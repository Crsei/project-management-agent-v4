# 会话与持久化统一设计候选

> **状态：D1–D4 保守方案已于 2026-11-15 获用户明确采纳，实施与验收进行中，统一设计尚未验收收口。** 本文保留初稿基线及候选细节；开发授权不等于生产批量清理或破坏性迁移授权，不改变现行数据权威、权限或 PM 完成规则。当前仍沿用 Agent Chat 保存方式，各入口的未收口提醒保留。

采纳范围：按引用保留业务/未决证据及防复活墓碑；未知副作用先核对，不允许删除唯一核对依据；恢复后旧历史可读，不自动重绑目录或原生会话，显式新 Session 交接；保留 Chat SQLite，使用停写恢复集。第 1–10 节保留 **2026-11-14 初稿基线与候选验收方案**，其中“当前”“未运行”“本任务”均指当时调查；不作为本轮实施状态。第 11 节记录已采纳决策，第 12 节记录现行实现及实际证据，现行用法以公开指南为准。

## 1. 目标、基线与范围

观察日期：2026-11-14。对象是当前工作树，而非仅提交或历史计划；调查时 `threads.ts`、`chat-runtime.ts`、PM 上下文和公开架构／指南已有并行修改，队列及部分操作模块尚未提交。以下“已实现”仅指读取到的源码行为，**不是测试通过、运行实例已部署或真实 Provider 验收结论**。本次没有读取运行数据库／会话正文、修改运行数据、执行迁移或运行 build/lint/tests/formatters。

初稿之后，父线程另行授权修正既有 `exclude` 备份合同：只在导出副本清除遗漏的原生 continuation／环境引用，并补充对应真实 SQLite 行为用例；这项小修复不实施 D1–D4，也不表示本候选已采纳。源码检查、冻结基线故障复现和部署证据由集成者统一交付，本稿不把新增用例写成已运行通过。

目标是统一**身份、写入边界、生命周期、恢复和备份合同**，不是把全部数据搬进一个数据库。候选延续本机单操作者、单 Agent 写进程及既有 Chat SQLite；PM 仍拥有自己的业务权威。不把历史业务 Session/Run/Runner 与 Chat thread/generation 合并。

范围包含普通 Chat、PM 内嵌 Chat、显式保存草稿／前台队列、原生输出／续聊、PM 工具关联，以及任务交付／工作流／自动化的引用保护。外部 MCP 执行根没有 Chat 时仍不创建虚构线程。非目标：多租户会话所有权、HA／多写、跨设备同步、全局凭据迁入、通用事件库、完整业务 Runner、文件系统沙箱、自动 GC、在线无停写备份、外部副作用自动回滚。现有 PM 身份、成员／项目能力、OAuth 委托、审批配置、revision/CAS 和业务完成规则不变。

### 1.1 可追溯源码入口

下列符号是事实定位点；行号可能随并行修改变化，实施前须重读。没有发现覆盖本问题的等价现行统一设计文档；复用既有权威／指南／Provider 合同，不另立替代版。

| 来源 | 已阅读定位与用途 |
| --- | --- |
| [数据所有权](data-ownership.md)、[系统上下文](context.md)、[Markdown ADR](adr/0003-markdown-core.md)、[Agent 指南](../guides/agent-chat.md) | 现行权威、单操作者、安全与离线备份；不是本文已被采纳的证明 |
| [store.ts](../../apps/server/agent/src/durable/store.ts) | `getDatabase`、`transaction`、`closeStore`：文件锁＋SQL owner、WAL/FULL、同步事务与关闭顺序 |
| [threads.ts](../../apps/server/agent/src/durable/threads.ts) | `ThreadMetadata`、`saveFormattedMessage`、`bindMessageTurnContext`、`freezeThreadExecution`、`deleteThread`：消息树、受理绑定、删除范围 |
| [chat-runtime.ts](../../apps/server/agent/src/durable/chat-runtime.ts) | `submitChat`、`bindExecutionInput`、`settleChat`、`continueChat`、`startChatRuntime`、`continueChatRecovery`：受理、终态与重启 |
| [chat.ts](../../apps/server/agent/src/chat.ts)、[chat-actions.ts](../../apps/server/agent/src/chat-actions.ts) | 现行 HTTP、归档／删除门禁、当前权限投影、输出／队列入口 |
| [message-queue.ts](../../apps/server/agent/src/durable/message-queue.ts)、[queue-coordinator.ts](../../apps/web/src/features/agent/src/chat/queue-coordinator.ts) | 显式草稿、派发身份、前台推进、unknown 核对及重启暂停 |
| [thread-actions.ts](../../apps/server/agent/src/durable/thread-actions.ts)、[engine.ts](../../apps/server/agent/src/durable/engine.ts)、[thread-sidebar.ts](../../apps/server/agent/src/durable/thread-sidebar.ts) | Fork／rewind／steer、每线程进程内执行锁、侧栏独立 revision 与派生活动 |
| [native-output.ts](../../apps/server/agent/src/durable/native-output.ts)、[continuation.ts](../../apps/server/agent/src/providers/t3code/continuation.ts) | 输出序号／快照、live 交互闭包、原生续聊强边界与所属线程 |
| [pm-tools.ts](../../apps/server/agent/src/pm-tools.ts)、[pm-tool-transport.ts](../../apps/server/agent/src/pm-tool-transport.ts)、[pm-visibility.ts](../../apps/server/agent/src/pm-visibility.ts) | 原 operation、派发证据、结果核对、正文可见性和污染的原生上下文 |
| [PM agent-tool-routes.ts](../../apps/server/pm/src/agent-tool-routes.ts)、[PM agent-chat-tools.ts](../../apps/server/pm/src/agent-chat-tools.ts) | PostgreSQL 操作台账、原 command/native journal 恢复、提交前授权和结果交付复查 |
| [agent-workspaces.ts](../../apps/server/agent/src/agent-workspaces.ts) | `agent:workspaces:v1`／`agent:scratch:v1`、规范目录和 device/inode/birthtime 身份 |
| [agent-backup.ts](../../apps/server/agent/src/maintenance/agent-backup.ts)、[PM backup.mjs](../../scripts/backup.mjs)、[桌面 maintenance.ts](../../apps/desktop/src/backend/maintenance.ts) | Agent 快照／脱敏、PM SQL/core/blob 检查点、桌面已有组合备份 |
| [session-cutover.ts](../../apps/server/agent/src/maintenance/session-cutover.ts) | 已有显式旧 Session 清理的清单、指纹、业务证据保留和未知 namespace 拒绝模式；不等于本设计迁移已实现 |

## 2. 当前权威矩阵：事实，不作权威搬迁

