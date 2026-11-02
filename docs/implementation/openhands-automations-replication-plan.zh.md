# OpenHands Automations 完整复刻计划

计划日期：2026-10-31。用户已授权使用 `gpt-6.1-sol / xhigh` 子代理分别实施；当前状态：**实施中，未完成验收、未发布常驻服务、未创建 PM 业务任务。**

目标：以用户指定的本机 OpenHands 源码及 `http://localhost:8000/automations` 为基线，将自动化页面簇的布局、交互、状态和对应真实能力接入本仓，不止复制首页截图。实施授权不等于授权连接外部账号、启用后台规则、向外部仓库推送或变更现有业务数据。

## 1. 基线与证据边界

- 来源目录：`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/OpenHands`。源码指针为 `b4a3f45a28f6b6c387a8deb3dc7c18b4393c59c1`，前端包 `@openhands/agent-canvas@1.34.0`，依赖 `@openhands/extensions@0.36.0`。固定的是本次本机版本，不假定等同官方最新版本；实施前补充工作树文件摘要，防止只固定提交却漏掉本地修改。
- 来源前端与 extensions 使用 MIT；移植实质代码时保留版权及许可证，并核查选入模板/素材的许可。源码默认 Automation 服务1.26.1、Agent Server1.59.0不是本机实际运行版本证明。
- 已用真实浏览器查看 Dashboard、Filters、网格/列表切换菜单、Add Automation 菜单、规则操作菜单、Templates、现有规则/失败运行详情、创建页 Prompt / Custom Python / Event 分支、Git Sync，以及创建页 390px 窄屏；已截图。
- 模板页当时显示 **6 个 Suggested、17 个 More templates**；是本次观测值，不把数量硬编码为永久产品规则。
- 现有来源规则显示 Preparing environment 阶段的 HTTP 502、Failed、No Conversation。仅查看已有失败，未点击 Run now、Test、保存、启用、导入或同步；没有成功执行证据，不能据此认为来源执行后端已就绪。
- 本仓入口已访问，但当前浏览器未登录 PM，页面显示 `unauthenticated` / 需要先选择工作区。目标功能基线据源码和现有交付记录确认，**未完成本轮已登录运行验收**；未读取凭据文件。
- 未读取 PM 项目任务列表，未核对已有业务任务是否重复；下文全部使用本计划内候选编号，不冒充正式 ID。工作区/项目归属在发布任务时核对。
- 当前仓库存在 Provider/OMP 等并行修改。本轮只新增本计划；未来实施保留无关修改，不接管来源服务。

### 来源索引

