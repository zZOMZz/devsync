import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectSync } from "../src/service.mjs";
import { writeJson } from "../src/core.mjs";

const aligned = () => ({ paused: false, status: "watching", alpha: { connected: true, scanned: true, files: 2 }, beta: { connected: true, scanned: true, files: 2 } });
async function fixture(t, state, control = {}, error = null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ds-status-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [file, value] of Object.entries({ config: { remote: {} }, tool: { path: "/unused" }, control,
    "last-run": { at: "2026-09-08T00:00:00.000Z", files: 99 } }))
    await writeJson(path.join(root, `.sync/${file}.json`), value);
  const service = new ProjectSync(root, { dependencies: {
    Session: class {
      env = {};
      async get() {
        assert.equal(this.env.MUTAGEN_DISABLE_AUTOSTART, "1");
        if (error) throw error;
        return state;
      }
    },
    probeConnection: () => assert.fail("status must not connect to remote"),
    ensureTool: () => assert.fail("status must not install anything"),
    startWorker: () => assert.fail("status must not start worker"),
  } });
  const before = await Promise.all((await fs.readdir(path.join(root, ".sync"))).map(async file => [file, await fs.readFile(path.join(root, ".sync", file), "utf8")]));
  const result = await service.status();
  for (const [file, value] of before) assert.equal(await fs.readFile(path.join(root, ".sync", file), "utf8"), value);
  assert.equal((await fs.readdir(path.join(root, ".sync"))).length, before.length);
  return result;
}

test("unavailable daemon does not hide a live manager or claim synchronization stopped", async t => {
  const result = await fixture(t, null, { auto: true, pid: process.pid }, Error("daemon query timed out"));
  assert.equal(result.auto, true);
  assert.equal(result.manager.state, "running");
  assert.equal(result.sync.state, "unknown");
  assert.equal(result.sync.active, null);
  assert.equal(result.sync.aligned, null);
  assert.equal(result.state, "unavailable");
  assert.ok(result.issues.some(issue => issue.code === "SESSION_UNAVAILABLE"));
});

test("live transfer with a missing manager is explicit and offers recovery and stop", async t => {
  const result = await fixture(t, aligned(), { auto: true });
  assert.equal(result.auto, false);
  assert.equal(result.manager.state, "missing");
  assert.equal(result.sync.state, "aligned");
  assert.equal(result.sync.active, true);
  assert.ok(result.issues.some(issue => issue.code === "MANAGER_MISSING"));
  assert.ok(result.actions.some(action => action.command === "start"));
  assert.ok(result.actions.some(action => action.command === "stop"));
});

test("scanning is progress and last-run is not evidence of current alignment", async t => {
  const state = { ...aligned(), status: "scanning" };
  const result = await fixture(t, state, { auto: true, pid: process.pid });
  assert.equal(result.sync.state, "scanning");
  assert.equal(result.sync.aligned, false);
  assert.equal(result.error, null);
  assert.deepEqual(result.issues, []);
  assert.equal(result.lastRun.files, 99);
  assert.equal(result.sync.local.files, 2);
  assert.equal(result.statusVersion, 1);
  assert.deepEqual(result.session, state); // legacy data is retained
});

test("disconnected, paused and absent sessions remain distinct from a running manager", async t => {
  for (const [state, expected] of [
    [{ ...aligned(), beta: { connected: false } }, "disconnected"],
    [{ paused: true }, "paused"], [null, "not-started"],
  ]) {
    const result = await fixture(t, state, { auto: true, pid: process.pid });
    assert.equal(result.manager.state, "running");
    assert.equal(result.sync.state, expected);
    assert.notEqual(result.sync.aligned, true);
    if (expected === "paused") assert.equal(result.sync.active, false);
  }
});

test("authentication failure survives manager exit and offers configuration repair", async t => {
  const result = await fixture(t, { paused: true }, { auto: false, error: "认证失败，自动同步已暂停。" });
  assert.equal(result.manager.state, "failed");
  assert.ok(result.issues.some(issue => issue.code === "AUTH_FAILED"));
  assert.deepEqual(result.actions.map(a => a.command), ["config"]);
});

