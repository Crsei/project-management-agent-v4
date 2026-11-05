# agent-workspace

> 上游历史说明快照，不是Dovspace当前部署/能力合同。当前使用[根入口](../../README.md)、[Agent指南](../guides/agent-chat.md)和[数据所有权](../architecture/data-ownership.md)，不得据本页旧路径/账号示例迁入数据或开放公网。

**React 19 / Hono / assistant-ui 的单用户 Agent 工作区。** Web 使用 Vite，桌面使用 Electron，官网使用 Astro；执行与数据统一归 Server。支持持久化聊天和顺序工作流、Provider 多账号、原生会话恢复、Fork/上下文回传、定时任务、额度恢复和 GitHub PR 监测。原 Next.js 实现在 `../agent-workspace-next`；旧 localStorage 数据可幂等导入，新的服务端数据契约不再与归档版双向互换。

多应用拆分计划与本轮验收见 [MULTI-APP-PLAN.md](MULTI-APP-PLAN.md)；持久执行功能的上一轮任务与证据见 [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)。

## 页面与服务边界

| 入口                  | 能力                                                                                     | 数据与执行                                         |
| --------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `/`、`/workspace`     | 聊天；Agent / 工作流 / 文档 / 技能 / 运行记录 / 自动化；Files / Git / Terminal / Browser | Hono API；服务端 SQLite 持久化；真实 Provider 驱动 |
| `/settings/providers` | Provider 实例创建、编辑、删除、登录及凭据管理                                            | 密钥与实例环境变量只在服务端保存                   |
| `/showcase`           | 75 页目录，及延期 Composer 页的直接路由                                                  | 独立展示实验室；fixture 回执不是后台执行结果       |

Showcase 保留原有 Conversation 23 页、业务 30 页、API Platform 20 页和 Composer 目录。特殊路由 `/showcase/parent-child-conversations`、`/showcase/web-answer`、`/showcase/agent-studio/{builder,integrations,skills}` 不变。生产环境默认关闭 Lab。

**不是多用户 SaaS。** 所有已授权浏览器共享同一工作区和本机权限。默认仅监听 loopback；远程监听必须配置访问令牌。API、Provider 凭据操作及 PTY 都受同源/访问控制保护，但访问令牌不提供用户隔离、细粒度 RBAC 或支付能力。

### 应用目录与共享边界

