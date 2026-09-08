import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ignored,
  changes,
  validateRemote,
  platformKey,
  healthy,
  verifyArchive,
  digest,
  command,
} from "../src/core.mjs";
test("generic defaults exclude environment files and private state", () => {
  for (const file of [".env", "docker/.env", ".env.local", ".sync/auth.json", ".git/config"])
    assert.equal(ignored(file), true, file);
  for (const file of ["main.py", "public/index.php", "vendor/autoload.php", "docker/sdk/client"])
    assert.equal(ignored(file), false, file);
});
test("preview separates additions, replacements and deletions", () =>
  assert.deepEqual(
    changes({ a: "1", b: "2", c: "3" }, { a: "1", b: "old", d: "4" }),
    { added: ["c"], updated: ["b"], deleted: ["d"] },
  ));
test("unsafe targets and shell option injection are rejected", () => {
  const r = {
    host: "devbox",
    username: "alice",
    port: 22,
    path: "/home/alice/www_so_com",
  };
  assert.doesNotThrow(() => validateRemote(r));
  for (const value of ["/", "/home", "/tmp", "/home/alice/../bob"])
    assert.throws(() => validateRemote({ ...r, path: value }));
  assert.throws(() => validateRemote({ ...r, host: "host;touch bad" }));
  assert.throws(() => validateRemote({ ...r, port: 0 }));
});
test("supported platform asset names", () => {
  assert.equal(platformKey("darwin", "arm64"), "darwin_arm64");
  assert.equal(platformKey("win32", "x64"), "windows_amd64");
  assert.equal(platformKey("linux", "arm64"), "linux_arm64");
});
test("watching alone is not proof of a successful sync", () => {
  const s = {
    status: "watching",
    alpha: { connected: true },
    beta: { connected: true },
  };
  assert.ok(healthy(s));
  assert.equal(
    healthy({
      ...s,
      beta: {
        connected: true,
        transitionProblems: [{ error: "permission denied" }],
      },
    }),
    false,
  );
  assert.equal(healthy({ ...s, paused: true }), false);
  assert.equal(healthy({ ...s, lastError: "network" }), false);
});
test("archive corruption fails checksum verification", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-test-"));
  try {
    const file = path.join(dir, "archive");
    await fs.writeFile(file, "ok");
    await verifyArchive(file, digest("ok"));
    await assert.rejects(verifyArchive(file, digest("bad")), /SHA-256/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("password prompts can be answered over pipes without exposing the secret", async () => {
  const out = await command(
    process.execPath,
    [
      "-e",
      `process.stdout.write("alice@devbox's password: ");process.stdin.once('data',b=>{if(b.toString().trim()!=='test-password')process.exit(2);process.stdout.write('accepted');process.exit(0);});`,
    ],
    { password: "test-password" },
  );
  assert.match(out, /accepted/);
  assert.ok(!out.includes("test-password"));
});

test("atomic state updates tolerate concurrent writers", async () => {
  const { writeJson } = await import("../src/core.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-state-"));
  try {
    const file = path.join(dir, "control.json");
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => writeJson(file, { index })),
    );
    assert.equal(
      typeof JSON.parse(await fs.readFile(file, "utf8")).index,
      "number",
    );
    assert.deepEqual(await fs.readdir(dir), ["control.json"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SSH askpass hook only releases credentials for the configured host", async () => {
  const { fileURLToPath } = await import("node:url");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-auth-"));
  try {
    const config = path.join(dir, "config.json"),
      auth = path.join(dir, "auth.json");
    await fs.writeFile(
      config,
      JSON.stringify({ remote: { host: "devbox", username: "alice" } }),
    );
    await fs.writeFile(
      auth,
      JSON.stringify({ password: " password with spaces " }),
    );
    const env = {
      ...process.env,
      SYNC_CONFIG_FILE: config,
      SYNC_AUTH_FILE: auth,
      NODE_OPTIONS: `--require ${JSON.stringify(fileURLToPath(new URL("../src/askpass.cjs", import.meta.url)))}`,
    };
    assert.equal(
      await command(process.execPath, ["alice@devbox's password: "], { env }),
      " password with spaces ",
    );
    await assert.rejects(
      command(process.execPath, ["alice@otherhost's password: "], { env }),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("process permission denial does not masquerade as process exit", async () => {
  const { isProcessAlive } = await import("../src/core.mjs");
  assert.equal(
    isProcessAlive(123, () => {}),
    true,
  );
  assert.equal(
    isProcessAlive(123, () => {
      throw Object.assign(new Error(), { code: "EPERM" });
    }),
    true,
  );
  assert.equal(
    isProcessAlive(123, () => {
      throw Object.assign(new Error(), { code: "ESRCH" });
    }),
    false,
  );
  assert.equal(isProcessAlive(0), false);
});
test("new sessions explicitly enable one-second polling", async () => {
  const { Session } = await import("../src/session.mjs");
  const s = new Session("/test/project", "mutagen", {});
  let args;
  s.run = async (a) => {
    args = a;
  };
  await s.create({
    remote: {
      host: "dev",
      username: "user",
      port: 22,
      path: "/home/user/project",
    },
  });
  assert.equal(args[args.indexOf("--watch-mode-alpha") + 1], "force-poll");
  assert.equal(args[args.indexOf("--watch-polling-interval-alpha") + 1], "1");
});

test("download progress handles curl rows split across chunks and unknown sizes", async () => {
  const { Progress, parseCurlProgress } = await import("../src/progress.mjs");
  let clock = 0,
    output = "";
  const stream = {
    isTTY: false,
    write: (text) => {
      output += text;
    },
  };
  const p = new Progress("下载", { stream, now: () => clock, tickMs: 60000 });
  try {
    p.consume("\r 25 100M 25 25");
    p.consume("M 0 0 5M 0 0:00:20 0:00:05 0:00:15 5M\r");
    clock = 5000;
    p.render();
    assert.match(output, /25%/);
    assert.match(output, /25.0 MB \/ 100.0 MB/);
    clock = 16000;
    p.render();
    assert.match(output, /未收到新数据/);
    assert.equal(parseCurlProgress("% Total % Received"), null);
    p.consume("0 0 0 2M 0 0 1M 0 --:--:-- 0:00:02 --:--:-- 1M\r");
    assert.doesNotMatch(p.text(), /%|预计剩余/);
    assert.doesNotMatch(output, /\x1b/);
  } finally {
    p.stop(true);
  }
});

test("phase failures finish progress output and propagate the error", async () => {
  const { withProgress } = await import("../src/progress.mjs");
  let output = "",
    instance;
  await assert.rejects(
    withProgress(
      "校验",
      async (p) => {
        instance = p;
        throw Error("bad archive");
      },
      {
        stream: {
          isTTY: false,
          write: (s) => {
            output += s;
          },
        },
      },
    ),
    /bad archive/,
  );
  assert.equal(instance.finished, true);
  assert.match(output, /校验失败/);
});

test("curl download streams real progress without contacting a remote service", async () => {
  const { createServer } = await import("node:http");
  const { Progress } = await import("../src/progress.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-progress-"));
  const server = createServer((_req, res) => {
    const chunk = Buffer.alloc(128 * 1024);
    let remaining = 12;
    res.writeHead(200, { "Content-Length": chunk.length * remaining });
    const timer = setInterval(() => {
      res.write(chunk);
      if (--remaining === 0) {
        clearInterval(timer);
        res.end();
      }
    }, 120);
    res.on("close", () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const p = new Progress("下载", { stream: { isTTY: false, write() {} } });
  try {
    const file = path.join(dir, "download");
    await command(
      process.platform === "win32" ? "curl.exe" : "curl",
      [
        "--noproxy",
        "*",
        "-fL",
        "-o",
        file,
        `http://127.0.0.1:${server.address().port}/`,
      ],
      { onStderr: (chunk) => p.consume(chunk) },
    );
    assert.equal((await fs.stat(file)).size, 12 * 128 * 1024);
    assert.ok(p.data.received > 0);
    assert.equal(p.data.percent, 100);
  } finally {
    p.stop(true);
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("reconfiguration keeps same-account credentials without displaying them", async () => {
  const { configureConnection } = await import("../src/configure.mjs");
  const previous = {
    remote: {
      host: "devbox",
      username: "alice",
      port: 22,
      path: "/home/alice/project",
    },
  };
  const prompts = [];
  const result = await configureConnection(
    async (prompt, secret) => {
      prompts.push({ prompt, secret });
      return "";
    },
    previous,
    { password: "existing-secret" },
  );
  assert.deepEqual(result, {
    cfg: previous,
    auth: { password: "existing-secret" },
  });
  assert.equal(prompts.find(p => p.secret)?.secret, true);
  assert.ok(prompts.every((p) => !p.prompt.includes("existing-secret")));
});

test("changed host, username or port requires a fresh password", async () => {
  const { configureConnection } = await import("../src/configure.mjs");
  const previous = {
    remote: {
      host: "devbox",
      username: "alice",
      port: 22,
      path: "/home/alice/project",
    },
  };
  for (const fields of [
    ["newbox", "alice", "", ""],
    ["", "bob", "", ""],
    ["", "", "2222", ""],
  ]) {
    const answers = [...fields.slice(0, 3), "2", "", "new-secret", fields[3]];
    const result = await configureConnection(
      async () => {
        assert.ok(answers.length);
        return answers.shift();
      },
      previous,
      { password: "old-secret" },
    );
    assert.equal(result.auth.password, "new-secret");
    assert.equal(answers.length, 0);
  }
});

test("switching to key authentication clears the stored password", async () => {
  const { configureConnection } = await import("../src/configure.mjs");
  const answers = ["", "", "", "1", ""];
  const result = await configureConnection(
    async () => answers.shift(),
    {
      remote: {
        host: "dev",
        username: "alice",
        port: 22,
        path: "/home/alice/project",
      },
    },
    { password: "old-secret" },
  );
  assert.deepEqual(result.auth, {});
});

test("cancelled configuration does not mutate previous settings", async () => {
  const { configureConnection } = await import("../src/configure.mjs");
  const cfg = {
      remote: {
        host: "dev",
        username: "alice",
        port: 22,
        path: "/home/alice/project",
      },
    },
    auth = { password: "old" };
  const before = JSON.stringify({ cfg, auth });
  await assert.rejects(
    configureConnection(
      async () => {
        throw Error("cancelled");
      },
      cfg,
      auth,
    ),
    /cancelled/,
  );
  assert.equal(JSON.stringify({ cfg, auth }), before);
});

test("downloads prefer the company proxy and only fall back after failure", async () => {
  const { downloadArchive } = await import("../src/install.mjs");
  const calls = [];
  await downloadArchive("https://example.test/release", "/tmp/archive", {
    proxy: "http://company-proxy:8080",
    stage: async (_label, task) => task({ consume() {} }),
    log() {},
    run: async (_bin, args, options) => {
      calls.push({ args, options });
      if (calls.length === 1) throw Error("proxy unavailable");
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].args[calls[0].args.indexOf("--proxy") + 1],
    "http://company-proxy:8080",
  );
  assert.equal(calls[1].args.includes("--proxy"), false);
  for (const { args, options } of calls) {
    assert.equal(args[args.indexOf("--max-time") + 1], "0");
    assert.equal(args[args.indexOf("--speed-time") + 1], "120");
    assert.equal(args[args.indexOf("--speed-limit") + 1], "1024");
    assert.equal(options.timeout, 0);
  }
});

test("default direct download runs exactly once", async () => {
  const { downloadArchive } = await import("../src/install.mjs");
  let calls = 0;
  await downloadArchive("https://example.test/release", "/tmp/archive", {
    stage: async (_label, task) => task({ consume() {} }),
    run: async () => {
      calls++;
    },
  });
  assert.equal(calls, 1);
});

test("zero timeout disables the command wall-clock timer", async () => {
  assert.equal(
    await command(
      process.execPath,
      ["-e", 'setTimeout(()=>process.stdout.write("finished"),100)'],
      { timeout: 0 },
    ),
    "finished",
  );
});

test("Composer symlinks participate in preview without dereferencing targets", async () => {
  const { localManifest, symlinkSignature } = await import("../src/core.mjs");
  const { parseRemoteManifest } = await import("../src/remote.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-symlink-"));
  try {
    await fs.mkdir(path.join(dir, "vendor/bin"), { recursive: true });
    await fs.symlink(
      "../phpunit/phpunit/phpunit",
      path.join(dir, "vendor/bin/phpunit"),
      "file",
    );
    const local = await localManifest(dir);
    assert.equal(
      local["vendor/bin/phpunit"],
      "symlink:../phpunit/phpunit/phpunit",
    );
    const remote = parseRemoteManifest(
      "\0SYNC_LINKS\0./vendor/bin/phpunit\0../phpunit/phpunit/phpunit\0",
    );
    assert.deepEqual(changes(local, remote.files), {
      added: [],
      updated: [],
      deleted: [],
    });
    remote.files["vendor/bin/phpunit"] = symlinkSignature(
      "vendor/bin/phpunit",
      "../other/phpunit",
    );
    assert.deepEqual(changes(local, remote.files).updated, [
      "vendor/bin/phpunit",
    ]);
    assert.deepEqual(changes({}, local).deleted, ["vendor/bin/phpunit"]);
    assert.throws(
      () => symlinkSignature("vendor/bin/link", "/etc/passwd"),
      /项目内相对路径/,
    );
    assert.throws(
      () => symlinkSignature("vendor/bin/link", "../../../outside"),
      /项目内相对路径/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("remote manifest rejects truncated link records and compares file/link replacements", async () => {
  const { parseRemoteManifest } = await import("../src/remote.mjs");
  assert.throws(
    () => parseRemoteManifest("\0SYNC_LINKS\0./vendor/bin/phpunit\0"),
    /不完整/,
  );
  const hash = digest("php source");
  const remote = parseRemoteManifest(
    hash + "  ./vendor/autoload.php\n\0SYNC_LINKS\0",
  );
  assert.equal(remote.files["vendor/autoload.php"], hash);
  assert.deepEqual(
    changes(
      { "vendor/autoload.php": "symlink:composer/autoload.php" },
      remote.files,
    ).updated,
    ["vendor/autoload.php"],
  );
});
