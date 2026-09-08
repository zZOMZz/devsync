# 配置与接口

本文描述 0.1.0 的实际实现。接口尚未承诺跨版本稳定；修改时同步更新文档与契约测试。

## 配置归属

| 位置 | 内容 | 共享方式 |
| --- | --- | --- |
| 项目 `sync.config.json` | 目录排除、环境文件例外、轮询间隔 | 可提交业务项目 Git |
| 项目 `.sync/config.json` | 个人开发机地址、账号、端口、绝对路径 | 项目私有 |
| 项目 `.sync/auth.json` | 密码，密钥认证时为空对象 | 项目私有，POSIX 文件权限 0600 |
| 用户配置目录 `devsync/config.json` | 下载代理、镜像、本地发行包 | 同一用户共用 |
| 用户缓存目录 `project-sync/mutagen/` | 版本/平台隔离的程序与 agent 包 | 同一用户共用 |

`.sync` 目录在 POSIX 使用 0700，Windows 配置当前用户 ACL。密码目前保存在私有文件中，没有操作系统钥匙串集成。

## 公共项目规则

```json
{
  "version": 1,
  "mode": "one-way-replica",
  "exclude": [".vscode", ".idea", ".DS_Store", "node_modules", "dist"],
  "envFiles": [],
  "pollingInterval": 1
}
```

| 字段 | 当前约束 |
| --- | --- |
| `version` | 仅接受数字 1 |
| `mode` | 仅接受 `one-way-replica` |
| `exclude` | 字符串数组；显式提供时替换默认列表 |
| `envFiles` | 允许同步的具体 `.env*` 文件相对路径，默认空数组 |
| `pollingInterval` | 1–3600 的整数秒数，默认 1 |
| `$schema` | 可接受但规范化时移除；目前未提供配套 JSON Schema 文件 |

未知字段报 `INVALID_RULES`。`.sync`、`.git`、`.hg`、`.svn` 和根目录 `sync.config.json` 始终排除，即使 `exclude` 为空也不改变。

路径使用 `/`。不含 `/` 的名字匹配任何层级，含 `/` 或以 `/` 开头的规则相对于项目根目录匹配。`*` 匹配当前路径分量内的任意字符，`?` 匹配一个字符；不支持 `**`、`!`、字符组或 `..`。目录被排除后，其子项一起排除。

| 规则 | 会排除 | 不会排除 |
| --- | --- | --- |
| `cache` | `cache/a`、`src/cache/a` | `cached/a` |
| `/cache` | `cache/a` | `src/cache/a` |
| `resource/*.js` | `resource/main.js` | `resource/sub/main.js` |
| `a?.txt` | `a1.txt` | `a12.txt` |

`.env*` 默认排除，例外通过 `envFiles` 指定，例如 `[".env", "docker/.env"]`。例外不能位于被排除目录内；不支持以通配符批量允许。允许的文件也会同步删除。

规则与 `.gitignore` 独立。项目示例见 [Web/PHP](../examples/www_so_com/sync.config.json) 和 [Python](../examples/python-service/sync.config.json)。

## 个人连接配置

正常使用 `devsync init` 或 `devsync config` 生成：

```json
{
  "remote": {
    "host": "devbox",
    "username": "alice",
    "port": 22,
    "path": "/home/alice/project"
  }
}
```

主机字段支持主机名、IPv4 和 SSH 别名，目前不接受 IPv6 字面量。端口为 1–65535 的整数。远端路径必须是独占项目绝对路径，不能包含 `..` 或使用系统目录；远端还会检查权限、主目录和符号链接目标等条件。

SSH 密钥和跳板机优先通过 OpenSSH config 管理。macOS/Linux 也支持在上述配置的顶层添加 `"identityFile": "~/keys/devbox"`。绝对路径保持不变，`~/` 展开为本机用户主目录，相对路径基于项目根目录解析，与执行命令的工作目录无关。不支持空值、换行、空字符或 `~其他用户/`。路径以 OpenSSH `-i` 传递，仍保留 SSH config 和 agent 的正常行为；加密私钥请先加载到 ssh-agent。

