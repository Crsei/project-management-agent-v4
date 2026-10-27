# Agent 完整接入：可分派任务清单

> 历史参考副本：保留本次收缩为 Agent Chat 范围之前的完整方案。以下“任务待启动”“后续实施”等表述属于旧版语境，不是当前任务或启动指令。业务 Session/Run、Host、主动发现、自动化及旧全场景均不属于当前接入范围。当前实施以[本次 Chat 接入计划](agent-capability-integration-plan.zh.md)和[八项任务清单](agent-capability-integration-tasks.zh.md)为准。
> 本副本保留旧版正文，仅增加此说明，并将三份旧文档之间的链接指向对应历史副本。

配套方案：[完整接入计划](agent-capability-integration-plan.full-scope-reference.zh.md)。状态：**仅生成任务，未开始实施**。所有复选框均为空；未创建正式 PM 任务、未启动 Agent/Host/模型请求、未修改同步 UI 文件。

任务规模：20 个基础接入任务 + 36 个交互场景 + 24 个主动发现场景 + 14 个自动化场景 + 8 个完整旅程 + 8 个验收交付任务，共 110 项。S/P/A/J 编号一一对应[来源场景矩阵](../../SCENARIO-MATRIX.zh.md)，不得合并后漏掉单场景验收。

权限优先顺序更新：先执行[固定 Full access 独立任务 FA01–FA07](agent-full-access-first-tasks.full-scope-reference.zh.md)，不要求先完成 F03/F05 的多模式策略与完整设置产品。FA 是本表相关任务的切片，不额外叠加一套权限工程；切片完成不等于父任务完成。暂缓部分和原 82 个场景均保留，当前仍未启动实施。

## 1. 执行与分派规则

- `UI-MIGRATION` 是同步进行中的外部前置任务，其范围与技术栈见 [UI 采用清单](agent-workspace-ui-adoption.zh.md)。本清单不修改该任务的状态或所拥有文件。
- 角色是文件所有权，不要求一个角色永远由同一执行者承担；同一时刻同一文件只有一个写入者。共用 contracts、迁移序号、routes/shell、依赖锁和 runtime 接线由对应集成人统一修改。
- 基础任务提供业务服务和共享 UI；场景任务必须增加真实的场景交互与边界，不能只创建空组件或重新包装通用卡片改标题。
- 一行任务作为独立分派单：范围由组件/产物和所有者限定，表中依赖是完成前提，验收列是最低要求；源场景矩阵的其余约束继续有效，不能用简表缩减原验收。
- 每项完成需报告文件/接口/迁移、使用的共享服务、Ask/Auto 分支、实际验证、证据位置及阻塞。需要外部访问的项可以登记阻塞，但不能勾选为完成。
- 实施中不自动 commit/push；并行编辑期间不运行互相覆盖的全局 formatter/build，集成后统一检查。

### 1.1 通用组件合同

S/P/A/J 每项各有唯一导出组件，拟定文件位置：

- S：`apps/web/src/features/pm/agent/scenarios/interaction/<组件名>.tsx`
- P：`apps/web/src/features/pm/agent/scenarios/proactive/<组件名>.tsx`
- A：`apps/web/src/features/pm/agent/scenarios/automation/<组件名>.tsx`
- J：`apps/web/src/features/pm/agent/scenarios/journeys/<组件名>.tsx`

每项配套独立 `<组件名>.stories.tsx`，覆盖可用、空态、无权、等待、失败/未知、恢复等适用状态；Storybook 样例不作为正式数据或运行证据。组件使用 React + assistant-ui external-store runtime、现有 Radix/MessageContent 和 PM token，不自建 Hono、SQLite、第二个认证 Provider 或消息数据库。

输入使用 F02/F19 的 named DTO 与宿主上下文；来源权限由服务端检查。组件必须有实际入口、所需能力、数据完整性/版本展示、动作与结果/错误/恢复。模型文字不能驱动 UI 自行批准或标记业务完成。

### 1.2 模式分支标记

- **R**：只读/导航/展示，自动批准不增加业务副作用。
- **W**：默认 Ask 下预览并人工确认；Project write/Full access + 有效 Auto approve 委托下增加真实自动应用分支，保留 before/after、策略批准和收据。
- **E**：Host/Run 动作；Ask 下精确人工审批，Auto 下按工具/目标/参数逐次策略授权，不能越沙箱或跳过核对。
- **H**：硬保护的人类操作，如成果通过审核、Done、生命周期、跨项目移动；任何模式都不能由模型自动通过。
- 一项可以同时含多个标记；例如分析部分 R、发布部分 W、完成部分 H。候选生成/内部消息持久化使用自身授权，不能因不改正式任务而跳过权限与预算。

## 2. 基础接入任务 F01–F20

