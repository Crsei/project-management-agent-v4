# 通用出站 Webhook：安全事实、投递协议与实施计划

状态：**W01–W08 的业务、持久模型、HTTPS 协议、正式 UI 与共享接线已完成，并运行隔离真实数据库/TLS/DNS/Worker/浏览器验收；W09 生产外部门禁仍关闭**。第15节保留实现代理首轮交接，当前证据见第16节与[统一交付](service-completion-and-acceptance.zh.md#five-package-delivery)。没有生产 allowlist/密钥/接收账本证明时仍禁用。

## 1. 范围、依据与不能混算的结果

范围是向运营批准的接收器发送选定项目的最小已保存事实；不是任意 HTTP 客户端、入站 webhook、供应商连接器、动态插件或任务执行器。接收器返回值只影响 Webhook 投递记录，**不能调用任务命令、改 Markdown、通过审核或决定工作项完成**。不新增 Redis、RabbitMQ、全能 job 框架或第二个核心文件写进程。

依据：[仓库约定](../../AGENTS.md)、[总体实施计划](../domain-design/README.md)、[最新后端记录](backend-delivery.md)、[Markdown 权威 ADR](markdown-integration-adr.zh.md)、[外部集成讨论](service-completion-and-acceptance.zh.md)、[插件中心交付](plugin-settings-adaptation-plan.zh.md)。适用 [INV-01/09/10/13/14/15/20](../domain-design/invariants.md)、[SC-09/12/13/14/20](../domain-design/scenarios.md)、[当前权限边界](../domain-design/permissions.md)及 INF-01/02/03/05/06。旧设计中的固定任务状态/审核完成前置条件不得借此恢复。

必须分开记录：

1. 原业务事实已持久化；
2. 站内 SSE 事件已发布；
3. Webhook 已持久入队；
4. 外部接收器已认证确认持久接受；
5. 接收器之后的处理结果。第 4 项不证明第 5 项，更不证明 PM 业务成功。

不做：任意 URL 测试发送、自定义请求头/脚本/模板、转发整个 changes/outbox、正文或附件同步、OAuth、供应商 callback 写业务、历史批量补发、跨项目历史迁移、自动删除事实/投递/去重记录、HA、多写核心目录。19 项插件目录不会因本包一次性变成可用连接器。

## 2. 已核实的现状及直接影响

| 现有证据 | 核实结论 | 实施约束 |
| --- | --- | --- |
| [outbox.ts](../../packages/application/src/outbox.ts) | `publishOutboxBatch` 在工作区锁内将 SQL outbox 复制为 events，再设置 `published_at`；10 次发布失败隔离。没有外部 HTTP。 | `published_at` 只表示 SSE 发布，禁止当外部确认、通知生成游标或 Webhook 去重位。 |
| [outbox-admin.ts](../../packages/application/src/outbox-admin.ts)、[维护 CLI](../../scripts/outbox-admin.ts) | 现有维护使用本地数据库操作员权限，列表不取原始 payload/error；retry 重置原 outbox attempts 并先记录操作。 | 不改现有命令语义，不让 outbox retry 触发外部重发；Webhook 有独立查询/恢复命令。 |
| [outbox.ts 保留维护](../../packages/application/src/outbox.ts) | 只清理过期 events、sessions、旧 heartbeat，不删除源 outbox。 | SSE 七天保留不能冒充完整事实源或 Webhook/接收器去重保留期；本包不顺带添加 GC。 |
| [project-audit.ts](../../packages/application/src/project-audit.ts)、[字段合同](../../packages/domain/src/project-audit.ts) | 持久审计按原事实去重，每页重查 `domain.read`、`audit.read`、项目与 actor-private。安全差异仍可能有标题、负责人、预算等字段值。 | 不把“可内部审计”理解为“可出站”；不直接导出 audit changes 或 actor。 |
| [core-journal.ts](../../apps/server/pm/src/core-journal.ts)、[core-routes.ts](../../apps/server/pm/src/core-routes.ts)、[core-adapter.ts](../../apps/server/pm/src/core-adapter.ts) | 文件/SQL 无共同事务；pending/completed journal fsync 后可恢复原收据/审计。原生写保留 revision、原 key；pending 不是失败。`coreProjectAuditWrites` 只归属实际受控写入。 | 复用共享事实包的持久 mutation journal/SQL 导入；不知道文件结果时不合成事件、不重新执行业务命令。 |
| [审计真实测试](../../tests/project-audit.integration.test.ts) | 覆盖 Markdown 已提交而 SQL 失败、原请求恢复、原生源码不留正文、外部文件编辑不冒充用户、private 分页与不可变历史。 | 复用相同隔离与故障切点；不能假定当前 SQL 审计覆盖全部外部文件变化。 |
| [access.ts](../../packages/application/src/access.ts)、[kernel.ts](../../packages/application/src/kernel.ts) | 授权读取有效会员并关联未禁用 users；`access.manage` 的工作区范围不隐含 `domain.read`/`audit.read`。命令和收据均有当前权限复核。 | 端点管理复用真实能力；新命令必须加入收据权限分类，不能落入默认普通读取权限。 |
| [Worker main](../../apps/server/worker/src/main.ts)、[邀请投递](../../packages/application/src/invitation-delivery.ts) | 现有 Worker 是 outbox/保留维护/心跳主循环与独立 SMTP bounded 循环。邀请发送租约过期变 unknown，不回 queued。 | 新增独立 Webhook bounded 循环；外联不能堵住心跳、SSE、邀请或找回。租约到期不证明未送达。 |
| [runtime-config.ts](../../packages/infrastructure/src/runtime-config.ts)、[API app](../../apps/server/pm/src/app.ts) | 当前无 Webhook 配置或能力；公共 capabilities 不是端点配置证明；现有 readiness 的 worker 检查主要是心跳/outbox。 | 拟新增配置/管理 DTO/循环健康事实，禁止把旧 worker=true 显示为 Webhook 可投递。 |
| [目录](../../apps/web/src/features/pm/service/settings/plugin-catalog.ts)、[插件页](../../apps/web/src/features/pm/service/settings/settings-plugins.tsx)、[SMTP 状态表面](../../apps/web/src/features/pm/service/settings/plugin-smtp-status.tsx) | 19 项内置能力目录，只有 SMTP 邀请已有实现；Webhook 当前 unimplemented。SMTP 已区分无权、loading、error、未配置，不把旧快照当可用。 | 仅改 Webhook 卡片与对应文案；沿用同一真实状态模式，不造 OAuth/已连接/发送成功。Lab 继续零业务请求。 |
| [核心 Workspace](../../packages/pm-core/index.ts)、[历史模式](../../packages/pm-core/sprint-history.ts) | watcher 观察不等于持久通用事件；现有 Sprint history 记录真实观测并明确 restart/gap。 | 共用通知包新增的持久事实输入；不从内存 SSE 推断完整历史，不补造停机中间状态。 |

## 3. 选定默认与需要用户/运营的输入

### 3.1 本计划选定的安全默认

- 出站对象限定 `project`、`work_item`、`milestone`；内容只含身份、版本、变化类别和来源时间，不含业务字段值。
- 最小配置采用**部署批准目标 + 工作区管理员选择 targetKey**：部署文件拥有精确 URL/允许工作区与项目上限/协议/密钥引用，浏览器和命令永远不接受 URL、secret 或任意 headers。
- 端点有明确授权责任人，默认为创建端点的认证管理员。授权不因 Worker 是后台进程而永久有效；失效即停止新派发，不能自动借其他管理员权限继续发送。
- 创建端点默认 paused，显式启用后才派发；从创建事务保存的事实水位开始，不自动发上线前历史。暂停保留后续选中事实与未派发队列，恢复会发送积压，UI 必须预告数量。
- targetKey、项目集合、事件集合创建后不可变。需要改目标/范围时暂停并退役旧端点、创建新端点；旧未发送记录不能被改址重放。没有通用 endpoint CRUD 或删除历史接口。
- 生产只开放满足本文 `pm-receipt-v1` 协约的目标。没有持久去重/可认证核对的普通接收器，本包不降级为“尽量至少一次”，保持不可启用；不伪造任何供应商支持。
- 签名必选；未知结果不自动重发。接收器查询失败、普通 404、普通 2xx 或人工口头“应该没收到”都不是核对证据。
- 暂不物理清理源事实、投递身份、收据、关闭旧 attempt 的屏障和接收器去重键。容量不足阻止新入队并显示积压，不丢弃源事实或重置消费水位。

### 3.2 必须提供而不能由实现者假定的输入

| 输入/决定 | 未提供时的行为 | 不阻塞的本地工作 |
| --- | --- | --- |
| 实际接收器归属、数据出境/保留许可、批准的工作区/项目和最低必要事件集合 | 生产 target allowlist 为空，服务禁用；技术白名单不替代数据授权。 | 可完成代码、隔离真实接收器和权限验收。 |
| 精确公网 HTTPS 主机/443/path、receipt 查询与 reconcile 路径、DNS/TLS/防火墙目标 | 不启用真实目标，不能用网页输入替代。 | 本地 HTTP/TLS/SSRF 协议验证。 |
| 接收器对本文去重、签名、负面确认屏障和查询协议的真实实现承诺 | 保持 `receiver_contract_missing`；不得声称通用 Webhook 已兼容该供应商。 | 使用自有真实接收器验证本协议。 |
| 安全生成并秘密分发的每端点 HMAC keyring、轮换/紧急撤销责任人 | `secret_unavailable`，不发送；不读取用户现有凭据作替代。 | 测试临时密钥只存在隔离夹具中。 |
| 生产保留期、容量/SLO、跨边界合规审批 | 仍保留事实与收据，不做自动 GC；不承诺 HA 或容量达标。 | 有界批次/积压/恢复行为可实施。 |

是否扩展标题/字段值、其他九类对象、评论、供应商普通 webhook 模式、旧历史补发或双向同步，均是新增产品范围，不是本包的隐含默认。

## 4. 与站内通知共用一个安全事实输入

### 4.1 拟共享 `service_fact_events`

该表及 Markdown 持久 mutation fact journal 由通知事实包实现、父线程统一命名/迁移/文件所有权；**Webhook 不另建相同事实源，也不依赖 notification recipients 表**。共享字段：

| 字段 | 合同 |
| --- | --- |
| `schemaVersion, factId, workspaceId` | 严格版本；factId 是稳定事实 UUID，出站 `eventId` 直接使用它。 |
| `factSequence, recordedAt` | 每工作区在既有 workspace 锁内分配并提交的单调序列和 SQL 记录时间；不能拿裸 bigserial 当提交安全高水位。 |
| `sourceKind` | `command / core_http / core_observation / legacy_activity`；最后一种仅兼容内部历史，出站强制拒绝。 |
| `sourceKey, sourceDigest` | 原持久来源身份/摘要，唯一约束防重；仅内部使用，不出站。 |
| `projectId, entityKind, entityId` | 单一可信项目范围；无法确定、范围变化或多范围事实不进入本包。 |
| `beforeRevision, afterRevision` | 原事实版本，可空；不是读今天文件后重造昨天版本。 |
| `changeKinds[]` | 本包接受 `created / metadata_changed / content_changed / lifecycle_changed`；类别之间不导致同事实重复投递。 |
| `occurredAt, observedAt, safetyClass` | 前者可能为空；后者真实记录观测时间。`project_fact / restricted_internal`；出站仅接受前者。 |

可信 actor、mentions 等内部路由附加数据由通知包自行维护，不属于出站合同。即使内部数据有 actor/commandId，本包也不得序列化这些字段。

来源闭合：

- SQL 附属写入可在业务/收据/事实同一事务中记录，但当前出站白名单不消费评论、成员、邀请、账号、偏好、收藏、工时、预算或任何 actor-private 事实。
- 核心命令、原生创建/修改由共享持久 journal 在文件结果确定后产生事实，SQL 导入失败后恢复原 factId；不重复写 Markdown。不把原生成功伪装为业务命令收据。
- 外部文件变化只消费已持久记录的有效版本观测，`sourceKind=core_observation`、`occurredAt=null`；不虚构 actor 或 commandId，不把“首次扫描现有内容”当新创建，不补离线中间编辑。
- stale/未知 schema/无效扫描/不确定文件结果只表现源健康缺口，不变成“对象成功变化”。共享事实持久化失败必须可见、可按原事实补入，不能吞错后声明无事发生。
- 业务写入与 watcher 对同一已保存版本的重复观察由共享来源规则归一；Webhook 再以 `(endpointId,factId)` 防重，不凭“字段看起来相同”猜同一命令。

### 4.2 出站白名单与严格投影

| 出站类型 | 对象 | 接受类别 |
| --- | --- | --- |
| `pm.project.changed.v1` | `project` | created、metadata_changed、content_changed、lifecycle_changed |
| `pm.task.changed.v1` | `work_item` | 同上 |
| `pm.milestone.changed.v1` | `milestone` | 同上 |

`lifecycle_changed` 只表示保存后的状态/归档/恢复事实，不承诺固定工作流状态含义。删除、无法授权的墓碑、多项目迁移、其他类型以及白名单外 sourceKind/category 均不投递；这是明确范围，不声称覆盖所有核心事件。

拟 JSON body 上限 4 KiB，严格 schema 仅允许：`schemaVersion=1, eventId, deliveryId, eventType, workspaceId, projectId, entity:{id,kind,beforeRevision,afterRevision}, changeKinds, sourceKind, occurredAt, observedAt`。版本是原事实版本；不查询正文补全 payload。序列化一次后持久保存确切 UTF-8 bytes 和 SHA-256，后续同 deliveryId 字节不变。

**禁止输出**标题/姓名/邮箱/负责人/提及 ID、字段 before/after 值、审计 changes、评论/Markdown/消息正文、文件名/路径/内容/下载 URL、actor-private、actorRef、内部 commandId/sourceKey、认证/会话/token/password/secret、请求或响应任意正文。HTTP 固定安全事件 JSON 不是业务原文；不提供模板或附件扩展口。投递日志、UI、命令收据也不能携带上述原文/秘密。

## 5. 最小配置、管理员与当前授权

### 5.1 拟部署配置门禁

拟在 `runtime-config.ts` 解析 `WEBHOOK_TARGETS_FILE` 指向的只读部署 manifest；没有变量表示未配置且默认禁用，部分/非法配置是 `configuration_error`，不是未配置。manifest 仅包含运营审核目标，严格未知字段拒绝：

- `targetKey`、批准的 workspace UUID、项目集合上限；不允许跨工作区复用授权。
- 精确 `deliveryUrl` 和固定 `receiptBaseUrl`/`reconcileBaseUrl`，同一 HTTPS origin、443。查询和 reconcile 的 delivery UUID 路径由程序编码拼接，不能读取响应 Location/link 决定下一跳。
- `protocol=pm-receipt-v1`、允许事件类型、DNS/TLS 策略版本。
- keyring 的公开 `keyId`、激活/退出时间、`receiverReady` 与部署 secret 文件引用。`secretFile` 是绝对路径模板，必须恰好包含一次 `{endpointId}`；API 只读取该引用的元数据，Worker 仅用数据库中已验证的端点 UUID 替换模板。先创建 paused 端点取得 ID，再由运营为该端点/每个 key 独立生成并秘密分发至少 32 bytes 随机文件；不得复用其他端点的密钥。文件专用只读挂载、非符号链接、无组/其他用户权限。实际 key 不进数据库、前端或 API 响应。
- 不变的目标 URL/范围/协议计算 `targetDigest`；keyring 公开元数据另参与总配置 `digest`。API 与 Worker 核对总摘要和端点对应 key 可用性。批准轮换可更换 key 而不改已有 targetDigest/body/deliveryId；targetKey 指向不同 URL/项目上限时旧端点 blocked，不能静默重定向积压。允许多个独立端点使用同一批准 targetKey，各自固定范围和独立密钥，不添加一目标仅能创建一次的产品限制。

不提供 `allowPrivateNetwork`、任意端口、代理地址、跳过证书或任意 host/header 配置。生产 loader 不接受测试网络豁免；公共 API 的任何 URL/secret/header 字段均按未知字段拒绝，不能“测试一下”任意地址。环境代理不继承到此 transport，禁止 UNIX socket、自定义 socketPath 或通用 fetch 转发。

### 5.2 授权责任

创建/查看/暂停/启用/退役/换钥/核对/恢复都要求当前有效会员、未禁用账号、工作区范围 `project_ids IS NULL` 的 `access.manage`，另对端点每个 projectId 显式要求 `domain.read` 和 `audit.read`。不新增默认授予成员的 connector capability，也不以角色名称推断能力。

- 创建者成为 `authorizerUserId`，服务端从认证 actor 派生，不接收任意 userId 代签；每个端点明确项目与事件集合，不能填 `*`。
- 入队时和每次真正 dispatch 前，均从当前 users/memberships 重查责任人的上述权限及 manifest 范围；不能复用创建时或通知接收人快照。这里授权的是**固定历史项目范围内的最小事实元数据出站**，不是“当前对象可读”，实际入口和区别见下节。项目移动不迁移旧事实权限。
- dispatch 前最后授权检查、endpoint 版本/状态/摘要、payload 白名单检查、租约和 `sending` 标记同在工作区锁事务中提交。**撤权先提交则无新请求；sending 先提交则可能已发出，之后撤权不能撤销外部事实。**UI 显示此在途边界，不能伪称已取消。
- 责任人失效使端点 blocked，未发送记录保留不发；重新授权须由当前有权管理员显式执行并成为新责任人，保持 paused，再显式 enable。不能自动寻找其他管理员接管；unknown 不因此回队列。
- 查询管理页/投递页/原命令收据每次重查；无权 403，跨工作区/不可见 ID 404，不泄露条数、目标或载荷。Cookie/Origin/退出撤权仍复用现有 HTTP 保护。端点管理员只能管理自己的当前工作区。

### 5.3 Worker 无 CoreAccess：选定历史元数据语义，而非伪造当前对象授权

现有 Worker 没有 API 的 CoreAccess。本包明确选择父合同允许的窄范围：三类出站事件都是“某固定历史项目中曾保存/观测到这些 ID、版本与类别”的不可变事实，**不声明对象目前存在、当前归属仍相同、当前正文可读或当前状态等于当时状态**。payload 不含当前字段、标题、导航/下载链接，接收器不能凭事件获得 PM 读取凭据。本包不把 fact.projectId 当作当前对象 project，不读取异步索引批准业务访问。

- 拟应用入口 `authorizeWebhookHistoryDispatch(sql, endpoint, fact)` 由 application Webhook 模块拥有，API 入队/Worker dispatch/reconcile 共用。在 workspace 锁内调用现有 `getMembership/requireCapability`：核对当前有效 users/membership、工作区全范围 access.manage、对固定历史 projectId 的 domain.read 与 audit.read、端点项目集合、manifest 上限、fact safetyClass/sourceKind 与严格白名单；成功后才以同事务 CAS 写 sending。它只读取当前授权 SQL 和不可变事实，不查询当前对象内容，也不声称完成当前实体授权。
- 首次创建端点在 **API 所属服务**中通过已有 `coreWorkspaces`/`authorizeCoreScope` 验证项目确实存在、有效且在当前授权范围；复用 app 中邀请项目验证的所属层模式，不由 Worker 打开 Workspace。这个创建时检查只是端点范围登记，不代替每次 dispatch 的当前 SQL 历史权限复核。
- 发送后续历史事实时，删除/迁移不自动回溯抹去已合法保存的历史。删除本身、当前范围变更、无可信原历史范围事实均不在本包白名单。若接收器需要“仍可读的当前对象”或标题/正文/当前链接，则必须另行采用 API 所属的权威派发准入/安全载荷服务并处理读取—发送竞态，**不能在本合同下顺手扩展**。
- Worker 禁止实例化 `CoreWorkspacePool`/`Workspace`，禁止初始化 watcher/SQLite/持久 state，禁止伪造 human actor；`core_observation` 始终使用事实 sourceKind 与可空 occurredAt，出站无 actorRef。这样没有第二个核心目录写者，也没有通用核心读取凭据。

验收必须证明：新建端点的不存在/无效项目被 API 拒绝；历史事实发送只依赖明确的历史范围许可；撤销当前任一所需能力后不再派发；历史 ID 不能用来绕过 PM 当前实体读取权限。若产品不接受这种历史元数据出境语义，则该端点保持禁用，不能把更宽的当前对象读取当作已有能力。

## 6. 拟数据、命令和查询合同

迁移编号由集成 owner 分配。新附属表不保存 SQL 任务副本，不使用 entities.kind 冒充 webhook 聚合；应用 handler 复用 kernel 事务、workspace 锁、command receipts 与 expectedVersions。

| 拟表 | 核心字段与约束 |
| --- | --- |
| `webhook_endpoints` | UUID id/workspaceId、targetKey/targetDigest、非空 projectIds/eventTypes、authorizerUserId、activeKeyId、`activationSequence`、state=`paused/enabled/retired/blocked`、safeBlockCode、version、createdAt。配置集合创建后不变；retired 不可重新启用。 |
| `webhook_fact_consumptions` | PK `(endpointId,factId)`、decision=`queued/filtered`、safeReason、createdAt；关联同工作区事实。分类结果与创建 delivery 同事务，消费检查点不能先推进。 |
| `webhook_deliveries` | deliveryId UUID、endpointId/factId，unique `(endpointId,factId)`；原配置摘要、严格 payload bytes/SHA、state/version、attemptNo、nextAttemptAt、keyId、leaseId/leaseKind/leaseExpiresAt、reconcileRequested、safeFailureCode、acceptedAt。事实/投递身份/bytes 不可修改；状态只走授权 CAS。 |
| `webhook_delivery_attempts` | PK `(deliveryId,attemptNo)`、attemptId UUID、kind=`dispatch/reconcile`、leaseId、keyId、startedAt/finishedAt、phase、requestBodySha256、safeOutcomeCode、HTTP status（可空）。不记录请求头、signature、URL path、raw error 或响应正文。 |
| `webhook_delivery_receipts` | 本地不可变 receiptId、deliveryId/attemptId、verified receiverReceiptId、status、payloadSha256、closedThroughAttemptNo（可空）、recordedAt、verifiedKeyId、responseSha256。只保存严格投影/认证结论，不存原响应、认证头或 token。唯一外部收据键冲突须核对，禁止覆盖。 |
| `webhook_loop_health` / `webhook_key_health` | 实际 Worker 总摘要/循环时间与端点独立 keyId 可用性；每 cycle 最多检查 20 个端点，按最旧检查时间轮转，不做无界全量 secret 扫描。只有同摘要且 30 秒内的两类证据才能启用。健康表不保存 key、路径或签名。 |
| `webhook_restore_fences` | 恢复目标工作区的持久派发隔离；建立后创建/启用/Resume 和 Worker 最终 sending 准入都拒绝新派发，仍可核对原投递。没有 HTTP 强制清除此隔离的开关。 |

Check/FK/索引需约束：同工作区引用、合法状态/类别/摘要、版本正数；只有持租约状态可含 lease；accepted 必须有匹配已验证 receipt；unknown 不可被普通 retry 领取。领取索引按 state/nextAttemptAt，端点每次最多一个在途网络租约；永久保留去重键，不能因清空 UI 历史重新发送。

### 6.1 拟命令（通过现有 `/commands`）

所有新命令严格 payload，targetId 指向对应端点或 delivery；修改必须 `expectedVersions[targetId]`。服务端派生 actor、workspace、lease、摘要和网络身份。命令成功仅是本地事实提交，不是外部已送达。

| 命令 | 输入/结果/条件 |
| --- | --- |
| `CreateWebhookEndpoint` | `{targetKey, projectIds, eventTypes}`；返回 `{endpointId,version,state:'paused',activationSequence}`。同锁保存当前源水位，只选更大的新事实；要求部署目标已经批准本工作区与范围。 |
| `SetWebhookEndpointState` | `state` 为 `enabled`、`paused` 或 `retired`；启用检查责任人/目标/key/接收器合同和近期 Webhook 循环摘要；paused 停新 dispatch 并保留积压；retired 抑制未发送记录但保留历史/unknown，不发取消到接收器。 |
| `ReauthorizeWebhookEndpoint` | `{}`；当前有权 actor 接管固定范围，version+1，普通端点置 paused；retired 保持 retired，仅恢复历史核对责任。不能修改 URL、范围或 unknown 结果，也不能解除恢复工作区隔离。 |
| `SetWebhookEndpointSigningKey` | `{keyId}`；只选运营 manifest 已配、接收器已准备的端点独立 key。保持原 payload/delivery；不把换钥当重发。退役端点若仍有 unknown，可换钥以核对历史，绝不重新启用。 |
| `ReconcileWebhookDelivery` | `{}`；仅 unknown，设置只读核对请求标志，返回 `{deliveryId,reconciliationRequested:true}`；Worker 后续访问固定 receipt/reconcile 目标。提交此命令不是 receiver accepted。 |
| `ResumeWebhookDelivery` | `{receiptId}`；仅此前 unknown 且已有匹配、已认证的 not_accepted/关闭旧 attempt 证明；再次当前鉴权与 CAS，原 deliveryId/body、新 attemptNo 入 ready。没有证明返回 `webhook_outcome_unknown`，不能提供 force 开关。 |

创建同 commandId 同参数返回原 endpointId；同键不同参数 409；状态冲突 409 且不静默刷新重交。命令响应丢失保留原 commandId，通过现有收据 GET 核对；查不到不代表未提交，更不能创建新 delivery 身份。`assertReceiptReadable` 须把上述命令列为管理权限，并复核其端点固定项目集合；不允许以通用 `domain.read` 读取管理收据。

拟查询：`GET /api/v1/workspaces/:workspaceId/webhooks`、`.../webhooks/:endpointId/deliveries?cursor&limit`、`.../webhook-deliveries/:deliveryId`。DTO 只给 endpointId、批准目标别名/主机（无路径）、固定作用域、版本、配置/授权/循环健康状态、积压数量、安全状态码和时间/收据 ID；不返回密钥引用/文件路径/URL 凭据/签名/raw payload/raw response。分页游标绑定 workspace/endpoint/当前 actor，范围先授权后分页，no-store。

安全错误至少区分：`webhook_not_configured`、`webhook_configuration_error`、`webhook_target_not_allowed`、`webhook_secret_unavailable`、`webhook_authorization_revoked`、`webhook_dns_denied`、`webhook_target_changed`、`webhook_receiver_contract_missing`、`webhook_outcome_unknown`、`version_conflict`、`idempotency_conflict`；对外文本不拼接原始 URL/库异常。

## 7. 接收器协议、签名及密钥轮换

### 7.1 签名请求

每次发送都有稳定 `eventId`、稳定 `deliveryId` 与新的 `attemptId/attemptNo`；不同端点消费同事实可有不同 deliveryId。传输重试和核对恢复不能创建新 eventId/deliveryId 或改 payload。

固定请求头：`Content-Type: application/json`、`X-PM-Endpoint-Id`、`X-PM-Delivery-Id`、`X-PM-Event-Id`、`X-PM-Attempt-Id`、`X-PM-Attempt-No`、`X-PM-Timestamp`、`X-PM-Key-Id`、`X-PM-Signature`。无 Cookie、Authorization、用户 session 或业务 token。

HMAC-SHA256 输入按 UTF-8、LF、无尾随空行固定为：协议域 `pm-webhook-request-v1`、HTTP method、精确 origin-relative request path、endpointId、deliveryId、eventId、attemptId、attemptNo、Unix 秒 timestamp、keyId、实际 body SHA-256。`X-PM-Signature=v1=<lowercase hex>`；请求无 query（receipt UUID 为 path 段），body bytes 持久化后直接发送，不重新格式化、压缩或追加字段。GET 核对使用空 body 的 SHA-256；reconcile POST 使用严格身份投影，不含业务正文。

接收器必须限制 ±300 秒时间偏差、严格 schema/大小、常量时间验签；验签先于任何业务处理。同一签名的网络重复由 delivery 去重处理，不能因为签名时间仍有效就重复应用。

### 7.2 durable inbox、查询与否定屏障

接收器至少实现以下协议，路径必须提前登记，不能由响应告诉 PM 访问任意地址：

1. `POST <deliveryUrl>`：以 `(endpointId,deliveryId)` 建立 durable inbox，绑定 eventId 与 payloadSha256。**持久去重登记与唯一接受效果必须原子化**；如果后续还有处理，则该处理必须用同一 inbox 身份幂等推进，不能先执行效果再落去重键。同 ID 不同 hash 明确冲突，不“更新为新 payload”。
2. 已接受的重复 POST 返回同一接受收据；不能产生第二份业务效果。PM 仍不将这一能力解释成可以随意重发 unknown。
3. `GET <receiptBaseUrl>/<deliveryId>`：返回已认证的 `accepted / pending / unknown`；普通 404、记录不存在或查询超时一律只说明无法确认。查询记录不能通过短 TTL 消失后允许旧 delivery 再应用。
4. `POST <reconcileBaseUrl>/<deliveryId>`：对原 attempt 身份做核对；若尚未接受，接收器必须线性化地**关闭所有不大于 closedThroughAttemptNo 的旧 attempt**，持久保存屏障，拒绝其迟到请求，然后才返回 `not_accepted`。若已接受返回 accepted；仍在处理且无法关闭则 pending/unknown。一个“当前查不到”但旧 POST 之后仍可接受的响应不满足该协议。
5. PM 获得真实 not_accepted 屏障后，才允许管理员显式 Resume，仍使用原 deliveryId/hash，attemptNo 更大。接收器永久去重和旧 attempt 屏障共同防止迟到旧 Worker 与恢复请求重复应用。

接收器响应上限 8 KiB，严格允许 `schemaVersion,receiverReceiptId,endpointId,deliveryId,eventId,attemptId,payloadSha256,status,closedThroughAttemptNo?,recordedAt`；响应签名使用独立域 `pm-webhook-receipt-v1`，绑定本次 request attemptId、响应状态、精确响应 bytes SHA 和 keyId。使用相同端点 keyring 验证，禁止跟随 body 内链接。HTTP 2xx 但签名/身份/hash/schema 不匹配不算成功；非 2xx 也只有认证的 not_accepted/accepted 事实才能决定状态，不能凭 500 推断副作用未发生。

accepted 的准确 UI 文案是“接收器已持久接受”，不是“任务处理成功”。不接受供应商向 PM 任意推送成功回调，也不提供匿名确认路由或人工无凭据 MarkDelivered。

### 7.3 换钥与紧急撤销

- 每个端点独立至少 32 随机字节 HMAC key，keyId 不复用。运营先把新 key 安全交付接收器，接收器同时验旧/新 key；再部署双方 keyring，管理员以 CAS 切 activeKeyId。
- 每个 attempt 持久记录实际 keyId；发送前选择当前有效 key。in-flight attempt 不改签名/身份；已入队但尚未派发可用新 key，body/delivery 不变。核对请求可用当前有效 key，接收器按请求 key 签回应答。
- 旧 key 只有在旧在途和 unknown 均完成核对或明确保留为不可核对、且双方确认后才退役；不能按“等一个超时”就删除。没有旧 key/接收器不认新 key 时保留 unknown，换钥不证明没收到。
- 泄露时立即暂停端点、部署撤销并阻断新派发，保留原 attempt/收据；已送出去的数据不能收回。重新建立可信 key 后先核对，不发全量“补偿重放”。任何签名、secret、密钥文件内容均不进入 logs/收据/UI。

## 8. SSRF、DNS pinning 与网络上限

生产边界必须覆盖配置时、DNS 解析时和实际 socket 连接时，而不是只在 UI 正则校验 URL。

1. URL 统一解析/规范化：只接受精确 HTTPS DNS 主机、443、固定无 query/fragment 的路径；拒绝 userinfo、IP literal、非 HTTP 协议、反斜线/控制字符/编码歧义、单标签/internal/local 主机和路径穿越。IDNA 规范化后再与部署精确 allowlist 对照，无通配域名、后缀匹配或用户自定义 Host。
2. 每次 dispatch/reconcile 都重新解析全部 A/AAAA，限制 DNS 截止时间；任何答案、CNAME 目标或最终结果含非全球可路由地址即拒绝整个答案集。拒绝 loopback、RFC1918、link-local/metadata、CGNAT、ULA、multicast、unspecified、reserved/documentation、IPv4-mapped IPv6 等绕过；不能只检第一个 IPv4。
3. 本次连接只使用已验证集合中的 pinned IP；HTTP Host 与 TLS SNI/证书校验仍用批准 hostname。transport 禁止 connect 时再次系统解析，连接建立后比对 remoteAddress，不能验证 public IP 后又让 fetch 自己解析成 private。禁用跨目标连接池/HTTP2 合并；最小实现每个 attempt 新建并关闭专用连接。
4. DNS 答案由公网 A 换公网 B 可在下一次解析后使用 B；由公网变内网立即 blocked，不发新请求。正在用 A 的连接只属于本次 attempt；TTL 不是跳过下一次校验的理由。DNS 改变不允许跳过 key/targetDigest/当前授权。
5. 所有 3xx **不跟随**，包括同域重定向；不读取 Location 再发。POST 已发出后的 3xx 没有认证收据则 unknown，不能回 ready。TLS 校验不可关闭，环境 HTTP(S)_PROXY、代理 PAC 和凭据不继承。
6. 建议固定上限：DNS 2 秒、连接/TLS 3 秒、响应头/体阶段 5 秒，统一总 deadline 10 秒；各阶段受同一总预算，不累加无限延长。响应 8 KiB、请求 4 KiB，拒绝压缩响应和无限/chunked 慢流；超限中止并按已派发阶段判 unknown。禁用 HTTP 库自动 retry。
7. 部署再以 egress 防火墙禁止内网/metadata，作为第二层；它不能替代应用 pinning。DNS/TLS/响应错误只保留安全码，不保留服务端任意文本或响应业务内容。

## 9. Worker 状态、租约与明确恢复

### 9.1 事实入队与派发

端点创建事务在 workspace 锁内保存 `activationSequence`；消费者只扫描更大的共享事实。`(endpointId,factId)` 的消费结果、过滤原因、delivery 建立在同一 SQL 事务，源高水位不能先提交。暂停端点继续持久化选中事实但不 dispatch；受权失效或容量门禁时保留可恢复积压。退役端点的未发送记录标记 suppressed，不删除共享事实。

发送循环一次领取一个候选、每端点最多一个网络租约，SQL `FOR UPDATE SKIP LOCKED` + workspace 锁/CAS；不在网络等待期间持数据库事务或 workspace 锁。步骤为：

| 当前状态 | 允许转换 | 关键规则 |
| --- | --- | --- |
| `ready / retry_wait` | `preparing` | 持久准备租约，随后解析 DNS；尚未发送 HTTP。默认租约 45 秒，高于总 deadline 与落库余量。 |
| `preparing` | `sending` | DNS pinning 完成后，在工作区锁内最后重查权限、endpoint/配置/key、租约并记录 immutable dispatch attempt；事务提交后才允许发送 body。旧租约 CAS 失败绝不发送。 |
| `preparing` 过期 | `ready` 或 `blocked` | 仅因从未进入 sending 才可安全恢复；迟到准备者不能升级 sending。 |
| `sending` | `accepted` | 仅匹配、已认证 receiver accepted 收据落库成功；SQL 写失败留 sending，之后 unknown。 |
| `sending` | `unknown` | 已可能发请求后超时/断线/Worker 崩溃/租约过期/响应不可信；不重新领取。 |
| 证明无请求发出 | `retry_wait / failed_safe` | 仅可证明在 HTTP request bytes 发出前的本地/DNS/connect/TLS 失败；最多 3 次，退避 1/5/30 秒，始终原 deliveryId。库不能证明阶段时保守 unknown。 |
| 配置/SSRF/授权不符 | `blocked / suppressed` | 不发新请求；恢复配置/重新授权后仅可显式恢复未派发部分。已经 sending 的记录不假取消。 |
| `unknown` | 保持 unknown 或 `accepted` | Reconcile 的匹配认证接受证据可置 accepted；pending/无证据保持 unknown。 |
| `unknown` + 已验证 not_accepted 屏障 | `ready` | 仅 Resume 命令+当前授权+delivery version CAS；attemptNo 增加，deliveryId/body 不变。 |

network deadline 到期必须 abort/关闭自有 socket；发送租约过期只代表失去写权，不证明网络副作用消失。落库使用 `WHERE deliveryId=? AND leaseId=? AND state='sending'`，旧 Worker 的迟到结果不能覆盖新状态；可追加安全证据等待核对，不擅自复活投递。receiver 屏障负责拒绝已关闭旧 attempt。queued、preparing、sending、unknown 的计数必须分开展示。

### 9.2 独立 bounded 循环与健康

拟新增 `runWebhookLoop`/`deliverWebhookBatch`，由父线程在 `apps/worker/src/main.ts` 注册，使用既有 PG pool/AbortSignal。与 outbox、邀请、找回各自独立、有界 deadline/concurrency/backoff；一个 HTTP 目标挂住不能影响主循环 heartbeat 或其他渠道。停止只 abort 本循环自有请求，等待有界收尾，不能把发送中记录统一改回 queued。

heartbeat 的拟安全 details 只含 Webhook 配置摘要、loop state、最近成功 cycleAt、积压/unknown/blocked 数量；不带 target URL 或 payload。管理 DTO 必须核对实际 Webhook 循环及摘要，而非旧 generic worker=true。未配置为 disabled，不使原有基础 readiness 失败；已启用但循环/配置异常在 Webhook 管理能力中明确 degraded，不能仍标可投递。原基础数据库/存储/core/outbox readiness 保持真实，不用 Webhook 状态掩盖原错误。

reconcile 使用同 delivery 行上的独立 leaseKind/请求标志，不建通用 job。只发送身份/摘要查询，不重发事件 body；查询租约过期仅可恢复查询，不恢复 dispatch。对认证失败/响应丢失保持 unknown，显式再次请求核对是安全查询，不是新业务投递。

## 10. 真实前端与禁用态

入口保留正式 `/pm/<workspace>/settings/plugins` 的通用 Webhook 卡片/详情；拟新增服务状态区和端点列表/投递详情，复用 SettingsSection、Notice、Dialog、现有查询/命令恢复模式，不开第二套 Lab 成功页面。

- 仅 Webhook 目录项在真实实现集成后变 builtin；SMTP 原有状态不变，其余 17 项保持未实现/不可用，Skype 保持退役。目录 builtin 只代表有适配器，不代表已连接或已接受事件。
- 未配置：显示“未配置 / 未启用”，新建/启用/核对控件禁用，展示部署变量名与协议要求，不显示任意地址或密钥输入框。
- 真实创建表单仅选择服务端批准 targetKey、授权项目和白名单事件；没有获批目标时明确空态。保存创建 paused 端点，不触发测试发送。目标别名/主机不等于连通验证。
- 权限不足：不挂载管理 query，不显示他人的旧私有快照、目标或计数；成员/账号撤权清空该工作区缓存和未授权详情。会话错误、loading、刷新中、离线暂停、503/配置错误与未配置分别显示。
- 创建/暂停/启用/退役/换钥使用原 commandId 与 expectedVersions，丢响应显示“结果待核对”，只查原收据；冲突保留输入并要求显式重读，不能自动换版本提交。
- paused 明确显示积压将于启用后派发；启用前显示项目/事件/批准目标及积压量。unknown 只提供“核对原投递”，无“重发试试”；只有已验证 not_accepted 屏障才显示“按原投递恢复”，清楚标明未执行过业务写回。
- sending 时暂停的文案说明在途可能已接受；accepted 显示“接收器已持久接受”，不展示任务操作成功。循环失联/配置摘要变化时撤销可投递结论，旧成功收据仍仅是历史事实。
- Lab 只静态说明，无真实 hooks、目标配置或模拟 accepted。保留键盘焦点、错误 live region、中英文本及 390px 无横向溢出。

## 11. 稳定实施步骤与文件责任

以下 W 编号稳定，子任务可细化但不得复用编号代表不同交付；共享文件由父线程安排唯一集成 owner。列出的新源码/测试名称都是拟新增，不制造不存在文件的 Markdown 链接。

| 步骤 | 依赖 | 文件责任与实施内容 | 可观察退出条件 |
| --- | --- | --- | --- |
| W01 冻结事实与协议 | 通知包共享事实设计 | 通知包拥有持久 mutation journal、`service_fact_events` 和来源归一；Webhook owner 只定义安全投影/receiver schema；父线程统一本文件与通知计划的字段、sequence/activation 和分类。 | 命令/原生/外部观测/legacy/private 的覆盖、缺口及排除规则无矛盾；只有一个事实源。 |
| W02 建立配置与外联门禁 | W01 | infrastructure 拟新增 webhook config/transport 模块；修改 `runtime-config.ts` 的非秘密配置接口。部署 manifest 精确 allowlist、secret 挂载与摘要，生产无私网豁免。 | URL/secret 不能由 API 输入；配置不全与未配置不同；API/Worker 摘要不一致不能启用。 |
| W03 增量持久模型 | W01 | infrastructure schema 与新迁移（编号集成时分配）；端点/消费/投递/attempt/receipt、不可变字段、约束、索引、独立租约。 | 空库和前一版升级可定义验证；源水位、去重与 delivery 在同锁事务中闭合；unknown 无自动领取路径。 |
| W04 应用命令与读取 | W02、W03 | application 拟新增 webhook 管理/消费模块；`registry.ts` 注册；`kernel.ts` 收据权限；API 拟 webhook routes、`app.ts` 注册；contracts schema/OpenAPI/client。导出调整前使用可用 LSP references 迁移所有调用者。 | 真实权限/CAS/同键恢复闭合，无任意 actor/URL 注入；管理收据不以普通读取权限泄露。 |
| W05 传输与接收器核对 | W02、W03 | infrastructure transport + domain 严格协议类型；应用投递端口。实现 DNS pin/remoteAddress/TLS、签名/限额/deadline、阶段判定、receiver receipt 与负面屏障验证。 | 只有实际认证收据可 accepted；普通 2xx/500/404/timeout 都不会伪成功/盲重发。 |
| W06 接入独立 Worker | W04、W05、共享事实导入可用 | application `deliverWebhookBatch`/loop；Worker main 的最终注册由父线程独占，与通知/找回/现有邀请统一接入。安全 heartbeat 与关闭行为。 | 双 Worker 只领取一次；sending 过期 unknown；HTTP 卡住不阻塞主心跳/SSE/其他邮件循环。 |
| W07 正式 UI | W04、W06 | web settings 的 Webhook 状态/端点/详情及 hooks；局部修改 catalog/settings-plugins 现有文案；不改其他连接器事实。 | 真查询/命令/原收据恢复；无权不查询；未配置、失败、blocked、unknown 不混为成功；Lab 零业务请求。 |
| W08 隔离真实验收 | W01–W07 全部集成后 | tests 拟新增 webhook 配置/协议/HTTP/Worker/恢复测试，复用 dashboard/worker fixtures；父线程统一执行检查和浏览器。 | 第 12 节矩阵有真实 HTTP/PG/进程/浏览器证据，未配置数据库或跳过不能算通过。 |
| W09 运维与发布门禁 | W08，生产外部输入另计 | 更新 deploy README、README 的能力边界与插件交付文档、备份验证脚本的附属表核对；父线程更新汇总索引/ADR。 | 新库/新卷恢复不重发历史、秘密备份独立、回退/停用和接收器合同有实际记录；公网目标未提供则仍不启用。 |

W02 与 W03 在 W01 冻结后可并行；W07 可基于 W04 冻结 DTO 开始，但只用真实服务验收。任何实现代理均不在中途运行 build/lint/tests/formatter；父线程集成后一次统查，避免共享迁移/Worker/合同半成品被误验。

## 12. 可运行验收矩阵（待实施后执行，非已有证据）

### 12.1 隔离装置和命令边界

沿用 [dashboard fixture](../../tests/dashboard-fixture.ts)、[Worker 进程测试](../../tests/worker-process.integration.test.ts)、[SMTP Worker 测试](../../tests/member-invitations-worker.integration.test.ts)模式：随机 PG schema、两个独立工作区和管理员/受限成员、临时 core/blob/manifest/key roots、随机 API/Web/接收器端口，真实 Node 子进程。验收只关闭自己拥有的进程/监听器并删除自建 schema/目录，不重启用户服务。

本地接收器是真实 HTTP/TLS listener，持久 inbox/receipt/屏障使用隔离数据库；可实际断开 socket、延迟/丢响应、关闭连接和控制 DNS。测试临时密钥不输出。测试 fixture 通过**仅测试入口的依赖注入**允许自有 loopback receiver/临时 CA/本地 DNS；生产配置 loader 和 main 不存在 `ALLOW_PRIVATE`、忽略 TLS 或任意地址绕过开关。测试子进程复用实际 `runWebhookLoop/deliverWebhookBatch`，只替换明确的 loopback 目标策略，不 mock HTTP 成功；生产 main 的注册、未配置禁用和心跳亦单独验证。公网 DNS/TLS/真实运营目标的验收是另一个上线门禁，不能以本地注入取代。

拟持久测试文件：webhook 协议/SSRF 单测、webhook HTTP 集成、webhook Worker 集成、webhook 恢复集成及 fixture。集成 owner 在文件落地后运行根文档/合同检查、受影响后端检查和真实数据库套件、前端检查；可用 `node --test` 对上述最终测试文件作独立复现。具体最终路径/命令在实现交付时登记，不在本规划假称已执行。

### 12.2 HTTP、签名、去重与恢复

| 场景 | 实际操作与证据 | 必须结果 |
| --- | --- | --- |
| W-HTTP-01 正常协议 | 经真实命令/原生接口保存 task；比较 core revision、共享事实、delivery bytes/hash；receiver socket 收请求并验签，落 durable inbox 和签名收据。 | eventId=factId、一个 delivery、一份 accepted 收据；无 PM 业务状态额外改变。 |
| W-HTTP-02 来源覆盖 | 分别执行核心 command、原生创建/修改、外部文件实际写入、重启/清 SQLite、未知写恢复。 | 同事实恢复不重复；外部仅有效观测、无 actor；离线中间状态不补造；pending 不发送。 |
| W-HTTP-03 防泄露 | 在标题/正文/评论/收藏/邮箱/认证字段置独特标记，产生公共/actor-private/legacy 事实；检查 receiver bytes、DB投递投影、管理 DTO、收据、logs。 | 只有三类对象严格字段；所有秘密/正文/身份标记及 internal/legacy 事实零外发；不把变更事件重放到任务命令。 |
| W-HTTP-04 重复与改参 | 重放同 fact、同 commandId、同 delivery；向 receiver 实际送相同 delivery/hash 的重复请求及同 ID 不同 hash。 | 源/消费/投递唯一约束有效；receiver 一次接受效果；hash 不同明确冲突；PM 不生成新 delivery 绕去重。 |
| W-HTTP-05 签名 | 改 body byte/header/path/method/timestamp/keyId，旧钥与新钥窗口、超时窗、签名缺失；真实 receiver 验证。 | 全部无效输入不接受；合法换钥原身份不变；不记录 signature/secret。 |
| W-HTTP-06 响应丢失 | receiver 已提交 inbox 后主动断 socket，或丢掉签名响应；观察多轮 Worker，然后 Reconcile。 | 进入 unknown、不自动再 POST；匹配签名查询确认 accepted，receiver 接受数仍 1。 |
| W-HTTP-07 否定恢复 | 首次 POST 未接受，reconcile 先持久关闭旧 attempt；之后注入旧迟到 POST，再显式 Resume。 | 旧 attempt 被屏障拒绝；原 deliveryId/body、新 attemptNo 只接受一次；普通404不能触发恢复。 |
| W-HTTP-08 不满足协约 | 接收器仅返回2xx、错误签名/hash、未认证500、查询404、只称not-found而无屏障、查询断线。 | 不伪accepted，不从unknown自动/强制重发；不满足接收器合同的端点不可启用。 |
| W-HTTP-09 本地提交丢失 | receiver 接受后使 PM receipt SQL commit 失败，再杀自有 Worker/等待 lease过期并重启。 | unknown；查询恢复相同投递，原业务收据/Markdown不变；不能靠新业务命令补偿。 |

### 12.3 撤权、SSRF/DNS、租约与 UI

| 场景 | 实际操作与证据 | 必须结果 |
| --- | --- | --- |
| W-AUTH-01 入队/发送前撤权 | source 保存后/准备完成后，分别撤销责任人 membership、domain.read、audit.read 或禁用账号；用数据库锁固定与dispatch提交顺序。 | 撤权先提交时 receiver 请求数为0；不能借通知接收人或其他管理员权限继续；端点 blocked。 |
| W-AUTH-02 在途撤权 | dispatch marker 已提交后暂停/撤权，receiver 延迟响应；随后查询/重新授权。 | 不能声称外部已取消；未知保持核对边界；接管不会新建delivery或自动重发。 |
| W-AUTH-03 跨域权限 | 非管理员/只有access.manage无audit.read、其他workspace、已撤权会话直接访问管理路由/原收据/分页。 | 正确403/404，无URL/计数/载荷泄漏；UI不发管理query，不显示旧快照。 |
| W-NET-01 不可任意调用 | API提交URL/headers/secret/未知targetKey，manifest放userinfo/query/IP/非443/HTTP/内网域名；监视receiver及被禁止监听器。 | 配置或schema明确拒绝，请求数0，无“保存成功但以后失败”的假配置。 |
| W-NET-02 DNS变化 | 自有DNS真实返回A集合，再变B；分别包含public→private、混合A/AAAA、IPv4-mapped、CNAME→private；观察实际socket地址。 | 每次重解析、全答案检查；private答案绝不连接；公网轮换只用本次校验IP，Host/SNI仍原hostname；无二次解析窗口。 |
| W-NET-03 Redirect/Proxy/TLS | receiver返回301/302/307至内网/同域，设置测试进程环境代理，错误证书，慢头/无限body/超限响应。 | 不跟随、不走代理、不关TLS；总deadline生效；已发POST无可信收据则unknown，第二目标请求数0。 |
| W-LEASE-01 双Worker | 两个自有进程同时领取同endpoint/事实，真实SQL锁和租约；等待持久状态而非猜sleep成功。 | 一条active lease，一份delivery；不重复派发/收据；共享事实导入重复无副作用。 |
| W-LEASE-02 崩溃切点 | 分别在preparing、sending提交后网络前、body发送后、receiver提交后、PM收据落库前杀自有Worker。 | preparing无发送标记可恢复；其余保守unknown；旧lease不能覆盖后继状态；必须核对而非超时回queued。 |
| W-LEASE-03 有界隔离 | receiver挂到deadline；同时制造真实outbox/SSE、邀请/找回自有接收器工作；再SIGTERM自有Worker。 | 主heartbeat持续推进，其他循环不被webhook阻塞；只关闭自有socket，退出有界；不把sending回queued。 |
| W-UI-01 真状态 | 正式浏览器查看未配置、合法目标、digest不一致、循环过期、503刷新、paused积压、unknown/已确认恢复；截断管理命令响应。 | 仅真实DTO决定可操作性；旧快照不是可用依据；按原commandId恢复；unknown无盲重发按钮。 |
| W-UI-02 目录/无障碍 | 搜索19项目、查看Webhook/SMTP/其余条目、Lab及390px中英深浅色/键盘焦点。 | 仅Webhook新增适配实现事实；其余未实现条目不变成功；无secret/任意URL表单，Lab业务请求0。 |

## 13. 迁移、备份、停用与前向恢复

1. **部署顺序**：先备份并完成旧版恢复演练；增量 schema/共享事实源先上，所有端点缺省禁用。现有 SQL activities/outbox 不全量转成出站历史。部署 allowlist/keyring 后校验 API/Worker 摘要，在自有 receiver 验收；管理员新建 paused 端点再显式 enable。迁移失败不开放能力。
2. **一致恢复**：[现有备份](../../scripts/backup.mjs)覆盖 SQL 和 core `.pm/state`（排除cache），但新 Webhook 表和共享 facts/journal 需加入恢复核验。secret keyring/manifest 由运营独立加密备份与访问控制，不在一般 evidence/JSON manifest中复制秘密。恢复到新库/新卷先断外联、禁用所有endpoint dispatch，核对源factId/sequence、deliveryId/hash、收据和keyring后再授权启用。
3. **防止恢复重发**：源重导入保持事实唯一；accepted不回ready；备份中的sending一律作为unknown候选核对。数据库回到旧时间点可能丢失备份后已发生的投递，不能只依赖随机新deliveryId：先与接收器已接受账本对齐共享事实/端点身份，无法证明一致则保留停用并核对，不能宣布恢复后可以直接重放全部源。
4. **停用/回退**：先暂停端点/关闭新dispatch并等待有界在途收尾，记录unknown；可退回不注册新循环的应用版本但保留新表/事实/journal，不下迁移删除记录、不重置published_at。旧应用不能接收新管理命令；UI明确不可用。重新部署使用原数据前向恢复，不把停用看作外部副作用撤销。
5. **运维恢复**：分别查询源导入错误、配置/授权blocked、准备租约、sending/unknown、接收器收据。修好DNS/配置不自动重发unknown；只有真实接收器核对与符合屏障的显式Resume。命令/运维日志只记ID、摘要、安全码、时间和责任操作，不存正文、签名或secret。
6. **保留和容量**：本包无自动GC。源事实/消费状态/receiver去重与关闭屏障不能用SSE保留期清掉。空间不足显示具体安全原因和积压，暂停新消费；仍保存的核心事实由共享journal恢复，不能删未知记录“解堵”。任何物理清理必须另行确定引用/备份/receiver去重的联合政策。

## 14. 交付与上线门禁

W01–W07 的具体代码、0029 增量迁移及 W08 durable receiver/Worker/DNS 夹具已落地，父层负责最终共享接线与统一验证。本实施线程没有实际执行 HTTP 接收、签名测试、数据库迁移、测试或浏览器操作；以下矩阵仍是待执行验收，不能标为已通过。W09 的公网接收器、数据授权、独立秘密分发与恢复对账继续作为生产门禁，默认不激活生产目标。

本地实施退出条件是：共享事实包真实落地，实际 HTTP/TLS receiver 验签与 durable inbox/屏障、真实 PG/双 Worker/断流/撤权/DNS 变化/丢响应矩阵均有记录，正式UI不伪成功，统一检查由集成owner执行。生产启用另需第3.2节实际目标/数据授权/secret/接收器协议/网络与运维输入；这些外部门禁不妨碍隔离本地验证，也不能被本地验证冒充已满足。

<a id="webhook-implementation"></a>

## 15. 实施落点与集成核验入口

| 步骤 | 已落文件与实际合同 | 证据边界 |
| --- | --- | --- |
| W01 | `packages/domain/src/webhooks.ts`：三类对象显式投影、严格 body/receipt、双域 HMAC；只读取通知包唯一 `service_fact_events`。拒绝 legacy/private/未知 schema/category、无 afterRevision、删除/多项目不安全来源。 | Notifications owner 已冻结 0026 的同工作区 FK、sequence 与真实 observedAt；本线程未运行来源矩阵。 |
| W02 | `packages/infrastructure/src/webhook-config.ts`：严格 manifest、部署批准 targetKey、端点独立 secret 引用、目标/密钥元数据摘要分离，未配置与配置错误分开。 | API 不开 secret；Worker 文件不可用时不能启用。未提供生产 manifest/密钥。 |
| W03 | `packages/infrastructure/migrations/0029_webhooks.sql`、`packages/infrastructure/src/webhook-schema.ts`：端点、消费、不可变 bytes/hash、独立 leases、attempt/receipt、循环/有界 key 健康与恢复隔离；同工作区 FK、唯一事实消费、accepted 证据约束、unknown 恢复屏障、不可变历史触发器。 | 尚未应用空库/升级迁移；父层统一执行。 |
| W04 | `packages/application/src/webhooks.ts`、`webhook-store.ts`、`packages/contracts/src/webhook-schemas.ts`、`apps/api/src/webhook-routes.ts`：六命令/当前 SQL 历史授权/CAS/原收据权限、三查询/actor-bound 分页/安全 DTO 与严格输出 schema；管理变化仅发 actor-private outbox invalidation，不公开管理 ID 或用 outbox 当外部事实源。 | registry/kernel/client/OpenAPI/app 为父层接线；没有任意 URL/actor/secret/header 输入。 |
| W05 | `packages/infrastructure/src/webhook-transport.ts`：实际 HTTPS socket、全部 DNS A/AAAA/CNAME 检查、本次 IP pin、TLS Host/SNI/remoteAddress、无代理/redirect/retry、4/8 KiB 与有界 deadline；GET receipt 后必要时 POST reconcile 关闭旧 attempt。 | 可注入的测试网络 policy 只在 `tests/` 使用；生产 main 不暴露私网/跳证书开关。 |
| W06 | `packages/application/src/webhook-delivery.ts`：有界消费/领取、workspace 锁与最终当前权限准入、preparing/sending/reconcile 独立租约、sending 过期 unknown、认证接受、显式否定屏障后同身份恢复；独立 `runWebhookLoop`。 | Worker main 并行注册及主 heartbeat 不受阻塞由父层集成验证。 |
| W07 | `apps/web/src/features/pm/service/settings/plugin-webhook-status.tsx`、`use-webhooks.ts`、`settings-plugins.tsx`、`plugin-catalog.ts`：真实 targetKey/范围表单、paused/积压预告、确认版本、未知原命令收据、投递/attempt/认证收据与显式恢复 UI。 | 无权不挂 query；Lab 静态；其余连接器仍禁用。前端/390px/键盘/中英验收尚未运行。 |
| W08 | `tests/webhook-protocol.test.ts`、`webhook-dns.test.ts`、`webhook-commands.integration.test.ts`、`webhook.integration.test.ts`、`webhook-worker.integration.test.ts`、`webhook-restore.integration.test.ts`；`webhook-fixture.ts`、`webhook-receiver-fixture.ts`、`webhook-worker-fixture.ts`。 | 使用隔离 PG schema、真实 HTTPS+临时 CA、durable inbox/效果/旧 attempt fence、真实 DNS UDP listener、独立 Node Worker 子进程及恢复目标 fence；尚未执行，未配置数据库而跳过不算通过。 |
| W09 | `packages/application/src/webhook-restore.ts` 导出真实 `fenceRestoredWebhooks(sql)`，由父层恢复事务组合：保留 accepted/bytes/收据，非 accepted/non-suppressed 保守 unknown，清除 lease/旧健康并建立持久工作区隔离。父层统一更新部署/备份/README 和新卷核验。 | 技术实现和隔离证明均不能代替第 3.2 节接收器、数据许可、DNS/TLS/egress、保留/SLO 与密钥运维输入；不能在源数据库调用恢复 fence。 |

恢复到旧检查点后，备份之后已经接受但本地账本缺失的投递不能靠随机新 deliveryId 推断或补发。`restoreFenced=true` 时只允许原历史核对；运营必须提供接收器持久账本、端点/源 fact/delivery/hash 与备份检查点对齐证明，才能在受控停写恢复程序中解除隔离。该接收器账本导出/对齐承诺属于第 3.2 节缺失的真实生产输入，本包不虚构通用供应商对账能力，不提供公开 force-unfence。

部署 manifest 的结构示例（仅合同示例，不是实际批准目标或可直接启用配置）：

```json
{
  "schemaVersion": 1,
  "targets": [{
    "targetKey": "approved_receiver",
    "workspaceId": "00000000-0000-4000-8000-000000000001",
    "projectIds": ["PRJ-001"],
    "eventTypes": ["pm.task.changed.v1"],
    "deliveryUrl": "https://receiver.operator-approved.com/pm/deliver",
    "receiptBaseUrl": "https://receiver.operator-approved.com/pm/receipts",
    "reconcileBaseUrl": "https://receiver.operator-approved.com/pm/reconcile",
    "protocol": "pm-receipt-v1",
    "policyVersion": 1,
    "keyring": [{
      "keyId": "operations-issued-key-id",
      "secretFile": "/run/secrets/pm-webhooks/{endpointId}/operations-issued-key-id",
      "activeFrom": "2026-10-01T00:00:00.000Z",
      "activeUntil": null,
      "receiverReady": true
    }]
  }]
}
```

父层集成完成后使用隔离数据库执行（本线程未执行）：

```bash
node --test tests/webhook-protocol.test.ts tests/webhook-dns.test.ts
TEST_DATABASE_URL='<isolated-postgresql-url>' node --test tests/webhook-commands.integration.test.ts tests/webhook.integration.test.ts tests/webhook-worker.integration.test.ts tests/webhook-restore.integration.test.ts
```

集成套件临时证书生成依赖 `openssl`；没有该二进制应明确失败而非跳过 TLS 或伪造认证成功。测试只销毁自己创建的 schema、目录、UDP/TLS listener 与子进程。正式生产接收器仍必须单独证明 durable inbox 原子效果、持久去重/关闭屏障、双向签名、独立密钥分发与长期收据保留，不将本地夹具叫作供应商支持。


## 16. 集成后的实际证据

- 实际运行协议/DNS 和真实 PG/TLS/独立 Worker/restore 回归，覆盖最小事实、签名、SSRF/地址固定、授权/CAS、原 deliveryId/attempt、丢响应/认证核对、关闭屏障与恢复隔离；skip 不算通过。
- 浏览器选择批准 targetKey、PRJ-001 与 `pm.task.changed.v1`，创建 paused 端点；单独 provision 测试密钥后显式启用。真实 CreateWorkItem 触发 HTTPS，独立 PostgreSQL inbox 持久 accepted、effect_count=1；页面显示“接收器已持久接受”，body 无标题/正文/actor/链接。
- 首个浏览器夹具 keyId 与接收器固定测试键不一致，实际401保守记为 unknown、零接收效果且没有自动重投；修正测试配置后在独立资源完成正向证明，未放宽签名验证。
- 临时 CA 与 loopback 解析/连接注入仅用于自有真实 TLS 接收器；生产拒绝规则不变。实际 restore-rebind 在目标库设置持久 Webhook 围栏，不能因恢复 PM 库推定外部账本同步；生产接收器、目标、密钥与数据许可仍未代为决定。
