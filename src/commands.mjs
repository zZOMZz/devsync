// Shared by argument validation, help and shell completion.
export const commands = [
  { name: "init", description: "引导配置当前项目，生成 sync.config.json" },
  { name: "config", description: "修改并验证连接配置，自动同步保持暂停" },
  { name: "preview", description: "暂停自动同步并预览差异，不修改远端源码" },
  { name: "sync", description: "同步一次；已开启自动模式时保持自动模式" },
  { name: "start", description: "同步并开启后台自动模式" },
  { name: "stop", description: "停止当前项目的自动同步" },
  { name: "status", description: "查看当前项目状态，不启动后台进程" },
  { name: "dashboard", description: "打开所有已登记项目的控制面板" },
  { name: "completion", description: "生成、安装或卸载 Shell 补全" },
  { name: "help", description: "显示帮助" },
];
export const flags = [
  { names: ["--dir", "-C"], key: "dir", argument: "目录", description: "指定项目目录", actions: ["init", "config", "preview", "sync", "start", "stop", "status", "dashboard"] },
  { names: ["--verbose"], key: "verbose", description: "展示全部已记录问题路径", actions: ["status"] },
  { names: ["--json"], key: "json", description: "输出结构化 JSON", actions: ["preview", "sync", "start", "stop", "status", "dashboard", "completion"] },
  { names: ["--yes"], key: "yes", description: "确认预览并允许同步", actions: ["sync", "start"] },
  { names: ["--help", "-h"], key: "help", description: "显示帮助" },
  { names: ["--version"], key: "version", description: "显示版本" },
];
