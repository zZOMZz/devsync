import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { defaultRules, ignored } from "./rules.mjs";
export { ignored } from "./rules.mjs";
export const quote = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";
export const digest = (b) => createHash("sha256").update(b).digest("hex");
export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT" && arguments.length > 1) return fallback;
    if (path.basename(file) === "auth.json")
      throw Error("认证文件格式无效，请检查 .sync/auth.json。");
    throw e;
  }
}
export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
  });
  await fs.rename(tmp, file);
}
export function validateRemoteField(field, value) {
  if (field === "host" && (typeof value !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(value)))
    throw Error("开发机地址无效，请填写主机名、IPv4 地址或 SSH 别名。");
  if (field === "username" && (typeof value !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(value)))
    throw Error("开发机账号无效。");
  if (field === "port" && (!Number.isInteger(value) || value < 1 || value > 65535))
    throw Error("SSH 端口必须是 1–65535 的整数。");
  if (field === "path" && (
    typeof value !== "string" || !value.startsWith("/") || /[\r\n\0]/.test(value) ||
    ["/", "/home", "/root", "/tmp", "/usr", "/etc", "/var"].includes(path.posix.normalize(value)) ||
    path.posix.normalize(value) !== value.replace(/\/$/, "")
  )) throw Error("请指定独立项目的绝对路径，不能使用系统目录或包含 .. 的路径。");
}
export function validateRemote(r) {
  for (const field of ["host", "username", "port", "path"]) validateRemoteField(field, r?.[field]);
}
export async function localManifest(root, rules = defaultRules) {
  const files = Object.create(null);
  async function walk(dir, rel = "") {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const p = rel ? `${rel}/${entry.name}` : entry.name;
      if (/[\r\n\0]/.test(p)) throw Error("暂不支持名称含换行的文件。");
      if (ignored(p, rules)) continue;
      if (entry.isSymbolicLink()) {
        files[p] = symlinkSignature(
          p,
          await fs.readlink(path.join(dir, entry.name)),
        );
        continue;
      }
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), p);
      else if (entry.isFile())
        files[p] = digest(await fs.readFile(path.join(dir, entry.name)));
    }
  }
  await walk(root);
  return files;
}
export function changes(local, remote) {
  const added = [],
    updated = [],
    deleted = [];
  for (const [p, h] of Object.entries(local))
    if (!Object.hasOwn(remote, p)) added.push(p);
    else if (remote[p] !== h) updated.push(p);
  for (const p of Object.keys(remote))
    if (!Object.hasOwn(local, p)) deleted.push(p);
  return { added, updated, deleted };
}
export function healthy(s) {
  return Boolean(
    s &&
    !s.paused &&
    s.status === "watching" &&
    s.alpha?.connected &&
    s.beta?.connected &&
    !s.lastError &&
    !s.conflicts?.length &&
    !s.alpha?.scanProblems?.length &&
    !s.beta?.scanProblems?.length &&
    !s.alpha?.transitionProblems?.length &&
    !s.beta?.transitionProblems?.length,
  );
}
const activeChildren = new Set();
export function cancelCommands() {
  for (const child of activeChildren) child.kill();
}
export async function command(
  bin,
  args,
  {
    env = process.env,
    cwd,
    input,
    password,
    timeout = 60000,
    signal,
    onStderr,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    activeChildren.add(child);
    let out = "",
      err = "",
      prompt = "",
      count = 0,
      finished = false;
    const redact = (s) => (password ? s.replaceAll(password, "[隐藏]") : s);
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    // Downloads use curl's connection/stall limits instead of a wall-clock limit.
    const timer = timeout > 0 ? setTimeout(() => child.kill(), timeout) : null;
    child.on("error", (e) => {
      activeChildren.delete(child);
      clearTimeout(timer);
      reject(Error(`${bin} 无法启动：${e.code}`));
    });
    child.stdout.on("data", (b) => {
      const text = b.toString();
      out += text;
      prompt = (prompt + text).slice(-4096);
      if (/password:\s*$/i.test(prompt) && password) {
        if (++count > 12) {
          child.kill();
          return;
        }
        child.stdin.write(password + "\n");
        prompt = "";
      }
    });
    child.stderr.on("data", (b) => {
      const text = b.toString();
      err += text;
      onStderr?.(redact(text));
    });
    child.stdin.on("error", () => {});
    if (input !== undefined) child.stdin.end(input);
    child.on("close", (code) => {
      activeChildren.delete(child);
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (finished) return;
      finished = true;
      if (code === 0) resolve(out);
      else
        reject(
          Error(
            redact((err || out).trim().slice(-1800)) ||
              `${bin} 执行失败或超时（${code}）。`,
          ),
        );
    });
  });
}
export function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform === "win32" ? "windows" : platform}_${arch === "x64" ? "amd64" : arch}`;
}
export async function verifyArchive(file, expected) {
  if (digest(await fs.readFile(file)) !== expected)
    throw Error("安装包 SHA-256 校验失败，请重新下载正确的官方安装包。");
}

// EPERM means the process exists but this caller cannot signal it.
export function isProcessAlive(pid, probe = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    probe(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

// Match Mutagen's portable symlink scope without following the target.
export function symlinkSignature(relativePath, target) {
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(relativePath), target),
  );
  if (
    !target ||
    path.posix.isAbsolute(target) ||
    target.includes("\\") ||
    resolved === ".." ||
    resolved.startsWith("../")
  ) {
    throw Error(`符号链接必须使用项目内相对路径：${relativePath}`);
  }
  return "symlink:" + target;
}
