# 桌面使用、备份与原生构建

本页描述当前源码的使用方式和已知限制，不代表当前工作树已通过检查、真实供应商账号验收或生产部署。历史计划和本机验收原件保留在本地，不作为公开安装依赖。

桌面复用现有 Web，通过独立 Node **24.21.0** 启动 PM、Worker、Agent 和同源网关，并管理私有 PostgreSQL **16.15**。安装后的本地模式不依赖用户预装 Docker、Node 或 PostgreSQL；Git、Provider CLI、账号和外部集成仍按对应能力显式配置。远程模式连接已有 HTTPS 服务，HTTP 仅允许显式回环地址。

| 构建目标 | 产物 | 边界 |
| --- | --- | --- |
| Windows x64 | NSIS `.exe` | 不提供 Windows ARM64 或跨平台构建 |
| macOS Apple Silicon | `.dmg`、`.zip` | arm64；最低 macOS 15 |
| macOS Intel | `.dmg`、`.zip` | x64；最低 macOS 15 |

这是交付目标，不是原生验收结论。原生安装验收必须在对应平台执行；Windows/macOS 安装、卸载、签名、公证、原生 ACL 与进程监督仍需相应平台验证。Linux 仅用于隔离冒烟，不发布 Linux 安装包。

**首次使用与数据**

- 选择 Local，输入首次账号、密码及工作区名称；默认数据位于 Electron 用户数据目录 `PM Agent v4/workspace`，默认项目父目录由应用创建。自定义项目父目录必须已存在。不会读取开发实例的 `.env`、`.local/access.json`，也不会自动导入 v3/v4 开发数据库或复制全局 CLI 凭据。
- PostgreSQL 凭据、实例身份、存储绑定与服务端状态保存在私有实例目录；账号初始密码不写入连接配置。Windows 使用当前用户 ACL，Unix 使用私有权限。目录必须是本地规范路径；不能用符号链接、目录联接或无法确认身份的目录替代。
- 公共 origin 保持稳定；被占用时拒绝接管，不改 origin 绕过冲突。仅停止本次拥有的进程；数据库正常关机允许完成检查点，超时保留所有权并显示错误，不把它伪报为已退出。PostgreSQL 大版本不会自动升级。
- 同一实例和 origin 复用浏览器持久化分区，断开不会清空客户端日志。会话与持久化仍暂沿用 Agent Chat，**尚未经过统一设计收口**；不得把 Run 成功或恢复成功解释为业务工作项完成。

**备份与恢复**

连接窗口仅在本地服务停止后允许备份/恢复。备份包含 PostgreSQL 逻辑快照、登记项目的 `.pm` 核心文件、附件、应用拥有的聊天文件，以及显式包含私密数据的 Agent 离线备份；选择前会提示其包含凭据和会话。备份不加密，必须安全保存。恢复仅写入新的空实例目录，重新绑定存储及实例身份，不覆盖已有实例。目前仅接受相同操作系统的备份。

不复制项目的完整外部源码树、外部文档目录、原生外部 Provider Home、浏览器 Cookie/localStorage 或尚未确认的客户端操作日志。恢复后外部文件区域/文档来源需重新关联，Provider 账号按原生策略重新核对，MCP 授权需重新批准；未知副作用先查询。Linux 保留描述符相对遍历及目录 fsync；macOS/Windows 使用路径、身份、链接及内容校验，不承诺对恶意同用户进程的等价文件系统沙箱。Node 无法刷新 Windows 目录句柄，不能保证目录元数据在突然断电时的持久性。

**原生构建**

在对应 OS/CPU 的独立构建检出中使用 Node 24.21.0、pnpm 11.9.0：

```sh
node scripts/doctor.mjs
pnpm install --frozen-lockfile
pnpm --filter @agent-workspace/desktop runtime:prepare
pnpm --filter @agent-workspace/desktop package
```

运行时下载固定版本并校验归档及文件清单，保留完整 PostgreSQL 客户端、库、share 与许可证；不在应用启动时下载。代理环境需要为 Node 设置 `NODE_USE_ENV_PROXY=1`。开发调试另需 `pnpm --filter @agent-workspace/desktop runtime:install`，再执行 `pnpm build:v4 && pnpm build:desktop` 和 `pnpm --filter @agent-workspace/desktop start`；Electron 安装脚本不会在依赖安装时自动执行。

