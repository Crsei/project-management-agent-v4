# 多应用拆分实施计划

## 确认范围

2026-10-24：用户要求建立待执行清单并交给 subagents 实施，随后明确选择「本轮不做任何移动端」。本轮交付 apps/web、apps/server、apps/desktop、apps/marketing，以及 packages/contracts、packages/client-runtime。不新增手机 Web 界面，不创建 apps/mobile，不主动删除已有响应式行为。

沿用本会话 gpt-6.1-sol:xhigh 的 studio-sol 子代理配置。四个独立工作切片；主线程负责集成、依赖安装、验证和文档。下面的勾选只在实施与验证后更新，不代表提前交付。

## 待执行清单

- [x] 固定包边界、接口、文件归属及验证标准。
- [x] 将 Web 源码、样式、静态资源和配置迁入 apps/web，保留聊天、工作区、Provider 设置及 Showcase 门禁。
- [x] 将 Hono、持久执行、自动化、Provider、检查器和测试迁入 apps/server；分离开发服务，保留一体化生产部署。
- [x] 建立 packages/contracts，迁移共享类型及适合共享的协议 schema；迁移全部消费者，不保留旧目录兼容导出。
- [x] 建立 packages/client-runtime，统一 HTTP、认证头、流连接及 WebSocket 地址；Web 接入真实共享实现，不留下第二套客户端。
- [x] 建立 apps/desktop：Electron 窗口、安全 preload/IPC、本地 Server 生命周期、远程 Server 连接及可实际运行的打包产物。
- [x] 建立 apps/marketing：独立官网、功能与自部署/桌面安装说明、有效工作台入口；不伪造下载链接、客户或指标。
- [x] 更新 pnpm workspace、各包依赖/tsconfig、根命令及 Docker 启动路径。
- [x] 保留现有数据库目录、Provider 凭据、浏览器存储键及导入逻辑；避免 cwd 改变导致项目根漂移。
- [x] 验证独立 Server、Web 开发代理、生产静态资源、SSE、PTY、聊天/运行、桌面宿主和官网。
- [x] 更新 README、设计采用记录和本清单的真实验收证据。

## 包及运行边界

