# Studio 场景逐项真实化与验收矩阵

本文件是 EXECUTION-PLAN.zh.md 的强制组成部分。来源为 `../agent-pm-studio/README.md`、逐份读取的 `integration-scenarios/01..36-*.md`、`integration-scenarios/PROACTIVE.md`。用户已授权完整真实化；下方要求不是完成声明，当前状态以“本轮逐项证据登记”为准。原型的 204/204、100/100、localStorage 快照或手动勾选均不是本项目通过证据。

**本轮已结束：遵照用户“这一轮运行完后结束所有任务”的指令。** 所有子代理已退出，剩余未启动分支停止，不再发新模型、Run、pair、通知批次、fixture、修复或补验请求。已发请求按原键结算，运行库非终态Run查询为空；本文件中的“待验证/仍需”表示停止时未完成，不是继续执行承诺。最后bg237全backend已结束：902项、900通过、2失败、0取消、0跳过；不宣称全部验收通过。

## 语义转换（不复制演示限制）

- 原型 localStorage 业务事实改为本项目真实 Markdown/SQL/内容存储；本地仅保留交互草稿、偏好和未知请求恢复。
- 原型 demo-controller、demo-evidence、演示开关、载入快照、勾选测试清单不进入正式产品。验收创建隔离的真实任务/文件/测试进程，不用拦截成功 API 或预写绿色报告。
- 刷新/关页只断开订阅，不停止后台 Run；实际显式取消、失租和无法核对的副作用分别显示，不能照搬原型“刷新即 stopped”。
- 任务工作流动态读取；Agent核验采用持久执行/独立报告，不强加第六状态列。**这只转换载体，不取消原README109/119/182的三条标准真实来源、明确送审、人工批准Done、Done列定位/高亮与审计要求**；原缺口链的重新评估/人工意见退回也保留。独立ready或测试通过不是完整正向完成旅程。
- 新 Run 允许先持久排队以便追踪，但任何受控工具副作用必须精确审批后派发。不能把模型输出当命令执行证据。
- 历史 Run 输入/原项目不可重写；跨项目移动保存历史来源与当前任务归属映射，读历史需核验相关项目权限。不可破坏 INV-05 换取表面“移动成功”。
- PR 草稿为真实 Run 产物生成的本地文档，不声称创建远端 PR。PR/CI 来源观察必须有真实适配器，未配置供应商时该来源阻塞但不得用 DEMO 替代。

上述转换的依据不是临时放宽：`IMPLEMENTATION-CONTRACT.md`明确保留原PM/UI、Markdown权威及生产持久排队/后台执行；[Markdown ADR决策5–7](docs/implementation/markdown-integration-adr.zh.md)明确审核与核心状态转换分开、当前配置工作流决定人工完成。对应原型差异逐一保留：S07“批准前无Run”转换为“可持久排队，但批准前无受控工具副作用”；S26“刷新即stopped”转换为“刷新不能取消或重派，必须读取同Run”；J02–J06“强制第六列/报告通过才能Done”转换为独立真实核验报告＋原人工完成规则；S34“把历史Session/Run项目一起改”转换为当前任务迁移与原历史不可变/双侧授权。原UI外壳尺寸保留，新增Agent的同宽/右置/非模态要求不删除。其余逐项接受标准，包括数量、视口、操作分支与来源证据，不因迁移被默默缩减。

## S01–S36 联动场景

| 编号 | 使用情境 | 页面/组件 | 真实行为与验收要求 |
| --- | --- | --- | --- |
| S01 | 详情打开/关闭 Agent | 原任务详情＋非模态侧栏 | 原标题/正文可编辑；关闭重开不丢保存内容或未保存草稿；最多一个面板 |
| S02 | 自然语言创建任务 | 集合 AI 创建→候选编辑 | 真实 DeepSeek 生成；打开/取消零任务；候选可改；明确发布才创建且只创建一次 |
| S03 | 选区改写/缩短/扩写 | 原编辑器选区→差异审阅 | 标题和正文分别覆盖改写/缩短/扩写；保存选区与来源 revision；真实模型输出；预览/拒绝不写；应用仅目标区；版本安全撤销 |
| S04 | 补充验收标准 | 侧栏提案 | 标准写任务真实验收属性/原生规范字段，不误写评论；确认前及任务状态不变 |
| S05 | 展开完整工作台 | 侧栏→Agent/Run 全页 | 同一对象与会话；不新增消息/Session；核验链接直达报告标签 |
| S06 | 返回原任务 | 工作台返回 | 保留正确实体、返回来源、草稿、光标/选择/滚动与焦点恢复 |
| S07 | 启动 Coding Agent | 关联执行→运行页 | 打开不派发；真实 DeepSeek＋Host；逐动作审批；实际文件和命令结果；刷新持久，不自动完成 |
| S08 | 结果回到任务 | 任务执行摘要 | 摘要关联正确 Run；待审批与历史同时可达；人工审阅标记持久，详细产物留运行页 |
| S09 | 消息转任务草稿 | 对话消息操作→规划/创建 | 保留消息/会话来源，生成未发布候选；来源链接可回原会话 |
| S10 | 引用任务/项目 | 授权对象选择器 | 类型化引用、真实标题/revision；服务器按当前权限加载上下文，不仅回显 token |
| S11 | 评论调用 Agent | 原任务评论 | 显式 @Agent 触发真实模型；人工/Agent 来源区分，评论与提案持久；拒绝不改字段 |
| S12 | 拆解子任务 | 任务→规划页 | 候选审核后创建真实子任务；parent 正确；不是纯文本 checklist |
| S13 | 一次生成多个任务 | 规划候选编辑器 | 候选可编辑、删除、选择；只发布选中项；确认前正式任务数不变 |
| S14 | 批量修改 | 集合侧栏＋逐项提案 | 优先级/负责人/正文/状态分别预览、接受/拒绝；逐项 revision 与恢复；核验创建真实核验记录 |
| S15 | 多 Session | 执行/会话选择 | 新身份、旧历史与 Run 输入不覆盖；会话与任务关系可查 |
| S16 | 侧栏/全页连续 | 共享会话 provider | 消息去重、输入草稿连续；执行/核验/活动/详情切换不重建会话 |
| S17 | 看板选择交给 Agent | 原集合选择＋非模态面板 | 面板打开仍可增选/取消；52匹配仅加载40仍捕获52；三组各20项、每组初显15时追加整组，取消一组不丢另组，切列表保留；停止后再分析保留现场；只读不改状态；编码逐项独立审批 |
| S18 | 项目目标转开发计划 | 新规划页，保留原项目页 | 真实目标上下文；里程碑/父项/依赖可编辑；分批发布映射真实ID；未选依赖/环明确拒绝 |
| S19 | 查重与关联 | Agent 分析与相关任务 | 读取授权任务，展示相关性依据；确认才写正式关联，不自动合并 |
| S20 | 依赖分析 | 规划/批量建议 | 真实关系图；拒绝不存在/自环/环；应用前不写，遵循当前跨项目依赖规则 |
| S21 | 审查 Diff/Test/PR | Run 产物与人工审阅 | 实际文件 diff、真实测试 stdout/exit/断言，PR草稿不伪造URL；审阅不完成任务 |
| S22 | 失败结果转 Bug | Run→调查候选 | 实际失败日志与来源Run，人工编辑发布新任务，不覆盖失败现场 |
| S23 | 文档 Agent 编辑 | 原文档＋共享侧栏 | 正常手工保存保留；AI before/after、拒绝、接受、安全撤销；真实关联来源 |
| S24 | 项目进度/风险总结 | 项目 Agent 分析 | 当前授权任务/Run/文档引用可追溯；只读，不猜完成率/根因 |
| S25 | 失败/停止/重试 | Run 操作 | 真实受控失败、取消请求与停止确认；重试新Run和授权；原日志/成果保持 |
| S26 | 刷新/断网恢复 | 持久 Run/请求 journal | 浏览器断网/刷新不重派；重连读取同一记录；服务重启/unknown有事实依据 |
| S27 | 权限/人工审批 | 审批页/运行详情 | 当前权限复核，拒绝/撤权不派发；恢复权限不自动批准；审批绑定精确动作 |
| S28 | 版本冲突 | 双会话提案 | A生成后B修改，A应用返回冲突并保留双方内容，不用mock冲突 |
| S29 | 并行独立运行 | 两任务/两个Session | 不同Run真实并发，一项取消不阻止另一项；观察标签页不控制后台状态 |
| S30 | 统一 Inbox/Activity | 待审＋原通知/活动入口 | 真实运行/审批/发现来源可跳转；已读持久；不跳任意当前任务 |
| S31 | 关闭/归档后的历史 | 原生命周期与运行历史 | 活跃占位守卫；归档禁止新执行；恢复保留身份；已删除来源有历史快照与授权 |
| S32 | 布局适配 | 原PM＋新增页面 | 1440×1000/1920×1080逐页几何与人工视觉；任务/执行/规划/看板右侧栏同宽、非模态、独立滚动、中央不重叠、根无横溢；规划按钮可见；文档/Inbox/审计/搜索/设置浮层可见可关闭；旧主题/默认页不变，保留窄屏 |
| S33 | 不可用/空态 | 模型/Host/权限/网络状态 | 分别验证真实未配置、无读/写权限、服务错误、断网及恢复；恢复不造Run；无写权限允许只读审计/字段预览但禁止应用；空项目创建归属正确 |
| S34 | 跨项目移动 | 原任务明确移动操作 | 源/目标权限重查；任务ID保留；历史输入/Run项目不篡改；关联/交付/评论归属有可恢复迁移合同 |
| S35 | 大数据边界 | 列表/消息/Session/Run/通知/长文档 | 隔离服务真实写入1200任务、240消息、40历史Session/Run、120通知及长文档；源验收首屏分别40/30/12/8/20；分页到最早、长消息可展开到尾部、长文档可打开，正文不截断保存；不把耗时样本当设备帧率 |
| S36 | 审计与撤销 | 原审计＋提案详情 | 操作者/来源/对象/before-after真实；版本匹配撤销成功，后续编辑拒绝旧撤销，审计不可变 |

S17 查询必须覆盖关键词/短语、NOT>AND>OR、括号、status/priority/created、状态别名、UTC日界/闰日/区间及错误位置；非法表达式零匹配并禁批量选择，不回退整个项目。列/组追加全匹配与“全部筛选替换”“已加载追加”语义分别验收，不替换原 PM 已有筛选器，只增高级输入/适配。

## P01–P24 主动来源场景

| 编号 | 真实来源/触发 | 结果与确认 | 验收重点 |
| --- | --- | --- | --- |
| P01 | 新建任务与授权已有任务相似 | 关联提案 | 不自动合并/删除 |
| P02 | 内容更新缺验收/范围/约束 | 补全提案 | Level2只准备pending，不应用 |
| P03 | ≥7天无活动/评论/会话/Run | 跟进提案 | 用持久时间，不能伪造旧日期 |
| P04 | 全部前置依赖满足 | 排期状态建议 | 实际工作流与权限重查 |
| P05 | 同版本真实Run非空测试全通过 | 人工送审建议 | 不把测试通过等同任务完成 |
| P06 | 依赖或声明修改范围相交 | 协调任务草稿 | 来源/范围可展开 |
| P07 | 真实Run成功且有摘要/成果 | 来源化活动、总结文档候选 | 去重，记录Run来源 |
| P08 | 真实Run失败日志/测试/文件 | 调查草稿 | 保留原错误，不声称根因已证实 |
| P09 | 会话空闲/完成且明确遗留事项 | 未发布任务草稿 | 保留原话/Session，用户编辑后发布 |
| P10 | 真实PR/CI来源与验收覆盖缺口 | 补充验收草稿 | 实现外部只读适配；缺访问配置标阻塞，不能载入DEMO |
| P11 | Run时间实际重叠且diff路径交叉 | 并行协调任务 | 有来源文件身份，不推定必然冲突 |
| P12 | 多Run重复失败测试/错误 | 假设与执行申请 | 必须人工授权，不自动执行 |
| P13 | 对话明确决策 | 决策文档候选 | 来源消息可查 |
| P14 | 实际diff超出声明范围 | 范围复核草稿 | 使用Host真实文件变更，不自动回滚 |
| P15 | 需求版本变更及关联下游 | 影响分析文档 | before/after版本与引用 |
| P16 | 多Session重复明确技术主题 | 知识文档 | 授权消息与主题证据 |
| P17 | 不同任务共享失败问题 | 共性调查草稿 | 关联真实Run/任务 |
| P18 | 阶段完成且有下游工作 | 规划候选 | 原生规划审核后发布 |
| P19 | 持久后台每日/首访观测 | 项目变化摘要 | 无变化不制造日报，不能依赖页面interval |
| P20 | ≥14天无进展且真实阻塞 | 项目调查草稿 | 使用真实历史观测/时钟边界，不改业务日期 |
| P21 | 里程碑＋未完/失败/待审 | 发布风险文档 | 不宣告可交付 |
| P22 | 当前访问晚于持久上次访问边界 | 离开期间摘要 | 水位持久，不倒退重放 |
| P23 | 目标＋未完目标任务＋近期文件偏离 | 下一步规划 | 真实文件变更，不能靠Session数量判断 |
| P24 | 目标任务＋已满足依赖＋明确遗留 | 下一步规划 | 用户可编辑，禁止自动发布 |

