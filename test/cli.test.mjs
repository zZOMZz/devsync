import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { command, writeJson } from "../src/core.mjs";
import { parseArgs } from "../src/cli.mjs";
const bin = fileURLToPath(new URL("../bin/devsync.mjs", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

test("CLI resolves cwd and explicit --dir without requiring package.json", async t => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "devsync-cwd-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  for (const [args, cwd] of [[["status", "--json"], project], [["status", "--json", "--dir", project], packageRoot]]) {
    const result = JSON.parse(await command(process.execPath, [bin, ...args], { cwd }));
    assert.equal(result.project, await fs.realpath(project));
    assert.equal(result.configured, false);
    assert.equal(result.ok, true);
  }
  assert.deepEqual(await fs.readdir(project), []);
});

test("version/help and read-only stop do not create project files", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "devsync-readonly-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal((await command(process.execPath, [bin, "--version"], { cwd: root })).trim(), "0.1.0");
  assert.match(await command(process.execPath, [bin, "--help"], { cwd: root }), /preview/);
  assert.equal(JSON.parse(await command(process.execPath, [bin, "stop", "--json"], { cwd: root })).stopped, true);
  assert.deepEqual(await fs.readdir(root), []);
});

test("invalid arguments fail before configuration or tool setup", () => {
  for (const args of [["upload"], ["sync", "--wat"], ["status", "--dir"], ["init", "--json"], ["sync", "--binary", "x"]])
    assert.throws(() => parseArgs(args), { code: "USAGE" });
});

test("non-interactive errors use a single structured JSON response", async t => {
  const { spawn } = await import("node:child_process");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "devsync-errors-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [bin, "sync", "--json", "--dir", root]);
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.on("close", resolve));
  assert.equal(code, 1);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "NOT_CONFIGURED");
  assert.equal(stderr, "");
});

test("packed npm artifact installs into an isolated prefix and runs outside its repository", { skip: process.platform === "win32" }, async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "devsync-package-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const pack = JSON.parse(await command(npm, ["--cache", path.join(base, "npm-cache"), "pack", "--json", "--ignore-scripts", "--pack-destination", base], { cwd: packageRoot }))[0];
  assert.ok(pack.files.some(file => file.path === "bin/devsync.mjs"));
  assert.ok(pack.files.some(file => file.path === "src/releases.json"));
  assert.ok(pack.files.every(file => !file.path.startsWith("test/") && !file.path.startsWith(".sync/")));
  const prefix = path.join(base, "installed");
  await command(npm, ["--cache", path.join(base, "npm-cache"), "install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", "--offline", path.join(base, pack.filename)]);
  const project = path.join(base, "plain-project");
  await fs.mkdir(project);
  const result = JSON.parse(await command(path.join(prefix, "bin/devsync"), ["status", "--json"], { cwd: project }));
  assert.equal(result.project, await fs.realpath(project));
  assert.equal(result.ok, true);
});
