# Project Management Agent：保留原前端的完整接入执行清单

日期：2026-10-25。实施目录 `../project-management-agent`；目录名不代表产品改名，界面继续保留 Project Management 品牌。**用户已确认计划并授权开始实施，要求逐项实现 Studio README 场景并验证真实运行。** 本计划取代上次以 Studio 为主入口的产品组合方式，不替代来源项目业务规则；新增场景矩阵及实施合同为本计划强制组成部分。

**本轮已结束：遵照用户“这一轮运行完后结束所有任务”的指令。** 所有子代理已退出，剩余未启动分支停止；不再启动模型/Run/pair/通知批次/fixture/补验或修复轮次。已发请求按原键结算，运行库非终态Run查询为空；主API/Worker/Host/Vite保留。下方“待验证/仍待”均为停止时未完成，不是继续执行承诺。最后bg237完整backend已结束：902项、900通过、2失败、0取消、0跳过，不将本轮描述为全部通过。

### 规划阶段历史与本轮起点

- 用户补充“只构建计划”前，已创建新目录、复制当前源码、初始化独立 Git，并原样复制指定 `.env.local`；文件权限为 0600，字节比较一致，未打印秘密。
- 规划阶段保存464个原前端源码文件的SHA-256基线至 `.local/evidence/frontend-source-baseline.json`，当时尚无浏览器视觉基线；本轮后来取得的home/project/task基线与当前页面截图分别见A01/D02，不能把局部截图倒推为所有页面的实施前基线。
- 上一轮仅计划，尚未修改业务源码、安装依赖、迁入执行模块或启动新服务；这些是当时的历史状态，不是当前结论。本轮已实现原生Agent/Host/自动化入口，并产生真实DeepSeek、Markdown/SQL、Host、Worker与浏览器证据。完整场景仍按下方30项及 `SCENARIO-MATRIX.zh.md` 逐条登记，未全部通过。
- 上一轮遵循“仅计划”停止；本轮按新授权复用源码副本、前端基线及私密模型配置，不重新覆盖来源。所有source sibling只读，不commit/push。
- 本轮发生过Eval旧环境误继承PG55433并误建隔离主体/工作区，已按精确ID回滚；正确数据库为55440，测试库55441。详见 `.local/evidence/acceptance-environment-isolation.json`；此记录只证明所列清理边界，不扩大为整库未变审计。

## 1. 硬约束与取舍

1. 从当前 project-management 工作树复制源码（包括未提交源码），不是从旧 agent-pm-platform 复制整站。原 PM 唯一 Web 外壳、品牌、主题、导航顺序、项目/任务/文档视图、草稿恢复和 URL 保留；不新增 Studio 根应用，不嵌套 iframe，不覆盖全局 CSS。
2. 旧 agent-pm-platform 仅作为已实现后端/Host/独立组件参考；可迁入真实服务实现，必须重新测试。agent-workspace 为模型配置和交互参考，不直接代理其单用户服务，不能继承其本机权限。
3. 不复制 .git、node_modules、dist、.local、.env、.env.worker、日志、缓存、截图和运行数据。仅按用户授权原样复制 agent-workspace/.env.local，0600，Git/Docker 排除，绝不打印值。新数据库、存储、API/Web/Host 独立。
4. 九类核心实体继续由 Markdown 权威保存；SQL 保存模型消息/提案/Session/Run/Approval/收据/自动化。不会建立第二份可写任务树。
5. DeepSeek 首先验证。模型输出是不可信候选，不是完成事实；Run 成功不改任务状态，显式确认才可应用建议，未知写入先核对。
6. 本次不顺带迁入 Desktop/Marketing/移动 App、任意 shell、CLI Provider、Git 写入或公网部署。已存在响应式保持；缺真实来源的外部连接器明确禁用。

## 2. 页面接入矩阵

| 原页面/新增 URL（相对 /pm/:workspaceId） | 保留项 | 增量入口/组件 | 真实数据与动作 |
| --- | --- | --- | --- |
| home / dashboard | 原布局、统计、偏好、全部变体 | 不强塞 AI 卡片、不更改默认首页 | 原服务不变 |
| projects、projects/:projectId | 原卡片/列表与项目视图导航、文件、动态 | 项目上下文 Agent 入口 | 固定授权项目；不替换项目概览 |
| issues、projects/:projectId/issues | 原工具栏、搜索、筛选、布局、创建 | Agent 辅助入口，可携带当前项目 | 建议预览后显式创建，原生幂等与恢复 |
| entities/:id、projects/:projectId/entities/:id | 原标题、属性、Markdown、证据、评论 | 按需 Agent 侧栏、相关运行链接 | 固定实体 ID/revision；陈旧建议拒绝覆盖 |
| documents / 文档详情 | CodeMirror、预览、保存、附件与双链 | 同一 Agent 侧栏支持解释/改写建议 | 展示差异，不自动保存正文 |
| agent | 同一 PM 外壳 | 对话工作台、项目选择、消息、上下文、提案预览 | 持久对话、流输出、取消、授权上下文 |
| runs | 同一 PM 外壳 | Session/Run 列表、详情、日志、动作审批、取消/核对、成果 | 受信 Host 收据；任务状态分开展示 |
| proposals | 同一 PM 外壳 | 待审列表、before/after、应用/拒绝/撤销与恢复 | 当前权限与来源 revision 校验 |
| pulse | 同一 PM 外壳 | 发现列表、来源、人工处置/提案 | 持久 Finding；没有来源的规则禁用 |
| automations | 同一 PM 外壳 | 规则 CRUD、测试、启停、运行历史 | Worker 后台调度、时区、预算、去重 |
| settings/agent | 原设置中心结构 | 服务端模型/Host 能力与配置说明 | 不把 API key 放前端，不将配置当就绪 |

