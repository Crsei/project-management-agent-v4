# Agent Chat ↔ PM 接口接入计划

状态：2026-10-29。范围是合并后的独立 Agent Chat 与 PM 之间的接口，不包含新权限体系、Host、真实 Coding Agent 或业务完成规则。

## 1. 当前边界

- Agent Chat 拥有会话、生成、Provider、工具记录、文件观察和 UI。
- PM 拥有工作区/项目/任务读取、17 个业务工具、文件区域和核心文件。
- PM 旧聊天路由已移除；`/pm/<workspace>/agent` 重定向到 `/agent/workspace`。
- PM 侧栏通过 `AgentPanel` 挂载同一个 Agent Chat `Assistant`，入口参数包含 `workspace/project/task/entity`。
- 现有 17 工具：查询、读取、创建/更新项目、创建/更新任务、创建/保存文档、读取/创建评论、读取/添加/移除关系，以及归档、恢复、永久删除和状态转换。

## 2. P0 必须完成（本轮）

| ID | 任务 | 主要文件 | 依赖 | 验收 |
| --- | --- | --- | --- | --- |
| P0-1 | PM 引用解析接口：单条/批量 Issue/Project/Document，返回 available/stale/forbidden/deleted 与当前 revision | `packages/agent-contracts/src/pm-references.ts`、`apps/server/pm/src/agent-reference-routes.ts` | 无 | 真实 PM 权限；跨项目/无权限不泄露；批量最多 50 |
| P0-2 | 工具能力接口：按 workspace/project scope 返回 allowed/denyReason，Agent 侧代理 | `packages/agent-contracts/src/pm-capabilities.ts`、`apps/server/pm/src/agent-capability-routes.ts`、`apps/server/agent/src/pm-capability-routes.ts` | P0-1 的 scope 语义 | 不把全局 registry 当当前用户能力；写入工具按 `planning.edit` 等检查 |
| P0-3 | 线程绑定 PM Issue：thread 保存 `pmTaskId/pmEntityId`，创建/发送时 PM 校验 | `packages/agent-contracts/src/chat.ts`、`apps/server/agent/src/chat.ts`、`durable/threads.ts`、`durable/chat-runtime.ts` | P0-1 | 刷新/切换历史保留绑定；无权限拒绝；不猜归属 |
| P0-4 | 对话引用载荷：`POST /api/chat` 接收 `pmReferences`，服务端解析并记录来源 | `packages/agent-contracts/src/chat.ts`、`apps/server/agent/src/chat.ts`、`durable/chat-runtime.ts` | P0-1、P0-3 | 引用不可用阻止发送或明确移除；历史可追溯；不把正文复制进消息 |
| P0-5 | 变更集详情：工具记录补充 arguments/target/before-after/conflict；提供线程级变更查询 | `packages/agent-contracts/src/pm-tools.ts`、`packages/agent-contracts/src/pm-changes.ts`、`apps/server/agent/src/pm-tools.ts`、PM 工具结果 | P0-2 | 未知/冲突不显示成功；字段 diff 来自真实工具结果或 PM 当前读取 |

## 3. P1 受控写入（P0 后）

| ID | 任务 | 依赖 | 备注 |
| --- | --- | --- | --- |
| P1-1 | 写入预览：返回目标、当前 revision、预计字段变化，不写业务 | P0-3/P0-5 | 可用 PM `pm_read` + 工具参数在服务端生成 |
| P1-2 | 生命周期工具：删除、归档、恢复、状态转换 | P0-2/P1-1 | 需要 PM `planning.lifecycle`、`workitem.complete`、`workitem.cancel_reopen`；删除必须独立确认 |
| P1-3 | 逐动作审批：approve/reject，绑定 operationId、参数摘要、revision | P1-1/P1-2 | 不复用普通 auto-approve；拒绝/过期不派发 |
| P1-4 | 批量修改：逐项 revision、逐项结果，不宣称原子成功 | P1-1 | 复用单对象工具或批量协调器 |

## 4. P2 执行与协作（需单独确认）

| ID | 任务 | 依赖 | 风险 |
| --- | --- | --- | --- |
| P2-1 | Issue → Run：绑定 workspace/project/task/session，复用 Agent workspace runs | P0-3 | 需要 Run 状态机、取消、未知副作用和业务完成分离 |
| P2-2 | Run 结果反馈：日志/Diff/测试摘要写评论或草稿 | P2-1 | 成功 Run 不等于 WorkItem 完成 |
| P2-3 | 评论 `@Agent` 触发 | P0-3/P0-4 | 不能自动改字段；需显式会话和权限 |
| P2-4 | 服务端任务搜索/批量引用：`q/status/assignee/ids` | P0-1 | 当前前端只加载 100 条后过滤 |

## 5. 子代理切片与文件所有权

| 切片 | 子代理 | 允许修改 |
| --- | --- | --- |
| Reference | `RefApi` | 新增 `pm-references.ts`、`agent-reference-routes.ts` 及测试 |
| Capability | `CapApi` | 新增 `pm-capabilities.ts`、PM/Agent capability routes 及测试 |
| Thread | `ThreadApi` | `packages/agent-contracts/src/chat.ts`、Agent `chat.ts`、`threads.ts`、`chat-runtime.ts` 及测试 |
| Change | `ChangeApi` | `pm-tools.ts`、`pm-tools`/`pm-changes` 契约及测试 |
| Preview/Lifecycle | `LifecycleApi` | 工具 registry、PM tool implementation、preview route；不得改前端 |
| Frontend | `PmUi` | Agent Chat PM 组件、Chat transport、样式；不改后端 |

