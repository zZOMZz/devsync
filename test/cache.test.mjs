import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTool } from "../src/install.mjs";
import { withCacheLock, userCacheDirectory } from "../src/cache.mjs";
import { command, digest } from "../src/core.mjs";
import { Session } from "../src/session.mjs";

const binaryName = process.platform === "win32" ? "mutagen.exe" : "mutagen";
const tar = process.platform === "win32" ? "tar.exe" : "tar";
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(process.platform === "darwin" ? "/private/tmp" : os.tmpdir(), "sync-cache-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, binaryName), "fixture-binary");
  await fs.writeFile(path.join(source, "agent"), "fixture-agent");
  await command(tar, ["-czf", path.join(source, "mutagen-agents.tar.gz"), "-C", source, "agent"]);
  const archive = path.join(dir, "release.tar.gz");
  await command(tar, ["-czf", archive, "-C", source, binaryName, "mutagen-agents.tar.gz"]);
  const releaseManifest = { version: "0.18.1", baseUrl: "https://unused.test", assets: {
    fixture: { file: "release.tar.gz", sha256: digest(await fs.readFile(archive)) },
  } };
  let downloads = 0;
  const options = {
    key: "fixture", cacheRoot: path.join(dir, "cache"), releaseManifest,
    env: {}, stage: async (_label, task) => task(), log() {},
    run: async (bin, args) => {
      if (args[0] === "version") {
        assert.equal(await fs.readFile(bin, "utf8"), "fixture-binary");
        return "0.18.1";
      }
      return command(bin, args);
    },
    download: async (_url, file) => { downloads++; await fs.copyFile(archive, file); },
  };
  return { dir, source, archive, options, downloads: () => downloads };
}

test("cache location follows each OS user cache convention", () => {
  assert.equal(userCacheDirectory("darwin", {}, "/users/alice"), "/users/alice/Library/Caches/project-sync/mutagen");
  assert.equal(userCacheDirectory("linux", { XDG_CACHE_HOME: "/custom" }, "/home/alice"), "/custom/project-sync/mutagen");
  assert.equal(userCacheDirectory("linux", { XDG_CACHE_HOME: "relative" }, "/home/alice"), "/home/alice/.cache/project-sync/mutagen");
  assert.equal(userCacheDirectory("win32", { LOCALAPPDATA: "/local" }, "/users/alice"), "/local/project-sync/mutagen");
});

test("concurrent projects install once, share binaries and keep independent session state", async t => {
  const f = await fixture(t);
  const roots = ["a", "b", "c"].map(p => path.join(f.dir, p));
  const binaries = await Promise.all(roots.map(root => ensureTool(root, f.options)));
  assert.equal(new Set(binaries).size, 1);
  assert.equal(f.downloads(), 1);
  const sessions = roots.map(root => new Session(root, binaries[0], {}));
  assert.equal(new Set(sessions.map(s => s.env.MUTAGEN_DATA_DIRECTORY)).size, 3);
  const calls = [];
  for (const s of sessions) {
    s.get = async () => ({ name: s.name });
    s.run = async args => calls.push({ root: s.root, args });
  }
  await sessions[0].pause();
  assert.deepEqual(calls, [{ root: roots[0], args: ["sync", "pause", "project-sync"] }]);
});

test("independent processes serialize downloads through the shared lock", async t => {
  const f = await fixture(t);
  const installer = fileURLToPath(new URL("../src/install.mjs", import.meta.url));
  const core = fileURLToPath(new URL("../src/core.mjs", import.meta.url));
  const counter = path.join(f.dir, "downloads");
  const script = path.join(f.dir, "child.mjs");
  await fs.writeFile(script, `
import fs from 'node:fs/promises';
import {ensureTool} from ${JSON.stringify(installer)};
import {command} from ${JSON.stringify(core)};
await ensureTool(process.argv[2], {
  cacheRoot: ${JSON.stringify(f.options.cacheRoot)}, key:'fixture',
  releaseManifest:${JSON.stringify(f.options.releaseManifest)}, env:{},
  stage:async(_,task)=>task(), log(){},
  run:async(bin,args)=>args[0]==='version'?'0.18.1':command(bin,args),
  download:async(_,target)=>{
    await fs.appendFile(${JSON.stringify(counter)},'download\\n');
    await new Promise(resolve=>setTimeout(resolve,150));
    await fs.copyFile(${JSON.stringify(f.archive)},target);
  }
});`);
  await Promise.all(["p1", "p2", "p3"].map(root => command(process.execPath, [script, path.join(f.dir, root)])));
  assert.equal(await fs.readFile(counter, "utf8"), "download\n");
});