新增导航采用一个可展开的“Agent”分组，子项为对话、运行记录、待审建议、主动发现、自动化；放在原工作区入口之后、项目树之前，不重排已有个人入口和项目树。模型与执行设置归原设置中心，不在侧栏再增加一个顶级设置入口。默认不弹侧栏、不改变首页偏好。跨工作区切换释放请求/缓存；未保存草稿与未知请求保留现有离开保护。新组件使用现有按钮、表单、对话框、主题 token；CSS 模块或局部命名空间，不能污染原页面。

### 2.1 原页面可修改点与禁止项

| 接入位置 | 允许的最小改动 | 禁止改动 |
| --- | --- | --- |
| `apps/web/src/routes.tsx` | 增加同一 PM 宿主下的 Agent 路由、详情深链及懒加载 | 用 Studio 路由替换根路由、修改旧深链语义 |
| `apps/web/src/features/pm/pm-shell.tsx` | 增加上述折叠分组及按需面板挂载点 | 重写侧栏、品牌、顶栏、工作区切换器和外观菜单 |
| `service/service-project-layout.tsx`、`service/service-project-detail.tsx` | 在既有操作区添加次级“Agent 助手”入口 | 将原概览换成聊天、删除任何项目视图 |
| `features/pm/markdown` 的任务集合与共享详情 | 经实施前定位，只在共享操作区接入按钮和面板 | 每种布局复制一套 Agent 状态、覆盖 Markdown 编辑器 |
| `service/settings` | 新增一个遵循原设置布局的 Agent 设置页面 | 新造另一套设置中心、前端保存模型密钥 |
| 原 `views/pm`、全局主题和样式文件 | 默认不修改，新增能力从适配层组合 | 为迁入 Studio 全局 CSS 而调整原页面结构 |

“Agent 助手”为次级操作，原“新建任务”“保存”等主按钮地位不变。任务集合未选项目时，必须先选授权项目才能生成可落地提案；不得默认绑定第一个项目。任务或文档详情固定其实际项目，不允许通过面板选择器悄悄改归属。

### 2.2 新增组件清单

以下是本轮接入职责清单；实际公开导出及逐项已运行/未运行分支见 `SCENARIO-MATRIX.zh.md`“证据与入口索引”，不是仅凭组件存在即验收完成。

| 组件 | 职责与必要状态 | 复用规则 |
| --- | --- | --- |
| AgentContextBar | 展示工作区、项目、实体、已保存 revision；选择明确纳入的上下文 | 项目/实体名称来自授权查询，不从 URL 文本猜测 |
| AgentPanel | 原页面侧栏，聊天、建议、相关运行三类内容；默认关闭 | 全页和侧栏复用同一会话状态，展开全页不新建对话 |
| AgentConversation | 消息历史、流式正文、输入草稿、停止生成、失败及未知请求 | 关闭面板只关闭展示；只有显式停止才发取消 |
| ProposalPreview | before/after、来源 revision、拟变更字段及风险；应用/拒绝/撤销 | 同一组件用于聊天卡片、侧栏和待审页 |
| RunStatus / RunTimeline | 运行阶段、时间、步骤、日志与错误；未知时间显示未知 | 不能将模型文字当真实工具日志或执行收据 |
| OperationApproval | 具体动作、资源、参数摘要、有效期与批准/拒绝 | 与成果 Review 分开，不采用永久“全部允许” |
| RunArtifacts | 真实成果、版本、摘要、下载及进入原交付流程 | 复用已有 Artifact/Evidence，不另建文件存储 |
| FindingDetail | 发现来源、观测时间、依据、指纹、处置及关联提案 | “再次检查”产生当前观测，不篡改旧历史 |
| AutomationEditor / History | 触发条件、时区、范围、预算、动作、测试与运行详情 | 浏览器不是调度器，刷新不重复派发 |
| AgentCapabilityStatus | 模型已配置/最近验证、Host 连通/支持能力及禁用原因 | 配置、可达、执行就绪三个状态分开展示 |

### 2.3 页面内部布局与交互

- 对话页：窄会话列表＋主消息区＋按需上下文/提案检查区；使用原 PM 顶栏，不再出现第二个工作区侧栏。
- 运行页：状态/项目筛选＋运行列表；详情显示摘要、步骤/日志、操作审批、成果。保留独立 URL，刷新后复读同一 Run。
- 待审页：按项目/状态筛选的提案列表＋差异详情；确认前显示作用对象，冲突时保留提案，不能自动基于最新版本重做并应用。
- 主动发现页：只显示当前授权来源；无可信来源时展示禁用原因，不放演示发现凑内容。
- 自动化页：规则列表、编辑表单、只读测试结果和历史详情；启用前校验实际配置，不因保存规则自动运行。
- 设置页：展示服务端模型/Host 的实际能力、最近探测结果和管理员配置说明。本计划不承诺 Provider 账号管理、CLI 登录或自动切换模型。
- 侧栏开启时原页面和未保存输入不卸载；窄屏复用现有抽屉行为。全页跳转保留来源返回地址；任务/文档未保存内容默认不发送，只有用户明确选择才作为“未保存草稿”附加上下文。

