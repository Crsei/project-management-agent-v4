# 统一 Agent ↔ PM 交互矩阵与历史场景对照

当前实现以第 1 节和 [统一改造计划](agent-chat-pm-unification-plan.zh.md) 为准：PM 助手与 Agent Chat 是同一个 Agent 的不同入口。第 2–6 节保留统一前与 `agent-pm-studio` 的历史差异快照；其中“两套 Agent”、旧 grant 和旧聊天接口的判断不再代表当前实现。第 8 节是目标讨论及独立前端记录，不扩大本次交付范围。

判定口径：

- **已实现**：当前仓库有等效行为，可在现有 PM 或 Agent Chat 中完成；不要求与原型视觉 1:1。
- **部分**：有相邻能力或基础，但缺少场景要求的关键步骤，例如候选草稿、逐项预览、Run、审批或撤销。
- **未实现**：当前没有对应能力，也没有明确排除。
- **范围外**：仓库已明确声明不建设，例如业务 Session/Run、Host、代码执行、提案平台、主动发现和生产审批工作台。

`agent-pm-studio` 是浏览器 `localStorage` 高保真原型：没有真实 AI、仓库命令、测试执行、PR 集成或 PM 后端；其 DEMO Controller 和本地证据不能当作当前仓库的验收结果。本文的对照只比较产品语义和能力边界。

---

## 1. 一个 Agent，两类职责

| 维度 | 当前归属与行为 |
| --- | --- |
| 入口 | PM 详情侧栏与 `/agent/workspace` 共用 Chat；旧 PM Agent 路由只重定向 |
| UI、模型与会话 | Chat Provider/runtime；Chat 拥有列表、消息、生成、订阅、归档、删除 |
| 持久化 | 暂用 Chat SQLite 保存聊天、工具展示和文件差异；会话与持久化尚未统一设计 |
| PM 业务执行 | PM Fastify → 原应用服务/domain；不是第二个模型 Agent |
| 工具传输 | 同一注册表，MCP/CLI；九类 Provider 全部接入，Pi 使用工具扩展 |
| 认证与 scope | 转发当前 PM 请求认证，PM 重新验证成员、项目与原生能力；无新增工具凭据 |
| 结果可信度 | operationId、精确 revision、幂等键和原收据；未知结果只核对，不重派 |
| 文件记录 | 已登记 PM 核心文件前后快照及增改删；非 Git 目录可用，不冒充完整审计或已知操作者 |
| 完成语义 | Provider 回复/执行成功不代表 PM WorkItem 完成；不开放自动 Done |

### 1.1 统一 PM 工具接口

```text
GET  /api/v1/workspaces/:ws/agent-tools
POST /api/v1/workspaces/:ws/agent-tools/call
POST /api/v1/workspaces/:ws/agent-tools/result
GET  /api/v1/workspaces/:ws/agent-tools/core-files?projectId=PRJ-*
GET  /agent/api/pm-tools/threads/:threadId/calls
POST /agent/api/pm-tools/calls/:operationId/reconcile
GET  /agent/api/pm-core-changes
GET  /agent/api/pm-core-changes/:id
POST /agent/api/pm-core-changes/refresh
```

旧 PM 聊天线程/消息/grant 路由已退出。开发期迁移只清理旧 PM 聊天表，业务对象、审计、命令收据及既有 Chat 历史保留。scope 与目录分别核验，不把本地执行目录当作授权。文件观测在授权活动后轮询，重启后待新请求恢复；权限失效或不完整快照不推断文件删除。

17 个工具：

| 工具 | 类型 | 所需能力 | 边界 |
| --- | --- | --- | --- |
| `pm_query` | 读 | `domain.read` | 搜索授权项目/任务/文档，稳定 ID 分页，不返回完整正文 |
| `pm_read` | 读 | `domain.read` | 读取单个对象，带 revision，正文分段 |
| `pm_create_project` | 写 | `domain.read` + `planning.edit` | 仅 workspace scope；不改生命周期 |
| `pm_update_project` | 写 | `domain.read` + `planning.edit` | 普通字段，revision 精确匹配 |
| `pm_create_task` | 写 | `domain.read` + `planning.edit` | 授权项目内创建，使用原生初始工作流状态 |
| `pm_update_task` | 写 | `domain.read` + `planning.edit` | 普通字段；永不改状态 |
| `pm_create_document` | 写 | `domain.read` + `planning.edit` | 原生创建服务 |
| `pm_save_document` | 写 | `domain.read` + `planning.edit` | 精确 revision 保存正文 |
| `pm_read_comments` | 读 | `domain.read` | 有界分页读取任务评论 |
| `pm_create_comment` | 写 | `domain.read` + `intent.propose` | 以当前委托人身份走原生幂等命令 |
| `pm_read_relations` | 读 | `domain.read` | 仅返回两端都授权的关系 |
| `pm_add_relation` | 写 | `domain.read` + `planning.edit` | 两端 revision、合法关系、防环 |
| `pm_remove_relation` | 写 | `domain.read` + `planning.edit` | 只移除一条合法关系 |
| `pm_archive_task` | 写 | `domain.read` + `planning.lifecycle` | 只归档一个任务；不删除、不改状态 |
| `pm_restore_task` | 写 | `domain.read` + `planning.lifecycle` | 恢复一个已归档任务；普通字段与状态不变 |
| `pm_delete_task` | 写 | `domain.read` + `planning.lifecycle` | 仅永久删除已归档任务；原生引用/历史守卫仍生效 |
| `pm_transition_task` | 写 | `domain.read` + 目标状态能力 | 由原生工作流校验转换；完成/取消使用独立能力 |