| 状态 | 任务 | 所有者 / 依赖 | 实施产物与范围 | 验收 |
| --- | --- | --- | --- | --- |
| [ ] | F01 同步边界与权限增量冻结 | INTEGRATOR / 无；前端接线等待 UI-MIGRATION | 接收同步 Thread/Composer/sidebar/runtime 公开接口、保护文件清单；记录 Full access/Auto approve 相对旧手动审批规则的 ADR，冻结硬保护、作用域、生效与模式分支 | 不覆盖同步文件；确认旧 Ask 验收保留、新 Auto 验收独立；技术栈与锁定版本一致；当前/历史/计划状态分开 |
| [ ] | F02 合同、事件与能力注册定义 | CONTRACT / F01 | AgentPolicy、AgentGrant、AgentCapabilitySnapshot、AgentContextManifest、AgentOperation、AgentRunEnvelope、AgentProposal、AgentFinding DTO；严格 schema、同源 SDK、OpenAPI、工具/事件版本与错误类别；保留现有聊天协议 | 请求身份不能由正文伪造；权限错误不泄露对象；旧聊天消息迁移/读取不丢失；生成合同一致；事件可回放去重 |
| [ ] | F03 策略引擎与策略存储 | POLICY / F02 | 两轴模式、项目/工具/字段/网络/文件根约束、deny/ask/allow 优先级、工作区与项目收窄、策略 revision/审计；审批决定归受信服务而非模型 | 全模式组合；Read only + Auto 无写；Full + Ask 仍审批；新增/未知工具拒绝；ACL 与硬保护不可绕过；只读 policy preview 无副作用 |
| [ ] | F04 委托、撤销、期限与预算 | POLICY / F03 | grant 生命周期、会话/Run/后台独立作用域、原子预算与并发、精确操作授权记录、策略版本冻结和生效重查、撤销/到期结算 | 双请求争用额度不超支；过期/撤权阻止新动作；提权不重放旧待批；已派发进入取消/核对；未知不自动重试 |
| [ ] | F05 设置区域与模式配置 UI | POLICY / F03,F04,F19 | AgentSettingsOverview、AgentAccessModeSettings、AgentApprovalPolicySettings、AgentContextPrivacySettings、AgentToolPolicySettings、AgentBudgetSettings、AgentAutomationPolicySettings、AgentGrantManager；原生设置路由由 F20 注册 | 有权保存/只读查看/无权拒绝；Full/Auto 提升显式说明范围、硬保护、预算和到期；保存不影响旧 Run；策略模拟和未知保存恢复真实可用 |
| [ ] | F06 授权上下文与来源适配 | CONTEXT / F02,F04 | 项目/任务/文档/评论/关系/成员/附件/Run 来源的应用层读适配；manifest、对象 revision/hash、选区、草稿 opt-in、分页/大小预算与脱敏；能力快照查询 | 当前 ACL 与委托双重过滤；跨项目/私有会话受控；UI 已发送清单等于实际模型输入；未加载/截断可见；不把草稿当已保存事实 |
| [ ] | F07 模型工具循环与工具注册 | CONTEXT / F04,F06 | OpenAI-compatible 类型化工具调用、供应商能力验证、schema 校验、tool-call 身份/去重、server-owned 多轮执行、预算/取消/未知处理、能力工具与只读查询工具；写工具随后注册 | 模型真实调用授权工具；没有工具支持时明确不可用；拒绝伪造工具结果/提升权限/秘密外发；关浏览器不重派；既有流式终态检查保留 |
| [ ] | F08 运行时上下文与工具可视化 | CONTEXT / F02,F19；接线等待 UI-MIGRATION，联调需 F04,F06,F07 | AgentRuntimeContextBar、AgentContextPicker、AgentContextInspector、AgentAccessModeControl、AgentToolCallCard、AgentApprovalCard、AgentChangeCard、AgentRunContextSnapshot；adapter 将结构化事件接入 assistant-ui | 模型与 UI 能力同源；显示已访问/已发送区别、真实批准方式/工具状态、预算和到期；撤权刷新不泄露旧缓存；历史快照与当前权限区分 |
| [ ] | F09 提案与原生应用/撤销服务 | PLANNING / F04,F06,F07 | 结构化提案、编辑/接受/拒绝/撤销；普通字段/关系/文档工具走原生 CAS、命令或 CreationDraft；人工与策略应用同一服务；逐对象收据 | 预览不写；Auto 真实写且留批准记录；来源变化冲突；未知查原键；撤销拒绝覆盖后续编辑；不直接 SQL/文件绕过业务守卫 |
| [ ] | F10 规划、批量选择与图发布 | PLANNING / F09 | 候选选择/编辑/删除/分批发布、父子/里程碑/依赖真实 ID 映射、合法图校验；高级查询完整选择集；共享 Planning/Batch/Graph UI | S17 查询语法/52匹配与首40/三组追加；不发布未选候选；无缺失引用或环；批次部分成功逐项结算，不虚报跨对象原子成功 |
| [ ] | F11 文档、选区、评论与来源链接 | PLANNING / F09,F19 | 复用原 CodeMirror 与 TaskComments；选区 revision/定位、明确草稿附加、Agent 评论身份、消息转候选、ProposalPreview/来源导航共享组件 | 原正文/标题六种选区动作；只改目标；拒绝零写；人工后改拒旧撤销；评论不伪装人类；返回原编辑器保留草稿/光标 |
| [ ] | F12 Session/Run 与操作持久化 | EXECUTION / F02,F04 | 执行状态机、单 Session 活跃占位、排队/审批/派发/unknown、独立取消与核对、重试新 Run、租约/epoch、事件/收据；原任务生命周期协作守卫 | 两 Run 独立；旧 epoch 拒绝；取消请求不冒充终态；失租/重启先核对；Run 成功不改任务状态；Chat cancel 与 Run cancel 区分 |
| [ ] | F13 受信 Host 与隔离执行 | EXECUTION / F12 | 管理员登记的源码根只读快照、非秘密文件清单、独立 Run 工作目录、文件读写/真实 diff/允许测试适配器、资源/网络限制、签名信封与工具结果 | 实际文件与测试 stdout/exit；路径/符号链接/秘密拒绝；不改原目录；Ask/Auto 都验证授权；一项取消不停止另一项；未知副作用可核对 |
| [ ] | F14 成果、核验与交付集成 | EXECUTION / F09,F12,F13 | 复用 Artifact/Evidence；真实版本/摘要/下载；逐标准核验报告、来源变更失效、PR 本地草稿、人工审阅/送审/完成原生入口；共享报告/日志/成果 UI | 三标准当前来源可核验；未知不变通过；历史绿不能沿用；成果审核、批准工具与 Done 分开；不生成虚假远端 PR |
| [ ] | F15 主动来源与外部只读连接器 | AUTOMATION / F04,F06,F12 | 任务/评论/Session/Run/diff/访问水位/里程碑的持久来源；PR/CI 真实只读适配；来源身份、范围和版本、事件去重/历史时间 | 来源不可见不泄露；没有配置明确阻塞；真实 7/14 天语义；同源文件交叉不混同不同沙箱同名文件；完整只读适配而非 demo |
| [ ] | F16 Finding 引擎与处置状态 | AUTOMATION / F09,F15 | P01–P24 确定性触发/必要模型分析、证据/指纹、冷却/预算/去重/失效、共享 Finding 身份、来源化草稿与当前再检查 | 不造事实或根因；新观测不改旧记录；过期来源拒绝应用；Pulse/任务/规划/待审同一 Finding；所有 P 规则分别可验 |
| [ ] | F17 自动化 Worker 与规则生命周期 | AUTOMATION / F04,F07,F16 | 规则 CRUD/CAS、时区调度、后台独立主体/委托、会话新建/续接、预检与正式执行区分、规则历史、限额/水位/暂停 | 无浏览器也调度；预检不发模型/写对话；保存不等于运行；重启不重复；09:00 Asia/Shanghai 与预算跳过真实可验；Level1/2 含义不变 |
| [ ] | F18 后台预授权自动应用 | AUTOMATION + POLICY / F09,F17 | 独立 `自动应用授权`：精确规则/项目/工具/字段/时效/预算；策略授权、来源重新验证、幂等应用、自动应用记录与紧急停用 | 默认关；Level2 不隐式应用；只匹配规则可直写；审批敏感/生命周期仍人审；撤权与模型失败不写；未知核对不派第二次 |
| [ ] | F19 场景组件基础与共享 UI 合同 | INTEGRATOR / F02；runtime 接线等待 UI-MIGRATION | AgentScenarioSurfaceProps、lazy 场景注册、查询/cache key、来源/权限/差异/审批/收据基础组件、独立 Storybook 模板；约束消息单一 runtime | 不创建第二套业务状态；未知场景/能力拒绝；组件可独立挂载真实 DTO；不在注册表拼万能任意写入口；每场景有唯一导出 |
| [ ] | F20 原生入口、路由与共享接线 | NATIVE / F05,F08,F19,UI-MIGRATION；业务入口随 F09–F18 完成分段接通 | 唯一改动 routes/shell/设置注册及原项目/任务/文档工具栏；新增 planning/proposals/runs/pulse/automations/settings/agent；通知/活动/搜索/审计深链 | 原页面/主按钮/草稿/主题保留；禁用原因真实；无第二认证/侧栏壳；跨工作区释放缓存；同会话面板/全页往返不新建消息 |

