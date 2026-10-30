# v4 Usage 数据链路补齐与页面复刻计划

状态：**已获用户授权并完成源码实施，受控数据链路与浏览器验收已执行**。PM 正式任务未创建/发布；未提交、推送或重启现有服务。工程检查与交付边界见第8节。

修订：2026-10-30，按用户纠正撤回“仅展示层增量、现有后端原则上不动”的范围限制。**以 t3code Usage 数据链路为功能参照，补齐当前实现，再交付截图中的页面。** 已存在模块不等于行为对齐，旧验收不等于本轮差异已消除。

第2–7节保留实施前的范围、任务分解和验收合同，不作为当前未实现清单。用户随后明确要求使用 `gpt-6.1-sol`、`xhigh` subagents 实施；本轮按六个独立文件范围并行完成，主代理负责接口、客户端数据层、集成与统一验收。

## 1. 基线与范围

### 已确认事实

- 目标：对照 t3code 的原生历史/账号采集、缓存、标准化、去重、计价、汇总、客户端合并、额度及运行遥测链路补充本项目现有逻辑，并在 `/agent/usage` 复刻截图中的展示与交互；不是只换 UI，也不另建演示页。
- 用户提供三个图片路径，其中第二、第三个完全相同；实际读取两张独立图片：`Screenshot 2026-10-29 121538.png`（Cost，1908×1236）和 `Screenshot 2026-10-29 121547.png`（Tokens，1900×1227）。目录为 `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/tmp-screenshot`。没有第三张独立图片，也没有 Limits 正文截图。
- 参考仓库：`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/t3code`，读取时 HEAD 为 `d53873b6a4799e87afd63c8d288ef0089f5a3748`。本计划依据实际读取的工作树源码，不声称已校验其工作树与提交完全一致。
- 当前项目 HEAD 为 `2f21c0769de35f414d983fc3393e5b2feb44e03d`，工作树已有大量并行修改；上述 HEAD 不能代表当前全部实现。现有 Usage 已包含历史、价格、额度、模型详情和 Composer 接入。
- 调查日期：2026-10-30。来源仅只读，不修改 t3code。移植代码继续保留 MIT 与 `LICENSE.t3code` 归属。
- 代码目标明确为本仓 Agent Usage；未查询 PM 业务任务目录。**基于所提供材料及源码，未核对现有任务**，不声称与已有正式任务完成去重；负责人、容量与交付日期未提供。

### 默认决策

1. **截图决定视觉目标，t3code 的 Usage 链路决定功能对齐目标，当前项目的授权和业务规则决定安全边界。现有数据合同允许随链路补齐同步调整，不能反过来限制需求。** 移植来源的计算与状态语义，适配当前 Zod/Promise/HTTP/React 架构，不机械复制框架。例如参考源码桌面顶栏把指标放在时间之前，本次视觉仍采用截图的时间、指标、刷新、关闭顺序。
2. 保留 `/agent/usage` 及现有返回对话逻辑；不替换 PM 外壳、不增加第二套路由、状态管理或 Effect 运行时。
3. 本项目只有一个本机环境。截图的 `All environments` 改为真实的“本机环境”，保留来源状态、模型价格设置入口；不制造远程环境选择器。Provider 筛选与实例筛选概念分开，现有实例筛选能力不得丢失。
4. Cost、Tokens 按两张截图完整复刻；Limits 同时对照 t3code 补齐探测、原生回报、Hub、账号合并、窗口计算与客户端消费链路。缺少 Limits 正文截图仅限制像素对照，不作为排除其数据逻辑的理由。
5. 保留当前页面语言约定；截图中的英文模块名用于对照，不单独新增国际化框架。数字采用 K/M/B 紧凑格式，详细值可通过 tooltip 或详情读取。
6. 不写死截图金额、模型、Provider 数量、日期与会话数。测试数据只存在于隔离验收环境，不作为正式页面 fallback。

### 非目标与约束

- 原生 reader、扫描缓存、价格/别名、聚合、limits/Hub、运行遥测和客户端合并均在差异补齐范围内；按来源逐项判定“已等价可复用 / 已确认缺口需实现 / 待场景验证”，不得以模块存在或 UI 暂不显示为由跳过。保留现有 Provider 配置和认证流程，只调整 Usage 实际依赖的读取/身份绑定，不另造认证产品。
- 不新增账单、支付、预算、远程环境、移动 Widget、多用户权限或项目费用归属。原生来源可能包含本机配置账号在其他工具中的历史，不把它改称当前 PM 项目的用量。
- 本次规划不读取凭据或调用供应商；后续用受控输入验证链路，不调用收费模型、消耗真实 reset credit 或改写宿主 CLI 配置。实际 Usage 运行继续使用既有授权与原生认证边界，不把“规划不读凭据”误写成禁止正式 reader 使用其必要认证。
- 遵守 [领域不变量](../domain-design/invariants.md) INV-03、INV-09、INV-20 和 [场景](../domain-design/scenarios.md) SC-14、SC-20：统计不是业务完成依据，不扩大授权，未知写入结果不能自动重试。接口和身份边界对应 [领域计划](../domain-design/README.md) INF-05、INF-06；不恢复其中的历史完成规则。
- **会话与持久化尚未经过统一设计，当前暂沿用 Agent Chat 的保存方式。** 本次不以 Usage sessions 统计重定义业务 Session 或增加会话存储。

## 2. 截图元素与增量映射