## 3. 工作包与所有权

| 包 | 所有权 | 输出/依赖 |
| --- | --- | --- |
| P00 主执行者 | 复制、根配置、依赖、私密环境、部署、本文、总集成与验收 | 独立运行、基线比较、最终证据 |
| P01 BackendIntegration | apps/api、apps/worker、packages 中新增/受影响的业务模块及相关 backend tests；不含主执行者所有的共享注册入口 | 从旧实现迁入模型/提案/执行/自动化、必要客户端与协议、占位守卫；保留当前 PM API |
| P02 HostRuntime | apps/agent-host、Host 专项测试与运行文档 | 从旧 Host 迁入真实沙箱/审批/租约/收据，安全默认、编译入口需求 |
| P03 AgentUI | apps/web/src/features/pm/agent 下对话/提案/运行/设置/侧栏及局部样式 | 消费同源现有 SDK，导出共享页面组件，不改 PM 主外壳 |
| P04 AutomationUI | apps/web/src/features/pm/automation 下发现/自动化/历史及局部样式 | 消费真实 automation SDK；不另建调度器 |
| P05 NativeIntegration | 原 PM routes/shell/任务与文档接入点、agent/context.tsx | 增量注册、原上下文适配、入口与恢复；禁止搬迁或替换原页面 |

全部实施 subagents 指定 `gpt-6.1-sol / xhigh`。派发时核对实际模型/推理配置，工具不支持时报告，不静默换模型。最新文件所有权与接口以根 `IMPLEMENTATION-CONTRACT.md` 为准；子代理不得覆盖其他包文件。并行编辑期间不运行 build/lint/test/formatter，集成后统一运行。各包报告路径、接口、未验证项，不以源码存在冒称通过。

共享 UI 契约在实施前冻结：工作区 ID 必须提供；项目、任务/文档 ID、来源 revision、返回地址和当前授权能力按上下文传入；刷新和关闭由宿主提供。使用同源 cookie，在现有 `usePmService` 授权上下文内组合，不建立第二个认证 Provider。AgentUI 提供对话、运行、提案、设置与侧栏组件，AutomationUI 提供发现和自动化组件，NativeIntegration 负责原页面适配。旧项目 SDK 只作为契约参考；按实际依赖迁入必要实现，不强制搬迁原 PM 客户端或重构全部包结构。

### 3.1 依赖与实施批次

1. **批次 0：界面设计冻结。** 记录原前端464文件摘要及原home/project/task基线截图；按批准接入点增量修改。现有证据覆盖部分实际页面，不倒推“所有UI集成前的逐页视觉门槛已经全部满足”；完整变体与浮层对照仍在D02开放。
2. **批次 1：隔离与模型先验。** 主执行者核对副本、秘密忽略规则、独立配置/资源，完成 DeepSeek 非流式、JSON、流式与取消试验。失败则记录供应商事实，不用假数据代替。
3. **批次 2：合同与独立实现。** P01 先固定公共 DTO、权限、请求键、恢复和 Host 信封；合同明确后 P01/P02/P03/P04/P05 并行，各包只改自有路径。前端可以制作明确开发样例，但正式路由绝不回退 fixture。
4. **批次 3：按闭环集成。** 先聊天/提案和原页面侧栏，再执行/审批/成果，再发现/自动化。每个闭环通过本次真实服务与浏览器验证后，再开放相应入口。
5. **批次 4：全量回归与交付。** 核对原页面视觉、原人工 PM 闭环、失败/恢复/授权矩阵；最后才标记清单通过。任何一项未通过保留明确状态，不宣称整体验收完成。

P01 的内部实施顺序为模型/提案→执行持久化与守卫→自动化；不要求 UI 等全部后端完成才开始，但必须等其消费的合同冻结。主执行者统一处理 API/Worker 注册、生成合同、依赖锁和部署配置，避免多个子代理同时改共享入口。

## 4. 顺序执行清单（30项独立状态）

更新日期：2026-10-25。`[x]`仅表示该行所述边界已有本轮证据；未勾选不等于没有实现。**进行中/已实现待验证/失败/外部前提阻塞逐项写明，不用统一PASS覆盖。** 证据代号沿用 `SCENARIO-MATRIX.zh.md`：N原生UI、L规划、T自动化、R父级真实执行、M模型、F原前端、E环境隔离、H0首次运行失败、U旧Provider诊断。所有路径与JSON字段见矩阵，不沿用来源项目历史检查数。

