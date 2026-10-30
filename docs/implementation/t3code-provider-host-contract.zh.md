# t3code Provider → PM 宿主接入合同

合同标识：`pm-provider-host/1`。来源：`30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c`。适用 [迁移计划](t3code-provider-module-migration-plan.zh.md) 的 T5/T6 及后续 Provider 家族切片。

**状态：T2冻结合同已与T1固定来源清单交叉签收；本文不是运行实现或真实Provider验收声明。** 主集成已校验清单全部949个源文件摘要。后续实现按本合同的唯一所有权推进，不得把声明代码当作可以返回固定值的运行时骨架。

## 1. 不变边界与名词

- 本地公开合同继续为 `@agent-workspace/contracts/{provider,output,usage,chat}`，HTTP/SSE、`NativeProviderAdapter` 继续是本地外层 API。**真正的协议、SDK、驱动、模型 schema 和原生事件生成必须调用移入的上游模块**；不得把原模块仅用于填 `source`/metadata，执行仍走另一套手写协议。
- 上游 `ProviderAdapterV2` 的 `RunId/RunAttemptId/NodeId` 只是适配器要求的技术关联 ID；映射当前 Chat generation，不创建 PM 业务 Run、Execution 聚合、t3 Orchestrator、ProjectionStore、t3 业务库或新的恢复引擎。现有非 Chat workspace execution 的调用继续存在，但不得扩大其 PM 权限。
- `instanceId`、本地 `driver`、账号/环境 revision、显式模型、Home/cwd、Chat scope、系统指令和原生边界分别校验。上游 `continuationKey` 相同不允许跨本地实例/revision/cwd 复用。
- 当前 PM17 工具、调用身份、scope、Origin/访问检查、`operationId`、原收据、幂等和逐动作审批不变。模型回复、原生命令退出码、Provider turn completed 都不是业务写入或任务完成收据。
- **会话与持久化尚未经过统一设计，当前暂沿用 Agent Chat 保存方式。** 不替换 `durable/store.ts` 的 `records` 存储、Chat journal、线程历史或当前输出恢复协议；第 7 节只允许必要的 Provider continuation 附属记录。
- 来源仓库只读。`vendor/t3code/` 是随产品分发的源码，不是外部绝对路径、symlink 或运行时读取来源目录。补丁逐条进入 T1/T18 补丁账本。

### 1.1 已读源码依据

表中 `U/` 表示固定来源根；落地后为 `vendor/t3code/` 下的相同相对路径。行号是本次读到的固定来源/当前工作树位置，不表示未执行的测试证据。

| 依据 | 代码事实 |
| --- | --- |
| `U/packages/provider-core/src/server/ProviderHost.ts:15–54` | paths、settings snapshot/changes/scoped subscribe、后台策略、附件解析、凭据端口；没有 PM 权限或执行数据库 |
| `U/packages/provider-core/src/server/driver.ts:35–120` | `create(input): Effect<ProviderInstance, ProviderDriverError, R \| Scope>`；每实例 mutable state 隔离；实例持有原 `orchestrationAdapter/auth/snapshot/textGeneration`；usage 是 driver 级 reader |
| `U/packages/provider-core/src/server/ProviderAdapter.ts:396–648` | openSession 需要 Scope；会话暴露 events、ensure/resume/fork/start/interrupt/respond/readSnapshot；无 `closeSession` 方法，关闭靠拥有它的 Scope |
| `apps/server/agent/src/providers/driver-adapter.ts:10–77` | 当前 context、Promise 风格的 NativeProviderAdapter、run 回调、PM `{command,args}` 传输配置 |
| `providers/runtime.ts:42–136`（下文省略 Agent src 前缀） | 必须显式实例/模型；resolve 与执行前 revision 核验、账号忙检查、cwd/续聊/fork 校验、执行占位及 limits 回调 |
| `providers/instances.ts:68–118,195–238,279–334` | 当前环境保留/剔除规则、原生 Home 与应用 state 分离、环境 binding、全局单调 revision、CAS、敏感值往返、观察值绑定 revision |
| `durable/chat-runtime.ts:543–650,651–885,887–968,1096–1138` | nativePlan 的 scope/cwd/system/model 检查；generation-scoped PM bridge；输出/usage/session 回调；终态、取消、重启标 interrupted 而非重放 |
| `durable/native-output.ts:150–219,296–435` | 累积条目、独立命令输出、一次性 live interaction、拒绝过期回答、队列 128 后 snapshot reset |
| `pm-tools.ts:179–245,286–305` | loopback generation bridge；未知结果按原 operationId 核对；破坏性工具先 pending_approval，原操作原子领取后才派发 |
| `usage/ledger.ts:23–108`、`usage/service-tiers.ts:22–131`、`usage/limits.ts:21–81` | 原生 telemetry/历史优先级、turn 去重、冻结 launch 选项、revision/账号/并发刷新保护，不是 t3 SQL 投影 |

## 2. 精确文件所有权与集成顺序

所有新模块路径相对仓库根。`*.test.ts` 仅指与本行精确新增模块同名的测试，不授权改其他切片测试。T5/T6 并行前，主集成者先落地声明、包导出和下列共享补丁；本合同不授权子代理自行改这些文件。

| 所有者 | 精确新增路径 / 既有路径 | 唯一职责 |
| --- | --- | --- |
| 主集成者 | `apps/server/agent/src/providers/t3code/contract.ts` | 第 3 节共享本地声明；不是第二套 Provider/schema 定义 |
| 主集成者 | `vendor/t3code/packages/provider-core/src/server/ProviderRuntimeHost.ts` 及该包 export | 第 6 节通用宿主运行绑定 tag；只含 host/transport 端口，无 PM、Hono、durable 或本地包反向依赖 |
| 主集成者 | `vendor/t3code/packages/provider-core/src/server/instanceEnvironment.ts` | 第 5 节 bound environment 默认值补丁及账本登记 |
| T5 / SolHost | `apps/server/agent/src/providers/t3code/host.ts` | 原 ProviderHost 服务值与 layer、paths/settings/background/附件边界 |
| T5 | `apps/server/agent/src/providers/t3code/host-runtime.ts` | Node/Effect 4.0.5 基础层、实例 Scope 与 acquire；不消费 generation 事件 |
| T5 | `apps/server/agent/src/providers/t3code/config-mapping.ts` | local driver/config/environment ↔ 原 schema；不维护第二份模型目录 |
| T5 | `apps/server/agent/src/providers/t3code/credentials.ts` | 仅应用私有凭据持久端口与 binding；不读取外部原生 credential 文件 |
| T5 | `apps/server/agent/src/providers/t3code/management.ts` | upstream auth controller/snapshot/维护能力 → 现有管理 DTO；复用当前互斥和 revision |
| T5 | `apps/server/agent/src/providers/t3code/upstream-services/{server-config,server-settings,server-environment,server-secret-store,attachments,document-text}.ts`（花括号为该目录下六个独立精确文件） | 第 10 节具体 t3 应用依赖的 PM 宿主适配；不启动 t3 应用层 |
| T5 | `apps/server/agent/src/providers/{instances,auth,maintenance,checks}.ts` 及各自同名测试 | 接通原 schema、配置变更通知、当前互斥、状态失效；不改 runtime/durable 执行 |
| T6 / SolExecution | `apps/server/agent/src/providers/t3code/execution.ts` | acquire → 原 AdapterV2 session/turn → 现有 run Promise 的完整链路 |
| T6 | `apps/server/agent/src/providers/t3code/runtime-host.ts` | generation/thread 隔离的 ProviderRuntimeHost 实现；仅绑定/释放 PM stdio 配置和原生权限策略 |
| T6 | `apps/server/agent/src/providers/t3code/events.ts` | 上游事件的唯一 NativeOutput/interaction/result 适配器 |
| T6 | `apps/server/agent/src/providers/t3code/continuation.ts` | session/thread/turn 元数据编解码、原生 resume/fork、旧游标校验；不重写原生 fork 协议 |
| T6 | `apps/server/agent/src/providers/t3code/usage.ts` | live 事件 → NativeUsageUpdate、原始 usage reader 边界声明/转换；不拥有 Usage 页面/汇总产品 |
| T6 | `apps/server/agent/src/providers/{runtime,native}.ts`、`apps/server/agent/src/durable/{chat-runtime,native-output}.ts` 及各自同名测试 | 保留外层 API 并接通以上执行模块；可在当前 durable records 内保存必要 continuation 附属记录 |
| 主集成者 | `providers/driver-adapter.ts`、`driver-registry.ts`、`catalog.ts`、`routes.ts`、`app.ts`、应用启动/退出接线、所有 `packages/agent-contracts` exports、workspace/package/build/lock/同步清单 | 接纳本合同增量字段、总注册和平台依赖；避免 T5/T6 同写。`NativeProviderAdapter` 不改成 Effect API |
| 主集成者 | `durable/engine.ts`、`durable/forks.ts`、`durable/threads.ts`、`durable/thread-title.ts`、`pm-tools.ts` | 如需额外 execution identity 接线，由父级统一修改；既有保存/审批/收据及非 Chat 消费者行为不重设计 |
| T7、T9–T13 | 各自家族 `providers/drivers/<family>` 既有文件；对应 `vendor/t3code` 原 driver/adapter/SDK callsite | 构造薄 NativeProviderAdapter façade，接原模块；删除本家族被替代协议。第 6.2 节传输 callsite 补丁由各家族承担，T5/T6 不越界改包 |
| T14/T15/T16 | 模型客户端 / 设置与 Composer UI / Usage 产品 | 分别消费原 schema、现有管理 DTO、usage reader；不另建 Host 或 execution adapter |

