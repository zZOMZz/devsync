import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Session, sessionArguments } from "../src/session.mjs";
import { normalizeRules } from "../src/rules.mjs";
import { startWorker, stopWorker } from "../src/worker.mjs";
import { ProjectSync } from "../src/service.mjs";
import { localManifest, writeJson } from "../src/core.mjs";

// Opt-in: uses a caller-selected real Mutagen executable, with disposable local
// endpoints and isolated daemons. It never reads or contacts a developer server.
test("real Mutagen applies two project profiles and stopping one leaves the other active", {
  skip: !process.env.DEVSYNC_TEST_MUTAGEN,
}, async t => {
  const binary = path.resolve(process.env.DEVSYNC_TEST_MUTAGEN);
  const base = await fs.realpath(await fs.mkdtemp(path.join(process.platform === "darwin" ? "/private/tmp" : os.tmpdir(), "ds-engine-")));
  const sessions = [];
  t.after(async () => {
    for (const session of sessions) {
      await stopWorker(session.root).catch(() => {});
      await session.run(["sync", "terminate", session.name]).catch(() => {});
      await session.run(["daemon", "stop"]).catch(() => {});
    }
    await fs.rm(base, { recursive: true, force: true });
  });
  const fixtures = [
    { profile: "www_so_com", files: ["public/index.php", "vendor/autoload.php", ".env", "docker/.env", "docker/sdk/ignored", "resource/js/.rollup-stage-123/a", ".env.local"] },
    { profile: "python-service", files: ["main.py", "lib/tool.py", ".env", ".venv/ignored.py", "__pycache__/ignored.pyc", "build/generated"] },
  ];
  for (let index = 0; index < fixtures.length; index++) {
    const fixture = fixtures[index];
    const rules = normalizeRules(JSON.parse(await fs.readFile(new URL(`../examples/${fixture.profile}/sync.config.json`, import.meta.url))));
    const root = path.join(base, "a" + index), target = path.join(base, "b" + index);
    await fs.mkdir(root); await fs.mkdir(target);
    await fs.mkdir(path.join(root, ".sync"), { mode: 0o700 });
    for (const file of fixture.files) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), "local-" + file);
    }
    await fs.writeFile(path.join(target, "remote-only"), "delete me");
    await fs.writeFile(path.join(target, ".env.local"), "retain excluded remote env");
    const session = new Session(root, binary, {});
    sessions.push(session);
    const args = sessionArguments(root, { remote: { username: "unused", host: "unused", port: 22, path: "/unused" } }, rules);
    args[args.length - 1] = target;
    await session.run(args);
    await session.resume();
    await session.flush();
    assert.deepEqual(await localManifest(target, rules), await localManifest(root, rules));
    assert.equal(await fs.readFile(path.join(target, ".env.local"), "utf8"), "retain excluded remote env");
    await assert.rejects(fs.access(path.join(target, "remote-only")), { code: "ENOENT" });
    await writeJson(path.join(root, ".sync/tool.json"), { path: binary });
    await startWorker(root, binary);
    fixture.root = root; fixture.target = target;
  }
  await stopWorker(fixtures[0].root);
  const unmanaged = await new ProjectSync(fixtures[0].root).status();
  assert.equal(unmanaged.manager.state, "stopped");
  assert.equal(unmanaged.sync.active, true);
  assert.equal(unmanaged.auto, false);
  assert.ok(unmanaged.issues.some(issue => issue.code === "SESSION_UNMANAGED"));
  await new ProjectSync(fixtures[0].root).stop();
  await fs.writeFile(path.join(fixtures[0].root, "after-pause"), "must remain local");
  await fs.writeFile(path.join(fixtures[1].root, "after-pause"), "other project continues");
  await sessions[1].flush();
  assert.equal((await sessions[0].get()).paused, true);
  assert.equal((await sessions[1].get()).paused, false);
  await assert.rejects(fs.access(path.join(fixtures[0].target, "after-pause")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(fixtures[1].target, "after-pause"), "utf8"), "other project continues");
  await stopWorker(fixtures[1].root);
  await sessions[1].run(["daemon", "stop"]);
  const unavailable = await new ProjectSync(fixtures[1].root).status();
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.sync.active, null);
  await assert.rejects(fs.access(path.join(fixtures[1].root, ".sync/state/daemon/daemon.sock")), { code: "ENOENT" });
});