| 数据／身份 | 当前权威和保存位置 | 当前原子／恢复边界 | 候选处理 |
| --- | --- | --- | --- |
| 核心任务／项目／正文／正式关系 | PM Markdown；共享 `.pm` 与登记项目 `.dovspace/.pm` | revision、共享 state/journal、原命令及 SQL 审计恢复；无跨介质 rollback | 不变，不创建 Chat／SQL 任务副本 |
| 身份、当前成员／能力、PM 会话、PM 附加事实 | PostgreSQL 所属模块 | 当前身份逐次检查；历史引用不是授权 | 不变，Agent 身份不替换 PM 主体 |
| PM 工具操作与原业务收据 | `pm_agent_tool_operations`、`command_receipts`、所属服务 journal／receipt | 同 operationId＋actor＋target＋requestHash 核对；原生文件与 SQL 不是全系统原子提交 | 不变，Chat 只持有相关证据／投影 |
| PM 配置／恢复 state／变更快照／附件 | 权威配置/state、SQL 元数据、绑定 Local/S3 不可变字节 | 完整 PM 检查点；索引 `.pm/cache/index.sqlite` 可重建，state／快照不可丢 | 完整恢复集必须覆盖，不能仅备份聊天 |
| Agent Workspace／scratch | Agent SQLite `agent:workspaces:v1`、`agent:scratch:v1`；scratch 字节在 `chat-scratch` | 保存规范目录身份；缺失／替换拒绝，不能自动补建既有身份 | 不变；恢复到新 inode 默认不能继续旧执行 |
| Session 元数据、设置与目录冻结 | `records` 的 `chat:threads` | `revision` 当前主要保护 settings／executionSelection；不是全部字段全局版本 | 保留；新增独立生命周期版本，见第 5 节 |
| 消息树、head、服务端权威消息 ID、TurnContext | `chat:history`，key 为 `[threadId, format]` | 整个 history JSON 写入；既有内容不可由浏览器改写；输入上下文由受理事务绑定 | 保留格式与存储，不另建第二套 transcript |
| generation、受理幂等、UI chunk journal | `chat:generations`、`chat:requests`、`chat:events` | SQLite 同步事务；generation 持有冻结 request／环境；重启只恢复输出和标中断 | 保留；补齐明确的受理结果查询和结构版本 |
| 原生输出与命令输出 | `native-output` 的 generation 快照；部分有界 tail／订阅在内存 | generation 内 sequence；快照 reset，非完整原生历史事件库 | 保留，不能把命令条目 ID 当 PM commandId |
| PM 工具本地记录、内容／引用来源 | `pm-tool-calls`、`pm-content-provenance`、`pm-quote-provenance` | 本地原请求＋主体＋target／hash；每次输出依当前 PM 权限投影 | 保留敏感历史，不把隐藏结果改成失败 |
| 输入执行来源记录 | `chat:execution-grants` 与输入 TurnContext／generation | `full / audit-only`，无持久 Cookie／Authorization；只记录来源，不是新权限 | 不改成授权系统，不新增 grant 许可门槛 |
| 显式队列／暂存 | `chat:message-queue`、`chat:draft-stash` | 队列 revision、输入摘要、冻结 settings／环境和原 dispatchKey；无后台凭据 | 保留；队列 `sent` 只表示 generation 已受理 |
| 侧栏、rewind／plan／steer 操作 | `chat:sidebar`、`chat:thread-actions`、`chat:steering` | 侧栏独立 CAS；操作有原键；steer 不确定不重发 | 不用 settle／unread 状态覆盖执行终态 |
| 任务交付／工作流／自动化、历史 durable run | 各自 Agent records／应用目录及 PM 引用 | 受管流程保留原 scope／工具上限；旧资源 run 不再启动 | 只登记引用与保留规则，不转成普通 Chat 或 PM 权威 |
| Provider 配置、私有凭据、原生续聊 | 应用私有文件／`provider-private`／自有 homes；`provider:t3code:continuations`；外部原生 Home 仍属外部 | continuation 校验实例 revision、driver／协议、Home／cwd、ownerThread、真实 turn 边界 | 保留原位置；backup 清除／重信任需逐 namespace 明确 |
| PTY、交互应答闭包、前台队列 armed 状态 | 当前进程／页面内存 | 断开视图不停止执行；重启不恢复进程、闭包或队列授权 | 不持久化为可重放命令，不伪造“等待可回答” |
| 浏览器 Composer、偏好、外部正文草稿 | 原 origin／账号／workspace 定义的浏览器存储或内存 | 非服务器跨设备权威；附件／引用恢复有限，外部正文仅内存 | 不暗中纳入服务器备份，不自动发送恢复草稿 |

### 2.1 已有实现的关键限制

1. `store.ts` 使用 `workspace.lock`＋`worker_owner` 保护单进程，`records(namespace,key,value)`／`run_events` 没有关系外键或全 records 结构迁移版本；`transaction` 拒绝 async callback。文件写入、Provider 和 PM HTTP 不在该事务中。启动可接替已死 owner；离线备份对陈旧文件锁则拒绝并要求人工核对，二者不可混用。
2. `submitChat` 在一个 SQLite 事务内保存受理消息、输入 TurnContext、generation、执行来源记录、冻结目录、初始原生输出和 `chat:requests` 映射；事务后才调度 Provider。已有幂等键不能更换内容；网络未知不等于未受理。目前没有普通 Chat 的独立只读 submission 查询端点。
3. generation 的 `queued` 是**已经受理、等待执行锁**，而消息队列 `queued` 是**尚未受理的新输入**。`engine.ts` 的锁是每线程进程内 Promise 链，不是持久分布式租约；不能从 SQLite 的 queued 自动恢复执行。旧资源 run 启动时被标 interrupted，不能借本文恢复旧 Runner。
4. 删除 API 会取消活跃 Chat、等其停止、关闭 App、终止该 Session PTY，再调用 `deleteThread`。后者标 `deleted:true`，删除 history／sidebar／execution-grants／queue／stash；**并不删除** generation 中的 request.messages、UI journal、native-output、PM 工具／provenance、Provider continuation 或所有字节。普通查询因 `getThread` 返回空而不可见，但这不是物理抹除，也不保证未知 PM 操作已经核对。该差异须显式告知用户，不能照抄“删除不可恢复”就声称全盘清除。
5. 归档拒绝活跃 Chat，保留历史及目录；不是取消／删除／PM 归档。当前队列 `threadFor` 同时拒绝已归档线程的读写，因此归档后无法通过队列 API 浏览其保留草稿。标题／status 更新不增加 settings revision；仅靠现有 revision 不能表示所有生命周期竞争。
6. Agent 备份 v1 校验全 records／run_events 摘要、计数和 SQLite integrity，并非关系完备性验证。调查时发现 `excludeNativeSessions` 遗漏 `provider:t3code:continuations` 及 thread 的 `nativeEnvironment`／`pendingForkEnvironment`；随后获单独授权，当前源码已在 **exclude 导出副本**中删除该 continuation namespace，并清除这两个字段。`include` 的原生 refs 与两种模式既有 MCP 撤销规则不变，源库、执行目录身份、generation 请求／输出／continuation 谱系及 PM 业务证据保留。已补 [对应行为用例](../../apps/server/agent/src/maintenance/agent-backup.test.ts)，不冒充运行通过；该修复不证明旧 exclude bundle 已被重写或全部 namespace 已统一设计。旧 bundle 如需保证新排除合同，应从可信原源重新导出，不能据原标签推定已经清除。
7. `agent:scratch:v1` 校验父目录及子目录 device/inode/birthtime；备份复制会产生新目录身份，而现行 restore 不改写这些 records。[INFERENCE] 一致性／摘要验证成功不等于恢复后旧 scratch 可执行。外部目录也只是引用，不能自动接管另一目录。

## 3. 关联模型：不混用身份

```text
Agent Store（单写实例；候选增加稳定 storeId／restoreEpoch）
  └─ Thread(remoteId == threadId；不是 PM workspaceId)
      ├─ Message(threadId, format, id, parent_id) → history.headId 选择一条分支
      │   └─ 输入用户消息 → 不可变 TurnContext(version, threadId, messageId, refs/revisions)
      ├─ Submission(threadId, requestIdentity/idempotencyKey, fingerprint) → generationId
      ├─ Generation(id, inputMessageId, assistant messageId, traceId, continuationOf/Id)
      │   ├─ executionSnapshot + settingsSnapshot + Provider instance/revision/model
      │   ├─ NativeOutput(generationId, sequence, itemId)／UI chunk journal(seq)
      │   ├─ executionGrantId（来源记录，非许可）
      │   └─ PM operationId → actor + target + requestHash + commandIds/recovery identity
      └─ Queue(queueId, revision, inputMessageId, dispatchKey) → accepted generationId

外部 MCP executionId／traceId → PM operation（可以没有 Thread／Generation）
PM commandId + workspaceId + actorId → 原业务收据／journal（不是 Chat 输出项）
```

| 身份／关联 | 不变量与多重性 |
| --- | --- |
| Thread → Message | 一个线程有多条消息和多分支；消息唯一键至少包含 threadId＋format＋id。Fork 可能复制相同消息 ID 到另一线程，不能按 messageId 全库唯一反查 |
| 输入消息 → Generation | 同一次普通发送最多一个原始 generation；显式 regenerate、工具延续等可有关联的其他 generation，不能宣称所有输入与 generation 一对一 |
| Generation → assistant messageId | 一般创建新 assistant ID；frontend tool continuation 可继续原 assistant ID。因此 assistant messageId **不是 generation 唯一键** |
| TurnContext → 输入消息 | 绑定最后一条受理用户消息，绝不绑 assistant ID；原 references/revision 是受理证据，不是长期授权或历史正文快照。旧记录缺失时不反推 |
| executionGrantId／traceId | 每个 generation 的来源／关联证据可以新建；再生复用旧输入 TurnContext 时，context 中原 executionGrantId 不必等于该 generation 新来源记录。必须分别核验绑定，不能强造一对一约束 |
| Queue → Submission | 同一队列修订使用固定 dispatchKey；编辑需新输入消息 ID 和新派发键；sent 表示受理成功，不表示 completed 或 PM 成功 |
| Generation → operation | 一个 generation 可调用多个明确 PM targets；同 Session 可跨已授权工作区。operationId 不能跨请求、主体、delegation、executionRoot 或 target 复用 |
| Operation → command／native journal | 读操作可以没有命令；写操作返回实际 commandIds／recovery identity。部分创建以 operationId 作 commandId，其他原生操作用派生身份，不能全库按相等连接；保留原 action／target／hash／revision |
| traceId | 用于串联，不授予读权、不证明提交，也不能由无签名调用者自报后当可信审计来源 |
| NativeSessionRef | 原生 session／turn／message ID 与 Chat generation、上游 providerSessionId 分开；只能在当前实例、Home/cwd、精确协议、所属线程和已完成强边界可证明时续聊／fork |
| cursor／sequence | Chat chunk seq、native snapshot sequence、命令 tail sequence、PM SQL SSE cursor、核心事实 sequence、通知 cursor 各属于自己的域；不相互排序，不用一个水位证明全局检查点 |

