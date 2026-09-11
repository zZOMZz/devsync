import { diagnosticText } from "./diagnostics.mjs";
import { statusText } from "./status.mjs";
import * as prompts from "@clack/prompts";
import readline from "node:readline/promises";
import { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { withProgress } from "./progress.mjs";
import { SyncError } from "./errors.mjs";
import { backupPolicy } from "./backup.mjs";

export function scopeLines(scope) {
  const remote = scope.remote;
  const lines = [`本地  ${scope.local}`, `远端  ${remote.username}@${remote.host}:${remote.port}:${remote.path}`];
  if (scope.authentication) lines.push(`认证  ${{ password: "密码", "identity-file": "指定私钥", "ssh-config": "SSH config / agent" }[scope.authentication]}`);
  if (scope.identityFile) lines.push(`私钥  ${scope.identityFile}`);
  if (scope.backup) lines.push(scope.backup.mode === "off" ? "备份  已关闭" : `备份  自动，保留最近 ${scope.backup.keep} 份`);
  lines.push(scope.envFiles.length ? `允许的环境文件  ${scope.envFiles.join("、")}` : ".env* 环境文件不参与同步");
  lines.push("本地删除会同步到远端；远端独有的未排除文件会删除，远端修改会被本地覆盖。");
  return lines;
}

// Keep summaries readable in narrow terminals, including CJK text. No content
// is omitted; long paths can wrap and full preview data remains in JSON.
export function wrapLines(text, columns) {
  const width = Math.max(12, columns - 5);
  return stripVTControlCharacters(text).split("\n").flatMap(line => {
    const parts = []; let current = "", used = 0;
    for (const char of line) {
      const size = /\p{Mark}/u.test(char) ? 0 : /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(char) ? 2 : 1;
      if (used + size > width && current) { parts.push(current); current = ""; used = 0; }
      current += char; used += size;
    }
    parts.push(current);
    return parts;
  }).join("\n");
}

export async function plainQuestion(message, secret = false, signal) {
  if (!process.stdin.isTTY) throw new SyncError("INTERACTION_REQUIRED", "配置需要交互终端，请执行 devsync init 或 devsync config。");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const output = secret ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : process.stdout;
  if (secret) process.stdout.write(message);
  const rl = readline.createInterface({ input: process.stdin, output, terminal: secret });
  rl.on("SIGINT", abort);
  try {
    const answer = await rl.question(secret ? "" : message, { signal: controller.signal });
    return secret ? answer : answer.trim();
  } catch (error) {
    if (controller.signal.aborted) throw new SyncError("INTERRUPTED", "操作已中断。");
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    rl.close();
    if (secret) process.stdout.write("\n");
  }
}

export class TerminalUI {
  constructor({ json = false, signal, action } = {}) {
    this.json = json;
    this.signal = signal;
    this.rich = !json && Boolean(process.stdin.isTTY && process.stdout.isTTY) && process.env.TERM !== "dumb";
    this.cancelMessage = ["init", "config"].includes(action) ? "已取消，配置未保存，自动同步保持暂停。" : "已取消，自动同步保持暂停。";
  }
  async prompt(task) {
    if (this.signal?.aborted) throw new SyncError("INTERRUPTED", this.cancelMessage);
    let interrupted = false;
    const key = (_text, value) => { if (value?.ctrl && value.name === "c") interrupted = true; };
    // Clack 0.11 does not forward AbortSignal to its core prompts. Trigger its
    // own cancellation path so raw mode, cursor and listeners are restored.
    const abort = () => process.stdin.emit("keypress", "\x1b", { name: "escape", sequence: "\x1b" });
    process.stdin.on("keypress", key);
    this.signal?.addEventListener("abort", abort, { once: true });
    try {
      const value = await task();
      if (this.signal?.aborted || interrupted) throw new SyncError("INTERRUPTED", this.cancelMessage);
      if (prompts.isCancel(value)) throw new SyncError("CANCELLED", this.cancelMessage);
      return value;
    } finally {
      process.stdin.off("keypress", key);
      this.signal?.removeEventListener("abort", abort);
    }
  }
  async ask(message, secret = false, options = {}) {
    if (!this.rich) return plainQuestion(message, secret, this.signal);
    return this.prompt(() => secret ? prompts.password({ message: options.message || message, validate: options.validate })
      : prompts.text({ message: options.message || message, initialValue: options.initialValue,
        defaultValue: options.initialValue, validate: options.validate }));
  }
  async select(options) {
    if (this.rich) return this.prompt(() => prompts.select({ ...options, maxItems: 6,
      options: options.options.map(item => ({ ...item, hint: process.stdout.columns < 65 ? undefined : item.hint })) }));
    const { message, options: choices, initialValue } = options;
    process.stdout.write(`${message}\n${choices.map((item, index) => `  ${index + 1}. ${item.label}`).join("\n")}\n`);
    const initial = choices.findIndex(item => item.value === initialValue) + 1;
    while (true) {
      const answer = await plainQuestion(`请选择 [${initial || 1}]：`, false, this.signal);
      const number = Number(answer || initial || 1);
      if (Number.isInteger(number) && choices[number - 1]) return choices[number - 1].value;
      process.stdout.write("请输入列表中的序号。\n");
    }
  }
  async confirm(message, { yes = false, details, active = "继续，先备份再同步", inactive = "取消", initialValue = false } = {}) {
    if (this.signal?.aborted) throw new SyncError("INTERRUPTED", this.cancelMessage);
    if (yes) return true;
    if (this.json || !process.stdin.isTTY || !process.stdout.isTTY)
      throw new SyncError("CONFIRMATION_REQUIRED", "请先查看 devsync preview，确认后使用 --yes 或在交互终端执行。", details);
    if (this.rich) return this.prompt(() => prompts.confirm({ message, active, inactive, initialValue }));
    const answer = await plainQuestion(message + (initialValue ? " [Y/n] " : " [y/N] "), false, this.signal);
    return answer ? answer.toLowerCase() === "y" : initialValue;
  }
  async backupSettings(previous) {
    let policy;
    try { policy = backupPolicy(previous); }
    catch { policy = backupPolicy(); this.log("当前备份配置无效，请重新选择。", "warn"); }
    const choice = await this.select({ message: "备份策略", initialValue: policy.mode, options: [
      { value: "auto", label: `自动备份，保留最近 ${policy.keep} 份`, hint: "首次接入或扩大同步范围时" },
      { value: "off", label: "关闭备份", hint: "适合可随时重建的远端目录" },
      { value: "custom", label: "自动备份，自定义保留数量" },
    ] });
    if (choice !== "custom") return { ...policy, mode: choice };
    const validate = input => { try { backupPolicy({ keep: Number(input) }); } catch (error) { return error.message; } };
    while (true) {
      const answer = await this.ask(`保留数量 [${policy.keep}]：`, false, { message: "保留最近多少份备份？", initialValue: String(policy.keep), validate });
      const keep = Number(answer || policy.keep);
      const error = validate(String(keep));
      if (error) { this.log(error, "warn"); continue; }
      return { mode: "auto", keep };
    }
  }
  async confirmSync(plan, { yes = false } = {}) {
    if (!plan.backup?.enabled || yes || this.json || !process.stdin.isTTY || !process.stdout.isTTY)
      return this.confirm("以本地为准同步，是否继续？", { yes, details: plan, active: plan.backup?.enabled ? "备份后同步" : "直接同步" });
    const value = await this.select({ message: "选择同步方式", initialValue: "cancel", options: [
      { value: "backup", label: "备份后同步" },
      { value: "skip", label: "跳过本次备份，直接同步", hint: "仍会覆盖和删除远端文件" },
      { value: "cancel", label: "取消" },
    ] });
    return { confirmed: value !== "cancel", skipBackup: value === "skip" };
  }
  intro(message) { if (!this.json) this.rich ? prompts.intro(message) : process.stdout.write(message + "\n"); }
  outro(message) { if (!this.json) this.rich ? prompts.outro(message) : process.stdout.write(message + "\n"); }
  log(message, kind = "info") {
    if (this.json) return;
    if (this.rich) prompts.log[kind](wrapLines(message, process.stdout.columns || 80));
    else process.stderr.write(message + "\n");
  }
  scope(scope) {
    if (this.json) return;
    const text = scopeLines(scope).join("\n");
    if (this.rich) { prompts.log.step("同步范围"); prompts.log.message(wrapLines(text, process.stdout.columns || 80)); }
    else process.stdout.write(text + "\n");
  }
  preview(plan) {
    if (this.json) return;
    this.scope(plan.scope);
    if (!plan.remoteExists) this.log("远端目录尚不存在，确认同步后创建。");
    for (const [key, label, marker] of [["added", "新增", "+"], ["updated", "覆盖", "~"], ["deleted", "删除", "-"]]) {
      const files = plan[key];
      const lines = [`${label} ${files.length} 个文件`, ...files.slice(0, 15).map(file => `  ${marker} ${file}`)];
      if (files.length > 15) lines.push(`  另有 ${files.length - 15} 项，完整清单见 .sync/preview.json`);
      this.log(lines.join("\n"), key === "deleted" && files.length ? "warn" : "step");
    }
    if (plan.backup?.enabled) {
      const bytes = plan.backup.estimatedBytes;
      const size = bytes == null ? "未知" : bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
      this.log(`本次备份 ${plan.backup.fileCount} 个文件，${bytes == null ? "大小暂无法估算" : `原始大小约 ${size}（压缩后大小会变化）`}。同步成功后保留最近 ${plan.backup.keep} 份。`);
    } else if (plan.backup) {
      const reasons = { disabled: "项目已关闭备份", "scope-unchanged": "同步范围未扩大", "no-affected-files": "没有会被覆盖或删除的文件" };
      this.log(`本次不备份：${reasons[plan.backup.reason] || "无需备份"}。`);
    } else this.log("确认后先备份将被覆盖或删除的远端文件，再开始同步。");
  }
  async stage(label, task) {
    if (this.json) return task({ consume() {} });
    if (this.rich) process.stdout.write("│\n");
    return withProgress(label, task, { stream: this.rich ? process.stdout : process.stderr,
      interactive: this.rich, successSymbol: this.rich ? "◇" : "✓", failureSymbol: this.rich ? "■" : "✗" });
  }
  status(result, options) {
    const value = statusText(result, options);
    if (this.rich) {
      prompts.intro("devsync · 项目状态");
      this.log(value.trim(), result.lastFailure || result.issues.some(i => i.severity === "error") ? "warn" : "info");
      prompts.outro("完整结构化状态：devsync status --json");
    } else if (!this.json) process.stdout.write(value);
  }
  failure(error) {
    const diagnostic = error.details?.diagnostic;
    if (diagnostic) {
      this.log(`操作未全部完成 · ${diagnostic.phase}`, "error");
      if (diagnostic.remote) this.log(`远端：${diagnostic.remote.username}@${diagnostic.remote.host}:${diagnostic.remote.path}`);
      this.log(diagnosticText(diagnostic), "warn");
      this.log("可能已有部分文件同步。修复后执行 devsync sync 重试。\n查看失败记录：devsync status --verbose；结构化详情：devsync status --json");
      if (this.rich) prompts.outro("本次操作结束");
      return;
    }
    if (this.rich && ["CANCELLED", "INTERRUPTED"].includes(error.code)) prompts.cancel(error.message);
    else this.log(error.message, "error");
  }
}