全部规则具备项目策略暂停、逐规则启停、冷却、每日预算、语义去重、证据版本保护、权限与项目变化失效。**Level1自动观察/建议，但明确人工确认的写入仍允许**；Level2仅增加自动准备原生pending字段提案，不自动应用，Issue/文档/Planning/Coding仍需明确确认；Level3不在本轮开放。原硬性Level2人工门槛是P07已记录缺陷，不是缩减后的产品契约。Finding在Pulse/任务/规划/统一待审共享同一身份。

## A01–A14 自动化使用情境

| 编号 | 使用情境 | 必须真实实现的行为 |
| --- | --- | --- |
| A01 | 总览/运行/待审核三入口 | 持久规则、触发、上次/下次、失败/待审数，不显示假统计 |
| A02 | 创建/编辑规则 | 名称、指引、模板、范围、触发、时区、输出、冷却、限额；revision与未保存草稿 |
| A03 | 每次新建对话 | 正式检查才建会话；记录输入快照、运行ID、结果 |
| A04 | 继续既有对话 | 追加不覆盖，缺失/跨项目拒绝；不静默改为新会话 |
| A05 | 保存/只读测试/预算跳过 | 不写对话、不发模型执行、不修改业务；测试结果明确是预检 |
| A06 | 三栏运行工作台 | 左运行列表、中活动/对话/输入、右变更/发现；触发不是用户消息 |
| A07 | 变更审阅 | 字段before-after/文档候选/规划候选；预览后应用、忽略、版本安全撤销 |
| A08 | 审核收件箱 | 待审发现与失败运行、待变更数、来源与当前重查入口 |
| A09 | 人工审阅备注 | 真实保存、标为人工，不触发模型回复或调度 |
| A10 | 再次检查当前来源 | 当前规则/当前数据/权限/策略/预算；不伪装历史事件重放 |
| A11 | 编辑与运行页往返 | 未保存规则保留；历史输入不得用当前配置补造 |
| A12 | 需求完整性检查 | 真实任务更新触发，新审阅对话、发现/证据/任务深链 |
| A13 | 停滞任务跟进 | 手动检查续接对话，两次运行保留各自输入与结果，不复制演示消息 |
| A14 | 每日09:00 Asia/Shanghai摘要 | 独立Worker真实时区调度、仅通知模式、每日上限跳过；关浏览器与重启后可核验 |

原README“浏览示例”的三个情境A12–A14改为普通可配置规则及隔离真实验收，不向正式工作区注入DEMO项目。源README推荐的“证据齐全/存在缺口/Session失败”分别使用实际成功测试、失败测试和真实失败Run，在核验工作台逐标准展示证据与未知；修复必须真的改受控工作目录文件并重跑，禁止更换快照冒充修复。

## J01–J08 完整旅程与全局工具

- J01 项目简报→真实模型候选→编辑/删除/里程碑/父子/依赖→分批发布→真实卡片定位；未选候选保留。
- J02 单任务自然语言→标准提案→人工采纳/发布→当前逐标准来源→明确送审；人工批准Done与要求修改分支均须真实操作，不能只用负向退回代替正向完成。
- J03 原README109/119/182的完整成功链：三项标准均有当前版本源码/Session/实际测试依据→合格报告→明确送审→人工批准Done→原看板Done卡片定位/高亮及操作者审计；Run或报告完成本身不得自动Done。
- J04 原README110/183的缺口链：真实失败/证据缺口→明确退回In progress→修改受控文件→新版本实际复查通过→送审/填写意见退回，意见与报告失效保留；不能拼接不同版本的绿色报告冒充整链。
- J05 实际失败Session：保留部分输出、失败事实与不可完成原因，不把部分成功涂绿。
- J06 停止、刷新、修改验收条件、修改来源、旧报告失效；未知标准保持unknown，不能让模型自报成功。
- J07 原文档/通知/对象搜索/审计/设置入口保留；执行待审与来源深链融入，不替换为全局Studio工具层。
- J08 正式产品不提供“DEMO可用性”及人工勾选通过数；管理员显示真实能力，测试记录在本矩阵与私有证据中。

## 证据登记格式

每个S/P/A/J编号独立记录：实现文件/入口、验收命令或浏览器动作、实际对象/Run/提案引用、结果、证据路径、未验证分支及外部阻塞。状态为“待实现 / 已实现待验证 / 真实通过 / 失败 / 外部前提阻塞”；部分真实通过仍归“已实现待验证”，不能把一条 check 的 PASS 扩大为整个编号通过。涉及自然语言的验收使用真实DeepSeek；确定性规则可以真实读取持久事实，不伪装模型推理。故障注入、受控时钟和真实壁钟分别登记。

## 本轮逐项证据登记（2026-10-25）

### 证据与入口索引

本节为已观测事实的快照，不宣称所有场景完成。时间戳来自证据的 ISO UTC 字段，浏览器展示可能为 Asia/Shanghai。状态只覆盖该行全部要求；局部分支成功不会消除未跑分支或历史失败。JSON 文件是本机私有证据，不随 Git 分发；下面的字段定位可直接按编号检索，不要求阅读巨量原始 body。

| 证据代号 | 实际路径与定位约定 |
| --- | --- |
| N | `.local/evidence/native-ui-acceptance.json`；`checks[id=...]` 表示 `checks[]` 中该 `id`，另有 `scenarioSummary`、`objects`、`screenshots`、`layout1920`、`layoutNarrow` |
| L | `.local/evidence/planning-acceptance.json`；`observations[id=...]`、`objects`、`requests`；任务/消息检查点另见 `.local/evidence/planning-load-checkpoint.json`、`planning-message-checkpoint.json`；真实分页/分组见 `planning-native1200-browser.json`、`planning-groups60-browser.json`，以实际count、ID集合及逐项结果为准 |
| T | `.local/evidence/automation-acceptance.json`；`scenarios.Pxx`、`automationScenarios.Axx`、`observations[id=...]`、`objects`、`controlledBoundaryChecks` |
| R | `.local/evidence/parent-acceptance.json`；`checks`、`verification`、`move/moveBranches`、`sourceRecovery`、`document`、`projectSummary`、`permissionRestoration`、`objects/requests`；真实部署见`semanticLeaseMigration/semanticDeployment/artifactDeployment`及旧`runtimeMigration/runtimeRestart/deployedExecutionCapabilities` |
| M | `.local/evidence/model-smoke.json`；实际 `deepseek-flash` 结构化返回、流式5块、usage、streamAbort/preDispatchAbort，不是模型配置存在即通过 |
| F | `.local/evidence/frontend-source-baseline.json`原464摘要；旧`frontend-preservation.json`的445同/19改/0缺保留；新`.local/evidence/frontend-preservation-current.json`于02:52:27.032Z确认442逐字同/22受控接入改/0缺，原views未改。文件级对照不等于所有视觉/业务通过 |
| E | `.local/evidence/acceptance-environment-isolation.json`；正确PG55440、正确主体/工作区、最小子进程环境，以及误继承55433后精确移除本轮误建主体/工作区的ID |
| H0 | `.local/evidence/agent-runtime-smoke.json`；最初真实Run失败及先前成功的模型候选/原键重放；该文件总体为failed，不能因后续新Run成功改称整次smoke通过 |
| H | `.local/evidence/host-history-acceptance.json`；`checks[0]`实计52去重Session＋52Run（5复用＋47真实DeepSeek/Host taskless），`pagination`完整API54/62，`browser.passed=true`实点分页/最早对象；终态与receipt仍按真实失败/恢复保留 |
| U | `.local/evidence/native-ui-provider-error-capture.json`；新导航console/pageErrors为空、warmNavigation/sharedProfileProbe未复现；不包含足以诊断旧Provider500的旧异常参数 |
| EJ | `.local/evidence/execution-journey-acceptance.json`；`summary`/`scenarioSummary`逐分支水位，`observations[id=…]`、`browser.actions[id=…]`及对应截图；本观察段closed且completionClaim=false，不是完整旅程PASS |
| MC | `.local/evidence/message-conversion-acceptance.json`；S09 TASK-506主链；旧S22 TASK-507仍kind=task/旧汇总不可当正式Bug；新`formalBugAfterFix`/check `S22-formal-native-bug-after-parent-fix`实证TASK-1001 kind=bug/单H1/冻结Run来源返回，同时保留0da…及更早真实模型失败 |

下列路径均相对本仓库。实现代号表示真实入口，不把文件存在当运行通过：

| 实现代号 | 文件/公开入口 |
| --- | --- |
| I-N | `apps/web/src/features/pm/agent/native.tsx`（`NativeEntityAgentActions`、`NativeProjectAgentAction`、`NativeTaskMove`、`PmAgentNativeHost`）与 `context.tsx`；原任务/文档/项目中的次级操作 |
| I-C | `apps/web/src/features/pm/agent/conversation/{index.tsx,state.ts,reference-picker.tsx,comment-action.tsx}`；`AgentPage`、`AgentPanel`、`AgentCommentAction`、`MessageTaskDraftLink` |
| I-P | `apps/web/src/features/pm/agent/planning/{page.tsx,model.ts,query.ts,board.tsx}`；`PlanningPage`、`BoardAgentActions`、`compileAgentQuery`、`validatePlanningGraph`；原 `markdown/TaskCollectionView.tsx` 选择适配 |
| I-X | `apps/web/src/features/pm/agent/execution/{index.tsx,evidence.tsx,verification.tsx,requests.ts}`；`RunsPage`、`RelatedExecutionSummary`、`VerificationPanel`；`runs?runId=…&sessionId=…&tab=…` |
| I-V | `apps/web/src/features/pm/agent/proposals/index.tsx`；`ProposalPreview`、`ProposalsPage`；`packages/application/src/studio-agent{,-apply,-context,-schema}.ts` 的版本保护与原生写入 |
| I-T | `apps/web/src/features/pm/automation/{index.tsx,RunWorkspace.tsx,FindingReview.tsx,RuleEditor.tsx,PolicyEditor.tsx}`；`PulsePage`、`AutomationsPage`、`AgentInboxPage`；`packages/application/src/studio-automation*.ts` 与独立Worker；P10只读来源为 `packages/infrastructure/src/studio-github-sources.ts` / `studio-automation-sources.ts`；P05/P12 followup在 `studio-automation-followups.ts` |
| I-S | `packages/application/src/pm-agent-scenarios-{comments,moves,verification,sources}.ts`；真实评论、移动、核验与来源；`apps/agent-host/src/{runtime,adapters,transport}/` 负责实际隔离执行 |
| I-G | 原 `apps/web/src/features/pm/service/{service-notifications.tsx,notification-inbox-model.ts}`、`pm-shell.tsx`、`routes.tsx`、原设置中心；新增 `agent/settings/index.tsx` 只展示真实能力 |

为减少长ID重复，下列引用是精确对象，不是示例值：

- **N-task**：`PRJ-005/TASK-021`；原生文档 `DOC-002`；对话 `ed6984a2-1d3e-40ba-ac7b-c568af4c5d6b`（N.objects）。
- **Run-0**：`c8c8549e-c90b-440a-b763-edcfbb9ca649`，Session `5d8e9fe9-f747-4f3f-8322-513d54abfc4b`；任务 `TASK-001` 原 `PRJ-001`、显式移到 `PRJ-004`。旧失败Run为 `4d6db289-42ef-4584-a541-b963eb4ad211`（H0、R）。
- **Run-A / Run-B**：`8e66cfdd-e23a-48fd-9fce-5dd8354293c8` / `8c0ad35f-b673-44eb-b7dd-eed84a8fe765`，分别 `PRJ-004/TASK-026` / `TASK-028`、Session `66d2b344-51f8-457b-9b5d-a8e5a7444040` / `7f9ae1fc-ed09-4e0d-8dd0-2243be9ea225`（R.objects、N.parallelActualTerminal）。
- **Run-F1 / Run-F2 / Run-D**：真实失败测试 `8612b6b6-4275-465d-9f6a-6ac6d06e5d31` / `81540648-f6ae-457f-9018-4c72966f9c86`（`TASK-090/091`），真实越声明范围修复 `90fbf80f-3d5a-4397-8485-8ce97a9d42f0`（`TASK-092`、`GOAL-002`）；T.observations `P12-P17-real-test-only-failures` / `P14-P23-actual-diff-and-artifact-provenance`。
- 本轮工作区 `76763b1d-c8cb-4f4c-ab14-73259b98c610`；owner `380be8fe-c27b-4e60-861a-2784f32aebf2`；真实reader `e7c4831e-d7d5-463a-a03d-23b2f26dede5`。不在文档展开登录凭据或会话cookie。

### S01–S36：操作、对象与结果

