import { fileURLToPath } from "node:url";
import { readJson, cancelCommands } from "./core.mjs";
import { resolveProject, userConfigPath } from "./project.mjs";
import { ProjectSync } from "./service.mjs";
import { configureConnection } from "./configure.mjs";
import { sshAliases, sshDefaults } from "./connection.mjs";
import { runWorker } from "./worker.mjs";
import { TerminalUI, plainQuestion } from "./terminal-ui.mjs";
import { SyncError, errorResult } from "./errors.mjs";
import { statusText } from "./status.mjs";

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
export const ask = plainQuestion;
export async function main(args = process.argv.slice(2)) {
  let options, ui;
  try {
    options = parseArgs(args);
    if (options.help || (options.action === "help" && !options.version)) { process.stdout.write(help); return; }
    if (options.version) {
      const pkg = await readJson(fileURLToPath(new URL("../package.json", import.meta.url)));
      process.stdout.write(pkg.version + "\n"); return;
    }
    if (["init", "config"].includes(options.action) && (!process.stdin.isTTY || !process.stdout.isTTY))
      throw new SyncError("INTERACTION_REQUIRED", "配置需要交互终端，请执行 devsync init 或 devsync config。");
    const root = await resolveProject(options.dir);
    if (options.action === "_worker") { await runWorker(root, options.binary, options.token); return; }
    let interrupted = false;
    const controller = new AbortController();
    options.signal = controller.signal;
    ui = new TerminalUI({ json: options.json, signal: options.signal, action: options.action });
    const interrupt = () => { interrupted = true; controller.abort(); cancelCommands(); };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
      if (["init", "config", "preview", "sync", "start"].includes(options.action))
        ui.intro(`devsync · ${{ init: "配置项目", config: "修改配置", preview: "差异预览", sync: "单次同步", start: "后台同步" }[options.action]}`);
      const service = new ProjectSync(root, {
        signal: options.signal,
        onEvent: event => ui.log(event.type === "backup" ? `备份已保存：${event.path}` : event.message, event.type === "warning" ? "warn" : "step"),
        stage: (label, task) => ui.stage(label, task),
      });
      let result;
      if (["init", "config"].includes(options.action)) {
        result = await service.configure(async (project, auth, checks) => {
          ui.log(ui.rich ? "方向键选择，回车确认；已有内容可直接编辑。配置完成后同步保持暂停。" : "输入序号选择，回车沿用默认值。配置完成后同步保持暂停。");
          const answers = await configureConnection((message, secret, metadata) => ui.ask(message, secret, metadata), project.config, auth, {
            root, aliases: await sshAliases(), resolve: sshDefaults,
            select: options => ui.select(options),
            probe: checks.probe, checkPath: checks.checkPath,
            log: message => ui.log(message, "warn"),
          });
          answers.cfg.backup = await ui.backupSettings(answers.cfg.backup);
          return answers;
        }, async scope => {
          ui.scope(scope);
          ui.log("保存后不会开始同步，可稍后执行 devsync sync 或 devsync start。");
          return ui.confirm("确认保存以上配置？", { details: scope, active: "保存配置", inactive: "暂不保存", initialValue: true });
        });
      } else if (options.action === "preview") result = await service.preview();
      else if (options.action === "status") result = await service.status();
      else if (options.action === "stop") result = await service.stop();
      else result = await service.sync({ auto: options.action === "start", confirm: async preview => {
        ui.preview(preview);
        return ui.confirmSync(preview, { yes: options.yes });
      } });
      if (interrupted) throw new SyncError("INTERRUPTED", "操作已中断。");
      if (options.json) process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
      else if (["init", "config"].includes(options.action)) ui.outro("配置已保存，同步保持暂停。执行 devsync sync 或 devsync start 开始同步。");
      else if (options.action === "preview") { ui.preview(result); ui.outro("自动同步保持暂停。完整清单：.sync/preview.json"); }
      else if (options.action === "stop") ui.outro("当前项目的自动同步已停止。");
      else if (options.action === "status") process.stdout.write(statusText(result));
      else ui.outro(`${result.files} 个文件已对齐，${result.auto ? "后台自动同步已开启" : "本次同步结束"}。`);
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  } catch (error) {
    if (options?.signal?.aborted) error = new SyncError("INTERRUPTED", "操作已中断，自动同步请用 devsync status 检查。");
    const json = options?.json || args.includes("--json");
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: errorResult(error) }) + "\n");
    else if (ui) ui.failure(error);
    else process.stderr.write(`devsync：${error.message}\n`);
    process.exitCode = error.code === "INTERRUPTED" ? 130 : 1;
  }
}
