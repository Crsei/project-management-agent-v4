# Project Management Agent v4

统一 PM + Agent Chat 仓库。PM 保留项目/任务/文档与业务保护；PM 详情侧栏和 `/agent/workspace` 使用同一套 Agent Chat 界面、Provider 与会话运行时，不再运行第二个 PM 模型助手。Agent 展示 Session 侧栏、对话和 Composer，右侧按需展开 Files / Git / Terminal / Browser。工作区/项目来自真实 PM 授权目录，文件区域在服务端解析为本次 CLI 执行目录快照。没有新增角色/权限、业务 Session/Run/审批或自动完成任务规则。

本仓库是独立 v4 副本，不复用 v3 数据库或 Agent 数据，不接管来源服务。原生 Provider 按 t3code 规则使用 Agent 服务所在机器的 CLI 配置与账号；不会复制或导入来源仓库的凭据。[v3 任务及验收记录](V3-AGENT-CHAT-TASKS.zh.md) 是历史证据，不等于 v4 已验收。统一 Agent 与 PM 的实际交互面，以及与 `agent-pm-studio` 场景的历史差异，见 [Agent ↔ PM 交互矩阵](docs/implementation/agent-pm-interaction-matrix.zh.md)。

仓库级 [PM 分析 Skills](.agents/skills/README.md) 提供需求审阅、计划草稿、证据审阅和项目摘要，包含调用示例及行为评估案例。文件位于 `.agents/skills/`，默认只读分析或输出草稿；不代表 Chat 已自动加载，也不新增业务写入或后台自动化能力。

## 应用结构

- `apps/server`：PM API、Agent API、Worker 的独立运行角色及同源公共网关；业务规则仍归 domain/application。
- `apps/web`：PM 与 Agent 共用的 Web 工程和构建产物，浏览器及桌面复用。
- `apps/desktop`：Electron 宿主与本地服务组生命周期；`tools/marketing` 保留营销站源码。
- `packages` 保留领域、应用、基础设施、合同和 Agent 客户端运行时的既有职责。

桌面开发入口：完成下述依赖安装和本地 PostgreSQL、迁移及存储配置后，运行 `pnpm build:v4 && pnpm build:desktop`，再运行 `pnpm --filter @agent-workspace/desktop start`。桌面本地模式启动自己的完整服务组并等待实际就绪，不打包 PostgreSQL。安装包、签名、公证和其他平台尚未验收。

## v4 本机验证

- v3 完成后的提交 `2f21c0769de35f414d983fc3393e5b2feb44e03d` 是本副本源码基线。独立 PostgreSQL 中复制了账号和工作区；示例项目 34 个文件与来源一致，原数据库中项目附件对象路由数为 0。v4 CLI 读取到 `PRJ-001` 的 13 项任务。
- 统一 Web 的 lint、TypeScript 与 Vite 构建通过；Agent server 440 项、client runtime 11 项、desktop 5 项、网关及 Worker 隔离 4 项通过，均无跳过。文档与 OpenAPI 检查通过；具体完整后端回归结果以最终执行记录为准。
- Chromium 实际访问 PM 项目与 Agent 会话分组、自动化页面、390px 窄屏，项目 scope resolve 返回 v4 项目目录。终端 `pwd` 返回该目录；PM SSE 收到 `ready`，受控原生 CLI 的 Agent SSE 返回该目录并完成。受控 CLI 不是商业模型或真实供应商账号验收。
- 四角色本机服务组重启后项目和验证会话仍可读；桌面进程管理器实际启动 PM、Worker、Agent、网关并在退出后清理自身子进程。本机没有图形显示，未验收 Electron GUI、安装包、签名、公证或其他平台。

## 当前状态

已实现正式命令与 Markdown 核心接口；当前命令清单以生成合同为准。`project`、`work_item`、`milestone` 的读写进入 `/api/v1/workspaces/{workspaceId}/core`。本地模式的新项目写入所选目录的 `.pm/core/`，未迁移旧项目仍在共享工作区根；配置、统一 ID 和恢复台账继续归工作区所有。对话/意图/决策、成员能力、上传元数据/成果/证据/提交/审核及 Dashboard/项目协作附加记录使用 PostgreSQL，附件字节另存。核心命令收据同样写入 `command_receipts`，创建以 `commandId` 幂等。当前服务为本机后端部署，不将此结果等同于完整生产发布验收。