| 编号/独立状态 | 实现入口 | 本轮真实操作、对象与证据 | 未闭合分支/明确限制 |
| --- | --- | --- | --- |
| S01 **真实通过** | I-N、I-C；原任务详情 | N.beforePanel/afterReturn先证raw/位置往返；新增 `.local/evidence/native-ui-draft-refresh-acceptance.json` /N.draftRefresh：TASK-021标题追加未保存suffix＋CodeMirror正文marker→开Agent输入composer→关闭/重开→reload→原对象重新打开；raw3464字符严格相同、composer同一未发文本、nonReadNetworkRequests=[] | 末尾仅显式UI discard本轮未保存改动、原标题恢复，服务端任务没有被该交互写入；截图 `native-ui-draft-title-body-refresh.png` |
| S02 **真实通过（同源取消→单草稿编辑→明确发布→原看板）** | I-P/I-V、原native入口，独立PRJ-011 | L `S02-one-same-source-cancel-reopen-real-draft-human-edit-publish-native-focus`及planning-s02-samecase-{complete,continuation}.json：同PRJ-011取消0POST/0formal；唯一真实DeepSeek请求 `1ef5e777-4aba-4bc8-a33e-558c5d7cca79`→conversation `8d7cbe46-8d8d-4eaf-9424-2f2db8e65383` /proposal `4741431c-f5bb-4a98-9d23-7d93e9c04775`，unpublished.items=1/tasks=0；人工标题/正文edit `84754022-6e0d-4520-8417-921cb9820d8f`200后formal仍0；明确publish `0ca836d5-60e7-422c-9abb-b91f53f7f7cf`200得唯一TASK-1350 | planning-s02-original-draft-published.json.native实际原kanban定位TASK-1350/selected持续高亮/sameConversation=true；未重发模型。前两次按钮0dispatch/URLreload瞬态selector失败保留；本次真正同案闭合，不拼H0或独立S13代替 |
| S03 **真实通过（标题/正文各三种选区操作）** | I-N选区、I-C、I-V | `.local/evidence/native-ui-selection-rewrites-acceptance.json` 的六个passed分支：title/body × rewrite/shorten/expand，均真实拒绝后重新生成、明确应用精确选区、明确安全撤销；每项rejectionUnchanged/applyExactDelta/undoExactOriginal/statusUnchanged均true，TASK-021最终均恢复49ef8c47…/todo | 早先一次选区证据及两次派发前校验/驱动失败保留，不能冒充模型成功；六分支完成不代表S36人工后改文档的旧undo CAS也已验证 |
| S04 **真实通过** | I-C验收标准→I-V原生写入 | N.checks `S04-criteria-persistence`；提案 `c3dcc3a5-d8ec-42d7-83a9-af5d1172e51c` 人工应用后写为2条Markdown checklist，非评论；正文保留、状态todo | 验收标准存在不代表标准已满足 |
| S05 **真实通过（共享对话/草稿与原任务核验快捷入口）** | I-N全页、I-C、I-X | N.checks `S01-S05-S06-S16`同N-task/同对话/未发草稿连续且无附带Session/message创建；独立R.reportShortcut.passed=true：原TASK-505“核验报告”→/runs含taskId505/mode=verify/tab=verification/sourceRevision43716…/returnTo原页，scoped selectedTab=逐标准核验并自动读已存报告bade1df6…unknown（2passed＋第三unknown） | R.reportShortcut.studioWrites=[]，无新message/Session/Run/报告，图native-task-report-shortcut.png/观察页已关。两个分支分别引用，不拼造成同case；导航不会把unknown涂绿 |
| S06 **真实通过** | I-N/context返回快照 | N.beforePanel/afterReturn、scenarioSummary.S06：同N-task、CodeMirror选择 `[2624,2633]`、scrollTop1920、`cm-content`焦点及raw恢复 | 不从原型sessionStorage推断远端事实 |
| S07 **真实通过（原任务显式申请→精确动作授权→实际成功）** | I-X→I-S真实Host、原TASK-505执行入口 | EJ `S07-TASK505-native-explicit-new-B7-run-request`于04:25:26.597Z passed：原任务进入只观察、不自动建Run；填写指令后明确请求原键 `a4e4df8b-2840-44c1-9390-512b497d0c7d`创建B7 `0e0ca746-b0ca-43f2-bd42-bdd74e21dd46`；其write/test各原键具体授权，`B7-after-live-pair-no-cancel`真实succeeded/e1、7295ms/exit0/两passed | 保留R.Run-0及旧B3 unknown/SQL23514，不回填。B7是受控私有副本执行，不是远端合并/部署；成功Run也不证明第三个外部标准、不自动送审/Done，核验与原PM人工链分别登记 |
| S08 **真实通过** | I-X `RelatedExecutionSummary`→原TASK-505 | EJ.summary.humanRunReview及`S08-task-review-marker-survives-reload`：B4独立review `e8096d23-86ed-453e-8e34-3404b2c7c223`、原键ba20e5f1…200，回原任务摘要正确显示reviewed/刷新持久/任务todo；新`S07-S08-native-pending-and-historical-run-entry`于03:12:07.963Z显示B5待批＋同TASK-505的B4/B3成功及旧失败历史，定位B5原Run/Session，nonGetRequests=[]/contextClosed=true | 同任务当前待批与历史并存、只查看不隐批/不新建分支已闭合。独立Run review不是原PM Submission/Review；后续B5成功/报告passed也不自动完成任务 |
| S09 **真实通过** | I-C `MessageTaskDraftLink`→I-P→原生任务/来源返回 | MC.S09/checks[0]：来源message `113e8302-c4d5-43b5-b631-89268a4766c9`、真实DeepSeek请求 `e5a573b9-5ac2-4904-84a4-6b7e388787db`→提案 `859c0178-ddf3-47a5-abce-ca4608cf7e58`→人工编辑时0正式新增→明确发布唯一TASK-506/todo；native receipt committed、同键重放同TASK；实际返回原conversation/message、mutations=0 | 截图 `message-conversion-s09-{preview,native-task,source-replay}.png`；旧122fa30c…/722ce209…/50994798…真实模型失败及未明根因保留，新成功不是旧失败已修证明；H1重复标题风险仍在MC.unresolvedRisks |
| S10 **真实通过** | I-C typed picker、I-N原文档 | N请求 `12b3455d-8892-4cbc-ac7c-2030776fbf86`已证真实project/document选择与revision/服务端上下文；新增R.document.firstModelPreview.sourceTaskPicker=`TASK-090`：DOC-004侧栏实际选择该任务，真实请求 `bd3bbaa7-7886-4564-a95f-20c6020a0ffe` contexts含PRJ-004/DOC-004/TASK-090固定revision，非token回显 | 仅已跑task/project/document引用，不扩大未验引用种类；原TASK-021 pinned context本身仍不冒充picker操作 |
| S11 **真实通过** | 原TaskComments＋I-C `AgentCommentAction`、I-S/comments | N.checks `S11-persisted-comment-real-agent-reject`：原command `77851a47-f6bb-4fd0-8050-88daac9a10cd` 原键恢复；人工comment `7de1567e-95f4-440a-a59f-991070de9b82` 显式@Agent，真实DeepSeek保存Agent comment `7d19c690-6e13-486d-a4a9-e2df6434be53` /提案 `def0caf8-ec55-41ab-afc1-49b400c5ba7e`；浏览器拒绝后任务revision不变 | 早期503unknown及恢复过程仍留N.commentReceiptAfterRecovery/s11Recovered，不隐去旧失败 |
| S12 **真实通过** | I-P拆解、I-V | L.observations `real-simple-decomposition`、`unpublished-zero-native-creation`、`S12-S13-S36-partial-publish-original-key-replay`；真实DeepSeek提案 `b6918831-c002-4609-9d50-d6d685f64027`，人工发布 `TASK-094/095`，parent=`TASK-004`；确认前54任务未变 | 正式子任务是原生Markdown对象，不是文本checklist |
| S13 **真实通过** | I-P真实候选→原生看板，PRJ-008 | L `S13-original-proposal-explicit-delete-publish-reveal-continuation`：真实DeepSeek request `78559b55-e45c-4135-8051-dba3dcb7e575` /proposal `81bef22f-62d6-4841-8c1c-8a0770f754d6`三未发布候选且formal0；UI删除第3并保存后formal仍0，显式发另2→TASK-1097/1101/todo，deletedTitle无正式残留；实际点原kanban，两card selected=true/原主题背景，同cv `4a2d7f98-7b4a-4e45-900e-eb983cf63dc9`，关详情及全页→浏览器返回仍侧栏打开/两高亮，清marker URL生效 | originalModelNotResent=true/errors=[]；不是暂停负载后取巧：L `S13-authoritative-native-write-pressure-during-new-model`证明model期间实际建TASK-1019/1020、两次显式发布间TASK-1098/1099/1100归PRJ-006。先前94/95分批/原键证据仍留 |
| S14 **真实通过（逐项审阅→一次批量确认/独立核验）** | I-P/I-V原生中区、TASK-1350/1351 | L `S14-native-UI-all-two-reviewed-then-one-confirm-actual-results`及planning-s14-original-reviewed-confirmed：原真实stream请求 `10fff152-7462-4af4-925c-e52db7d22f66`按原键追回succeeded/未重发，proposal `95887e12-7001-4912-a200-ca8ee9540ed5`真实展开两项before/after，ack前apply disabled、明确all-two ack后唯一apply `1941e4f1-d59f-43d8-bf1f-3dc21565eeca`200/itemIndexes[0,1]；两个原native task实际priority=medium/status=todo | 旧四字段62a0c1c8…真实API应用/拒绝预览与原键复读保留，未冒称其为新UI链；独立TASK-1287/1288两持久报告3b808208…/e8e703d2…各2AC unknown、精确report-id渲染/源不变已证。核验不只改标签，也不自动Coding或Done；旧stream/selector失败留档 |
| S15 **真实通过（独立Session与历史返回）** | I-X Session列表、TASK-505旧执行历史 | EJ.summary.sessionJourney /browser.actions `S07-S15-real-session-return` passed=true：旧Run `ac967f23-685a-445b-a97d-adf493966423` 已真实failed，显式新建Session `2e93f899-2d02-4383-a5fd-2a1d9c4f8a74`；原创建键 `e4a2d6ea-40c3-4a96-9745-aadc7a93b6bc`查committed后仅恢复，实际加载历史切回旧Session `015728e3-ba44-437e-b208-3e9fd43fdfa1`/原Run结果，resume writes=[] | 新Session未提交Run；不声称新Run成功或把Conversation当执行Session。初次分页driver同步失败保留，后续只查原键、无重复创建；截图 `execution-journey-S15-recovered-original-returned-original-failed-run.png` |
| S16 **已实现待验证** | I-C共享provider、I-X | N面板/全页同对话/草稿已证；新增N.executionTabsSettled真实8中央tab均等ARIA稳定选中（Diff/测试/产物/核验/审阅/详情/收据/活动），同Run `d6fc3c1a-1861-426f-b9ab-24c7dbc31916`，未发执行prompt与Agent composer跨tab保持；N.executionSwitch.nonReadNetworkRequests=[] | 初次过早采样tabs标签滞后一项保留，settled结果单列；8tab切换现已补证，不再写成未跑。跨原任务→执行工作台的同任务/会话消息一份及全部往返链仍需最终统一证据 |
| S17 **真实通过（query52/细分筛选/原UI逐项编码授权）** | I-P/query、原集合/共享右栏→原生中区→I-X精确审批 | L query52在首40时exactFullSet/52固定原文、typedRefs52/all52Unchanged=true，原文全属PRJ-003且无draft/archived条目；settled24例、真实UTC425/775/1200各首40、三组20首15/完整组选中与列表保持均实证。显示名同TASK-1287/revision旧0→1、body-only60亦证；planning-s17-coding-requests记录原生checkbox026/028→批量中区→展开独立编码入口→明确申请2项，4POST返回独立Session da0bfc10…/ecb1f1ba…与Run bb255f6d…/622e52dd… | 两Run初只待批；后各read/read/test另原键授权，真实exit1/两失败/e1、无write/任务revision及todo不变；停止/两次再分析及52原文不变另见L。测试失败不涂绿/不自动完成，分析与编码不混同，旧显示名0/Query52 Provider500未解观察不因本项重验通过删除 |
| S18 **真实通过** | I-P目标规划、I-V原生图 | L.observations `S18-J01-real-project-goal-plan`、`S18-S20-invalid-graph-guards-and-roots`、`S18-J01-real-parent-milestone-dependency`；提案 `c33a3a0f-1ef8-46ca-8066-ae570f3d579c`，实际 `MS-003/TASK-096/TASK-097`，父项/依赖真实ID；未选依赖/环拒绝 | 当前工作流来自原核心，不添演示状态 |
| S19 **真实通过** | I-P只读查重→I-V关联→原生Graph详情 | L真实DeepSeek分析/提案 `5140704e-dee3-4eb9-835b-c649f97e87d5` 显式应用TASK-094.related_to→TASK-095、无合并；新 `S19-native-graph-samecase-settled-after-runtime0104` 实际点击TASK-095原Graph按钮→URL `projects/PRJ-003/issues?view=graph&entity=TASK-095`→同次原生TASK-095.md/正确完整描述559ms呈现，API均200/errors=[] | 新证据不是direct跳转替代，截图 `planning-related-graph095-samecase-settled.png`；旧30秒同次详情超时与随后direct读取历史原样保留，559ms仅该次观测不作性能承诺；相似不等于已证重复 |
| S20 **真实通过** | I-P/模型图守卫、I-V | L.observations `S20-native-invalid-graph-and-S28-foreign-source-CAS`、`S20-current-authorized-cross-project-dependency`：自环/环/不存在/跨项目parent均422；当前规则允许显式授权跨项目blocked_by，提案 `ed671ea9-9389-40d3-b8ce-12a548584dfb` 将TASK-094依赖TASK-067；graph有真实关系 | 不恢复旧“所有跨项目依赖一律禁用”假设 |
| S21 **真实通过（产物审查与独立Run审阅）** | I-X/evidence与human Run review，TASK-505/B4 | EJ.observations `S21-B4:real-private-diff`、`real-seven-second-two-pass-tests`、`real-local-pr-artifacts`：实际逐Tab打开同Run `b4e499a9-2caa-4780-8f5e-7daa625102ab`的私有sum.cjs diff、原测试两passed/stdout/exit0/7302ms与本地pr-draft；独立显式审阅 `e8096d23-86ed-453e-8e34-3404b2c7c223` reviewed，原任务摘要刷新持久/todo | 三张 `execution-journey-B4-{real-private-diff,real-seven-second-two-pass-tests,real-local-pr-artifacts}.png`及review记录可定位；PR不声称远端URL/推送或生产合并批准。**仅S21原产物/审阅语义通过**，B3核验e90c0c3f…unknown/缺tested-source artifact仍影响J03/P05，未因人工审阅绕过 |
| S22 **真实通过（正式原生Bug与冻结来源）** | 真实失败Run-F1/TASK-090→I-P→原生TASK-1001 | MC.formalBugAfterFix：已知失败0da…后一次明确授权新请求 `3352b4d2-297c-4cea-bac5-ba9c4f35a2d4`真实DeepSeek succeeded→proposal `36518ce6-5063-4abb-a9b1-80a168c81bb9`；人工改标题后显式apply原键 `e8503b0c-0046-4fbd-9025-cba57bb9467c`→native receipt committed/TASK-1001 kind=bug、PRJ-004/todo、related_to TASK-090、标准全未勾、仅1H1；真实FrozenRun引用/原tests导航、writes=[]，原失败仍可见 | check `S22-formal-native-bug-after-parent-fix`及7张formal-bug截图可定位；旧TASK-507仍kind=task/旧TASK-506/507双标题未改，不能拿它们冒充新Bug。原Run/operations/approvals/receipt/artifact/fixture及三原task raw/revision一致；0da.invalid_model_proposal根因未明，新成功不等于已诊断旧失败 |
| S23 **真实通过** | 原DocumentContentEditor＋I-C/I-V | R.document：DOC-004手动preview revision不变→明确保存 `1a122a7efb8990e12749ffb4d38ee6a4aab2291f038abe4fe5dfd9bb337fb177`；从真实关联TASK-090生成提案 `7ff17987-8832-49cb-a633-6a5be7b3ec04` before/after→UI拒绝不写；第二真实请求 `ad140ae7-3043-44f5-ae5b-377e108a177f` /提案 `beca5f78-b908-44ff-8b3e-357d4c7778b4` 独立ack后UI应用rev22fd…→独立undo ack/UI撤销精确恢复手工raw/revision | 全链字段 `manualPreview/manualSave/firstModelPreview/rejected/secondModelPreview/applied/undone`；截图 `native-doc-manual-preview.png` / `native-doc-ai-applied.png`。后续人工编辑再旧undo拒绝是S36独立待验分支 |
| S24 **真实通过（真实只读摘要/六个冻结来源/原生目标导航）** | I-N项目Agent＋I-C授权冻结上下文 | R.projectSummary真实DeepSeek request `af8f2e33-9e76-4368-b2a9-502716d7933d`、conversation `26c7b374-c02d-46d9-a9c0-4e07b259c698`、message1a53b871…/proposal=null；N.deployedSummarySources与native-ui-final-handoff.observed.frozenSources确认4个core＋2个Run来源，六份展开原文哈希均匹配冻结DTO；DOC-004真实编辑器及原Run导航已实际完成 | 旧仅四源/过早editorPresent=false观察保留，不把源码支持当通过；本次来源/目标是已运行证据。不补写原消息或据模型自述猜事实，不把后续DOC-004 CAS模型失败当摘要导航通过以外的成果 |
| S25 **已实现待验证（本轮取消未通过，停止补验）** | I-X精确审批/取消；当前双Node与UI状态 | EJ原A2/A3/A4/B5/A5/B6全部失败/成功历史保留；04:36:43.546Z owned Host50392同snapshot确有A6 1ed72383…/B7 0e0ca746…两独立workspace的Node，两test keys committed，最终各succeeded/两pass。driver等UI running十秒超时，**cancel POST=0**；Native随后定位approval onChanged全量刷新/settling锁Cancel，末版修复已落execution/index.tsx并冻结 | 父级bg240覆盖末版静态/Web测试及原B7只读权威刷新，但没有新真实运行中取消验证，不称已解决取消场景。用户停止后未创建A7/B8/6000ms新Run，EJ.summary.finalState无active/unknown自有Run/无在途，观察context全关；自然退出/双成功仍不当取消 |
| S26 **已实现待验证** | I-C恢复journal、I-X/requests | N真实离线禁发送/恢复同对话草稿；EJ.summary.originalUnknownRecovery：原f232f75a… v14/e1 unknown→v17/e2 failed、两原receipt字节相同/0新dispatch；EJ `B-continued-while-browser-offline`及browser B2 offline/reload/reconnect，真实活跃B2在浏览器离线时完成第二read并恢复同Run | 早先A离线时已终态，明确不当活跃恢复证据；B2活跃离线分支现已证，完整停止/重启/取消后安全恢复矩阵仍未齐，不用自动stopped原型语义 |
| S27 **真实通过（权限恢复不隐批、明确拒绝不派发）** | I-X精确审批、I-S授权 | 旧N撤权原键94b1ff21…403/0receipt保留；R.permissionRestoration.passed=true：TASK-1347、Run `f6bef7c4-fc66-4c8e-9cc3-f4eb85263d93`、approval `3486e246-ba6d-4626-8fae-9a5ac61e0863`；reader权限版本10→grant11原页启用→revoke12禁用/冻结approve403→restore13原页再启用但仍waiting_approval/v1/0receipt→显式reader UI reject原键6e4c2cbe… | 拒绝后Run failed/approval rejected/v2/0receipt，任务raw/revision严格不变；恢复基线权限v14、独立context关闭，图native-restored-authority-explicit-rejection.png。这是拒绝/权限语义通过，不是执行测试成功 |
| S28 **真实通过（两独立浏览器原生编辑/CAS拒绝）** | I-V版本CAS、I-P来源图、原native标题框 | L既有TASK-065/外部TASK-067变化409分支保留；R.twoBrowserConflict.passed=true：A真实DeepSeek request `cc3864e8-e6d4-4a7a-8e74-72317eda37d9`→pending提案 `f7b314db-a796-478e-b664-f61ab80d680b`固定TASK-1348/rev7a6e…；B独立页原生标题框明确PUT200保存human title/rev948c…；A旧preview勾选确认后apply原键 `67becfcd-420d-49b4-9b46-6d7c59afa787`实际409/source_version_conflict | API最终raw/revision严格等于B保存，提案仍pending/v1、任务todo，A预览/原文保留。图native-two-browser-stale-proposal.png、native-two-browser-human-title.png；这是实际双页冲突，不再只有API并发，也未强制覆盖人工新版本 |
| S29 **已实现待验证（同snapshot真实并行已证，取消隔离未齐）** | I-X独立Session/沙箱/owned进程树 | EJ A6 1ed72383…/B7 0e0ca746…于04:36:43.546Z在Host50392同snapshot各有真实Node，exe=/newroot/runner-node、两独立run workspace匹配；两test授权原键committed，实际分别7328/7295ms、exit0/各两passed，均succeeded/e1。早先各批真实成功/lease失败及observer误认原样保留 | 同时活着的两个测试进程分支现已真闭合，不再说仅两个排队Run；但该批无cancel POST，仍未得到A真正停止、B同段继续成功的隔离取消结果，不能拿双成功拼取消 |
| S30 **已实现待验证** | I-G原通知＋I-T/Inbox | N.checks `S30-exact-approval-target`：原通知深链Run-0/Session/task/approval `14a4ea60-c4f2-4a78-a620-3fc96ede3a83` 并focus精确审批；T `A08-loaded-post-fix-inbox`见40待审finding/7proposal items/0失败，非伪统计 | 120真实评论源已全部committed，原生通知仅完成40条/每页20与精确目标导航；全120分页和个人已读刷新持久未验，按用户要求停止，不再收集下一轮 |
| S31 **已实现待验证（历史/归档恢复/禁执行已证，原软归档UI细链未独立全验）** | 原生命周期、I-X固定历史、单API禁用 | N TASK-127归档只读/禁执行/恢复同ID；EJ活跃与unknown archive/close各409/源不变；自有TASK-1349/Run98c80766…真实failed后archive/restore/close/archive/delete，源404、原failed输入/4artifact及`native-history:source:deleted`原生UI passed。R.disabledExecution.singleOwner真实唯一4191禁执行、非空表单禁用/B6历史可读，原0637e2b8…503 runner_unavailable/durable rejected、Session/Run全JSON同/0新Run | 原31要求的“先取消一次归档确认→软归档→从归档列表回原任务/历史”未在现证据中独立全链取证，非实际Run取消的同义词；本轮停止，不再补验。真实硬删除历史是额外已证边界，不替代软归档交互。4192共享root失败/撤回readonly与之后正确单owner维护分列，不当通过 |
| S32 **已实现待验证** | I-N、I-P、I-X、I-T、I-G | N.geometry/L已测四surface380@1440/420@1920/右置不叠，N.task1920x1080及executionSwitch为实际1080高/深色，无横溢；L新 `S35-pause-boundary-and-native-read-clarification.planningSharedConversation` 真选中原对话 `9f5de264-c54f-4dbf-a762-0f696e8bc981` v4、mode=plan、宽380/420 | 先前“未选中”是pending读取的过早采样，settled已证同会话，不再列为缺handler缺陷；旧记录保留。完整原浮层/规划按钮及所有页双视口几何尚未全齐，不能由四宽一致扩大整S32通过 |
| S33 **已实现待验证** | I-C/I-X真实能力、I-G设置/空项目原页 | N真实reader/禁写/audit.read可读13审计及字段预览；R.emptyProject：PRJ-007初仅project，无任务/文档/对话/Session，原Agent未选会话禁发送；父级实际预检/原生显式建TASK-534/todo归PRJ-007，记录0Run，截图 `native-empty-project-agent.webp` | 空项目明确创建归属分支已补证；缺provider的独立fixture未启动。图谱Provider500已取得两份React runtime/useRef null真实栈，dedupe后原图缩放及TASK-097导航通过；该修复不代替无模型配置验收 |
| S34 **真实通过（原生移动、授权与历史身份分支）** | I-N原生move＋I-S权限/不可变历史，TASK-001/534各明确分支 | R.moveBranches.nativeUiPassed=true；撤源权限403/源不变、只读目标durable rejected并restore、原Session/Run及4artifact历史项目/下载SHA/ACL、评论关系creation保留各有实际分支；新原UI request `bfc62860-be8f-41ff-bbcc-d41f16358609`7→4 committed→自动目标详情/reload保持，截图 `native-task-move-destination.webp`；request `b87690b7-b378-4cd9-81ed-b382ea2162ff`真实pending时主动离页/issues，完成后不抢路由、journal空/errors=[] | TASK-534最终PRJ-007/revision1495d90d…、历史保留；完整原身份见本页S34表。旧3b49…/b225…两导航失败不删，前两次harness错过pending窗口也不当真验证；仅已列源/目标/对象，不外推跨Workspace ACL/所有权限矩阵或全应用通过 |
| S35 **已实现待验证（任务/消息/历史/长文分支已证）** | I-P原任务集合、I-C消息、I-X历史、I-G通知、原文档 | L `S35-final1200-native-identities-and-complete-long-task`于02:50:26.895Z实计PRJ-006任务1200/unique1200、原键全200；planning-native1200-browser首40→30次水位至1200/无漏重/最早TASK-067可开，TASK-1286请求53640正文完整SHA/尾marker/DOM已证；PRJ-010三组20首15、240消息首30、H首12/8及DOC-003完整长文各有独立证据 | 首40 settled=20784ms是在真实写压力下的观测，不据此宣称流畅性/FPS达标。N现120原键comment命令200、comments.id去重120，但仍awaiting-delivery；120定向通知/首20/六页/已读持久尚未闭合，不以来源写入数顶替通知结果 |
| S36 **已实现待验证（安全undo已证，文档CAS场景模型失败/本轮未完成）** | I-V、原审计、I-T/文档编辑 | L字段apply/safe undo/人工后改priority拒旧undo、12旧审计不变；T.DOC-005及R.DOC-004正常安全undo已证。native-ui-final-handoff.uncompleted.documentCas /native-ui-document-cas-acceptance.json：conversation `cfe71765-d28c-4110-ae28-99dbf58aa50d`、原请求 `7f9e2153-928f-490f-99e3-2012264724eb`已failed/model_request_failed、proposal=null/documentWritten=false，第二模型未派发 | **文档apply→人工改正文→旧undo被拒**未到达，不把模型失败说成CAS保护已通过或已失败；也不拿普通归档undo/任务staleguard替代。全局审计原生UI完整链仍未齐，用户停止后不补请求 |

