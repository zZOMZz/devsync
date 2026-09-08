import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureConnection } from "../src/configure.mjs";
import { sshAliases, sshDefaults, connectionError, probeConnection, checkRemotePath } from "../src/connection.mjs";
import { command } from "../src/core.mjs";

function questions(answers) {
  const prompts = [];
  return { prompts, ask: async (prompt, secret) => {
    prompts.push({ prompt, secret });
    assert.ok(answers.length, `Unexpected prompt: ${prompt}`);
    return answers.shift();
  } };
}
const base = { root: "/work/my-project", log() {}, resolve: async () => ({ username: "alice", port: 2222 }) };

test("SSH aliases provide defaults and the remote HOME determines the project path", async () => {
  const q = questions(["", "", "", "", ""]);
  const result = await configureConnection(q.ask, null, {}, {
    ...base, aliases: ["devbox"], probe: async () => ({ home: "/srv/alice" }),
  });
  assert.deepEqual(result.cfg.remote, { host: "devbox", username: "alice", port: 2222, path: "/srv/alice/my-project" });
});

test("bad port, password and directory each retry only their own input", async () => {
  const q = questions(["dev", "", "0", "2222", "2", "wrong", "2", "correct", "/denied", "/srv/alice/project"]);
  let probes = 0, paths = 0;
  const result = await configureConnection(q.ask, null, {}, {
    ...base,
    probe: async (_cfg, auth) => {
      probes++;
      if (auth.password === "wrong") throw connectionError(Error("Permission denied (password)."), auth);
      return { home: "/srv/alice" };
    },
    checkPath: async cfg => { paths++; if (cfg.remote.path === "/denied") throw connectionError(Error("SYNC_PATH_ERROR")); },
  });
  assert.equal(result.auth.password, "correct");
  assert.equal(result.cfg.remote.path, "/srv/alice/project");
  assert.equal(probes, 2);
  assert.equal(paths, 2);
  assert.equal(q.prompts.filter(p => p.prompt.startsWith("开发机地址")).length, 1);
  assert.equal(q.prompts.filter(p => p.prompt.startsWith("开发机账号")).length, 1);
  assert.equal(q.prompts.filter(p => p.prompt.startsWith("SSH 端口")).length, 2);
});

test("an invalid stored password cannot be silently reused on retry", async () => {
  const q = questions(["", "", "", "", "", "", "", "new", ""]);
  let calls = 0;
  const previous = { remote: { host: "dev", username: "alice", port: 22, path: "/srv/alice/project" } };
  await configureConnection(q.ask, previous, { password: "stale" }, {
    ...base,
    probe: async (_cfg, auth) => {
      calls++;
      if (calls === 1) throw connectionError(Error("Permission denied"), auth);
      assert.equal(auth.password, "new");
      return { home: "/srv/alice" };
    },
  });
  assert.equal(calls, 2);
  assert.ok(q.prompts.every(p => !p.prompt.includes("stale")));
});

test("DNS corrections preserve already entered username and port", async () => {
  const q = questions(["typo", "", "", "1", "dev", ""]);
  let calls = 0;
  const result = await configureConnection(q.ask, null, {}, {
    ...base, probe: async () => {
      if (++calls === 1) throw connectionError(Error("Could not resolve hostname typo"));
      return { home: "/srv/alice" };
    },
  });
  assert.equal(result.cfg.remote.host, "dev");
  assert.equal(q.prompts.filter(p => p.prompt.startsWith("开发机账号")).length, 1);
});

test("connection failures let the user correct only the port or retry the network", async () => {
  const q = questions(["dev", "", "", "1", "2", "2200", "5", ""]);
  let calls = 0;
  const result = await configureConnection(q.ask, null, {}, {
    ...base, probe: async () => {
      if (++calls < 3) throw connectionError(Error("Connection refused"));
      return { home: "/srv/alice" };
    },
  });
  assert.equal(result.cfg.remote.port, 2200);
  assert.equal(q.prompts.filter(p => p.prompt.startsWith("认证方式")).length, 1);
});

