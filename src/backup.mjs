import path from "node:path";
import { digest } from "./core.mjs";
import { ignored, normalizeRules } from "./rules.mjs";
import { SyncError } from "./errors.mjs";

export function backupPolicy(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["mode", "keep"].includes(key)))
    throw new SyncError("INVALID_BACKUP", "backup 仅支持 mode 和 keep 字段。");
  const policy = { mode: "auto", keep: 3, ...value };
  if (!["auto", "off"].includes(policy.mode)) throw new SyncError("INVALID_BACKUP", "backup.mode 必须为 auto 或 off。");
  if (!Number.isInteger(policy.keep) || policy.keep < 1 || policy.keep > 100)
    throw new SyncError("INVALID_BACKUP", "backup.keep 必须为 1–100 的整数。");
  return policy;
}
export function backupTarget(cfg) {
  const r = cfg.remote;
  return { host: r.host, username: r.username, port: r.port, path: path.posix.normalize(r.path).replace(/\/$/, "") };
}
export function backupScope(root, cfg, rules) {
  return { version: 1, root, remote: backupTarget(cfg), rules: { exclude: rules.exclude, envFiles: rules.envFiles } };
}
export function planBackup(root, cfg, rules, diff, accepted = {}) {
  const policy = backupPolicy(cfg.backup);
  const current = backupScope(root, cfg, rules), prior = accepted.backupScope;
  const affected = [...new Set([...diff.updated, ...diff.deleted])];
  let files = affected, reason = "first-contact";
  if (prior?.version === 1 && prior.root === root && JSON.stringify(prior.remote) === JSON.stringify(current.remote)) {
    try {
      if (!Array.isArray(prior.rules?.exclude) || !Array.isArray(prior.rules?.envFiles)) throw Error("incomplete history");
      const oldRules = normalizeRules(prior.rules);
      files = affected.filter(file => ignored(file, oldRules));
      reason = files.length ? "scope-expanded" : "scope-unchanged";
    } catch { reason = "unknown-history"; } // Invalid history never disables a required backup.
  } else if (prior?.version === 1) reason = "target-changed";
  if (policy.mode === "off") reason = "disabled";
  else if (!affected.length) reason = "no-affected-files";
  return { ...policy, enabled: policy.mode === "auto" && files.length > 0,
    reason, files, fileCount: files.length, estimatedBytes: null };
}

export function backupOwner(root) { return digest(root).slice(0, 24); }
export function ownedBackup(root, cfg, file) {
  if (typeof file !== "string") return false;
  const target = backupTarget(cfg).path;
  const prefix = `${path.posix.basename(target)}.sync-backup-${backupOwner(root)}-`;
  return path.posix.dirname(file) === path.posix.dirname(target) && path.posix.basename(file).startsWith(prefix) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tar\.gz$/.test(path.posix.basename(file).slice(prefix.length));
}