| 区域 | 截图目标 | 当前实现及本次增量 |
| --- | --- | --- |
| 顶栏 | 单行 Usage / 环境 / Provider；右侧时间、指标、刷新、关闭 | 目前是大标题、返回链接、设置链接和多行工具栏；合并为紧凑顶栏，关闭复用原返回目标及 state |
| 主体外壳 | 居中宽内容区、明显留白、轻分隔，无嵌套大卡片 | 替换 `.usage-panel` 在概览中的重边框和圆角，不把影响扩散到设置与额度确认弹窗 |
| 首屏左列 | 大号金额或 Tokens；sessions/API estimate；Provider 图标、名称、sessions、主值、占比及次值 | 当前仅两个总数，没有 Provider 汇总列表；新增受筛选控制的展示聚合 |
| 首屏右列 | 按 Provider 分色的平滑曲线与浅面积填充，坐标网格、日期轴 | 当前按 Provider+模型画堆叠柱，位于页底；改为顶部 Provider 趋势，不能只移动旧柱图冒充复刻 |
| Totals | Processed tokens、Cached input、Uncached input、Output、Cache savings 五列 | 当前分类数字分散且重复；合并成稳定五列，窄屏重排，缓存写入等额外真实分类在分解/详情保留 |
| Cost 分解 | 并排 Cost by type / Cost by speed，细灰阶条及图例，右侧 Premium | 当前彩色条和大数字格重复；重做细条、灰阶、紧凑图例；Fast/Ultrafast 有数据才显示速度分解 |
| Tokens 分解 | Tokens by type 单条；不展示成本速度栏 | 对齐原生计数标准化与聚合，再用统一结果绘制；非零 cache write 不能为了匹配样图而丢弃 |
| Breakdown | Model / Day 切换；模型表为 #、Model、Cost、Share、Tokens；模型图标和细横条 | 当前只有模型表，缺排名、占比与时间视图；补齐 Day，24h 自动变 Hour；按当前指标排序 |
| 模型详情 | 点击模型查看趋势、缓存命中率、每百万成本、设置价格入口 | 复用 `UsageModelDetail`；与新图表接口一起迁移，保留未定价说明及现有设置链接 |
| 状态与设置 | 来源/扫描状态不抢占主视觉；失败和部分数据清晰可见 | 来源技术明细可折叠或进入环境菜单；失败、过期、未定价警告不能全部藏进 tooltip |
| Limits | 同一顶栏，时间范围不参与额度查询 | 对照来源补齐账号/窗口及刷新数据逻辑，再呈现真实账号池；保留安全确认与未知结果核对 |

布局参数先参照来源的 18rem 左列、24px 左右列间距、五列 Totals、双列分类条、36px 主指标与 12/14px 辅助/正文字号。截图文件像素不直接当 CSS 像素；以浏览器 viewport、DPR、缩放和字体一致时的对照结果校正。视觉重点是布局比例、顺序、密度、图表形态与层级，不是复刻样本金额。

## 3. 数据口径与共享接口

现有合同在 [usage.ts](../../packages/agent-contracts/src/usage.ts)，HTTP 客户端与服务路由分别在 [api.ts](../../apps/web/src/features/agent/src/usage/api.ts)、[routes.ts](../../apps/server/agent/src/usage/routes.ts)。沿用现有 summary/refresh、limits/refresh/reset、settings 入口组织能力；按对齐结果修改合同、服务及全部消费者，不建立平行事实源。相同 `contractVersion: 6` 只表明版本数字相同，不证明行为、解码或合并语义已对齐。

### 3.1 数据链路对照与补齐清单

下列为源码核对结果，不是运行时验收。`t3/` 表示用户指定参考仓库；`local/` 表示本仓。后续实施必须为每项保留来源行为、当前行为、变更和运行证据，不能只勾选“模块已存在”。

