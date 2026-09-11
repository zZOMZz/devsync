import { diagnose, diagnosticText } from "./diagnostics.mjs";
import { healthy, isProcessAlive } from "./core.mjs";

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const endpoint = value => ({
  connected: typeof value?.connected === "boolean" ? value.connected : null,
  files: Number.isSafeInteger(value?.files) && value.files >= 0 ? value.files : value?.scanned === true ? 0 : null,
});
const authenticationFailure = message => /authentication failed|incorrect password|permission denied.*(?:publickey|password)|认证失败|密码认证失败/i.test(message || "");

// Versioned, additive status contract. Engine data remains in the legacy
// session field; consumers can use this projection without knowing Mutagen.
export function projectStatus({ root, configured, control = {}, session = null, queryError = null, lastRun = null, lastFailure = null }) {
  // A successful command supersedes a stale snapshot even if cleanup failed.
  if (lastFailure && lastRun && lastRun.at >= lastFailure.at) lastFailure = null;
  const requested = control.auto === true;
  const running = isProcessAlive(control.pid);
  const manager = {
    requested, running,
    state: running ? requested ? "running" : "stopping" : control.error ? "failed" : requested ? "missing" : "stopped",
  };
  const auto = requested && running;
  const issues = [], actions = [];
  const issue = (code, severity, message, details = {}) => issues.push({ code, severity, message, ...details });
  const action = (command, reason) => {
    if (!actions.some(a => a.command === command)) actions.push({ command, reason });
  };
  let problemCount = 0;
  for (const [source, side] of [["alpha", "local"], ["beta", "remote"]]) {
    for (const [kind, code, omitted] of [["scanProblems", "FILE_SCAN", "excludedScanProblems"], ["transitionProblems", "FILE_WRITE", "excludedTransitionProblems"]]) {
      for (const problem of session?.[source]?.[kind] || []) {
        issue(code, "error", problem.error, { side, path: problem.path });
        problemCount++;
      }
      const excluded = count(session?.[source]?.[omitted]);
      if (excluded) {
        issue(code + "_OMITTED", "error", `引擎还省略了 ${excluded} 个文件问题。`, { side, count: excluded });
        problemCount += excluded;
      }
    }
  }
  const fileProblems = problemCount > 0;
  for (const conflict of session?.conflicts || []) {
    issue("SYNC_CONFLICT", "error", "此路径存在同步冲突，请检查两端文件。", { path: conflict.root });
    problemCount++;
  }
  const excludedConflicts = count(session?.excludedConflicts);
  if (excludedConflicts) {
    issue("SYNC_CONFLICT_OMITTED", "error", `引擎还省略了 ${excludedConflicts} 个冲突。`, { count: excludedConflicts });
    problemCount += excludedConflicts;
  }
  const conflicts = Boolean(session?.conflicts?.length || excludedConflicts);
  const authFailed = authenticationFailure(control.error) || authenticationFailure(session?.lastError);
  const halted = session?.status?.startsWith("halted-");
  if (queryError) issue("SESSION_UNAVAILABLE", "error", `无法读取同步会话，当前传输状态未知：${queryError.message}`);
  if (authFailed) issue("AUTH_FAILED", "error", control.error || session.lastError);
  else {
    if (control.error) issue("MANAGER_FAILED", "error", control.error);
    if (session?.lastError) issue("SESSION_ERROR", "error", session.lastError);
  }
  if (halted) issue("SYNC_HALTED", "error", "同步引擎因项目根目录变动停止，请检查两端根目录。");
  if (manager.state === "missing") issue("MANAGER_MISSING", "warning", "已请求自动同步，但后台重连管理进程未运行。");

  let syncState;
  if (queryError) syncState = "unknown";
  else if (!session) syncState = "not-started";
  else if (session.paused) syncState = "paused";
  else if (conflicts) syncState = "conflict";
  else if (fileProblems || halted) syncState = "error";
  else if (session.alpha?.connected === false || session.beta?.connected === false) syncState = "disconnected";
  else if (session.lastError) syncState = "error";
  else if (healthy(session)) syncState = "aligned";
  else if (["scanning", "waiting-for-rescan"].includes(session.status)) syncState = "scanning";
  else if (["reconciling", "staging-alpha", "staging-beta", "transitioning", "saving"].includes(session.status)) syncState = "syncing";
  else if (["disconnected", "connecting-alpha", "connecting-beta"].includes(session.status)) syncState = "disconnected";
  else syncState = "unknown";
  const active = queryError ? null : session ? !session.paused : false;
  if (syncState === "unknown" && !queryError)
    issue("SESSION_STATE_UNKNOWN", "warning", "引擎返回了尚不能识别的状态，无法确认文件是否对齐。");
  if (syncState === "disconnected" && !authFailed)
    issue("ENDPOINT_DISCONNECTED", "warning", auto ? "端点未连接，请检查网络/VPN；后台重连管理正在运行。" : "端点未连接，请检查网络/VPN。后台重连管理未运行。");
  if (active && !running && manager.state !== "missing")
    issue("SESSION_UNMANAGED", "info", "同步会话仍处于启用状态，后台重连管理未运行。");
  if (!configured) {
    issue("NOT_CONFIGURED", "info", "尚未配置项目连接。");
    if (active) action("stop", "如需停止现有会话，先停止当前项目同步。");
    action("init", "配置项目连接。");
  } else if (manager.state !== "stopping") {
    if (authFailed) action("config", "更新认证配置，保存后执行 devsync start。");
    else if (halted) action("stop", "先停止同步并检查两端根目录，再决定恢复方式。");
    else if (fileProblems || conflicts) {
      if (active) action("stop", "先暂停同步，检查上述路径的冲突或权限。");
      action("sync", [...new Set(issues.filter(i => i.severity === "error").map(i => diagnose(i).advice))].join(" ") + " 修复后重新同步。");
    } else if (session?.lastError) {
      action("sync", diagnose({ code: "SESSION_ERROR", message: session.lastError }).advice);
    } else if (lastFailure && !healthy(session)) {
      if (active) action("stop", "检查文件问题前可先暂停同步。");
      const advice = [...new Set(lastFailure.issues.map(i => diagnose(i).advice))].join(" ");
      action(lastFailure.issues.some(i => diagnose(i).category === "AUTH") ? "config" : "sync", advice + " 修复后重试。");
    } else if (queryError || !session || session.paused || !auto) {
      action("start", "如需持续同步，启动或恢复后台管理。");
      if (active || queryError) action("stop", "如需停止可能仍在运行的传输，停止当前项目同步。");
    } else if (syncState === "unknown") action("status", "稍后再次查询；若持续未知，检查 Mutagen 版本与状态。");

  }
  // Keep the original state vocabulary for existing consumers.
  const state = queryError ? "unavailable" : !session ? "not-started" : session.paused ? "paused" : syncState === "aligned" ? "watching" : "attention";
  return {
    statusVersion: 1, project: root, configured, auto, state,
    manager,
    sync: { state: syncState, active,
      aligned: ["unknown", "not-started", "paused"].includes(syncState) ? null : syncState === "aligned",
      local: endpoint(session?.alpha), remote: endpoint(session?.beta), problemCount },
    issues, actions,
    error: issues.find(i => ["error", "warning"].includes(i.severity))?.message || null,
    session, lastRun, lastFailure,
  };
}

