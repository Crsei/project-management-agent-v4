# Agent 工作区前端接入清单（agent-workspace → PM）

记录日期：2026-10-25。目标：在 PM 现有外壳内呈现与 `../agent-workspace` 相同的 Agent 工作区页面；后端不照搬 Hono/SQLite/Claude Agent SDK，继续使用 PM 的 Fastify + PostgreSQL + 现有 Agent 会话接口。第一步只交付**左侧栏、对话框（Composer）、对话区（Thread）**。

来源目录（只读）：`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/ui-examples/agent-workspace`。目标目录：本仓库 `apps/web/src/features/pm/agent`。

## 1. 技术选择

| 项目 | 决定 | 理由 |
| --- | --- | --- |
| UI 运行时 | `@assistant-ui/react` 0.15.x | 与参考站相同的消息/Composer/Thread 原语 |
| Markdown | 现有 `MessageContent`（streamdown） | PM 已有安全 Markdown/流式渲染，避免再引一套 markdown 组件 |
| 对话状态 | `useExternalStoreRuntime` | PM 的 SSE 合约不是 AI SDK `UIMessageChunk`，先把外部 store 适配到现有接口 |
| 后端 | 不改 | 保持 `/api/v1/workspaces/:id/agent/*`；不引入 Hono/SQLite |
| 样式 | PM 主题 token + Tailwind/CSS Modules | 不加载参考站全局 CSS，不覆盖 PM 外壳 |
| 侧栏壳 | 自建 `aside` | 参考站 `sidebar.tsx` 依赖 Base UI 与 Sheet；PM 使用 Radix，避免混装两套 primitive |
| 线程列表 | `ThreadListPrimitive` + 自建搜索/分组 | 复用 assistant-ui 的线程切换/删除语义 |

暂不引入：`ai`、`@assistant-ui/ai-sdk`、`@assistant-ui/react-markdown`、`react-syntax-highlighter`、`@base-ui/react`、`xterm`、`@pierre/diffs`。等后端协议或后续面板需要时再评估。

## 2. 参考文件映射

| 参考文件 | PM 目标 | 处理 |
| --- | --- | --- |
| `apps/web/src/assistant.tsx` | `agent-chat-page.tsx` | 保留 runtime provider 结构；用 `useExternalStoreRuntime` 替换 `useChatRuntime` |
| `components/assistant-ui/elements/threadlist-sidebar.aui.tsx` | `agent-sidebar.tsx` | 复制品牌/分组/线程列表布局；去掉 Base UI Sidebar、语音/Provider 入口 |
| `components/assistant-ui/elements/thread-list.aui.tsx` | `agent-thread-list.tsx` | 复制搜索、Today/Yesterday/Earlier 分组；删除归档/重命名，保留删除 |
| `components/assistant-ui/elements/thread.aui.tsx` | `agent-thread.tsx` | 复制 Thread/Viewport/Composer/消息布局；去掉附件、引用、语音、模型选择、分支 |
| `components/assistant-ui/elements/markdown-text.tsx` | 复用 `components/blocks/message-content.tsx` | 不复制语法高亮组件 |
| `styles/globals.css` 的对话尺寸 | `agent-chat.module.css` | 使用 PM 的 `--radius-composer`、`--radius-bubble`、`--agent` 等 token |
| `chat/transport.ts`、`chat/remote-adapter.ts` | `agent-chat-page.tsx` | 不复制；改为 PM 现有 SSE/线程查询适配 |

## 3. 后端契约映射

第一步只使用现有接口，不新增后端字段：

| 界面动作 | 现有接口 |
| --- | --- |
| 读取可用性 | `GET /api/v1/workspaces/:ws/agent/status` |
| 线程列表 | `GET /api/v1/workspaces/:ws/agent/threads` |
| 新建线程 | `POST /api/v1/workspaces/:ws/agent/threads` |
| 读取消息 | `GET /api/v1/workspaces/:ws/agent/threads/:threadId` |
| 发送消息 | `POST /api/v1/workspaces/:ws/agent/threads/:threadId/messages`（SSE） |
| 停止生成 | `POST /api/v1/workspaces/:ws/agent/threads/:threadId/cancel` |
| 删除会话 | `DELETE /api/v1/workspaces/:ws/agent/threads/:threadId` |

SSE 事件映射到 `AgentChatMessage[]`，再通过 `convertMessage` 转成 assistant-ui `ThreadMessageLike`。关闭页面不取消生成；只有显式停止才调用 cancel。

## 4. 第一步实施清单

### 4.1 左侧栏