`ProviderInstanceRegistry.ts` 本身的 reconcile/Scope 算法可复用；`ProviderInstanceRegistryHydration.ts`/mutator 的默认实例注入、ServerSettings 后端和 watcher 是宿主适配点。不得照搬 hydration 后额外生成 `claudeAgent` 账号或 devReplay 实例。T1 清单扩大的是源码闭包，不扩大上述可编辑所有权。新增缺口须由主集成者分配，不能按同目录擅自扩权。

## 3. T5 ↔ T6 冻结本地接口

以下是 `t3code/contract.ts` 的规范声明，类型 import 路径是实际源路径/现有包 export；实现函数分别位于第 2 节文件。不得把 `unknown` 的 config 强转为某家族 schema；必须用该 `ProviderDriver.configSchema` decode。

```ts
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { AgentScope } from "@agent-workspace/contracts/chat";
import type { NativeSessionRef, ProviderDriver } from "@agent-workspace/contracts/provider";
import type { ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import type { ProviderRuntimeHostService } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import type { CliChatResult } from "../../agents/cli-chat.ts";
import type {
  ProviderDriverContext, ProviderDriverRunOptions,
} from "../driver-adapter.ts";
import type {
  ProviderInstance as T3ProviderInstance,
  ProviderContinuationIdentity,
} from "@t3tools/provider-core/server/driver";
import type { PmProviderFamily } from "./registration.ts";
import type { PmNativeUsageReader } from "./native-usage.ts";

export type PmProviderPurpose = "status" | "execution" | "auth" | "maintenance" | "usage";
export type PmExecutionIdentity = {
  readonly threadId: string;
  readonly generationId: string;
  readonly messageId: string;
  readonly scope: AgentScope;
};
export type PmProviderBoundaryError = Error & {
  readonly status: number;
  readonly code: string;
  readonly errorClass?: "usage_limit" | "authentication" | "cancelled" | "unsupported" | "provider_error";
  readonly resetAt?: string;
  readonly terminalStatus?: "failed" | "cancelled" | "interrupted";
};
export interface PmProviderUsageLease {
  readonly localDriver: ProviderDriver;
  readonly instanceId: string;
  readonly revision: number;
  readonly cwd: string;
  readonly nativeHome: string;
  readonly usage?: PmNativeUsageReader;
  // Re-read the local authoritative instance and fail, never silently refresh this lease.
  readonly assertCurrent: Effect.Effect<void, PmProviderBoundaryError>;
}
export interface PmProviderLease extends PmProviderUsageLease {
  readonly continuationIdentity: ProviderContinuationIdentity;
  readonly instance: T3ProviderInstance;
}
export interface PmProviderHostService {
  readonly acquire: {
    (context: ProviderDriverContext, purpose: "usage"): Effect.Effect<PmProviderUsageLease, PmProviderBoundaryError, Scope.Scope>;
    (context: ProviderDriverContext, purpose: Exclude<PmProviderPurpose, "usage">): Effect.Effect<PmProviderLease, PmProviderBoundaryError, Scope.Scope>;
  };
  readonly invalidate: (instanceId: string) => Effect.Effect<void, PmProviderBoundaryError>;
  readonly shutdown: Effect.Effect<void, PmProviderBoundaryError>;
}
export interface PmProviderExecutionService {
  readonly run: (
    context: ProviderDriverContext,
    options: ProviderDriverRunOptions,
  ) => Promise<CliChatResult>;
  readonly fork: (
    context: ProviderDriverContext,
    source: NativeSessionRef,
    boundary: { readonly turnId?: string; readonly messageId?: string } | undefined,
    signal?: AbortSignal,
  ) => Promise<NativeSessionRef>;
}
```

两个 T5 工厂与两个 T6 工厂的签名也冻结如下；`driverLayer` 的输入/输出只是原 driver 依赖的具体装配，父级持有其注册，不能返回未提供的依赖或用类型断言假称 closed Effect：

```ts
export declare function makePmProviderHostLayer(
  context: ProviderDriverContext,
  services: Omit<ProviderHost["Service"], "paths">,
): Layer.Layer<ProviderHost>;
export declare function makePmProviderHostService(input: {
  readonly families: ReadonlyMap<ProviderDriverKind, PmProviderFamily>;
  readonly runtimeHost: ProviderRuntimeHostService;
}): Effect.Effect<PmProviderHostService, PmProviderBoundaryError, Scope.Scope>;
export declare function makePmProviderRuntimeHost(): ProviderRuntimeHostService;
export declare function makePmProviderExecutionService(
  host: PmProviderHostService,
  runtimeHost: ProviderRuntimeHostService,
): PmProviderExecutionService;
```

父级创建一次 `makePmProviderRuntimeHost()`，同一个值既提供给原 driver layer，也传给 execution 工厂；不能两边各建 Map。driverLayer 必须提供 R 中包括原 ProviderHost/ProviderRuntimeHost 在内的真实服务，T5 在传入 context 的作用域执行并释放该 layer；通用平台/共享算法层可由父级复用。

M5补充：同一精确context只构造一次家族layer，分别关闭执行依赖和usage依赖。`usage`租约不暴露执行实例；禁用的已存实例仍可通过同一环境/Home构造路径读取历史，但不能创建原生执行实例或取得status/auth/maintenance/execution租约。原 `ProviderUsageInstance.configured` 表示已存配置存在，禁用不等于不存在。所有租约仍受revision、环境、Home、cwd与账号维护互斥约束。

主集成者给现有 `ProviderDriverContext` 以及 `runNativeRuntime` options **只增加** `execution?: PmExecutionIdentity`；`runNativeRuntime` 将它原样传入 context。现有 `{command,args}`、所有 callback 与 `CliChatResult` 字段不改名。Chat 调用必须提供 execution（包括 idle compaction，后者不提供 PM bridge）。无 PM bridge 的既有非 Chat 调用允许没有 execution；T6 为其分配隔离的技术 thread/session ID，不能伪造 PM scope，也不能获得业务工具。**存在 pmToolBridge 而 execution 缺失时直接 412 `scope_required`，不得生成一个假的 PM generation。**

### 3.1 父级调用点与原 AdapterV2 输入投影

| 位置 / 所有者 | 精确改动 |
| --- | --- |
| `providers/driver-adapter.ts` / 父级 | context 加可选 execution 字段；不改变 NativeProviderAdapter 的 run/check/auth 签名或默认权限 |
| `providers/runtime.ts:82–136` / T6 | options 加同名字段，连同既有 pmToolBridge 传给 context；保留 resolve/execute/fork 前 revision/cwd/model/互斥守卫；不双重执行本地 fork 与原 adapter.forkThread |
| `durable/chat-runtime.ts:756–799` / T6 | 从当前 generation/thread/message/executionSnapshot.scope 构造 execution；不把请求体 identity 当受信值。原 callback 和 usage launch capture 不变 |
| `durable/engine.ts:391` / 父级 | 既有非 Chat caller 继续原 no-PM-tool 调用；其 run/step 仅作当前执行关联，不被强制升级成 Chat/business Run。需要 identity 时只补内部技术关联，不伪造 AgentScope |
| `durable/thread-title.ts` / 父级 | 标题路径保持隔离、无 PM bridge；不能误用带工具的 Chat execution service 获得业务权限 |

T6 在一个地方构造原 AdapterV2 输入，固定规则如下；原 schema 负责校验，不能用 `as` 补必填字段：

