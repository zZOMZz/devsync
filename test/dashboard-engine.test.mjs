import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Session, sessionArguments, fingerprint } from "../src/session.mjs";
import { ProjectSync } from "../src/service.mjs";
import { ProjectRegistry } from "../src/registry.mjs";
import { DashboardModel } from "../src/dashboard-model.mjs";
import { normalizeRules } from "../src/rules.mjs";
import { writeJson } from "../src/core.mjs";
import { stopWorker } from "../src/worker.mjs";

test("real dashboard management starts/stops only selected sessions and closing discovery leaves workers running", {
  skip: !process.env.DEVSYNC_TEST_MUTAGEN, timeout: 45000,
}, async t => {
  const base = await fs.mkdtemp(path.join(process.platform === "darwin" ? "/private/tmp" : os.tmpdir(), "ds-panel-engine-"));
  const binary = path.resolve(process.env.DEVSYNC_TEST_MUTAGEN), registry = new ProjectRegistry(path.join(base, "projects.json"));
  const sessions = [], roots = [];
  t.after(async () => {
    for (const session of sessions) {
      await stopWorker(session.root).catch(() => {});
      await session.run(["sync", "terminate", session.name]).catch(() => {});
      await session.run(["daemon", "stop"]).catch(() => {});
    }
    await fs.rm(base, { recursive: true, force: true });
  });
  for (let index = 0; index < 2; index++) {
    const root = path.join(base, "a" + index), target = path.join(base, "b" + index);
    await fs.mkdir(root); await fs.mkdir(target);
    await fs.writeFile(path.join(root, "source.txt"), "hello");
    const cfg = { remote: { host: "unused", username: "unused", port: 22, path: "/unused" }, backup: { mode: "off", keep: 3 } };
    const rules = normalizeRules();
    await writeJson(path.join(root, ".sync/config.json"), cfg);
    await writeJson(path.join(root, ".sync/tool.json"), { path: binary });
    const session = new Session(root, binary, {}); sessions.push(session); roots.push(root);
    const args = sessionArguments(root, cfg, rules); args[args.length - 1] = target;
    await session.run(args);
    await writeJson(path.join(root, ".sync/accepted.json"), { fingerprint: fingerprint(root, cfg, rules) });
    await registry.add(root);
  }
  const model = new DashboardModel({ registry, service: (root, options) => new ProjectSync(root, { ...options, dependencies: {
    ensureTool: async () => binary, probeConnection: async () => ({}), checkRemotePath: async () => {}, registerProject: root => registry.add(root),
  } }) });
  await model.operate("start", roots[0], { confirm: async () => assert.fail("accepted session should be reused") });
  assert.equal((await sessions[0].get()).paused, false);
  assert.equal((await sessions[1].get()).paused, true);
  await model.operate("start", roots[1]);
  const snapshot = await model.snapshotOnce();
  assert.equal(snapshot.projects.filter(project => project.status.auto).length, 2);
  await model.pause();
  assert.equal((await new ProjectSync(roots[1]).status()).auto, true);
  await model.operate("stop", roots[0]);
  assert.equal((await sessions[0].get()).paused, true);
  assert.equal((await new ProjectSync(roots[1]).status()).auto, true);
  await fs.writeFile(path.join(roots[1], "still-running"), "other project is active");
  await sessions[1].flush();
  assert.equal(await fs.readFile(path.join(base, "b1/still-running"), "utf8"), "other project is active");
});