test("conflicts and file errors preserve side/path and account for omitted engine problems", async t => {
  const state = aligned();
  state.conflicts = [{ root: "src/conflict.txt", alphaChanges: [], betaChanges: [] }];
  state.excludedConflicts = 2;
  state.beta.transitionProblems = [{ path: "src/blocked.txt", error: "Permission denied" }];
  state.beta.excludedTransitionProblems = 3;
  const result = await fixture(t, state, { auto: true, pid: process.pid });
  assert.equal(result.sync.aligned, false);
  assert.ok(result.issues.some(i => i.code === "SYNC_CONFLICT" && i.path === "src/conflict.txt"));
  assert.ok(result.issues.some(i => i.code === "FILE_WRITE" && i.side === "remote" && i.path === "src/blocked.txt"));
  assert.equal(result.sync.problemCount, 7);
  assert.ok(!result.issues.some(i => i.code === "AUTH_FAILED"));
});

test("stopping manager and paused session do not show a false recovery warning", async t => {
  const result = await fixture(t, { paused: true }, { auto: false, pid: process.pid });
  assert.equal(result.manager.state, "stopping");
  assert.equal(result.auto, false);
  assert.deepEqual(result.actions, []);
});

test("unknown engine phases never claim alignment and root halts require inspection", async t => {
  const unknown = await fixture(t, { ...aligned(), status: "future-phase" }, { auto: true, pid: process.pid });
  assert.equal(unknown.sync.state, "unknown");
  assert.equal(unknown.sync.aligned, null);
  const halted = await fixture(t, { ...aligned(), status: "halted-on-root-deletion" }, { auto: true, pid: process.pid });
  assert.equal(halted.sync.state, "error");
  assert.ok(halted.issues.some(issue => issue.code === "SYNC_HALTED"));
  assert.deepEqual(halted.actions.map(a => a.command), ["stop"]);
});

test("session-construction errors retain diagnostics instead of hiding manager state", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ds-status-constructor-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeJson(path.join(root, ".sync/tool.json"), { path: "/missing" });
  await writeJson(path.join(root, ".sync/control.json"), { auto: true, pid: process.pid });
  const service = new ProjectSync(root, { dependencies: { Session: class { constructor() { throw Error("invalid tool path"); } } } });
  const result = await service.status();
  assert.equal(result.auto, true);
  assert.equal(result.sync.active, null);
  assert.ok(result.issues.some(i => i.code === "SESSION_UNAVAILABLE"));
});

test("missing tool metadata with evidence of prior activity is unknown rather than stopped", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ds-status-metadata-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeJson(path.join(root, ".sync/control.json"), { auto: true, pid: process.pid });
  const result = await new ProjectSync(root).status();
  assert.equal(result.manager.running, true);
  assert.equal(result.state, "unavailable");
  assert.equal(result.sync.active, null);
  assert.equal(result.sync.aligned, null);
  assert.ok(result.issues.some(issue => issue.code === "SESSION_UNAVAILABLE"));
});

test("historical failures retain uncertainty, group paths and expose full details on request", async () => {
  const { projectStatus, statusText } = await import("../src/status.mjs");
  const { failureRecord } = await import("../src/diagnostics.mjs");
  const lastFailure = failureRecord({ details: { issues: Array.from({ length: 9 }, (_, n) => ({ code: "FILE_WRITE", side: "remote", path: `dist/${n}.js`, message: "permission denied" })) } });
  const status = projectStatus({ root: "/project", configured: true, session: { paused: true }, lastFailure });
  assert.equal(status.sync.aligned, null);
  const text = statusText(status);
  assert.match(text, /历史失败记录/);
  assert.match(text, /另有 6 项/);
  assert.doesNotMatch(text, /dist\/8.js|devsync start/);
  assert.match(statusText(status, { verbose: true }), /dist\/8.js/);
  const recovered = projectStatus({ root: "/project", configured: true, session: { paused: true }, lastFailure, lastRun: { at: "9999", files: 9 } });
  assert.equal(recovered.lastFailure, null);
});

test("engine omitted errors and root halts fail promptly without inventing a conflict", async () => {
  const { Session } = await import("../src/session.mjs");
  for (const state of [{ beta: { excludedTransitionProblems: 4 } }, { status: "halted-on-root-deletion" }]) {
    const session = new Session("/tmp/test", "/unused", {});
    session.run = async () => {};
    session.get = async () => state;
    await assert.rejects(session.flush(), error => error.code === "SYNC_PROBLEMS" && !error.message.includes("冲突"));
  }
});

test("diagnosis distinguishes auth, permissions, storage, network and unknown errors", async () => {
  const { diagnose } = await import("../src/diagnostics.mjs");
  for (const [message, category] of [["Permission denied (publickey)", "AUTH"], ["permission denied", "PERMISSION"], ["no space left on device", "SPACE"], ["connection refused", "NETWORK"], ["unexpected engine failure", "SESSION_ERROR"]]) {
    assert.equal(diagnose({ code: "SESSION_ERROR", message }).category, category);
  }
});
