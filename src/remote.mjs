import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { command, quote, symlinkSignature, writeJson, readJson, digest } from "./core.mjs";
import { defaultRules, protectedPatterns, patternBody } from "./rules.mjs";
import { sshOptions } from "./ssh-transport.mjs";
import { backupOwner, backupTarget, ownedBackup } from "./backup.mjs";
import { SyncError } from "./errors.mjs";
export async function ssh(root, cfg, auth, script, input, run = command) {
  const r = cfg.remote;
  const args = ["-p", String(r.port), ...sshOptions(root, cfg, auth)];
  const destination = `${r.username}@${r.host}`;
  const env = { ...process.env };
  let credentials;
  try {
    if (auth.password) {
      // OpenSSH expands aliases before invoking askpass. Only allow the selected
      // destination, never a jump host requesting unrelated credentials.
      const effective = await run(process.platform === "win32" ? "ssh.exe" : "ssh", [...args, "-G", destination]);
      const resolvedHost = /^hostname (.+)$/m.exec(effective)?.[1];
      await fs.mkdir(path.join(root, ".sync"), { recursive: true, mode: 0o700 });
      credentials = await fs.mkdtemp(path.join(root, ".sync", "credential-check-"));
      await writeJson(path.join(credentials, "config.json"), { remote: r, resolvedHost });
      await writeJson(path.join(credentials, "auth.json"), auth);
      Object.assign(env, {
        SSH_ASKPASS: process.execPath,
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: process.env.DISPLAY || "sync:0",
        SYNC_CONFIG_FILE: path.join(credentials, "config.json"),
        SYNC_AUTH_FILE: path.join(credentials, "auth.json"),
        NODE_OPTIONS: `--require ${JSON.stringify(fileURLToPath(new URL("./askpass.cjs", import.meta.url)))}`,
      });
    }
    args.push(destination, script);
    return await run(process.platform === "win32" ? "ssh.exe" : "ssh", args, {
      env, input: input ?? "", password: auth.password, timeout: 120000,
    });
  } finally {
    if (credentials) await fs.rm(credentials, { recursive: true, force: true });
  }
}
export function findExpression(rules = defaultRules) {
  const parts = [...protectedPatterns, ...rules.exclude].map(p =>
    `-regex ${quote("\\./" + patternBody(p))}`);
  const env = `-regex ${quote("\\./" + patternBody(".env*"))}`;
  const allowed = rules.envFiles.map(p => `! -path ${quote("./" + p)}`).join(" ");
  parts.push(`\\( ${env} ${allowed} \\)`);
  return `\\( ${parts.join(" -o ")} \\) -prune -o`;
}
export async function remoteManifest(root, cfg, auth, rules = defaultRules) {
  const target = quote(cfg.remote.path);
  const guard = `if [ ${target} = "$HOME" ] || [ -L ${target} ]; then echo '目标不能是用户主目录或符号链接' >&2; exit 1; fi; `;
  const result = await ssh(
    root,
    cfg,
    auth,
    guard +
      `if [ ! -e ${target} ]; then echo SYNC_TARGET_MISSING; exit 0; fi; test -d ${target} && test -w ${target} || exit 1; cd ${target} || exit 1; find . -regextype posix-extended ${findExpression(rules)} -type f -exec sha256sum {} + && printf '\\0SYNC_LINKS\\0' && find . -regextype posix-extended ${findExpression(rules)} -type l -printf '%p\\0%l\\0'`,
  );
  return parseRemoteManifest(result);
}
export function parseRemoteManifest(result) {
  if (result.trim() === "SYNC_TARGET_MISSING")
    return { exists: false, files: {} };
  const files = Object.create(null);
  const boundary = "\0SYNC_LINKS\0";
  const position = result.indexOf(boundary);
  if (position < 0) throw Error("远端文件清单不完整。");
  const hashes = result.slice(0, position);
  for (let line of hashes.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^(\\?)([a-f0-9]{64}) [ *](.*)$/.exec(line);
    if (!match)
      throw Error(
        "无法解析远端文件清单，请检查登录脚本是否向标准输出打印额外内容。",
      );
    let p = match[3];
    if (match[1])
      p = p.replace(/\\([\\n])/g, (_, c) => (c === "n" ? "\n" : "\\"));
    if (/[\r\n]/.test(p)) throw Error("预览暂不支持名称含换行的文件。");
    files[p.replace(/^\.\//, "")] = match[2];
  }
  const links = result.slice(position + boundary.length).split("\0");
  if (links.pop() !== "" || links.length % 2 !== 0)
    throw Error("远端符号链接清单不完整。");
  for (let i = 0; i < links.length; i += 2) {
    const p = links[i].replace(/^\.\//, "");
    files[p] = symlinkSignature(p, links[i + 1]);
  }
  return { exists: true, files };
}
function backupInput(files) {
  if (files.some(file => typeof file !== "string" || !file || file === "." || file.startsWith("/") || /[\0\r\n]/.test(file) || path.posix.normalize(file) !== file || file.split("/").includes("..")))
    throw new SyncError("INVALID_BACKUP", "备份清单必须使用项目内的相对文件路径。");
  return Buffer.from(files.map(file => "./" + file + "\0").join(""));
}
export async function estimateBackup(root, cfg, auth, files, run = ssh) {
  if (!files.length) return 0;
  // Only stat affected entries; do not hash/read their contents a second time.
  const script = `cd ${quote(cfg.remote.path)} && xargs -0 -r sh -c ${quote('find "$@" -maxdepth 0 -printf "%s\\n"')} sh`;
  const result = await run(root, cfg, auth, script, backupInput(files));
  const sizes = result.trim().split(/\r?\n/);
  if (sizes.length !== files.length || sizes.some(size => !/^\d+$/.test(size))) throw Error("无法读取备份文件大小。");
  const bytes = sizes.reduce((total, size) => total + Number(size), 0);
  if (!Number.isSafeInteger(bytes)) throw Error("备份大小超出可估算范围。");
  return bytes;
}
async function backupLedger(root) {
  const ledger = await readJson(path.join(root, ".sync/backups.json"), { version: 1, entries: [] });
  if (ledger?.version !== 1 || !Array.isArray(ledger.entries)) throw new SyncError("INVALID_BACKUP", "备份记录格式无效，请检查 .sync/backups.json。");
  return ledger;
}
export async function backupRemote(root, cfg, auth, files, run = ssh) {
  if (!files.length) return null;
  const input = backupInput(files);
  const ledger = await backupLedger(root);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${backupTarget(cfg).path}.sync-backup-${backupOwner(root)}-${stamp}-${randomUUID()}.tar.gz`;
  const temporary = backup + ".partial";
  await run(
    root,
    cfg,
    auth,
    `set -e; umask 077; trap ${quote(`rm -f -- ${quote(temporary)}`)} 0; cd ${quote(cfg.remote.path)}; tar -czf ${quote(temporary)} --no-recursion --null -T -; tar -tzf ${quote(temporary)} >/dev/null; mv -- ${quote(temporary)} ${quote(backup)}`,
    input,
  );
  ledger.entries.push({ target: digest(JSON.stringify(backupTarget(cfg))), path: backup });
  await writeJson(path.join(root, ".sync/backups.json"), ledger);
  return backup;
}
export async function pruneBackups(root, cfg, auth, keep, run = ssh) {
  if (!Number.isInteger(keep) || keep < 1 || keep > 100) throw new SyncError("INVALID_BACKUP", "无效的备份保留数量。");
  const ledger = await backupLedger(root);
  const target = digest(JSON.stringify(backupTarget(cfg)));
  const entries = ledger.entries.filter(entry => entry?.target === target && ownedBackup(root, cfg, entry.path));
  const paths = [...new Set(entries.map(entry => entry.path))];
  const removed = paths.slice(0, Math.max(0, paths.length - keep));
  if (!removed.length) return { removed: 0 };
  const retained = paths.slice(-keep);
  // Never discover deletion candidates with a wildcard. Require the retained
  // files to exist, and reject symlink/directory substitutions before deleting.
  const guard = retained.map(file => `test -f ${quote(file)} && test ! -L ${quote(file)}`).join(" && ");
  const oldGuard = removed.map(file => `test ! -L ${quote(file)} && { test ! -e ${quote(file)} || test -f ${quote(file)}; }`).join(" && ");
  await run(root, cfg, auth, `set -e; ${guard} || { echo '保留的备份缺失或不是普通文件，已停止清理。' >&2; exit 1; }; ${oldGuard} || { echo '旧备份包含符号链接或非普通文件，已停止清理。' >&2; exit 1; }; rm -f -- ${removed.map(quote).join(" ")}`);
  ledger.entries = ledger.entries.filter(entry => entry?.target !== target || !removed.includes(entry?.path));
  await writeJson(path.join(root, ".sync/backups.json"), ledger);
  return { removed: removed.length };
}
export async function createRemote(root, cfg, auth) {
  await ssh(
    root,
    cfg,
    auth,
    `mkdir -p -- ${quote(cfg.remote.path)} && test -w ${quote(cfg.remote.path)}`,
  );
}
