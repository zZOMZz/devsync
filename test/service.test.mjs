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
    estimateBackup: async () => 128,
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

test("explicit key authentication mode changes require confirmation before resuming", {
  skip: process.platform === "win32",
}, async t => {
  const f = await fixture(t);
  f.config.identityFile = "/keys/dev";
  await writeJson(path.join(f.root, ".sync/config.json"), f.config);
  await f.service.sync({ auto: true, confirm: async () => true });
  await f.service.sync({ auto: true, confirm: async () => assert.fail("unchanged authentication must reuse acceptance") });
  const previous = await readJson(path.join(f.root, ".sync/accepted.json"));
  await writeJson(path.join(f.root, ".sync/control.json"), { auto: true, pid: process.pid });
  await writeJson(path.join(f.root, ".sync/auth.json"), {});
  f.calls.length = 0;
  await assert.rejects(f.service.sync({ confirm: async () => {
    assert.ok(f.calls.includes("pause"));
    return false;
  } }), { code: "CANCELLED" });
  assert.ok(!f.calls.includes("resume"));
  assert.deepEqual(await readJson(path.join(f.root, ".sync/accepted.json")), previous);
});

test("configuration reuses service-owned validation but rechecks changed answers", async t => {
  for (const change of ["none", "path", "password", "unverified"]) {
    const f = await fixture(t);
    let probes = 0, paths = 0;
    f.dependencies.probeConnection = async () => { probes++; return { home: "/home/alice" }; };
    f.dependencies.checkRemotePath = async () => { paths++; };
    const service = new ProjectSync(f.root, { dependencies: f.dependencies });
    await service.configure(async (_project, _auth, checks) => {
      const cfg = structuredClone(f.config), auth = { password: "fixture" };
      await assert.rejects(checks.probe({ ...cfg, remote: { ...cfg.remote, port: 0 } }, auth), /端口/);
      await assert.rejects(checks.checkPath({ ...cfg, remote: { ...cfg.remote, path: "/" } }, auth), /独立项目/);
      if (change !== "unverified") {
        const { path: _path, ...remote } = cfg.remote;
        await checks.probe({ ...cfg, remote }, auth);
        await checks.checkPath(cfg, auth);
      }
      if (change === "path") cfg.remote.path = "/home/alice/another";
      if (change === "password") auth.password = "changed";
      return { cfg, auth };
    }, async () => true);
    assert.equal(probes, change === "password" ? 2 : 1, change);
    assert.equal(paths, ["path", "password"].includes(change) ? 2 : 1, change);
  }
});

test("failed validation cannot be reused and cancellation keeps original credentials", async t => {
  const f = await fixture(t);
  let probes = 0;
  f.dependencies.probeConnection = async () => { if (++probes === 1) throw Error("network error"); return {}; };
  const service = new ProjectSync(f.root, { dependencies: f.dependencies });
  await assert.rejects(service.configure(async (_project, _auth, checks) => {
    const cfg = structuredClone(f.config), auth = { password: "draft" };
    await assert.rejects(checks.probe(cfg, auth), /network error/);
    await checks.checkPath(cfg, auth);
    return { cfg, auth };
  }, async () => false), { code: "CANCELLED" });
  assert.equal(probes, 2);
  assert.equal((await readJson(path.join(f.root, ".sync/auth.json"))).password, "fixture-only");
});

test("a later failed check invalidates an earlier successful validation receipt", async t => {
  const f = await fixture(t);
  let probes = 0;
  f.dependencies.probeConnection = async () => { if (++probes === 2) throw Error("connection lost"); return {}; };
  const service = new ProjectSync(f.root, { dependencies: f.dependencies });
  await service.configure(async (_project, _auth, checks) => {
    const cfg = structuredClone(f.config), auth = {};
    await checks.probe(cfg, auth);
    await assert.rejects(checks.probe(cfg, auth), /connection lost/);
    return { cfg, auth };
  }, async () => true);
  assert.equal(probes, 3);
});

test("backup policies and one-time skipping avoid remote backup work without changing project policy", async t => {
  for (const mode of ["off", "skip"]) {
    const f = await fixture(t);
    if (mode === "off") f.config.backup = { mode: "off", keep: 3 };
    await writeJson(path.join(f.root, ".sync/config.json"), f.config);
    let estimates = 0;
    f.dependencies.estimateBackup = async () => { estimates++; return 128; };
    const result = await new ProjectSync(f.root, { dependencies: f.dependencies }).sync({ confirm: async preview => {
      assert.equal(preview.backup.enabled, mode === "skip");
      return mode === "skip" ? { confirmed: true, skipBackup: true } : true;
    } });
    assert.equal(result.synced, true);
    assert.equal(estimates, mode === "off" ? 0 : 1);
    assert.ok(!f.calls.some(call => Array.isArray(call) && call[0] === "backup"));
    assert.deepEqual(await readJson(path.join(f.root, ".sync/config.json")), f.config);
    const accepted = await readJson(path.join(f.root, ".sync/accepted.json"));
    assert.equal(accepted.backup, null);
    assert.equal(accepted.backupDecision, mode === "skip" ? "skipped-once" : "disabled");
  }
});

