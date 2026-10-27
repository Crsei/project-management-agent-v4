# Project Management

面向人工与 Agent 协作的项目管理应用。项目/工作项/里程碑及其九类 Markdown 模型以工作区 Markdown 文件为权威；PM 独有的账号、意图/正式决策、成果/审核、附件与白板保留各自存储。后端为 Node.js 24、Fastify、PostgreSQL（PM 独有模块）与独立 Worker，Vite + React 前端 `/pm` 连接真实服务，`/lab/pm` 仅承载展示样例。真实 Agent 执行仍未启用。

项目路径：`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/ui-examples/project-management`。

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

要求 Linux、Node.js 24、pnpm 11.9.0、Docker 与 Compose。在本项目根目录执行首次设置：

```bash
pnpm install --frozen-lockfile
pnpm setup:local
pnpm db:up
pnpm db:migrate
pnpm bootstrap
pnpm build
# 目标描述符与 API 存储位置一致；全新安装须显式绑定，详见部署手册。
pnpm storage bind --new --stopped --target-config /secure/pm-storage-target.json
pnpm services:start
pnpm services:status
```

默认 API 监听 `127.0.0.1:4100`，PostgreSQL 监听 `127.0.0.1:55433`。Markdown 工作区默认位于 `.local/pm-workspaces/{workspaceId}/`，可用 `CORE_WORKSPACE_ROOT` 覆盖。inotify 配额不足时可设 `CHOKIDAR_USEPOLLING=true`，不改变文件权威。`setup:local` 分别创建 0600 的 `.env` 与 `.env.worker`，保留已有文件；Worker 不继承 API 的对象存储身份。新安装显式选择 Local 后仍需绑定；旧安装停写后使用 `bind --adopt` 核验原对象，不能用 `--new` 替代。管理员信息保存在 `.local/access.json`（0600），不输出日志，bootstrap 不自动轮换已有账号。已有服务先查 `services:status`；角色配置、描述符及升级顺序见[部署手册](deploy/README.md)。

`services:start` 启动并验证本项目 API/Worker；`services:stop` 仅停止 PID、启动时间、工作目录与入口均匹配的自身进程，不删除数据库。开发时可单独用 `pnpm dev`，需另行运行 Worker，并避免和常驻 API 占用同一端口。没有 DATABASE_URL 时仅保留不就绪的 bootstrap 模式。

```bash
curl http://127.0.0.1:4100/health/live
curl -i http://127.0.0.1:4100/health/ready
curl http://127.0.0.1:4100/api/v1/capabilities
```

### 本地项目目录与初始化

优先交付本机 API + Worker + PostgreSQL 使用方式；本批不新增云端同步、多实例或 Agent。`pnpm setup:local` 生成并保留已有 `.local/local-projects.json`，新配置默认只允许 `.local/projects`。需要选择其他代码目录时，本机管理员先把真实绝对父目录加入 `allowedRoots`；浏览器输入路径不能扩大授权范围。配置更改须在受控升级/重启时生效，不自动迁移文件。

进入 `/pm/<workspace>/settings?section=local-storage` 查看实际核心/备份路径并设置默认项目父目录。新建项目可在该父目录下新建文件夹，或使用已有目录；必须先预检最终路径。初始化稳定项目 ID、身份标记、项目 Markdown、工作流初始状态、空任务/文档目录、附件绑定和恢复记录；不改原 README/代码，不建样例任务、不初始化 Git。

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
pnpm dev:web       # http://127.0.0.1:3220/pm
pnpm storybook     # http://127.0.0.1:6017，独立组件样例
```

`/pm` 使用 `.local/access.json` 中的本机账号登录，再选择实际授权工作区；无权限或后端不可用时明确报错，绝不回退示例数据。Vite 开发与 preview 将 `/api`、`/health`、`/openapi.json` 同源代理到 `http://127.0.0.1:4100`。需改目标时设置 `PM_API_URL`，后端信任 Origin 与目标不同才设置 `PM_API_ORIGIN`；不要把服务凭据写入前端配置。生产使用独立 API/Worker/Web 镜像与 Caddy 同源代理，见[部署手册](deploy/README.md)；开发代理不等于生产部署通过。

