# OMP 独立 Provider 实现计划与验收记录

日期：2026-10-31。项目：project-management-agent-v4。

状态：三个 `gpt-6.1-sol / xhigh` 实现切片已交付；源码、安全审查、受控模型下的真实 OMP / PM / Web 主链路、离线来源和独立产物验证已完成。完整Agent及仓库级门槛未全绿，真实模型 / 账号未验收；具体失败、跳过和能力限制见下表及执行记录，不能宣称全面验收或上线。本文编号只用于源码交付计划，未创建或发布用户的 PM 业务任务；运行验证仅操作自建临时工作区及测试任务。不自动提交、推送或切换常驻服务。

## 1. 基线与目标

- 本仓 t3code 固定 `30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c`，源码位于 `vendor/t3code/packages`，不是上游 main。
- 新建独立 `@t3tools/provider-omp`，保留现有 Pi、Provider Core、PM 宿主、Chat UI 和持久化。OMP 不作为 Pi 启动别名，也不迁入完整 t3code Orchestrator。
- OMP 固定来源：`v18.13.2` → `e996e1c7ac476f60e02b8ed9764cf30fa8c00a8e`；协议、审批、原生加载和会话语义的源码摘要记录于 `vendor/t3code/omp-source.json`，MIT 声明保留于 `vendor/t3code/third-party-licenses/oh-my-pi.txt`。调研时 main 已到18.14.1，不作为本批基线。
- 本机 OMP 探测版本 `18.13.2`。首次空临时 Home/cwd、无 prompt 探测观察到 ready、v2 协商成功、get_state 成功、EOF 后退出码0；启动曾超过20秒，日志阶段为模型发现。后续真实 Adapter / Host / Web 证据见第5节。
- 固定官方协议来源：[RPC](https://github.com/can1357/oh-my-pi/blob/e996e1c7ac476f60e02b8ed9764cf30fa8c00a8e/docs/rpc.md)、[审批](https://github.com/can1357/oh-my-pi/blob/e996e1c7ac476f60e02b8ed9764cf30fa8c00a8e/docs/approval-mode.md)。不把持续变化的 main 当成可重现依赖。
- 执行代理配置为 `.omp/agents/provider-sol.md` 中的 `model: gpt-6.1-sol`、`thinking-level: xhigh`。实施期间子代理不运行构建、lint、测试、格式化、安装和 runtime smoke；集成者在合并完成后统一验证。

### 目标与范围

交付从设置添加 OMP、模型发现/选择，到真实聊天流式输出、工具/信息请求、停止、同原生会话续聊、重启恢复、错误与后台工作收尾的完整路径；PM 工具进入既有授权桥，Usage 使用真实事件，缺少历史/额度读取能力时如实声明。

首次交付必须包含安全和生命周期，不允许先启用后补审批。Fork/Rollback、Goal、主动子 Agent 操作、历史 Usage/额度等仅在实现和验收后声明能力；缺少支持时明确 unsupported，不用空实现或假成功。第一批不抽象 Pi-family 通用 runtime、不新增业务权限或后台自动派发。

会话与持久化尚未经过统一设计，暂沿用 Agent Chat 保存方式；本次只补 OMP 原生身份和游标，不宣称设计收口。Run/生成成功不完成 WorkItem；沿用 INV-01/03/04/08/09/15 及 SC-03/06/10/14 所体现的边界，不启用历史提案里的另一套业务执行系统。

### 保留并行修改

开工时已存在 README、t3code-provider-module-migration-plan、vendor integration/source/sync 清单及 OpenCode status/usageLimits 的修改。它们属于既有工作，不能 reset、覆盖或借本任务重新解释来源。共享清单更新必须保留这些变动。

## 2. 冻结共享合同

### 2.1 公共接口

使用现有 ProviderAdapterV2、ProviderDriver、ProviderInstance、ProviderRuntimeHost 和 PM continuation/evidence 模式；不建立第二套事件或配置仓储。

新增包出口：`./client`、`./settings`、`./server`、实现需要的 `./server/*`。名称冻结为 `OmpSettings`、`ompClient`、`OmpDriver`、`makeOmpAdapterV2`、`OmpAdapterV2Driver`、`OmpAdapterV2DriverEnv`。settings/client 必须浏览器安全。Settings 基础字段 enabled=false、binaryPath=omp、launchArgs、customModels；Profile 若暴露必须纳入宿主身份/恢复检查，不继承 Pi 原生目录假设。

Transport 导出 `OmpRpcRecord`、`OmpRpcError`、`OmpRpcTimeoutError`、`OmpRpcSpawnOptions`、`OmpRpcConnection`、`makeOmpRpcConnection`，以及需要的 `ompRecordField/String/Number`、`parseOmpModelSlug`。Effect/Queue 接口沿 Pi 的形状：

- spawn options 为 command、args、cwd、env；可加独立 startupTimeoutMs。
- `request(record, timeoutMs?)` 返回 response.data，失败返回类型化错误。**保留调用方显式 id**，缺失才生成，防重复 pending id；prompt_result 不被吞掉。
- `send(record)` 用于无普通 response 的 UI/host-tool 回包。
- `events` 为 Queue；`exited`、`terminate` 为 Effect。连接创建成功前完成 ready 和 v2 协商；独立启动期限须容纳实际模型发现耗时。
- stdout 按字节/正确 UTF-8 处理 LF JSONL；对分块/损坏/超限 fail closed，不能套用 Pi 丢弃长行逻辑。
- OMP stdin 无 chunk 协议，发送前执行帧大小检查。进程错误清理 pending；关闭 stdin 后读完 stdout；Scope finalizer 只清理自己的进程。

Adapter options/driver.create 的具体类型沿 Pi 形状，两个包内实现者直接对齐 import 契约，不复制 Pi runtime。`sessionEvidence.ts` 导出 `readOmpSessionEvidence`/`bindOmpSessionEvidence`，与 Pi evidence 形状一致，probe/readLegacy 必须从实际 OMP 状态和会话证据核验，而不是固定字符串。可选 adoptBuffered 不实现则不声明。

### 2.2 结束状态

- response.success 通常只是受理。
- prompt 的 response.data.agentInvoked=false 是本地命令完成；不得等待不存在的 prompt_result/session_settled。
- 其余 prompt 以显式请求 id 匹配 prompt_result，保留 completed/aborted/error；sessionSettled=true 可收尾，false 保持 generation 有效直到 session_settled。
- 后台再次产生的消息继续属于当前有效运行；不能用子 Agent、旧 prompt、错误 root identity 的 terminal 结束根运行。
- 取消回执不代表已停止；流结束缺终态不能假成功。错误不能被随后 session_settled 覆盖为 completed。
- 当前宿主不自动创建终态后的新 generation；本批不扩展这个规则。

### 2.3 权限与 PM 工具

当前 PM runtimePolicy 为 approval-required/untrusted/readOnly，RuntimeHost nativePermissions=deny-ungranted。OMP 原生 approval-mode 不是沙箱；普通模式默认为 yolo，用户 config/flags 可影响审批。必须验证并实施宿主执行前门禁，不能仅添加 always-ask 参数就宣称等价。

- 优先 rpc-ui；需要审批时不得 --no-ui。
- launchArgs 不得覆盖协议模式、宿主 session/cwd/工具桥、身份与权限；拒绝 yolo/auto-approve 等绕过项及等价配置入口。
- 识别原生工具审批与普通信息问答；runtime request 响应校验执行身份、pending 状态和取消；迟到或跨运行授权拒绝。
- Host Tools 复用既有 generation-local PM bridge 的真实 schemas、arguments、request correlation、取消和审批。不得读凭据文件或把 PM Cookie/token 放到 argv/env/模型文本；工具桥不是新的授权源。
- 每次工具执行使用 admission 捕获的 executionId 调用 RuntimeHost.authorize，禁止替换为后来的 binding。
- 原生目录/Home/Profile、revision 与 lease 必须一致。不能自动导入 Pi 会话或全球凭据；任何未知副作用不自动重放。

### 2.4 来源与构建

新 OMP 包归类 local-addition，明确参考 Pi 和引用的 OMP 代码来源/许可证；不修改原始 t3code provenance hash 来伪装上游来源。已有 vendor 文件改动通过精确补丁、sync/import inventory 记录。保持单一 Effect 4.0.5。优先 Node/Effect 进程管理；直接采用 OMP 客户端须证明其 Bun 依赖不会破坏宿主产物。

## 3. 工作切片与所有权

| 编号 | 成果/范围与非目标 | 文件所有权 | 验收 | 前置 | 来源/未决 |
| --- | --- | --- | --- | --- | --- |
| draft:T1 | OMP Transport、发现、Driver 与客户端定义；不写 Adapter | 新包 package.json/tsconfig/client/settings/server；server/rpc、frame、launch、commands、status、driver、textGeneration 及对应行为测试 | v2/请求关联/退出、模型命令发现、无工具辅助生成，外部认证状态不伪造 | 共享合同 | 固定 t3code + OMP；实际模型认证可用性待真实验证 |
| draft:T2 | Adapter、安全、工具与会话证据；不修改 PM 总注册表 | 新包 server/adapter、permissions、hostTools、sessionEvidence 与必要私有 helpers/行为测试 | 流式/工具/审批/本地命令/取消/错误/后台收尾/恢复；能力与实现一致 | 共享合同；运行集成依赖 T1 | OMP RPC/审批；必要 native extension 按源码实现 |
| draft:T3 | PM 宿主与 UI/Usage 合同贯通；不重写 Provider 协议 | apps/server/agent/src/providers 的 omp driver/family、总注册及 mapping；agent-contracts、client registry、Usage 展示、诊断、包依赖；相关行为测试 | 配置/模型选择/lease/evidence/PM工具/Usage 与原 UI 相接；其余 Provider 不回归 | 共享合同；运行集成依赖 T1/T2 | 现有 PM Host/Chat 合同；不新建设置页 |
| draft:T4 | 来源、依赖、交付文档与检查集成 | 集成者独占锁文件、vendor provenance 清单/补丁、构建脚本、README 和本计划 | 离线 sync/import、单一 Effect、独立产物依赖完整；保留并行 OpenCode 变更 | T1/T2/T3 | SYNC.md；不升级固定 t3code |
| draft:T5 | 真实运行与安全审查 | 集成者执行 checks/smoke；gpt-6.1-sol xhigh 审查/修复分片 | 下节矩阵有真实证据，未满足项明确阻断能力开放 | T4 | 模型可达性、账号额度属外部前提 |

代码代理使用 provider-sol 预设，不另派低推理模型替代。三个实现切片可并行；每个文件只有一个所有者。公共配置/包依赖由 T3 合并，锁文件与来源账本由集成者统一维护。接口细节变动先互相发送消息，更新本合同后落地，不能并行创造不同版本。

依赖方向：T4 depends_on T1/T2/T3；T5 depends_on T4。T1/T2/T3 的代码可按冻结接口并行；集成验证必须等三者齐备。不存在自动发布业务任务或推送 Git 的步骤。

## 4. 验收门槛

| 门槛 | 当前结果 | 证据级别 / 限制 |
| --- | --- | --- |
| 包 / 宿主 lint、类型、测试和独立构建 | 部分通过 | OMP类型及140测试、宿主相关lint与11项边界测试、Agent类型、原始settings24测试、Web lint / 类型 / 隔离构建及独立产物通过；完整Agent和根检查仍有下述失败 / 超时 / 跳过 |
| ready / v2、模型 / 命令发现、请求关联与大帧 | 通过 | 真实18.13.2 CLI；生产 Decoder 消费43个chunk，Adapter / PM Host 获得完全相等的1,200,030字符；畸形和超限为行为测试 |
| 多轮文本、thinking、工具、错误及最终历史 | 分层通过 | 真实文本 / PM工具 / 恢复 / Usage；thinking与失败竞态为协议行为测试，未把手工事件称为真实录制 |
| 本地命令、延迟后台及根运行结束语义 | 分层通过 | 真实 `/session` 无Agent turn；延迟settled、错误及子任务隔离为行为测试；主动子 Agent / Goal 未开放 |
| 审批、信息请求、过期响应和参数绕过 | 部分通过 | 真实 PM 业务批准 / 拒绝、原生write拒绝及待审批时取消；信息请求及迟到响应为受控协议测试。当前 PM 不开放原生工具授权，未宣称普通ask工具的真实允许路径已验收；无OS沙箱承诺 |
| 停止、退出、续聊、重建恢复和身份拒绝 | 分层通过 | 真实取消、正常进程释放、重建与legacy精确游标恢复、revision拒绝；异常退出和其他身份 / lease 分支为行为测试 |
| PM工具、现有授权、审批和撤权 | 分层通过 | 真实查询、task归档批准 / 拒绝 / 待审批取消；scope / generation / 撤权为宿主行为测试。归档后workflow仍为todo，不是WorkItem完成 |
| 临时 HTTP / SSE / 浏览器主路径 | 通过 | 添加 / 检查OMP、发现 / 选择模型、实际聊天、刷新历史、同会话记忆、完整段落流中取消；未接管常驻服务 |
| Usage 和外部认证边界 | 通过 | 真实运行Usage投影；历史 / 额度明确unsupported，auth为unknown；受控模型不代表真实账号推理 |
| 来源 / import / sync 和独立产物闭包 | 通过 | 离线重建1201输出、重复无差异、来源 / 补丁 / 模式 / host工具漂移与symlink拒绝均通过；imports为1200文件 / 6764边 / 18包；迁移后的独立产物实际验证通过 |
| gpt-6.1-sol xhigh 安全 / 生命周期审查 | 通过 | 两个reviewer-sol审查切片均已关闭阻断项；最新legacy消费者由真实PM Host验证，不只检查适配器快照 |

验证在临时目录/端口进行，运行前核对端口/PID/cwd，仅清理本次拥有的资源。不读 access.json、.env 或供应商凭据；真实 CLI 使用授权运行环境的边界仍遵循仓库约定。缺少外部账号/额度不能用受控 CLI 成功替代真实模型验收，也不能静默降低交付范围。

## 5. 执行记录

- 2026-10-31：计划和接口已写入；执行配置已核对为 gpt-6.1-sol/xhigh。实现、测试、浏览器与产物尚未验收。
- 2026-10-31：三个 provider-sol（gpt-6.1-sol/xhigh）切片已实际派发：OmpTransportSol、OmpAdapterSol、OmpHostSol。T3 宿主切片已返回源码，尚未通过统一类型检查或运行验收。
- 原生基线补充：真实 `/session` 返回 `response.data.agentInvoked=false`，适合作为无 Agent turn 验证。`/stats` 虽也返回此状态，但会尝试启动原生 dashboard，不能当作无副作用命令；该探测进程退出后已确认 3847 无监听。空 Home 直接 CLI `--model ollama/qwen3.6:27b` 在 ready 前拒绝，先 discovery 再 RPC set_model 可成功，因此实现采用显式 RPC 模型选择，不静默替换。
- 真实推理外部限制：本机已发现Ollama模型，默认openai-responses请求404；临时独立pm-omp-local配置显式openai-completions后，真实服务返回500 unable to load model，原生重试中abort后prompt_result为aborted/sessionSettled=true。未修改或重启该模型服务。该结果不是成功推理证据；真实CLI+受控模型服务的协议/安全验证须与真实模型验收分开。
- 原生真实回放暂存 `.local/evidence/omp-provider/native-18.13.2-local-command-and-model-error.jsonl`；不含账号凭据。后续永久fixture只纳入必要脱敏事件及来源，不把手工拼装事件标为真实录制。
- 启动安全边界：stock OMP 18.13.2 的 `--no-tools`/`--trusted-extension` 不能关闭全部 custom tools、plugins 和 MCP 初始化。采用完整原生来源的 metadata-only 启动预检；遇到可执行来源或无法证明安全的来源拒绝启动。实际 CLI 向 custom-tool loader 传入空 configuredPaths，不能把 SDK 独有参数误判成配置绕过。此方案不读取账号、不修改全局配置，也不承诺抵御被恶意替换的受信 CLI 或本机配置竞争。
- 已观察的原生受控验证（尚非新 Adapter 验收）：真实 OMP 18.13.2 完成 `/session`、流式回复、独立进程恢复会话并读回前一轮标记、流中取消并返回 aborted；正常运行返回 completed/sessionSettled=true，进程正常退出。记录为 `.local/evidence/omp-provider/native-18.13.2-controlled-{stream,resume-cancel}.jsonl`。
- 大帧原生录制：受控模型返回 1,200,030 字符正文，真实 OMP 产生 43 个 rpc_chunk、5 个逻辑事件；独立重组验证字节数/顺序及正文完全一致。记录 `.local/evidence/omp-provider/native-18.13.2-controlled-large.jsonl`。此证据尚待新 Transport/Adapter 实际消费验证，不能提前打勾。
- 新 Adapter / 生产宿主验证已补齐上述“大帧待消费”和“原生CLI尚非Adapter验收”阶段缺口。`.local/evidence/omp-provider/decoder-smoke-result.json` 与 `host-smoke-result.json` 均为实际通过结果：流式正文准确、事件Usage、同原生会话跨宿主重建记忆、legacy强游标消费、`/session`、大帧、取消以及旧revision恢复拒绝。
- legacy回归不是只改fixture：真实 OMP 正常退出会在assistant后追加 `custom/session_exit`。实现只接受已证明祖先之后明确列出的非会话元数据，保留对话头H；在删除**自建临时**PM continuation后，经真实 `adoptLegacy → assertPmContinuationCursor → resumeThread` 恢复并读回原标记。新增消息、异常退出、未知custom和不可证明分支仍拒绝。
- 永久回放 `vendor/t3code/packages/provider-omp/src/server/fixtures/native-18.13.2-stream.jsonl` 是实际受控模型运行的原始帧摘录；文件记录完整源SHA和行范围。回放只改请求关联ID，不伪造事件或最终正文；140项包测试已包含这一正文 / 历史一致性用例。
- 实际浏览器结果：`.local/evidence/omp-provider/browser-smoke-result.json`。真实UI完成添加、检查、选模、多轮、刷新历史、原会话记忆与流中取消。原有逐段显示需要完整Markdown边界；控制模型发出完整段落后，在终态前观察到文字，再点击取消。没有为测试修改既有流式显示策略。
- 实际PM工具结果：`.local/evidence/omp-provider/pm-tools-browser-result.json`。自建项目PRJ-001中，TASK-001在批准前revision和archived均未变化，批准后归档且workflow仍为todo；TASK-002拒绝后revision不变；TASK-003待审批时取消生成，仍未归档且revision不变。取消不会撤销既有PM提案的独立人工审批权，剩余测试提案随后显式拒绝，不能据此宣称“取消后人工审批也被禁止”。原生write工具实际被边界拒绝，目标文件不存在。
- UI实图保留 `.local/evidence/omp-provider/pm-query-ui.webp` 与 `pm-pending-cancel-ui.webp`；这是实际浏览器，不是设计稿。上述`.local`文件为本机验收材料，不替代永久行为测试，也不代表它们已进入版本提交。
- 初始真实PM工具运行暴露OMP在 `tool_call` 后还有stock二次审批；现已使用nonce / call ID / 参数 / generation绑定的单次准入并再次核验宿主。PM工具许可不能扩散为原生工具许可。标题 / 压缩使用显式 `technical-no-tools`，不能因工具发现失败而退化为无约束执行。
- 受影响检查：OMP140测试 / 11文件、包typecheck；Agent及client类型；客户端18测试；最终宿主边界11测试及相关oxlint；Web lint / typecheck / 隔离vite build均通过。构建保留既有chunk-size和动态import警告，没有为消除警告改造无关代码。
- 完整Agent套件以 `--test-concurrency=2` 运行：679项中678通过、0断言失败、1取消、0跳过。取消项为既有Codex测试 `native resume, continuation and fork require matching scope and accepted directory`，原30秒期限下孤立运行也超时。诊断loader仅在内存将该期限改为120秒，源码和断言不变，56.4秒完成全部断言；**原30秒门槛仍未通过**，不把诊断当成原套件全绿，也未永久放宽测试。
- 两个reviewer-sol审查已收口：原生加载路径 / 插件穿越 / 实例环境、PM工具二次审批、generation及技术调用、会话与legacy游标问题均已修复；最后一个legacy消费者缺口由真实Host smoke关闭。审查本身未代替运行验证。会话与持久化仍未统一设计。
- 仓库级 `pnpm check` 的文档检查通过（135份Markdown），随后在 `contracts:check` 停止：`docs/contracts/openapi.yaml` 漂移。对实际生成对象与已有YAML做语义比较，差异仅为 `AgentChatToolResult.anyOf` 缺少已有 `lifecycle` 分支，不是OMP枚举；未生成或覆盖这项任务外合同。
- 继续单独运行可达门槛：后端限定范围 `pnpm lint` 与 `pnpm build` 通过。根 `pnpm typecheck` 被未修改路径 `apps/web/src/features/pm/service/notification-inbox-model.ts`、`project-files/model.ts` 的filter-card导入 / 隐式any及 `tests/artifact-files-model.test.ts` 的FilterCondition参数类型阻断；不把Agent专用typecheck通过写成全仓库类型检查通过。
- 原始contracts设置行为测试使用冻结仓根的正确runner执行：在 `vendor/t3code` 运行 `pnpm exec vp test run --config vite.config.ts packages/contracts/src/settings.test.ts`，24项通过。直接调用另一个Vitest实例或在包目录套用根include并不能运行该原始测试，未把这两次启动失败计为通过。最终Agent源码和测试类型检查再次通过。
- 独立Web / Agent产物已构建、打包并迁至 `/tmp/pm-omp-agent-relocated-3rtCH1/agent`（157依赖包、21,713文件、280内部链接）。删除原临时build与Web输出后，从 `/tmp` 执行产物自带 `tools/verify-artifact.mjs`，实际通过文件 / 链接、磁盘SDK、PTY、单一Effect、文档worker、Claude历史入口及生产HTTP检查。结果在 `.local/evidence/omp-provider/artifact-result.json`；这不代表产物中的每个Provider均完成真实账号推理，也未部署至常驻服务。
- 已关闭自建浏览器 / PM / 受控模型服务和浏览器页，移除临时harness、诊断loader、复制的 `tests/.omp-browser-fixture.ts` 及录制中可确认归属的原生临时Home。保留结果JSON、真实录制、实图和独立验收产物，不保留可误入测试集的临时代码。
- 最终离线 `verify-sync` 和 `imports --check` 已通过：1201输出可重建且重复无差异；未改上游 / 无关PM内容；源hash、commit、补丁、host工具、权限位冲突及symlink均在写入前拒绝。import清单核对1200文件、6764条边、18包。结果保留 `.local/evidence/omp-provider/source-verification-result.json`。
- 单独运行根 `pnpm test`：390项，380通过、2失败、2超时取消、6跳过。2项失败同属上述OpenAPI生成漂移；取消项为 `packages/pm-core/tests/dashboard-sprints.test.ts:35`（30秒）和 `project-locations.test.ts:42`（90秒）。未将跳过计为通过，未放宽这些任务外测试期限。
- 完整 `pnpm test:backend` 已跑完123/123文件，实际连接核对后的本副本PostgreSQL55444：856项中845通过、4失败、7跳过、0取消。失败为OpenAPI漂移2项、`tests/artifact-files-model.test.ts` 的 `conditions.filter is not a function`、`tests/local-project-backup.integration.test.ts` 的真实 `pg_dump` 调用失败。7项跳过来自真实S3夹具测试，监督器因此将该文件判为未通过。没有缺失文件摘要，不把完整跑完写成验收全绿；未修改任务外实现或接管数据库 / S3服务。
