import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectSync } from "../src/service.mjs";
import { writeJson, readJson } from "../src/core.mjs";
import { normalizeRules } from "../src/rules.mjs";
import { fingerprint } from "../src/session.mjs";
import { withCacheLock } from "../src/cache.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "devsync-service-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { remote: { host: "dev", username: "alice", port: 22, path: "/home/alice/project" } };
  await writeJson(path.join(root, ".sync/config.json"), config);
  await writeJson(path.join(root, ".sync/auth.json"), { password: "fixture-only" });
  await fs.writeFile(path.join(root, "main.py"), "print('hello')");
  let state = null;
  const calls = [];
  const dependencies = {
    ensureTool: async () => { calls.push("tool"); return "/mock/mutagen"; },
    remoteManifest: async () => ({ exists: true, files: { "main.py": "old", "obsolete.py": "old" } }),
    backupRemote: async (_root, _config, _auth, files) => { calls.push(["backup", files]); return "/backup.tar.gz"; },
    createRemote: async () => { calls.push("mkdir"); },
    probeConnection: async () => ({ home: "/home/alice" }),
    checkRemotePath: async () => {},
    stopWorker: async () => { calls.push("stopWorker"); },
    startWorker: async () => { calls.push("startWorker"); },
    Session: class {
      constructor() { this.name = "project-sync"; this.env = {}; }
      async get() { return state; }
      async pause() { calls.push("pause"); if (state) state.paused = true; }
      async create(_cfg, rules) { calls.push(["create", rules]); state = { paused: true }; }
      async resume() { calls.push("resume"); state.paused = false; }
      async flush() { calls.push("flush"); return { alpha: { files: 1 } }; }
      async run(args) { calls.push(args); }
    },
  };
  return { root, config, calls, dependencies, service: new ProjectSync(root, { dependencies }), setState: value => { state = value; } };
}

test("first sync confirms a preview, backs up, creates a session and pauses after completion", async t => {
  const f = await fixture(t);
  const result = await f.service.sync({ confirm: async preview => {
    assert.deepEqual(preview.updated, ["main.py"]);
    assert.deepEqual(preview.deleted, ["obsolete.py"]);
    assert.equal(f.calls.some(c => Array.isArray(c) && c[0] === "backup"), false);
    return true;
  } });
  assert.equal(result.auto, false);
  const names = f.calls.map(c => Array.isArray(c) ? c[0] : c);
  assert.ok(names.indexOf("backup") < names.indexOf("create"));
  assert.ok(names.indexOf("create") < names.indexOf("resume"));
  assert.equal(names.at(-1), "pause");
  assert.equal((await readJson(path.join(f.root, ".sync/accepted.json"))).backup, "/backup.tar.gz");
});

test("cancelled preview neither backs up nor starts or replaces a session", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.sync({ confirm: async () => false }), { code: "CANCELLED" });
  for (const name of ["backup", "create", "resume", "startWorker"])
    assert.equal(f.calls.some(c => (Array.isArray(c) ? c[0] : c) === name), false);
  await assert.rejects(fs.access(path.join(f.root, ".sync/accepted.json")), { code: "ENOENT" });
});

test("a backup failure prevents synchronization and leaves the project paused", async t => {
  const f = await fixture(t);
  f.dependencies.backupRemote = async () => { throw Error("backup failed"); };
  const service = new ProjectSync(f.root, { dependencies: f.dependencies });
  await assert.rejects(service.sync({ confirm: async () => true }), /backup failed/);
  assert.ok(!f.calls.includes("resume"));
  assert.equal(f.calls.at(-1), "pause");
});

test("start keeps the session running and repeated start reuses its accepted session", async t => {
  const f = await fixture(t);
  const first = await f.service.sync({ auto: true, confirm: async () => true });
  assert.equal(first.auto, true);
  assert.equal(f.calls.at(-1), "startWorker");
  await f.service.sync({ auto: true, confirm: async () => assert.fail("must not reconfirm") });
  assert.equal(f.calls.filter(c => Array.isArray(c) && c[0] === "create").length, 1);
});

test("changed project rules pause the existing target and require a new preview", async t => {
  const f = await fixture(t);
  await writeJson(path.join(f.root, ".sync/accepted.json"), { fingerprint: fingerprint(f.root, f.config, normalizeRules()) });
  await writeJson(path.join(f.root, "sync.config.json"), { envFiles: [".env"] });
  await writeJson(path.join(f.root, ".sync/control.json"), { auto: true, pid: process.pid });
  f.setState({ paused: false });
  await assert.rejects(f.service.sync({ confirm: async () => {
    assert.ok(f.calls.includes("pause")); return false;
  } }), { code: "CANCELLED" });
  assert.equal(f.calls.at(-1), "pause");
});

test("preview requires no tool installation and never writes to the remote", async t => {
  const f = await fixture(t);
  const result = await f.service.preview();
  assert.equal(result.auto, false);
  assert.deepEqual(result.deleted, ["obsolete.py"]);
  assert.deepEqual(f.calls, ["stopWorker"]);
});

test("configuration cancellation preserves credentials; confirmation creates public rules without secrets", async t => {
  const f = await fixture(t);
  const candidate = { cfg: { remote: { ...f.config.remote, host: "new" } }, auth: { password: "new-fixture" } };
  await assert.rejects(f.service.configure(async () => candidate, async () => false), { code: "CANCELLED" });
  assert.equal((await readJson(path.join(f.root, ".sync/auth.json"))).password, "fixture-only");
  await assert.rejects(fs.access(path.join(f.root, "sync.config.json")), { code: "ENOENT" });
  await f.service.configure(async () => candidate, async () => true);
  const rules = await fs.readFile(path.join(f.root, "sync.config.json"), "utf8");
  assert.doesNotMatch(rules, /new-fixture|remote|password/);
  assert.match(await fs.readFile(path.join(f.root, ".gitignore"), "utf8"), /\.sync\//);
});

test("stopping works even when the public rules file is invalid", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "sync.config.json"), "invalid-json");
  assert.equal((await f.service.stop()).stopped, true);
});

test("project locking interoperates with an existing numeric command lock", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, ".sync/command.lock"), String(process.pid));
  await assert.rejects(f.service.stop(), /另一个同步命令/);
  assert.equal(await fs.readFile(path.join(f.root, ".sync/command.lock"), "utf8"), String(process.pid));
});

test("status reads an existing session with daemon autostart disabled", async t => {
  const f = await fixture(t);
  await writeJson(path.join(f.root, ".sync/tool.json"), { path: "/mock/mutagen" });
  f.dependencies.Session = class {
    env = {};
    async get() { assert.equal(this.env.MUTAGEN_DISABLE_AUTOSTART, "1"); return { paused: true }; }
  };
  const result = await new ProjectSync(f.root, { dependencies: f.dependencies }).status();
  assert.equal(result.state, "paused");
  assert.equal(result.auto, false);
});
