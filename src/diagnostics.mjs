import { stripVTControlCharacters } from "node:util";

const count = n => Number.isSafeInteger(n) && n > 0 ? n : 0;
export function diagnose(issue) {
  const raw = issue.message || "";
  const side = issue.side === "remote" ? "远端" : issue.side === "local" ? "本地" : "";
  if (/authentication failed|incorrect password|permission denied.*(?:publickey|password)|认证失败|密码认证失败/i.test(raw))
    return { category: "AUTH", title: "SSH 认证失败", advice: "检查同步账号、密钥或认证配置后重试。" };
  if (/permission denied|operation not permitted|EACCES|EPERM/i.test(raw))
    return { category: "PERMISSION", title: `${side}${issue.code === "FILE_SCAN" ? "文件读取" : issue.code === "FILE_WRITE" ? "文件写入" : "文件操作"}权限不足`, advice: "检查文件及父目录的所有者和访问权限；写入还需要父目录的写入权限。" };
  if (/no space left|disk quota exceeded|ENOSPC|EDQUOT/i.test(raw))
    return { category: "SPACE", title: `${side}空间或配额不足`, advice: "检查磁盘空间、inode 和用户配额，清理后重试。" };
  if (/connection refused|connection timed out|network is unreachable|no route to host|could not resolve hostname|connection reset|broken pipe/i.test(raw))
    return { category: "NETWORK", title: "连接失败", advice: "检查网络/VPN、主机地址及 SSH 服务，恢复连接后重试。" };
  if (issue.code.startsWith("SYNC_CONFLICT"))
    return { category: "CONFLICT", title: "文件同步冲突", advice: "检查所列路径的两端内容和文件类型，处理冲突后重试。" };
  if (issue.code === "SYNC_HALTED")
    return { category: "HALTED", title: "同步引擎已停止", advice: "检查两端项目根目录是否被删除或替换，确认目录正确后重试。" };
  return { category: issue.code, title: `${side}${issue.code.startsWith("FILE_SCAN") ? "文件扫描失败" : issue.code.startsWith("FILE_WRITE") ? "文件写入失败" : "同步失败"}`, advice: "根据原始错误检查对应路径或配置，排除问题后重试。" };
}
export function sessionIssues(s) {
  const issues = [];
  for (const [key, side] of [["alpha", "local"], ["beta", "remote"]]) {
    for (const [kind, code, omitted] of [["scanProblems", "FILE_SCAN", "excludedScanProblems"], ["transitionProblems", "FILE_WRITE", "excludedTransitionProblems"]]) {
      for (const p of s?.[key]?.[kind] || []) issues.push({ code, side, path: p.path, message: p.error });
      if (count(s?.[key]?.[omitted])) issues.push({ code: code + "_OMITTED", side, count: count(s[key][omitted]), message: "引擎省略了更多路径的详情。" });
    }
  }
  for (const c of s?.conflicts || []) issues.push({ code: "SYNC_CONFLICT", path: c.root, message: "此路径存在同步冲突。" });
  if (count(s?.excludedConflicts)) issues.push({ code: "SYNC_CONFLICT_OMITTED", count: s.excludedConflicts, message: "引擎省略了更多冲突的详情。" });
  if (s?.lastError) issues.push({ code: "SESSION_ERROR", message: s.lastError });
  if (s?.status?.startsWith("halted-")) issues.push({ code: "SYNC_HALTED", message: s.status });
  return issues;
}
export function failureRecord(error, { phase, password, remote } = {}) {
  const issues = error.details?.issues?.length ? error.details.issues : [{ code: error.code || "SYNC_FAILED", message: error.message }];
  const record = { version: 1, at: new Date().toISOString(), phase: phase || "准备同步", remote,
    issues: issues.map(i => ({ ...i, ...diagnose(i) })) };
  // Persist only diagnostic fields, never an arbitrary error/credential object.
  return JSON.parse(JSON.stringify(record, (_key, value) => typeof value === "string" && password ? value.replaceAll(password, "[隐藏]") : value));
}
export function diagnosticText(record, { verbose = false } = {}) {
  const lines = [], groups = new Map();
  for (const issue of record.issues) {
    const d = { ...issue, ...diagnose(issue) };
    const key = `${d.side || ""}:${d.category}:${d.code}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  for (const group of groups.values()) {
    const total = group.reduce((sum, i) => sum + (i.count || 1), 0);
    lines.push(`${group[0].title}（${total} 项问题）`);
    for (const i of verbose ? group : group.slice(0, 3)) {
      lines.push(`  ${i.side === "remote" ? "远端 " : i.side === "local" ? "本地 " : ""}${i.path !== undefined ? i.path || "项目根目录" : "详情"}：${i.message}`);
    }
    if (!verbose && group.length > 3) lines.push(`  另有 ${group.length - 3} 项，执行 devsync status --verbose 查看。`);
    lines.push(`建议：${group[0].advice}`);
  }
  return stripVTControlCharacters(lines.join("\n"));
}
