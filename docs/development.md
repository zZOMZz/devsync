# 开发与测试

## 开始工作

独立仓库目录为 `/Users/zzt/code/devsync`。先阅读[交接说明](handoff.md)，再检查当前状态：

```bash
cd /Users/zzt/code/devsync
git status --short
git branch --show-current
node --version
node bin/devsync.mjs --help
```

0.1.0 使用 Node.js ESM，没有 npm 运行时依赖，无构建步骤。Node 版本要求以 `package.json` 的 `engines` 为准，当前为 `>=18`。改变运行时范围前应同步更新安装说明和测试矩阵。

源码直接运行：

```bash
node bin/devsync.mjs status --dir /path/to/test-project --json
```

仓库没有配置 lint、format、CI 或远端发布工作流，不把不存在的命令当成必需检查。

## 测试选择

```bash
npm test
```

实现阶段的测试总数为 64。默认未设置真实程序路径时，引擎测试会跳过；其余测试覆盖配置、规则、缓存、服务编排、JSON 和程序包安装。在 Windows 上还有平台限定测试会跳过，应以运行报告为准。

选择具体测试时：

```bash
node --test test/rules.test.mjs test/service.test.mjs
node --test test/cache.test.mjs
node --test test/cli.test.mjs
```

| 测试文件 | 主要覆盖 |
| --- | --- |
| [cache.test.mjs](../test/cache.test.mjs) | 多进程只下载一次、迁移、损坏缓存、版本隔离、锁 |
| [configure.test.mjs](../test/configure.test.mjs) | 分项重试、SSH 默认值、路径权限和草稿密码 |
| [core.test.mjs](../test/core.test.mjs) | 通用校验、差异、进度、子进程、符号链接 |
| [rules.test.mjs](../test/rules.test.mjs) | 不同项目规则、本地/远端筛选一致性、确认指纹 |
| [service.test.mjs](../test/service.test.mjs) | 确认与备份顺序、取消、状态、锁及重复启动 |
| [cli.test.mjs](../test/cli.test.mjs) | 参数、工作目录、JSON、npm 打包和隔离安装 |
| [engine.test.mjs](../test/engine.test.mjs) | 真实 Mutagen 双项目传输和后台停止隔离 |

真实引擎测试：

```bash
DEVSYNC_TEST_MUTAGEN=/absolute/path/to/mutagen npm run test:engine
DEVSYNC_TEST_MUTAGEN=/absolute/path/to/mutagen npm test
```

测试程序路径必须是可执行的真实 Mutagen 文件，通常可以从一个测试项目的 `.sync/tool.json` 中找到。测试使用临时本地端点和独立数据目录，不连接真实开发机。结束时停止管理进程、结束会话并关闭测试 daemon。macOS 使用短的临时路径以避免 Unix socket 长度限制。

CLI 程序包测试使用临时 npm cache 和临时安装 prefix，不修改用户全局安装。远端 GNU find 的规则在支持的平台上通过等价 ERE 筛选表达式测试；这不替代真实 SSH、远端权限和系统兼容性验收。

## 按改动选择验证

| 改动 | 至少应验证 |
| --- | --- |
| 规则或 `.env` 策略 | 规则一致性测试、服务指纹测试、真实引擎传输 |
| 备份与确认流程 | 服务异常路径、取消/备份失败、测试远端人工验收 |
| 缓存或锁 | 同进程与跨进程争用、损坏包、中断后重试、版本共存 |
| 后台管理 | 重复 start、关闭终端、stop、密码失败、双项目隔离 |
| CLI 参数或 JSON | 参数失败、纯 JSON、非交互确认、程序包安装 |
| 文档 | 相对链接、命令和配置与源码一致；README 引用的文档包含在包内 |

围绕变更运行必要检查。已经通过且代码未变时，不需要为了增加次数重复运行全部测试。遇到失败先判断是产品缺陷、环境约束还是测试设置问题，并保留证据。

## 分发验证

当前本地安装方式：

```bash
npm install --global .
```

检查打包清单：

```bash
npm pack --dry-run --json --ignore-scripts
```

实际打包：

```bash
npm pack --ignore-scripts
npm install --global ./devsync-0.1.0.tgz
```

`files` 白名单包含入口、源码、示例、文档和 README；测试、个人配置和后台状态不应出现在发行包内。`private: true` 仍保留，本地打包与安装不代表已发布到 npm。

## 开发边界

- 从 `ProjectSync` 组织行为，让终端文案和提问留在 CLI/向导层。
- 项目特有目录放入示例或业务配置；公司代理放入用户配置。
- 修改配置结构时明确迁移路径；修改 JSON 字段时同时考虑未来调用方。
- 新增排除语法需验证本地清单、远端清单、真实传输三者一致。
- 命令返回成功后仍需核对文件结果；单纯 daemon 存活不是同步完成。
- 人工测试使用独立项目和独立远端目录；详细步骤见[验收文档](acceptance.md)。

## 变更交付信息

每次功能优化记录具体问题、结果变化、运行的测试、尚未验证的平台或场景，以及配置/接口兼容影响。需要发布时再确定包名和版本策略；本地实现完成不自动意味着发布或提交到业务项目。
