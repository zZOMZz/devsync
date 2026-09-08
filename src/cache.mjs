import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isProcessAlive, readJson } from "./core.mjs";

export function userCacheDirectory(platform = process.platform, env = process.env, home = os.homedir()) {
  const base = platform === "win32"
    ? env.LOCALAPPDATA || path.join(home, "AppData", "Local")
    : platform === "darwin"
      ? path.join(home, "Library", "Caches")
      : env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME)
        ? env.XDG_CACHE_HOME : path.join(home, ".cache");
  return path.join(base, "project-sync", "mutagen");
}

// Publish a complete owner record with an atomic hard link, so an interrupted
// writer never leaves an empty lock. The short recovery gate serializes reapers.
export async function withCacheLock(file, task, { waitMs = 600000, pollMs = 250, log = () => {}, label = "等待其他项目准备共享 Mutagen 程序…", pidOnly = false, timeoutMessage } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const candidate = `${file}.${token}`;
  await fs.writeFile(candidate, JSON.stringify(pidOnly ? process.pid : { pid: process.pid, token }), { mode: 0o600 });
  let acquired = false, announced = false;
  const deadline = Date.now() + waitMs;
  try {
    while (!acquired) {
      try {
        await fs.link(candidate, file);
        acquired = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = await readJson(file, null);
        if (owner && !isProcessAlive(typeof owner === "number" ? owner : owner.pid)) {
          const gate = file + ".recover";
          let recovering = false, reclaimed = false;
          try {
            await fs.mkdir(gate, { mode: 0o700 });
            recovering = true;
            const current = await readJson(file, null);
            if ((typeof owner === "number" ? current === owner : current?.token === owner.token) && !isProcessAlive(typeof current === "number" ? current : current.pid))
              { await fs.unlink(file); reclaimed = true; }
          } catch (e) {
            if (!["EEXIST", "ENOENT"].includes(e.code)) throw e;
          } finally {
            if (recovering) await fs.rmdir(gate);
          }
          if (reclaimed) continue;
        }
        if (!announced) { log(label); announced = true; }
        if (Date.now() >= deadline)
          throw Error(timeoutMessage || `等待共享下载锁超时，请确认其他同步命令是否仍在下载后重试：${file}`);
        await new Promise(resolve => setTimeout(resolve, pollMs));
      }
    }
    return await task();
  } finally {
    const current = acquired ? await readJson(file, null) : null;
    if (acquired && (pidOnly ? current === process.pid : current?.token === token)) await fs.unlink(file);
    await fs.rm(candidate, { force: true });
  }
}