| 链路 | t3code 依据 | 当前依据与判定 | 本次工作 |
| --- | --- | --- | --- |
| 原生来源与记录标准化 | `t3/apps/server/src/usage/UsageService.ts:81–91` 通过各 driver 的 transcript/scan reader 读取；格式定义位于 provider 包及服务端 Drivers | `local/apps/server/agent/src/usage/service.ts:39–46` 已调用 transcript/database/Cursor/ledger；`readers/databases.ts:181–196` 已接 OpenCode、Muse、Antigravity。**已存在，完整格式等价性待逐供应商核对** | T7 对八类历史来源逐项对齐字段、路径、身份、分页/子会话及错误语义；不能把 Muse 不在 transcript 分支误判为缺失 |
| 扫描缓存与并发 | `t3/.../UsageService.ts:77–79,894–895,916–956` 有保留窗口、受限并发、按查询/设置合并在途扫描、完成后持久化；`usageScanCache.ts` 负责版本化缓存 | `local/.../readers/transcript-stream.ts:18,31–94` 有内存增量缓存、offset/guard 与文件身份校验；`service.ts:17–59` 无 summary 级在途合并。**确认缺少持久 transcript 缓存和 summary 请求合并，不是完全没有缓存** | T7 补持久缓存、重启复用、失效/裁剪、受限扫描并发；T8 接 summary single-flight，键包括实例范围、时间/时区、设置身份和刷新模式，避免一次刷新影响另一筛选 |
| Codex 速度档位补全 | `t3/.../UsageService.ts:778–815` 调 `resolveServiceTiers` 并回写当前缓存；`CodexUsageHistory.ts:45–115` 匹配 turn/session/model 与首次 running 时的选择，歧义不推测 | `local/.../service.ts:42–45` 仅对 `unresolvedServiceTierTurnId` 发警告。**确认缺少可信历史回填步骤** | T8 使用本项目已保存的 generation/原生 session/turn 与启动选项建立等价查询；必要时补齐今后运行的最小元数据，不读取 t3code 数据库。历史无法证明档位仍标未知；不能拿当前模型选项倒填过去 |
| 记录去重与 sessions | `t3/.../UsageService.ts:817–859` 跨文件 occurrence key、去重后 source sessions；`packages/shared/src/usageMerge.ts:143–265,399–409` 判定来源贡献后累计 | `local/.../readers/transcripts.ts:85–96` **已有 Codex occurrence 去重**；`aggregation.ts:108–124,160–171` 已有记录与 source 计数；`ledger.ts:64–97` 有 native turn/session 优先边界 | T7/T8 保留并验证上述能力，补齐其他格式差异；T10 消费 source sessions，不重复累计桶。ledger 是本项目额外来源，必须单独证明 fallback 与原生记录不双算 |
| 价格与分类成本 | `t3/.../usagePricing.ts`、`UsageService.ts` 的价格缓存、override、alias、providerReported、分类、缓存节省及速度溢价 | `local/.../pricing.ts:278–329,332–419` 已有主要计算及价格缓存；不能据此宣布所有 reader 的 reported cost 与 speed 已正确贯通 | T8 对相同输入比较价格选择、别名后的模型/费率、显式0与缺省缓存价、Other、未知价格、长上下文与速度费率；修复实际差异，不新增来源没有的快档自定义价格产品 |
| 共享汇总、版本和进度 | `t3/packages/shared/src/usageMerge.ts:277–595` 提供版本门禁、Provider/model/day/hour、sessions、costQuality、来源贡献；`usageProgress.ts:11–85` 区分逐 Provider 进度 | `local/.../web/.../usage/page-data.ts:34–48` 是桶累加；`UsagePage.tsx:80–103` 管页面内轮询/epoch，未实现上述完整合并层。**确认需补齐** | T10 适配共享合并语义、兼容检查和刷新快照身份；多环境传输不在范围，但单环境多来源/账号和版本状态不能省略 |
| 额度稀疏回报与探测 | `t3/packages/provider-core/src/server/usageLimits.ts:50–121` 空更新不清窗、相同更新不改快照、失败保留已发布有效时间；`managedProvider.ts:158–179` 防账号/工作区串用 | `local/.../limits.ts:25–45` 空更新已忽略；相同非空更新仍刷新时间，失败分支保留窗口但采用本次失败的 `checkedAt`。**确认有状态语义差异** | T9 区分有效窗口时间与最近探测结果、实现 no-op 与身份隔离；明确 probe 完整快照和 runtime 稀疏更新两种语义，**不能把空稀疏更新改成清空窗口**。unsupported 转换按实际 Provider 能力验证，保留 Muse 仅运行时报告的合法路径 |
| Hub 刷新与 reset | `t3/.../UsageLimitSources.ts:89–123` 刷新与兑换共锁，兑换后重读并发布 | `local/.../limits.ts:93–110` 串行刷新；`:112–129` reset 另用进行中集合，没有加入刷新队列或后置读。**确认缺口** | T9 对同源刷新/兑换建立同一顺序边界；成功后重读并更新快照，重读失败单独说明“动作已确认、额度未确认”，不得误报动作失败后再兑换 |
| 账号合并与窗口池 | `t3/packages/shared/src/usageLimits.ts:375–508,662–788` 账号识别、可用快照选择、credit 来源、周额度门控和重置估计 | `local/.../limits.ts:47–80` 服务端按 fingerprint 合并；Web `page-data.ts:50–108` 再按身份合并并算有效窗口；Composer 另按实例展示。**存在多处规则，等价性待统一验证** | T9/T10 抽取共享纯规则，API/页面/Composer 使用一致身份与窗口语义；不强制把所有展示计算塞进服务器。保留窗口缺失、过期、模糊身份和 credit 动作来源 |

供应商对齐矩阵必须覆盖：Codex/Claude/Grok/Pi JSONL；OpenCode SQLite 与旧 JSON；Antigravity 原生数据；Muse 原生历史及子会话；Cursor Dashboard 的分页、重叠、账号级缓存。逐项注明当前已有能力与来源差异；本轮未穷尽上述所有 reader，**“待核对”是实施任务，不是可以跳过的验收项**。FX/ACP 不因参考里没有通用历史格式而虚构 reader，已有合法 canonical telemetry 仍按当前合同处理。

链路分工：reader 产出实际记录和身份 → scan cache/可信档位补全 → 去重及 native/ledger 优先 → alias/价格/时间桶 → 版本化 summary → 共享合并/进度 → 页面。额度链路单独为 probe/runtime/Hub → 身份与快照归并 → 共享窗口池 → Limits/Composer；两条链路不能用 token 总量推算订阅余额。

持久扫描缓存仅保存必要 usage 元数据，不保存提示词/凭据；是可重建派生数据，不替代现有 Agent 会话持久化。新增缓存文件须接入现有私有目录、原子写和离线备份/排除约定；不得因缓存损坏放弃重新读取真实来源，也不能将重建结果冒充完整历史。

### 共享合并与展示模型

参照 t3code `usageMerge.ts`、`usageProgress.ts` 和客户端 Usage 状态，补齐本项目共享数据层，而不是在每个组件内另算一份。现有 `page-data.ts` 是迁移起点，不是功能上限；页面、图表、模型详情及适用的 Composer 消费共享投影和快照：

- 筛选输入：时间窗口、时区、选定实例、选定 Provider；Provider 类型多选在展示层执行，实例范围由现有 `instanceIds` 请求限定。Limits 对同一 Provider/实例条件过滤，Hub-only 账号不伪装为某个本地实例。
- 结果：整体 totals、按 Provider 汇总、按 Provider+model 明细、完整时间轴、按时段/Provider 聚合、完整性与价格状态。图表隐藏/Provider 筛选采用明确且一致的语义，不能出现总额与表格悄悄统计不同集合。
- tokens = uncached input + cached input + cache creation + output；reasoning 已包含于 output。Premium 是速度成本中的溢价说明，不再次加入总成本。
- Cost 占比基于当前筛选的已知成本，并标明未定价部分；全未定价的 Cost 和 Share 不显示 `$0`/`0%`。Tokens 占比仍包含未定价模型。真实免费与未知价格分开。
- 模型行细条按本视图最大行值归一化，Share 列才是整体占比，两者不能混为一个字段。极小正值可显示 `<0.1%`，精确值仍可读取。
- Day/Hour 以当前指标显示每个 Provider、合计与 Tokens，按时间倒序；日期窗口按现有时区语义，24h 是精确最近24小时，不能简单当作本地自然日。
- 图表以 Provider 稳定配色；Codex 使用主题前景、OpenCode 采用来源蓝色语义，其余使用稳定 Provider 配色。分类条使用主题灰阶，不复用当前模型名哈希色。
- 补齐选定窗口的时间坐标。在成功覆盖的历史范围内，无记录时段可呈现观测值0；缺失/失败/部分扫描或未定价不是已知0，必须保留不完整说明/未知标记，不能通过平滑曲线伪造完整历史。