### A 基线与隔离
- [ ] **A01 已记录基线，完整逐页视觉待验证**：464文件SHA见F；原home/project/task截图见 `.local/evidence/baseline-home-1440.png`、`native-ui-baseline-project-1440.png`、`native-ui-baseline-task-1440.png`。本轮保留上一轮外壳替换失败模式；不是所有原页面都有集成前视觉基线。
- [ ] **A02 已隔离运行，复制范围/来源全量不变未独立复验**：只在本仓库实施，原项目/Studio/旧平台只读；E记录正确workspace/owner与误继承55433精确回滚。独立Git/复制为本轮起点历史；不凭该记录宣称来源全部业务数据逐表未变，未stage/commit/push。
- [ ] **A03 已实现安全加载，最终秘密门禁待验证**：`scripts/load-model-env.mjs`按模型字段加载，M真实调用；既有`.env.local`权限/一致性仅引用规划阶段已记录事实，本文责任人未读取凭据。Git/Docker排除、前端产物秘密扫描的最终执行证据待父级；不打印任何值。
- [x] **A04 支持的单owner维护/新build恢复已证，旧违规试验保留**：主Web3290/API4191、PG55440运行/55441测试。R.disabledExecution先记录4192共享liveRoot试验POST503/PERSISTENT_STATE_INVALID/撤回readonly且停止；后严格停原3→唯一4191禁执行→停该API→正常新build恢复。当前API50390/Worker50389/Host50392、startTicks1222947086/cwd/entry核实，认证cap200/enabled/runnerReady=true；原3与旧0041/stop超窗历史不回填。NoModel副实例须独立DB/nativeRoot/物理mountedroots；已结束的bg237使用独立55441测试DB，未共享运行库。
- [x] **A05 真实通过（模型先验范围）**：M记录实际DeepSeek `deepseek-flash` 非流式结构化JSON、usage、流式5块、streamAbort与preDispatchAbort；两次模型请求totalTokens65/16。没有配置即冒充成功或自动换模型；业务模型失败另见H0/R，不能以先验smoke消除它们。

### B 后端和运行
- [x] **B01 真实通过（核心模型/提案路径）**：`packages/application/src/studio-agent*.ts`接当前授权/真实上下文与revision；H0真实候选→TASK-002，N选区/验收标准提案，L真实图与来源CAS、T/R原键恢复，均写原Markdown/SQL而非localStorage第二任务树。
- [ ] **B02 已实现待完整故障验证**：`studio-execution*.ts`及Host协议实际持久Session/Run/精确Approval/receipt；Run-0、Run-A/B及R.sourceRecovery已真实核对。单Session活跃唯一、旧epoch拒绝及unknown占位的完整统一回归证据仍待D06/D09，不以有成功Run替代竞态验证。
- [ ] **B03 生命周期/删除源历史/禁执行已证，原软归档UI细链未独立全验**：N TASK-127归档只读/禁新执行/同ID恢复；EJ活跃与unknown归档/关闭409、原文不变，自有TASK-1349终态archive/restore/close/archive/delete、源404及原Run98c80766…输入/失败/4artifact与最终原生历史页均真证。R.disabledExecution.singleOwner唯一4191禁执行的非空UI禁用、原B6可读/0637…durable rejected/0新Run/全JSON同已证。原31“取消一次归档确认→软归档→归档列表返回”未单独全链取证，不能把它误解为实际Run取消，也不以额外硬删除覆盖该UI缺项；用户停止后不补。
- [ ] **B04 真工具/完整来源/可信分项计算已证，取消隔离待齐**：本地工具smoke仅限定范围；0041后B5真实write/test及完整未改test-source，报告560…在当次77a版本两标准passed并明确人工ready，旧SQL23514缺口实证关闭。后标准变化使旧560…historical/current=false；正常f370…原测试仍两passed，新当前bade…第三外部标准unknown，不把历史绿搬到新输入。真实双Node隔离已证，取消收据及全部多租户边界仍未齐。
- [ ] **B05 成果/ready/原PM退回UI已证，正向人工Done未完成**：B4成果/Run review摘要、B5在当时todo/77a明确ready随后stale均真；真实3标准采纳及明确human PUT才改in_progress/43716…；f370…两pass后当前bade…pass/pass/unknown，原Submission d3411ffa…/Review e93f3aac…changes_requested/ReturnForChanges200与最终原生history已读。原README109/119/182的正向送审/批准Done/Done列定位审计未执行，不能用ready或负向退回替代；同Task后续计划按用户停止取消，最终仍3条/in_progress，无Done。
- [ ] **B06 P05/P07/P12/P19/P22真实链已证，现实7/14天仍阻塞**：P05当次current源→fresh Finding→来源按钮/明确ready后旧源失效409；P12独立新Session/Run精确审批后实测失败/原TASK-090不变；P19空源0/跨日源1、P22双visit不重放均真证。P07已在始终Level1/r5/同Finding afe6f097…真实UI审阅确认保存DOC-006，三原key committed，原TASK-092不变，旧409保留；不再误写只部署未复验。P03/P20/A13现实年龄与runtime-PG成熟阳性未具备，unit阈值PASS不代长期观察，本轮停止不回写日期。
- [ ] **B07 当前合同/类型构建通过，完整backend有2项失败**：R.level1Regression/bg236 backend lint/type/build/contracts（109 commands/140 paths）及37真实PG-HTTP/domain tests PASS；最终前端bg240 lint/42tests/tsc/build PASS覆盖末版approval/cancel修改。bg237最终902项、900通过、2失败、0取消/跳过，退出码1；Host OpenAPI产物数断言49≠20、评论集成测试普通字段跨项目移动收到409 explicit_task_move_required而预期200。详情见R.finalBackendRegression；遵用户指令停止，不修复或重跑下一轮。

