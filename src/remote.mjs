import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { command, quote, symlinkSignature, writeJson } from "./core.mjs";
import { defaultRules, protectedPatterns, patternBody } from "./rules.mjs";
export async function ssh(root, cfg, auth, script, input, run = command) {
  const r = cfg.remote;
  const args = [
    "-p",
    String(r.port),
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "NumberOfPasswordPrompts=1",
  ];
  if (cfg.identityFile) args.push("-i", cfg.identityFile);
  if (!auth.password) args.push("-o", "BatchMode=yes");
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
      args.push("-o", "PreferredAuthentications=password");
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
export async function backupRemote(root, cfg, auth, files) {
  if (!files.length) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${cfg.remote.path}.sync-backup-${stamp}.tar.gz`;
  await ssh(
    root,
    cfg,
    auth,
    `umask 077; cd ${quote(cfg.remote.path)} && tar -czf ${quote(backup)} --null -T - && tar -tzf ${quote(backup)} >/dev/null`,
    Buffer.from(files.map((p) => "./" + p + "\0").join("")),
  );
  return backup;
}
export async function createRemote(root, cfg, auth) {
  await ssh(
    root,
    cfg,
    auth,
    `mkdir -p -- ${quote(cfg.remote.path)} && test -w ${quote(cfg.remote.path)}`,
  );
}
