#!/usr/bin/env node
// Shell startup only needs the small completion module, not the sync/TUI stack.
if (process.argv[2] === "completion") {
  const { runCompletion } = await import("../src/completion.mjs");
  try { await runCompletion(process.argv.slice(3)); }
  catch (error) {
    const { errorResult } = await import("../src/errors.mjs");
    if (process.argv.includes("--json")) process.stdout.write(JSON.stringify({ ok: false, error: errorResult(error) }) + "\n");
    else process.stderr.write(`devsync：${error.message}\n`);
    process.exitCode = 1;
  }
} else {
  const { main } = await import("../src/cli.mjs");
  await main();
}