F05 与 F08 的 UI 可以基于 F02/F19 合同先制作独立开发组件，正式开放必须等对应服务完成；这不构成正式路由使用假数据的许可。F20 不反向成为 F19 或 F05 的依赖，避免循环。

## 3. 交互场景任务 S01–S36

| 状态 | 任务 / 独立组件 | 所有者 / 依赖 | 真实交互、最低验收与模式分支 |
| --- | --- | --- | --- |
| [ ] | S01 详情侧栏 / EntityAgentPanel | NATIVE / F08,F19,F20 | 固定任务上下文的非模态面板，开关不卸载编辑器；同一面板与会话，保存/未保存内容保留；R |
| [ ] | S02 自然语言创建 / NaturalLanguageTaskCreator | PLANNING / F10,F19 | 单任务候选编辑/取消/发布及原看板定位；Ask 确认前零任务、发布一次；Auto 仅明确创建意图且有效委托时落地并展示收据；W |
| [ ] | S03 选区改写 / SelectionRewritePanel | PLANNING / F11 | 标题/正文各改写/缩短/扩写六分支；定位/revision/差异与安全撤销；Ask 拒绝不写，Auto 只改授权选区；W |
| [ ] | S04 验收标准 / AcceptanceCriteriaEditor | PLANNING / F09,F11 | 标准写原生验收字段而非评论；显示原/新标准与来源；两审批模式均不改变任务状态/声明标准已满足；W |
| [ ] | S05 展开工作台 / AgentWorkbenchLauncher | NATIVE / F08,F14,F20 | 同对象/会话展开全页，核验直达正确报告标签；零新增消息/Session/Run；R |
| [ ] | S06 返回来源 / AgentSourceReturnControl | NATIVE / F11,F20 | 返回正确任务/文档和来源，恢复草稿、选区、滚动与焦点；不发模型、不写业务；R |
| [ ] | S07 编码执行 / CodingRunLauncher | EXECUTION / F08,F12,F13 | 打开只读，明确执行意图创建 Run；Ask 逐动作人批，Auto 显示精确策略批准；真实文件/测试；不自动 Done；E |
| [ ] | S08 任务执行结果 / TaskRunResultSummary | EXECUTION / F14,F20 | 正确 Run 摘要、待批和历史共存、人工审阅标记刷新持久；详细成果留运行页；R/H |
| [ ] | S09 消息转任务 / MessageTaskDraftAction | PLANNING / F10,F11 | 指定消息生成候选，保留原会话来源往返；Ask 编辑发布一次，Auto 只在明确转换并允许发布时写；W |
| [ ] | S10 引用对象 / AgentObjectReferencePicker | CONTEXT / F06,F08 | 类型化项目/任务/文档选择、服务端实际载入、revision/已发送清单；无权限拒绝不回显对象；R |
| [ ] | S11 评论调用 / AgentCommentAction | PLANNING / F07,F11 | 显式 @Agent 产生真实模型回复和 Agent 来源评论/提案；人工与模型身份分开，字段应用另按策略；R/W |
| [ ] | S12 拆子任务 / SubtaskDecompositionPanel | PLANNING / F10 | 候选编辑、选择与发布，正式子项 parent 正确；未选不写，Auto 仍限定此次作用集；W |
| [ ] | S13 多任务创建 / MultiTaskDraftPublisher | PLANNING / F10 | 多候选编辑/删除/分批发布、ID映射与看板定位；Ask 只选中项落地，Auto 不扩大已选集合；W |
| [ ] | S14 批量修改 / BatchTaskChangePanel | PLANNING / F09,F10 | 四类字段逐项差异/版本/结果；Ask 分项审阅一次确认；Auto 精确字段规则；Done 等保护动作仍人工，核验有真实报告；W/H |
| [ ] | S15 多执行会话 / ExecutionSessionSwitcher | EXECUTION / F12,F19 | 显式新建独立 Session、读取旧历史与 Run 输入；切换不覆盖、不自动启动 Run；R/E |
| [ ] | S16 会话连续性 / ConversationContinuitySurface | NATIVE / F08,F19,F20 | 面板、全页、详情/执行/核验/活动复用同一 runtime；消息去重与输入草稿连续，往返持久消息精确一份；R |
| [ ] | S17 看板批量上下文 / BoardAgentSelectionPanel | PLANNING / F06,F10,F13 | 全筛选/已加载/组追加明确；52匹配首40与3组20首15；布尔/日期/错误位置；只读分析不改状态，编码逐任务授权；R/W/E |
| [ ] | S18 目标开发计划 / ProjectGoalPlanningPanel | PLANNING / F10 | 读取真实项目目标，编辑里程碑/父子/依赖、分批发布、未选候选保留；缺失引用/环拒绝；W |
| [ ] | S19 查重关联 / RelatedTaskSuggestionPanel | PLANNING / F06,F09 | 展示授权候选与相似依据、关系提案/原图导航；允许关联不允许自动合并/删除；W |
| [ ] | S20 依赖分析 / DependencyAnalysisPanel | PLANNING / F10 | 真实图分析、变更预览与合法应用；自环/成环/不存在/不合法跨项目拒绝，所有模式保持守卫；R/W |
| [ ] | S21 产物审查 / RunArtifactReviewPanel | EXECUTION / F14 | 实际 diff、stdout/exit/断言、成果与本地 PR 草稿；来源可回，不能伪造远端 URL/自动完成；R |
| [ ] | S22 失败转 Bug / FailedRunBugDraftPanel | PLANNING / F09,F14 | 从固定失败 Run 生成正式 bug 类型候选、编辑/发布与来源往返；保留失败现场，Auto 规则不能覆盖原任务；W |
| [ ] | S23 文档编辑 / DocumentAgentEditorPanel | PLANNING / F11 | 同原编辑器的解释/改写、before-after、拒绝、应用和安全撤销；手工后改冲突真实可验，草稿只显式附加；W |
| [ ] | S24 项目总结 / ProjectProgressRiskPanel | CONTEXT / F06,F07,F14 | 当前授权任务/Run/文档分析、引用与范围完整性；摘要只读，不猜完成率/根因，另存文档须独立写动作；R |
| [ ] | S25 运行恢复操作 / RunRecoveryActions | EXECUTION / F12,F13 | 失败、取消请求/settling/终态、核对、显式重试；重试新 Run/授权，原结果保留；E |
| [ ] | S26 断网刷新 / AgentRecoveryStatusPanel | CONTEXT / F07,F08,F12 | 展示连接/未知/核对与原请求身份；关闭/刷新不重派，缺终态不装成功；Run 与 Chat 分别恢复；R |
| [ ] | S27 动作审批 / OperationApprovalPanel | POLICY / F04,F08,F12 | 精确目标/参数/期限与当前权限；人工批准/拒绝/撤销、Auto 策略记录；恢复权限不批准旧请求；E/H |
| [ ] | S28 版本冲突 / ProposalConflictResolver | PLANNING / F09 | 双浏览器 A提案/B修改/A应用真实冲突，保留双方并供人工处理；Auto 不基于新版本偷重算再应用；W |
| [ ] | S29 并行运行 / ParallelRunMonitor | EXECUTION / F12,F13 | 两任务/Session 的真实并发进程、独立目录/收据/预算；取消一项另一项继续，观察标签页不控制执行；E |
| [ ] | S30 统一收件箱 / AgentInboxActivityPanel | NATIVE / F12,F16,F20 | 实际运行/审批/Finding 来源深链、个人已读持久；查看不接受建议/审批，不跳任意当前任务；R |
| [ ] | S31 生命周期历史 / ArchivedAgentHistoryPanel | EXECUTION / F12,F14,F20 | 取消归档确认、原生归档/恢复、删除源历史读取；活跃/unknown 守卫，归档禁新执行，原身份保留；R/H |
| [ ] | S32 响应式布局 / AdaptiveAgentSurface | NATIVE / F19,F20 | 同宽右置非模态独立滚动；任务/规划/Run/文档/收件箱/搜索/设置浮层，1440/1920/390和键盘焦点；不改变旧主题与首页；R |
| [ ] | S33 能力与空态 / AgentAvailabilityPanel | POLICY / F05,F08 | 未配置模型/Host、无读/写权限、网络/服务错误和恢复分别显示；只读预览不应用，空项目归属正确；R |
| [ ] | S34 跨项目迁移 / TaskProjectMovePanel | NATIVE / F09,F12,F20 | 原生明确移动、源/目标权限重查、任务ID不变，关系/交付/评论恢复合同；Run历史原项目不改，双侧历史授权；H |
| [ ] | S35 大数据与历史 / AgentHistoryExplorer | NATIVE / F06,F08,F12,F20 | 任务/消息/Session/Run/通知完整分页、长消息展开与长文档原文；真实规模/首屏标准，不能截断保存或越权扩大范围；R |
| [ ] | S36 审计撤销 / AgentAuditUndoPanel | PLANNING / F09,F11,F20 | 操作者、授权方式、对象、before-after、原键收据；同版本撤销成功、人工后改拒旧撤销；审计不可变；W |

