# t3code Provider 原模块移植计划清单

日期：2026-10-30。项目：`project-management-agent-v4`。

状态：**阶段0、阶段1已验收，阶段2宿主接入进行中；未发布为PM业务任务，尚未切换常驻服务。** 用户指定实施代理为 `gpt-6.1-sol / xhigh`。以本清单的依赖与验收门槛推进，未验收阶段保持未勾选。

本文 `draft:T*`、`draft:M*` 仅为计划内编号，不是正式业务 ID。未查询 PM 任务列表，未核对现有任务，不宣称已去重；没有负责人容量或工期依据，不承诺日期。

## 1. 目标、基线与不变边界

目标：**保留上游 Provider 的模块结构、公共逻辑、协议实现及行为测试；本项目仅在宿主、传输、持久化和 PM 安全边界做适配。** 以后按固定上游 commit 同步，不继续为各 Provider 重写一份协议栈。

### 1.1 来源与事实

| 来源 | 已核对事实 / 用途 |
| --- | --- |
| S1 上游固定基线 | `30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c`；本机只读 worktree：`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/.tmp/t3code-provider-audit-30eb7e7bb1`；编制时工作树干净 |
| S2 用户指定主目录 | `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/t3code` 当前为较早的 `d53873b6a4799e87afd63c8d288ef0089f5a3748`，缺少 `provider-fx` 包，锁文件有未提交修改；不修改、不直接用它覆盖 S1 |
| S3 当前配置与真实证据 | [Provider 差异与实施记录](../reference/t3code-provider-config-diff-30eb7e7bb1.zh.md)，特别是第15—18节；历史通过不算迁移后验收 |
| S4 当前 Chat / PM 边界 | [统一 Chat 计划](agent-chat-pm-unification-plan.zh.md)、[PM 接口计划](agent-pm-interface-plan.zh.md)、[交互矩阵](agent-pm-interaction-matrix.zh.md)；以当前源码及较新实施记录为准，不恢复历史未启用方案 |
| S5 输出与用量参考 | [输出适配记录](v3-provider-output-plan.zh.md)、[v4 Usage 计划](v4-usage-page-replica-plan.zh.md)；复用当前功能与行为验收，不继承旧版本 Home 隔离等已废弃选择 |
| S6 本机代理配置 | [codex-sol 预设](../../.omp/agents/codex-sol.md) 已声明 `model: gpt-6.1-sol`、`thinking-level: xhigh`；当前说明偏 Composer，其他切片派发前须使用职责匹配且相同模型/推理档位的预设 |

已观察：S1 的 `provider-core/src/server/snapshotProbe.ts` 原始版本解析函数能把本机 `opencode v2.1.2` 解析为 `2.1.2`。当前本仓 OpenCode 已通过真实 Chat 调用，但仍使用本地移植实现；不能据此勾选本计划任何迁移验收项。

### 1.2 范围

- 覆盖现有十类：Codex、Claude、Cursor、Grok、FX、OpenCode、Antigravity、Muse Code、Pi、ACP Registry。没有“只迁成功的几家”的默认缩减。
- 保留配置、认证、安装/维护、模型目录与能力选项、原生执行、输出、信息提问、取消、原有续聊/分支/上下文移交、用量与额度；能力以真实 Provider 声明为准，不强行让每家支持所有功能。
- 保留现有 Hono HTTP/SSE、React 页面、PM scope/cwd 核验、Origin/访问检查、revision、业务工具及既有审批门禁。信息回答不能变成权限批准；运行成功不能变成业务完成。
- 保留当前原生 HOME/XDG/环境继承规则与应用私有账号状态分离；不人工读取、复制或导入凭据文件，不删除外部 Provider Home。原生 CLI 可按已授权环境使用自身账号。
- 不搬 t3code 完整 Orchestrator、业务数据库、Project/Worktree 系统、WS/RPC 权限体系、Source Control、远程连接、桌面壳或整站 UI。类型/schema 的依赖导入不等于启用对应业务服务。
- 不新增业务权限、自动重试、自动模型替换或后台能力。标题生成等隔离路径不能因此获得业务工具权限。
- **会话与持久化尚未经过统一设计，暂沿用 Agent Chat 保存方式。** 阶段交付持续提醒；Provider 原生游标/身份需要适配时只做必要、有证据的数据变换，不顺带更换存储体系。

## 2. 移植目录与唯一所有权

建议落地到 `vendor/t3code/`，保留原相对路径、包名、导出和许可证。它是可随本项目分发的源码，不是指向本机外部仓库的 symlink、绝对路径依赖或运行时源码读取。

| 范围 | 必须纳入的模块 |
| --- | --- |
| 公共运行包 | `packages/contracts`、`packages/shared`、`packages/provider-core` |
| 原生/ACP Provider 包 | `packages/provider-opencode`、`provider-cursor`、`provider-grok`、`provider-fx`、`provider-muse`、`provider-pi`、`provider-acp`、`provider-acp-registry` |
| 协议包 | `packages/effect-acp`、`packages/effect-codex-app-server`，包括实际依赖的生成协议/schema |
| 测试支持 | `packages/provider-testing` 与上述模块的行为测试、必要 fixtures；不把测试包加载到生产路径 |
| Codex 服务器模块 | `apps/server/src/provider/Drivers/CodexDriver.ts`、Codex Provider/Home/安装/Managed Runtime/Token Broker/ChatGPT 认证/模型/MCP/用量依赖；`orchestration-v2/Adapters/CodexAdapterV2.ts`、`textGeneration/CodexTextGeneration.ts` |
| Claude 服务器模块 | `provider/Drivers/ClaudeDriver.ts`、Claude Provider/Home/Executable/Skills/模型/用量/额度依赖；`orchestration-v2/Adapters/ClaudeAdapterV2.ts`、任务输出 helper、`textGeneration/ClaudeTextGeneration.ts` |
| Antigravity 服务器模块 | `provider/Drivers/AntigravityDriver.ts`、Provider/安装/认证/回调/ACP/Skills/用量依赖；`orchestration-v2/Adapters/AntigravityAdapterV2.ts`、`textGeneration/AntigravityTextGeneration.ts` |
| 公共管理逻辑 | `provider/ProviderRegistry`、`ProviderInstanceRegistry*`、`builtInDrivers`、`builtInProviderCatalog`、`ModelManifest`及 JSON 资源、状态缓存、版本/安装/维护逻辑；认证与宿主实现按第3节适配 |
| 客户端模块 | `client-runtime/src/providerClients.ts`、`providerUpdateRequiredModels.ts`、`modelTraits.ts`、`state/providerInstanceDisplay.ts` 及源码依赖闭包；各 Provider 的 `client.ts`/`settings.ts` 已随包进入；按需纳入 Web 的模型/实例纯派生逻辑 |