- `threadId = ThreadId.make(execution.threadId)`；`messageId = MessageId.make(execution.messageId)`；`runId = RunId.make(execution.generationId)`；`attemptId = IdAllocator.derive.runAttempt({runId,attemptOrdinal:1})`；`rootNodeId = IdAllocator.derive.rootNode({runId})`。这些 ID 不写入 PM 业务表。无 execution 的 no-tool 调用分配一次内部技术 ID，整个调用复用。
- `providerSessionId` 用原 IdAllocator.allocate.providerSession 分配；与 NativeSessionRef.sessionId 不混。`providerThread`/原生 refs 从 ensure/resume/fork 返回值获取，不按 browser ID 猜造。
- 新 thread `runOrdinal=1`，续聊取已校验 metadata 的 `providerThread.lastRunOrdinal + 1`（null 为 0）；`providerTurnOrdinal` 是已保存 providerTurns 最大 ordinal 加 1。一次 generation 内原协议创建多个 native turn 时，由原事件推进，不重新派发 prompt。序数溢出或原 metadata 缺必要身份时失败，不复用旧 run ordinal。
- `appThread` 是当前线程的只读技术投影：title 用当前 thread title 或其非空 ID；modelSelection/instance/runtimeMode/interactionMode 来自冻结输入，activeProviderThreadId 为实际原 thread；branch/worktreePath/forkedFrom 默认 null，lineage 的 rootThreadId 为当前 threadId，其他父关系 null（有已验证 fork 关系时映射）；createdBy=user、creationSource=server，时间来自当前保存的线程或 generation，archivedAt/deletedAt/settledOverride/settledAt/lastVisitedAt 为 null。guest/device/linked environment/worktree 等可选能力不设置。
- `appThread.projectId` 只满足原 schema 的技术关联：有 PM project 时使用其 ID；workspace 级无 project 时使用 `ProjectId.make("pm-workspace:" + scope.workspaceId)`。后者明确不是 PM 项目，不能用于 PM 请求/授权/创建。no-tool 无 PM scope 时使用该技术 thread 的独立 `host-thread:` 关联值，不捏造可调用 PM 的 scope。
- `message` 的 text 是当前 nativePlan 已生成的 prompt，attachments 为本次确已登记的原 ChatAttachment 数组（当前纯文本调用为 []）；createdBy=user、creationSource=server，scheduledTaskId/senderThreadId 不设置。不触发原 t3 scheduled task/subagent dispatch。appContext 不再重复注入同一 system/portable prompt。

`run` 依第 8 节把 native terminal 的 cancelled/interrupted 映射到 reject error 的 `terminalStatus`；Chat catch 必须消费这个字段，不能在 signal 未 aborted 时把原生 interrupted 一概记 failed，更不能让 run resolve 后被记 completed。普通 failure 和 callback failure 保持 failed；真正 shutdown 的 signal 仍按当前 interrupted 规则。

- T5 导出 `makePmProviderHostLayer`（`host.ts`）和 `makePmProviderHostService`（`host-runtime.ts`）；前者的输出 tag 是原 `ProviderHost.ProviderHost`，后者的值满足上述 service，平台依赖在 T5 内封装，不向 T6 泄漏 t3 ServerConfig/SQL 环境。
- T6 导出 `makePmProviderRuntimeHost()`（`runtime-host.ts`）与上述 `makePmProviderExecutionService`（`execution.ts`）；家族 façade 的 `run` 必须委托它，不再读取本地协议 parser。
- 只有主集成者创建应用级服务实例、挂启动/退出钩子并更新注册表；T5/T6 不分别 new 第二个管理 runtime。`shutdown` 在 Chat/workspace workers 收敛后、`closeStore()` 前完成。
- 原 `ProviderAdapterV2`/`ProviderDriver`/event/schema 签名不重定义。扩展或移除既有导出符号前由对应实现者执行 LSP references；本文未修改这些符号。

## 4. Effect Layer、Scope 与 revision 生命周期

### 4.1 层级与资源归属

```text
Agent server 生命周期
  ├─ T5 平台层：Effect 4.0.5 / platform-node 4.0.5、FS/Path/Crypto/HttpClient/Spawner
  ├─ 原模块基础层：IdAllocator、ModelCatalog、ProviderLatestVersions、事件 logger
  ├─ T5 Host/config/私有 credentials + 原 registry 的实例创建/销毁算法
  └─ operation Scope（一次 acquire）
       ├─ 某 instance + revision + effective cwd/Home/env 的 lease
       └─ T6 generation/session Scope
            ├─ ProviderRuntimeHost binding
            ├─ 原 adapter.openSession(...) / native process 或连接所有权
            ├─ 单一事件消费者 + 请求响应 fibers
            └─ interrupt / drain / final persistence / 解除 binding / close Scope
```

- `driver.create` 的 Scope 不得在构造 ProviderInstance 后立刻被 `Effect.scoped` 关闭。lease 保持实例与其后台 fibers 的有效性；`adapter.openSession` 的 Scope 至少覆盖 startTurn 到终态、回调完成及资源清理。不能在 Hono SSE handler 结束时销毁 generation。
- T5 可以复用同一不可变配置实例，但缓存键必须包含：`dataDirectory`、`instanceId`、revision、已解析 cwd、effective native Home、有效环境 binding。cwd/Home 不同不能共用会捕获它们的 service。每个 session 的 HostProcess 引用、Host.paths.cwd 与运行策略 cwd 一致；不能用全局 projectDirectory 覆盖已核验 PM cwd。
- 同键复用时由 T5 统一持有实例 Scope，acquire/release 引用计数；零引用且已失效才关闭。也可每 operation 独立创建 Scope，不得因此引入第二套 registry/reconcile 实现或静默重启执行。任何方案均须保证不同实例 mutable state 不共享。
- T6 在 `openSession` **之前**注册运行绑定，先获取事件订阅再调用 ensure/resume/startTurn，避免启动事件丢失。`subscribeEvents` 存在时使用独立 subscription 并在 finally close；否则只允许一个 consumer 读取 `runtime.events`。不启动第二条 stream 竞争消费 interaction/terminal。
- `Stream.runForEach` 串行处理事件；信息问题通过子 fiber 等待答案，不能阻塞事件主消费（否则 request 关闭/取消/终态死锁）。pending request map 和 response fiber 属于 session Scope。
- 只关闭本应用创建的进程/连接。外部 OpenCode server、Provider 原生 Home、外部安装目录不能被 scope finalizer 删除/关闭；使用来源已有 ownership/process-group 实现。

### 4.2 配置与账号变更

| 时点 | 必须执行的检查 / 动作 |
| --- | --- |
| resolve | 保留 `resolveProviderRuntime` 的 enabled、installation/auth、busy、显式 model/options 检查；status await 后重新比较 revision |
| acquire / before fork / before startTurn | 原子取得当前互斥占位；比较 instanceId/driver/revision/cwd/Home/environment identity；不得把旧 runtime 自动升级成新配置 |
| config/env/Home/auth/logout/install/update/remove/reset/delete | T5 先占当前互斥，保留既有单调 revision 规则与 CAS；写成功后通知 settings stream、失效 observations/models/status/limits/lease。登录启动、退出、维护即使取消也不能重新信任变更前 revision |
| 运行期间 config CAS 赢得竞态 | `assertCurrent` 阻止旧 callback 发布新 session/usage 或新工具交互，终止并释放旧运行；记录 `session_mismatch` 失败/中断，不在新 revision 下补写成功 |
| 新实例替换旧实例 | 旧 Scope 完整关闭后才启用同逻辑实例的新 Scope；旧 worker 的迟到事件不能使新 generation/终态回退 |
| 进程重启 | 仍由当前 `startChatRuntime` 把 queued/running 记 interrupted、PM running call 记 unknown；不通过 Effect layer 自动 startTurn 或恢复原始 prompt |

`beginProviderExecution`/`beginProviderStatus` 是共享读式占位；auth/logout/maintenance 是排他变更。沿用 `auth.ts`，不另建互不相见的锁表。相同原生 credential/installation binding 的多个实例还必须按原 controller `credentialBinding`/maintenance `lockKey` 联锁；binding 共享只决定互斥，不授予跨实例 continuation。租用/计数的 release 必须幂等，所有异常路径执行。维护进行中不能靠旧缓存显示为可运行。

## 5. 原 ProviderHost 的 PM 实现与配置映射

### 5.1 原方法的精确适配

`ProviderHost.ProviderHost["Service"]` 是 Host layer 的直接输出类型；不得发布同名本地 tag 替代它。