### J01–J08：完整旅程独立门槛

| 编号/独立状态 | 实现入口与真实对象 | 操作/证据与结论 | 未闭合分支 |
| --- | --- | --- | --- |
| J01 **真实通过（原c33/e28同案发布定位/会话返回/图节点）** | I-P/I-V＋原native看板/Graph | L `J01-same-original-c33-e28-published-mapping-native-highlight-graph097-repaired`及planning-j01-final-samecase.json：同proposal c33a3a0f…/conversation e28f67bb…的MS-003/TASK-096/097映射→原native097 selected高亮/同会话→原Graph58nodes/109links→实际点击097打开正确URL/TASK-097.md及保存正文，pageErrors=[]/consoleWarnings=[] | native-ui-graph097-final.json/png另实测zoom103→122→109/正确原任务标题/errors=[]，不是direct URL替代点击。旧Provider500、双React/onZoom修复、冷Vite/driver早读失败均保留；独立S13案例没有拼成这条原同案 |
| J02 **已实现待验证（要求修改分支真实通过，人工Done正向未完成）** | 原TASK-505菜单/逐标准报告/原Submission与Review | EJ真实0fb65753…→9c965530…原生before-after/checkbox/apply落3标准；明确human PUT febbc630…才改in_progress/rev43716…；正常f370ac7e…实际两pass，当前bade1df6…为pass/pass/unknown。原Submission d3411ffa…/Review e93f3aac…changes_requested/ReturnForChanges cff171ae…200与最终原生delivery history观察passed，原因和逐条pass/pass/inconclusive保留 | 要求修改与当前unknown是已完成分支，不能替代原README正向人工批准Done。用户停止后同TASK-505“两标准新版本/新Run/新报告/新送审/批准/Done”计划取消：只有一次未保存编辑超时、已关context中止typing，最终仍3条标准/rev43716…/in_progress，无Done、无保存重试 |
| J03 **已实现待验证（当次合格报告/人审ready已证，完整人工Done链未完成）** | 当前版本可信来源→明确送审→人工完成/原看板 | B5 2a8294ce…实际两pass/完整测试来源，当时两标准报告560558d4…/rev77a…current=true；两源按钮及03:29:50人审a028f829…ready/当时todo真实。之后原生加入第三标准使旧报告UI stale/ready disabled，当前bade1df6…三条为pass/pass/unknown/current43716…，没有伪造外部观察 | 原README109/119/182要求三条真实来源/合格当前报告→明确送审→人工批准Done→Done列定位高亮/活动，不能以两个测试＋ready缩减。该正向整链未运行；用户停止后没有删除合成第三条、没有新Run/报告/批准或Done。本编号不再提前PASS，旧560历史绿色仍保留 |
| J04 **已实现待验证（真实修复/退回已证，原整链未全闭合）** | 原失败/缺口→私有修复→新版本复查/人审 | 旧B2真实exit1/两失败/4b0c1b2b…及B3/B4测试过但e90…unknown保留；0041后B5有当次完整两标准passed报告/来源/ready，后正常f370ac7e…a+b/原tests实际两pass，当前第三外部标准保持unknown；原PM changes_requested/意见/ReturnForChanges与最终原生history已实际看到 | 原README110/183还要求同输入修复后复查通过→明确送审/填写意见退回并保留失效证据，不能拼旧两标准绿色与新三标准unknown当完整正向复查。未声称生产合并/部署或自动Done；用户停止后不再开下一轮，状态保留部分已证而非整项PASS |
| J05 **真实通过（失败与部分证据不涂绿）** | I-X/I-S，TASK-504失败Session | EJ.summary.verification /browser `A-partial-report:report:failed-with-unknown-criteria`：原Run `faaf6e2a-2c42-4f4b-889a-af73b252c2dd`仅部分真实read后lease失败；实际报告 `fd38900a-ca51-4ebf-969b-de031741e611` failed，TASK-504-AC-1/2均unknown，UI逐条解释缺completed run_test receipt/无可信Host基线，任务仍todo | 截图 `execution-journey-A-partial-report-failed-with-unknown-criteria.png`；这是失败处理语义通过，不是工具测试通过、成功交付或人工送审完成 |
| J06 **已实现待验证（成功报告失效/未知标准已证，真实停止待）** | I-X/verification、原Task标准菜单/人审 | EJ原生采用3标准后旧passed560…实际UI freshness=false/ready disabled；明确human start→正常f370ac7e…两测试passed，但新bade…标准依次passed/passed/unknown、当前revision43716…/current=true；原PM changes_requested及ReturnForChanges200/Task in_progress真实记录。早先TASK-504 failed报告因来源变化失效、B2活跃离线/刷新同Run恢复另留 | 不再称成功报告后的标准变更或unknown未跑；外部部署无观察不改为passed。真实运行中停止/取消及其恢复边界仍缺，不用自然退出、lease失败或双成功替代；旧报告/审阅都保留 |
| J07 **已实现待验证** | I-G原文档/通知/搜索/审计/设置＋I-N | F无原文件丢失；N原文档/原审批深链/真实设置，readonlyAuditPreview原动态13审计；新增N.originalSearch：1920×1080原全局搜索TASK-128→实际 `/issues?entity=TASK-128` /正确标题，dialog关闭、nonReadNetworkRequests=[] | 搜索分支现已补证，不再保留“对象搜索未跑”；原全部工具/设置/审计与双视口巡检仍未齐。审计只公开白名单字段，不补造正文差异，不移植Studio工具层 |
| J08 **真实通过** | I-G原设置＋AgentSettingsPage | N.checks `J08-actual-capabilities`真实deepseek/Host能力，无DEMO开关或人工通过数；M真实模型；正式业务证据来自Markdown/SQL/Host | 测试fixture/Lab不是正式产品fallback；本地PR草稿不是远端PR |

