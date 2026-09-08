import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { quote } from "./core.mjs";
import { SyncError } from "./errors.mjs";

export function identityPath(root, cfg, { platform = process.platform, home = os.homedir() } = {}) {
  if (cfg.identityFile === undefined) return null;
  if (typeof cfg.identityFile !== "string" || !cfg.identityFile.trim() || /[\r\n\0]/.test(cfg.identityFile))
    throw new SyncError("SSH_IDENTITY", "identityFile 必须是非空的私钥文件路径，不能包含换行或空字符。");
  if (platform === "win32")
    throw new SyncError("SSH_IDENTITY_UNSUPPORTED", "Windows 请通过 SSH config 的 IdentityFile 配置私钥，并移除项目 identityFile；当前 Mutagen 私钥适配仅支持 macOS/Linux。");
  const file = cfg.identityFile;
  if (file.startsWith("~") && !file.startsWith("~/"))
    throw new SyncError("SSH_IDENTITY", "identityFile 的主目录写法仅支持 ~/，也可以使用绝对路径。");
  return path.resolve(root, file.startsWith("~/") ? path.join(home, file.slice(2)) : file);
}

// Shared by direct SSH operations and Mutagen's SSH/SCP launchers. Passwords
// stay in the existing askpass/prompter channels, never in generated scripts.
export function sshOptions(root, cfg, auth = {}) {
  const identity = identityPath(root, cfg);
  const args = ["-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new",
    "-o", "NumberOfPasswordPrompts=1"];
  if (identity) args.push("-i", identity);
  args.push("-o", auth.password ? "PreferredAuthentications=password" : "BatchMode=yes");
  return args;
}

async function executable(name) {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    // Resolve once in the foreground: daemon and scp working directories vary.
    const file = path.resolve(directory || ".", name);
    try {
      await fs.access(file, fs.constants.X_OK);
      if ((await fs.stat(file)).isFile()) return file;
    } catch (error) { if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) throw error; }
  }
  throw new SyncError("SSH_NOT_FOUND", `找不到 ${name}，请安装 OpenSSH 并加入 PATH。`);
}

export async function prepareSSHTransport(root, cfg, auth) {
  const args = sshOptions(root, cfg, auth);
  if (!identityPath(root, cfg)) return null;
  const programs = { ssh: await executable("ssh"), scp: await executable("scp") };
  const parent = path.join(root, ".sync/ssh");
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(parent, "transport-"));
  try {
    for (const [name, program] of Object.entries(programs))
      await fs.writeFile(path.join(directory, name),
        `#!/bin/sh\nexec ${[program, ...args].map(quote).join(" ")} "$@"\n`, { mode: 0o700 });
    return { directory };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