明确不开放：Run/Host、跨项目移动、ACL、秘密、任意文件、shell；破坏性动作已接入逐动作审批，仍需人工批准。

### 1.2 Chat 与 PM 的其他交互点

| 交互 | 接口/行为 | 边界 |
| --- | --- | --- |
| 身份/工作区 | PM `GET /api/v1/auth/me`、`GET /api/v1/workspaces`、`POST /api/v1/auth/logout` | 只镜像 PM 身份，不建立第二套账号 |
| 工作区/项目目录册 | `GET /api/v1/agent-contexts` | 名称、项目、文件区域状态来自 PM；路径不可见时不泄露 |
| 执行作用域 | `POST /api/v1/agent-contexts/resolve` | 每次发送/Inspector 请求重新向 PM 解析；scope 不一致则拒绝 |
| 文件区域配置 | `PUT /api/v1/workspaces/:ws/agent-file-area`、`PUT /api/v1/workspaces/:ws/projects/:projectId/agent-file-area` | 优先级：已保存映射 → 已登记本地项目目录 → Chat Space 默认目录；不自动回退仓库根目录 |
| 默认保存根 | `GET/PUT /api/v1/workspaces/:ws/agent-storage-settings` | 只影响将来首次分配，不迁移已有目录 |
| Inspector | Agent `/api/files`、`/api/file`、`/api/git`、`/api/git/diff`、WS `/terminal` | 每次请求携带 PM scope；thread 绑定校验；不接受客户端 cwd；目录不是权限或沙箱 |
| 会话归档/删除/恢复 | Agent 线程状态；操作前用 PM 目录册核验原始 scope | 运行中不能归档/删除；无 scope 旧会话只读 |
| 自动化页签 | PM `/api/v1/workspaces/:ws/automations/*` | PM 规则、报告和 Worker；不调用 Agent 模型、Host 或外部连接器 |

Chat 先获得工作区/项目标识、目录和对象引用，再按需调用上述工具读取正文/revision。工具卡、来源、收据、未知结果核对和核心文件差异统一由 Chat 展示；Provider 接入不等于真实供应商已验收。

### 1.3 PM 自动化

PM 侧自动化是只读报告调度，不是 Agent Run：

- `GET/POST/PUT/DELETE /api/v1/workspaces/:ws/automations/rules`、`POST .../status`、`POST .../run`、`POST .../test`、`GET .../runs`、`GET .../runs/:id`、`GET .../receipts/:requestId`。
- 规则字段：`projectId`、`trigger`（manual/daily、IANA 时区）、`condition`（`all_open` / `overdue` / `blocked`）、`action: report`、`dailyLimit`、`cooldownMinutes`。
- Worker 执行到期规则；报告冻结当时配置、任务 ID/revision 和原对象链接；不改变任务状态。
- `capabilities.actions` 明确 `report` 可用，`model`、`host`、`external` 不可用。

---

## 2. agent-pm-studio 场景总览

> 第 2–6 节为统一前的历史场景差异，不是当前验收清单。当前统一的工具、会话和 UI 归属见第 1 节；Proposal、业务 Run、审批和自动完成等缺口没有随本次统一自动补齐。

| 来源 | 数量 | 说明 |
| --- | --- | --- |
| `integration-scenarios/01..36` | 36 | 原型中的联动产品场景，含 110 条双视口 Playwright 用例 |
| `integration-scenarios/PROACTIVE.md` | 24 | Project Pulse / Finding / 策略 / 确认与撤销 |
| `automations-*.spec.ts` | 25 | 自动化规则、运行工作台、对话、调度、安全、示例 |

外部来源：

- [36 个联动场景目录](../../../agent-pm-studio/integration-scenarios/)
- [PROACTIVE.md](../../../agent-pm-studio/integration-scenarios/PROACTIVE.md)

---

## 3. 36 个联动场景对照

