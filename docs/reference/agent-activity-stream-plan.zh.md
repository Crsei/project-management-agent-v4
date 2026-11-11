# Agent 活动流、思考块与会话状态执行计划

## 基线与授权

- 目标：沿用 Dovspace 现有 Agent Chat，将原生输出投影为保持顺序的 Thinking / Action / Output 活动流，统一侧栏与详情的运行状态；不是固定三段循环。
- 用户已授权本计划及代码实施，指定执行模型 `openai-codex/gpt-6.1-sol:xhigh`。本文件的 `draft:*` 仅是工程计划编号，不创建 PM 任务、审核或完成记录。
- 参考：当前仓库代码、公开 Agent 指南及操作者指定的外部 t3code checkout（只读）。不升级上游 pin，不修改外部源码。
- 本轮前已存在桌面、Web、发布和文档并行修改；目标 Web 文件也已修改。以开始时工作树为基线增量编辑，不回退、覆盖、广泛暂存、提交或推送。
- 当前 3224 是 built 服务入口；服务状态检查显示 PM/Agent/Web HTTP 可达，不代表 Provider 执行已验证。
- **会话与持久化统一设计尚未收口，当前仍沿用 Agent Chat。** 本轮不改变这一边界。

## 范围与非目标

包含：原生排序与 phase 保真、输出投影及恢复、相邻思考/操作分组、可见摘要、运行状态与环境分离、现有标题同步、可访问性、旧历史读取、实际浏览器核验和公共入口部署。

不包含：新执行引擎、固定 ReAct 循环、新权限或业务完成规则、通用事件溯源系统、原始 Provider 日志默认落盘、会话数据库迁移、凭据导入、上游升级、生产多租户、commit/push/PR。不为验证调用未经授权的付费 Provider，不把受控协议当真实账号验收。

## 共享接口与所有权

底层实施者拥有 `packages/agent-contracts`、Agent 服务/Provider 映射及对应回归；前端实施者拥有 Agent Web 展示、状态消费与对应回归。集成方拥有本计划、公开指南、CHANGELOG、最终检查、浏览器验证与部署。所有导出变更先查 LSP references，迁移真实消费者。

接口约定（实施者发现原生语义冲突须先回报，不猜测）：

1. `NativeOutputItem` 增加可选 `order: { scope: string; ordinal: number }`。scope 明确原生排序域，不能把不同 thread/turn/attempt 的 ordinal 全局比较；旧历史无此字段保留其既有顺序。同一排序域内保持原生位置，item upsert 不重复正文；SSE sequence 仍只表示服务端投影版本。
2. `NativeOutputItem.phase?: "commentary" | "final_answer"` 只来自 Provider 明确信息；缺失代表未知。不引入未证实的 `partial_answer`，不从文本或末尾位置猜 phase。正文完成与 generation 完成独立。
3. 保留 `id/nativeItemId/parentItemId`。能可靠获得 reasoning part 信息时保留 kind/index；前端只合并相邻、同生成/父关联/排序域的合理分组，不跨正文、提问、错误或其他特殊事件合并。不要按相似文字删重。
4. 时长区分 Provider 时间与本地观察时间；不得把完成时才到达的片段显示为精确模型耗时。可选时间来源标记由底层明确后告知前端；旧记录没有来源时不宣传精确耗时。
5. `ThreadSidebar.activity` 提供服务端权威派生摘要：`status: "idle" | "queued" | "running" | "waiting_approval" | "waiting_input" | "failed" | "cancelled" | "interrupted"`，可带 `generationId`。等待状态必须对应活跃且可响应请求；终态之后不保留等待/Thinking。现有 running 若仍用于操作门禁，必须从相同事实派生，不成为第二状态权威。
6. 标题沿用现有 `RemoteThread.title` / assistant-ui 同步路径，侧栏、主区和详情显示一致；活动摘要不改写标题。执行环境独立显示，不再填入状态字段。
7. 保留 full-snapshot 重连和慢消费者重置。除非已有真实必要性，不改为增量事件日志；文档准确说明 `after` 当前不代表原生事件回放。