## 4. 必须保持的设计不变量（候选验收合同）

- **SP-01 单写与局部原子性**：只允许现有一个 Agent writer；线程受理／幂等映射／输入绑定／generation 初始化同 SQLite 事务提交，Provider 启动在提交之后。禁止 async I/O 穿过事务边界，禁止为“统一”引入双写聊天库。
- **SP-02 身份不可偷换**：同原键＋同摘要返回原结果；同键不同内容冲突。恢复保留原 operation／command／revision／target／actor；not_found、超时、4xx、空列表不能单独证明未知写入未发生。
- **SP-03 原事实与当前投影分离**：PM 已证成功不因撤权、旧失败帧、后续读取失败或对象变化而降级；失权时不返回正文／参数／错误／引用／续聊材料。unknown 不伪装 failed 或 succeeded。
- **SP-04 不自动重放**：浏览器断线只释放订阅；服务重启只恢复已保存记录，generation 标 interrupted、在途 PM 操作按证据标 unknown，队列暂停。不得自动重发 prompt、steer、shell、PTY 输入或 PM 写入。
- **SP-05 目录冻结**：首次受理后执行身份固定，重命名／关闭文件夹不改绑；缺盘／替换／不明未来版本拒绝。PM 引用不改变 cwd，allowedRoots／目录并非安全沙箱。
- **SP-06 终态语义分离**：generation completed 只代表该技术轮次结束；queue sent 只代表受理；批准不等于业务提交，取消不等于回滚，Run／CI／Review 成功不等于任务完成。等待审批／输入是有 live channel 的派生活动，不新建虚假 generation 终态。
- **SP-07 删除不可复活**：墓碑阻止 ensure／save／late callback／旧浏览器重新创建原线程；关闭／归档／删除都不能扩大受管流程 scope。删除前处理未知操作与保留引用，不能以删证据解决 unknown。
- **SP-08 检查点可组合而非原子幻想**：恢复集只在所有纳入写者停写的同一屏障内成立；外部副作用不在恢复集内。Agent、PM、项目字节、Provider 外部 Home 的覆盖分别声明。
- **SP-09 敏感数据边界**：源会话、journal、差异、备份默认私密；不存 PM Cookie／Authorization／live response closure，不读取全局凭据来补齐迁移。不把普通摘要或 include/exclude 标签当内容安全证明。
- **SP-10 版本拒绝与可回退**：未知 records/schema／备份版本拒绝写入或恢复；迁移有停写前提、完整预演、指纹和原始副本。不能让旧二进制默默写已升级 Store，也不能把恢复旧数据称作外部副作用回滚。

## 5. 候选增量：保留 Chat 存储，补齐合同

以下均为**新增设计，尚未实现**。字段／API 名称用于可执行评审；不能按本文调用尚不存在的入口。

### 5.1 Store 元数据、结构版本与 namespace 清单

在既有 `records` 增加应用私有元数据 namespace `agent:persistence:v1`（key `store`），记录 `storeId`、`formatVersion`、`minimumReaderVersion`、`minimumWriterVersion`、`restoreEpoch` 和已完成 migrationId／planHash。`storeId` 是本地存储身份，不是租户／用户／授权范围；源备份保留 sourceStoreId，恢复副本分配新 storeId／epoch，原 thread/message/generation/operation IDs 不重编号。

- 版本预检须先于 runtime recovery、Provider 初始化及自动化调度；不兼容时不能先更新 owner/schema 再宣布只读。一次性 bootstrap 只允许已识别旧布局；未知 namespace／未来版本进入阻断报告，而非直接 DELETE 或忽略。
- 复用 `store.ts` 的单 writer 与同步事务；在已有 durable 模块附近增加小型 codec／inventory 模块（候选 `durable/persistence-schema.ts`），集中声明 namespace 的结构版本、owner、引用、敏感度、可重建性、备份策略和删除保留策略。不要建立通用 ORM 或新 event store。
- 清单必须包含 queue/stash、thread-actions/steering、execution-grants、PM provenance／quote、Provider continuations、MCP/App、workspace/scratch 及全部当前 task／automation namespaces。现行 `session-cutover.ts` 的分类名单不能直接当完整真理；新 namespace 没登记就不能通过迁移／备份覆盖验收。
- 保持 `ai-sdk/v6` transcript 和现有分支；新增结构版本不能把旧消息内容、缺失 TurnContext 或不明 PM actor 伪装成已知。只建立能由已有服务端绑定证明的关联；断链进入报告，现有合法旧只读历史仍须可读取。

### 5.2 可核对的受理记录

演进现有 `chat:requests`，保留其 requestIdentity／fingerprint／原 generation 连接，而非新增并行聊天受理库。候选记录阶段为 `resolving | accepted | rejected`，仅增加 threadId、inputMessageId、摘要、版本和已证明的受理结论，不复制整份 prompt 或认证头。

1. Agent 访问校验后，以原提交键同步保留 resolving 记录，再进行异步 PM 引用／Provider／目录预检。同键并发共享原身份，摘要不符即冲突；预检阶段不派发模型轮次或 PM mutation。
2. 在现有受理事务内转为 accepted，并与 generation、history、TurnContext、来源记录、目录冻结、初始输出一次提交。仅 accepted 且当前进程持有执行权的 generation 可以启动；不能因重复 POST 重新启动已 interrupted 的 generation。
3. resolving 在重启后仅能在完整本地 store／journal 证明没有 generation 受理提交时转为 rejected（`admission_interrupted`）；缺失映射、损坏或恢复集不完整为 unknown，不自动造 generation。恢复元数据不表示原生 CLI 的其他外部活动不存在。
4. **候选新只读 API**：`GET /chat/threads/:id/submissions/:submissionId`，submissionId 是客户端发送前保存的幂等键；服务端用原 `chatRequestIdentity` 解析。返回最小 `accepted + generationId`／`not_accepted + 本地拒绝证据`／`unknown`，附 storeId／restoreEpoch，不返回旧 prompt。保留记录不存在本身不是跨恢复／跨实例的未执行证明。
5. 浏览器／CLI 在发出请求前保存原键与摘要；超时只查该接口及原 generation，不生成新 key。确认 not_accepted 后也只允许用户明确重发同一意图；修正内容必须新消息／新键。旧 `chat:requests {id,fingerprint}` 只在原 generation 可核验时迁为 accepted，否则报告断链。

涉及 `chat-runtime.ts`、`threads.ts`、`chat.ts`、`packages/agent-contracts/src/chat.ts` 及现有 Web／CLI 发送调用点。所有调用点一起切换，不保留会静默重放的旧发送分支。

### 5.3 生命周期版本与幂等删除

保留 `ThreadMetadata.status = regular | archived`、settings revision 和 sidebar revision；候选增加独立 `lifecycleRevision` 与 `deletionState`。删除属于过渡控制，不强迫 generation 增加“已取消请求”等伪终态。