共享注册文件 `apps/server/pm/src/app.ts`、`apps/server/agent/src/app.ts`、`packages/agent-contracts/package.json` 由主集成人最后合并，避免并行覆盖。

## 6. 状态

- [x] P0-1 引用解析
- [x] P0-2 工具能力
- [x] P0-3 线程绑定 Issue
- [x] P0-4 对话引用载荷
- [x] P0-5 变更集详情
- [x] P1-1 写入预览
- [x] P1-2 生命周期工具
- [x] P1-3 逐动作审批
- [x] P1-4 批量修改（多选引用 + Agent 直接编辑对应 Markdown）
- [x] P2-1 Issue → Run（文件直改模式：选中 Issue 后由 Agent 读取并修改对应 Markdown，不另建 Run 状态机）
- [x] P2-2 结果反馈（Agent 回复 + Markdown 修改；原生评论仍用 pm_create_comment）
- [x] P2-3 评论/审阅意见（直接写入对应 Markdown；不伪造 PM 评论数据库）
- [x] P2-4 服务端搜索/批量引用（后端 endpoint 与前端搜索已接入；批量写入仍按逐项工具调用）

### 6.1 文件直改模式

- P1-4 批量修改：用户在 Composer/Issue 选择器中多选 Issue，服务端解析引用；Agent 根据 `.pm/core/work-items/<ID>.md` 约定直接编辑对应 Markdown。
- P2-1 Issue → Run：选中 Issue 后由 Agent 读取该 Markdown、完成内容修改；不另建 Run 状态机，也不把聊天回复当外部执行成功。
- P2-2 结果反馈：Agent 最终回复 + 实际文件修改；需要原生任务评论时仍调用 `pm_create_comment`。
- P2-3 评论/审阅意见：直接写入对应 Markdown；不伪造 PM 评论数据库，也不声称已审核或完成。
- 原生状态转换、关系、归档/删除和数据库评论继续走 17 个 PM 工具及审批；文件编辑不被当作业务完成证明。

## 7. 实现记录（2026-10-29）

已注册：

- PM `POST /api/v1/workspaces/:workspaceId/agent-references/resolve`
- PM `GET /api/v1/workspaces/:workspaceId/agent-capabilities?projectId=...`
- Agent `GET /api/pm-capabilities?workspaceId=...&projectId=...`
- Agent `/api/pm-tools/threads/:threadId/calls` 增加有界 `arguments`
- Agent `GET /api/pm-tools/threads/:threadId/changes`
- Agent chat thread `pmContext` 与 chat body `pmReferences`

前端已接：

- `pm-chat-bridge.ts`：`pmContext`/`pmReferences` 交给 `remote-adapter` 与 `transport`。
- `pm-capabilities-strip.tsx`：真实能力摘要与拒绝原因。
- `pm-reference-tray.tsx`：结构化引用 chip 与 availability，不再把引用拼接进正文。
- `pm-issue-workspace.tsx`：entry task/entity 与引用集合同步；服务端搜索已接入。
- `pm-context.ts`：生成提示包含 `.pm/core/work-items|docs|projects/<ID>.md` 文件约定；Agent 可直接编辑这些 Markdown。

验证：

- `pnpm typecheck` 通过。
- `pnpm --filter @agent-workspace/server typecheck` 通过。
- `pnpm --filter @pm/web build` 通过。
- `pnpm lint:agent` 通过（仅保留既存警告）。
- 24 项 P0 定向测试通过：引用、能力、线程绑定、引用载荷、变更集。

P1/P2 已按“文件直改”模式落地：选中 Issue 后由 Agent 读取并修改项目文件区域中的 `.pm/core/*` Markdown；不新增独立 Run/评论服务。原生状态转换、关系和数据库评论仍走 PM 工具，文件编辑不被当作业务完成证明。

### 7.1 P1/P2 增量

- P1-1：`POST /api/v1/workspaces/:ws/agent-tools/preview` 返回 proposed 变更集，不执行写入。
- P1-2：工具注册表扩为 17 个，新增 `pm_archive_task`、`pm_restore_task`、`pm_delete_task`、`pm_transition_task`；使用原生核心与工作流能力。
- P1-3：Agent `/api/pm-tools/calls/:operationId/approve|reject`；破坏性工具先进入 `pending_approval`，批准后才用原 operationId 执行。
- P2-4：`GET /api/v1/workspaces/:ws/agent-issues` 服务端搜索；Issue 选择器已切换到该接口。
- 定向测试：生命周期 5 项、预览 10 项、搜索 2 项、审批 2 项通过。

## 8. 验证要求

- 每个后端切片：真实 PostgreSQL/PM 夹具、权限、跨项目、revision 冲突、未知结果、幂等。
- 前端切片：TypeScript、lint、Vite build，真实浏览器覆盖引用、批量引用、变更状态、390px。
- 不用模型文字、固定 fixture 或 DEMO 数据作为业务成功证据。
- 不修改来源副本、外部 `agent-pm-studio` 或其他项目服务。