### Agent 对话

`/pm/<workspace>/agent` 在现有 PM 外壳内提供私有 Agent 对话：线程、消息及工具结果持久化到 PostgreSQL，服务端调用 OpenAI 兼容的 `/chat/completions`；浏览器不保存模型密钥。侧栏左上角的工作区切换菜单同时提供 Project Management / Agent Workspace 全局切换：进入 Agent 打开既有对话页，切回 PM 按已保存启动页返回；本次只做导航与展示，不自动绑定项目、任务或线程上下文，也不新增其他操作逻辑。在本项目根目录 `.env` 配置 `AGENT_CHAT_BASE_URL`、`AGENT_CHAT_MODEL`、`AGENT_CHAT_API_KEY` 后重启 API；配置模板见 `.env.example`。未配置时页面明确禁用；配置完成不等于供应商工具调用已验证。

输入框内部提供权限模式、当前工作区 / 项目、当前消息的任务、思考程度四个入口；权限按钮直接显示“普通聊天”或“Full access”。项目弹层仅显示左右两列：左侧工作区，右侧项目；项目可多选或选择“全部项目”（需原生工作区权限），选择后直接保存，无额外保存按钮或能力说明。新线程默认采用有效入口项目，否则工作区级成员默认采用当前工作区。范围变更不自动启用工具、不发送项目正文，刷新后保留。跨工作区进入目标工作区的新对话，不搬移旧线程或沿用授权；有未发送输入时提示离开。

默认仍为普通聊天。打开权限模式菜单，选择 Full access 即提交授权，选择普通聊天即停用工具；没有重复勾选或启用按钮，成功后关闭菜单，失败或状态未知时明确提示并提供重新读取。弹层不展示“详情”入口；详细限制、有效期与完整能力/来源保留在 `/pm/<workspace>/settings/agent?thread=<threadId>`。Full access 固定使用 `auto_approve`，允许动作直接落地；已启用时选择项目直接更新范围，不再二次确认。授权有效期60分钟，按当前用户权限裁剪；工作区范围冻结启用时的可访问项目，不自动纳入之后新建的项目。项目创建另需工作区范围及原生权限。

“思考程度”从服务端读取当前模型支持的档位，随下一条消息及其全部工具轮次传递；“自动”不覆盖供应商默认值，刷新页面恢复自动，不改变 PM 权限。仅对已登记的官方 OpenAI/DeepSeek 模型开放对应档位；未知兼容接口、模型及 `deepseek-chat` 旧别名仅显示自动，不伪造可调能力。服务端在保存消息前拒绝不支持的选项；内部思考内容不作为聊天正文或数据库消息保存。

已接通13个真实工具：项目/任务/文档查询和读取、项目与任务创建及普通字段修改、文档创建和正文保存、评论读取/创建、关系读取/添加/删除。写入复用原生应用服务、revision、幂等键与收据；模型措辞不是成功证明。Full access 不开放 Done/生命周期、审核、删除/归档、迁移、ACL、秘密、任意文件或 shell。能力栏区分授权范围与实际发送给模型的来源；工具卡显示真实状态、结果、收据和原对象链接。具体清单与验收见[本次接入计划](docs/implementation/agent-capability-integration-plan.zh.md)。

任务详情侧栏和完整 Agent 页共用 `AgentConversation`，统一管理 assistant-ui external-store runtime、Composer、Thread、权限、范围、思考程度、历史及连接核对。任务入口默认选中当前任务，可搜索、切换或清除；候选仅来自当前授权项目范围内的有效任务。消息附加所选任务及项目 ID，不附加任务正文、草稿或 revision，也不把选择冒充已固定的数据来源。读取正文仍需显式工具授权；选中任务不可用时阻止发送。展开完整页保留同一线程、当前任务和未发送草稿；新建对话或切换其他历史线程清除旧任务选择。
执行运行记录、待审建议仍保留禁用入口；自动化由下述独立页面提供只读报告，不复用聊天授权启动工具。其他入口安排见 [Agent 界面接入矩阵](docs/implementation/agent-ui-entry-matrix.zh.md)，不将旧矩阵自动纳入本次交付。

