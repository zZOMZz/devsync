import path from "node:path";
import { sessionIssues, diagnose } from "./diagnostics.mjs";
import fs from "node:fs/promises";
import { command, digest, healthy, readJson, writeJson } from "./core.mjs";
import { SyncError } from "./errors.mjs";
import { defaultRules, mutagenIgnores } from "./rules.mjs";
import { identityPath, prepareSSHTransport } from "./ssh-transport.mjs";
export const watchPolicy = { mode: "force-poll", pollingInterval: 1 };
export function fingerprint(root, cfg, rules = defaultRules, auth = {}) {
  const identity = identityPath(root, cfg);
  return digest(
    JSON.stringify({
      root,
      remote: cfg.remote,
      identityFile: cfg.identityFile,
      ...(identity ? { sshTransport: { version: 1, identity, password: Boolean(auth.password) } } : {}),
      mode: "one-way-replica",
      watchPolicy,
      rules,
    }),
  );
}
export class Session {
  constructor(root, binary, auth) {
    this.root = root;
    this.binary = binary;
    this.auth = auth;
    this.name = "project-sync";
    const socketPath = path.join(root, ".sync/state/daemon/daemon.sock");
    const socketLimit = process.platform === "darwin" ? 104 : 108;
    if (process.platform !== "win32" && Buffer.byteLength(socketPath) >= socketLimit)
      throw new SyncError("PROJECT_PATH_TOO_LONG", "项目路径过长，超过 Mutagen 后台通信路径限制，请将项目放到更短的绝对路径下。");
    this.env = {
      ...process.env,
      MUTAGEN_DATA_DIRECTORY: path.join(root, ".sync/state"),
    };
    delete this.env.MUTAGEN_SSH_PATH;
  }
  async run(args, options = {}) {
    // Read the accepted snapshot, never a potentially edited/draft config.
    // The same path is available to fresh CLI processes and background workers.
    const transport = await readJson(path.join(this.root, ".sync/ssh.json"), null);
    if (transport) this.env.MUTAGEN_SSH_PATH = transport.directory;
    else delete this.env.MUTAGEN_SSH_PATH;
    return command(this.binary, args, {
      env: this.env,
      password: this.auth.password,
      timeout: 120000,
      ...options,
    });
  }
  async list(options) {
    return JSON.parse(
      await this.run(["sync", "list", "--template", "{{json .}}"], options),
    );
  }
  async get(options) {
    return (await this.list(options)).find((s) => s.name === this.name);
  }
  async stopDaemon() {
    await this.run(["daemon", "stop"]);
    const socket = path.join(this.root, ".sync/state/daemon/daemon.sock");
    const deadline = Date.now() + 20000;
    while (process.platform !== "win32") {
      try { await fs.lstat(socket); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      if (Date.now() >= deadline)
        throw new SyncError("SSH_TRANSPORT_BUSY", "旧同步服务尚未退出，请稍后重试。");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  async stateFileMissing(state, directory = "sessions") {
    if (!/^sync_[A-Za-z0-9]+$/.test(state?.identifier || "")) return false;
    try { await fs.lstat(path.join(this.root, ".sync/state", directory, state.identifier)); return false; }
    catch (error) { if (error.code === "ENOENT") return true; throw error; }
  }
  async recoverRemovedController(state) {
    // Do not restart persisted sessions: they might resume on daemon startup.
    // Only discard a controller whose session metadata is already gone.
    if (!(await this.stateFileMissing(state))) return false;
    await this.stopDaemon();
    return true;
  }
  async create(cfg, rules = defaultRules) {
    const transport = await prepareSSHTransport(this.root, cfg, this.auth);
    const file = path.join(this.root, ".sync/ssh.json");
    const previous = await readJson(file, null);
    let published = false;
    try {
      if (transport || previous) {
        // SSH_PATH belongs to the daemon, not the CLI command. Stop the old
        // daemon before switching its snapshot, including when removing a key.
        // create() also supports direct callers with no daemon yet.
        await this.get();
        await this.stopDaemon();
        await writeJson(file, transport);
        published = true;
      }
      await this.run(sessionArguments(this.root, cfg, rules));
    } finally {
      if (transport && !published) await fs.rm(transport.directory, { recursive: true, force: true });
    }
  }
  async pause() {
    const state = await this.get();
    if (!state) return;
    try { await this.run(["sync", "pause", this.name], { timeout: 20000 }); }
    catch (error) {
      if (!/controller disabled/i.test(error.message) || !(await this.recoverRemovedController(state))) throw error;
      if (await this.get()) await this.run(["sync", "pause", this.name], { timeout: 20000 });
    }
  }
  async terminate() {
    const state = await this.get();
    if (!state) return;
    try { await this.run(["sync", "terminate", this.name]); }
    catch (error) {
      const partialRemoval = /controller disabled/i.test(error.message) ||
        /unable to remove (?:session|archive) from disk.*(?:no such file|cannot find)/is.test(error.message);
      if (!partialRemoval || !(await this.stateFileMissing(state, "archives")) || !(await this.recoverRemovedController(state))) throw error;
      if ((await this.get())?.identifier === state.identifier)
        throw new SyncError("SESSION_RECOVERY_FAILED", "旧会话仍未清理完成，请检查项目同步状态。", { cause: error.message });
    }
  }
  async resume() {
    await this.run(["sync", "resume", this.name]);
  }
  async flush() {
    await this.run(["sync", "flush", this.name]);
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      const s = await this.get();
      const issues = sessionIssues(s);
      if (issues.length) throw new SyncError("SYNC_PROBLEMS", diagnose(issues[0]).title, { issues });
      if (healthy(s)) return s;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw Error("同步尚未完成，请检查连接后重试。");
  }
}
export function describe(s, auto) {
  if (!s) return "尚未创建同步会话，请执行 devsync sync。";
  if (s.paused) return "自动同步已停止。";
  if (healthy(s))
    return `${auto ? "后台自动同步中" : "本轮同步完成"}：${s.alpha.files} 个文件已对齐。`;
  if (s.lastError) return `连接或同步失败：${s.lastError}`;
  if (
    s.conflicts?.length ||
    s.alpha?.transitionProblems?.length ||
    s.beta?.transitionProblems?.length ||
    s.alpha?.scanProblems?.length ||
    s.beta?.scanProblems?.length
  )
    return "同步存在冲突或文件读写错误。";
  return !s.alpha?.connected || !s.beta?.connected
    ? "连接已断开，自动模式会重试；请检查网络/VPN。"
    : "正在扫描或同步文件…";
}

export function sessionArguments(root, cfg, rules = defaultRules) {
    const r = cfg.remote;
    const args = [
      "sync",
      "create",
      "--paused",
      "--name",
      "project-sync",
      "--mode",
      "one-way-replica",
      "--watch-mode-alpha",
      watchPolicy.mode,
      "--watch-polling-interval-alpha",
      String(rules.pollingInterval),
      "--ignore-syntax",
      "mutagen",
      "--no-global-configuration",
      "--no-ignore-vcs",
      "--default-file-mode-beta",
      "0644",
      "--default-directory-mode-beta",
      "0755",
    ];
    for (const p of mutagenIgnores(rules)) args.push("--ignore", p);
    args.push(root, `${r.username}@${r.host}:${r.port}:${r.path}`);
  return args;
}