上述独立包共 **13个运行相关包 + 1个测试支持包**；服务器和客户端模块另计，不能用14包数量宣称全部依赖已闭合。

依赖处理：S1 的 Effect / `@effect/platform-node` 为 `4.0.5`；按 S1 版本及本仓现有 SDK 补丁核对，不整体升级本仓工具链。`provider-acp` 源码运行时依赖 `effect-acp`，上游却放在 devDependencies，需按源码补闭包。完整 `client-runtime` 会额外引入 Source Control 等功能，不为几个 Provider helper 整包启用其状态系统。

同步记录至少包含上游 commit、路径清单、原文件摘要、依赖版本、必要补丁及原因、测试入口。同步工具必须离线可核对，默认不修改源仓库、不拉取最新版本、不覆盖本地未知改动；协议生成只在版本明确改变时执行。

## 3. 开工前冻结的共享合同

由主集成者签收 `draft:T2` 后，后续子代理按以下端口实现，不各自创造第二套合同：

| 边界 | 输入 / 输出与必须保持的语义 |
| --- | --- |
| PM ProviderHost | 提供已核验的 cwd、私有 state/cache/附件目录、配置快照/变更、凭据访问和后台策略；不套用上游 ServerConfig/SecretStore/BackgroundPolicy |
| 实例与配置 | 现有 instanceId、revision、显示名、启停、环境敏感标记、模型偏好继续有效；上游 `claudeAgent` 与本仓 `claude` 在此显式映射，不以改名重建账号/历史 |
| 执行与会话 | 当前 Chat generation 对接上游 ProviderAdapterV2；Scope/进程生命周期、取消、终态、原生游标、fork/handoff 的归属与 revision 规则明确；不能把旧游标直接解释成另一协议的游标 |
| 输出与交互 | 上游结构化事件转为现有 NativeOutput/SSE；条目去重、最终文本、命令输出、子代理、提问、错误、背压与恢复沿用当前语义；回调失败必须传播 |
| 认证与维护 | 映射上游 auth controller/installation 能力到现有 API；维护/认证/执行互斥，变化使旧检查失效；上游依赖 ProjectionStore/ProviderSessionManager 的部分接当前 Chat，不搬其仓储 |
| 模型与客户端 | 以原始 schema/descriptor/客户端注册信息为来源，边界转换为当前公开 DTO；内置、发现、自定义及能力选项不丢失；无模型、失效选择不得静默回退 |
| 用量与额度 | 原生读取器和实际事件为来源，接当前 usage 账本及 UI；缓存/增量/去重/缺失值语义保留；上游 CodexUsageHistory 等数据库查询不得直接落到本仓不存在的 t3 表 |
| PM 工具 | 继续使用现有 MCP/CLI 接入、当前身份/scope、operationId/收据和审批；不将 t3 orchestrator MCP、自动批准或新业务工具注入会话 |

共享文件只由主集成者修改/合入：根 `package.json`、`pnpm-workspace.yaml`、锁文件、构建配置、公共合同 exports、Provider 总注册表、主路由及公共文档入口。各切片提交所需变更说明，不并行改这些文件。

## 4. 分阶段计划与子代理分工

所有阶段须凭实际证据完成。表内代理名称为切片名，实际派发与完成另记。实施代理使用 `.omp/agents/provider-sol.md` 固定的 `gpt-6.1-sol / xhigh`；每阶段主集成者承担接口冻结、共享文件整合、检查与门槛判断。

### 阶段0：来源清单与接入合同 — draft:M0

- [x] 完成 `draft:T1`、`draft:T2` 并冻结本轮源码范围。

| 候选编号 / 代理 | 目标、范围与所有权 | 验收 | 前置依赖 | 来源 | 待确认项 |
| --- | --- | --- | --- | --- | --- |
| draft:T1 / SolSourceMap | 生成精确导入清单、文件摘要、许可证/资源/生成文件/运行及测试依赖清单；定义同步工具输入，不改源仓库 | 清单覆盖十类 Provider、14包及包外实现；源码导入和 manifest 差异明确 | 无 | S1、S2 | 仅真实源码闭包遗漏在此收敛，不缩减 Provider |
| draft:T2 / SolBoundary | 固化第3节接口、现有数据映射、错误语义及每切片文件所有权；只交付合同与验收说明，不建假运行时 | Host、实例、输出、认证、用量、PM 与客户端各有单一责任方；历史/游标切换策略明确 | 无 | S3、S4、S5 | 若发现必须改变既有持久化设计，先列差异，不擅自实施 |

**门槛：** 主集成者将来源清单与边界合同交叉核对后签收；禁止用“先复制后补接口”进入下一阶段。

### 阶段1：导入原模块与构建依赖 — draft:M1

- [x] 完成 `draft:T3`、`draft:T4`；源码可在本仓独立解析与构建。

| 候选编号 / 代理 | 目标、范围与所有权 | 验收 | 前置依赖 | 来源 | 待确认项 |
| --- | --- | --- | --- | --- | --- |
| draft:T3 / SolCoreImport | `vendor/t3code/packages/{contracts,shared,provider-core}`；保留导出、原文件结构与行为测试 | Effect 及 schema 依赖闭合；公共版本、错误、模型逻辑从上游唯一实现读取 | T1、T2 | S1 | 上游非 Provider schema 可作为类型依赖存在，但不启用业务服务 |
| draft:T4 / SolProtocolImport | 两个 effect 协议包、八个 provider 包及 provider-testing；与 T3 目录互斥 | 无外部源码路径依赖；生成协议、SDK、资源、上游测试入口齐全；生产不加载测试包 | T1、T2 | S1 | SDK版本与当前补丁冲突需记录原因和解决方式 |

**门槛：** 主集成者统一修改 workspace/锁文件，执行依赖解析、类型检查与构建；运行公共解析/配置等无账号 smoke。不启动供应商账号流程，不安装或升级宿主 CLI。

### 阶段2：接入本项目宿主与运行边界 — draft:M2

- [x] 完成 `draft:T5`、`draft:T6`；上游驱动有真实宿主，不依赖 t3code 应用数据库。

| 候选编号 / 代理 | 目标、范围与所有权 | 验收 | 前置依赖 | 来源 | 待确认项 |
| --- | --- | --- | --- | --- | --- |
| draft:T5 / SolHost | PM ProviderHost、Effect Layer/Scope、实例配置后端、认证/维护协调；负责 providers 的配置与管理边界 | 多实例隔离、配置 CAS、敏感值保留、HOME 继承、维护互斥、状态失效、附件越界拒绝均可观察；API 不双注册 | T3、T4 | S1、S3、S4 | 只迁必要账号元数据，不导入外部凭据 |
| draft:T6 / SolExecution | ProviderAdapterV2 与现有 runtime/durable/output/PM 工具桥；负责运行与事件边界，不写 T5 文件 | 完成、失败、取消、续聊、游标不匹配、信息问题、权限拒绝、SSE恢复、用量事件有统一映射；PM规则未扩大 | T3、T4 | S1、S4、S5 | 按 T2 冻结类型实现；新增接口冲突交主集成解决 |