| 原成员 | PM 实现 |
| --- | --- |
| `paths.cwd` | 当前受信 context.cwd。Chat 来自 `resolveAgentScope` 的 executionSnapshot.path；非 Chat 沿用现有已经过其入口核验的 cwd。ProviderHost 不接受浏览器自报路径当授权 |
| `baseDir`、`stateDir` | 应用 data root 与该实例 `stateDirectory` 的私有子树；不是 nativeHome/HOME。暴露 `ServerConfig` 前创建私有 `stateDir`（新目录0700），供原生状态命令使用；初始化失败报告 `provider_state_unavailable`，不误报CLI未安装。明确实例运行 root 与共享 cache root，不套入上游整个 userdata/statev2.sqlite 布局 |
| `providerStatusCacheDir` | `<dataDirectory>/provider-cache/t3code`，缓存键含 driver/instance/revision/环境身份；cache 命中不能跳过 authoritative revision 检查 |
| `attachmentsDir` | `<dataDirectory>/provider-attachments`，只作应用私有 Provider 附件存储；不等于 PM blob root 或任意 workspace 文件 |
| `settings.get` | 原 `ServerSettings` 的纯投影快照；原 schema decode，来源只有当前实例/settings/usage preferences；不落第二份 settings.json |
| `settings.withSnapshot(use)` | 真正的读写互斥：use 完成前所有本地 settings/instance 写者都不得改变快照对应状态。不可仅 shallow-copy 后声称冻结。Scope/Effect 失败时释放；不能在同步 durable transaction 内 await |
| `settings.changes` / scoped `subscribe` | 同一串行发布源；先 acquire subscription，再读取初值。订阅获取到使用之间的变更必须缓存；读失败保留原状态而非发布空实例表 |
| `shouldRunBackgroundWork(scope)` | 仅 provider-status 按现有 health interval/enabled/busy 策略；thread 仅在当前已授权 generation/既有重新核验的 idle-compaction 范围，不能产生新生成；其他 server/vcs/git/diagnostics scope 返回 false。不得借上游默认策略启用拉取、重试或后台 Agent |
| `resolveAttachmentPath(attachment)` | 用原 ChatAttachment ID/类型白名单解析本应用登记的附件；绝对路径、`..`、符号链接/realpath 越界、未登记 ID 返回 null，不回落 cwd/Home |
| `resolveExtractedTextPath?` | 只有当前 DocumentText 适配具备真实提取链路时提供；不存在的派生文件返回 undefined；失败为真实 Effect failure，不假装空文本 |
| `credentials(namespace,bindingId)` | `ProviderCredentials` 原签名；只访问第 5.3 节应用私有后端，get 缺失为 Option.none，I/O 失败为 ProviderCredentialError；不能吞成未登录 |

### 5.2 实例、schema、模型与环境

| 本地事实 | 上游投影 / 回写规则 |
| --- | --- |
| `driver: "claude"` | 只在边界映射为 `ProviderDriverKind.make("claudeAgent")`；反向 status/event/usage 回本地 `claude`。其他九类同名映射；未知 driver 保留原不透明历史，不可执行 |
| `instanceId: "claude"` 或自定义 ID | 原样 `ProviderInstanceId`；**不变成 claudeAgent，不调用 defaultInstanceIdForDriver 重建 ID**。超过/不符合原 slug schema 的既有有效本地历史不删改；不可无损编码时明确 409 `session_mismatch`/配置错误，由父级登记迁移差异，不伪造另一个账号 |
| `label/accentColor/enabled` | `displayName/accentColor/enabled`；显式 disabled 优先，原 config 的 enabled 也同步为当前有效值；UI 更名不得改变账号身份 |
| `config` | 对应原 driver.configSchema decode；null patch 删除、omit 保留、password 空值规则沿用当前 schema/fields；Claude 原 binaryPath/homePath/launchArgs/autoCompactWindow/idleCompaction 同名，config 内 customModels 从当前顶层 customModels 注入 |
| `customModels/modelPreferences` | 当前顶层持久数据仍是唯一权威；原 CustomModelSetting/schema 转换一次；hidden/order/favorites/per-model options 不丢失、不通过上游 hydration 二次默认化 |
| `env/envSensitivity` | 原 `ProviderInstanceEnvironment` 条目 name/value/sensitive。只向内存原服务传真实值；public DTO 仍保留 secretConfigKeys、valueRedacted 往返，响应与事件不得带秘密 |
| `model`、`modelOptions` | 原 `ModelSelection {instanceId,model,options}`，以当前 `resolveCatalogModel/resolveProviderModelOptions` 的显式选择为准；能力信息从原 descriptor 来。default/isDefault/alias 不等于允许无模型或失效模型静默回退 |
| `revision/observations` | 不塞进上游不认识的 config；由 lease 与本地 records 关联；保持全局单调 revisionClock、expectedRevision CAS、observations.instanceRevision |

环境必须由当前 `providerContext`/`providerEnvironment` 产生，保留 `instances.ts` 的 RESERVED_ENV 剔除、敏感条目及 nativeEnvironmentBinding 规则。既有 `HOME/USERPROFILE/XDG_*` 和原生供应商环境继续继承，**不把 HOME/XDG 指到应用 stateDirectory**。Codex existing 继承 CODEX_HOME/native Home；managed 使用现有应用私有 state。Claude 仅显式 homePath 设置 CLAUDE_CONFIG_DIR；未指定时沿用原生环境。其余原生 Home 行为不统一改写。

必须登记的窄补丁：`U/packages/provider-core/src/server/instanceEnvironment.ts:7–23` 目前 `baseEnv = process.env`，会绕过绑定的 `HostProcess.Environment`。移入副本改成可选参数，未传时从 `HostProcess.Environment` 读取；显式传入 baseEnv 仍优先。T5 每实例/会话绑定 `HostProcess.Environment = context.env`、`WorkingDirectory = context.cwd`；`HomeDirectory` 是该环境的用户主目录（`context.env.HOME || context.env.USERPROFILE || os.homedir()`），**不是** `context.homeDirectory` 代表的 `.codex/.claude` 等原生配置目录，更不是 stateDirectory。**禁止修改 process.env 实现实例隔离；禁止只提供 HostProcess tag 却保留原 helper 默认参数。** 所有直接 `process.env` 的家族执行 callsite 由 T1 清单定位、对应家族切片审计并按同一边界处理，不在协议包另造环境合并器。

### 5.3 应用私有 credentials

`ProviderCredentials.binding` 原要求 `{owner:"t3",key}`，是上游内部区分 app-owned credentials 的标签，不表示引入 t3 账号/权限。key 只能由应用 root、namespace 和经验证 binding ID 派生；相同 binding 才共享。namespace/bindingId 必须编码/哈希成应用私有文件键，不能拼接成任意路径。目录 0700、值 0600、原子替换；remove 仅删除本应用创建的对应记录。

不得读取/复制全局 Codex auth.json、Claude credentials、Cursor keychain 或其他来源仓库/用户目录凭据来“初始化”此后端。原生程序运行时继续使用自己已授权的环境/账号。账号登录显式产生并属于应用的状态可经 controller 写入；不要把 instance.env 中已有敏感值搬进新存储再删旧值。SecretStore 的 get/set/create/getOrCreateRandom/remove 必须是真实后端语义，不用内存假密钥或无条件成功替代。

## 6. PM 原生工具/权限定制端口

### 6.1 新的通用上游 Host 端口（父级先落声明）

文件：`vendor/t3code/packages/provider-core/src/server/ProviderRuntimeHost.ts`。只依赖 `@t3tools/contracts` 与 Effect，service key 固定 `@t3tools/provider-core/server/ProviderRuntimeHost`。这不是 PM 工具 registry，也不返回浏览器/设备/t3 orchestrator 能力。

```ts
import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ProviderRuntimeHostBinding {
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly executionId: string; // local generation ID; opaque to source modules
  readonly cwd: string;
  readonly mcpServers: ReadonlyArray<{
    readonly name: string;
    readonly transport: "stdio";
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  }>;
  readonly nativePermissions: "deny-ungranted";
  readonly instructionText: string; // host-only instructions, not source orchestration instructions
}
export interface ProviderRuntimeHostService {
  readonly bind: (
    binding: ProviderRuntimeHostBinding,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly read: (
    input: { readonly threadId: ThreadId; readonly providerInstanceId: ProviderInstanceId },
  ) => Effect.Effect<ProviderRuntimeHostBinding | undefined>;
}
export class ProviderRuntimeHost extends Context.Service<
  ProviderRuntimeHost, ProviderRuntimeHostService
>()("@t3tools/provider-core/server/ProviderRuntimeHost") {}
```

`bind` 只用于已完成入口核验的内部值；同一 thread/instance/execution 重复绑定相同值幂等。冲突是程序不变量失败，必须传播为 failure/defect 并由外层失败收敛，不能覆盖前一个 live binding。Scope finalizer 只清除自己持有的 execution/token，不能清掉后来绑定。没有默认“无操作实现”或自动 t3 fallback。未绑定表示此 session 没有应用工具；带 PM bridge 的执行找不到绑定必须在 startTurn 前失败。

PM 实现 `t3code/runtime-host.ts` 将当前 `{command,args}` 转成一个 stdio entry，name 为 `pm_tools`、args 追加一次 `"mcp"`；原 bridge args 已含 executable path/loopback URL，不能另造服务或把用户 cookie/token 放到 argv/env/日志。端口中不保存 request Headers。纯 CLI 提示仍沿用 `chat-runtime.ts` 的 generation-scoped tools list/call/result 说明与原 operationId 核对要求；只注入一次，不再追加 t3 指令。

### 6.2 各家族必须修改的原调用点

相对 `vendor/t3code/`；这里只冻结 host/transport 的调用替换，不允许重新写协议或整段复制本地 driver。相同 adapter 的 fork/resume/新 session 都使用同一绑定。

