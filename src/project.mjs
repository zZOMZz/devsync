import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readJson, writeJson, command, validateRemote } from "./core.mjs";
import { normalizeRules, defaultRules } from "./rules.mjs";
import { SyncError } from "./errors.mjs";

export async function resolveProject(directory = process.cwd()) {
  const root = await fs.realpath(path.resolve(directory));
  if (!(await fs.stat(root)).isDirectory()) throw new SyncError("INVALID_PROJECT", "项目路径必须是目录。");
  return root;
}
export function userConfigPath(env = process.env, home = os.homedir()) {
  const base = process.platform === "win32" ? env.APPDATA || path.join(home, "AppData", "Roaming") :
    env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, ".config");
  return path.join(base, "devsync", "config.json");
}
export async function loadUserConfig(file = userConfigPath()) {
  const settings = await readJson(file, {});
  for (const key of Object.keys(settings))
    if (!["downloadProxy", "mutagenMirror", "mutagenArchive"].includes(key))
      throw new SyncError("INVALID_USER_CONFIG", `未知的用户配置字段：${key}`);
  for (const [key, value] of Object.entries(settings))
    if (typeof value !== "string") throw new SyncError("INVALID_USER_CONFIG", `${key} 必须是字符串。`);
  return settings;
}
export async function loadProject(root, { validateConfig = true } = {}) {
  const dir = path.join(root, ".sync");
  const rules = normalizeRules(await readJson(path.join(root, "sync.config.json"), defaultRules));
  const config = await readJson(path.join(dir, "config.json"), null);
  if (config && validateConfig) validateRemote(config.remote);
  return { root, dir, rules, config };
}
export async function secureProject(root) {
  const dir = path.join(root, ".sync");
  try {
    if (!(await fs.lstat(dir)).isDirectory()) throw new SyncError("INVALID_STATE", ".sync 必须是项目内的真实目录。");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const user = (await command("whoami", [])).trim();
    await command("icacls", [dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`]);
  } else await fs.chmod(dir, 0o700);
}
export async function ensureProjectFiles(root, rules) {
  const file = path.join(root, "sync.config.json");
  try {
    await fs.writeFile(file, JSON.stringify(rules, null, 2) + "\n", { flag: "wx" });
  } catch (error) { if (error.code !== "EEXIST") throw error; }
  const ignoreFile = path.join(root, ".gitignore");
  let content = "";
  try { content = await fs.readFile(ignoreFile, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!content.split(/\r?\n/).some(line => [".sync", ".sync/", "/.sync", "/.sync/"].includes(line.trim())))
    await fs.appendFile(ignoreFile, `${content && !content.endsWith("\n") ? "\n" : ""}\n# devsync private configuration, credentials and state\n.sync/\n`);
}
export async function saveConnection(root, config, auth) {
  // Guarded by the project command lock; validation/confirmation happen first.
  const dir = path.join(root, ".sync");
  const oldAuth = await readJson(path.join(dir, "auth.json"), null);
  await writeJson(path.join(dir, "auth.json"), auth);
  try { await writeJson(path.join(dir, "config.json"), config); }
  catch (error) {
    if (oldAuth) await writeJson(path.join(dir, "auth.json"), oldAuth);
    else await fs.rm(path.join(dir, "auth.json"), { force: true });
    throw error;
  }
}