## 4. 主动发现场景任务 P01–P24

各项依赖 F16、F19；表中列出额外必要来源或应用任务。每个组件包含该场景自己的证据展示、解释与处置，不只是渲染一个通用 Finding 标题。默认 Level1/2 保留只建议/准备候选；涉及 W/E 的自动落地须 F18 的独立后台授权，不能继承交互会话模式。

| 状态 | 任务 / 独立组件 | 所有者 / 额外依赖 | 真实来源、交互与最低验收 |
| --- | --- | --- | --- |
| [ ] | P01 相似任务 / DuplicateTaskFindingCard | AUTOMATION / F09 | 新任务与已有授权任务、相似依据、关联提案；不自动合并/删除；W |
| [ ] | P02 需求缺项 / RequirementGapFindingCard | AUTOMATION / F11 | 真实内容更新与缺失范围/标准/约束；补全差异；Level2 仅pending，自动应用需单独 grant；W |
| [ ] | P03 七天无活动 / StaleTaskFollowupCard | AUTOMATION / F15 | 持久活动/评论/会话/Run 的真实时间线；跟进候选；真实年龄和受控时钟证据分开，不倒填；R/W |
| [ ] | P04 依赖就绪 / DependencyReadyFindingCard | AUTOMATION / F10 | 当前前置依赖和工作流、状态建议；应用时重查，不直接 Done；W/H |
| [ ] | P05 测试通过 / ReviewReadinessFindingCard | AUTOMATION / F14 | 同版本非空真实测试与当前标准、送审依据；人工送审/审阅，不凭测试自动完成；R/H |
| [ ] | P06 范围重叠 / ScopeOverlapFindingCard | AUTOMATION / F10 | 依赖和声明范围、交集来源展开、协调任务候选；不推定已发生冲突；W |
| [ ] | P07 成功总结 / RunSuccessSummaryCard | AUTOMATION / F14 | 成功Run真实摘要/成果、来源活动/文档候选；Level1 人工保存可用；Auto 有独立规则批准，去重；W |
| [ ] | P08 失败调查 / RunFailureInvestigationCard | AUTOMATION / F14 | 真实失败日志/测试/文件、假设与调查候选；保留错误不编造根因；W |
| [ ] | P09 会话遗留 / ConversationFollowupCard | AUTOMATION / F06,F10 | 授权会话中的明确遗留原话，带来源的未发布任务；不扫描他人私有会话；W |
| [ ] | P10 PR/CI 覆盖 / PullRequestCoverageFindingCard | AUTOMATION / F15 | 真实只读外部PR/CI、标准覆盖缺口、补全候选；无连接器/权限阻塞，不伪造远端数据；W |
| [ ] | P11 并行变更交叉 / ConcurrentEditRiskCard | AUTOMATION / F13 | 实际重叠时间、同源码身份、diff路径与协调候选；不同沙箱同名文件不能认定相撞；W |
| [ ] | P12 重复失败 / RepeatedFailureFindingCard | AUTOMATION / F13,F14 | 多Run重复失败测试/错误、假设、执行申请；Ask 人批，Auto 需单独后台执行授权和每次操作决定；W/E |
| [ ] | P13 明确决策 / DecisionCaptureFindingCard | AUTOMATION / F11 | 明确来源消息、决策文档候选；文档保存不等于正式 intent.decide，正式决策仍人工；W/H |
| [ ] | P14 超范围改动 / OutOfScopeChangeCard | AUTOMATION / F13 | Host 实际diff与声明范围比对、复核候选；不自动回滚原代码/沙箱；R/W |
| [ ] | P15 需求影响 / RequirementImpactFindingCard | AUTOMATION / F10,F11 | before/after需求版本与下游引用、影响文档；来源后变失效；W |
| [ ] | P16 知识沉淀 / RepeatedTopicKnowledgeCard | AUTOMATION / F06,F11 | 明确授权的多Session主题证据与知识候选；不把同项目当私有消息共享授权；W |
| [ ] | P17 共性问题 / CrossTaskFailureFindingCard | AUTOMATION / F14 | 不同任务的真实失败/Run来源、共性调查候选；无法证明的结论标假设；W |
| [ ] | P18 阶段后续 / PhaseContinuationFindingCard | AUTOMATION / F10 | 真实阶段完成与下游工作、规划候选；候选选择/发布仍有原键映射；W |
| [ ] | P19 每日变化 / DailyProjectChangeCard | AUTOMATION / F15,F17 | 持久后台/首访水位、真实新增事实、来源摘要；无变化零虚假日报，非浏览器 interval；R |
| [ ] | P20 长期阻塞 / BlockedProjectInvestigationCard | AUTOMATION / F15 | ≥14天无进展且真实阻塞的历史，调查候选；现实年龄不足标阻塞，不伪造日期；W |
| [ ] | P21 发布风险 / ReleaseRiskFindingCard | AUTOMATION / F10,F14 | 里程碑及未完/失败/待审来源、风险文档；不宣布可交付；W |
| [ ] | P22 离开期间 / SinceLastVisitSummaryCard | AUTOMATION / F15 | 当前访问与持久上次水位、范围内变化；两次访问不倒退重放；R |
| [ ] | P23 目标偏离 / GoalDriftFindingCard | AUTOMATION / F10,F13 | 目标、未完目标任务、近期真实文件变化与下一步候选；不能凭Session数量判断；W |
| [ ] | P24 下一步 / NextActionPlanningCard | AUTOMATION / F10 | 目标任务、满足依赖和明确遗留、可编辑下一步规划；默认不自动发布，Auto 只按单独规则委托发布选定集合；W |