| # | studio 场景 | 当前仓库对照 | 状态 |
| --- | --- | --- | --- |
| 01 | Issue 详情打开 Agent，编辑字段，关闭/重开/刷新 | PM 任务详情有 `EntityAgentPanelAction`；单例 `AgentPanel`，关闭后恢复焦点；任务字段由 PM 编辑器保存 | 已实现 |
| 02 | 自然语言创建 Issue，取消不建空任务，生成可编辑草稿后手动发布 | 有 `pm_create_task`，但 Full access + Auto approve 直接创建；没有可编辑候选/显式发布阶段 | 部分 |
| 03 | 选中标题/描述片段改写、缩短、扩写，before/after、拒绝、采纳、撤销 | 编辑器有选区，但 Agent 面板不上报选区；工具只支持整字段更新，无 diff/接受/撤销 | 未实现 |
| 04 | Agent 补充验收标准，确认前不变，写入原生验收字段 | `pm_update_task` 不暴露 acceptanceCriteria/checklist；只有整段 description 更新 | 未实现 |
| 05 | 从 Issue Dock 展开完整 Workspace，同 issueId/sessionId，不新建会话 | 侧栏和全页共用 `AgentConversation`、thread、任务选择和草稿；没有扫描/Run 结果 | 部分 |
| 06 | 返回 Issue 恢复任务、滚动位置、选区、输入焦点 | 关闭面板会恢复焦点；没有编辑器滚动位置和选区快照 | 部分 |
| 07 | 在 Issue 中申请 Coding Agent，批准后运行，刷新保留 Run，不自动 Done | 当前仓库明确没有 PM Run/Host/代码执行；独立 Agent Chat 的 CLI 运行不绑定 PM Issue | 范围外 |
| 08 | Run 结果回到 Issue，摘要/审阅标记/历史 Run | 没有 PM Run、审批或审阅标记 | 范围外 |
| 09 | 从 Agent 消息提取 Issue 草稿，保留 sourceSession | 可直接创建任务，但没有“消息→未发布草稿→保留来源”的流程 | 部分 |
| 10 | 在 Agent 输入框引用 Issue/Project，预览来源并发送类型化引用 | 有任务/项目选择器，消息只附加 ID 文本；没有 @ 引用、来源预览或自动加载正文 | 部分 |
| 11 | Issue 评论中 @Agent，生成分析回复与独立提案，拒绝不改字段 | 评论可读/可创建，但没有 @Agent 触发、提案或评论内 Agent 回复 | 未实现 |
| 12 | 将大型 Issue 拆成子任务，确认后创建带 parentId 的真实 Issue | `pm_create_task` 不支持 parentId；关系工具只能在任务创建后追加 parent，且没有批量候选 | 未实现 |
| 13 | 一次生成多个 Issue 草稿，编辑/删除/选择后只发布选中项 | 工具一次创建一个任务，没有多草稿/选择集合 | 未实现 |
| 14 | 批量修改已有 Issue，逐项预览、采纳/拒绝 | 工具一次一个对象，没有批量 scope、逐项预览或审批 | 未实现 |
| 15 | 一个 Issue 关联多个 Agent Sessions，历史 Session 保留原 Run | PM 线程不绑定 Issue，也没有 Issue→Session 关系；独立 Agent Chat 会话只绑定工作区/项目 | 部分 |
| 16 | Dock 与完整 Workspace 共享会话、消息和未发送草稿 | 共享 `AgentConversation` 与 thread，展开保留任务/草稿/思考程度；没有原型四个中央标签 | 部分 |
| 17 | 从 Board 批量选择任务交给 Agent，侧栏非模态，停止后保留现场 | PM 任务集合只有入口跳转，没有看板多选 scope 或批量 Agent 操作 | 未实现 |
| 18 | 从项目目标生成开发计划，编辑里程碑/依赖/父子，审核后创建 | 无 Planning Canvas、候选计划或批量创建；工具只能单对象写入 | 未实现 |
| 19 | 自动查找重复/相关 Issue，确认后写 relatedIds | `pm_query` 可搜索，`pm_add_relation` 可写 `related_to`；无自动分析/候选确认 | 部分 |
| 20 | 分析依赖，拒绝不存在/环，确认后写合法依赖 | `pm_read_relations`、`pm_add_relation`、`pm_remove_relation` 有双端 revision 和防环；无预览 UI | 部分 |
| 21 | 审查 Run 的 Diff / Test / PR 草稿，人工记录审阅 | 无 PM Run/Diff/Test/PR；独立 Agent Chat 的 Git 面板不关联 PM Issue | 范围外 |
| 22 | 从失败 Run 起草 Bug，保留 source.kind=run 和原任务 | 无失败 Run 或来源化草稿 | 范围外 |
| 23 | 在 PM Documents 中使用 Agent 改写，预览/拒绝/接受/撤销 | `pm_save_document` 可按 revision 保存正文；无选区、before/after、接受/撤销 | 部分 |
| 24 | Agent 总结项目进度和风险，来源可展开，只读 | `pm_query`/`pm_read` 可读取项目、任务、文档并生成只读总结；没有 Run/文档证据和结构化来源卡 | 部分 |
| 25 | Agent 执行失败/停止/重试，新旧 Run 独立 | PM Agent 聊天有停止/未知核对，但没有 Coding Run、审批或重试 | 范围外 |
| 26 | 刷新、断线、重连，不自动重放，不伪报成功 | PM 聊天有持久消息、断线核对、显式 cancel 和 unknown 状态；没有 Run 级恢复 | 部分 |
| 27 | 权限/人工审批：拒绝、撤权、恢复、批准 | 有原生 ACL、scope、撤销和 Full access 检查；没有逐动作审批或 Inbox | 部分 |
| 28 | 双标签版本冲突，旧提案被拒绝，不覆盖新内容 | 工具写入使用精确 revision/CAS，冲突返回错误；不会自动覆盖 | 已实现 |
| 29 | 多个 Agent 并行处理不同任务，独立停止/结果 | 不同线程可并行；没有 Run/审批/任务级并行模型 | 部分 |
| 30 | 统一 Inbox/Activity，通知可跳到正确 Issue/Run | PM 有通知收件箱和活动记录；没有 Agent 提案/Run 通知或审批收件箱 | 部分 |
| 31 | 任务关闭/归档/删除后保留 Session/Run 历史并可恢复 | PM Agent 线程不绑定任务生命周期；Agent Chat 的归档/恢复不关联 PM Issue | 未实现 |
| 32 | 桌面布局：四个 Agent 侧栏同宽、非模态、看板不重叠 | 桌面 PM 侧栏为 380px 非模态，900px 以下变抽屉；没有看板 AI 侧栏和四区域一致性 | 部分 |
| 33 | 模型/权限/服务不可用的空态与恢复，不自动造 Run | PM 聊天对模型未配置、权限、工具不可用有明确状态；没有 Run 空态和恢复 | 部分 |
| 34 | 跨项目移动任务，重查权限，保留 Session/Run 身份 | Agent 工具明确禁止跨项目移动；原生 PM 也没有 Agent 驱动的移动流程 | 范围外 |
| 35 | 大数据边界：1200 Issues、240 消息、40 Session/Run 按需加载 | PM 有分页、正文分段和工具输出上限；没有 40 Run 历史，也未按原型规模验收 | 部分 |
| 36 | 跨界面审计与版本安全撤销 | 核心写入有审计/收据；没有 Agent 侧 guarded undo 或文档撤销 | 部分 |