| 切片 | 已知原调用点 | 必须改变的宿主接线 |
| --- | --- | --- |
| T7 | `packages/provider-opencode/src/server/adapter.ts`、`packages/provider-opencode/src/server/v2/adapter.ts` | 不使用 McpProviderSessions 的 remote t3-code endpoint；将绑定转原 SDK 的 local MCP 配置，保持本地当前随机 generation 名称与移除所有权。外部服务不因“不归本应用启动”而漏 PM 接入，也不被停止。runtime instructions 只保留通用 harness 部分，去掉 t3 orchestration prompt |
| T9 | `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`、`apps/server/src/provider/CodexDeveloperInstructions.ts` | `codexThreadRuntimeParams` 的 `mcp_servers.t3-code` 改为绑定的 stdio pm_tools；ensure/resume/fork/turn 都读当前绑定，禁止 `hasT3Mcp` 触发上游 orchestration/browser/device 指令 |
| T10 | `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` | `claudeMcpOverrides`、query options 与 permission callback 读绑定；不装 t3-code HTTP MCP、不追加 T3_CODE_ORCHESTRATION_INSTRUCTIONS。保留当前 hooks/sandbox/settings sources 限制、launchArgs 防覆盖与原生环境；不继承 upstream DEFAULT_RUNTIME_MODE full-access/bypassPermissions |
| T11 | `apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts` | 通过原 ACP transport 的 MCP 配置承载绑定；不能授予上游 device/browser 能力 |
| T12 | `packages/provider-cursor/src/server/adapter.ts`、`packages/provider-muse/src/server/adapter.ts`、`packages/provider-pi/src/server/adapter.ts`、`packages/provider-pi/src/server/mcpInjection.ts` | 由各原 SDK/extension 注入同一 binding；Pi 沿用本项目 `packages/pm-cli/pi-tools.ts` generation transport，不导入 t3 orchestrator extension |
| T13 | `packages/provider-acp/src/server/adapter.ts`、`packages/provider-acp/src/server/AcpSessionRuntime.ts`、`packages/provider-acp-registry/src/server/adapter.ts`、`packages/provider-grok/src/server/adapter.ts`、`packages/provider-fx/src/server/adapter.ts` | 公共 ACP 的 `acpMcpContext/readMcpContext`、session/new/load/resume/fork MCP 数组和 turn prompt instruction state 接本 port；删除 t3-code self-invocation/auth/browser/device 接线。Grok/FX/Registry 保留其对公共 ACP 的配置，不各写协议。T11 的公共 ACP 修改交此所有者 |

以上 adapter 路径均已通过固定来源目录定位。本合同不授权导入完整 `mcp/` 应用或 OrchestratorMcpServer。

### 6.3 权限绝不随 transport 放大

- `runtimePolicy.runtimeMode` 固定从当前 PM 限制生成，基线为 `approval-required`；不能采用上游默认 full-access。`interactionMode` 仍是当前 default/plan；approvalPolicy/sandboxPolicy 必须映射现有家族限制，不允许源 adapter 从 launchArgs 覆盖 model/session/MCP/权限。
- 原生 permission request 默认拒绝，输出可观察的不可回答 approval_request（respondable=false、明确原因）。**信息提问 answers 不能转成 ProviderApprovalDecision.accept**。
- 唯一已有特例是本次 session 的受信 pm_tools transport 调用：仅在能证明 server/name、原生 session/turn 与当前 generation binding 一致时允许一次 transport admission。它不代表批准业务动作；PM bridge 仍按当前 PM17 能力/revision/逐动作审批执行。匹配不完整或只是工具文本名包含 pm_ 必须拒绝。
- 不提供 acceptForSession/acceptAlways，不接受 provider 自批；不创建新的本地批准 UI。PM approve/reject 仍只处理 PM 工具 operationId，不能顺便解除原生命令权限。标题生成、status probe、model refresh、usage refresh、idle compaction 不带 PM 工具。

## 7. 原生 session、resume/fork 与最小持久化

### 7.1 保持 NativeSessionRef 的含义

公开 `NativeSessionRef` 不改结构：`sessionId` 是 Provider 原生会话/thread ID，**不是上游 providerSessionId 或本地 generationId**；`turnId/messageId` 保留原生稳定边界。`driver` 仍为本地 claude，revision/cwd/modelId 必须由当前受信 context 填入。无原生 ID 不伪造支持 resume/fork。

完整上游会话结构不是可从一串 sessionId 无损猜出的对象。T6 将必要元数据附属保存到现有 `durable/store.ts` 的 records namespace `provider:t3code:continuations`，不建 t3 表、不换存储。键固定为 JSON 数组：`[instanceId, revision, cwd, nativeSessionId]`。记录声明如下（`*Json` 使用原 schema encode/decode 的 JSON，不 JSON.stringify Effect DateTime 对象）：

```ts
export interface PmContinuationRecord {
  readonly version: 1;
  readonly upstreamCommit: "30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c";
  readonly protocol: string; // exact family wire/runtime dialect; never just local driver
  readonly providerInstanceId: string;
  readonly localDriver: ProviderDriver;
  readonly instanceRevision: number;
  readonly cwd: string;
  readonly nativeHome: string;
  readonly continuationKey: string;
  readonly nativeSessionId: string;
  readonly ownerThreadId: string;
  readonly lastGenerationId: string;
  readonly providerSessionJson: unknown;
  readonly providerThreadJson: unknown;
  readonly providerTurnsJson: readonly unknown[]; // native turn/boundary identities, no messages/tool bodies
  readonly nativeHistory?: ProviderNativeHistoryBoundary;
}
```

- JSON 字段分别用 `OrchestrationV2ProviderSessionJson`、`OrchestrationV2ProviderThreadJson`、`OrchestrationV2ProviderTurnJson` 校验；schema 错误报告不兼容，不能 type cast 后执行。保存 thread/session 必要结构，去掉非续聊必需的 payload/临时环境/工具正文；绝不持久 credentials、Headers、MCP transport URL 或 live response closure。
- `protocol` 由家族原运行探针提供精确值；OpenCode 必须区分 v1/v2，ACP 必须包括 registry agent identity/实际协议版本，不能因 local driver 同名就复用另一 dialect。原 commit/schema 升级若需转换，先新增有证据的转换规则，不无条件忽略 version。
- onSession 前先保存这份有效元数据，然后调用当前 generation 的 onSession（原持久化 callback）；callback 失败整次执行失败。不会以 sidecar 存在代替 Chat 的成功终态提交；线程 nativeSession 仍只在 `settleChat(completed)` 被提升，失败/取消/中断清理规则保持。
- 同一 native session 多个 generation 更新元数据时只接受本线程当前已核验 generation；旧 late event 不覆盖最新快照。分支原生 fork 建立新的 nativeSessionId 和目标 ownerThreadId；源记录不改。
- 部分 SDK 的既有原生历史没有本应用的 `NodeId/RunAttemptId`。可选 `nativeHistory` 使用原 `ProviderAdapter` 新增的 schema：`{ nativeSessionId, completedTurnRefs: [{ driver, nativeId, strength: "strong" }] }`。仅保留原生已完成回合的证明，不伪造应用节点、回合或成功状态；driver、非空 ID、原生 session 和实际分支均须核验。原生历史证明与迁入后产生的真实图回合可以共存；原生分支裁剪时不得继续承认被丢弃的边界。该字段仍属于版本1附属记录，旧记录无需批量改写。
- `completedTurnRefs` 只是一组历史证明，数组顺序不能推断当前头。可选 `latestCompletedTurnRef` 必须由原生当前分支的实际完成状态确认，并属于同一 session/driver 的已证明集合；没有该字段时不挑选任意历史条目。分支裁剪同时清除不再保留的当前头。最新图回合只有 weak ref 时，不把更早的 strong ref 误报为当前头。
- 已完成回合缺少 strong 原生图边界时，执行入口读取原模块 snapshot，重新核对实例、原生 session、应用 thread 和当前 lease，再保存其 `nativeHistory`。已有原始图节点仍按事件保存；不把 weak ref 升级成 strong，不因读取历史再发 prompt。

### 7.2 具体操作顺序

| 操作 | 上游调用与本地守卫 |
| --- | --- |
| 新对话 / 已选择 portable handoff | nativePlan 按当前 bounded prompt（64k 总上限、16k system、20k transfer）生成一次上下文；openSession → ensureThread(forceNewNativeThread=true) → startTurn。不能再额外 inject 全量历史造成重复 |
| 同账号续聊 | nativePlan 的 scope/cwd/system/model/revision 检查保持；读取并校验附属记录；openSession 的 resumeFromSession/initialNativeThreadId 按原 schema 使用 → resumeThread(existing providerThread)；仅发送 nativePlan 的新消息，不重发原始历史 |
| 模型切换 | 先原 `planSelectionTransition`；apply_on_next_turn 原样下发；restart_session 只重建原生进程并显式 resume，不重放 prompt；create_with_handoff 由现有 portable plan 承接；reject 明确错误。不把上游声明变成自动换模型 |
| fork | 使用原 sessionRuntime.forkThread；Codex inclusive boundary 用 native turnId，Claude 用 native assistant message UUID；优先从真实 providerTurn/ref 映射，原生历史使用经验证的 `nativeCompletedTurnRef`，不伪造图节点。Pi 选择目标已完成回合之后首个应丢弃的 user entry；没有后继时保留原生 `--fork` 行为。目标原生 ID 必须与源不同。bounded capability 不成立、边界缺失或不可映射 → 409 unsupported_fork，不退到 live head，不调用本地手写 fork RPC |
| 未完成 generation 的显式恢复 | 继续由当前 continueChat/continueChatRecovery 校验确认、幂等、最新设置与 scope；恢复提示先核对已有进度，不重新派发原始动作。Provider 的 retryable/retry 元数据不触发本项目自动 retry |
| 取消/进程退出 | interruptTurn 原生确认/释放本应用资源后 Promise 才收敛；不把 AbortSignal 已发出视作 native 已停。不确定的 PM 工具结果保留 unknown，只按原 operationId 查询；清理完成前不释放变更互斥 |