## 候选任务与验收

| 候选编号 | 目标/成果 | 范围与非目标 | 验收 | 前置依赖 | 来源 | 待确认项 |
| --- | --- | --- | --- | --- | --- | --- |
| draft:T1 | 事件语义保真 | 原生排序域、phase、reasoning 身份及时间来源；不猜模型内容 | C1、C2、C3、C8 | 无 | contracts/output、ProviderAdapter、PM events 映射 | 若需 vendor 补丁，走既有精确来源流程 |
| draft:T2 | 权威运行状态 | generation/tool/request 到 sidebar.activity；完成/失败/取消/中断；不改变 PM 完成规则 | C4、C6、C8 | 无 | thread-sidebar、native-output、chat-runtime | 无 |
| draft:T3 | 活动流 Presenter | 真实摘要、相邻分组、正文边界、错误/提问可见、折叠状态；不重排为固定三段 | C1、C2、C3、C5、C7 | 消费 T1 接口 | output-timeline、output-stream、execution-trace；t3code 时间线参考 | 无 |
| draft:T4 | 会话 UI 状态统一 | 侧栏、主区标题、详情状态和环境；不另造标题生成器 | C4、C6、C7 | 消费 T2 接口 | chat-surface、thread-details-panel | 无 |
| draft:T5 | 分层集成核验 | 真实投影/SQLite/SSE 受控行为，lint/type/build，浏览器；不以源码检查替代行为 | C1—C9 | T1—T4 | 现有检查脚本和隔离夹具 | 真实账号执行单列 |
| draft:T6 | 文档与 3224 交付 | 使用说明、限制、变更记录；核对归属再部署受影响产物 | C9、C10 | T5 | Agent 指南、部署手册 | 门禁失败保留当前服务，明确 blocker |

## 验收场景

- **C1 顺序与身份**：Output-only；Thinking→Output；工具之间穿插 progress；同一排序域的延迟条目；不同域 ordinal 重复；同 id 更新不重复；无排序信息旧历史稳定读取。绝不按类型重新排成三段。
- **C2 phase 与完成**：commentary→tool→final_answer 保留各自语义；未知 phase 不冒充 final；收到文本、单工具结束或 final_answer 本身都不能提前结束 generation。
- **C3 思考展示**：相邻有效摘要紧凑展示、可展开原始内容；无摘要不伪造推理；Thinking/正在处理占位只在活跃且无更准确活动时出现；完成/失败/取消后不悬空；完成时首次到达不展示误导性的 0.0s 精确耗时。
- **C4 状态优先级**：活跃可回答请求/审批优先于运行；queued、running、failed、cancelled、interrupted、idle 区分；请求关闭/重启后不可回答；侧栏与详情使用同一语义；状态不显示目录名。
- **C5 操作分组**：连续工具紧凑计数/摘要；并行调用逐项保留独立状态；正文、错误、提问、计划/通知等边界不能被跨越；PM 工具收据、原生 App、命令展开订阅与失败详情保留。
- **C6 标题与环境**：切换、重命名、历史恢复时侧栏/主区/详情标题一致；动态活动不写标题；文件夹、路径及环境校验与运行状态分别展示。
- **C7 UI 可用性**：实际页面查看空/历史/运行/等待/错误状态，折叠键盘操作、窄屏、不截断重要错误；进度文本弱于最终输出但可读。用户手动展开/收起不被流更新反复覆盖。
- **C8 持久与恢复**：隔离真实 SQLite 路径检查投影读回、重连完整快照、重复旧帧忽略、慢消费者快照重置、活跃 generation 恢复中断；不重放工具，不改变已有安全授权。
- **C9 工程门禁**：受影响 lint、合同/client/server/Web 类型检查、相关行为回归与构建、公开文档、导入边界及来源完整性。永久测试只覆盖消费者可见边界，不添加源码字符串/转发回声测试；集成烟测与浏览器证据不能被测试计数替代。
- **C10 公共入口**：部署前核对 3224/4325 等端口、PID、cwd、服务模式和活跃生成；保留旧 Web 哈希资源。只部署已核验产物，不覆盖未审阅并行修改。部署后 3224 实际验证页面/接口；构建或来源门禁阻塞则保留旧服务并逐项报告，临时预览不算部署。