### P01–P24：真实来源与结果独立登记

全部P条目入口为 **I-T/Pulse→FindingReview→原生提案**；来源判定在 `packages/application/src/studio-automation*.ts`，规则结果与Worker扫描写SQL，业务修改仍走I-V/Markdown。下表的scan/preflight是**AutomationRun**，不是执行工具的ExecutionRun；只读preflight有dryRun审计不意味着实际派发、模型执行或业务写入。仅存在候选的行不声称候选已经发布。

| 编号/独立状态 | 本轮真实操作与对象（I-T；特别入口另列） | 可定位证据与结果 | 未闭合分支/前提 |
| --- | --- | --- | --- |
| P01 **真实通过** | PRJ-002 TASK-030/032相似；finding `e2826fa1-3575-43f0-b782-050358d209bd`，提案 `8dc3c7d7-6ecf-4649-80cf-7d06d3df420d` | T.scenarios.P01、observations `P01-real-association-review`：明确应用关联再undo；任务总数8→8，无合并/删除 | 仅相似建议，非已证重复 |
| P02 **真实通过** | 实际TASK-036更新；TASK-093 Level2 finding `cdb77184-0c3b-4c41-ad9a-b0b52395116a` /提案 `8f002574-cc09-463a-bf5d-0a2764f6c909` | T.scenarios.P02、`stable-task-event`、`Level2-auto-pending`：后台真实发现、自动pending但任务revision不变；人工review提案另有apply/undo证据 | Level2不自动应用/发布，Level3未开放 |
| P03 **外部前提阻塞（现实7天）** | 新持久任务preflight `556b3a98-49e7-4b4e-a01c-3443010c9d8e`，当前正确零停滞finding | T.scenarios.P03、A13两次真实续接；T.controlledBoundaryChecks.parentEvidence的artifact://1154:44由父级实跑受控7/14天边界通过 | 未回写业务日期，真实≥7天无活动/评论/会话/Run尚未经历；受控时钟通过独立登记，不冒充现实长期观察 |
| P04 **真实通过** | TASK-014实际done，TASK-030依赖满足；finding `a03da06b-ed82-4df0-b1de-9a9c1a0fe56a` /提案 `5fb4be9b-d2f0-4d19-850a-09aacf67670e` | T.scenarios.P04、`P04-real-workflow-review`：人工应用todo→in_progress，明确undo→todo；未自动完成 | 沿当前配置工作流，不强套原型Backlog/Todo枚举 |
| P05 **真实通过（当时当前源→建议→明确人工ready，不自动Done）** | B5当前版本成功源→Finding/followup→逐标准人审 | T.scenarios.P05.actualFollowup/EJ：B5 2a8294ce…/当次passed560…，proof63f5fce3…、正式scan91a628a6…/Finding `1482720d-7703-489b-8a8d-d5c89b4f9267`，实际点两项followup GET→精确当前Task/Run/Revision、两源按钮及03:29:50人审a028f829…ready/HTTP200；当时TASK-505仍todo | 初次selector等待超时保留、后精确report URL成功另列；03:48后明确human PUT febbc630…才改in_progress/rev43716…，旧Finding当前409是正确来源失效，不再声称其仍新鲜。policy r4不清计数，不复用旧TASK-001 Finding；原PM交付UI完整性另归J02 |
| P06 **真实通过** | PRJ-002 TASK-030/034及声明`src/shared/`与依赖交叉；finding `08cc6376-627e-4119-948d-1ec03543f774`等 | T.scenarios.P06，preflight `906927e0-1b57-485c-aead-ea41caf13e4f`、真实scan结果保留任务范围和create work_item协调候选 | 候选未发布，不自动判定冲突或改依赖 |
| P07 **真实通过（私有来源活动/跨rule去重＋同Level1人工保存）** | TASK-092/真实Run90fb…→原生私有活动→原文档 | T.scenarios.P07.nativeActivity及documentConfirmation.completed：两manual/daily1 Worker轮次仅同actor/private audit1624/changes=[]/版本null/跨rule同id和observedAt，真实原TASK-092活动行已见，24日23:12执行与25日03:36观察分开。始终Level1/r5、同Finding `afe6f097-6fa7-47a4-83eb-70d5069272b5`/proposal `d594d114-3308-4f47-874a-b6e8b59c9cb6`真实UI prepare/edit/未预选checkbox→明确保存DOC-006/active、revision ec6376a226432f4d3edc79f8d543befd8df9a94acb02aab763e78ef8ce60babe | prepare c8d73c7f…/edit0377d8fd…/applydf23906c…均预存native journal并匹配committed，原Task raw/revision/status及policy不变；截图见T.scenarios.P07.documentConfirmation.completed.ui及p07-real-native-task-readonly-source-activity-1920.png。旧409/req-4ju和旧项目零活动保留，不借临时升2或P13冒绿；不声称范围合规、远端部署或完成任务 |
| P08 **真实通过** | H0旧Run `4d6db289-42ef-4584-a541-b963eb4ad211` pre-tool失败；finding `70191f65-7f51-4e53-a4fa-d73fd4b6809a` | T.scenarios.P08：scan fee83cb9…生成调查候选，保留`runner_generated_plan_invalid`原错误、明确没有测试/file receipts | 这是实际计划校验失败，不说执行过失败测试；实际测试失败另见P12/P17 |
| P09 **真实通过** | 对话 `5ee16af7-1b4b-4110-b628-ae3640ab7148` / `92d4a4f5-c560-4c59-a369-85a74d15e92d`明确遗留；finding `d24be794-fa7f-4294-b079-4bf698144413` / `8e87b279-376b-4359-8001-b303817d9724` | T.scenarios.P09、`real-model-discussion`、scan `35d785bd-28f4-473d-ab95-9067779e8241`：真实持久原话来源/未发布候选 | 指来源检测与候选，不替代S09消息操作到规划往返 |
| P10 **真实通过（public只读来源/缺口/正式轮次及复验）** | public PR `github:octocat/Hello-World#11615` /head `4b7742b6990db517792180639a9b1d67c521ab2c`；TASK-003；原rule b7c25993…r3/daily1 | T.scenarios.P10：原正式Run0de100e7…匹配1/复用finding `e7c369cc-cf20-4c70-82b7-cf2c18d629b0`，第二Run9512adbe…预算skip；新T.sourceFixes.workerCompletionClock.liveRecheck源02:04:11.609Z真观测/到期02:14:11.609Z，当前来源再检查Run `f94838fe-0702-4419-ad46-0dff373d2b62` completed，02:05:09.850Z→02:05:34.065Z（+24215ms），匹配同finding，任务/原policy r4/daily1规则DTO未变 | 新复验是当前来源再检查（automationId=null/ruleRevision0），不冒充重跑原daily1规则；原正式Run负时长-6784ms及原note `be20d925-b97a-46fb-9fed-01f76d550f1a`字节不变保留，修复凭真实新轮次关闭，不改旧审计。public不是private、无CI检查不等于CI通过，旧403/过读失败仍留 |
| P11 **真实通过** | Run-A/B同可信source identity/baseline且实际时段重叠、sum.cjs真实diff交叉；finding `25e7d506-ea64-48e8-a7e2-7c8a68ce6deb` | T.scenarios.P11、`P11-fresh-current-finding-and-stable-rescan`：proof `9a9f947c-6e74-43fc-b0a0-bc90566fd84f`，scan `fcbb6161-23dd-4b22-a5c6-8c1f0c97af02` / `51cefc70-b7bd-4e56-ae3a-f064771cd745`同指纹同finding；来源深链到TASK-028/原Session | 旧lease版本引起的重复历史不删；新语义去重已真实复验。只提协调风险，不声称发生主目录覆盖或必然冲突 |
| P12 **真实通过（共同假设→明确独立Run→精确批准/实际失败保留）** | 多Run同名失败→I-T/followup→I-X，不自动执行 | T.scenarios.P12.actualFollowup/EJ保留finding `76f10c56-066c-4489-b524-93045854f958`两原失败Run81540648…/8612b6b6…、可编辑hypothesis/回原工作台草稿；明确新Run原键 `45361969-f070-4745-a336-dc086b912bfe`→独立Session `23b19a18-857d-4923-a0f1-8e9622c65767` /Run `7b2ebca4-0904-437e-b6aa-d23500637d99`，先waiting_approval/0receipt；approval `9273969b-d4ec-41bc-9ab4-2e4ba5ac98e9`原键c22d845c…于04:01:14.331 consumed，先于dispatch .333 | 唯一op=dfb9546e…run_test，receiptcccca7b4…真实exit1/两失败/e1终态failed，TASK-090原pin/raw未改、无write/无Done。stopped=true仅进程已退出，不是取消；没有宣称根因已证或已修复，旧只读prepare/导航零执行与后来明确执行分开 |
| P13 **真实通过** | 两真实对话明确决策→来源化document候选→明确保存/撤销 | T.scenarios.P13原finding `ab3c536b-8247-4d32-94d1-fd0a87c04aa2` / `6fa3de7d-1de5-439c-b0c8-72e0176a5cdb`；新A07.documentBranch从前者形成proposal `1ebce627-fbdf-41b7-9a09-fdd8f82bf2d8`，人工改标题/正文及真实来源ID，明确保存原生DOC-005，再显式safe undo；两原operation committed，正文/历史保留 | DOC-005当前archived=true、proposal undone；不是“从未发布”，也不把保存讨论文档说成决策已执行。native标题前缀造成原raw比较false的精确差异保留，详A07 |
| P14 **真实通过** | Run-D在TASK-092声明docs/外真实修复sum.cjs；finding `bb0474fa-39ba-4a6a-8602-2b9b4c41923f` | T.scenarios.P14、`P14-P23-actual-diff-and-artifact-provenance`：实际before/after、下载SHA核对、源revision匹配；scan b2c4b45d…生成范围复核候选 | 未自动回滚代码、未改任务状态；受控沙箱不等于用户原代码目录被改 |
| P15 **真实通过** | TASK-036历史 `93797fb605ba1fc394e296493deecf3fc65be2c41c34ec21deda18f6c80b018f` → 当前 `f0449d9c53a871094936e7e813e090e10cfcbbbb1dbcc1509be56d786b3b2d9f`；关联TASK-038 | T.scenarios.P15补正：真实WorkerRun `1e2f79f5-82d0-4279-ac44-0dc925c816fa` completed、finding `c834080e-3f49-4a54-8889-1d5ea7787149`，影响document候选含原文/当前/下游来源 | 早期空preflight `6597d587-bccb-4973-9044-168dfde64d34` 不是阳性证据；文档仍未发布 |
| P16 **真实通过** | 两真实授权对话重复明确技术主题；finding `f72daa44-3392-4647-83ca-858d09b65291` | T.scenarios.P16，scan35d785bd…持久知识document候选，sourceIds为两真实conversation | 不靠虚构Session数量或demo文本造主题 |
| P17 **真实通过** | TASK-090/091的Run-F1/F2跨任务共享实际失败断言；finding `b708ca16-b58d-42e4-b219-3af9e34716b2` / `86775875-105c-451f-a9f7-9953bb72da87` | T.scenarios.P17、`P17-current-source-acceptance`：scan b2c4b45d…，证据任务/Run/命令/失败断言完整，生成共性调查候选 | 未证明根因、未自动执行修复 |
| P18 **真实通过** | MS-001真实完成及TASK-014/030下游；finding `3ddbf92b-17bd-47ac-aac5-5af272a95adb` | T.scenarios.P18、`P18-native-reviewed-publish`：提案 `8726d096-8b1d-4966-9ef5-407e1172a68d` 人工编辑审核后发布 `TASK-126` todo/PRJ-002，同原键仍同ID | 正式任务是明确人工发布，不是发现即自动建项 |
| P19 **真实通过（空源零日报/真实跨日未审源）** | I-T只读preflight、PRJ-009空源及既有真实HostRun | T.scenarios.P19.deployedRecheck：0041后03:12:11.959Z proof `2adcfce2-9dc5-4b01-8e52-6ea3fd709b3f` /dryRun `1bfa5325-f357-4274-93df-3cf1e4129f28`，空PRJ-009 findings=0/conversation=null/native不变；03:12:15.231Z proof `b2974e08-fb03-431d-a4e9-00bf2fb002ee` /dryRun `fb595676-8616-4ecf-b6f3-12a703fa62b8`匹配1，来源含真实10-24未审失败Run-F1 8612b6b6…/F2 81540648…及其他当前事实 | 旧02:31 proof5d53fb20…/dryRune0b70566…仅project却匹配1的失败原样保留，未正式发布。新鲜源重评实际修复关闭；未伪造日期/审核/模型答复。父级受控空源/UTC/跨日回归另见T.controlledBoundaryChecks.parentEvidence artifact://1154:25,46,47，不混为现实日期 |
| P20 **外部前提阻塞（现实14天）** | TASK-034真实被未完成TASK-030阻塞；preflight `69e4e8d9-170b-4f56-a405-5a13d3c50670`正确零≥14天finding | T.scenarios.P20；父级受控7/14天边界实跑PASS定位T.controlledBoundaryChecks.parentEvidence artifact://1154:44 | 未倒填createdAt/updatedAt，现实≥14天无进展尚未经历；受控通过不变成现实长期正向，零预检也不标阳性通过 |
| P21 **真实通过** | MS-002未交付、TASK-030未完；finding `6da0a01d-4afb-4e87-8168-613e71924145` | T.scenarios.P21，真实scan保留milestone/task revision及发布风险document候选 | 只记录风险，未宣告可交付或更改里程碑完成状态 |
| P22 **真实通过（两次原生visit/不重放＋隔离水位回归）** | 原生页面访问→独立Worker→Since You Left | T.scenarios.P22.nativeRepeatVisits：dispatch前已持久原键native journal/安全日志；真实UI两visit对应Run `131129fa-4968-4c2b-b6e1-8a6d534c45d2` / `6b010c15-85e9-4d39-bea1-82d35840b5c8`均completed/原receipt吻合，首次新P22 finding `b9cf10ac-dd38-4d9d-9b45-46233ba3d62f`、第二次无P22重放；旧11d5ade6…保留 | 正常live重复访问已闭合；GREATEST防回退及future fingerprint/watermark反例由父级真实隔离PG/HTTP病例PASS，T.controlledBoundaryChecks.parentEvidence artifact://1154:26,48。future水位仅隔离测试DB，不写生产未来日期；journal只存恢复键，不是localStorage业务事实库 |
| P23 **真实通过** | GOAL-002/TASK-092当前未完成且实际Run-D diff超docs/目标范围；finding `06362b85-417a-4819-abfb-29e49c3b6ffe` | T.scenarios.P23、`P23-current-source-acceptance`，proof `a8d94b58-1731-492e-95a5-fa67adb5385a`、scan b2c4b45d…生成下一步规划候选 | 使用真实文件变更；未自动发布，非按Session计数猜偏离 |
| P24 **真实通过** | GOAL-001/TASK-030、done依赖TASK-014、明确下一步；旧finding `c66ac4ea-8260-47b3-b276-08f0418e2937` /编辑拒绝提案 `a31c92ec-a312-4d65-9c02-4538becc57e8` | T.scenarios.P24.restoredSourceRecheck：部署后proof `b24d3e39-4082-403c-b8f8-0c98f1556257` /dryRun `2a026e33-d915-4d94-8868-e5514ace364f` 实际恢复revision `56a12cb2825ec7e1b290b026b27fa2b3b8f82e9fed4ddb697c14f70816a3c822` 匹配1，目标/任务来源完整，native前后同revision/todo，未发布 | 早先真实候选编辑/拒绝已证；本次只读复验关闭undo后来源隐藏回归，不声称新正式任务已创建。旧0 preflight `854cbe46-d0f8-454e-9ceb-7953b6e52a2f` 永久保留，不以新1覆盖历史0 |

