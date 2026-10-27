# 命令、领域事件与错误语义

本文件是 [v0.1 提案](README.md) 的语义契约，不是已发布 API。HTTP 路径、序列化 schema、字段长度和分页约定由后续契约文档补充。

## 1. 通用信封

| 命令字段 | 约束 |
| --- | --- |
| commandId | 客户端生成的稳定去重键；本版不再另设含义相同的 idempotencyKey |
| commandType、schemaVersion | 精确命令名及结构版本 |
| actor | 从受信认证上下文派生 principalId、principalType；Agent 另带 onBehalfOf 与 grantId，不能信任任意请求体自报身份 |
| workspaceId、projectId? | 操作作用域；与目标对象和权限交叉验证 |
| targetId?、expectedVersions | 修改现有聚合时提供版本；多聚合命令携带有关对象的预期版本或使用受控事务校验 |
| payload | 业务参数，形成规范化请求摘要；排除传输时间等易变元数据 |
| correlationId、causationId? | 连接业务流程和直接触发原因，不用于去重 |

事件具有 `eventId、eventType、schemaVersion、workspaceId、projectId?、aggregateType、aggregateId、aggregateVersion、eventSequence、occurredAt、actorRef、correlationId、causationId、payload`。时间以统一时区表示，业务排序以版本/序号为准，不以客户端时钟为准。

示例（示意 JSON，标识符不表示已存在对象）：

```json
{
  "eventId": "evt-123",
  "eventType": "WorkItemCompleted",
  "schemaVersion": 1,
  "workspaceId": "ws-1",
  "projectId": "project-1",
  "aggregateType": "WorkItem",
  "aggregateId": "wi-1",
  "aggregateVersion": 12,
  "eventSequence": 15,
  "occurredAt": "2026-10-16T08:00:00Z",
  "actorRef": { "principalId": "user-1", "principalType": "human" },
  "correlationId": "flow-1",
  "causationId": "cmd-complete-1",
  "payload": {
    "contentRevision": 3,
    "submissionId": "submission-2",
    "reviewId": "review-2"
  }
}
```

事件只携带传播所需信息和稳定引用，不广播完整提示词、凭据或敏感成果内容；订阅方同样受 Workspace/Project 授权约束。

## 2. 命令与事件目录

表中斜线表示各自独立命令或对应事件，不是一个可任意赋值的万能状态接口。所有状态守卫以 [workflows.md](workflows.md) 为准。

