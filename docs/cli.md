# 命令与参数

本文对应 devsync 0.1.0，解释公开命令、参数默认值、适用范围和配置入口。理解同步方向、会话和确认机制，请先读[核心概念](core-concepts.md)。

## 命令格式

```bash
devsync <命令> [选项]
devsync status --dir /path/to/project --json
devsync -C /path/to/project status
```

项目目录必须已经存在；相对路径基于当前工作目录解析，符号链接目录会解析为真实路径。路径含空格时加引号，例如 `devsync status --dir "/path/to/my project"`。

参数名和值之间使用空格，例如 `--dir /path/to/project`；当前不支持 `--dir=/path/to/project`、短参数合并或直接在命令后填写项目路径。`completion` 使用独立语法，应紧接在 `devsync` 后，见下文[Shell 补全](#shell-补全)。

## 参数速查

| 参数 | 值与默认行为 | 生效场景 | 示例 |
| --- | --- | --- | --- |
| `--dir <目录>`、`-C <目录>` | 目录路径；默认当前目录，不向父目录查找 | `init/config/preview/sync/start/stop/status` 指定项目；`dashboard` 指定初始选中项目 | `devsync status -C /path/to/app` |
| `--json` | 无需值；默认使用终端文本或交互界面 | `preview/sync/start/stop/status/dashboard/completion` 输出结构化结果 | `devsync status --json` |
| `--yes` | 无需值；默认在需要新确认时询问用户 | `sync/start` 接受本次同步确认，继续按项目策略备份 | `devsync start --yes` |
| `--verbose` | 无需值；默认每类诊断最多展示 3 个示例 | `status` 文本输出展示全部已记录问题详情 | `devsync status --verbose` |
| `--help`、`-h` | 无需值；显示帮助并退出 | 普通命令显示总帮助；`completion --help` 显示补全帮助 | `devsync --help` |
| `--version` | 无需值；显示当前版本并退出 | 查询 devsync 版本 | `devsync --version` |

表中列的是参数实际起作用的场景。普通命令的解析器目前也可能接受无关选项，但不会因此产生对应行为，例如 `preview --yes` 仍然只做预览。按表中的组合使用即可。

`--json` 不改变命令本身的操作：`preview --json` 仍会暂停同步，`start --json --yes` 仍会传输文件并启动后台管理。帮助与版本输出使用文本，调用脚本时应分别处理。

## 命令速查

| 命令 | 用途 | 成功后的主要结果 |
| --- | --- | --- |
| `init` | 首次配置项目连接 | 保存配置，保持暂停 |
| `config` | 修改已有连接和备份策略 | 保存配置，保持暂停 |
| `preview` | 暂停并查看新增、覆盖、删除清单 | 远端源码保持原样，本地保存预览 |
| `sync` | 立即同步一次 | 通常完成后暂停；可复用原自动会话时保留自动模式 |
| `start` | 同步并开启自动模式 | 会话启用，后台重连管理运行 |
| `stop` | 停止当前项目自动同步 | 管理进程停止，会话暂停，配置和文件保留 |
| `status` | 查看当前项目状态 | 返回一次快照，不启动同步服务 |
| `dashboard` | 查看和管理已登记的多个项目 | 持续展示面板；退出不停止既有同步 |
| `completion` | 生成、安装或卸载 zsh 补全 | 输出规则，或更新用户 Shell 配置 |
| `help` | 显示总帮助 | 打印命令、选项及用户下载配置路径 |

### init 与 config

```bash
devsync init --dir /path/to/app
devsync config --dir /path/to/app
```

两个命令使用同一个交互配置流程：暂停已有同步 → 选择地址和认证方式 → 验证连接与目录 → 选择备份策略 → 确认保存。已有连接作为默认值，已有公共规则保留；公共规则不存在时创建默认规则文件。

需要标准输入和输出连接到终端。`init/config --json` 会报 `USAGE`；重定向输入或输出会报 `INTERACTION_REQUIRED`。`--yes` 不会代替配置向导。取消保留原配置，已暂停的自动同步保持暂停。键盘操作见[终端交互](terminal.md)。

### preview

```bash
devsync preview --dir /path/to/app
devsync preview --dir /path/to/app --json
```

要求项目已经配置。先停止重连管理并暂停会话，再验证连接、比较两端文件。结果包含 `added`、`updated`、`deleted` 和 `backup`，完整清单保存在项目 `.sync/preview.json`。

预览只读取远端源码；会改变本地预览和控制记录。预览后自动同步保持暂停，使用 `sync` 执行一次，或使用 `start` 恢复持续同步。

### sync 与 start

```bash
devsync sync --dir /path/to/app
devsync start --dir /path/to/app
devsync sync --dir /path/to/app --json --yes
```

`sync` 通常在传输完成后暂停；当原自动模式运行、配置未变且会话可复用时，保留自动模式。如果需要重建会话，`sync` 按单次操作结束。`start` 成功后则会确保后台自动模式运行。

没有会话或配置指纹变化时，两者都会重新计算差异并要求确认；日常文件内容变化不会单独触发新确认。交互确认默认取消。非交互或 JSON 模式下，需要确认但未提供 `--yes` 时，返回 `CONFIRMATION_REQUIRED`，预览位于 `error.details`。

`--yes` 只接受同步确认，仍然按 `.sync/config.json` 中的备份策略执行。跳过单次备份需要在交互确认中明确选择；CLI 没有 `--skip-backup` 参数。关于确认后可能发生的覆盖、删除和备份，见[核心概念](core-concepts.md#确认记录如何影响下一次同步)。

### stop

```bash
devsync stop --dir /path/to/app
devsync stop --dir /path/to/app --json
```

停止这个项目的重连管理并暂停会话，不删除本地或远端文件，不影响其他项目。没有 `.sync/` 的目录也可以执行，会返回已停止、尚未配置的结果。它也不会从面板移除项目记录。

### status

```bash
devsync status --dir /path/to/app
devsync status --dir /path/to/app --verbose
devsync status --dir /path/to/app --json
```

读取管理进程状态、已有会话和历史成功/失败记录。项目尚未配置时也可以查询。查询不会启动 daemon，也不会重新进行 SSH 连接验证。

默认诊断按原因分组，每组最多显示 3 个示例；`--verbose` 展示全部已记录详情。`--json` 始终提供结构化详情，无需再加 `--verbose`；引擎已省略的路径只能提供数量。

程序判断应读取 `sync.aligned`、`manager` 和 `issues`。`ok: true` 与退出码 0 只表明状态查询返回了结果；`sync.aligned: null` 表示当前无法确认是否对齐。字段说明见[CLI 输出契约](configuration.md#cli-输出契约)。

### dashboard

```bash
devsync dashboard
devsync dashboard --dir /path/to/app
devsync dashboard --json
```

列表来自用户级项目索引；成功执行 `init/config/sync/start` 会登记项目，旧项目可在面板按 `a` 添加。`--dir` 只初始选中已登记项目，列表仍包含全部项目，也不会自动登记这个目录。

交互面板需要正常终端；重定向输出或 `TERM=dumb` 时使用 `--json` 获取一次快照。JSON 查询不修改索引或开始同步。面板中 `s` 开启、`x` 停止、`c` 配置，`q` 退出；退出不停止既有后台同步。全部快捷键见[控制面板](dashboard.md)。

### Shell 补全

```bash
devsync completion zsh
devsync completion install zsh
devsync completion uninstall zsh
devsync completion --help
```

| 调用 | 含义 | 是否修改文件 |
| --- | --- | --- |
| `completion zsh` | 把当前命令和参数的 zsh 补全脚本输出到标准输出 | 否 |
| `completion install zsh` | 在 `${ZDOTDIR:-$HOME}/.zshrc` 中维护 devsync 补全区块 | 是，更新该用户的 Shell 配置 |
| `completion uninstall zsh` | 移除 devsync 管理的区块，保留其他配置 | 是，更新该用户的 Shell 配置 |

目前支持 `zsh`。上述三种调用都可附加 `--json`；生成时 JSON 包含 `shell` 和 `script`，安装/卸载结果包含 `changed`、`file`、`installed`。`completion` 不接受 `--dir`、`--yes`、`--verbose` 或 `--version`。

安装和卸载可重复执行，遵循 `ZDOTDIR`，保留已有 dotfile 符号链接。安装后新开终端生效；新终端启动时加载当前 devsync 的补全规则，因此更新源码或版本后无需重复安装。补全生成不读取项目配置，不访问 SSH，也不开始同步。

常见效果：`devsync dash<Tab>` 补全命令，`devsync status --<Tab>` 展示选项，`--dir` / `-C` 后补全目录。

### 帮助与版本

```bash
devsync
devsync help
devsync --help
devsync status --help
devsync --version
```

不传命令时显示总帮助。普通命令的 `--help` 也显示总帮助；补全单独使用 `devsync completion --help`。内部后台入口 `_worker` 及其 `--binary`、`--token` 参数由 devsync 自己管理，不作为用户调用接口。

## 配置参数应该写在哪里

CLI 选项控制本次调用。持续生效的连接、规则和下载设置分别存入配置文件：

| 想调整的内容 | 对应字段 | 配置位置与说明 |
| --- | --- | --- |
| 同步模式、目录排除、环境文件、扫描间隔 | `mode`、`exclude`、`envFiles`、`pollingInterval` | 项目 `sync.config.json`，见[公共项目规则](configuration.md#公共项目规则) |
| SSH 主机、账号、端口、远端项目目录 | `remote.host`、`remote.username`、`remote.port`、`remote.path` | 由 `init/config` 写入 `.sync/config.json`，见[个人连接配置](configuration.md#个人连接配置) |
| 当前项目的私钥路径 | `identityFile` | `.sync/config.json`；支持 macOS/Linux，也可通过 SSH config 管理 |
| 自动备份及保留数量 | `backup.mode`、`backup.keep` | `.sync/config.json`，见[备份策略](configuration.md#备份策略) |
| 下载代理、镜像或本地 Mutagen 发行包 | `downloadProxy`、`mutagenMirror`、`mutagenArchive` | 用户 `devsync/config.json`，见[用户下载配置](configuration.md#用户下载配置) |

例如 SSH 端口通过 `remote.port` 保存，CLI 没有 `--port`；扫描间隔通过 `pollingInterval` 保存，CLI 没有 `--polling-interval`。密码通过配置向导输入并保存到项目私有 `.sync/auth.json`。

## 常用环境变量

| 变量 | 用途 | 未设置时 |
| --- | --- | --- |
| `DEVSYNC_DOWNLOAD_PROXY` | Mutagen 下载代理，不配置 SSH 代理 | 依次检查用户下载配置、旧变量及通用代理设置 |
| `DEVSYNC_MUTAGEN_MIRROR` | Mutagen 发行包下载目录 | 使用用户设置、旧变量或内置官方地址 |
| `DEVSYNC_MUTAGEN_ARCHIVE` | 本地官方发行包路径；需要安装时优先复制并校验 | 通过缓存、旧项目工具或下载获取程序 |
| `HTTPS_PROXY`、`https_proxy` | 下载代理的后备设置 | 无其他代理配置时直连 |
| `XDG_CONFIG_HOME` | Linux/macOS 用户配置和项目索引的根目录，需为绝对路径 | `~/.config` |
| `XDG_CACHE_HOME` | Linux 程序缓存根目录，需为绝对路径 | `~/.cache`；macOS 固定使用 `~/Library/Caches` |
| `APPDATA`、`LOCALAPPDATA` | Windows 用户配置与程序缓存位置 | 用户 `AppData/Roaming`、`AppData/Local` |
| `ZDOTDIR` | zsh 补全安装目标 `.zshrc` 的所在目录 | 当前用户主目录 |
| `NO_COLOR=1` | 关闭颜色 | 按终端能力显示 |
| `TERM=dumb` | 使用纯文本向导和进度 | 正常终端使用交互组件 |

下载设置兼容 `SYNC_DOWNLOAD_PROXY`、`SYNC_MUTAGEN_MIRROR`、`SYNC_MUTAGEN_ARCHIVE`。完整优先级及空值行为见[用户下载配置](configuration.md#用户下载配置)。

## JSON 与退出码

支持 JSON 的命令返回单个对象。失败时通常为：

```json
{
  "ok": false,
  "error": {
    "code": "NOT_CONFIGURED",
    "message": "尚未配置同步，请执行 devsync init。"
  }
}
```

| 退出码 | 含义 |
| --- | --- |
| `0` | 命令正常返回；状态查询仍需检查结果字段 |
| `1` | 一般错误、取消确认或需要交互/同步确认 |
| `130` | 项目命令由 CLI 处理的中断 |

在项目已配置、当前差异可接受后，脚本可运行 `devsync sync --dir /path/to/app --json --yes`。需要新确认时命令会重新计算差异；一次失败也可能已完成部分传输。状态、预览和失败诊断的完整结构见[配置与接口](configuration.md#cli-输出契约)。
