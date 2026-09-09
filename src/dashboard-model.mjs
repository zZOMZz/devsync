import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { readJson } from "./core.mjs";
import { ProjectRegistry } from "./registry.mjs";
import { ProjectSync } from "./service.mjs";
import { SyncError } from "./errors.mjs";

export class DashboardModel extends EventEmitter {
  constructor({ registry = new ProjectRegistry(), service = (root, options) => new ProjectSync(root, options), interval = 3000, concurrency = 3, readTimeout = 12000 } = {}) {
    super();
    this.registry = registry; this.service = service;
    this.interval = interval; this.concurrency = concurrency;
    this.readTimeout = readTimeout;
    this.rows = new Map(); this.jobs = new Map(); this.queue = [];
    this.active = 0; this.paused = true; this.epoch = 0;
    this.error = null; this.loading = false;
  }
  snapshot() {
    return { registryError: this.error, loading: this.loading,
      projects: [...this.rows.values()].sort((a, b) => Number(Boolean(b.status?.auto)) - Number(Boolean(a.status?.auto)) || a.name.localeCompare(b.name) || a.root.localeCompare(b.root)) };
  }
  changed() { this.emit("change"); }
  resume() {
    this.paused = false;
    void this.refresh();
    clearInterval(this.timer);
    this.timer = setInterval(() => { void this.refresh(); }, this.interval);
    this.timer.unref();
  }
  async pause() {
    this.paused = true; this.epoch++;
    clearInterval(this.timer);
    for (const job of this.queue.splice(0)) { this.jobs.delete(job.root); job.done(); }
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map(job => job.promise));
  }
  async refresh() {
    if (this.paused || this.loading) return;
    const epoch = this.epoch;
    this.loading = true;
    this.changed();
    try {
      const projects = await this.registry.list();
      if (this.paused || epoch !== this.epoch) return;
      this.error = null;
      const roots = new Set(projects.map(p => p.root));
      for (const root of this.rows.keys()) if (!roots.has(root)) { this.rows.delete(root); this.jobs.get(root)?.controller.abort(); }
      for (const project of projects) {
        this.rows.set(project.root, { ...this.rows.get(project.root), ...project });
        this.schedule(project.root);
      }
    } catch (error) {
      if (!this.paused && epoch === this.epoch) this.error = error.message;
    } finally { this.loading = false; this.changed(); }
  }
  schedule(root) {
    if (this.jobs.has(root) || this.paused) return;
    const job = { root, epoch: this.epoch, controller: new AbortController() };
    job.promise = new Promise(resolve => { job.done = resolve; });
    this.jobs.set(root, job); this.queue.push(job); this.drain();
  }
  drain() {
    while (!this.paused && this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift(); this.active++;
      void this.read(job).finally(() => {
        this.active--; this.jobs.delete(job.root); job.done(); this.drain();
      });
    }
  }
  async read(job) {
    let result;
    const interrupted = () => new SyncError(job.timedOut ? "STATUS_TIMEOUT" : "INTERRUPTED", job.timedOut ? "项目状态查询超时，请检查本地目录或后台服务。" : "查询已取消。");
    let rejectAbort;
    const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
    const abort = () => rejectAbort(interrupted());
    job.controller.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { job.timedOut = true; job.controller.abort(); }, this.readTimeout);
    try {
      result = await Promise.race([aborted, (async () => {
        if (!(await fs.stat(job.root)).isDirectory()) throw new SyncError("PROJECT_UNAVAILABLE", "项目目录不可用，请重新定位或移除记录。");
        const config = await readJson(path.join(job.root, ".sync/config.json"), null);
        if (job.controller.signal.aborted) throw interrupted();
        const status = await this.service(job.root, { signal: job.controller.signal }).status();
        const { session: _engine, ...summary } = status;
        const remote = config?.remote;
        return { status: summary, error: null,
          target: remote ? `${remote.username}@${remote.host}:${remote.port}:${remote.path}` : null };
      })()]);
    } catch (error) {
      result = { status: null, target: null, error: { code: error.code || "STATUS_FAILED",
        message: error.code === "ENOENT" ? "项目目录不可用，请重新定位或移除记录。" : error.message } };
    } finally {
      clearTimeout(timer);
      job.controller.signal.removeEventListener("abort", abort);
    }
    if (!this.paused && job.epoch === this.epoch && (!job.controller.signal.aborted || job.timedOut) && this.rows.has(job.root)) {
      this.rows.set(job.root, { ...this.rows.get(job.root), ...result, updatedAt: new Date().toISOString() });
      this.changed();
    }
  }
  async snapshotOnce() {
    this.paused = false;
    await this.refresh();
    await Promise.allSettled([...this.jobs.values()].map(job => job.promise));
    const result = this.snapshot();
    await this.pause();
    return result;
  }
  async operate(type, root, { confirm, ...options } = {}) {
    if (!["start", "stop"].includes(type)) throw new SyncError("USAGE", "未知的面板操作。");
    await this.requireProject(root);
    const service = this.service(root, options);
    return type === "stop" ? service.stop() : service.sync({ auto: true, confirm });
  }
  async requireProject(root) {
    if (!(await this.registry.list()).some(project => project.root === root))
      throw new SyncError("PROJECT_NOT_REGISTERED", "项目已从索引移除，请刷新列表。");
    // Recheck a stale row before any command can create private state on disk.
    if (!(await fs.stat(root)).isDirectory()) throw new SyncError("PROJECT_UNAVAILABLE", "项目目录不可用。");
  }
  async configure(root, collect, confirm, options) {
    await this.requireProject(root);
    return this.service(root, options).configure(collect, confirm);
  }
}