- status 修改通过现有 `PUT /chat/threads/:id` 携带 expected lifecycle revision；设置仍走原 settings revision。归档／恢复的 CAS 不因重命名、侧栏读取自动归置而误冲突，也不能覆盖新的删除状态。
- 删除继续使用现有 `DELETE /chat/threads/:id`，候选要求原 `Idempotency-Key`、expected lifecycle revision、明确确认及精确 expectedGenerationId（有活动时还须显式同意停止）。不以打开菜单或导航隐式删除。
- 在同步事务内先声明 `deletionState: closing` 并增加 lifecycle revision，立即阻止新受理、队列派发、恢复、派生和原生交互；再在事务外停止本应用拥有的执行／App／PTY。等待真实终止后重进事务核对身份和引用，不把发信号当完成。受管交付／自动化仍走其原生命周期入口，不借普通删除绕过限制。
- 候选 namespace `chat:lifecycle-operations` 保留原键＋请求摘要＋`stopping | blocked | committed`＋最小结果，线程删除后也能返回同一个删除回执。**候选只读 API** `GET /chat/threads/:id/lifecycle-operations/:operationId` 只返回操作状态／原因码，不暴露已删除正文或赋予 PM 读权。重启不会自动继续终止／删字节，只报告 blocked，等待操作者核对。
- 默认建议：未知 PM 写入／未确认 steering／未决原生 fork 先核对；待审批 PM 操作须明确拒绝或由原流程处理；存在活跃受管流程或无法证明可保留的业务引用时阻止提交删除。可以先归档隐藏，但不能丢失原查询身份。用户若选择“带未知结果仍隐藏删除”，须另行确认只读恢复入口，不能只删 getThread 门禁。
- commit 后最小 thread 墓碑包含 threadId、删除操作 ID、deletedAt、版本与保留证据引用，不保留无必要标题／custom／冻结 prompt。history／queue／stash／sidebar 按清单删；generation／输出／provenance／PM call 等哪些保留见第 7 节，不能沿用当前无界残留当成策略。ID 永不重用。

## 6. 生命周期、队列与恢复

### 6.1 状态及动作矩阵

| 对象／动作 | 当前源码 | 候选合同与实施边界 |
| --- | --- | --- |
| 新 Session | 建立目录选择／scratch；设置取默认快照，第一次受理冻结 | 保留；新建不调用模型，不自动绑定 PM owner／项目 |
| generation 受理／执行 | queued → running → completed/failed/cancelled/interrupted；per-thread lock | 保留；活跃最多一条，重复输入不再生；一切 await 后在提交／启动前复核 lifecycle／环境／当前权限 |
| 等待输入／原生审批 | native-output waiting＋内存 pending closure | 保留；只有 matching generation/request/channel 可响应。重启／关闭后必须不可答，不从 durable flag 复活批准 |
| 浏览器断线／切 Session | 订阅独立，后台生成继续 | 保留；重连读服务端 history／generation／snapshot，不以上次半段文字重建或重放 |
| cancel | 精确 generation 或输入 cancellation 记录；取消 queued 可立即终结，running 等 worker | 保留取消意图与真实终态区别；停止回执未知只读核对。已提交 PM 不回滚，不为旧 cancel 请求取消新 generation |
| restart／正常 stop | 所有在途 Chat interrupted；PM running／无证 legacy failed 转 unknown；关闭 live requests | 保留；恢复需先确认原输出／操作结果，不自动启动队列、原生 turn 或旧 durable run |
| continue | 显式 `confirmSideEffects`，新恢复输入＋新 generation，保存 continuation 双向关系 | 保留新轮次而非重放；先核对第 6.3 节证据。原生续接和 portable handoff 分开标识；污染／身份变化不能原生续聊 |
| 配额恢复 | 已有 `continueChatRecovery` 要求原实例 revision、原生能力及既有用户配置 | 不把“无重启重放”误写成禁用所有已授权恢复；保留原恢复批准与来源。服务启动本身不授权新恢复，restore epoch 改变须暂停并重新确认 |
| Archive／Restore | 归档保留数据，运行中拒绝，恢复回 regular | 增补生命周期 CAS；归档不删草稿、不派发队列。归档后 queue/stash 可按当前授权只读，edit/send 仍拒绝；恢复不自动 armed |
| Settle／Snooze／关闭文件夹 | 侧栏状态或 Workspace 元数据；不是归档／删除 | 保留，不中止 Provider，不改变目录身份、不宣布业务完成 |
| Rewind | 仅 head 回到较早 completed assistant，清原生续聊引用；保留其他消息及真实副作用 | 保留；队列因 head 变化暂停；不回滚文件／Git／PM／终端 |
| Native Fork／计划实施 | 强边界／当前权限检查，原键；受管会话限制普通派生 | 保留；原生 fork 未知不能退到 live head 或再 fork；计划只是背景，不转移新权限 |
| Steer | 真正 live 能力，先记 dispatching，再 accepted/unknown；未知不重复派发 | 保留；区别排队下一条和继续生成。重启后 dispatching 显示 unknown，不能换键绕过原未决引导 |
| Delete | 现有停止后标记／删部分记录 | 候选第 5.3 节；逻辑删除、证据保留、物理清除分开，不复活原 ID |

### 6.2 队列的精确语义

当前已实现：每线程最多 100 条未 sent/removed 队列、50 份可见 stash；单草稿 20 MiB；附件仅完整 data/base64，不保存 blob／网络地址／任意本地路径。存草稿不是受理，不调用 Provider；冻结 settingsRevision/settingsDigest、执行环境和 PM 引用 revision；每次查看／发送重新校验权限，数据不可读时返回 `draft:null` 和原因，不当作空草稿。

候选保留并补齐如下转换及原子边界：

| 转换 | 条件／持久事实 | 未知与竞争 |
| --- | --- | --- |
| 新输入 → queued | 同 queueId 同摘要幂等；保存 inputMessageId／dispatchKey／当前等待边界 | 已入 history 的输入拒绝重排；同键不同内容冲突 |
| queued/blocked → 编辑后 queued | queue revision 与 settings revision 都匹配；新 inputMessageId／dispatchKey | 不允许编辑 dispatching/unknown/sent；设置或目录变动不能偷偷采用新值 |
| queued/blocked → dispatching | 当前授权、冻结设置／环境一致、无活跃执行、head/latest 边界匹配；异常上一轮需明确确认其 ID | 改顺序／多 tab 竞争只能一方赢；不得把发送下一条实现为 cancel/steer |
| dispatching → sent | 同一 SQLite Store 中找到原提交映射／generation；记录准确 generationId | generation failed/cancelled/interrupted 仍是 sent，绝不重新置 queued 重试 |
| dispatching → unknown | 响应或进程状态无法证明是否受理 | 同时暂停前台协调；unknown 不允许编辑／重排／删除后换键 |
| unknown → sent 或 queued/blocked | 只读核对原 dispatchKey＋inputMessageId；映射与 generation 一致则 sent；证明没有受理提交才解除锁 | 当前 reconcile 主要查 generation 列表；候选改用第 5.2 节受理证明，恢复 epoch／丢失映射／损坏不能仅因列表为空判 queued |
| queued/blocked/sent → removed | CAS 后保留最小幂等保存证据，draft 置空 | 保持当前“不让删除可见 receipt 造成重复保存”的语义；物理清理另议 |
| stash save/remove | 显式保存，同 ID 摘要一致；移除保留最小 tombstone | 不直接变成已发送；取回到 Composer 仍是草稿，必须显式发送或排队 |

前台协调器只在当前可见、已明确加入／恢复的页面推进，每次用新 HTTP 当前身份；切 Session、页面隐藏、认证失效、服务/HMR runtimeId 改变、head 变化、blocked/unknown 或上一轮异常都暂停。刷新／恢复备份不恢复 armed。当前队列与前台协调不等于后台调度器，不能为“持久化”把 Cookie／Bearer 存入数据库或后台计时器。多个前台页面由服务端 CAS／同键去重兜底，而不是声称只有一个浏览器能访问。

### 6.3 未知副作用恢复决策表

