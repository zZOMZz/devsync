import path from "node:path";
import { command, digest, healthy } from "./core.mjs";
import { SyncError } from "./errors.mjs";
import { defaultRules, mutagenIgnores } from "./rules.mjs";
export const watchPolicy = { mode: "force-poll", pollingInterval: 1 };
export function fingerprint(root, cfg, rules = defaultRules) {
  return digest(
    JSON.stringify({
      root,
      remote: cfg.remote,
      identityFile: cfg.identityFile,
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
  run(args, options = {}) {
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
  async create(cfg, rules = defaultRules) {
    await this.run(sessionArguments(this.root, cfg, rules));
  }
  async pause() {
    if (await this.get())
      await this.run(["sync", "pause", this.name], { timeout: 20000 });
  }
  async resume() {
    await this.run(["sync", "resume", this.name]);
  }
  async flush() {
    await this.run(["sync", "flush", this.name]);
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      const s = await this.get();
      if (healthy(s)) return s;
      if (
        s?.lastError ||
        s?.conflicts?.length ||
        s?.alpha?.scanProblems?.length ||
        s?.beta?.scanProblems?.length ||
        s?.alpha?.transitionProblems?.length ||
        s?.beta?.transitionProblems?.length
      )
        throw Error(
          "同步存在冲突或写入错误，请执行 devsync status 查看。",
        );
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