| 所属上下文 | 命令 | 主要参数 | 提交后事件 |
| --- | --- | --- | --- |
| 意图 | CreateConversation / AppendMessage | 标题/消息及作者来源 | ConversationCreated / MessageAppended |
| 意图 | ProposeIntent / ReviseIntent | 目标、来源、revision | IntentProposed / IntentRevised |
| 意图 | AcceptIntent / RejectIntent | intentId、revision、理由 | IntentAccepted / IntentRejected；同时 DecisionRecorded |
| 意图 | WithdrawIntent | intentId、理由 | IntentWithdrawn |
| 意图 | RecordDecision | subjectRef、理由、依据、supersedesDecisionId? | DecisionRecorded；不能用此命令绕过 AcceptIntent 状态检查 |
| 规划 | CreateProject / ActivateProject | 项目目标/完成标准 | ProjectCreated / ProjectActivated |
| 规划 | CompleteProject / CancelProject / ReopenProject | 标准检查记录/原因 | ProjectCompleted / ProjectCancelled / ProjectReopened |
| 规划 | CreateWorkItem | projectId、标题、范围、标准 | WorkItemCreated |
| 规划 | CreateWorkItemFromIntent | AcceptedIntentRef、初始工作范围 | WorkItemCreated（含 originIntentRef）；唯一映射与创建同事务 |
| 规划 | UpdateWorkItemContent | 范围、标准、expectedVersions | WorkItemContentChanged（含新 contentRevision、结果状态、失效提交引用） |
| 规划 | UpdateWorkItemMetadata / SetWorkItemBlockers | 允许的元数据/阻塞原因 | WorkItemMetadataChanged / WorkItemBlockersChanged |
| 规划 | ReadyWorkItem / StartWorkItem | workItemId、版本 | WorkItemReadied / WorkItemStarted |
| 规划 | AddDependency / RemoveDependency | dependentId、prerequisiteId、图版本 | DependencyAdded / DependencyRemoved |
| 规划 | CreateMilestone / AssignMilestone / UnassignMilestone | projectId、标准/工作项及 milestoneId；解除时引用原 milestoneId | MilestoneCreated / WorkItemMilestoneChanged（解除时结果为 null） |
| 规划 | AchieveMilestone / CancelMilestone / ReopenMilestone | 标准依据/原因 | MilestoneAchieved / MilestoneCancelled / MilestoneReopened |
| 规划 + 交付协调 | SubmitWorkItemResult | workItemId、contentRevision、成果版本及证据引用 | Delivery：SubmissionCreated；Planning：WorkItemSubmitted |
| 规划 | ReturnWorkItemForChanges | workItemId、原因、reviewId? | WorkItemReturnedForChanges |
| 规划 | CompleteWorkItem | workItemId、submissionId、reviewId | WorkItemCompleted |
| 规划 | CancelWorkItem / ReopenWorkItem | workItemId、原因 | WorkItemCancelled / WorkItemReopened |
| 规划 | ArchiveObject / RestoreArchivedObject | Project/WorkItem 的类型、ID、原因 | ProjectArchived/WorkItemArchived 或 ProjectRestored/WorkItemRestored |
| 执行 | CreateSession / CloseSession | projectId、上下文/关闭原因 | SessionCreated / SessionClosed |
| 执行 | CreateRun / RetryRun | sessionId、workItemId?、输入版本、授权；重试另带 retryOfRunId | RunQueued（重试包含原 Run 引用） |
| 执行 | StartRun | runId、当前 executorEpoch | RunStarted |
| 执行 | RequestApproval | runId、operationId、动作/资源/参数摘要、有效期 | ApprovalRequested；RunApprovalWaitStarted |
| 执行 | GrantApproval / DenyApproval / RevokeApproval / ExpireApproval | approvalId、决定者/系统时钟、理由 | ApprovalGranted / ApprovalDenied / ApprovalRevoked / ApprovalExpired |
| 执行 | ResolveApprovalWait | runId、approvalId、后续路径 | RunApprovalWaitResolved |
| 执行 | DispatchApprovedOperation / DispatchOperation | operationId、payloadDigest、授权依据/approvalId | OperationPrepared；审批路径同时 ApprovalConsumed |
| 执行 | RecordOperationDispatch / RecordOperationOutcome | operationId、providerRef、当前执行者凭据、证据 | OperationDispatched / OperationOutcomeRecorded |
| 执行 | RequestRunCancellation | runId、原因 | RunCancellationRequested |
| 执行 | RecordRunOutcome | runId、结果、证据、executorEpoch | RunSucceeded / RunFailed / RunCancelled |
| 执行 | RecordOperationUnknown / RecordRunUncertainty | 操作或 Run 引用、最后已知状态、原因 | OperationOutcomeUnknown / RunOutcomeUnknown；操作未知时同事务进入 Run 未知状态 |
| 执行 | ReconcileOperation / ReconcileRun | 原标识、查询凭据、核对证据 | OperationReconciled / RunReconciled（含确认后的状态） |
| 交付 | RegisterArtifact / AddArtifactVersion | 类型、不可变内容/定位符、摘要、来源 | ArtifactRegistered + ArtifactVersionAdded / ArtifactVersionAdded |
| 交付 | RecordEvidence | subjectRefs、方法、范围、观察结果 | EvidenceRecorded |
| 交付 | RecordReview | submissionId、逐条标准结论、verdict、理由 | ReviewPassed / ReviewChangesRequested |

首次 RegisterArtifact 必须同时创建首个 ArtifactVersion。命令涉及多个聚合时，每个事件使用其实际所属聚合的 ID 和新版本；不能把跨模块变化伪装成单个聚合版本。

## 3. 事件的后续作用