| 不确定点 | 唯一允许的核对路径 | 可确立结论／禁止行为 |
| --- | --- | --- |
| 普通 Chat 发送丢响应 | 原 submission 幂等键、原 inputMessageId、受理映射与 generation；候选只读 submissions API | 已受理则重新订阅；证据缺失则 unknown。不能重新生成用户消息或新键发同一任务 |
| Queue 派发进程崩溃 | 原 queue row／dispatchKey，经同 Store/epoch 的受理核对 | 已有 generation 一律 sent；只在证实未受理后恢复待发送，不把 Provider 没输出当未启动 |
| PM 写入可能已发送 | `pm_get_operation_result({arguments:{operationId}})` 或 `/pm-tools/calls/:operationId/reconcile`，复用保存请求；PM `/result`／内部 proof 查原 command/native journal | 成功与失败只来自权威证据。404／撤权／超时／列表没有同名任务都不能当失败，也不能重调 `/call` 或换 operationId |
| PM 成功已证明但正文不可读 | 已有独立 proof＋当前权限投影；只返回许可的最小事实 | 内部可核对提交事实，不把收据、参数、正文给失权用户；不把成功降级。已授权而来源版本变更则发起新的只读操作，不覆盖旧结果 |
| 原生 Shell／Git／发布／邮件／远端工具 | 原生 session/turn/item、已有文件／Git／远端原请求收据；必须有相应读取权限 | CLI 退出码或 generation 终态不能证明所有副作用。无 provider 原身份或幂等查询则保持 unresolved，交用户核对；不自动再执行／补偿／发信 |
| Fork／steer 已派发但响应未知 | 原操作记录＋原生强边界／实际输出；支持时只查询原 ID | 无可靠查询能力就保留 unknown；不能换键再 fork、退 live head、停止后重发来伪造“引导成功” |
| 取消／服务重启时 PM 正提交 | 取消后仍查询原 operation；内部 proof 不依赖把旧访问 token 持久化 | 取消只阻止后续派发，不能撤销已有提交；未核对前不得删除唯一关联证据 |
| 恢复到旧备份后远端已有新写入 | 原实例 sourceStoreId／恢复清单／原 operation 与远端收据核对 | 本地无记录不证明远端无写入；冻结恢复后的新外发，不能用新的 storeId 绕过外部重复风险 |

不为普通 shell 假造 exactly-once。允许保存“人工核对／尚无法证明”的恢复说明与证据引用，但不能仅凭人工点“继续”把未知 PM 操作写成 succeeded。继续授权只允许新 generation 在当前身份下完成**可确定尚未完成的部分**。

## 7. PM 撤权、证据保留与删除边界

### 7.1 撤权不是删除历史，也不是事务回滚

当前 `pm-tools.ts` 在派发前重新查 actor/target，PM 在原生服务提交前复查；保存 `possibly_sent` 后 HTTP 失败为 unknown。`pm-visibility.ts` 对 history、UI chunk／SSE、native item、command output、引用、工具卡和后续模型输入按当前 actor／scope／来源授权投影；有权访问项目也不自动有权读原私密来源。原生成标题／custom 缺少完整来源时也做保守处理。

候选将这些既有规则写成跨入口合同：

1. 未派发的 PM 操作撤权后不得派发；审批按钮也重新核对原主体、delegation 和目标，不能借 Agent cookie 代批。
2. 已可能派发的保持 unknown 或原已证明成功。内部 `/api/v1/internal/agent-tools/reconcile` 使用既有独立用途签名＋持久单次 nonce，只更新事实确定性，不能外露正文；签名配置缺失保留 `pm_linkage_unavailable`，不新增阻断普通合法 PM 操作的门禁。
3. 当前 PM 不可用是 unavailable，不当成撤权、空看板或无历史。数据投影失败关闭敏感读取，但普通不依赖 PM 的代码目录／纯对话仍按现有 Agent 访问可用；不能缓存一次授权作为永久许可。
4. 受污染原生上下文不得用于 resume、idle compaction、fork 或后续模型输入。清引用 chip 不会清掉原生上下文里的数据；必须使用明确的新原生会话／授权投影后的 portable handoff，或直接拒绝该操作。
5. 退出／撤权使相应 live transport／App 能力失效，历史快照不能复活。已经交付给客户端／外部 Provider 的数据无法靠本地数据库撤回，不作全系统原子撤销保证。
6. 验收必须覆盖 HTTP、SSE 重连和慢消费者 reset、CLI、PM 内嵌 Chat、native bridge、MCP/App、队列草稿／引用／quote 与复制／分支入口；不仅是前端遮盖。恢复／迁移后仍按当前 PM 权限，不能把备份内成员或旧 scope 当新的准入。

### 7.2 删除保留分类（需用户确认 D1/D2）

| 类别 | 推荐候选策略 | 不可越界 |
| --- | --- | --- |
| 可见 Chat transcript、排队／暂存正文、侧栏偏好 | 逻辑删除提交后清除对应记录；最小 tombstone 防旧键复活 | 不能宣称备份、generation.request、原生 Home 或已导出文件同时抹除 |
| 无业务引用的 generation／UI journal／native output／continuation／provenance | 删除提交前用清单算引用闭包；无未知副作用且确认无引用时才允许一并物理清除，保留必要幂等墓碑 | 不用任意 JSON 文本匹配作为“已无业务引用”的唯一证明；未分类 namespace 阻断清理 |
| PM operation、业务关联 generation／输出、交付／工作流／自动化证据 | 原所属模块保留权威，Agent 只保留被明确引用的最小证据闭包；标源 Session 已删除，不可执行 | 不级联删 PM 审计／收据／Markdown／附件／源码／Worktree；不自动改变业务对象状态 |
| 未知 operation／steer／fork、待审批操作、活跃受管执行 | 默认不允许进入不可核对的删除终态；先核对／拒绝／停稳，或保留可读 Session 归档 | 不得通过删记录、改状态、换 ID 或恢复旧快照解除 blocker |
| 附件／scratch／App 私有资产 | 本候选不新增自动 GC；仅在明确所有权和零保留引用、独立确认清单后做维护 | 不删外部 Home、Workspace 源码、共享 asset 或未知归属路径；不以目录名猜所有者 |
| 已有离线备份 | 保留原备份不可变；报告其仍可能含已删除内容 | 删除在线 Chat 不是销毁所有备份；备份保留／销毁期限由用户另定，不擅自给期限 |

未获删除／保留语义确认前，实施不应把普通“删除”宣传为隐私擦除，也不应自动删现有残留来“修正文案”。

## 8. 跨存储备份一致性候选

### 8.1 复用已有备份，不宣称从零实现

- Agent `createAgentBackup`：显式 `--stopped`、include/exclude、源／bundle／空 target 分离、独占维护锁、SQLite backup API、移除 copied owner、完整摘要／coverage／integrity；未知根文件拒绝。两种策略都撤销**副本** MCP grants/tokens/codes/consents 和 App model context，不改源数据库。include 收应用自有私有状态，不复制外部 Home；exclude 禁用恢复原生实例并去实例 env／配置覆盖。`provider-cache` 与重建用量缓存不备份。
- PM `scripts/backup.mjs`：`--stopped` 声明 API/Worker/外部 Markdown 编辑器停写；导出全部登记项目检查点，dump，按该 dump 的克隆库枚举附件，绑定 SQL/core/blob 摘要并前后核对根。不包含 Agent Store；其数据库连接检查不能单独证明外部编辑器已停。
- 桌面 `backend/maintenance.ts` 已把 PM dump/core/blob、chat-spaces 与 Agent bundle 的 manifest 摘要放入同一 `desktop-backup.json`，并有隔离恢复／格式兼容校验；不能把“统一备份尚未设计”误解为现有桌面没有组合能力。它仍不证明所有外部写者停稳，也不是外部副作用 checkpoint。

### 8.2 同一停写屏障内的 recovery set

建议复用上述 format，在现有编排层补一个**组合描述**，而非将 SQL/Markdown/SQLite 假装成一笔事务。Web／CLI 路径可演进 `scripts/backup.mjs` 的显式选项以纳入 Agent 源目录／secret policy；桌面复用同一描述验证器并升级已支持的 manifest，避免第二套摘要／恢复规则。具体选项与 format version 由 D4 确认，以下流程不是当前已有 CLI。

