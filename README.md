# devsync

独立的开发目录同步 CLI。以本地源码为准，通过 SSH 同步到 Linux 开发机，支持首次差异确认、远端备份、单次同步和后台自动同步。底层使用固定版本的 Mutagen。

项目无需 Node.js 工程或 `package.json`，无需复制同步脚本。当前为本地分发的 0.1.0 版本，尚未发布到 npm。

## 文档与继续开发

新工作空间直接打开本仓库。先读[工作空间交接](docs/handoff.md)，了解当前实现、验收状态和后续优化候选。完整资料见[文档索引](docs/README.md)，涵盖架构、配置/API、开发测试和验收步骤。

## 安装

本机需要 Node.js 22+、OpenSSH（ssh/scp）、curl、tar。Node.js 仅用于运行本地 CLI，远端开发机无需安装 Node.js。下载清单支持 macOS ARM64、Linux x64/ARM64、Windows x64/ARM64。远端需要 Linux、GNU find/tar 和 sha256sum。

在 devsync 源码目录安装：

```bash
npm ci
npm install --global .
```

也可以直接使用源码运行：

```bash
node /path/to/devsync/bin/devsync.mjs --help
node /path/to/devsync/bin/devsync.mjs status --dir /path/to/project
```

分发程序包：

```bash
npm pack
npm install --global ./devsync-0.1.0.tgz
```

## 使用

```bash
cd /path/to/project
devsync init       # 引导配置，验证后确认保存
devsync preview    # 暂停当前项目自动同步，检查差异
devsync sync       # 同步一次，完成后暂停
devsync start      # 同步并开启后台自动同步
devsync status     # 查看连接、同步及读写错误
devsync stop       # 停止当前项目的自动同步
devsync config     # 修改连接配置，保持暂停
devsync dashboard  # 集中查看与管理已登记项目
```

任意命令可通过 `--dir /path/to/project` 或 `-C /path/to/project` 指定项目目录。默认使用当前目录本身，不向父目录猜测项目根目录。符号链接形式的本地项目路径会解析为真实路径。

`dashboard` 面向用户的全部已登记项目，`--dir` 仅用于初始选中项目，不会过滤列表。

初始化复用现有 `.sync/config.json` 和密码，发现 SSH 别名，并读取有效 SSH 配置中的账号与端口。支持密钥/agent 或密码认证，密码输入隐藏。默认远端路径根据实际 `$HOME` 和本地目录名推导，可修改。地址、端口、认证和目录分步验证，错误时修正对应项。确认页展示本地与远端目录、删除行为和允许同步的环境文件。

交互终端采用逐步向导：方向键选择 SSH 别名和认证方式，已有字段可直接编辑，输入错误在当前问题下修正。支持 SSH config/agent、指定私钥（macOS/Linux）和密码；确认页集中展示连接与同步范围。Esc 取消当前向导，Ctrl+C 中断操作，取消不会保存草稿配置。普通配置只做一次 SSH 验证和一次目录验证。

预览按新增、覆盖、删除分组展示，超过 15 项时提示完整清单位置。连接检查、下载、备份和同步使用统一的阶段提示；下载保留百分比和速度。`NO_COLOR=1` 关闭颜色，`TERM=dumb` 使用序号选择及纯文本进度，`--json` 保持纯 JSON。详见[终端交互](docs/terminal.md)。

SSH 私钥优先通过 SSH config 管理。macOS/Linux 也可以在私有 `.sync/config.json` 顶层设置 `identityFile`：支持绝对路径、`~/` 和相对于项目根目录的路径，连接检查、备份和 Mutagen 的 SSH/SCP 都会使用它。私钥变更需重新确认；旧版已设置此字段的项目升级后也会重新确认一次。Windows 请使用 SSH config 的 `IdentityFile`，项目内显式设置会报说明性错误。详见[个人连接配置](docs/configuration.md)。

`init` 和 `config` 验证后才保存，不下载 Mutagen、不创建远端项目目录、不启动同步。取消保留原连接配置，已有自动同步保持暂停。`preview` 为得到稳定的差异先暂停已有同步，只读取远端源码；检查结果写入本地 `.sync/preview.json`。

首次同步或规则/目标变更时，展示新增、覆盖和删除清单。默认自动备份：首次接管或切换目标时，备份将被覆盖/删除的文件；规则扩大同步范围时，仅备份新纳入范围且会被覆盖/删除的文件。单纯认证、轮询变更和日常后台同步不额外备份。需要备份时，备份失败会终止同步。

