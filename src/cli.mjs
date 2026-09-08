import readline from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { readJson, cancelCommands } from "./core.mjs";
import { resolveProject, userConfigPath } from "./project.mjs";
import { ProjectSync } from "./service.mjs";
import { configureConnection } from "./configure.mjs";
import { sshAliases, sshDefaults, probeConnection, checkRemotePath } from "./connection.mjs";
import { runWorker } from "./worker.mjs";
import { withProgress } from "./progress.mjs";
import { SyncError, errorResult } from "./errors.mjs";

export const help = `devsync — 本地源码同步到 Linux 开发机

用法：devsync <命令> [--dir <项目目录>]

  init       引导配置当前项目，生成 sync.config.json
  config     修改并验证连接配置，自动同步保持暂停
  preview    暂停自动同步并预览差异，不修改远端源码
  sync       同步一次；已开启自动模式时保持自动模式
  start      同步并开启后台自动模式
  stop       停止当前项目的自动同步
  status     查看当前项目状态（不会启动后台进程）

选项：
  --dir, -C  指定项目目录，默认使用当前目录
  --json     输出结构化 JSON（status/preview/sync/start/stop）
  --yes      确认预览结果并允许首次接入或配置变更后的同步
  --help     显示帮助
  --version  显示版本

项目无需 package.json。连接和密码保存在项目私有 .sync/ 中。
用户级下载设置：${userConfigPath()}
`;
export function parseArgs(args) {
  const result = { action: null, dir: process.cwd(), json: false, yes: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (["--help", "-h"].includes(arg)) { result.help = true; continue; }
    if (arg === "--version") { result.version = true; continue; }
    if (arg === "--json") { result.json = true; continue; }
    if (arg === "--yes") { result.yes = true; continue; }
    if (["--dir", "-C", "--binary", "--token"].includes(arg)) {
      if (!args[index + 1] || args[index + 1].startsWith("--"))
        throw new SyncError("USAGE", `${arg} 缺少参数。`);
      result[arg === "-C" ? "dir" : arg.slice(2)] = args[++index];
      continue;
    }
    if (arg.startsWith("-")) throw new SyncError("USAGE", `未知选项：${arg}`);
    if (result.action) throw new SyncError("USAGE", `多余的参数：${arg}`);
    result.action = arg;
  }
  result.action ||= "help";
  if (!["help", "init", "config", "preview", "sync", "start", "stop", "status", "_worker"].includes(result.action))
    throw new SyncError("USAGE", `未知命令：${result.action}`);
  if (result.action !== "_worker" && (result.binary || result.token)) throw new SyncError("USAGE", "无效的内部选项。");
  if (result.action === "_worker" && (!result.binary || !result.token)) throw new SyncError("USAGE", "后台启动参数不完整。");
  if (result.json && ["init", "config"].includes(result.action))
    throw new SyncError("USAGE", "init/config 需要交互终端；编辑器可调用核心 API 配置连接。");
  return result;
}
export async function ask(message, secret = false, signal) {
  if (!process.stdin.isTTY) throw new SyncError("INTERACTION_REQUIRED", "配置需要交互终端，请执行 devsync init 或 devsync config。");
  let output = process.stdout;
  if (secret) {
    output.write(message);
    output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  }
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  try { const answer = await rl.question(secret ? "" : message, { signal }); return secret ? answer : answer.trim(); }
  finally { rl.close(); if (secret) process.stdout.write("\n"); }
}
function scopeText(scope) {
  const remote = scope.remote;
  return `本地目录：${scope.local}\n远端目录：${remote.username}@${remote.host}:${remote.port}:${remote.path}\n` +
    "本地删除会同步到远端；远端独有的未排除文件会删除，远端修改会被本地覆盖。\n" +
    (scope.envFiles.length ? `允许同步的环境文件：${scope.envFiles.join("、")}` : ".env* 环境文件默认不参与同步。");
}
function previewText(plan) {
  const details = ["updated", "deleted"].flatMap(key => plan[key].slice(0, 15).map(file => `  ${key === "updated" ? "覆盖" : "删除"}：${file}`));
  return `${scopeText(plan.scope)}\n将新增 ${plan.added.length}、覆盖 ${plan.updated.length}、删除 ${plan.deleted.length} 个文件。\n` +
    (plan.remoteExists ? "" : "远端目录尚不存在，同步确认后创建。\n") + details.join("\n");
}
async function confirm(message, options, details) {
  if (options.signal?.aborted) throw new SyncError("INTERRUPTED", "操作已中断。");
  if (options.yes) return true;
  if (!process.stdin.isTTY || options.json)
    throw new SyncError("CONFIRMATION_REQUIRED", "请先查看 devsync preview，确认后在同步命令中使用 --yes，或在交互终端执行。", details);
  return (await ask(message + " [y/N] ", false, options.signal)).toLowerCase() === "y";
}
export async function main(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(args);
    if (options.help || (options.action === "help" && !options.version)) { process.stdout.write(help); return; }
    if (options.version) {
      const pkg = await readJson(fileURLToPath(new URL("../package.json", import.meta.url)));
      process.stdout.write(pkg.version + "\n"); return;
    }
    const root = await resolveProject(options.dir);
    if (options.action === "_worker") { await runWorker(root, options.binary, options.token); return; }
    let interrupted = false;
    const controller = new AbortController();
    options.signal = controller.signal;
    const interrupt = () => { interrupted = true; controller.abort(); cancelCommands(); };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
      const service = new ProjectSync(root, {
        signal: options.signal,
        onEvent: event => {
          if (!options.json) process.stderr.write((event.type === "backup" ? `✓ 备份已保存：${event.path}` : event.message) + "\n");
        },
        stage: options.json ? async (_label, task) => task({ consume() {} }) : withProgress,
      });
      let result;
      if (["init", "config"].includes(options.action)) {
        result = await service.configure(async (project, auth) => {
          process.stdout.write("配置引导：回车沿用已有值；连接、认证和目录将依次验证。\n");
          return configureConnection((message, secret) => ask(message, secret, options.signal), project.config, auth, {
            root, aliases: await sshAliases(), resolve: sshDefaults,
            probe: (cfg, credentials) => probeConnection(root, cfg, credentials),
            checkPath: (cfg, credentials) => checkRemotePath(root, cfg, credentials),
          });
        }, async scope => {
          process.stdout.write(scopeText(scope) + "\n");
          return confirm("检查通过，是否保存配置？", options, scope);
        });
      } else if (options.action === "preview") result = await service.preview();
      else if (options.action === "status") result = await service.status();
      else if (options.action === "stop") result = await service.stop();
      else result = await service.sync({ auto: options.action === "start", confirm: async preview => {
        if (!options.json) process.stdout.write(previewText(preview) + "\n");
        return confirm("以本地为准同步，是否继续？", options, preview);
      } });
      if (interrupted) throw new SyncError("INTERRUPTED", "操作已中断。");
      if (options.json) process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
      else if (["init", "config"].includes(options.action)) process.stdout.write("✓ 配置已保存，自动同步保持暂停。执行 devsync sync 或 devsync start 开始同步。\n");
      else if (options.action === "preview") process.stdout.write(previewText(result) + "\n完整清单：.sync/preview.json；自动同步保持暂停。\n");
      else if (options.action === "stop") process.stdout.write("✓ 当前项目的自动同步已停止。\n");
      else if (options.action === "status") {
        const labels = { "not-started": "尚未启动", paused: "已暂停", watching: "文件已对齐", attention: "连接或文件读写需要处理", unavailable: "后台服务不可用" };
        process.stdout.write(`${root}\n${labels[result.state]}${result.auto ? "，后台自动同步中" : ""}\n`);
        if (result.error) process.stdout.write(result.error + "\n");
        if (result.lastRun) process.stdout.write(`上次同步成功：${result.lastRun.at}，${result.lastRun.files} 个文件。\n`);
        for (const side of ["alpha", "beta"])
          for (const kind of ["scanProblems", "transitionProblems"])
            for (const problem of result.session?.[side]?.[kind] || []) process.stdout.write(`${problem.path}：${problem.error}\n`);
      } else process.stdout.write(`✓ ${result.files} 个文件已对齐，${result.auto ? "后台自动同步已开启" : "本次同步结束"}。\n`);
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  } catch (error) {
    if (options?.signal?.aborted) error = new SyncError("INTERRUPTED", "操作已中断，自动同步请用 devsync status 检查。");
    const json = options?.json || args.includes("--json");
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: errorResult(error) }) + "\n");
    else process.stderr.write(`devsync：${error.message}\n`);
    process.exitCode = error.code === "INTERRUPTED" ? 130 : 1;
  }
}
