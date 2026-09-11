import fs from "node:fs/promises";
import path from "node:path";
import { runDashboard } from "../../src/dashboard.mjs";
import { dashboardView } from "../../src/dashboard-view.mjs";
import { DashboardModel } from "../../src/dashboard-model.mjs";
import { ProjectRegistry } from "../../src/registry.mjs";
import { projectStatus } from "../../src/status.mjs";
import { readJson, writeJson } from "../../src/core.mjs";
import { SyncError } from "../../src/errors.mjs";
const base = process.argv[2], stateFile = path.join(base, "state.json");
const registry = new ProjectRegistry(path.join(base, "projects.json"));
const service = root => ({
  configure: async (collect, confirm) => {
    const config = await readJson(path.join(root, ".sync/config.json"));
    const answers = await collect({ config }, {}, { probe: async () => ({ home: "/srv/alice" }), checkPath: async () => {} });
    if (!(await confirm({ local: root, remote: answers.cfg.remote, envFiles: [], backup: answers.cfg.backup })))
      throw new SyncError("CANCELLED", "已取消，原配置已保留。");
    await writeJson(path.join(root, ".sync/config.json"), answers.cfg);
    await fs.appendFile(path.join(base, "calls"), JSON.stringify(["configure", root]) + "\n");
    return { configured: true };
  },
  status: async () => {
    const value = (await readJson(stateFile))[root] || { auto: false };
    return projectStatus({ root, configured: true, control: value.auto ? { auto: true, pid: process.pid } : {}, session: value.auto ? {
      name: "project-sync", paused: false, status: "watching", alpha: { connected: true, scanned: true, files: 1 }, beta: { connected: true, scanned: true, files: 1 },
    } : { paused: true }, lastFailure: value.lastFailure || null });
  },
  sync: async ({ auto, confirm }) => {
    const preview = { scope: { local: root, remote: { host: "dev", username: "alice", port: 22, path: "/srv/project" }, envFiles: [], backup: { mode: "off", keep: 3 } },
      remoteExists: true, added: ["new.txt"], updated: [], deleted: ["old.txt"], backup: { enabled: false, mode: "off", reason: "disabled", fileCount: 0 } };
    const decision = await confirm(preview);
    if (decision !== true && decision?.confirmed !== true) throw new SyncError("CANCELLED", "已取消，自动同步保持暂停。");
    const states = await readJson(stateFile); states[root] = { auto };
    await writeJson(stateFile, states);
    await fs.appendFile(path.join(base, "calls"), JSON.stringify(["start", root]) + "\n");
    return { synced: true, files: 1, auto };
  },
  stop: async () => {
    const states = await readJson(stateFile); states[root] = { auto: false };
    await writeJson(stateFile, states);
    await fs.appendFile(path.join(base, "calls"), JSON.stringify(["stop", root]) + "\n");
    return { stopped: true };
  },
});
try {
  await runDashboard({ model: new DashboardModel({ registry, service, interval: 100 }),
    view: (model, options) => dashboardView(model, { ...options, selectedRoot: options.selectedRoot || path.join(base, "one") }) });
} catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = error.code === "INTERRUPTED" ? 130 : 1; }