**门槛：** 合并后通过受控原生子进程的真实 HTTP/SSE smoke，证明配置→执行→输出→持久化链路，不以 mock echo、非空响应或仅编译当验收。检查取消释放 Scope/进程、回调异常不假成功。

### 阶段3：OpenCode 首个完整接入 — draft:M3

- [x] 完成 `draft:T7`、`draft:T8`；原 OpenCode 模块已接入并通过隔离真实调用与浏览器历史验证，常驻服务尚未发布。

| 候选编号 / 代理 | 目标、范围与所有权 | 验收 | 前置依赖 | 来源 | 待确认项 |
| --- | --- | --- | --- | --- | --- |
| draft:T7 / SolOpenCode | 使用原 OpenCodeDriver/Runtime/v1-v2 Adapter、模型/维护/用量；移除已被替代的 OpenCode 手写执行路径 | 本地/远程服务、版本、密码、模型与选项、完整输出、取消、续聊、PM 工具进入新模块；无旧驱动自动回退 | T5、T6 | S1、S3 | 保持协议版本最低门槛，不顺带升级 OpenCode CLI |
| draft:T8 / SolOpenCodeCases | 独占 OpenCode 消费者行为回归及临时真实验证脚本；按已冻结边界编写，不修改驱动 | 覆盖 `opencode v2.1.2`、1.x/2.x、外部服务不被关闭、401/402、断流、终态、取消、事件重复、过期回答与恢复 | T5、T6 | S1、S3、S5 | 真实账号测试由主集成执行；供应商额度不能用 mock 代替 |

**门槛：** 主集成在隔离端口先完成受控故障场景，再使用实际已配置模型完成“设置检查→Chat SSE→真实回复→历史重读→浏览器显示”。`opencode-go/minimax-m3.1-flash` 是上轮成功参考，不是本轮保证；失败按实际原因处理。402、未知认证和模型列表必须如实区分。

### 阶段4：其余九类 Provider 按家族切换 — draft:M4

- [x] 完成 `draft:T9`—`draft:T13`；十类 Provider 的生产调用均进入原模块，协议门槛通过；真实账号覆盖按下方证据表单独记录。

| 候选编号 / 代理 | 目标、范围与所有权 | 验收 | 前置依赖 | 来源 | 待确认项 |
| --- | --- | --- | --- | --- | --- |
| draft:T9 / SolCodex | 包外 Codex 模块、协议、existing/managed、ChatGPT/Token Broker、模型、fork及用量；仅 Codex 家族文件 | 原生配置免强制登录、managed账号边界、原有续聊/fork、工具与输出不退化；上游数据库查询替换为当前端口 | T7、T8 | S1、S3 | ChatGPT OAuth此前403；真实认证不可伪称已通过 |
| draft:T10 / SolClaude | Claude包外模块、SDK、Home、Skills、compaction、模型、续聊/fork、用量；仅 Claude 家族文件 | 原生环境、压缩调度的PM复核、输出及隔离标题路径保留；无原生权限自动批准 | T7、T8 | S1、S3、S4 | SDK差异与平台/账号前提逐项登记 |
| draft:T11 / SolAntigravity | Antigravity包外模块、安装/认证/回调/ACP、用量；仅该家族文件 | 维护认证与执行互斥，模型能力和平台限制真实，无虚假跨平台就绪 | T7、T8 | S1、S3 | 平台专属能力需相应设备，不新增假 fallback |
| draft:T12 / SolSdkProviders | Cursor、Muse、Pi三包的本地桥接及各自行为测试 | 三者配置/状态/模型/执行/输出/用量进入原实现；保留 Cursor key 与登录切换边界 | T7、T8 | S1、S3 | 原生账号/平台能力分别验收，不互相代调用 |
| draft:T13 / SolAcpProviders | Grok、FX、ACP Registry桥接及公共ACP接入；独占ACP公共补丁 | Registry准备与认证、ACP生命周期/工具/取消正确；Grok/FX外部认证边界保留 | T7、T8 | S1、S3 | Registry必须指明实际被测Agent；T11所需ACP变更交此所有者 |

**门槛：** 五个切片在稳定共享边界后同批派发；各自家族互不修改，注册表由主集成统一切换。每家均有协议行为证据和明确真实账号状态。未具备账号的平台项可标阻塞，但不能勾选“十家全部真实验收”或把该家移出范围。

### 阶段5：客户端配置、模型与用量接入 — draft:M5

- [x] 完成 `draft:T14`—`draft:T16`；原客户端、配置/Composer与Usage模块门槛通过；真实额度读取结果单独记录，不等于所有账号已验收。

| 候选编号 / 代理 | 目标、范围与所有权 | 验收 | 前置依赖 | 来源 | 待确认项 |
| --- | --- | --- | --- | --- | --- |
| draft:T14 / SolClientModels | Provider客户端注册、原始schema元数据、modelTraits/显示helper及公开DTO边界；不改设置页面 | 十家字段/图标/模型能力与上游一致，现有实例ID保持；未指定或失效模型不会自动换选 | T9、T10、T11、T12、T13 | S1、S3 | 仅导入客户端必要闭包，不迁Atom/WS/多环境状态系统 |
| draft:T15 / SolProviderUi | 现有Provider设置、认证/维护、模型管理、Composer选择/能力控件；独占这些UI文件 | 保存与失败恢复、revision、敏感值遮蔽、模型刷新、键盘和390px布局；真实读取新DTO | T14 | S3、S5 | 必须等T14接口完成再派发，不以并行之名猜接口 |
| draft:T16 / SolUsage | 原生usage readers/limits与现有账本、Usage UI接线；不改T15的设置/Composer文件 | 增量去重、缓存、来源、缺失值、额度失败、身份变更不串账；不把刷新变成计费推理 | T9、T10、T11、T12、T13 | S1、S5 | 只按已发现需要适配的数据库接口修改，不重建用量产品 |

**门槛：** T14和T16可并行；T15等待T14，其运行期可与尚未结束的T16并行。主集成验证实际浏览器设置/模型/输出/Usage表面，不只运行组件测试；全页与PM内嵌Chat仍共用一条运行链路。

### 阶段6：完整切换、数据连续性与可更新性 — draft:M6

