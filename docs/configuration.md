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

SSH 密钥和跳板机优先通过 OpenSSH config 管理。现有代码还识别顶层 `identityFile`，但它在探测与 Mutagen 传输中的使用尚未统一，见[优化候选](roadmap.md)，暂不把它作为推荐配置入口。

密码认证文件形式为 `{ "password": "用户输入的密码" }`，密钥认证时为 `{}`。正式配置在确认后保存；探测密码时使用临时私有文件，不把密码写入命令行参数。

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

成功查询尚未启动的项目，示例：

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

成功退出码为 0，一般失败为 1，CLI 处理的中断为 130。`status` 的 `ok: true` 表示查询成功，不表示同步健康；还需要检查 `state`、`error`、`session`。状态枚举目前有 `not-started`、`paused`、`watching`、`attention`、`unavailable`。

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
| `configure(collect, confirm)` | `collect(project, previousAuth)` 返回 `{ cfg, auth }`，`confirm(scope)` 返回布尔值 |
| `preview()` | 暂停并计算差异，写本地预览文件 |
| `sync({ auto, confirm })` | `confirm(preview)` 决定是否接受新的接入范围，默认不确认 |
| `stop()` | 停止当前项目后台同步 |
| `status()` | 查询状态，不自动启动 daemon |

构造参数还可提供 `stage`、`signal` 和用于测试的 `dependencies`。API 返回领域数据，CLI 再添加 `ok` 包装。API 接受 AbortSignal 并在关键节点检查；CLI 还会调用子进程取消逻辑，二者目前不能视为完整等价的取消机制。