1. **准备**：核对当前服务 PID／出生身份／cwd／数据根与现有权限，确定 PM 根、登记项目、blob binding、Agent 目录、应用私有配置以及明确不纳入的外部目录。分配 recoverySetId，记录应用／协议／schema 版本和 secret policy；日志只含最小 ID／计数／摘要。操作员需确认可信源与私密保存位置。
2. **停止纳入写者**：先关闭新的 Agent／PM／自动化入口，停本实例 Agent、PM API、Worker、PM 外部编辑器及可能写纳入目录的自有原生进程；等待退出并核验锁与数据库客户端。只停止本应用拥有的进程，不碰外部服务。不可证明外部写者停稳的目录排除并明示，若是权威 PM 目录则整个完整恢复集失败。停止过程中可能已发生的远端副作用记录为 unknown，不能靠“停服成功”清掉。
3. **冻结清单**：屏障起止时间、各源逻辑身份与 schema、项目 storageId/marker、Agent sourceStoreId/restoreEpoch、全部原操作 unknown／保留引用计数。真实敏感状态放私有 manifest／bundle，不进入公开审计或仓库。
4. **同屏障导出**：PM 沿原检查点流程；Agent 沿离线 backup API；应用私有文件按现行分类。保存 `databaseDumpSha256`、`coreManifestSha256`、`blobManifestSha256`、`agentManifestSha256`（其 coverage digest）及可选 chatFiles 摘要，组合 manifest 自身固定摘要。采用停写一致性而非跨服务 cursor 最大值。任一分项失败不发布 complete 标志，保留失败证据与源数据。
5. **屏障复核**：PM 权威根与登记清单前后不变；Agent、Provider 配置／应用自有字节未出现新 owner／写者；所有引用的附件已覆盖。单独几份“各自通过”的备份若不在同屏障内，不标为完整一致 recovery set。
6. **隔离恢复并核对**：完整恢复只用同 set 的 SQL/core/blob/Agent；新数据库／新根／新 storage identity 与新 Agent storeId，禁止覆盖源。验证路径、摘要、SQLite integrity、结构版本、引用闭包、权限及 exclude 策略，再产生恢复报告；同名文件不作 identity 证明。
7. **恢复后默认围栏**：不启动旧 generation／queue／PTY／App，不恢复 MCP live 授权；通知、自动化及外发使用现有 restore-safety／模块围栏，确认目标信任与账号后才单独解封。仅切回读取不等于授权发送。恢复 unknown 原 ID 保留，不能因为新实例 PM `/result` 404 就重放原写入。

组合描述至少有：format/version、recoverySetId、createdAt、quiescence 起止与确认范围、source logical identities／应用和数据兼容版本、上述分项 manifest 摘要、secret policy、exclusions、verification 结果。它不保存凭据或裸操作正文，也不把绝对路径公布到 HTTP。

### 8.3 恢复能力与秘密策略

- `include` 仍须重新建立 live 授权，不承诺外部 Home／账号存在或续聊可用；`exclude` 必须在恢复前验证原生实例显式 disabled，并清除可执行续聊／fork 能力。当前已修正新导出副本的 `provider:t3code:continuations` 与 thread 环境 refs 遗漏，统一 namespace 清单／旧包策略仍属候选评审范围。保留必需历史路由身份与清除可执行引用要分别定义，不能粗暴删所有 generation 证据。
- 新清单应为各 namespace 区分“不可执行历史证据”与“续聊能力”。统一检查 thread native fields、generation／旧 durable run refs、Provider continuation、pending fork、MCP/App、steering 与队列；两种模式都不恢复执行 owner／pending response closure。未知 namespace 或未分类新私有文件阻断导出，而非悄悄遗漏。
- 复制的 scratch 和外部 Workspace 身份不自动重绑。推荐默认恢复可读历史、执行受阻；用户明确新建 Session／新目录身份后，仅复制当前有权读取的可携带 transcript，并记录 sourceThreadId／restore lineage，不复制 live native cursor，不改变旧 Session 的冻结身份。需要“原 Session 原地可继续”的方案属于 D3 另行确认，不作为备份工具隐含行为。
- Agent-only restore 不是 PM restore；PM-only restore 不是完整 Chat／工具状态 restore。允许二者独立导入供隔离只读检查，但不标“完整恢复”，不混拼 checkpoint 后直接执行。外部源码／文档、Provider Home 和浏览器草稿只按明确范围另备份；未覆盖项逐项报告。
- 任何 manifest 摘要／加密通过均不证明来源可信或 SQL 安全。恢复仍需当前既有可信源确认，include 私密备份不经 HTTP 提供、不进公开 Web 根、不上传第三方；密钥与部署配置使用现有私密渠道，本文不授予读取权限。

## 9. 迁移、切换与回滚候选计划

本节 draft 编号仅在本文有效，不是已创建 PM 任务或正式里程碑；不承诺负责人、日期或工期。全程先在**新隔离导出／副本**实施，不能覆盖当前 live dist，不运行生产迁移来补证。

### 9.1 前置依赖

- 用户确认 D1–D4 中影响写入／删除／恢复的选择，明确纳入的能力与不纳入项；用户未确认不启用破坏性切换、不移除设计提醒。
- 当前可读完整源码及已登记 namespace／文件 inventory；不得把历史 Session 清理名单或历史绿色测试当现行覆盖。
- 用户另行授权维护窗口／备份可信来源与目标；只读盘点无需停服，但 apply、恢复、删除、外发均需对应授权。
- 能制作并验证旧版本可恢复的完整 PM＋Agent 同屏障基线，保存对应二进制／兼容版本和原实例外发边界。没有完整备份／未知写者，不能做破坏性 migration。
- 当前 Agent Workspace v2、既有 PM tool target/proof 及 PM schema 前置已满足；本文不重新执行 `0051`，不迁入退休 PM chat 表／旧 UUID 任务，也不自动应用历史 cutover。

### 9.2 候选工作包与依赖

| 候选 | 成果与具体改动面 | 非目标 | 验收／依赖 |
| --- | --- | --- | --- |
| draft:T1 | namespace／文件清单、版本 codec、Store metadata、离线 inventory/dry-run 与迁移收据；`store.ts`、候选 schema 模块、maintenance 与 backup/cutover 的覆盖声明 | 不改变任务权威或新建聊天库 | SP-01/09/10；以 D4 与完整旧基线为前置 |
| draft:T2 | 受理状态、原键只读查询、所有 Web／CLI 发送调用点；`chat-runtime.ts`、`chat.ts`、chat contracts、队列原键核对 | 不增加后台调度、重试模型或存凭据 | SP-01/02/04；draft:T2 depends_on draft:T1 |
| draft:T3 | 独立 lifecycle CAS、closing／幂等删除回执、归档后只读草稿、保留引用清单；`threads.ts`、`chat.ts`、queue／thread-actions、受管流程入口 | 不做外部目录 GC／PM 级联删除 | SP-05/06/07；draft:T3 depends_on draft:T1；破坏性部分 depends_on D1/D2 |
| draft:T4 | PM 结果／污染上下文／跨恢复 epoch 的投影与恢复合同补齐及真实隔离故障用例；PM tool／visibility／Provider continuation、既有恢复入口 | 不新增授权体系，不把 full/audit-only 改成 permit gate | SP-02/03/04；draft:T4 depends_on draft:T2；删除引用检查对接 draft:T3 |
| draft:T5 | recovery-set 组合描述、既有 PM／Agent／桌面备份适配，exclude 全 namespace 清理与隔离恢复报告 | 不做 HA／在线快照，不导入外部凭据 | SP-08/09/10；draft:T5 depends_on draft:T1；depends_on D3/D4；最终联调依赖 draft:T2/T3/T4 |
| draft:T6 | 全调用点切换、故障与回滚演练、公开指南／权威页更新，提交给用户评审是否收口 | 不自动发布、写正式业务完成或移除提醒 | draft:T6 depends_on draft:T2/T3/T4/T5；第 10 节证据全部逐条交接 |

顺序：T1 先完成共同数据接口；T2／T3／T5 可按明确文件 owner 并行，但 `store.ts`／chat contracts／backup schema 同时只能有一个集成 owner；T4 依赖 T2 的受理结果，随后统一联调 T3/T5；最后 T6。不能为了并行在半成品数据格式上同时跑检查或应用迁移。

### 9.3 实际迁移阶段

1. **盘点预演**：只读导出 namespace/key/版本/计数/引用统计和 SHA-256 指纹；私密 plan 保存精确候选键与判定，不输出正文／凭据。覆盖整个 records 及持久字节清单，不以可见 Session 列表代替全库。循环 parent、缺 head、重复关联、悬挂 request/generation、缺 PM 原主体、未知 namespace／未来版本分别列 blocker。
2. **备份与冻结**：按第 8 节做同屏障 baseline；plan 绑定 sourceStore/数据摘要/应用版本和 schema。人工检查不等于 apply 授权；清单改变必须重生成并重新审阅，不绕过指纹。
3. **仅副本迁移**：同 SQLite 事务写可证明的版本／关联和 migration receipt；原 ID／原内容／已证成功不变。旧 request 映射可验证才升级；旧无 TurnContext／provenance 只保留 legacy 状态。持久文件通过 staging＋清单校验后发布；不得把 SQL 回滚当字节回滚。不做自动全盘内容清理。
4. **故障演练**：在每个持久边界终止副本进程，重启检查半成品、unknown 与不重放；按第 10 节跑真实隔离验收。失败保留私有 evidence，不迁移源。
5. **切换窗口**：另行获授权后停止本实例写者；重新核对 source fingerprint，apply 精确 plan，保存旧基线和 migration receipt，启用全部新调用点及版本门禁。先只读验证，再按原权限解封新发送／自动化，不能让新旧 writer 同时写同一 Store。
6. **交接**：报告迁移数量／拒绝项／保留项／字节覆盖／checks 的执行版本及环境，明确哪些仍不可执行。只有用户评审确认完整方案与证据，才能另议“设计收口”；本文件本身不完成此动作。

