import fs from "node:fs/promises";
import path from "node:path";
import { readJson, writeJson } from "./core.mjs";
import { resolveProject, userConfigPath } from "./project.mjs";
import { withCacheLock } from "./cache.mjs";
import { SyncError } from "./errors.mjs";

export const registryPath = () => path.join(path.dirname(userConfigPath()), "projects.json");
const key = root => process.platform === "win32" ? root.toLowerCase() : root;

export class ProjectRegistry {
  constructor(file = registryPath()) { this.file = file; }
  async list() {
    let value;
    try { value = await readJson(this.file, { version: 1, projects: [] }); }
    catch (error) { throw new SyncError("REGISTRY_UNAVAILABLE", `无法读取项目索引 ${this.file}：${error.message}`); }
    if (value?.version !== 1 || !Array.isArray(value.projects) || value.projects.some(p =>
      !p || typeof p.root !== "string" || !path.isAbsolute(p.root) || typeof p.name !== "string" || !p.name.trim()))
      throw new SyncError("INVALID_REGISTRY", `项目索引格式无效：${this.file}`);
    const roots = new Set();
    return value.projects.filter(p => { const id = key(p.root); if (roots.has(id)) return false; roots.add(id); return true; })
      .map(({ root, name }) => ({ root, name }));
  }
  async edit(change) {
    return withCacheLock(this.file + ".lock", async () => {
      const projects = await this.list();
      const result = change(projects);
      await writeJson(this.file, { version: 1, projects });
      return result;
    }, { waitMs: 5000, pollMs: 50, timeoutMessage: "另一个进程正在更新项目索引，请稍后重试。" });
  }
  async configuredRoot(directory) {
    const root = await resolveProject(directory);
    try {
      if (!(await fs.stat(path.join(root, ".sync/config.json"))).isFile()) throw Error("not a file");
    } catch {
      throw new SyncError("NOT_CONFIGURED", "此目录尚未配置 devsync，请先在该目录执行 devsync init。");
    }
    return root;
  }
  async add(directory) {
    const root = await this.configuredRoot(directory);
    return this.edit(projects => {
      const existing = projects.find(p => key(p.root) === key(root));
      if (existing) return existing;
      const project = { root, name: path.basename(root) || root };
      projects.push(project);
      return project;
    });
  }
  async remove(root) {
    return this.edit(projects => {
      const index = projects.findIndex(p => key(p.root) === key(root));
      if (index !== -1) projects.splice(index, 1);
    });
  }
  async relocate(oldRoot, directory) {
    const root = await this.configuredRoot(directory);
    return this.edit(projects => {
      const old = projects.findIndex(p => key(p.root) === key(oldRoot));
      if (old === -1) throw new SyncError("PROJECT_NOT_REGISTERED", "原项目已从索引移除，请重新添加。");
      const existing = projects.find(p => key(p.root) === key(root));
      if (existing && key(root) !== key(oldRoot)) { projects.splice(old, 1); return existing; }
      return projects[old] = { root, name: path.basename(root) || root };
    });
  }
}

export const registerProject = root => new ProjectRegistry().add(root);
