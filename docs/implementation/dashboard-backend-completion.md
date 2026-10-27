# Dashboard 1–4 后端补齐计划与实施契约

状态：十二项已实现并完成真实浏览器验收。用户授权：建立补齐计划，由 `gpt-6.1-sol / xhigh` 子代理执行；主代理负责正式 `/pm/<workspace>/dashboard?view=dashboard1` 至 `dashboard4` 接入、统一检查和本机服务激活。

## 边界与决策

依据：[领域计划第七节](../domain-design/README.md#implementation-plan)、[后端交付记录](backend-delivery.md)、[Markdown 权威 ADR](markdown-integration-adr.zh.md)。本轮补齐十二项，不重建已存在的任务、成员授权、里程碑创建、任务依赖或原生 Sprint/cycle，不接管其他仓库、Agent、邮件与邀请服务。

- Markdown 是项目、任务、里程碑、cycle 和正式关系的唯一权威；新增项目依赖、任务工期与 Sprint 成员关系必须通过共享核心校验，不能另建 SQL 核心副本。
- PostgreSQL 保存 PM 独有的个人协作、计时与工时、在线心跳、健康评估和财务记录。使用现有命令内核、事务级工作区锁、版本检查、持久收据与 outbox。新增迁移，不改已应用迁移。
- 命令继续由可信会话决定 actor，携带 commandId/expectedVersions；未知结果查询原收据，不自动重发。私有资料/便签/计时必须支持受限项目成员，不能以放宽工作区读权限实现。
- 私有记录及其事件按当前 actor 隔离。项目数据逐项目授权；关联两项目必须都有权限；收据重读仍检查当前授权。现有完整成员列表继续要求 access.manage，不借在线状态泄露成员目录。
- 新记录时间戳使用服务端时钟；时区为有效 IANA 标识；加入时间读取 memberships.created_at，不用账号创建时间冒充。修改姓名同步真实 users.name，个人资料使用跨工作区 CAS。Markdown 实体缺少来源时间时，createdAt/updatedAt 为 null；不使用读取时间或文件扫描时间伪造活动。
- 金额用安全整数最小货币单位及明确币种，不进行隐式汇率转换。预测由真实累计支出加显式剩余成本估计组成；历史保留当时预算/支出/预测与日期，不由任务进度推导金额。
- 健康度是授权人的显式评估（on_track/at_risk/off_track、理由与风险项），保留评估历史。缺少评估显示未评估，不根据任务状态猜测。
- 关键路径采用明确的任务预计工期（日，连续日历时间，无资源平衡）、finish-to-start 零延迟依赖、前向/后向计算；不支持的/缺少的输入明确返回不可计算原因。多条同长关键路径均保留；不自动完成任何任务、里程碑或项目。
- Sprint 历史为核心成功扫描到的有效 cycle/成员任务快照，包含观测时间和来源；在 API、CLI、外部文件扫描及重启路径持久记录，不放在可重建 SQLite。离线期间未观察的中间状态不重建、不伪造每日连续记录；损坏或写入失败不得伪装历史完整。
- INV-01/10/13/14/15/17/20、SC-12/13/14/17/20、INF-01/03/05/06 继续适用。旧 INV-04/12/19、SC-11 的 SQL 完成/跨项目任务依赖语义以 Markdown ADR 为准；项目依赖是独立有向无环图，不更改现有跨项目任务 blocked_by 语义。

## 十二项交付与验收

| 项 | 数据与服务端行为 | 正式页面 | 退出条件 | 状态 |
| --- | --- | --- | --- | --- |
| 1 任务关注/订阅 | 当前用户关注/取消关注；同一任务唯一；只读取当前有权访问任务 | D1 Watching 筛选、数量与操作 | 刷新/重启保留；另一用户不可读；撤权后隐藏 | 完成 |
| 2 计时与工时 | 每人每工作区最多一个活动计时器；停止生成不可变工时；允许真实人工补录；日/周/月按个人时区汇总，跨期区间按交集计入 | D1 Timer/Time tracking | 并发开始最多一条；幂等停止不重复工时；刷新恢复服务端开始时间 | 完成 |
| 3 个人资料 | 本人姓名、IANA 时区、成员加入时间；版本冲突不覆盖 | D1 Profile | 保存后会话/成员姓名一致；加入时间来自数据库；跨工作区并发 CAS | 完成 |
| 4 会议日历 | 项目内会议、起止时间、参与成员、编辑/取消；无外部日历/邮件假同步 | D1 Meetings | 时间范围/成员/项目权限校验；刷新保留；取消有记录 | 完成 |
| 5 便签 | 私有便签内容、完成/重开、删除（保留事件/收据） | D2 Notes | 刷新保留；版本冲突与其他用户隔离 | 完成 |
| 6 Sprint 与趋势 | 原生 cycle 创建/排期/生命周期；单任务 cycle 分配；持久观测历史 | D2 Sprint；D3 Progress；D4 Sprint 入口 | Markdown 同一对象；原生编辑同步；重启保留历史；不宣称多文件原子批量分配 | 完成 |
| 7 健康与风险 | 显式评估及风险说明、历史与评估人/时间 | D3 Portfolio；D4 项目详情 | 编辑权限；可追溯；未评估不算零风险 | 完成 |
| 8 财务 | 预算、支出、剩余成本估计、预测与历史；币种隔离 | D3 Budget/Forecast | 聚合与边界校验；历史不改写；跨币种不相加；权限撤销生效 | 完成 |
| 9 在线状态 | 服务端心跳时间、在线/离开意图；超时离线；本人可设置 | D2/D3 Members | 多页/刷新状态一致；TTL 过期离线；成员目录权限不扩大 | 完成 |
| 10 关键路径 | 正式工期字段、真实任务依赖、完整 DAG 分析与缺失原因 | D4 Critical path | 分叉/合流/多关键路径/缺少工期/不可见依赖测试；不改变生命周期 | 完成 |
| 11 项目依赖 | 项目正式 depends_on 关系，类型/引用/自环/成环与删除保护 | D4 Project graph | 与任务图区分；原文/API 同一校验；跨权限端点不可泄露 | 完成 |
| 12 里程碑改期 | 复用 UpdateMilestone 核心能力，补严格公开契约和日期表单 | D4 Reschedule | 改/清空日期后刷新一致；旧版本拒绝；正文/标准不被日期更新破坏 | 完成 |

## 并行文件所有权与共享接口

六个实现者一次并行启动，均使用 `gpt-6.1-sol:xhigh`。不在实现中途跑构建、lint、测试或格式化；统一集成后检查。压缩报告只列修改、公共符号、验证要求和未解决风险。跨模块接口调整先通知集成负责人。

1. **DashboardFoundation**：`dashboard-store.ts`、`dashboard-read.ts`、领域共享 dashboard 类型、迁移 `0008_dashboard.sql`、ports/kernel/outbox/changes/schema、registry、API app/core-adapter 集成、client/OpenAPI、pm-service/pm-data 查询 hooks、公共真实 HTTP 测试 fixture。不得编辑 feature 模块/页面或核心 schema/relation/scan。
2. **DashboardPersonal**：`dashboard-personal` 命名的 domain/application/前端组件及独立测试；关注、资料、会议、便签；通过自有迁移 `0009_dashboard_personal.sql` 扩展 users/profile。不得改共享入口。
3. **DashboardTime**：`dashboard-time` 命名模块/组件/测试；计时、工时、presence；必要约束迁移 `0010_dashboard_time.sql`。
4. **DashboardSprints**：`dashboard-sprints` 命名模块/核心适配器/组件/测试；`packages/pm-core/index.ts` 的观测持久化接入及独立 sprint-history 文件。cycle/任务关系不复制进 SQL。
5. **DashboardPortfolio**：`dashboard-portfolio` 命名模块/组件/测试；健康/风险、预算/支出/预测/历史；必要约束迁移 `0011_dashboard_portfolio.sql`。
6. **DashboardPlanning**：`dashboard-planning` 命名模块/核心适配器/组件/测试；`packages/pm-schema/index.ts`、relations/query 的工期/depends_on 校验；关键路径；公开 UpdateMilestone 契约。不得编辑 pm-core/index.ts 或共享 core-adapter；接口需要由 Foundation 接入。

主代理拥有计划/领域文档、正式 service-dashboard-1..4 及 dashboard-contract/page 接入、统一验收与服务/浏览器 smoke。其他会话修改的项目、团队、成员页面和公共布局原样保留。

### 供实现者使用的接口

共享 domain `dashboard.ts`：`DashboardRecord<T>`（id/workspaceId/projectId/kind/ownerId/version/data/createdAt/updatedAt/createdBy）。kind 为模块定义的字符串；不扩展旧 EntityKind 来混入辅助对象。

共享 application `dashboard-store.ts`：

- `insertDashboardRecord<T>(ctx, {kind, data, projectId?, ownerId?, id?}): Promise<DashboardRecord<T>>`。
- `readDashboardRecord<T>(ctx, id, kind): Promise<DashboardRecord<T>>`：工作区/项目/owner 授权；私有行只读本人。
- `updateDashboardRecord<T>(ctx, record, data): Promise<DashboardRecord<T>>`：所有已有记录必须校验 expectedVersions[record.id]，CAS 更新；无静默覆盖。
- `listDashboardRecords<T>(ctx, kind): Promise<DashboardRecord<T>[]>`：当前可见行，保留全量语义，不静默截断。
- `emitDashboardEvent(ctx, eventType, record): Promise<void>`：事务内事件，只发元数据；私有事件按 owner 隔离。
- `requireDashboardSelf(ctx): Promise<void>`：当前有效成员 + domain.read，不要求拥有整个工作区；记录 actor-scoped 收据权限。项目引用另外 `ctx.require('domain.read'/'planning.edit', projectId)`。

`DashboardReadContext`（位于 dashboard-read.ts）：`sql, actor, workspaceId, membership, now: Date, core`；core 提供 `get(id, kind?)`、`list(kind)`（旧 Entity 类型）、`records()`（经过当前 scope 过滤的原生 FileRecord）。command helpers 接受 CommandContext；list helper 支持 CommandContext 或 DashboardReadContext。模块 reader 负责必要的项目/成员二次授权与不存在对象处理。

模块导出：`dashboardPersonalCommands / dashboardTimeCommands / dashboardSprintsCommands / dashboardPortfolioCommands / dashboardPlanningCommands`，以及 `readPersonalDashboard / readTimeDashboard / readSprintsDashboard / readPortfolioDashboard / readPlanningDashboard(ctx)`。named DTO `PersonalDashboard / TimeDashboard / SprintsDashboard / PortfolioDashboard / PlanningDashboard` 在对应 domain 文件导出，client 公开导出并返回这些明确类型，不使用 ReturnType 暴露实现推导合同。

原生 Sprint/Planning 命令模块另导出 `isDashboardSprintsCoreCommand / executeDashboardSprintsCoreCommand`、`isDashboardPlanningCoreCommand / executeDashboardPlanningCoreCommand`（接收现有 CoreCommandContext 与可选 idempotencyKey，返回业务结果）。Foundation 在原有核心收据/日志/CAS 边界内调用并覆盖目标类型；严格 payload validator 由 application registry 所有、适配器复用。新增创建命令以 Create 开头；跨项目结果收据保留每个实际授权范围。

GET `/api/v1/workspaces/:workspaceId/dashboard/{personal,time,sprints,portfolio,planning}` 返回模块 DTO，不接受客户端 actor。API/查询 ctx 在复用当前鉴权后创建。客户端 `getPersonalDashboard/getTimeDashboard/getSprintsDashboard/getPortfolioDashboard/getPlanningDashboard`；hooks `usePersonalDashboard/useTimeDashboard/useSprintsDashboard/usePortfolioDashboard/usePlanningDashboard` 放入 pm-service，复用 usePrivateQuery 与现有私有 cache key、命令收据和刷新机制。

组件统一在 `apps/web/src/features/pm/service/dashboard-{module}.tsx` 导出可嵌入区域与编辑入口；组件自己调用对应 hook/useAction/usePmService；`projects?: Entity[]`、`issues?: Entity[]` 等需要时显式 props。不改正式 dashboard 页面，向主代理报告导出组件及 props、推荐插槽。保存使用现有 usePmCommand，不旁路未知结果 journal；新增后端能力不可用时展示真实错误，禁止 fixture/localStorage 充当持久化。

## 集成与验收顺序

1. 领域规则/上述契约冻结，并行完成六组实现；共享入口由 Foundation 单一所有者接入，所有生成契约最后统一生成。
2. 正式四页原位置替换 disabled/unavailable 区域；保留示例布局，提供真实创建/编辑/历史与 empty/error/loading/permission 状态，390px 不横向溢出。
3. 运行 `pnpm contracts:generate`；后端限定 lint/typecheck/unit/build；真实 PostgreSQL `pnpm test:backend`，跳过不计通过；前端 lint/typecheck/build。删除既有实现细节/固定命令数测试，不重新固定新数量。
4. 浏览器验收使用隔离 schema、Markdown/blob 根目录、API/Worker/前端端口和测试账号，不读取现有账号秘密。正式服务激活另行核验 PID、启动身份和工作目录，仅迁移并重启属于本项目的 API/Worker。真实浏览器完成十二项操作及刷新恢复、权限/版本冲突路径，保存截图/结果。
5. 核对 outbox/SSE 私有事件与撤权、跨工作区资料 CAS、计时并发与日界、Sprint 历史重启、图环路与缺失工期、币种/金额边界。验证不扩展现有 Agent 或全项目 G1/G2 声明。

## 交付证据

### 检查与运行

- `pnpm contracts:generate` / `pnpm contracts:check`：77 个命令、21 条路径，具名 Dashboard DTO 与可空来源时间合同一致。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`：通过；后端路径限定在 API/Worker/对应 packages，不格式化其他页面。
- `pnpm test:backend`：321 tests、12 suites，321 passed、0 failed、0 cancelled、0 skipped，包含真实 PostgreSQL、Markdown、HTTP、SSE 和独立 Worker。首次 600 秒运行中断且发现 Sprint 校验和及不稳定来源时间回归；修复后完整运行通过，不把中断/跳过算作通过。
- Sprint 独立复验：核心八项 + 真实 HTTP/CLI 六项，共 14 passed、0 skipped。损坏历史、缺失尾记录、中断 checkpoint、CLI/外部扫描与权限撤销均有覆盖。
- `pnpm --filter @pm/web lint && pnpm --filter @pm/web build`：最终通过。曾被并行设置页尚未落盘的模块阻断；保留其修改，模块完成后复验通过。现存大 chunk 与共享画布混合导入警告未被隐藏。
- 本机迁移到 `0011_dashboard_portfolio.sql`；既有本项目 API/Worker 重新启动后 `/health/ready` 返回 database/storage/worker/core 全 true、quarantinedEvents=0。`3220/pm` 实际打开登录页，无 pageerror。没有读取或写入现有用户的业务数据。

### 真实浏览器结果

使用隔离 PostgreSQL schema、Markdown/blob 目录、真实 API 与 Worker，正式 Vite production preview 端口 3339；没有拦截后端响应。后段使用独立 `dashboard-acceptance.localhost` 主机名，避免并行浏览器验收的同主机登录 cookie 相互覆盖。

| 场景 | 实际观察 |
| --- | --- |
| 关注 | 管理弹窗关注任务；Watching 只显示当前关注且可访问任务；修复表格关注按钮被更多菜单覆盖后，行内关注可点击 |
| 计时/工时 | 整页刷新保持同一 timer ID 和 startedAt；停止得到一条 61,963ms 工时；补录 1,800,000ms 后当日合计 1,861,963ms；不把运行中时间重复计入 |
| 资料/会议 | 修改姓名与 Asia/Shanghai 时区，账号页头/任务负责人/资料同步；创建会议后日程显示真实起止时刻；修复资料保存引发反复卸载和刷新循环 |
| 便签/在线 | 私有便签创建、完成、重开；切换 away 后服务读模型显示离开；另一账号无权读取原账号便签、关注与完整在线目录 |
| Sprint | 创建原生 CYC-001、逐项分配三个 TASK 并开始；D3 显示 active、3 个任务和真实离散观测，不生成每日历史 |
| 健康/冲突 | 显式 at_risk 及风险说明/严重程度/缓解措施持久保存；B 标签页提交后 A 草稿保留、保存禁用，显式采用当前版本后可保存并追加历史 |
| 财务 | CNY 预算 100,000、支出 25,000、剩余 60,000 时预测 85,000；剩余估计调整至 31,000，再将原支出纠正为 20,000，预测为 51,000。原 25,000 记录保留并作废，新记录引用原记录，财务历史共五条；金额均为最小单位 |
| 关键路径 | 2/3/1 日的三任务链计算为 6 日，一条关键路径；每项 total/free float 均为 0 |
| 项目依赖/改期 | PRJ-001 depends_on PRJ-002；搜索后图和表同步限制范围；里程碑日期改为 2026-11-05；受限账号仅见 PRJ-001、隐藏端点 ID/名称不出现、编辑禁用 |
| 布局 | 四页均查看 1440×1000 和 390×844；窄屏文档无横溢。D3 固定高度卡片改用已有滚动内容区，桌面风险及财务表单保存实测可达，不再覆盖下一行卡片 |
| 未知命令 journal | 真实 IndexedDB 复现复制标签页覆盖待核对命令；修复后占用键拒绝新命令，错误 ID 删除及旧命令延迟清理均不删除当前记录 |

八张截图保留在 `.local/evidence/dashboard-backend/dashboard{1,2,3,4}-{desktop,mobile}.webp`。真实 Agent/Runner、外部日历/邮件、自动汇率换算、资源平衡和公开互联网生产部署仍不在本次交付范围；不借此关闭整个项目 G1/G2/G3。

### 末轮复验与清理

全量测试发现 PostgreSQL 同一 client 上并行 query 的弃用警告。已将 Time/Portfolio 的同连接读取及账目加载改为顺序 await，不屏蔽警告；`node --throw-deprecation --env-file=.env --test --test-concurrency=1 tests/dashboard-portfolio.integration.test.ts tests/dashboard-time.integration.test.ts` 实测 12 passed、0 failed、0 skipped。修复后的后端 lint/typecheck/build 再次通过。

另以一次性真实 HTTP 脚本创建项目/任务、开始/停止计时、设置预算、记录支出及调整剩余成本；`--throw-deprecation` 下结果为一条工时、actualMinor=5000、forecastMinor=12000、三条财务历史。隔离浏览器、临时 API/Worker/preview 已关闭；一次性脚本删除，截图证据保留。未 commit 或 push。