`package` 明确生成 unsigned 测试包；macOS ad-hoc 不等于 Developer ID 签名或公证。正式构建用 `package:signed`，需显式提供证书及 macOS 公证材料，缺失时失败而不降级。默认输出 `apps/desktop/releases/<version>/<platform>-<arch>/<unsigned|signed>/`，`desktop-package.json` 记录产物 SHA256 与资源位置。没有自动更新源，也不自动发布 GitHub Release。

[原生 CI](../../.github/workflows/desktop.yml) 仅手动触发，分别运行 Windows x64、macOS x64/arm64，执行真实 PG 回归和打包资源的初始化、登录、停止与重连冒烟；signed 模式使用受保护的 `desktop-signing` 环境。工作流配置和历史通过不代表最新工作树、原生GUI或真实Provider执行已验收。

CI 在桌面类型检查前依次构建 `@agent-workspace/contracts` 与 `@agent-workspace/client-runtime`，生成包导出的类型声明；全新检出不能依赖开发机已有的 `dist` 缓存。[`.gitattributes`](../../.gitattributes) 固定文本检出的 LF 行尾，避免 Windows `core.autocrlf` 改变受固定哈希保护的构建输入；不放宽或重写完整性校验。完整 Web 类型检查超出托管 macOS 默认堆上限，工作流显式设置 `NODE_OPTIONS=--max-old-space-size=4096`，保留全部类型检查。

Actions 只缓存 pnpm 内容仓与 `apps/desktop/.cache/runtime-downloads` 下载归档，signed/unsigned 分离，不缓存应用产物、已安装运行时、私有 Home 或签名材料。缓存命中后仍执行冻结安装、归档 SHA256/官方 Node checksum 校验、重新解压和 runtime smoke，以及全部原生测试、打包和成品冒烟。比较构建耗时必须记录真实 run/attempt、提交、OS/架构、runner image 与缓存命中状态；没有运行结果时不能宣称提速或发布通过，见 [CI 耗时记录](../reference/ci-performance-2026-11-06.zh.md)。

Windows 权限、reparse 检查和进程监督脚本显式加载系统 PowerShell 模块，不依赖 runner 的模块分析缓存或完整用户环境。打包 staging 目录创建后转为真实路径，兼容 macOS 的 `/var` 临时目录别名，同时保留产物目录的符号链接拒绝规则。

Windows reparse 属性及时间戳来自不跟随链接的原生句柄，并与 Node 看到的卷号/文件 ID 绑定；目录成员变动不冒充目录替换，时间戳变化仍使缓存失效。辅助编译使用独立私有临时目录，避免自身写入使公共 Temp 祖先的缓存持续失效。递归建目录后的持久化遍历同时规范普通路径和 Windows 扩展长度路径，不在卷根无限循环。

Windows 使用随包 `pg_ctl` 创建 PostgreSQL 的受限令牌进程，兼容以管理员令牌运行的宿主；通过数据库身份校验、实际 PID 与持久认证连接监督服务器，关机仍执行可重试的正常停止。版本检查在输出管道关闭后读取完整结果，不把进程 `exit` 当作输出已收齐；无需输出的控制命令不建立捕获管道，避免后台服务继承管道阻塞完成。

macOS 签名工具使用[固定补丁](../../patches/@electron__osx-sign@1.3.3.patch)：只遍历真实文件、跳过符号链接并顺序检查二进制，避免依赖别名循环及大资源树的 `EMFILE`。

## 验收证据边界

提交 `a063dc0` 的原生桌面 CI 历史通过仅覆盖该次提交及该工作流执行范围，不代表最新工作树、正式签名、公证、真实设备安装卸载或 Electron GUI 业务验收通过。unsigned 包和 ad-hoc 签名不能作为正式发布凭据。原生构建工具先按[开发指南](development.md)准备，外部 Provider/账号仍须逐项验收。
