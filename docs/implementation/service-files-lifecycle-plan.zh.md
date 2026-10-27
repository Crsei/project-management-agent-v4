# Files 显示名、软隐藏／恢复与独立版本复制实施规划

状态：**F01–F10 的源码及共享接线已交付，隔离真实数据库/HTTP/浏览器/S3 与备份路径已执行；未升级业务实例或启用生产服务**。批准合同的“拟”措辞和第12节保留为实现代理首轮交接记录，不能继续解释为仅有规划。当前实际证据见第13节及[统一交付](service-completion-and-acceptance.zh.md#five-package-delivery)。

## 1. 范围、权威与不做事项

本包落实 D13 中方向已经明确的三件事：修改 Artifact 显示名；软隐藏并以**原 Artifact ID 恢复**；将一个明确选定的不可变 ArtifactVersion 复制为同工作区的独立 Artifact。允许复制到原项目或另一授权项目，绝不移动原历史。

遵守 [Markdown 接入 ADR](markdown-integration-adr.zh.md)、[领域不变量](../domain-design/invariants.md) INV-01/09/10/13/14/20、[场景](../domain-design/scenarios.md) SC-07/12/13/14/16/20 和 [INF-01/03/04/05/06](../domain-design/README.md#implementation-plan)。九类核心 Markdown 仍是权威；SQL 仅保存 PM 附属 Artifact／Upload／Evidence／Submission／Review、收据、来源及 outbox。不把附件操作变成任务完成、审核失效或核心文件改写。

明确不做：物理删除、版本 tombstone、保留期到期清理、孤立对象 GC、内容去重／共享 objectKey、跨工作区复制、整套版本历史／Evidence／Submission／Review 复制、批量命令、文件移动、长期下载签名 URL、修改浏览器 StageUpload／下载协议、S3 专用 copy/delete、Agent、CRDT、多实例核心写入。不得因本包增加 Redis、RabbitMQ 或通用任务框架。

## 2. 已核实的当前实现

以下是源码事实，不是拟新增能力的运行证明。

| 证据 | 当前行为及规划影响 |
| --- | --- |
| [delivery.ts](../../packages/application/src/delivery.ts) `StageUpload`、`upload`、`publishVersion` | StageUpload 在 SQL 事务内调用 `store.put`，生成 1 小时上传租约；登记校验 upload 的 CAS、本人所有、未消费、未过期及实际字节摘要。发布版本需要 uploadId，并更新 upload 消费指针。失败不会删除内容。 |
| [delivery.ts](../../packages/application/src/delivery.ts) `RegisterArtifact`／`AddArtifactVersion` | Artifact 现有 `title/kind/versionRefs/latestVersionId`；追加版本校验 Artifact 和 upload CAS。版本存 `artifactId/uploadId/objectKey/sha256/contentDigest/size/mediaType/fileName/sourceRunId/producerId`。当前没有改名、隐藏、恢复、复制命令。 |
| [delivery.ts](../../packages/application/src/delivery.ts) `downloadArtifactVersion`／`verifyVersion` | 按 version ID 当前授权读取，再读真实字节并核对 sha256、contentDigest、size；返回历史 fileName。历史下载不依赖 `latestVersionId`。 |
| [queries.ts](../../packages/application/src/queries.ts) | `readEntity`／`listEntities` 要求当前 domain.read 和项目范围；列表在只读 repeatable-read 快照内分页，游标当前绑定 kind/projectId，没有隐藏筛选。Entity JSON 原样返回，不能把跨项目源 ID 塞进去再指望 UI 隐藏。 |
| [kernel.ts](../../packages/application/src/kernel.ts) | 按工作区 SQL 锁串行；相同 actor/commandId/requestHash 返回原收据，异参 409。可变写入要求最初读取版本，SQL 更新递增 version；业务写入、收据、outbox 同事务。DomainError 拒绝回滚业务 savepoint 后保存 rejected 收据；数据库异常可能整笔回滚、没有收据。收据仅原 actor 可读并重查所有 touched projects。 |
| [BlobStore](../../packages/infrastructure/src/blobs.ts) | 只有 init/check/put/read；MAX_BLOB_BYTES=8 MiB。LocalBlobStore.put 每次生成新随机 key，持久发布后返回 key/sha256/size；read 有界读取并验证内容。没有 copy/delete，不假设事务回滚能撤销 put。 |
| [domain/core.ts](../../packages/domain/src/core.ts)／[access.ts](../../packages/application/src/access.ts) | 复用现有 Entity、Command、CommandReceipt 和 delivery.write/domain.read；能力是 workspace 级列表加 projectIds 范围，不存在每项目不同 capability 列表。不能声称当前授权模型已经支持“A 只读、B 可写”的逐项目能力差异。 |
| [0001 SQL](../../packages/infrastructure/migrations/0001_foundation.sql) `pm_guard_entity` | ArtifactVersion、Evidence、Submission、Review、Decision 不可更新；所有 entities 禁止删除。Artifact 可 CAS 更新。artifact_version_upload_unique 限制一个 upload 只发布一个版本，upload_object_key_unique 禁止重复 upload objectKey。 |
| [0005 SQL](../../packages/infrastructure/migrations/0005_markdown_core_identity.sql) `pm_validate_entity`／[0003 SQL](../../packages/infrastructure/migrations/0003_reference_validation.sql) | 当前 project_id 是 text，核心身份由 Markdown 校验；版本仍必须有同项目 uploadId、artifactId，sourceRunId 必须 null。复制不能跳过 upload 或放宽原同项目引用检查。0005 的历史清库不属于本轮迁移方案，禁止重用。 |
| [0014 审计](../../packages/infrastructure/migrations/0014_project_audit.sql)／[0024 修复](../../packages/infrastructure/migrations/0024_project_audit_restore_scope.sql) | 受控实体写入已有不可变审计；字段采用显式安全白名单，当前有 title，没有隐藏字段。复制来源不能进入目标项目的通用审计 changes。新迁移不得改写旧审计或修改旧 migration 摘要。 |
| [Files model](../../apps/web/src/features/pm/service/project-files/model.ts)／[页面](../../apps/web/src/features/pm/service/project-files/index.tsx) | 按 Artifact 聚合版本，目前最新 fileName 优先于 artifact.title；无父 Artifact 的版本会作为孤立条目显示。菜单只有预览／下载／复制链接。新增隐藏筛选时必须防止“隐藏父项、版本作为孤立行复活”。 |
| [上传 UI](../../apps/web/src/features/pm/service/project-files/UploadDialog.tsx)／[预览 UI](../../apps/web/src/features/pm/service/project-files/FilePreviewDialog.tsx) | 已有两阶段上传、原 commandId 恢复、逐版本下载与版本深链；追加上传目前在登记前从查询快照找目标，不是用户选择时固定的操作基线。预览标题目前使用选中版本 fileName。 |
| [pm-data.ts](../../apps/web/src/features/pm/service/pm-data.ts)／[pm-service.tsx](../../apps/web/src/features/pm/service/pm-service.tsx) | 分页读取和缓存 key 目前只含 kind/projectId；新增 visibility 必须同时穿透分页、query key、hook 和刷新，不可只过滤浏览器可见行。 |
| [既有 Files 交付](project-files-replication-plan.zh.md) 第12节／[backend.integration.test.ts](../../tests/backend.integration.test.ts) | 已有真实上传、两版本摘要、Evidence、权限及暂存／登记丢响应证据，测试含随机 schema、真实 HTTP、临时 Markdown/blob 根目录和 corrupt blob。只能复用模式，不能拿旧证据声称本包新功能通过。 |

当前项目写守卫来自 [planning.ts](../../packages/domain/src/planning.ts) `assertProjectWritable`：仅未归档的 planning／active 项目可写。API 的 [coreAccessFor/projectMetadataWrites](../../apps/api/src/app.ts) 为部分 PM 附属写入重扫当前核心文件；新增命令需要登记在相同受控路径，不以旧浏览器项目快照判断可写。

## 3. 本包选定默认与剩余产品政策

### 3.1 本包采用的可执行默认

| 项目 | 选定默认（拟实施） |
| --- | --- |
| 唯一显示名 | **复用 `artifact.data.title`**，不再新增 displayName 别名。列表、卡片、搜索、名称排序、上传目标选择及预览主标题均以 title 为准。历史 `artifact_version.fileName` 单独标“原文件名”；下载始终用它。 |
| 名称兼容 | 复用现有 title 的 trim、非空、最大 20,000 字符规则，不暗加 filename 的 255 字符／路径规则。显示名只是 React 转义的纯文本，不作为路径、MIME、下载名或可信预览类型依据；长名用截断展示和可访问全名。重复显示名允许，不加未经决定的同项目唯一性。 |
| 初始显示名 | 新登记沿用 `RegisterArtifact.payload.title`，普通多文件上传目前默认原文件名；追加版本**不自动重命名**。旧有效 title 不被最新 filename 覆盖。该 cutover 会使“旧 title 与最新 filename 不同”的条目改为展示旧 title，UI 同时呈现原文件名，见迁移。 |
| 隐藏 | Artifact 级共享软隐藏，不是个人归档，更不是 ACL 撤销；不删除 Artifact、任何版本、对象、引用、封面或审核。默认集合与新版本目标选择排除隐藏项。 |
| 历史访问 | 当前有 domain.read 的读者仍可通过已知 ID、历史 Evidence／Submission／Review／封面和版本链接下载、预览。隐藏列表也可由当前项目 reader 读取；写者才可恢复。明确提示“从默认文件列表隐藏，不撤销下载权限”。 |
| 恢复 | 显式 RestoreArtifact，在原项目恢复**同一 ID、同一版本链、同一 objectKey**；不 RegisterArtifact 重建，不重新上传，不抹掉隐藏历史。未设保留政策时永不自动 GC。 |
| 隐藏时的写入 | RenameArtifact／AddArtifactVersion 对隐藏目标返回 artifact_hidden，须先恢复。隐藏源的历史版本仍允许复制；复制是新身份而非恢复。现有按 ID 记录 Evidence／Submission／封面继续遵循原授权与版本校验，不因隐藏新增隐形业务门槛。 |
| 项目生命周期 | 改名／隐藏／恢复和复制目标均沿用项目可写规则；归档／关闭项目中这些写入口禁用。源只读，允许读取仍被授权的历史项目版本，不要求源项目可写。须恢复归档项目才能在其中恢复 Artifact。 |
| 复制 | 同 workspace；选定确切版本，不隐式改为最新。新 Artifact、新版本、新 upload、新随机 objectKey；仅字节摘要、大小、MIME、原 fileName 与选中版本相同。执行者是新 producer，时间是新创建时间，sourceRunId=null。 |
| 复制默认名／类型 | 复制表单预填源 Artifact 当前 title 与 kind，必须将最终 title/kind 作为请求值冻结提交；不擅加“副本”后缀，也不覆盖同名目标。复制确认前展示目标项目与“目标读者将获得该版本内容”。 |
| 复制历史 | 不复制原 versionRefs、producer 身份、Evidence、Submission、Review、任务关联、封面或审核通过结论。源和目标此后独立追加版本／改名／隐藏，互不传播。 |
| 非原子边界 | 对象已持久但 SQL 未提交时可产生孤立对象，保留而非补偿删除。unknown 只核对原 commandId，不自动再次 put／重建。 |

### 3.2 仍需要用户而非实现者决定的政策

这些问题**不阻塞上述安全默认**；若用户要求不同语义，必须先改合同与验收，不允许开发中自行推断：

1. 隐藏后是否应撤销历史读者的下载、是否需要独立 restore 权限或双人审批。本文不实施这类访问封禁，delivery.write 仅管理默认列表可见性。
2. 何种法律／合规保留期、强制擦除、备份到期及物理 GC 审批；没有期限就保持内容，不把 upload 的 1 小时租约当清理授权。
3. 是否限制跨项目内容分发，或要求源项目管理员额外批准。本文使用**源读＋目标写**；复制确认是显式向目标受众发布内容，不暗中迁移原项目历史。
4. 更短的显示名上限、组织命名规范、同名自动后缀／唯一性、配额／计费。本文沿用现有 title 合同与 8 MiB 单对象上限，不引入新收费或新配额。

## 4. 拟数据模型与迁移后唯一读模型

### 4.1 Artifact 元数据（拟新增隐藏字段）

仍使用 `entities.kind='artifact'`，data 保持 `title/kind/versionRefs/latestVersionId`，新增：

| 字段 | 合同 |
| --- | --- |
| `hiddenAt` | ISO 时间或 null；由服务端赋值，不接收客户端时间。 |
| `hiddenBy` | user UUID 或 null；来自认证 actor；与 hiddenAt 成对为空／非空。历史用户失效不妨碍读取及恢复，不要求旧 hiddenBy 仍为活跃会员。 |

隐藏／恢复都 CAS 更新 Artifact version。隐藏历史由已有不可变审计与新 outbox 事件记录；恢复清空当前 hiddenAt/hiddenBy，不删除旧事件。不得在 ArtifactVersion 上补隐藏标志，不得放宽 pm_guard_entity。

### 4.2 `artifact_copy_origins`（拟新增、独立不可变来源表）

不得把来源信息直接放到目标 Entity.data：`readEntity` 原样返回 JSON，会把源 ID 泄露给只有目标权限的读者。

| 列／约束 | 拟合同 |
| --- | --- |
| 身份 | `workspace_id uuid`，`target_artifact_version_id uuid`；两列主键，目标首版本最多一个来源。 |
| 目标 | `target_artifact_id uuid`、`target_project_id text`。 |
| 来源 | `source_artifact_id uuid`、`source_artifact_version_id uuid`、`source_project_id text`。允许源／目标项目相同，不允许源／目标版本或 Artifact ID 相同。 |
| 操作事实 | `copied_by uuid`、`command_id uuid`、`copied_at timestamptz`；`UNIQUE(workspace_id,copied_by,command_id)`。 |
| 引用完整性 | source/target artifact/version 都用 `(workspace_id,id)` FK 指向 entities；copied_by 指向 users；到 command_receipts 的 `(workspace_id,actor_id,command_id)` FK 使用 DEFERRABLE，因收据由内核最后插入。 |
| 类型／归属 | 独立延迟约束触发器核对四实体 kind、各自 project_id、版本 artifactId；源与目标均同 workspace。不能把跨项目来源交给现有 `pm_assert_reference` 的“必须同项目”检查，更不能放宽全局检查。 |
| 字节独立性 | 约束／命令同时核对源目标 sha256/contentDigest/size/mediaType/fileName 一致，objectKey 不同；目标 upload 也只在目标项目。 |
| 不可变 | 拒绝 UPDATE／DELETE／TRUNCATE；迁移与恢复验证此保护。来源属于内部审计事实，未作为通用 EntityKind 暴露。 |

SQL 权限不能代替应用鉴权；新表没有通用 list 路由，也不注册通用项目审计触发器将源 ID 展开到目标受众。

### 4.3 复制时为什么仍创建新 upload

当前 SQL 明确要求每个 artifact_version 有同项目 uploadId，并有每 upload 单版本唯一约束。复制**不复用源 upload**，也不新增“copy 类型版本”的永久旁路。命令在新 put 成功后插入目标 upload v1，字段沿用当前 upload 模型（owner=actor、fileName/MIME=选中版本、租约时间按现有常量），随后在同一 SQL 事务中走 publishVersion，消费为 v2；它从未作为可供另一请求消费的暂存上传暴露。

目标 Artifact／version 与已消费 upload、来源、原收据和 outbox 要么一起提交，要么一起回滚。独立对象的 put 不属于该原子性承诺。

## 5. 拟命令契约：权限、CAS、幂等、失败恢复

全部使用现有 `POST /api/v1/workspaces/{workspaceId}/commands`。新增名称如下，不把尚不存在的命令写成已上线端点。未知字段使用严格 Zod schema 拒绝。

### 5.1 公共规则

- 每个新命令都要求当前有效认证／membership、domain.read 和对应项目范围；写目标额外 delivery.write。权限从服务端 actor 派生，不接收 producerId/hiddenBy/ownerId。权限模型没有“access.manage 自动包含 delivery.write”。
- 先完成项目、归属、状态、CAS 检查，再执行 blob I/O。沿用现有 workspace 锁、审计事务上下文、ctx.update/emit、requestHash、savepoint、receipt；**不得**自造成功收据、绕过 CAS 或先发事件后提交。
- 新写命令登记到现有 `projectMetadataWrites` 的重扫路径；使用当前 Markdown 项目状态。复制在较慢的 read/put 后、插入 SQL 发布记录前再次读取目标项目并核对选定版本／可写状态。不宣称 SQL 锁能阻止外部 Markdown 文件编辑或形成文件／SQL 分布式事务；使用现有核心输入校验边界，不写项目副本。
- 同 actor/commandId/同规范请求返回原 committed 或 rejected 收据；同键改 payload／expectedVersions 报 idempotency_conflict 409。确定 rejected 后修改输入需显式新命令；未知不换键重发。原收据读取按当前 touched-project 权限复核。
- 业务冲突保存 rejected 收据且不保留 SQL 业务行／outbox。版本缺失与过旧均 version_conflict 409；项目越界、跨 workspace 引用用现有不泄露资源的 404；缺能力 403；结构错误 400。项目状态错误沿用现有守卫错误。隐藏 guard 新错误 `artifact_hidden` 409，不新增“成功但实际没改”的假响应。

### 5.2 新命令矩阵

| 拟命令 | 信封与 payload | CAS 基线／权限 | 成功结果及状态 | 拒绝与恢复 |
| --- | --- | --- | --- | --- |
| `RenameArtifact` | targetId=Artifact UUID；projectId=该项目；`{title:string}` | 弹窗打开时冻结 Artifact.version；expectedVersions[artifactId] 必填。源项目 domain.read＋delivery.write，项目可写，Artifact 可见。 | `{artifact:Entity}`；只改 title，Artifact v+1；`ArtifactRenamed`。与当前 title 相同也走 CAS；若完全相同返回原实体且不增加版本／事件，收据仍 committed。 | 冲突保留输入和原基线，显示服务端 title；用户显式重新合基线后新命令。unknown 仅原收据核对。不得更新历史 fileName。 |
| `HideArtifact` | targetId=Artifact UUID；projectId=该项目；`{}` | 冻结 Artifact.version；expectedVersions[artifactId] 必填；同上权限。 | visible→hidden：设置 hiddenAt/hiddenBy，v+1，`ArtifactHidden`。已隐藏且 CAS 相符则返回当前实体、不增版本／事件；不是物理删除。 | 旧版本即使当前已隐藏也 409，不以“目标状态相同”吞掉 CAS。unknown 找回后只刷新列表；不继续 Delete 或重新隐藏。 |
| `RestoreArtifact` | targetId=原 Artifact UUID；projectId=原项目；`{}` | 在隐藏列表／历史预览读取原 Artifact，并冻结其隐藏状态版本；同上权限及项目可写。 | hidden→visible：清空 hiddenAt/hiddenBy，v+1，`ArtifactRestored`。已可见且 CAS 相符则无实体写入，返回当前原 ID。 | 项目归档／关闭时明确先恢复项目；没有原 ID 不创建替代品。冲突保留恢复意图，重新读取后显式确认；unknown 只按原键找回。 |
| `CopyArtifactVersion` | targetId=源 ArtifactVersion UUID；projectId=目标项目；`{targetTitle:string,targetKind:string}`，title/kind 沿用当前登记校验 | 冻结源 Artifact.version、选定 immutable version.version（当前为1）、目标项目.version，全部放 expectedVersions。ctx.get 源版本／Artifact 要源 domain.read；目标项目要 domain.read＋delivery.write＋可写。源隐藏／只读不阻止复制。 | `{artifact,artifactVersion}`，均是目标项目新身份；新 upload 仅内部消费；`ArtifactRegistered`／`ArtifactVersionAdded` 等现有目标事件加一条 `ArtifactCopied`。源零更新。 | 源新增版本／改名／隐藏导致源 Artifact CAS 变化，即使旧选中版本仍存在也 409，要求显式确认；不静默改选最新。blob 失败、撤权、SQL 失败按第7节处理。原收据双项目 scope，撤去源权限后不能凭目标权限取回。 |

复制对新 Artifact 没有“非存在实体的 CAS=0”，也不要求不存在的 upload CAS：这些是本事务 created 实体。目标项目 CAS 是用户确认目标时的读取版本，不是在发送前用最新查询覆盖。若源目标同项目，expectedVersions 中项目键只出现一次。

### 5.3 现有命令必须同步适配，不能漏掉的基线

| 现有命令 | 保留与增量 |
| --- | --- |
| StageUpload | 不变：delivery.write＋项目可写；无既有 upload CAS；8 MiB／原 fileName／mediaType／一小时租约；原 commandId 恢复。put／SQL 非原子性同第7节。 |
| RegisterArtifact | 初始化 hiddenAt/hiddenBy=null；title 是唯一显示名。保留本人 upload 的 expectedVersions[uploadId]、未消费／未过期／实际摘要检查。已确认暂存但登记失败时可显式继续登记，不再次上传。 |
| AddArtifactVersion | **在选择目标成果／确认上传意图时冻结目标 Artifact 基线**，不能等 StageUpload 完成或 SSE 更新后替换。登记仍必须携带该 Artifact 基线和实际 upload.version；隐藏目标报 artifact_hidden。冲突保留已暂存 upload，在租约内经用户重新确认目标状态后新登记命令，不自动合基线／再上传。 |
| RecordEvidence／SubmitWorkItemResult／RecordReview | 原版本引用、摘要检查、审核身份和不可变历史保持；Rename/Hide/Restore/Copy 不改它们或任务状态。旧明确版本引用不会改指向“最新”或副本。 |

## 6. 拟查询、来源访问、事件及 UI 合同

### 6.1 默认展示与完整分页

扩展现有 entities 列表，拟参数 `visibility=visible|hidden|all`，省略为 visible，仅适用于 artifact／artifact_version。其他 kind 只接受省略或 visible，非默认值返回 validation_failed。

- artifact：按 hiddenAt 判断；artifact_version：JOIN／EXISTS 父 Artifact 后按父状态判断，**在 SQL 授权和 LIMIT 前过滤**。不能先拿一页再过滤导致分页丢项。
- `visibility=hidden` 是当前有 domain.read 的项目读者可访问的隐藏集合；它不是秘密回收站。`all` 供明确选择的全量历史、恢复和深链使用，不是默认列表。
- 游标绑定 kind、projectId、visibility、最后 UUID。旧游标缺少 visibility 时拒绝为不匹配，并让客户端从首页重读；不能把 visible 游标用于 hidden。每页现有 cursor／快照语义保留。
- 直接 GET entities/:id 与版本 content **不因 hiddenAt 拒绝**；仍复核当前 domain.read／项目授权、摘要。历史获取不能被默认集合筛选间接破坏。
- 查询缓存 key、readAllEntities、usePmEntities、client.listEntities、API Zod 及 OpenAPI 同时贯穿 visibility；默认调用不变。SSE 失效须覆盖 visible／hidden／all 三类缓存。
- 已发现的无父 Artifact 孤立版本必须作为数据异常处理：不因默认列表缺少隐藏父项就回退创建一行。深链可直接读取确切版本和父 Artifact；数据真的损坏则保留授权历史读取／诊断，不伪造新父项。迁移前置审计必须识别这类数据，见第8节。

### 6.2 不泄露源 ID 的来源读取（拟新增）

拟新增 `GET /api/v1/workspaces/{workspaceId}/artifact-versions/{id}/copy-origin`，路由 id 为**目标版本 ID**；只读且不需 CAS／commandId。

1. 先按当前权限读取目标版本与目标 Artifact；目标不可读统一 404。
2. 没有来源行，或来源项目当前不可读／源项目不可用：统一 `200 {origin:null}`，不返回 hasOrigin、源数量、源名称、项目 ID、Artifact ID、版本 ID 或不同错误线索。
3. 两侧当前均有 domain.read 时才返回 `origin:{sourceProjectId,sourceArtifactId,sourceArtifactVersionId,copiedAt}`。只在返回成功后 UI 才渲染“查看来源”链接；不自动从链条递归展开更多源。
4. 每次读取复核权限，`Cache-Control: private,no-store`；前端 cache 带 actor/workspace/membership scope，撤权清理。无源权限仍可正常下载目标的独立字节，不要求源权限作为目标内容 ACL。

目标通用 Entity.data、upload、outbox payload、ChangeNotification、目标 audit changes、浏览器普通列表缓存都不得嵌 source IDs 或原 sourceRunId。复制请求/来源原始事实不进入普通日志正文。命令收据只返回目标实体；现有 touchedProjects 同时包含源／目标，原 actor 也必须当前能读两侧才能重读该收据，不改成“任一侧即可”。

### 6.3 事件边界（拟新增）

- Rename／Hide／Restore 的 outbox 以 Artifact 为聚合，随 v+1；payload 只含本项目安全事实。审计增加 hiddenAt/hiddenBy 白名单；title 已在白名单。来源 ID 不加入任何目标项目白名单。
- `ArtifactCopied` 以**目标 Artifact**为聚合，仅携带 `{artifactVersionId:<目标版本>}`。沿用目标 upload／version／Artifact 的已有发布事件；不在源项目发“副本目标位置”事件，避免向只有源权限者透露目标项目。
- 现有 outbox→events→SSE 仍仅做持久失效通知，published_at 不是外部送达；本包不新增 Worker 循环、不清理源 outbox。站内通知／Webhook 若选择消费文件事件，须按各自安全白名单和当前受众另行接入，不能自动转发来源表／收据。

### 6.4 真实前端改动（拟实施）

1. Files 工具栏增加“可见文件／已隐藏／全部”选择，初始 visible。隐藏集合空态与搜索无结果不同，保留查询错误／过期快照标记。隐藏条目显示清晰标记，不叫“已永久删除”。
2. 菜单按真实能力开放“修改显示名”“隐藏”“复制所选版本”；隐藏项提供“恢复”。reader 可读隐藏历史，无写按钮；业务／存储不可用、项目不可写、命令 pending／unknown 时按依赖禁用。仅 metadata 命令不需因 blob 存储故障禁用；复制必须 storage 可用。
3. 改名弹窗冻结 Artifact，保留未保存 title；SSE 不覆盖草稿／基线。预览主标题使用 Artifact title，副标题及版本行展示选定版本原 fileName、序号、时间、摘要／大小；类型和安全解码仍依据**原 filename/MIME/真实字节**，不能因改显示名为 .png 误判文件安全。
4. 隐藏确认写明历史仍可访问／不会删除 Evidence；恢复动作明确原 ID。隐藏后打开的预览不突然丢失历史，应显示隐藏提示和恢复入口；刷新后原 `?file=<versionId>` 深链可直接按 ID 恢复历史读取，不能仅在默认 entries 中查找然后误报404。关闭弹窗保留现有项目／Files路由。
5. 复制入口同时支持当前最新和历史版本，默认预选**用户当前查看版本**；卡片入口明确显示将复制哪个版本。目标项目选项只列当前能读且 delivery.write 范围内可写的同工作区项目；提交前展示源原文件名、确切版本、目标、title/kind 与分发提示。隐藏源允许从隐藏集合／历史预览复制。
6. 新命令复用 usePmCommand／IndexedDB journal／工作区全局原请求恢复。局部记录仅保存操作元数据、原 commandId、冻结基线；不保存字节或源外部 URL。持久化恢复意图失败时不发写请求。丢响应后锁写，刷新后只核对原 commandId；收到匹配 committed 收据才导航新 Artifact／更新隐藏状态。
7. 身份切换、工作区切换、项目撤权要清空可见私有内容及来源链接，取消旧预览请求／撤销 Blob URL；保留原 actor 隔离的未知请求恢复依据。原 actor 失去源权限不能通过目标表面绕过收据权限。
8. **撤权导致原收据403/404不等于未提交。**复制原收据的双scope保护不放宽；原actor无法再读源项目时，UI显示“原结果暂不可查询”，保留原commandId并继续禁止新ID复制。恢复合法源权限后核对原收据，或交由有权运维人员核对原事务；不能用目标列表未出现、origin=null或下载失败推断可以重做。已提交目标独立内容按目标权限访问，与原命令恢复是否暂被权限阻挡分开。

## 7. SQL 与对象存储非原子故障及恢复

### 7.1 复制顺序（拟实现）

在当前 runCommand 事务／workspace 锁内：读取与检查源 Artifact＋选定版本、目标当前项目及所有 CAS → `BlobStore.read(source.objectKey)` → 同 `verifyVersion` 核对 sha256/contentDigest/size → `BlobStore.put(bytes)` → 核对返回 sha256/size 与源一致且 key 不同 → **read 新 key 再核对实际摘要／大小** → 重查目标当前状态／基线及当前授权 → 插入目标 upload／Artifact／version，消费 upload → 插入来源行 → emit 目标事件 → 检查 deferred constraints → 内核保存原收据并 COMMIT。

8 MiB 有界 bytes 可在这条路径复用；不转 base64、不让浏览器重新上传、不在代码中复制不必要的 Buffer。仅本包组合 read/put，适配器的耐久、随机独立 key 与读完整性由本地／S3 共同 BlobStore 合同负责。额外新 key read 是发布前的实际独立对象验证，不以 provider 返回 ETag 代替摘要。

### 7.2 故障矩阵

| 故障点 | 允许的持久结果 | 用户／操作员恢复，不允许的动作 |
| --- | --- | --- |
| 权限／CAS／隐藏／项目状态失败，尚未 I/O | rejected 收据，零新对象／业务行／事件 | 显示真实错误；授权修复／显式重新确认后新命令。不能静默更新 expectedVersions。 |
| 源 read 缺失／摘要不符 | blob_read_failed／blob_integrity_error 等现有错误；零目标 SQL 发布 | 修复原存储／从可信备份恢复原对象并核验。不得复制空 bytes、伪造成功或改写不可变元数据掩盖损坏。 |
| put 失败或结果未知 | SQL 业务回滚；可有适配器已写但没有返回 key 的孤立对象 | 查询原收据；若确定 rejected，修复 provider 后可显式新动作。保留不明 key，不猜 key、不新增 delete/list/copy 端口。 |
| put 返回后新 key read／元数据检查失败 | rejected 收据；新对象可能已存在，但没有目标业务记录 | 作为存储完整性故障处理，保留对象；不能指向源 objectKey 当兜底。 |
| put 成功后 DomainError／约束拒绝／撤权复核拒绝 | 新 blob 孤立；savepoint 回滚目标 upload/artifact/version/来源/outbox；rejected 收据可存在 | 原收据说明失败；修复后显式新命令可能产生另一个 key，旧孤立对象仍保留。不能补偿删除，也不能声称整笔“无副作用”。 |
| put 成功后 API 崩溃／数据库断开，COMMIT 未知 | blob 可能存在；SQL 或整笔已提交，或整笔未提交 | 只按原 actor/workspace/commandId 查收据。404 不是未提交证明；不得再次发原命令、换键复制或凭对象存在当成功。 |
| SQL 已 COMMIT、HTTP 响应丢失 | 完整目标、来源、收据和 outbox，目标仅一份 | 刷新后查原收据恢复同一 ID；不再次 put。Worker 晚发布不影响 SQL 成功事实。 |
| 已提交后存储丢失／恢复只恢复 SQL | SQL 事实仍在，下载真实报503 | 按共同备份检查点恢复引用对象并校验 SHA/size；不新建副本代替原 ID，不把缺失解释为隐藏。 |

**无收据 unknown 的运维终结边界：**前端持续保留 unknown；不得将一次404变为失败。由操作员核对本次自有 API 请求／进程已终结、不会迟到进入内核，确认原数据库连接／事务结束，并在获取同一 workspace 锁后只读检查原 actor/commandId 收据及对应审计／来源事实。若存在收据，恢复原结果；若证明原事务未提交，记录非业务运维证据并显式解除这条失败尝试，才允许用户以新 commandId 开始新动作。该流程不合成 committed/rejected 收据、不重放旧 handler；无法证明时继续 unknown。孤立 key 在 crash 前未记下可能无法定位，这不妨碍确认没有 SQL 目标，但不承诺本包能枚举或回收它。实施者须把该操作写入运行手册并真实演练，不能用自动重试取代。

StageUpload 同样先 put 后 SQL，适用上述非原子说明。RegisterArtifact／AddArtifactVersion 失败通常只留下原已暂存 upload，租约和当前版本允许时可显式继续；过期后原上传不再可登记，先核对原命令状态，再由用户重新选择文件形成新暂存，不伪造延长租约。

## 8. 旧数据迁移、备份与前向恢复

迁移由共享合同统一分配为 `0025_files_lifecycle.sql`，不修改0001／0005／0014／0024。

1. 停写窗口前先只读审计现有 Artifact／version／upload：title 类型／长度／非空，versionRefs 唯一性及与实际 artifactId 关系，latestVersionId 归属，元数据摘要／size，upload 消费指针，孤立版本；记录 ID 和摘要，不公开内容／凭据。缺父、跨 scope、错误 latest 属数据损坏门禁，不能靠 UI 的 orphan fallback 当兼容路径，也不能伪造迁移成功。
2. 用现有备份流程备份 SQL、blob 与 Markdown 一致检查点；在新临时 DB／新内容根目录恢复验证后才迁移。本文不授权停止既有服务；实际实施由集成 owner 安排自有服务维护。
3. 新 migration 建来源表、约束／不可变触发器、隐藏字段校验、必要的 `(workspace_id,project_id,id)` 可见／隐藏部分索引，并扩展审计安全白名单。Artifact.title 沿用已有字符串；若个别旧 title 缺失／空，仅从其**已验证 latestVersionId 的原 fileName**修复；无法修复则阻断迁移并出具精确记录，不静默截断旧 title 或改版本 filename。
4. 对尚无隐藏字段的旧 Artifact 一次性写入 hiddenAt=null、hiddenBy=null，依照现有 entity guard **version+1**；保留 ID、createdAt/createdBy、versionRefs/latestVersionId、title、全部不可变历史及对象 key。updatedAt 标记迁移时间，不冒充上传时间；Files“最新上传”排序仍看选中版本时间。迁移不设置 pm.audit_actor，不虚构历史操作者／命令／outbox。
5. 不为旧文件补“复制来源”，即使摘要相同也不能推断复制关系。新来源表初始为空。SQL 校验允许恢复后的历史 disabled 用户引用，不给旧会员补授权。
6. 同次切换 API/client/UI：Files 的名称优先级从 latest.fileName 改为唯一 artifact.title，显示原文件名以解释变化。使用 migration 后的 Entity.version，关闭旧写 UI或使旧基线409；不能服务端接受旧版本忽略CAS。旧草稿保留并提示“系统迁移后基线变化”，由用户显式重新确认。旧命令收据保持原文，重读后再刷新当前实体，不能当作新基线。
7. 迁移完成后读模型要求隐藏字段存在且合法，移除长期 `title || fileName`／缺隐藏字段自动当可见的兼容写读逻辑。仅暂时的发布窗口可通过维护模式避免老前端连接新库，不维持两套字段双写。真实孤立数据修复先完成，否则不切默认列表。
8. 回退原则：首笔新命令前可回到经过演练的完整旧检查点；首笔新命令后**前向修复**，不降级到会忽略 hiddenAt、显示隐藏附件的旧 UI／API。必要时只读维护，保留新字段／来源／收据；恢复备份须使用能识别新 schema 的服务。不得 drop 来源表、回写旧版本或删除新对象来伪装未发生。

## 9. 稳定实施步骤与文件责任（当前交付映射见第12节）

步骤号 F01–F10 为本包唯一稳定标识；实现记录和验收引用这些号，不重编号。下表的新文件仅列拟路径，不制造指向尚不存在文件的 Markdown 链接。

| 步骤 | 依赖 | 任务与退出交付 | 文件责任／共享边界 |
| --- | --- | --- | --- |
| F01 冻结合同 | 无 | 固定本计划默认、四命令、visibility、来源读取、错误和隐私矩阵；列出旧 title 展示切换。对将改变 exported signature 的函数用 LSP references（可用时）查全调用者，再编辑。 | Files：delivery.ts／queries.ts／domain/core.ts（仅复用类型，不扩 EntityKind／能力）；集成 owner 管 shared contract／OpenAPI 注册。不得用新能力扩大历史角色。 |
| F02 数据与升级 | F01 | 新迁移＋Drizzle 表、来源延迟约束／不可变保护、隐藏校验／索引、审计白名单；形成旧库审计／停写升级／前向恢复说明。 | Files 提供 SQL 设计与 schema.ts 改动；迁移编号由 owner 统一分配。不可改旧 migrations。 |
| F03 元数据命令 | F01、F02 | Rename/Hide/Restore 使用 ctx.update/emit，覆盖 idempotent state、CAS、可写项目和历史引用；新 Register 初始化字段，Add 拒绝隐藏。 | packages/application/src/delivery.ts；apps/api/src/app.ts 的 projectMetadataWrites 为共享修改；kernel.ts原则不增旁路。 |
| F04 独立复制 | F01、F02 | 实现选定版 read→verify→put→read验证、新 upload 发布、来源、目标事件、源零更新；明确 I/O 后复核及失败留下孤立对象。 | delivery.ts，来源查询模块可新建 `packages/application/src/artifact-copy-origins.ts`；不改 BlobStore 方法。S3 包所有 registry/buildApp 注入及 provider，本包只消费 BlobStore。 |
| F05 授权读与合同 | F02、F03、F04 | SQL visibility 分页／游标绑定、历史 direct read、双侧 origin 路由；具体 DTO schema、错误及生成客户端同步，检查目标受众零源ID。 | queries.ts；apps/api/src/app.ts；packages/contracts/src/openapi.ts、client.ts；docs/contracts/openapi.yaml；来源 DTO 可新建 `packages/contracts/src/artifact-files.ts`。由 owner 串行生成合同一次。 |
| F06 前端数据基座 | F01、F05 | visibility 贯穿分页／cache key／hook；按ID读取隐藏深链；上传目标冻结 Artifact基线，不能被SSE自动换新；回收origin缓存。 | apps/web/src/features/pm/service/pm-data.ts、pm-service.tsx、project-files/model.ts、index.tsx；既有 pm-command-store.ts 仅复用，非必要不改恢复内核。 |
| F07 真实操作表面 | F03–F06 | 可见／隐藏／全部、改名／隐藏确认／恢复、精确版本复制目标选择、冲突草稿、pending/unknown／禁用态；主标题与原filename分开；原ID恢复深链可用。 | project-files/index.tsx、FilePreviewDialog.tsx、UploadDialog.tsx、model.ts、project-files.module.css；可在同目录拆独立操作Dialog，复用现有Dialog/Button/useText。 |
| F08 集成故障验收 | F02–F07 | 编写真PG/HTTP/blob/浏览器用例及受控crash／丢响应；逐条执行第10节。只用新schema、临时目录、自有端口／进程，保存无秘密证据。 | tests/backend.integration.test.ts、tests/project-audit.integration.test.ts；可新建 `tests/artifact-files.integration.test.ts`、`tests/artifact-files-model.test.ts`；现有测试公共夹具按已有风格复用。集成owner最终执行，不并行跑检查。 |
| F09 运维及文档 | F08 | 写入非原子边界、unknown核对、备份／迁移／恢复；更新旧Files文档当前能力，保留历史记录；无孤立GC承诺。 | README.md、deploy/README.md、docs/implementation/project-files-replication-plan.zh.md、backend-delivery.md、service-completion-and-acceptance.zh.md 为共享文档，归owner整合；实施时本计划追加真实证据。 |
| F10 上线门禁 | F08、F09 | owner 统一检查后，隔离真实路径／恢复演练全部通过才开放动作；清理仅本次测试schema／目录／进程，保留证据。 | owner发布／检查文件；Files不启动常驻服务、不代替用户决策、不声明S3／公网／GC已就绪。 |

可并行边界：F01 后元数据命令与复制的局部实现可设计分拆，但 delivery.ts 只能一个合并责任人；F02 schema／迁移必须先冻结，F05 才能定生成合同。F06/F07 可对冻结 DTO 开发，不以 mock 成功宣称交付。S3 和 Files 可独立实现，但合并后必须用**注入的 BlobStore**走同一实际复制路径；无需等S3真实环境才完成本地验收，S3上线有自己的外部门禁。

## 10. 真实验收矩阵（全部待执行）

### 10.1 隔离资源与可复现输入

集成 owner 复用现有 backend 测试模式：唯一随机 PostgreSQL schema、两个 workspace W1/W2、临时 Markdown/blob 根目录、API 随机端口、自有 Web／故障代理和 Worker。预建 W1 项目 A、B 与 W2 项目 C；创建有两侧权限的 writer、仅 B 范围成员、仅 A 范围成员、只有 domain.read 的 reader、无 delivery.write 的成员。能力列表按当前workspace级实现配置，不伪造逐项目能力模型。

通过**真实HTTP**执行：A 中上传 first.txt 字节X并 RegisterArtifact，再追加 second.txt 字节Y（X≠Y），记录版本V1/V2、Artifact AV、upload消费指针、SHA/size；RecordEvidence 同时引用两版并形成真实Submission／Review历史，另设图片版本为项目封面。所有命令ID及expectedVersions保存在无秘密证据JSON。浏览器使用这些真实资源，丢响应只在真实提交后截断网络，不拦截伪造成功JSON。

下面的命令输入字段均依据第5节；可由生成客户端或真实HTTP请求提交，查询用现有 `/entities/:id`、`/commands/:commandId`、`/artifact-versions/:id/content` 与拟新增的 visibility／copy-origin 路由。DB 使用测试专用连接查询 entities／command_receipts／outbox／project_audit／artifact_copy_origins，并核对临时存储文件实际字节。

### 10.2 场景与判据

| 编号／步骤 | 操作 | 必须观察的HTTP／浏览器／SQL／storage结果 |
| --- | --- | --- |
| FA-01 / F03,F07 | RenameArtifact(AV,{title:'交付显示名'})，分别下载V1/V2，刷新两种项目详情与网格／列表 | 主标题、搜索／排序用新title；原filename分别first.txt/second.txt，下载Content-Disposition仍原名，X/Y/SHA/size不变；Artifact v+1，一次审计／事件，版本／Evidence／Submission／Review／封面内容及ID不变。 |
| FA-02 / F03,F06 | 两个会话同AV版本改名；另一会话同时追加版本／隐藏 | 最多一个基于该版本的写入成功，另一409；本地改名／上传意图仍在，SSE未重写基线。明确合基线后新命令才成功。 |
| FA-03 / F03,F05,F07 | 隐藏AV；用visible/hidden/all分页，打开历史Evidence及V1深链 | 默认和上传目标无AV，无“孤立版本”复活；hidden/all有原AV且标隐藏；已授权历史下载仍X/Y，封面／审核引用未清除；显示“隐藏不是撤销下载”。 |
| FA-04 / F03,F07 | 从隐藏列表恢复；再用已可见同当前版本恢复一次；用过旧版本恢复 | 第一次原ID／原版本链恢复，元数据v+1；第二次无实体写／无重复事件但有committed收据；旧版本仍409。无新artifact/version/upload/objectKey。 |
| FA-05 / F03,F07 | reader读隐藏；无写权限改名／隐藏／恢复；项目归档后恢复／追加 | reader有历史读，无写菜单；直接写403，越项目404；归档／关闭目标写拒绝，无业务事件。源历史读不因源只读／归档被偷加delivery.write前置。 |
| FA-06 / F04 | 选V1复制至A，再选V1复制至B，同时源最新仍V2 | 新Artifact／version／upload／key各自不同；目标均X的SHA/size/MIME/原filename，绝不是Y；producer为复制者，sourceRunId=null，versionRefs仅新首版本，来源精确指V1；原AV/V1/V2／Evidence／Review零变化。 |
| FA-07 / F04,F05 | 仅B成员读目标Entity/列表/upload/audit/changes/预览/origin；两侧成员再读origin；撤掉其A权限重读 | B可下载新X；所有普通响应零源项目／Artifact／版本ID，origin无源权限为null；两侧权限才返回来源。撤权后链接／缓存消失且origin=null；收据仍要求原actor和两侧当前读权，不能从目标绕过。 |
| FA-08 / F04 | 仅A范围无B权限复制至B、仅B范围指定A版本、引用W2版本、目标项目与payload不符 | 403/404或明确scope校验拒绝，不泄露不可见资源；零目标对象／业务行／成功事件。源读和目标写都由服务端检查，不依赖项目下拉框。 |
| FA-09 / F04,F06 | 打开复制表单后源改名／追加／隐藏，或目标项目version改变／归档；随后发送冻结请求 | 源Artifact／源版本／目标项目缺失或旧CAS均409，绝不自动改选最新或换基线；目标生命周期当前复核失败。隐藏源重新确认当前基线后仍可复制历史。 |
| FA-10 / F03,F04 | 同commandId同参数并发请求／已提交后再次投递；同键改title/目标/版本基线 | 同参数相同原结果／ID，无重复业务对象、put及outbox；异参409 idempotency_conflict。确定拒绝同键返回原拒绝，不在修复后偷偷成功。 |
| FA-11 / F07,F08 | 改名／隐藏／恢复／复制分别在真实COMMIT后截断响应，刷新后核对原ID | IndexedDB journal与局部意图保留；原收据恢复同一对象／状态；每个原请求只实际转发一次，无新commandId，无重复put。退出／换账号不向其他actor显示私有源信息，原actor恢复依据仍在。 |
| FA-12 / F04,F08 | 临时源blob篡改／缺失；put拒绝；新key读失败；I/O返回后撤权 | 正确blob错误／权限拒绝，不发布空内容或引用源key；零目标SQL行／成功outbox；可能孤立新对象被保留，失败收据如实记录。移除受控故障后先核对再显式新动作。 |
| FA-13 / F04,F08 | 注入put成功后、SQL插入后、COMMIT前的受控进程退出／DB断开；另做COMMIT后崩溃 | 未提交组仅孤立blob、无半套目标／来源／收据／outbox；已提交组全部存在。无收据unknown按第7节运维核对流程终结，不将404当失败。重启不自动copy。 |
| FA-14 / F03,F06 | StageUpload提交后截断；确认后显式继续登记；Add在Stage期间遇到AV变化或被隐藏；租约过期 | 原暂存恢复不再put；登记携带实际upload CAS与冻结AV CAS；冲突保留暂存，隐藏目标拒绝；确认收据前不重新上传。过期按真实upload_expired，不延租／复用已消费upload。 |
| FA-15 / F02,F05 | 超过一页的可见／隐藏数据；切换visibility复用游标，旧无visibility游标；查询中隐藏／恢复并SSE刷新 | 每模式完整分页，无客户端截页过滤；错模式／旧游标400并可重读；SSE后各缓存收敛。深链按ID读隐藏版本，默认列表不能成为历史访问唯一来源。 |
| FA-16 / F02,F08 | 直接SQL尝试改／删版本、Evidence、Review、来源；来源跨workspace／错误kind／错误project／目标key=源key | PostgreSQL约束拒绝，原immutability保护仍在；新来源表保护可在pg_restore后重现。目标upload消费／版本唯一约束不被复制旁路绕过。 |
| FA-17 / F02,F09 | 旧schema数据先有title≠filename／缺隐藏字段；升级，再恢复备份至新库／新卷 | title保留且成为显示名，原filename可见；旧artifact version按迁移规则递增，历史版本对象和原收据原文不变；孤立／损坏数据阻止切换并报ID。恢复后原ID／隐藏态／来源／引用字节SHA和约束一致。 |
| FA-18 / F07 | 中文／长显示名、重复名、主动扩展名；键盘弹窗、暗色、390px、读失败／离线 | 标签安全转义、不改变MIME／安全预览类型；重复名不覆盖；原文件名仍可识别，焦点／Esc／触控入口可用。真实错误和unknown有可见状态，无fake成功，无页面级横向溢出；390px仅浏览器仿真。 |

## 11. 统一检查、上线门禁与本次交接

### 11.1 由集成 owner 后续执行的检查

本规划阶段不运行任何检查。业务实施合并后由 owner 一次统一执行：合同生成与 `pnpm contracts:check`、`pnpm check:docs`、后端 `pnpm check`、真实数据库 `pnpm test:backend`、`pnpm check:web`，以及第10节隔离HTTP／浏览器／DB／存储／备份恢复。沿用项目脚本真实配置，不由本包读取 `.env`、access.json 或账号凭据；数据库未配置而skip不算通过。导出签名更改先用可用LSP references覆盖调用者，再由owner检查，不让各并行包分别生成合同／跑检查。

门禁：新迁移从空库和升级库均可完成；历史字节／不可变SQL约束保持；真实上传／复制非原子故障和原ID恢复已演练；目标读者零源ID泄露；来源／隐藏与备份一致；UI没有虚假菜单或自动重试unknown；运维能区分孤立对象与已提交引用。任一缺失只标对应门禁未通过，不借用既有584项历史回归或Files旧预览证据。

### 11.2 需要父线程统一分配的共享文件及接口

- `packages/application/src/delivery.ts`：本包主体；metadata命令、复制、现有上传适配必须一个编辑责任人整合。
- `packages/application/src/queries.ts`／`kernel.ts`：前者新增visibility；后者保持原receipt／CAS／scope实现，原则不改通用unknown或弱化收据可读性。
- `packages/infrastructure/src/schema.ts`、新编号migration及审计白名单：Files提供内容，owner决定编号并检查restore兼容。
- `packages/application/src/registry.ts`、`apps/api/src/app.ts`：registry的LocalBlobStore→BlobStore抽象注入归S3包；Files注册的projectMetadataWrites、visibility和origin路由由owner合并，不能各建一套BlobStore实例。
- `packages/contracts/src/openapi.ts`、`client.ts`、`docs/contracts/openapi.yaml`、生成脚本入口：Files接口与其他包同批生成一次；StageUpload／content路径与二进制下载行为不变。
- `apps/web/src/features/pm/service/pm-data.ts`、`pm-service.tsx`：visibility查询／缓存签名由Files设计、owner整合其他包改动；project-files目录是Files局部UI实现责任。
- README、deploy运行手册、旧Files文档、backend-delivery、service-completion-and-acceptance：owner更新索引／实际能力／检查记录，本规划未改这些共享文档。

对S3交接：只依赖 init/check/put/read，put必须返回新的独立key；不存在copy/delete/listKey接口诉求，不需要S3专用copy job。unknown的原commandId是SQL恢复身份，不要求provider反查丢失key。对通知／Webhook交接：文件安全事件仅本项目目标身份；不得转发来源表／原收据，published_at不是投递成功，Files本包无消费者循环。

### 11.3 本次证据与未解决前提

本包已阅读仓库规则、当前ADR、领域 INV／SC／INF、交付文档和完整批准合同，并实现第12节列出的业务路径与可运行回归用例。未读取凭据、操作服务或执行检查；因此第10节运行结果仍须由集成 owner 以真实隔离资源记录。

本地BlobStore实施不依赖新增供应商。第3.2节超出批准默认的产品政策、实际上线维护窗口、生产存储/加密及备份保留目标仍须输入；这些门禁不改变第13节已经完成的隔离运行证据。

## 12. 实现代理首轮交接（最终集成结果见第13节）

| 步骤 | 已交付实现 | 尚待集成 owner 运行 |
| --- | --- | --- |
| F01 | 四命令严格payload、title唯一显示名、visibility、私有origin DTO；无新增EntityKind／能力；工具未提供LSP，已以仓库搜索枚举受影响调用者 | 生成合同与共享客户端／API接线检查 |
| F02 | 0025迁移：旧Artifact／version／upload前置审计、有效title保留／缺失修复、v+1隐藏字段切换、父状态分页索引、不可变来源及延迟复合FK、隐藏审计白名单；独立artifact-files-schema.ts完整Drizzle镜像；files-lifecycle-migration.test.ts从实际0024验证升级和错误latest门禁 | 空库／旧库升级、损坏门禁、真实pg_restore与完整检查点恢复 |
| F03 | delivery.ts的Rename／Hide／Restore；CAS先于幂等目标状态判断；相同title／状态无重复实体写和事件；新登记初始化字段、Add拒绝隐藏 | FA-01–05、并发及历史Evidence／Submission／Review／封面回归 |
| F04 | 选定不可变版本真实read→verify→put→read；新upload消费和目标首版本；I/O后fresh core rescan＋目标CAS／生命周期／当前权限；来源仅内部表，安全目标outbox | FA-06–14、受控崩溃／未知COMMIT及孤立对象保留证据 |
| F05 | queries.ts在授权／LIMIT前过滤Artifact及父状态版本；游标绑定visibility；direct GET／content保持历史访问；origin双侧当前权限、source不可用时null、private,no-store | 多页授权、来源隐私、双scope原收据、撤权／恢复测试 |
| F06 | pm-data／pm-service完整分页与缓存visibility；Files按ID历史深链读取；上传选择时固定Artifact基线；保留实际upload CAS及暂存；历史任务证据／封面查询显式all | SSE三模式缓存、actor／membership切换及历史深链浏览器检查 |
| F07 | 正式Files可见／隐藏／全部、改名／隐藏确认／恢复／精确所选版本复制；当前可写目标项目、分发提示、保留冲突输入及显式采用基线；原请求恢复记录不保存字节、不重放unknown；预览title与原filename／SHA分开 | FA-11／14／18：真实浏览器、存储失败、中文长名、390px、键盘与深色 |
| F08 | 新tests/artifact-files.integration.test.ts真实PG／HTTP／blob／socket截断场景；tests/artifact-files-model.test.ts及delivery.test.ts增加领域／真实本地对象故障回归 | 下列命令和第10节矩阵；未执行不得填写“通过” |
| F09–F10 | 已向集成owner交付非原子边界、unknown终结约束、共享schema／registry／kernel／API／client／OpenAPI／运行手册接线合同；§3.2未决产品政策未擅自扩大 | 统一检查、隔离浏览器／备份恢复、运维演练、实际上线窗口与生产配置 |

可直接运行的专项命令（仅指令，不是已通过的证据）：

```bash
node --test packages/application/tests/delivery.test.ts tests/artifact-files-model.test.ts
TEST_DATABASE_URL=<隔离测试数据库连接> CHOKIDAR_USEPOLLING=true node --test tests/artifact-files.integration.test.ts packages/infrastructure/tests/files-lifecycle-migration.test.ts
```

集成测试自行创建随机schema、自有HTTP端口、真实Markdown／blob临时根目录，仅清理自身资源；数据库变量缺失会skip，不能算通过。测试包含延迟来源约束成功、约束拒绝时成功收据随savepoint回滚而只保存rejected、真实上游COMMIT后下游socket截断及原收据恢复，不拦截伪造业务成功JSON。服务进程crash／新卷恢复与完整浏览器矩阵仍由owner使用第10节真实资源补齐，不能由本包静态阅读代替。

未知结果运维程序仍严格适用第7节：原收据403／404不证明失败；先证明原请求／进程／数据库事务不会迟到，在同一workspace锁内只读核对原actor／commandId与来源／审计；不能证明时保持unknown，不造收据，不重放handler，不补偿删除blob。没有物理GC、跨workspace复制或访问撤销能力声明。


## 13. 集成后的实际证据

- 真实 PostgreSQL/HTTP/文件回归已运行，包含延迟来源 FK、约束拒绝时成功收据随 savepoint 回滚、丢响应原 commandId 恢复及双侧授权；不取消 CHECK 或重放未知写入。
- 正式浏览器在真实私有 MinIO 上修改显示名、隐藏/恢复同一成果，再明确选择旧 v1 复制到另一项目。新 artifact/version/upload/objectKey 独立，下载200且为原 v1 的31字节；原历史 filename/来源版本保留，未把最新 v2 复制错。
- 0025 populated migration 的延迟触发器阻塞 DDL 已复现并通过排空指定约束修复，随后恢复原延迟规则。实际 provider 备份含三份版本对象，新库/新核心根/新 Local 身份恢复后经授权 API 全部校验原字节。
- 构建/合同/统一检查与清理见[第九节](service-completion-and-acceptance.zh.md#five-package-delivery)。有界隔离证据不代表全部物理设备、生产供应商或 GC 已验收。