### C 原生页面接入
- [ ] **C01 原生接入/02:52文件级保留已证，冻结时全视觉未齐**：F的frontend-preservation-current.json在02:52对原464文件确认442逐字同/22受控接入改/0缺/原views未改，旧445/19留史；这是该时点快照，不自动覆盖后来Graph/React/approval逻辑修复或所有视图。后续源码静态/Web收尾bg240通过另列，全部页/浮层/主题/键盘视觉仍按冻结未完成记录。
- [ ] **C02 S02同源创建/S09消息转任务/S24六冻结源导航已证**：S02 PRJ-011唯一真实模型1ef5e777…/单草稿4741431c…→human edit后formal0→明确publish0ca836d5…→TASK-1350原kanban高亮/同cv，未拼S13；S09实际TASK-506来源往返闭合。S24原af8摘要六个冻结core/Run源哈希全匹配，真实DOC-004编辑器/原Run导航已证；旧四源/早期导航未就绪保留。不扩大成全部文档CAS/所有入口视觉，后者本轮未完成。
- [ ] **C03 任务/文档真实主链已证，全部入口矩阵待齐**：N-task原生侧栏close/reopen/refresh保持未存标题/正文3464字符与Agent未发草稿，原位置往返保持；R.document真实DOC-004手动preview不写→save→关联TASK-090的DeepSeek建议→UIreject不写→第二建议显式apply→安全undo精确原raw。S01/S10/S23已各补证；项目入口/所有页面与键盘分支仍待完整矩阵，不把主链扩大全入口通过。
- [ ] **C04 原生显式执行/并行/核验及历史已证，取消/正向Done未完成**：S07原TASK-505明确请求B7→两原UI动作授权→真实两pass；S05只读快捷核验/S08待批＋历史/S15原Session返回、H完整分页及删除源原生历史已真证。A6/B7同snapshot真实双Node终态两pass，cancel POST=0；末版settling修复只有bg24042/0与原B7 GET200只读smoke，不代真实取消。当前3标准bade…第三unknown；正向人工Done未做且用户停止后不再启动。
- [ ] **C05 安全undo已证，文档后改CAS模型失败/审计UI全链未齐**：字段CAS/staleguard、DOC-004/005安全undo及P24源恢复真证，原UTF-16/UTF-8包装差异照实保留。Native文档CAS原请求7f9e2153…已failed/model_request_failed、无proposal/无文档写，第二模型未派发；apply→人工改正文→旧undo被拒未到达，不能称保护通过或产品CAS失败。用户停止后不补轮次。
- [ ] **C06 原生审阅/后续及Level1同案保存已证，全部情境仍未齐**：A07三类输出、P05/P12后续、P19/P22及P24均各有真实证据；P07修复后同Finding afe6f097…始终Level1/r5，明确未预选checkbox确认保存DOC-006/三key committed/原Task不变，旧409与跨rule私有audit1624均留。Level2自动pending规则未放宽。仍有真实长期年龄及A08失败运行入箱等未闭合，不用功能通过替代所有情境完成。
- [x] **C07 真实通过（实际能力页边界）**：N.checks `J08-actual-capabilities`及真实settings截图，DeepSeek配置与当前canPropose/canApply、Host授权/readiness分开；真实reader禁写；不提供虚假的DEMO凭据管理或前端provider key。
- [ ] **C08 细分筛选/原UI批量/Graph与六种选区操作已证，其余视觉键盘未完成**：S17 query52/首40、24词法布尔日期错误、UTC425/775/1200、三组20首15、显示名0→1及原UI逐项Coding均真证；S02同源单草稿、S14全审批量确认、S05快捷核验、J01原图节点/zoom及S03标题/正文各改写/缩短/扩写六分支均已闭合，旧失败保留。完整双视口/全部浮层、Popover Esc归焦、NoModel及S16持久消息精确一份往返未完成，用户停止后不补。