- [x] 完成 `draft:T17`、`draft:T18`；连续性、同步及独立运行门槛通过；无关后端失败与外部账号限制单独保留。

| 候选编号 / 代理 | 目标、范围与所有权 | 验收 | 前置依赖 | 来源 | 待确认项 |
| --- | --- | --- | --- | --- | --- |
| draft:T17 / SolContinuity | 会话/实例/历史连续性与跨模块消费者回归；迁完所有旧调用点，删除已废弃驱动、协议helper、别名和旧入口 | 配置/模型偏好/现有历史/合法续聊保留；不兼容游标显式处理，无双写/自动回退；PM收据与权限不变 | T15、T16 | S3、S4、S5 | 必要持久字段变更按T2约定和备份策略执行，不重设计存储 |
| draft:T18 / SolSync | 同步清单、校验/补丁工具、构建资源、发布包可移植性与升级演练；不改T17运行代码 | 临时副本离线复现同commit导入，同步无差异；人为冲突会拒绝覆盖；无外部绝对路径；SDK/生成资源/许可证可追踪 | T15、T16 | S1、S2 | 不改上游主目录或其锁文件；未来版本升级另固定commit |

**门槛：** 主集成统一跑受影响lint/类型/行为回归/构建、现有Agent套件及真实HTTP/SSE/UI smoke；数据库、事务或持久流有变更时执行 `pnpm test:backend`，跳过不算通过。旧接口已弃用的实现细节测试删除，不改断言迎合新实现。对未改源码的无关失败独立登记，不能标全绿。

### 阶段7：交付审查与受控发布 — draft:M7

- [x] 完成 `draft:T19`、`draft:T20`，并由主集成完成获授权的实际发布和发布后核验。

| 候选编号 / 代理 | 目标、范围与所有权 | 验收 | 前置依赖 | 来源 | 待确认项 |
| --- | --- | --- | --- | --- | --- |
| draft:T19 / SolBoundaryAudit | 只读审查迁移差异、配置/凭据/PM审批、实例与游标边界、遗留调用点；不得自行部署或改业务数据 | 高影响缺陷有证据、修复归属及复验；不遗留第二套执行实现 | T17、T18 | S3、S4 | 发现问题返回对应切片修复，主集成重跑受影响检查 |
| draft:T20 / SolReleaseEvidence | 汇总逐家能力/测试/真实调用证据、发布输入与回退条件；审核来源/依赖清单 | 源码交付、协议验证、真实账号验证、常驻发布四种状态分开；发布步骤只影响本仓服务 | T17、T18 | S1、S3、S5 | 所有真实供应商覆盖缺口明确，不替用户补账号/购买额度 |

**发布门槛：** 主集成核对当前端口/PID/cwd、活跃运行、当前配置和Chat存储备份，按实际变更重启本仓Agent/发布Web；不重启来源或无关服务。发布后从真实页面检查Provider、发送真实消息、核对SSE/历史/用量及PM作用域。失败回退到已备份构建和相容数据快照，不保留运行时旧驱动fallback。commit与push仍分别需要明确授权。

## 5. 依赖与阶段调度规则

表内T编号均指同名 `draft:T*`。以下为规范依赖表，`A depends_on B` 表示必须先完成B：

```text
draft:T3 depends_on draft:T1,draft:T2
draft:T4 depends_on draft:T1,draft:T2
draft:T5 depends_on draft:T3,draft:T4
draft:T6 depends_on draft:T3,draft:T4
draft:T7 depends_on draft:T5,draft:T6
draft:T8 depends_on draft:T5,draft:T6
draft:T9 depends_on draft:T7,draft:T8
draft:T10 depends_on draft:T7,draft:T8
draft:T11 depends_on draft:T7,draft:T8
draft:T12 depends_on draft:T7,draft:T8
draft:T13 depends_on draft:T7,draft:T8
draft:T14 depends_on draft:T9,draft:T10,draft:T11,draft:T12,draft:T13
draft:T15 depends_on draft:T14
draft:T16 depends_on draft:T9,draft:T10,draft:T11,draft:T12,draft:T13
draft:T17 depends_on draft:T15,draft:T16
draft:T18 depends_on draft:T15,draft:T16
draft:T19 depends_on draft:T17,draft:T18
draft:T20 depends_on draft:T17,draft:T18
```

- 任务依赖满足之外，还必须通过上一阶段门槛，不能以子代理自报完成替代验收。
- 独立切片同批派发；共享前置合同由主集成先定。实际只剩一个可执行切片时主线程执行，不为使用代理而拆出机械任务或单代理等待。
- 父任务是本次模块移植；T为成果切片，M为验收里程碑，不把阶段序号当工期或正式PM任务。
- 任一关键切片受阻时可完成不受影响的切片，但对应里程碑保持未完成；缩减十类Provider范围必须显式获得用户同意。

## 6. gpt-6.1-sol / xhigh 派发合同

### 6.1 模型与运行约定

- 每个实施/审查预设必须显式声明 `model: gpt-6.1-sol` 与 `thinking-level: xhigh`，并在启动记录核验实际生效；不能只把“xhigh”写进提示词。模型不可用时报告阻塞，不静默换模型或降低档位。
- 复用S6的模型配置格式；按职责使用相应专用预设。若仅保留当前Composer预设，不用它的旧职责说明代替后端切片合同。只读未知子系统调查使用scout，已知差异审查使用reviewer；同样须核对指定模型和档位。
- 子代理不得再派子代理；只改分配目录，保留无关并行修改。导出符号修改前查询引用；未知接口先通知主集成。
- 实施子代理不在共享工作树中途运行build/lint/tests/formatters、安装依赖、启动供应商、重启服务、迁移数据或发布。可以编写必要行为测试与验证脚本；主集成在本阶段合并后统一执行。
- 主集成不空等：同步完成共享文件整合准备、接口核对和下一阶段前置工作；收到结果后再执行对应门槛。

### 6.2 每次派发必须包含的内容

```text
任务：draft:T编号；阶段：draft:M编号；切片名：表内代理名。
模型：gpt-6.1-sol；thinking-level：xhigh（启动配置核验，不是提示词模拟）。
来源：固定commit、只读源码根、导入清单及必要补丁。
目标：本切片可观察的完整成果，不是编译通过的空骨架。
所有权：允许修改的精确路径；禁止修改的共享文件及相邻切片。
共享合同：T2签收版本、输入输出、持久字段与错误语义。
验收：本任务表与本阶段门槛；哪些由主集成实际执行。
约束：PM/凭据/Home/会话边界；无中途检查/部署/嵌套代理。
交回：修改路径、上游来源与偏离、已实现行为、待主集成执行的命令、真实阻塞。
```