原生 fork 调用后必须重新读取目标 snapshot，核对实例、driver、原生 session 与目标应用 thread，保存目标实际图元数据及目标自身的历史证明。禁止仅把源证明的 sessionId 改成目标 ID。若原生 fork 已开始但调用结果、目标证明、当前绑定或持久化无法确认，返回 `502 provider_fork_unconfirmed`；这不是可安全自动重试的失败，不再派发第二次 fork。

旧记录没有 sidecar 时，T6 不批量改写历史。对应家族必须提供**纯 metadata、零 prompt**的 legacy adoption：确认当前实例/revision/cwd/Home 与实际 protocol、原生 session ID 存在及边界类型，再通过原 adapter 的 ensure/resume/readThreadSnapshot 建立元数据。不能为了探测发送一轮模型请求。现有 Codex app-server session/turn、Claude SDK session/assistant UUID、可由运行探针识别的 OpenCode v1/v2/ACP native ID，必须分别验证并接纳有效会话；**禁止统一把缺 sidecar 判 mismatch 来省略迁移**。若该协议无法证明兼容，显式返回 409 `session_mismatch`（保留旧历史，说明需用户采用已存在的 portable handoff）；不得自动把缺 sidecar 当新会话、假称 resumed 或重新执行旧任务。现有 nativePlan 原本就选择 portable 的设置/scope 变化不改为隐式 resume。

`NativeSessionRef` 与附属记录都不能独自证明 PM scope：scope/system prompt/历史消息边界仍由当前 Chat generation/thread 字段校验。T6 不迁移 `durable/engine.ts` 为业务 Run 引擎；其既有 runNativeRuntime 调用仅由父级作同边界接线。

## 8. 事件、交互、错误与输出收敛

### 8.1 上游 event → 本地投影唯一表

所有时间经原 DateTime/schema 转 ISO；条目 key 使用原 `turnItem.id`，以 generation 为持久化作用域。`nativeItemId` 只保存原生 ref。不得每次累计更新生成随机 item ID。`message.updated`/`turn_item.updated` 可能表达同一正文，不能双写成两段答案。

| 上游 `ProviderAdapterV2Event.type` | 本地消费 |
| --- | --- |
| `provider_session.updated` | 更新当前 session 元数据与 live 状态；不单独完成 Chat generation |
| `provider_thread.updated` | 更新续聊 thread/native refs/contextUsage，处理 retainedNativeTurnIds；不替换本地线程 ID/scope |
| `provider_turn.updated` | 原生 turn/ref/ordinal/usage 增量；终结状态仍等待匹配 root turn.terminal |
| `turn_item.updated` | assistant_message/reasoning/command_execution/file_change/file_search/web_search/todo_list/proposed_plan/approval_request/user_input_request/error/compaction 按同名转换；idle→pending；input/output/diffStr/oldStr/newStr 等映射现有 NativeOutputItem 字段；完整累计正文不是 append delta |
| `command_output.delta` | `{type:"command.output",itemId,chunk}`；仅旁路实时尾部。最终 command_execution 累计 output 覆盖尾部状态，不能把最终 output 再追加一遍；outputOmitted 时从原 readThreadSnapshot/原最终 item 取回，不假装空输出 |
| `message.updated` | 更新正文查表/补全 textOmitted 的条目；以对应 assistant turn item 为显示权威，不另外发 onText 重复文本；没有 item 的真实协议由该家族明确适配且证明单一正文来源 |
| `runtime_request.updated` | 与 request turn item 按 requestId 联结，处理 pending/resolved/expired/cancelled；只将已具备问题描述与可响应能力的 user_input 放进当前 requestNativeInteraction |
| `plan.updated` | 按 planId 更新同一个 proposed_plan/todo_list；若已有对应 turn item 只补缺字段，不新建副本 |
| `node.updated`、`subagent.updated` | node 只作 parent/root 路由；subagent 映射现有 subagent 条目（childSessionId、状态、标题/输出/模型），原生 children 不创建带 PM 身份的新 Chat/business thread |
| `app_thread.created` | 保留为原生子线程关联/通知；无本地 createThread/PM 项目写入权限，不能把上游 appThread projectId 当 PM Project |
| `turn.terminal` | 只有匹配本次 root providerThreadId/providerTurnId/runOrdinal 才能结束 generation；completed/failed/cancelled/interrupted 精确区分，children 的终态不提前完成 root；broken 不再允许 native resume |

其他上游条目如 checkpoint/handoff/system_notice/run_interrupt_request/result/secret_request/link_request 以现有 notification 表达真实状态和不支持原因；不新增 checkpoint 文件恢复、远程连接、密钥输入或授权能力。上游动态工具行映射 `dynamic_tool`，不因行文本宣称执行了 PM 写入。子代理、通知、最终正文、完整命令/文件结果必须可在当前 snapshot 重读，不以“无对应 UI 类型”静默丢弃。

`onText` 是旧消费者的纯正文增量接口，T6 从同一累积 assistant item 状态派生，不从 message/item 两路都 append；Chat structured 输出仍只由 onEvent 存储/过滤。修正型累计正文不伪造 append，最终 `CliChatResult.text` 为原有顺序的最终 assistant 正文，不含 reasoning/tool stdout/失败提示。paragraph/turn filter 与节流仍由当前 Chat/native-output 持有。

### 8.2 信息问题与 live response

- source `responseCapability.type=live` 仅在当前 session/request 未关闭时 respondable；question IDs/options/multiple/secret/free text 一次准确映射，不从 prompt 猜选项。message 型回答只在原协议明确支持时走其原生回应方法；not_resumable 显示不可回答原因。
- `onRequest` resolve 后再检查 generation、requestId、item 状态、revision 和 session binding；只发一次 `respondToRuntimeRequest({requestId,answers})`。取消问题用原协议取消/拒绝；不能把取消变成空答案或 accept。
- 迟到答案、重复答复、native request 已 resolved、server restart 后丢失 closure 都返回现有 `native_interaction_closed`；不从历史输出重建可执行 closure。native 关闭请求时 pending Promise 必须 reject 并终结条目。
- 同一 generation 的 item/command/usage/session callback 同步抛错，或 onRequest Promise reject，都属于执行失败；保留首个 callback 错误，interrupt、关闭 Scope、reject run。不能 `Effect.ignore`/catch→success。主消费不得因等待 UI 而错过取消。

### 8.3 终态与错误表

`run` Promise 只有在收到真实匹配成功终态、最终正文/条目/usage/session callback 完成且清理成功后 resolve。空回复不是成功证明，stdout EOF/HTTP 200/process exit 0 也不是；原协议明确完成但正文为空时允许成功，需真实终态依据。以下边界错误均保留脱敏 message、code/status；`cause/detail/payload` 只作私有诊断，不能原样发 SSE。

| 情形 | 外层结果 |
| --- | --- |
| 无/禁用/不支持实例，缺模型或失效模型 | 保留现有 unknown_provider / provider_disabled / invalid_model，400/409；无模型 fallback |
| 配置/账号/cwd/Home/原生 dialect/游标不匹配 | 409 session_mismatch；unsupported_resume/fork 为 409；不自动新建原生会话重试 |
| 安装未知或缺失、原生未就绪 | 412 provider_not_configured；仅明确未认证时为provider_not_authenticated。所有家族以原nativeSessionReady为准，身份unknown不等于未就绪，authenticated也不能替代就绪证据 |
| 原结构化 failure.class=usage_limit 或可靠 quota code/status | errorClass usage_limit；resetAt 只取结构化字段/真实 headers；不猜时间、不自动重试 |
| 401/403 与原认证错误 | errorClass authentication（保留原 code）；不是模型列表为空或安装失败。402 保留 payment/quota 原始结构含义，不能无证据一律称 auth 或 completed |
| transport/protocol/schema/permission/validation/unknown failure | errorClass provider_error；permission 被拒绝不转认证成功/自动授权。原标签错误映射保留 operation 与可公开 code |
| abort 用户取消 / shutdown 中断 | 分别 cancelled / interrupted；先等待 interrupt/Scope 清理。回调失败优先 failed，不被随后 abort 掩盖 |
| 断流、无终态 EOF、stream failure、Scope cleanup 失败 | reject；保存 partial output，不假成功。不能将上游 retryable=true 用成自动重放授权 |