**36 场景统计**：已实现 2；部分 19；未实现 9；范围外 6。

---

## 4. 24 个 Proactive 场景对照

当前仓库没有 Finding 引擎、Project Pulse、观察策略、统一待审收件箱或 Level 1/2/3 主动策略。PM 自动化只做 `all_open` / `overdue` / `blocked` 的只读报告；它不读取 Session/Run/Diff/PR/测试，也不生成原生 pending 提案。因此除“每日摘要”有相邻的定时报告能力外，其余场景均未实现。

| # | studio 触发或结果 | 当前仓库对照 | 状态 |
| --- | --- | --- | --- |
| 01 | 新 Issue 与已有任务相似 → 关联字段提案 | 可用 `pm_query` 搜索，但没有 Finding/相似度分析/提案 | 未实现 |
| 02 | 内容更新缺少验收/范围/依赖 → 字段补全提案 | 无内容完整性规则或 pending 提案 | 未实现 |
| 03 | 开放任务 7 天无活动 → 跟进备注提案 | 自动化不读取活动/评论/Session 时间，只按状态/截止/阻塞过滤 | 未实现 |
| 04 | 依赖全部 Done → 从 Backlog 排入 Todo 建议 | 无状态迁移建议或依赖完成观察 | 未实现 |
| 05 | 同版本 Run 测试通过 → 人工送审建议 | 无 Run/测试/报告 | 未实现 |
| 06 | 依赖或修改范围交叉 → 协调任务草稿 | 无范围/Diff 分析 | 未实现 |
| 07 | Run 成功 → 来源化活动与总结文档 | 无 Run；Agent 可写文档但没有自动活动投影 | 未实现 |
| 08 | 失败 Run → 带原始证据的调查草稿 | 无 Run/日志/调查草稿 | 未实现 |
| 09 | 空闲 Session 有未解决事项 → Issue 草稿 | 独立 Agent Chat 有会话，但不自动分析或生成 PM 草稿 | 未实现 |
| 10 | PR 快照与验收缺口 → 验收补充草稿 | Agent Server 有 GitHub PR Watch，但不接入 PM Issue/验收 | 未实现 |
| 11 | 并行 Run 时间重叠、Diff 交叉 → 协调任务 | 无并行 Run/Diff | 未实现 |
| 12 | 多次 Run 同名失败 → 共同假设/执行审批 | 无 Run/失败聚类/审批 | 未实现 |
| 13 | 对话有决策标记 → 决策文档 | 无对话观察或决策提取 | 未实现 |
| 14 | Diff 超出声明范围 → 范围复核草稿 | 无 Diff/范围基线 | 未实现 |
| 15 | 需求变更影响下游 → 影响分析文档 | 无需求版本/下游影响分析 | 未实现 |
| 16 | 多 Session 重复技术主题 → 知识文档 | 无跨会话主题分析 | 未实现 |
| 17 | 不同 Issue 共享失败 → 共性调查任务 | 无失败聚类 | 未实现 |
| 18 | 阶段完成且有下游 → Planning 草稿 | 无 Planning 草稿或主动规划 | 未实现 |
| 19 | 首次访问/UTC 新日 → 变化、失败、待审摘要 | PM 自动化可定时生成只读 overdue/open/blocked 报告；没有“变化/失败/待审”聚合或水位去重 | 部分 |
| 20 | 项目 14 天无进展且有阻塞 → 调查草稿 | 自动化的 `blocked` 条件只检查当前阻塞，不判断 14 天无进展 | 未实现 |
| 21 | 里程碑、未完成任务、失败测试 → 发布风险文档 | 无里程碑/测试/Run 综合分析 | 未实现 |
| 22 | 再次访问晚于上次访问 → Since You Left 摘要 | 无访问水位或跨次摘要 | 未实现 |
| 23 | 目标、未完成目标、近期文件变化 → 下一步规划 | 无文件变化/目标偏离分析 | 未实现 |
| 24 | 目标任务、完成依赖、遗留 → 下一步规划 | 无主动规划候选 | 未实现 |

**24 场景统计**：已实现 0；部分 1；未实现 23。

Level 1/2/3 对照：

- studio Level 1：自动观察/建议，人工确认后写入。当前 PM 自动化只有定时只读报告，没有 Finding 或确认写入。
- studio Level 2：自动准备原生 pending 字段提案。当前没有 pending 提案模型。
- studio Level 3：明确不可用。当前仓库同样没有隔离执行器，不能提供自主执行。

---

## 5. 25 个自动化场景对照

`agent-pm-studio` 的自动化包含规则总览、对话模式、运行工作台、变更审核/撤销、示例项目、Pulse 联动等。当前 PM 自动化是较窄的“规则 + 只读报告 + Worker 调度 + 运行历史”，没有对话、变更应用、审核收件箱或示例项目。Agent Server 的 `/api/automation/schedules|watches|recovery` 是另一套定时 Agent 运行/GitHub PR Watch，不是这里的 PM 自动化。