### 9.4 回滚矩阵

| 时点 | 允许回退 | 禁止／剩余风险 |
| --- | --- | --- |
| 只产生设计或 dry-run／未写数据 | 回到原代码／配置；保留分析证据 | 不用清理数据库或撤回用户并行变更 |
| 升级副本失败，未切换源 | 丢弃本次明确拥有的副本或保留故障证据；源不变 | 不反向复制副本 records／字节到源 |
| 已切换但尚无新受理／PM 或外发 | 停写；按完整基线恢复到新目标，核验旧二进制兼容后切回 | 不能让旧 writer 打开新 schema，不能只回滚 SQLite 而保留不同 checkpoint 的 PM |
| 已有新 generation／PM 提交／外发 | 先冻结，保存切换后的完整恢复集及原操作清单；优先前向修复。若必须回旧基线，先逐项核对新原身份／收据并经用户接受数据时间点取舍 | 无通用 lossless downgrade；恢复旧数据不会撤销文件发布／Git／邮件／远端请求，不能自动重放丢失记录 |
| 已物理清除 transcript／字节 | 仅能从明确覆盖它们的可信备份在隔离目标恢复历史 | 恢复不复活原执行／授权；没有备份的删除不可逆，不给虚假 undo |

版本兼容策略是拒绝旧 writer，而非长期双写／别名兼容层。迁移工具若支持断点恢复，只能恢复同 migrationId／planHash 的本地持久步骤，绝不重新派发业务命令。

## 10. 验收与证据交付方案

以下全部是**待执行验收**；测试文件存在只表示可复用入口，不表示当前实现或新增候选已通过。设计稿的评审验收是来源可核对、约束无自相矛盾、决策与依赖完整；实现验收须在对应实现落地后另行运行。

### 10.1 数据与生命周期验收矩阵

| 编号／不变量 | 隔离操作与故障点 | 必须观察的持久结果／拒绝行为 | 复用或新增位置 |
| --- | --- | --- | --- |
| criterion:1／SP-01 | 两进程指向同一临时 Agent Store；事务中抛错／返回 Promise | 第二 writer 拒绝；受理记录／history／generation／初始输出全有或全无；没有 Provider start | `durable/store.ts` 对应新增真实 SQLite 测试；`chat-runtime.test.ts` |
| criterion:2／SP-02 | 同提交键重复、并发、丢响应；同键改正文／模型／引用；受理事务前后杀进程 | 只一个原始 generation；冲突不写新消息；只读 submission 查询不启动模型；不存在记录不被跨 epoch 当未执行 | `chat-runtime.test.ts`、候选 submission routes 用例 |
| criterion:3／SP-02/05 | 多分支／相同跨线程消息 ID／frontend tool continuation；首次受理后改目录或替换 inode | 不把 assistant ID 当唯一 generation；保留输入 TurnContext；改绑／缺盘拒绝；PM refs 不改变 cwd | `pm-context.test.ts`、`agent-execution.test.ts`、`agent-workspaces.test.ts` |
| criterion:4／SP-04/06 | 输出中断 SSE、慢消费者 reset、关闭页面，再重连；服务正常 stop／强杀重启 | 输出无双重追加；generation interrupted，活跃 PM unknown；无自动 prompt／旧 run／PTY 重放，旧 request 不可应答 | `chat-runtime.test.ts`、`native-output.test.ts`、`inspector/terminal.test.ts`；真实进程故障用例新增 |
| criterion:5／SP-02/04 | queue 派发写 dispatching 后、受理事务后、sent 回执前分别崩溃；第二 tab CAS；修改 settings/head | 同 dispatchKey 核对；已有 generation 为 sent；无权威未受理证明不解锁重发；前台 runtime 改变／隐藏／失联暂停 | `message-queue.test.ts`、Web `queue-coordinator.test.ts`；新增恢复 epoch 场景 |
| criterion:6／SP-05/06/07 | archived 恢复、仍排队／运行时归档、删除 closing 与 submit/continue/fork 并发、重复旧删除回执 | lifecycle CAS 唯一结果；closing 阻新受理；未停稳不删；恢复归档不发送 backlog；deleted ID 不复活 | `chat-archive.test.ts`、`thread-actions.test.ts`、新增 lifecycle operation 测试 |
| criterion:7／SP-02/03 | 真实隔离 PM 写入提交后丢 HTTP 响应；在本地、PM reservation、native journal／command receipt 后逐点终止 | 原 operation/actor/target/hash 核对到原收据；不重复实体／评论；没有权威证明保持 unknown；已证成功不降级 | `pm-tool-certainty.test.ts`、`pm-operation-result.test.ts`、`tests/agent-chat-tools.integration.test.ts`，复用真实 PG/Markdown 并补故障点 |
| criterion:8／SP-03/09 | PM 请求在途撤权、换主体、失去私密来源、PM 不可用；重连 SSE／展开命令／查看 quote／草稿／MCP App／继续原生上下文 | 未发送拒绝；在途事实与可见性分离；服务器帧／后续模型输入无失权正文；污染 resume/fork/compaction 拒绝；不影响无 PM 的合法代码环境 | `chat-authorization.test.ts`、`pm-visibility.test.ts`、`pm-visibility-resource-results.test.ts`、`mcp`／`mcp-apps` 对应用例 |
| criterion:9／SP-02/06 | continue 之前核对 PM unknown、外部 shell 原收据未知、旧 cancel 迟到、rewind 后 queue／native fork | 新 continuation 链唯一；不重放原 prompt；外部不明保持 unresolved；不取消新 generation；rewind 只改对话；fork 不退 live head | `thread-actions.test.ts`、`chat-runtime.test.ts`、`providers/t3code/continuation.test.ts` |
| criterion:10／SP-07/09 | 删除有 PM／交付／工作流引用、unknown、待审批、共享附件和非引用普通输出的线程 | 精确保留闭包；unknown 不因删历史消失；无 PM 级联／源码／Home 删除；旧回调拒绝；UI 不宣称全盘擦除 | 新增 retention/inventory 测试及真实临时目录；对接 task-delivery／task-workflows／automation store |
| criterion:11／SP-08/09 | 停写完整 PM+Agent set，include/exclude 各一份；篡改分项 manifest、混拼 set、额外文件、活锁／陈旧锁、非空 target | 组合摘要／身份一致才恢复；篡改／遗漏／非空目标拒绝且不改源；exclude 所有原生能力清零并 disabled；两种副本 MCP 授权失效；源摘要不变 | `maintenance/agent-backup.test.ts`、`tests/local-project-backup.integration.test.ts`、桌面 `backend/maintenance.test.ts`；补全跨 set 测试 |
| criterion:12／SP-05/08 | 恢复到新 scratch inode、外部目录缺失／替换、include Home 不存在、unknown 远端已提交 | 历史可查与可执行分开；不自动重绑／补建／导入凭据／重发；用户显式建新 Session 后仍需当前权限 | `agent-workspaces.test.ts`、backup／continuation 测试与人工真实目录观察 |
| criterion:13／SP-10 | 旧／当前／未来 schema、未知 namespace、断 head／request 映射、迁移事务与文件发布中断；旧二进制写升级 Store | 已知旧布局无损预演；未来／断链阻断；migration receipt 与指纹准确；旧 writer 拒绝；同计划续接不重做外部动作 | 新增 persistence-schema／migration 用例，复用 `maintenance/session-cutover.test.ts` 的指纹模式 |
| criterion:14／SP-08/10 | 第 9.4 节每个回滚阶段真实演练，包括切换后新增 PM 操作 | 恢复至新目标、原实例未覆盖、保留 post-cutover 证据；报告不可回滚副作用与数据时间点，无伪 lossless downgrade | 新增临时 PG/Markdown/SQLite 组合演练；单元假 Provider 不能独自证明 |

这些 criterion 编号仅为本文局部验收编号，不冒充既有正式标准。真实外部模型／账号、供应商原生 fork／续聊、Electron GUI／Windows/macOS 目录／ACL 行为需在用户授权环境单列；受控协议可以证明本地恢复合同，但不证明付费模型、远端供应商或发行平台已验收。没有执行的项一律“待核实”，不能靠检查项存在或 health ready 判通过。

