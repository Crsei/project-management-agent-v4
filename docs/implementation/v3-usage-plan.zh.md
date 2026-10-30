# v3 Usage 完整移植计划与共享接口

用户要求继续核对 t3code Usage，并用 subagents 同样复制、适配前后端；沿用 `openai-codex/gpt-6.1-terra:xhigh`。来源 `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/t3code`，revision `d53873b6a4799e87afd63c8d288ef0089f5a3748`，MIT/T3 Tools Inc. 2026；只读来源，归属保留在 LICENSE.t3code。用户未授权提交、推送或重启常驻服务。

当前 v4 输入框已按后续用户要求隐藏上下文 / token / 费用及本轮供应商用量，并移除自动轮询；后台采集、Usage 页和显式 `/usage-limits` 保留，见[输入框调整与实际验证](../reference/t3code-provider-config-diff-30eb7e7bb1.zh.md#v4-composer-effort)。以下 Composer 展示范围与验收保留为原始移植历史，不代表当前仍展示；原生 Home 的后续切换见同文[第15节](../reference/t3code-provider-config-diff-30eb7e7bb1.zh.md#v4-native-provider-flow)。

## 语义与边界

完整范围以来源 `docs/user/usage.md` 为基线：原生历史的 token / 缓存 / 模型 / 日或小时趋势 / API 等价成本与 speed premium，公开价格缓存、自定义价格及模型映射，订阅额度窗口与账号池、重置时间/credits、CLIProxyAPI hubs，Composer `/usage-limits` 与真实上下文用量。费用估算不是账单，reasoning 属于 output 子集，不重复相加；三个 input 分类互斥。不能从正文估算缺失 token。

当前项目是一个本机环境，不新增远程环境连接或手机 Widget 产品；前端如实呈现当前环境与已配置实例过滤，不伪造多环境。已有 disabled 实例的历史仍可读，同 home/inode 与同账号去重。只能读取本项目明确配置的独立 home / data roots；不自动发现、导入或探测全局 CLI 凭据。Cursor Keychain 必须显式设置授权且匹配支持平台，否则说明不可用。所有联网供应商验收使用受控协议/HTTP fixture，不读取真实凭据、不调用商业模型。

保持同源 accessGuard、现有 PM scope 检查、独立 homes、认证互斥与目录检查。不新增权限体系、执行计划或业务完成规则。原生 usage 事件不改变 output 条目、请求 broker 或运行终态。额度不足只展示已有安全恢复入口，不自动重跑未知副作用或变更账号。

## 已冻结接口

公共 Zod 合同：`packages/agent-contracts/src/usage.ts`（`@agent-workspace/contracts/usage`），已包含 summary、pricing/settings、limit windows/reports/hubs、native telemetry/context 和 thread snapshot。内部共享：`apps/agent-server/src/usage/types.ts` 的 `UsageRecord`、`UsageScan`、`UsageReadContext`。主集成所有这些共享文件和 package.json；扩展先消息协调。

`ProviderDriverRunOptions.onUsage?: (update: NativeUsageUpdate) => void` 已添加。`turn.totals` 表示当前整轮累计值，不是 delta；重复通知覆盖而非累加。`context` 是供应商实际报告的当前上下文，不是整轮/历史总 token。`limits.windows` 是稀疏更新，按窗口 ID 合并，不清空遗漏窗口。`runNativeRuntime` 转发并把 limits 送入 quota service，durable 回调把 turn/context 保存到 generation/thread；不写提示词或密钥。

集成时扩展 `reportedTurn` 保留供应商分类不完整的本轮实际计数：与 canonical `turn.totals` 分开，输入保留原生口径，不进入历史计费、不推导缺失缓存。额度额外携带原生 `account` 信息及去重后的 `instanceIds`，避免实例筛选丢失同账号来源。未探测实例以 notice 表示，不伪造失败或检查时间。

### 后端模块导出

- `usage/readers/transcripts.ts`: `scanTranscriptUsage(context: UsageReadContext): Promise<UsageScan[]>`，Codex/Claude/Grok/Pi。
- `usage/readers/databases.ts`: `scanDatabaseUsage(context: UsageReadContext): Promise<UsageScan[]>`，OpenCode/Antigravity/Muse。
- `usage/readers/cursor.ts`: `scanCursorUsage(context: UsageReadContext): Promise<UsageScan[]>`，真实账号 Dashboard API；不回退文本估算。
- `usage/limits/core.ts`: `probeCoreUsageLimits(instance: StoredProviderInstance, signal?: AbortSignal): Promise<ServerProviderUsageLimits>`；Codex/Claude/Grok。`consumeCoreResetCredit(instance: StoredProviderInstance, signal?: AbortSignal): Promise<ProviderConsumeResetCreditResult>`；仅真实支持的 Codex/Claude。
- `usage/limits/other.ts`: `probeOtherUsageLimits(instance: StoredProviderInstance, signal?: AbortSignal): Promise<ServerProviderUsageLimits>`；Cursor/OpenCode/Antigravity/Muse。Pi/ACP 返回明确 unsupported，不伪造窗口。
- `usage/limits.ts`: `getUsageLimitsReport(): UsageLimitsReport`（只读快照）；`refreshUsageLimits(instanceIds?: string[], signal?: AbortSignal): Promise<UsageLimitsReport>`；`ingestUsageLimits(instanceId: string, update: ProviderUsageLimitsUpdate): void`；`consumeUsageReset(input: ProviderConsumeResetCreditInput): Promise<ProviderConsumeResetCreditResult>`。
- `usage/hubs.ts`: `listUsageSources(): UsageLimitSourceView[]`；`createUsageSource(input: UsageLimitSourceInput): UsageLimitSourceView`；`updateUsageSource(id: string, input: UsageLimitSourceInput): UsageLimitSourceView`；`deleteUsageSource(id: string, revision: number): void`。
- `usage/service.ts`: `readUsageSummary(input: UsageSummaryInput): Promise<UsageSummary>`（缓存正常读取）；显式 refresh 用同 input 的 `awaitRefresh:true`。
- `usage/settings.ts`: `getUsageSettings(): UsageSettings`，`updateUsageSettings(input: UsageSettingsUpdate): UsageSettings`；revision 冲突保留客户端草稿，alias 循环拒绝，未知模型可自定义价格，cache 价格省略用 input、0 保持免费。
- `usage/ledger.ts`: SQLite 保存 generation/thread 的真实 native turn/context/reportedTurn。扫描原生历史与本地采集不双算同 session/turn；只有完整 canonical 计数可作为无对应原生历史的聚合补充。原生分类不完整时仍保存和显示实际计数，但不猜测分类或费用。

### HTTP（内部 `/api`，浏览器 workspaceClient 自动加 `/agent`）

- `POST /api/usage/summary`: UsageSummaryInput → UsageSummary。
- `POST /api/usage/refresh`: 同 input，强制 awaitRefresh → UsageSummary。
- `GET /api/usage/settings`: UsageSettings；`PATCH` 同路径 UsageSettingsUpdate → UsageSettings。
- `GET /api/usage/limits`: UsageLimitsReport，不触发模型或刷新。
- `POST /api/usage/limits/refresh`: `{instanceIds?: string[]}` → UsageLimitsReport。
- `POST /api/usage/limits/reset`: ProviderConsumeResetCreditInput → ProviderConsumeResetCreditResult；必须用户明确确认，不自动重试未知结果。
- `GET /api/usage/sources`: `{sources: UsageLimitSourceView[]}`；`POST` UsageLimitSourceInput → `{source}`；`PUT /:id` 同输入（revision 必填）→ `{source}`；`DELETE /:id?revision=N` → `{deleted:true}`。
- `GET /api/usage/threads/:threadId`: ThreadUsageSnapshot，沿用当前 PM 授权范围校验，只读检查不得调用会创建目录的 resolve 路由。

## 并行所有权

| 包 | 所有文件与成果 |
| --- | --- |
| U1 历史文本 | `usage/readers/transcripts.ts`、专属解析器/流读取/增量缓存/测试；复制 Codex/Claude/Grok/Pi 真实格式，保留去重、累计差分、快/超快与缓存语义 |
| U2 原生数据库 | `usage/readers/databases.ts`、OpenCode/Antigravity/Muse 专属 reader/测试；只读数据库/历史、原生子会话、结构化成本、独立配置路径 |
| U3 核心额度 | `usage/limits/core.ts` 及 Codex/Claude/Grok probe/reset 专属 helper/测试；真实认证与接口约束，不自动刷新账号、不泄漏 token |
| U4 其他额度/账号历史 | `usage/limits/other.ts`、`usage/readers/cursor.ts`、Cursor/OpenCode/Antigravity/Muse quota helpers/测试；账号去重、Cursor stale cache、明确不支持情况 |
| U5 额度服务/Hub | `usage/limits.ts`、`usage/hubs.ts`、Hub专属helpers/测试、`maintenance/agent-backup.ts`秘密排除；合并稀疏更新、过期/失败区分、只读快照、管理key写入不回显、credits真实动作 |
| U6 核心统计/API | `usage/service.ts`、pricing/settings/aggregation/ledger/routes与测试、`app.ts`挂载、durable `chat-runtime.ts` usage callback，必要只读 scope helper；对接所有reader/probe，时区/DST/24h/7/30/90d统计与去重 |
| U7 原生运行遥测 | `providers/runtime.ts`、九类driver/protocol与专属测试、`agents/cli-chat.ts`可选canonical结果；真实token/cache/reasoning/context/rate limits映射，保持本次已实现output/onRequest，不改auth配置或权限 |
| U8 前端 | 新 usage 页面与组件/hooks、settings Usage providers/价格面板、`app.tsx`路由、`thread.aui.tsx` Composer context/`/usage-limits`接入；不碰正在并行修改的 `pm/chat-surface.tsx`/session/sidebar，由主集成接入口 |

每个子代理负责实现，不只报告。可以复用来源纯函数并改为当前 Zod/Promise/React/Hono 模式，不能引入第二套 Effect/多环境框架。禁止中途 build/lint/tests/formatters；主集成在各片就绪后统一运行。Node 24 strip-only 不支持构造函数 parameter properties；不可写 `constructor(private ...)`。现有并行 Automation/Sidebar 与依赖变化属于用户；保留并读取最新状态，不重建、格式化或覆盖无关文件。

## 验收

1. 真格式 history fixture → 实际 reader → Hono API → 浏览器 Cost/Tokens/模型详情，验证 dedupe、跨时区/DST、缓存与reasoning不双算、未知价格与缓存价格、别名/改价revision。
2. 受控 Dashboard/CLI/quota/Hub 接口 → 实际 probe/cache/pool → Limits/Composer；核对 failed/unsupported、不同窗口稀疏合并、同账号去重、重置时间和明确 reset credit 动作。
3. 原生子进程 usage 事件 → durable snapshot → Composer context meter；缺少容量不虚构百分比，切Session/刷新保持正确实例。
4. 桌面和390px、深浅主题、筛选/刷新/快捷键/表单冲突/秘密不回显，不运行模型的 `/usage-limits`。
5. 受影响类型/lint/测试/构建。PM 全量测试已有另一进程持锁（本次运行输出验收尝试返回75），不终止、不绕过锁或冒充通过。真实供应商未实际联网的部分逐项明确。

## 实现与验证记录

- U1–U8 已用本会话 `openai-codex/gpt-6.1-terra:xhigh` task override 实现，必要的嵌套切片继承相同配置；未保存全局配置。保留并行 Automation/Session/依赖修改，仅接入导航、共享合同和实际调用链。
- 历史读取、价格/别名、Hono API、SQLite 遥测、额度/Hub 与前端已连通；原生格式/身份隔离/DST/缓存分类/费用/去重/额度窗口/失败/修订冲突/秘密备份均有行为回归。首次集成发现并修复 Codex callback Error 类型、测试 helper 的字面量类型、Node ESM 扩展名、Usage 备份安全白名单问题，未削弱路径防护。
- 工程检查：完整 Agent 检查 client-runtime **11/11**、server **440/440**、desktop **3/3**；前端 Usage 行为 **24/24**，无失败/取消/跳过。后续未检查额度状态修正后的 quota/ledger/backup 专项 **14/14**。Agent 全量类型检查、服务端构建、独立 Web Vite 构建通过，lint 无输出；保留既有字体/Zod/大 chunk 提示。全量 PM backend 此前因其他测试进程持锁退出75，没有绕过锁，不记作通过。
- 隔离44323/44324真实 Hono HTTP + SQLite + 原生 JSONL smoke：14条有效记录，复制的原生历史不重复计算；总 token **6,160,000**，reasoning **35,000** 已包含于 output，未再次相加。受控价格下成本 **$21.724**、1条未定价；别名后 **$24.658**。停用实例历史可查询，设置409保留胜出状态，Origin拒绝403，Hub同账号去重，GET额度不探测，探测失败保留旧窗口，响应不含管理密钥。
- 浏览器完成真实表单保存：未知模型自定义输入/输出价格、缓存读取0、缓存写入留空；并发修改制造409后草稿保留，读取新revision再保存保留另一写入者的别名。Hub改名保留密钥、不回显。重置先取消、再明确确认；受控Hub实际收到 **1** 次 consume，页面显示“已重置”、credits归零。
- 原生 Codex JSON-RPC 子进程在运行中报告13,000上下文，终态26,000/200,000；partial turn保留输入24,000、输出2,000、缓存读取8,000、reasoning500而不生成canonical费用。完整 turn归一化为未缓存15,000/缓存读取8,000/写入1,000/输出2,000；历史合计仅增加26,000而不是重复累加通知。`/usage-limits` 实测仅GET快照，无生成或刷新POST。
- 浏览器验收覆盖桌面1440×1000、390×844、深浅主题、Cost/Tokens/Limits、模型弹窗、图表、实例筛选和快捷键返回原会话。修复来源价格URL撑宽窄屏及独立Usage页面未订阅主题变化，最终页宽390。自动额度刷新曾在离开再进入时重复发起：实际复现2次，改为路由生命周期外的5分钟窗口后同操作仅1次；失败也占用该间隔，显式刷新不受此限制。未检查实例不再显示1970或伪造查询失败。最后 Web 类型检查、lint 和独立构建通过。
- 来源供应商接口和价格响应由受控fixture提供，PM身份/目录也为fixture；这证明本次真实进程、HTTP、持久化和浏览器链路，不证明商业账号、收费模型、macOS Keychain或所有供应商线上版本已验收。ACP无通用历史格式；Muse独立额度查询不伪造，保留实际运行遥测。没有原生容量/额度/成本时明确不可用；未授权自动压缩或自动重试副作用。
- 收尾已关闭临时浏览器和自建服务，移除本轮 smoke 脚本、独立 Web 产物及临时数据；未删除用户业务目录。文档检查通过：101个Markdown、27个计划步骤与领域引用；40个仓库外可选链接未纳入可移植检查。源码与隔离验证完成，不宣称常驻页面已发布。