| # | studio 自动化场景 | 当前仓库对照 | 状态 |
| --- | --- | --- | --- |
| 01 | 自建规则：只读测试 → 启用 → 自然编辑 → 带来源发现 → 人工预览/应用 | 规则创建、测试、启停、手动运行、只读报告可用；无 Finding/变更应用 | 部分 |
| 02 | 新建取消/丢弃无残留；草稿与完整配置刷新保留 | 有规则草稿和离页保护；未核对原型式取消/丢弃语义 | 部分 |
| 03 | 编辑使测试失效；复制配置为独立草稿，不隐式执行 | 没有测试凭证/失效模型，也没有复制规则 API | 未实现 |
| 04 | 空范围/无效表达式绝不扩大到全项目；有效零匹配保留真实历史 | 规则按显式 `projectId` 和枚举条件执行，无表达式扩大面；零匹配生成真实报告 | 已实现 |
| 05 | 已归档、未发布草稿、其他项目不进入范围 | 规则按项目；归档项目禁止启用/运行；PM 自动化不读取草稿 | 已实现 |
| 06 | 只读项目可测试但禁止保存/启用/领域写入 | 测试只要求 `domain.read`；保存/启停/运行要求 `planning.edit` | 已实现 |
| 07 | 其他标签修改来源后旧测试不能启用，需重新测试 | 没有测试凭证；启用使用当前快照而不是旧测试结果 | 未实现 |
| 08 | 两标签编辑同一规则，revision 冲突保留本地输入 | 规则更新使用 `expectedRevision`，冲突返回 409 | 已实现 |
| 09 | 权限/来源守卫变化后旧动作不能提交 | 没有待提交动作或精确审批模型 | 未实现 |
| 10 | 暂停不重放；重新测试恢复；冷却、每日上限真实限制执行 | 暂停清空 `nextDueAt`；`dailyLimit`、`cooldownMinutes` 和预算记录已实现 | 已实现 |
| 11 | 仅通知输出无动作；独立规则不合并同源发现 | 只有只读报告，没有通知/发现合并 | 部分 |
| 12 | 按 IANA 当地日历执行，不按浏览器 UTC 猜测 | 规则保存 IANA 时区，Worker 按当地日期计算 | 已实现 |
| 13 | 关闭页面错过每日执行不补跑 | README 明确跨日错过记为跳过，不补发历史批次 | 已实现 |
| 14 | DST 回拨重复分钟每天至多一次 | README 明确重复时刻使用第一次 | 已实现 |
| 15 | DST 不存在时刻跳过；错误时区不能保存/启用 | 时区用 `Intl.DateTimeFormat` 校验；缺失时刻跳过 | 已实现 |
| 16 | 手动重复检查同一快照不重复发现/待审写入 | 每次手动运行生成独立报告；没有 Finding 去重 | 未实现 |
| 17 | 显式依赖可作只读证据，写入只命中表达式范围 | 无表达式筛选；依赖分析不在自动化中 | 未实现 |
| 18 | 模板只是配置起点；缺失 PR/Webhook/自动执行能力明确不可用 | 无模板；`capabilities.actions` 明确 model/host/external 不可用 | 部分 |
| 19 | 对话只在正式运行创建；继续对话保留旧消息与不可变配置快照 | 没有对话模式或自动化对话记录 | 未实现 |
| 20 | 跨项目对话不能继续；缺失目标不静默创建替代 | 没有自动化对话 | 未实现 |
| 21 | 历史筛选保留已删除规则；输入快照不可变；隔离其他项目 | 删除规则保留历史运行；运行保存 `config`/`ruleRevision`；按 workspace/actor 和项目权限读取 | 已实现 |
| 22 | 示例预览不写入；打开后有真实结果、连续对话、跳过与 Pulse 来源 | 无示例项目、Pulse 或对话 | 未实现 |
| 23 | 示例重复打开/刷新保留编辑、历史和原项目未保存表单 | 无示例项目 | 未实现 |
| 24 | 能力关闭时示例不能绕过权限或伪造结果 | 无示例；真实能力已按 `canWrite`/scheduler 状态限制 | 部分 |
| 25 | 运行工作台：活动流、右栏审核、应用/撤销、审阅备注、待审核入口 | 只有运行历史/详情；没有变更审核、应用、撤销或备注 | 未实现 |

**25 场景统计**：已实现 10；部分 5；未实现 10。

---

## 6. 差异结论

### 6.1 已经真正对齐的部分

- PM 原生助手的“任务详情侧栏 + 全页共享会话/任务/草稿”与原型 01/16 的核心会话连续性方向一致。
- 精确 revision、幂等命令、收据和未知结果核对覆盖原型 28/36 的版本与审计基础。
- PM 自动化的时区、每日上限、冷却、暂停不补跑、DST、历史快照和只读报告覆盖原型自动化 04/05/06/08/10/12/13/14/15/21。
- 独立 Agent Chat 的 scope 解析、文件区域、Inspector、会话归档/恢复属于当前仓库自己的产品能力，但不等同于 studio 的 Issue Session/Run 场景。

### 6.2 主要缺口

- **候选/提案层**：自然语言建任务、批量修改、拆分、规划、文档改写都缺少“生成候选 → 预览 → 人工确认 → 应用/撤销”。
- **Issue 级会话与 Run**：当前 PM 线程不绑定 Issue，也没有 Run/审批/审阅/Diff/Test/PR。
- **选择与上下文**：没有编辑器选区上报、@Issue/@Project 类型化引用、服务端按引用加载正文。
- **看板批量操作**：没有多选 scope、逐项跟踪、批量确认。
- **主动发现**：没有 Finding、Pulse、观察策略、Level 1/2/3、统一审批收件箱。
- **自动化工作台**：没有自动化对话、变更应用/撤销、审核收件箱、示例项目。
- **生命周期关联**：任务关闭/归档/移动不会自动影响 PM Agent 线程；Agent Chat 的归档/恢复也不绑定 Issue。

### 6.3 不应直接按原型补齐的部分

