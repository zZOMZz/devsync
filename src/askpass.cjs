// Loaded by Node only when OpenSSH invokes SSH_ASKPASS. Never logs credentials.
const fs = require("node:fs");
try {
  const config = JSON.parse(
    fs.readFileSync(process.env.SYNC_CONFIG_FILE, "utf8"),
  );
  const auth = JSON.parse(fs.readFileSync(process.env.SYNC_AUTH_FILE, "utf8"));
  const prompt = require("node:path").basename(process.argv[1] || "");
  const expected = [config.remote.host, config.resolvedHost].filter(Boolean)
    .map(host => `${config.remote.username}@${host}'s password:`);
  if (!expected.includes(prompt.trim()) || !auth.password) process.exit(1);
  process.stdout.write(auth.password);
  process.exit(0);
} catch {
  process.exit(1);
}