### D 验收门槛（全部取本次证据）
- [x] **D01 真实通过（02:52文件级保留对照）**：F新`frontend-preservation-current.json`原464文件442逐字同、22受控接入修改、0缺失，原views全部未改；22条before/after SHA可定位，旧445/19记录不覆盖。此项只证明该次文件保留与受控差异，不是全部视觉/业务验收或以后改动自动通过。
- [ ] **D02 原生移动完整导航实测通过，全部视觉仍待齐**：R.moveBranches.nativeUiPassed=true：原UI bfc62860…7→4自动目标详情/reload保持；b87690b7…真实pending时主动离页到issues，原响应不抢路由/journal清空，TASK-534最终PRJ-007/rev1495…/历史保留，截图native-task-move-destination.webp。旧两导航失败不删；原全部页/浮层/工具双视口仍未全齐，不因S34闭合整体改绿。
- [ ] **D03 原键与受控维护恢复部分已证**：H原键settled、R/EJ原效果不重派及T原scan恢复保留；新R.disabledExecution.singleOwner在唯一4191禁执行/恢复正常3服务前后读取原Session/Run fullJSON严格相同、无新Run，正常新build认证ready。4192共享root试验失败不称只读/正常恢复通过；全新库迁移、备份恢复及所有历史/原生UI联合门槛仍待最终套件/场景结果，不扩成整库未变。
- [x] **D04 真实通过（已执行的原生写入链）**：N真实DeepSeek选区→before/after→显式apply仅选区→undo精确raw，验收标准写Markdown checklist且todo不变；L模型候选人工分批发布及CAS409拒绝旧来源。此行不扩大为S03全部标题/正文分支或S23文档闭环。
- [ ] **D05 负向人审/分项来源已证，原完整成功旅程未通过**：同TASK-505真实3标准采纳→旧560…stale/ready禁用→明确human start→正常f370…两pass、新bade…passed/passed/unknown/current43716…；原Submission/Review逐条pass/pass/inconclusive、changes_requested/ReturnForChanges200及最终原生history真证。原README109/119/182的三标准全有真实依据/合格当前报告→明确送审→人工批准Done→Done列定位审计未做，不能以B5两测试/ready缩减；J03/J04此前局部成功不标整链PASS。用户停止时未保存删除合成条款的编辑，服务器仍3条/in_progress，无Done或新正向轮次。
- [ ] **D06 原键恢复/同snapshot双Node已证，仍没有取消POST**：旧两409、A3/A5仅write后lease失败、A4/B5双成功及observer comm误认都保留。新A6 1ed72383…/B7 0e0ca746…于04:36:43.546Z在owned Host50392两独立workspace确见真实Node/exe，两原test keys committed，最终各两pass/exit0/succeeded/e1；driver等UI running十秒超时、没发cancel。并行不再仅凭Run记录推断，但仍缺实际停止/Host确认及同段另一Run继续，不拼双成功成取消。
- [ ] **D07 撤权/恢复拒绝/双浏览器CAS/历史已证，完整权限待齐**：S34撤源权限403/只读目标拒绝restore/历史ACL/SHA/关系creation/comment/自动导航与离页保护各有真实分支；S27 reader grant11→revoke12→restore13不隐批→明确reject/0receipt/源不变后恢复基线14已证。新R.twoBrowserConflict：TASK-1348 A冻结preview，B独立原生标题PUT200后A明确apply409/source_version_conflict，最终严格等B保存、proposal pending/v1/todo，S28独立通过；不外推全部Workspace ACL/缓存/恢复/秘密门禁。
- [ ] **D08 调度/水位/Level1实存已证，现实长期未满足**：P07同Level1/Finding已真实保存DOC-006，P19空源/跨日事实、P22双visit/P24恢复源、P10当前源复验均真证；A14实际06:09通知与09:00合法daily1 skip分开，不能称09点新模型摘要。父级受控7/14天unit/09:00UTC PASS不代P03/P20/A13真实成熟来源或runtime-PG阳性。本轮按用户指令冻结，不倒填业务日期。
- [ ] **D09 最终Web收尾通过，完整backend未通过**：bg236 backend四门/109commands140paths与37PG-HTTP tests PASS；末版execution/index.tsx settling/Cancel改动由bg240补lint/42tests0fail0skip/tsc/Vitebuild PASS（artifact1470），原B7权威GET200/v7/pageErrors=[]/Studio写=[]只读smoke也真证，均非运行中取消。bg237完整902项中900通过、2失败、0取消/跳过，原始输出artifact1367及R.finalBackendRegression保留；旧失败、主动停止与S3 507等历史不抹。文档检查通过77份Markdown及domain references，不替代后端回归。
- [x] **D10 本轮审计收尾完成，全项目验收未全部通过**：S01–36/P01–24/A01–14/J01–08及30项计划分别保留入口、实际ID/JSON/截图、失败/unknown/外部前提和最终检查结果。所有子代理与自有观察context已结束，运行库无非终态Run；NoModel未启动，临时baseline3291与4192试验已停，主API/Worker/Host/Vite保留。未commit/push；遵用户指令不再启动任何新的实现、修复、模型、Run或补验轮次。

## 5. 验证与风险登记

源码检查不能代替浏览器；旧项目历史证据不能代替新副本运行。旧后端存在并行修改，实施时固定选中文件内容并记录差异，不能不断追随外部变化。本轮执行必要 DeepSeek 真实测试，无自动重发未知请求。公开部署/多租户沙箱/外部 CLI、Git 写入不在本轮范围；README 中外部观测场景必须实现真实来源适配，无法取得供应商访问前提的项标记阻塞，不能当完成。发现原页面发生布局替换即不通过 C01/D02。

### 5.1 关键失败场景

| 场景 | 期望行为 | 后续证据 |
| --- | --- | --- |
| DeepSeek 超时、限流、无效 JSON | 保留真实错误与请求身份；不自动换模型、不制造成功提案 | 脱敏请求结果、持久请求记录 |
| 提案生成后任务被人工修改 | 应用拒绝旧 revision，原文与提案均保留 | 双会话操作与核心文件复读 |
| 提案应用响应丢失 | 保留原键和未知提示，先核对，不创建第二个对象 | 截断响应后刷新恢复 |
| Host 失租、重启、旧 epoch 回报 | 拒绝旧回报；副作用不明确继续占位，不盲重跑 | 真实进程故障及持久收据 |
| 取消请求已发但执行未确认停止 | 分别展示取消请求与终态，不提前标记已取消 | 实际进程停止/工具收据 |
| 当前用户被撤权或切换工作区 | 清空无权快照，取消订阅，不泄露旧消息/日志/上下文 | 双主体、跨工作区浏览器操作 |
| 关闭浏览器 | 不取消已受理 Run；Worker 调度仍由服务端负责 | 关闭页面后复读同一记录 |
| Agent 面板反复打开/关闭 | 原任务/文档草稿保留，会话不重复创建，原布局恢复 | 编辑中切换面板与刷新 |

### 5.2 设计依据与冲突优先级