子代理交回不标记已验收。主集成记录实际命令、退出码、通过/失败/跳过数、HTTP/SSE/截图证据及运行范围后，才勾选对应阶段。

## 7. 验收覆盖与发布交接

每家Provider均维护同一张证据矩阵，列为：配置/状态、模型/选项、认证/维护、执行/取消、输出/交互、原有续聊/fork/handoff、PM工具、安全边界、用量/额度、真实账号状态。能力原生不支持时注明来源；功能应支持但失败时记缺陷，不能伪装成不支持。

必测场景：以下勾选表示对应自动化、受控协议及执行记录中注明的真实场景已经验证，不表示十家供应商的真实账号、额度或所有平台均通过。实际失败和外部前提仍以第8节为准。

- [x] 空配置、禁用、CLI缺失、版本输出差异、401/403/402、网络/启动失败分别如实显示；检查不计费。
- [x] 真实生成与结构化输出完成；断流/错误/取消不假成功，停止后无本次遗留子进程；回调失败传播。
- [x] 模型能力选项实际下发；自定义/隐藏/排序/收藏/默认值保持；未指定与失效模型不自动替换。
- [x] 多实例、账号/环境变化、并发保存、合法续聊与过期游标；旧历史可读，重启和SSE恢复一致。
- [x] 信息提问可按真实能力回答/取消；原生权限请求与PM业务审批不混用；跨scope和非法cwd仍拒绝。
- [x] PM工具使用当前已授权接口，真实读场景及隔离数据下的受控写入保留revision/幂等/收据；生产业务数据不作为破坏性测试夹具。
- [x] 桌面与390px、Provider设置和Composer、输出和Usage、全页与PM内嵌入口均实际操作；不能只靠SSR或受控模型回复证明真实账号可用。
- [x] 数据/凭据不进入日志、截图或公开证据；临时脚本与测试数据按所有权撤除，保留脱敏结果。
- [x] 离线同版本同步、冲突拒绝覆盖、构建包独立运行、必要补丁和许可证追踪均已执行。

现有代码复用点：`providers/routes.ts` 的HTTP边界、`durable/`的Chat存储/SSE、`pm-tools.ts`与PM应用服务、当前前端设置/模型/输出/Usage表面。其内部调用迁向上游模块，重复驱动和协议逻辑在各切换阶段删除，不长期双轨。

发布前必须把真实账号/额度/平台前提、未通过场景和必要持久字段变更写明。前一轮OpenCode成功、51项测试或其他历史数字均不能直接作为本轮结果。

若以后需要创建正式PM任务，先读取实际工作区/项目与既有任务，核对去重后另行映射 `draft:T*` 到真实ID；本文不执行业务创建或状态转换。

## 8. 执行记录

- 2026-10-30：完成只读模块调查及本计划编制；未启动20项候选任务，未修改Provider实现、代理配置、数据库或常驻服务。
- 本计划定向校验通过：7个本地链接、20个唯一任务、8个阶段、依赖无环且与任务表一致、代码围栏闭合。README已增加计划入口。`pnpm check:docs` 退出1，原因是README既有 `docs/implementation/v4-usage-page-replica-plan.zh.md#8-实施与验收记录2026-10-30` 缺少检查器要求的显式锚点；该无关内容未修改，不宣称仓库文档检查全绿。
- 实施启动：新增职责匹配的 `.omp/agents/provider-sol.md`，固定模型 `gpt-6.1-sol`、`thinking-level: xhigh`；SolSourceMap/SolBoundary交付阶段0。主集成校验[源码清单](../../vendor/t3code/source-manifest.json)全部949个源文件SHA256一致，签收[宿主合同 pm-provider-host/1](t3code-provider-host-contract.zh.md)。清单包括14个完整包、857个计划复制文件、92个参考/复用文件、6282条导入边和292个待迁入行为测试文件；这些数量不是测试通过数。
- 阶段1已派发SolCoreImport与SolProtocolImport；主集成负责嵌套workspace、依赖版本、隔离测试配置及共享宿主端口。启动前服务观察：Agent/publicWeb HTTP200，PM readiness不可达；既有Agent PID42467、API24624、Worker23398、Gateway23401，未重启任何服务。真实Provider验收仍未开始。
- 阶段1验收：14包647个原文件导入，生产依赖分类及宿主export为显式补丁；补入Pi测试使用的纯输出helper，以及隔离的6包Markdown外部补丁闭包，未全局更换现有PM/Web渲染依赖。修复原Effect协议版本混用与测试runner peer实例分裂后，14包typecheck通过，215个测试文件通过、2137项通过、2项跳过（不计通过）。现有Agent源码及测试typecheck、受影响新增代码oxlint通过。独立esbuild产物实际执行本机`opencode --version`并经原解析器识别`2.1.2`，原schema有效/无效输入smoke通过；临时脚本已撤除。尚不是真实推理或常驻切换验收。
- 阶段2实施：SolHost、SolExecution同批负责宿主与执行切片，均使用固定provider-sol配置。主集成补齐应用Scope装配、独立源server包元数据、生产workspace打包与文档worker入口；这些接线尚待集中验收。先修复原`mergeProviderInstanceEnvironment`默认读取全局环境的问题：新增并发绑定回归失败前/通过后验证，5项定向测试通过；独立编译产物实际启动两个Node子进程，环境键严格隔离、未继承额外ambient变量。后续宿主依赖安装通过（保留peer警告），未自动安装CLI或重启服务。重新核对本副本监听PID/cwd后，PM live与ready均返回成功，database/storage/worker/core为true、quarantinedEvents为0；这不等于Provider推理验收。
- 阶段2验收：受控原生 ACP v2 子进程经原 FX Driver、真实 HTTP Chat/SSE 计算得到 `M2_NATIVE_RESULT=42`；历史重读、SSE replay、用户取消、原生权限拒绝、消费者回调失败及6个自有进程退出均通过。未调用真实供应商、未写PM业务对象。修复原FX强制模式绕过typed ACP编码及structured输出仅终态写journal两处真实链路问题；paragraph未闭合尾段继续缓冲，turn模式不提前发布。Agent源码/测试typecheck及受影响oxlint通过；此次集中回归76项中75项通过，旧Codex受控CLI fork断言因原执行入口已替换而失败，保留该回归，待T9原Codex装配后复验，不宣称全套通过。此前宿主/执行43项、原认证/凭据/维护/附件58项、SQLite17项、ACP/FX148项及新FX原生回归2项分别通过。认证unknown仅在原模块明确ready时视作可用，不伪造authenticated身份。会话与持久化仍沿用现有Chat保存方式，未完成统一设计；未重启常驻服务。
- 阶段3验收：SolOpenCode/SolOpenCodeCases及收口切片均使用 `provider-sol`（`gpt-6.1-sol / xhigh`）。OpenCode生产执行只经过原Driver/Runtime/v1-v2 Adapter，删除旧本地transport/output/question实现；修复SSE订阅先于会话创建、原生命令累计输出去重、问题完成回执及已关联子会话独立根节点的展示边界。原包16个测试文件142项通过；OpenCode消费者与共享事件/执行99项通过、无跳过；另有宿主/续接/执行22项通过。原包和Agent源码/测试typecheck、隔离生产构建通过。受影响Provider代码lint通过；共用测试夹具既有 `Promise.allSettled([...active])` 警告保留，未改无关行。
- 阶段3真实证据：本机 `opencode v2.1.2`、明确模型 `opencode-go/minimax-m3.1-flash` 经生产装配、临时PM数据库schema和随机HTTP端口，两轮独立验收分别得到 `1770→1777`、`960→967`；每轮第二次均复用同一原生session，Chat SSE终态及历史重读一致。设置检查 `ok:true`、认证身份仍为 `unknown`，未伪造authenticated。实际浏览器完成登录、Agent门禁、Provider检查及两次历史回复显示；首轮发现测试夹具固定来源地址拒绝浏览器登录，改为匹配所保留临时网关端口，未关闭来源校验。浏览器页签已关闭，自有控制器/烟测进程和临时运行目录已撤除；原生供应商会话按其所有权保留。未重启常驻服务。
- 阶段3发现并交阶段5处理：当前Web的 `provider-card.tsx` 仍把非Codex的unknown身份显示为“尚未确认就绪”，与原模块明确ready的检查结果不一致；T14/T15须消费真实就绪DTO，保留身份unknown，不以认证文案代替可用性。当前会话/持久化仍沿用Agent Chat保存方式，统一设计尚未收口。其余九类Provider、完整UI/Usage、同步演练和受控发布尚未验收。
- 后续每阶段追加：实际代理模型/档位、接口版本、文件范围、检查与smoke、未验收能力、发布状态；没有证据的格子保持未勾选。

