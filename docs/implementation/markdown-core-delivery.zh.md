# Markdown 核心交付记录

依据：[移植计划](markdown-porting-plan.zh.md)、[全量移植专项](markdown-full-port-plan.zh.md)。
实现状态：核心代码、PM 宿主、API、CLI 与统一页面模块已接入。旧核心数据已按 D11 丢弃。第 3 节为初次移植历史，第 7 节为统一页面重构，第 8 节为任务五页与共享创建；各轮证据独立记录，不把历史检查冒充本轮重跑。

## 1. C01–C12 复制与适配登记

| 编号 | 源 | 目标 | 适配 | 证据 |
| --- | --- | --- | --- | --- |
| C01 | Lab `packages/pm-schema/*` | `packages/pm-schema/*` | 原样复制；修正 PM 严格类型选项；新增 `viewConfigOf` 物料化 | `pnpm typecheck`；`packages/pm-core/tests/{protocol,query}.test.ts` |
| C02 | Lab `packages/pm-markdown/index.ts` | `packages/pm-markdown/index.ts` | 原样复制；严格类型修复 | `roundtrip.test.ts`、`core.test.ts` |
| C03 | Lab `packages/pm-core/*` | `packages/pm-core/*` | 原样复制；`Workspace` 由 PM API 池按工作区实例化；监听可通过 `CHOKIDAR_USEPOLLING` 轮询 | `core/lifecycle/migrations/advanced-core` 测试；真实 SSE smoke |
| C04 | Lab `packages/pm-views/index.tsx` | `packages/pm-views/index.tsx` | 原样复制；新增 workspace `package.json` 声明依赖 | 工作台 Board/Table/Tree/Graph 真实渲染 |
| C05 | Lab `apps/web/src/App.tsx` | `apps/web/src/features/pm/markdown/{workspace,controller,session,EntityDetail,WorkspaceDialogs}` | 复用能力并拆分控制器、授权会话、共享详情和弹窗；集合默认不打开详情；文件浏览器/源码分栏为可选工具，不再嵌入另一套应用外壳 | 第 7 节真实浏览器闭环 |
| C06 | Lab `Preview.tsx` | `markdown/Preview.tsx` | 别名导入与回调保持 | 预览、checklist 行写回、Wikilink、pm-view |
| C07 | Lab `EntityFields/Properties/Diagnostics/WorkspaceEditors` | `markdown/*` | 别名导入；`api` 注入 core 前缀 | 属性、创建、配置、视图、迁移界面 |
| C08 | Lab `api.ts` | `markdown/api.ts` | `createCoreClient(workspaceId)` 返回独立客户端；同源 cookie、AbortSignal、`current/diagnostics` 保留；无全局可变 API 前缀 | 真实 HTTP、409 冲突、401 首次保存失败与权限收窄 |
| C09 | Lab `apps/server/index.ts` | `apps/api/src/core-routes.ts` | Hono → Fastify 薄路由；复用 Lab 错误码/SSE；认证 + 能力 + 项目范围 | `/core/*` 全接口 smoke、越权 401/403、SSE |
| C10 | Lab `packages/pm-cli/index.ts` | `packages/pm-cli/index.ts` | 默认 `PM_API_URL=4100`；登录/工作区解析；路径改为 core；参数与错误语义保留 | `pnpm run pm` protocol/list/file/context/update/migration |
| C11 | Lab `styles/app.css` | `markdown/markdown.css` | `.markdown-workbench` 作用域内改为 PM 原生集合、详情、设置布局；复用宿主主题 token；窄屏详情隐藏集合工具栏，关闭后恢复 | 桌面/窄屏、浅色/深色实际截图 |
| C12 | Lab `tests/*.test.ts` | `packages/pm-core/tests/*` | 导入重写；fixture 本地化；Hono transport 三套移到 `transport-later/` | 165 项通过（轮询监听） |

## 2. 核心接口

前缀：`/api/v1/workspaces/{workspaceId}/core`