## 5. 自动化场景任务 A01–A14

各项依赖 F17、F19；自动应用相关项还需 F18。每个场景拥有独立生产组件，展示真实规则/运行/来源，不生成“示例业务项目”。

| 状态 | 任务 / 独立组件 | 所有者 / 额外依赖 | 真实交互与最低验收 |
| --- | --- | --- | --- |
| [ ] | A01 自动化总览 / AutomationOverviewPanel | AUTOMATION / F20 | 总览/运行/待审核入口，真实上次/下次/失败/待审计数；R |
| [ ] | A02 规则编辑 / AutomationRuleEditor | AUTOMATION / F05 | 名称/指引/范围/触发/时区/输出/冷却/预算，revision与未保存草稿；启用自动写需额外授权，不由模型自改规则；H |
| [ ] | A03 新建对话 / AutomationNewConversationPanel | AUTOMATION / F07 | 正式执行检查才新建会话，输入快照/运行ID/结果持久；预算跳过不得产生空会话；R |
| [ ] | A04 续接会话 / AutomationConversationContinuationPanel | AUTOMATION / F06 | 追加指定授权会话而非覆盖；缺失/跨项目拒绝，不静默新建；R |
| [ ] | A05 只读预检 / AutomationDryRunPanel | AUTOMATION / F03,F04 | 预检/保存/预算跳过清晰；不写对话、不发模型、不修改业务或调用Host；R |
| [ ] | A06 运行工作台 / AutomationRunWorkspace | AUTOMATION / F08 | 三栏运行列表/活动与输入/变更发现；触发不是用户消息；显示实际策略/预算与批准方式；R |
| [ ] | A07 变更审阅 / AutomationChangeReviewPanel | AUTOMATION / F09,F18 | 字段/文档/规划候选、应用/忽略/安全撤销；默认审阅与预授权自动应用记录并存，后改拒旧撤销；W |
| [ ] | A08 审核收件箱 / AutomationReviewInbox | AUTOMATION / F16,F20 | 待审发现与失败运行、待变更数、来源及当前重查；已读不批准；R |
| [ ] | A09 人工备注 / AutomationHumanNoteEditor | AUTOMATION / F20 | 明确保存为人工备注，不触发模型/执行/重新调度；R |
| [ ] | A10 再次检查 / AutomationRecheckPanel | AUTOMATION / F16 | 当前规则/源/权限/策略/预算生成新观测，保留旧运行输入；不伪装重放历史事件；R/W |
| [ ] | A11 编辑返回 / AutomationEditorNavigation | AUTOMATION / F20 | 未保存规则/编辑位置恢复，运行历史使用冻结快照；导航不保存、不派发；R |
| [ ] | A12 完整性规则 / RequirementAuditAutomationPanel | AUTOMATION / P02,F18 | 真实任务更新、新审阅会话、Finding/证据/任务深链；Level2与独立自动应用可区分；W |
| [ ] | A13 停滞跟进 / StaleTaskAutomationPanel | AUTOMATION / P03 | 手动当前检查续接授权会话，两次输入/结果独立；真实停滞前提与模拟时钟分别验收；R/W |
| [ ] | A14 定时摘要 / DailyDigestAutomationPanel | AUTOMATION / P19 | 09:00 Asia/Shanghai真实Worker调度、仅通知输出、每日上限/跳过；关浏览器及重启后可核验，不自动改任务；R |

