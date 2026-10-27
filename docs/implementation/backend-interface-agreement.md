# 第一阶段并行实现接口约定

本轮按用户要求由 gpt-6.1-sol / xhigh 子代理协作，主代理集成和实测。仅推进第一阶段后端，前端和真实执行继续关闭。

## 冻结边界

- 所有运行代码使用 Node 24 可擦除 TypeScript，跨模块显式相对 `.ts` 导入；根 tsconfig 统一编译到 dist，禁止参数属性/enum。根代理统一维护 package.json、安装和入口脚本。
- 领域公共类型：`packages/domain/src/core.ts`；应用接口：`packages/application/src/ports.ts`。共同改变须先通知主代理。
- PostgreSQL 16，专用数据库与独立容器/卷，不能操作宿主已有数据库。应用以规范化 aggregate 元数据 + JSONB 内容存储首版聚合；数据库仍有作用域、类型、版本、唯一引用等约束。该持久化选择记录 ADR，不将 JSONB 当免校验的任意存储。
- 所有命令以 workspace 为粒度使用同一事务级 advisory lock，先校验当前成员权限；业务效果、收据与 outbox 同一事务。牺牲同工作区写入并行度换取首版跨聚合一致性，后续优化不能移除不变量。
- Entity 字段：id/workspaceId/projectId/kind/version/data/createdAt/updatedAt/createdBy。status、contentRevision、archivedAt、currentSubmissionId 等在 data 中。所有 id 为 UUID。
- Command 信封：commandId、commandType、targetId?、projectId?、expectedVersions?、payload。actor 来自会话；workspaceId 来自路由。变更已有对象必须 ctx.checkVersion(entity)，每个被变更对象均检查。创建的子对象不要求新 id 的预期版本。
- 每个模块导出 `...Commands: CommandRegistry`，每个定义包含 Zod 严格 payload schema 与 handler；内核负责解析、拒绝收据、去重。OpenAPI 从这些 schema 生成。
- ctx.get/list 始终限定 workspace；handler 再验证 project 和能力。ctx.insert/update 返回 Entity；ctx.emit 写持久 outbox。handler 不自行 commit、不直写 HTTP 响应。
- capabilities 使用显式字符串数组；成员可限制 projectIds（null 表示全工作区）。workspace 管理能力不隐含业务审核/完成权限。CLI 初始管理员明确授予全部首版能力。
- 第一阶段从未启用 Execution，真实命令拒绝 capability_not_enabled；不得创建假 Run。将来停用执行开关不能绕过已有运行占位。

## 文件所有权

| 实现者 | 范围 |
| --- | --- |
| foundation 子代理 | infrastructure database/migrations/schema/auth、application kernel/queries/access、基础设施测试；不改根 package/入口 |
| planning 子代理 | application planning/intent handlers，domain planning helpers，模块测试 |
| delivery 子代理 | infrastructure blobs、application delivery handlers/下载函数，模块测试 |
| 主代理 | 依赖/配置、API/Worker、SSE、契约生成、运行脚本、全链路测试、部署、文档、集成修复 |

## 基础设施导出约定

- `infrastructure/src/database.ts`：createPool(databaseUrl)、migrate(pool)、checkDatabase(pool)。采用 pg Pool，并以 Drizzle schema/迁移记录存储定义。
- `infrastructure/src/auth.ts`：createUser(pool,{email,password,name})、createWorkspace(pool,ownerId,name)、login(pool,{email,password}) → {token,actor,expiresAt}、authenticate(pool,token) → Actor、logout(pool,token)。令牌仅存摘要；密码使用 Node crypto.scrypt，cookie 由 API 维护。无公开注册/自动默认账号。
- `application/src/kernel.ts`：runCommand(pool,actor,workspaceId,command,registry) → CommandReceipt；getCommandReceipt(pool,actor,workspaceId,commandId)。同键同请求复用结果，拒绝也保留；无权读取原结果时拒绝。
- `application/src/queries.ts`：listWorkspaces(pool,actor)；listEntities(pool,actor,workspaceId,{kind,projectId?,limit?,after?}) → {items,nextCursor,cursor}；readEntity(pool,actor,workspaceId,id) → Entity。
- `application/src/access.ts`：requireCapability(sql,actor,workspaceId,capability,projectId?)；导出 accessCommands（成员能力更新/撤销）。明确 projectIds 对 workspace 级命令和查询的作用。
- outbox 表至少 id(bigserial)、event_id(uuid)、workspace_id、project_id、aggregate_id、aggregate_kind、aggregate_version、aggregate_sequence、event_type、payload、actor_id、created_at、published_at、attempts、last_error。events 表 workspace_id/cursor/event_id/envelope，主键(workspace_id,cursor)、event_id唯一；workspaces 有 stream_cursor bigint。Worker 在 workspace 同锁事务中把未发布 outbox 按 id 复制进 events 并更新游标和已发布标记，重复恢复不产生副作用。
- sessions 表 hashed token/expiry/user，memberships 表 workspace/user/capabilities/project_ids/version。actor 管理写操作必须和普通命令共用 workspace 锁。
- entities 表 id/workspace_id/project_id/kind/version/data/created_at/updated_at/created_by；kind 与引用校验、不可变实体与业务唯一键由约束及事务共同保证。

## 规划/交付约定

- WorkItem data：title、description、acceptanceCriteria:[{id,text}]、contentRevision、status、assigneeId|null、milestoneId|null、manualBlockReasons:[]、prerequisiteIds:[]、currentSubmissionId|null、completionRecord|null、completionHistory:[]、archivedAt|null。
- Project data：name、goal、ownerId、completionCriteria:string[]、status、archivedAt|null。Milestone data：title、criteria:string[]、targetDate|null、status。
- Planning 的 CompleteWorkItem 从 ctx.get 读当前 submission/review，逐项匹配版本、依赖与阻塞；Delivery 在同一上下文执行 Submit/Review/Return，避免跨事务竞态。
- Submission data：workItemId、contentRevision、workScopeSnapshot、artifactVersionIds、evidenceIds；Review data：submissionId、workItemId、contentRevision、criterionResults:[{criterionId,result,basisRefs,explanation}]、verdict、reason、reviewerId。
- Delivery 导出 createDeliveryCommands(blobStore):CommandRegistry；BlobStore 构造 `new LocalBlobStore(root)`，异步 init()/check()/put(bytes)/read(key)；put 返回 {key,sha256,size}。不可变 key 由服务端生成，读写防路径逃逸。
- 上传通过 StageUpload 命令（contentBase64、mediaType、fileName；明确大小上限）持久化暂存内容与 upload 元数据。RegisterArtifact/AddArtifactVersion 引用 uploadId，并按 expectedVersions 原子消费；内容先落盘再登记，失败可留下待清理孤立内容，禁止删除已引用成果。
- 下载导出 downloadArtifactVersion(pool,actor,workspaceId,versionId,blobStore)，在当前权限检查后读取并核验摘要；返回 {bytes,sha256,mediaType,fileName}。