### sessions 的特殊风险

[aggregation.ts](../../apps/server/agent/src/usage/aggregation.ts) 对每个时间/模型/source 桶维护 sessions 集合，另对 source 维护窗口内 `distinctSessions`。直接累加桶的 `sessions` 会让跨日、跨模型会话重复计数。

t3code 合同明确要求客户端汇总 source 的 `distinctSessions`，其 `usageMerge.ts` 在来源归属判定后累计到 Provider 和总量；本项目应先对齐这条既有口径，**不先发明一套全局 session ID 合同**。来源身份、同 home 多实例和复制记录的去重在 reader/聚合层核对；客户端不可再累加桶 sessions。若场景证明当前来源信息确实不足，才调整合同并同步消费者。来源本来不提供 session 身份时明确不支持/部分覆盖，不能把请求数当 sessions。

### 状态与刷新

- 对齐来源的首次加载、无数据、逐 Provider 部分结果、失败、旧快照、合同不兼容和未定价状态；保留旧结果时同时保留其窗口/筛选身份，不让旧值冒充新查询。
- 对齐请求合并、扫描/价格刷新、settings revision 失效、缓存更新和竞态保护，再接显式刷新与额度自动检查。已有 epoch 与5分钟间隔需保留并验证，但不能当作整个刷新链路已等价的证据。
- 页面偏好仅保存指标、时间范围、Provider 选择等显示状态；复用既有浏览器偏好约定，不能将它当新的会话持久化设计。
- 使用 reset credit 仍须明确确认；未知结果先刷新核对，禁止自动再发。设置继续使用 revision 冲突保护。

## 4. 候选任务

下列编号仅在本草稿有效，不是 PM 正式对象 ID。保留原 T2–T6 的页面成果编号；重定义 T1，并新增 T7–T10 作为**必需的数据链路成果**，不是可选优化。所有候选仍不新增权限、账单或业务完成规则。

| 候选编号 | 目标/成果 | 范围与非目标 | 验收 | 前置依赖 | 来源 | 待确认项 |
| --- | --- | --- | --- | --- | --- | --- |
| draft:T1 | 冻结来源对照、记录和快照合同 | 逐层/逐 Provider 的差异矩阵；UsageRecord、source 身份、查询键、价格与额度状态及消费者接口；不限于 UI 字段 | 每项标明已等价/需补齐/待场景证明；后端和前端可依据同一合同实现，不以版本号相同代替对齐 | 无 | 第3.1节与 t3code Usage 全链路 | 仅实际无法取得的供应商协议输入列阻塞；先从源码/现有 fixture 获取 |
| draft:T7 | 原生采集、去重与持久扫描缓存 | transcript/database/Cursor reader 差异、缓存加载/增量/失效/裁剪、受限并发、native/ledger 身份边界；不复制宿主凭据 | 八类来源逐项场景通过；重启后缓存可复用；追加/截断/替换/半行不漏不重；已有 Codex 去重、Cursor 缓存不回归 | T1 | UsageService、usageScanCache、各 provider usage reader；本地 readers/ledger | 历史缺失只能标明，不补造记录 |
| draft:T8 | 可信档位、计价、汇总与服务编排 | Codex tier 回填、alias/price/costQuality、按日/小时/来源统计、summary single-flight、设置和价格刷新贯通；集成 T7 reader 接口 | 可证实 fast/ultrafast 正确计价；歧义保持未知；同查询并发共享扫描且不同实例/设置隔离；模型/Provider/时间合计一致 | T1 | CodexUsageHistory、usageAggregation、usagePricing、UsageService | 旧运行元数据不完整时不能推断历史档位；新采集须闭环 |
| draft:T9 | 额度、Hub 与原生回报链路 | 各 Provider probe/runtime 语义、有效时间/失败、账号身份、共享归并/窗口池、refresh/reset 同步与后置读；不新增自动兑换 | 空稀疏更新不清窗；重复回报不伪造新检查；失败旧值可辨；换账号不串用；兑换与刷新竞态、确认后读取失败可区分 | T1 | provider-core usageLimits、UsageLimitSources、shared usageLimits；本地 limits/Hub | 不支持的供应商能力显式保留，不因 UI 存在而虚构 |
| draft:T10 | 共享客户端合并、快照与刷新状态 | 适配 usageMerge/usageProgress；版本/未知变体处理、source sessions、Provider/model/day/hour、费用质量、筛选与缓存失效；Limits/Composer 共享规则 | summary 经版本与来源判定后统一供图表/表格消费；Provider 筛选同时过滤 sources/buckets；迟到/旧窗口结果不能串页；额度消费口径一致 | T7、T8、T9 | shared usageMerge/usageLimits、client-runtime state、Web state/usage | 不照搬 Effect/多环境框架；兼容行为须明确声明 |
| draft:T2 | 紧凑页面外壳与筛选入口 | UsagePage/usage-page.css/navigation；菜单、时间/指标/刷新/关闭，消费冻结接口；不另建计算层 | 顶栏符合截图；关闭恢复原会话；筛选与真实请求关联；Limits 时间控件不生效 | T1 | 截图顶栏、来源 UsagePage | 本机环境替代多环境，作为本计划默认 |
| draft:T3 | Provider 汇总与趋势首屏 | Provider 列表、sessions、曲线、坐标/tooltip、完整时间轴；消费 T10 共享结果 | 单位、占比、颜色与底层数据一致；按日/小时准确；未知不画成已知零；键盘/触摸可读详情 | T10 | 两张截图上半部、UsageProviderChart | 无 |
| draft:T4 | Totals、分类条与 Breakdown | 五项 Totals、分类/速度条、Premium、Model/Day/Hour、排名/占比及模型详情；消费 T10 | 非零缓存写入/Other/Ultrafast不丢；未知价格、排序和模型详情使用同一口径；设置价格后数据收敛 | T10 | 截图下半部、UsageShareBar/usageBreakdown、模型详情 | 无 |
| draft:T5 | 全链路页面集成、Limits 与响应式 | 接入真实完成的采集/计价/额度/共享状态和 T2–T4；清除旧重复聚合，保留安全提示 | 正式路由可操作完整链路；390px、深浅主题、来源状态、Limits/Composer、弹窗与快捷键一致 | T2、T3、T4 | 当前 UI 与 t3code 页面及共享状态 | 无 Limits 正文截图只影响视觉对照，不降低链路验收 |
| draft:T6 | 数据对照与端到端视觉验收 | 同输入差分检查、真实 reader→服务→浏览器、缓存重启与竞态、受影响工程检查及文档 | 第6节全部通过；每个来源差异有结论；不可只用前端 mock、旧验收或“页面有数字”结项 | T5 | 本计划、来源行为与原生格式 fixture | 未提供负责人、资源与工期；不承诺日期 |

