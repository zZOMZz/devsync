import fs from "node:fs/promises";
import path from "node:path";
import { readJson, writeJson, localManifest, changes, isProcessAlive, validateRemote, validateRemoteField, digest } from "./core.mjs";
import { loadProject, secureProject, saveConnection, ensureProjectFiles, loadUserConfig } from "./project.mjs";
import { probeConnection, checkRemotePath } from "./connection.mjs";
import { ensureTool } from "./install.mjs";
import { Session, fingerprint } from "./session.mjs";
import { remoteManifest, backupRemote, createRemote } from "./remote.mjs";
import { withCacheLock } from "./cache.mjs";
import { stopWorker, startWorker } from "./worker.mjs";
import { SyncError } from "./errors.mjs";
import { projectStatus } from "./status.mjs";

// All user interaction is supplied by the caller. Core operations return data;
// an editor can use this API or the CLI JSON interface without parsing prose.
export class ProjectSync {
  constructor(root, { onEvent = () => {}, stage, signal, dependencies = {} } = {}) {
    this.root = root;
    this.signal = signal;
    this.dir = path.join(root, ".sync");
    this.emit = onEvent;
    this.stage = stage;
    this.deps = { ensureTool, remoteManifest, backupRemote, createRemote,
      probeConnection, checkRemotePath, Session, startWorker, stopWorker, ...dependencies };
  }
  checkCancelled() {
    if (this.signal?.aborted) throw new SyncError("INTERRUPTED", "操作已中断。");
  }
  async phase(label, task) {
    this.checkCancelled();
    if (this.stage) return this.stage(label, task);
    this.emit({ type: "phase", message: label + "…" });
    return task();
  }
  async locked(task) {
    this.checkCancelled();
    await secureProject(this.root);
    return withCacheLock(path.join(this.dir, "command.lock"), task, {
      waitMs: 0, pidOnly: true,
      timeoutMessage: "另一个同步命令正在运行，请稍后重试。",
    });
  }
  async auth() { return readJson(path.join(this.dir, "auth.json"), {}); }
  async storedSession() {
    const tool = await readJson(path.join(this.dir, "tool.json"), null);
    return tool ? new this.deps.Session(this.root, tool.path, await this.auth()) : null;
  }
  async pause() {
    await this.deps.stopWorker(this.root);
    const session = await this.storedSession();
    if (session) await session.pause();
  }
  async configure(collect, confirm) {
    return this.locked(async () => {
      // Even an invalid edited config must not prevent stopping the old target.
      await this.pause();
      const project = await loadProject(this.root, { validateConfig: false });
      const previousAuth = await this.auth();
      // Validation receipts live only in this invocation. A UI cannot mark
      // arbitrary answers as checked; changed answers are validated again.
      const probes = new Set(), paths = new Set();
      const key = (cfg, auth, includePath) => digest(JSON.stringify({
        ...cfg, remote: { ...cfg.remote, ...(!includePath ? { path: undefined } : {}) }, auth,
      }));
      const checks = {
        probe: async (cfg, auth) => {
          for (const field of ["host", "username", "port"]) validateRemoteField(field, cfg.remote?.[field]);
          const id = key(cfg, auth, false);
          probes.delete(id);
          const result = await this.phase("验证 SSH 连接和认证", () => this.deps.probeConnection(this.root, cfg, auth));
          probes.add(id);
          return result;
        },
        checkPath: async (cfg, auth) => {
          validateRemote(cfg.remote);
          const id = key(cfg, auth, true);
          paths.delete(id);
          const result = await this.phase("验证远端目录", () => this.deps.checkRemotePath(this.root, cfg, auth));
          paths.add(id);
          return result;
        },
      };
      const answers = await collect(project, previousAuth, checks);
      validateRemote(answers.cfg.remote);
      if (!probes.has(key(answers.cfg, answers.auth, false))) await checks.probe(answers.cfg, answers.auth);
      if (!paths.has(key(answers.cfg, answers.auth, true))) await checks.checkPath(answers.cfg, answers.auth);
      const scope = this.scope(answers.cfg, project.rules, answers.auth);
      if (!(await confirm(scope))) throw new SyncError("CANCELLED", "已取消，原连接配置已保留，自动同步保持暂停。");
      this.checkCancelled();
      await ensureProjectFiles(this.root, project.rules);
      await saveConnection(this.root, answers.cfg, answers.auth);
      return { configured: true, scope, auto: false };
    });
  }
  scope(config, rules, auth) {
    return { local: this.root, remote: config.remote, mode: rules.mode,
      ...(auth ? { authentication: auth.password ? "password" : config.identityFile ? "identity-file" : "ssh-config",
        ...(config.identityFile ? { identityFile: config.identityFile } : {}) } : {}),
      deletesRemote: true, envFiles: rules.envFiles, exclude: rules.exclude };
  }
  async requiredProject() {
    const project = await loadProject(this.root);
    if (!project.config) throw new SyncError("NOT_CONFIGURED", "尚未配置同步，请执行 devsync init。");
    return project;
  }
  async verify(project, auth) {
    await this.phase("验证 SSH 连接和认证", () => this.deps.probeConnection(this.root, project.config, auth));
    await this.phase("验证远端目录", () => this.deps.checkRemotePath(this.root, project.config, auth));
  }
  async plan(project, auth) {
    const { remote, local } = await this.phase("检查本地与远端差异", async () => ({
      remote: await this.deps.remoteManifest(this.root, project.config, auth, project.rules),
      local: await localManifest(this.root, project.rules),
    }));
    const diff = changes(local, remote.files);
    const result = { scope: this.scope(project.config, project.rules, auth), remoteExists: remote.exists,
      added: diff.added, updated: diff.updated, deleted: diff.deleted };
    await writeJson(path.join(this.dir, "preview.json"), result);
    return result;
  }
  async preview() {
    return this.locked(async () => {
      await this.pause();
      const project = await this.requiredProject();
      const auth = await this.auth();
      await this.verify(project, auth);
      return { ...(await this.plan(project, auth)), auto: false };
    });
  }
  async stop() {
    try { await fs.access(this.dir); }
    catch (error) { if (error.code === "ENOENT") return { stopped: true, configured: false }; throw error; }
    return this.locked(async () => { await this.pause(); return { stopped: true }; });
  }
  async status() {
    const config = await readJson(path.join(this.dir, "config.json"), null);
    const control = await readJson(path.join(this.dir, "control.json"), {});
    const lastRun = await readJson(path.join(this.dir, "last-run.json"), null);
    let state = null, queryError = null;
    try {
      const session = await this.storedSession();
      if (session) {
        // Queries never resurrect a daemon or initiate a remote connection.
        session.env.MUTAGEN_DISABLE_AUTOSTART = "1";
        state = await session.get({ timeout: 10000 });
      } else if (control.auto || isProcessAlive(control.pid) || lastRun)
        queryError = new Error("缺少工具记录，无法读取已有同步状态。");
    } catch (error) {
      queryError = error;
    }
    return projectStatus({ root: this.root, configured: Boolean(config), control, session: state, queryError, lastRun });
  }
  async sync({ auto = false, confirm = async () => false } = {}) {
    return this.locked(async () => {
      let session, keepAuto = false;
      try {
        const project = await this.requiredProject();
        const auth = await this.auth();
        const current = await readJson(path.join(this.dir, "control.json"), {});
        keepAuto = Boolean(current.auto && isProcessAlive(current.pid));
        const id = fingerprint(this.root, project.config, project.rules, auth);
        const accepted = await readJson(path.join(this.dir, "accepted.json"), {});
        // Pause before validating a changed target or rules so the old session
        // cannot continue propagating changes while a new decision is pending.
        if (accepted.fingerprint !== id || !keepAuto) {
          keepAuto = false;
          await this.pause();
        }
        await this.verify(project, auth);
        const user = await loadUserConfig();
        this.checkCancelled();
        const binary = await this.deps.ensureTool(this.root, {
          stage: this.stage, log: message => this.emit({ type: "phase", message }),
          env: {
            ...process.env,
            DEVSYNC_DOWNLOAD_PROXY: process.env.DEVSYNC_DOWNLOAD_PROXY ?? user.downloadProxy,
            DEVSYNC_MUTAGEN_MIRROR: process.env.DEVSYNC_MUTAGEN_MIRROR ?? user.mutagenMirror,
            DEVSYNC_MUTAGEN_ARCHIVE: process.env.DEVSYNC_MUTAGEN_ARCHIVE ?? user.mutagenArchive,
          },
        });
        await writeJson(path.join(this.dir, "tool.json"), { path: binary });
        session = new this.deps.Session(this.root, binary, auth);
        const previous = await session.get();
        if (!previous || accepted.fingerprint !== id) {
          keepAuto = false;
          await this.deps.stopWorker(this.root);
          if (previous) await session.pause();
          const preview = await this.plan(project, auth);
          if (!(await confirm(preview))) throw new SyncError("CANCELLED", "已取消，自动同步保持暂停。");
          this.checkCancelled();
          const backup = await this.phase("备份受影响的远端文件", () => this.deps.backupRemote(this.root, project.config, auth, [...preview.updated, ...preview.deleted]));
          if (!preview.remoteExists) await this.deps.createRemote(this.root, project.config, auth);
          if (previous) await session.run(["sync", "terminate", session.name]);
          await session.create(project.config, project.rules);
          await writeJson(path.join(this.dir, "accepted.json"), { fingerprint: id, backup, at: new Date().toISOString() });
          if (backup) this.emit({ type: "backup", path: backup });
        }
        this.checkCancelled();
        await session.resume();
        const status = await this.phase("同步文件", () => session.flush());
        const lastRun = { at: new Date().toISOString(), files: status.alpha.files };
        await writeJson(path.join(this.dir, "last-run.json"), lastRun);
        if (auto || keepAuto) {
          this.checkCancelled();
          await this.deps.startWorker(this.root, binary);
          keepAuto = true;
        }
        return { synced: true, ...lastRun, auto: keepAuto };
      } finally {
        if (session && !keepAuto) await session.pause();
      }
    });
  }
}