### A01–A14：自动化交互与后台时序

| 编号/独立状态 | 实现入口、实际动作/对象 | 可定位证据与结果 | 未闭合分支/限制 |
| --- | --- | --- | --- |
| A01 **真实通过** | I-T总览/运行/待审；PRJ-002真实规则 | T.automationScenarios.A01、`automation-overview-1440.png`、`automation-inbox-loaded-1920.png`：规则状态/触发/last-next/需关注数来自服务；数量有服务页范围标识 | 不把当前页统计冒充全库 |
| A02 **真实通过** | I-T/RuleEditor；原规则 `8845a5bd-b9ee-4122-9630-34f241344d8b`、副本 `514af51d-c431-481b-807f-cf00be74139f` | T `A02-A05-save-readonly`、`A02-rule-controls`、`exact-current-source-proof`：真实保存/复制/修改revision2/删除、paused状态及旧proof409；未保存表单往返保留 | 自然语言指引是记录的审阅上下文，不冒充任意模型/代码调度 |
| A03 **真实通过** | I-T新对话模式，Worker task-event/daily | T `stable-task-event`、`daily-worker`、objects.dailyObserved：正式completed检查各有真实conversation、runId与不可变input | 触发为结构化后台事实，不伪装用户消息 |
| A04 **真实通过** | I-T继续对话 `5ee16af7-1b4b-4110-b628-ae3640ab7148`；两run `d07dd4c6-4b66-4315-95d3-7265addf2ac2` / `9ce0c115-b67a-4976-93e4-24bd252fe043` | T `A03-A04-A05-A13-continuation`：只读测试2→2条，正式两轮后4条；`A04-invalid-continuation`缺失/跨项目404且无替代新会话 | 此成功只证续接，不证明已经历7天停滞 |
| A05 **真实通过** | I-T保存/只读测试/预算跳过 | T `A02-A05-save-readonly`、`post-restart-readonly-preflight`：任务revision/对话数/ExecutionRun数不变，providerCalled=false；真实daily/cooldown跳过无conversation | 可持久保存dryRun审计/proof；不是“完全无任何数据库写入”，更不是工具执行成功 |
| A06 **真实通过** | I-T/RunWorkspace三栏；activity/conversation/input切换 | T.automationScenarios.A06、`browser-native-automation`，1440/1920实际截图 `automation-run-{activity,input,conversation}-1440.png` / `automation-run-activity-1920.png` | 历史缺输入/耗时显示未记录，不用当前配置补造 |
| A07 **真实通过（三类输出与版本保护）** | I-T/FindingReview→I-V；字段、文档、规划候选 | 字段apply/undo/staleguard/P24恢复源、P18编辑发布TASK-126/P24拒绝已证；DOC-005 proposal `1ebce627-fbdf-41b7-9a09-fdd8f82bf2d8`真实人工edit/apply，原键 `85358d71-04ef-4c38-b639-20fd95072a5a` / `493b1d89-8d10-4050-bd6a-a8b0bf65711b`各GET committed；undo后archived=true/body保留，TASK-003/030及policy r4未变 | 原bodyMatchesReviewedDraft=false不隐去：UTF-16长度221/288、完整原文offset67；UTF-8实际457/525字节、起点68。差异为原生标题前缀，不称raw相等，完整正文有verbatim证据；不扩大为S36后改文档拒旧undo、工具执行或任务完成 |
| A08 **已实现待验证** | I-T/AgentInboxPage | T `A08-loaded-post-fix-inbox`：真实40待审finding/7pending proposal items/0失败AutomationRun，1920宽无横溢且来源/审阅链可见 | 当前实际失败计数0；不能造失败凑数，失败运行入收件箱分支尚未有阳性数据验证 |
| A09 **真实通过** | I-T人工审阅备注，run `d07dd4c6-4b66-4315-95d3-7265addf2ac2` | T `A09-inert-persistent-note`：人类备注刷新持久，对话message数4→4，无新Run/模型回复 | 备注不触发调度 |
| A10 **真实通过** | I-T当前来源重查 | T `dismiss-dedup-recheck`保留finding `5f2458ca-095a-4b08-b8f1-1223fee63b48` 忽略与去重；`exact-current-source-proof`变源使旧proof409；新增P24.restoredSourceRecheck用当前恢复revision匹配1且native不变，proof `b24d3e39-4082-403c-b8f8-0c98f1556257` | 当前源恢复缺陷已通过新真实只读检查闭合，不伪装历史事件重放；旧0结果不删，权限/策略/冷却/预算边界仍沿用实际已验guard |
| A11 **真实通过** | I-T编辑→历史→编辑 | T `browser-native-automation`、`A03-A04-A05-A13-continuation`：未保存规则query/续接选择保留，第二轮改指引后首轮输入仍保留旧文本 | 不用当前配置伪造历史 |
| A12 **真实通过** | TASK-036真实原生正文更新→独立Worker→新审阅对话 | T `stable-task-event`、scenarios.P02/P15、eventRule `54d02aee-cacd-4fd1-aa32-792bf41269f9`：真实发现/版本及任务深链持久 | 无DEMO来源注入，未自动应用字段 |
| A13 **外部前提阻塞（现实7天）** | 手动规则 `31017909-f279-48db-8d38-8fa76f97c60e`，A04两次真实续接 | T.automationScenarios.A13、`A03-A04-A05-A13-continuation`两次独立input/result，当前新任务停滞finding=0；父级受控7/14天边界实际PASS见T.controlledBoundaryChecks.parentEvidence artifact://1154:44 | 续接已真实通过；“停滞≥7天”现实观察未满足，受控测试单列、不倒填业务时间 |
| A14 **真实通过（调度/通知/预算语义）** | 独立Worker，规则 `4e23e5b9-b4dc-482e-b25a-3120c909d15c`；成功通知Run `819153f2-2125-4d4f-b3c0-854bbd0824eb`；09点到期Run `fc0562e5-9fb1-4976-bde8-1e3be1e0c85b` | T.automationScenarios.A14.actual0900Boundary：真实due key2026-10-25T01:00:00Z、实际01:00:00.126Z（上海09:00）识别并合法skipped，同当地日dailyLimit1已由关页后真实06:09成功通知用完；无新conversation/model/tool，规则重启保留/nextDue=10-26T01:00Z。父级受控精确09:00UTC/不提前触发PASS另见T.controlledBoundaryChecks.parentEvidence artifact://1154:29 | README同时要求摘要/来源及真实每日上限skip；这里成功通知是06:09，09:00真实分支是预算skip，**不声称09:00摘要或模型执行成功**。受控clock与两次真实壁钟观测分别保留 |