## 依赖与执行顺序

- `draft:T3 depends_on draft:T1`：界面依赖保真的顺序与 phase；接口已约定，可并行实现，最终集成时核对。
- `draft:T4 depends_on draft:T2`：界面依赖服务端权威状态；不在 UI 自行猜测。
- `draft:T5 depends_on draft:T1/T2/T3/T4`；`draft:T6 depends_on draft:T5`。
- 第一组：指定模型两个独立实施切片（底层 T1/T2、前端 T3/T4）；共享接口由底层拥有，前端不改合同；不在实施中重复跑构建/检查。
- 第二组：全部编辑完成后统一运行受影响检查与隔离真实路径烟测，修正失败，再观察浏览器实际界面。
- 第三组：补齐公开文档、核对来源与部署门禁、更新受影响产物并验 3224。没有工期承诺，不创建正式 PM ID。

## 上游与并行修改保护

优先通过现有 injection/Layer/host context/transport 接入 phase，不读取或持久化原生秘密。确需源内改动时，使用当前 pin 的 inspect/隔离 local-authoring/逐输出批准/record/verify；不手改来源哈希、不把所有 dirty 文件批量收录，不升级其他 fork。若真实 dirty 基线或来源缺失阻塞，报告精确前提，不能旁路门禁。

本轮文档及代码实施不授权提交、推送或 PR；不停止其他项目服务。会话与持久化统一设计尚未收口的提醒须保留。

## 交付证据

交付时逐项记录实际修改、命令与结果、隔离协议/浏览器覆盖、3224 部署身份及未覆盖范围。区分源码事实、受控 Provider 协议、真实账号验收；不把旧 CI 或单阶段成功说成完整通过。正式 PM 对象未创建，无业务任务状态变化。

### 本轮执行结果：源码实现与隔离核验完成，公共部署受阻

- T1/T2 与 T3/T4 分别由两个 `openai-codex/gpt-6.1-sol:xhigh` 实施切片完成；主会话负责集成修正、核验与交付门禁。未提交、推送或创建正式 PM 对象。
- 底层在 `packages/agent-contracts/src/output.ts` / `chat.ts`、Provider `t3code/events.ts` / `execution.ts` / `families/codex*.ts` 与 durable 输出、Chat、侧栏投影保留排序域、显式 phase、思考分段与时间来源。Codex 使用现有 client factory 注入观察元数据，不修改 vendor、接管原生协议或保留完整原始事件日志。
- 前端在 `output-presenter.ts` / `output-timeline.tsx` / `output-stream.ts` 与会话状态、详情组件完成相邻分组、生命周期显示和标题／环境分离。浏览器发现的摘要标题 Markdown 标记与整段拼接问题已修正为首个有效标题行，展开仍读取 Provider 原文。
- 新增 Codex 元数据观察模块的 vendor 依赖经核对后，仅登记一个精确 importer/module 对：`codex-activity.ts` → `CodexAdapterV2.ts`。未增加目录级导入豁免；边界负向回归继续通过。