### 阶段4继续执行记录（模块与协议门槛通过）

- 按用户授权恢复任务，继续使用 `provider-sol` 的 `gpt-6.1-sol / xhigh`。原生家族、共享历史证明、原服务测试宿主由独立切片收敛；没有重启常驻服务、提交或推送。
- 本轮已实际完成：PM契约构建、14个原包typecheck、选入原server模块typecheck、Agent源码/测试typecheck、Agent及契约oxlint、隔离生产构建；常驻产物未覆盖。
- 发现并修复两处真实宿主问题：Claude首次检查的私有stateDir尚未创建，导致已安装CLI被误报未安装；Grok初始化探针使用了PM进程cwd而非项目cwd。前者真实子进程回归失败前/通过后成立，宿主8项通过；后者与Codex定向原生回归合计13项通过。
- 家族消费者回归已从206项中的7项失败收敛为 **217/217通过、0跳过**；原模块全套 **297个文件通过，3512项通过、2项跳过**，跳过不计通过。修复Antigravity受控原生peer的原schema编码及mode配置、OpenCode保留进程生命周期和独立原生完成证明、原回滚replay的idle查询。错误场景验证拒绝后的原生状态、无额外prompt及无替换session，不绑定内部错误文案。原大历史夹具在一次事务中写入相同数据量，未缩小分页/去重断言或提高超时。
- 本轮真实检查/调用结果如下。原生程序自行使用现有授权环境；未读取凭据文件或自动导入账号。状态检查不代表计费推理成功。

| Provider | 实际原生状态 | 认证身份 | 原生就绪 | 本轮真实模型调用 |
| --- | --- | --- | --- | --- |
| OpenCode | 已安装2.1.2 | unknown | true | 最新生产HTTP/SSE：`opencode-go/minimax-m3.1-flash` 两轮 `3083→3090`，同一原生session，历史回读通过 |
| Codex | 已安装0.163.0 | authenticated | true | `gpt-6.1-sol`：原执行入口两轮 `1112→1119`，同一原生session；该次不是浏览器验收 |
| Claude | 已安装2.1.303 | unknown | true | 原执行入口调用 `claude-opus-5-5` 被实际服务拒绝：`api_error_403`；未算推理通过 |
| Cursor | 原SDK检查为installed | unauthenticated | false | 缺少已认证原生账号，未调用 |
| Muse | not-installed | unknown | false | 未调用 |
| Pi | 已安装1.1.0 | authenticated | true | 无诊断包装的原执行入口，继承原生 `default` 模型，两轮 `1199→1206`、同一session续聊通过；曾出现的首轮 `session_mismatch` 后续未复现，未宣称根因已修复 |
| Grok | not-installed | unknown | false | 未调用 |
| FX | not-installed | unknown | false | 未调用 |
| Antigravity | not-installed | unknown | false | 未调用；受控协议夹具不算供应商账号验收 |
| ACP Registry | 未配置真实具名Agent | 未检查 | 未检查 | 未调用；协议回归使用明确命名的受控原生Agent |

- T9—T13模块/协议门槛通过，进入T14与T16并行接入。Pi历史间歇失败的现有证据不足以确定根因；透明RPC观测、原权限扩展、并发负载及最终无诊断调用均已核对，保留该风险供T19和发布前真实验证复核，不把后续成功写成已修复。另修复Linux `/proc` 枚举的Dirent回退竞态：退出中的无关PID不再使整个ACP进程快照失败，原有PID身份/所有权检查保留；修改后原包仍为3512通过、2跳过。
- **会话与持久化仍暂沿用Agent Chat保存方式，统一设计尚未收口。** 常驻服务未发布；客户端、Usage、连续性、同步工具及受控发布继续按阶段门槛执行。

### 阶段5继续执行记录（客户端与浏览器门槛通过）