| 事件 | 允许的消费行为 | 禁止推导 |
| --- | --- | --- |
| IntentAccepted | 展示可创建工作项的候选，等待显式创建命令 | 自动认为外部执行已获授权 |
| WorkItemCreated | 更新列表、发出已授权的内部通知 | 自动启动 Agent |
| RunSucceeded / RunFailed / RunReconciled | 更新运行视图、提示可提交/可重试 | 直接写入 WorkItem done/cancelled |
| ApprovalGranted | 唤醒执行器并重新校验派发条件 | 事件到达即执行任意当前参数 |
| ReviewPassed | 展示可完成提示，供 CompleteWorkItem 校验 | 绕过内容版本和权限自动关闭任务 |
| WorkItemCompleted | 更新进度及依赖读模型 | 自动完成 Project/Milestone |

## 4. 幂等、并发与恢复

命令去重作用域为 `(workspaceId, principalId, commandId)`，摘要包含命令类型、目标、业务参数和预期版本。同键同摘要返回既有结果；同键不同摘要返回 `idempotency_conflict`。先检查身份及读取原结果权限，再查去重记录；重放已提交命令不因原 expectedVersion 过期而再次执行。

创建命令还需业务唯一键，例如 Intent 转化键，避免客户端换 commandId 导致重复创建。请求被明确拒绝时返回拒绝结果；修改参数或版本后是新意图，应使用新 commandId。传输层未确认请求是否已提交时先查询原 commandId。

本地状态、命令结果、待发布事件原子提交。事件按 `(consumerId, eventId)` 去重，去重记录与本地消费效果同事务提交；涉及外部效果的消费者仍使用 operationId，不宣称端到端 exactly-once。

aggregateVersion 相同的一次提交可能产生多个事件；另提供聚合内 `eventSequence` 连续序号以支持严格排序。使用增量投影的消费者发现序号缺口时补读或从权威快照重建，不能用旧事件覆盖新状态；不需要全序的消费者仍按 eventId 去重。

执行回报携带 `executorEpoch` 和来源序号。执行服务分配并校验当前 epoch，旧执行者不能推进权威状态；其迟到材料可留为核对证据。更新 epoch 不证明旧执行已停止，迁移执行者必须先核对旧动作。operationId 与命令/事件 ID 分离，即使重启、换执行者或重试也不能丢失副作用身份。

去重记录保留期限、事件保留期限和业务对象寿命必须在实施前明确；不得因缓存过期就允许旧非幂等操作重放。持久化事件失败不会自动回滚已经发生的外部动作，需要凭据核对和恢复。

## 5. 领域错误与结果

| 错误码 | 含义 | 调用方处理 |
| --- | --- | --- |
| validation_failed | 缺少标准、来源或非法字段 | 修正输入后用新命令 |
| not_found_or_forbidden | 对象不存在或不可见 | 不泄露对象存在性 |
| permission_denied | 可见对象上的动作未获授权 | 获取合法授权，不盲重试 |
| scope_mismatch | 可见引用的 Workspace/Project 不一致 | 修正引用；不可见引用使用上一类不泄露错误 |
| version_conflict | 并发版本已变化 | 读取新状态并重新决定，不静默覆盖 |
| invalid_transition | 当前状态不允许命令 | 按状态机处理 |
| idempotency_conflict | 同去重键对应不同请求 | 查原命令；新的业务意图用新键 |
| dependency_cycle / dependency_unsatisfied | 依赖成环/未满足 | 修正规划，不绕过图校验 |
| blocked / active_run_exists | 手工阻塞/仍有运行 | 解除阻塞或确认运行结束 |
| approval_required / approval_invalid | 缺少审批或审批范围/期限不匹配 | 申请当前动作的审批 |
| review_required / review_stale / review_already_recorded | 无通过审核、版本过期或提交已有结论 | 读取当前提交，按流程重新提交审核 |
| outcome_unknown | 外部副作用无法确定 | 返回 operationId/runId 与查询方式，先核对 |
| resource_archived / project_not_active | 对象归档或项目不允许当前动作 | 显式恢复/重开/激活后再决定 |
| temporarily_unavailable | 尚未派发外部动作的基础设施暂不可用 | 查询命令状态后按同键重试；已派发且不明必须返回 outcome_unknown |

最终 API 需要区分 `committed`（本地业务事实已提交）、`accepted`（仅入队，附查询标识）、`rejected`（未接受该业务改变）、`outcome_unknown`（外部结果待核对）。HTTP 成功响应、消息写入或队列入队均不能被产品界面描述为工作项已完成。