连接探测、预览、备份与 Mutagen 的 SSH/SCP 使用一致的私钥路径和认证选项。Mutagen 使用 `.sync/ssh/` 下的私有启动脚本；`.sync/ssh.json` 记录已启用的位置。脚本不包含密码或私钥内容。后台进程复用已确认的脚本，不直接读取手工修改、尚未确认的连接配置。切换或移除私钥时，旧项目 daemon 退出后才启用新配置；旧脚本保留，不修改用户的 SSH 配置。

旧版本已使用项目 `identityFile` 的会话会要求重新预览、确认和按需备份；未使用此字段的项目保持原确认指纹。显式私钥项目在密钥/密码认证方式间切换也需重新确认，修改密码值本身不改变指纹。

Windows 暂不支持项目 `identityFile`，会返回 `SSH_IDENTITY_UNSUPPORTED`，请移除此字段并将 `IdentityFile` 写入 SSH config。Windows 的 SSH 别名、默认密钥、agent 和密码入口保持原行为；尚未完成 Windows 实机验收。

密码认证文件形式为 `{ "password": "用户输入的密码" }`，密钥认证时为 `{}`。正式配置在确认后保存；探测密码时使用临时私有文件，不把密码写入命令行参数。

## 备份策略

在 `devsync init/config` 的“备份策略”中选择，或在项目私有 `.sync/config.json` 中添加：

```json
"backup": { "mode": "auto", "keep": 3 }
```

`mode` 为 `auto`（默认）或 `off`；`keep` 为 1–100 的整数，默认 3。设置为 `off` 不创建备份，也不自动清理已有备份。这是个人项目设置，不写入公共 `sync.config.json`。

自动备份与会话重建分开判断：首次接管、切换远端目标或本地来源时，备份将被覆盖/删除的远端文件；规则扩大范围时，只备份此前排除、现在将被覆盖/删除的文件。单纯认证或轮询变更不触发备份，日常后台同步不备份。没有受影响文件时不生成空包。

确认页的 `backup` 数据包含 `enabled`、`reason`、`files`、`fileCount`、`estimatedBytes`、`mode` 和 `keep`。估算仅使用 GNU find/xargs 读取候选文件的大小元数据，不再次读取文件内容；大小为压缩前估算，符号链接计链接自身大小。无法估算时为 `null` 并标记 `estimateUnavailable`，仍需按策略备份，备份失败仍阻止同步。

交互确认可选择备份后同步、跳过本次备份直接同步或取消，默认取消。跳过只影响本次确认，不改变项目策略；`--yes` 继续按项目策略备份。API 的 `confirm(preview)` 仍支持布尔返回值，也可返回 `{ confirmed: true, skipBackup: true }` 明确跳过一次。仅返回 `skipBackup` 而没有 `confirmed: true` 不会授权同步。

新备份生成临时压缩包，校验成功后启用，再记录到 `.sync/backups.json`。同步成功后保留当前项目、当前连接目标最近 `keep` 份登记的备份。降低数量会在下一次成功同步后生效；同步失败保留备份，清理失败返回 `warnings` 并在后续成功同步时重试，不把已经完成的同步改成失败。候选路径必须属于当前项目的新格式命名空间，清理拒绝符号链接/目录替换，并先确认要保留的文件存在。

旧版本备份、未登记压缩包、其他项目或其他目标的备份不会被自动删除。`accepted.json` 中新增 `backupScope` 保存已确认的范围，`backupDecision` 记录本次选择。旧会话指纹未变时可迁移范围记录；旧记录不足且配置已变化时，会保守地按首次接管处理一次。

## 用户下载配置

Linux/macOS 默认路径为 `~/.config/devsync/config.json`，绝对路径的 `XDG_CONFIG_HOME` 可改变配置根目录。Windows 使用 `%APPDATA%/devsync/config.json`，缺省时回落到用户 `AppData/Roaming`。实际路径可从 `devsync --help` 查看。

仅支持三个可选字符串字段：

```json
{
  "downloadProxy": "http://your-proxy:8080",
  "mutagenMirror": "https://your-mirror.example/mutagen",
  "mutagenArchive": "/path/to/official-mutagen-release.tar.gz"
}
```