test("legacy payload is validated and reused without a download or moving live files", async t => {
  const f = await fixture(t);
  const root = path.join(f.dir, "project");
  const legacy = path.join(root, ".sync/tools/mutagen-0.18.1-fixture");
  await fs.mkdir(legacy, { recursive: true });
  for (const file of [binaryName, "mutagen-agents.tar.gz"])
    await fs.copyFile(path.join(f.source, file), path.join(legacy, file));
  const binary = await ensureTool(root, f.options);
  assert.equal(f.downloads(), 0);
  assert.equal(await fs.readFile(binary, "utf8"), "fixture-binary");
  await fs.access(path.join(legacy, binaryName));
});

test("invalid legacy agents are replaced by a verified official archive", async t => {
  const f = await fixture(t);
  const root = path.join(f.dir, "project");
  const legacy = path.join(root, ".sync/tools/mutagen-0.18.1-fixture");
  await fs.mkdir(legacy, { recursive: true });
  await fs.copyFile(path.join(f.source, binaryName), path.join(legacy, binaryName));
  await fs.writeFile(path.join(legacy, "mutagen-agents.tar.gz"), "truncated");
  await ensureTool(root, f.options);
  assert.equal(f.downloads(), 1);
});

test("a failed checksum never publishes a cache and the next attempt can recover", async t => {
  const f = await fixture(t);
  await assert.rejects(ensureTool(f.dir, { ...f.options, download: async (_, file) => fs.writeFile(file, "bad") }), /SHA-256/);
  assert.deepEqual(await fs.readdir(path.join(f.options.cacheRoot, "0.18.1")), []);
  await ensureTool(f.dir, f.options);
  assert.equal(f.downloads(), 1);
});

test("missing receipts and payload corruption are never accepted as ready", async t => {
  const f = await fixture(t);
  const binary = await ensureTool(f.dir, f.options);
  await fs.writeFile(binary, "corrupted");
  await ensureTool(f.dir, f.options);
  assert.equal(f.downloads(), 2);
  await fs.rm(path.join(path.dirname(binary), "verified.json"));
  await ensureTool(f.dir, f.options);
  assert.equal(f.downloads(), 3);
});

test("versions occupy separate cache directories", async t => {
  const f = await fixture(t);
  const old = await ensureTool(f.dir, f.options);
  const newer = await ensureTool(f.dir, {
    ...f.options,
    releaseManifest: { ...f.options.releaseManifest, version: "0.19.0" },
    run: async (bin, args) => args[0] === "version" ? "0.19.0" : command(bin, args),
  });
  assert.notEqual(old, newer);
  await fs.access(old);
  await fs.access(newer);
  assert.equal(f.downloads(), 2);
});

test("dead download owners are recovered and active owners are not stolen", async t => {
  const f = await fixture(t);
  const lock = path.join(f.dir, "test.lock");
  // Obtain a real exited PID instead of assuming a numeric PID is unused.
  const pid = Number(await command(process.execPath, ["-e", "console.log(process.pid)"]));
  await fs.writeFile(lock, JSON.stringify({ pid, token: "dead-owner" }));
  let ran = false;
  await withCacheLock(lock, async () => { ran = true; }, { pollMs: 1, log() {} });
  assert.equal(ran, true);
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, token: "live-owner" }));
  await assert.rejects(withCacheLock(lock, () => assert.fail("must not enter"), { waitMs: 10, pollMs: 1, log() {} }), /超时/);
  assert.equal(JSON.parse(await fs.readFile(lock, "utf8")).token, "live-owner");
});
