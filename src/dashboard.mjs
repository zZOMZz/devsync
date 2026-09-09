import { DashboardModel } from "./dashboard-model.mjs";
import { TerminalUI } from "./terminal-ui.mjs";
import { configureConnection } from "./configure.mjs";
import { sshAliases, sshDefaults } from "./connection.mjs";
import { cancelCommands } from "./core.mjs";
import { SyncError } from "./errors.mjs";

export async function runDashboard({ json = false, model = new DashboardModel(), view, initialRoot } = {}) {
  if (json) {
    const result = await model.snapshotOnce();
    if (result.registryError) throw new SyncError("REGISTRY_UNAVAILABLE", result.registryError);
    process.stdout.write(JSON.stringify({ ok: true, dashboardVersion: 1, ...result }) + "\n");
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === "dumb")
    throw new SyncError("INTERACTION_REQUIRED", "控制面板需要交互终端；可使用 devsync dashboard --json 查看项目快照。");
  view ||= (await import("./dashboard-view.mjs")).dashboardView;
  let selectedRoot = initialRoot, message = "", currentView, operation, interrupted = false;
  const interrupt = () => { interrupted = true; currentView?.unmount(); operation?.abort(); cancelCommands(); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  try {
    while (!interrupted) {
      model.resume();
      const choice = await view(model, { selectedRoot, message, onMount: instance => { currentView = instance; } });
      await model.pause();
      selectedRoot = choice.root;
      if (choice.type === "quit" || interrupted) { interrupted ||= Boolean(choice.interrupted); break; }
      // Ink unrefs stdin on teardown; Clack expects a live input handle across
      // successive prompts. Give it ownership until returning to the panel.
      process.stdin.ref?.();
      operation = new AbortController();
      const ui = new TerminalUI({ signal: operation.signal, action: choice.type === "configure" ? "config" : choice.type });
      if (["add", "relocate", "remove"].includes(choice.type)) ui.cancelMessage = "已取消，项目记录和后台同步未改变。";
      try {
        if (["add", "relocate"].includes(choice.type)) {
          ui.intro(choice.type === "add" ? "添加已配置的项目" : "重新定位项目目录");
          const directory = await ui.ask("项目绝对路径：", false, { message: "项目目录", initialValue: choice.type === "add" ? process.cwd() : choice.root,
            validate: value => !value.trim() ? "请输入项目目录。" : undefined });
          const project = choice.type === "add" ? await model.registry.add(directory) : await model.registry.relocate(choice.root, directory);
          selectedRoot = project.root; message = `已登记：${project.name}`;
        } else if (choice.type === "remove") {
          ui.intro("移除项目记录");
          ui.log(choice.root);
          if (await ui.confirm("仅从面板移除？项目文件和后台同步保持原状。", { active: "移除记录", inactive: "保留记录" })) {
            await model.registry.remove(choice.root); selectedRoot = undefined; message = "项目记录已移除，文件和后台同步未改变。";
          } else message = "已保留项目记录。";
        } else {
          ui.intro(`${choice.type === "start" ? "开启自动同步" : choice.type === "stop" ? "停止自动同步" : "修改项目配置"} · ${choice.root}`);
          const options = { signal: operation.signal,
            onEvent: event => ui.log(event.type === "backup" ? `备份已保存：${event.path}` : event.message, event.type === "warning" ? "warn" : "step"),
            stage: (label, task) => ui.stage(label, task) };
          if (choice.type === "configure") {
            const result = await model.configure(choice.root, async (project, auth, checks) => {
              const answers = await configureConnection((...args) => ui.ask(...args), project.config, auth, {
                root: choice.root, aliases: await sshAliases(), resolve: sshDefaults, select: value => ui.select(value),
                probe: checks.probe, checkPath: checks.checkPath, log: value => ui.log(value, "warn"),
              });
              answers.cfg.backup = await ui.backupSettings(answers.cfg.backup);
              return answers;
            }, async scope => { ui.scope(scope); return ui.confirm("确认保存以上配置？", { active: "保存配置", inactive: "暂不保存", initialValue: true }); }, options);
            message = result.warnings?.join("；") || "配置已保存，同步保持暂停。";
          } else {
            const result = await model.operate(choice.type, choice.root, { ...options, confirm: async preview => { ui.preview(preview); return ui.confirmSync(preview); } });
            message = choice.type === "start" ? `自动同步已开启：${result.files} 个文件已对齐。` : "当前项目自动同步已停止。";
            if (result.warnings?.length) message += " " + result.warnings.join("；");
          }
        }
      } catch (error) {
        message = error.message;
        ui.failure(error);
        if (error.code === "INTERRUPTED" || interrupted) { interrupted = true; break; }
      } finally { operation = null; process.stdin.unref?.(); }
    }
  } finally {
    await model.pause();
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  }
  if (interrupted) throw new SyncError("INTERRUPTED", "控制面板已退出；后台同步状态可用 devsync status 检查。");
  process.stdout.write("控制面板已关闭，后台同步继续按原状态运行。\n");
}
