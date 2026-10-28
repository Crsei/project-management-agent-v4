# v3 Provider 运行输出完整适配计划

## 授权、基线与范围

用户于 2026-10-28 要求完整复刻 t3code 多 Provider 运行输出适配及相关前端功能，允许复制改进源码，并指定 gpt-6.1-terra / xhigh 子代理实现。本计划为仓库工程执行记录，不创建 PM 业务任务、审批或完成规则。

来源：`../../t3code`（revision `d53873b6a4799e87afd63c8d288ef0089f5a3748`）的 ProviderAdapterV2、各原生 Adapter、assistantStreaming、ThreadLiveEventCoalescer、CommandOutputHub、terminalOutput、ThreadTimeline、V2ItemInspector。MIT，复制或实质改编保留 T3 Tools Inc. 2026 版权及 LICENSE.t3code。源仓库只读。

现有基线：assistant-ui + AI SDK UIMessage，Hono API，同源 durable SSE，SQLite records，已接入九类原生驱动。现有 onText 不足以显示完整运行过程。保留 PM 工作区/项目 Session、执行目录快照、独立 provider homes、认证/Origin 检查、取消及未知副作用确认。保留全部既有未提交修改。

功能等价而非框架替换：复用本项目 SSE 和 React，不移植 t3code 无关编排/登录/业务系统；完整覆盖文本、reasoning、工具、命令、文件 diff、搜索、计划、子代理、审批、用户提问、错误、状态、恢复和显示性能。Provider 不支持或安全策略禁止的动作明确显示不可响应，不伪造支持，不放宽权限。

## 工作包与顺序

| 编号 | 成果/所有权 | 前置 | 验收 |
| --- | --- | --- | --- |
| P0 | 主集成：统一合同 `agent-contracts/output`，driver/runtime 回调接口，计划与来源 | 无 | 稳定条目 ID、状态、事件、请求响应及 SSE 合同明确 |
| P1 | Codex/Claude 运行事件适配；仅其 drivers、必要专属 helper/行为测试 | P0 | 原生文本/思考/工具/命令输出/文件/计划/子代理/请求/终态完整映射；既有安全策略不变 |
| P2 | Cursor/OpenCode 运行事件适配；仅其 drivers、必要专属 helper/行为测试 | P0 | SDK/IPC/SSE 不丢结构化事件，原生 ID 与终态收口，不重复回复 |
| P3 | ACP/Grok/Registry/Pi/Muse/Antigravity 输出适配；仅其 drivers、helper/行为测试 | P0 | 公共协议复用，所有现有 provider 已覆盖；只呈现实际支持的交互 |
| P4 | durable output 服务、持久投影/SSE 恢复、命令 hub、请求 broker、运行桥接；chat.ts及durable | P0 | 快照/序号补发/去重/有限队列，取消重启收口；命令仅展开订阅，慢消费者尾部替换；原生响应严格绑定当前 generation/request |
| P5 | Agent Web 输出 timeline、typed cards、命令面板、交互请求、流式设置及增量渲染 | P0 | 真实新旧历史兼容，文本不重复，思考可折叠，命令ANSI/跟随/截断，文件diff，计划/子代理/搜索/通用工具，审批/提问、错误及状态；390px与桌面可用 |
| P6 | 主集成：合同调用方更新、行为检查、真实HTTP/SSE/浏览器smoke、文档 | P1–P5 | 全链路经过本次代码实际运行；provider fixture 与真实供应商验收明确分开 |

P1/P2/P3/P4/P5 在 P0 后并行；禁止子代理中途执行 build/lint/tests/formatters，由主集成合并后统一执行。共享文件变更先沟通，不覆盖他人修改。未授权 commit/push。

## 共享接口

- `packages/agent-contracts/src/output.ts` 为唯一定义，导出 `NativeOutputItem`、`NativeOutputEvent`、`NativeInteractionRequest`、`NativeInteractionResponse`、`AgentOutputSnapshot`、`AgentOutputFrame`、`CommandOutputFrame`。
- `ProviderDriverRunOptions.onEvent?: (event: NativeOutputEvent) => void`；`onRequest?: (request: NativeInteractionRequest) => Promise<NativeInteractionResponse>`。既有 `onText` 保留给 CLI/automation/可移植历史消费者。原生输出必须有 assistant_message 条目，使前端可按正确时间线显示；结构化UI存在时不重复显示 legacy text。
- 条目 `id` 在单次 generation 内稳定，跨 provider 原生调用 ID 使用前缀；同 id upsert 完整状态，文本字段是累计全文，不是 delta；状态由真实事件驱动。新条目按首次出现顺序，更新不改排序。`command.output` 是独立原始分块，不写每块持久日志；最终 item.output 作为最终结果收口。
- 所有 onEvent/onRequest 消费错误必须传播，不能吞掉导致假成功。异常/取消由 runtime 收口未终结条目；不得把工具完成当整轮完成。
- `GET /api/chat/generations/:id/output?after=<sequence>`：SSE（JSON data），`AgentOutputFrame`；首帧snapshot，后续item/status，重连游标补发或安全snapshot替换。鉴权沿用同源 accessGuard，额外核验generation/thread作用域。
- `GET /api/chat/generations/:id/items/:itemId/output`：SSE `CommandOutputFrame`，仅命令条目；replace/append，running=false终止。归一化尾部有界，ANSI支持CR/清行/光标/跨块；折叠即取消订阅，取消订阅不取消执行。
- `POST /api/chat/generations/:id/requests/:requestId/respond`：`NativeInteractionResponse`，当前运行且待决请求的合法选择才接受；重复/过期明确拒绝。失去原生回调的请求必须不可响应，不能后台自动批准或重跑动作。
- API 内部路径如上，浏览器统一 workspaceClient 自动加 `/agent`，不硬编码绕过原代理。
- generation 输出 metadata 带 `durable.generationId` 和 `durable.nativeOutput: true`；前端以该 id 订阅独立输出，不让每个工具chunk重渲染整个聊天壳。旧历史无标记继续现有消息展示。
- 回复显示模式 paragraph/turn 保留完整终态文本；默认paragraph，Markdown完整边界与约400ms释放；高频可覆盖item更新约50ms合并，终态立即flush。命令帧约100ms，慢消费者整尾替换。

