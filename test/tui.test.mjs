import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { command } from "../src/core.mjs";
import { TerminalUI, wrapLines, scopeLines } from "../src/terminal-ui.mjs";

const python = process.env.DEVSYNC_TEST_PYTHON || "python3";
const hasPty = process.platform !== "win32" && spawnSync(python, ["--version"], { stdio: "ignore" }).status === 0;
const driver = fileURLToPath(new URL("./fixtures/tui-driver.py", import.meta.url));
const cli = fileURLToPath(new URL("../bin/devsync.mjs", import.meta.url));
for (const scenario of ["success", "escape", "ctrl-c", "sigterm", "plain", "stage-interrupt", "preview"])
  test(`PTY ${scenario}: keyboard flow restores terminal and releases the project lock`, { skip: !hasPty, timeout: 25000 }, async () => {
    const result = JSON.parse(await command(python, [driver, process.execPath, cli, scenario], { timeout: 20000 }));
    assert.equal(result.checks, "passed");
  });

test("JSON presentation stays silent and confirmations preserve non-interactive semantics", async () => {
  const module = new URL("../src/terminal-ui.mjs", import.meta.url).href;
  const output = await command(process.execPath, ["--input-type=module", "-e", `
    import { TerminalUI } from ${JSON.stringify(module)};
    const ui = new TerminalUI({json:true});
    ui.intro('hidden'); ui.outro('hidden'); ui.log('hidden'); ui.preview({});
    await ui.stage('hidden', async p => p.consume('anything'));
    try { await ui.confirm('continue', {details:{deleted:['old']}}); }
    catch(error) { console.log(JSON.stringify({code:error.code, details:error.details})); }
  `]);
  assert.deepEqual(JSON.parse(output), { code: "CONFIRMATION_REQUIRED", details: { deleted: ["old"] } });
  assert.equal(await new TerminalUI({ json: true }).confirm("continue", { yes: true }), true);
});

test("narrow summary wrapping retains CJK paths and authentication summary contains no secrets", () => {
  const line = "目录 /srv/开发项目/很长很长的路径和文件名称.py";
  const wrapped = wrapLines(line, 25);
  assert.equal(wrapped.replaceAll("\n", ""), line);
  assert.ok(wrapped.split("\n").length > 1);
  const text = scopeLines({ local: "/project", remote: { username: "alice", host: "dev", port: 22, path: "/srv/project" },
    envFiles: [], authentication: "password", password: "never-display" }).join("\n");
  assert.match(text, /认证  密码/);
  assert.doesNotMatch(text, /never-display/);
});
