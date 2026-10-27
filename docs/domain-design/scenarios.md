# 业务验收场景

以下是 [v0.1 领域规范](README.md) 的 Given / When / Then 验收规格。第一阶段已有真实 PostgreSQL、HTTP、存储、Worker 和 SSE 验证，实际覆盖层次见[后端实现记录](../implementation/backend-delivery.md)。真实 Agent 场景仍留待第三阶段，不能以 UI 截图或模拟回调替代执行验收。

## 核心链路

| 编号 | Given（前置条件） | When（操作） | Then（可观察结果） | 规则 |
| --- | --- | --- | --- | --- |
| SC-01 | 有一段 Conversation，未作规划决定 | 用户表达想法，Agent 提出 Intent | 消息和 proposed Intent 可查询；WorkItem/Run 数量均不变 | INV-02 |
| SC-02 | Intent 为 proposed；随后由有权人接受 revision 1 | 对 accepted 意图重复调用 CreateWorkItemFromIntent，包括同键重试和不同键重复创建 | 同一转化键最多一个 WorkItem；同键同参数返回原 ID，不同键返回既有映射或明确冲突；无重复 Run；若在接受前创建则拒绝 | INV-02、INV-14 |
| SC-03 | WorkItem in_progress，当前 Run 正在执行 | 受信执行器回报 succeeded 并登记成果 | Run succeeded，WorkItem 仍 in_progress；没有 WorkItemCompleted 事件；出现“可提交”提示不等于完成 | INV-03、INV-15 |
| SC-04 | 同一 Project 中一个 open Session，首次 Run 终结 | 再创建一个 Run；并对同一 Session 并发请求第三、第四个 Run | 各次 Run 有独立 ID、输入和结果；同一时刻至多一个非终结 Run；Session/Project ID 不变；不能改已创建 Run 的工作项绑定 | INV-05、INV-06 |
| SC-05 | WorkItem in_progress，有一次执行尝试 | Run 明确 failed 或 cancelled | 工作项保持 in_progress，失败/取消原因保留；重试生成新 Run，不覆盖旧结果 | INV-03 |
| SC-06 | WorkItem in_review，当前提交 S1 对应内容版本 2，所有标准已有通过依据，无阻塞及活跃 Run | 有权人 RecordReview(passed)，再显式 CompleteWorkItem | 审核后仍 in_review；完成命令后才 done，CompletionRecord 精确引用 S1 和 Review；缺标准结论或无通过审核时拒绝完成 | INV-04、INV-18 |
| SC-07 | S1/Review1 审核了内容版本 2、ArtifactVersion A1 | 修改范围至版本 3，或撤回并提交使用 A2 的 S2，再用 Review1 完成 | 旧 Review 不匹配当前提交而被拒绝；内容修改增加 contentRevision、退回 in_progress；A1/S1/Review1 原样保留；仅上传 A2 不暗改 S1 | INV-10、INV-11、INV-04 |

## 审批与执行恢复

| 编号 | Given | When | Then | 规则 |
| --- | --- | --- | --- | --- |
| SC-08 | Run 请求对资源 A 的动作审批，工作项尚未审核 | Agent 尝试自批；有权人随后批准，执行成功 | Agent 自批拒绝；人批准只允许所绑定动作；工作项仍需 Submission、Review 与 CompleteWorkItem | INV-07、INV-08 |
| SC-09 | 外部动作可能已经执行，响应在回传前丢失；或审批等待期间执行器失联 | 记录 unknown；调用方以新命令要求重试/直接宣布失败；随后按原标识核对 | 保留 operationId 和证据，Run outcome_unknown 且继续占位，重试被拒；只允许先查询核对，不能重复派发；若确认恢复时审批仍 pending 且无取消意图，则回到 waiting_approval | INV-09 |
| SC-10 | Run 正在外部执行 | RequestRunCancellation 后连接断开；随后核对确认仍执行或已停止 | 最初只记录 cancel_requested/unknown；未确认不能成为 cancelled 或释放 Session；确认停止且副作用已界定才 cancelled；若已完成则记录实际 succeeded/failed | INV-06、INV-09 |
| SC-15 | Approval 绑定操作 O1、参数摘要 H1、有限有效期 | 改为 H2、过期后派发、并发消费两次、撤销后派发；Run 已取消/未知/终结后收到迟到批准 | 所有不匹配路径拒绝；仅 running 且执行权有效时可派发新动作；两个有效消费最多一条 OperationReceipt 和一次授权消费；已消费后撤销不能声称动作被撤销 | INV-07 |

## 一致性与授权