## 验证矩阵

1. 各 driver：真实形状原生事件序列含多个文本块、thinking、工具参数增量、工具结果/失败、命令分块、diff、计划/子代理、审批/提问及取消；不把 SDK mock echo 作为最终验收。
2. HTTP/SSE：隔离临时存储启动真实 app，真实 provider协议fixture子进程驱动；跨断线重连、重复序号、最终状态、故障/取消/服务重启；验证数据与历史一致。
3. 命令输出：CR覆盖、跨块ANSI、有界尾部、慢消费者、多个并发命令、折叠释放与重新展开恢复、结束后最终输出。
4. 请求：合法响应完成原生请求；错误generation/request、重复、过期、禁止能力、取消中请求拒绝；不改现有权限。
5. UI：真实浏览器桌面与390px，正文/思考/工具/diff/计划/子代理/审批提问、滚动跟随与用户上翻、切Session再回、刷新恢复、不重复正文、不全页高频重渲染。
6. 检查：受影响 lint/typecheck/tests/build；持久流变更运行 `pnpm test:backend`（跳过不算通过）。真实供应商需已授权可用账号，不读取凭据文件或复用来源 homes；未实际执行的供应商逐项如实标记。

## 执行记录

- 已核对现有 Git 状态，保留未提交修改；共享合同、driver 回调及流式模式已落地。
- P1–P5 已按所有权并行派发。当前会话使用 `openai-codex/gpt-6.1-terra:xhigh` task 模型覆盖；未保存全局配置。
- 各切片禁止中途执行检查；交回后由主集成统一验证。信息提问与权限审批分开：仅接入明确的信息回答协议，原有命令、文件、权限和含义不明的原生授权仍拒绝。
- 已准备隔离 HTTP/SQLite、受控 Codex JSON-RPC 子进程与浏览器 smoke；协议夹具不能作为真实供应商验收。

### 集成与实测记录

- 九类驱动、统一条目、durable SSE、独立命令流和前端真实聊天时间线已完成接入。信息回答仅开启 Codex / OpenCode / Grok / Muse 明确支持的协议；Cursor 无对应 SDK 回调、ACP/Pi 含义不明的原生授权仍不可响应。权限审批继续拒绝，不把信息提问变成执行授权。
- 恢复接口总是先给安全快照，再续实时更新；`after` 不承诺无限历史日志重放。命令尾部有界64KiB，折叠取消订阅但不取消执行；缓冲、ANSI/CR覆盖和最终累计输出统一收口。观察时间作为缺省耗时来源，不覆盖原生时间。
- 工程检查：Agent contracts / client-runtime / server / web 类型检查与构建通过；服务端完整 **341/341**，client-runtime **11/11**，desktop **3/3**，均无失败/取消/跳过。最后调整耗时与展开状态后，durable/output/streaming 专项 **38/38**；前端再次类型检查和独立 Vite 构建通过。保留既有字体解析、Zod 注释与大 chunk 提示；检查时另有并行 `thread-title.ts` 的 control-regex 警告。
- `pnpm test:backend` 已尝试，因另一 PID 50930 持有 `.local/backend-tests.lock` 退出75；没有终止持锁者、绕过锁或将未执行记为通过。
- 隔离44323/44324、独立 `/tmp` 数据、真实 Hono/SQLite/SSE 和 Codex JSON-RPC 子进程完成 HTTP smoke：完成/失败/取消、断开连接不取消执行、快照恢复一致、命令分块、信息回答、无效回答400与重复回答409。子进程实际执行受控 Node 命令产生 ANSI stdout；不是商业模型。PM 身份/目录使用夹具，不代表真实 PM 授权验收。
- Chromium 实测：思考折叠、计划/待办、MCP 输入与结果、子代理、搜索、文件红绿 diff、上下文压缩、拒绝的权限请求、信息问题提交与完成；命令实际运行时显示增量输出与耗时，折叠卸载终端，再展开恢复。复制得到 `Progress 20/20` 和实际命令结尾；终态历史接管仍保持已展开卡片。整轮模式在运行中隐藏正文、终态恢复完整正文；逐段模式正常释放且正文不重复。
- 桌面1440×1000与390×844、深浅主题已观察；窄屏文档宽390、无横向溢出，diff 行没有重复空行。请求完成/卡片卸载引起的 SSE abort 为预期，没有观察到浏览器运行时异常。未重启常驻服务、未执行真实供应商账号/付费模型验收。
- 后续用户追加的 Usage 移植另见 [Usage 计划](v3-usage-plan.zh.md)，使用相同 session-only 子代理模型覆盖；不据此把运行输出阶段的检查结果当作 Usage 已通过。
