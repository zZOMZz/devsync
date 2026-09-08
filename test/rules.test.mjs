import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeRules, ignored, matches } from "../src/rules.mjs";
import { localManifest, command } from "../src/core.mjs";
import { findExpression } from "../src/remote.mjs";
import { fingerprint, sessionArguments } from "../src/session.mjs";
const example = async name => normalizeRules(JSON.parse(await fs.readFile(new URL(`../examples/${name}/sync.config.json`, import.meta.url))));

test("project-specific env, vendor and generated paths live exclusively in example rules", async () => {
  const web = await example("www_so_com");
  const python = await example("python-service");
  for (const file of [".env", "docker/.env", "vendor/autoload.php"]) assert.equal(ignored(file, web), false, file);
  for (const file of ["service/.env", "docker/sdk/a", "application/views/http/a", "resource/js/.rollup-stage-123/a"])
    assert.equal(ignored(file, web), true, file);
  assert.equal(ignored("docker/sdk/a", python), false);
  assert.equal(ignored(".env", python), true);
  assert.equal(ignored(".venv/lib/a.py", python), true);
});

test("rules reject unsupported glob syntax and impossible environment exceptions", () => {
  for (const exclude of [["!dist"], ["**/*.js"], ["a/../b"], ["[abc]"]])
    assert.throws(() => normalizeRules({ exclude }), { code: "INVALID_RULES" });
  for (const envFiles of [["../.env"], [".sync/.env"], ["node_modules/.env"], [".env-dir/.env"], [".env*"]])
    assert.throws(() => normalizeRules({ envFiles }), { code: "INVALID_RULES" });
  assert.throws(() => normalizeRules({ mode: "two-way-resolved" }), /仅支持/);
  assert.throws(() => normalizeRules({ typo: true }), /未知/);
  assert.equal(ignored(".sync/auth.json", normalizeRules({ exclude: [] })), true);
  assert.equal(ignored("dist/app.js", normalizeRules({ exclude: [] })), false);
});

test("wildcards do not cross directory separators, while bare names match any depth", () => {
  assert.equal(matches("resource/main.js", "resource/*.js"), true);
  assert.equal(matches("resource/sub/main.js", "resource/*.js"), false);
  assert.equal(matches("x/cache/a", "cache"), true);
  assert.equal(matches("x/cache/a", "/cache"), false);
  assert.equal(matches("a1.txt", "a?.txt"), true);
  assert.equal(matches("a12.txt", "a?.txt"), false);
});

test("local manifest and remote find use identical filtering for rooted globs and env exceptions", { skip: process.platform === "win32" }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "devsync-filter-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = ["a.py", ".env", "docker/.env", "x/.env", ".env.local", ".sync/auth.json", "resource/main.js", "resource/sub/main.js", "x/cache/a", "a1.txt", "a12.txt"];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), "fixture");
  }
  const rules = normalizeRules({ exclude: ["resource/*.js", "cache", "a?.txt"], envFiles: [".env", "docker/.env"] });
  const start = process.platform === "darwin" ? "find -E ." : "find . -regextype posix-extended";
  const result = await command("sh", ["-c", 'cd "$1" && ' + start + " " + findExpression(rules) + " -type f -print", "filter-test", root]);
  const remote = result.trim().split("\n").map(p => p.replace(/^\.\//, "")).sort();
  assert.deepEqual(remote, Object.keys(await localManifest(root, rules)).sort());
});

test("rule changes invalidate accepted sessions and reach Mutagen creation arguments", () => {
  const cfg = { remote: { username: "u", host: "h", port: 22, path: "/home/u/project" } };
  const first = normalizeRules();
  const second = normalizeRules({ envFiles: [".env"], pollingInterval: 3 });
  assert.notEqual(fingerprint("/project", cfg, first), fingerprint("/project", cfg, second));
  const args = sessionArguments("/project", cfg, second);
  assert.ok(args.includes("!/.env"));
  assert.equal(args[args.indexOf("--watch-polling-interval-alpha") + 1], "3");
  assert.equal(args[args.indexOf("--ignore-syntax") + 1], "mutagen");
});

test("runtime source contains no www_so_com paths or company download proxy", async () => {
  const src = fileURLToPath(new URL("../src", import.meta.url));
  for (const name of await fs.readdir(src)) {
    const content = await fs.readFile(path.join(src, name), "utf8");
    assert.doesNotMatch(content, /www_so_com|qihoo\.net|application\/views\/http|docker\/sdk/, name);
  }
});