## 6. 完整旅程任务 J01–J08

旅程组件组合已交付场景，提供真实的阶段、当前依据与下一步操作；不复制业务实现，不是手工勾选通过数的验收页面。

| 状态 | 任务 / 独立组件 | 所有者 / 依赖 | 完整端到端接受标准 |
| --- | --- | --- | --- |
| [ ] | J01 项目规划旅程 / ProjectPlanningJourney | PLANNING / S02,S12,S13,S18,S20 | 简报→真实候选→编辑/删除/里程碑/父子/依赖→分批发布→原卡片定位；Ask/Auto 分支分别证明未选项不落地；W |
| [ ] | J02 单任务交付 / TaskDeliveryJourney | EXECUTION / S02,S04,S08,S21,F14 | 自然语言任务→标准采纳/发布→当前逐标准依据→明确送审→人工批准Done或要求修改；两分支真实操作；W/H |
| [ ] | J03 成功完成链 / VerifiedCompletionJourney | EXECUTION / S07,S21,F14 | 三项标准同当前版本真实源码/Session/测试依据→合格报告→送审→人工批准Done→原看板定位/高亮与审计；Auto不跳人类完成；E/H |
| [ ] | J04 失败修复链 / ChangeRequestRecoveryJourney | EXECUTION / S07,S23,S25,F14 | 真实缺口/失败→明确退回→授权修改隔离文件→新版本复查→送审/意见退回；不拼旧绿色报告，意见与失效历史保留；E/H |
| [ ] | J05 失败会话 / FailedSessionJourney | EXECUTION / S15,S21,S25 | 失败与部分输出真实保留，显示不能完成原因；无伪造通过，后续新Run不覆盖旧失败；R/E |
| [ ] | J06 取消与失效 / VerificationInvalidationJourney | EXECUTION / S04,S25,S26,S28,F14 | 显式取消/实际停止、刷新、修改标准或源、旧报告失效；unknown不变passed；各事件有当前版本依据；E/H |
| [ ] | J07 原生工具融入 / NativeAgentToolsJourney | NATIVE / S06,S23,S30,S32,S36,F05 | 文档/通知/对象搜索/审计/设置仍原生，真实来源深链和权限过滤；无全局Studio替换，完整键盘/浮层往返；R |
| [ ] | J08 真实能力解释 / AgentCapabilityJourney | POLICY / F05,F08,S27,S33 | 设置→上下文→模型能力回答→真实工具调用→批准方式/收据同源；配置≠可达≠执行就绪，无DEMO或人工通过计数；R/W/E/H |