`agent-pm-studio` 的 07/08/21/22/25/34 以及 Proactive 的大部分场景依赖真实 Run、Host、代码执行、Diff/Test/PR、审批和隔离运行器。当前仓库的 `README.md` 和 `agent-capability-integration-plan.zh.md` 明确把这些排除在现有范围之外；不能因为原型有 DEMO Controller 就把它们当作已实现或默认后续阶段。

---

## 7. 源码与文档依据

- 统一 Agent 的工具桥：`apps/server/pm/src/agent-tool-routes.ts`、`agent-chat-tools.ts`、`packages/application/src/agent-chat-tools.ts`、`apps/server/agent/src/pm-tools.ts`、`packages/agent-contracts/src/pm-tools.ts`。
- PM 页面入口与共享侧栏：`apps/web/src/features/pm/agent/`、`pm-shell.tsx`、`markdown/EntityDetail.tsx`、`markdown/TaskCollectionControls.tsx`。
- 独立 Agent Chat 的 PM scope/文件区域：`apps/server/pm/src/agent-file-area-routes.ts`、`packages/application/src/agent-file-areas.ts`、`agent-storage.ts`。
- Agent Chat 的 scope 解析与执行：`apps/server/agent/src/durable/agent-scope.ts`、`chat-runtime.ts`、`chat.ts`。
- Inspector：`apps/server/agent/src/inspector/`、`apps/web/src/features/agent/src/pm/inspector.tsx`。
- PM 自动化：`apps/server/pm/src/automation-routes.ts`、`packages/application/src/automation.ts`、`automation-report.ts`、`packages/infrastructure/migrations/0034_automation.sql`。
- 现行文档：`README.md`、`docs/implementation/agent-capability-integration-plan.zh.md`、`docs/implementation/agent-page-areas-integration-plan.zh.md`、`docs/implementation/backend-delivery.md`、`V3-AGENT-CHAT-TASKS.zh.md`、`EXECUTION-PLAN.zh.md#automation-page-delivery`。

## 8. 目标形态：独立 Agent Chat 合并为 PM 原生助手

本节保留早期目标讨论及 8.9 的前端记录，不是本次实施合同。工具、运行时和界面归属已按 [统一改造计划](agent-chat-pm-unification-plan.zh.md) 切换；下面的 ChangeSet、业务执行、审批和未来分期不因此获得实施授权。

### 8.1 联动场景清单

#### 8.1.1 读取与上下文

| 场景 | PM 原生助手当前 | 独立 Agent Chat 当前 | 目标设计 |
| --- | --- | --- | --- |
| 按项目/状态/关键词搜索任务 | 可用：`pm_query` | 不可用 | Composer `@` 搜索，结果按当前 PM scope 过滤 |
| 读取任务详情、正文、revision | 可用：`pm_read` | 不可用 | 引用后由服务端加载当前正文，不在前端缓存正文 |
| 读取任务评论 | 可用：`pm_read_comments` | 不可用 | 对话内展开评论来源，保留作者/版本 |
| 读取关系、父子、依赖 | 可用：`pm_read_relations` | 不可用 | 关系图/依赖列表作为 Issue 上下文卡 |
| 汇总项目进度、风险、阻塞 | 部分：可读任务/文档，无 Run 证据 | 不可用 | 只读摘要卡，标注实际来源和缺口 |
| 把当前 Issue 作为对话上下文 | 部分：只附加任务/项目 ID | 不可用 | 固定 Issue 引用，服务端解析最新快照 |

#### 8.1.2 生成与拆解

| 场景 | PM 原生助手当前 | 独立 Agent Chat 当前 | 目标设计 |
| --- | --- | --- | --- |
| 自然语言生成单个任务 | 可用：`pm_create_task` 直接创建 | 不可用 | 先生成可编辑草稿，再显式发布 |
| 生成任务草稿、预览后发布 | 不可用 | 不可用 | `proposal/draft` 状态，确认前不写 PM |
| 一次生成多个任务并选择发布 | 部分：可多次调用，无批量候选 | 不可用 | 批量候选表，逐项勾选/编辑/删除 |
| 将大任务拆成子任务 | 部分：可建任务后加 `parent` 关系 | 不可用 | 拆解候选树，确认后一次创建并写 parentId |
| 从对话/评论/文档生成任务 | 部分：可创建，但无来源草稿 | 不可用 | 保留 sourceMessage/sourceDocument 引用 |
| 生成验收标准/checklist | 不可用 | 不可用 | 验收标准作为结构化字段候选，不写 description |
| 从失败执行生成 Bug/调查任务 | 不开放 | 不可用 | 需要 Run 失败事实和来源证据，不能凭空生成 |

#### 8.1.3 修改、删除与生命周期

| 场景 | PM 原生助手当前 | 独立 Agent Chat 当前 | 目标设计 |
| --- | --- | --- | --- |
| 修改标题、描述、负责人、优先级、日期、标签 | 可用：`pm_update_task` | 不可用 | 变更集预览 + 逐项确认 |
| 修改状态、完成、重开 | 不开放：工具永不改状态 | 不可用 | 独立生命周期动作，需当前能力和人工确认 |
| 修改验收标准/checklist | 不可用 | 不可用 | 结构化字段 diff，不使用整段正文覆盖 |
| 添加/删除父子、阻塞、依赖、相关关系 | 可用：`pm_add_relation` / `pm_remove_relation` | 不可用 | 双端 revision 和防环结果在变更集中展示 |
| 批量修改多个任务 | 不可用 | 不可用 | 批量 scope + 每项独立 revision/结果 |
| 跨项目移动任务 | 不开放 | 不可用 | 不交给 Agent；保留原生人工流程 |
| 编辑或删除已有评论 | 不可用 | 不可用 | 只允许创建新评论；历史评论不静默修改 |
| 删除任务、归档、取消 | 不开放 | 不可用 | 破坏性动作单独确认；删除不自动执行 |