对话刷新或连接中断后，页面通过会话详情持续核对仍在生成的消息；核对失败时保持结果未知并阻止重复发送，不自动重发模型请求。SSE 必须收到 `done`、`cancelled` 或 `error` 终态，提前结束会触发核对。“停止”以服务端持久状态为准：取消失败或未确认不会伪装成已停止，也不会主动切断仍有效的订阅；服务端由生成处理器一起保存最后的部分文本与取消终态。

停止生成、停用或到期只阻止后续工具派发，不回滚已提交修改。写入结果未知时只查原操作收据，不自动重派；未核实前不显示成功。历史数据因权限或范围被隐藏时，不代表此前操作未执行或已撤销。

### 自动化规则与报告

`/pm/<workspace>/automations` 位于原工作区外壳的 Agent 折叠分组，支持本人规则的创建、编辑、删除、启停、只读测试、明确运行、搜索筛选及分页运行历史。项目必须显式选择；规则和不可变报告保存在 PostgreSQL，任务仍以 Markdown 为权威。新规则只保存为草稿；测试未保存配置不会创建运行、调用模型或修改任务。

支持手动或每日定时触发、IANA 时区、每日运行上限和冷却时间。实际动作是对未完成、逾期或受阻任务生成只读观测报告，保留当时配置、来源任务 ID/revision 和原对象链接。自动化不代表 Agent Session/Run，更不会改变任务完成状态；模型分析、Host 工具和外部通知/连接器仍明确禁用。

规则编辑采用独立规则侧栏、报告内容与运行时间两步布局，限额设置默认折叠；运行历史按日期分组，可按规则筛选并在行内展开结果与运行配置。页面使用 Radix UI Colors 的明暗色阶、12/14/20px 字号和 0.5px 边框，无装饰阴影或动画；配色和字号覆盖该路由的既有工作区外壳，不影响其他页面。普通保存、暂停直接提交，启用、正式运行和删除保留确认；窄屏的已保存规则列表默认折叠。

Worker 独立执行到期规则，关闭页面不停止调度。夏令时缺失时刻跳过、重复时刻使用第一次；跨日错过的检查记为跳过，不补发历史批次。预算按规则当地日期计算，手动与定时正式运行共同计入预算，测试不消耗预算。专用调度心跳与 API/普通 Worker 健康分开；旧 Worker 的存活不代表自动化就绪。

