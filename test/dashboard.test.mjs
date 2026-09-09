import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DashboardModel } from "../src/dashboard-model.mjs";
import { ProjectRegistry } from "../src/registry.mjs";
import { projectStatus } from "../src/status.mjs";
import { command, writeJson } from "../src/core.mjs";

const state = root => projectStatus({ root, configured: true, control: {}, session: { paused: true } });
async function fixture(t, names = ["one", "two", "three"]) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "ds-dash-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const registry = new ProjectRegistry(path.join(base, "config/devsync/projects.json"));
  const roots = [];
  for (const name of names) {
    const root = path.join(base, name);
    await writeJson(path.join(root, ".sync/config.json"), { remote: { host: "dev", username: "alice", port: 22, path: "/srv/project" } });
    roots.push((await registry.add(root)).root);
  }
  return { base, registry, roots };
}

test("dashboard progressively refreshes independent projects with bounded concurrency and a timeout", async t => {
  const { registry, roots } = await fixture(t);
  let concurrent = 0, maximum = 0, sawFastBeforeTimeout = false;
  const model = new DashboardModel({ registry, concurrency: 2, readTimeout: 120,
    service: root => ({ status: async () => {
      concurrent++; maximum = Math.max(maximum, concurrent);
      if (root === roots[0]) return new Promise(() => {});
      await new Promise(resolve => setTimeout(resolve, 10));
      concurrent--; return state(root);
    } }) });
  model.on("change", () => {
    const rows = model.snapshot().projects;
    if (rows.some(p => p.root === roots[1] && p.status) && !rows.find(p => p.root === roots[0])?.error) sawFastBeforeTimeout = true;
  });
  const result = await model.snapshotOnce();
  assert.ok(maximum <= 2);
  assert.equal(sawFastBeforeTimeout, true);
  assert.equal(result.projects.find(p => p.root === roots[0]).error.code, "STATUS_TIMEOUT");
  assert.equal(result.projects.filter(p => p.status).length, 2);
  assert.ok(result.projects.every(p => !p.status?.session));
});

test("closing the model cancels pending read-only work and never stops a sync session", async t => {
  const { registry } = await fixture(t);
  let starts = 0, stops = 0;
  const model = new DashboardModel({ registry, service: () => ({
    status: async () => { starts++; return new Promise(() => {}); }, stop: async () => { stops++; },
  }) });
  model.resume();
  while (!starts) await new Promise(resolve => setTimeout(resolve, 5));
  await model.pause();
  assert.equal(stops, 0);
  assert.equal(model.jobs.size, 0);
  assert.equal(model.active, 0);
});

test("panel operations target only the selected project and preserve the service confirmation decision", async t => {
  const { registry, roots } = await fixture(t);
  const calls = [], preview = { added: ["new"], updated: [], deleted: ["old"] };
  const model = new DashboardModel({ registry, service: root => ({
    sync: async options => { calls.push([root, "start", options.auto]); return options.confirm(preview); },
    stop: async () => { calls.push([root, "stop"]); return { stopped: true }; },
  }) });
  const result = await model.operate("start", roots[1], { confirm: async value => { assert.equal(value, preview); return { confirmed: true, skipBackup: true }; } });
  assert.deepEqual(result, { confirmed: true, skipBackup: true });
  await model.operate("stop", roots[1]);
  assert.deepEqual(calls, [[roots[1], "start", true], [roots[1], "stop"]]);
  await registry.remove(roots[1]);
  await assert.rejects(model.operate("start", roots[1]), { code: "PROJECT_NOT_REGISTERED" });
  assert.equal(calls.length, 2);
});

test("missing projects remain visible and operations never recreate their directories", async t => {
  const { registry, roots } = await fixture(t, ["missing"]);
  await fs.rm(roots[0], { recursive: true });
  const model = new DashboardModel({ registry, service: () => assert.fail("must not operate on missing root") });
  const result = await model.snapshotOnce();
  assert.equal(result.projects[0].error.code, "ENOENT");
  await assert.rejects(model.operate("start", roots[0]), { code: "ENOENT" });
  await assert.rejects(fs.access(roots[0]), { code: "ENOENT" });
});

test("dashboard JSON works outside project directories without terminal control or global state writes", async t => {
  const { base, registry } = await fixture(t, []);
  const cli = new URL("../bin/devsync.mjs", import.meta.url).pathname;
  await command(process.execPath, [cli, "dashboard", "--json"], { cwd: base, env: { ...process.env, XDG_CONFIG_HOME: path.join(base, "config"), APPDATA: path.join(base, "config") } }).then(output => {
    assert.doesNotMatch(output, /\x1b\[/);
    assert.deepEqual(JSON.parse(output), { ok: true, dashboardVersion: 1, registryError: null, loading: false, projects: [] });
  });
  await assert.rejects(fs.access(registry.file), { code: "ENOENT" });
});

const python = process.env.DEVSYNC_TEST_PYTHON || "python3";
const { spawnSync } = await import("node:child_process");
const { fileURLToPath } = await import("node:url");
const hasPty = process.platform !== "win32" && spawnSync(python, ["--version"], { stdio: "ignore" }).status === 0;
for (const scenario of ["manage", "cancel-start", "configure", "index", "relocate", "details", "ctrl-c", "sigterm", "prompt-interrupt"])
  test(`dashboard PTY ${scenario}: Ink/Clack transitions preserve other projects and terminal state`, { skip: !hasPty, timeout: 25000 }, async () => {
    const result = JSON.parse(await command(python, [fileURLToPath(new URL("./fixtures/dashboard-driver.py", import.meta.url)), process.execPath,
      fileURLToPath(new URL("./fixtures/dashboard-app.mjs", import.meta.url)), scenario], { timeout: 20000 }));
    assert.equal(result.checks, "passed");
  });