## 7. 独立验收与交付任务 V01–V08

| 状态 | 任务 | 依赖 / 所有者 | 验收与产物 |
| --- | --- | --- | --- |
| [ ] | V01 合同与模式一致性 | F01–F20 / CONTRACT | schema/SDK/OpenAPI、事件/迁移、每工具可委托性、Ask/Auto差异、模型提示与真实工具能力一致；原聊天历史/调用者兼容迁移 |
| [ ] | V02 权限与安全矩阵 | F03–F09,F12–F18 / POLICY | 双主体/双工作区/项目范围/私有会话/审计/附件、Full各组合、撤权/过期/提权、注入/秘密/网络/路径逃逸、批量部分授权；真实后端拒绝与零副作用证据 |
| [ ] | V03 故障、并发与恢复 | F04,F07,F09,F12–F18 / INTEGRATOR | 原键丢响应/断流/乱序/重启/未知、并发预算、两个Run取消隔离、旧epoch、撤权派发竞态、策略切换与旧审批、旧revision/安全撤销；保留失败证据 |
| [ ] | V04 全场景浏览器与组件 | S01–S36,P01–P24,A01–A14,J01–J08 / NATIVE | 82个组件独立入口/故事/真实行为逐项核验；1440×1000、1920×1080、390、键盘焦点/浮层/草稿/同会话；不能只截欢迎页 |
| [ ] | V05 真实模型、Host、来源与调度 | F07,F13–F18及相关场景 / INTEGRATOR | 实际供应商的读取/工具/结构化/流式/取消，真实Host文件/测试、独立Worker调度、PR/CI来源；真实7/14天和缺外部前提单列，不用模拟结果代替 |
| [ ] | V06 规模与范围完整性 | S17,S35,P19,P22,A14 / INTEGRATOR | 隔离真实1200任务/240消息/40Session与Run/120通知、首屏40/30/12/8/20与全分页、52筛选/三组选择/长文档；记录耗时、模型预算与内存边界 |
| [ ] | V07 全量工程与原PM回归 | V01–V06 / INTEGRATOR | 受影响lint/typecheck/build、合同/文档检查、完整test:backend、原人工创建/编辑/生命周期/交付；失败/跳过/取消/超时独立登记，不删边界测试换绿 |
| [ ] | V08 迁移、部署与逐项交付 | V07 / INTEGRATOR | 隔离空库/升级/备份恢复、策略与历史消息恢复、默认不开启扩权、分能力停用保留历史、独立环境与秘密门禁；生产切换前核对PID/端口/cwd；110项状态/证据与外部阻塞完整交接 |

