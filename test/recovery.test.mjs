import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Session, sessionArguments } from "../src/session.mjs";
import { writeJson } from "../src/core.mjs";

test("real engine recovers a disabled controller left by a missing archive without affecting another project", {
  skip: !process.env.DEVSYNC_TEST_MUTAGEN, timeout: 30000,
}, async t => {
  const base = await fs.mkdtemp(path.join(process.platform === "darwin" ? "/private/tmp" : os.tmpdir(), "ds-recover-"));
  const binary = path.resolve(process.env.DEVSYNC_TEST_MUTAGEN), sessions = [], fixtures = [];
  t.after(async () => {
    for (const session of sessions) {
      await session.run(["sync", "terminate", session.name]).catch(() => {});
      await session.run(["daemon", "stop"]).catch(() => {});
    }
    await fs.rm(base, { recursive: true, force: true });
  });
  for (let i = 0; i < 2; i++) {
    const root = path.join(base, "a" + i), target = path.join(base, "b" + i);
    await fs.mkdir(root); await fs.mkdir(target);
    await writeJson(path.join(root, ".sync/config.json"), { fixture: "keep configuration" });
    await writeJson(path.join(root, ".sync/auth.json"), { fixture: "keep credentials" });
    const session = new Session(root, binary, {}); sessions.push(session);
    const args = sessionArguments(root, { remote: { username: "unused", host: "unused", port: 22, path: "/unused" } });
    args[args.length - 1] = target;
    await session.run(args);
    fixtures.push({ root, target, args });
  }
  await sessions[1].resume(); await sessions[1].flush();
  const broken = sessions[0], { root, target, args } = fixtures[0];
  const original = await broken.get();
  await fs.rm(path.join(root, ".sync/state/archives", original.identifier));
  // Mutagen removes the session file, then fails on the missing archive. Its
  // in-memory controller remains registered but disabled.
  await assert.rejects(broken.run(["sync", "terminate", broken.name]), /unable to remove archive from disk/);
  await assert.rejects(broken.run(["sync", "pause", broken.name]), /controller disabled/);
  await broken.pause();
  assert.equal(await broken.get(), undefined);
  await broken.run(args);
  const next = await broken.get();
  await fs.rm(path.join(root, ".sync/state/archives", next.identifier));
  await broken.terminate();
  assert.equal(await broken.get(), undefined);
  await broken.run(args);
  await fs.writeFile(path.join(root, "restored.txt"), "sync works again");
  await broken.resume(); await broken.flush();
  assert.equal(await fs.readFile(path.join(target, "restored.txt"), "utf8"), "sync works again");
  await fs.writeFile(path.join(fixtures[1].root, "unaffected.txt"), "other project keeps running");
  await sessions[1].flush();
  assert.equal((await sessions[1].get()).paused, false);
  assert.equal(await fs.readFile(path.join(fixtures[1].target, "unaffected.txt"), "utf8"), "other project keeps running");
  assert.equal(JSON.parse(await fs.readFile(path.join(root, ".sync/config.json"))).fixture, "keep configuration");
  assert.equal(JSON.parse(await fs.readFile(path.join(root, ".sync/auth.json"))).fixture, "keep credentials");
});

test("recovery never discards persisted sessions or treats permission failures as missing state", async t => {
  const root = await fs.mkdtemp(path.join(process.platform === "darwin" ? "/private/tmp" : os.tmpdir(), "ds-recovery-guard-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = { identifier: "sync_fixture", paused: false };
  await writeJson(path.join(root, ".sync/state/sessions", state.identifier), { marker: "preserve" });
  const session = new Session(root, "/unused", {});
  session.get = async () => state;
  let resets = 0;
  session.stopDaemon = async () => { resets++; };
  const disabled = Error("unable to pause session: controller disabled");
  session.run = async () => { throw disabled; };
  await assert.rejects(session.pause(), error => error === disabled);
  assert.equal(resets, 0);
  assert.match(await fs.readFile(path.join(root, ".sync/state/sessions", state.identifier), "utf8"), /preserve/);
  await fs.rm(path.join(root, ".sync/state/sessions", state.identifier));
  const denied = Error("unable to remove archive from disk: permission denied");
  session.run = async () => { throw denied; };
  await assert.rejects(session.terminate(), error => error === denied);
  await assert.rejects(session.pause(), error => error === denied);
  assert.equal(resets, 0);
});