当前 `classifyProviderError` 可作为最终公开分类入口；T6 在边界构造带 errorClass/code/statusCode/resetAt 及必要 terminalStatus 的脱敏错误，而非要求本地分类器解析任意上游 Cause。子代理失败/childTurnsContinue 不代表父成功，父终态后也不得脱离 generation 继续拥有 PM bridge。

### 8.4 SSE、背压与恢复不另造协议

复用 `durable/native-output.ts` 的 item snapshot/sequence、独立 command tail、50/100ms 合并和队列 128 reset；不改为每原生 token 写一条新 journal。Consumer 慢时可合并同 item 累积更新，但不丢 request 关闭/失败/终态。SSE 客户端关闭只清 listener，不取消后台 generation；当前 journal/快照重读继续工作。server restart 恢复已保存 partial output 并标 interrupted；不把 event stream replay 当作 startTurn 指令。无需也不引入 t3 WS/RPC 或新的 event store。

## 9. 认证、维护、模型和 usage 端口

### 9.1 管理边界保持现有 HTTP

T5 的 façade 继续满足 `NativeProviderAdapter.check/authenticate/logout/prepare/update/removeInstallation` 原 Promise 签名。`ProviderInstance.auth?: ProviderAuthController` 以及 snapshot/maintenance capabilities 是来源，不把上游 ProviderAuthService 实例挂到路由。

| 现有端口 | 原实现消费 / 失败语义 |
| --- | --- |
| `check(context,signal)` | 原 `instance.snapshot.getSnapshot` / `refresh`（必要时 `snapshotForCwd`）转 ProviderDriverStatus；安装/认证/模型/更新要求分别表示，unknown 不伪造成 authenticated；status check 只 metadata，不发模型推理 |
| `authenticate(context,options)` | controller.start/subscribe/respond/complete/cancel；本地 auth flowId 与 owner token 在内存绑定，ownerSessionId 用该受控 flow owner，不使用 providerSessionId 或伪造 PM principal。options.values/readInput/saveEnvironment 映射原 respond 的真实字段；不提供自动 profile import |
| `logout` | controller.logout 的 stopSessions callback 接当前 host lease/Chat 生命周期；先 account idle 与 CAS/revision 失效。当前外部管理、不支持 logout 的家族维持明确不可用，不删 native Home |
| `prepare/update/removeInstallation` | 原 installation 与 `instance.snapshot.resolveMaintenance({fresh:true})` 返回的真实 update action；保留 command/executable/args/env/lockKey，透传进度及取消。maintenance update 不等于所有家族都有 install/remove；后两者只接各家族实际 installation 服务。无能力时明确不支持，不制造成功安装 |
| cache/model refresh | 原 ModelCatalog/manifest/snapshotSettings/managedProvider 为唯一实现；invalid selection 仍报错。公开模型 DTO/client 由 T14 转换，不在 T5 重列静态模型/能力 |

现有 API/鉴权/Origin 检查只注册一次。认证与维护开始前后的 busy/observations/limits 失效保留；start 后 native 文件可能已经变化，取消不能恢复原 revision。source `importProfile/adoptCredentials/reconnectProfile` 只是原模块能力，**不是本合同授权的新 PM API 或全局凭据导入功能**。

### 9.2 冻结 usage 接入

- live：`provider_turn.updated.turnTokenUsage` 的真实分类计数转 `NativeUsageUpdate.turn`；上下文 `tokenUsage` 转 `.context`，未分类的实际 counters 只到 `.reportedTurn`，不可把上下文总量当本轮计费。reasoning 是 output 子集，不能重复相加；缺值保留缺失，不补零假称完整。
- `provider_thread.updated.contextUsage` 只更新该 native session/thread 当前 context；同一事件累计替换而非不断加总。limits 仍通过 snapshot.applyUsageLimits 与 `ingestUsageLimits(instanceId,update,expectedRevision)`；账号/revision 失效后丢弃旧限额，不能串账。
- history：直接消费原 `ProviderDriver.usage` 的 transcripts/scan 两分支及 format state/schema/dedupeKey/directories；T16 负责把扫描结果接现有 usage service/cache/ledger，不能改成静态统计。保留 native history 优先、ledger 覆盖缺口及 session/nativeTurn 去重。
- 历史reader与执行共用保留的原家族服务；仅历史读取允许禁用实例。缓存和并发读取按实际环境/config/Home/cwd/revision绑定隔离，不存环境秘密明文；旧未绑定缓存必须重读原文件，并明确披露已移除文件造成的覆盖缺口。
- Cursor Keychain用量开关来自现有Usage设置，经同一ProviderHost settings快照和提交后通知投影；写入仍受snapshot锁和Usage revision保护，不增加第二个配置事件总线。
- `CodexUsageHistory.resolve(requests): Effect<ReadonlyMap<原 request 对象,UsageSpeed>,CodexUsageHistoryReadError>` 在 `t3code/upstream-services/usage-history.ts`（T16 所有）实现，数据来自现有 `usage:launches`/冻结 launch 与当前 Chat 证据。精确匹配 instance/session/turn/model/revision；重复歧义或缺 selection 不推断 standard，不使用后来 thread preferences。错误真实传播，不访问不存在的 `orchestration_events` / `orchestration_v2_projection_*` 表。
- usage refresh 不触发推理或自动消费 reset credit；reset action 仍按现有明确用户动作/锁/身份检查执行。失败、unsupported、stale cache、partial source 分别表示，不能成功空列表覆盖已知真实用量。

## 10. 可复用源模块与必须适配的具体服务

“导入类型”不等于“启用服务”。以下是已定位的直接边界，T1 闭包中的包内算法/SDK/fixture 继续保留；不要为了满足一个 import 把整个 t3 应用接进来。

| 来源模块/具体边 | 处理方式与所有者 |
| --- | --- |
| `packages/{provider-core,provider-*,effect-acp,effect-codex-app-server}` 的 driver/adapter/runtime/protocol/status/model/maintenance/usage 逻辑 | 真正复用并替换当前重复协议；公共 Host/env/transport 是少数有账本补丁。协议库不依赖本地 PM 包 |
| `apps/server/src/provider/ProviderHostLive.ts` | **不启用原 layer**。T5 `host.ts` 替代；其 attachmentStore、ServerSecretStore、BackgroundPolicy、ServerConfig、ServerSettings、DocumentText、ProviderCredentialStore 均接本合同端口 |
| `ProviderInstanceRegistry.ts` | 复用 reconcile、decode、失败 unavailable snapshot、child Scope 逻辑；T5 控制生命周期。`ProviderInstanceRegistryHydration.ts`、`ProviderInstanceRegistryMutator.ts` 不直接绑定原 serverSettings/默认实例/devReplay；父级注册表唯一 |
| `apps/server/src/config.ts` | 原 module 引用 package.json/observability/attachment sweeping，不能为了 ServerConfig tag 启动其目录创建/SQL路径。T5 `upstream-services/server-config.ts` 提供实际被 Provider 读取的路径/运行配置，vendor import 窄重定向；不创建虚假的 port/staticDir/desktop/auth 配置 |
| `apps/server/src/serverSettings.ts` | 原文件直接引 effect/sql、nodeSqliteClient、sourceControl secrets。T5 `server-settings.ts` 只提供 Provider 实际依赖的 tag/method，通过第 5 节快照/CAS投影接本地；不加载原 settings 后端、不暴露整套 settings 修改 API |
| `apps/server/src/auth/ServerSecretStore.ts`、`provider/ProviderCredentialStore.ts`、`environment/ServerEnvironment.ts` | T5 对应 secret/environment adapter；保持原 controller 需要的实际 get/set/create/binding/stable app identity，不导入 t3 登录/设备/relay 服务。只读/生成本应用私有身份，不把当前 PM actor 冒充 ServerEnvironmentIdentity |
| `apps/server/src/attachmentStore.ts`、`provider/DocumentText.ts` | T5 `attachments.ts/document-text.ts` 接受已登记附件/派生文本；如已有 worker 算法则移入并正确打包，不把缺文件解析为成功空文本 |
| `apps/server/src/provider/ProviderAuthService.ts:18–20,90–169` | 直接依赖 ProjectionStore/ProviderSessionManager；T5 management 使用原 controller，释放/互斥接本地 Chat/lease，**不搬这两个仓储/manager 的业务实现** |
| `apps/server/src/provider/ProviderOrchestrationAdapterInfrastructure.ts` | 原 QueryRunner/AppServerClientFactory/Cursor SDK/IdAllocator 可复用；组装 layer 由 T5，generation-specific transport 由 T6。不能原样启用 continuation worker/上游 orchestrator |
| `apps/server/src/preview/PortScanner.ts` 被 Claude query runner 使用 | T10 在 `t3code/upstream-services/port-discovery.ts` 只接原 runner 使用的 `trackAgent(): () => void` 生命周期计数/清理；窄重定向 import/tag 只保留该方法，不捏造 scan/subscribe/stopServer。不得启用桌面浏览器、Preview discovery 或用 no-op 标成功 |
| `apps/server/src/mcpApps/McpAppSnapshot.ts` → attachmentStore/attachmentPaths | 这是带文件写入的 MCP app 快照 helper，不是必须启用的 MCP 应用服务器。仅原生工具确有该输出且当前输出已支持时复用；文件定位接 T5 attachments adapter。当前 PM17 不注册 t3 MCP app/browser 能力，不创建假 iframe/截图服务 |
| `apps/server/src/usage/CodexUsageHistory.ts:43–120` | T16 `usage-history.ts` 替代 SQL 查询，保留原 request/response/歧义语义；原 usage reader/格式逻辑仍复用 |
| `ProviderContinuationRequests` 原 Context.Reference 默认丢请求，layer 又是无界队列 | 不依赖默认 no-op，也不启用自动再生成 worker。T6 给当前 live generation 消费 adapter-buffered 事件的通道；generation 外通知保存现有通知/中断信息，不自动 startTurn；后台任务停止和权限归属随 generation 清理 |
| 原 McpProviderSessions / mcpSession / orchestrationInstructions 与 browser/device/remote helper | 不把 PM bridge 塞进 t3 的授权字段冒充 t3 server；第 6 节 narrow port + 家族 transport 补丁替代，仅通用纯 helper 按实际依赖保留 |