## 8. 实施波次与可立即分派范围

| 波次 | 主要任务 | 放行条件 |
| --- | --- | --- |
| 0 合同与交接 | F01、F02 | 接收同步UI边界；确认新权限语义不冒充已启用 |
| 1 权限/上下文基础 | F03、F04、F06、F19；合同允许后 F05/F08 独立UI | 当前ACL、委托、能力/manifest可真实查询；UI共享接线等同步交付 |
| 2 模型与规划写入 | F07、F09、F10、F11；F05/F08联调；S中的R/W切片 | 只读端到端通过后开放写工具，Ask与Auto均有真实保护 |
| 3 受控执行 | F12、F13、F14及对应S/J；可与独立规划UI并行 | Host真实隔离、精确批准、收据和取消核对通过 |
| 4 来源与自动化 | F15、F16、F17、F18及P/A | 来源与后台独立委托先到位；自动应用最后单独开启 |
| 5 原生全面集成 | F20分段接线、全部S/P/A/J完成 | 同步UI已交接，入口实际服务可用；原PM保留 |
| 6 全量验收与交付 | V01–V08 | 无静态组件冒充闭环，缺外部前提明确登记，不擅自缩减范围 |

本轮“先生成对应的任务”交付到此，不自动执行波次0。后续分派采用上表依赖，不能把整份任务清单直接变成一个巨大单代理任务，也不能让多个执行者同时编辑聊天/路由/合同/锁文件。