| 编号 | 依据 |
| --- | --- |
| S1 | OpenHands `src/routes.ts:38-43`；`src/routes/automations-list.tsx`、`automation-templates.tsx` |
| S2 | OpenHands `src/routes/automation-setup-new.tsx`、`automation-setup-route.tsx`；`src/components/features/automations/setup/` |
| S3 | OpenHands `src/routes/automation-detail.tsx`；`src/components/features/automations/detail/` |
| S4 | OpenHands `src/routes/automation-git-sync.tsx`；`src/components/features/automations/git-sync/` |
| S5 | OpenHands `src/manifests/automation-interface.ts`、`automation-insights.ts`；`src/hooks/query/use-automations.ts`；`src/types/automation.ts` |
| S6 | OpenHands `src/manifests/manifest-sources.ts`；`@openhands/extensions@0.36.0` 的 `automations/interface.json`、`catalog-index.js`、`catalog/*/manifest.json`、`bundle-index.js` |
| T1 | 本仓 `apps/web/src/features/agent/src/pm/automation/`；正式挂载于同级 `chat-surface.tsx` |
| T2 | 本仓 `packages/contracts/src/automation.ts`、`automation-client.ts`；`apps/server/pm/src/automation-routes.ts` |
| T3 | 本仓 `packages/application/src/automation.ts`、`automation-report.ts`、`automation-schedule.ts`；迁移 `0034_automation.sql`；`apps/server/worker/src/main.ts` |
| T4 | 本仓 `apps/server/agent/src/automation/`、`packages/agent-contracts/src/automation.ts`、Agent durable 运行模块 |
| T5 | 本仓 [README 自动化说明](../../README.md#自动化)、[交互矩阵](agent-pm-interaction-matrix.zh.md)、[Markdown ADR](markdown-integration-adr.zh.md) |

## 2. 完整复刻范围

| 页面/能力 | 必须覆盖的内容 | 本仓增量 |
| --- | --- | --- |
| 页面结构 | 保留本仓 Agent 主侧栏，在内容区复刻 Automate 二级导航；Dashboard / Templates；各子页返回、选中态、滚动与窄屏布局 | 当前正式页为规则侧栏＋编辑器，需要重新组织，不替换全站前端 |
| Dashboard | 标题/说明、Git Sync / Add Automation；规则数、需关注、运行数、平均耗时；搜索、状态/触发/标签/适用创建者筛选、排序；Grid/List、Active/Inactive/Saved Drafts、分页 | 复用真实规则和历史；补标签/统计/筛选字段。统计明确时间窗口、已加载或全量口径，缺数据不伪造 |
| 卡片与行 | 名称、说明、触发标签、最近运行/错误、活动概览、成功率/耗时；Run now、View、Export、Edit、启停、Delete 与确认 | 复用当前权限、revision、收据；新增执行类结果不能冒充报告结果 |
| Templates | 搜索、来源标签、Cron/Event 分类、Suggested/More、Beta、依赖连接状态、说明、模板预填 | 固定本次目录清单和模板版本；保留所有模板入口，不以几个 PM 报告预设替代来源目录 |
| 新建/编辑 | 名称、Prompt、Provider/模型、Repositories、插件、超时；Custom Python/脚本包、entrypoint/setup；Save draft、Test、Create；底部辅助 Chat | 新契约、持久草稿、仓库/插件引用、现有 Chat 接入；打开表单不创建会话或启动模型 |
| 触发器 | Once、Hourly、Daily、Weekdays、Weekly、Custom cron、IANA 时区；Event source/key/filter/test payload | 现有仅 manual/daily 报告；需补时间语义、事件来源及可靠接收/去重 |
| 详情/运行 | Prompt、Configuration、Activity、tags、启停/立即运行/菜单；活动日志、分页、运行/会话链接、失败/无会话、调试入口、JSON/CSV 导出；按来源可用状态呈现源码/文件 | 现有仅不可变报告和任务证据；需执行生命周期、真实日志与会话关联 |
| 导入/导出 | 定义文件选择、解析错误、预览/确认、来源格式往返、脚本包边界 | 禁止导入即执行；不导出凭据；不把未知字段静默丢弃 |
| Git Sync | 状态、启停、手动/周期同步、仓库/分支/路径、commit/时间/待同步数、作者、token、加密 key；保存、保存并同步、错误恢复 | 新增真实服务能力；不复用 PM 仓库工作树；同步配置不意味着授权执行导入规则 |
| 全部状态 | 初始加载、空列表、筛选无结果、后端未配置、无权、错误、保存中、冲突、未知结果、缺 Provider/连接器 | 沿用本仓真实能力与恢复机制，不用 mock 或静态计数交付 |

**完整性口径：** UI 对照通过与功能闭环通过分别登记。未配置能力可以真实禁用，但它仍是未完成的功能验收项，不能将禁用按钮当作完整功能复刻。外部模板的逐项实际运行受账号、权限及测试目标约束，不把 Beta 模板标为已验证稳定功能。

### 2.1 必须保留的来源合同与差异

- **不是只移植 TSX。** 文案、端点、筛选和统计配置、23个模板及部分真实脚本 bundle 来自 S6 的 production manifest。需要固定并适配所需数据；不引入 testing fixtures，不复制无关扩展运行时。
- **模板不是同一种表单。** `/automations/new/:automationId` 中的 ID 是模板目录 ID；`setup?automationId=` 才是编辑，`setup?draftId=` 才是恢复草稿。目录包含 direct 向导、assisted 会话及无 setup 的 launch prompt 三条路径；向导覆盖 prerequisites/form/review、字段预检和服务端错误定位。T4/T5 必须分别验收，不能统一成“点卡片就创建规则”。
- **统计口径有界。** 来源列表50条起加载，搜索/部分筛选发生在已加载列表；运行摘要取最近20条，统计存在样本口径。目标默认保留并说明该口径，不擅自承诺全库统计。完整日志导出需遍历所有页，而非只导出屏幕上的20条。
- **Test 与草稿真实持久化。** 来源可在不支持 drafts 时退化为内存表单/validate；本仓不能复制这种降级后仍宣称已保存或已试跑。支持正式试运行时先保存草稿，再运行冻结版本；修改后重存；事件 payload 必须是 JSON object。AI 辅助更新不能覆盖用户已编辑字段。
- **Once 语义需核对。** 来源前端将日期转成无年份的五段 cron，不能由标签推出只执行一次。T2/T6 必须明确带年份的单次语义及持久去重；这是目标合同的明确差异，不悄悄复制潜在年复发行为。
- **编辑与交换格式有限制。** 来源 plugin/上传代码属于创建期配置；仓库是否可改取决于后端能力。`.automation.json` 为 version1/kind/spec，来源导出遗漏多仓库、tags和脚本包，导入又要求 prompt，不能把脚本JSON视为可往返格式。T1/T9 需区分兼容JSON与完整bundle，明确支持范围，避免静默丢数据；不承诺来源本身不存在的跨格式无损转换。
- **日志与外部就绪分离。** 来源 run 元数据与 Bash stdout/stderr 来自不同服务，脚本可只有 sandbox、没有会话。Git check 仅验证远端读取，不证明 push 权限或加密 key 有效；同步POST受理不等于同步完成。T8/T10保留这些状态区别。


## 3. 推荐集成决策

以下是候选设计，不声称已实现或已经用户批准扩展运行权限。

1. **原生页面接入，而非 iframe 或第二个应用。** 在 `apps/web/src/features/agent/src/pm/automation/` 中实现新页面组合，复用本仓 React、组件、主题及中英文偏好。来源局部布局/样式可移植，不能复制其全局 CSS、认证壳、遥测、样例数据或秘密。
2. **保留已有报告规则与不可变历史。** 统一展示入口，执行类型显式区分 `report` 和新增 Agent/脚本自动化；不能把 description 当 prompt、把 completed 报告当模型成功。数据库仍是权威，Git 是可同步定义，不是第二套未经校验的业务事实源。
3. **规则归 PM，实际模型调用走当前 Agent Provider。** PM 应用层拥有主体/项目授权、规则版本、调度与运行关联；Agent 宿主负责现有 Provider 执行。仅借鉴另一套 Agent automation 的持久派发/核对机制，不直接暴露其全局 SQLite schedule API 当 PM 项目授权接口。
4. **异步执行不占用 PM 长事务。** 原报告表仅允许终局结果且不可变；执行占位/事件/终局快照需独立设计。先持久记录派发意图，再执行，再核对；不能在当前 workspace 锁内等待模型或外部服务。
5. **定义稳定子页 URL。** 推荐新增 `/agent/automations` 下 dashboard、templates、setup、detail、git-sync 路由，携带真实 workspace/project 上下文；现有 `view=automations` 链接仅做导航迁移，不保留第二份页面实现。PM 内嵌 Chat 继续复用同一视图及离页保护。具体 URL 在契约阶段冻结。
6. **复用而不削弱安全行为。** 保留 actor/workspace/project 隔离、当前授权复核、revision/CAS、原 requestId 收据核对、草稿恢复、删除保留历史。浏览器关闭不停止后台调度，暂停不等于取消已开始运行。
7. **时间与测试语义显式。** 继承已有预算/冷却和 DST 保护，补齐每种触发器的下一次执行/错过策略。原 PM “只读预检”仍无模型、无运行记录；来源式 Test 是另一种可能收费/有副作用的试运行，必须清楚区分并显式触发。
8. **不恢复旧完整 Agent 执行计划。** 只建设此页面簇所必需的规则、运行关联及适配，不顺带建设主动发现、完整审批产品、新权限体系、自动完成任务或全站 OpenHands UI。

会话与持久化尚未经过统一设计，当前暂沿用 Agent Chat 保存方式。新增自动化草稿、定义、调试会话和运行关联前，需要明确所有权、保留/删除、备份和恢复边界；不能借本次复刻默认宣布统一设计收口。

## 4. 候选任务表

下列编号仅在本草稿内有效。前置列写的是交付依赖；基于冻结契约制作界面可以提前，但真实验收不能跳过服务依赖。

| 候选编号 | 目标/成果 | 范围与非目标 | 验收 | 前置依赖 | 来源 | 待确认项 |
| --- | --- | --- | --- | --- | --- | --- |
| draft:T1 | 固定复刻基线与能力对照 | 源码/manifest/许可证、全部模板清单、页面与状态截图、字段/API 映射；不把来源失败当目标正确行为 | 每个页面/控件映射到目标能力、任务和验收；明确哪些是样式移植、适配或新能力 | 无 | S1–S5、T1–T5、本次浏览器 | 无；执行前复核来源漂移 |
| draft:T2 | 统一契约、数据与运行边界 | 定义/草稿/标签/触发/运行/会话关联、能力、分页/统计、revision/收据、迁移方案；保留旧报告 | schema/client/OpenAPI 对齐；旧规则/历史可读；新执行不占长事务、不借 Agent 全局接口扩权 | T1 | T2–T4 | 会话保存/删除；后台执行范围 |
| draft:T3 | 页面壳与 Dashboard | 二级导航、统计、搜索/筛选/排序、Grid/List、分组、卡片/菜单、URL 状态；不重做全站侧栏 | 与来源同视口对照；真实分页/空态/错误；返回/刷新恢复，原报告可管理 | T2 | S1、S5、T1 | 无 |
| draft:T4 | 模板目录与依赖预检 | 固定 production manifest/catalog/bundles；完整目录、标签/Beta、搜索、连接状态、direct/assisted/launch 三种路径 | 本次模板逐项可达；预填内容/来源版本可追踪；prerequisites/form/review正确；仅浏览不创建或运行 | T2 | S1、S2、S5、S6 | 模板外部账号清单 |
| draft:T5 | 创建、编辑与草稿 | Prompt/脚本/插件、Provider/模型、仓库、超时、表单校验、保存/恢复、辅助 Chat；不新增聊天运行时 | 空白/模板/编辑三入口一致；冲突保留输入；刷新/离页保护；未发送前不创建会话 | T2、T4 | S2、T1、T4 | 脚本执行环境、插件来源 |
| draft:T6 | 时间及事件触发后端 | 六种频率/cron/IANA、事件源/key/filter/payload、预算/冷却、持久领取/去重；不实现通用工作流引擎 | 下一次时间、DST、单次不重复、重启/双 Worker 去重、事件重放拒绝、撤权不新派发 | T2 | S2、T3、T4 | Webhook 公共入口、签名/来源身份 |
| draft:T7 | 真实执行与试运行 | PM scope→Provider/脚本执行、模型快照、仓库目录校验、派发核对、状态/日志/会话关联、超时及所需取消路径 | 手动/定时/事件均可核对真实结果；试运行与只读预检分离；未知结果不重派；运行成功不改任务状态 | T2、T6 | S2、S3、T3、T4 | 后台执行授权、费用；隔离运行前提 |
| draft:T8 | 详情、运行历史与调试 | 配置/活动/tags、历史分页、真实状态/错误/无会话、来源文件、会话跳转、调试与日志导出 | 直达/刷新可还原；删除规则仍可读授权历史；错误可定位；导出与实际记录一致、无秘密 | T2、T7 | S3、T1 | 无 |
| draft:T9 | 定义导入导出 | 兼容JSON与完整bundle分别解析/预览，版本与未知字段处理、脚本包安全、明确导入草稿 | 各格式声明支持的字段往返保持；不支持转换明确拒绝；非法包/越界拒绝；导入不启用；未知保存结果可查询 | T2、T5 | S1、S2、S5、S6 | 格式兼容边界在 T1 冻结 |
| draft:T10 | Git Sync 闭环 | 配置、私有凭据、可选加密、同步状态、手动/周期、冲突/失败；不操作业务代码仓库 | 独立测试仓库同步/重启恢复；同步未知先核对；token/key不回显；无 key 不伪造解密成功 | T2、T9 | S4 | 测试远端、同步管理范围、密钥保管 |
| draft:T11 | 模板外部集成闭环 | 按目录连接 GitHub/Slack/Linear/GitLab/Bitbucket/Atlassian Rovo/Tavily/Notion 等实际依赖，保留现有 MCP 暂停约束 | 每类连接认证、撤销、事件/读取/受控写入实测；每个模板依赖及执行结果逐项登记，不以一个连接代表全通过 | T4、T5、T6、T7 | S2、S5 | 外部测试账号/仓库/频道；外部写入许可 |
| draft:T12 | 集成、迁移与交付验收 | 原页面切换、旧数据、响应式/主题/键盘、后端并发/恢复、真实 Provider 与模板、部署证据；不替他人修复无关改动 | 下节门槛逐项通过；未验证项不记完成；备份/恢复成立后才受控发布本副本 | T3–T11 | 全部 | 已登录测试环境和外部验收前提 |

## 5. 顺序、依赖与并行边界

- `draft:T2 depends_on draft:T1`：先固定字段与能力，不对着未冻结模板设计数据库。
- `draft:T3/T4/T6 depends_on draft:T2`：契约冻结后，Dashboard、模板目录、调度服务可并行。
- `draft:T5 depends_on draft:T4`；`draft:T7 depends_on draft:T6`：模板预填与触发派发分别是前置。
- `draft:T8 depends_on draft:T7`：真实运行/日志合同支撑详情验收。
- `draft:T9 depends_on draft:T5`；`draft:T10 depends_on draft:T9`：先有稳定定义格式，后做 Git 同步。
- `draft:T11 depends_on draft:T4/T5/T6/T7`：外部模板闭环不能只靠目录卡片。
- `draft:T12 depends_on draft:T3–T11`：全部选定能力有真实服务证据才能最终交付。

里程碑候选：

- `draft:M1`：T1–T2，范围/契约/数据与运行边界冻结。
- `draft:M2`：T3–T5，页面与表单交互具备对照条件；不是功能完成。
- `draft:M3`：T6–T9，调度、执行、详情与定义交换闭环。
- `draft:M4`：T10–T12，Git、外部模板和完整交付门槛通过。

并行按成果划分所有权：Dashboard、模板/编辑、PM 契约/调度、Agent 执行、导入/Git、集成验收。`chat-surface.tsx`、根 routes、共享 schema/迁移入口、主题映射由单一集成者负责；不让多组同时改共享壳。候选父级成果为“自动化页面完整复刻”，里程碑不是额外业务功能。没有资源容量依据，不承诺固定工期。

## 6. 验收门槛

### 视觉与交互

- 对照 1440×1000、2560×1440、390×844；核对二级栏/正文宽度、标题与按钮位置、四统计块、卡片/列表密度、字体/圆角/边框、弹层与独立滚动。来源桌面二级导航宽度约260px、正文最大800px（`manifest-subpage-layout.tsx:63-88`）；按容器适配，不按截图整体缩放。
- 深浅主题、中英文、键盘焦点/Escape、菜单及确认、窄屏抽屉、长名称/错误/代码/日志不破坏布局。
- 实际浏览器逐一操作列表、模板、表单、详情、导入导出、Git Sync；截图证明布局，网络/持久状态证明行为，二者不可互相替代。

### 业务与运行

- 保存草稿→刷新恢复→明确试运行→创建/启用→手动/定时/事件触发→真实历史/日志/会话→暂停/删除，逐路径核验。
- 并发编辑冲突不覆盖；丢失保存/派发响应沿原键查询；重启后不重复产生外部效果；暂停与已运行状态分开。
- 权限撤销、跨项目 ID、无效 Provider/仓库、归档项目、失效连接器均在服务端拒绝；统计不泄露不可见规则。
- 原规则及不可变报告仍可读；新异步执行不会修改旧历史；删除保留约定历史，导入/同步不得自动提升权限或启用任务。
- INV-01/03/08/09/10/13/14/15/20；SC-03/05/09/10/12/13/14/20；INF-01/02/05/06，若新增流则加 INF-03。以已采纳 Markdown ADR 覆盖旧提案的部分语义，不恢复“完成必须审核”等旧守卫。

### 工程与发布

- 实施完成后统一运行受影响 lint、类型检查、构建及行为测试；数据库/事务/流修改执行本仓要求的 `pnpm test:backend`，跳过不算通过；同步合同/文档检查。
- 真实 Provider/脚本/事件/同步必须有独立冒烟；mock、受控 CLI 与真实供应商结果分列。源码检查通过不等于真实账号可用。
- 在临时端口与隔离数据验收，运行前核对 PID/工作目录/端口；不停止来源或其他副本服务。迁移前备份，验证旧数据与恢复，再受控发布 v4。

## 7. 待决定与发布交接

完整方案已纳入页面、执行和外部能力，没有静默缩减为“只换皮”。以下决定影响具体实施，不阻止本计划评审：

1. **后台执行范围**：现有 Provider 可用不等于允许定时自主调用工具。确认自动化可读取/修改的 PM 与文件范围、费用/预算和外部动作；沿用既有权限，不另造角色体系。
2. **脚本与插件环境**：Custom Python/上传包需要实际隔离和依赖执行条件，不能直接用 PM 服务进程权限执行。若未具备则保留为明确阻塞项，不能以禁用状态报全部完成。
3. **会话及持久化**：确认自动化与 Chat 会话的归属、历史/草稿保留和删除关联；本轮不默认收口统一设计。
4. **外部前提**：来源 Git Sync 目前未配置仓库，模板中多类 MCP 未连接；目标需独立测试账号、受控仓库/频道和必要 Webhook 入口。不得复制来源凭据或重新启用仓库规定暂停的 MCP。

复用的是上文 T1–T4 所列代码能力，不是已有业务任务 ID。本次没有核对项目任务去重，也不创建任何任务。发布时先核对已有任务与版本，再将被选中的 `draft:T* / draft:M*` 映射到真实 ID；选择部分候选时必须同时列出其必要前置和剩余未交付范围。范围缩减需要明确确认，不能把未选择或被阻塞的功能标成完成。

## 8. 本轮实施分工

统一子代理定义：`.omp/agents/automation-sol.md`，`model: gpt-6.1-sol`、`thinking-level: xhigh`、`prewalk: false`。首批六个子代理已实际派发；用户随后明确选择将八个依赖 OpenHands 专有运行协议的内置模板迁移为本项目原生执行，追加四个独立分工。父代理负责共享前端挂载、集成、隔离环境、检查和最终证据。实施期间不并发运行构建、lint、测试或全目录格式化。

| 子代理 | 所有权与计划覆盖 | 当前状态 |
| --- | --- | --- |
| AutomationCore | PM 定义/草稿/执行契约、SQL迁移0040、CRUD/CAS/收据、执行队列、时间调度、PM/Worker接线；T2/T6/T7 | 已集成；隔离真实运行及 Studio 事务回归通过 |
| AutomationRuntime | 真实原生Provider运行、PM受信服务通道、日志/取消/核对、隔离脚本执行；T7/T8 | 已集成；真实 OCI 通过，供应商账号验收未完成 |
| AutomationDashboard | 正式页面组合、Dashboard/详情、统计/筛选/Grid/List、历史/日志；T3/T8 | 已集成；实际浏览器验证见第11节 |
| AutomationSetup | 固定23模板、manifest/bundles/许可、完整创建/编辑/草稿与辅助Chat；T1/T4/T5 | 已集成；目录/表单/恢复/Chat 预填已验证 |
| AutomationGit | 格式交换/安全脚本包、Git服务/迁移0041、导入与同步界面；T9/T10 | 已集成；真实隔离裸仓库、文件导入验证通过 |
| AutomationEvents | 连接器真实配置/状态、Webhook签名/去重/过滤/事件派发、迁移0042；T6/T11 | 已集成；真实签名事件通过，外部账号验收未完成 |
| NativeTemplateHost | 原生模板持久状态/CAS/声明、真实 Chat 子运行、受限 API/公共 Feed、授权仓库上下文 | 已集成；Agent 回归通过，真实供应商验收未完成 |
| NativeGithubAgent | GitHub Issue→PR、Issue Triage、PR Reviewer 的来源确定性判断与原生 Agent 阶段 | 已集成；确定性回归通过，受控 GitHub 写入未验收 |
| NativeGithubMaintenance | Delivery Watchdog、Stale CI PR Closer 的真实 CI/当前 head/警告/合并关闭守卫 | 已集成；确定性回归通过，受控 GitHub 写入未验收 |
| NativeContentWorkflows | News Digest、AGENTS.md Maintainer、GitLab Issue→MR 原生流程 | 已集成；确定性回归通过，模型/外部账号未验收 |

本轮共享决策：现有报告规则及不可变报告保持原语义；新增 PM 所有的执行定义、执行队列及历史，统一页面明确区分报告与执行。新接口位于原工作区自动化前缀下的 `definitions` / `executions` 等路径。不会直接把 Agent 全局 SQLite schedule 接口当作 PM 项目授权。新定义默认草稿，未配置运行依赖或未显式启用时不自动产生外部效果。

发布/验收状态只在实际证据产生后更新；子代理输出不自动算验收通过。

## 9. 已确认：八个内置脚本模板原生迁移

用户明确选择“迁移为本项目原生执行”，而非部署第二套 OpenHands 后端，也不接受把这八个模板全部禁用后称为完成。源脚本保留为 MIT 来源证据；新定义使用独立 `action.kind: template`、固定模板 ID、原始表单字段名参数和原生 Provider 快照。手工切换到 Custom Python 才使用脚本动作，不能静默忽略用户修改的 Python。

原生流程保留来源确定性的仓库/Issue/PR 筛选、去重、当前 head、CI/独立审核、UTC 日/周声明、无新内容不调用模型等语义；真实模型只负责来源交给模型的判断与操作。OpenHands 全局秘密名只作迁移来源信息，实际认证必须使用当前工作区/创建者所选连接器及其已保存版本，不读取或复制来源凭据。

已确认的安全差异：GitHub Stale CI PR Closer 不把任意评论中的标记文字当作本自动化已发出警告；恢复必须有本地持久操作收据或已返回评论 ID，避免他人伪造标记导致提前关闭。公共 Feed 仅允许有界、无凭据的公共 HTTPS，并拒绝私网与重定向逃逸；动态 XML 外部实体不可执行。

会话与持久化仍沿用当前 Agent Chat 方式。本轮增加运行关联及恢复台账，不代表统一的会话归属、保留期和删除设计已经收口。

## 10. 实际部署前提与兼容边界

迁移 `0040_automation_studio.sql`、`0041_automation_git.sql`、`0042_automation_events.sql` 与对应 PM/Worker/Agent/Web 必须同批部署；先备份本副本数据和加密密钥。服务管理器按各角色读取既有私有配置，不能假定启动它的进程环境会自动透传给 PM/Worker。首次实施未改写角色凭据配置；后续经授权部署时只补齐本副本生成的独立密钥及运行配置，不显示秘密值，也不替用户授权外部账号或规则，见第12节。

| 配置/前提 | 消费角色 | 用途与限制 |
| --- | --- | --- |
| `PM_AUTOMATION_AGENT_URL`、`PM_AUTOMATION_SERVICE_SECRET` | PM / Worker；Agent 使用同一服务密钥 | URL 指向本副本 Agent 干净 origin；密钥至少32字节、独立高熵。签名服务请求保留 actor/workspace/project/definition/execution 身份，不能用健康状态代替授权 |
| `PM_API_URL` | Agent | 指向本副本 PM API，执行及每次宿主工具使用当前授权；正常本机角色管理器注入 `http://127.0.0.1:4194` |
| `PM_AUTOMATION_CONTAINER_RUNTIME`、`PM_AUTOMATION_PYTHON_IMAGE` | Agent | Docker/Podman 绝对路径；已预加载且经审核的不可变 Python 镜像。禁用网络、只读根与业务仓库、资源/输出/时间有界；不拉取镜像、不回退宿主 Python |
| `PM_AUTOMATION_WORKSPACE_IMAGE` | Agent | 已预加载、不可变的仓库检查工具链；Issue→PR、PR Reviewer、GitLab Issue→MR 的命令经隔离容器执行。Triage / AGENTS.md 仍需受限仓库文件工具，但不因此要求命令镜像；News 无仓库工具，两个维护模板无模型 |
| `PM_AUTOMATION_INTEGRATIONS_KEY` | PM | 32字节 base64 私有存储密钥，随加密数据库备份妥善保管；不返回私有 Header/令牌。GitHub/GitLab 原生 API 与 MCP 分别验证，保存/撤销清除旧验证证据 |
| `PM_AUTOMATION_GIT_ROOT`、`PM_AUTOMATION_GIT_ALLOWED_HOSTS` / `PM_AUTOMATION_GIT_LOCAL_REMOTE_ROOT` | PM / Worker | 源码/业务工作树之外的专用绝对目录；远端仅允许显式 HTTPS 主机或隔离本地裸仓库。关闭全局 Git 配置、凭据助手、SSH、代理和重定向继承 |
| `PM_AUTOMATION_GIT_MASTER_KEY` | PM / Worker | 32字节 base64 私有 Git 配置密钥；私有远端令牌及可选文档加密另由本人明确配置。读通不等于写权限或加密密钥已验证 |
| `PM_AUTOMATION_TRIAGE_READINESS_POLICIES` | Agent | 非秘密部署审计策略：按仓库键指定 `mode: authorized-writers` 与 `files` 的40位 Git blob SHA。只有策略与当前文件/写者权限相符才新增 `ready-for-dev`；未知策略不能由模型自行批准 |

GitHub 原生 API 固定为 `https://api.github.com`；GitLab 使用明确配置且与模板参数相符的 HTTPS API origin。目标仓库/项目及写权限必须显式批准。Reviewer 的 reviewer-request 触发要求连接身份匹配 `triggerReviewer`；跨已选仓库的 owner 负载计数另需 `nativeApi.allowOwnerLoadSearch: true` 和当前 `access.manage`，不将全组织数据返回模型。API-only 连接不伪装为已连接 MCP，也不暴露给 Prompt/脚本执行去调用原生发布方法。

当前所选 Provider 的工具组合以运行时 `provider:<instanceId>:promptConnectors` / `:templateWorkspace` 特性为准：

| 驱动 | Prompt 的 PM＋外部连接器 | 五个仓库模板的单独工作区工具 |
| --- | --- | --- |
| Codex、实际通用桥接的 Antigravity/Grok/FX/ACP Registry | 有原生映射，仍须真实安装/账号/模型与授权就绪 | 同左 |
| OpenCode | 当前仅允许单个宿主通道，不能额外叠加 | 支持单个工作区通道，仍须实际就绪 |
| OMP / Pi / Cursor | 当前宿主只接纳旧 PM 工具形状，明确阻塞 | 明确阻塞 |
| Claude / Muse | 当前无人值守审批只接纳旧 PM 工具，通用 MCP 不能冒充已授权 | 明确阻塞 |
| 未识别驱动 | 没有证据的组合不启用 | 没有证据的组合不启用 |

这不是禁用模板目录：可选择兼容 Provider；普通 Prompt、无仓库的 News 和无模型的维护模板不受无关工具前提阻塞。本轮不改动并行进行的供应商适配、不放宽原生审批，也不把受限 MCP/OCI 工具等同于整个 Provider 进程的操作系统沙箱。

格式交换保留明确边界：完整 PM bundle 可无损交换三类动作；来源 `.automation.json` 不可表达的原生配置拒绝有损导出。上传 tar.gz 只接收有界 UTF-8 普通文件（最多200文件、展开2MiB），拒绝路径穿越、链接、设备、二进制及额外扩展；原始八个源码包可作为来源下载，不能默默当作可运行的 OpenHands 服务客户端。

## 11. 本轮证据记录

- 来源完整性已实际核验：53个固定来源文件、9个来源页面/组件工作树摘要、9个派生资源，SHA-256 与字节数全部一致；固定目录为23模板、8脚本包。
- 集成时复现并修复 GitHub `/repos/<owner>/<repo>/labels` 被错误拒绝；同一真实 URL 校验器由 `integration_repository_forbidden` 变为接受。仅开放已批准仓库的 GET/POST 标签集合，不开放标签定义删除/重写。
- 复现 Node24 的单地址 DNS pin 回调与默认 `lookup(all:true)` 不匹配：修复前 `ERR_INVALID_IP_ADDRESS`、零连接；显式固定 family 后自身临时回环 HTTP 返回200、一次连接。实际原生 HTTPS 适配器随后向 GitHub 发出只读、故意无效认证请求，得到401及已净化错误体；**这只证明传输/拒绝路径，不证明真实账号认证或外部写权限**。
- Agent 最终全套：`TMPDIR=/var/tmp node --test --test-concurrency=4 'src/**/*.test.ts'`，806通过、0失败、0跳过；其中包含准备脚本、创建容器、重新鉴权三个异步边界的取消回归。修复前查询把在途创建误判为未知；单独修复查询后仍复现鉴权期间丢失取消，最终三条均通过。取消和当前授权检查未放宽。
- 前端自动化辅助函数：22通过、0失败、0跳过。`pnpm lint`、Web 类型检查、Agent 生产/测试类型检查、后端生产类型检查通过；`pnpm lint:agent` 为0错误、15条正则/遍历提示。后端、Agent 与 Web 使用本轮专属输出目录构建通过，没有覆盖现有服务的发布目录；Web 仍报告大 chunk 及 workflow-canvas 静态/动态混合导入警告。
- 真实隔离环境：独立 PostgreSQL schema/账号/工作区、私有 HOME 与数据目录、PM4394/Agent4395/Web4396；预加载固定 Python3.12.5 镜像，无网络、只读项目挂载。手动执行、单次排程仅一次、原始 body HMAC 验证、无效签名拒绝、过滤不派发、重放拒绝、运行中真实容器取消均通过。容器内没有服务授权环境变量，写业务挂载被拒绝。
- Git 使用源码/业务工作树之外的 `/var/tmp` 私有裸仓库，真实读取检查、提交、推送及远端 SHA 对照通过，dirtyCount 归零；读取检查明确不宣称推送权限已验证。本机默认 TMPDIR 和 `/tmp` 都位于已有 Git 工作树边界内，曾被正确拒绝；未删除或绕过这些边界。
- 浏览器实际操作：1440×1000、2560×1440、390×844，深浅主题、中英文；Dashboard Grid/List、搜索、23模板、三步编辑器、手动/单次/小时/每日/工作日/每周/cron/事件表单、刷新恢复、明确启用/运行、运行记录和真实 stdout、Git 读取检查、连接/事件及旧报告页面。窄屏正文无横向溢出，二级导航独立横向滚动。
- 浏览器往返完整 bundle：从真实保存的脚本定义导出，上传文件、预览、导入，得到另一条 v1 草稿、0运行；没有导入启用状态。辅助 Chat 经明确点击后仅创建会话及侧栏记录，配置进入输入框，没有生成请求；缺 Provider 时不静默选择模型。原生辅助提示不再带来源服务的部署接口或“本部署无法直接创建”旧断言。
- 浏览器复现并修复快速搜索丢字、运行中/未知状态停止刷新、已保存新建草稿错误复用旧定义。最终运行无需手动刷新即可显示 completed；完成保存后重新选择模板得到全新未保存配置，未丢弃未决请求或未保存草稿。
- 最终编译产物实际运行通过：构建后的 PM、Worker、Agent 和 Web preview 同时启动，重复执行手动/单次/HMAC过滤与防重放/真实取消/真实 Git 五组冒烟，浏览器读取真实 Dashboard、状态/触发器筛选和 URL 状态，无页面脚本异常。为避开全量回归的全库迁移锁，使用预加载固定 PostgreSQL 镜像在55445建立独立临时实例，未放宽生产或测试超时。Agent 隔离构建目录链接其实际包依赖，不冒充独立无依赖发行包。
- `pnpm check:docs`：138 Markdown、27计划步骤；`pnpm contracts:check`：OpenAPI3.1、112命令负载、129路径，均通过。全量 `pnpm test:backend` 已结束：132/132文件，904用例中890通过、7失败、7跳过，5文件未通过，不计为全绿。
- 全量回归发现本轮两处缺陷：Worker 拒绝派发分支的时间参数被推断为 text，已显式转换为 timestamptz；来源 QA 模板的 `!pull_request.draft` 在标准 JMESPath 中先否定对象再访问属性，已在本项目目录适配层改为 `!(pull_request.draft)`，固定来源文件不变。最终编译产物的有界 Worker 冒烟确认非草稿通过，草稿、已处理 PR 和其他仓库拒绝。删除了错误要求空值短路后调用未知函数仍报错的断言，改为验证仅访问 payload 而非 Node 全局对象，以及实际求值的未知函数拒绝。
- 修复后完整自动化专项回归：`env TMPDIR=/var/tmp node --env-file=.env scripts/backend-tests.mjs files -- 'tests/automation*.test.ts' 'packages/application/tests/automation*.test.ts' 'packages/contracts/tests/automation*.test.ts'`，11/11文件、66/66用例通过，0失败、0跳过、0取消，包含真实 PostgreSQL 的撤权、预算、连接器/Provider 准入拒绝分支。随后/同期的最终 lint、Web 类型检查、后端编译、Web 构建通过；未重跑整个132文件回归，不将专项通过等同全仓验收。
- 全量回归其余失败/跳过：本轮未修改的 `tests/artifact-files-model.test.ts` 调用旧字符串参数；备份集成缺少 `pg_dump`（实际命令不存在）；S3集成未配置真实隔离存储，7项跳过。未排除这些测试、安装系统客户端或借用其他项目的存储与凭据。
- 根 `pnpm typecheck` 仍失败于本轮未修改文件：`notification-inbox-model.ts` 的 filter-card alias/隐式 any、`project-files/model.ts` 的 NodeNext 扩展名/隐式 any，以及 `tests/artifact-files-model.test.ts` 两处旧字符串参数不匹配 FilterCondition[]。没有修改或排除这些并行 PM 模块/测试，不能宣称 `pnpm check` 全绿。
- 外部验收仍阻塞：未获独立真实 Provider 账号/模型及 GitHub、GitLab、Slack、Linear、Bitbucket、Atlassian Rovo、Tavily、Notion 的测试账号、仓库/频道和受控写入许可；不读取全局凭据、不写真实上游、不重新启用暂停 MCP。确定性测试和401拒绝探针不能代替逐模板真实验收。
- 本轮未迁移生产数据库、未重启3224/4194/4325/4326服务、未提交或推送。上线仍须第10节角色配置、备份/恢复验证与真实账号验收；会话及持久化统一设计仍未收口。
- 两轮浏览器与全部自有临时服务均已关闭。最终构建冒烟正常退出0；4394/4395/4396/55445端口已释放，临时 PostgreSQL/OCI 容器、schema 与 `/var/tmp/pm-automation-smoke-*` 数据已清理。保留现有 v4、来源服务及无关修改。

## 12. 当前入口部署（2026-10-31 UTC）

用户明确要求“部署到当前页面并重启服务”后，已将本轮产物发布到现有 `http://localhost:3224/`，不是临时预览端口；本节替代第11节“尚未部署”的历史状态，不改变外部平台/模型尚未验收的边界。

- **停写与归属**：核对原 API、Worker、Agent、网关 PID、启动身份及工作目录均属于本仓。网关首次 SIGTERM 因长连接超过管理器等待时间；对已核验的上游角色发送 SIGTERM 后正常退出，再由原管理器完成停机，没有强杀或接管其他副本。
- **PM 备份与恢复**：运行 `env TMPDIR=/var/tmp pnpm backup:verify --stopped`，使用本副本 PostgreSQL 容器内的16.14版客户端，不依赖缺失的宿主 `pg_dump`。备份保存在 `.local/backups/2026-10-31T22-49-29.919Z-33c170da-94b2-4ad9-886b-eadcfb685fe5/`；919个共享核心文件、1个项目根、0个 SQL 引用附件对象。独立数据库和新目录恢复验证通过，工作区32个权威文件、0错误；没有覆盖原数据库。
- **Agent 与回退副本**：`.local/backups/automation-deploy-2026-10-31T22-49-45.024Z/` 保存旧后端/Agent/Web构建、部署前后私有角色配置及已核验的 Agent 备份。Agent 备份覆盖138条记录、14个会话、4个 Provider 实例；包含本副本必要私有状态，目录0700、配置0600，不展示内容，也不备份外部/全局 CLI Home。
- **配置与迁移**：给 PM/Worker/Agent 配置同一本副本独立随机服务密钥；PM 配置连接器加密密钥，PM/Worker配置独立Git私有配置密钥。Agent 使用 `/usr/bin/docker` 与已预加载固定 Python 镜像 `sha256:de975f3f5997fef7d279dd25b8aea9e2abed6e7c2e9a5c4d095dab12db393471`，不拉取镜像、不回退宿主执行。`pnpm db:migrate` 实际从0039升级至0042。
- **正式构建与启动**：`pnpm build:v4` 通过，包含后端资源、Agent生产/测试类型检查及Web类型检查/打包。原服务管理器以 built 模式启动：Worker 34464、API 34465、Agent 34466、网关34467（仅本次观测PID，不作为永久配置）。Web由3224网关提供静态构建，无需4326开发服务。
- **当前入口验证**：`/health/ready` 返回200，database/storage/worker/core均true、quarantinedEvents=0；迁移0040–0042存在，自动化专用Worker心跳新鲜，仍为原1工作区/1用户。通过现有CLI正常认证链路读取工作区协议并在浏览器复访当前页面，未显示密码/Cookie；Dashboard、23/23模板、Custom automation前提和配置表单可见，定义/规则/历史/能力/连接接口均返回200。原有会话仍可见；未创建、启用或执行业务规则，未向第三方写入。
- **浏览器边界与清理**：1440×1000桌面和390×844移动端实际显示当前控制台，移动端文档宽度390、无整体横向溢出；当前检查无页面脚本异常。浏览器工具曾在离开创建表单时超时，已记录工具问题并用新检查页复访，不计为该离页动作通过。检查使用的独立登录会话已正常注销，全部自有检查页已关闭，常驻服务保持运行。
- **尚需显式配置**：三类需命令执行的仓库模板（GitHub Issue→PR、PR Reviewer、GitLab Issue→MR）仍缺经审核的 `PM_AUTOMATION_WORKSPACE_IMAGE`；Git Sync仍需源码树之外的专用目录及明确远端许可策略。外部连接器/账号/仓库写入许可未替用户配置；Provider列表可读取不代表真实模型运行已验收。会话与持久化统一设计仍未收口。

## 13. 移除原报告规则页面（2026-11-01 UTC）

用户明确要求删除“原报告规则”页面。本节替代此前关于保留旧报告前端入口的安排；不扩大为后台功能下线或数据清理。

- **删除范围**：移除旧页面、导航、控制台旧报告卡片/指标/筛选与跳转，清理只供该页面使用的编辑器、历史展示、请求恢复状态及样式和对应测试。控制台仅请求执行定义和执行历史；旧 `/agent/automations/reports` 走现有“自动化页面不存在”分支，不保留兼容页面。
- **保留边界**：未修改后台报告 API、数据库、历史数据或 Worker 调度；已有启用规则仍按原逻辑执行。新自动化模板、配置、历史、Git Sync 和连接入口保留；未变更业务完成规则。会话与持久化统一设计仍未收口。
- **发布**：Web 类型检查与隔离目录生产构建通过，先发布哈希静态资源，再原子替换 `apps/web/dist/index.html`，当前 `3224` 网关直接提供新页面；未重启或停止 API、Worker、Agent 和网关。原 Web 回退副本保存在 `.local/backups/remove-report-page-2026-11-01T08-13-20.792Z/web/`。
- **检查**：受影响前端 lint 无错误，保留 `studio-view.ts`、`studio-setup.ts` 两处既有 control-regex 警告；现有前端行为测试16/16通过，0跳过。生产构建保留既有大 chunk 和 workflow-canvas 静态/动态重复导入警告，不宣称全仓检查通过。
- **当前页面验收**：授权浏览器实际访问3224，控制台不再显示旧报告入口，状态/触发筛选与重置正常；23/23模板可见，模板前提与配置步骤可打开；旧报告链接显示页面不存在。定义/执行接口返回200，未观察到旧规则/报告/能力接口请求，未创建、启用或执行业务规则。1440×1000桌面与390×844移动端已截图检查，移动端文档宽度390，无整体横向溢出，无页面脚本异常。独立检查会话已注销，自有浏览器标签已关闭。

## 14. PM 原生24场景（2026-11-01 UTC）

本轮将 `agent-pm-studio/PROACTIVE.md` 的24个场景适配到现有 Automation Studio，不搬入演示状态、不启动来源服务、不恢复旧报告页面。六个 `gpt-6.1-sol` / `xhigh` 子代理分别负责契约目录、PM 应用服务、内部事件、Agent 执行边界、场景分析、现有前端；主代理负责集成与真实运行核验。

### 14.1 场景与结果

目录共47个模板：保留23个 OpenHands 来源模板，新增24个 `pm-*` 模板。下表“语义”需明确选择兼容 Provider；“确定性”不调用模型。所有写入均为待人工审阅候选，不因分析运行完成而自动落地。

| 来源编号 | 模板 ID | 方式 | 结果与边界 |
| --- | --- | --- | --- |
| 01 | `pm-duplicate-tasks` | 语义 | 重复任务证据与关联提案；不合并、删除任务 |
| 02 | `pm-requirement-review` | 语义 | 验收、范围、前置依赖的字段补全提案 |
| 03 | `pm-stalled-tasks` | 确定性 | 默认七天无进展任务的跟进备注 |
| 04 | `pm-ready-dependencies` | 确定性 | 全部前置完成后的允许状态建议 |
| 05 | `pm-execution-status-review` | 确定性 | 同任务版本、完整非空且全部通过的测试证据支持人工送审；不完成任务 |
| 06 | `pm-task-overlap` | 确定性 | 声明路径/依赖交叉的协调调查任务 |
| 07 | `pm-run-summary` | 确定性 | 成功 Run 的来源化总结文档 |
| 08 | `pm-run-failure-investigation` | 确定性 | 失败日志、测试与文件支持的调查任务；不宣称根因已证实 |
| 09 | `pm-session-followups` | 语义 | 明确未解决对话事项的任务候选 |
| 10 | `pm-pr-acceptance-coverage` | 确定性 | 指定仓库/PR 的验收覆盖缺口；未配置外部来源时明确缺口 |
| 11 | `pm-parallel-run-overlap` | 确定性 | 真实时间区间和 diff 路径交叉的协调任务 |
| 12 | `pm-repeated-failure-hypothesis` | 确定性 | 重复失败的共同假设及验证任务；不生成虚假审批单或启动隔离执行 |
| 13 | `pm-decision-record` | 语义 | 带明确决策原话的文档提案 |
| 14 | `pm-scope-drift` | 确定性 | 实际 diff 超出声明路径的范围复核 |
| 15 | `pm-requirement-change-impact` | 确定性 | 持久 before/after 需求变化与真实关联影响 |
| 16 | `pm-session-knowledge` | 语义 | 多 Session 重复技术主题的知识文档 |
| 17 | `pm-cross-task-failures` | 确定性 | 跨任务共同失败测试/技术标签的调查任务 |
| 18 | `pm-next-phase-plan` | 语义 | 指定阶段完成且有未完成下游依赖时的可选发布规划 |
| 19 | `pm-project-digest` | 确定性 | 默认 UTC 当日项目变化摘要；无变化不制造日报，可显式配置观察窗口 |
| 20 | `pm-project-stagnation` | 确定性 | 默认十四天无进展且有真实阻塞的项目风险调查；收窄任务范围不冒充全项目结论 |
| 21 | `pm-milestone-readiness` | 确定性 | 指定里程碑的未完成项、失败测试和待审结果；不宣告交付完成 |
| 22 | `pm-since-last-visit` | 确定性 | 同主体/项目上次真实访问至本次访问的变化；首次访问不伪造区间 |
| 23 | `pm-goal-drift` | 语义 | 明确目标、未完成目标任务与偏离变更共同支持的规划建议 |
| 24 | `pm-next-actions` | 语义 | 目标、已完成依赖和明确遗留事项支持的下一步规划 |

来源适配差异明确保留：场景07的总结、19的日报也需人工应用；场景12的当前项目没有对应执行审批目标，只能发布验证任务提案，不能称为批准或执行。没有新增权限体系、业务完成条件或第二套 Runner。

### 14.2 持久化、授权和执行边界

- `0043_automation_pm.sql` 保存不可变来源快照/原始结果、独立候选修订、人工请求收据、执行步骤与真实 ID 映射、访问水位及事件游标。快照最多4MiB，13类覆盖逐项声明 complete/partial/unavailable；达到读取上限不能冒充完整。
- 内部任务/里程碑变化来自既有核心写入日志、外部文件观测及 outbox；Agent 终态/空闲事件保留原 actor，访问事件由实际项目导航提交。服务签名验证原始 JSON；队列再次鉴权，暂停/草稿不触发，可信自动化来源抑制自触发环。手动 payload 不能伪造历史版本或访问水位。
- 16个确定性模板只读原生来源，不需要 Provider、文件区域映射或工具容器。8个语义模板需要已认证且明确宣告 `provider:<id>:pmAnalysis` 的 Provider。当前实现为 Claude 原有适配器上的无工具通道：禁用工具、MCP、hooks、plugins、外部 settings 来源及批准回调，使用 Agent 私有空工作目录，不回退项目仓库。其他驱动，包括只有工具沙箱的 Codex，明确不可用。
- Agent 只能冻结/发布其原始活动执行的分析结果，不能调用 PM 写工具、编辑或应用候选。模型输出必须匹配冻结的主体、项目、来源版本和直接原文证据；不能升级覆盖、捏造测试、预置已应用状态或生成终态完成命令。
- 场景10只读已选连接版本、仓库和 PR。即使连接本身允许更广权限，也只允许对应元数据/文件的有界 GET，禁止写入、跨 PR/仓库和 MCP 工具。PR 正文的验收表属于作者声明，不是已验证 CI；缺少明确验收映射时保留缺口。
- 人工编辑不改写原始引用和引文；显式重基另存当前来源保护。预览 token 绑定候选修订、当前来源及选择；应用复用现有 PM 写服务、授权与 CAS。规划选择校验依赖闭包，复用既有任务，局部 ID 映射持久化。未知结果只查原请求；仅明确继续原申请才执行其尚未开始的已批准步骤。
- JSONB 会重排对象键。真实运行复现后，来源/请求指纹改用现有 canonical `requestHash`，持久快照读取重新经过契约解析，避免同值来源及结构化引文被误拒；没有放宽来源真实性校验。
- 对外协议位于 `/api/v1/workspaces/:workspaceId/automations/pm`：执行 snapshot/result、候选 edit/preview/apply/ignore、原请求 receipts、visits 和签名 signals。OpenAPI 与客户端使用同一契约；edit/apply/ignore 返回收据，preview 返回预览本体。

### 14.3 已实际观察的证据

- 独立数据库、角色、账号、工作区、HOME、Agent 存储与随机端口运行真实 PM HTTP、Worker、Agent；前端使用隔离目录生产构建。没有导入任何真实 Provider/外部平台凭据，没有连接来源副本。
- 16个确定性处理器均经真实队列派发并完成。场景19读取实际新建任务，产出文档候选；人工编辑、预览、应用写入真实 `DOC-001`，同一申请重放和查询返回相同收据。场景22经实际两次访问触发，冻结上次水位，结果包含两次访问之间创建的 `TASK-003`。
- 其余处理器的本次现场输入主要验证空结果/缺失来源边界，不代表全部正向场景实测：无 PR 连接、无历史 before/after、未选里程碑及收窄项目范围均明确报告缺口。8个语义模板没有真实模型运行凭据；不能把契约、规则或适配器测试当作模型验收。
- 浏览器实际登录独立工作区，来源筛选显示24/47个模板；1440×1000和390×844截图检查，移动端文档宽度390，无整体横向溢出。配置页明确显示无工具 Provider 缺失并阻止运行；详情读取持久快照、覆盖和原始引文。浏览器显式启用、手动运行、编辑文档、预览并确认应用，查询原收据恢复为 `applied`，实际写入 `DOC-002`；刷新后仍为已应用且操作禁用。实际文件 API 读到审阅内容，三个源任务仍为 `todo`，未观察到页面脚本异常。
- 首次 Agent 全量运行在默认临时目录/并发下出现超时及 Provider 用例失败；采用本仓既有 `TMPDIR=/var/tmp node --test --test-concurrency=4 'src/**/*.test.ts'` 隔离方式后，**930项全部通过，0失败、0跳过、0取消**，没有修改超时阈值或删测试。包括 PM 分析/运行时专项124项；前端 PM 行为测试另12项通过。
- 真实 PostgreSQL 专项 `automation-pm.integration`、`automation-pm-signals.integration`、`automation-events.integration`：**21项全部通过，0失败、0跳过、0取消**。覆盖 JSONB 引文恢复、原始来源防伪、来源冲突/重基、原生字段/关系/评论/文档写入、规划部分应用恢复、既有任务复用、事件防重放/撤权/防环、覆盖分页边界，以及更宽权限连接下的 PR 只读限制。初始化仅计资源获取，原生文件准备仍受原用例120秒截止约束；未提高超时阈值或禁用数据库历史约束。
- 后端生产及本轮集成测试类型检查、Agent 生产/测试类型检查、Web 类型检查和隔离生产构建通过；根 lint 与自动化前端 lint 无错误，后者保留两处既有 control-regex 警告。文档检查138个 Markdown、27个计划步骤；OpenAPI 检查112命令、138路径。Web 保留大 chunk 与静态/动态混合导入警告。
- 根类型检查仍失败于本轮未修改的 `notification-inbox-model.ts`、`project-files/model.ts` 和 `artifact-files-model.test.ts`；没有修改、排除这些并行文件或宣称 `pnpm check` 全绿。
- 全量后端回归未完成：137文件中运行至第58个 `account-recovery.integration.test.ts`，该文件发生初始化超时、顺序 fixture 未释放及 after hook 失败，随后被外层3600秒截止中断。此前57个完整摘要为440用例通过、0跳过；缺失摘要和未运行文件不计通过。未改动账户恢复模块；本轮三个数据库专项的21项完整通过单独记载，不能代替全仓验收。
- 收尾已注销并关闭自有浏览器，关闭全部 smoke 服务并确认临时端口释放；专用数据库零连接后删除数据库及其独立角色，删除 smoke 脚本、私有测试数据和隔离构建输出。既有 v4 角色与业务数据未停机或改写。

### 14.4 发布前提

本轮新增场景**尚未发布到当前3224入口**，没有修改生产数据库、重启既有角色或提交/push。发布需要备份与恢复核验、迁移0043、同批更新 PM/Worker/Agent/Web；语义模板另需本人配置兼容 Provider，PR 场景另需明确的受控账号/仓库许可。沿用第10节独立服务密钥和现有角色配置，不复制全局 CLI Home 或来源凭据。会话及持久化统一设计仍未收口；本轮的分析/候选台账不代表已解决会话保留期、归属和删除设计。
