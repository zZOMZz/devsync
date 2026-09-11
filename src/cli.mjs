import { commands, flags } from "./commands.mjs";
import { parseCompletionArgs, runCompletion } from "./completion.mjs";
import { fileURLToPath } from "node:url";
import { readJson, cancelCommands } from "./core.mjs";
import { resolveProject, userConfigPath } from "./project.mjs";
import { ProjectSync } from "./service.mjs";
import { configureConnection } from "./configure.mjs";
import { sshAliases, sshDefaults } from "./connection.mjs";
import { runWorker } from "./worker.mjs";
import { TerminalUI, plainQuestion } from "./terminal-ui.mjs";
import { SyncError, errorResult } from "./errors.mjs";

export const help = `devsync — 本地源码同步到 Linux 开发机

用法：devsync <命令> [--dir <项目目录>]

${commands.map(c => `  ${c.name.padEnd(12)} ${c.description}`).join("\n")}

选项：
${flags.map(f => `  ${f.names.join(", ").padEnd(14)} ${f.description}`).join("\n")}

项目无需 package.json。连接和密码保存在项目私有 .sync/ 中。
用户级下载设置：${userConfigPath()}
`;
export function parseArgs(args) {
  if (args[0] === "completion") return { ...parseCompletionArgs(args.slice(1)), action: "completion", completion: args.slice(1) };
  const result = { action: null, dir: process.cwd(), json: false, yes: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const flag = flags.find(f => f.names.includes(arg));
    if (flag || ["--binary", "--token"].includes(arg)) {
      const key = flag?.key || arg.slice(2);
      if (flag?.argument || !flag) {
        if (!args[index + 1] || args[index + 1].startsWith("--"))
          throw new SyncError("USAGE", `${arg} 缺少参数。`);
        result[key] = args[++index];
      } else result[key] = true;
      continue;
    }
    if (arg.startsWith("-")) throw new SyncError("USAGE", `未知选项：${arg}`);
    if (result.action) throw new SyncError("USAGE", `多余的参数：${arg}`);
    result.action = arg;
  }
  result.action ||= "help";
  if (![...commands.map(c => c.name), "_worker"].includes(result.action))
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
    if (options.action === "completion") { await runCompletion(options.completion || (options.help ? ["--help"] : [])); return; }
    if (options.help || (options.action === "help" && !options.version)) { process.stdout.write(help); return; }
    if (options.version) {
      const pkg = await readJson(fileURLToPath(new URL("../package.json", import.meta.url)));
      process.stdout.write(pkg.version + "\n"); return;
    }
    if (options.action === "dashboard") {
      const { runDashboard } = await import("./dashboard.mjs");
      await runDashboard({ json: options.json, initialRoot: await resolveProject(options.dir) });
      return;
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
      else if (options.action === "status") ui.status(result, { verbose: options.verbose });
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