本地发行包存在于设置中时优先复制它，不下载。镜像目录需提供与官方发行包相同的文件名与内容，仍需通过固定 SHA-256 校验。

非空配置的有效优先级：

| 用途 | 从高到低 |
| --- | --- |
| 本地包 | `DEVSYNC_MUTAGEN_ARCHIVE` → 用户 `mutagenArchive` → `SYNC_MUTAGEN_ARCHIVE` |
| 下载目录 | `DEVSYNC_MUTAGEN_MIRROR` → 用户 `mutagenMirror` → `SYNC_MUTAGEN_MIRROR` → 官方地址 |
| 代理 | `DEVSYNC_DOWNLOAD_PROXY` → 用户 `downloadProxy` → `SYNC_DOWNLOAD_PROXY` → `HTTPS_PROXY` → `https_proxy` → 直连 |

空字符串的处理涉及服务层 `??` 与安装层 `||`，目前没有专门的“禁用继承代理”开关，不应将空值视为稳定的禁用接口。

缓存根目录：macOS 使用 `~/Library/Caches`；Linux 使用绝对路径的 `XDG_CACHE_HOME` 或 `~/.cache`；Windows 使用 `LOCALAPPDATA` 或用户 `AppData/Local`。安装器的 `cacheRoot` 参数是内部/API 测试入口，目前不是 CLI 选项。

## CLI 输出契约

`status`、`preview`、`sync`、`start` 和 `stop` 支持 `--json`，输出单个 JSON 对象。`init/config --json` 当前被拒绝。

成功查询尚未启动的项目，示例（部分兼容字段）：

```json
{
  "ok": true,
  "project": "/path/to/project",
  "configured": false,
  "state": "not-started",
  "auto": false,
  "lastRun": null
}
```

失败示例：

```json
{
  "ok": false,
  "error": {
    "code": "NOT_CONFIGURED",
    "message": "尚未配置同步，请执行 devsync init。"
  }
}
```

成功退出码为 0，一般失败为 1，CLI 处理的中断为 130。`status` 的 `ok: true` 表示状态查询已返回，不表示同步健康；例如 daemon 不可用时，仍会返回诊断结果、`ok: true` 和退出码 0。读取配置等导致整个查询无法完成的异常仍返回 `ok: false`。

状态查询的新增契约为 `statusVersion: 1`。原 `state`、`auto`、`error`、`session`、`lastRun` 等字段保留；原 `state` 枚举仍为 `not-started`、`paused`、`watching`、`attention`、`unavailable`。新调用方优先使用以下字段：

| 字段 | 含义 |
| --- | --- |
| `manager.requested` | 控制记录是否请求自动同步 |
| `manager.running` | 控制记录的 PID 是否存活；不代表文件已对齐 |
| `manager.state` | `running`、`stopping`、`stopped`、`missing`、`failed` |
| `sync.state` | `unknown`、`not-started`、`paused`、`aligned`、`disconnected`、`scanning`、`syncing`、`conflict`、`error` |
| `sync.active` | 会话是否已启用、未暂停；不表示此刻有数据传输。查询失败时为 `null` |
| `sync.aligned` | `true` 表示引擎当前报告对齐；扫描/断连/错误等为 `false`；未知、未启动、暂停时为 `null` |
| `sync.local` / `sync.remote` | `{ connected, files }`；文件数来自引擎最近快照，未提供的数据为 `null` |
| `sync.problemCount` | 文件问题和冲突总数，包含引擎省略的条目；不计网络/管理进程问题 |
| `issues` | `{ code, severity, message }` 数组，必要时附 `side`（`local/remote`）、`path` 或省略条目 `count` |
| `actions` | `{ command, reason }` 数组；在返回的 `project` 目录执行对应 `devsync` 子命令，仅提供建议，不自动执行 |

例如管理进程退出而会话仍对齐时，`manager.state` 为 `missing` 或 `stopped`，`sync.state` 为 `aligned`，`sync.active` 为 `true`，`auto` 为 `false`。单次同步执行中也可能没有后台管理进程，`SESSION_UNMANAGED` 因此是信息提示。daemon 查询失败但管理进程仍存活时，`auto` 可为 `true`，同步状态为 `unknown`，不再错误地把管理进程显示为关闭。