test("auth and polling changes do not back up again; scope expansion backs up newly included files", { skip: process.platform === "win32" }, async t => {
  for (const change of ["identity", "polling", "expanded", "target"]) {
    const f = await fixture(t);
    await f.service.sync({ confirm: async () => true });
    if (change === "identity") f.config.identityFile = "/different/key";
    if (change === "target") f.config.remote.path = "/srv/new-project";
    await writeJson(path.join(f.root, ".sync/config.json"), f.config);
    if (change === "polling") await writeJson(path.join(f.root, "sync.config.json"), { pollingInterval: 5 });
    if (change === "expanded") {
      await writeJson(path.join(f.root, "sync.config.json"), { exclude: [] });
      f.dependencies.remoteManifest = async () => ({ exists: true, files: { "main.py": "old", "dist/remote.js": "old" } });
    }
    let estimates = 0;
    f.dependencies.estimateBackup = async () => { estimates++; return 128; };
    f.calls.length = 0;
    await new ProjectSync(f.root, { dependencies: f.dependencies }).sync({ confirm: async preview => {
      assert.equal(preview.backup.enabled, ["expanded", "target"].includes(change));
      return true;
    } });
    const backups = f.calls.filter(call => Array.isArray(call) && call[0] === "backup");
    assert.equal(backups.length, ["expanded", "target"].includes(change) ? 1 : 0);
    assert.equal(estimates, backups.length);
    if (change === "expanded") assert.deepEqual(backups[0][1], ["dist/remote.js"]);
  }
});

test("unknown size does not disable backup and cleanup failures are retryable after a successful sync", async t => {
  const f = await fixture(t);
  f.dependencies.estimateBackup = async () => { throw Error("stat failed"); };
  let cleanups = 0;
  f.dependencies.pruneBackups = async () => { if (++cleanups === 1) throw Error("cleanup unavailable"); return {}; };
  const service = new ProjectSync(f.root, { dependencies: f.dependencies });
  const result = await service.sync({ confirm: async preview => {
    assert.equal(preview.backup.enabled, true);
    assert.equal(preview.backup.estimatedBytes, null);
    assert.equal(preview.backup.estimateUnavailable, true);
    return true;
  } });
  assert.equal(result.synced, true);
  assert.match(result.warnings[0], /清理失败/);
  assert.equal((await readJson(path.join(f.root, ".sync/accepted.json"))).backupPendingCleanup, true);
  await service.sync({ confirm: async () => assert.fail("accepted session") });
  assert.equal(cleanups, 2);
  assert.equal((await readJson(path.join(f.root, ".sync/accepted.json"))).backupPendingCleanup, false);
});

test("failed synchronization retains backups and defers cleanup until successful retry", async t => {
  const f = await fixture(t);
  let flushes = 0, cleanups = 0;
  f.dependencies.Session = class extends f.dependencies.Session {
    async flush() { if (++flushes === 1) throw Error("write failed"); return super.flush(); }
  };
  f.dependencies.pruneBackups = async () => { cleanups++; };
  const service = new ProjectSync(f.root, { dependencies: f.dependencies });
  await assert.rejects(service.sync({ confirm: async () => true }), /write failed/);
  assert.equal(cleanups, 0);
  await service.sync({ confirm: async () => assert.fail("already accepted") });
  assert.equal(cleanups, 1);
});

test("invalid backup settings fail before connecting and non-confirming objects do not authorize sync", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.sync({ confirm: async () => ({ skipBackup: true }) }), { code: "CANCELLED" });
  assert.ok(!f.calls.includes("resume"));
  f.config.backup = { mode: "off", keep: 0 };
  await writeJson(path.join(f.root, ".sync/config.json"), f.config);
  f.dependencies.probeConnection = async () => assert.fail("invalid config must not connect");
  await assert.rejects(new ProjectSync(f.root, { dependencies: f.dependencies }).sync(), { code: "INVALID_BACKUP" });
});

test("lowering retention applies after the next successful sync without creating another backup", async t => {
  const f = await fixture(t), keeps = [];
  f.dependencies.pruneBackups = async (_root, _cfg, _auth, keep) => { keeps.push(keep); };
  const service = new ProjectSync(f.root, { dependencies: f.dependencies });
  await service.sync({ confirm: async () => true });
  f.config.backup = { mode: "auto", keep: 1 };
  await writeJson(path.join(f.root, ".sync/config.json"), f.config);
  await service.sync({ confirm: async () => assert.fail("retention is not a transfer change") });
  assert.deepEqual(keeps, [3, 1]);
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === "backup").length, 1);
});
