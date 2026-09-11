import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { zshCompletion, manageCompletion, updateZshrc, parseCompletionArgs } from "../src/completion.mjs";
import { command } from "../src/core.mjs";
const bin = fileURLToPath(new URL("../bin/devsync.mjs", import.meta.url));
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ds-completion-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
test("generation is project-independent; invalid install requests fail before writing", async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "sync.config.json"), "invalid");
  const env = { ...process.env, ZDOTDIR: root };
  const script = await command(process.execPath, [bin, "completion", "zsh"], { cwd: root, env });
  assert.equal(script, zshCompletion());
  assert.doesNotMatch(script, /_worker|--binary|--token/);
  assert.equal(JSON.parse(await command(process.execPath, [bin, "completion", "zsh", "--json"], { env })).script, script);
  for (const args of [[], ["install"], ["bash"], ["install", "fish"], ["install", "zsh", "extra"], ["install", "zsh", "--yes"]])
    assert.throws(() => parseCompletionArgs(args), { code: "USAGE" });
  assert.deepEqual(await fs.readdir(root), ["sync.config.json"]);
});
test("install is idempotent, follows ZDOTDIR and symlinks, and uninstall preserves other edits", async t => {
  const root = await fixture(t), target = path.join(root, "dotfile");
  const original = '# my config\nexport EXAMPLE="keep"';
  await fs.writeFile(target, original, { mode: 0o640 });
  const dir = path.join(root, "custom zsh"); await fs.mkdir(dir);
  await fs.symlink(target, path.join(dir, ".zshrc"));
  const options = { home: root, env: { ZDOTDIR: dir } };
  assert.equal((await manageCompletion("install", options)).changed, true);
  assert.equal((await manageCompletion("install", options)).changed, false);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o640);
  assert.equal((await fs.lstat(path.join(dir, ".zshrc"))).isSymbolicLink(), true);
  await fs.appendFile(target, '# subsequent edit\n');
  assert.equal((await manageCompletion("uninstall", options)).changed, true);
  assert.equal(await fs.readFile(target, "utf8"), original + '# subsequent edit\n');
  assert.equal((await manageCompletion("uninstall", options)).changed, false);
  assert.deepEqual((await fs.readdir(root)).sort(), ["custom zsh", "dotfile"]);
});
test("fresh install and uninstall handle absent files and preserve exact existing content", async t => {
  for (const original of ["", "# text", "# text\n", "# text\n\n", "# text\r\n"])
    assert.equal(updateZshrc(updateZshrc(original, true), false), original);
  assert.throws(() => updateZshrc('# >>> devsync completion >>>\n', true), { code: "COMPLETION_CONFIG" });
  const root = await fixture(t), options = { home: root, env: {} };
  assert.equal((await manageCompletion("uninstall", options)).changed, false);
  assert.deepEqual(await fs.readdir(root), []);
  assert.equal((await manageCompletion("install", options)).changed, true);
  assert.equal((await fs.stat(path.join(root, ".zshrc"))).mode & 0o777, 0o600);
});
const zsh = spawnSync("zsh", ["--version"]).status === 0;
const python = process.env.DEVSYNC_TEST_PYTHON || "python3";
const pty = process.platform !== "win32" && zsh && spawnSync(python, ["--version"]).status === 0;
test("real zsh Tab completes subcommands, flags, directory paths and completion management", { skip: !pty, timeout: 20000 }, async t => {
  const root = await fixture(t), script = path.join(root, "_devsync");
  await fs.writeFile(script, zshCompletion());
  await command("zsh", ["-n", script]);
  const driver = fileURLToPath(new URL("./fixtures/completion-driver.py", import.meta.url));
  const result = JSON.parse(await command(python, [driver, "zsh", script], { timeout: 18000 }));
  assert.equal(result.checks, "passed");
});
test("installed block initializes completion and tolerates a missing devsync executable", { skip: !zsh }, async t => {
  const root = await fixture(t), file = path.join(root, ".zshrc");
  await manageCompletion("install", { home: root, env: {} });
  const env = { ...process.env, ZDOTDIR: root, HOME: root, PATH: path.dirname(bin) + path.delimiter + process.env.PATH };
  assert.equal((await command("zsh", ["-f", "-c", 'source "$ZDOTDIR/.zshrc"; print -r -- $_comps[devsync]'], { env })).trim(), "_devsync");
  const content = await fs.readFile(file, "utf8");
  assert.ok(content.includes('eval "$(devsync completion zsh)"'));
  // A PATH with no devsync leaves shell startup silent and successful.
  assert.equal(await command("zsh", ["-f", "-c", 'PATH=/nonexistent; source "$ZDOTDIR/.zshrc"'], { env }), "");
});
