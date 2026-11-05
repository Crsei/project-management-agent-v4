# 权限与授权边界

> 适用性：本文件保留v0.1历史提案/稳定编号，不代表完整业务Runner或旧SQL核心规则已启用。当前Markdown任务状态、审核独立性与关系语义以[已采纳ADR](../architecture/adr/0003-markdown-core.md)及[入口第七节](README.md#implementation-plan)为准；Chat thread/generation不能替代历史Session/Run模型。

本文件是 [v0.1 提案](README.md)。以能力定义授权，角色只负责组合能力。身份、角色及授权从受信服务取得，不采信提示词、消息文本或 Agent 自报的角色。

## 1. 主体与作用域

主体分为 human、agent、service。人通过 Workspace 成员资格及项目授权操作；Agent 使用自己的身份，并记录委托人、grantId、允许资源和有效期；后台服务使用限定用途的服务身份。

授权条件为：`主体有效 ∧ Workspace 匹配 ∧ 项目可访问 ∧ 能力被授予 ∧ 资源与动作在范围内 ∧ 授权未过期/撤销 ∧ 领域守卫满足`。角色更高不能豁免业务不变量。

Workspace 管理员管理成员和授权，但不天然具有业务审批、审核或任务完成权；需要显式授予相应能力。工作项负责人也不自动获得成果审核权。

## 2. 能力目录

| 能力 | 代表命令 | 人 | Agent | 服务 |
| --- | --- | --- | --- | --- |
| domain.read | 读取有权访问的项目、工作项、成果、执行历史 | 按项目授权 | 按委托范围 | 按用途范围 |
| intent.propose | CreateConversation、AppendMessage、ProposeIntent、ReviseIntent、WithdrawIntent | 作者/获授权协作者；撤回限本人提出且未接受的意图 | 可委托；撤回限本人提出且未接受的意图 | 不默认授予 |
| intent.decide | AcceptIntent、RejectIntent、RecordDecision、WithdrawIntent | 明确授予的决策者，可撤回仍为 proposed 的意图 | 不授予 | 不授予 |
| planning.edit | CreateProject、CreateWorkItem、内容/元数据、依赖、里程碑、Ready/StartWorkItem、阻塞设置 | 规划编辑者 | 可限项目委托；不能修改授权策略 | 仅明确配置的协调器 |
| planning.lifecycle | Activate/Complete/Cancel/ReopenProject、Achieve/Cancel/ReopenMilestone、Archive/Restore | 项目管理者 | 不授予 | 不默认授予 |
| workitem.cancel_reopen | CancelWorkItem、ReopenWorkItem | 明确授予的人 | 不授予 | 不默认授予 |
| execution.start | CreateSession、CreateRun、RetryRun、CloseSession | 执行发起者 | 可委托 | 调度器按已授权请求 |
| execution.cancel | RequestRunCancellation | 运行发起者或明确管理者 | 委托范围内可请求 | 策略限定的控制器 |
| execution.report | StartRun、RecordRunOutcome、操作凭据、未知状态与审批等待处理 | 不直接授予普通用户 | 模型不能自行签发权威执行回报 | 对应 Run 的受信执行适配器 |
| execution.approve | GrantApproval、DenyApproval | 明确授予的审批者 | 不授予 | 本版不授予自动批准 |
| execution.revoke | RevokeApproval | 审批者或获授权管理者；请求者可撤回自己的 pending 请求 | 仅可撤回自己 pending 请求 | 系统按有效期/授权撤销处理 |
| execution.reconcile | ReconcileOperation、ReconcileRun | 获授权运维人员提交核对证据 | 可提出查询请求，不能自行断言结果 | 受信核对适配器 |
| delivery.write | RegisterArtifact、AddArtifactVersion、RecordEvidence | 成果贡献者 | 委托范围内 | 受信执行/验证服务 |
| delivery.submit | SubmitWorkItemResult、ReturnWorkItemForChanges | 获授权贡献者 | 可提交/撤回自己的交付；仍经过 Planning 守卫 | 明确委托的协调器 |
| delivery.review | RecordReview | 明确授予的审核人 | 不授予 | 本版不授予自动验收 |
| workitem.complete | CompleteWorkItem | 明确授予的完成确认者 | 不授予 | 本版不授予自动关闭 |
| access.manage | 成员、角色、委托授权管理（支撑上下文） | Workspace 管理员 | 不授予 | 专用身份服务 |
| audit.read | 读取当前授权项目的不可变业务审计及安全字段差异 | 与 domain.read、当前项目范围共同检查；明确授予 | 未启用真实 Agent | 不默认授予 |

能力表是允许授予的上限，不代表所有人/Agent 自动拥有相应能力。SubmitWorkItemResult 与 ReturnWorkItemForChanges 会改变规划状态，但仅授权这一特定流程，不因此获得任意 planning.edit。

用户可拥有多种能力，例如同一人审批动作、审核成果并完成工作项；三个动作仍留下独立记录。若需要职责分离，可增加“审核人不得为交付者”的项目策略，但本版未默认强制双人审核。

## 3. Agent 委托与动作审批

Agent 的实际权限是自身能力、用户委托与项目策略的交集。模型生成的工具参数只是请求；执行服务必须再检查能力、资源、当前版本与动作策略。Agent 不能通过修改 WorkItem 的验收标准、负责人或元数据给自己增加授权。

动作策略按 actionType 与资源范围定义：允许的只读动作可以直接执行；未配置的外部写操作需要人工 Approval；明确禁止的动作即使获得 Approval 也不可执行。Approval 补充动作前确认，不授予原本不存在的基础能力。

RequestApproval/DispatchOperation 由受信执行入口接受 Agent 的请求，绑定 operationId、Run、参数摘要和授权来源。审批 UI 展示的资源与参数必须与实际派发内容一致。审批有效期由项目策略规定且必须有限；执行前重新验证当前授权。变更参数、目标或运行需重新审批。

撤销委托后阻止新的派发；已经发生或仍在执行的动作进入取消/核对流程，不能声称撤销授权就撤销了外部副作用。服务可保留仅接收事实与核对的权限，以正确记录已派发动作，不能继续执行新的写操作。

## 4. 审计与读取

审计至少保留 principalId/type、onBehalfOf、grantId、命令/事件 ID、目标范围、授权策略版本、前后业务版本、审批/审核依据、结果及原因。运行日志不是唯一审计凭据；不得把凭据、令牌或不必要的完整提示词写入公共事件。

读取 ArtifactVersion 内容与读取其元数据分别检查权限。跨项目引用即使 ID 有效也要拒绝。归档对象仍受权限保护；错误响应不向无权主体透露对象存在性。审计记录的读取能力应单独配置，不让普通项目只读权限自动暴露敏感执行材料。

<a id="project-page-permissions"></a>

## 5. 项目页面补充授权

- 个人项目收藏使用当前 `domain.read`，仅本人可读写；另一成员即使可读同一项目也不能读取其收藏、私有事件或收据。
- 项目封面和结构化范围使用 `planning.edit`，同时校验核心项目版本、附加记录版本及原生可写状态。封面必须指向本项目的已登记栅格图片版本，下载仍逐次授权。
- 团队定义/成员维护需要无限制工作区 `access.manage`；该能力不隐含业务读取。仅有管理能力者可以维护团队，但项目目录为空，不能关联或读取项目。项目关联同时要求当前项目 `domain.read` 及项目可写。
- 最小项目目录只返回合法关联者的 `{id,name}`。团队成员按当前项目读取权限裁剪；团队关联不创建 membership、不发邀请、不扩大任何成员的授权。
- 项目审计需要显式 `audit.read`，不能由普通只读权限或“管理员”标签推断。迁移不自动给既有成员追加能力；管理员通过既有成员授权流程显式授予。新工作区初始 owner 仍采用创建时的完整能力集合。
- 已撤销能力、项目范围或账号后，审计分页、原命令收据及私有缓存都按当前权限重新检查。部署前的操作和外部文件编辑不补造用户归属；当前文件更新时间与 API 审计分开展示。

具体范围、接口及证据见[正式项目页面说明](../guides/project-management.md)。

## 6. 成员目录与邀请

- `directory.read` 是显式成员目录能力，不随升级自动授予既有成员。普通目录按实际共享项目范围裁剪，隐藏他人邮箱、电话、能力/项目授权明细和撤销记录；仅工作区 `access.manage` 可读完整管理目录与邀请列表。本人可读自己的联系资料。
- Admin / Member / Guest 只是服务端能力模板，不能作为额外授权依据。Admin 不隐含审核、生命周期或任务完成权限；非模板组合保留为 Custom。精确组合见[成员说明](../guides/project-management.md)。
- 邮件邀请创建、撤销、重发均要求当前工作区 `access.manage`；接受时再次检查邀请人当前能力、邀请状态、期限与项目范围。邀请不绕过账号认证，不允许改写已有账号密码或覆盖已有有效成员授权。
- 岗位、电话、安全头像使用本人资料的同一 CAS 版本。在线状态复用心跳 TTL；没有认证系统证据时 2FA 返回未知及不可用能力，不由成员管理员任意设置。

## 7. Teams 页面与容量

- 团队维护者、工作方向、响应目标和成员关系修改沿用无限制工作区 `access.manage`；维护者标签不构成管理权限。关联项目继续要求该项目的业务读取与可写状态。
- 容量配置由无限制工作区 `access.manage` 维护，目标必须是有效工作区成员；只有管理能力并不允许读取工作项。工作量查询另需 `domain.read` 及目录授权，沿用成员目录的脱敏与共同范围裁剪。
- 原生任务创建/估算编辑仍需实际项目 `planning.edit` 与业务读取，不能因查看某成员任务卡而获得其所有项目权限。
- 普通读者的容量判断必须带范围完整性语义，未见的工作不得当作不存在；新能力不自动修改现有成员授权。