## 5. 关系、里程碑与文件所有权

父目标为“Usage 数据链路补齐与页面复刻”；T1–T10 是成果分解，不使用父子关系替代依赖。

- `draft:T7 depends_on draft:T1`、`draft:T8 depends_on draft:T1`、`draft:T9 depends_on draft:T1`：需要稳定记录、来源、查询与快照合同，三个后端成果可按文件所有权并行。
- `draft:T2 depends_on draft:T1`：页面外壳可依据冻结合同并行制作，不代表链路已接通。
- `draft:T10 depends_on draft:T7`、`draft:T10 depends_on draft:T8`、`draft:T10 depends_on draft:T9`：共享客户端成果必须消费已对齐的真实 summary/limits，不能以 fixture 作为完成依据。
- `draft:T3 depends_on draft:T10`、`draft:T4 depends_on draft:T10`：图表与明细共用合并结果，不在组件内绕过数据层。
- `draft:T5 depends_on draft:T2`、`draft:T5 depends_on draft:T3`、`draft:T5 depends_on draft:T4`：需要外壳、首屏和明细的实际组件才能集成。
- `draft:T6 depends_on draft:T5`：完整链路才能做端到端验收。依赖无自环或反向边。
- `draft:M1`：T1 结束，来源/接口明确；`draft:M2`：T7–T10 结束，数据链路对齐并可消费；`draft:M3`：T2–T5 结束，完整页面可操作；`draft:M4`：T6 结束，数据与视觉证据齐全。均为候选里程碑，不表示目前达成。

推荐顺序：T1 → 并行 T7/T8/T9/T2 → T10 → 并行 T3/T4 → T5 → T6。可以提前开发已冻结接口的组件，但不能提前标记真实接入验收完成。共享文件只有一个集成所有者：

| 文件范围 | 责任与共享限制 |
| --- | --- |
| `packages/agent-contracts/src/usage.ts`、`usage/types.ts`、HTTP `routes.ts` | 集成所有者统一维护；T1 定义合同，各包提出必要增量；改导出符号前查引用，迁移所有消费者 |
| `apps/server/agent/src/usage/readers/*`、扫描缓存、`ledger.ts` 的历史贡献判定 | T7；T8 通过冻结的记录/档位补全接口衔接，不同时编辑 reader |
| `usage/service.ts`、`pricing.ts`、`aggregation.ts`、档位回填及必要的本地运行元数据 | T8；runtime/ledger 共享编辑由集成所有者落地，不复制来源 orchestration 数据库结构 |
| `usage/limits.ts`、`limits/*`、`hubs.ts`、`cliproxy.ts` 与共享账号/窗口纯函数 | T9；服务数据与展示池计算明确分层，不能前后端各保留一套身份优先级 |
| 客户端 Usage 合并、progress、`api.ts`、`page-data.ts` 与对应消费边界 | T10；公共接口供 T2–T4 使用，Composer 并行修改需先核对当前状态，不恢复被其他工作移除的 UI |
| `UsagePage.tsx`、`usage-page.css`、`navigation.tsx` | T2/集成所有者；其他包通过组件和 hook 接入，不并行改主页面 |
| `UsageCharts.tsx`、`usage-charts.css` | T3；提前冻结 ShareBar props，T4 使用接口，不同时改共用图表 |
| Totals/Breakdown、`UsageModelDetail.tsx` 与专属样式 | T4；只做必要组件划分，不建立通用仪表盘框架 |
| `UsageLimitsPage.tsx`、来源诊断、整体响应式与 Composer 共享消费接入 | T5；消费 T9/T10 规则，不在此新造计费/额度算法 |

并行实施已完成：TranscriptHistory、DatabaseHistory、PricingPipeline、QuotaPipeline、UsageSurface、ChartsSurface 均使用 `gpt-6.1-sol` / `xhigh`。各子任务未各自运行构建/格式化；集成后统一验证，保留无关并行修改。

## 6. 验收门槛

### 视觉与交互

1. 桌面 Cost/Tokens 在同 viewport/DPR/字体下与参考截图并排核对：顶栏、首屏左右分栏、五项 Totals、细分类条、Breakdown 顺序与比例；概览不再是连续大卡片或页底堆叠柱图。
2. 24h、7/30/90天；Provider 多选与实例筛选；Model/Day/Hour；刷新、关闭、模型详情、设置价格入口均真实操作。费用与 Tokens 切换同时改变排序、占比、主指标、图表单位，不只是标签。
3. 桌面常用宽度及390px，深浅主题；页面无横向溢出，宽时间表可在自身区域滚动。键盘焦点、Esc、C/T/L、时间快捷键及输入区屏蔽有效；曲线和占比不能只靠颜色理解。
4. 长模型名、多 Provider、极小值、空数据、全未定价、部分未定价、非零 cache write/Other/Ultrafast、失败和旧快照均有可读状态。