- SolClientModelsM5、SolSettingsUiM5、SolComposerUiM5与SolUsageM5按 `provider-sol`（`gpt-6.1-sol / xhigh`）交付；主集成完成实际浏览器验收。原模块仍位于 `vendor/t3code/packages`，根目录 `packages/agent-client-runtime` 只提供PM客户端边界，不是另一套Provider实现。
- 原客户端注册、动态schema、图标、模型别名/能力和原生就绪DTO已进入现有设置及Composer；身份unknown与原生ready分开显示。禁用实例可读取原生历史，但不能取得执行实例。Usage使用原reader及原额度探针，缓存按实例、revision、环境与Home绑定；失败不伪装为零额度。
- 集中检查：PM包构建、15个选入原包及原server/Agent源码和测试typecheck通过；原模块 **298个测试文件、3523项通过、2项跳过**。客户端17项、元数据/就绪31项、Composer行为4项、宿主与Usage103项通过；Claude额度修复定向3项通过。Web lint/typecheck/build及Agent lint、隔离Agent构建通过。Web构建仍有大chunk和混合静态/动态导入警告。
- 修复原额度刷新证据与缓存时间混淆：保留原快照关联的真实探针结果，不用普通状态检查时间推断额度成功。Claude额度测试显式给原Fetch层注入各自传输，避免Effect默认Reference缓存串用前一夹具。宿主平台只装配需要的Node服务，不再为每个Provider创建交互终端；原生stdin/auth传输保留，21项宿主/reader回归未再出现监听器警告，新增监听器数量不变断言在103项回归中通过。
- 本轮隔离真实OpenCode：`2.1.2`、`opencode-go/minimax-m3.1-flash`，生产HTTP/SSE两轮 **1876→1883**；随后实际全页Composer选择原生Low并发送得到 **1894**，PM内嵌Chat读取同一历史并发送得到 **1895**。四代均为completed，原生session始终为 `ses_e73116335ffe7968LV7ycX9rgd`；没有用受控回复替代真实调用。
- 实际浏览器完成十家创建入口、ACP Registry/本地命令切换及字面参数控件、真实revision冲突后的草稿保留/放弃/刷新、键盘失焦保存、密码字段遮蔽/留空保留/显式清除。桌面与390px设置、Chat和Usage均已观察；390px文档宽度为390，无横向溢出。PM内嵌验证使用隔离数据库中创建的项目入口，并明确选择工作区会话续聊，不写生产业务数据。
- Usage实际展示原生历史与部分覆盖提示；OpenCode Go额度实际返回 `OpenCode Go could not read usage.`，界面明确显示查询失败及未知窗口，不显示零余额。该账号额度读取**未通过**，不影响已证实的模型调用；其余禁用实例额度为未检查。
- `pnpm test:backend` 首次受外层900秒截止中断：31个完整文件汇总170项通过、2项失败、0跳过，第32个文件中断不算通过。两项失败指向既有PM OpenAPI生成物漂移，与Provider模块无关，未覆盖该产物；剩余92个文件通过现有串行runner续跑，最终结果尚待阶段6记录。
- 文档检查器改为实际Markdown标题解析，Unicode、重复标题、行内代码和显式锚点smoke通过，围栏中的伪标题/伪HTML锚点被拒绝。临时文档、额度诊断loader及浏览器控制器已撤除；自有浏览器/服务退出0，原生会话按所有权保留。
- Web检查曾更新网关正在使用的 `apps/web/dist`，而常驻Agent旧DTO没有 `nativeSessionReady`。为避免提前混发，保留新版入口后，用现有上一版 `index-D4FqR2KC.js` / `index-C8TuOFr1.css` 恢复静态HTML入口，未改源码或重启服务。先在隔离预览核对，再在实际3224浏览器确认旧版OpenCode2.1.2卡片与当前API兼容、无资源错误；预览和页签已关闭。后续Web验证必须使用隔离outDir，新Web/Agent在阶段7一起受控发布。
- **会话与持久化仍暂沿用Agent Chat保存方式，统一设计尚未收口。** 阶段6继续处理连续性、旧入口收口、源码同步和独立发布产物，阶段7负责审查与受控发布。

### 阶段6集成记录（连续性、最终产物门槛通过）

- SolContinuityM6、SolSyncM6及集成修复切片SolConsumerGateM6、SolProcessGateM6均使用 `provider-sol`（`gpt-6.1-sol / xhigh`）。旧实例ID、私有配置、未知历史字段和原生会话标识保留；移除旧进程helper、错误再导出及未引用的旧WorkspaceSurface，不恢复完整执行计划UI。
- 原生历史中的“曾完成”不再等同于“当前游标”：无最新tip证明、较新弱根或失败根后的旧完成边界不能冒充当前恢复点；历史精确fork与无游标原生恢复仍保留。Pi/OpenCode采用原模块提供的完成证明，不编造应用turn；原生fork能力不再硬编码为仅Codex/Claude。
- 真实OpenCode2.1.2、明确 `opencode-go/minimax-m3.1-flash` / Low：HTTP/SSE **2847→2854**，全页Composer续聊 **2859**；从第一轮通过既有授权HTTP接口创建分支，实际Chat发送得到 **2850**，PM项目内嵌入口明确选择工作区分支后再发送得到 **2852**。父会话仍为3代；分支2代分别为native-fork/native，全部completed。父原生session为 `ses_e72b3a6dbffe8UYdWdyZqfoxpn`，分支为 `ses_e72a6e7c7ffe92DFRoaueGcw5J`；未声称点击了当前不存在的fork UI入口。桌面、390px及内嵌表面均实际观察，新Web入口为 `index-DWl23vGb.js`。自有浏览器与随机端口服务已关闭，服务退出0、隔离PM数据已撤除，供应商会话按所有权保留。
- 全量Agent回归先发现旧就绪夹具、Node不可导入的React国际化依赖、标题夹具未启动原应用及错误的v1进程生命周期断言。修复后634项中631项通过、3项失败、0跳过/取消；剩余标题与FX用例随后定向 **15/15通过**，最终全量复验另记。此前根文件系统接近满载引起的期限取消，在私有可执行tmpfs中消失，未增加原测试期限。
- 管理式Codex标题测试发现真实环境漏洞：完整已清理环境经默认合并重新带回被删除的凭据覆盖。仅在原标题模块的MCP枚举与exec两个完整环境调用处设置 `extendEnv:false`，保留通用部分环境合并语义；真实子进程夹具验证未带回秘密，原标题模块 **12/12通过**。纯 `agentText` 已从React依赖中抽离并迁移全部值调用方，无兼容再导出。
- 同步清单收敛为959个固定输入、861个选入原文件及154个精确补丁。已实际验证1159个输出的离线重建、重复无差异、pristine模式、冲突前零写入、错误源码/commit/补丁及symlink拒绝；既有0664文件按Git可执行位语义保留，不擅自chmod，特殊权限拒绝。最后两行Codex环境补丁已重新捕获，最终同版本检查待复验。
- 独立产物首次移至仓库之外：157个依赖包、21916文件、280个内部相对链接。实际验证单Effect、磁盘SDK、Cursor SQLite与worker、原生PTY、文档worker、Claude历史入口和随机端口HTTP启动；仅证明linux-x64资源闭包，不代表这些账号推理可用。该次产物早于最后Codex环境补丁，最终产物必须重建。另实测仓库内常驻入口缺少keyring解析，已在Agent运行依赖与锁文件显式固定现有 `@napi-rs/keyring@1.3.0`，原生模块加载通过，未读取Keychain或导入账号。
- **会话与持久化仍暂沿用Agent Chat保存方式，统一设计尚未收口。** 常驻服务仍未切换；真实账号、额度及Pi既有间歇失败限制继续保留，不能用模块或受控协议通过替代供应商验收。
- 最终收敛：Agent **634/634通过，0失败/取消/跳过**；Agent源码/测试类型、受影响lint及隔离构建通过。最终同版本同步 **1159/1159未变**，AST导入检查 **6526条/17个包记录**，文档检查 **133文件/27步骤通过**。最终独立产物为157包、21918文件、280内部链接；已在仓库外从 `/tmp` 运行随包验证器，哈希/内部链接、SDK与原生资源、单Effect、文档worker、Claude历史分发和真实HTTP均通过（linux-x64）。阶段6临时浏览器控制器及旧Web预览已删除。
- 后端回归不得标全绿：前31个完整文件170通过、2个既有OpenAPI生成文件漂移失败、0跳过；续跑92个文件最终为674通过、3失败、7跳过、0取消。失败分别是 `artifact-files-model.test.ts` 的 `conditions.filter is not a function`、`dashboard-time.integration.test.ts` 邮件夹具初始化超时、`local-project-backup.integration.test.ts` 的真实 `pg_dump` 失败；S3套件7项缺少实际MinIO/显式S3测试配置而跳过。未覆盖无关 `docs/contracts/openapi.yaml`、修改这些PM测试或将跳过计为通过。