### 10.2 父线程／实施者后续命令与证据格式

本任务不运行检查。对**本设计文档**，可由集成者统一运行 `pnpm check:docs` 并人工核对相对链接／“当前事实 vs 新增候选”／D1–D4；仅文稿本身没有运行产物变化。获额外授权的备份源码小修复须另由集成者执行对应行为测试／受影响检查及部署核验，不能用文档检查替代；本任务不操作服务。

后续实现落地后，在新的独立源码导出、临时端口／库／目录运行相应入口，不能直接对 live Store 执行下列维护命令：

```sh
# 文档检查；本次未运行。
pnpm check:docs
# 源码落地后按仓库隔离检查合同统一执行；本次未运行。
node scripts/check-ci.mjs --stage static
node scripts/check-ci.mjs --stage build
node scripts/check-ci.mjs --stage backend
PM_OPENHANDS_AUTHORING_SOURCE=<已认证PUBLIC来源绝对目录> node scripts/check-ci.mjs --stage agent
# 仅对明确拥有、已停服的临时 Agent 数据副本；本次未运行。
pnpm agent:backup create --source <临时源目录> --bundle <新的私有bundle> --secrets exclude --stopped
pnpm agent:backup restore --bundle <私有bundle> --target <独立空目标> --stopped
pnpm agent:backup:verify --bundle <私有bundle> --target <恢复目标> --stopped
```

`backend`／`agent` 必须先完成同一检出的 `build`；Agent 还需要已认证的固定 PUBLIC OpenHands 来源。其余真实前置依赖按 [测试说明](../../tests/README.md) 和 [开发指南](../guides/development.md) 准备，不隐式下载未授权来源／读取本机凭据；host 等追加受影响范围由最终实现决定，分阶段结果不写成 all 通过。上述现行命令不提供候选 recovery-set／schema 迁移能力；新增 CLI 名称及 OpenAPI／contracts 变更须随实现一并交付，不能用不存在命令充当迁移验收。

每条验收交付：criterion/SP 编号、实际源码版本及关键文件摘要、临时 Store/PM/checkpoint 逻辑身份、精确命令与环境、故障注入持久边界、原请求／operation／generation ID（最小必要且私密）、前后计数／摘要、实际观察、通过／不满足／待核实、原始私有 evidence 路径及排除项。日志不输出 Cookie、token、凭据、完整消息／工具正文。源码阅读、实际执行、历史记录与人工观察分别标注；没有检查结果就不补写 passed。

## 11. 已确认的保守设计决策与替代边界

| 决策 | 推荐候选与理由 | 其他选择及影响／未确认时处理 |
| --- | --- | --- |
| **D1 删除语义与保留范围** | 明确“删除可见会话＋防复活墓碑”，业务／未知结果相关证据按引用保留；无引用聊天内容经精确清单清除。不引入自动 TTL／GC | 若要求隐私硬擦除，需要定义 generation.request、输出、provenance、附件、Provider 外部历史和已有备份各自范围及合法保留取舍。未确认不能自称当前 Delete 已彻底抹除，也不启动批量清理 |
| **D2 未决副作用时是否允许删除** | 默认先核对原 operation；未核实时拒绝不可核对的永久删除，可先归档隐藏。保留排查入口，不给未知写入新键 | 若要强制隐藏删除，必须同时接受最小只读恢复入口／私有保留证据及后续人工核对；不能仅关闭 unknown 门禁。未确认不实现“删记录解决 unknown” |
| **D3 恢复后旧 Session 的可执行性** | 默认旧历史可读、原目录／native 身份不重绑；显式创建新 Session/原生会话后做当前授权的 portable handoff，保留恢复谱系 | 若必须原 ID 原地续聊，需要另批精确身份迁移证明与 Provider 真实验收，不能直接改 inode／cwd。未确认维持现行拒绝目录替换、不自动恢复执行 |
| **D4 切换与完整恢复集合同** | 保留 Chat SQLite，使用停写 recovery set，复用 PM/Agent/桌面 manifest；确认 format/version 和 maintenance 窗口后再做版本门禁与迁移 | 若要在线备份／不停机升级或换存储引擎，是另一个范围，不据此把 HA／多租户列必做。未确认仅交付本候选，不应用 schema、不新建正式任务、不声称统一设计收口 |

用户于 2026-11-15 明确选择上表 D1–D4 推荐保守方案，并授权 M0/M1/M2 实施。表中替代方案不在本批；生产迁移/清理仍需精确维护前提，不因采纳设计而自动执行。实现及隔离证据见下节；统一设计未验收收口，不把设计采纳写成运行实例迁移已完成。

## 12. 本轮实施与验收状态

M0 已实现版本／命名空间／关系门禁、单写者保护、原提交核对、生命周期 CAS 与关闭屏障、引用保留闭包／墓碑，以及停写副本迁移和恢复集校验。继续使用 Agent Chat SQLite，不改变 PM、Markdown、PostgreSQL 或外部系统的权威；Agent／Team／业务 Run 记录不构成新的 PM 完成规则。

| 已实施合同 | 实际证据 | 不覆盖的结论 |
| --- | --- | --- |
| 同键受理及原提交核对 | 实际 SQLite 回归覆盖丢响应、重启不重放；同一输入的新提交键保存完整原 generation 收据。停机在途受理与重复输入收据问题已修复，12 项定向回归通过；合并后的完整 Agent 隔离阶段 1875/1875 项通过、无跳过 | 不能由记录缺失推断未知副作用从未执行；证据仅覆盖已审查候选，不自动覆盖未来并行修改 |
| 生命周期与保留 | 归档 revision、closing 屏障、实际 generation／PTY 停止、业务／unknown 引用及墓碑合同进入运行时及检查 | 可见删除不是全盘擦除，也不撤销已产生的 PM／文件／远端副作用 |
| 停写副本升级 | 真实 CLI 完成清单、apply、同计划重复 apply、无新增写入时 rollback，并核对原指纹 | `agent-persistence.ts` 所有模式均要求 `--stopped --isolated-copy`；不能把 live 数据目录标成副本或跳过人工清单审阅 |
| 恢复与执行隔离 | 实际 Agent 备份／恢复／校验与新 Store／restore epoch 合同；实际桌面加密往返 2 项通过 | 桌面证据来自兼容的 Linux Node 24／PostgreSQL 16 容器，不是 Electron GUI 或 Windows/macOS ACL 证明；SQL 静态校验不替代实际还原 |
| 跨服务运行及权限 | 合并后的完整隔离后端阶段 1337/1337 项通过、无跳过；最终临时服务再次通过 8 项原生协议场景，真实双 Agent Codex 场景通过；浏览器验证原审批拒绝及授权失效后草稿清除，业务 Issue 状态不变 | 不证明生产多租户隔离、远程 Runner、Mission 自动恢复或第 10 节所有跨系统故障点已完成 |

用户另行批准开发实例不生成额外备份包。执行方式仍须先核对并停止本项目写者，保留原数据目录，在真实副本上升级并验证后再切换；没有删库、清空会话或重置账号授权。原目录保留不等于完整恢复集，也不保证切换产生新写入后能无损降级。3224 的切换与核验结果单独记录，不把临时副本成功写成已部署。

首轮发布因并行变化在停服前暂停；用户随后选择合并最新变更后统一发布。合并候选完成独立审查、构建与隔离回归后，已于 2026-11-15 切换本项目开发入口 `3224`：仅重启已核对归属的 Agent，PM API／Worker／gateway 保持原进程；停写 SQLite 在真实私有副本上升级，原 341 条记录和 0 条事件逐行不变，新增 Store 元数据后为 342 条记录及 9 个写者门禁触发器。原数据与 scratch 目录身份、旧 SQLite、2 个账号和 2 个工作区均保留；重启后核对原记录仍不变，未清库、未重置账号、未生成额外备份包。公共运行面板、Agents、Teams、需要处理页面及实际服务响应已核验；公共入口未登录 PM，未在该实例新建业务 Run，完整授权交互和真实模型执行仍属于隔离验收证据。

完整命令、服务与备份前提见 [Agent 指南](../guides/agent-chat.md)、[CLI 指南](../guides/cli.md)、[桌面指南](../guides/desktop.md)与[部署手册](../../deploy/README.md)。第 10 节仍用于跟踪更完整的故障矩阵；本节只记录实际观察，不将全部设计验收自动勾选。统一设计尚未验收收口的提醒继续保留。