test("SSH config aliases include literal names from Include files", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "sync-ssh-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, ".ssh/conf.d"), { recursive: true });
  await fs.writeFile(path.join(home, ".ssh/config"), "Host dev other * !skip\n  User alice\nInclude conf.d/*.conf\n");
  await fs.writeFile(path.join(home, ".ssh/conf.d/work.conf"), "Host work\n Include config\n");
  assert.deepEqual(await sshAliases(home), ["dev", "other", "work"]);
  const defaults = await sshDefaults("dev", async (_bin, args) => {
    assert.deepEqual(args, ["-G", "dev"]);
    return "user alice\nport 2200\nhostname dev.example.test\n";
  });
  assert.deepEqual(defaults, { username: "alice", port: 2200, hostname: "dev.example.test" });
});

test("connection failures distinguish password, key, DNS, network and directory issues", () => {
  assert.equal(connectionError(Error("Permission denied (password)"), { password: "x" }).field, "auth");
  assert.match(connectionError(Error("Permission denied (publickey)")).message, /SSH 密钥/);
  assert.equal(connectionError(Error("Could not resolve hostname x")).field, "host");
  assert.equal(connectionError(Error("Connection timed out")).field, "connection");
  assert.equal(connectionError(Error("SYNC_PATH_ERROR: Permission denied")).field, "path");
  assert.equal(connectionError(Error("Host key verification failed")).field, null);
});

test("remote probe extracts HOME without mistaking login banner output for it", async () => {
  assert.deepEqual(await probeConnection("/root", {}, {}, async () => "Banner\nSYNC_HOME=/srv/user\n"), { home: "/srv/user" });
  await assert.rejects(probeConnection("/root", {}, {}, async () => "Banner only"), /无法读取远端主目录/);
});

test("directory preflight is read-only and rejects unsafe paths", { skip: process.platform === "win32" }, async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sync-path-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const run = async (_root, _cfg, _auth, script) => command("sh", ["-c", script], { env: { ...process.env, HOME: dir } });
  const check = target => checkRemotePath(dir, { remote: { path: target } }, {}, run);
  const absent = path.join(dir, "nested/project");
  await check(absent);
  await assert.rejects(fs.access(absent), { code: "ENOENT" });
  await assert.rejects(check(dir), /目录权限检查失败/);
  await fs.writeFile(path.join(dir, "file"), "content");
  await assert.rejects(check(path.join(dir, "file")), /目录权限检查失败/);
  await fs.symlink(dir, path.join(dir, "link"));
  await assert.rejects(check(path.join(dir, "link")), /目录权限检查失败/);
  await check(path.join(dir, "link/project"));
});

test("SSH validates draft credentials through askpass without replacing saved settings", async t => {
  const { ssh } = await import("../src/remote.mjs");
  const { writeJson } = await import("../src/core.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sync-draft-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const savedConfig = { remote: { host: "old", username: "olduser" } };
  await writeJson(path.join(root, ".sync/config.json"), savedConfig);
  await writeJson(path.join(root, ".sync/auth.json"), { password: "old-password" });
  const cfg = { remote: { host: "alias", username: "alice", port: 22 } };
  const auth = { password: "draft-password" };
  for (const fail of [false, true]) {
    const run = async (_bin, args, options) => {
      if (args.includes("-G")) return "hostname dev.example.test\n";
      assert.notEqual(options.env.SYNC_AUTH_FILE, path.join(root, ".sync/auth.json"));
      const accepted = await command(process.execPath, ["alice@dev.example.test's password: "], { env: options.env });
      assert.equal(accepted, "draft-password");
      await assert.rejects(command(process.execPath, ["alice@jumphost's password: "], { env: options.env }));
      if (fail) throw Error("connection failure");
      return "validated";
    };
    if (fail) await assert.rejects(ssh(root, cfg, auth, "true", undefined, run), /connection failure/);
    else assert.equal(await ssh(root, cfg, auth, "true", undefined, run), "validated");
    assert.deepEqual((await fs.readdir(path.join(root, ".sync"))).sort(), ["auth.json", "config.json"]);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, ".sync/config.json"))), savedConfig);
    assert.equal(JSON.parse(await fs.readFile(path.join(root, ".sync/auth.json"))).password, "old-password");
  }
});