已新增 Files 显示名/软隐藏/恢复/指定版本独立复制、站内定向通知及持久共享事实、可信恢复邮箱与密码找回、私有 S3 BlobStore/停写维护，以及受限出站 Webhook。源码交付、隔离真实验收和生产启用分别记录，见[五工作包状态](docs/implementation/service-completion-and-acceptance.zh.md#five-package-delivery)。本批次不自动升级或重启既有业务实例；未配置的邮件/S3/Webhook 不能显示为就绪。

| 接口 | 当前行为 |
| --- | --- |
| `GET /health/live` | 200：API 进程可响应 |
| `GET /health/ready` | 数据库 schema、内容卷、Markdown 核心根目录、Worker 心跳和失败隔离均正常时 200，否则 503 |
| `GET /api/v1/capabilities` | 按实际配置分别声明能力；配置/初始化不代表依赖已就绪、邮件送达或接收器可达；execution 始终 false |
| `GET /openapi.json` | 现行 OpenAPI3.1；接口路径与严格命令 payload 以生成合同为准 |
| `/api/v1/workspaces/{id}/core/*` | Markdown 核心：protocol/config/workspace/query/graph/files/entities/lifecycle/context/views/migrations/SSE |

接口契约见 [openapi.yaml](docs/contracts/openapi.yaml)，Node/浏览器客户端见 [client.ts](packages/contracts/src/client.ts)。命令统一提交到 `/api/v1/workspaces/{workspaceId}/commands`；实体读取、收据查询、changes/SSE、成果下载使用各自接口。客户端写入不自动重试，丢响应后按原 commandId 查询。

## 本地启动

要求 Linux、Node.js 24 LTS、pnpm 11.9.0、Docker 与 Compose。在本项目根目录对**全新 v4 空库**执行：

```bash
pnpm install --frozen-lockfile
pnpm setup:local
pnpm db:up
pnpm db:migrate
pnpm bootstrap
pnpm build:v4
# setup 生成的描述符与默认 .local/blobs 一致；改过 BLOB_ROOT 时先同步描述符。
pnpm storage bind --new --stopped --target-config .local/blob-target.json
pnpm services:start
pnpm services:status
```

默认公共入口 `http://127.0.0.1:3224/pm`（同端口的 `http://localhost:3224/pm` 等价，便于端口转发访问）；PM API `4194`、Agent API `4325`、Web 开发上游 `4326`、PostgreSQL `55444`。数据库 Compose 名称 `project-management-agent-v4-backend`，应用 Compose 名称 `project-management-agent-v4-app`。不要连接来源副本的端口/卷。

`setup:local` 生成并保留已有 0600 的 `.env`、`.env.worker`、`.env.agent`，只为新 v4 生成数据库密码；不会复制秘密或导入 `~/.codex`、`~/.claude`、`~/.gemini`。PM Markdown、附件、可信目录配置、Agent SQLite 和应用管理的运行时 / 账号状态在本仓 `.local/` 下；原生 CLI Home 不再强制迁入其中。Worker 只取得自身角色配置；Agent 继承启动环境并叠加 `.env.agent`，原生子进程仍排除 PM / 数据库等应用私有变量。首次存储绑定不能因目录存在而省略；已有数据不能执行上面的 `--new`。

本机按用户明确授权复制了 v3 工作区 `e317b803-5c03-4eb9-a7d9-79d7a38927bf`、项目 `PRJ-001`、账号及其项目数据到 v4 独立目录与数据库；新安装不会自动导入。Provider 原生进程可直接使用服务用户既有 CLI 账号，但不复制账号文件。

`services:start` 启动 PM API、Worker、Agent API 与托管统一 Web 产物的公共网关；`services:status` 报告进程与 HTTP 可达性，**不把 HTTP 就绪当 Provider/CLI 执行通过**。`services:stop` 只向记录中的 PID、启动时间、工作目录和允许入口均匹配的本仓进程发送 SIGTERM，不删除数据库、不按端口杀进程。日志为 `.local/logs/`。

宿主 inotify 限额不足时使用 `CHOKIDAR_USEPOLLING=true pnpm services:start` 或 `CHOKIDAR_USEPOLLING=true pnpm dev:v4`；服务管理器不会给已运行进程更新环境。健康检查不能替代真实工作区目录读取。

```bash
pnpm dev:v4          # 统一 Web HMR；后端改动后重启
pnpm services:status
# Ctrl-C 只停止本次 dev:v4 启动的自身进程
pnpm services:stop   # 停止本仓管理器记录的自身进程，切换 built/dev 模式前执行
curl http://127.0.0.1:3224/health/live
curl -i http://127.0.0.1:3224/health/ready
curl http://127.0.0.1:3224/agent/api/access
```

PM Cookie 为 `pm_v4_session`，Agent Cookie 为 `agent_v4_access`；原 same-origin、认证、目录 allowedRoots 与 WS upgrade 检查保留。未配置模型时明确报错或禁用，不生成假回复。

### 本地项目目录与初始化

本批不新增云端同步、多实例或业务执行规则。`pnpm setup:local` 生成并保留已有 `.local/local-projects.json`，新配置默认只允许 `.local/projects`。需要选择其他代码目录时，本机管理员先把真实绝对父目录加入 `allowedRoots`；浏览器输入路径不能扩大授权范围。配置更改须在受控升级/重启时生效，不自动迁移文件。

进入 `/pm/<workspace>/settings?section=local-storage` 查看实际核心/备份路径并设置默认项目父目录。新建项目可在该父目录下新建文件夹，或使用已有目录；必须先预检最终路径。初始化稳定项目 ID、身份标记、项目 Markdown、工作流初始状态、空任务/文档目录、附件绑定和恢复记录；不改原 README/代码，不建样例任务、不初始化 Git。

新建项目使用参考 gr8r-studio 的专用表单：名称、Markdown 描述、图标、颜色、真实负责人及目标日期随首次创建保存；支持 Ctrl/Cmd+Enter，输入法组合期间不提交。保存位置与最终路径预检保留，初始化说明和高级属性可展开。团队需在创建后的项目设置中独立关联；模板目前仅开放空白项目，其余明确禁用，不自动生成样例任务。取消或刷新保留原创建草稿，未知结果仍按原请求核对。

| 数据 | 本地保存位置 |
| --- | --- |
| 新项目 Markdown 与附件字节 | 所选目录下 `.pm/core/`、`.pm/attachments/`；身份标记 `.pm/project.json` |
| 工作区配置、统一 ID、目录映射与恢复台账 | `CORE_WORKSPACE_ROOT/<workspaceId>/`，默认 `.local/pm-workspaces/<workspaceId>/` |
| 账号、权限、评论、审核、审计、命令收据、附件元数据 | PostgreSQL；物理数据库卷独立于项目目录 |
| 旧项目及历史附件 | 原核心根与原 Local/S3；仅显式迁移改变定位，切换项目不会改全局 `BLOB_ROOT` |
| 完整备份 | `LOCAL_BACKUP_ROOT`，默认应用数据基目录下 `backups/`；包含 SQL、共享台账、全部登记项目托管文件与引用附件 |

项目详情支持目录状态、复制路径、显式迁移、托管移动及找回已由用户移动的原目录。缺盘不会创建空替代目录；未知结果先核对原请求，显式恢复仍使用原键和冻结输入。项目文件夹不是完整备份。准确配置、停写维护和恢复命令见[部署手册](deploy/README.md)，实施与验收见[本地项目存储计划](docs/implementation/local-project-storage-plan.zh.md)。

### 浏览器应用与组件展示

后端启动后，在根目录另开终端：

```bash
pnpm dev:web       # 仅启动统一 Web 开发上游；完整同源入口使用 pnpm dev:v4
pnpm storybook     # http://127.0.0.1:6017，独立组件样例
```

`/pm` 使用本机账号手工登录，再选择实际授权工作区；浏览器不读取访问文件，无权限或后端失败不回退示例。公共网关将 `/api`、`/health`、`/openapi.json` 转发 PM API，将 `/agent/api/*` 去除 `/agent` 转发 Agent API，页面与资源来自统一 Web 构建，流不缓冲并保留 WebSocket。

隔离端口通过本地角色配置与 `PUBLIC_HOST`、`PUBLIC_PORT`、`PM_URL`、`AGENT_URL` 设置；不要把服务秘密放进 `VITE_*`。生产 Caddy 使用等价代理；部署见[手册](deploy/README.md)。

PM 左侧栏底部在账号上方提供“设置”入口，展开、折叠图标栏与手机抽屉均保留当前工作区路径及设置子页选中态；不再展示“已连接”按钮及其服务状态弹层。底层连接、离线 / 错误 / 快照过期提示与未知写入恢复仍保留。

`/pm/<workspace>/settings/design-system` 为设置内的“设计系统”，桌面导航和窄屏页面选择器均可进入。参考 gr8r-studio 的顺序展示颜色、状态与优先级、字体、间距 / 圆角 / 阴影、按钮、输入、导航、数据展示、反馈和图标，复用本仓真实主题令牌及组件。示例交互只改变页面局部状态，不创建任务、删除项目或发出业务写请求，离页重置；主题切换沿用全站 PM 浏览器偏好。此次未改会话与持久化设计，仍暂沿用 Agent Chat 保存方式，尚待统一设计收口。

本轮在临时 Web 4337 对接本副本服务，已验证正式 Design System 路由刷新、2560×1440 / 1440×900 / 390×844 布局、主题切换、示例菜单 / 校验 / 对话框 / 抽屉 / 确认 / 命令菜单及侧栏设置入口。Lint 与新增页面的 LSP 诊断通过；完整类型检查和独立 Vite 打包被未修改的 `provider-instance-dialog.tsx:365` JSX 语法错误阻断，尚未更新常驻 Web 产物。

### Agent Chat

左上产品切换进入 `/agent/workspace?workspace=<真实ID>`。侧栏顶部集中搜索、作用域筛选、工作区/项目选择与新建会话；选择器展示真实授权目录，包括没有会话的工作区和项目。新会话先绑定作用域，服务端接受生成时重新核验目录并持久化快照，原生 Agent 使用该目录；目录不是权限或沙箱。无 scope 的旧会话只查看，不猜归属。选择器内的文件区域设置可使用现有目录或显式新建目录。目录优先级为已保存映射、已登记本地项目目录、Chat Space 默认目录；已有目录不自动迁移。Provider 在 `/agent/settings/providers` 配置，原生 Home 留空时沿用服务端 CLI 环境和账号；受管 ChatGPT 使用应用私有账号状态。旧 API Provider 历史只读保留，继续发送须显式选择原生 Agent，不自动替换模型。离页保留草稿保护，不自动取消后台生成。主题直接复用 PM 偏好存储，首次切换、刷新和双产品导航保持一致。范围、合同、已执行检查与剩余验收边界见[任务记录](V3-AGENT-CHAT-TASKS.zh.md)。

会话行支持右键或省略号菜单：Pin、Settle、Snooze、重命名、隔离生成标题、未读、项目筛选、Auto-settle、复制、项目设置、Archive 与 Delete。列表按“置顶 / 活跃 / 稍后提醒 / 已归置”平铺，每行显示作用域、时间、标题及 Provider；作用域筛选只过滤列表，不改写当前会话归属。归置不是归档，更不代表 PM 工作完成。状态由服务端持久化并用独立 revision 防止覆盖；自动归置为默认 3 天无活动，不在运行成功时立即执行。归档可从 `/agent/settings/history` 恢复，删除需要确认且不可恢复；运行中不能归档或删除。标题重生成仅对具备隔离无工具调用能力的 Codex / Claude 开放，不修改原消息或原生会话游标。

主页沿用 t3code 的排列：自动化为独立横向导航行；设置、用量、快捷键工具栏位于登录信息上方。顶栏集中面包屑、侧栏开关、会话详情、终端和右侧面板；Files / Git / Terminal / Browser 标签仅在面板打开后出现。详情显示实际作用域、文件区域与会话参数入口，`Ctrl / ⌘ + Shift + B` 切换；内嵌页保留展开、关闭和 PM 返回上下文，窄屏使用侧栏抽屉。

新会话及成功读取的空历史显示项目化欢迎区和居中输入框，已有消息时输入框停靠底部。Composer 左侧排列模型、原生能力选项和交互模式，右侧放任务引用、附件、可选听写及发送/停止；引用芯片仅在存在引用时占行。历史读取失败明确阻止发送并提供“刷新重试”，不冒充空会话；刷新仍遵循现有文字草稿恢复和附件/引用丢失提醒，不新增持久化协议。

当前只面向本机单操作者适配；尚未按 PM 成员建立 Agent 会话所有权隔离。不要将本次目录绑定视作多用户授权或文件沙箱，也不要据此开放公网使用。权限、审批和业务边界按本次要求留待后续沟通。

#### Chat Space 保存位置与检查器

默认根目录为运行 PM API 的用户主目录下 `~/.pmv4`，不是浏览器电脑或仓库根目录。通过 PM API 环境变量 `PM_CHAT_SPACE_ROOT`（程序入口 `buildApp({ chatSpaceRoot })`）指定绝对路径；服务管理器只向 PM API 转发此覆盖。`/agent/settings/file-areas` 可在现有可信根目录内按工作区更改默认保存根目录，携带 revision 保存，冲突或结果未知时先重读。设置只影响将来首次分配的默认区域，不移动已有目录、PM 数据库、Agent SQLite 或 Provider homes。

```text
<默认保存根目录>/workspaces/<workspaceId>/workspace/
<默认保存根目录>/workspaces/<workspaceId>/projects/<projectId>/
```

目录册读取不创建目录；安全且未分配的默认区域显示“首次使用时创建”，首次有权解析才创建并登记设备/inode 身份。父目录缺失、软链接、越界或已登记目录丢失时拒绝，不重建丢失磁盘、不回退仓库根目录。文件和 Git 只读；终端为真实本机 shell，不是隔离沙箱。Inspector HTTP / WebSocket 请求必须携带 `workspaceId`、可选 `projectId`，已持久会话另带 `threadId` 核验绑定；每次由 PM 使用当前请求身份解析。终端连接固定本次 cwd，切换会话/目录或关闭面板即断开，聊天后台生成不因此取消。顶栏提供“切换终端抽屉”和“切换右侧面板”按钮，分别对应 `Ctrl / ⌘ + J`、`Ctrl / ⌘ + Alt + B`；抽屉高度可拖动或键盘调整并保存在当前浏览器。网页预览保留 iframe sandbox，不放开同源权限。

v3 历史目录检查器验收与 inotify 故障记录见[任务记录](V3-AGENT-CHAT-TASKS.zh.md)，不能作为 v4 的实际运行证据。

若已打开的页面在更新后点击面板出现“页面暂时不可用”，还需检查动态模块请求，而不是重发消息。本机 Web 重建现在保留旧哈希资源，避免已打开页面依赖的模块被删除；历史资源只在停机维护时清理，见[部署手册](deploy/README.md)。修复前已经缺失的模块仍需手动重新加载一次页面；不会自动提交、重试消息或取消后台生成。

#### Chat 设置

统一入口为 `/agent/settings/general`；设置页共用导航、作用范围标识和未保存 / 保存中离页保护。这里的服务配置适用于本机 Agent 的全部工作区 / 项目，不是新增的 PM 权限或项目级 Provider 覆盖。

设置布局参考 t3code 的“全宽外壳与独立正文宽度”分层：PM 设置导航贴齐主工作区左侧内边距，不再与正文一起限制在 1440px 居中容器；Agent 设置侧栏保持贴左，正文紧随侧栏左对齐。两者正文最大宽度为 1160px，避免超宽表单；窄屏保留 PM 页面选择器与 Agent 横向导航，不按 2560×1440 固定比例缩放。已在临时 Web 4336 对接本副本服务验证 2560×1440、1440×900 和 390px 视口的对齐、页面切换与横向溢出；未更改保存、权限或会话持久化。此次 lint 通过，完整类型检查与独立打包分别被未修改的 `team-list-3-content.tsx` 缺失 `DropdownMenu*` 标识符、`team-list-1-content.tsx` 语句粘连阻断，尚未更新常驻 3224 的 Web 产物。

| 页面 / 入口 | 实际配置与边界 |
| --- | --- |
| 通用 | 持久保存新会话默认 Provider / 模型、模型能力选项和交互模式；仅创建时快照，不改写历史会话。可明确不设置默认值；失效选择不自动替换，发送前必须显式选择有效模型 |
| 提供商 | 按 t3code 原生驱动定义配置、启停、认证与显式维护运行环境；内置、实际发现和显式登记的自定义模型共用执行校验。安装 / 版本、实际认证及最近状态检查分开展示；健康刷新间隔默认300秒，0关闭；revision 变更使旧检查失效，模型目录不代表付费推理成功 |
| 输入框模型选择器 | 沿用 t3code 的紧凑触发器、提供商侧栏、跨提供商搜索、收藏与键盘操作；隐藏、排序、收藏和模型默认选项按实例保存于本机 Agent 服务，设置页与各浏览器共享。直接保存当前会话，不更改新会话默认值；失效选择不自动替换 |
| 当前会话参数 | 模型右侧直接显示当前思考程度（如 Extra High = `xhigh`）；点击后按 t3code 的分组单选菜单选择原生声明的档位和其他 select / boolean 能力，保存成功后关闭；default / plan 由相邻独立按钮切换。共用当前会话原子保存和 revision 检查，不改新会话默认值；失败保留修改并提供重试、阻止发送，不凭空生成 reasoning 档位。system prompt 与支持的 temperature 仍由会话参数编辑 |
| 输入与快捷键 | Enter 或 Ctrl/Cmd+Enter 发送，保留 IME 组合输入；Ctrl/Cmd+Shift+O 新会话、Ctrl/Cmd+K 搜索、Ctrl/Cmd+. 停止、`?` 帮助。输入和弹窗不触发全局快捷键；停止需服务端确认 |
| 外观 | 主题 / 跟随系统、减少动态效果、侧栏密度复用 PM 浏览器偏好；Agent 正文字号、内容宽度、代码换行仅影响阅读，不改写消息 |
| 文件区域 | 汇总真实授权工作区 / 项目、空组、路径来源、状态和 revision；保存继续使用既有权限、allowedRoots 和版本检查 |
| 历史与归档 | 归档保留历史，恢复到原工作区 / 项目；运行中不可归档。恢复 / 删除重新核验原范围，永久删除需明确确认 |
| 诊断、数据与存储 | 展示实际版本、SQLite 所有权 / 完整性 / 计数、最近失败类别及私有目录；安全诊断下载采用状态白名单，不导出消息、提示词、凭据、目录或原始日志 |

Provider 集合为 Codex、Claude、Cursor、Grok、FX、OpenCode、Antigravity、Muse Code、Pi、ACP Registry。初始化仍只持久创建 Codex / Claude；其他默认位仅在已配置、有效启用或定向访问时显示，浏览页面不创建实例。FX 位于“显示更多”，ACP Registry 为独立搜索 / 准备入口；Registry 先显式准备，再填写身份并按协议认证，local 命令走较短路径。实例 ID 固定、字母开头、最多64字符，显示名称可清空回退驱动名；默认实例可重置，额外实例可删除。普通字段失焦或 Enter 保存，环境变量和模型显式保存。非敏感环境变量可回显编辑，敏感值遮蔽且空值回传保留；旧环境变量默认按敏感值迁移。模型段统一管理隐藏、排序、收藏、自定义能力选项；Antigravity 不开放自定义模型。独立 OpenAI / Anthropic / DeepSeek API 卡片及新执行入口不恢复，原始历史和私有凭据不删除。

适配以 `t3code@30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c` 为配置与协议基准；MIT 归属见 [LICENSE.t3code](LICENSE.t3code)。Codex 通过“使用现有 CLI”与“继续使用 ChatGPT”进入对应流程，不再展示模式下拉框。existing 复用原生配置 / 外部认证，可使用 API Key 或第三方服务，不强制 ChatGPT 登录；managed 使用受管运行时、ChatGPT 多账号 OAuth / token broker，私有状态保留在本副本 `provider-homes`。Claude 的四种 idle compaction 模式接入实际宿主调度并重新核验 PM 范围；Cursor 的 `CURSOR_API_KEY` 位于专属 Setup，填写密钥后隐藏浏览器登录，清除并保存后恢复该入口。Grok / FX / Muse / Pi 与 existing Codex / Claude / OpenCode 遵循来源的外部认证边界，不另造应用内登录 / 登出。

安装、更新、取消与移除仅对实际支持的驱动开放；“继续使用 ChatGPT”先准备运行时，再发起登录，只读检查或发送消息不会自动下载。维护与认证 / 执行互斥。原生 Home 留空时继承宿主规则，显式 Home 和实例环境覆盖对应配置，不重写进程 HOME / XDG，也不清除宿主 Provider 凭据。应用自有状态与原生 Home 分离，重置、删除和备份不收集、创建或删除外部 Home。PM 作用域、审批与完成规则不变。

当前配置流程、实际执行及发布记录见 [t3code Provider 原生流程切换](docs/reference/t3code-provider-config-diff-30eb7e7bb1.zh.md#v4-native-provider-flow)。原调查和前两轮实施保留为历史记录；旧的强制独立 Home 与配置文件教程已被替换。

原模块移植见 [t3code Provider 模块移植计划清单](docs/implementation/t3code-provider-module-migration-plan.zh.md)：固定上游源码、分阶段切片与 `gpt-6.1-sol / xhigh` 派发及验收约定。十类Provider、客户端模型/配置/Composer、原生Usage、数据连续性及离线同步已接入；14个完整原包位于 `vendor/t3code/packages`，选入的原server模块位于 `vendor/t3code/apps/server`，根目录 `packages/agent-*` 是PM宿主边界，不是重复Provider实现。最终审查与本副本Web/Agent受控发布已完成；发布后OpenCode真实调用、原生续聊、重启后续聊及项目内嵌Chat的只读PM工具均通过。其他提供商真实账号、额度及全仓库后端检查仍有明确限制，不能用模块测试替代账号验收；详见计划执行记录。会话与持久化仍沿用现有Agent Chat保存方式，未完成统一设计。

##### 配置并使用 Provider

1. 在“提供商”选择已有实例，或“添加提供商”。Codex 选择“使用现有 CLI”复用服务所在机器的原生配置；只有选择“继续使用 ChatGPT”才走受管账号连接。
2. 原生 CLI 已可用时，无需填写 Home 或重复登录。需要覆盖时，使用驱动提供的 Runtime、Launch arguments 和 Environment；实例变量覆盖同名宿主变量，敏感值只写入、不回显。页面不展示额外 `config.toml` 路径或要求编辑配置文件。
3. 保存后“检查 Agent”，回到会话选择 Provider / 模型并发送消息。新会话未设置默认模型时，选择器也会展示可用 Provider 的模型；浏览列表不自动选中，须明确点选后才保存当前会话选择。原生 `account/read` 明确 `requiresOpenaiAuth=false` 时可就绪、身份仍未知；缺失 / 非法报告和真实认证失败不推断成功。managed 仍要求有效 ChatGPT profile。

状态检查不执行计费推理，不能证明远端接口、密钥或模型可用。本轮已通过宿主原生配置调用 `gpt-6.1-sol` 并获得真实回复；本机 ChatGPT 登录 discovery 返回 HTTP 403，受管 OAuth 尚未完成真实账号验收。其他供应商账号、额度和平台专属能力不因此自动算通过。

本机发布记录（2026-10-29）：`3224` 已使用新 Web / Agent，实际 Codex 检查成功。现有 PM `/health/ready` 仍返回503，只读核查为尚未应用的 `0039_document_sources.sql`；本轮未执行这项无关迁移，也未重启 PM API / Worker / 网关。Provider 可用不能替代整套 PM 的就绪判定。

#### Provider 运行输出

十类原生驱动共用按 generation 排序的输出投影；前端按原生协议实际事件显示回复、可折叠思考、工具输入/结果、命令终端、文件 diff、搜索、计划、子代理、上下文压缩与失败状态，未报告的能力不补造。旧历史继续原有正文显示，新输出不会再重复显示一份纯文本回复。

- Composer“更多输入选项”中的“逐段 / 整轮”只改变显示时机。逐段按完整 Markdown 边界约 400ms 释放；整轮在结束时展示正文，工具过程仍实时显示；错误和取消保留已收到的内容。
- 输出投影保存在 Agent SQLite，SSE 以序号和完整快照恢复；断开页面不取消原生执行。条目更新约 50ms 合并，慢消费者重置为快照，不无限积压。
- 命令仅在展开时单独订阅，约 100ms 合并输出；折叠释放订阅但不停止命令。终端处理 ANSI、回车覆盖和跨块控制序列，尾部有界且标明截断，最终结果持久保存。工具没有实时命令协议时只显示实际最终结果。
- Codex、OpenCode、Grok、Muse 的明确**信息提问**可回答或取消；重复、过期和不匹配回答被拒绝，服务重启后失去原生回调的请求不可回答。回答本身不写入输出投影。原有命令/文件/权限审批继续拒绝；Pi 通用扩展 UI、ACP 含义不明确的 elicitation 不自动当成安全提问放行。

端点、源码归属、各驱动限制和验收记录见[运行输出移植计划](docs/implementation/v3-provider-output-plan.zh.md)。该功能不新增 PM 权限或业务完成规则；受控原生协议验证不代表真实供应商账号和模型已验收。

#### Usage 用量与额度

- Agent Chat 左下角侧栏的“用量”进入 `/agent/settings/usage`：紧凑顶栏、Cost / Tokens / Limits、24小时及7/30/90天、实例和 Provider 筛选。概览包含 Provider 汇总与平滑趋势、五项 Totals、缓存/速度费用分解，以及 Model / Day / Hour 明细。成本是 API 等价估算，不是订阅账单；未定价记录保留 token 并明确标记，不当成免费。旧的 `/agent/usage` 保留为跳转到该路由的兼容地址。
- 历史读取 Codex、Claude、Grok、Pi JSONL，以及 OpenCode、Antigravity、Muse 的原生存储；Cursor 使用账号 Dashboard 数据，不从本地对话估算。目录依据生效的原生 Home / 环境变量定位，包含已停用实例的历史；ACP / FX 没有通用历史扫描格式，FX 不推测历史用量。扫描缓存支持重启、追加与文件身份失效，容量与保留期有界，不能恢复已被淘汰的原生历史。Codex 速度档位仅从匹配的原生记录或冻结启动记录补全，不拿当前会话选项改写历史。
- 公开价格缓存、自定义价格和模型别名在 `/agent/settings/usage/config` 配置；保存使 Usage 查询失效，revision 冲突保留草稿。Limits 展示真实账号/窗口快照、剩余额度、重置时间和支持的 reset credits。页面自动检查有5分钟间隔，显式刷新另行执行；失败保留旧数据及其原有效时间，不伪装成新快照或推测已补满。CLIProxyAPI Hub 的管理密钥只写入、不回显，使用重置 credit 必须明确确认；动作成功但回读失败与动作结果未知分开呈现，均不自动重复兑换。
- 输入框不再显示上下文 token / 进度、费用估算或本轮供应商用量，也不再轮询会话用量；后台原生记账和独立“用量”页保留。`/usage-limits` 仍可显式读取现有额度快照，不执行模型、不自动探测或隐藏刷新。
- Cursor Keychain 只在明确启用、macOS 与对应原生认证条件满足时可用；不会自动导入全局账号。离线备份 `--secrets exclude` 清除 Hub 密钥、停用恢复的 Hub，并排除 Cursor 账号历史缓存；`include` 仍需显式离线授权。

本轮数据链路补齐、逐 Provider 对照、受控浏览器与工程验收见 [v4 Usage 复刻实施记录](docs/implementation/v4-usage-page-replica-plan.zh.md#8-实施与验收记录2026-10-30)；[原 Usage 移植计划](docs/implementation/v3-usage-plan.zh.md)保留为历史。真实供应商账单、额度及 macOS Keychain 尚未实际验收；Provider 执行与发布的最新结果以[原生流程切换记录](docs/reference/t3code-provider-config-diff-30eb7e7bb1.zh.md#v4-native-provider-flow)为准。

#### Agent 离线备份与恢复

先核对所属 PID、工作目录和服务，再停止**本副本 Agent**；工具不会替你停止进程。数据目录从“数据与存储”读取，备份目录与恢复目标必须和源目录分离，恢复目标必须为空。不要对运行中的目录直接打包 SQLite。

```bash
pnpm agent:backup create --source <Agent数据目录> --bundle <新的私有备份目录> --secrets exclude --stopped
pnpm agent:backup restore --bundle <私有备份目录> --target <独立空目录> --stopped
pnpm agent:backup:verify --bundle <私有备份目录> --target <恢复目录> --stopped
```

必须显式选择 `--secrets exclude` 或 `--secrets include`。两种备份都包含私有会话及 `provider-attachments` 内的Agent附件，目录 / 文件权限为 0700 / 0600，不能放在公共 Web 根目录。`exclude` 保留一致的会话、历史、设置和模型配置，但排除凭据、`provider-private` 凭据/环境身份、实例环境、原生私有配置及应用自有 home，清除原生续聊引用并停用恢复的实例；恢复后必须明确检查原生配置并启用。`include` 纳入上述私有凭据/身份、私有实例配置及数据目录内部的应用自有 homes；外部 Home 只保留路径引用，不收集其内容，恢复时也不创建该目录；应用目录内的符号链接仍被拒绝。可重建的 `provider-cache` 探测缓存不进入任一备份；两种模式均不修改原始数据。

恢复时同样核验 `exclude` 策略：原生实例必须明确为 `enabled:false`，不得携带旧 `cliHome` 覆盖；缺失禁用标志也会拒绝，即使备份文件摘要已重新计算。拒绝发生在创建恢复目标之前。

工具校验文件摘要、SQLite 一致快照和记录覆盖，拒绝活跃 / 陈旧锁、不明确的文件、路径穿越及非空目标；不通过 HTTP 提供秘密备份。Agent 备份包含 Chat 保存的 PM 工具结果和核心文件差异快照，仍**不包含完整权威 PM 数据**：PostgreSQL、Markdown 根目录、PM附件、用户项目源码、`.env.agent`、浏览器登录或全局 / 外部 CLI home 不在其中；PM 仍需既有完整备份流程。恢复校验通过不代表 Provider 已登录、PM 范围已获授权或真实模型可执行。

### 统一 Agent Chat 与 PM 工具

PM 侧栏与完整 Chat 页共享会话、模型选择、生成订阅和草稿交接；会话列表、历史、取消、归档及删除全部归 Agent Chat。旧 `/pm/<workspace>/agent` 仅重定向到 Chat，不映射旧 PM 线程。模型统一使用 Chat Provider，不再读取 `AGENT_CHAT_BASE_URL/MODEL/API_KEY`。**会话与持久化尚未经过统一设计，当前暂沿用 Agent Chat。**

17 个 PM 工具共用一个注册表和执行入口：查询/读取，项目与任务创建及普通字段修改，文档创建/保存，评论读取/创建，关系读取/添加/删除，以及任务归档、恢复、永久删除和状态转换。Codex、Claude、Cursor、Grok、OpenCode、Antigravity、Muse、Pi、ACP Registry 通过原生 MCP 或 Pi 工具扩展接入，同一代生成还提供统一 CLI。Provider 工具配置随生成建立，标题生成和空闲压缩不获得业务工具。接入源码不等于真实供应商账号已验收。

PM API 的 `/api/v1/workspaces/:workspaceId/agent-tools` 提供注册表，`/call` 执行，`/result` 核对原结果。Chat 只在内存中转发本次 PM 请求认证信息，不创建第二套工具凭据，不把 Cookie/Authorization 保存进会话或放进 Provider 环境。PM 仍在服务端检查成员、项目 scope、原生能力、revision、幂等键、关系防环和领域规则；目录不是权限或沙箱。

工具卡显示状态、来源、revision、收据和原对象链接。写入结果未知时只核对原 operationId 的原收据，不自动重派，也不把后来修改的对象冒充原结果。停止生成只阻止后续派发，不回滚已经提交的业务修改。PM 工具不开放完成/重开等生命周期、删除/归档、跨项目移动、ACL 或任意 shell；Provider 自己的本地执行能力不因此成为 PM 授权。

Chat 的“PM 核心文件变更记录”保存已登记共享/独立核心目录的文件新增、修改、删除及前后内容，非 Git 目录和无效 Markdown 也可观察。记录是观测快照，不是完整 Git 历史或防绕过审计；无法证明操作来源时不归因给某次工具调用。当前认证活动后保持短期轮询；重启后需新的合法请求恢复扫描，权限丢失或不完整快照不得推断删除。界面明确区分正在观测、空闲、过期、不完整和失败。

开发阶段迁移 `0038_unified_agent_tools.sql` 定向移除旧 PM 聊天数据表，不迁移旧 PM 历史；PM 业务对象、审计、命令收据及原有 Agent Chat 历史保留。实施范围、文件合同和实际验收见[统一改造计划](docs/implementation/agent-chat-pm-unification-plan.zh.md)。候选提案、批量审核、业务 Run/审批与自动完成任务不在本次范围。

### 自动化规则与报告

`/agent/workspace?workspace=<id>&view=automations` 从 Agent Chat 侧栏独立的“自动化”导航行进入；它不是会话记录，也不与对话组成双页签。支持本人规则的创建、编辑、删除、启停、只读测试、明确运行、搜索筛选及分页运行历史。项目必须显式选择；规则和不可变报告保存在 PostgreSQL，任务仍以 Markdown 为权威。新规则只保存为草稿；测试未保存配置不会创建运行、调用模型或修改任务。

支持手动或每日定时触发、IANA 时区、每日运行上限和冷却时间。实际动作是对未完成、逾期或受阻任务生成只读观测报告，保留当时配置、来源任务 ID/revision 和原对象链接。自动化不代表 Agent Session/Run，更不会改变任务完成状态；模型分析、Host 工具和外部通知/连接器仍明确禁用。

规则编辑采用独立规则侧栏、报告内容与运行时间两步布局，限额设置默认折叠；运行历史按日期分组，可按规则筛选并在行内展开结果与运行配置。页面沿用 Agent Chat/PM 共用的语义色 token、12/14/20px 字号和 0.5px 边框，不再加载第二套 Radix 色阶；配色和字号只作用于该视图，不影响对话页。普通保存、暂停直接提交，启用、正式运行和删除保留确认；按实际面板宽度切换紧凑布局，窄屏与 PM 内嵌页的已保存规则列表默认折叠。未保存草稿、待核对请求及存储错误在切换会话、离开自动化、展开/关闭内嵌页和浏览器前进/后退时保留离页保护；同一路径的查询参数切换也受保护。

Worker 独立执行到期规则，关闭页面不停止调度。夏令时缺失时刻跳过、重复时刻使用第一次；跨日错过的检查记为跳过，不补发历史批次。预算按规则当地日期计算，手动与定时正式运行共同计入预算，测试不消耗预算。专用调度心跳与 API/普通 Worker 健康分开；旧 Worker 的存活不代表自动化就绪。

所有读写与后台执行重新检查当前主体和项目授权；更新携带 revision，未知响应保留原请求键并查询原收据，刷新不重发。删除规则保留不可变历史；项目归档后禁止启用与运行，但仍允许有权用户暂停、删除规则。部署需要迁移 `0034_automation.sql` 并更新本副本 API/Worker；不连接来源副本。实现与本次验收见[执行计划补充记录](EXECUTION-PLAN.zh.md#automation-page-delivery)。

认证入口使用独立全窗口登录页，支持密码显隐、字段校验和本地化反馈；登录后进入授权工作区选择。登录响应未知时先检查当前会话，不自动重发。账号由管理员或有效邀请创建，未开放公开注册或第三方登录。`/pm/account/security`、`/pm/account/recovery` 和恢复邮箱确认页不依赖工作区；配置邮件能力且本人独立验证恢复邮箱后才可自助找回，历史登录邮箱/邀请不自动算可信证明。

正式应用以工作区为稳定外壳：侧栏顶部切换实际授权工作区，依次排列个人入口、工作区聚合入口和授权项目树，底部保留账号与可展开的连接状态。内容区只有一条上下文顶栏；主题、语言、页面变体、设置与个人白板可从“页面与外观选项”进入，工作区菜单另有设置及按权限显示的成员入口。项目可独立展开看板、列表、时间线、文件，展示真实状态和个人收藏；展开偏好按账号和工作区隔离。工作区全部任务、日历、时间线跨授权项目汇总并显示归属；项目页固定项目，工作区的项目筛选可清除。工作区创建需选择所属项目，项目创建预填并锁定项目。跨工作区使用整页导航，释放旧查询与订阅；未保存编辑和创建草稿保留离开提示及恢复机制，浏览器存储失败时须先重试保存，避免强制离开丢失内存输入。设计、分工与实际验收见[工作区导航改造记录](docs/implementation/workspace-navigation-plan.zh.md)。

项目侧栏、列表和详情共用真实项目 `…` 菜单：打开、个人收藏、重命名与编辑、分享、复制链接、复制项目、侧栏上移/下移、归档及删除。排序按账号/工作区在服务端保存；分享复用实际成员范围，不提供公开访问。复制使用新 ID 和新目录，重映射所选任务关系，不复制历史、权限、附件或用户代码；未知响应先查原收据，未完成复制只能显式恢复原请求。`/projects?archive=archived` 提供恢复入口；永久删除须已归档、无引用且完整名称确认，不删除用户代码目录。启用需要 `0035_project_sidebar_order.sql` 及配套 API/Worker/Web，未自动升级既有服务。实现与验收见[项目菜单计划](docs/implementation/project-sidebar-menu-plan.zh.md)。

任务集合默认展示范围、布局、搜索、筛选与一个“新建任务”主操作。“筛选”中保留项目、状态、优先级、排序、归档和看板分组；“更多任务工具”中保留完整创建页、保存视图/完整查询、文件浏览器、高级源码分栏及帮助。已启用的筛选和查询保持可见，项目路由的固定范围不能清除。列表按标题、状态、负责人、优先级、截止日期和项目对齐；每行“任务操作”提供真实状态/优先级编辑，手机端使用紧凑元数据行和独立操作入口。只显示有可信来源的负责人名称，其他已分配引用不伪造姓名。

项目内“新建任务”（含看板分组和日历日期入口）直接进入 `/projects/<id>/issues/new` 的 Markdown 编辑页，不先创建空任务。正文使用 Markdown 编辑器和预览，同页维护标题、状态、负责人、日期、优先级、标签及高级关系；当前项目固定，已有恢复草稿优先保留原输入。“保存并创建”后进入同一任务的源码/实时视图继续编辑。工作区快速创建仍保留。

文档“内容”页默认直接可编辑，提供 Markdown 正文、实时预览、格式工具栏、三级右键菜单、查找替换、命令搜索、大纲与块操作；正文、属性、关联和高级源码共用原文/revision 草稿，显式保存。授权双链按对象类型跳转项目或任务页面；选区转任务和附件上传使用真实服务及原请求恢复。插件技术参考、语法、安全边界和验收见 [Markdown 编辑补全计划](docs/implementation/markdown-editor-completion-plan.zh.md)。Agent/Session 执行与多人逐键合编仍未启用。

### 目录型 Markdown 文档来源

PM 文档页右上角“文档来源设置”可为工作区或项目关联一个 **PM 后端机器上的已有目录**。输入绝对路径，先“预检目录”再保存；目录必须在现有本地项目允许根内且通过身份与权限检查。可以复用 Agent 或原生项目目录，也允许与它们存在父子关系；不会修改 Agent cwd。只有多个已配置的文档来源之间不能相同或互为父子目录，以免重复收录；同一来源更新自己的路径不与旧配置冲突。部署需要迁移 `0039_document_sources.sql` 及配套 API/Web。

“外部目录 · 只读”按来源范围递归列出普通 `.md` / `.MD` 文件，不要求 frontmatter 或 PM ID；相对路径区分同名文件，“继续加载”可穷尽分页。选择文件从后端读取正文，外部新增、修改、删除后使用“刷新来源”。它不导入原生 PM 实体，也不上传、改写、移动或删除源文件；“解除关联”只清除配置并保留 revision。原有“原生 PM 文档”创建、编辑与保存不变。

内容读取沿用当前工作区/项目授权；仅项目成员不能读取工作区或其他项目来源。父目录来源不会整体拒绝，但会过滤当前成员无权读取的原生项目子树及其他工作区的已登记项目/Agent 区域，直接请求被过滤文件也拒绝，问题列表不泄漏这些路径。主机路径只向已有路径查看权限的管理者披露，配置修改另需现有规划编辑能力。私有存储、路径穿越、软链接、硬链接和特殊文件仍被拒绝；`.pm` 不进入外部文档，避免重复展示原生 PM 文档。正文最多 4 MiB，不静默截断。扫描限制为 100,000 个条目、128 层目录和 1,000 条问题；遇到排除或限制会明确显示“不完整”，不能当成空目录或完整结果。预览禁用原始 HTML、相对资源与 PM 实体嵌入。

配置使用 revision 防止覆盖他人修改；保存响应未知时先查询核对，不自动重试。实施清单、并行分工及实际验收见[目录文档来源计划](docs/implementation/directory-document-sources-plan.zh.md)。

| 入口/能力 | 当前范围 |
| --- | --- |
| `/pm` | 真实会话、工作区与能力；项目/任务/里程碑/依赖、人工对话与意图、成员授权、成果上传下载/证据/提交/审核；侧栏账户菜单（本人资料、账号设置、主题、快捷键、退出） |
| `/pm/<workspace>/home` | 工作区首页：真实姓名/个人时区问候、权限快捷入口、活跃项目/开放任务/已完成/逾期、我的任务三分组、项目进度、即将截止与最近动态；参考 gr8r-studio Home 布局，仅聚合授权范围内的已保存事实。新浏览器默认进入首页，保留已保存启动偏好；工作区根路径按该偏好跳转，Dashboard 独立保留 |
| `/pm/<workspace>/projects` | 正式项目列表四种布局；`?view=list1..4` 显式覆盖工作区显示偏好。真实个人收藏/筛选、授权图片封面、团队/身份、里程碑摘要和独立人工健康度；工作区管理员可从“团队管理”维护已有成员的团队 |
| `/pm/<workspace>/projects/<id>` | `?view=detail1`、`detail2`：概览/看板/列表/表格/日历/时间线/关系图/文件/动态；共享项目身份与任务工具栏，真实范围、健康、预算、团队和分页审计。Files 按 artifact 聚合不可变版本，支持真实内容预览、上传/下载、显示名修改、软隐藏/恢复及指定版本独立复制；来源按双侧当前权限读取，不改变历史 filename/Evidence 或删除字节。任务/日期仍写回同一 Markdown revision。见[项目补齐计划](docs/implementation/project-backend-completion.md)、[Files 生命周期](docs/implementation/service-files-lifecycle-plan.zh.md)与[视图顶栏](docs/implementation/project-view-arrangement.zh.md) |
| `/pm/<workspace>/projects/<id>/issues` | 项目作用域内的任务列表、看板、表格、日历、甘特图；侧栏保留稳定工作区分组和项目树，内容区保留完整项目视图。`/issues/new` 创建及 `/entities/<entityId>` 全页详情沿用该项目；路由项目优先于查询参数和保存视图，工作区“全部任务”仍跨授权项目汇总 |
| `/pm/<workspace>/issues`、`/documents`、`/views` | PM 原生集合与共享详情：九类实体、原文/预览/草稿、属性/关系、看板/表格/树/图、嵌入 pm-view；文件浏览器和源码分栏按需打开，不再嵌入第二套应用 |
| `/pm/<workspace>/issues?scope=mine` | 我的任务：替代侧栏独立的今天/即将到来入口，按 gr8r-studio My Tasks 展示当前登录人负责的真实任务。逾期、今天、即将到来（所有未来及未排期）、已完成四组；已完成默认折叠，取消任务不混入。统计、搜索、筛选及列表/日历共用同一集合；新建默认分派本人，完整创建页支持 `issues/new?scope=mine`，保留显式项目/负责人选择和恢复草稿。完成/重开按配置工作流和独立能力写回原生 Markdown，不以界面操作推断成功 |
| `/pm/<workspace>/agent` | 旧入口仅跳转到统一 Agent Chat，不迁入旧 PM thread ID；PM 侧栏与完整 Chat 使用同一界面、Provider、会话及17个 PM 工具，沿用当前 PM 登录与业务权限 |
| `/agent/workspace?view=automations` | Agent Chat 内的本人规则 CRUD、只读测试、启停、手动/每日后台报告、时区/预算/冷却/去重及不可变运行历史；仅观测真实 Markdown 任务，不执行模型/Host 或自动完成任务 |
| `/pm/<workspace>/entities/<id>` | 与集合详情共用草稿和 revision 的完整对象页；任务默认连续展示标题、属性、依赖、Markdown 描述、真实子任务、成果证据与服务端评论；评论支持本人编辑、软删除/恢复及不可变历史，不改核心 Markdown。字段和源码双向更新并显式保存；保留高级属性/关联/关系图/业务/上下文。见[任务详情交付](docs/implementation/markdown-core-delivery.zh.md#task-detail) |
| `/pm/<workspace>/views?view=graph` | 九类实体的力导向知识图谱；正式类型关系与正文双链、全局/一至三层局部图、关系筛选与搜索、缩放/拖动/邻居高亮；正式图只读已保存事实，嵌入图明确标记草稿预览 |
| `/pm/<workspace>/settings` | 工作流与字段、本地项目目录、迁移与备份、诊断；`?section=local-storage` 管理本地目录，`?section=preferences` 保留 PM 展示偏好；Agent Provider 与聊天配置由 Chat 设置管理 |
| `/pm/<workspace>/settings/:page` | 24 页、7 分组设置中心；真实个人资料、本人改密/会话撤销、独立可信邮箱管理、工作区名称/安全图标/颜色及原请求恢复；浏览器和任务/项目偏好。MFA/SSO、工作区删除/自定义URL、支付/OAuth、外部通知偏好仍禁用。见[设置清单](docs/implementation/settings-completion-plan.zh.md)与[实际边界](docs/implementation/service-completion-and-acceptance.zh.md) |
| `/pm/<workspace>/settings/plugins` | 内置能力目录、搜索和详情；真实 SMTP 邀请状态，以及批准目标下的 Webhook 创建/暂停/启用、投递状态与原投递核对。未配置时明确禁用；其他供应商连接器/OAuth/动态插件不因此可用。见[Webhook 合同](docs/implementation/service-webhook-plan.zh.md) |
| 任务多视图 | 列表、看板、表格、全天日历、周/月/季时间线；同一服务 ID 与日期元数据，不各自维护任务副本。时间线参考 gr8r-studio：固定任务栏与日期表头、项目/状态/负责人分组、真实里程碑与依赖线、今天定位及日期跳转；点击任务条显式保存日期，保留权限与 revision 冲突保护 |
| `/pm/<workspace>/dashboard` | `?view=dashboard1` 至 `dashboard4`：真实关注、计时/工时、个人资料、会议、便签、Sprint 观测历史、健康风险、预算/支出/预测、在线状态、关键路径、项目依赖与里程碑改期；见[补齐计划与证据](docs/implementation/dashboard-backend-completion.md) |
| `/pm/<workspace>/members` | 统一“成员与团队”入口，`?tab=members\|teams\|workload` 分别承载成员目录、团队管理和工作量。成员页保留三种布局、角色/独立能力、本人资料及 `panel=invitations` 邀请记录；团队页维护成员/维护者、项目关联和归档；工作量按成员/团队/任务池查看，保留任务创建、Markdown 估算点与显式容量。`memberId`/`teamId` 筛选可清除并随链接恢复；组织关系不授予权限。旧正式 `/teams` 已移除，Lab 独立保留。见[合并计划与验收](docs/implementation/people-workspace-consolidation-plan.zh.md)、[成员能力](docs/implementation/member-backend-completion.md)及[Teams 能力](docs/implementation/teams-backend-completion.md) |
| `/pm/<workspace>/notifications` | 默认 Activity：参考 gr8r-studio 的单列日期时间线，全部/状态变更/评论/项目及人员筛选、真实对象跳转、相对时间与个人时区分组。沿用授权项目审计和保留的变更元数据；操作者与差异要求已有 `audit.read`，不补造外部编辑历史。`?section=notifications` 保留个人通知的显式关注/提及、已读/归档 CAS 与原收据恢复；不是邮件/Push服务。见[通知交付](docs/implementation/service-notification-routing-plan.zh.md)和[Activity 复刻记录](docs/implementation/backend-delivery.md#activity-replica) |
| `/pm/<workspace>/whiteboard` | 个人本地 SVG 白板：撤销/重做、缩放/平移、便签/形状/画笔、导入导出；不是服务器协作成果 |
| `/lab/pm` | 开发操作默认开放的56个展示入口：原32个页面变体与24个设置页；业务表单离页重置，不付款、不连接外部账号、不写后端。所有 build 默认不注册 Lab，生产 Caddy 另返回404；受控展示产物须显式 `PM_ENABLE_LAB=true` |
| `/errors/401`、`/errors/403`、`/errors/404`、`/errors/500`、`/errors/503` | 五个 HTTP 错误页；受保护 `/pm` 路由的 401/403/404/5xx 与会话异常复用同一表面，重试只调用真实会话刷新 |
| Storybook | 11 个独立组件 stories；明确样例数据，不作为真实业务验收 |
| 核心写入语义 | 任务完成按配置工作流直接转换，不要求先提交审核；审核是独立交付流程，不自动改写核心状态 |
| 未支持 | 外部邮箱同步、邮件/Push 通知、Agent Host/Runner、业务 Session/Run、主动发现、模型或外部动作自动化（Chat 工具成功和自动化报告均不代表工作项完成）；MFA/SSO、自动 GC、协作白板及供应商连接器；团队不授予项目权限。邮件/S3/Webhook 缺少真实配置或启用前提时保持禁用 |

完整变体目录、首选/备选库、已安装组件与日期契约见 [前端移植与接入清单](docs/frontend-porting-manifest.md)。浏览器人工闭环、响应丢失核对和双会话冲突证据见 [交付记录](docs/implementation/backend-delivery.md)。

统一页面重构、独立 review 修复与本轮真实浏览器证据见 [Markdown 核心交付记录第 7 节](docs/implementation/markdown-core-delivery.zh.md#unified-pages)。正式 `/markdown` 入口已移除，核心 Markdown 能力由上述原生页面承载。

验证：

```bash
pnpm check
pnpm test:backend
pnpm check:web
pnpm --filter @pm/web build-storybook
pnpm smoke
pnpm smoke:verify
# 备份要求先停止本项目 API/Worker 和外部核心写入者。
pnpm backup:verify --stopped
```

`check` 检查文档、合同漂移、后端 lint、类型、无需数据库的测试并构建，不包含前端。`check:web` 运行前端 lint、全量 TypeScript 与 Vite 构建；`build:web` 不运行 lint，`preview:web` 在 3220 预览。`test:backend` 使用真实 PostgreSQL 和独立随机 schema，覆盖文件、HTTP、Worker、故障恢复和 SSE，仅清理自有资源。S3 验收需隔离真实 MinIO（`PM_S3_TEST_MINIO_BINARY`）或明确测试配置，并设置 `PM_REQUIRE_S3_TESTS=true` 防止静默跳过；测试临时盘必须有足够空间，不能降低存储保护阈值绕过 507。跳过的数据库/S3测试不算通过。

本地目录专项验收使用 `node --env-file=.env scripts/local-project-smoke.ts --verify`；`--browser` 启动独立临时 API/Worker/Web，SIGINT/SIGTERM 只清理自身进程、随机 schema 和临时根。备份验收需要实际 `pg_dump`/`pg_restore` 与 `CREATEDB`；可用 `PM_TEST_PG_DUMP`、`PM_TEST_PG_RESTORE` 指定受控客户端。它们不读取既有账号访问文件，也不操作业务项目。

后端回归入口共用单实例门禁，并逐文件记录进度、期限与真实用例统计；重叠运行直接拒绝，失败、取消、跳过或泄漏不能算通过。运行选项与隔离边界见[测试说明](tests/README.md)，本次耗时问题的证据与修复验收见[后端回归修复计划](docs/implementation/backend-regression-repair-plan.zh.md)。

Markdown 核心的行为测试位于 `packages/pm-core/tests/`（迁自 Lab，165 项）。宿主机 inotify 不足时以 `CHOKIDAR_USEPOLLING=true pnpm test` 运行。

```bash
# 连接已启动的 PM 服务；认证优先 PM_SESSION_TOKEN，其次 PM_EMAIL/PM_PASSWORD 或 .local/access.json
PM_WORKSPACE_ID=<workspace-uuid> pnpm run pm protocol
PM_WORKSPACE_ID=<workspace-uuid> pnpm run pm task list
PM_WORKSPACE_ID=<workspace-uuid> pnpm run pm file TASK-102
PM_WORKSPACE_ID=<workspace-uuid> pnpm run pm entity update TASK-102 --status done
PM_WORKSPACE_ID=<workspace-uuid> pnpm run pm migration list
```

CLI 默认连接 `http://127.0.0.1:4194`，可用 `PM_API_URL` 覆盖。`pnpm run pm <args>` 直接传参（不要额外加 `--`）。更新默认先读取当前 revision；冲突返回非零退出码且不自动重试。

`smoke` 在实际服务创建人工交付/审核/关闭/归档验收数据并保存 `.local/evidence/service-smoke.json`；`smoke:verify` 复读原对象、收据和成果摘要。`backup:verify --stopped` 使用实际 provider 备份 SQL、共享核心、全部已登记项目托管目录和引用 blob，在新数据库、新核心/项目目录和新 Local 存储根恢复并设置认证、通知与外发围栏，再通过真实 API 校验授权下载字节；不修改源库或归档。恢复旧凭据信任与生产切换必须另行批准，详见[部署手册](deploy/README.md)。

## 账号与维护

```bash
pnpm account:create --email colleague@example.test --name Colleague
pnpm outbox:failed --workspace WORKSPACE_UUID
pnpm outbox:retry --workspace WORKSPACE_UUID
```

账号 CLI 生成的密码存入 `.local/accounts/{userId}.json`，初始不授予工作区权限。管理员通过 `SetWorkspaceMember` 显式授予能力及 projectIds；`null` 表示整个工作区，UUID 数组表示限制在指定项目。Workspace 管理能力不隐含审核/完成权限。

Worker 事件发布达到 10 次失败后保留原事件并隔离该工作区。操作员先查询，修复原因，再显式重试；CLI 不改业务实体或收据，重试记录持久写入 `.local/logs/outbox-maintenance.ndjson`。SSE 默认保留 7 天；游标过期返回 410，需要重新读取快照。

详见 [运行手册](deploy/README.md) 与 [本轮实现记录](docs/implementation/backend-delivery.md)。

## 文档与实施顺序

- [领域规范与完整三阶段计划](docs/domain-design/README.md#implementation-plan)：第一阶段 13 步、第二阶段 7 步、第三阶段 7 步。
- [真实验收与缺失服务能力补齐](docs/implementation/service-completion-and-acceptance.zh.md)：八包实施合同、真实故障修复、独立验收与 D01–D15 待讨论清单；不把禁用能力或仿真设备算作已交付。
- [Markdown 核心接入 ADR](docs/implementation/markdown-integration-adr.zh.md)：身份、授权、存储权威与核心命令边界。
- [本地优先项目目录与初始化](docs/implementation/local-project-storage-plan.zh.md)：五包实施、目录选择、初始化、共享工作区身份、项目附件、迁移/重新定位及完整备份恢复。
- [Markdown 能力台账](docs/implementation/markdown-capability-ledger.zh.md)：L01–L30 与 E01–E12 的入口和状态。
- [Markdown PM 能力移植计划与取舍说明](docs/implementation/markdown-porting-plan.zh.md)：Lab 全部能力必做，共有业务以 Lab 语义和文件权威为准；PM 独有能力逐项列明，可暂保留原存储。含完整能力对照、D01–D11 易读解释、阶段与验收；旧数据已按 D11 丢弃，Markdown 核心已接入。
- [Markdown 能力全量移植专项](docs/implementation/markdown-full-port-plan.zh.md)：主移植计划的强制组成部分，列出 C01–C12 源码复制清单、独立模块及宿主接口、MD01–MD24 完整能力和真实验收。优先直接复制 Lab 实现/行为测试再适配接口；实现与证据见 [Markdown 核心交付记录](docs/implementation/markdown-core-delivery.zh.md)。
- [知识关系图谱实施计划与验收](docs/implementation/knowledge-graph-plan.zh.md)：授权图数据、Canvas 力导向组件、共享详情、草稿与正式关系边界及真实运行证据；与 React Flow 任务依赖图分离。
- [任务五页与 Markdown 工作台统一创建：计划与交付](docs/implementation/task-creation-adaptation-plan.zh.md)：已实现后端统一规则与原生恢复、前端五入口与共享创建草稿，保留九类对象和源码工作台；含真实浏览器故障验收及 466 项零跳过数据库测试证据。
- [Markdown 内容直接编辑与功能补全](docs/implementation/markdown-editor-completion-plan.zh.md)：gpt-6.1-sol / xhigh 五包实施，React/CodeMirror 原生编辑、结构命令、丰富渲染、授权对象与附件联动；保留 Markdown 权威和明确能力边界。
- [侧栏底部头像用户菜单复刻计划](docs/implementation/sidebar-user-menu-replication-plan.zh.md)：按参考站拆解触发区、账户卡片、主题切换、资料/设置/快捷键/退出映射；正式 `/pm` 已实现并保留真实数据、视觉规格与浏览器验收记录。
- [工作区外壳与项目导航改造计划及验收](docs/implementation/workspace-navigation-plan.zh.md)：工作区/项目职责、真实切换、授权项目树、聚合集合与创建归属；含指定模型并行实施和真实浏览器草稿/权限/移动端证据。
- [项目 Files 页复刻计划](docs/implementation/project-files-replication-plan.zh.md)：按参考站项目 Files 页拆解工具栏、拖放/上传、网格/列表、空态、预览与菜单，映射到真实 artifact/version 数据并替换现有附件区；正式 `/pm` 已实现，含深色/移动端与浏览器验收记录。
- [项目视图顶栏与任务工具栏重构记录](docs/implementation/project-view-arrangement.zh.md)：按参考站项目页把看板/列表/表格/日历/时间线/关系图提升为一级标签，共享搜索/状态/排序/新建任务工具栏，指标移入概览；含旧 URL 映射与浏览器证据。
- [Agent 界面接入矩阵](docs/implementation/agent-ui-entry-matrix.zh.md)：按执行计划逐页列出项目/任务/文档/设置的原页面增量入口，以及对话/运行/提案/发现/自动化五个同壳新页面、宿主导航改动、禁止项和本副本当前路由状态。
- [Agent 工作区前端接入清单](docs/implementation/agent-workspace-ui-adoption.zh.md)：以 agent-workspace 为参照，记录左侧栏、Composer、Thread 的代码映射、assistant-ui 运行时、PM 既有 SSE 适配、后续面板与验收范围。
- [Agent 页面区域接入计划](docs/implementation/agent-page-areas-integration-plan.zh.md)：issues 之外的 project list/detail、entity/task、documents、settings/agent 的插入点、共享 Provider/Panel、选区与草稿边界、分阶段与后端门禁。
- [初始化架构决策](docs/architecture/adr/0001-project-bootstrap.md)：已确定的工程边界及剩余决策。
- [第一阶段架构决策](docs/architecture/adr/0002-first-stage-backend.md)：事务、身份、存储和事件的一致性选择。
- [初始化记录](docs/implementation/bootstrap.md)：保留最初工程初始化历史，当前状态以本轮实现记录为准。
- [原始需求参考](docs/reference/domain-design-background.md)：从 `project-management-book/readme.md` 原样保留。

领域规范已复制到本仓库，后续开发和进度在本仓库维护。原 `project-management-book` 保留设计来源。EasyuseUI 路径引用是当前机器上的可选参考，独立安装与构建不依赖它存在。

## 工程边界

| 路径 | 当前内容与职责 |
| --- | --- |
| `apps/server/pm` | HTTP、认证、下载、变更查询与 SSE |
| `apps/server/worker` | 持久事件发布、保留维护与心跳 |
| `apps/server/agent` | Agent API、持久会话、Provider 与 CLI 执行；目录由 PM resolve |
| `apps/server/gateway.ts` | 公共同源网关、API/WS 代理和统一静态托管 |
| `apps/web` | 统一 Vite SPA；`/pm`、`/agent`、隔离 `/lab/pm` 与 Storybook |
| `apps/desktop` / `tools/marketing` | 完整本地服务组的 Electron 宿主 / 静态营销站 |
| `packages/agent-contracts` / `agent-client-runtime` | Agent 协议与 same-origin 前缀 HTTP/WS 客户端 |
| `vendor/*` | 单 pnpm workspace 内的固定导入 UI/协议源包，不引用来源仓目录 |
| `packages/domain` | 状态、验收与图约束 |
| `packages/application` | 命令、查询、访问与事务协调 |
| `packages/contracts` | OpenAPI 生成、命令 payload 类型和客户端 |
| `packages/infrastructure` | PostgreSQL/Drizzle schema、SQL 迁移、身份与 BlobStore |
| `packages/pm-schema` / `pm-markdown` | Markdown 协议、字段/关系/DSL 校验、保留式编解码 |
| `packages/pm-core` | 权威文件仓库、投影、监听、幂等/墓碑、迁移与恢复 |
| `packages/pm-views` / `pm-cli` | 主/嵌入视图与 Markdown 核心 CLI |
| `apps/web/src/features/pm/markdown` | 独立 Markdown 能力模块：控制器/授权会话、共享详情、集合和设置；复用 PM 外壳，不再维护独立应用导航 |
| `tests` | 真实数据库、HTTP、Worker 和恢复验收 |
| `deploy` | 专用 PostgreSQL Compose 与运行手册 |

PM 后端编译到根 `dist`，Agent 服务编译到 `apps/server/agent/dist`；唯一 Web 产物为 `apps/web/dist`。`pnpm build:v4` 构建 PM、Agent 合同与运行时、Agent 服务及统一 Web。根 `check`、`check:web`、`typecheck:agent`、`test:agent`、`build:desktop`、`build:marketing` 分别覆盖对应工程，不能相互代替。

前端工作项状态、优先级等单选器将选项图标与 `SelectItemText` 分开：菜单保留图标，选中值仅回填文本，避免 Issues 页面按钮重复显示图标。

前端表层已按 [AI 与项目协作工作台设计模式](../DESIGN-PATTERNS.md) 更新（暖中性表面、前景色主按钮、角色化圆角、56px 业务页头、44px 数据行、独立焦点环、减少动效）。采用范围、Token 映射、局部例外与分批验收证据见 [前端设计模式采用记录](docs/frontend-design-adoption.md)；原 fixture-only 记录属于移植历史，当前正式入口使用真实服务。

当前 PM 限制仍包括单文件 8 MiB、单 API/本地 Markdown 核心、同工作区写入串行，实体 data/命令 result 仍较通用；尚无自动孤立文件 GC、通用 job 编排、公开注册、MFA/SSO 或业务 Session/Run/Runner。独立 Agent Chat 不改变这些业务边界。私有 S3、可信邮箱找回与受限 Webhook 的供应商/SMTP/接收器、生产恢复、公网 TLS、多实例/HA、容量和真实设备仍需独立输入及验收；Provider 未配置或未实测时不宣称真实模型通过。