### 数据与安全

5. 隔离原生历史 fixture 经实际 reader、summary API 到浏览器，核对整体/Provider/模型/时间四层合计与 sessions 去重；不靠浏览器 mock 返回值证明服务聚合正确。
6. 24h 精确区间、跨日、DST；已知无记录与未完成扫描分开；缓存和 reasoning 不双算。刷新中快速切换条件，晚响应不能覆盖当前选择。
7. Limits 使用受控额度接口验证同账号去重、缺失窗口、检查失败、5分钟自动间隔、显式刷新、reset 取消/确认/未知结果；不消耗真实账号 credit。
8. `/agent/settings/usage` 与模型详情现有 revision、未定价与设置入口不回归；Composer `/usage-limits` 仍只读，不因图表重构触发模型执行或隐藏刷新。
9. 每个 Provider 使用相同原生格式输入，对照来源的标准化记录、时间桶、成本与状态；记录所有允许差异及理由，不要求把本项目不存在的远程环境框架搬入。没有逐来源证据不能宣称全链路等价。
10. 扫描缓存：首次读取、追加、完整/不完整尾行、同长度改写、截断、inode 更换、损坏缓存、重启、保留窗口裁剪；均以实际文件和进程验证结果。并发同查询只共享一次底层扫描，一名调用者离开不破坏其他等待者；不同设置/实例不错误复用。
11. 速度档位：缺少原生日志档位但存在可信本地启动记录时，准确回填并重算成本/溢价；turn/session/model 不匹配、多重匹配、执行中修改选项不误归因。仅在费率确有差价时断言非零 Premium，不能写“fast 必须更贵”的假验收。
12. 价格与别名：公共价格失败保留旧价时间、自定义0、缓存价留空、别名链/循环拒绝、providerReported/模型估价/未知和 Other；设置成功后 summary 与页面更新，冲突草稿保留。新档位补全不能抹掉用户明确的价格覆盖规则。
13. 额度：失败后旧窗口仍显示其真实有效时间；重复相同 runtime tick 不刷新快照时间；稀疏遗漏/空更新不清窗；完整 probe 与稀疏回报竞争、账号/工作区切换不串用。认证失败与未检查不伪装可用。
14. Hub：暂停一个刷新响应，再执行 reset；恢复响应后不得覆盖兑换后的快照。动作已确认但后置读失败时保留动作结果并提示核对，未知动作绝不自动重发。页面与 Composer 的同账号、窗口与 credit 来源一致。
15. 客户端：不兼容合同、未知 Provider 变体、部分返回、来源重复/缺失、旧窗口保留、改价后失效；每种情况说明哪些数据参与合并。不能静默丢数据后显示“完整”，不能把页面显示数字当合同验证。

### 工程与证据

- 前端：运行 `pnpm check:web`（lint、类型检查与构建）及受影响 Usage 行为测试；新增永久测试只针对去重、筛选、时间边界、占比和错误等消费者可见行为，不测试 CSS 字符串或 JSX 文案副本。
- 后端/共享合同是本次必测范围：运行 readers、缓存、aggregation/pricing、ledger/tier、routes、limits/Hub 与共享客户端的受影响行为回归，以及 Agent 类型检查、限定路径 lint 和构建。数据库、事务或流变更另运行规定的 `pnpm test:backend`，跳过不算通过；不以只跑 Web 检查交付数据链路。
- 临时端口启动前核对端口、PID、工作目录；通过真实浏览器保存 Cost/Tokens、Limits 兼容和390px截图及操作记录。默认不停止/重启现有3224/4194/4325/4326服务。
- 完成后更新 README 的 Usage 描述和本计划实施记录，保留历史计划作为历史；移除本轮临时脚本和隔离数据，不能删除用户并行工作。
- 受控协议证明页面与接口链路，不证明真实供应商账单、额度或所有平台已验收。没有真实浏览器证据不能标记“复刻完成”。

## 7. 复用、来源与发布交接

### 已有实现复用

- [历史 Usage 移植计划](v3-usage-plan.zh.md)：保留已实现的 reader、pricing、limits、Hub 与遥测作为补齐起点；复用已经证明等价的行为，不整套推倒重来，也不据旧 U1–U8 完成记录免除本次对照和修复。
- [UsagePage](../../apps/web/src/features/agent/src/usage/UsagePage.tsx)、[UsageCharts](../../apps/web/src/features/agent/src/usage/UsageCharts.tsx)、[page-data](../../apps/web/src/features/agent/src/usage/page-data.ts)：请求生命周期与统计基础复用；布局、图形和展示聚合按本计划替换。
- [UsageModelDetail](../../apps/web/src/features/agent/src/usage/UsageModelDetail.tsx)、[UsageLimitsPage](../../apps/web/src/features/agent/src/usage/UsageLimitsPage.tsx)：复用 UI 交互，迁移到补齐后的共享数据规则；保留安全确认和未知值，不机械保留已发现有差异的算法。
- [当前项目说明](../../README.md) 与 [后端交付边界](backend-delivery.md)：以当前 v4 边界为准。旧 Usage 计划中的旧目录名和独立 Home 描述不覆盖当前原生 Provider 配置规则。
- t3code 数据来源：`apps/server/src/usage/UsageService.ts`、`usageScanCache.ts`、`usageAggregation.ts`、`usagePricing.ts`、`CodexUsageHistory.ts`、`UsageLimitSources.ts`；各 `packages/provider-*/src/server` 与服务端 `provider/Drivers` 的历史/额度适配；`packages/provider-core/src/server/usageLimits.ts`、`packages/shared/src/usageMerge.ts`/`usageLimits.ts`、客户端 Usage/progress 状态。页面来源继续为 `apps/web/src/components/usage` 和 `docs/user/usage.md`；移植数据语义并适配现有架构，不复制另一套环境/身份框架。

### PM 发布与范围边界