### 不能合并掉的失败、时间与隔离边界

1. **Provider500旧观察/新诊断/真实复验分层**：旧Query52单例及U稳定/warm/storage未复现继续留档，首次参数/响应不全，不声称独立闭根。新J01 Graph097双React runtime/onZoom render-phase setter已定位修复；native-ui-graph097-final和planning-j01-final-samecase在原c33/e28案真实节点点击/正确正文/zoom103→122→109/errors=[]完成正向复验。旧失败仍留，不把后续成功删除历史、也不无证声称旧Query52与新Graph必为同根因。
2. **真实Host失败/unknown原样保留**：H0总体failed；R有pre-tool计划失败、旧epoch/unknown及原write receipt。R.sourceRecovery仅按原operation核对，无新键/重复效果；Run-0、Run-A/B后来成功不覆盖旧事实。`stopped=true`在实际测试receipt意为进程已退出，不等于用户取消；旧核验解释缺陷报告保留，新的passed报告有不同ID。
3. **GitHub历史错误保留，时长缺陷凭新真实轮次关闭**：原0de100e7…负时长-6784ms及note不改；0040/Worker时钟修复部署后，当前来源真重观测与Run f94838fe… +24215ms、同finding/任务不变已复验。P10可按public只读/缺口/正式轮次＋当前来源复验独立通过，不把新recheck称原daily1正式规则重跑，不删除旧403/过读/负时长失败；private/CI通过/远端PR仍无此声明。
4. **撤销后源可见性回归已具体复验**：旧P24/A10 preflight `854cbe46-d0f8-454e-9ceb-7953b6e52a2f` 零匹配保留。部署后新proof `b24d3e39-4082-403c-b8f8-0c98f1556257` /dryRun `2a026e33-d915-4d94-8868-e5514ace364f` 在原恢复TASK-030 revision匹配1、native前后不变，因此关闭该缺陷；不是因源码/部署本身改绿，也没有伪造正式Finding/任务。
5. **7天/14天/09:00证据分层**：P03/P20/A13缺真实成熟且持续未活动的7/14日来源，不回写日期；父级artifact://1154:44的受控阈值unit snapshots已PASS，但不是生产日龄或受控runtime-PG阳性。:29为受控Asia/Shanghai09:00精确UTC/不提前触发；A14真实09:00是同日预算skip（fc0562e5…/01:00:00.126Z），06:09才是关页后的真实成功通知，不能称09点新模型摘要成功。
6. **55433误继承与精确回滚**：E只记录本轮误建 `userId=33b325e7-511a-4167-a32f-4b2c2e5efe6b`、`workspaceId=0d1ea6a4-f169-4a0f-88ca-abec90984416` 已被精确移除，随后使用55440和本轮正确主体/工作区、子进程环境allowlist。它不是整库逐表差异报告，不把“其余所有业务数据未动”写成额外独立核验结论；仅引用记录的精确清理边界。
7. **最终检查不继承历史**：本文档责任人未运行build/test/lint/formatter、未重启服务、未新增业务写入；源码/真实应用验收由相应owner负责。根README及旧backend-delivery中的历史检查数不作为当前增量全量通过。最终统一检查及尚未完成的真实场景由父级逐项附证，不能用本矩阵的实现入口替代执行结果。
8. **旧长正文未尝试与最终完整保存分开**：旧checkpoint `S35-long-native-body.fullRequestedBodySaved=false`同时attempted=false：当时第1199任务尚不存在，`!lastFile`比较为false，不是截断观测。新最终TASK-1286真实保存请求53640字符，canonical body53681、请求与实际片段SHA均5a3f6cbf…、尾marker/DOM完整，见L最终checkpoint和planning-native1200-browser；旧记录保留。DOC-003及6806消息另有独立正向证据。

9. **history旧恢复阻塞已按原身份闭合，通知另列**：旧`host-history-reconciliation-blocker.json`的reported=true/outcome_unknown及停写记录保留。H.runs按原Run `f232f75a-5e83-4077-9669-36b24d8ab1c0` / `11b13f82-06b5-43de-bad0-e0828570d4eb`核对，现均failed，已记录effect保留、未发动作未执行、testExecuted=false；第三Run `ac386ae7-1c44-4497-ac8d-c3438f212e59`同样真实lease后恢复失败，不能冒充测试失败receipt。H.proof所有原键settled：168committed＋原审批`24e7cd87-ebbd-4da5-b567-77eaa2ade5d2`真实rejected；没有新身份遮盖旧错。通知503/404及not-sent边界不因history完成而消失。

### 父级统一检查：已观察结果而非门槛完成

| 检查/证据 | 实际结果与适用边界 |
| --- | --- |
| 全backend `node --env-file=.env.test --test --test-concurrency=1 apps/api/tests/*.test.ts apps/agent-host/tests/*.test.ts packages/*/tests/*.test.ts tests/*.test.ts`；`.local/evidence/backend-full-before-final-fixes.log`、R.checks `full-backend-before-final-fixes`（会话副本 `artifact://485`，汇总534–541/实际失败545–603） | 外层3600秒超时/中断；Node汇总499 tests、413 pass、**2 fail、84 cancelled**、0 skipped、duration3598856ms。不PASS，也不能把全部取消称独立断言失败。 |
| 实际断言失败1：`apps/agent-host/tests/runner.test.ts:24`，`model digest markers become hashes of exact generated bytes before approval` | 旧测试输入的expectedSha256/command/expectedDigests被新strict生成计划schema拒绝（Zod unrecognized_keys）；修复与之后受影响检查尚待父级证据。 |
| 实际断言失败2：`tests/account-recovery-worker.integration.test.ts:41`，真实SMTP DATA挂起时独立Worker心跳 | 约39.5秒后`Owned Worker did not reach expected committed state`，until第47行/Test第49行ERR_ASSERTION；这是独立失败，不归入84个parent取消。 |
| CLI默认真实连接；`.local/evidence/cli-default-origin-smoke.json` | `node packages/pm-cli/index.ts task list --project PRJ-004 --q "Repair positive"`，未给API override、默认4191，exit0/stderr空，读到TASK-026；只证明该CLI读取，不扩大为全部CLI/全backend通过。 |
| 被替换的全backend bg_201；R.supersededBackendCheck / `.local/evidence/backend-superseded-bg201.log` | 父级因源码/0040迁移变更主动cancel，未有最终失败堆栈；不是全suite通过，亦不取代前一轮499测试的真实失败/取消。后续共用迁移advisory lock的检查串行，不把锁等待说成业务通过。 |
| S3存储历史失败与最终真实结果 | 旧真实MinIO HTTP507/XMinioStorageFull与根盘仅6.7G/879G记录保留；后改用本仓数据盘`.local/check-tmp`，未降低安全阈值。最终bg237原始输出795–802行已实际通过必需真实fixture、0/1/8MiB字节、条件冲突、丢响应原键核对、流损坏拒绝、Local→S3迁移及空安装SQL绑定；这些存储检查通过不覆盖该套件另外2项失败。 |
| Host本地工具/adapter/protocol；`.local/evidence/tested-source-artifact-smoke.json`、父级bg_219 | smoke passed=true：真实两断言、pinned未改test留产物、changed/missing/symlink拒绝、原fixture不变；scope明确无API/SQL/DeepSeek及业务Run。另父级报告Host/protocol27pass；二者均不能代新服务端provenance或J03/P05完整运行。 |
| 父级bg_222、bg_224 | bg_222原46tests/41pass/5fail保留；automation13集成＋22domain相关全PASS。四个outbox fixture生命周期修复后bg_224全部5pass；剩余source-artifact HTTP503/SQLSTATE23514由0041修复，运行库已部署且新B5完整test-source/当次passed报告实证。旧五失败不改写；最终全backend结果见独立bg237记录。 |
| 父级bg_223/238与本轮最终bg_240 check:web | 旧记录保留；bg23842tests/lint/tsc/build PASS及artifact1385早于最后execution/index.tsx审批settling/Cancel改动。父级随后bg240对该已落地修复收尾，lint＋42tests/0fail/0skip＋tsc/Vitebuild PASS、artifact://1470；原B7只读“读取权威状态”GET200/v7、pageErrors=[]/Studio写=[]/无新模型Run报告另见R.finalShutdown.finalReadOnlyRunSmoke。既有largechunk/ineffective import警告保留；不冒充实际运行中取消或全部业务场景通过。 |
| 本轮check:docs失败与链接修复 | 旧ADR explicit anchor unresolved失败保留，父级仅改为真实ADR文件链接，未改ADR本体。文档owner冻结后父级已实际运行check:docs，通过77份Markdown、27个plan steps及domain references；40条仓库外可选链接不纳入可移植检查。后端测试结果另列，不以文档检查代替。 |
| 新全backend：父级bg_229 **主动停止，非PASS** | 曾以最小环境/data2 TMPDIR/必需真实MinIO及pg_dump-restore串行、无工具截止时间运行；父级因新发现P07 Level1人工确认被硬2拒绝的真实语义bug需永久修复而主动停止。不是新的完整通过，也不冒充工具超时或单元断言失败；后续冻结源码再统一检查。运行55440已到0041，原55441测试DB/迁移窗口仍由父级统筹，子agent不擅自migrate/tests/diagnostic。 |
| 父级bg_236、最终完整bg_237 | R.level1Regression：backend lint/type/build/contracts（109 commands/140 paths）及真实PG/HTTP automation＋domain37项通过。R.finalBackendRegression/bg237最终902项、900通过、2失败、0取消/跳过，退出码1，原始输出artifact://1367：`packages/host-protocol/tests/openapi.test.ts:37`产物数量断言实际49/预期20；`tests/task-comments.integration.test.ts:124`普通属性跨项目移动实际409 explicit_task_move_required/预期200。运行总时长约93分钟；按用户要求不再修复或重跑，不能用已过增量检查覆盖完整套件失败。 |
| 4192不支持的共享root试验与正确单owner维护 | R.disabledExecution.unsupportedTopology明确withdrawnReadonlyClaim=true/notCountedAsDisabledGuardPass：副API GET也可scan/observe写元数据、实际POST503/PERSISTENT_STATE_INVALID，已停/未blind换新键。随后singleOwner.passed=true按“停原3→唯一4191禁执行→停止禁用API→正常3恢复”完成；原键0637…durable rejected，Session/Run全JSON严格相同/0新Run。仅记录该边界，不把它扩成其他业务数据整库未变；NoModel副实例必须独立DB/nativeRoot/物理mountedroots。 |