#### 8.1.4 执行与反馈

| 场景 | PM 原生助手当前 | 独立 Agent Chat 当前 | 目标设计 |
| --- | --- | --- | --- |
| 选中 Issue 后启动 Coding Agent/Run | 不开放 | 部分：可跑 CLI，但不绑定 Issue | Issue → Run 请求，绑定 project/task/session |
| 执行前生成计划并人工确认 | 不开放 | 不可用 | 计划卡 + 逐项动作授权 |
| 提交任务/Session/权限审批 | 不开放 | 不可用 | 审批收件箱，参数摘要绑定 operationId |
| 查看运行状态、日志、Diff、测试 | 不开放 | 部分：输出/Git 面板不关联 Issue | 运行详情挂到 Issue，结果只读展示 |
| 执行成功后回写评论/摘要 | 部分：可人工让模型写评论 | 不可用 | 结果卡“写回评论/任务”显式操作 |
| 执行失败后创建 Bug/后续任务 | 不开放 | 不可用 | 失败事实 → 未发布草稿，保留来源 Run |
| 取消、重试、并行执行 | 部分：只能取消聊天生成 | 部分：会话级取消/继续 | 取消以服务端 Run 状态为准；重试新建 Run |

#### 8.1.5 协作与治理

| 场景 | PM 原生助手当前 | 独立 Agent Chat 当前 | 目标设计 |
| --- | --- | --- | --- |
| 在任务下写进度评论 | 可用：`pm_create_comment` | 不可用 | 结果卡内直接创建评论 |
| 通知负责人/关注者 | 不可用 | 不可用 | 复用 PM 通知事实，不另建通知体系 |
| 评论中 `@Agent` 触发分析 | 不可用 | 不可用 | 评论事件 → 明确 Agent 会话，不自动写字段 |
| 一个 Issue 关联多个 Session | 部分：线程不绑定 Issue | 部分：线程只绑定工作区/项目 | Issue 侧栏展示 Session 列表，可切换/新建 |
| 提案审阅、接受、拒绝、撤销 | 不可用 | 不可用 | 统一 Proposal/ChangeSet，不接受模型自报成功 |
| scope/权限/授权到期 | 可用 | 部分：只用于目录解析 | 合并后统一使用 PM 原生 ACL 和工具 scope |
| 审计、收据、未知结果核对、幂等 | 可用 | 不可用 | 所有 PM 写入带 commandId/revision/receipt |

### 8.2 界面适配原则

建议把合并后的界面理解为三层，而不是在 PM 页面上再加一个聊天框：

| 层 | 位置 | 职责 |
| --- | --- | --- |
| PM 上下文层 | 左侧栏 + Composer 上方 | 当前工作区/项目、固定 Issue、引用集合、批量选择 |
| 对话执行层 | 中央 Thread | 消息、工具调用、变更集、运行状态、审批与结果 |
| 工具/检查层 | 右侧 Inspector | Files、Git、Terminal、Browser；可增加只读 PM 详情 |

不要复制 PM 的完整项目导航。侧栏只保留“会话 + 当前 PM 上下文”；进入完整 PM 页面仍使用明确链接。

### 8.3 Issue 引用

1. **入口**：Composer 输入 `@` 打开 Issue 选择器；选择器默认限定当前工作区和项目。跨项目引用必须显式切换项目，不能默认扫描整个工作区。
2. **引用载荷**：消息只保存 `{ kind: 'issue' | 'project' | 'document', id, projectId, revision? }`，不保存正文、标题快照或模型可伪造的权限字段。
3. **服务端解析**：发送时用当前用户身份重新读取授权对象；返回 `available / stale / forbidden / deleted` 状态。不可用引用阻止发送，或要求用户明确移除。
4. **界面表现**：Composer 内显示 chip，例如 `TASK-102 · 修复登录 · r7`；消息内保留同一 chip，点击打开 PM 对象。消息展开区显示“实际发送给模型的来源”和读取时间。
5. **写入语义**：若引用用于修改，必须固定所选 revision；服务端返回冲突时展示当前值和用户草稿，不自动重放。

### 8.4 批量引用

- **选择语义**：区分“全部筛选结果”“当前已加载项”“手动勾选项”。界面始终显示三个数量，不能把分页加载当成完整集合。
- **范围限制**：默认同一项目；跨项目需显式添加项目并分别校验权限。草稿、归档、已删除和不可见对象不进入选择集。
- **批量上限**：建议单次对话最多 20 个显式引用；超过时要求缩小筛选或分批，不静默截断。
- **消息表现**：Composer 上方显示 `已引用 12 个任务 · 来自筛选`；消息内折叠为摘要，展开后逐项显示 ID、标题、revision、状态。
- **执行表现**：批量读取可以一次发送；批量写入必须逐项展示 revision 和结果，不能用一个“成功”覆盖部分失败。

### 8.5 对话区修改状态

建议引入统一的 **ChangeSet / 变更集**，不要只显示工具名和一段模型文字。

```text
proposed → approved → queued → running → applied
                                      ↘ failed
                                      ↘ conflict
                                      ↘ unknown
                                      ↘ reverted
```

每个变更集至少展示：