- 本轮源码已按 T1–T10 完整依赖闭包实施；这些 `draft:` 编号仍是本文内的计划标识，不代表已创建正式 PM 任务。
- 查询实际授权项目的现有任务与关系，再将真正未覆盖的候选映射为正式 ID；目前没有 `existing:<ID>` 可列，不虚构复用任务或对象版本。
- 如果用户补充第三张不同截图，只复核受影响的 Limits/细节要求；不将当前重复路径解释为第三种画面。
- 本计划明确包含 t3code Usage 链路差异补齐，不能再按“Limits 仅兼容 / 后端只做 UI 必需字段”缩减。完整多环境、账单或新增认证产品仍需独立范围决定；本机已有 Provider 的 Usage 逻辑补齐不属于这些额外产品。
- 用户已授权源码实施，但没有授权创建 PM 正式任务、提交、推送或接管既有服务。本轮实际结果记录如下，不把受控协议验收扩展为真实供应商商业账单或全平台验收。

## 8. 实施与验收记录（2026-10-30）

### 交付范围

- **T1/T10 合同与客户端**：继续使用现有 HTTP 入口与合同 v6；增量字段为 `providerReportedRecords`、额度 `lastProbeAt`。客户端校验合同，兼容 v4–v6 的已知数据，未知 Provider 显式披露为遗漏；不兼容版本不合并。`UsageViewModel` 统一来源归属、会话数、Provider/模型/完整时间轴投影；请求 epoch 隔离切换后的晚响应，成功改价触发失效。
- **T7 原生历史与缓存**：JSONL 缓存原子私有持久化、重启加载、追加/尾行重放、文件与根目录身份校验；全局最多4个文件读取。缓存上限为92天、256文件、200,000条记录及96 MiB。OpenCode 使用有界 rowid 快照，Antigravity 使用一致读事务与 DB/WAL 缓存失效，Muse 保留原有子会话/评审并补齐大文件投影和持久缓存，Cursor 改为账号级覆盖缓存、重叠更新和最多6页并发。派生扫描缓存及其临时文件不进入离线备份。
- **T8 计价与归因**：查询共享任务同时绑定实例 revision/Home、设置、数据目录及刷新模式；匹配冻结启动配置与 native session/turn/model 后才补全 Codex 档位，无遥测的真实启动也可恢复。模糊、矛盾、继承和原生未知档位不猜测；保留原生历史优先及 ledger 会话去重。公共价格强制刷新、自定义0、别名循环和精确 provider-reported 记录数保持独立语义。
- **T9 额度**：共享账号/窗口/credit 规则迁入 `packages/agent-contracts/src/usage-limits.ts`，服务、Limits 与 Composer 使用同一套规则。稀疏空回报和相同 tick 不更新数据时间；失败保留旧窗口与 `checkedAt`，单独记录探测时间。实例/账号/工作区栅栏、刷新/reset 串行队列防止旧结果跨身份或覆盖兑换结果。
- **T2–T5 页面**：紧凑顶栏、真实实例与 Provider 筛选、左右概览、Provider 曲线、五项 Totals、灰阶分类条、按指标排序的 Model/Day/Hour、模型详情、价格入口、Limits 安全确认、返回上下文和快捷键。390px 自动重排，宽表只在自身区域滚动；没有恢复已被并行工作移除的输入框用量 UI。

### 逐来源对照与允许差异

依据第1节固定来源工作树的实际 reducer/reader/聚合逻辑编写原生格式回归；并非启动完整 t3code 服务做逐字节响应比较。

| Provider | 本轮对应证据 | 保留差异或边界 |
| --- | --- | --- |
| Codex | `transcript-codex.test.ts`、`transcript-parity.test.ts`、`service-tiers.test.ts`：累计差值、复制历史、fork、null 计数、未知档位、冻结启动回填 | 使用本项目持久化 generation 元数据，不移植来源 orchestration 数据库；不推断缺失/矛盾身份 |
| Claude | `transcript-parity.test.ts`：独立缓存类别、重复块、空 message/request ID、报告0成本、synthetic 排除 | 本项目继续拒绝负报告成本；未执行真实订阅账号探测 |
| Grok | `transcript-parity.test.ts`：时间优先级、inclusive input、ticks、跨模型比例与余数；样例成本 `$0.20 + $0.32 + $0.48` | 原生认证边界不变；配置目录按本项目有效环境解析 |
| Pi | `transcript-parity.test.ts`：session/header、不同原生 usage 变体、缓存类别、复制记录、零价回退 | 没有模型价格的历史仍保留 tokens，不把未知成本变为0 |
| OpenCode | `databases.test.ts`：SQLite/legacy JSON、rowid 边界、大 envelope、跨根去重 | 报告0仍按来源语义等待模型定价；不扫描相对 XDG 指向的无关目录 |
| Antigravity | `databases.test.ts`：protobuf/steps/retries、身份桥接、时间质量、WAL 更新、损坏部分结果 | 显式配置根优先，不额外扫描无关默认根；保留已支持的受管 profile 历史 |
| Muse | `databases.test.ts`：schema 1/3、子会话/自动评审、大 envelope、推理去重、缓存重启/损坏 | **保留本地扩展**：原生明确报告的成本，包括0；参考 reader 对该字段输出 null，不倒退为未知 |
| Cursor | `cursor.test.ts`：账号覆盖、分页重叠、并发/取消、半开区间、真实重复账单项、缓存迁移/损坏 | 受控 Dashboard 协议，不用本地对话估算；macOS Keychain 未在 Linux 验收 |

额外覆盖：`transcript-cache.test.ts` 的独立进程重启、追加/尾行、改写/截断、inode/root 变化、损坏、裁剪、共享扫描/取消与投影隐私；pricing、aggregation、ledger、service、routes、limits/Hub、runtime、备份及客户端行为回归均纳入统一测试。