### 阶段7审查修复与发布验证

- 审查、实施和定向复核继续使用职责匹配的 `gpt-6.1-sol / xhigh` 子代理；主集成执行全部检查及发布。已修复完整管理式Codex环境重新合并泄露覆盖、原生PM工具异步请求期间授权失效、安装终态早于最终清理、应用停机遗漏维护任务，以及迁移私有目录的备份覆盖与恢复策略问题。原有PM授权、revision、审批、幂等收据及业务完成规则不变。
- 原安装器现在在原启动锁内返回精确worker完成凭据；PM等待指针目录、staging及worker最终清理，保留清理失败，但不撤销已提交运行时、不取消或等待替换的新操作。两家原安装器均取得有效失败前证据，修复后8项定向回归通过。停机先同步封闭入口、取消全部已接纳维护，再等待清理，最后关闭宿主和存储；最终12项生命周期回归通过，包括停止期间不得启动后续Worker、异步构造期间切换数据根必须拒绝并清理，两类新增竞态共4项均取得失败前证据。夹具使用原安装器、受控下载/文件系统屏障及Worker启动屏障，不是供应商账号或跨平台验收。
- 新原生工具发现和派发在异步请求读取之后重新核验当前执行授权；既有已接纳操作只做结果核对，业务审批独立保留。23项实际CLI/MCP至Chat桥接回归通过。备份14项通过，官方CLI实际创建、独立恢复、验证两种策略通过；重新计算摘要但缺少明确禁用标志的exclude备份仍在创建目标之前被拒绝。
- 宿主构建/打包/随包验证器/共享来源校验器必须匹配固定摘要，旧工具链产物不得仅靠重写清单重新准入。四个工具的独立漂移拒绝和旧产物拒绝已实际执行。当前清单保留959个不可变源输入、157个精确补丁；1163个输出的离线重建、重复无差异、pristine、冲突/错误源码/补丁/工具/symlink拒绝均通过，最终同版本检查1163个文件未变，AST检查6526条导入/17个包记录通过。一次默认临时盘重建被外层180秒截止中断，不算通过；改用自有tmpfs后在相同截止内完成，未提高测试期限。
- 集成全量回归：Agent **671/671通过，0失败/取消/跳过**；原模块 **298个文件通过，3523项通过、2项跳过**，跳过不计通过。Agent源码及测试类型、选入原server严格类型、Agent lint、Web类型/lint及隔离构建通过。Web仍有既有大chunk与混合导入警告。最后一次实际Storage页面核对发现诊断API仍保留旧“外部Home导致include拒绝”文案；已与真实备份策略对齐，删除绑定旧文案的断言，随后Agent源码/测试类型、定向lint、诊断4项及最终隔离构建通过，并在发布页面确认新说明。
- 受控发布已完成：先核对PID/cwd、活跃生成、Workspace Run和维护状态；官方CLI对生产Agent数据执行私有include备份、独立恢复和验证，旧构建在原安装依赖位置用隔离数据实际启动成功。仅切换本仓Agent和Web，Worker23398、PM API24624、Gateway23401的启动身份保持不变；最终Agent PID12347，Web入口 `index-CB_6C2RV.js`。首次由Python启动缺少Shell原生代理环境，Codex路由发现超时；改回现有Bash服务启动入口后Codex恢复authenticated/ready，未改账号或凭据。回退输入保留在 `.local/provider-m7-5nbevc_e/rollback`；旧Agent构建须恢复到原安装位置后运行，不把离线备份目录当作独立运行包。
- 发布后真实OpenCode2.1.2、明确模型 `opencode-go/minimax-m3.1-flash` / Low：实际全页Chat得到 **3283→3294**，最终Agent重启后继续得到 **3295**。三个生成均completed，后两次为native续聊，同一原生session `ses_e720499f5ffeTuG8mZTQW1TSL7`；实际POST返回HTTP200/SSE，历史回读一致。设置检查ok/ready，账号身份仍unknown。五个原有会话在发布、测试和清理后历史摘要均保持不变。
- 实际项目 `PRJ-001` 的内嵌Chat明确保持项目scope，原OpenCode工具调用 `pm_read` 成功，收据 `0bfb711c-1755-4fdf-88ba-4a8d18f97954` 为succeeded，并得到 **M7_PROJECT=657**；没有写生产业务对象。全页/内嵌、桌面/390px、原生历史Usage及Storage均实际观察；390px无横向溢出，Usage明确标记部分覆盖，不把缺失数据当零。OpenCode Go额度读取失败仍保留，未用模型调用通过代替额度验收。
- 最终仓库外独立产物 `release-complete-agent` 为 **157包、21706文件、280内部链接**；从 `/tmp` 执行随包验证器，哈希/内部链接、磁盘SDK、原生PTY、单Effect、文档worker、生产Claude历史分发和实际API-only HTTP均通过，仅证明linux-x64资源闭包。最终脱敏证据为 `.local/provider-m7-5nbevc_e/release-evidence.json`。两个自有Chat测试会话已删除，原生供应商会话及审计记录按所有权保留；浏览器、临时认证控制器/脚本/Socket和过期自有构建已撤除，临时登录注销后实际返回401。没有commit或push。
- **会话与持久化仍暂沿用Agent Chat保存方式，统一设计尚未收口。** 真实账号、额度、平台前提及Pi既有间歇失败限制继续保留；不宣称全仓库后端检查全绿。