- [x] 品牌头：Agent 工作区 + 当前模型状态。
- [x] “会话工作区”分组：对话可用；运行记录、待审建议仍禁用。自动化后经独立请求接入真实只读报告页面，见[增量交付](../../EXECUTION-PLAN.zh.md#automation-page-delivery)，不伪造 Agent 执行。
- [x] 新建对话按钮。
- [x] 线程搜索。
- [x] 线程按 Today / Yesterday / Earlier 分组；显示运行中状态。
- [x] 删除线程（调用现有 DELETE；不做归档/重命名）。
- [x] 窄屏折叠为可打开/关闭的抽屉或顶部入口，不挤压 PM 外壳。
- [x] 线程读取错误显示重试，不显示空列表冒充成功。

### 4.2 对话框（Composer）

- [x] `ComposerPrimitive.Root/Input/Send/Cancel`。
- [x] 模型未配置或工作区无权限时禁用输入并显示原因。
- [x] Enter 发送、Shift+Enter 换行；流式期间显示停止按钮。
- [x] 发送中禁用重复发送；取消只调用现有 cancel。
- [x] 不显示附件、语音、Provider 切换、引用等尚未接通的入口。
- [x] 底部提示与当前模型标识。

### 4.3 对话区

- [x] `ThreadPrimitive.Viewport` + `Messages`。
- [x] 空会话欢迎态；有历史时顶部对齐。
- [x] 用户消息右侧气泡；助手消息全宽 Markdown。
- [x] 流式文本增量更新；终止/失败/中断状态明确。
- [x] 复制消息；不提供未实现的重试/分支/编辑。
- [x] 滚动到底部入口；不自动抢阅读位置。
- [x] 会话切换/刷新后仍显示服务端消息；未知状态不伪造完成。

## 5. 后续切片（不在本次）

- 附件、引用、语音、模型/Provider 选择。
- Agent / Workflows / Documents / Skills / Runs / Automation 面板。
- Files / Git / Terminal / Browser inspector。
- 规划、提案、运行记录、自动化页面与 Host 审批。
- 若后续后端迁移到 AI SDK UI message stream，再把 `useExternalStoreRuntime` 换成 `useChatRuntime` + `ChatTransport`。

## 6. 验收

已执行：

- `pnpm --filter @pm/web lint`、`typecheck`、`build` 通过。
- 浏览器 1440×900：加载既有线程、显示用户/助手消息、发送并接收 SSE 增量与终态。
- 新建线程：空态欢迎、发送后创建会话、URL 保留 `thread` 参数、消息不被空历史回读覆盖。
- 删除线程：调用 DELETE，列表与 URL 回收，空态正确。
- 390×844：侧栏默认收起，可由顶部按钮打开，遮罩与关闭按钮正常；Composer 在底部。
- 上述浏览器验证使用请求拦截的固定响应，未读取 `.local/access.json`，不是真实模型/登录验收。

未在本次验证：真实模型流、停止生成（cancel）、错误/中断恢复、复制消息、线程搜索输入、跨刷新历史、附件/语音/Provider 面板。禁用面板与静态线程不作为能力通过。

不把禁用面板、示例消息或静态线程当作真实能力。

## 7. 普通 PM 工具接入

本节是后续真实工具接入，不改写第6节仅 UI 阶段的固定响应证据。具体范围及工程结果见[当前 Chat 接入计划](agent-capability-integration-plan.zh.md)第8节。

- 保留 React/TypeScript、assistant-ui 0.15 external-store runtime、MessageContent/streamdown、Radix 与 PM token；未引入另一套认证、消息协议或后端栈。
- `agent-chat-store.ts` 统一服务端历史、SSE、工具状态、来源、取消及核对；`agent-chat-queries.ts` 共享私有线程授权状态。主体/工作区切换清理旧订阅和私有缓存。
- 新增 AgentRuntimeContextBar、AgentContextPicker、AgentToolCallCard，以及 Project/Task/Document/Comment/Relation 五类结果组件；消费真实 DTO、原生收据与深链，不使用故事数据。
- 原设置中心增加 AgentSettingsOverview；仅固定 Full access/Auto approve 的范围与启停，不接旧计划的完整权限平台。
- 既有 Chat API/SSE 增加授权、能力、来源与工具事件；后端仍为 Fastify/PostgreSQL/原生 PM 应用服务。该 Chat 批次没有接入运行、提案、主动发现或自动化；后续独立请求已交付自动化只读报告页面，不改变本批次边界。
- 真实模型、授权启停、原生页面深链、刷新恢复和390px窄屏已在隔离服务观察；不是把第6节的固定响应测试改称真实能力。
- 后续布局调整：Full access 入口移至输入框内部左下角、模型标识之前；点击向上展开原能力摘要与授权表单，移除对话区上方的独立权限栏。复用主题感知的 Radix Popover，设置页及后端权限语义不变。
- 本次布局验证使用浏览器内固定 API 响应，不写业务数据或调用真实模型：1440px/390px 下按钮位于输入框下方左侧、页面无横向溢出；弹层启停控件、Escape 关闭及输入草稿保留已操作。`pnpm check:web` 的 lint、TypeScript、Vite 构建通过；未重跑全仓库后端回归。

## 8. 输入框控制项拆分与模型思考程度

- 输入框左下角并列 `AgentPermissionPicker`、`AgentContextPicker`、`AgentReasoningPicker`，分别负责权限启停、工作区/项目上下文、下一条消息的模型思考程度。保持同一个 Composer/runtime 和 Radix 弹层，不新增权限模式平台。
- 新线程采用有效入口项目，否则工作区级成员采用当前工作区作为默认上下文。上下文保存复用线程 `access_scope` 与 revision CAS，权限关闭时保存不会生成 grant 或启用工具；授权开启时保存新范围即应用 Full access，不再重复勾选确认。跨工作区整页进入新聊天，不转移线程/历史/授权，有未保存输入时提示离开。设置页复用分开的权限与范围组件。
- `GET agent/status` 返回 `reasoning`；消息 POST 可选 `reasoningEffort`，默认 `auto` 不覆盖供应商默认值。选择只影响当前浏览器页面后续请求，刷新恢复自动；同一请求的所有工具轮次保持选择。服务端在消息持久化前拒绝不支持的档位；拒绝后输入框仍可编辑，不进入未知写入核对循环。
- 按已登记的官方接口与模型开放真实档位，不依据名称前缀猜测兼容网关能力。当前配置的 `deepseek-chat` 仅提供自动，不宣称已验证其可调思考预算。实现依据：[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode)、[OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning)。DeepSeek 工具续轮保留供应商要求的内部 reasoning 内容，但不发送到浏览器或持久聊天消息；旧可见历史以明确标记的历史文本提供，不伪造缺失的思考内容。

### 本轮验证边界

- 隔离 PostgreSQL schema、临时 Markdown/Blob 目录、API4297 与 Web3297/构建预览3298：真实保存项目范围后 `enabled=false`、`grantId=null`；启用权限、明确确认切换项目、刷新恢复、输入草稿保留、跨工作区离开确认及历史/授权隔离均已操作。项目入口预选项目而不授予权限；设置页显示独立权限与上下文区块。
- 真实配置的 `deepseek-chat` 调用 `pm_query`，只返回所选 `PRJ-002 / Alpha Delivery`，回复与工具结果持久状态均为成功；未写入用户业务数据。1440px/390px 检查三入口位于输入框下方左侧；窄屏无横向溢出，思考及项目弹层在视口内。
- 额外浏览器场景只替换模型状态为含“高”档位的固定响应，消息仍发送真实 API：服务端返回 `agent_reasoning_unsupported` 且消息数保持0；改回自动后真实模型回复 `OK`。该场景证明失配恢复，不冒充真实供应商接受“高”。支持档位的参数映射与工具续轮由受控上游验证。
- 模型流与 Chat store 的17项测试通过；OpenAPI/生成合同检查通过；受影响后端 lint、类型检查、构建及 `pnpm check:web` 通过。真实 PostgreSQL access 套件8项及 reasoning 3项分批通过。最初合并数据库命令达到240秒上限，在8项 access 与1项 reasoning通过后被中断；剩余2项 reasoning单独执行通过，未把中断命令或全仓库回归标为通过。
- 本副本 API4192/Worker 已通过受控脚本激活，启动前确认没有正在生成的 Chat 消息；不修改来源副本或其他项目服务。无数据库迁移；模型密钥配置保持不变。

## 9. 权限选择交互简化

- 权限入口直接显示“普通聊天”或“Full access”。弹层只展示两个即时生效选项，不展示“详情”入口；删除确认勾选、独立启用/续期按钮和常驻长说明。设置页复用相同选择行为并保留详细说明。
- 选中模式提交原 access API，成功才更新显示并关闭弹层。保留 revision CAS、原生 ACL、有效期和工具守卫；未知状态不显示成已停用，失败不自动重复提交。到期后可重新选择 Full access。生成过程中仍可切回普通聊天阻止后续工具动作。
- Full access 下选择项目立即更新范围，不再二次确认；普通聊天保存范围仍不授权。跨工作区的未发送消息离开保护保持不变。
- 本轮只改前端交互与说明，没有数据库、API 或模型执行变更。真实页面使用浏览器内隔离 API 响应验证：一次选择只提交一次授权请求、切回普通聊天、保持 Full access 保存新项目、冲突后重新读取、到期重选及输入草稿保留。1440px/390px 弹层无横向溢出，无页面运行异常；不将固定响应验证称为真实后端验收。`pnpm check:web` 的 lint、类型检查与构建通过，后端无需重启。

## 10. 工作区与项目选择精简

- `AgentContextPicker` 仅保留左侧工作区、右侧项目两列；不再嵌入能力栏、版本信息、长说明、保存/放弃草稿/常驻刷新按钮。权限弹层也不提供“详情”，完整说明与能力/来源保留在 Agent 设置页。
- 项目保留多选能力，选择后直接调用现有 access API；不允许保存空项目集合。“全部项目”仅对具备原生工作区范围权限的用户显示，仍由服务端冻结当前项目集合；不改变权限模式。保存未完成时禁止再次切换，失败时显示错误与重新读取入口，不自动重派写入。
- 跨工作区仍打开新对话，有未发送消息时确认离开；不迁移旧线程或授权。新线程创建期间保留所选范围和输入草稿。
- 浏览器内隔离 API 响应验证：多选与取消选择即时保存、普通聊天不授权、Full access 保持启用、409 后重新读取、新线程创建后的范围/草稿保留、跨工作区离开保护与新对话，以及1440px/390px左右布局无横向溢出。本轮不调用真实模型或写入业务数据，不替代后端验收。
