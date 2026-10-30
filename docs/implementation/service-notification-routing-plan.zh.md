# 站内通知接收人路由：实施计划

状态：**N01–N09 源码与共享接线已完成，隔离 SQL/文件/Worker/HTTP 与正式通知状态页面已运行；N10 业务实例激活仍待停写窗口**。原“拟”措辞及第13节是实现代理交接记录，实际集成结果见第14节与[统一交付](service-completion-and-acceptance.zh.md#five-package-delivery)。站内能力不等待 SMTP，但不冒充完整离线历史。

依据：[当前能力与待讨论项第七节](service-completion-and-acceptance.zh.md#plane-source-decisions)、[Markdown 权威 ADR](markdown-integration-adr.zh.md)、[领域实施计划](../domain-design/README.md#implementation-plan)、[现有站内活动交付](activity-inbox-delivery.zh.md)。适用 INV-01/13/14/15/20、DASH-INV-01/04、SC-12/13/14/20、INF-01/02/03/05/06；任务状态仍由已保存 Markdown 和既有工作流决定，通知不回写任务，也不恢复旧的审核完成前置规则。

## 1. 范围与已选默认

本包交付的是“这个已保存事件发给哪些人”的站内通知，而不是把全部可见活动改名为通知：

- 持续接收只复用已有**显式任务关注**；本次新增提及只形成**该次事实**的接收理由。创建、受派、评论、被提及、团队成员身份都不自动关注。
- 已识别的可信操作者不接收自己的事件；关注与提及取并集，同一事实、同一接收人只有一条通知。
- 写入提及时验证身份与当前权限；生成接收人、列表、计数、状态修改和打开目标时再读当前授权。关注、提及及通知记录均不赋权。
- 任务创建、元数据／正文保存和生命周期事实、SQL 任务评论，按第 3 节明确的事件矩阵接入；不声称覆盖九类 Markdown 对象的全部历史。
- 本批只有站内渠道；没有邮件、Push、团队／全工作区 mention、安静时段、摘要频率、自动截止提醒、供应商连接器或动态插件。
- 与出站 Webhook 共用一份安全事实源，但**不同受众、不同投影、不同消费状态**。内部提及身份、关注者、个人已读归档、评论原文和认证数据不能进入外部载荷。

以下是本计划选定的实施默认，不是现状，也不表示用户已选择无限保留或其他未讨论的产品政策。需要用户决定的事项单列第 10 节；不以这些扩展事项阻塞本包可独立实施的基础。

## 2. 迁移前已核实的实现与缺口

| 真实文件 | 当前实现 | 对本计划的约束 |
| --- | --- | --- |
| 已移除的旧 `activity-state.ts`／领域可见性、[0022](../../packages/infrastructure/migrations/0022_activity_state.sql) | 迁移前从 `events` 扫描最多 200 个流位置，个人状态依赖 events 外键；已由 [0026](../../packages/infrastructure/migrations/0026_service_facts_notifications.sql) 无损迁入，旧表和旧新写入口移除。 | 旧版不是明确接收人事实；新源不再依赖 SSE retention。原旧命令收据仍按原 ID 查询，不保留业务别名。 |
| [outbox.ts](../../packages/application/src/outbox.ts) | `publishOutboxBatch` 把 outbox 发布进 `events`，再标记 `published_at`；失败累计至 10 次会隔离工作区。`pruneEventHistory` 当前删除 `events`、过期会话和心跳，**没有删除 outbox**。 | 不把 `published_at` 当站内／外部送达；也不误称 outbox 当前随事件保留期清理。outbox 即使尚在，也不是本包承诺的永久业务事件接口。 |
| [changes.ts](../../packages/application/src/changes.ts) | 返回当前授权的安全元数据，去除完整 envelope/payload；cursor 是缓存失效流位置。 | changes/SSE 只负责使查询失效；不以流消费成功建立通知权威，更不能在断流后拼凑完整历史。 |
| [dashboard-personal.ts](../../packages/application/src/dashboard-personal.ts)、[dashboard-store.ts](../../packages/application/src/dashboard-store.ts)、[0009](../../packages/infrastructure/migrations/0009_dashboard_personal.sql) | `WatchTask` 保存 `dashboard_records(kind=task_watch, owner_id, project_id, data={taskId,watching})`；活跃关注有唯一索引。`UnwatchTask` 修改原记录并检查版本。Dashboard 只显示仍绑定当前项目且可见的关注。 | 唯一持续订阅存储已经存在；不能另造 subscriptions 表。已有多个已取消关注记录并不等于多个活跃订阅。 |
| [task-comments.ts](../../packages/application/src/task-comments.ts)、[评论领域合同](../../packages/domain/src/task-comments.ts) | SQL 评论、不可变版本、作者 CAS、软删除／恢复；`domain.read` 读、`intent.propose` 写；原 commandId、审计和 outbox 在命令事务内。正文不进收据或 SSE。跨项目改变返回 `task_comment_project_changed`。 | 在同一评论事务中增加事实与本次提及；不另造评论正文副本、不扩大历史受众。现有 payload 只有 content 等字段，尚无提及协议。 |
| [project-audit.ts](../../packages/application/src/project-audit.ts)、[安全字段投影](../../packages/domain/src/project-audit.ts) | 持久审计有原来源、commandId、目标和前后版本，按复合键去重；读取另要求 `audit.read`。白名单仍可能含标题、姓名引用或金额。 | 不把完整审计直接发给只需 `domain.read` 的通知用户，更不能直接转发外部。它是恢复模式参考，不是全部 Markdown 事件或提及源。 |
| [core-journal.ts](../../apps/server/pm/src/core-journal.ts)、[core-adapter.ts](../../apps/server/pm/src/core-adapter.ts)、[app.ts](../../apps/server/pm/src/app.ts)、[core-bridge.ts](../../packages/application/src/core-bridge.ts) | 核心命令用 `.pm/state/pm-command-journal.ndjson` 的 pending/completed 区分未知与已知结果；completed fsync 后再持久化 SQL 收据／审计。适配器捕获安全审计，不为每个核心保存产生当前活动事件。 | 新事实必须沿原命令身份进入 journal 与 SQL 恢复；不能只给 SQL 评论加事件就声称任务通知完整。 |
| [core-routes.ts](../../apps/server/pm/src/core-routes.ts) | 原生创建、源码／属性修改、归档／恢复／删除经过 `auditedMutation`；有 `http_pending/http_completed` 和创建 prepared 信息；原生结果不是 PM CommandReceipt。配置、保存视图和迁移另有路由。 | 需要接入实际写入点与原生恢复，不能把新通知 commandId 代替原生 key。现有 completed 前崩溃窗口不能被描述为已有完备提交证明。 |
| [pm-core/index.ts](../../packages/pm-core/index.ts)、[state.ts](../../packages/pm-core/state.ts)、[repository.ts](../../packages/pm-core/repository.ts) | 原文写入有文件 revision/CAS、原子替换和 fsync；创建／删除有耐久协议状态，普通更新没有同等业务完成收据。watcher 去抖后重新扫描，`onChange` 只给 change/error 与 reason，不提供不可变业务事件。 | 需要持久变更边界和观测基线；不能消费 `onChange`／SQLite cache 就承诺记录每个离线中间版本。 |
| [pm-notification-hooks.ts](../../apps/web/src/features/pm/service/pm-notification-hooks.ts)、[service-notifications.tsx](../../apps/web/src/features/pm/service/service-notifications.tsx) | 旧活动 hook 已迁移；正式页读取定向通知并可切换历史活动状态。仍复用私有 Query、串行状态命令、IndexedDB 原请求核对和 CommandNotice。 | 没有第二套命令 journal／SSE；来源、有限历史及 pending/error 明确显示。 |
| [通知路由回归](../../tests/notification-routing.integration.test.ts)、[评论回归](../../tests/task-comments.integration.test.ts)、[原生恢复回归](../../tests/core-creation.integration.test.ts) | 复用真实 PG／HTTP 夹具、事务故障、原命令恢复及文件先提交 SQL 后失败的模式。 | 测试源码不是本轮通过证据；旧活动回归已迁移到通知合同。 |

## 3. 事件矩阵与明确覆盖边界

### 3.1 本批选定的站内事件

同一次保存形成一个事实，可有多个 `changeKinds`，但不会按每个字段／接收理由再拆一条站内通知。对于 work_item：

| 已保存事实 | 显式关注者 | 本次提及者 | 说明 |
| --- | --- | --- | --- |
| `created` | 事实首次入源时已有有效关注者，通常为空 | 新任务已保存正文中经服务端验证的个人提及 | 创建时的“关注此任务”仍是已有独立 WatchTask 子操作，保留原分项恢复；不倒灌一次创建通知。 |
| `metadata_changed` | 是 | 只有该次也新增了正文提及时 | 范围限定为任务标题、状态以外的业务元数据、负责人、优先级、日期、标签、估算及正式关系变化；只输出变化类别，不复制字段原值。指派本身不是接收规则。 |
| `content_changed` | 是 | 已认证保存中相对上一已保存正文新增的用户 ID | 未保存草稿、预览及编辑器输入不产生事实。只改标签文字但 ID 未变不重提及。 |
| `lifecycle_changed` | 是 | 只有同次正常保存新增提及时 | 状态、归档／恢复；遵守自定义工作流实际保存结果，不由通知完成任务。核心永久删除只保留内部事实，当前对象缺失时不新增定向送达，原通知按当前读取规则隐藏。 |
| 评论 `created` | 是 | 此版本新增用户 ID | 独立 `restricted_internal` 评论事实，与核心正文保存不同。 |
| 评论 `edited` | 是 | 新版本集合减去前一已保存版本集合 | 同一评论未变的提及不再次发送；先移除、后在另一版本重新加入是新的本次提及。 |
| 评论 `deleted/restored` | 是 | 否 | 不从恢复的旧内容再次展开提及；详情只用当前评论读取协议呈现隐藏／恢复，不展示复制的删除前正文。 |

元数据与生命周期分类互斥归类：状态／归档属于 lifecycle，其余指定元数据属于 metadata；正文同时变动可再加 content。单纯字节格式变化而语义摘要未变不产生站内通知。核心事实可以记录 revision 改变，但若无本表类别，不进入站内接收矩阵。

**不在矩阵内**：项目／里程碑的自动全员通知、任务“参与者”、全部项目成员、个人便签／计时／资料、成员／认证事件、活动／通知状态失效事件、其他六类核心对象、外部附件正文、会议、到期调度。项目／里程碑的受控安全事实可供共享源和 Webhook 使用，不因此引入项目关注模型。没有选择的事件不悄悄落入 `property_change` 万用兜底。

### 3.2 各来源的保证

| 写入来源 | 拟持久边界 | 身份／提及 | 能保证与不能保证 |
| --- | --- | --- | --- |
| PM `/commands` 核心命令 | 原 commandId → 文件保存 → 带事实的 durable completed journal → SQL 事实／原收据 | 可信 actor；本次新增任务正文提及可验证 | 成功确认的选定保存必须有可恢复事实；原 commandId 重放不再保存或重复派生事件。一个多对象命令逐对象持久事实，不伪称跨文件事务。 |
| 原生 HTTP：`POST core/entities`、`POST core/items`、`PUT core/files/:id`、`PATCH core/entities/:id`、archive/restore/delete | 原生 scoped key／request hash、实际前后 revision、扩展的 prepared／completed journal，再进入同一 SQL 源 | 可信 actor；本次新增任务正文提及可验证 | 原生结果继续使用自身恢复协议；不是另造 PM 收据。源码、属性、任务创建及看板／日期等所有这些调用者共用同一接入点。 |
| SQL 评论命令 | 评论版本、事实、内部路由输入、原收据、既有 outbox 同事务 | 可信 actor；服务端解析评论新增提及 | SQL 回滚时均不存在；正文仍只在评论／版本表。 |
| 已启动 API 的 watcher／独立文件编辑／不带 PM 身份的核心库或 CLI 写入 | 真实有效扫描结果 → 耐久观测记录／checkpoint → 同一 SQL 事实源 | `actorId=null`、`commandId=null`；不展开正文提及 | 可给关注者发“观察到已保存变更”；不把文件 mtime 当发生时间，不把最近登录者当作者。只能保证持久观察到的差异。 |
| API 离线期间连续外部修改，或工作区尚未打开 | 重启／首次接入扫描与最后耐久基线对比 | 同上 | 一次标注为观测差异；离线 A→B→C 只看到 A 与 C 时不编造 B，不承诺每次保存、不补造历史作者／发生时间。首次无基线只建基线，不广播整个既有仓库。 |
| 配置、保存视图、迁移、批量外部导入 | 不冒充单次受控任务命令；有效任务差异可走观测来源，记录 scan reason | 无可信每条作者；无提及 | 不声称现有 auditedMutation 已覆盖这些接口；只发本矩阵真实观察到的任务差异，不发配置／迁移原文。 |

API 的独立 importer 与核心访问都可首次建立唯一 Workspace；缓存获取等待既有串行磁盘刷新，watcher 防抖不再是读取正确性的前置条件。捕获显式显示未观察/错误/积压，不重建 API 停机期间未观测的中间历史；Worker 只读核心文件，不创建第二个 Workspace/watcher。

## 4. 无歧义提及协议与服务端校验

### 4.1 身份表示

拟新增 PM 个人提及语法：`[@显示名](pm-user:11111111-1111-4111-8111-111111111111)`。身份只取 `pm-user:` 后的**规范小写 UUID**；显示名只是可变呈现，不按姓名、email、核心 TASK ID、`@foo` 文本或团队名匹配。

- 使用现有 [Markdown AST／隐藏评论语义](../../packages/pm-markdown/syntax.ts) 识别普通 inline link；只接受该 scheme、精确 UUID、普通文本标签。不得有域名、路径、百分号替代身份、query、fragment 或隐式团队展开。
- 代码块、行内代码、HTML、数学、图片、隐藏 `%%...%%` 评论、引用示例块中的 token 不激活；转义内容保持字面。引用式链接不作为本批提及。保留原 Markdown，不把 HTML 渲染结果回写。
- 正文和评论使用同一解析函数；提取去重后的 ID 集合。请求不能提交任意 `recipientIds` 或由客户端声称的 mentions 清单；服务端从**实际待保存且最终保存的内容**派生。
- 拟技术上限为每次正文／评论 50 个唯一提及 ID，超限整体拒绝并保留草稿，不静默截断。UUID 只规范化身份，不改写普通中文／英文正文。
- 提及渲染是专门的非外联控件，不把 `pm-user:` 通用放入 URL allowlist。标签不可信；只有现有目录授权允许时读取当前脱敏姓名，否则显示中性“成员”，不伪造姓名或暴露 email。已失效的历史 token 仍保留原文，不因此授予身份或权限。

### 4.2 验证与“本次”含义

对**本次新增 ID**，在现有工作区锁／原命令事务与核心 mutation guard 的授权边界内验证：操作者仍可写当前任务／评论；目标用户未禁用，有当前有效 membership，具有该任务原项目的 `domain.read`，且正文／评论绑定的工作区和项目一致。目标不满足时统一 `mention_not_eligible`，不泄露哪个 ID 存在于其他工作区。

编辑时集合差 `newIds = afterIds - previousCommittedIds` 才是本次候选；旧 token 未变时不重新要求历史身份有效，否则撤权一个历史提及会阻止无关正文编辑。新加无效 token 拒绝本次保存；外部文件中无效 token 不回写或阻止核心文件读取，只不展开通知。操作者自身 token 可保存，但在路由时排除。保存已发生而后续权限撤销，不回滚正文；Worker 再授权时跳过接收人。

拟新增 `GET /api/v1/workspaces/{workspaceId}/tasks/{taskId}/mention-candidates?projectId=...&q=...&after=...&limit=...`：当前 `domain.read`、当前任务项目绑定和既有 `directory.read` 规则均满足时，返回分页 `{userId,name}`，只列可读该项目的有效成员，不返回 email／电话。复用目录裁剪逻辑；没有目录能力时禁用搜索选择器，不用另一路接口绕过目录权限。手工输入 token 同样服务端验证，不提供用户存在性探针。项目移动仍失败关闭，不以提及扩大历史读者。

## 5. 共享持久事实与内部路由数据

以下是批准的共享合同，当前实现为 [0026_service_facts_notifications.sql](../../packages/infrastructure/migrations/0026_service_facts_notifications.sql) 与 [notification-schema.ts](../../packages/infrastructure/src/notification-schema.ts)；不另建 Webhook 核心事实源。

### 5.1 唯一共享事实源 `service_fact_events`

拟列：

| 字段／约束 | 合同 |
| --- | --- |
| `fact_id uuid` | 稳定事件身份；新保存可预分配随机 UUID 并写入 journal，重放必须沿用；遗留迁移沿用原 eventId。不能用 commandId 直接充任多对象事件 ID。 |
| `workspace_id`、`fact_sequence bigint` | `(workspace_id,fact_sequence)` 唯一；在既有 workspace 锁下分配并提交。它不是裸 bigserial 的“提交安全游标”，也不复用 SSE stream_cursor。 |
| `schema_version`、`source_kind`、`source_key`、`source_digest` | source 为 `command / core_http / core_observation / legacy_activity`；唯一 `(workspace,source_kind,source_key)`，同键不同 digest 报 `fact_idempotency_conflict`。source_key 包括原 actor／原操作身份、目标和稳定操作序号；external 使用耐久 observation 序号。 |
| `project_id`、`entity_kind`、`entity_id` | 保存当时的范围与目标，核心 ID 保持原字符串；新站内任务事实必须明确项目。跨项目变化、范围不明或无法验证 revision 的记录不进入普通路由／出站。 |
| `before_revision`、`after_revision` | 可空版本字符串；核心为真实 revision，评论为不可变版本号字符串。不得把个人状态 version 或 SSE cursor 当业务 revision。 |
| `change_kinds` | 安全分类 `created / metadata_changed / content_changed / lifecycle_changed`；评论为独立内部事件类型和 action，禁止外部通配消费。 |
| `occurred_at`、`observed_at`、`recorded_at` | 可信受控提交时间／真实扫描时间／SQL 入源时间分开；外部 `occurred_at=null`。恢复不改写原时间。 |
| `safety_class` | `project_fact / restricted_internal`。SQL 评论、遗留活动、跨范围／无法裁剪事实为 internal。个人／认证内容不因落入源就获得对外许可。 |

事实为不可变最小元数据：**无标题、Markdown、评论正文、完整字段值、路径、email、凭据、二进制或任意 envelope**。共用源不是 SQL 任务副本，不能用来回答任务当前状态／授权／完成条件。已选任务类别可保留字段名或摘要用于分类，不保留字段原值。

共享核心采集覆盖 `project / work_item / milestone` 的受控写入与有效外部观测，供 Webhook 白名单消费；项目事实的 projectId 为自身 ID，任务／里程碑使用已验证所属项目。站内新路由仍仅消费第 3 节的任务及内部评论矩阵，不能因为共享源覆盖三类对象就自动新增项目／里程碑订阅。其他六类核心实体不在本批事实采集承诺内。

持久边界：新 SQL 评论事实和评论版本同事务；新核心事实先随原提交完成结果 fsync，再与 SQL 收据／审计恢复在同一 SQL 事务插入。通知不能依赖将来一定能从 outbox、保留期 events、SSE 或 cache 重建。事实保留与 events 保留相互独立，未选择物理保留政策前不自动删除本源／通知归档。

### 5.2 内部路由扩展与接收人

拟 `notification_fact_inputs`：`(workspace_id,fact_id)` 唯一 FK，包含可信 `actor_id|null`、`task_id|null`、可空 `comment_id/comment_version`、`original_project_id`、原私有 audience 约束（只用于遗留）、`watch_candidates`、`new_mention_ids`、`routing_policy_version`。routed 任务／评论必须有 task_id；legacy 非任务活动允许为空，不伪造任务关联。候选是**该事实的一次性接收依据**，不是第二套可编辑 subscriptions；后续事件始终从 `dashboard_records.task_watch` 读取持续关注。

- 受控命令／原生写入在原授权锁内捕获当次有效关注候选和新增提及；随 durable outcome 一起保留，恢复不能用今天新加入的关注者重写过去受众。
- 外部观察没有可还原的历史 SQL 关注时间线：在该观察首次入 SQL 源、持有 workspace 锁时冻结当前关注候选；`recordedAt` 明确表示路由观察时点，不冒充磁盘原始保存时点。同一观察重导入不扩展候选，之后关注不补发。
- 候选关注记录 `ownerId/watchRecordId/watchVersion`，必须 `watching=true`、watch.projectId 等于当前任务及原事实项目、owner 为有效成员；Worker 再查**同一条** watch 仍有效，不以后来重新关注的新记录替换旧候选。仅 watch 理由在入队前被取消即跳过；同时有 mention 理由的仍可按 mention 接收。取消关注不删除已经送达的个人历史。

拟 `notification_recipients`：`(workspace_id,fact_id,recipient_id)` 主键；不可变 `reason_set`（`watch / mention / legacy_activity_state`），`origin`（`routed / legacy_activity`）、`enqueued_at`、`delivery_cursor bigint`、本人 `state_version >= 1`、`read_at`、`archived_at`。它同时拥有投递后的个人状态，不另建重复 notification_states 表。routed 初始 v1；同值命令核对 CAS 但不增版本，实际改变递增；read/archive 独立。legacy 可按第 8 节精确保留旧 v2+。

`delivery_cursor` 与 `fact_sequence`、SSE cursor 分离：拟工作区 `notification_head` 在 workspace 锁内随**新 recipient 事务提交**递增，`(workspace_id,delivery_cursor)` 唯一。延迟路由的旧事实获得新的 delivery cursor，否则客户端经过某 factSequence 后会永久漏掉后来补入的旧事实通知。重复投递不分配新位置，状态修改不移动位置。分页 head 取此提交安全 delivery 水位；事件展示按可信 occurredAt、否则 observedAt／recordedAt 排序，同时间以 delivery cursor 稳定排序。

拟 `notification_route_jobs`：每事实唯一，`state=pending/running/completed/failed`、`lease_owner`、`lease_until`、`lease_epoch`、`candidate_after`、`attempts`、`next_attempt_at`、`last_error_code`、完成／跳过计数。只消费已提交事实，不靠共享单游标跳过失败事实；每个接收人结果和本事实的批内 checkpoint 同事务。

拟每工作区通知激活记录：`activation_fact_sequence`、迁移状态、`routing_policy_version`。只有激活之后产生且匹配矩阵的新事实进入 routed；旧事实不能因消费者重启全量补发。

### 5.3 commandId、factId 与重复的边界

1. 原 `/commands` 的 `(actor,workspace,commandId,requestHash)` 仍是业务幂等；丢响应只查询原收据。notification Worker 不调用该命令，也不生成替代 commandId。
2. 每个派生事实按原操作身份＋目标＋稳定操作序号唯一；一个命令可有多事实，多个 changeKinds／watch+mention 仍对应同一事实。不使用前后 revision 对作为唯一身份，因为真实 A→B→A→B 可以发生两次。
3. 原生 key 保留当前 actor/workspace/action/target/requestHash 语义；`core_http` 不造 PM CommandReceipt。原 key 的已知完成恢复只补事实／审计，不再次保存文件。
4. 观察身份由 durable checkpoint／递增 observation 序号给出；相同 watcher 通知反复扫描、仅 cache 重建不会生成新事实。相同 revision 在不同真实观察序列再次出现，不被错误合并。
5. 最终唯一键 `(workspace,fact,recipient)` 防止 Worker 重复执行、两个原因、并行进程产生多条；发现同 sourceKey 内容不一致要隔离并显式核对，不能 `ON CONFLICT DO NOTHING` 掩盖相互矛盾的事实。

## 6. 核心持久边界、Worker 与当前授权

### 6.1 核心事实进入 SQL 的执行顺序

在 [CoreCommandJournal](../../apps/server/pm/src/core-journal.ts) 扩展可选带版本 `facts/routingInputs`，兼容读取旧记录；旧记录不凭当前文件补造成历史新事实。在核心实际 mutation 点增加结果捕获接口，而不是在返回后的页面动作上补事件：

1. 当前授权、revision、目标项目及提及验证通过；捕获本次安全事实输入及接收依据。创建使用最终分配 ID／prepared 回调，更新使用 guard 内真实 before 与候选 after，删除沿原耐久墓碑路径。
2. 保存前准备记录绑定原操作身份、预分配 factId、预期前后 revision 与安全输入；准备记录本身**不是已经发生的事实**。复用原 `.pm/state` journal 的 fsync／目录持久化与严格 schema，不写正文到 PM journal。
3. Markdown 按既有 CAS／文件持久协议提交；其后在工作区串行队列放行下一次受控写入前，fsync 确认的事实／completed 结果。原 journal 绑定实际完成的 per-object 结果，不能把预期成功结果直接发布。
4. 同一 SQL 事务写原收据／审计、共享事实、内部输入和 pending 路由 job；失败则显示原有 unknown／audit-pending 恢复，不返回虚假通知成功。业务保存结果与“已排队／待恢复”分别表示。
5. API 启动及有界后台恢复器扫描 durable completed 记录补 SQL；恢复不要求原客户端重新在线，也不执行任何业务命令。不能把“原作者现已撤权”当丢弃既有保存事实的理由；真实接收人仍按当前授权裁剪。
6. 若文件已写但 completed 未 fsync：只在现有创建幂等台账、墓碑或扩展后的精确提交证明能够证明时恢复原身份事实。普通更新仅凭 prepared 或“今天恰好相同的字节”不足以证明原操作者提交；维持 unknown，必要时只生成 `core_observation`。外部已再改写时不伪造丢失中间历史、不重放文件、不发送未经证明的提及。

实现不能声称跨文件／SQL 原子事务。成功返回的选定保存必须先有耐久事实；崩溃未确认的极小窗口有上述可核对／降为观测的边界。现有 pending 语义不能被为了通知而改成“超时即失败／自动重发”。

外部观测复用 [SprintHistory](../../packages/pm-core/sprint-history.ts) 的“耐久观测＋checkpoint 先于 cache 发布”模式，拟在 `.pm/state/` 保存独立通知／Webhook共同观测基线和只含安全摘要的记录。该基线只用于差异发现，不用于当前业务读取。应在成功 scan 的**有效、非 stale、无歧义**项目、任务、里程碑结果上记录；错误来源维持错误／缺口，不把上次好值冒充新保存。SQL 导入 checkpoint 仅在事实事务提交后推进，崩溃重读按 sourceKey 幂等。恢复 completed 事实优先于普通扫描，避免同一受控保存又被 watcher 当作第二次外部变更。

### 6.2 当前核心读取端口

Worker 当前没有 CoreWorkspacePool。拟新增应用用只读 core 检查端口：复用 [FileRepository](../../packages/pm-core/repository.ts) 的安全收集／读取和已有 schema／关系校验，**不调用 `Workspace.init()`、不写 SQLite/state、不另开 watcher**。它每批读取当前真实文件／项目、检测重复 ID、stale／无效源、项目绑定和删除；不以 SQL 事实／缓存投影代替当前实体权威。API 列表／修改同样复用此检查或现有新鲜 core scope。

当文件恰在外部写入或范围不一致时失败关闭，保留 job 供安全重读；没有取得当前权威不算“没有对象／没有权限／成功投递”。当前确认已删除、任务项目已变化或评论历史绑定不符的候选不投递；既有条目在查询时隐藏，不迁移到新项目，不暗中扩大历史受众。

### 6.3 有界路由循环与恢复

沿 [现有 Worker](../../apps/server/worker/src/main.ts) 新增**独立有界循环**，不阻塞 outbox/SSE 心跳或邀请 SMTP；不用 Redis／RabbitMQ 或通用 job 框架。API 的文件 journal 导入恢复也有独立有界循环，不能让 HTTP GET 顺手推进持久状态。

- 按既有 workspace 锁优先的统一锁顺序领取，再在该工作区内领取到期 pending 或过期 running job；新租约增加 epoch。一次事务只处理有限候选页（拟 100 人），批间释放锁，不长持文件 IO／网络请求。
- 每页从冻结候选重查：用户未禁用、membership 未撤销、当前 `domain.read` 及项目范围、任务当前项目与源项目一致、评论绑定、原私有 audience、仅 watch 理由的当前 watch 状态；排除可信 actor；合并 watch+mention 原因。
- 当前核心读取在事务授权与写入前完成并确认 revision／项目未变；读失败可重试，确定不再可读记内部跳过。列表示数和正文详情仍需再次鉴权，因此候选曾通过不形成永久访问许可。
- 收件人插入、候选 checkpoint、actor-private `NotificationInboxChanged` 最小 outbox 失效事件同事务；失效只含接收 actor 的 aggregate 与空 payload，不含目标、提及／关注者名单、已读归档值，不反向成为可路由事实。
- 崩溃在事务提交前：整页回滚；提交后崩溃：重复页命中唯一键，状态不会重新变未读／未归档。旧租约进程必须凭 epoch 条件更新，否则不能完成新租约工作。
- 纯站内 SQL 没有外部“送达未知”副作用；结果以数据库提交为准，不制造邮件式假 delivered。连续错误退避，上限拟 10 次后保留 failed，显式按 factId 重试且沿原身份；不自动新建事实／新收件人身份。
- 运营可看脱敏 sourceKind、jobId、错误码、尝试数、最老未入源／未路由年龄和数量，不记录正文、提及名单或身份私密字段；API 不得在 backlog 存在时显示“历史已完整追平”。

## 7. 拟 HTTP、状态命令与前端合同

### 7.1 查询与修改

拟新增 `GET /api/v1/workspaces/{workspaceId}/notification-inbox`，查询 `origin=routed|legacy_activity`、`after?`、`through?`。返回：

```ts
{
  items: Array<{
    event: { eventId: string; eventType: string; projectId: string | null;
      entityId: string; entityKind: string; revision: string | null;
      occurredAt: string | null; observedAt: string | null; recordedAt: string };
    origin: 'routed' | 'legacy_activity';
    target: { taskId: string; commentId?: string } | null;
    reasons: Array<'watch' | 'mention' | 'legacy_activity_state'>;
    state: { eventId: string; version: number; readAt: string | null; archivedAt: string | null };
  }>;
  cursor: string; head: string; membershipVersion: number;
  sourceCoverage: 'selected_saved_facts';
  historyBoundary: { activatedAt: string; legacyImplicitUnreadNotImported: boolean };
  processing: { status: 'current' | 'pending' | 'error'; asOf: string };
}
```

`target` 仅在当前任务／评论授权检查通过后返回；评论条目给真实所属 taskId 与 commentId，不能将 commentId 冒充任务 ID。遗留非任务活动没有可验证导航目标时返回 null，保留历史状态但不提供假跳转。

DTO 是计划合同，实施时进入单一 schema／生成客户端。查询仅从**本人 recipients** 出发，再与当前授权相交，不给管理员读取他人 inbox 的旁路。快照分页复用当前有限扫描模式：每页最多 200 个真实 recipient 位置，首屏固定提交安全 head；隐藏页可为空但 cursor 必须前移；membershipVersion 或会话作用域变化重读整页，不跨授权合并。计数、搜索和详情都只对同样授权集合计算，不泄露不可见条目总数。保留边界不再冒用 SSE retention；未来若清理通知，须独立定义 410／重读与不可恢复提示。

拟命令仍走既有 `/commands`：

| commandType | payload／身份 | CAS／结果 |
| --- | --- | --- |
| `SetNotificationRead` | `{read:boolean}`，`targetId=factId`，不接受 recipientId 或 projectId | `expectedVersions[factId]=本人的state.version`；返回最小个人 state。 |
| `SetNotificationArchived` | `{archived:boolean}`，其余同上 | 同值核对但不增版本；实际改变递增，read/archive 相互独立。 |

每次写要求当前有效本人、原接收人行和当前对象／项目授权；他人、任意 UUID、跨工作区、撤权、已删除／迁移不可读统一 `not_found_or_forbidden`。旧 CAS 返回 409 `version_conflict`；同 commandId 不同请求仍为 `idempotency_conflict`。原收据继续由现有 actor＋项目 scope 检查，不能跨 actor 恢复；GET 原收据不复活已隐藏条目。

### 7.2 入口与交互

- `/pm/<workspace>/notifications?view=inbox3|inbox4` 默认接**定向通知**；同页明确的“历史活动状态”文件夹／来源页接迁移数据，显示来源标签和边界。二者不是“邮件”和“已投递邮件”。
- 复用 `NotificationInboxView`、私有 Query key、`usePmCommand`、CommandNotice、串行本页已读和原 IndexedDB journal；可把 `pm-activity-hooks.ts` 重命名／迁移为通知 hooks，但不永久保留两个写入口／两套状态。
- 列表只展示安全事件类别／当前可授权解析的对象；评论通知从当前任务跳到对应评论锚点。不能像当前只支持 project/work_item 的 openEntity 那样把 commentId 当任务 ID。已删除／隐藏评论显示当前墓碑，不展示已复制正文。
- 详情打开不偷偷标已读；watch+mention 显示两个理由但一个条目。本人关注入口继续复用 WatchTask／UnwatchTask，显示“关注不会授予访问权限”。没有合法任务／读能力时禁用，不能创建失效订阅占位。
- 提及选择器在任务正文／评论编辑器中插入规范 token，不在草稿阶段发送。引用、源码粘贴、名字重复、中文标签均通过同一服务端 parser；无目录能力／候选请求失败保持可解释禁用／错误。
- SSE 只使本人 inbox Query 失效；同一 provider 的现有 SSE 重用，不新增每页连接。断流、410、会话撤销沿现有恢复；快照读取失败不能推进游标或标记在线，unknown 状态不能乐观伪成功。
- 已存在 unknown 的旧状态命令不换新类型／新 commandId 重发：仍通过现有通用 `GET commands/:commandId` 核对原收据，再刷新迁移后的本人 state。

## 8. 迁移：切换入口但保留真实已读归档

采取一次性前向迁移，不把旧 events 永久当通知源，也不为所有成员回填“仿佛当年收到过”的通知。

1. 获得一致停写／暂停本工作区 retention 的迁移窗口，并备份 SQL、核心 Markdown 与全部 `.pm/state`。这是后续部署动作；本次规划没有暂停任何现有服务。记录旧 `stream_cursor`、事实激活 sequence、迁移批次／时间和仍保留状态行数。
2. 对每一条**仍有原 events 引用的 activity_states**，复制原安全元数据为 `source_kind=legacy_activity,safety_class=restricted_internal` 的事实：`factId=原eventId`、原发生时间、原项目、原 aggregate 身份／版本；不复制 envelope/payload，不把 ActivityStateChanged 带入。
3. 为原 actor 建一条 `origin=legacy_activity,reason=legacy_activity_state` 的 recipient，**原 eventId、version、read_at、archived_at 完全不变**，含后来恢复成未读／未归档但已有版本的状态。尊重原私有 audience；撤权行可内部保留但仍不可读，不能因迁移授予访问。多 actor 的状态独立复制。
4. 原先默认未读且从未写过状态的活动，没有“投递事实”或持久个人状态；不全成员扇出迁移。页面明确说明“旧版只迁入曾保存过个人状态的仍保留活动；未操作的旧活动、已按旧保留期消失的事件不可重建”。不把它们报告为已读，也不宣称完整历史迁移。
5. 在 workspace 锁内完成一次性复制与激活边界，按身份／版本／时间逐行比较结果并记录 manifest；失败回滚该批次，重复运行按相同 key／digest 核对，不重置 CAS。新路由只消费 activation 之后的真实事实。
6. 切换全部正式页面／客户端／模型测试到新查询和新状态命令；旧 `activity-inbox`、SetActivityRead／Archived 新写入口及旧活动 hook 移除。保留既有通用 command receipt 查询与原收据数据，不增加旧业务命令别名。离线旧客户端新写可明确收到“不再支持／请刷新”，但原 unknown 仍按原 ID 查询。
7. 核验并保存迁移结果后，移除 activity_states 对 events 的依赖及旧表、旧状态业务实现；这是被本切换替代的代码／存储，不是删除其他活动／changes 能力。`events`／outbox／changes 原功能继续；事件清理再也不删除已迁入的通知历史。

遗留条目的查询／计数／状态修改沿用原活动的当前 membership、能力、历史项目范围和 actor-private audience 规则，另限制 recipient 必须为本人；不套用新 routed 任务必须存在的条件，也不重新展开关注／提及。原私有 audience 必须从迁移时已知事件类别及安全归属提取，无法确认则隔离而非公开。routed 条目继续逐次执行第 6 节的当前核心检查；两种来源在同一入口内显式分支，不能因非任务 legacy 的 task_id 为空而丢弃已保存状态。

恢复政策：激活前可回到旧读取，尚未产生新 routed 通知时可整批事务回滚；激活后优先关闭**新路由生产**并保留事实／recipient／原收据只读查询，修复后从原 job 恢复。不能把 SQL 降回旧版本、重置状态、删除新事实或把全部 notifications 改回隐式活动来“回退”。前后端版本必须配套，不能一边旧版写 activity_states 一边新版迁移。

[现有备份](../../scripts/backup.mjs) 已包含 SQL 和除 cache 之外的核心目录，但当前没有通知 source／路由计数校验。实施需扩展恢复清单：事实数／sourceKey 摘要、本人状态原版本／时间、未完成 job／lease、核心 journal 与 SQL 导入 checkpoint。SQL、核心和 checkpoint 要有一致停写检查点；单独恢复某一边不能宣称全系统恢复。旧 lease 在隔离新库启动时失效并增加 epoch，不能重新生成已送达行或把归档设为未读。

## 9. 与 Webhook 的共享接口与责任边界

双方按同一个 `service_fact_events` 暂名和 schema 实施，最终名称／DDL 由集成负责人统一；本页不重复建立第二份核心事实采集。

- Webhook 只对白名单 `project_fact`、受支持 sourceKind、项目／任务／里程碑及指定类别构造**全新安全投影**：对象 ID／类型、项目、前后版本、变化类别和真实时间。不使用完整审计、原 payload、actor、commandId、提及 ID 或内部 recipient。
- `restricted_internal`、`legacy_activity`、评论、actor-private、认证、通知失效、跨项目／无法确定范围及无法验证版本的事实明确禁止出站。即使未来添加类别，也需显式 whitelist，而不是“所有非私有事件”。
- 站内 candidates 与 Webhook endpoint 授权／activationSequence 分开；Webhook 不读取通知接收人表，不将“某人收到过”推定为外部 endpoint 有权收到。站内也不将 endpoint 授权当成员授权。
- 两消费者独立 job／租约／唯一键／失败恢复；Webhook 失败不阻塞站内、站内标已读／归档不改变 Webhook 状态。各自复核当前授权，既有 outbox 的 published_at 只保留原 SSE 发布含义。
- 共享文件由一个集成人员负责：核心采集／journal／bridge、共享事实 DDL／schema 和 Worker 注册。N 包拥有站内输入／路由／inbox／迁移语义，W 包拥有 endpoint／外联／签名／出站记录；不得两包各写一套采集器或同时改同一 Worker 注册。

## 10. 需要用户决定的精确事项与上线门禁

| 决定／门禁 | 本计划可先实施的安全默认 | 何时必须取得输入 |
| --- | --- | --- |
| 通知和迁入历史的物理保留期限、个人删除及法律／备份保留 | 不自动清理持久事实与个人已保存状态；归档不是删除，不承诺永久无限保留服务级别。 | 任何自动 GC、历史擦除或对外发布保留 SLA 之前；这不是本包替用户选择“永久保存”。 |
| 事件矩阵超出显式关注／本次提及：受派即通知、项目关注、本人操作、团队提及等 | 只用第 3 节；不自动订阅、不扩大接收者。 | 产品要求扩大矩阵时另行决定，不以通配分类偷偷上线。本批不实现这些扩展。 |
| 需要外部文件“保存发生当时”的关注关系或全离线中间历史 | 外部按首次持久接入时冻结关注、标明观测来源；无可信作者不展开提及。 | 若要求更强保证，必须引入受控写入／版本归档与明确历史订阅策略，不能由本次 watcher 方案承诺。 |
| 跨项目历史读者迁移 | 保留原项目绑定，发现变化失败关闭；不因新项目授权使旧评论／通知可读。 | 仍依 D07 另行决定；本包不实现历史迁移。 |
| 激活与数据迁移 | 需运营给出可停写窗口、备份位置和恢复责任人；在隔离资源先演练。 | N10 激活前。没有 SMTP／Push／Webhook endpoint 外部配置依赖，不请求这些凭据。 |

新路由的发布门禁：共同事实边界、独立 Worker 恢复、迁移不丢既存个人状态、当前授权全链路、提及校验及下面真实场景全部通过。没有经过演练的观察缺口／跨项目处理不能通过修改文案冒充覆盖。N 包不关闭整个 G2、生产容量、HA 或外部渠道验收。

## 11. 稳定实施步骤与文件责任

以下保留 N01–N10 的批准实施合同。N01–N09 已有真实代码、迁移和回归源码，具体路径见第 13 节；退出条件仍需集成负责人统一验证。N10 的业务库停写窗口、备份与生产激活尚未执行。

| 步骤 | 依赖 | 文件责任与具体产出 | 退出条件 |
| --- | --- | --- | --- |
| **N01 固定矩阵与共享合同** | 当前 ADR、本页；与 W 共享接口 | 集成负责人统一 `service_fact_events`、factSequence 锁、sourceKey／digest、四种 source、安全级、激活边界；N 负责人定第 3／4／8 节合同。后续统一更新 ADR／现有交付说明，不改 Markdown 权威。 | 每个来源、事件、接收理由与失败边界有唯一含义；未决仅限第 10 节，现有能力不被误报。 |
| **N02 定义 SQL 与领域合同** | N01 | `packages/infrastructure/migrations/` 新迁移、`packages/domain/src/` 与 `packages/contracts/src/` 拟新增通知 schema；共享 facts 由单一集成 owner，N 写内部输入、recipients、jobs、激活／迁移记录。沿既有 constraint／CAS／作用域模式。 | 唯一性、不可变事实、租约 epoch、个人版本与原状态迁移均有 DB 约束；无 subscriptions／SQL task 副本。 |
| **N03 接入受控核心提交与恢复** | N02 共享合同 | 集成 owner 修改 `pm-core/index.ts` 的实际 mutation 捕获、`core-journal.ts`、`core-adapter.ts`、`core-routes.ts`、`app.ts`、`core-bridge.ts`；扩展 prepared／completed 并增加只导入已证实事实的恢复入口／有界后台 importer。 | 命令、原生创建、源码、属性、生命周期走同一事实协议；原 commandId／native key 不变；SQL 故障不丢 confirmed 事实、不重写文件。 |
| **N04 接入观测与只读当前核心检查** | N03 捕获顺序 | `pm-core/index.ts`、`repository.ts` 复用纯读取与验证，拟新增安全观测 ledger／checkpoint 与只读 port；集成 owner 管公共 core 文件。扫描 reason、有效快照／缺口、启动恢复／周期核对接实际 Workspace 生命周期。 | cache 重建不重发、无效源不伪成功、外部只记录真实观测；Worker 无新可写 Workspace。 |
| **N05 接入评论与个人提及** | N02；N03 提及 guard 接口 | N owner 修改 `task-comments.ts`、评论领域/schema；`pm-markdown` 拟新增共用 AST 提及提取，core 写 guard 使用同函数；`app.ts` 的 candidates 查询由集成 owner 合入，复用目录授权。 | 评论版本／事实同事务；规范 token、差集、失效历史 token、当前成员与项目校验全部闭合；原正文不进公共源。 |
| **N06 实现站内路由消费** | N02–N05 | N owner 在 `packages/application/src/` 拟新增 notification-routing 应用服务／读端口，复用 `dashboard-personal.ts`／`dashboard-store.ts` 的关注存储。Worker 独立 bounded loop 注册由集成 owner 修改 `apps/worker/src/main.ts`。 | 候选冻结、本人排除、理由合并、当前授权重查、并行唯一性、分页租约／失败重试可恢复；不依赖 outbox 发布。 |
| **N07 实现查询与个人状态命令** | N06 | N owner 新通知 inbox／state 应用模块，替代 `activity-state.ts`；registry／生成 client／OpenAPI／API 路由由集成 owner 合同顺序接入；`changes.ts` 只允许最小私有失效。 | 有限快照分页、统计／状态权限一致、CAS／原收据恢复、非递归失效；无他人状态读取接口。 |
| **N08 实现一次性历史迁移** | N07；激活前 | N owner 迁移 SQL／应用迁移器、manifest；统一部署／backup owner 更新 `scripts/backup.mjs` 和运行说明，保留通用原收据恢复。 | 原 eventId／版本／read/archive 时间无损；隐含未读不伪造；事件清理不能级联掉新历史；旧状态表和新写入口不永久双轨。 |
| **N09 切换真实前端** | N05、N07、N08 的 DTO／来源标签 | N owner 已迁移 `pm-notification-hooks.ts`、`service-notifications.tsx` 与 notification model，接入真实任务正文／评论选择器；复用私有 Query、CommandNotice、现有 SSE／草稿恢复。 | inbox3/4 真实显示定向与历史来源；草稿不发、watch 不赋权、comment 锚点正确；unknown 不重发，旧 pending 能查询。 |
| **N10 集成验收与激活** | N01–N09 全部合入；运营窗口 | 集成负责人一次统一执行合同／文档检查及受影响源码检查、真实 PG／HTTP／browser／Worker／文件恢复；更新本页与 activity-inbox-delivery、README、总交付索引和部署说明的实际证据。 | 第 12 节全部可追踪；新库／旧库升级及一致备份恢复通过后激活，不把历史测试当本轮通过。 |

并行边界：N01 后，N02 的内部 DDL／DTO、N05 的 parser／评论、N09 的受控 UI 可按已固定接口分别推进；共享 DDL 与所有公共 API/core/Worker 文件必须单 owner 合入。N03–N04 的事实归属先后是真依赖，N06 不能在未经证明的事实源上先伪投递。所有实现人员中途不并行跑构建／检查；最终检查由集成人员统一执行。

## 12. 真实验收方案（执行证据见第14节）

复用 [dashboard 夹具](../../tests/dashboard-fixture.ts)、[通知实集成测试](../../tests/notification-routing.integration.test.ts)、[core 创建恢复](../../tests/core-creation.integration.test.ts) 与 [核心真实文件测试](../../packages/pm-core/tests/service-facts.test.ts)。提及与迁移专项已加入 [personal-mentions.test.ts](../../tests/personal-mentions.test.ts)、[notification-migration.integration.test.ts](../../tests/notification-migration.integration.test.ts)。所有资源使用随机 PostgreSQL schema、临时 Markdown/blob 根、随机端口及只属于验收的 API/Worker/browser cookie 域；不操作默认业务工作区或停止其他服务。

| 场景 | 实际操作与应留证据 | 必须看到的结果 |
| --- | --- | --- |
| **NA01 接收矩阵／本人排除** | 两项目、A 操作者，B 显式关注，C 仅提及，D 同时关注／提及，E 仅受派、F 范围外；经真实 HTTP 保存任务与评论，启动实际 Worker，查询 SQL 与各用户 inbox。 | B/C/D 各一条，D 两理由；A/E/F 无 routed 行；memberships 与 task_watch 数量没有因提及增加。 |
| **NA02 提及身份／AST** | 浏览器选择重名成员、中文标签；HTTP 手工 UUID／冒名标签／未知与禁用成员／跨项目 ID；代码、引用、转义、隐藏评论、HTML、图片、畸形 URI 和超限集合。 | 只按合法 UUID 身份；新增不合格整体拒绝，核心 revision／评论版本／事实不变；字面内容不触发；外联不执行。 |
| **NA03 编辑／恢复语义** | 评论创建含 B，改普通文字但保留 B，再新增 C、删除后恢复；任务正文执行同样集合差并分别试未保存预览。 | 每事实关注者一条；B 不因未变 token 重复 mention；C 仅新增版本接收，删除／恢复不重提及；草稿零事实。 |
| **NA04 关注时点与取消** | 显式 WatchTask 重复、旧 Unwatch CAS、事实入源前后关注／取消，暂停路由后恢复；再测试仅提及的人未关注。 | 只有一个活跃 watch；旧版本409；冻结候选不因重放扩展；取消前未送达且只靠 watch 的跳过，已送达历史不被删；提及不形成长期订阅。 |
| **NA05 当前授权全链路** | 入源后、Worker 入队前撤权／禁用；入队后撤权／缩范围，再查列表、计数、搜索、状态命令、原收据及目标；另保留授权账号对照。 | 所有入口不泄漏标题／ID／数量／正文，其他账号不能看 recipient；有效用户继续可用。任务迁移到另一项目不搬历史，评论继续 task_comment_project_changed。 |
| **NA06 原命令与派生去重** | 对评论／核心 `/commands` 同键重放、同键改参；对原生 key 重放；一个命令影响多对象；A→B→A→B；两 Worker 并发及重复导入事实。 | 原结果恢复；参数冲突不新发；每个真实事实／接收人一次，多对象不被 commandId 合并，真实重复变化不被 revision 对误删。 |
| **NA07 文件／SQL 边界** | 在真实文件 fsync 后、completed 后、SQL insert 前分别中断自有 API；恢复已完成 journal；另在仅 prepared 时外部改为另一版本。 | confirmed 事实按原 ID 补入；未证明窗口保持 unknown／只观察最终版本，无重建原任务、无伪造 actor 提及；原生仍不是 PM 收据。 |
| **NA08 外部观察与缺口** | 启动后真实写任务源、重复 watcher 事件、破坏／修复源、重建 cache；关闭自有 API 后 A→B→C，再重启；无基线导入既有仓库。 | 有效可观测差异一次；非法源显示错误；不补 B／作者／发生时间，无提及展开；首次基线不刷全仓。API 未观察状态不能伪称已追平。 |
| **NA09 Worker 崩溃恢复** | 收件人事务前中断、提交后未完成 job 时中断、过期 lease 交给第二 Worker、旧 epoch 再提交；注入真实 SQL 写入故障。 | 事务前无半条；重放不改已读归档；旧 epoch 不推进；failed 可按原 factId 恢复。慢 Webhook／SMTP 不阻塞站内／outbox 心跳。 |
| **NA10 CAS／丢响应／SSE** | 两实际浏览器标签页 inbox3/4 修改同一状态；真实提交后丢响应并刷新，按原 commandId 核对；断流、410 和快照503。 | 旧 CAS409；状态只递增一次，read/archive 独立；SSE 跨页收敛，unknown 不重发；快照失败不误报在线／推进游标。 |
| **NA11 迁移无损／有限历史** | 预置两 actor 的已读、归档、取消归档后 v4、私有活动及撤权行，另有从未持久状态的未读活动；迁移前后逐行查原 ID／version／时间，再执行真实 pruneEventHistory。 | 有状态行精确保留；未操作旧活动不伪造送达且边界可见；私有与撤权仍隐藏；旧 events 清理不删新历史；原旧收据可查但不复活已过期源。 |
| **NA12 Webhook 安全隔离** | 同一核心保存被两消费者读取；加入评论 mention、private_note、认证／状态事件、legacy fact 与跨项目事实；真实测试接收端捕获出站 body。 | 共享 factId 可关联，但外部只有独立允许投影，无姓名／actor／commandId／原文／提及／接收人，内部事实不外发；站内归档不改外部记录。 |
| **NA13 新库／升级／恢复** | 新库迁移、旧0024库升级、迁移中断再运行；一致停写备份后恢复到随机新库和新根，仅启动自有进程。 | 约束 validated；原收据、源事实、个人 state、job/checkpoint、核心／blob 摘要一致；过期 lease 恢复无重复通知；不中途关闭 CHECK 或改业务行来变绿。 |
| **NA14 UI 与禁用态** | 真浏览器操作关注、候选搜索、正文／评论保存、定向／历史切换、对象／评论跳转、无权限、pending/error、390px；检视无邮箱／Push 假开关。 | 两变体真实可用，失败不回落样例；无目录时有明确原因；历史不混充定向通知，无页面横向溢出。390px 仿真不冒充触屏设备验收。 |

每项留实际 HTTP 状态／原请求 ID（不含认证 Cookie）、脱敏 SQL 行数／约束／版本摘要、文件 revision、Worker 进程中断与恢复时序、必要浏览器截图。检查通过仅写实际执行结果；未运行项保持未验收。清理只删除本夹具 schema、临时目录、进程、cookie 域和一次性脚本，保留脱敏证据，不记录凭据。

## 13. 本次交付与后续交接

本节记录实现代理交接时的落点；之后已完成统一接线和隔离验收，实际结果见第14节。业务库激活仍未执行。

| 落点 | 实现边界 |
| --- | --- |
| `packages/application/src/service-facts.ts`、`packages/infrastructure/migrations/0026_service_facts_notifications.sql`、`packages/infrastructure/src/notification-schema.ts` | 单一安全事实源；工作区锁内 factSequence／deliveryCursor；严格 source digest 冲突；不含标题／正文／actor 原值。内部 inputs 与 recipients 分离。 |
| `apps/api/src/core-facts.ts`、`core-journal.ts`、`core-adapter.ts`、`core-routes.ts`、`packages/application/src/core-bridge.ts`、`packages/pm-core/index.ts` | SQL 工作区锁先于核心串行队列；实际文件提交后、队列释放前 fsync 完成事实。命令与原生结果身份不变；受控三类对象逐对象捕获。原生正式客户端为每次显式新操作发送独立 key，不按 revision 对合并真实重复变化。 |
| `apps/api/src/core-fact-importer.ts`、`packages/pm-core/service-facts.ts` | API 独立有界恢复；confirmed journal 先于普通扫描；只凭创建台账精确证明提升 prepared 创建，普通 prepared 更新保持 unknown。安全语义摘要与基线先于 cache；初次仅基线、离线仅最终差异、错误保留 gap；SQL checkpoint 只随事务提交推进。 |
| `packages/pm-core/readonly.ts` | 实读安全文件／配置／已有耐久身份，校验 schema、正式关系、重复 ID、墓碑及扫描稳定性；不调用 Workspace.init、不创建目录／state／cache、不打开 watcher。 |
| `packages/pm-markdown/mentions.ts`、`packages/application/src/notification-mentions.ts`、`task-comments.ts` | 共用 AST canonical token 解析；代码／引用／HTML／数学／隐藏评论不激活；50 个去重身份上限；只校验新增 ID；评论版本／事实／原收据／outbox 同事务。渲染为非外联中性成员 chip，不信任标签姓名。 |
| `packages/application/src/notification-routing.ts`、`notifications.ts`、`apps/api/src/notification-routes.ts` | 冻结关注与本次提及、本人排除、并集一条；当前核心／成员／同一 watch 版本重查；有界 lease epoch、候选 checkpoint、10 次失败隔离；真实本人收件人分页、read/archive 独立 CAS 和当前收据授权。 |
| `apps/web/src/features/pm/service/pm-notification-hooks.ts`、`notification-inbox-model.ts`、`service-notifications.tsx`、`PersonalMentionPicker.tsx`、`TaskComments.tsx`、`apps/web/src/features/pm/markdown/EntityDetail.tsx`、`TaskCreationSurface.tsx` | 正式 inbox3/4 切换 routed／legacy；复用原 Query／SSE／unknown journal；正文／评论候选通过真实分页接口插入草稿；评论导航使用所属 taskId 与真实 comment anchor，打开不标已读。 |
| `scripts/notification-admin.ts` | 脱敏 status；按原 factId 显式重试 failed job，记录 OS operator UID 与 lease epoch 的不可变 SQL 维护审计，不重建事实／收件人。 |

迁移保留原 eventId、每 actor 的 v2+ 和 read/archive 原时间，包括恢复至双空值的 v4 状态；legacy 非任务允许空 taskId／target，不丢历史。未知或无法确认私有 audience 的 legacy 行内部保留并隔离，不公开。旧 implicit unread 不伪造。`events` 继续原 SSE/retention 角色。

新增／迁移的回归源码覆盖 parser／语义分类／只读无写入、关注／提及／自排除、CAS／撤权／移动删除后原收据拒绝、命令／原生三类事实、原 key 去重与 A→B→A→B、真实 SQL 故障恢复、离线真实观测、Worker 页回滚／过期 lease／重复送达不重置状态、0024→0026 原状态迁移及 prune 独立性。**本实施者没有运行这些检查**；N10 须由集成负责人补充实际命令和隔离 HTTP／Worker／浏览器证据。

统一验收期间发现并修正观测 ledger 的 CAS 写入接入：`FileRepository.write` 无 expectedRevision 时是独占创建，不能用于覆盖已有 ledger。最小真实 `Workspace.init()` 在第二次 startup scan 得到 `ServiceFactObservations.save → FileRepository.write: File already exists` 原栈；`ServiceFactObservations` 现记录载入及成功写入后的 revision，以原 CAS 协议原子替换，不跳过扫描或制造事实。最小诊断仅使用项目指定临时目录并清理自有资源；修改后的统一复验仍交集成负责人，不在此声称通过。

站内不需要 SMTP／Push 配置；真正待用户／运营输入仍仅限第 10 节的物理保留／扩展策略及激活停写窗口。未选择自动 GC，不把当前不清理误称永久无限保留 SLA。

## 14. 集成后的实际证据

- 真实回归覆盖当前权限、接收人并集/本人排除、持久事实、原请求去重、文件/SQL 恢复、外部观测、lease/页事务、旧状态迁移与 retention 隔离；没有把数据库 skip 算通过。
- 真实 API 与独立编译 Worker 生成一条 watch+mention 评论通知。浏览器显式标已读、归档、通过“显示选项→显示归档”查看，再取消归档；同一 eventId 的版本达到4，已读时间保留，archivedAt 清空，不改任务。
- 观测 ledger 改用原 revision CAS；importer checkpoint 比较显式 bigint，独立真实调用从 PG42P08 恢复到 current；缓存 Workspace get 串行刷新，坏源规划409/陈旧写409与磁盘保护已实际验证。旧进程的 error 未伪装成 current。
- 补充浏览器场景从真实成员候选插入个人提及并发布评论，换收件人登录后实际 `/notification-inbox` 返回仅 `mention` 的一条记录及 `processing=current`；独立编译 Worker 参与路由，未用 UI 假状态代替。
- 真实390px验收发现 inbox3 列表错误沿用43%桌面宽度；现在窄屏列表满宽、详情在下方可滚动。点击打开仍未读，显式已读后原 eventId 达到v2；1440px桌面布局保留。inbox4单独回看，物理触屏设备仍未验收。
- 恢复只在新目标库清租约并换通知 epoch，保留原事实/收件人/个人状态，不对源库执行围栏。provider 备份恢复与统一检查见[实际交付](service-completion-and-acceptance.zh.md#five-package-delivery)；生产升级、物理保留及未选扩展仍单列。