### S17/S35 保留的精细分支（不得以“有界/可筛选”泛化替代）

| 分支 | 不缩减的接受标准 | 当前已观察/未观察边界 |
| --- | --- | --- |
| S17-查询词法 | ID/标题/描述/负责人/标签关键词；引号短语；裸P1优先级与text:"P1"字面文本分开；字段/别名大小写不敏感 | L settled24例的ID/标题短语/标签/裸P1与text字面量/大小写字段均实证；planning-group-consumers-browser同TASK-1287同revision将显示名旧预期1实际0复验为带引号匹配1，原负责人UUID/仅标签词亦各1；仅正文text:"not a model reply"真实匹配60/首40。旧0及早期consumer不可点击错误留档，不以ID替代显示名，也不把重验改成首跑通过 |
| S17-布尔 | NOT > AND > OR、空格AND、括号；原生下拉筛选与表达式相交；刷新保留查询且筛选不改原选择 | L settled24真实UI：spaceAND=26、AND-before-OR=26、NOT-before-AND=52、括号NOT=0；原生todo下拉26、todo∩advanced inprocess=0，selectedStill2=true，刷新query preserved=true；errors=[]/writes=[]。这些具体分支已证，不再统一写全未跑 |
| S17-时间/错误 | created为可信UTC创建日而非更新时间；>=/<=/闭区间、闰日/UTC日界；未知字段/状态/优先级、无效日期、倒置区间、不完整语法有字符位置且零匹配/禁全选 | L settled24的52项created上下界/合法2024闰日、非法字段/状态/优先级/2023闰日/倒置区间/尾AND/未闭引号定位零匹配已证；新planning-real-UTC-browser真实created:10-24=425、10-25=775、24..25=1200且各首40/errors=[]，不是仅元数据推断。TASK-502/508真实跨UTC日及旧缺括号/Provider500记录保留，不回写日期 |
| S17-范围 | 52匹配而仅初载40；三个组各20、各初显15；追加整组含未加载；取消Todo不丢其他状态选择；列表/看板切换保留；替换全部筛选 vs 追加已载分开 | 原52匹配/首40/完整52上下文保持；新PRJ-010真实60、high/medium/low各20，planning-groups60-browser初15/15/15→20/15/15→20/20/20；整组选20含未加载TASK-1302–1306，追加并集50、移除high保留其他40、列表loaded40且selectionPreserved40。先前26todo/26in_progress分支独立保留 |
| S17-交接 | 右栏非模态仍可选卡；中区逐项来源与变更；停止保留现场并可重新分析；返回看板侧栏不关闭；编码逐项另申请/精确审批 | L corrected-observer真停止b90f14b3…/006未发、再分析e9aaed98…/81f83438…succeeded/null proposal、52raw不变；d9ef…仅原键核对。planning-s17-coding-requests的observedActionsFromExecutedBrowserCall明确记录原checkbox选026/028→批量中区→展开“编码执行·单独申请授权”→明确申请2项，4POST/两独立Run链接，不是API造Run；其后每个read/read/test单独授权、真实各exit1/两失败/e1/无write/源不变，图planning-s17-two-independent-coding-requests.png及rendered-tests。分析停止不代Host停止 |
| S35-任务 **功能分支真实通过** | 真实1200原生任务；首屏40；加载到最早；不截断原内容 | L最终checkpoint02:50:26.895Z actualCount=uniqueIds=1200、unresolved=[]、1200原键全200/response_received；planning-native1200-browser首40、loadedCounts=[40,80,…,1200]、allLoaded缺漏/意外ID均[]，最早TASK-067实际打开。首屏settled20784ms/压力并发如实记录，不据此判流畅性；旧425/851/917/1133水位均保留 |
| S35-消息 | 真实240有上下文消息；首30、逐页可达全部/最早、长正文到尾，原文不截断 | 消息checkpoint实际120user＋120DeepSeek；N.longConversation DOM30→60…240、6806字符首消息含尾marker、API/DOM SHA一致，已真实通过此分支 |
| S35-历史 **真实通过** | 至少40历史Session/Run；首12Session/8Run；分页到最早、历史身份/输入不覆盖 | H.checks[0]实计52/52（5复用＋47真实DeepSeek taskless Host Run），总体3succeeded/49failed；新47中44真实测试exit1、3lease恢复未执行测试。H.pagination API50＋4/50＋12无漏重；H.browser.passed=true，实际Session4次/Run7次加载达54/62，首12/8，打开最早Session66d2b344…与Run6728f5a5…；5张截图见browser.screenshots、浏览写0/contextClosed=true、源两文件hash/目录metadata不变且秘密样文件内容未读 |
| S35-通知 **本轮未完成** | 真实120定向通知；首20；六页可达最早、个人已读刷新持久、精确来源深链 | N.notificationLoadAttempt的120命令均200/comments.id去重120/无剩余未发；native-ui-final-handoff.observed.notifications最终仅实际分页40条/20每页，最后delivery110且processingPending=true；120全分页与个人已读刷新均false。旧40/80未发水位不是当前，110交付也不是120；用户停止后不增批次或补验 |
| S35-长文档/长任务 **完整性分支真实通过** | 实际打开长文档/任务，完整正文不撑破布局、不截断保存；非任意毫秒性能跑分 | L DOC-003请求104437/保存104491（H1包装），fullBodySaved=true、native DOM正确LONG_DOCUMENT_END；TASK-1286请求53640/保存53681、请求片段SHA一致/fullRequestedBodySaved=true、LONG_TASK_BODY_END实际到尾，documentWidth=viewportWidth=1440。图planning-native-DOC-003-read.png、planning-s35-native53640-task-tail.png；旧错marker/旧task not_attempted均保留而非截断失败 |

### 当前部署与原身份核对水位

以下是父级控制的本仓库部署，不是本文责任人启动/重启服务，也不涉及来源项目。服务PID只代表该次真实进程快照，接口能力需认证另查。

| 事实/原身份 | 已观察证据 | 状态边界 |
| --- | --- | --- |
| 数据库与迁移 | R.runtimeMigration旧0039、R.semanticLeaseMigration于01:58:20.632Z实际0040；新R.artifactDeployment的migrate-runtime-0041 exit0/settled，schemaVersion=0041_tested_source_artifact_provenance.sql；均运行PG55440，测试PG55441另隔离 | 0041实际已部署，不再写尚待迁移；迁移本身不等同取消/外源/全部业务场景通过 |
| 新切换的停止失败与随后启动 | R.semanticDeployment始于02:00:37.733Z：stop exit1，Host21585无owned live进程/API21582已停，Worker21581未在8秒优雅窗口退出且无forcekill；随后观察PID不存在/worker_stopped，再独立start exit0，API2165/Worker2164/Host2166 | stop失败保留，不重写全程成功，不重复已成功stop或碰他项目。start最初仅api_ready/认证未验；其后R.semanticDeployment.capabilities已真实认证200/runnerReady，02:01:40.397Z本次部署结束，不再沿用旧ready |
| 最新支持的单owner部署/停止点 | R.disabledExecution正确停原3→唯一4191禁执行完成真实UI/history/503 rejected→停禁用API→新build恢复；API50390/Worker50389/Host50392、认证ready及cwd/entry已核实。P07同Level1/Finding保存DOC-006已闭合；末版Cancel/approval settling前端修复由bg24042/0与原B7只读smoke收尾 | 本轮已结束，无新模型/Run/pair/补验，主API/Worker/Host/Vite保留；baseline3291已核身份后停止。NoModel未启动，无其DB/API/Vite需清理；4192共享root失败不回填。bg237及所有子代理已结束，无在途验收请求 |
| history原Run **原身份恢复已证** | `f232f75a-5e83-4077-9669-36b24d8ab1c0`、`11b13f82-06b5-43de-bad0-e0828570d4eb`；原request `0c5c1c9f-e9c5-4e34-9360-8cdabeb78e13` / `f9fb0b07-bca1-411a-8376-680f53c02ec5` | H.runs原ID终态failed，原effect已核对/未发操作不执行；H.proof.allOriginalKeysSettled=true，168原键committed＋1真实过期审批rejected。H.browser实打开历史，无重复执行；不把历史失败“修复”为成功 |
| 通知原command | 原8a3c6637-9bf0-46df-a325-e343b9319a40已按原键恢复；N.notificationLoadAttempt | 累计120来源comment命令200、120不同comments.id、无剩余未发；status仍awaiting-delivery。旧40/80暂停是历史水位，不再当当前；已提交来源不等同120通知已查询/首20/6页/已读持久 |
| 规划原生大数据 | PRJ-006最终1200/unique1200、1200原键response_received/200；L最终checkpoint/planning-native1200-browser与PRJ-010分组browser | 新长TASK-1286完整SHA/尾marker和40→1200全部分页已证；PRJ-010真实三组20、初15/整组选中/列表选择保持已证。S13模型压力中1019/1020及两发布间1098–1100真实写入保留；旧425/851/917/1133不是最终数或失败改写 |
| 主动源原观测及恢复 | P24新proofb24d3e39…匹配1；P10原正式轮次/安全预算skip及新鲜源recheck f94838fe… +24215ms | P24恢复源、P10完成时钟均有真实新证据关闭；旧0/403/过读/负时长/原note全部留存，PRJ-002原policy r4/daily1规则DTO及TASK-003原revision不变，没有清计数。具体来源有效期/Run类型边界见P10 |
| 本轮冻结检查与业务边界 | backend bg236四门/37PG-HTTP tests PASS；Web bg240覆盖最终前端修复42/0/0及原B7只读刷新PASS；完整bg237最终902项、900通过、2失败、0取消/跳过，明确未通过。P07同Finding/Level1文档、S14原UI全审一次确认、J01原case图节点与S24六冻结源/导航均有真实证据 | 所有子代理已结束，运行库非终态Run为空，无后续修复/补验轮次。J02/J03人工Done、S25/S29真实取消及Native其他未完成项不改为通过。55433精确回滚、旧499/超时、bg201取消/S3 507、4192违规试验和docs anchor失败均保留；已部署应用服务保留可访问 |

### S34 原身份与历史失败定位

以下为不同真实分支/时间点，不把它们伪称同一请求，也不覆盖旧失败。来源均为R.move及R.moveBranches；历史合同为`retain_source_require_both`。

| 分支 | 原身份/对象 | 已观察结果 |
| --- | --- | --- |
| 读取后撤源权限 | TASK-534；冻结request `2bc9d5ac-12e1-4f74-bf7b-2f7c8ab3fbc1` | 撤planning.edit后403，原revision/raw/PRJ-007归属不变；reader权限随后恢复 |
| 只读/归档目标拒绝 | TASK-001→PRJ-007；request `77a1e9c3-7df3-4675-bf7a-b9bec60a09e8` | 外层HTTP200的durable结果为rejected/project_unavailable，不是移动成功；原TASK-001未变，PRJ-007随后明确restore |
| 已提交但旧UI导航失败 | TASK-534：`3b49c506-390f-499f-b003-642684e2b444` 7→4，`b2250724-3e2b-47f5-a6f5-a356ef98601f` 4→7 | 两次committed保留；只有project字段变、related_to TASK-090/creation保留；原comment `c5924386-ebb8-44d9-aeb7-0c16b124afe0` 仍PRJ-007/version1/原字节，当前讨论可读200而current-only主体404。旧route/journal失败未删 |
| 新原生导航修复复验 | TASK-534；原UI request `bfc62860-be8f-41ff-bbcc-d41f16358609`，7→4 | durable committed，exactExpectedRaw=true；同次自动正确目标URL/路径、journal空、reload保持、无旧权限/CancelledError；截图 `native-task-move-destination.webp`。新键已据原receipt补全，不再以旧3b49当本次键 |
| 真实pending后主动离页保护 | TASK-534；原UI request `b87690b7-b378-4cd9-81ed-b382ea2162ff`，4→7 | pending实际1条journal时从源详情离开到`/issues`；committed后仍`/issues`/journal空/errors=[]，原响应不抢路由。最终真实GET200、PRJ-007/revision1495d90d…，nativeUiPassed=true；不是仅人工API回写或模拟pending |
| 原任务移动后的不可变交付 | TASK-001原move `b7c451d4-e8f1-4250-ae99-eede75f5b6f8`；Run-0仍PRJ-001；artifactVersionIds `81b04d25-da29-42cb-a1ca-dce3c7d3a432`、`6568d507-0cdf-4055-8f76-05d25b276ffb`、`0733aa66-29ec-4e5f-b96a-4249eda6a603`、`2601ee7e-0695-4e19-b78c-460450e15dc0` | 四个原版本下载200/原SHA一致；current-project-only主体各404。当前任务PRJ-004不篡改历史Run项目或产物出处 |