所有读写与后台执行重新检查当前主体和项目授权；更新携带 revision，未知响应保留原请求键并查询原收据，刷新不重发。删除规则保留不可变历史；项目归档后禁止启用与运行，但仍允许有权用户暂停、删除规则。部署需要迁移 `0034_automation.sql` 并更新本副本 API/Worker；不连接来源副本。实现与本次验收见[执行计划补充记录](EXECUTION-PLAN.zh.md#automation-page-delivery)。

认证入口使用独立全窗口登录页，支持密码显隐、字段校验和本地化反馈；登录后进入授权工作区选择。登录响应未知时先检查当前会话，不自动重发。账号由管理员或有效邀请创建，未开放公开注册或第三方登录。`/pm/account/security`、`/pm/account/recovery` 和恢复邮箱确认页不依赖工作区；配置邮件能力且本人独立验证恢复邮箱后才可自助找回，历史登录邮箱/邀请不自动算可信证明。

正式应用以工作区为稳定外壳：侧栏顶部切换实际授权工作区，依次排列个人入口、工作区聚合入口和授权项目树，底部保留账号与可展开的连接状态。内容区只有一条上下文顶栏；主题、语言、页面变体、设置与个人白板可从“页面与外观选项”进入，工作区菜单另有设置及按权限显示的成员入口。项目可独立展开看板、列表、时间线、文件，展示真实状态和个人收藏；展开偏好按账号和工作区隔离。工作区全部任务、日历、时间线跨授权项目汇总并显示归属；项目页固定项目，工作区的项目筛选可清除。工作区创建需选择所属项目，项目创建预填并锁定项目。跨工作区使用整页导航，释放旧查询与订阅；未保存编辑和创建草稿保留离开提示及恢复机制，浏览器存储失败时须先重试保存，避免强制离开丢失内存输入。设计、分工与实际验收见[工作区导航改造记录](docs/implementation/workspace-navigation-plan.zh.md)。

项目侧栏、列表和详情共用真实项目 `…` 菜单：打开、个人收藏、重命名与编辑、分享、复制链接、复制项目、侧栏上移/下移、归档及删除。排序按账号/工作区在服务端保存；分享复用实际成员范围，不提供公开访问。复制使用新 ID 和新目录，重映射所选任务关系，不复制历史、权限、附件或用户代码；未知响应先查原收据，未完成复制只能显式恢复原请求。`/projects?archive=archived` 提供恢复入口；永久删除须已归档、无引用且完整名称确认，不删除用户代码目录。启用需要 `0035_project_sidebar_order.sql` 及配套 API/Worker/Web，未自动升级既有服务。实现与验收见[项目菜单计划](docs/implementation/project-sidebar-menu-plan.zh.md)。

任务集合默认展示范围、布局、搜索、筛选与一个“新建任务”主操作。“筛选”中保留项目、状态、优先级、排序、归档和看板分组；“更多任务工具”中保留完整创建页、保存视图/完整查询、文件浏览器、高级源码分栏及帮助。已启用的筛选和查询保持可见，项目路由的固定范围不能清除。列表按标题、状态、负责人、优先级、截止日期和项目对齐；每行“任务操作”提供真实状态/优先级编辑，手机端使用紧凑元数据行和独立操作入口。只显示有可信来源的负责人名称，其他已分配引用不伪造姓名。

项目内“新建任务”（含看板分组和日历日期入口）直接进入 `/projects/<id>/issues/new` 的 Markdown 编辑页，不先创建空任务。正文使用 Markdown 编辑器和预览，同页维护标题、状态、负责人、日期、优先级、标签及高级关系；当前项目固定，已有恢复草稿优先保留原输入。“保存并创建”后进入同一任务的源码/实时视图继续编辑。工作区快速创建仍保留。

文档“内容”页默认直接可编辑，提供 Markdown 正文、实时预览、格式工具栏、三级右键菜单、查找替换、命令搜索、大纲与块操作；正文、属性、关联和高级源码共用原文/revision 草稿，显式保存。授权双链按对象类型跳转项目或任务页面；选区转任务和附件上传使用真实服务及原请求恢复。插件技术参考、语法、安全边界和验收见 [Markdown 编辑补全计划](docs/implementation/markdown-editor-completion-plan.zh.md)。Agent/Session 执行与多人逐键合编仍未启用。

| 入口/能力 | 当前范围 |
| --- | --- |
| `/pm` | 真实会话、工作区与能力；项目/任务/里程碑/依赖、人工对话与意图、成员授权、成果上传下载/证据/提交/审核；侧栏账户菜单（本人资料、账号设置、主题、快捷键、退出） |
| `/pm/<workspace>/home` | 工作区首页：真实姓名/个人时区问候、权限快捷入口、活跃项目/开放任务/已完成/逾期、我的任务三分组、项目进度、即将截止与最近动态；参考 gr8r-studio Home 布局，仅聚合授权范围内的已保存事实。新浏览器默认进入首页，保留已保存启动偏好；工作区根路径按该偏好跳转，Dashboard 独立保留 |
| `/pm/<workspace>/projects` | 正式项目列表四种布局；`?view=list1..4` 显式覆盖工作区显示偏好。真实个人收藏/筛选、授权图片封面、团队/身份、里程碑摘要和独立人工健康度；工作区管理员可从“团队管理”维护已有成员的团队 |
| `/pm/<workspace>/projects/<id>` | `?view=detail1`、`detail2`：概览/看板/列表/表格/日历/时间线/关系图/文件/动态；共享项目身份与任务工具栏，真实范围、健康、预算、团队和分页审计。Files 按 artifact 聚合不可变版本，支持真实内容预览、上传/下载、显示名修改、软隐藏/恢复及指定版本独立复制；来源按双侧当前权限读取，不改变历史 filename/Evidence 或删除字节。任务/日期仍写回同一 Markdown revision。见[项目补齐计划](docs/implementation/project-backend-completion.md)、[Files 生命周期](docs/implementation/service-files-lifecycle-plan.zh.md)与[视图顶栏](docs/implementation/project-view-arrangement.zh.md) |
| `/pm/<workspace>/projects/<id>/issues` | 项目作用域内的任务列表、看板、表格、日历、甘特图；侧栏保留稳定工作区分组和项目树，内容区保留完整项目视图。`/issues/new` 创建及 `/entities/<entityId>` 全页详情沿用该项目；路由项目优先于查询参数和保存视图，工作区“全部任务”仍跨授权项目汇总 |
| `/pm/<workspace>/issues`、`/documents`、`/views` | PM 原生集合与共享详情：九类实体、原文/预览/草稿、属性/关系、看板/表格/树/图、嵌入 pm-view；文件浏览器和源码分栏按需打开，不再嵌入第二套应用 |
| `/pm/<workspace>/issues?scope=mine` | 我的任务：替代侧栏独立的今天/即将到来入口，按 gr8r-studio My Tasks 展示当前登录人负责的真实任务。逾期、今天、即将到来（所有未来及未排期）、已完成四组；已完成默认折叠，取消任务不混入。统计、搜索、筛选及列表/日历共用同一集合；新建默认分派本人，完整创建页支持 `issues/new?scope=mine`，保留显式项目/负责人选择和恢复草稿。完成/重开按配置工作流和独立能力写回原生 Markdown，不以界面操作推断成功 |
| `/pm/<workspace>/agent` | 私有 Agent Chat、真实模型流及13个普通 PM 工具；显式 Full access 授权、来源/能力/工具卡、原生收据、停止与未知核对。未授权仍为普通聊天，未配置模型明确禁用 |
| `/pm/<workspace>/automations` | 本人规则 CRUD、只读测试、启停、手动/每日后台报告、时区/预算/冷却/去重及不可变运行历史；仅观测真实 Markdown 任务，不执行模型/Host 或自动完成任务 |
| `/pm/<workspace>/entities/<id>` | 与集合详情共用草稿和 revision 的完整对象页；任务默认连续展示标题、属性、依赖、Markdown 描述、真实子任务、成果证据与服务端评论；评论支持本人编辑、软删除/恢复及不可变历史，不改核心 Markdown。字段和源码双向更新并显式保存；保留高级属性/关联/关系图/业务/上下文。见[任务详情交付](docs/implementation/markdown-core-delivery.zh.md#task-detail) |
| `/pm/<workspace>/views?view=graph` | 九类实体的力导向知识图谱；正式类型关系与正文双链、全局/一至三层局部图、关系筛选与搜索、缩放/拖动/邻居高亮；正式图只读已保存事实，嵌入图明确标记草稿预览 |
| `/pm/<workspace>/settings` | 工作流与字段、本地项目目录、迁移与备份、诊断；`?section=local-storage` 管理本地目录，`?section=preferences` 保留 PM 展示偏好；`/settings/agent` 管理当前私有聊天的范围与启停 |
| `/pm/<workspace>/settings/:page` | 24 页、7 分组设置中心；真实个人资料、本人改密/会话撤销、独立可信邮箱管理、工作区名称/安全图标/颜色及原请求恢复；浏览器和任务/项目偏好。MFA/SSO、工作区删除/自定义URL、支付/OAuth、外部通知偏好仍禁用。见[设置清单](docs/implementation/settings-completion-plan.zh.md)与[实际边界](docs/implementation/service-completion-and-acceptance.zh.md) |
| `/pm/<workspace>/settings/plugins` | 内置能力目录、搜索和详情；真实 SMTP 邀请状态，以及批准目标下的 Webhook 创建/暂停/启用、投递状态与原投递核对。未配置时明确禁用；其他供应商连接器/OAuth/动态插件不因此可用。见[Webhook 合同](docs/implementation/service-webhook-plan.zh.md) |
| 任务多视图 | 列表、看板、表格、全天日历、周/月/季时间线；同一服务 ID 与日期元数据，不各自维护任务副本。时间线参考 gr8r-studio：固定任务栏与日期表头、项目/状态/负责人分组、真实里程碑与依赖线、今天定位及日期跳转；点击任务条显式保存日期，保留权限与 revision 冲突保护 |
| `/pm/<workspace>/dashboard` | `?view=dashboard1` 至 `dashboard4`：真实关注、计时/工时、个人资料、会议、便签、Sprint 观测历史、健康风险、预算/支出/预测、在线状态、关键路径、项目依赖与里程碑改期；见[补齐计划与证据](docs/implementation/dashboard-backend-completion.md) |
| `/pm/<workspace>/members` | 统一“成员与团队”入口，`?tab=members\|teams\|workload` 分别承载成员目录、团队管理和工作量。成员页保留三种布局、角色/独立能力、本人资料及 `panel=invitations` 邀请记录；团队页维护成员/维护者、项目关联和归档；工作量按成员/团队/任务池查看，保留任务创建、Markdown 估算点与显式容量。`memberId`/`teamId` 筛选可清除并随链接恢复；组织关系不授予权限。旧正式 `/teams` 已移除，Lab 独立保留。见[合并计划与验收](docs/implementation/people-workspace-consolidation-plan.zh.md)、[成员能力](docs/implementation/member-backend-completion.md)及[Teams 能力](docs/implementation/teams-backend-completion.md) |
| `/pm/<workspace>/notifications` | 显式任务关注与本次提及驱动的站内通知；排除本人、合并原因、去重并逐次复核当前授权；个人已读/归档 CAS、原收据恢复及事实捕获/路由状态。旧活动仅迁入仍存在且已有个人状态的项，不制造历史未读。不是邮件/Push服务。见[通知交付](docs/implementation/service-notification-routing-plan.zh.md) |
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

Markdown 核心的行为测试位于 `packages/pm-core/tests/`（迁自 Lab，165 项）。宿主机 inotify 不足时以 `CHOKIDAR_USEPOLLING=true pnpm test` 运行。

```bash
# 连接已启动的 PM 服务；认证优先 PM_SESSION_TOKEN，其次 PM_EMAIL/PM_PASSWORD 或 .local/access.json
PM_WORKSPACE_ID=<workspace-uuid> pnpm run pm protocol
PM_WORKSPACE_ID=<workspace-uuid> pnpm run pm task list
PM_WORKSPACE_ID=<workspace-uuid> pnpm run pm file TASK-102
PM_WORKSPACE_ID=<workspace-uuid> pnpm run pm entity update TASK-102 --status done
PM_WORKSPACE_ID=<workspace-uuid> pnpm run pm migration list
```

CLI 默认连接 `http://127.0.0.1:4100`，可用 `PM_API_URL` 覆盖。`pnpm run pm <args>` 直接传参（不要额外加 `--`）。更新默认先读取当前 revision；冲突返回非零退出码且不自动重试。

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
| `apps/api` | HTTP、认证、下载、变更查询与 SSE |
| `apps/worker` | 持久事件发布、保留维护与心跳 |
| `apps/web` | Vite SPA；真实 `/pm`、隔离 `/lab/pm` 与 Storybook 组件 |
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

后端统一编译到根 dist，数据库迁移随产物复制；前端独立构建到 `apps/web/dist`。根 `check` 与前端 `check:web` 的验证范围分开记录，不能相互代替。

前端工作项状态、优先级等单选器将选项图标与 `SelectItemText` 分开：菜单保留图标，选中值仅回填文本，避免 Issues 页面按钮重复显示图标。

前端表层已按 [AI 与项目协作工作台设计模式](../DESIGN-PATTERNS.md) 更新（暖中性表面、前景色主按钮、角色化圆角、56px 业务页头、44px 数据行、独立焦点环、减少动效）。采用范围、Token 映射、局部例外与分批验收证据见 [前端设计模式采用记录](docs/frontend-design-adoption.md)；原 fixture-only 记录属于移植历史，当前正式入口使用真实服务。

当前限制：单文件 8 MiB、单 API/本地 Markdown 核心、同工作区写入串行，实体 data/命令 result 仍较通用；尚无自动孤立文件 GC、通用 job 编排、公开注册、MFA/SSO 或真实 Agent 执行。私有 S3、可信邮箱找回与受限 Webhook 已实现，但目标供应商/SMTP/接收器、生产恢复策略、公网 TLS、多实例/HA、容量和真实设备仍需独立输入及验收。完整 G1/G2 不因这五包交付自动关闭。