- @agent-workspace/web：apps/web。原 src、components、hooks、styles、public、index.html、Web lib/utils 和组件配置归此包。前端不导入 server 源码。
- @agent-workspace/server：apps/server。原 server/** 迁入 src/**。应用默认仍只监听 loopback；生产可托管 apps/web/dist。支持独立 API 模式，不要求先构建 Web 才能启动 API。
- @agent-workspace/contracts：packages/contracts。无 React、DOM 或 Node 执行依赖。公开子路径 workspace、durable、provider、automation、inspector、chat；需要的 schema 可依赖 zod。Node 直接执行与前端构建均须能解析。
- @agent-workspace/client-runtime：packages/client-runtime。平台无关客户端，不能直接访问 window、document、localStorage 或 Node 文件系统；通过调用参数注入地址、fetch、认证头等能力。不得自动重试有副作用的 POST，也不得将请求断开变成取消执行。
- @agent-workspace/desktop：apps/desktop。Electron 只提供平台壳，加载现有 Web；执行仍属于独立 Server。至少包含本地托管和显式远程 URL 两种模式、可达连接/失败反馈、打开窗口与退出行为。关闭窗口与退出服务的区别必须明确；不能默默承诺应用退出后仍执行定时任务。
- @agent-workspace/marketing：apps/marketing。独立 Astro 静态站，不引用 Server 或工作区执行代码；默认不需要访问服务端密钥。面向桌面浏览器，本轮不新增移动产品界面。
- vendor/* 保留原目录及包名；不为了拆包改写供应商副本。

Web 开发使用同源代理转发 /api（包含流式请求及 /api/terminal WebSocket），保留 Origin/Host 安全约束，不使用通配 CORS。用户项目根和持久数据目录必须显式保持稳定。原根 .env.local 保留原处，不复制进浏览器或发布产物。

## 固定交接契约

### 分包代理 → 客户端代理

分包代理唯一负责移动现有目录及迁移 shared imports。完成移动及 imports 更新后，发送「Web files released」通知 ClientRuntime；之后不得再编辑 apps/web 的业务文件，配置文件仍归分包代理。ClientRuntime 可先独立创建 packages/client-runtime，等待通知后接入 Web。

共享类型子路径使用 @agent-workspace/contracts/{workspace,durable,provider,automation,inspector,chat}。contracts 中保留既有导出符号名；现有聊天 RemoteSettings、RemoteThread、ChatGenerationView 迁入 chat 子路径。schema 的所有权由分包代理统一处理，不能双份复制。

### 客户端运行时公开入口

由 ClientRuntime 实现并尽早向同伴公布精确 API。基础设计：createWorkspaceClient({ baseUrl?, fetch?, getHeaders? })，提供 API URL、WebSocket URL、认证后的 request/fetch 与 JSON 错误处理；流式响应保留标准 Response/ReadableStream，不绑定 React。业务层保留各自状态机，避免重写已经正确的执行恢复语义。

### Server → Desktop

Server 源码入口 apps/server/src/index.ts，构建输出 apps/server/dist/index.mjs，package 提供 build/start/dev/typecheck/test。构建若需要复制 worker/runtime 资源，必须完整交付并通知 Desktop。Server 支持 PORT=0，打印实际监听地址以供桌面宿主确定就绪，不靠固定延时。

环境变量保留 HOST、PORT、AGENT_WORKSPACE_DATA_DIR、AGENT_WORKSPACE_PROJECT_ROOT、AGENT_WORKSPACE_ACCESS_TOKEN；新增 AGENT_WORKSPACE_WEB_DIST 指定静态目录、AGENT_WORKSPACE_API_ONLY=1 关闭静态托管。默认 Web dist 路径以模块位置解析，不以 process.cwd() 推断。认证路由及 /api 相对路径不改。

Desktop 本地服务使用随机强访问令牌，IPC 仅允许必要且受来源约束的操作；不得向任意网页暴露文件系统/进程执行权限。远程地址只允许明确校验的 http(s)，本机以外应要求 HTTPS；不得在不可信远程内容中注入本地凭据。桌面打包需包含可用 Web/Server 资源和匹配的运行时/依赖，或明确且检测必要运行前提；不能以启动空窗口替代可用应用。本轮不新增自动更新后台、代码签名服务、SSH/WSL 管理或系统守护进程安装功能。

### 命令与依赖

根命令保留 pnpm dev/build/start/test/lint，并提供按包执行与 Desktop/Marketing 入口。分包代理拥有根 package.json、pnpm-workspace.yaml、根构建配置和 docker.sh；各新应用代理拥有自己的 package.json。不要并行安装依赖；各代理声明所需依赖，主线程最终统一安装并更新 pnpm-lock.yaml。安装使用 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY=http://127.0.0.1:17891，本地服务走 NO_PROXY=localhost,127.0.0.1。

## 子代理文件归属

1. AppSplit：所有原有应用目录的移动、apps/web 的配置、apps/server、packages/contracts、根脚本/配置及 docker.sh。迁移现有测试，禁止删除有效行为覆盖；不编辑文档或锁文件。
2. ClientRuntime：packages/client-runtime；收到移交后拥有 apps/web 内所有网络接入业务文件。禁止移动其他目录、修改 Server 或根配置。
3. DesktopShell：apps/desktop 全部文件，仅使用约定 Server/Web 产物；向 AppSplit 提交打包需求，不越界改 Server。
4. MarketingSite：apps/marketing 全部文件。文案以现有真实能力为准；下载链接只有存在构建产物或配置真实发布地址才显示。
5. 主线程：本计划、README、DESIGN-ADOPTION、锁文件、统一验证及跨片集成。

各代理必须跳过中途 build/lint/test/format，完成后汇报路径、接口、依赖、风险；不得伪称验证通过。引用/移动导出符号前使用 LSP；批量语法改写优先 AST 工具。共享旧文件与用户原有修改必须保留。

## 验收标准

- 原有服务端行为测试在新包路径运行通过；新增测试只覆盖真实行为边界。
- 各包类型检查与生产构建通过；Web 构建不再加载后台服务或打开 SQLite。
- 独立 Server API 无 Web dist 可启动；生产模式能从非仓库 cwd 正确定位资源，项目根不漂移。
- 实际启动开发 Web/Server，浏览器走同源代理完成聊天、SSE、取消；PTY 真实回显；不做真实计费调用。
- 实际启动生产服务验证会话/执行状态保留，Fork/回传及自动化关键路径不因迁移失效。
- 实际启动 Electron，观察 Web 窗口与服务就绪，操作聊天/连接，验证退出/子进程清理；打包产物做实际启动验收。平台工具链缺失则准确记录尝试及限制，不伪称安装通过。
- 实际浏览器打开官网，验证页面和主要链接，不把组件演示或占位按钮当作功能。
- 本轮不新增 Mobile，不把历史手机截图算作本轮交付。

## 本轮实际验收

模型使用隔离的本地 HTTP Provider 协议夹具；没有真实模型计费或 GitHub 写操作。临时数据库、端口与浏览器资料均独立于用户工作区。

| 项目             | 实际结果                                                                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 行为测试         | `pnpm test`：Server 100、共享客户端 10、桌面策略 3，共 113 项通过，无失败或跳过。                                                                                                                                                            |
| 构建             | contracts、client-runtime、Server、Web、桌面宿主及 Marketing 均已成功构建；Marketing 生成 4 个静态页面。                                                                                                                                     |
| 独立 API         | 从 `/tmp` 启动构建后的 Server，API-only 模式允许不存在 Web dist；页面 404、未认证 API 401、携带有效凭据的跨 Origin 请求 403；Files 项目根仍指向仓库。                                                                                        |
| 开发 Web         | 容器只读源码、Vite runner 与独立 API；实际浏览器完成令牌登录、hydrate、聊天流与取消；同源代理上的真实 PTY 输出 `DEV_PTY_OK`，界面终端输出 `UI_PTY_OK`。                                                                                      |
| 生产与恢复       | 从非仓库 cwd 托管生产 Web，`/workspace` 200、未启用 Showcase 时 404。重启后正在运行的 generation 变为 interrupted，Provider 请求未自动重放；显式 continuation 完成，原记录保留 interrupted。浏览器恢复原消息和设置。                         |
| Fork 与回传      | 创建已完成运行的分支、执行子分支、按精确预览确认回传；父会话下一次请求消费一次回传，之后请求不再重复。                                                                                                                                       |
| 持久执行与自动化 | 关闭流读取不取消服务端 generation；实际一分钟定时任务由 worker 派发并完成，随后暂停该测试任务。                                                                                                                                              |
| 官网             | 实际浏览器逐页操作 `/`、`/get-started/`、`/desktop/`、`/security/`；无横向溢出和页面异常，无分析脚本或虚假下载；默认工作台链接明确要求启动本地服务。                                                                                         |
| 桌面本地模式     | 已实际启动移出仓库路径的 Linux x64 打包目录，用外部 Node 22.23.3 启动随机端口 Server；聊天返回 `MULTI_APP_REPLY`，真实 PTY 返回 `DESKTOP_PTY_OK`。renderer 无 Node globals、无可见 Cookie/令牌；关闭工作区后任务完成，重新打开仍使用原服务。 |
| 桌面最终退出     | 最终打包产物重新启动并读取已有会话；实际发送 SIGTERM 后不显示确认弹窗，应用退出 0，自有 Server 端口关闭。该原生生命周期问题以修复前/后的真实 Electron 场景回归，未用 mock 退出函数替代。                                                     |
| 桌面远程模式     | 最终打包产物连接独立 Server；隔离 session 首次显示访问令牌门禁，登录后从列表打开已恢复的会话，显示保存上下文与 `MULTI_APP_REPLY`。没有创建本地 Server；关闭窗口并点击 Quit 后应用退出 0，独立远程 API 仍认证成功。                           |
| 静态检查         | `pnpm lint` 退出 0、格式检查通过；保留 URL 控制字符拒绝正则的 1 条 `no-control-regex` 警告，没有通过禁用校验隐藏它。Web 构建仍有大 chunk 和上游 Zod 注释警告。                                                                               |

### 集成中修正的问题

- Electron ESM 顶层等待 `app.whenReady()` 会阻止应用加载完成：改为注册异步就绪回调，已实际启动窗口。
- pnpm 11 legacy deploy 会改写调用目录的安装状态：在独立临时 workspace 中部署生产依赖，避免剪掉源码工作区开发依赖。
- Electron packager 复制资源时破坏 pnpm 相对链接：显式保留 symlink，复制后再检查依赖未逃出产物。
- Electron 下载代理必须在加载 packager/get 之前配置；打包脚本延迟导入，沿用用户代理。
- 用户内退出确认与系统原生 quit 分开处理；系统终止与显式确认后的退出共用单次清理，避免终止信号被确认弹窗阻塞。

### 交付限制

- 桌面交付是 Linux x64 完整应用目录，不是安装器；没有签名、公证或自动更新，未宣称验证 Windows/macOS。
- 本地桌面需要外部 Node ≥22.18、兼容桌面系统库及可用 Chromium sandbox。验收使用 Debian 12/Xvfb 隔离环境，没有关闭 sandbox；测试字体来自容器系统包。
- 原生 Codex/Claude Fork/Resume、真实额度重置和 GitHub CI/Review/冲突监测本轮以迁移后的已有行为测试为回归依据，不将协议夹具称为线上账号验证。
- 本轮没有新增 Mobile。旧响应式行为保留，不宣称新增移动产品或本轮手机验收。

状态：上述清单全部完成。实际生成并运行的交付目录为 `apps/desktop/release/Agent Workspace-linux-x64/`；完整目录分发要求与启动命令见 README。
