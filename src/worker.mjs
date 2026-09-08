import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readJson, writeJson, isProcessAlive } from "./core.mjs";
import { Session } from "./session.mjs";
import { SyncError } from "./errors.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function stopWorker(root) {
  const file = path.join(root, ".sync/control.json");
  const state = await readJson(file, {});
  await writeJson(file, { ...state, auto: false });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const current = await readJson(file, {});
    if (!current.pid || !isProcessAlive(current.pid)) return;
    await delay(100);
  }
  throw new SyncError("WORKER_BUSY", "后台重连仍在结束，请稍后重试 devsync stop。");
}
export async function startWorker(root, binary) {
  const file = path.join(root, ".sync/control.json");
  const current = await readJson(file, {});
  if (current.auto && isProcessAlive(current.pid)) return;
  const token = randomUUID();
  await writeJson(file, { auto: true, token });
  const child = spawn(process.execPath,
    [fileURLToPath(new URL("../bin/devsync.mjs", import.meta.url)), "_worker", "--dir", root, "--binary", binary, "--token", token],
    { detached: true, stdio: "ignore", windowsHide: true });
  let spawnError;
  child.on("error", error => { spawnError = error; });
  child.unref();
  for (let n = 0; n < 50; n++) {
    const state = await readJson(file, {});
    if (state.token === token && state.pid === child.pid && isProcessAlive(child.pid)) return;
    if (spawnError || (child.pid && !isProcessAlive(child.pid))) break;
    await delay(100);
  }
  const state = await readJson(file, {});
  if (state.token === token) await writeJson(file, { ...state, auto: false });
  throw new SyncError("WORKER_START_FAILED", "后台管理服务未启动，请重试 devsync start。");
}
export async function runWorker(root, binary, token) {
  const file = path.join(root, ".sync/control.json");
  const initial = await readJson(file, {});
  if (initial.token !== token || !initial.auto) return;
  const session = new Session(root, binary, await readJson(path.join(root, ".sync/auth.json"), {}));
  await writeJson(file, { auto: true, token, pid: process.pid });
  let failures = 0, nextAttempt = 0, workerError;
  try {
    while (true) {
      const state = await readJson(file, {});
      if (!state.auto || state.token !== token) break;
      let locked = false;
      try { await fs.access(path.join(root, ".sync/command.lock")); locked = true; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!locked && Date.now() >= nextAttempt) {
        try {
          const status = await session.get({ timeout: 10000 });
          if (status?.lastError && /permission denied|authentication failed|incorrect password/i.test(status.lastError))
            throw Error(status.lastError);
          if (status && !status.paused && (!status.alpha?.connected || !status.beta?.connected))
            await session.run(["sync", "resume", session.name], { timeout: 10000 });
          failures = 0;
        } catch (error) {
          nextAttempt = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(failures++, 4));
          if (/permission denied|authentication failed|incorrect password/i.test(error.message)) {
            workerError = "认证失败，自动同步已暂停。请运行 devsync config 更新认证后重新 start。";
            await session.pause();
            break;
          }
        }
      }
      await delay(2000);
    }
  } catch (error) {
    workerError = error.message;
    await session.pause().catch(() => {});
  } finally {
    const state = await readJson(file, {});
    if (state.token === token) await writeJson(file, { auto: false, token, error: workerError });
  }
}
