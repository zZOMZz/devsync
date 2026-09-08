import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { backupPolicy, backupScope, planBackup, ownedBackup, backupOwner } from "../src/backup.mjs";
import { backupRemote, pruneBackups, estimateBackup } from "../src/remote.mjs";
import { normalizeRules } from "../src/rules.mjs";
import { command, readJson, writeJson } from "../src/core.mjs";

const cfg = { remote: { host: "dev", username: "alice", port: 22, path: "/srv/project" } };
const rules = normalizeRules();
const diff = { updated: ["main.js", "dist/output.js"], deleted: ["old.js", ".env"] };

test("backup policy validates modes and bounded retention", () => {
  assert.deepEqual(backupPolicy(), { mode: "auto", keep: 3 });
  assert.deepEqual(backupPolicy({ mode: "off", keep: 1 }), { mode: "off", keep: 1 });
  for (const value of [null, false, [], { mode: "always" }, { keep: 0 }, { keep: 101 }, { keep: "3" }, { unknown: 1 }])
    assert.throws(() => backupPolicy(value), { code: "INVALID_BACKUP" });
});

test("first contact and changed targets back up affected files; empty and disabled backups do no work", () => {
  const initial = planBackup("/project", cfg, rules, diff);
  assert.equal(initial.enabled, true);
  assert.equal(initial.fileCount, 4);
  const accepted = { backupScope: backupScope("/project", cfg, rules) };
  const changed = planBackup("/project", { remote: { ...cfg.remote, path: "/srv/other" } }, rules, diff, accepted);
  assert.equal(changed.reason, "target-changed");
  assert.equal(changed.fileCount, 4);
  assert.equal(planBackup("/project", cfg, rules, { updated: [], deleted: [] }).enabled, false);
  assert.equal(planBackup("/project", { ...cfg, backup: { mode: "off" } }, rules, diff).enabled, false);
});

test("authentication and polling changes do not trigger backups; expanded scope backs up newly managed paths only", () => {
  const accepted = { backupScope: backupScope("/project", cfg, rules) };
  const changed = { ...cfg, identityFile: "/new/key" };
  assert.equal(planBackup("/project", changed, normalizeRules({ pollingInterval: 5 }), { updated: ["main.js"], deleted: ["old.js"] }, accepted).enabled, false);
  const expanded = planBackup("/project", changed, normalizeRules({ exclude: [], envFiles: [".env"] }), diff, accepted);
  assert.equal(expanded.reason, "scope-expanded");
  assert.deepEqual(expanded.files, ["dist/output.js", ".env"]);
  const invalid = { backupScope: { ...accepted.backupScope, rules: {} } };
  assert.equal(planBackup("/project", cfg, rules, diff, invalid).reason, "unknown-history");
});

test("size estimation stats only supplied paths and rejects incomplete measurements", async () => {
  await assert.rejects(estimateBackup("/project", cfg, {}, ["../outside"], async () => assert.fail()), { code: "INVALID_BACKUP" });
  const bytes = await estimateBackup("/project", cfg, {}, ["a file", "-option"], async (_root, _cfg, _auth, script, input) => {
    assert.match(script, /-maxdepth 0/);
    assert.match(script, /xargs -0/);
    assert.equal(input.toString(), "./a file\0./-option\0");
    return "12\n34\n";
  });
  assert.equal(bytes, 46);
  await assert.rejects(estimateBackup("/project", cfg, {}, ["a", "b"], async () => "12\n"), /文件大小/);
  assert.equal(await estimateBackup("/project", cfg, {}, [], async () => assert.fail()), 0);
});

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "ds-backup-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "local"), remote = path.join(base, "remote's project");
  await fs.mkdir(root); await fs.mkdir(remote);
  await fs.writeFile(path.join(remote, "file with spaces.txt"), "original remote contents");
  const config = { remote: { ...cfg.remote, path: remote + "/" } };
  const run = async (_root, _cfg, _auth, script, input) => command("sh", ["-c", script], { input, timeout: 10000 });
  return { base, root, remote, config, run, create: () => backupRemote(root, config, {}, ["file with spaces.txt"], run) };
}

test("verified archives retain only this project's recorded backups and preserve unrelated files", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), files = [];
  for (let index = 0; index < 5; index++) files.push(await f.create());
  assert.ok(files.every(file => ownedBackup(f.root, f.config, file)));
  assert.ok(files.every(file => path.dirname(file) === f.base)); // trailing slash stays outside project
  assert.match(await command("tar", ["-tzf", files[0]]), /file with spaces.txt/);
  const legacy = f.remote + ".sync-backup-2020.tar.gz";
  const untracked = `${f.remote}.sync-backup-${backupOwner(f.root)}-2020-01-01T00-00-00-000Z-${randomUUID()}.tar.gz`;
  await fs.writeFile(legacy, "legacy backup"); await fs.writeFile(untracked, "not recorded");
  const otherRoot = path.join(f.base, "another-project"); await fs.mkdir(otherRoot);
  const other = await backupRemote(otherRoot, f.config, {}, ["file with spaces.txt"], f.run);
  assert.equal((await pruneBackups(f.root, f.config, {}, 3, f.run)).removed, 2);
  for (const file of files.slice(0, 2)) await assert.rejects(fs.access(file), { code: "ENOENT" });
  for (const file of [...files.slice(2), legacy, untracked, other]) await fs.access(file);
  assert.equal((await readJson(path.join(f.root, ".sync/backups.json"))).entries.length, 3);
});

test("failed backup removes its partial archive and never registers or prunes old copies", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t), valid = await f.create();
  await assert.rejects(backupRemote(f.root, f.config, {}, ["missing"], f.run));
  assert.equal((await readJson(path.join(f.root, ".sync/backups.json"))).entries.length, 1);
  await fs.access(valid);
  assert.ok(!(await fs.readdir(f.base)).some(file => file.endsWith(".partial")));
});

test("cleanup rejects symlink/directory substitutions and missing retained archives without deleting candidates", { skip: process.platform === "win32" }, async t => {
  for (const scenario of ["symlink", "directory", "missing-retained"]) {
    const f = await fixture(t), first = await f.create(), second = await f.create();
    if (scenario === "symlink") {
      await fs.rm(first);
      await fs.symlink(path.join(f.remote, "file with spaces.txt"), first);
    } else if (scenario === "directory") {
      await fs.rm(first);
      await fs.mkdir(first);
    } else await fs.rm(second);
    await assert.rejects(pruneBackups(f.root, f.config, {}, 1, f.run));
    await fs.lstat(first);
    assert.equal((await readJson(path.join(f.root, ".sync/backups.json"))).entries.length, 2);
    assert.equal(await fs.readFile(path.join(f.remote, "file with spaces.txt"), "utf8"), "original remote contents");
  }
});

test("unrecorded ownership and corrupt ledger cannot authorize cleanup", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  await writeJson(path.join(f.root, ".sync/backups.json"), { version: 1, entries: [{ path: path.join(f.remote, "file with spaces.txt"), target: "fake" }] });
  assert.deepEqual(await pruneBackups(f.root, f.config, {}, 1, async () => assert.fail()), { removed: 0 });
  await writeJson(path.join(f.root, ".sync/backups.json"), { entries: [] });
  await assert.rejects(pruneBackups(f.root, f.config, {}, 1, async () => assert.fail()), { code: "INVALID_BACKUP" });
});