诊断代码包括 `SESSION_UNAVAILABLE`、`SESSION_STATE_UNKNOWN`、`MANAGER_MISSING`、`MANAGER_FAILED`、`SESSION_UNMANAGED`、`AUTH_FAILED`、`SESSION_ERROR`、`ENDPOINT_DISCONNECTED`、`FILE_SCAN`、`FILE_WRITE`、`SYNC_CONFLICT`、`SYNC_HALTED` 和 `NOT_CONFIGURED`。文件问题/冲突被引擎截断时，用相应 `_OMITTED` 代码及 `count` 标明。严重程度为 `info`、`warning`、`error`；代码供程序判断，文案可调整。

`lastRun` 仍只记录最近一次前台 `sync/start` 成功，不能充当后台最后同步时间。终端输出已明确标注此含义。状态是一次查询快照，进程检测仍基于 PID，未解决 PID 重用问题。

版本策略：版本 1 可增加字段和诊断代码，调用方应忽略未知字段、对未知代码保留展示；已有字段的类型和含义变更需升级 `statusVersion`。原始 `session` 为兼容保留的 Mutagen 数据，不属于新契约的稳定结构。

`preview` 包含 `scope`、`remoteExists`、`added`、`updated`、`deleted` 和 `auto: false`。同步成功包含 `synced`、`at`、`files`、`auto`。需要新确认时，非交互/JSON 模式返回 `CONFIRMATION_REQUIRED`，`error.details` 带预览；确认后可用 `--yes` 重试，但命令会重新计算本次差异，不绑定此前预览快照。

主要错误码包括 `USAGE`、`INTERACTION_REQUIRED`、`NOT_CONFIGURED`、`INVALID_RULES`、`INVALID_USER_CONFIG`、`INVALID_PROJECT`、`INVALID_STATE`、`PROJECT_PATH_TOO_LONG`、`CONFIRMATION_REQUIRED`、`CANCELLED`、`INTERRUPTED`、`WORKER_BUSY`、`WORKER_START_FAILED`。SSH 字段错误会转换为 `SSH_AUTH`、`SSH_HOST`、`SSH_PATH`、`SSH_CONNECTION`；未归类错误仍可能为 `SYNC_FAILED` 或原始系统错误码。

## 核心 API

公共导出以 [src/index.mjs](../src/index.mjs) 为准。仓库根目录脚本示例：

```js
import { ProjectSync, resolveProject } from './src/index.mjs';

const root = await resolveProject('/path/to/project');
const service = new ProjectSync(root, {
  onEvent(event) {
    // phase: { type, message }；backup: { type, path }
  }
});
const status = await service.status();
```

| 方法 | 作用 |
| --- | --- |
| `configure(collect, confirm)` | `collect(project, previousAuth, checks)` 返回 `{ cfg, auth }`，`confirm(scope)` 返回布尔值；已有两参数回调兼容 |
| `preview()` | 暂停并计算差异，写本地预览文件 |
| `sync({ auto, confirm })` | `confirm(preview)` 决定是否接受新的接入范围，默认不确认 |
| `stop()` | 停止当前项目后台同步 |
| `status()` | 查询状态，不自动启动 daemon |

构造参数还可提供 `stage`、`signal` 和用于测试的 `dependencies`。API 返回领域数据，CLI 再添加 `ok` 包装。API 接受 AbortSignal 并在关键节点检查；CLI 还会调用子进程取消逻辑，二者目前不能视为完整等价的取消机制。

`checks.probe(cfg, auth)` 返回 SSH 探测结果（含 `home`），`checks.checkPath(cfg, auth)` 验证目录。服务记录本次回调中成功验证的参数，提交相同配置时复用；变更目标/认证、检查失败或未调用服务检查时，保存前仍补做必要校验。记录仅在内存中存活到本次 configure 结束，取消不保存草稿。

配置确认和预览的 `scope` 新增 `authentication`（`ssh-config`、`identity-file`、`password`），指定私钥时附 `identityFile` 路径；不返回密码或私钥内容。CLI 的可视向导、序号选择和 JSON 输出均复用同一服务流程。交互操作见[终端交互](terminal.md)。