| 方法 | 路径 | 能力 |
| --- | --- | --- |
| GET | `/protocol`、`/config`、`/workspace`、`/items`、`/files/:id`、`/context/:id`、`/events` | `domain.read` |
| POST | `/query` | `domain.read` |
| POST | `/items`、`/entities` | `planning.edit`（创建项目需工作区范围） |
| GET / POST | `/creation-attempts/:key`、`/creation-attempts/:key/recover` | `domain.read`，原账号与当前对象/项目范围；POST 仅恢复原写入审计 |
| PUT | `/files/:id` | `domain.read` + 实际修改字段对应的编辑/完成/重开/生命周期能力 |
| PATCH | `/entities/:id` | `domain.read` + 实际修改字段对应的编辑/完成/重开/生命周期能力 |
| POST | `/entities/:id/archive`、`/restore`；DELETE `/entities/:id` | `planning.lifecycle` |
| PUT | `/config`、`/views/:id`；migration list/preview/apply/restore | 管理员（`project_ids IS NULL`） |

PM 命令入口 `/commands` 对 `project`/`work_item`/`milestone` 命令转到 `core-adapter`；其它命令仍走 SQL 内核。核心实体的 SQL insert/update/list 已被内核拒绝。

## 3. 初次移植验证证据（历史记录）

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm --filter @pm/web typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm build` | 通过 |
| `CHOKIDAR_USEPOLLING=true pnpm test` | 216 项通过；其中迁入核心回归 165 项（无轮询时宿主 inotify 耗尽） |
| `CHOKIDAR_USEPOLLING=true pnpm test:backend` | 255 项通过，0 跳过（真实 PostgreSQL、HTTP、Worker、SSE、核心工作区） |
| `node --env-file=.env --test packages/infrastructure/tests/foundation.test.ts` | 11 项通过（PM-only fixtures） |
| 迁移 | 临时库与真实库均应用到 `0006_drop_legacy_reference_overload.sql`；临时库验证 `entities.project_id`/`memberships.project_ids` 为 text |
| 核心真实 HTTP | 创建项目/任务、幂等创建、revision 409、查询、context、归档、永久删除 + 墓碑、外部编辑 + SSE |
| 跨项目依赖 | `TASK-005` 以 `blocked_by: TASK-001` 成功写入（不同项目） |
| Intent → 核心任务 | 对话/消息/Intent/接受决策后创建核心任务，文件含 `x-pm-intent-ref`；同一 acceptedRevision 的第二次转换拒绝 `intent_already_converted` |
| 项目范围授权 | 受限成员仅见 `PRJ-001`；读取/写入 `PRJ-002` 返回 404；创建新项目返回 403 |
| 未审核完成 | `CompleteWorkItem` 直接写入 `done`，无评审门槛 |
| 交付模块 | 上传 → 成果 → 证据 → 提交 → passed 审核；核心任务状态保持 `draft`，审核不反向覆盖 |
| 浏览器 | `/pm/<ws>/markdown` 真实文件；属性状态写回磁盘；源草稿 Save/刷新恢复；冲突双版本/rebase；归档、删除确认；创建 PRJ-001/DOC-001；Preview 嵌入 pm-view；checklist 行写回；保存视图文件；config/migration/context 弹窗；`pm/v2` 只读 |
| CLI | `protocol`、`task list`、`file`、`context`、`entity update --revision`、`migration list` 均针对真实 core |

## 4. 安全与一致性修正

- 项目范围：核心读取、查询、context、SSE 均按 `project_ids` 过滤；Agent context 不再包含范围外关联文件的原文；受限成员的 snapshot 不返回配置诊断、范围外视图或全局计数。
- 写入能力：`PUT /files`、`PATCH /entities`、创建接口按字段检查 `workitem.complete`、`workitem.cancel_reopen`、`planning.lifecycle`，不能通过通用编辑绕过命令能力；目标项目必须在范围内。
- 成员授权：`SetWorkspaceMember` 先校验 `access.manage`，再触碰核心工作区；项目 ID 必须是已存在的核心项目。
- 命令回执：核心命令在 `.pm/state/pm-command-journal.ndjson` 记录 pending/completed；SQL 回执丢失时由 journal 重放已完成结果，pending 返回 `command_outcome_unknown` 而非伪造拒绝。同一 commandId（及 Intent+revision）在单进程内串行。
- 查询缓存按 `origin + actorId + workspaceId + membershipVersion + actorEpoch` 隔离；草稿持久化按宿主、账号、工作区隔离，授权更新后仍保留本人草稿，但不展示当前范围之外的源码。
- 迁移 0007 恢复成员能力白名单与 `access.manage ⇒ project_ids IS NULL` 约束。

## 5. P1 修复复核

| 问题 | 修复 |
| --- | --- |
| 刷新删除未保存草稿 | 清理仅在 `query.isSuccess` 后执行；首屏未加载不再视为“文件已删除” |
| 旧 PM 内容编辑破坏正文 | 标题单独修改时按字节保留正文；验收项按 AST 行号原位改文本，保留 `[x]`、缩进、代码块、强调；描述变更时只替换描述槽位 |
| journal 跨用户泄露 | 条目绑定 actorId；回放前重新校验结果对象当前项目范围 |
| 创建幂等回放越权 | 创建（含幂等命中）返回对象再次经过 `scope.entity` |
| 完成/重开权限不一致 | 通用编辑按配置 `statusCategory` 统一映射到 `workitem.complete` / `workitem.cancel_reopen` / `planning.lifecycle` |
| 查询缓存键不一致 | 当前统一为 `['pm', origin, actorId, workspaceId, 'core', membershipVersion, actorEpoch]`；读取拒绝或写入认证/授权失败会隐藏私有界面、取消/清理对应缓存并刷新宿主权限 |
| 已完成对象不可编辑 | `writable` 只排除归档对象，不再禁止 done/completed/cancelled |
| 无提交无法直接完成 | 独立完成表单不以 submission/review 为前置，无项目任务也可按权限完成；审核不会自动改变核心状态 |
| 验收项 ID/空描述 | 表单接受 `TASK-001-AC-1`；描述和验收项不再强制非空 |
| Decision 引用核心对象 | `subjectRef`/`basisRefs` 接受稳定核心 ID 或 UUID |
| Intent 转换可重复 | `.pm/state/pm-intent-conversions.ndjson` 持久记录 acceptedRevision 转换，任务删除后仍拒绝重复 |
| SSE 会话失效 | 心跳重新认证会话与成员项目范围，失效即关闭连接 |
| 工作台出现两套侧栏 | 已由第 7 节的统一页面替代旧“隐藏 PM 侧栏”方案；正式路由仅使用 PM 导航，Lab 文件浏览器按需打开 |
| 编辑器授权错误无反馈 | 配置/视图/迁移表单兜底显示 `ApiError.message` |
| 删除回执范围丢失 | 生命周期命令从目标对象补全 projectId，受限成员可查询自己的回执 |

## 6. 已知边界

- Lab 三套 Hono transport 测试保存在 `packages/pm-core/tests/transport-later/`，PM 使用 Fastify 由真实 HTTP smoke 覆盖；未把它们计入通过数。
- 宿主机 inotify 配额耗尽时，文件监听与测试需要 `CHOKIDAR_USEPOLLING=true`；这不是协议降级。
- 常驻 API 只允许一个进程管理同一工作区目录；多进程同时打开同一核心工作区会造成 SQLite 锁竞争，不属于支持范围。
- Markdown 模块提供能力和共享详情，不再提供独立应用导航。正式 `/markdown` 与旧对象详情入口已移除；`/lab/pm` 仍是显式 fixture，不代表生产页面。
- `x-pm-*` 扩展用于 PM 专用元数据（创建者、起止日期、归档时间、Intent 转换引用）。核心 `due` 仍是唯一截止日期权威。
- 个人视图、项目级配置覆盖、多实例协同、真实 Agent 执行不属于本轮。

<a id="unified-pages"></a>
## 7. 统一页面重构与复审

### 7.1 当前页面结构

| 入口 | 职责 |
| --- | --- |
| `/pm/:workspace/issues`、`/projects/:projectId/issues` | 集合优先；列表、看板、表格、日历、甘特、树和关系图，共用核心对象与写入协议 |
| `/documents` | 文档集合与内容优先的共享详情；源码编辑不再占据默认主界面 |
| `/views` | 九类对象查询及保存视图；`savedView` 表示保存视图 ID，`view` 只表示呈现布局 |
| `/entities/:entityId` | 同一对象的完整页面；与集合详情共用内容、源码、属性、关联、业务、上下文及草稿/revision |
| `/settings` | 工作流/字段、迁移/备份、诊断；`section=preferences` 保留 PM 展示偏好 |

表中省略的前缀均为 `/pm/:workspace`。PM 导航、搜索、账号、主题和语言只保留宿主入口。对象打开时默认是内容详情，不自动打开源码；文件浏览器和高级分栏需显式启用。窄屏详情让出集合工具栏空间，关闭后恢复原集合。核心正文不经过 Tiptap 的 Markdown→HTML→Markdown 全文件转换；PM-only 业务表单仍可保留原有富文本能力。

文档内容页默认直接提供 Markdown 正文编辑器、工具栏/右键菜单与实时预览；“高级源码”保留完整 YAML。正文、属性、关联和源码共用草稿，底部保存或 Ctrl/Cmd+S 写入同一文件；只读、归档、未知写入和版本冲突不能绕过。丰富内容、结构命令、转任务/附件联动及证据见[编辑补全计划](markdown-editor-completion-plan.zh.md)。正文双链和属性关联按已授权对象的真实类型导航：项目进入项目页面，任务进入其实际项目的详情，无项目任务及文档等对象进入工作区对象详情；不按 ID 前缀猜类型。标题和块锚点保留定位；源码文件浏览器仍显式打开原文，未知协议只读，未解析双链报错，返回路径限定同一工作区。

### 7.2 独立 review 修复

实现及两轮独立 review 使用会话指定的 `gpt-6.1-sol:xhigh` 子代理；集成与真实浏览器验收由主执行者完成。

| 问题 | 收口行为 |
| --- | --- |
| 旧 PM 完成/重开条件覆盖 Lab 语义 | 工作项可无提交、无审核、无项目完成；原生项目重开只提交原因，不要求填写随后被丢弃的目标/负责人/完成标准 |
| 清空手工阻塞误删 `blocked_by` | 手工原因只写 `x-pm-manual-block-reasons`，对象依赖由关系编辑管理 |
| 归档对象业务页查不到记录；只读源码成员无法使用生命周期 | 业务读取使用授权的单对象查询；`planning.lifecycle` 与 `planning.edit` 分开控制，含删除确认 |
| 所有排期误用工作项扩展字段 | 工作项使用 `x-pm-start/due`；项目、迭代、模块、需求、发布、目标使用原生 `start/due`；里程碑仅 `due`；文档没有可写排期字段 |
| 授权变化后复用旧缓存；首次保存 401 未清掉源码 | 缓存包含授权版本/代际，失效时取消读取并隐藏私有界面；源码、视图、配置、迁移等错误统一触发宿主权限刷新，本地草稿不因此删除 |
| PM 仪表盘状态与 Lab 状态不同 | 配置已有同名状态优先；否则将 `draft/ready/in_review/cancelled` 映射到对应 Lab 状态 |
| 保存视图 ID 与布局名称冲突、弹窗保存后 URL 陈旧 | 分离 `savedView/view`；保存、临时应用、清除查询与类型切换同步保存视图身份 |
| 返回集合后的旧 history context 反复覆盖新筛选 | 恢复上下文后立即消费该 history 状态，后续修改与刷新不再重新套用旧上下文 |

### 7.3 本轮实际运行证据

使用独立 PostgreSQL schema、独立 Markdown/Blob 目录及独立浏览器域名；没有用正式业务数据作验收 fixture。

| 场景 | 观察到的结果 |
| --- | --- |
| 九类创建 | 从真实创建表单逐一创建 project/work_item/document/cycle/milestone/module/requirement/release/goal，返回文件类型与标题正确 |
| 共享详情与草稿 | 集合→源码→完整页→返回保留草稿、标签及集合筛选；刷新恢复草稿；改筛选后再刷新不复用旧 history |
| 原文/CAS | 显式保存前文件不变；保存保留原文；外部写入后 409 展示两版，人工合并/rebase 不自动落盘，下一次显式保存保留双方更改 |
| 文件监听 | 实际编辑工作区文件后，SSE 触发界面自动刷新；未以手动刷新冒充监听 |
| 文档能力 | 清单写回与原文比较仅一个 `[ ]`→`[x]` 标记变化；Wikilink 跳到同一对象；callout 与包含三条真实任务的 pm-view 显示正常 |
| 上下文 | 生成真实对象上下文，不包含尚未保存的源码草稿 |
| 业务语义 | 无项目任务直接完成返回 committed；清空手工阻塞后依赖仍为 `TASK-001`；项目无定义补录即可重开 |
| 权限与归档 | 只读成员源码不可编辑、清单不可写；仅加生命周期权限即可归档/恢复/删除文档及恢复归档项目；项目范围收窄后原范围外详情变为不可访问 |
| 认证失效 | 复现“保存是首个失败请求”：401 后私有源码隐藏；重新登录后原草稿仍在 |
| 保存视图 | ID 为 `board` 的表格视图正常加载；弹窗保存另一个视图后 URL、当前视图、刷新结果一致；临时查询清掉保存身份 |
| 配置/未知版本 | 故意损坏配置后创建锁定、草稿保留；设置页修复返回 200；`pm/v2` 原文可读，修改/删除入口禁用 |
| 排期 | 工作项日历实际渲染；甘特编辑迭代写入原生 `start/due`，没有误写 `x-pm-start`；里程碑仅有截止字段，文档无日期输入 |
| 迁移入口 | 真实迁移预览及历史/备份区域可达；本轮未重新执行完整迁移故障恢复矩阵 |
| 空态与显示 | 空工作区零对象、创建可用、无自动详情；1440×1000 和 390×844、浅色/深色实际检查，无页面级横向溢出；窄屏详情关闭后集合工具栏恢复 |

本轮执行 `pnpm check:web`（ESLint、前端 TypeScript、Vite build）、`pnpm typecheck`、`pnpm contracts:check`，均通过。`CHOKIDAR_USEPOLLING=true node --test apps/api/tests/core-adapter.test.ts packages/application/tests/planning-intent.test.ts packages/contracts/tests/client.test.ts`：31 项通过，0 失败、0 跳过。构建仍有大 chunk 和既有动态/静态导入混用警告，不作为已解决的性能问题。历史全后端、CLI 和迁移故障恢复证据保留在第 3 节，本轮没有宣称全部重跑。

收口时 `pnpm check:docs` 通过：检查 51 份 Markdown、27 个计划步骤及领域引用；14 个仓库外可选链接不计入可移植性检查。自有验收浏览器、API、前端服务和监听探针均已关闭；隔离数据库 schema、临时 Markdown/Blob 目录及两个临时脚本已清理，保留截图证据，未停止原有常驻服务。

## 8. 任务五页与统一创建（2026-10-21）

详细工作包、字段合同及 TC-A01–TC-A12 逐项证据见 [任务创建适配计划与交付](task-creation-adaptation-plan.zh.md)。

- 新建任务页、快速新增、工作台弹窗及项目/Teams/日历/命令面板使用同一 `CreationDraft`。九类创建能力保留；带 ID 的源码草稿仍是独立 `{raw,revision}`，未被创建表单替代。
- 新 UI 使用原生 `POST core/entities`，成功即交给共享 EntityDetail。`creation-attempts` 的查询/审计恢复和个人 WatchTask 的 PM 收据严格分开；父子项部分成功不重建父项。
- 四个任务范围复用已授权 Markdown；重要是个人关注，日期取个人时区。真实优先级拖动没有改变状态，完成子项没有自动完成父项。
- 真实浏览器覆盖完整字段、另外八类对象、自定义字段/关系诊断、跨表面及跨标签页草稿、源码冲突/显式合并、外部文件/SSE、撤权、离线和 390×844。原生成功响应丢失及 API 审计前中断均按原键恢复，后者只有一次创建 POST、一个文件与一份恢复审计。
- 本轮 `pnpm check` 295 项测试通过，`pnpm test:backend` 466 项/25 suites 全部通过且零跳过，`pnpm check:web` 通过。大 chunk 和既有导入混用警告仍在。
- 午夜/闰日/月末使用明确标记的浏览器时钟注入；中文 composition 使用 Chrome CDP，不冒充物理 IME/触摸设备。提醒、小时级排期和 Agent 执行仍禁用。
- 证据在 `.local/evidence/task-creation/`；自有隔离服务、schema、临时目录、生成凭据及浏览器上下文已清理。未重启既有常驻服务，未宣称生产激活。

<a id="task-detail"></a>

## 9. 任务右侧详情与共享 Markdown 草稿（2026-10-21）

参考 `gr8r-studio` 的任务抽屉信息顺序，正式任务详情已切换为连续布局；不是另一份任务数据，也不把正文转换为 HTML 后整篇反写。非任务实体保持原有详情行为。

| 区域 | 已接入行为与边界 |
| --- | --- |
| 顶栏与布局 | 项目 / ID、按配置工作流暂存完成或重开、真实个人关注、复制链接、全页展开、关闭；桌面约 620px 右侧详情，宽屏源码 / 实时视图并排，移动端单栏切换 |
| 标题与属性 | 标题来自首个 H1；状态、优先级、真实成员身份、截止日期、`x-pm-start`、项目、标签、估算点与 `blocked_by` 均修改共享源码草稿；`x-pm-estimate` 与持续天数分开，重复任务明确禁用 |
| 描述与高级能力 | AST 渲染时隐藏权威 H1，不删除源码或改变检查项行号；代码块、双链与既有 Markdown 渲染保留；Sprint、父项及其他字段、关系、生命周期、正式图、业务、上下文仍可达 |
| 依赖与子任务 | 授权任务中搜索、多选、移除阻塞项，支持现有跨项目关系；真实子任务来自已保存 `parent`，工作流完成进度不使用正文检查项，取消不计完成；通用创建入口明确要求手选父项，不假装自动建立子任务关系 |
| 附件、活动、评论 | 只列出该任务的证据 / 提交实际引用的不可变成果版本，支持真实下载和引用来源；交付管理复用已有服务；活动按任务筛选真实项目审计，不补造外部编辑历史；任务评论通过独立 SQL 协作记录接入，共享详情组件与当前核心任务/项目授权，详见 9.2 |
| 草稿与保存 | 字段、源码和任务检查项共用 `{raw, revision}`，显式保存；无效源码保留原文并明确显示最后保存的有效内容，结构化字段锁定；可解析的关系错误仍允许修复。任务集合和正式图继续使用保存事实，通用嵌入草稿预览保持原协议 |
| 并发与权限 | 外部更新不覆盖草稿；比较、人工合并、变基后仍需显式保存；冲突期间源码编辑与字段锁定，避免看似输入成功却丢弃更新。PM 服务新写入在草稿未解决前禁用；已经开始的文件暂存保持原有在途语义，不改任务 Markdown |

### 9.1 本轮实际验收

使用独立 PostgreSQL schema、临时 Markdown/Blob 目录、API 临时端口和前端 3360，不改既有 3220/4100 服务及正式业务数据。

- `pnpm check:web`：ESLint、前端 TypeScript 和 Vite 构建通过。
- `node --test tests/task-detail-model.test.ts tests/task-collection.test.ts tests/project-task-editing.test.ts`：20 项通过、0 失败、0 跳过；覆盖原文保留、暂存工作流的最终转换校验、无效 / 身份变更拒绝、检查项真实 AST 行号及既有集合、行内编辑行为。
- 真实浏览器：字段修改未提前写盘，源码立即更新标题与描述；展开、刷新后草稿保留。修复无效 YAML 后可继续编辑；隐藏 H1 后检查项仍写回正确位置，保存结果与预期原文逐字节一致，保留未知扩展、双链、提示块和代码。
- 跨项目阻塞项可选；通过真实另一任务更新形成草稿依赖环后保存禁用，但阻塞项仍可编辑；移除环后保存成功。
- 实际编辑临时文件，干净详情通过 SSE 自动更新；有草稿时保留本地标题并锁定编辑。比较两版、合并外部截止日期、变基不会写盘，下一次保存同时保留双方更改。
- 真实个人关注成功；子任务进度显示 `1/2`；真实成果下载 26 字节，SHA-256 与登记值 `9ca11be3c626504def393d1ca9371afe4358d8b3070d3d31038e5361e6cfce13` 一致。暂存完成状态未改变服务端状态，交付写入禁用而下载仍可用。
- 390×844 下文档宽度 390，顶栏操作可达，源码模式隐藏并排预览并提供任务视图切换；真实受限成员的标题、状态、依赖、检查项、源码与保存均只读，未显示另一项目内容。双链打开文档后仍保留通用标题 / 正文 H1。
- 截图保留于 `.local/evidence/task-detail/{desktop,source-live,mobile}.png`。本轮未重跑完整后端事务、迁移故障恢复或个人关注丢响应矩阵；没有声称接通重复任务、任务评论或真实 Agent。

自有验收浏览器、API 与前端服务已关闭；隔离 schema、临时 Markdown/Blob 目录已由 fixture 正常清理。仅保留截图，不重启其他项目服务。

### 9.2 真实任务评论与可恢复历史（2026-10-23）

- 迁移 `0023_task_comments.sql` 只新增 PM 评论与不可变版本历史，不新增账号、服务或 SQL 核心任务副本；评论列表、发布、作者编辑、隐藏和恢复不回写 Markdown 正文，也不修改任务状态。全页与抽屉复用 `TaskDetailRelated` 内同一 `TaskComments` 组件。
- 读取沿用项目讨论的 `domain.read`；写入沿用当前项目的 `intent.propose`，编辑、隐藏和恢复还必须为原作者。每次读取/写入都验证当前真实任务与项目；写命令先刷新权威文件并拒绝归档、无效或不可写项目。管理员没有额外冒充作者的权限。
- `commandId`、版本 CAS、正文快照、最小审计、outbox 和收据处于同一 SQL 事务；收据、事件、审计差异不复制评论正文。当前版本 CAS 冲突保留原稿和原始基线，只有明确比较并采用新基线才允许重新提交。
- Markdown 使用现有 `MessageContent` 安全渲染：不执行 HTML，不自动请求外部图片，危险链接不激活。隐藏为可恢复 tombstone，列表保留 ID、作者、时间与版本；历史仍向当前项目读者可见，明确不是抹除。恢复要求作者当前仍有权限并通过 CAS，SQL 阻止物理删除及历史改写。
- 原稿按 origin / actor / workspace / project / task 分区，使用逐标签页 session storage 在刷新后恢复；全页与抽屉切换共享内存 store。存储失败保留内存输入并阻止发送，未知响应保留原命令并查询真实收据，不换键盲重发；成功恢复的原稿需显式清理，避免再发布一次。
- 任务跨项目移动后，已有评论历史保留原项目边界，不自动扩大新读者范围；返回 `task_comment_project_changed`，界面明确说明不是网络故障或空历史。如何显式迁移历史与授权需要用户决定。
- 回归源码：`tests/task-comments.integration.test.ts` 覆盖真实 PG/HTTP 发布、重读、原收据幂等、正文/revision/状态不变、作者 CAS、tombstone/恢复/历史防改、跨项目和撤权；`tests/task-comments-model.test.ts` 覆盖草稿、未知收据、刷新恢复与存储故障。并行实施期间未运行；集成后的实际检查和浏览器证据在完成后追加，不借用第 9.1 历史结果。
- 仍需讨论而未实施：重复任务的时区/DST、生成时机/提前窗口、遗漏补建/幂等、修改与取消对已生成任务的影响；小时排期的时区与全天字段兼容、跨日与拖动语义；文档逐键协作的 CRDT/OT、离线/冲突/权限撤销，以及批注锚点随正文移动、线程解决/重开与历史保留。任务评论不是逐键协作或文档批注线程。

#### 9.2.1 隔离真实验收

- 在新 PostgreSQL schema 与临时 Markdown/Blob 根目录、API `34183`、Web `3387` 实际验收；浏览器使用独立 `pm-comments.localhost` 与 `pm-comments-reader.localhost` cookie 域。初始开发入口受并行 HMR/模块请求争用影响，后续改用父线程统一构建的 production preview，不据开发时 provider 重载错误宣称服务失败或成功。
- 实际浏览器按钮完成发布、安全 Markdown 展示、刷新重读、作者编辑、隐藏/历史/恢复、受限项目作者发布。脚本与危险链接未执行，未创建外部图片请求节点；恢复后的原评论为 v6，保留六份可读取版本。真实另一写入引发版本变化时，编辑原稿和原基线保留，刷新后原稿仍在；人工采用新基线再保存成功。
- 发布在途刷新与受控响应抑制后，界面从持久记录恢复同一 `commandId`，查询真实原收据得到 `committed`；原评论只有一条，没有换键重发。全页返回集合并打开抽屉，未提交评论原稿保持；390px 深色抽屉的文档宽度为390px。
- HTTP 边界与浏览器交互分开记录：并发作者更新为200/409（`version_conflict`），错误项目和受限成员跨项目列表/历史为404，非作者编辑为403；撤销 `intent.propose` 后作者删除为403且浏览器输入禁用，撤销成员后列表/历史/原收据为404且旧评论表面和私有文字清空。
- 三条评论及其历史重读后，核心 Markdown 原文、revision 与任务状态均未改变。额外的隔离任务迁移探针返回409 `task_comment_project_changed` 并显示明确历史保留提示；探针后返回原项目，不把迁移后的 revision 变化冒充评论写入。
- 机器证据与七张截图在 `.local/evidence/task-comments/acceptance.json` 及同目录。此 slice 未自行运行 build/lint/tests/formatters，统一检查由父线程执行。自有 API 正常退出0，preview 和两个 tab 已关闭；实际核对该随机 schema 与临时根目录均不存在，冒烟脚本及临时快照已删除。既有4100/3220和业务数据未修改。