具体服务 adapter 不是“兼容 shim 保留双轨协议”：它们只实现 host/transport/persistence 方法。vendor import 重定向名单、使用到的 exported symbol 和必要签名必须进入同步 patch ledger；不能按同名字符串做全仓不加区分的 import 替换。原源码拥有其模块与行为测试，PM adapter 拥有本地资源/权限语义。

### 10.1 打包与 TS 运行边界（父级所有）

Agent构建显式打包vendored TS、PM客户端Provider helper及其原合同依赖；Effect保持单一外部运行时，依赖磁盘资源的SDK仍按发布清单携带。当前包exports、`.ts`源码与产物解析必须由隔离构建核验，不能依赖外部源码目录或部署后临时TS loader。T18继续验证完整可移植产物。

原 SDK query workers、DocumentText worker、Pi/PM CLI extension、模型 JSON/生成协议/资源都按 T1 清单随构建交付；`new URL(..., import.meta.url)`、源码 `.ts` 与产物 `.mjs/.js` 分支必须对应真实产物。现有 SDK patch/版本由父级核对，不在 T5/T6 安装依赖或强行升级。交付不能以一个能解析 metadata、生产 worker 找不到的 façade 算完成。

## 11. 相关 INV / SC / INF 的适用子集

依据 [不变量](../domain-design/invariants.md)、[场景](../domain-design/scenarios.md)、[基础设施验收](../domain-design/README.md) 与较新的 [PM 接口实施记录](agent-pm-interface-plan.zh.md)。只沿用下列安全/一致性含义，**不恢复旧业务 Run、SQL WorkItem 状态机或固定 Review→Complete 前置规则**；任务状态仍服从当前 Markdown 权威与工作流。

| 规则 / 场景 | 本合同落点 |
| --- | --- |
| INV-01、INV-08、INV-20；SC-14/20 | PM 当前身份/作用域/cwd 权威检查，Agent 不自批，不用缓存授权；旧 revision/旧 worker 不更新当前事实 |
| INV-03、INV-15、INV-16；SC-03/05/16 | Provider 成功/失败/取消只更新执行/输出；不自动完成/重开业务任务、不强制人工交付引用 Run |
| INV-05/06 的身份隔离与占位原则；SC-04 | Chat thread/generation/provider native session 身份不同；保持当前单线程活跃 generation 守卫及账号变更互斥，不引入旧 Session/Run 聚合 |
| INV-07/08/09；SC-08/09/10/15 | 保留当前逐动作审批、原 operationId/参数/scope/revision 绑定；未知结果不重放，取消请求不冒充实际停止，native 信息答案不能批准 PM 写入 |
| INV-10/13/14/20；SC-07/12/13/20 | 原历史保留、配置 CAS、生成/请求幂等、重复原生事件不重复条目/计费、终态不回退；不重写已有收据 |
| INF-01/03 | 原 records/输出重启可读；SSE 断开补发/snapshot、慢消费者与订阅竞态不丢最终事实 |
| INF-04/05/06 | 附件越界拒绝，schema/导出/HTTP 兼容，秘密不外泄，撤权后重核访问 |
| INF-07 的相关机制 | 旧 execution/revision 回调失效、审批竞争、unknown 仅查询核对；不为满足该历史编号引入 Runner/epoch 数据库 |

## 12. 并行构建者验收清单与真实阻塞

下表是后续父级必须执行的观察要求，**本轮全部未运行**。T5/T6 实施者不运行 build/lint/tests/formatter/smoke，不安装依赖、不启动 Provider；行为测试可以按所有权编写后交父级。

| 接口 / 所有者 | 必须有的可观察证据 |
| --- | --- |
| Host / T5 | 原 tag 实际供给；withSnapshot 与所有写者互斥；subscribe-before-read 无漏变更；不同 env/Home/cwd/实例不串状态；保留 HOME/XDG；附件 ID/软链接越界拒绝 |
| config / T5 | claude↔claudeAgent 只改 driverKind 不改 instanceId；密码/env redaction round-trip；CAS 冲突不覆盖；revision 更改使旧检查/限额/session 失效；未知历史仍可读 |
| Scope / T5+T6 | 创建后 driver Scope 活着，openSession 属于 generation；abort/失败/callback throw 后进程/连接/绑定/subscription/互斥均释放；外部服务不关；执行期间 auth/maintenance 拒绝 |
| execution / T6 | 真实完成/失败/取消/断流四条分离；root/child 终态不混；final text/command output 不重复；sidecar schema round-trip；legacy continuation 有确证才接入，无确证明确 mismatch |
| PM / T6+家族 | PM CLI/MCP 真实透传到原 adapter；无 t3-code MCP/指令/browser/device；仅允许本 session PM transport admission，其他原生权限拒绝；PM17 工具拒权、审批、revision 冲突、原收据/unknown 核对保持 |
| continuity / 家族+T6 | 显式模型与能力选项实际下发；同 identity 只发新消息续聊；Codex turn/Claude UUID 精确 fork 不取 live head；协议版本不兼容不自动重放；nativePlan portable/system/scope 规则保持 |
| output / T6 | question 可答/取消/原生关闭/迟答/重启失活；SSE 慢消费者 snapshot reset、断线重连和最终历史重读一致；回调失败上浮，不假成功 |
| usage / T6+T16 | 实际 token 分类/缺值、累计替换、turn 去重、history 优先、限额 revision 与刷新竞态、Codex launch tier 歧义不推断；刷新零推理 |
| packaging / 父级 | workspace/export/dependencies、TS/NodeNext 生产解析、worker/资源独立打包；构建产物不依赖外部来源绝对路径 |

**代码已证实的集成前置，不是虚构运行失败：**

1. `NativeProviderAdapter` 的现有 context 没有 generation/thread/scope identity（driver-adapter.ts:10–23）；父级必须先加入第 3 节可选 execution 字段并从 Chat 接线。否则无法在保持该外层 API 时安全绑定 generation-scoped PM transport。不能用全局“当前 generation”变量补洞。
2. 原 `ProviderRuntimeHost` 尚不存在，McpProviderSessionConfig 是 endpoint/authorization/browser/device 结构（`provider-core/server/mcpSession.ts:3–14`），不能承载当前 PM stdio 身份；父级先落第 6 节声明/包导出，各家族再补真实 callsite。
3. 原 environment helper 的 process.env 默认参数、原 ProviderAuthService 的 ProjectionStore/ProviderSessionManager、原 CodexUsageHistory 的 t3 SQL 查询均不符合本宿主；分别按第 5/9/10 节的精确边界替换，不能用常量/no-op/空结果掩盖。
4. 旧 NativeSessionRef 不含原 ProviderThread/Session 的完整 schema/version，无法无条件认定不同 dialect 等价；按第 7 节增量附属元数据与家族 metadata adoption 处理。若某家族真实原生服务不提供验证/边界能力，应列该能力的明确代码依据与 blocker，不能缩减十家范围。
5. T1 最终闭包与父级生产编译/资源策略尚需签收；这是 M0/M1 前置，不是要求修改外部服务。没有代码证据要求替换当前 Chat 存储，本合同也不批准该变化。

父级签收只确认接口与所有权，不等于后续实现/真实账号验证/发布完成。源模块导入、协议行为验证、真实账号验证、常驻发布四种证据继续分开记录。