实施前复读原项目 `README.md`、`docs/domain-design/README.md` 第七节、`docs/implementation/backend-delivery.md`、`docs/implementation/markdown-integration-adr.zh.md` 及涉及的领域不变量/场景。重点追踪 INV-01/02/03/05–10/13–16/20、SC-02/03/04/05/08/09/10/12/13/14/15/20 和执行相关 INF 场景。

现行 Markdown ADR 与实际配置工作流优先于旧 v0.1 “审核通过才能完成”的历史假设；本计划不恢复旧守卫，不改变当前人工完成语义。操作审批只授权具体工具动作；成果审核是独立交付流程；模型消息、Run 终态和任务完成不能互相代替。

## 6. 计划交付标准

交付必须覆盖本清单及 `SCENARIO-MATRIX.zh.md` 中逐项场景，完成真实实现和运行证据；原型的 DEMO 开关、内置快照、人工勾选及本地 controller 不迁入正式路由。缺外部输入的场景保留完整实现、明确所缺前提和已验证边界，不把禁用按钮算成功。完整运行结果在实施结束时逐项登记。

### 6.1 完整性与证据收口边界

- 已逐份对照Studio README、36份场景说明与PROACTIVE的24来源规则；矩阵分别保留S01–S36、P01–P24、A01–A14、J01–J08的独立状态、原生实现入口、真实对象/Run/提案ID与证据字段。首屏40任务/30消息/12Session/8Run/20通知、三组20任务初显15及长文档/长消息到尾的标准未删减；原native50不是用户批准的替代值。
- 原型与生产语义的差异有明确依据：真实Markdown/SQL替代localStorage业务库、后台Run不随刷新停止、精确动作审批替代DEMO控制器、原核心配置工作流/独立核验报告替代强制第六列、迁移当前任务不改历史Run项目。详见矩阵语义转换及Markdown ADR，不静默重定义Done。
- **停止时未完成**：S25/S29实际取消及同段另一Run继续（A6/B7真实双Node/两成功但cancel POST=0）；J02/J03人工批准Done、J04完整同版本正向复查送审链；S16持久消息精确一份往返；S31取消归档确认/归档列表返回完整UI细链；S36文档后改拒旧undo（原模型failed、无写、第二请求未发）；全部键盘/Popover Esc归焦/全视口浮层、未启动的NoModel；120通知全量投递/六页/个人已读；P03/P20/A13真实7/14日前提；完整backend的2项失败未修。S03六种选区操作与S02/S05/S07/S14/S17/S24/J01、P05/P07/P12/P22/P24、S27/S28等各有独立真实证据。用户停止后不再补验，不将局部pass、旧绿色报告或静态测试当完整场景通过。
- **已冻结的数据/时间边界**：真实1200任务/unique1200/1200原key200，首40到1200全分页，TASK-1286请求53640字符完整SHA/尾marker、DOC-003长文/240消息/历史首12/8及三组20首15均有实证；首40耗时20.784s原样保留，不声称流畅性。通知120源均committed/不同comment120，但最终仅验40条/20每页，最后observed delivery110/processing pending，120全分页及已读未验。A14真09:00只是预算skip；7/14天unit结果不是现实年龄。旧Provider500、模型/CAS失败、DB55433精确回滚及4192失败均保留，不扩成其他数据整库未变。
- **最终归因/安全收尾**：Native终态见`.local/evidence/native-ui-final-handoff.json`，Journey终态见EJ.summary.finalState；均无自有unknown/在途，context已关，未起NoModel临时DB/API/Vite。Native自身未检查末版execution，父级之后bg240及只读smoke补齐，两层证据不混淆；真实取消仍未通过。父级已接收并记录bg237最终900通过/2失败，检查任务与所有子代理均已结束，主应用服务保留，没有后续自动补验承诺。

<a id="automation-page-delivery"></a>

## 7. 本副本自动化页面增量交付（2026-10-26）

本节对应新的“在项目中实现自动化页面”请求，不改写上方历史冻结状态或把旧副本证据算成本副本验收。当前副本只有 Agent Chat，原计划中的 Studio 自动化服务并不存在；本次在原 PM 外壳增量实现真实规则、只读报告和 Worker 调度，不迁入 Studio 根应用。