| 目录                      | 职责                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/web`                | 聊天、工作区、Provider 设置和受门禁控制的 Showcase；不在 Vite 内启动执行 worker。               |
| `apps/server`             | Hono API、SQLite、Provider/CLI、PTY、Git、后台执行及自动化；可独立运行，也可托管 Web 静态产物。 |
| `apps/desktop`            | Electron 宿主，复用 Web；管理本地 Server 或连接明确指定的远程 Server，不另建执行器。            |
| `apps/marketing`          | 独立静态官网与部署说明；不加载工作区密钥、执行代码或后台订阅。                                  |
| `packages/contracts`      | 请求、响应、事件等共享类型与协议 schema。                                                       |
| `packages/client-runtime` | 平台无关 HTTP/流连接、认证头和 WebSocket URL；Web 实际使用该实现。                              |
| `vendor/*`                | 保留现有项目内供应商源码包，不因分包重写组件。                                                  |

本轮明确不新增任何移动端，不创建 `apps/mobile`；已有响应式行为保留，不作为新增交付。应用分包不意味着必须分开部署：生产 Server 仍可在同一个 origin 提供 Web 和 `/api`。

开发 Web 通过同源代理访问独立 API 服务；不要通过关闭同源检查或通配 CORS 来连接分离端口。服务端静态目录由 `AGENT_WORKSPACE_WEB_DIST` 覆盖，`AGENT_WORKSPACE_API_ONLY=1` 可只运行 API。用户项目根由 `AGENT_WORKSPACE_PROJECT_ROOT` 指定，持久数据仍由 `AGENT_WORKSPACE_DATA_DIR` 指定；源码目录搬迁不迁移数据库或账号凭据。

### 在真实对话中使用工作区

左侧栏是会话资源和自动化，右侧竖栏是检查器；手机端从侧栏进入同一功能，使用右侧 Sheet 展开。面板关闭不等于取消服务端任务。

1. **Agent**：设置 Provider 实例、模型、系统指令和技能。可用于后续聊天，或单独执行任务。「恢复默认助手」恢复当前 Thread 的聊天设置。
2. **技能**：可复用提示指令，不是可执行脚本。
3. **文档**：编辑、导入和导出 UTF-8 文本。新文档默认不加入模型上下文，需明确勾选。
4. **工作流**：1–8 个顺序步骤，每步选择 Agent。提交时保存任务、模型、指令和上下文快照，后续编辑不会改变已提交执行。
5. **运行记录**：显示排队、运行、完成、失败、取消和中断；未知时间/令牌显示 `—`。结果可引用至聊天草稿或保存文档，不自动发送。
6. **自动化**：管理定时任务、额度恢复和 PR Watch；派发状态与实际 Run 状态分别显示。

### 持久化、断线和重启

数据目录由 `AGENT_WORKSPACE_DATA_DIR` 指定，默认 `~/.agent-workspace`。`workspace.sqlite` 保存会话、执行请求、步骤结果、事件和自动化记录；Provider 凭据单独保存。Node 要求 **≥22.18**，使用原生 `node:sqlite`。

- 浏览器刷新、离开页面或语音设置重挂载只断开订阅，不取消已受理执行。
- 工作流通过 `POST /api/workspace/runs` 持久入队，通过 `GET /api/workspace/runs/:id/events?after=N` 补读事件。旧 `/api/workspace/run` 已删除。
- 同一 Thread 的聊天和工作流共用执行锁，不会并发操作同一个会话；不同 Thread 可以并行。
- 显式「停止」才发送取消命令；外部已产生的文件修改、工具副作用或费用不能撤销。
- 服务重启保留已确认输出，将未结束执行标为中断。续跑创建新记录，不篡改原结果；已完成工作流步骤复用输出。
- CLI 未完成步骤可能已经产生外部副作用。没有可确认的安全原生续接时，必须先检查文件/Git，并明确确认风险；不会无条件重放。
- 旧 localStorage 聊天/资源幂等迁移，保留本地原数据和备份。导入的旧运行仅为历史，没有完整服务端请求快照时不能自动续跑。
- 资源保存采用 revision。其他窗口已经修改时显示冲突，保留当前草稿，要求明确处理，不静默覆盖。

停止服务后备份数据目录；若配置了目录外的 CLI home，也需单独备份。不要让两个服务进程共用同一数据目录：执行存储使用进程锁拒绝第二个 owner。

### Fork 与上下文回传

在运行记录或聊天连续性控件中选择已结束执行创建 Fork。完成步骤可选精确边界；失败/中断快照中的部分结果明确标为未完成，使用 portable context，不冒充成功。

- 创建分支时不调用模型。首次执行时，能力、实例及原生边界都兼容才使用 Codex/Claude 原生 Fork；否则使用有边界的上下文迁移，或明确报告不支持。
- 父会话和原运行不变。**默认共享工作目录，不自动创建 Git worktree，也不回滚文件。**
- 分支稳定后选择「预览上下文回传」，确认内容后回传到直接父 Thread。父 Thread 下次明确执行时消费一次。
- **Merge back 是上下文回传，不是 Git merge/cherry-pick，也不自动启动父任务。**

### 模型提供商与账号

默认保留 DeepSeek / OpenAI / Anthropic API Key 与 Codex / Claude CLI 实例；`/settings/providers` 可创建额外实例，并设置独立名称、凭据、API endpoint、CLI home、工作目录及环境变量。

密钥、环境变量值不进入前端读接口；只显示密钥提示和环境变量名称。实例修改使用 revision 防止陈旧覆盖。损坏的凭据文件不会自动覆盖。

CLI 登录、状态探测、退出和执行使用该实例的隔离 home。迁移默认 CLI 时复制所需配置/凭据，不更改全局登录。更换账号/目录或配置修订会使旧原生会话引用失去兼容性，改走明确的 portable handoff，而不是把一个账号的 session ID 交给另一个账号。

Codex 使用真实 app-server 有界 Fork 协议；Claude 使用 SDK 的 `forkSession` 和原生恢复参数。需要支持对应协议的 CLI；没有 Provider 返回的边界不能伪造精确 Fork。API Key 模型使用规范化历史，不宣称原生会话 Fork。

模型、Provider、system 和 temperature 按 Thread 保存；语音偏好仍是浏览器级。切换选择用于后续执行，已提交快照不被修改。未配置凭据的聊天请求返回 `412`；后台任务则保留真实失败记录，不回落到另一 Provider。

### 定时任务、额度恢复与 PR Watch

**定时任务**

- 选择当前 Agent/工作流，填写输入并保存执行模板快照。
- 支持至少一分钟的间隔，或固定时间＋星期（星期日为 0）。界面显示服务端时区，不采用手机时区。
- 可编辑、暂停/恢复、立即执行或删除；暂停任务也可手动执行一次。
- 错过策略为跳过或合并为最近一次，不重放整个停机期间的积压。
- 「已派发」只表示队列接受，不代表模型执行成功；查看关联 Run 的实际状态。

**额度恢复**

- 仅在 Provider 提供明确 usage-limit 分类及有效 reset 时间时提供自动恢复授权。
- 默认关闭；可授权或取消。到期重新核验失败执行、最新活动、Provider 实例及配置修订。
- 没有 reset 时间不猜测，不自动换账号；未知 CLI 副作用可能阻止自动恢复，需人工检查后续跑。

**GitHub PR Watch**

- 填写 owner、repo、PR 编号和执行模板；可停止、编辑、手动检查或删除。
- 服务端使用 `GH_TOKEN` / `GITHUB_TOKEN`，未配置时尝试本机 `gh` 登录；不读取浏览器中的 GitHub 登录态。
- 首次成功读取建立基线。后续 checks/status、Review、评论、head 和冲突变化经过水位去重后派发任务；忽略自身评论，处理限流及关闭/合并状态。
- 唤醒通过同一个服务端执行队列，同会话忙时等待。PR 内容以不可信外部材料传入，不构成额外工具权限或自动合并授权。
- 此实现针对 GitHub；不把本地 Git diff 面板宣称为远端 PR 集成。

**后台前提**：任务只能在服务进程常驻时执行。关闭浏览器可以继续，关闭电脑/服务不能继续；停机后按上述恢复和错过策略处理。可由现有 systemd/容器管理器运行 `pnpm start`，本项目不会自行安装开机服务。

### 远程访问

在服务端配置 `AGENT_WORKSPACE_ACCESS_TOKEN`（至少 32 字符，不使用 `VITE_` 前缀），再显式设置 `HOST=0.0.0.0`。浏览器首次访问输入令牌，服务端设置 HttpOnly、SameSite=Strict 会话 cookie；令牌不写入 localStorage。轮换令牌会使旧会话失效。

远程部署应通过可信 HTTPS 反向代理访问；保留 Host/Origin，勿公开未保护的上游端口。所有持有令牌的人拥有同一工作区权限，包括 PTY 的本机 shell 权限。Docker 脚本只在端口发布于 loopback 时允许无令牌容器内部监听。

### 实现位置

- `apps/server/src/durable/`：SQLite、执行队列、事件、Thread/聊天、Fork、上下文 transfer。
- `apps/server/src/providers/`、`apps/server/src/agents/`：实例、凭据、CLI/SDK 原生会话和结构化错误。
- `apps/server/src/automation/`：定时、额度恢复、GitHub 适配和持久化派发。
- `apps/server/src/runtime.ts`：后台生命周期；`apps/server/src/access.ts`：HTTP/PTY 访问保护。
- `apps/web/src/chat/`、`apps/web/src/assistant.tsx`：远程 assistant-ui 历史、流恢复和聊天连续性。
- `apps/web/src/workspace/`：资源保存、运行/Fork/merge、自动化与检查器面板。
- `packages/contracts/`、`packages/client-runtime/`：跨应用契约与客户端连接。
- `pnpm test`：行为/契约测试；`pnpm build`：各应用生产构建；`pnpm lint`：oxlint＋格式检查。

此前 DeepSeek 实测记录属于旧版本；本次功能验证与未覆盖范围单独登记在实施清单，不能把本地 Provider/HTTP 测试替身当成真实模型或 GitHub 授权验证。

### 工作区检查器（Files / Git / Terminal / Browser）

`/workspace` 右侧检查器读取本机项目，入口在右侧竖栏，不写入文件、索引或 Git 状态；手机端从左侧抽屉进入。

- **Files**：`GET /api/inspector/files?path=` 列出目录，`path` 为相对项目根的 POSIX 路径（空串表示根）；`GET /api/inspector/file?path=` 返回 UTF-8 文本，二进制文件返回 415。项目根由 `AGENT_WORKSPACE_PROJECT_ROOT` 指定，源码运行的默认值固定为仓库根，而非某个包的 cwd；桌面由连接设置选择项目目录。绝对路径、`..` 和指向根外的符号链接都会被拒绝，`.git`、`node_modules`、`dist` 等目录不出现在树中。
- **Git**：`GET /api/inspector/git` 返回是否仓库、分支、ahead/behind 与逐文件状态；`GET /api/inspector/git/diff?path=&staged=1` 返回 unified patch，未跟踪文件按 `/dev/null` 对比。项目位于更大仓库的子目录时，状态用 `git status -- .` 限制在项目内，文件路径统一为项目相对路径；非 Git 目录的状态为 `repo: false`，diff 返回 409 `not_a_repo`。
- **Terminal**：`/api/terminal` 是 WebSocket 上的真实本地 PTY（`@lydell/node-pty` 预编译绑定），每个连接一个 PTY，socket 断开时结束；shell 取 `AGENT_WORKSPACE_TERMINAL_SHELL`，再回退 `$SHELL` / `/bin/bash`。升级握手使用与 API 一致的同源和访问令牌检查。终端等同于服务进程的本机 shell 权限。
- **Browser**：预览是 iframe 加地址栏、前进/后退、重新加载和自适应/桌面/平板/手机视口，没有服务端代理，请求由浏览器直接发往目标站点。目标站点的跨域策略、`X-Frame-Options` 或 CSP 可能拒绝被嵌入；iframe 默认 sandbox 不含 `allow-same-origin`，被预览站点因此访问不到自身的 cookie/localStorage，勾选「允许同源」后才会放开（仅对本机可信页面使用）。

| 项目      | 上限    | 超出时                        |
| --------- | ------- | ----------------------------- |
| 目录树    | 2000 项 | `truncated: true`             |
| 单文件    | 256 KiB | 内容截断，`truncated: true`   |
| 单个 diff | 512 KiB | patch 截断，`truncated: true` |

### 启用展示实验室

开发环境自动开放。生产默认关闭；开启需要重新构建，启动时读取构建产物 `dist/ui-lab.json`，关闭时 `/showcase` 及其子路径返回 HTTP 404：

```bash
pnpm install --no-frozen-lockfile
VITE_ENABLE_UI_LAB=1 pnpm build
pnpm start
# http://localhost:4320/workspace
# http://localhost:4320/showcase
```

容器等价命令：`VITE_ENABLE_UI_LAB=1 ./docker.sh build`，然后 `./docker.sh start`。关闭时用 `VITE_ENABLE_UI_LAB=0` 重建并重启服务。仅修改启动时环境变量不会覆盖构建策略。DeepSeek key 可继续放在服务端 `.env.local` 的 `DEEPSEEK_API_KEY`，也可在 `/settings/providers` 保存；两者都不能使用 `VITE_` 前缀。

### 实现位置与状态生命周期

- `apps/web/src/app.tsx`：真实聊天与实验室路由。
- `apps/web/src/showcase/{conversations,business,platform}`：逐页宿主、目录和懒加载路由；公共壳层负责搜索、主题、语言、场景选择与错误呈现。
- `vendor/{agent-workspace-views,ui,workspace-protocol}`：从 EasyuseUI 复制的本项目源码包，通过 pnpm workspace 解析；不依赖外部目录或 Next.js。未使用的 Project Management 页面未引入。
- `apps/web/public/fixtures`：原始音频、视频和 PDF；`apps/web/styles/showcase-tokens.css` 补齐语义角色而不替换现有聊天主题。
- 只挂载访问过的场景；同页切换场景保留各自编辑，重置只替换当前场景。业务/API 的原有 session cache 在实验室内部导航间保留；Conversation 控制器在离开页面时卸载。刷新重置 fixture，绝不写入真实聊天历史。
- 展示语言保存在 `agent-workspace:showcase-locale`，主题复用 `agent-workspace:theme`；这些浏览器偏好与服务端聊天/执行数据相互独立。
- `pnpm lint` 检查应用宿主；vendor 保留上游格式，不做全量重排。`pnpm build` 的 TypeScript 检查覆盖实际导入的 vendor 源码。

### 展示实验室接入时的历史验证范围

- `pnpm lint` 与生产 TypeScript + Vite 构建通过；分词器的动态编码模块使用 `worker.format: "es"`。
- 浏览器逐页挂载 **80 个直接路由 / 529 个外层场景**；75 个正式目录项，5 个延期页只支持直接访问。挂载检查无页面错误边界或未处理 JS 异常；这不代表逐页所有业务分支都已验收。
- 实际交互：问卷选择/提交、草稿的场景隔离与重置；文档接受修改/撤销；本地 API 密钥创建/一次性显示/确认撤销；分词器将 `Hello world` 编码为 `o200k_base` 的 `[13225,2375]`。
- 真实聊天返回 `integration-ready`，既有会话及消息可从 localStorage 恢复。深浅主题已检查目录、对话与 API 页面截图。
- `./docker.sh dev` 在只读源码挂载下启动成功；`--configLoader runner` 保留，生产构建命令补上 `tsc --noEmit`。
- 390×844 移动视口验证目录、中文快速输入搜索（完整保留“分词器”，命中 1 页）及英文切换；修复了输入状态直接绑定异步路由导致的丢字问题。
- Lab 关闭构建启动后，`/showcase` 与 `/showcase/composer` 实测 HTTP 404；开启构建重新启动后目录可访问。无效页面/场景及重复参数的客户端 404 已验证。
- 已知构建提示：部分语言/分词资源与主聊天 chunk 超过 500 kB；按页和 Worker 动态加载，不把该提示伪装为已解决。没有宣称真实支付、语音服务或外部业务系统已接通。

## 为什么要有这份

Next 16 的 dev 在容器里**整树不 hydrate**（SSR 出 HTML，客户端 React 根不挂载；连 vanilla Next 16.4 都复现，与本项目代码无关），只能拿生产构建做交互验证。Vite dev 在同一容器里 **84 个 React fiber、交互全通**，所以这份既是"Vite 方案"的落地，也是绕过 Next dev 问题的可用开发环境。

## 跑起来（原生与分应用）

要求 Node ≥22.18、pnpm 11.9.0。根 `.env.local` 保留在原处，密钥不能改成 `VITE_` 或 `PUBLIC_` 变量。

```bash
pnpm install
pnpm dev                 # Web :4320 + 独立 API :4322

pnpm build               # 共享包、Server、Web、Desktop 壳及 Marketing
pnpm start               # Server 托管 Web，默认 http://localhost:4320
```

分应用入口：

```bash
pnpm dev:server          # 独立开发 API
pnpm dev:web             # 只启动 Web，需已有开发 API
pnpm build:server        # 共享包 + Server
AGENT_WORKSPACE_API_ONLY=1 PORT=4322 pnpm start:server
pnpm build:web           # 共享包 + Web
pnpm dev:marketing       # 独立官网，http://localhost:4330
pnpm build:marketing
pnpm preview:marketing   # 预览静态官网
pnpm desktop             # 本地 Electron 宿主；先构建 Server/Web
pnpm desktop:package     # 构建并生成当前平台的桌面应用目录
```

`pnpm preview` 仅用于静态前端预览，不替代 `pnpm start` 的完整后端。共享包的 development 条件直接使用源码，生产条件使用编译后 JS/types；不要把 dist 删除后直接运行依赖生产条件的命令。

### Desktop 运行与生命周期

桌面使用 Electron 45；本地 Server 运行在外部 Node ≥22.18，而不是 Electron 的 Node ABI。连接窗口会检查 Node、SQLite、PTY 与 Claude SDK 运行依赖，支持选择 Node 可执行文件、项目根和数据目录。完整工作区构建推荐使用 Node 24 LTS。

```bash
pnpm --filter @agent-workspace/desktop runtime:install
pnpm --filter @agent-workspace/desktop start --local
pnpm --filter @agent-workspace/desktop start --remote=https://workspace.example.com
```

`start` 也会在缺少 Electron 二进制时尝试安装；下载可使用 `HTTP_PROXY` / `HTTPS_PROXY`。`--node`、`--project-root`、`--data-dir` 接受绝对路径，优先于相应 `AGENT_WORKSPACE_*` 环境变量和已保存选择。远程地址必须由用户指定；非 loopback 必须 HTTPS，不接受 URL 内嵌凭据。

- 本地模式：随机端口、随机强访问令牌；通过私有 session 的 HttpOnly Cookie 认证 HTTP 与 PTY，不把令牌放进 renderer 或 localStorage。
- 工作区窗口：启用 sandbox、context isolation，禁用 Node integration，没有 preload。仅可信连接窗口持有受来源校验的有限 IPC；远程窗口使用隔离 session。
- 关闭工作区窗口：保留本地 Server，通过连接窗口重新打开；应用内退出或断开连接：确认后停止自己拥有的 Server/worker。系统终止走非交互清理；退出不会停止用户的独立远程 Server，也不提供隐藏守护进程。
- 源码运行默认项目根为仓库根；打包运行默认为 `~/Agent Workspace Projects`。数据仍默认 `~/.agent-workspace`；不要让独立 Server 与桌面同时占用同一个数据目录。

`pnpm desktop:package` 会构建所需资源，隔离部署生产依赖并生成当前 OS/架构的应用目录。Linux x64 产物：

```bash
"apps/desktop/release/Agent Workspace-linux-x64/Agent Workspace"
```

分发时复制完整目录，保留可执行权限，并让目标用户能读取目录内容。它不是安装器，也没有代码签名、公证或自动更新服务；Windows/macOS 需在目标平台构建与验证。目标机器须有兼容 Node、桌面系统库和可用 Chromium sandbox；不要用 `--no-sandbox` 掩盖不受支持的系统环境。

### 官网配置

Marketing 是独立静态站，页面包括 `/`、`/get-started/`、`/desktop/`、`/security/`。构建时 `PUBLIC_WORKSPACE_URL` 可指向实际工作台；未设置时明确链接本机 `http://localhost:4320/workspace`，不会自动替用户启动服务。`PUBLIC_DESKTOP_RELEASE_URL` 仅接受 HTTPS 发布地址；未设置时提供真实构建说明，不显示假下载按钮。官网不加载 Provider 凭据、分析脚本或工作区 API。

## 跑起来（docker）

```bash
./docker.sh pull     # 首次：拉镜像（走 daocloud，Docker Hub 直连超时）
./docker.sh install  # 容器内 pnpm install（宿主 uid，产物归宿主）
./docker.sh dev      # 同源 Web + 独立 API → http://localhost:4320
./docker.sh build    # 多应用构建；Web → apps/web/dist
./docker.sh start    # apps/server/dist/index.mjs + Web → http://localhost:4321
./docker.sh clean-cache   # 清 Vite 缓存，保留 provider-data
```

端口用 `DEV_PORT`（默认 4320）/ `START_PORT`（默认 4321）覆盖。`.env.local` 可放 API Key fallback 和访问令牌；也可在 `/settings/providers` 保存实例凭据。原生启动用 `AGENT_WORKSPACE_DATA_DIR` 指定数据目录；Docker dev 数据位于 `agent-workspace-cache` 卷的 `provider-data`，Docker start 位于宿主 `.data`，两者是独立环境。`clean-cache` 只清 Vite 缓存，保留 `provider-data`，不会删除会话数据库。

## 为什么要 docker（本机实测，别照抄 Next 的理由）

| 假设的阻碍      | 实测结论                                                                                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| glibc 2.28 太老 | **不成立**。Vite 侧原生依赖只需 `GLIBC_2.14`：`tailwindcss-oxide`（Tailwind v4）与 `lightningcss` 二进制符号最高 2.14，esbuild 是静态二进制。对比 Next 16 的 SWC/Turbopack 绑定要 2.29，那是 Next 独有的坑 |
| 文件监听        | **真瓶颈**。`fs.inotify.max_user_instances = 128`，本机用户配额被几十个项目占满，Vite dev 的 watcher 会 `ENOSPC`。因此 dev 以 **root 容器**跑（root 配额独立），与 Next 版 `docker.sh dev` 同一对策        |

root 容器 + **源码只读挂载** + 缓存走 docker volume（`agent-workspace-cache` → `/app/.vite-cache`），宿主目录零写入，不会留 root 属主文件。

两个为只读挂载专门做的设置：

- `vite --configLoader runner`：默认的 `bundle` 加载器会把配置写成 `node_modules/.vite-temp/vite.config.ts.timestamp-*.mjs`，只读挂载下 `EROFS` 崩；`runner` 用原生 import 加载，不落临时文件。
- `VITE_CACHE_DIR=/app/.vite-cache`（`apps/web/vite.config.ts` 的 `cacheDir`）：把依赖预打包缓存挪出只读的 `node_modules/.vite`。

宿主原生也能跑（`pnpm install && pnpm build && pnpm start`；`pnpm dev` 受 inotify 配额限制，需要先 `sudo sysctl -w fs.inotify.max_user_instances=1024`）。

以上 Vite 原生依赖结论不适用于 Electron。桌面需满足所选 Electron 的操作系统与系统库要求；本轮不会为旧 glibc 降级到已停止支持的 Electron 版本。具体桌面验收平台见 `MULTI-APP-PLAN.md`。

## 原始聊天宿主与 Next 版的差异（历史记录）

| 关注点          | Next 版                                                                     | 本版                                                                                                                                                                                                                |
| --------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 入口            | `app/layout.tsx` + `app/page.tsx` + `app/assistant.tsx`                     | `index.html` + `src/main.tsx`（`StrictMode` + `TooltipProvider`）+ `src/assistant.tsx`                                                                                                                              |
| 字体            | `next/font/google` 注入 `--font-inter` / `--font-ibm-plex-mono` 到 `<body>` | `index.html` 的 Google Fonts `<link>`，变量在 `styles/globals.css` 末尾补齐                                                                                                                                         |
| API `/api/chat` | Next Route Handler `app/api/chat/route.ts`                                  | Hono `server/chat.ts`（同一段 `streamText` + `convertToModelMessages` + `injectQuoteContext` + `frontendTools` + 模型白名单/temperature 规则），dev 由 `vite.config.ts` 的中间件挂载，生产由 `server/index.ts` 服务 |
| Tailwind        | `@tailwindcss/postcss`（`postcss.config.mjs`）                              | `@tailwindcss/vite`                                                                                                                                                                                                 |
| 配置包装        | `next.config.ts` + `@assistant-ui/next`（devDep）                           | 无；`vite.config.ts` 直接用 `@vitejs/plugin-react`                                                                                                                                                                  |
| 别名            | `@/*` → `./*`                                                               | 同（`vite.config.ts` 的 `resolve.alias`），因此拷贝进来的代码**零改动**                                                                                                                                             |

原始聊天组件来源于归档版的 `components/**`、`hooks/**`、`lib/**` 与设计令牌；当前版本另有展示路由、主题扩展和侧栏入口，已不再逐字相同。

## 原始聊天数据契约（历史互操作记录）

localStorage 前缀与键名一字不差：

- `agent-workspace:threads` — 会话元数据
- `agent-workspace:formatted-messages:[remoteId,"ai-sdk/v6"]` — 每个会话的消息历史
- `agent-workspace:chat-settings` — 模型 / system prompt / temperature / 语音开关

**互操作验证**（换名之前做的，端口为当时的 3777/3780）：把 Next 版 origin 下的 3 个键整体导出，注入本版 origin 后 reload —— 侧边栏列出 Next 版建的会话 `Reply with exactly: running`，点开消息历史完整渲染（用户消息 + 助手回复 `running`）。即两条宿主写出的数据可以互相读取。

注意：storage 按 origin 隔离（默认 dev 端口 4320，生产 4321）；两个宿主各自独立时按上面的方式搬键即可共享。因为默认实现当时跑在 3777 上，浏览器里原有的 3777 数据由本实现直接继承。

新增 `agent-workspace:live-workspaces:v1` 保存 `{ version: 1, threads: { [remoteId]: ... } }`，包含会话级 Agent、工作流、文档、技能、活动 Agent 与运行记录；不迁移、不覆盖原消息键。归档 Next 版不读取此新增能力。工作区资源快照与会话元数据是独立存储，清除站点全部数据时需要一起处理；资源不做跨设备同步，也不承诺多个标签页同时编辑的一致性。

## 原始宿主历史验证（本机，容器内）

| 项                                            | 结果                                                               |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `tsc --noEmit`                                | 0 error                                                            |
| `./docker.sh build`（容器）                   | ✓，且 `dist/` 无 root 属主文件                                     |
| `./docker.sh dev`（root + 只读源码 + 缓存卷） | ✓ `http://localhost:4320`                                          |
| hydrate                                       | 84 个 React fiber（同页在 Next dev 下只有 5 个）                   |
| 发消息                                        | "vite works" 流式返回；侧边栏生成标题                              |
| 多会话持久化                                  | reload → 点会话 → 2 条用户消息 + 引用块完整还原（3 个 storage 键） |
| 划词引用                                      | 选中 → 浮动 Quote → composer 预览 → 发送 → 用户消息引用块          |
| 设置                                          | 切 `deepseek-reasoner` → toolbar 徽标同步                          |
| 命令面板                                      | ⌘K 打开，7 条命令                                                  |
| 生产（`./docker.sh start`）                   | 静态 + `/api/chat` 流式 ✓；页面 hydrate ✓；字体变量生效            |
| 与 Next 数据互操作                            | 见上节                                                             |

## 已知事项

- Web 构建仍有大 chunk 提示，分组定义在 `apps/web/vite.config.ts` 的 `manualChunks`。下方性能数字属于原始宿主历史测量，不代表本轮拆包后的重新测速；本轮构建与运行验收见 [`MULTI-APP-PLAN.md`](./MULTI-APP-PLAN.md)。
- 纯 SPA：无 SSR/RSC（Next 版有），首屏为客户端渲染。
- `dev` 的 HMR websocket 走宿主 4320（`DEV_PORT` 可改），容器内 `--host 0.0.0.0` 已开。

## 设计语言

UI 采用 `../DESIGN-PATTERNS.md`（v0.1 设计提案）：暖中性表面 + 少量陶土色强调、按职责分层的圆角与密度、Composer/浮层的受控材质、交互/数据/运行时三条独立状态轴。采用范围、局部例外与验收证据（含两套主题的对比度实测）登记在 [`DESIGN-ADOPTION.md`](./DESIGN-ADOPTION.md)。

## 与 Next 版的历史性能对比（本机实测，冷缓存）

同一台机器，Next 生产（归档版，3790）vs 本版生产（3781），CDP 量 `encodedBodySize` 与探针时间点：

| 指标                                | Next 16 prod        | Vite prod              | Vite prod + 首屏骨架 |
| ----------------------------------- | ------------------- | ---------------------- | -------------------- |
| JS                                  | 2.14 MB / 11 个请求 | 1.70 MB / **1 个请求** | 1.70 MB / 1 个请求   |
| CSS                                 | 114.7 KB            | 103.1 KB               | 103.1 KB             |
| HTML                                | 29.2 KB（SSR 整页） | 0.96 KB（空壳）        | 3.3 KB（含内联骨架） |
| 本地 FCP                            | 148 ms              | 540 ms                 | 540 ms               |
| **3G FCP**（150 ms RTT / 1.6 Mbps） | 3.05 s              | **9.13 s（空白）**     | **1.34 s**           |
| **3G 可交互**                       | 11.91 s             | 9.12 s                 | 9.08 s               |
| 3G CLS（骨架→真实 UI）              | —                   | —                      | **0**                |

结论：Next 靠 SSR 先把外壳画出来（FCP 3.05 s），但 JS 更重、可交互更晚（11.9 s）；Vite 单包更小、可交互更早（9.1 s），代价是 JS 到位前空白 —— 因此在 `index.html` 里内联了一个纯 CSS 首屏骨架（不依赖任何产物），FCP 从 9.13 s 降到 1.34 s，CLS 仍为 0。至此两个指标都优于 Next 版。

其他实测结论：

- **dev 下 StrictMode 不会重复发送**：一次发送 = 1 条 user + 1 条 assistant + 1 个 `POST /api/chat`。
- **生产可在宿主原生跑**（无需 docker）：原宿主曾使用 Node 24.21 验证；当前分包版使用 `pnpm build && pnpm start`，不再直接执行旧 `server/index.ts` 路径。dev 仍建议 docker（inotify 配额）。
- 附件按钮与 `capabilities.attachments` 两个宿主一致（同一组件 + `useChatRuntime` 自带的 `vercelAttachmentAdapter`）；OS 文件选择器本体未做浏览器自动化验证（assistant-ui 的 file input 不在 DOM 里，工具无法驱动）。
