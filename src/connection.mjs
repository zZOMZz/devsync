import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { command, quote } from "./core.mjs";
import { ssh } from "./remote.mjs";

export async function sshDefaults(host, run = command) {
  const output = await run(process.platform === "win32" ? "ssh.exe" : "ssh", ["-G", host]);
  const values = Object.fromEntries(output.trim().split(/\r?\n/).map(line => {
    const [key, ...rest] = line.split(/\s+/); return [key, rest.join(" ")];
  }));
  return { username: values.user, port: Number(values.port), hostname: values.hostname };
}

export async function sshAliases(home = os.homedir()) {
  const seen = new Set(), aliases = new Set();
  const sshDir = path.join(home, ".ssh");
  async function read(file) {
    if (seen.has(file)) return;
    seen.add(file);
    let content;
    try { content = await fs.readFile(file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const line of content.split(/\r?\n/)) {
      const tokens = line.replace(/#.*$/, "").trim().match(/"[^"\n]*"|'[^'\n]*'|[^\s=]+/g) || [];
      const [directive, ...values] = tokens.map(s => s.replace(/^["']|["']$/g, ""));
      if (directive?.toLowerCase() === "host")
        for (const alias of values) if (/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(alias)) aliases.add(alias);
      if (directive?.toLowerCase() === "include") {
        for (let pattern of values) {
          pattern = pattern.replace(/^~(?=\/)/, home);
          if (!path.isAbsolute(pattern)) pattern = path.join(sshDir, pattern);
          // Expand wildcards in each path component (no shell expansion).
          async function expand(base, parts) {
            if (!parts.length) return read(base);
            const [part, ...rest] = parts;
            if (!/[?*]/.test(part)) return expand(path.join(base, part), rest);
            const regex = new RegExp("^" + part.split("*").map(p => p.split("?").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".")).join(".*") + "$");
            let entries;
            try { entries = await fs.readdir(base); } catch (e) { if (e.code === "ENOENT") return; throw e; }
            for (const entry of entries.sort()) if (regex.test(entry)) await expand(path.join(base, entry), rest);
          }
          const parsed = path.parse(pattern);
          await expand(parsed.root, pattern.slice(parsed.root.length).split(path.sep));
        }
      }
    }
  }
  await read(path.join(sshDir, "config"));
  return [...aliases];
}

export function connectionError(error, auth = {}) {
  if (["SSH_IDENTITY", "SSH_IDENTITY_UNSUPPORTED"].includes(error.code)) return error;
  const message = error.message;
  let field = "connection", help = "连接失败。请检查网络/VPN、地址、SSH 端口和跳板机，再重试。";
  if (/SYNC_PATH_ERROR/.test(message)) {
    field = "path"; help = "目录权限检查失败。请使用独占项目目录，确保可读取、写入和进入目录，且父目录可写以保存备份。";
  } else if (/SYNC_REMOTE_UNSUPPORTED/.test(message)) {
    field = null; help = "远端需要 Linux、GNU find/tar 和 sha256sum，请安装后重试。";
  } else if (/permission denied|authentication failed|incorrect password/i.test(message)) {
    field = "auth"; help = auth.password
      ? "密码认证失败（密码可能错误，或账号/服务器不允许密码登录）。请重新输入密码；账号有误可取消后运行 devsync config。"
      : "SSH 密钥认证失败。请检查 SSH 别名、IdentityFile 和 ssh-agent，或改用密码认证。";
  } else if (/could not resolve hostname|name or service not known|nodename nor servname/i.test(message)) {
    field = "host"; help = "地址解析失败。请检查开发机地址、SSH 别名及 VPN/DNS。";
  } else if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(message)) {
    field = null; help = "SSH 主机指纹验证失败。请先通过 ssh 核实主机身份并处理 known_hosts，再重新配置。";
  }
  return Object.assign(new Error(`${help}\n${message}`), { field });
}

export async function probeConnection(root, cfg, auth, run = ssh) {
  try {
    const output = await run(root, cfg, auth, `[ "$(uname -s)" = Linux ] && command -v sha256sum >/dev/null && find --version >/dev/null 2>&1 && tar --version >/dev/null 2>&1 || { echo SYNC_REMOTE_UNSUPPORTED >&2; exit 1; }; printf '\\nSYNC_HOME=%s\\n' "$HOME"`);
    const home = /^SYNC_HOME=(\/[^\r\n]*)$/m.exec(output)?.[1];
    if (!home) throw Error("SSH 已连接，但无法读取远端主目录，请检查登录脚本。");
    return { home };
  } catch (error) { throw connectionError(error, auth); }
}

export async function checkRemotePath(root, cfg, auth, run = ssh) {
  const target = quote(cfg.remote.path);
  // Read-only permission checks. Creating a missing directory waits for sync approval.
  const script = `target=${target}
fail() { echo "SYNC_PATH_ERROR: $1" >&2; exit 1; }
[ "$target" != "$HOME" ] || fail '不能使用用户主目录'
[ ! -L "$target" ] || fail '目标目录不能是符号链接'
if [ -e "$target" ]; then
  [ -d "$target" ] && [ -r "$target" ] && [ -w "$target" ] && [ -x "$target" ] || fail '目标目录不可读写'
  canonical=$(cd "$target" && pwd -P) || fail '无法解析目标目录'
  canonical_home=$(cd "$HOME" && pwd -P) || fail '无法解析用户主目录'
  [ "$canonical" != "$canonical_home" ] || fail '不能使用用户主目录'
  case "$canonical" in /|/home|/root|/tmp|/usr|/etc|/var) fail '不能使用系统目录' ;; esac
fi
p=$(dirname -- "$target")
while [ ! -e "$p" ]; do p=$(dirname -- "$p"); done
[ -d "$p" ] && [ -w "$p" ] && [ -x "$p" ] || fail '父目录不可写，无法创建目录或备份'
printf 'SYNC_PATH_OK\\n'`;
  try {
    const output = await run(root, cfg, auth, script);
    if (!/^SYNC_PATH_OK$/m.test(output)) throw Error("目录检查未完成，请检查远端登录脚本。");
  } catch (error) { throw connectionError(error, auth); }
}
