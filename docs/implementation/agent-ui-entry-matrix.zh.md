# Agent 界面接入：页面元素矩阵

记录日期：2026-10-25。来源：`EXECUTION-PLAN.zh.md` 第 2 节「页面接入矩阵」及 2.1–2.3。该计划的目标实施目录为 `../project-management-agent`；本文只固化“哪些页面需要增加 Agent 元素、加什么、边界是什么”，不表示本副本已交付下列全部入口（本副本当前状态见第 6 节）。

## 1. 总览

需要接入 Agent 元素的页面分三类：

| 类别 | 页面 |
| --- | --- |
| 原页面增量入口（不替换原内容） | 项目列表、项目详情、任务集合、任务/实体详情、文档、设置中心 |
| 同壳新增 Agent 页面 | 对话、运行记录、待审建议、主动发现、自动化 |
| 宿主与导航 | `routes.tsx` 新路由、`pm-shell.tsx` 可折叠 “Agent” 分组 |
| 明确不加 | 首页 / Dashboard |

统一约束：新增能力是次级操作，原“新建任务”“保存”等主按钮地位不变；模型输出只是候选，不自动写业务数据；原页面结构、品牌、主题、导航顺序、草稿恢复和 URL 语义不改变。

## 2. 原页面需要增加的 Agent 元素

路由相对 `/pm/:workspaceId`。

| 页面 / 路由 | 增加的 Agent 元素 | 数据与边界 |
| --- | --- | --- |
| `projects`、`projects/:projectId` | 项目上下文 “Agent 助手” 入口（次级操作） | 使用固定授权项目；不替换项目概览、项目视图导航、文件或动态 |
| `issues`、`projects/:projectId/issues` | Agent 辅助入口，可携带当前项目 | 建议先预览、再显式创建；未选项目时必须先选授权项目，不默认绑定第一个项目；原生幂等与失败恢复 |
| `entities/:id`、`projects/:projectId/entities/:id` | 按需 Agent 侧栏（`AgentPanel`、`AgentContextBar`）、相关运行链接 | 固定实体 ID 与来源 revision；旧 revision 建议拒绝覆盖；不覆盖标题、属性、Markdown、评论的既有编辑 |
| `documents` / 文档详情 | 同一个 Agent 侧栏，支持解释与改写建议（`ProposalPreview`） | 展示 before/after 差异；不自动保存正文；复用现有 Markdown 编辑器与保存/revision 语义 |
| `settings` | 新增 `settings/agent` 子页（`AgentCapabilityStatus`） | 遵循原设置中心布局，展示服务端模型/Host 能力、最近探测结果与管理员配置说明；前端不保存 API key；配置、可达、执行就绪分开展示 |

任务集合未选项目时，先选授权项目才能生成可落地提案。任务或文档详情固定其实际项目，不允许通过面板选择器悄悄改归属。

## 3. 新增 Agent 页面

均位于同一 PM 外壳 `/pm/:workspaceId` 下，不新增 Studio 根应用、不嵌套 iframe。

| 路由 | 页面内容 | 关键组件 |
| --- | --- | --- |
| `agent` | 对话工作台：窄会话列表 + 主消息区 + 按需上下文/提案检查区；持久对话、流式输出、停止生成、失败与未知请求状态 | `AgentConversation`、`AgentContextBar`、`ProposalPreview` |
| `runs` | Session/Run 列表与独立详情 URL：摘要、阶段、步骤/日志、错误、取消/核对、成果；Run 状态与任务状态分开展示 | `RunStatus`、`RunTimeline`、`OperationApproval`、`RunArtifacts` |
| `proposals` | 待审列表、before/after、作用对象与来源 revision、应用/拒绝/撤销；冲突时保留提案，不基于最新版本自动重做并应用 | `ProposalPreview` |
| `pulse` | 主动发现列表、来源、观测时间、依据、`FindingDetail`、人工处置/转提案；无可信来源时显示禁用原因，不放演示数据 | `FindingDetail`、`ProposalPreview` |
| `automations`（Agent Chat 视图） | 规则列表、编辑表单（触发条件、时区、范围、预算、动作）、测试、启停、运行历史；浏览器不是调度器 | `AutomationPage` / `AutomationHistory` |

