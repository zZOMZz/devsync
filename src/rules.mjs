import path from "node:path";
import { SyncError } from "./errors.mjs";

export const protectedPatterns = [".sync", ".git", ".hg", ".svn", "/sync.config.json"];
export const defaultExcludes = [".vscode", ".idea", ".DS_Store", "node_modules", "dist"];
export const defaultRules = Object.freeze({
  version: 1, mode: "one-way-replica", exclude: Object.freeze(defaultExcludes),
  envFiles: Object.freeze([]), pollingInterval: 1,
});
const invalid = message => { throw new SyncError("INVALID_RULES", message); };

export function normalizeRules(input = {}) {
  if (!input || Array.isArray(input) || typeof input !== "object") invalid("sync.config.json 必须是对象。");
  for (const key of Object.keys(input))
    if (!["$schema", "version", "mode", "exclude", "envFiles", "pollingInterval"].includes(key))
      invalid(`未知的项目规则字段：${key}`);
  const rules = { ...defaultRules, ...input };
  delete rules.$schema;
  if (rules.version !== 1) invalid("不支持的项目规则版本。");
  if (rules.mode !== "one-way-replica") invalid("当前仅支持 one-way-replica（本地为准）同步模式。");
  if (!Number.isInteger(rules.pollingInterval) || rules.pollingInterval < 1 || rules.pollingInterval > 3600)
    invalid("pollingInterval 必须是 1–3600 的整数秒数。");
  for (const key of ["exclude", "envFiles"])
    if (!Array.isArray(rules[key]) || rules[key].some(p => typeof p !== "string" || !p))
      invalid(`${key} 必须是非空字符串组成的数组。`);
  rules.exclude = [...new Set(rules.exclude.map(p => p.replace(/\/$/, "")))];
  for (const p of rules.exclude) {
    if (!p || /[!\[\]{}\\\r\n\0]/.test(p) || p.includes("**") || p.includes("//") ||
      p.split("/").some(part => part === "." || part === ".."))
      invalid(`不支持的排除规则：${p}。支持普通路径、* 和 ?，不支持 !、**、字符组或 ..。`);
  }
  rules.envFiles = [...new Set(rules.envFiles)];
  for (const p of rules.envFiles) {
    if (p.startsWith("/") || /[*?\[\]{}\\\r\n\0]/.test(p) || path.posix.normalize(p) !== p ||
      p.split("/").includes("..") || !path.posix.basename(p).startsWith(".env"))
      invalid(`envFiles 必须是项目内具体的 .env 文件路径：${p}`);
    if (p.split("/").slice(0, -1).some(part => part.startsWith(".env")))
      invalid(`环境文件不能位于被 .env* 排除的目录中：${p}`);
    if ([...protectedPatterns, ...rules.exclude].some(pattern => matches(p, pattern)))
      invalid(`允许同步的环境文件位于被排除的路径中：${p}`);
  }
  return rules;
}

// A deliberately bounded glob grammar shared by JS, GNU find and Mutagen.
// Wildcards match one path component; paths containing / are rooted.
export function patternBody(pattern) {
  const rooted = pattern.startsWith("/") || pattern.includes("/");
  pattern = pattern.replace(/^\//, "");
  const escaped = [...pattern].map(c => c === "*" ? "[^/]*" : c === "?" ? "[^/]" :
    /[.\[\]{}()+^$|\\]/.test(c) ? "\\" + c : c).join("");
  return (rooted ? "" : "(.*/)?") + escaped + "(/.*)?";
}
export function matches(file, pattern) {
  return new RegExp("^" + patternBody(pattern) + "$").test(file);
}
export function ignored(file, rules = defaultRules) {
  if ([...protectedPatterns, ...rules.exclude].some(pattern => matches(file, pattern))) return true;
  return matches(file, ".env*") && !rules.envFiles.includes(file);
}
export function mutagenIgnores(rules = defaultRules) {
  return [...protectedPatterns, ...rules.exclude, ".env*", ...rules.envFiles.map(p => "!/" + p)];
}
