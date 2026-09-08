# 验收记录与步骤

## 当前记录

记录日期：2026-09-08，版本 0.1.0，Mutagen 0.18.1。

| 验证 | 已知结果与证据范围 |
| --- | --- |
| 自动化回归 | 实现阶段开启真实引擎测试，64 项通过 |
| 独立安装 | 程序包安装到临时 prefix，从无 package.json 的目录调用成功 |
| 配置交互 | 已验证初始化、默认值、保存、取消、Ctrl+C 释放锁、JSON 预览 |
| 真实引擎 | 真实 Mutagen、本地临时 Web/PHP 与 Python 两个项目，传输/删除/环境文件规则和后台停止隔离通过 |
| 用户验收 | 用户收到真实开发机验收步骤后反馈“测试没问题”，按本次验收通过记录 |
| 待补记录 | 用户未单独提供测试环境、逐项结果及日志；跨平台结果需分别记录 |

不要把真实引擎的本地端点测试改写为自动化真实 SSH 测试，也不要把用户的一次反馈扩展成 Windows/Linux 全部场景已通过。

### SSH 私钥修复回归（2026-09-08）

在 macOS ARM64、Mutagen 0.18.1 上新增独立的回环 SSH 实测：非默认私钥验证成功后，旧实现的 Mutagen resume 报 `Permission denied (publickey)`。修复后，显式私钥、SCP 安装 agent、文件传输、worker 在 daemon 退出后恢复同步、密钥轮换，以及移除显式配置后的 SSH config/agent 均通过；原有双项目隔离测试也通过。

默认回归 73 项中 71 项通过，2 项真实引擎测试跳过；另外显式开启并运行了这 2 项真实引擎测试，均通过。密码认证仍由参数/askpass/子进程回归覆盖，本次未连接真实密码服务器；Linux/Windows 客户端实机结果不能由本次 macOS 验证推定。

### 状态诊断回归（2026-09-08）

在 macOS ARM64 上显式开启真实 Mutagen 和回环 SSH 测试，84 项全部通过，无跳过。覆盖扫描进度、管理进程缺失/退出/停止中、断连、认证失败、文件错误和冲突、未知引擎状态、查询失败及工具记录丢失；CLI 文本/JSON 均已验证。真实引擎确认后台管理退出时会话仍启用，且关闭 daemon 后执行 `status` 不会将它重新启动。该结果不包含 Windows/Linux 客户端实机、VPN/休眠或 PID 重用场景。

### 终端向导回归（2026-09-08）

在 macOS ARM64、Node.js 18.20.8 上开启真实 SSH/Mutagen 和 PTY 用例，99 项全部通过，无跳过。PTY 覆盖方向键选择、可编辑默认值、端口原地校验、中文路径、密码隐藏、44 列终端、NO_COLOR、TERM=dumb、Esc、Ctrl+C、SIGTERM、验证阶段中断和差异分组。正常配置的 SSH/目录检查各执行一次；修改参数、检查失败及未通过服务检查的 API 输入仍会验证。离线程序包安装通过，发布包携带锁定的交互依赖。Windows/Linux 终端实机验收尚未补齐。

### 备份策略回归（2026-09-08）

默认测试共 116 项，114 项通过，2 项真实引擎测试跳过。新增用例覆盖首次接入/目标变更、范围扩展、认证与轮询变更不备份、项目关闭和跳过一次、大小未知仍执行必要备份、降低保留数量、同步失败延期清理及清理失败重试。临时本地目录使用实际 tar 执行归档和清理，验证其他项目、旧格式和未登记文件保留，以及符号链接/目录替换和保留文件缺失时停止清理。PTY 验证备份量展示、跳过一次和默认取消。本次未连接真实开发机；大小估算的 GNU find 远端路径使用 stand-in 验证，仍需 Linux 实机验收。

## 人工验收准备

本机准备 Node.js、OpenSSH、curl、tar；远端准备 Linux、GNU find/tar、sha256sum。以下命令面向当前 macOS 环境，在独立测试目录执行：