页面布局要点：

- 对话页使用原 PM 顶栏，不再出现第二个工作区侧栏。
- 运行页保留独立 URL，刷新后复读同一 Run。
- 待审页确认前显示作用对象，冲突时不能“自动按最新版本重做并应用”。
- 自动化页保存规则不自动运行；启用前校验实际配置。
- 设置页不承诺 Provider 账号管理、CLI 登录或自动切换模型。

## 4. 宿主与导航改动

| 位置 | 允许的最小改动 | 禁止改动 |
| --- | --- | --- |
| `apps/web/src/routes.tsx` | 增加 Agent 路由、详情深链与懒加载 | 用 Studio 路由替换根路由、修改旧深链语义 |
| `apps/web/src/features/pm/pm-shell.tsx` | 增加一个可折叠 “Agent” 分组：对话、运行记录、待审建议、主动发现、自动化；放在原工作区入口之后、项目树之前 | 重写侧栏、品牌、顶栏、工作区切换器和外观菜单；重排既有个人入口和项目树 |
| `service/settings` | 新增一个遵循原布局的 Agent 设置页 | 另造设置中心；前端保存模型密钥 |
| 原 `views/pm`、全局主题与样式 | 默认不改；新能力从适配层组合，局部 CSS 模块或命名空间 | 为迁入 Studio 全局 CSS 调整原页面结构 |

模型与执行设置归原设置中心，不在侧栏新增第二个顶级设置入口。默认不弹侧栏、不改变首页偏好；跨工作区切换释放请求/缓存；未保存草稿沿用现有离开保护。侧栏开启时原页面与未保存输入不卸载，窄屏复用现有抽屉行为。

## 5. 明确不添加 Agent 元素

- `home` / `dashboard`：不强塞 AI 卡片、不改默认首页与偏好。
- 不因新增 Agent 入口替换项目概览、任务集合工具栏、文档编辑器或设置中心的既有内容。

## 6. 本副本当前实现状态

当前入口以 [统一改造计划](agent-chat-pm-unification-plan.zh.md) 为准；第 1–5 节是历史目标，不自动纳入本次范围。

- PM 项目/任务/文档详情侧栏嵌入现有 Chat runtime；完整页为 `/agent/workspace`。模型、会话历史、输出订阅、取消、归档和删除均由 Chat 所有，不再适配第二条 PM 聊天 SSE。
- 项目操作、任务创建和任务集合的 Agent 入口携带真实 workspace/project/returnTo；任务引用仅是对象标识，正文和 revision 由 PM 工具按当前权限读取。
- 侧栏与完整页交接同一线程、模型、生成、文本草稿、附件、引用和返回位置。附件 File 与引用对象仅在同一应用运行期交接；硬刷新不承诺恢复浏览器内存对象。
- `/pm/:workspace/agent` 只做导航重定向，不复用旧 PM thread ID；旧 PM 模型设置与对话组件已退出。Provider 设置归 Chat。
- 工具卡、来源/收据/冲突和原请求核对、PM 核心文件差异查看均在 Chat 展示。不会因模型报告成功而改变任务完成状态。
- PM 自动化规则/只读报告及 Worker 保留原有业务归属；不因界面统一新增 Proposal、Run 或审批系统。
- 会话与持久化仍暂沿用 Chat，尚未完成统一设计。

## 7. 关联文档

- [执行计划](../../EXECUTION-PLAN.zh.md) 第 2 节：页面接入矩阵、可修改点、组件清单与交互细节。
- [场景矩阵](../../SCENARIO-MATRIX.zh.md)：各入口对应的场景、证据与状态。
- [实施合同](../../IMPLEMENTATION-CONTRACT.md)：文件所有权与共享接口。
- [README Agent 对话](../../README.md)：本副本已实现的 `/agent` 会话能力边界。
- [Agent 可读数据与编辑边界](agent-access-and-edit-boundaries.zh.md)：本副本当前聊天范围、全部计划场景的读取/提案/写入/审批映射及待确认权限策略。
