# 正式项目页面能力补齐计划

状态：P01–P10 已实现并接入正式页面，统一检查、真实浏览器验收及现有服务可用性核验完成。用户要求建立补齐计划并由 `gpt-6.1-sol:xhigh` 子代理执行；六个子代理完成各自实现，主代理完成集成与验收。

## 1. 依据与当前事实

- [领域计划第七节](../domain-design/README.md#implementation-plan)、[权限](../domain-design/permissions.md)、[不变量](../domain-design/invariants.md)、[后端交付记录](backend-delivery.md)、[Markdown 权威 ADR](markdown-integration-adr.zh.md)。
- 范围仅为正式 `/pm/<workspace>/projects` List 1–4 与 `/projects/<id>` Detail 1–2 及其必要业务入口；不以 Lab 页面作为交付。
- 重新读取仓库后发现 [Dashboard 补齐](dashboard-backend-completion.md) 已交付健康/风险及预算/支出/预测/历史。项目页必须复用 `dashboard-portfolio`，不得按之前页面的“未提供”提示重复建库。
- 项目、任务、里程碑、正文、日期、生命周期和正式核心关系仍由 Markdown 核心拥有。PostgreSQL 仅保存 PM 附加协作对象。不得引入 SQL 项目/任务副本，不改变 Run、Review 与工作项完成之间的边界。
- 本轮采用人工健康/信心评估；预算使用现有明确币种、安全整数最小货币单位及修正历史，不推导虚构财务或健康事实。

## 2. 交付清单

| 编号 | 能力与决策 | 验收标准 | 状态 |
| --- | --- | --- | --- |
| P01 | 个人项目收藏，独立于现有任务关注；按 actor + workspace + project 唯一 | 正式列表收藏/取消/筛选；刷新保留、另一用户隔离、撤权隐藏、旧版本拒绝 | 已实现 |
| P02 | 项目封面关联到本项目已登记的不可变图片成果版本；复用已有上传/下载，不建第二套 BlobStore | 选择/替换/移除后 List 1 与刷新一致；跨项目版本、非安全图片类型拒绝；未配置时仅显示默认装饰图 | 已实现 |
| P03 | 真实团队、团队成员、项目团队关联；团队是协作组织而不是权限授予 | 管理员创建/改名/成员维护/归档、关联项目；项目页展示真实团队；关联不扩大成员访问权限 | 已实现 |
| P04 | 项目授权范围内的最小身份目录，与 access.manage 完整成员管理分离 | domain.read 的项目成员可读该项目合法关联身份的 ID/姓名；不返回邮箱、权限、无关成员或不可见项目 | 已实现 |
| P05 | 列表里程碑摘要复用核心 milestone 和项目关联 | List 3 展示真实摘要；详情/列表与原生编辑一致，空/失败分开，不复制事实 | 已实现 |
| P06 | 项目页接入现有健康/风险及历史，增加可空人工交付信心 high/medium/low | 评估人/时间/原因和历史真实；与 Dashboard 读写一致；任务完成率独立显示，不自动关闭项目 | 已实现 |
| P07 | 项目页接入现有预算、支出、剩余估计、预测及历史 | 正式详情可保存与调整；刷新和 Dashboard 一致；旧版本冲突、币种和金额边界保持 | 已实现 |
| P08 | 独立结构化项目范围清单，作为 PM 协作注释，不替代 Markdown 正文/验收标准 | 条目稳定 ID、文本、完成标记；新增/修改/删除持久化，CAS 冲突保留草稿；勾选不改生命周期 | 已实现 |
| P09 | 授权的项目业务审计查询与游标分页；真实 API 写入的操作者、动作、版本和安全字段差异 | 新命令及核心 API 编辑可追踪；不依赖短期 SSE 留存；受限项目/私有事件/敏感字段不泄露；失败与重放不产生假成功或重复审计 | 已实现 |
| P10 | 任务行内编辑、看板状态拖动、甘特日期编辑复用现有核心写入 | 自定义工作流、revision、权限、归档和未知写入守卫不绕过；刷新一致；拒绝/冲突保留草稿，不盲重试 | 已实现 |

不额外扩展邮件邀请、独立评论回复树/表情/@投递、外部财务同步、跨设备显示偏好或服务端大规模搜索。这些是此前说明中的条件扩展；现有项目对话、浏览器显示偏好和前端筛选继续保留。

## 3. 数据与权限规则

- 新增记录复用 `dashboard_records` 与现有具名 `DashboardRecord<T>`/存储事务工具；表名是历史命名，不改变已有 Dashboard 行的含义。新 kind 使用 `project_favorite`、`project_cover`、`project_scope` 等独立命名；需要新表或唯一约束时只添加增量迁移。
- 收藏 `ownerId=actor.id`，读写需要当前项目 domain.read；私有事件和收据必须维持 audience/actor 隔离，绝不信任 payload.actorId。
- 封面/范围需要项目 planning.edit 且项目可写；封面来源必须是同工作区同项目的现存 ArtifactVersion，限定安全栅格图片格式；不允许任意外链或 SVG/HTML 冒充图片。文件访问继续鉴权，不把存储路径直接暴露。
- 团队定义、成员维护及项目团队关联由无限制工作区 access.manage 管理；不发送邀请、不自动 SetWorkspaceMember。仅有管理能力者可维护团队但不读取业务项目；项目关联还需该项目 domain.read。团队成员必须是本工作区有效成员。项目读模型只包含当前可见项目的关联，并裁剪各项目实际有权访问的成员。团队归档和成员撤销不得被缓存绕过。
- 最小身份目录从授权项目的 owner、assignee、合法团队关联等真实关系提取；只暴露最小姓名标识，不扩大发现全工作区成员的权限。
- 健康/财务沿用 DASH-INV-05。交付信心是独立可空字段；缺失不是低信心，不从健康级别或任务完成率推断。
- 审计另加 `audit.read` 能力，并仍检查项目范围；只记录安全白名单字段差异、命令/主体/版本/时间。私有内容仅原 actor 可见，不把消息、附件内容、凭据或完整 Markdown 原文写入公共历史。历史从本能力上线后的受控写入开始；外部文件/CLI 编辑无可信用户归属时不得伪装成某用户操作，既有最近文件更新作为不同来源展示。
- 命令写入保留 commandId、expectedVersions、事务、原收据核对与 outbox 规则。原生 PATCH 使用文件 revision，不伪装为 PM 命令收据；未知尝试保存在现有 CoreSession 草稿，跨原生页面/重载恢复后仍需读当前源文件并显式采用/放弃。同会话保护不等于实时跨标签页锁。原有 INV-01/10/13/14/15/17/20、SC-12/13/14/20、INF-01/03/05/06 适用；旧状态语义按 Markdown ADR，不重新引入审核完成前置条件。

## 4. 并行所有权与接口

六个子代理通过现有 task 模型配置使用 `gpt-6.1-sol:xhigh`、priority 服务级别；未修改全局配置。实现中途不运行 build/lint/tests/formatter；主代理整合后统一检查。新增行为测试验证权限、CAS、幂等、分页和业务边界，不固定源码文本/命令数量/转发细节。不要改无关并行页面、读取凭据或启动/停止其他项目服务。

### A. ProjectFoundation（共享入口唯一负责人）

拥有 `packages/application/src/registry.ts`、`apps/api/src/app.ts`、`packages/contracts/src/{client,openapi}.ts`、正式 pm-service/pm-data 查询 hooks；必要共享数据库 schema 登记。注册其他组命令，接入 GET 查询与具名 DTO，不自己定义其他组的业务语义。生成合同由主代理最后执行，不生成中间产物。

接口：
- `projectExtrasCommands(blobs)` 工厂、`readProjectExtras(ctx): Promise<ProjectExtras>`，来自 application/project-extras.ts；DTO 来自 domain/project-extras.ts。复用 BlobStore 检查已登记封面的真实字节。
- `projectDirectoryCommands`、`readProjectDirectory(ctx): Promise<ProjectDirectory>`，来自 application/project-directory.ts；DTO 来自 domain/project-directory.ts。
- `readProjectAudit(ctx, projectId, options): Promise<ProjectAuditPage>`，来自 application/project-audit.ts；DTO/options 来自 domain/project-audit.ts。
- reader 的 ctx 复用 `DashboardReadContext`，由当前有效会话及 core 适配器创建，不让客户端提交 actor。
- GET `/api/v1/workspaces/:workspaceId/projects/extras`、`/projects/directory`、`/projects/:projectId/audit?cursor=&limit=`。
- client `getProjectExtras(workspaceId, RequestOptions?)`、`getProjectDirectory(workspaceId, RequestOptions?)`、`getProjectAudit(workspaceId, projectId, ProjectAuditOptions?, RequestOptions?)`，沿用现有 `{signal}` RequestOptions，明确返回具名类型，不用 ReturnType。
- hooks `useProjectExtras()`、`useProjectDirectory()`、`useProjectAudit(projectId)`，复用身份隔离查询和现有刷新机制；审计 hook 返回原生 InfiniteData 的 `data.pages`、fetchNextPage/hasNextPage/isFetchingNextPage，不以首屏替代完整历史。

### B. ProjectExtras（收藏/封面/范围）

拥有新 domain/application/project-extras.ts、迁移 `0012_project_extras.sql`、前端 `project-extras.tsx` 及自有测试。命令名：`SetProjectFavorite`、`SetProjectCover`、`SetProjectScope`；统一严格输入/CAS/收据。`ProjectExtras.projects` 每项包含 projectId 与具名 favorite/cover/scope 记录（缺失为 null），完整覆盖当前可见核心项目。通过现有上下文校验项目和成果，输出前端可嵌入封面/范围编辑组件，收藏接入方式交给主代理。不得改列表/详情主文件、共享 API/client/hooks。

### C. ProjectDirectory（团队/安全身份目录）

拥有新 domain/application/project-directory.ts、迁移 `0013_project_directory.sql`、前端 `project-directory.tsx` 及自有测试。实现团队维护与项目关联，导出上面的命令注册、reader/DTO 以及可嵌入管理组件。最小身份 DTO 不带邮箱/权限；读者可见团队不得借 workspace-scoped 记录查询泄露无关成员。不得改正式团队页面/项目主文件或其他组文件；由主代理安排正式管理入口。

### D. ProjectPortfolio（健康/信心/财务复用）

拥有现有 domain/application/dashboard-portfolio.ts、前端 dashboard-portfolio.tsx 与新 project-portfolio.tsx 及对应行为测试。扩展可空人工 confidence 和历史，复用已有健康/预算/支出命令与组件，为项目详情提供紧凑只读概览和真实编辑入口。保持已有 Dashboard 调用兼容且不新建健康或财务事实源；新增导出/参数变更先查 LSP references。

### E. ProjectAudit（审计写入与安全分页）

拥有新 domain/application/project-audit.ts、迁移 `0014_project_audit.sql`、前端 project-audit.tsx、domain/core.ts 的 audit.read 能力，以及必要 kernel/core-adapter/core-routes/core-journal 审计接入及自有测试。不改 app.ts/client/hooks/registry。覆盖实际命令与核心 HTTP 编辑入口；文件写入/SQL 收据的不确定结果沿用原恢复边界，审计去重不能靠吞错误。审计数据应不可变，分页稳定；字段白名单和 actor/project 授权必须在后端。与 Foundation 同步 reader/options/query schema，主代理将该组件接入两种详情动态标签。

### F. ProjectTaskEditing（现有核心写能力接入）

拥有 `service-project-detail-panels.tsx` 中任务/Issue 区域及新 `project-task-editing.tsx`，必要已有 service-gantt 的向后兼容接口及行为测试。不改 service-project-detail.tsx 或共享查询入口。提供具名 `ProjectTaskEditing` 控制契约及 `useProjectTaskEditing(projectId)`，任务/Issue 组件接收可选 editing 参数；提供可嵌入 `ProjectTimeline`。使用 CoreSession 的真实配置、FileRecord/revision 与原生写入管理机制，不硬编码旧 SQL 状态、不绕过冲突和未知结果。保持附件/对话区域原样。

实施中授权的最小共享调整：Foundation 公开现有 `Workspace.assertWritable` 供封面/范围/团队关联命令复用，不新增写锁；Directory 只调整 `project_team` 存储授权，使单独 access.manage 能管理团队但不能读项目；TaskEditing 在原生 controller/WorkspaceEditors 复用同一草稿不确定性标记，避免导航到源码/设置后绕过锁。Portfolio 增加 `0015_project_portfolio_confidence.sql`，不回填旧评估历史。

### 主代理

拥有本计划/领域说明、正式 service-project-list.tsx、service-project-detail.tsx、pm-ui/项目受控布局与契约、项目相关导航及里程碑摘要整合。接入全部模块，处理六种布局、权限/加载/空/错误/版本冲突，运行统一验收并更新本计划实际状态。其他会话新增 Dashboard/设置/成员等功能保持不变。

## 5. 验收与激活

1. 子代理实现真实模块/回归测试并报告接口、路径及风险；主代理接入所有正式页面，移除已被真实能力替代的不可用提示。
2. 统一 `pnpm contracts:generate`、`pnpm check`、`pnpm test:backend`（真实 PostgreSQL，跳过不算通过）、`pnpm check:web` 和受影响共享视图 ESLint。仅格式化任务文件，不覆盖其他构建工作。
3. 独立临时 schema、Markdown/blob 根目录、API/Worker/Web 端口；浏览器使用独立 hostname 避免并行会话 cookie 冲突。逐项写入/刷新、只读及项目范围隔离、另一用户收藏隔离、版本冲突、审计分页；桌面与手机观察真实正式页面，不拦截服务响应。
4. 新迁移需实际应用到本项目后端才能让现有 `/pm` 使用。激活前核对端口、PID、启动身份和工作目录；只迁移/重启本项目 API/Worker，不停止其他项目服务，不修改用户业务记录。若无法安全识别运行环境，记录准确阻塞，不把临时服务验证称为已激活。
5. 清理自有临时 schema/服务/脚本，保留无秘密截图与结果；更新 README、领域补充规则和本计划证据，不 commit/push。

## 6. 实际验证记录

### 已观察的真实行为

- 临时 PostgreSQL schema、独立 Markdown/blob 根目录、真实 API/Worker 和正式 Web 路由；未拦截或伪造服务响应。截图与无秘密结果保留在 `.local/evidence/project-backend-completion/`。
- 收藏保存后重载仍在；另一用户未继承收藏。分别操作 List 1–4 的真实收藏筛选，只保留已收藏项目。筛选是当前页面状态，不承诺重载或跨设备保留。
- 创建已有成员组成的团队并关联项目，再通过正式入口改名、维护成员及归档；归档后项目不再展示该团队。范围条目添加、勾选、修改保持稳定 ID，删除后保存为空清单；选择、移除、恢复已登记 PNG 版本，浏览器鉴权下载的 Blob 图片实际解码成功。
- 正式详情保存 `at_risk` 健康、`medium` 信心及理由；保存 CNY 最小单位预算 1,200,000、剩余估计 800,000。列表健康/里程碑/团队来自相同真实读模型，完成率仍独立为 0%。
- 任务行内标题/优先级写入成功；实际指针拖动将任务从 `todo` 移到 `in_progress`；甘特写入开始/截止日期。提交期间刷新触发真实未知结果，重载恢复草稿，读取权威文件确认字段后显式放弃草稿解锁，未自动重试。
- 第二个真实 API 写入制造 revision 冲突；原草稿保留，明确采用新 revision 后再次保存成功。
- 项目受限读者只看到一个项目、最小 ID/姓名目录，没有团队管理分支或可用拖动操作；另一项目审计为 404，私有收藏审计不可见。撤销成员权限后当前浏览器清除了项目私有内容。
- 修复版审计浏览器“加载更早记录”从 30 增至 60 条；完整查询为 30/30/1，61 个唯一 ID 严格数值降序，无跨页重复。
- List 1–4、Detail 1–2 均在 1440px 桌面和 390px 手机实际加载并留图；十二个页面的文档 scrollWidth 均等于 viewport 宽度。

### 验收中修正

- 0014 同时移除 0001 留下的匿名成员能力白名单，避免旧约束拒绝新增 `audit.read`；不修改旧迁移。
- 团队表单采用本次已提交收据的版本，不把可能竞态的目录刷新当作提交确认，也不自动采用其他人的并发修改。
- 审计查询原来的文本输出别名影响 `ORDER BY id`，导致两位数以上记录排序及分页错误。改为 `ORDER BY project_audit.id DESC`，保留 PostgreSQL bigint 排序；真实数据库回归覆盖 98→100 的位数边界。
- 后端类型检查的 exactOptionalPropertyTypes 错误已修复，保持旧 journal 缺省字段的原语义；前端动作签名对齐现有受控契约。
- 合同测试移除入口文件名/源码正则扫描和描述文案断言，保留真实 `/openapi.json`、发布 YAML 与具名 schema 的一致性检查。新增模块拆分到独立路由文件不再造成假失败；权限和命令行为由真实 HTTP 集成测试覆盖。

### 检查状态

- 当前仓库合同：89 个命令 payload、30 条 OpenAPI 路径，包含保留的并行图谱、成员目录和邀请修改。前端 `pnpm check:web`（lint、TypeScript、Vite build）及受影响共享视图 ESLint 通过；既有 chunk-size/dynamic-import 构建提示仍保留。
- 项目补齐定向回归：真实 PostgreSQL、项目审计/目录/附加数据/查询/任务编辑及财务复用合计 36 项通过，0 失败、0 取消、0 跳过。
- 默认临时目录在机械盘上，既有冲刺历史用例触发 10 秒超时；首次完整命令又被执行器 900 秒期限中断。这些结果不算通过。最终使用 `TMPDIR=/dev/shm` 保留原业务断言及超时阈值完成检查，PostgreSQL 仍是真实数据库；并行更新造成的合同不同步已重新生成，未回退其他功能。
- 两套自有 API/Worker 均正常退出并报告临时 schema/根目录清理完成；两个临时 Web 服务、三个浏览器标签已关闭，验收脚本已删除。保留截图和 JSON 证据。
- 最终 `TMPDIR=/dev/shm pnpm check` 全链通过：文档、合同、后端 lint、类型检查、265 项测试及构建；受改动合同测试文件 ESLint 通过。`TMPDIR=/dev/shm pnpm test:backend` 385 项全部通过，0 失败、0 取消、0 跳过，包含真实 PostgreSQL、HTTP、独立 Worker、SSE 以及保留的并行功能回归。
- 正式服务核验：API PID 58552、Worker PID 58539 均属于本仓库，2026-10-20 08:26:39（+08:00）启动，晚于最终构建产物。数据库严格迁移/摘要检查通过，部署迁移集到 0017（本轮 0012–0015；并行成员目录/邀请 0016–0017）。`/health/ready` 返回 200，database/storage/worker/core 全部为 true，quarantinedEvents=0。
- 正式 projects/extras、projects/directory、projects/:id/audit 三条查询未认证请求均返回 401 而非未注册的 404。发现现有 API/Worker 已更新后未重复重启；保留原 3220 Web 进程 PID 43740，不向正式业务工作区写入验收数据。新增 `audit.read` 仍需显式授权，不迁移既有成员权限或补造历史审计。