export function statusText(result, { verbose = false } = {}) {
  const managerLabels = { running: "运行中", stopping: "正在停止", stopped: "未运行", missing: "异常退出或未启动", failed: "因错误退出" };
  const syncLabels = { unknown: "状态未知，无法确认是否仍在传输", "not-started": "尚未创建会话", paused: "已暂停，当前文件是否对齐未知",
    aligned: "当前文件已对齐", disconnected: "端点未连接", scanning: "正在扫描文件", syncing: "正在同步文件", conflict: "存在同步冲突", error: "存在同步错误" };
  const lines = [result.project, `同步：${syncLabels[result.sync.state]}`, `后台重连管理：${managerLabels[result.manager.state]}`];
  const fileIssues = result.issues.filter(i => /^(FILE_|SYNC_CONFLICT)/.test(i.code));
  for (const issue of result.issues.filter(i => !fileIssues.includes(i))) {
    lines.push(`[${issue.code}] ${issue.message}`);
  }
  if (fileIssues.length) lines.push(diagnosticText({ issues: fileIssues }, { verbose }));
  if (result.lastFailure) {
    lines.push(`上次命令失败：${result.lastFailure.at} · ${result.lastFailure.phase}`,
      "以下为历史失败记录，不代表当前检查结果；本轮操作未全部完成，可能已有部分文件同步。",
      ...(result.lastFailure.remote ? [`当时远端：${result.lastFailure.remote.username}@${result.lastFailure.remote.host}:${result.lastFailure.remote.path}`] : []),
      diagnosticText(result.lastFailure, { verbose }));
  }
  if (result.lastRun) lines.push(`上次命令同步成功：${result.lastRun.at}，${result.lastRun.files} 个文件（不代表当前后台同步时间）。`);
  for (const action of result.actions) lines.push(`下一步：在项目目录执行 devsync ${action.command} — ${action.reason}`);
  return lines.join("\n") + "\n";
}