- 操作类型：创建、更新、评论、关系、删除/归档、状态转换。
- 目标对象：`TASK-102`、项目、评论或关系两端。
- Before → After：仅显示实际变化字段；正文显示 diff。
- 授权依据：当前 scope、grant、审批方式、revision。
- 结果：commandId/收据、时间、操作者、失败码。
- 异常：`conflict` 保留双方内容；`unknown` 必须持续显示并提供“核对原操作”，不能改成成功。

批量变更集使用“摘要 + 展开逐项”结构：顶部显示 `3 项已应用 · 1 项冲突 · 2 项待确认`，展开后每项独立状态。删除、归档、完成、跨项目移动使用明显的破坏性样式，并保持独立确认。

### 8.6 侧栏 PM 展示

推荐左侧栏保留现有工作区/项目/会话分组，在每个项目下增加一个可折叠的 **PM 上下文** 区，而不是另造一个 PM 侧栏：

- **当前 Issue**：固定显示当前入口任务，包含标题、状态、优先级、负责人和“在 PM 打开”。
- **最近/我的 Issue**：按最近更新或当前负责人列出少量任务，支持搜索；点击后作为引用或当前上下文。
- **批量选择**：任务行提供复选框；选择集显示数量、项目和“清除/引用”操作。
- **变更摘要**：显示当前会话最近变更集数量、待确认、冲突和未知；点击滚动到对应消息。
- **会话分组**：原有 Session 分组保留；Issue 只是上下文，不替代会话列表。
- **右侧 Inspector**：继续承载 Files/Git/Terminal/Browser；可增加一个只读“PM 详情”标签，避免左侧栏同时承担完整对象详情。

### 8.7 合并的技术前置

UI 之前必须先解决四项：

1. **PM 工具桥接**：Agent Server 不能直接拿浏览器传入的 actor 调 PM；需要服务端到服务端、带当前用户授权上下文的工具接口，或把 17 个工具迁到 PM 原生运行时。
2. **线程身份统一**：当前 PM 助手线程在 PostgreSQL，独立 Agent Chat 在 SQLite。合并后必须选定唯一权威线程存储，或建立稳定映射；否则 Issue 引用、变更集和会话恢复会出现两套 ID。
3. **Issue 级会话关系**：线程需要可选绑定 `workspaceId/projectId/taskId`，并支持一个 Issue 多个 Session、切换历史、新会话不继承旧授权。
4. **破坏性动作策略**：删除、归档、完成、跨项目移动不应复用普通 `auto_approve`；需要独立能力、显式确认和审计。

### 8.8 建议分期

| 阶段 | 内容 | 不做什么 |
| --- | --- | --- |
| P1 | `@Issue` 引用、当前 Issue 固定、只读上下文卡 | 不写 PM、不批量修改 |
| P2 | 任务草稿/批量候选、显式发布、普通字段变更集 | 不自动完成、不删除 |
| P3 | 批量引用、逐项结果、冲突/未知状态 | 不跨项目移动 |
| P4 | Issue → Run 请求、审批、状态/日志/Diff 回显 | 不自动 Done |
| P5 | 结果写评论、失败转草稿、通知/审计 | 删除/归档最后单独评估 |

### 8.9 当前前端实现（2026-10-29）

| 能力 | 实现文件 | 当前行为 |
| --- | --- | --- |
| PM 任务目录 | `pm-issue-workspace.tsx`、`pm-types.ts` | 通过 PM `GET /entities?kind=work_item` 读取真实授权任务；按当前工作区/项目加载，客户端过滤搜索 |
| 侧栏 PM 上下文 | `pm-sidebar-context.tsx`、`pm-sidebar-section.tsx` | 组件保留但已从侧栏关闭，不再挂载；Issue 选择仍通过 Composer “引用任务”进入 |
| Issue 选择器 | `pm-issue-picker.tsx`、`pm-issue-picker-host.tsx` | 共享多选弹层，支持搜索、全选当前结果、清除、加载更多；不伪造任务 |
| Composer 引用 | `pm-reference-tray.tsx`、`pm-composer-references.tsx` | 显示引用 chip；当前“插入到输入”写入 `引用任务：@TASK-...` 文本，等待结构化引用后端 |
| 对话区变更状态 | `pm-change-set.tsx`、`pm-change-model.ts` | 对 `dynamic_tool` 的 `pm_*` 工具项显示状态卡；已有 `PmToolCard` 继续消费 `/api/pm-tools` 记录 |
| 侧栏 PM 变更摘要 | `pm-sidebar-context.tsx` | 预留 `PmChangeSet[]` 输入并显示计数/最近摘要；后端尚未接入时显示真实空态 |

仍未实现：结构化引用载荷、引用服务端解析与 stale/forbidden 状态、写入/删除/审批/Run。PM 工具桥已由并行后端提供（Agent `/api/pm-tools`、PM `/agent-tools`），前端已消费工具记录；写入、删除和执行策略仍待对应能力。前端不会把这些显示为已完成。

P0 接口实现与验证记录见 [Agent Chat ↔ PM 接口接入计划](agent-pm-interface-plan.zh.md)。

## 9. 维护规则

- 本文的状态以源码和可执行接口为准，不把原型、旧场景矩阵或目标设计自动升级为现状。
- 修改 17 个工具、授权 scope、SSE 事件、文件区域优先级或自动化条件时，必须同步更新本文对应表和受影响场景。
- 新增 studio 场景时，先判断它属于 PM 原生助手、独立 Agent Chat、PM 自动化还是新的系统；不能把不同系统的能力混成一条完成声明。
- 第 8 节包含目标设计；其中 8.9 记录当前前端实现，后端工具、写入和执行能力仍以源码为准。