```bash
npm install --global /Users/zzt/code/devsync
devsync --version

SYNC_ACCEPTANCE_DIR=$(mktemp -d /private/tmp/devsync-accept.XXXXXX)
cd "$SYNC_ACCEPTANCE_DIR"
mkdir -p src docker node_modules
cp /Users/zzt/code/devsync/examples/www_so_com/sync.config.json .
printf 'v1\n' > src/probe.txt
printf 'TEST_ONLY=local\n' > .env
printf 'TEST_ONLY=docker\n' > docker/.env
printf 'excluded\n' > node_modules/ignored.txt

devsync init
```

远端使用独立的测试目录，通常可沿用工具按本地临时目录名推导的路径。记录最终两个目录，后续均操作这对目录。

## 验收清单

| 场景 | 操作 | 通过标准 |
| --- | --- | --- |
| 首次配置 | 沿用 SSH 别名默认值，确认路径 | 显示本地/远端目录、删除提示及允许的环境文件 |
| 输入纠错 | 故意输入无效端口或错误密码后修正 | 只修正相应项，错误类别明确，密码不回显 |
| 配置取消 | 已有配置下执行 config，修改后选择取消 | 正式连接和凭据保持原值，同步保持暂停 |
| 中断 | 配置问题或命令执行中 Ctrl+C | 合理退出，项目锁释放，可再次执行命令 |
| 预览 | `devsync preview` | 清单与测试文件一致，远端源码不被修改，自动模式暂停 |
| 首次同步 | `devsync sync` | 普通文件及两份允许的 .env 对齐；node_modules、.sync 和规则文件不传输 |
| 覆盖、删除与备份 | 首次同步前在远端放入不同内容的 probe.txt 和 remote-only.txt | 预览显示覆盖/删除；确认后生成包含旧内容的备份并正确同步 |
| 自动同步 | start 后新增、修改和删除文件 | 在合理时间内对齐，删除也传到远端 |
| 关闭终端 | start 后关终端，改用编辑器修改 | 同步继续，重新打开终端可查询状态 |
| 网络恢复 | 断开网络/VPN，修改文件后恢复 | 恢复连接后最终对齐；持续失败时可获得错误信息 |
| 停止 | stop 后继续修改本地 | 远端不再变化 |
| 多项目 | 两个测试项目同时 start，停止其中一个 | 另一个继续工作，配置和状态独立 |
| 缓存共享 | 比较两个项目 `.sync/tool.json` | 同版本/平台程序路径相同，已有有效缓存时无需再次下载 |
| JSON | 执行 status/preview --json | 标准输出可作为单个 JSON 解析，无交互动画 |

同步结果应在远端检查实际文件内容与存在性，不能只看退出码。备份位于远端项目目录旁；验证旧内容时将它解压到独立检查目录，保持测试端点清晰。

常用执行顺序：

```bash
devsync preview
devsync sync
devsync status
devsync start
printf 'v2\n' > src/probe.txt
printf 'new\n' > src/new.txt
```

确认远端收到后删除本地 `src/new.txt`，检查远端删除。然后测试关闭终端、网络恢复和 stop。`preview` 会暂停，若还要继续测试后台模式，需要再次 `start`。

## 接入业务项目

独立测试通过后，把对应规则复制到业务项目，再执行 init 和 preview。确认业务目录、环境文件及删除清单后才进入 sync/start。

`www_so_com` 的示例仅声明规则，不包含个人主机或密码。该项目的 `vendor/` 参与同步，生成目录和开发工具目录按示例排除。Git 忽略与同步规则独立，应以 preview 为准。

## 后续验收记录模板

```text
日期与工具版本/提交：
本机系统、架构和 Node 版本：
远端系统及工具版本：
认证方式（密钥/密码/跳板机）：
测试项目类型：
验证场景及结果：
失败复现与错误码：
停止、恢复和多项目结果：
未覆盖项：
```

记录中不粘贴密码或 `.env` 内容。完成后停止所有测试项目；临时目录与备份在确认不再需要时清理，不影响正式项目。