| 编号 | Given | When | Then | 规则 |
| --- | --- | --- | --- | --- |
| SC-11 | 同项目 A 依赖 B，B 未完成 | 启动/完成 A；同时新增 B→A；另尝试跨项目依赖 | 前置未完成阻止启动/完成；反向边、跨项目边拒绝；并发形成环的两笔变更不能都成功；B cancelled 也不解锁 A | INV-12 |
| SC-12 | 两个编辑请求都读到 WorkItem version 5；看板仍显示旧状态 | 同时修改；另在工作项关闭与新建任务型 Run 之间制造竞态 | 普通修改只有一个成功，另一个 version_conflict；关闭与启动以共享一致性边界决定顺序，不能出现关闭已提交后仍接受基于旧状态的新 Run | INV-13、INV-20 |
| SC-13 | 某成功命令已提交但响应丢失；outbox 待投递 | 同键重试、同键改参数；重复投递同 eventId；乱序投递旧运行事件 | 重试返回既有结果，改参数报 idempotency_conflict；消费者只应用一次；旧事件不使终态回退；外部效果按 operationId 去重；不自动关闭工作项 | INV-14、INV-15 |
| SC-14 | 主体仅有项目 A 的执行/交付委托，没有审核和完成能力 | 引用项目 B 或另一 Workspace 的资源；提交 passed Review；CompleteWorkItem；伪造 actor 角色 | 范围越界及越权均拒绝，无成功事件；请求体不能覆盖认证身份；不向主体泄露不可见对象 | INV-01、INV-08 |
| SC-20 | 读模型滞后，显示授权有效或依赖已完成；执行者 epoch 已更新 | 旧授权创建 Run、按旧依赖完成；旧执行者发送终态回调 | 权威状态检查拒绝非法操作；旧 epoch 不更新状态，材料仅可供核对；变更 epoch 不触发原动作重放 | INV-20 |

## 人工交付与生命周期

| 编号 | Given | When | Then | 规则 |
| --- | --- | --- | --- | --- |
| SC-16 | 人直接创建并开始工作项，没有任何 Run | 人登记文本/文档成果，提交并审核、完成；之后重开修改标准 | 可以完成且 RunId 为空；历史 Submission 仍能恢复旧标准全文及审核依据；不能原地修改既有 Evidence/Decision/Review 来伪造通过 | INV-10、INV-16 |
| SC-17 | 项目工作项已全部 done，但项目自身标准尚未确认；或存在 unknown Run；另有 planned 里程碑含 cancelled 成员 | 请求 CompleteProject/ArchiveObject；对里程碑仅修改统计为 100%；尝试取消该里程碑 | 未满足条件时拒绝；百分比不触发完成；unknown 不视为已停止；先显式 UnassignMilestone 可解除终态成员且保留任务完成历史，再取消里程碑；确认全部条件后显式完成/归档成功 | INV-04、INV-17 |
| SC-18 | 同一 Submission 尚无 Review | 两位审核人并发提交相反终局结论；或审核与撤回/修改范围并发 | 最多一份结论提交，另一份收到冲突；若撤回/修改先提交，旧审核拒绝；若审核先提交，其记录保留，后续变更不沿用旧结论；要求改动时创建新 Submission 后重新审核 | INV-18 |
| SC-19 | WorkItem done，保留旧 CompletionRecord，Project active；或 draft 在标准未齐时被取消 | 直接修改终态范围/启动 Run 被拒后，显式 ReopenWorkItem，再重新规划与交付 | 进入 draft，经 ReadyWorkItem 重新检查后才能开始；旧历史保留，不能凭旧 Review 再次完成；若所属里程碑已达成，先重开里程碑；项目已关闭时先重开项目 | INV-19 |

## 实施验证要求

场景编号稳定保留，新增或改变业务语义时同步更新相关 `INV-*`、状态机和命令定义。自动化测试可按场景拆分，不要求每一场景只有一个测试函数。

- 聚合测试：状态守卫、标准逐项审核、版本失效、权限检查。
- 持久化集成测试：SC-02/04/11/12/13/15/18 的真实并发、唯一性、事务回滚与事件提交；仅用内存 mock 不能证明这些约束。
- 执行适配器测试：SC-09/10/20 的发送前后崩溃、回执丢失、旧执行者、未知结果及查询核对，使用可控制副作用的测试端点。
- 完整业务验收：SC-01 至 SC-06 的 Agent 交付链路及 SC-16 的人工链路；另行记录人工确认结果。执行器成功、测试通过和业务审核通过分别报告。

第一阶段人工链路及基础设施已形成可执行验证；涉及真实 Agent 的分支尚未完成。每个场景应分别记录规则、真实服务和人工业务验收结果，文档校验不替代运行时证据。