`init/config` 可选择自动备份、关闭备份或自定义保留数量（默认最近 3 份）。确认页显示本次文件数和估算原始大小，并可明确选择“跳过本次备份，直接同步”。`--yes` 按项目备份策略执行，不自动跳过备份。新备份生成并同步成功后，仅清理当前项目、当前目标登记的新格式旧备份；旧版本备份和未登记的文件保留。配置说明见[备份策略](docs/configuration.md#备份策略)。

后台模式关闭终端后继续运行，只轮询与传输变化文件。每个项目有独立的 Mutagen 数据目录和重连管理进程；停止一个项目不影响其他项目。后台模式中执行 `sync` 会立即同步并保持后台模式。重新启动电脑后执行 `start` 恢复；`status` 不会启动后台服务。

`status` 分别显示同步状态和后台重连管理状态：扫描、传输、对齐、暂停、断连及未知状态都有独立说明。查询失败不会被当成“传输已停止”；后台管理退出后，仍启用的同步会话也会明确显示。文件错误和冲突带有路径及下一步操作建议。显示的“上次命令同步成功”来自最近一次 `sync/start`，不是后台最后一次传输时间。

## 多项目控制面板

在任意目录运行 `devsync dashboard`。Ink 面板每约 3 秒刷新，已开启自动同步的项目排在前面；方向键选择项目，Enter 查看详情，`s` 开启、`x` 停止、`c` 修改配置，`q` 退出。退出面板不会停止后台同步。

旧项目首次使用时按 `a` 输入项目目录；之后 `init/config/sync/start` 成功会自动登记。索引位于用户配置目录下的 `devsync/projects.json`，只保存名称和本地路径，不保存密码。`l` 重新定位记录，`d` 只移除记录，不删除项目文件或停止同步。

需要同步确认时，面板切换到 Clack 预览/确认流程，沿用项目的备份策略；配置完成后仍保持暂停。可用 `devsync dashboard --json` 获取无界面的项目快照。更多说明见[控制面板](docs/dashboard.md)。

## 项目规则与个人信息

```text
项目/
├── sync.config.json       # 可提交 Git：同步规则
├── .gitignore             # init/config 会补充 .sync/ 排除
└── .sync/                 # 不提交 Git，不参与同步
    ├── config.json        # 个人远端地址、账号、端口和路径
    ├── auth.json          # 个人密码；密钥认证时无密码
    ├── state/             # 项目独立的 Mutagen 状态
    ├── tool.json          # 当前使用的共享程序路径
    ├── ssh.json           # 已启用的私钥传输配置位置（按需生成）
    ├── ssh/               # 项目独立 SSH/SCP 启动脚本，不含密码或私钥内容
    ├── accepted.json      # 确认记录和首次同步备份位置
    ├── backups.json       # 本项目创建并校验通过的备份记录，供保留策略使用
    ├── preview.json       # 最近的差异清单
    ├── control.json       # 后台管理进程状态
    └── last-run.json      # 最近成功同步时间
```

缺少 `sync.config.json` 时使用默认规则。显式提供 `exclude` 时替换默认排除列表；`.sync`、`.git`、`.hg`、`.svn` 和根目录 `sync.config.json` 始终排除。

```json
{
  "version": 1,
  "mode": "one-way-replica",
  "exclude": [".vscode", ".idea", ".DS_Store", "node_modules", "dist"],
  "envFiles": [],
  "pollingInterval": 1
}
```

- `mode`：第一版仅支持 `one-way-replica`。本地新增、修改和删除同步到远端；远端独有的未排除文件会删除，远端修改会覆盖。
- `exclude`：无 `/` 的名字匹配任何层级；以 `/` 开头或含 `/` 的路径从项目根目录匹配。支持 `*` 和 `?`，不跨越目录分隔符；暂不支持 `**`、`!`、字符组和 `..`。排除目录会连同子项排除。限定语法保证本地预览、远端预览和实际传输使用相同规则。
- `envFiles`：`.env*` 默认排除，只有显式列出的具体文件允许同步，例如 `[".env", "docker/.env"]`。不能放在已排除的目录内。允许后，其删除也会同步。
- `pollingInterval`：本地轮询间隔，1–3600 秒，默认 1 秒。

Git 忽略与同步规则独立，不自动读取 `.gitignore` 来决定同步文件。项目内相对符号链接会保留；不支持绝对链接或指向项目外的链接。

项目示例：

- [www_so_com](examples/www_so_com/sync.config.json)：保留源码和 `vendor/` 同步，显式允许根目录与 docker 下的两份 `.env`，排除该项目生成目录。
- [Python 服务](examples/python-service/sync.config.json)：排除虚拟环境、Python 缓存和构建目录，环境文件保持排除。

接入现有项目时，把对应示例复制为项目根目录的 `sync.config.json`，然后执行 `devsync init`。规则文件不包含个人主机、密码或公司代理。原业务项目的 npm 脚本和构建流程无需修改。

## 共享程序缓存与下载

Mutagen 程序包按用户、版本、平台共享：

```text
用户缓存目录/project-sync/mutagen/0.18.1/操作系统_架构/
├── mutagen                  # Windows 为 mutagen.exe
├── mutagen-agents.tar.gz
└── verified.json
```

macOS 缓存目录为 `~/Library/Caches`；Linux 为绝对路径的 `$XDG_CACHE_HOME` 或 `~/.cache`；Windows 为 `%LOCALAPPDATA%`。保留原工具的缓存位置，便于直接复用。

跨项目并发安装由下载锁串行处理，只有一个进程下载。同版本同平台只下载一份，其他版本互不影响。新下载校验固定发行包 SHA-256、程序版本和 agent 压缩包，完成后原子启用；每次读取缓存比对程序及 agent 的 SHA-256 记录。

自动复用项目内 `.sync/tools/mutagen-版本-平台/`。原安装器已校验发行包，迁移时复制后再次验证版本和 agent 包完整性，生成文件校验记录；不删除旧路径，以免影响仍在运行的旧进程。现有 `.sync` 连接与凭据直接沿用，新规则仍需重新确认。

默认直连官方 GitHub Release，可使用 `HTTPS_PROXY`，或设置用户配置（具体路径见 `devsync --help`）：

```json
{
  "downloadProxy": "http://your-proxy:8080",
  "mutagenMirror": "https://your-mirror.example/mutagen"
}
```

支持 `downloadProxy`、`mutagenMirror`、`mutagenArchive` 三个可选字段。Linux/macOS 用户配置默认位于 `~/.config/devsync/config.json`，可通过绝对路径的 `XDG_CONFIG_HOME` 改变；Windows 使用 `%APPDATA%/devsync/config.json`。

以下环境变量优先于用户配置：

```bash
DEVSYNC_DOWNLOAD_PROXY=http://your-proxy:8080 devsync sync
DEVSYNC_MUTAGEN_ARCHIVE=/path/to/mutagen_darwin_arm64_v0.18.1.tar.gz devsync sync
```

同时支持 `DEVSYNC_MUTAGEN_MIRROR`，兼容旧 `SYNC_*` 对应变量。代理失败后尝试直连；连接超时 20 秒，传输不断流时不限制总时长，连续 120 秒低于 1 KB/s 判定停滞。交互终端显示下载进度，JSON 模式保持输出纯 JSON。

## 自动化与编辑器集成

```bash
devsync status --json
devsync preview --json
devsync sync --json --yes
```

返回一份 JSON；失败返回非零退出码和 `{ "ok": false, "error": { "code": "...", "message": "..." } }`。需要确认时返回 `CONFIRMATION_REQUIRED`，其中 `details` 包含预览。JSON 模式不输出交互提示或动画。

状态查询新增 `statusVersion: 1`、`manager`、`sync`、`issues` 和 `actions`，保留原 `state`、`auto`、`session` 等字段。`ok: true` 仅表示查询已完成；请用 `sync.aligned` 判断是否确认对齐，`null` 表示未知。字段与兼容策略见[状态输出契约](docs/configuration.md#cli-输出契约)。

未来 VS Code 插件可调用 CLI，也可以调用包导出的 `ProjectSync`、`resolveProject`、`loadProject`、`normalizeRules` 和 `SyncError`。核心 API 接收项目路径、事件回调、确认回调和可选 AbortSignal，不读取终端输入。CLI 负责参数解析、配置向导与输出，Mutagen 负责实际传输，后台管理进程负责密码重连。

## 故障处理与范围

- 地址解析/连接失败：检查网络、VPN、SSH 别名、账号和端口。密码错误与密钥认证失败分别提示，执行 `devsync config` 修正。
- 下载失败：检查代理、镜像或使用本地官方程序包；与远端登录认证无关。校验失败的包不会启用。
- 目录检查失败：目标必须是独占项目目录，具有读写和进入权限，父目录可写以创建目录或保存备份。目标根目录不能是符号链接，也不能是用户主目录或系统目录。
- 项目路径过长：POSIX 系统的后台通信路径有长度限制，工具会提示将项目放到更短的绝对路径下。
- 备份恢复：先 `devsync stop`，从 `.sync/backups.json` 查到远端备份路径，将压缩包解压到独立目录核对后恢复。新包名包含项目标识、时间和随机标识；旧版 `项目目录.sync-backup-时间.tar.gz` 仍可手动恢复。备份仅覆盖对应接入或范围扩展时选中的文件，不是完整项目快照。

第一版支持本机到 Linux 开发机的单向同步。实现阶段已在 macOS ARM64 完成本地安装与真实 Mutagen 测试；2026-09-08 用户反馈“测试没问题”。验证范围及后续记录见[验收文档](docs/acceptance.md)，Windows/Linux 客户端仍需分别补齐环境记录。

## 开发与测试

源码运行前安装锁定依赖。配置向导使用 `@clack/prompts`，控制面板使用 Ink 7 和 React 19，本地运行要求 Node.js 22+；`npm pack` 会携带交互依赖及其传递依赖，生成的 `.tgz` 可以离线安装：

```bash
npm ci
npm test
DEVSYNC_TEST_MUTAGEN=/absolute/path/to/mutagen npm run test:engine
```

默认测试覆盖配置向导、草稿凭据、规则一致性、并发下载与迁移、备份/确认顺序、JSON 输出和隔离安装。真实引擎测试使用临时本地目录，不访问开发机；同时运行 Web/PHP 和 Python 两个项目，检查文件传输、删除、环境文件策略与项目间停止隔离。