缓存边界明确保留：被裁剪或淘汰的已删原生历史无法重建；整个根目录不可用时不继承未经验证的缓存身份。JSONL 快速 header/boundary 校验沿用 append-only 假设，不宣称检测得到“两个校验区不变、任意中段改写后继续增长”的所有情况。

### 实际浏览器与链路证据

在核对端口后，仅启动本轮临时4396服务与隔离 Home/数据目录；真实 Hono Usage 路由、SQLite、原生文件 reader、HTTP 客户端和现有 React 页面共同运行。只有输入历史和上游额度 Hub 受控，没有以浏览器 mock summary 替代后端。

- 4个原生 JSONL 来源、各28条记录，经实际服务到浏览器：**34,496,000 tokens、4 sessions、已知成本 `$267.938`，Pi 的28条未定价记录明确保留**。Provider 筛选与实例筛选一致；Codex 单实例为13,552,000 tokens / 1 session，隐藏 Codex 后为20,944,000 / 3。
- Model/Day/Hour 与总数核对：30天表的精确 tokens 合计34,496,000；24h 的24个桶合计308,000；7天日历区间6,468,000。键盘/触控曲线能读取精确值；C/T/L、时间快捷键、下拉输入屏蔽和 Esc 返回原 `workspace` / `thread` 查询参数均实际操作。
- 暂停刷新响应后切换 Pi，旧响应完成不能覆盖“未定价 / 1 session”；同条件刷新期间保留原数据。修复浏览器暴露的 Tokens Provider 排序，以及浮点相减制造约 `1e-15` Other 费用的问题，并保留真实微小费用。
- Limits 实际执行取消、确认、未知结果；确认后回读失败保留旧 `checkedAt` 和窗口，显示已确认动作及核对警告。未知结果只发送一次兑换请求，不自动重试。5分钟内重挂载不探测；将浏览器时钟推进301秒后重挂载只产生一次自动探测。
- 价格设置真实 PATCH revision 冲突保留模型 ID、输入1、输出3、缓存读取0的草稿；重新读取 revision 后保存为 revision 2。Pi 的1,232,000未缓存输入、1,232,000缓存读取、1,232,000输出重算为 `$4.928`，页面总价更新为 `$272.87`，未定价警告消失。
- 实际 `ComposerUsage` 只读快照；进入后仅 GET `/usage/limits`，非 GET 请求数保持32，没有模型请求或隐藏刷新。Limits 与 Composer 显示同一账号的80%剩余额度和原数据时间。
- 桌面 Cost/Tokens 深浅主题与390px视觉检查；390px document 宽度仍为390，Day 表在358px容器内横向滚动，不撑开页面。参考图未提供 DPR 元数据，按来源布局、字号和224px图高对照，**不宣称逐像素或样本金额完全一致**。
- 空原生历史实际显示 `$0.00 / 0 sessions` 和无记录明细，不冒充未定价；恢复全部来源后总价回到 `$272.87`。该最后一轮筛选切换没有浏览器 `error` / `unhandledrejection`，页面没有横向溢出。
- 截图保存在本机 `.local/usage-evidence-20261030/`：`cost-desktop-light.webp`、`cost-desktop-dark.webp`、`tokens-desktop-dark.webp`、`cost-mobile-light.webp`、`tokens-mobile-dark.webp`、`limits-desktop-dark.webp`、`limits-mobile-refresh.webp`、`tokens-mobile-day.webp`。其中移动 Limits 刻意保留刷新期间旧快照的状态。

### 工程检查与发布边界

- `pnpm check:web`：通过 Web lint、TypeScript 和 Vite 构建。
- `pnpm --filter @agent-workspace/server build`：通过生产/测试 TypeScript 和 Agent bundle；共享 contracts/client-runtime 构建通过。
- 受影响 Usage、runtime、备份和客户端行为测试：**215/215 通过，0失败、0取消、0跳过**；使用独立 HOME、清除原生 Home 覆盖并设置 `TMPDIR=/tmp`。此前 HDD 临时目录导致既有30秒生命周期测试超时；未放宽超时，改用本机临时盘后该路径约5.8秒完成。Claude revision 测试补齐与同组测试一致的外部原生环境隔离。
- 限定 Agent Usage/runtime/backup、共享合同和客户端 Usage 路径的 oxlint 通过；没有运行全目录格式化。
- **全量后端验收未通过，现已按用户要求暂停测试。** `pnpm test:backend` 首次因互斥锁拒绝启动；排队后运行到第52/123文件时被外层3600秒期限中断。`packages/contracts/tests/openapi.test.ts` 有两项 PM OpenAPI 生成合同漂移失败，未运行全量生成器覆盖并行工作。随后使用同一互斥 runner、`TMPDIR=/tmp` 继续未完成文件；用户叫停时续跑已完成30/72文件，正在第31个文件。已取消本会话测试任务并确认当时的测试 supervisor 退出，不再启动检查。
- 续跑中另观察到 `tests/agent-file-areas.integration.test.ts` 的 `Local-project schema migration exceeded 60000ms`，以及 `tests/local-project-backup.integration.test.ts` 的真实 `pg_dump` 失败。日志不能单独证明具体数据库/客户端根因；这些是全项目测试环境或其他模块的待调查项，不以 Usage 专项通过覆盖，也不把被取消的文件记为通过。串行123文件、真实数据库初始化和外层整轮期限共同放大了本次验收等待；后续测试策略需先收敛，不能继续无期限补跑。
- 未调用收费模型、读取宿主凭据或消耗真实 reset credit；未修改 t3code、PM 业务数据、既有服务端口或用户的无关并行文件。没有真实供应商账单/额度或 macOS Keychain 的验收证据，不扩展本次结论。
- 临时浏览器、4396服务、隔离数据和测试 HOME 均已关闭/删除，端口已释放；只保留上述本地截图。README/计划的18个本地链接、实施章节锚点及代码围栏检查通过。
- **会话与持久化尚未经过统一设计，当前暂沿用 Agent Chat 的保存方式。** 本次 Usage launch 元数据和扫描缓存不意味着该设计已收口。
