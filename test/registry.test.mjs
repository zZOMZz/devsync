import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ProjectRegistry } from "../src/registry.mjs";
import { command, writeJson } from "../src/core.mjs";

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "ds-registry-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const registry = new ProjectRegistry(path.join(base, "user/projects.json"));
  const project = async name => {
    const root = path.join(base, name);
    await writeJson(path.join(root, ".sync/config.json"), { remote: { host: "private-host" } });
    await writeJson(path.join(root, ".sync/auth.json"), { password: "fixture-secret" });
    return fs.realpath(root);
  };
  return { base, registry, project };
}

test("registry discovery is read-only and registration stores only canonical project metadata", async t => {
  const { registry, project } = await fixture(t);
  assert.deepEqual(await registry.list(), []);
  await assert.rejects(fs.access(path.dirname(registry.file)), { code: "ENOENT" });
  const root = await project("one");
  await registry.add(root);
  await registry.add(root + path.sep + ".");
  assert.deepEqual(await registry.list(), [{ root, name: "one" }]);
  const text = await fs.readFile(registry.file, "utf8");
  assert.doesNotMatch(text, /fixture-secret|private-host/);
  if (process.platform !== "win32") assert.equal((await fs.stat(registry.file)).mode & 0o777, 0o600);
});

test("symlink aliases deduplicate and removal does not change project configuration", { skip: process.platform === "win32" }, async t => {
  const { base, registry, project } = await fixture(t);
  const root = await project("one"), link = path.join(base, "alias");
  await fs.symlink(root, link);
  await registry.add(link); await registry.add(root);
  assert.equal((await registry.list()).length, 1);
  await registry.remove(root);
  assert.deepEqual(await registry.list(), []);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, ".sync/auth.json"), "utf8")).password, "fixture-secret");
});

test("concurrent processes preserve registrations and release the index lock", async t => {
  const { registry, project } = await fixture(t);
  const roots = await Promise.all(["one", "two", "three"].map(project));
  const source = `import {ProjectRegistry} from ${JSON.stringify(new URL("../src/registry.mjs", import.meta.url).href)};await new ProjectRegistry(process.argv[1]).add(process.argv[2]);`;
  await Promise.all(roots.map(root => command(process.execPath, ["--input-type=module", "-e", source, registry.file, root])));
  assert.deepEqual((await registry.list()).map(p => p.root).sort(), roots.sort());
  await assert.rejects(fs.access(registry.file + ".lock"), { code: "ENOENT" });
});

test("missing directories can be relocated or removed without overwriting invalid registry data", async t => {
  const { registry, project } = await fixture(t);
  const root = await project("old"); await registry.add(root);
  const moved = path.join(path.dirname(root), "moved");
  await fs.rename(root, moved);
  assert.equal((await registry.list())[0].root, root);
  await registry.relocate(root, moved);
  assert.equal((await registry.list())[0].root, await fs.realpath(moved));
  await fs.rm(moved, { recursive: true });
  await registry.remove(await fs.realpath(path.dirname(moved)) + path.sep + "moved");
  assert.deepEqual(await registry.list(), []);
  await fs.writeFile(registry.file, '{broken');
  const another = await project("another");
  await assert.rejects(registry.add(another), { code: "REGISTRY_UNAVAILABLE" });
  assert.equal(await fs.readFile(registry.file, "utf8"), '{broken');
});