- 原生入口：`/pm/<workspace>/automations`，侧栏 Agent 分组及聊天侧栏均可进入。规则 CRUD、明确项目、手动/每日触发、时区、预算/冷却、只读测试、启停、正式运行和分页历史消费真实 API；规则与运行可通过查询参数刷新复读。
- 可用动作：读取 Markdown 中全部未完成、逾期或受阻任务并保存观测报告。配置工作流决定终态，不另造任务树；模型分析、Host 执行、外部连接器未接通，保持禁用。此边界不等于 P01–P24 / A01–A14 或完整 Agent 计划已验收。
- 持久化：迁移 `0034_automation.sql` 保存本人规则、不可变报告/收据和专用调度心跳。当前授权、revision CAS、原键幂等、源范围、当地日预算、冷却和调度去重由 application/Worker 维护。测试零写入；保存草稿不运行；删除保留历史。
- 本次浏览器实证使用隔离 PostgreSQL schema、临时真实 API/Worker 和 Web 3248：空态→明确项目→未保存配置只读预览→草稿保存→手动运行→来源深链；实际提交响应被截断并阻断收据后，刷新查询原键，恢复同一规则且历史运行未重复。
- 关闭浏览器后，真实 Worker 于 `2026-10-25T21:31:00.140Z` 生成定时报告 `5ff57d0b-d24f-40a0-b399-597160da7381`；此前手动报告为 `f6b41804-7461-4276-8b2a-27fc7ac98c18`。两次来源 `TASK-001` 均为 `todo`、revision `7438edc1f4f05e768a007b319f1587ca18ac1e090b3f21dee2a74bb345c46829`，来源页正文未变。删除规则后两份报告仍保留；这些临时验收对象不是用户工作区的业务数据。
- 已操作搜索/状态筛选、暂停、取消删除、确认删除、历史深链、未保存草稿取消离开；1440px/390px 实际页面可用，390px 无横向溢出。只读成员的新建按钮禁用且看不到其他成员报告。项目真实归档后，运行/重新启用禁用，暂停与删除成功。修复了保存后列表刷新期间的旧 revision 操作窗口及启停后干净草稿误报过期。
- 本副本 API 4192 / Worker 已加载新构建，数据库迁移到 `0034_automation.sql`；实际 `/health/ready` 的数据库、存储、Worker、核心检查均为真，专用调度心跳新鲜，未登录自动化接口返回 401。原 Web 3222 保留；临时验收服务、schema、目录和脚本已清理。
- 检查通过：`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm check:web`、`pnpm contracts:check`、`pnpm check:docs`；自动化 domain/PostgreSQL/HTTP 专项 17/17 通过（0 跳过），浏览器恢复 journal 回归 6/6 通过。Vite 仍报告既有大 chunk / 静态与动态混合导入警告，不是构建失败。
- 全量 `pnpm test:backend` 未通过：3600 秒后命令超时，报告 394 通过、1 失败、71 取消、0 跳过。失败为 `tests/account-recovery-worker.integration.test.ts:41` 的 SMTP 挂起/Worker 心跳场景；账号恢复集成本身达到 120 秒 suite 超时，后续文件未完成，不能算通过。该环境存在 `AWS_PAGER`，而该用例把环境完整传给明确拒绝 `AWS_*` 的 Worker。未修改无关账号恢复实现或缩小全量检查口径；自动化的完整 17 项专项结果单独记录。
- 去除非凭据环境键 `AWS_PAGER` 后，原 SMTP 挂起/Worker 心跳用例单独执行通过（1 通过、0 失败、0 跳过），证明新增调度循环未阻塞该心跳场景；这不抵销上述全量回归的账号恢复超时与未完成部分。

### 7.1 自动化编辑与历史页面参考重构

- 按用户指定的 [Automation 1](https://shadcnblocks-admin.vercel.app/ai-chat/automation-1) 与 [Automation run history](https://shadcnblocks-admin.vercel.app/ai-chat/automation-run-history) 重构，保留原 PM 外壳和真实应用服务。两个 `gpt-6.1-sol` / `xhigh` 子代理分别负责规则编辑与历史；配置位于 `.omp/agents/automation-design-sol.md`。
- 编辑页改为规则侧栏、可编辑标题、紧凑操作、编号报告/运行时间区和折叠设置；历史改为日期分组、时间列、状态行和独立展开的结果/运行配置，不再使用概览卡片或左右详情布局。历史筛选消费真实规则参数与游标，不制造全量统计或未支持的后端筛选。
- 移除中点分隔符、冗余说明和未接通能力的装饰入口；普通保存/暂停不再要求确认。颜色来自官方 `@radix-ui/colors`，按背景/交互/边框/文本/状态语义使用色阶，覆盖明暗模式及该路由的原工作区外壳；三档字号 12/14/20px，CSS 边框 0.5px，无阴影与动画，窄屏规则列表默认折叠。
- 本轮隔离真实 API/Worker 浏览器实证：只读测试命中两条任务但未新增运行；新规则保存为草稿；直接保存、确认启用、直接暂停、确认运行成功。正式报告 `63a03975-bfd0-48e6-b312-809194154c72` 完成并保留来源配置；提交成功后截断响应并阻断原收据，保存被锁定，刷新后恢复 revision 5，仍为四条规则/四次运行，没有重复请求结果。
- 冲突实证：本地未保存名称遇到远端 revision 6 后保持原草稿并禁用保存，显式载入已保存版本后才替换；确认删除后历史报告名称和配置保持原快照。运行配置切换、深链刷新、规则筛选、完成/每日上限跳过状态及只读成员隔离均已在页面操作。验收使用临时 schema/账号，不写入用户工作区。
- 最终浏览器检查覆盖 1440px/390px 和明暗模式：整页可见文字只有 12/14/20px，无中点分隔符、阴影、动画或横向溢出；深色背景为 Radix gray-1。来源链接打开真实任务，离开自动化后原工作区外壳样式恢复，窄屏选择规则后列表收起。无页面 JavaScript 异常；故障注入造成的请求失败和导航取消不混同为页面异常。
- 本轮检查通过：`pnpm check:web`（ESLint、TypeScript、Vite）、journal 回归 6/6（0 跳过）、`pnpm check:docs`。既有大 chunk 和静态/动态混合导入警告仍存在。
- 本轮不修改后端协议、迁移或生产 API/Worker，不把前节全量后端回归的未完成项改为通过。
- 临时 API/Worker 已正常退出并清理隔离 schema/目录，预览服务与浏览器已关闭，临时验收脚本已删除；原 4192/3222 服务保持运行。
