# 桌面使用、备份与原生构建

本页描述当前源码的使用方式和已知限制，不代表当前工作树已通过检查、真实供应商账号验收或生产部署。历史计划和本机验收原件保留在本地，不作为公开安装依赖。

桌面复用现有 Web，通过独立 Node **24.21.0** 启动 PM、Worker、Agent 和同源网关，并管理私有 PostgreSQL **16.15**。安装后的本地模式不依赖用户预装 Docker、Node 或 PostgreSQL；Git、Provider CLI、账号和外部集成仍按对应能力显式配置。远程模式连接已有 HTTPS 服务，HTTP 仅允许显式回环地址。

Claude CLI 由用户在服务所在机器安装并在 Provider 的 Runtime binary 配置（默认 `claude`）；缺失或路径错误不会改用内置 Claude。Agent、桌面 workspace runtime、Electron 应用的独立部署闭包与容器交付均排除 Claude SDK 平台 CLI 包，保留通信 SDK 全部资源。SDK 不等于 CLI：Cursor 当前仍使用本地 Agent SDK 引擎及其必要原生工具，SQLite / PTY 等依赖也不因本次修复被删除。Codex / Antigravity managed 与 ACP Registry 的原生安装流程保持既有语义，详见 [Provider 指南](agent-chat.md#配置并使用-provider)。

桌面打包将 **PM、Agent、Electron 三个生产依赖闭包分别物化为真实、独立的 `node_modules`**，使用已锁定 electron-builder 的 hoister；不跨闭包共用包、不引入运行时 loader，也不升级依赖。相同源码身份可提升到祖先目录，版本冲突、peer 上下文及解析路径确有需要的实例仍保留；Agent 必须只有一个物理 Effect **4.0.5** 实例。包自有 SDK、原生二进制、许可证和嵌套 fixture/template 资源保留，原有 PM `jp` / `yaml` 命令入口也保留，不按文件 hash 或 tests/source-map 名称泛删资源。

`desktop-dependency-layout.json` 分别记录 workspace-runtime 的 PM/Agent 上下文和 Electron 应用上下文，包括实际包路径、资源摘要、依赖边与缺席的 optional 依赖。`agent-artifact-manifest.json` 中原始 `.packages`/links 清单仅为来源证明，不再代表桌面成品的物理目录；最终布局以新的 layout manifest 及实际资源核对为准。通用 Agent 独立打包拓扑不因此改变。

| 构建目标 | 产物 | 边界 |
| --- | --- | --- |
| Windows x64 | NSIS `.exe` | 不提供 Windows ARM64 或跨平台构建 |
| macOS Apple Silicon | `.dmg`、`.zip` | arm64；最低 macOS 15 |
| macOS Intel | `.dmg`、`.zip` | x64；最低 macOS 15 |

这是交付目标，不是原生验收结论。原生安装验收必须在对应平台执行；Windows/macOS 安装、卸载、签名、公证、原生 ACL 与进程监督仍需相应平台验证。Linux 仅用于隔离冒烟，不发布 Linux 安装包。

**首次使用与数据**

- 连接入口采用 Dovspace 中文三步引导：选择方式 → 设置连接 → 进入工作台。「继续」只切换页面，不会启动服务；已有连接可通过「更改连接」调整，也可「返回当前连接」打开工作台或断开服务。
- 选择「本地工作台」后，首次使用全新空目录时勾选「创建首次账号与工作区」，填写姓名、邮箱、密码与工作区名称；连接已有工作台时不勾选，进入 PM 后登录。账号创建建议来自桌面服务状态，不把服务不可用视为空实例；切换步骤或进入数据管理会清空尚未提交的密码。
- 数据目录与项目父目录位于默认折叠的「高级设置」；必填目录无效时会自动展开并定位输入。默认数据仍位于 Electron 用户数据目录 `PM Agent v4/workspace`，视觉品牌更新不迁移数据或更改应用标识。默认项目父目录由应用创建，自定义项目父目录必须已存在。不会读取开发实例的 `.env`、`.local/access.json`，也不会自动导入 v3/v4 开发数据库或复制全局 CLI 凭据。
- 首次建号及登录后新建工作区都会写入内置 Nova 示例项目；它是脱敏模板的独立副本，不是连接或复制开发数据库。每个新工作区包含真实可编辑项目、任务、文档与规划对象，保留固定示例日期、负责人留空，不复制其他实例的用户、权限、评论或执行历史。已存在工作区及删除后的示例不会自动补种。初始化未完成时保留原身份和恢复记录，不宣称连接／创建成功。
- 选择「远程服务」后只需填写服务地址，并在该服务自己的页面登录；回环地址之外必须使用 HTTPS。连接状态使用中文提示，原始服务消息与安全错误保留在诊断中；失败后若本地服务仍在运行，会保留断开操作，不显示为连接成功。
- PostgreSQL 凭据、实例身份、存储绑定与服务端状态保存在私有实例目录；账号初始密码不写入连接配置。Windows 使用当前用户 ACL，Unix 使用私有权限。目录必须是本地规范路径；不能用符号链接、目录联接或无法确认身份的目录替代。
- 公共 origin 保持稳定；被占用时拒绝接管，不改 origin 绕过冲突。仅停止本次拥有的进程；数据库正常关机允许完成检查点，超时保留所有权并显示错误，不把它伪报为已退出。PostgreSQL 大版本不会自动升级。
- 同一实例和 origin 复用浏览器持久化分区，断开不会清空客户端日志。会话与持久化仍暂沿用 Agent Chat，**尚未经过统一设计收口**；不得把 Run 成功或恢复成功解释为业务工作项完成。
- Agent Chat 本地工作区可用原生“选择文件夹”；远程连接只浏览服务端目录，不弹出本机目录冒充远程路径。桌面启动 Agent 时显式传入用户 Home、受管项目目录与配置项目父目录作为允许根；其他路径仍需操作者配置，选择按钮不扩大服务端授权。
- 新安装的 Codex／Claude 卡片未启用且不代表已认证；启用、原生检查、模型选择分别进行。已有配置保留。Codex 重连仍核验本次操作确认的原生 Home；同目录路径别名必须由文件系统身份确认，不跳过不同 Home 或目录替换检查。

**备份与恢复**

通过连接窗口底部的「管理本地数据」进入独立管理页面，使用「返回连接」回到引导。仅在连接已断开、本地服务停止后允许备份/恢复；维护期间禁用切换与重复操作，结果和错误留在管理页供核对。恢复成功后仍需手动连接，不自动进入工作台。

备份包含 PostgreSQL 逻辑快照、登记项目的 `.pm` 核心文件、附件、应用拥有的聊天文件，以及显式包含私密数据的 Agent 离线备份；选择前会提示其包含凭据和会话。备份不加密，必须安全保存。恢复仅写入新的空实例目录，重新绑定存储及实例身份，不覆盖已有实例。目前仅接受相同操作系统的备份。

不复制项目的完整外部源码树、外部文档目录、原生外部 Provider Home、浏览器 Cookie/localStorage 或尚未确认的客户端操作日志。恢复后外部文件区域/文档来源需重新关联，Provider 账号按原生策略重新核对，MCP 授权需重新批准；未知副作用先查询。Linux 保留描述符相对遍历及目录 fsync；macOS/Windows 使用路径、身份、链接及内容校验，不承诺对恶意同用户进程的等价文件系统沙箱。Node 无法刷新 Windows 目录句柄，不能保证目录元数据在突然断电时的持久性。

**原生构建**

在对应 OS/CPU 的**独立原生构建检出**中使用 Node 24.21.0、pnpm 11.9.0，并先准备[开发工具链](development.md)。`package` 会重建 Agent、Web 和 desktop 输出；不能在正被服务使用的检出中运行，以免覆盖其产物。

成品门禁还要求**全功能 7-Zip**：Windows 优先查找 `%ProgramFiles%\7-Zip\7z.exe`、`%ProgramFiles(x86)%\7-Zip\7z.exe`，否则使用 PATH 上的 `7z`；必须支持 NSIS、7z 和 ZIP，electron-builder 的独立 `7za` 不能替代。macOS 需要 PATH 上的全功能 `7z`（ZIP 解压前列举/检查）、系统 `/usr/bin/hdiutil`（只读挂载 DMG）、`/usr/bin/ditto`（解压 ZIP）与 `/usr/bin/codesign`（包括 ad-hoc 的最终 bundle/原生文件验签）。记录实际工具路径、版本和支持格式；镜像清单或工具文件存在不等于本次可执行检查已通过。缺失前提即停止，不自动安装工具、下载新 toolset 或绕过成品检查。

```sh
node scripts/doctor.mjs
pnpm install --frozen-lockfile
pnpm --filter @agent-workspace/desktop runtime:prepare
pnpm --filter @agent-workspace/desktop package
```

运行时下载固定版本并校验归档及文件清单，保留完整 PostgreSQL 客户端、库、share 与许可证；不在应用启动时下载。代理环境需要为 Node 设置 `NODE_USE_ENV_PROXY=1`。开发调试另需 `pnpm --filter @agent-workspace/desktop runtime:install`，再执行 `pnpm build:v4 && pnpm build:desktop` 和 `pnpm --filter @agent-workspace/desktop start`；Electron 安装脚本不会在依赖安装时自动执行。

`package` 明确生成 unsigned 测试包；macOS ad-hoc 不等于 Developer ID 签名或公证。`package:signed` 是独立显式模式，需提供证书及 macOS 公证材料，缺失时失败而不降级；本轮没有选择或配置签名。默认输出 `apps/desktop/releases/<version>/<platform>-<arch>/<unsigned|signed>/`，`desktop-package.json` 记录完整 Git commit、公开源码内容摘要/dirty 身份、实际版本、runtime 来源、产物与材料 SHA256/bytes。源码、许可材料存在不表示正式发布获准；没有自动更新源，也不自动发布 GitHub Release。

每组交付包含安装器、`desktop-package.json`、`desktop-verification.json`、`SHA256SUMS`、`desktop-source.tar.gz`、`desktop-source.json`、`desktop-legal.tar.gz`，以及 manifest 明确列出的辅助产物。对应源码保留已审阅本地改动、构建脚本及根 `turbo.json`；Git 与已审阅的 gitless 快照均将该配置的准确字节纳入清单和源码归档，构建后修改或删除会使源码复核失败。不含 `.env*`、`.local`、Home/凭据、内部历史计划、依赖缓存或旧产物。legal 材料来自最终成品，包括 runtime/Electron/Chromium 的原始许可；它是材料收集而不是第三方分发授权。具体上游 stable/nightly 实际 assets、采用/不采用理由、授权及回滚边界见 [发布设计](../reference/desktop-release-alignment-2026-11-08.zh.md)。

`package` 不只检查 sibling unpacked tree：完成构建后必须重新检查**本次最终发行文件**。Windows 从准确 `.exe` 中读取 `$PLUGINSDIR/app-64.7z` 再展开；macOS 分别检查本次 DMG 的只读挂载及 ZIP 解压所得 `.app`。门禁拒绝危险归档路径/链接、递归依赖展开、缺失或额外包/资源、错误依赖/peer 绑定、意外启用的 optional 依赖和 Effect 多实例。原生签名仅允许签名前按 magic 记录的 Mach-O 在原生验签后改变，JS、许可证及其他依赖/runtime 资源仍须逐字节匹配，不存在宽泛二进制 hash 豁免。

`desktop-verification.json` 的 `checks.finalArtifacts` 将每份发行文件的 SHA256/bytes 与内部 NSIS payload 摘要、`tree` 文件数/逻辑字节/链接数、`resourcesTree` 精确资源树摘要及依赖/runtime 检查绑定；依赖上下文另列物理实例数、资源数/逻辑字节和必要重复实例。逻辑字节不是文件系统实际占用量，归档展开不是安装后测量；没有本次原生包及已安装目录的实测，不宣称新的安装器或安装体积达标。

打包后的 `nativeSmoke` 仍为 `not-run`。在匹配的原生 runner、保留本次源码及已构建 desktop controller 的检出中执行：

```sh
node apps/desktop/scripts/verify-delivery.mjs --output ABS_PACKAGE_DIR --native-smoke --stage ABS_NEW_UPLOAD_DIR
```

此命令重验全部最终发行文件，并从第一份已核验发行文件的**最终提取资源**执行 bundled runtime/managed-instance 冒烟，不再从 `win-unpacked` 取资源。它检查原生依赖加载、Effect 运行时身份、隔离实例初始化/登录/正常停止/重连，并刷新报告和 checksums；managed-instance 控制器仍来自当前检出的 `apps/desktop/dist`，**不执行安装后 Electron `app.asar` 内的 controller 或 GUI**。报告 `nativeSmoke.scope=final-distributable-payload`，`installationExecuted` / `electronGuiExecuted` 均为 `false`；成功不是安装、升级、卸载、GUI 或真实 Provider 账号验收。

已有经单独授权安装/复制得到的资源目录时，可改用 `--native-smoke --installed-resources ABS_RESOURCES`，例如 Windows 的安装根 `resources`、macOS 的 `.app/Contents/Resources`。该选项先重验本次完整发行集，再将所供资源的应用检查及**整个 resources 树的精确摘要**绑定到当前第一份发行文件 SHA256/bytes，然后在该树执行同样的冒烟，报告 `installedTree` 与 `nativeSmoke.scope=supplied-installed-tree`。它不运行安装器，不比较 resources 之外的快捷方式/注册表/整个 Electron 安装目录，也不证明该目录来自真实安装或执行过 GUI。不能脱离 `--native-smoke` 使用，也不能与 `--files-only` 合用。

接收端可用 `node apps/desktop/scripts/verify-delivery.mjs --output ABS_DOWNLOADED_DIR --files-only` 核对完整材料清单、bytes/hash、源码身份和 `SHA256SUMS`；该模式不展开资源、不重跑 native smoke，不把旧报告升级为当前检查。`--stage` 只接受已绑定本次最终发行文件的成功 native-smoke 报告，并复制/复核精确材料集；所有路径须换成本次拥有的真实绝对目录，上传 staging 必须是与输出不重叠的新目录。

[原生 CI](../../.github/workflows/desktop.yml) 仅手动触发，默认 `distribution=unsigned`、`windows_only=true`，只运行 Windows x64；明确取消 Windows-only 才运行现有 macOS x64/arm64 目标。执行真实 PG 回归及最终 payload 冒烟后，只上传从完整 manifest 校验并精确暂存的发行材料，不通配上传 unpacked tree 或临时日志；signed 模式仍使用受保护的 `desktop-signing` 环境。操作与失败恢复见 [Windows 构建手册](../reference/windows-build-runbook.zh.md)。**2026-11-08 操作者进一步明确以当前主分支为准，保留既有修复与性能优化，将所有当前可公开源码更新的审阅增量集成到本地主分支并在该源码上测试；包括桌面、PM／Agent／Web、Turbo 与根 manifest／lock 等更新，不以旧候选覆盖主目录。测试输出隔离，有实际问题先修复并复验；完整范围审阅和主分支必要门禁通过后冻结精确源码，提交并公开推送到 `main`，随后只手动触发一次 `distribution=unsigned`、`windows_only=true` 的 Actions 构建，以该 SHA 的 Windows 实际 `success` 为目标。不下载安装器或发行材料到本地，原下载授权仍已被覆盖；凭据、运行数据、依赖缓存与旧产物不进入发布集。** 这不是动作已执行或原生验收通过的证据；本轮仍未授权 macOS 构建、签名、tag/PR/Release、远端合并操作、接管既有服务或执行真实安装器/GUI。上文接收端核对命令仅保留为未来另获下载授权后的通用操作，不属于本次执行范围。构建进程不得获得发布凭据；公共源码/测试 artifact 上传也不表示第三方发布阻塞已关闭。

CI 在桌面类型检查前依次构建 `@agent-workspace/contracts` 与 `@agent-workspace/client-runtime`，生成包导出的类型声明；全新检出不能依赖开发机已有的 `dist` 缓存。[`.gitattributes`](../../.gitattributes) 固定文本检出的 LF 行尾，避免 Windows `core.autocrlf` 改变受固定哈希保护的构建输入；不放宽或重写完整性校验。完整 Web 类型检查超出托管 macOS 默认堆上限，工作流显式设置 `NODE_OPTIONS=--max-old-space-size=4096`，保留全部类型检查。

Actions 只缓存 pnpm 内容仓与 `apps/desktop/.cache/runtime-downloads` 下载归档，signed/unsigned 分离，不缓存应用产物、已安装运行时、私有 Home 或签名材料。缓存命中后仍执行冻结安装、归档 SHA256/官方 Node checksum 校验、重新解压和 runtime smoke，以及全部原生测试、打包和成品冒烟。比较构建耗时必须记录真实 run/attempt、提交、OS/架构、runner image 与缓存命中状态；没有运行结果时不能宣称提速或发布通过，见 [CI 耗时记录](../reference/ci-performance-2026-11-06.zh.md)。

Windows 权限、reparse 检查和进程监督脚本显式加载系统 PowerShell 模块，不依赖 runner 的模块分析缓存或完整用户环境。打包 staging 目录创建后转为真实路径，兼容 macOS 的 `/var` 临时目录别名，同时保留产物目录的符号链接拒绝规则。

Windows reparse 属性及时间戳来自不跟随链接的原生句柄，并与 Node 看到的卷号/文件 ID 绑定；目录成员变动不冒充目录替换，时间戳变化仍使缓存失效。辅助编译使用独立私有临时目录，避免自身写入使公共 Temp 祖先的缓存持续失效。递归建目录后的持久化遍历同时规范普通路径和 Windows 扩展长度路径，不在卷根无限循环。

Windows 使用随包 `pg_ctl` 创建 PostgreSQL 的受限令牌进程，兼容以管理员令牌运行的宿主；通过数据库身份校验、实际 PID 与持久认证连接监督服务器，关机仍执行可重试的正常停止。版本检查在输出管道关闭后读取完整结果，不把进程 `exit` 当作输出已收齐；无需输出的控制命令不建立捕获管道，避免后台服务继承管道阻塞完成。

macOS 签名工具使用[固定补丁](../../patches/@electron__osx-sign@1.3.3.patch)：只遍历真实文件、跳过符号链接并顺序检查二进制，避免依赖别名循环及大资源树的 `EMFILE`。

## 源码捕获计时与 Windows 回归

源码捕获及构建后的源码复核会在读取前，按选集批量预热 Windows 原生属性缓存，覆盖卷根、源码根祖先和内部目录；每个请求最多 **256 个路径、128 KiB UTF-8 JSON**。这只合并相同身份/时间戳下的原生查询，不取消每文件检查：仍使用不跟随 reparse 的原生句柄、Node 文件身份/时间戳绑定、打开前后及目录 lineage 核对、SHA256、Git dirty 身份与最终发行材料检查。缓存预热后替换文件、修改正文或将祖先换成 junction 不能获得可信源码清单；失败不会发布新的 `desktop-source.json`。没有生产“跳过检查”开关。

`package` 输出 `scope=desktop-package` 的逐阶段 JSON `start` / `end` / `failure` 记录，包括源码捕获、workspace 构建、staging、安装器、最终成品及材料检查；失败仍保留已经完成的文件数/字节数。`elapsedMs` 是该阶段墙钟时间；嵌套阶段是包含关系，不能相加当总耗时。`nativeCalls`、`nativePaths`、`nativeElapsedMs` 及缓存 hits/misses/invalidations 是该阶段实际 Windows 属性辅助进程的增量，`nativeCallScope=windows-path-attributes` **不包含**首次私有编译目录的 ACL 设置进程。`cacheHitRate` 是 `cacheHits / (cacheHits + cacheMisses)`，分母为查询操作而非唯一文件，无查询时为 `null`。这些不含秘密/主机路径的诊断记录独立于源码和发行 manifest，不改变其身份格式。

原生回归继续由现有手动工作流的完整 desktop 测试和文件系统步骤运行，不替代或跳过其他交付/安全门禁。单独检查的命令为：

```sh
node --conditions=development --test apps/desktop/scripts/release-materials.test.mjs packages/pm-core/tests/platform.test.ts packages/infrastructure/tests/blobs.test.ts
```

新增 Windows 用例使用**实际系统 PowerShell 和原生句柄辅助程序**：预热后的同内容文件替换/同长度正文修改、相同正文的 junction 祖先替换、513 个短路径的三批查询及之后零新增 helper 的缓存命中、96 个额外源码文件的逐字节捕获，以及捕获中途的替换/正文/junction 失败。另有 UNC 根及设备名/尾点选集前置拒绝回归，使用 metadata trap 确保不触碰真实 UNC/危险别名，不替换实际验证 helper。它们只在 Windows 注册，避免破坏 backend runner 的无 skipped 契约；Linux 的通过数不包含这些原生用例。执行须具备真实 Windows、有效 `SystemRoot`、系统 Windows PowerShell，以及支持文件身份和 junction 的本地文件系统；Linux、Wine 或模拟平台不能补成该证据。

比较旧/新实现使用显式的独立进程 benchmark，不在每次 signed/unsigned CI 中重跑慢旧路径：

```sh
node apps/desktop/scripts/source-capture-benchmark.mjs --baseline-root ABS_FROZEN_RUNNABLE_TREE --baseline-provenance ABS_BASELINE_PROVENANCE_JSON
node apps/desktop/scripts/source-capture-benchmark.mjs --baseline-root ABS_FROZEN_RUNNABLE_TREE --baseline-provenance ABS_BASELINE_PROVENANCE_JSON --input ABS_REVIEWED_GITLESS_SNAPSHOT --timeout-ms 3600000
```

第一条只创建 **12 文件的合成 smoke**，默认每个子进程期限 180 秒，不是全仓性能样本。第二条才使用显式提供的真实已审阅 gitless `desktop-source.json` 及其源码树；不接受可变 Git checkout。源码输入由两侧真实 `captureSource`、输出文件逐字节/模式/hash 核对及 `requireUnchangedSource` 验证；manifest、文件数、字节数、清单 digest、commit/dirty 身份或运行平台不一致时拒绝比较。输出记录平台/架构、Node、输入大小/摘要、导入及 capture/recheck 耗时、实际 child_process 启动数和可用的新实现缓存指标，并将原生属性进程报告数与实际启动数核对。benchmark 的 PowerShell 总数包含 ACL 设置，不能和仅统计属性查询的 `nativeCalls` 混为同一范围。两侧各用新 Node 进程；不清空 OS/文件系统缓存，旧侧先执行，因此单次结果也不是受控冷磁盘统计。

基线必须是**任务修改前精确冻结的源码**，可以保留当时已审阅的 dirty 内容，不得换成 `HEAD`、历史 CI 提交或运行时禁用批处理的变体。基线树须可独立导入；若原件只是稀疏快照，只能补齐与当前实现逐字节相同的本地 helper 和根 `package.json`，并链接同一套已安装依赖，不安装/下载任何新工具。provenance JSON 使用 `schemaVersion: 1`、非空 `origin`、`frozenFiles` 和 `sharedFiles`：每项为相对 `path` / `sha256`。`frozenFiles` 必须精确包括旧 `apps/desktop/scripts/release-materials.mjs` 和 `packages/pm-core/windows-reparse.ts`；`sharedFiles` 必须完整覆盖脚本中 `sharedPaths` 列出的 13 个未变 helper/模块上下文文件。所有基线 hash 须来自保留的原字节，shared hash 同时匹配两侧；`tar` / `yaml` / `esbuild` 必须解析到同一套实际依赖。报告另列新模块 hash 和依赖入口 hash，并在结束后再次核对 provenance。

本轮合并检查环境为 **Linux x64 / Node 24.21.0**：最终源码的 release-materials/platform 测试 **32/32** 通过，未受后续 Windows-only 前置防护影响的 blobs 测试此前 **10/10** 通过，均无失败/跳过；新增 9 个 Windows 专用用例没有在 Linux 注册。最终 12 文件/560 字节 smoke 两侧清单 SHA256 均为 `5d36fbb5f9934f07fab711eed214c512c8ad82d99bbda97cd851b6b877551303`，旧/新 capture 为 `71.763078 / 59.292027 ms`，recheck 为 `16.803912 / 15.844753 ms`，实际 PowerShell 启动数均为 `0`，报告 `nativeWindowsMeasured=false`。这只证明该合成输入上的 Linux 等价性/计时入口可用，**不是 Windows 提速数据**，也不代表全量构建、安装器或 GUI 验收。另行隔离 backend 编译仍被现有 `app.ts` 的 `sample` 参数缺失及 `workspace-creation-routes.ts` 导入未导出的 `listWorkspaces` 阻塞，没有全量构建或部署成功结论。

历史 Run `42452780112` 在提交 `a560632d5576165864f1b766a399b4f4387e5ae1` 的实际成功及 Windows 安装器步骤 `45m31s` 只属于该次 CI。操作者报告的构建前 `32m31s` 静默不是 `captureSource` 函数测量，不能据此填写本次提速比例。当前没有可用的真实 Windows 执行环境，本次新增原生回归、同输入旧/新原生计时和新 Actions 结果仍未取得；本改动不触发 CI、不授予新的 commit/push/dispatch/安装器下载或服务重启权限。

## 验收证据边界

提交 `a063dc0` 的原生桌面 CI 历史通过仅覆盖该次提交及该工作流执行范围，不代表最新工作树、正式签名、公证、真实设备安装卸载或 Electron GUI 业务验收通过。unsigned 包和 ad-hoc 签名不能作为正式发布凭据。原生构建工具先按[开发指南](development.md)准备，外部 Provider/账号仍须逐项验收。

脚本单元/合同测试、Linux 上真实依赖闭包的物化/重打包实验、最终发行 payload 检查、所供安装资源树核对、native backend smoke、安装器生命周期及 Electron GUI 是不同证据层。Linux 的真实闭包实验仍不是新 Windows 安装包，也不证明 Windows 原生 ABI、ACL 或 GUI；旧安装器仅能作其自身来源身份的历史基线。本次新的原生安装器大小、实际安装目录占用、安装/升级/卸载保留数据和 GUI 结果均须在获授权的对应原生环境另行测量，不能用配置、源码观察或历史 CI 补成 passed。