| 核验项 | 实际结果与范围 |
| --- | --- |
| 合同与类型 | contracts/client-runtime 构建、client-runtime 类型检查、Agent 源码及测试类型检查、Web 类型检查通过。两处新增测试的联合类型窄化已修正。 |
| 活动流／Chat 回归 | 8 个受影响测试文件原有 115 项：首轮 108 通过，7 项标题 CAS 因隔离 `TMPDIR` 超出 Unix socket 路径长度失败；改用独立短临时目录后这 7 项通过。之后新增首行摘要回归并重跑 Presenter 文件 11 项通过，相关用例合计 116 项。 |
| 跨 Provider 回归 | Claude native、OpenCode native/output/questions、Pi continuity/tools 共 89 项通过；使用受控原生协议，不代表真实账号验收。 |
| 工程边界 | `node scripts/check-import-boundaries.mjs` 通过，边界负向测试 5 项通过。 |
| lint | 15 个受影响 Agent/contract 文件严格 oxlint、完整 Web eslint、新增边界登记脚本及最终摘要改动 lint 通过。额外尝试整片 Agent/contracts/client-runtime 的严格 oxlint 时，21 个未改动位置的既有 warning 阻止该额外检查；未修改无关代码或降低规则。 |
| 真实存储／流烟测 | 使用独立 SQLite 和实际 native-output API：修复前 phase/order 丢失，修复后均保留；文本不结束 Run、同工具 id 更新不重复、SSE 终态、关闭重开存储与重连快照通过。既有回归另覆盖慢消费者重置、取消、进程恢复中断及命令输出订阅。 |
| 实际浏览器 | 真实组件的隔离页面验证思考标题、键盘展开／收起、流更新及重挂载保留手动状态、工具组、进度／正文边界、空／运行／等待／失败／取消状态。等待请求选择后可提交，generation 结束后提交和取消均禁用；三个位置标题同步，环境另列，390px 下无横向溢出，页面无运行时错误。未向生产提交消息或执行 Provider。 |
| 构建 | 已通过类型检查后运行 `node apps/server/agent/scripts/build.mjs`，以及 `pnpm --filter @pm/web build`，均在隔离副本成功；Web 仍报告大 chunk／无效动态导入和既有 CSS 歧义警告。构建产物未覆盖公共服务。 |
| 文档与许可 | 公开文档链接、锚点和领域编号检查通过；公开许可完整性 27 项通过。该检查明确仍有发行授权 blocker，不代表发布授权完成。使用指南和 Unreleased 记录已更新。 |
| 来源门禁 | `node scripts/check-sources.mjs` 失败于 `apps/server/agent/src/durable/chat-runtime.ts` 的登记输出哈希不匹配。当前改动尚未通过受信来源流程登记，不能将构建成功解释为来源完整性通过。 |
| 3224 | 已核对 built 模式服务的 PID/cwd/入口归属，PM readiness、Agent 与公共页面 HTTP 均为 200；真实浏览器仍显示旧版思考行。来源门禁未过，部署停在前置校验，未替换产物或重启服务。临时预览已停止，烟测脚本已移除。 |

### 未闭合前提与后续交付条件

1. 受信 `upstream-sync inspect` 在现有 `vendor/t3code/third-party/mdast-util-math/index.d.ts` 处报 `UNSAFE_PATH`；该文件是既有多链接 inode。工作树另有本轮之前的并行修改与来源漂移。没有拆开其硬链接、暂存／丢弃并行修改、手改来源哈希，或把排除 dirty 文件的隔离副本冒充生产 authoring 基线。
2. 须先建立可安全审阅的来源维护基线，再按当前 pin 完成逐输出批准、record 和 verify；重新核验最终部署字节后，才能更新本项目 Agent／Web 产物并在 3224 做上线验收。本轮**未完成公共部署**。
3. 未运行完整 `check:ci all`、真实 Provider 账号执行、桌面 GUI 或生产恢复验收。此次受控核验不补造未知 phase、不证明所有 Provider 都公开完整推理，也不增加统一原始事件审计日志。
4. 会话与持久化统一设计仍未收口；本轮仅扩充已有 Agent Chat 投影与显示，不宣称完成新的会话／持久化架构。
