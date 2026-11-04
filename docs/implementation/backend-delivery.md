# 后端核心与前端接入交付记录

首次记录：2026-10-16；接入更新：2026-10-17。首批范围为用户授权以 `gpt-6.1-sol / xhigh` 子代理按依赖实现后端并验证本机服务；后续独立 Vite 前端接入及浏览器证据在下方单列。完整 G1/G2 仍有列明的收口项，真实 Agent 未实施。

## 首批已交付（2026-10-16 历史批次）

- 43 个命令，覆盖规划、意图、交付及 Workspace 成员能力；真实 PostgreSQL、版本并发与原子命令收据。
- 4 个顺序 SQL 迁移，关系作用域/引用/唯一性和不可变历史保护；迁移摘要验证与构建产物复制。
- scrypt 密码、散列会话、登录/退出、当前权限检查、最后管理员保护；本机私有账号引导。
- 8 MiB 成果上传、不可变本地内容、SHA-256、提交标准快照、人工审核及显式完成。
- 独立 Worker、持久 outbox、连续 cursor、失败隔离及受审计重试、changes/SSE 续订与授权撤销。
- 16 路径 OpenAPI3.1、从 Zod 生成的命令 payload 类型、Node/浏览器 fetch 客户端。
- API/Worker 管理脚本、专用 PostgreSQL Compose、真实服务 smoke、私有备份与隔离数据库恢复校验。

## 子代理协作

所有派发代理均使用用户指定的 `gpt-6.1-sol`、`xhigh`。先冻结 [共享接口](backend-interface-agreement.md)，再划分文件所有权，主代理负责集成与实际服务。

| 子任务 | 工作与证据 |
| --- | --- |
| backend_foundation | 数据库、身份、权限、命令内核、查询；真实 PG 事务/并发回归 |
| backend_planning | 26 个规划命令、8 个意图命令、领域守卫与模块测试 |
| backend_delivery | 真实文件存储、7 个交付命令、授权下载与文件/审核测试 |
| backend_contracts | 正式合同生成、客户端与合同漂移/浏览器类型兼容测试 |
| backend_integration | 真实 HTTP 人工闭环、SSE 及两个独立 Worker 的恢复测试 |
| backend_audit | 只读高影响审查、UUID/历史引用回归，随后补充受审计 outbox 恢复入口 |
| 主代理 | API、SSE、Worker、配置、专用服务部署、集成修复、备份与进度维护 |

## 集成中修复的问题

1. UUID 大小写曾绕过 Workspace 锁、自环判断、意图唯一转化及最后管理员保护；现在 schema 规范化、锁键 UUID cast 和数据库 UUID 唯一索引共同处理。
2. 游标曾因 `cursor::text` 输出别名按字典序排序；现在按数据库数字列排序，205 条事件分页回归验证。
3. 已撤销成员的历史 owner/assignee 引用阻塞归档恢复；现在历史引用与新分派有效性分开。
4. 未完整定义的项目取消后无法重开；现在 ReopenProject 可显式提供完整 definition，并保留 previousDefinition。
5. 失败 outbox 达十次后缺少恢复入口；现在提供只读失败查询和持久审计的显式重试，不跳过原事件。
6. 数据库重启可能触发空闲 Pool 连接未处理错误；现在记录安全错误码并由 readiness/Worker 恢复流程反映状态。

## 2026-10-16 后端运行证据（历史批次）

实际服务地址为 `http://127.0.0.1:4100`，专用 PostgreSQL 端口 55433。进程当前身份通过 `pnpm services:status` 查看，不把某个历史 PID 视为永久配置。

已在真实常驻服务中完成 16 步人工闭环，保留 `.local/evidence/service-smoke.json`。同一项目/工作项/16 份收据和成果 SHA-256 经 `smoke:verify` 重新核对。备份恢复在专用容器的新临时数据库验证，恢复出 9 个实体、16 份收据及对应成果文件；摘要匹配后清理临时库，原业务库保留。

该历史批次统一检查已通过（不代表后续修改后的最终检查）：

| 检查 | 实际结果 |
| --- | --- |
| 文档/计划引用 | 30 份 Markdown、27 步计划与领域引用通过；7 个本机外部参考链接不作为独立构建依赖 |
| 正式合同漂移 | OpenAPI3.1、43 个命令 payload、16 个路径与生成客户端一致 |
| lint / typecheck / build | 全部通过；后端 TypeScript 6.0.3，与当前 typescript-eslint 支持范围一致 |
| `pnpm test:backend` | **82 项通过，0 失败，0 跳过**；包含真实 PG、HTTP、文件、SSE、独立 Worker 和受控恢复 |
| 真实服务人工闭环 | 16 步命令提交成功，项目与工作项及成果保留；重启后读取同一批 ID/收据/SHA-256 |
| 备份恢复 | 在新临时数据库恢复 9 个实体、16 份收据和 1 个成果版本，内容摘要匹配；不覆盖业务库 |
| 数据库短暂中断 | API liveness 200、readiness 503；数据库恢复后 readiness 200，API/Worker 保持原进程，原数据复核通过 |
| 最终运行状态 | API 与 Worker 均在运行；数据库/存储/Worker 检查为 true，quarantinedEvents=0 |

本机证据索引：`.local/evidence/backend-checks.json`、`service-smoke.json`、`database-recovery.json` 和 `.local/backups/*/manifest.json`。这些私有记录不进入版本库；日志与凭据不在公开文档中展开。

## 2026-10-17 真实前端接入与增量合同

正式入口 `http://127.0.0.1:3220/pm` 通过同源代理使用 `http://127.0.0.1:4100` 的真实会话、能力、查询、命令、文件和 SSE；独立 `/lab/pm` 保留32个展示变体，Storybook 在 `127.0.0.1:6017` 提供11个显式组件样例。运行命令见[根 README](../../README.md)，库选择、实际组件路径及有界功能矩阵见[前端移植清单](../frontend-porting-manifest.md)。

- 生成客户端由 `packages/contracts/src/client.ts` 提供；TanStack Query 的快照按后端/主体/成员能力作用域隔离并读取完整分页。正式服务失败不回退 fixture。
- 全局未知命令 journal 使用 IndexedDB 保留原 commandId；原命令收据未核对前阻止后续写入，不生成新 commandId 盲重试。SSE checkpoint 驱动权威缓存失效；服务更新不抹去未保存草稿。
- `UpdateWorkItemMetadata` 新增可省略、可空的 startDate/dueDate（严格 `YYYY-MM-DD`；缺失旧字段读取为 null）。省略保持，null 清除；两者存在时起始不晚于截止，截止日包含当天。更新递增实体版本、不增加 contentRevision，不改变工作内容/审核快照。生成合同与日期校验同步更新。
- FullCalendar、甘特和详情共用任务日期；本批次小时布局只有全天任务。后续 Dashboard 的真实项目会议与独立项目依赖见下方补齐记录；任务日历不自动混入会议。白板仍是按浏览器 origin/账号/工作区/可选项目隔离的个人本地 SVG 数据，不是服务端 Artifact 或协作存储。

### 已观察的检查结果

| 检查 | 结果与时间边界 |
| --- | --- |
| `pnpm check` | 后端/文档/合同/client/lint/types/unit/build 通过；不包含 `check:web` |
| `pnpm test:backend` | **84 tests，5 suites，0 failures，0 skipped**；真实 PostgreSQL、文件、HTTP、SSE、独立 Worker |
| 依赖 peer 检查 | 已观察通过；不等于功能/生产验收 |
| 前端 lint、TypeScript/Vite 构建 | 最新响应式、布局切换、草稿共享及离线提示修改后的 `pnpm check:web` 通过；lint 显式包括本轮受影响的受控视图和 fixture 适配器 |
| Storybook 构建 | 真实 ELK Worker 修正后的构建通过；11 个组件 stories；仍有大 chunk 提示，不据此宣称首屏性能已优化 |

### 已观察的真实浏览器证据

本次产品验收使用隔离数据库 schema 与临时 API `4117` / Web `3237`，不是改写用户默认服务端口。以下均为实际浏览器交互，和 Storybook/Lab 样例分开：

| 场景 | 观察结果 |
| --- | --- |
| 人工项目/任务链路 | owner 登录、创建并 ActivateProject；创建任务后 ReadyWorkItem、StartWorkItem |
| 成果与证据 | 上传2340字节文件、RegisterArtifact 不可变版本、浏览器下载；SHA-256 为 `0fdea4e5431e1d2deab73688b0af2e0cda63f444e8ce3a81f374928f2e605c4f`，与上传内容一致；RecordEvidence 后提交标准快照 |
| 审核与显式完成 | 逐标准通过审核后任务仍为 `in_review` v4；显式 CompleteWorkItem 后 `done` v5，重新加载仍为 done |
| 人工对话/意图 | 创建对话、消息，提出并接受意图，再显式建任务；没有调用 LLM 或暗中自动建项 |
| 提交已成功但响应丢失 | CDP 在 `/commands` 服务端提交后丢弃响应；UI 阻止写入，原 commandId 经 IndexedDB 跨刷新保留，查询原收据清除 unknown；最终只有1个里程碑 |
| 共享日期 | FullCalendar 保存2026-10-20至22，甘特显示同一日期；无另造小时事件 |
| 并发冲突 | 两个 owner 标签页：SSE 已看到服务端更新，未保存24Oct草稿保留；旧版本保存被 `Aggregate version changed` 拒绝；显式 rebase 后保存为24Oct，contentRevision 仍为1 |
| 权限与 SSE | 另一 cookie 域 localhost 的 reader 只有 domain.read，不能创建/移动；owner ready 命令通过实时 SSE 更新 reader |
| 授权变更与撤销 | owner 将 reader 从工作区只读改为单项目 planning.edit，重新加载后开放合法编辑；撤销后 reader 显示 not_found_or_forbidden，私有任务内容清空 |
| 图与导航 | 依赖持久化2节点1边；ELK 使用真实 Worker 后未观察到 runtime pageerror；命令面板搜索任务并进入真实详情 |
| 外观 | 中英切换、深浅主题已操作；390×844 窄屏复访通过，快捷导航/抽屉与纵向正文可用，detail2 元数据保留，document.scrollWidth=390 |

组件样例已操作：指针/键盘看板、日历排期、ELK 布局、白板2对象及撤销/重做/刷新、Tiptap Markdown、虚拟表格筛选、甘特刻度。Lab **32/32** 最终巡检均渲染独立页面且无 pageerror；项目 cover→browse→table 的未提交草稿、任务 list↔board 搜索/选择及 board/detail 草稿跨变体保留已复验。正式入口的列表→看板/日历布局按钮同步 URL 与实际内容，并保留搜索条件。

补充恢复证据：CDP 模拟离线后，正式页面显示“当前离线/上次快照可能过期”，保留数据但不宣称实时；恢复网络后提示消失并恢复读取。注入项目读取 HTTP 503 时，页面显示真实错误与旧快照标记，手动“重试读取”后恢复，没有回退样例数据。

生产构建在临时 preview 3238 对接同一隔离 API：依赖图2节点1边，真实 Worker 布局位置为 (12,12)/(312,12)，无 pageerror。默认 3220 登录页及同源 `/health/ready` 已复访；本项目 API/Worker 经受控脚本重启后 ready，database/storage/worker=true，quarantinedEvents=0。该证据是本机服务与构建预览，不是公开生产部署验收。

### 仍开放的验收门槛

保留 B03/B09/B11/B13 与完整 G1；第二阶段 U03–U06 已实现并有上述有界证据，U07 本机前端检查/32视图/移动端回归已完成。完整身份切换、浏览器游标过期及所有命令分支矩阵、生产 Lab 门禁与部署仍未全部验收，不提前关闭 G2。物理显示缩放、真实 IME/触摸设备不在当前证据范围。X01–X07/G3 未开始；邮件邀请、外部邮件、Agent/Runner 与生产发布不宣称完成。团队组织能力的后续范围见下方项目补齐记录。

## Dashboard 1–4 后端补齐

六组 `gpt-6.1-sol:xhigh` 子代理实现，主代理接入正式 `/pm/<workspace>/dashboard?view=dashboard1` 至 `dashboard4`。十二项范围、数据所有权、退出条件与逐项实际证据见 [Dashboard 补齐计划](dashboard-backend-completion.md)，不把 Lab 或浏览器拦截响应算作服务结果。

- 新增五个具名 Dashboard 查询 DTO、命令注册与迁移 `0008`–`0011`；生成合同为 77 个命令、21 条路径。个人记录、收据和事件按 actor 隔离，项目数据按当前权限读取。
- 项目、任务、cycle、里程碑及依赖仍以 Markdown 为权威。缺少真实来源的实体 `createdAt`/`updatedAt` 返回 `null`；不再用每次读取的当前时间冒充创建/更新时间。显式来源时间戳保持原值。
- Sprint 历史是持久扫描观测，不是伪造每日燃尽数据；关键路径使用显式工期。财务采用最小单位整数与明确币种，预测为实际支出加剩余成本；健康风险来自显式评估。Run 状态仍不能决定任务完成。
- 浏览器实际操作覆盖十二项及刷新保留、私有便签隔离、受限成员只读、跨标签页版本冲突与草稿保留。修复了复制标签页覆盖未确认命令记录、个人资料刷新循环及固定高度卡片编辑区越界。
- 本机既有 API/Worker 经 PID、启动身份与工作目录核验后迁移并重启；数据库已到 `0011_dashboard_portfolio.sql`，`http://127.0.0.1:4100/health/ready` 实测 database/storage/worker/core 全部为 true、quarantinedEvents 为 0。未接管其他项目服务；不等于公开互联网生产部署。

## 正式 Project List 1–4 / Detail 1–2 后端补齐

按用户要求由六组 `gpt-6.1-sol:xhigh` 子代理执行，主代理接入正式 `/pm/<workspace>/projects`，不改为 Lab 交付。十项范围、权限、分工和逐项实际证据见[项目补齐计划](project-backend-completion.md)。

- 个人收藏/筛选、已登记图片版本封面、真实团队/项目关联与最小身份目录、核心里程碑摘要、人工健康/交付信心、预算/支出/预测历史、结构化范围注释、分页审计和原生任务行内/拖动/日期编辑。
- 健康和财务继续使用既有 `dashboard-portfolio`；只增加可空信心字段。项目、任务、里程碑和生命周期仍由 Markdown 核心拥有；范围清单及团队关联不会完成项目或扩大权限。
- 新增 `audit.read` 为显式授权，迁移不自动扩大既有成员能力。历史从受控写入开始，外部文件时间戳仍作为不同来源的快照显示。
- 原生任务 PATCH 使用 revision 和现有草稿恢复，不伪造 PM 命令收据。未知结果必须先读取权威版本，再显式采用或放弃；保护范围是同 CoreSession 和恢复的本地草稿，不宣称实时跨标签页锁。
- 本轮检查、数据库迁移、浏览器证据和本机激活结果以项目计划“实际验证记录”为准；上述历史 Dashboard 就绪结果不代表新迁移已经生效。

## 正式 Member 1–3 后端补齐

三个 `gpt-6.1-sol:xhigh` 子代理分别实现邀请/SMTP、目录/权限与正式前端；主代理集成合同、服务与浏览器验收。工作包、边界和检查结果见[成员补齐计划](member-backend-completion.md)。

- 迁移 `0016`–`0017`：显式 `directory.read`、本人资料扩展、持久邀请、加密邮件队列和接受收据。既有授权不自动追加能力。
- 普通目录按当前真实共同项目范围裁剪；管理目录继续要求工作区 `access.manage`。角色模板复用原成员命令的版本检查与最后管理员保护；自定义授权不自动改写。
- 邮件发送使用独立 Worker 与 SMTP 适配器；未知发送结果不自动重发。接受链接支持新账号与已有账号原密码确认；接受响应丢失可查询原 commandId 的收据，不能以邀请修改已有密码。
- 浏览器已使用隔离 PostgreSQL、临时 HTTP 服务、真实 SMTP 接收端与独立 Worker 验证创建→收信→接受→普通登录→脱敏目录，以及资料保存、角色写入、显式重发/撤销。不是 mock API 数据，也不是公网收件箱送达证明。
- 当前本机未配置 SMTP、邀请网页来源和加密密钥，正式部署的邮件邀请保持禁用；2FA 尚无可信认证来源，返回 null 与 supported:false。具体激活及最终检查结果以计划记录为准。

## 正式 Teams 1–3 后端补齐

四个 `gpt-6.1-sol / xhigh` 子代理分别实现团队领域、容量/估算、正式三页和任务卡动作；主代理整合合同、迁移及真实服务验收。工作包与最终检查/激活状态见 [Teams 补齐计划](teams-backend-completion.md)。

- 增量迁移 `0018`–`0019`，新增团队目录/工作量 DTO 及三个命令；复用既有团队、项目关联、成员资料/邀请和在线来源，不建立第二套业务存储。
- 团队维护者不授予能力；查询裁剪项目和人员。当前可见任务的历史受派人失效时保留任务、隐藏受派人身份；部分范围不宣称全局未超载。
- 估算点是原生 Markdown 保留字段 `x-pm-estimate`；容量是显式 SQL 协作记录。零不等于未知；创建任务不自动开始或完成。响应目标只提供配置，不提供 SLA 计时/达标引擎。
- 隔离真实 API/PostgreSQL/Worker/SMTP 的浏览器已验证团队维护、项目关联、冲突草稿、归档、任务卡创建、估算/容量、邀请接受及受限读取；截图和 JSON 证据在 `.local/evidence/teams-backend/`。本机正式 SMTP 仍需运营配置，不宣称公网邮件送达。

## 任务五页与原生创建恢复（2026-10-21）

五组 `gpt-6.1-sol / xhigh` 子代理分别承担共享规则、原生恢复、创建表面、集合入口和真实验收环境；主执行者集成并完成浏览器及故障验收。细项见 [任务创建计划与交付](task-creation-adaptation-plan.zh.md)。

- 原生创建、源码/属性修改与 CreateWorkItem/Intent 入口共享当前项目、成员、字段及关系规则；命令版本在工作区锁和文件守卫内核对。可选日期、标签、父项、估算与位置在首次 Markdown 写入内保存，无 SQL 任务副本。
- 新增按原 actor/key 查询的原生结果及显式审计恢复接口。真实 API 中断发生在文件事实已 fsync、SQL 审计提交之前；重启后恢复原 ID/revision，未重复创建或伪造命令收据。当前文件修改/删除与原提交事实分别返回。
- 原生/命令入口对越权项目、非法新受派人、关闭/归档项目一致拒绝；历史受派人失效不导致无关编辑被强制改派。完成、重开仍沿用实际字段对应能力，不暗增 planning.edit 前置条件。
- 本轮 `pnpm check` 295 项通过；真实 PostgreSQL 的 `pnpm test:backend` 466 项、25 suites、0 失败、0 跳过；`pnpm check:web` 通过。浏览器验证九类创建、原生/关注分项恢复、源码冲突、权限、个人时区及 390px 窄屏。
- 本机 `.local/evidence/task-creation/` 保留 JSON/截图/检查记录；自有 API 4151、代理 4152、Web 3351、Worker、隔离 schema 与临时根目录已清理。既有常驻服务未重启，本次不声明生产部署或真实 Agent 就绪。

## 项目工作空间与任务上下文（2026-10-22）

- 参考 gr8r-studio 的 `src/pages/project.js` 与 `src/core/store.js`：工作区任务为跨项目集合，项目的概览、看板、列表、表格、日历、时间线、文件、活动共享项目身份。只借鉴导航和关系，不复制样例事实或修改参考仓库。
- 正式项目路由增加持久项目侧栏和嵌套页面导航；任务集合、创建、详情、展开和复制链接保留 `/projects/<projectId>`。现有项目详情变体、文件和活动保留，源码编辑返回原视图及标签。
- 路由项目不能被查询参数、保存视图、恢复偏好或清空筛选覆盖；项目搜索和偏好分开持久化。跨项目详情/面板明确拒绝；创建固定当前项目，按项目恢复草稿，显式传入其他项目草稿时保留原意图而不重新归属。服务端授权、Markdown revision 和未知写入恢复规则不变。
- 真实浏览器使用临时 Web 3246、随机 API 端口、独立 PostgreSQL schema 与临时 Markdown 根目录：两项目任务的五种布局隔离、工作区汇总、项目内创建并重读核心文件确认归属、面板展开/刷新/返回、冲突查询参数、错误项目详情/面板、切换项目后的草稿独立恢复均已操作。项目源码从 Files 打开后返回 `?view=detail2&tab=files` 已验证；390px 窄屏文档宽度为390px。
- 前端 lint、TypeScript、Vite 构建及任务集合/创建/详情/行内编辑回归在本轮运行；构建仍有大 chunk 和静态/动态导入混用提示。未修改后端合同，不将此导航验收等同于完整 G2、生产部署或 Agent 验收。

## 项目内 Markdown 优先创建（2026-10-22）

- 项目任务集合的主按钮、看板分组、日历/日期分组和原快速新增入口统一跳转完整创建页；项目详情既有创建链接复用该页。路由保留项目、返回位置及状态/日期/优先级/关注初值，不创建占位任务，不覆盖恢复草稿。
- 创建页复用现有 CodeMirror Markdown 能力和原生创建草稿：正文编辑/预览与同页属性共同提交，状态使用真实工作流选项，支持 Ctrl/Cmd+S。输入中的本地编辑器值不被异步草稿备份回填覆盖；原幂等键、未知结果核对、子任务分项恢复保持不变。
- 保存后使用真实服务 ID 打开源码/实时任务视图。创建前使用属性控件维护元数据，保存后可在完整 Markdown 源码中继续编辑；不是先写一份空文件再补字段。
- 隔离 PostgreSQL/Markdown 工作区与临时 Web 3246 的浏览器实测：项目“新建任务”直接跳页、看板 in_progress 初值保留且无弹窗、保存前任务数为0、标题/完整正文/状态/负责人/日期/优先级/标签刷新恢复并写入同一 Markdown 文件、保存后源码标签选中、390px 窄屏无横向页面溢出。最终浏览器未观察到 pageerror。
- `pnpm check:web`（lint、TypeScript、Vite 构建）、`pnpm check:docs` 通过；`node --test tests/task-creation-model.test.ts tests/task-collection.test.ts tests/task-detail-model.test.ts` 为24通过、0失败、0跳过。临时服务、schema、Markdown 根目录和冒烟脚本已清理；未改后端写入合同。

## 双链页面导航与文档编辑入口（2026-10-22）

- Markdown 正文和属性中的对象链接按已授权文件的真实实体类型导航：项目进入项目页面；任务进入其实际所属项目的详情；文档等其他实体保持工作区详情路由。文件浏览器的源码选择不改为页面跳转，未解析和未知协议链接保持原有诊断/只读行为。
- 本批次先增加“编辑内容 / 阅读预览”入口，复用原编辑器、草稿、revision、权限和保存链路；后续“Markdown 内容直接编辑”批次已将默认内容页升级为可直接输入的正文编辑器，旧切换前置步骤不再保留。没有将 Markdown 转为 HTML 后回写。
- 临时 Web 3246、随机 API 与隔离 PostgreSQL/Markdown 工作区实测：项目链接进入概览页面、任务与文档链接进入正确详情、跨项目任务返回原文档集合、未解析双链留在原页；编辑按钮进入可输入编辑器，正文保存后 API 重读及刷新保持，预览切换保留草稿，Ctrl+S 保存成功，390px 页面无横向溢出。正式示例 DOC-001 的操作说明已同步。
- `pnpm check:web`（lint、TypeScript、Vite 构建）与 `pnpm check:docs` 通过；任务集合和详情回归13通过、0失败、0跳过。未更改后端合同或现有业务任务。

## Markdown 内容直接编辑与丰富能力（2026-10-22）

- 五个 `gpt-6.1-sol / xhigh` 子代理按[编辑补全计划](markdown-editor-completion-plan.zh.md)实施命令、结构操作、内容编辑、丰富渲染、PM 对象联动。React 19 / CodeMirror 6 保持 Markdown 权威；参考插件技术与交互，不接入 Obsidian 运行时或复制其业务数据。
- 内容默认可输入，正文/属性/关联/高级源码共享显式保存草稿；工具栏、三级右键菜单、命令搜索、查找替换、模板、大纲、块拖动、表格行列操作均接入真实文本事务。图片附件复用暂存/登记，PDF 用本地 PDF.js canvas 分页而非被浏览器拦截的插件 iframe。
- 隔离真实服务的浏览器已操作：中文输入与保存重读、六色高亮、撤销重做、复制/纯文本粘贴、表格排序、Callout 折叠、模板、块拖动、项目和标题锚点导航、KaTeX、中文/英文 Mermaid、授权文档嵌入、本地图片、实际 WebP/PDF 上传与两页 PDF 翻页。翻页未重新请求附件，光标/工具栏状态变化不重建图表和图片节点。
- 真实任务创建保留完整中英文标题与源关系；截断已提交创建响应后进入 unknown，按原请求核对恢复同一 ID，没有重复任务。外部 revision 更新保留本地草稿并锁写，版本对照可读；只读成员不能编辑，删除 H1 的无效草稿仍可修复。77 项编辑/语法/渲染/PDF 专项回归为零失败、零跳过；全量回归和本机激活结果见计划的实际验收记录。
- 已更新唯一真实工作区的示例 DOC-001；其余业务文件未作验收夹具。Agent execution/Session 合同、逐键多人合编与独立批注线程仍明确不可用，不把 SSE/revision 或隐藏 Markdown 批注称为这些能力。

## 工作区 Home 接入（2026-10-22）

两个 `gpt-6.1-sol / xhigh` 子代理分别实现首页内容与导航/启动偏好；主代理集成并完成下列有界验收。参考只读 `gr8r-studio/src/pages/home.js`，不改参考仓库，也不把其样例事实移入正式应用。

| 参考元素 | 当前项目采用方式 |
| --- | --- |
| 问候与快捷操作 | 真实账号/个人时区；任务、项目创建进入既有 Markdown 创建流程；成员与邀请进入实际成员页，不宣称 SMTP 可用 |
| 四项统计 | 授权范围内活跃项目、开放任务、已完成总数与逾期；无可靠完成时间，不复刻“本周完成” |
| 我的任务 | 按实际 assignee 与原生工作流分为待办、逾期、已完成；键盘切换，超过七项原位展开，详情保留返回来源 |
| 项目进度 | 已完成 / 未取消任务，排除归档及无效源码；完成率不改项目状态，不推造健康或团队头像 |
| 即将截止 | 个人时区的今天、明天及后天至第七天；日历、逾期与任务详情沿用现有入口 |
| 最近动态 | 真实授权 changes 事件；没有操作者姓名时不补造，空态、截断与读取失败分别展示 |

正式入口为 `/pm/<workspace>/home`。个人侧栏首位、命令面板与启动偏好均已接入；新浏览器默认 Home，已有显式偏好保留；工作区根按偏好跳转，原 `/dashboard` 与 `/pm` 登录/工作区选择、Lab 目录不替换。遵守 INV-01/03/17/20、SC-14/20 与 INF-03/06 的作用域和读模型边界，不改后端合同。

实际验证：临时 Web 3248、随机 API、独立 PostgreSQL schema 与临时 Markdown 工作区中，owner 的两项目汇总、只读成员单项目隔离/禁用创建、三任务分组及键盘切换、真实任务详情、新建项目/任务入口、工作区根跳转、保存 Dashboard 启动偏好、命令面板 Home、空工作区零值、实际 outbox 发布后的动态均已操作。受控注入核心读取 503 后显示未知统计与重试，移除故障并点击重试恢复真实数据。桌面浅色中文与 390px 深色英文已截图，移动文档宽度为390px，无页面横向溢出。

检查：`node --test tests/workspace-home-model.test.ts tests/task-collection.test.ts` 为16通过、0失败、0跳过；前端 lint 与启动偏好 store 补充 lint 通过；独立 `vite build` 通过，保留大 chunk/混合导入提示。`pnpm check:web` 的全量 TypeScript 尚未通过：Home 的可空资料收窄已修正，随后 `typecheck` 仅报告并行文档编辑文件 `DocumentObjectActions.tsx` 的 `applyDocumentUploadReceipt(action, receipt)` 可空参数错误；本次未改该文件，不能把单独 Vite 构建等同全量检查通过。未重启既有常驻服务，不声明生产部署或完整 G2。

`pnpm check:docs` 检查71份 Markdown 通过。临时验收服务正常退出，隔离 schema、Markdown/内容根目录及自建冒烟脚本已清理，既有服务与业务数据未修改。

## 真实验收与缺失服务补齐（2026-10-22）

八个 `gpt-6.1-sol / xhigh` 工作包完成工作区资料、账号安全、站内个人活动状态、任务评论、Files、日期写回与身份/命令/SSE 恢复的实现或真实验收；发布工作包另交付容器、同源代理与 Lab 门禁。完整范围、证据及 D01–D15 待讨论决定见[本轮汇总](service-completion-and-acceptance.zh.md)，不把本批次等同整个项目或完整 G2 封板。

- 新增资料/活动/评论七项工作区命令及账号级安全接口；OpenAPI 为99个命令 payload、43个路径。迁移0020–0023承载新附属数据，0024修复真实 pg_restore 发现的审计检查函数作用域；不改九类核心 Markdown 权威或任务完成语义。
- 真实服务发现并修复 Files upload CAS 缺失、日历丢弃旧 revision、退出时删除未知命令、内容页恢复入口缺失、静默流假在线和410恢复提前推进游标。会话撤销后的核心 SSE 泄漏窗口已先复现再修复，现逐条核对实际会话与授权。
- 工作区、账号安全、inbox3/4、评论、Files、日历/时间线与恢复矩阵均使用隔离 PostgreSQL/真实 HTTP/实际浏览器；明确区分提交后丢响应、原收据恢复和原生权威观察。各包私有夹具、临时服务、标签页和一次性脚本已清理。
- 本机 API/Worker 经归属检查停写；旧备份在独立新库用0024函数元数据修复完成恢复校验后，才前向迁移至0024。新备份 `.local/backups/2026-10-22T18-16-16.739Z-dfc36926` 已按常规 `backup:verify` 恢复通过，58份原收据、1个成果版本、12份核心文件保持；没有把业务工作区作新功能验收夹具。
- 最终本项目 API10424/Worker10410 已激活；API4100及Web3220同源 readiness 均200，database/storage/worker/core为true、quarantinedEvents=0。实际打开默认登录页，合同43路径及新增身份/活动/评论入口存在，未认证安全接口401；未读取或提交账号凭据。
- 本批次前端 lint/全量 TypeScript/Vite、后端 lint/类型检查/构建均通过，取代上述历史 Home 批次的并行编译失败状态。仍有大 chunk 和静态/动态导入混用提示，不以此声明性能容量通过。
- 最终原样重跑 `CHOKIDAR_USEPOLLING=true pnpm test:backend`：584通过、30 suites、0失败、0跳过。首轮5个约10秒的真实socket截断已先复现再修正请求接收/处理超时边界，没有靠自动重试或缩小范围变绿；Files安全预览另3项通过。最终文档检查为76份Markdown，合同99命令/43路径一致。
- API/Web镜像已实际构建、独立Compose停写切换及新库/新卷恢复通过；5条非空审计、3份原收据和Markdown/blob摘要保留，全部约束validated。实际Caddy、两路SSE、Origin、登录/退出与生产Lab404均验证，详情见[部署实际验收](../../deploy/README.md#release-acceptance-evidence)；并非公网/HA或容量SLO通过。

## 五个明确服务工作包（2026-10-22）

五个 `gpt-6.1-sol / xhigh / priority` 子代理分别实施，集成负责人统一共享入口；当前不是仅交付规划。迁移0025–0029，合同109个命令 payload、60个 OpenAPI 路径。

- Files 显示名、隐藏/恢复、指定版本独立复制；站内显式关注/提及通知与唯一持久核心事实；可信恢复邮箱/找回；私有 S3/维护/备份；受限 Webhook 均接入实际 API/Worker/正式页面。
- 浏览器在 S3 改名/隐藏/恢复并复制旧v1，下载31字节保持；通知已读/归档/取消归档保留身份和时间；SMTP验证邮箱后重置，旧会话401、新登录200；TLS接收器独立 SQL 账本 accepted 且效果一次，正文/actor 不外发。
- 实际备份 CLI 导出3个 S3 对象、9核心文件，恢复到新库、新核心根和新 Local 身份，epoch1→2；4核心对象0错误、3份授权 HTTP 字节一致、匿名拒绝。围栏只作用目标库，旧凭据信任未获生产批准。
- 修复了延迟约束阻塞迁移、ledger CAS、bigint 参数、核心缓存陈旧、MinIO412连接复用、账号路由 provider、默认配置缺省备份和新恢复库 public schema 冲突；未放宽约束、增加 PUT 重试或伪造成功。
- 独立角色环境、旧配置保留、编译 storage CLI、真实 API/Worker 及 Worker 不继承 API 云身份已验证。最终全量为676通过、35 suites、0失败/取消/跳过；检查、实际边界与清理见[五包交付](service-completion-and-acceptance.zh.md#five-package-delivery)。
- 未迁移/重启既有业务实例。生产 SMTP/S3/Webhook 配置、恢复信任与维护窗口仍需输入；不代表公网/HA、真实 Agent、容量或实机验收。

## 尚未完成及证据边界

- 自动安全 blob GC、通用 job 编排与持久任务管理尚未实现；orphan/过期内容保留。Worker 已有独立 outbox、保留维护、站内通知、邀请/找回邮件和批准 Webhook 循环，不再仅有邀请队列。
- 实体 data 与命令 result 仍是通用 JSON/unknown，正式输入 payload 已类型化；细粒度结果 DTO 有待收紧。
- 单工作区写事务串行、单 API/本地 Markdown 核心、8 MiB 上传；私有 S3 已隔离验收，目标供应商、多机核心共享、公开互联网/HA及系统级自启仍未验收。
- SSE 有背压断开机制，但本轮未做大规模慢客户端和并发容量验收；健康/恢复测试不代表负载测试。
- 本机账号引导、显式授权和可信邮箱找回已实现；公开注册、MFA/SSO、无证明人工恢复未提供。生产实际收信与旧备份凭据信任仍是门禁。
- 2026-10-16 后端批次未做前端接入；2026-10-17 后续真实浏览器证据已单列，不能继续称当前前端 fixture-only，也不能将样例展示算作服务结果。真实 Agent 执行仍未启用。
- 未 commit 或 push。最初初始化记录保留为历史，计划中 B09/B11/B13 等剩余项不标记全部完成。

## 本地优先项目目录与初始化

按用户要求先冻结[本地项目存储计划](local-project-storage-plan.zh.md)，再由五个 `gpt-6.1-sol / xhigh` 子代理分别实现核心、API、附件/维护、Web 和独立验收；集成 owner 负责合同生成、真实浏览器/CLI、发现问题后的修复与最终检查。

工作区保留统一授权、ID、配置与恢复台账；新项目选择真实目录，Markdown 与附件分别保存到该目录 `.pm/core` 和 `.pm/attachments`。既有项目不自动搬迁，显式迁移、托管移动和外部移动后找回共用身份校验与持久围栏；缺盘不创建空替代根。完整备份纳入 SQL、共享台账、全部登记项目和历史引用对象，不把单个项目目录当成完整备份。

新增 `0030_local_projects.sql` 与 `0031_project_blob_stores.sql` 的启用须随受控升级执行；本轮不迁移既有业务库、不重启原 API/Worker，也不增加云端同步、多实例或 Agent 能力。当前检查、真实故障修复与清理证据以本地项目计划第 8 节为准，不继承上方历史验收结论。

## Agent Chat 普通 PM 工具接入

本批次按用户确认的[收窄范围](agent-capability-integration-plan.zh.md)实施：固定 Full access/Auto approve 的普通 PM 工具，不恢复业务 Session/Run、Host、主动发现、后台自动化或完整权限产品。三份 `full-scope-reference` 旧计划副本保持参考用途。

- 接通13个项目/任务/文档/评论/关系工具，复用原生命令、Markdown 核心写入、当前 ACL、revision、幂等与真实收据。私有线程显式授权、冻结项目集合、60分钟有效期，原生写事务再次核验；既有用户线程不会自动获权。
- `0033_agent_chat_tools.sql` 只增加线程授权、消息来源与最小工具记录。未知写入查原操作，不自动重派；停止、撤权及历史隐藏不代表已提交动作回滚。
- 同一个 assistant-ui external-store runtime 接入能力/实际来源/工具卡及五类业务结果；原设置中心增加精简 Agent 页。没有替换 PM 前端或新增第二套消息/认证栈。
- 真实 `deepseek-chat` 在隔离 PostgreSQL/Markdown 服务中逐项调用全部13工具，原生页面核对项目、任务、评论和文档。另验证授权停用、普通聊天、原生人工评论、刷新无重复请求、显式取消与390px窄屏。
- 验收发现并修正文档完整正文回写重复 H1、文档卡错误使用项目任务路由、历史结果隐藏后模型误把撤权解释为过去未执行，以及跨轮来源权限检查与确定拒绝/未知结果区分。
- 本批次工程检查、超时/失败及本副本激活记录以接入计划第8节为准，不继承以上历史批次的全量通过数字。Chat 工具验收不等于 Host/Runner 或旧完整 Agent 计划验收。

## 成员、团队与工作量统一入口

- 按[合并计划](people-workspace-consolidation-plan.zh.md)，两个 `gpt-6.1-sol / xhigh` 子代理分别实现页面整合与导航迁移；主线程负责集成和隔离验收。
- 正式入口统一为 `/pm/<workspace>/members?tab=members|teams|workload`。成员目录去重，邀请/授权归成员页；团队管理与工作量分别保留。成员/团队详情可带 ID 筛选进入工作量，筛选支持清除、刷新与历史导航。旧正式 `/teams` 移除，Lab 六个变体保留。
- 复用现有成员目录、团队、任务、估算和容量服务；组织关系不授予权限，容量不是工时，未知不转成零。共享 CoreSession 与既有草稿/版本/原命令核对机制不另建事实源。
- 隔离真实 API/Worker/PostgreSQL/Markdown 浏览器验证了团队创建/维护者/关联/归档、成员岗位及限项目角色保存、容量/零估算写入、成员卡任务创建及原生详情、受限账号、工作量503与跨页隔离、390px及英文深色、历史启动偏好和Lab兼容。详细证据和边界见合并计划。
- 最终 `pnpm check:web` 通过；定向 ESLint 和11项行为回归通过，0失败、0跳过；文档检查通过。保留既有大chunk及混合导入告警。未修改后端合同、未重启业务服务，未向既有工作区写入验收数据。

## 项目侧栏菜单与安全复制

- 按[项目菜单计划](project-sidebar-menu-plan.zh.md)，四个 `gpt-6.1-sol / xhigh` 子代理分别实现原生复制、统一菜单、实际分享和本人排序，主线程整合合同与服务验收。侧栏、项目列表和详情共用菜单及按需挂载的弹窗，不替换原有项目页面。
- 新增 `DuplicateProject`、`SetProjectSidebarOrder`、正式 `DeleteObject` 合同和原复制恢复接口；`0035_project_sidebar_order.sql` 保存私有顺序。复制使用冻结清单、新 ID、内部关系重映射及工作流初态；不复制授权/历史/附件/用户代码，部分结果不发布，GET 收据不续写。
- 浏览器实测了编辑/取消/版本冲突、真实负责人、分享范围增减与继承授权、只读拒绝、账号独立收藏、搜索下全量排序、跨标签页更新、任务关系复制、归档/恢复、永久删除正向及引用保护、390px 和键盘焦点。真实复制提交后丢弃响应，界面锁住新提交；查询原收据打开唯一新项目，未新建替代请求。
- 验收修复了归档项目从 PM 目录消失而无法恢复的问题，以及无历史负责人时编辑器缺少可选真实成员的问题。PM 项目目录现在包含归档对象；原生查询和任务查询的归档默认值不变。
- 完整工程检查及环境差异以计划第 5 节最终记录为准。未迁移或重启既有 API/Worker，未向真实工作区写入验收数据，未修改 gr8r-studio 参考仓库；不将源码交付等同于生产激活。

## Timeline 参考复刻

- 三个 `gpt-6.1-sol / xhigh` 子代理分别实现时间线画布、原生数据适配及页面工具栏，主线程集成并用真实浏览器验收。参考 gr8r-studio 的紧凑工具栏、300px 任务栏、52px 双层日期表头、36px 行与24px浅色任务条；支持周/月/季、周末底纹、今天线、分组、里程碑和依赖曲线。
- 工作区与项目任务页、项目详情时间线共用同一画布。数据来自授权核心文件和现有工作流配置；里程碑使用已保存截止日期，依赖只连接当前可见任务，包括授权范围内的跨项目依赖。不导入参考项目的示例任务、假进度或数据存储。
- 日期仍由原生日程编辑器显式保存，保留缺失日期、草稿、权限、原文/revision 冲突和采用当前版本语义；不通过拖拽自动提交，也不改变任务状态。修正画布内部排序覆盖页面排序的问题，删除旧时间线专用样式。
- 隔离真实 API/Worker/PostgreSQL/Markdown 浏览器验证了日期保存、并发版本冲突与草稿恢复、项目路由范围、搜索/排序/分组、周/月/季及日期跳转、任务和里程碑详情、已完成/取消入口、受限只读账号、深色与390px窄屏。构建产物另经浏览器验证，两轴滚动保持任务栏/日期表头固定，页面无横向溢出。截图位于本地 `.local/evidence/timeline-replica-20261027/`。
- 最终 `pnpm check:web` 的 ESLint、TypeScript 和 Vite 构建通过；`node --test tests/task-collection.test.ts tests/project-task-editing.test.ts` 为16通过、0失败、0跳过。保留既有大 chunk 和混合导入告警。未修改后端合同、未迁移或重启既有 API/Worker，未向既有工作区写入验收数据，未修改参考仓库。

<a id="agent-shared-conversation"></a>

## 共享 Agent 对话与任务选择

- 两个 `gpt-6.1-sol / xhigh` 子代理分别实现共享对话控制器与任务选择，主线程集成并验收。任务详情侧栏和完整 Agent 页共用 `AgentConversation`，移除“来源已固定”及旧入口 revision 参数，保留真实未保存草稿提示。
- 任务入口默认选中当前任务；选择器支持标题/ID 搜索、切换、清除，仅显示当前授权项目中的有效任务。消息携带任务/项目 ID，不自动附加正文、草稿或版本，不自动授权。失效、归档、权限变化、读取失败均不静默替换选中目标。
- 展开完整页保留同一线程、当前任务、未发送草稿和思考程度；关闭/重开侧栏保留当前输入。新建对话与切换其他历史线程清除旧任务目标；展开交接的草稿消费后不会在刷新时重新出现。
- 隔离真实 API/PostgreSQL/Markdown 与 `deepseek-chat` 浏览器验证：打开/切换任务未创建线程或授权；任务一入口默认选中任务一，切换任务二后持久化消息及模型回答均为任务二；在完整页明确启用 Full access 后切回任务一，真实 `pm_read` 成功读取任务一并返回正确标题。另验证关闭/重开、同线程展开与草稿保留、新建/历史切换、刷新、任务二入口默认值、390px 选择器无横向溢出及 Escape 焦点恢复。
- `pnpm check:web` 的 ESLint、TypeScript、Vite 构建通过；任务可见性/范围/消息边界及会话切换共14项行为回归通过，0失败、0跳过。无后端合同、数据库或 Worker 修改，未重启既有业务服务，未向既有工作区写入验收数据；不将这次定向验证称为全量后端或 Runner 验收。

## My Tasks 参考复刻

此节记录此前仅复刻样式的批次，当时仍保留两个日期页面，未完成入口替换。当前导航和集合语义以下一节“我的任务统一入口”为准。

- 三个 `gpt-6.1-sol / xhigh` 子代理分别实现页面工具栏、紧凑分组列表及原生行内操作，主线程集成并验收。今天与即将到来参考 gr8r-studio My Tasks 的统计摘要、列表/日历切换、32px 共享表头、40px 任务行、36px 分组栏与圆形完成入口；保留搜索、筛选、排序、原生详情和高级视图。
- 不改变原生集合范围：今天显示个人时区的逾期与今日开放任务，即将到来显示明日起七天（含第七天），不额外按本人负责人过滤。任务、项目、状态和优先级均来自当前授权数据；未排期、已完成、已取消及默认排除的归档任务不混入日期分组。
- 完成使用配置工作流与独立生命周期能力，多种完成状态需显式选择；状态、优先级和日期写回同一 Markdown revision。日期编辑器独立于日期行保存：改期移出当前范围或远端版本变化后，仍保留草稿并要求显式采用当前版本；不会自动完成任务或覆盖其他远端字段。
- 隔离真实 API/Worker/PostgreSQL/Markdown 浏览器验证了完成、完成目标选择、优先级、跨日期组改期、并发冲突与草稿恢复、清除日期、按日期新建、详情、搜索/筛选/排序、列表/日历和时间线切回今天。只读账号可管理本人关注而不能编辑任务；仅编辑账号可改普通状态与优先级，但完成请求返回403且原文件未变。另验证深色、中英文与390px窄屏，修正窄屏更多按钮错位及误禁用只读用户个人关注的问题。
- 最终 `pnpm check:web` 的 ESLint、TypeScript 与 Vite 构建通过；`node --test tests/task-collection.test.ts tests/project-task-editing.test.ts` 为16通过、0失败、0跳过。保留既有大 chunk 与混合导入告警。构建产物经浏览器实测，既有3222服务上的两个页面亦只读打开确认；截图位于 `.local/evidence/mytasks-replica-20261027/`。
- 未修改后端合同、迁移或重启既有 API/Worker，未向既有工作区写入验收数据，未修改 gr8r-studio 参考仓库；隔离验收环境不代表真实 Agent/Runner 验收。

## 我的任务统一入口

- 两个子代理分别完成 My Tasks 页面与真实任务语义，主线程替换侧栏、面包屑和命令面板入口并集成验收。当前唯一个人任务入口为 `/pm/:workspace/issues?scope=mine`；独立 today/upcoming 页面选择已移除，无兼容别名，旧无效 scope 沿用 all 回退。
- 我的任务严格取当前登录人的 assignee 与授权任务交集，分为逾期、今天、即将到来、已完成。即将到来包括所有未来及未排期任务，不再限七天；已完成按配置类别识别并默认折叠，取消任务排除。搜索、项目筛选、摘要和列表/日历使用同一集合；项目路由不被个人 scope 缩小。
- 新建默认分派本人；今天组预填个人日期，即将到来组预填三天后，已完成组选择真实配置状态。完整创建页继承 mine scope 或安全的我的任务返回路径，显式负责人和恢复草稿不被覆盖；跨项目创建仍要求显式选择项目。完成/重开通过实际原生状态转换和独立生命周期能力写回，不要求额外的普通规划编辑能力；其他字段仍遵守原权限。
- 隔离真实 API/PostgreSQL/Markdown 浏览器验证：本人任务四分组、远期与未排期任务、取消/他人/未分派排除、搜索和项目筛选、列表/日历同集、草稿恢复、今天及已完成组创建、完成与显式选择状态重开。只读账号不能创建或完成；仅有完成/重开能力的账号可执行生命周期转换而不能改优先级。完整创建页验证了 mine 参数/返回来源、显式未分派、固定项目与已有草稿优先级；命令面板导航及项目路由范围亦实测。写入均核对实际原生文件与 revision，不使用 mock。
- 已在既有 3222 页面只读确认“我的任务”单一侧栏入口、面包屑、标题及四分组；另验证390px明暗主题无页面横向溢出。截图保留在 `.local/evidence/mytasks-cutover-20261027/`，含参考站、隔离数据页及既有服务页面。
- 前端 ESLint、TypeScript 与生产构建通过；任务集合、项目编辑、创建、首页、详情与团队动作的47项相关回归通过，0失败、0跳过。保留既有大 chunk 与混合导入构建告警；未修改后端合同，未重启既有服务、未向既有工作区写入验收数据、未改参考仓库。

## Provider 配置对齐 t3code 30eb7e7bb1

- 根据[Provider 差异计划第13节](../reference/t3code-provider-config-diff-30eb7e7bb1.zh.md#v4-provider-alignment)，14个 `gpt-6.1-terra / xhigh` 子代理分别完成公共合同、会话链、两块设置 UI 与10类驱动。基准为计划指定提交的只读 audit worktree，未修改参考仓库。
- 贯通模型 descriptors、服务端共享偏好、默认 / 当前会话选项及原生参数；环境变量区分敏感值与可回显值，默认实例按来源显示 / 重置，维护与健康刷新进入统一操作面。新增完整 FX；Codex managed 安装 / 多账号 OAuth / broker、Claude 宿主空闲压缩、Cursor SDK 参数及其余驱动专属设置与维护按计划接通。
- 保留独立 Provider homes、显式准备、原有 PM 范围复核及审批 / 完成边界，不导入全局账号。修复状态检查阻止并行原生会话、可选默认实例重置后仍启用的问题；重置保留独立账号目录并使旧 revision 失效。
- 实际隔离 HTTP、受控原生 FX 进程与生产构建浏览器验证了配置保存、脱敏、revision 冲突、原生 effort 消费、重启持久化、默认选项 / 模式、专属设置入口、默认实例重置与390px无溢出。最终 Provider / 备份回归264通过、client-runtime 11通过，均无失败 / 跳过；Web 类型检查、Web 与 Agent 构建通过。
- 整包 Agent 最后一轮受并行新增 PM 模块的 strip-only / 类型错误影响，不能使用此前478全绿替代当前结果；`test:backend` 因清单中的测试文件缺失及3600秒限时，只完成部分执行，不计为全量通过。全量文档检查另有3条未修改文档的失效引用，本次4份 Markdown 的链接 / 锚点 / 围栏定向检查通过。完整检查命令、结果边界与截图位置见上述记录。
- 未重启既有服务、修改真实工作区或提交 / 推送。真实供应商账号、生产 OAuth、实际安装下载和商业模型仍未验收。

## Agent Chat 与 PM 工具统一交付

- 四个 `gpt-6.1-terra / xhigh` 子代理完成 PM 工具、Provider 传输、共享 Chat 界面及核心文件差异，主线程集成并执行真实验收。范围、文件落点与证据见[统一改造计划第11—12节](agent-chat-pm-unification-plan.zh.md)。PM 不再另建聊天助手：会话列表、历史、生成、订阅、归档及删除均归 Chat。
- 13个 PM 工具共用注册表、执行入口及原结果核对；十类 Provider 经原生 MCP / CLI / Pi 扩展接入，其中 FX 复用 ACP 传输。不新增工具凭据体系，当前请求沿用 PM 登录、项目范围、revision、幂等和业务权限；未知结果只能核对，不重派写入。标题生成与空闲压缩不开放工具桥。
- PM 侧栏与完整 Chat 共用模型、文本、附件、引用和同一生成；修复真实浏览器复现的侧栏访问 revision 竞争、工具摘要不同步及模型保存后立即展开导致发送卡住。真实 PM 写入后丢弃响应，浏览器核对恢复原收据，调用数不增加；归档/恢复保留 Chat 历史，删除 Chat 不删除 PM 任务。
- 已登记 PM 核心目录的新增/修改/删除保存前后快照与差异，包含直接外部编辑和无效 Markdown；实际新 Node 进程重开 Chat 存储后仍读到历史。首次基线、授权变化、观察时限与不完整扫描不伪造删除；这不是编辑者归因或文件沙箱。
- `0038_unified_agent_tools.sql` 定向丢弃旧 PM 聊天历史，保留业务实体、审计、命令收据及 Chat 历史；迁移仅在隔离测试库验证，未应用到常驻环境。AGENTS.md 本轮只追加“会话与持久化尚未经过统一设计”提醒。
- `pnpm check` 通过（无数据库用例360通过、6跳过，跳过不计通过）；`pnpm test:agent` 共505通过、0失败/跳过，Agent 构建通过；Web lint / 类型 / 构建、Agent lint 及6项前端行为回归通过。全量后端115文件初轮800通过，23项受端口约束、缺 PostgreSQL 客户端或 S3 fixture 影响；按真实依赖补跑15项 Worker/automation/outbox、1项完整备份恢复、7项 MinIO 协议，均通过且无跳过。823项证据来自全量加分环境补跑，不宣称单次全绿；PM 工具数据库定向10项亦全部通过。
- 实际工具、MCP stdio、生产构建浏览器、差异新进程持久化证据保留于 `.local/evidence/unification/`；受控 Provider 只驱动真实业务链路，真实供应商账号与商业模型仍未验收。未重启既有服务、向现有业务工作区写入数据或执行 commit / push。

## Codex existing 原生配置与认证状态

- 两个 `gpt-6.1-sol / xhigh` 子代理完成后端与设置页，主线程集成。existing 支持原生 API / 第三方配置，不统一要求 ChatGPT 登录；明确免 OpenAI 认证时可就绪但身份仍未知，真实认证失败、缺失报告与 managed 账号要求不被绕过。
- 设置页展示实际独立 home / `config.toml` 路径，指引复用原生配置及敏感实例环境变量；不读取配置或凭据、不自动继承全局账号。前端手动检查保留原生认证要求标志。
- 实际 Codex `0.163.0` 经应用运行时读取私有原生配置、携带合成密钥访问本地受控接口并完成回复；定向回归343项全部通过，无失败 / 跳过。证据、构建与验收边界见[专项记录第14节](../reference/t3code-provider-config-diff-30eb7e7bb1.zh.md#v4-codex-native-configuration)；真实接口 / 密钥仍由使用者配置，不宣称现有空配置实例已可用。

<a id="activity-replica"></a>

## Activity 参考复刻

- 两个 `gpt-6.1-sol` 子代理分别实现活动数据适配和页面；当前工具未暴露有效 effort，不能独立确认用户指定的 `xhigh`。只读参考 gr8r-studio 的 Activity、活动行和时间线样式，不导入示例事实或修改参考仓库。
- `/pm/<workspace>/notifications` 默认使用 820px 单列活动流、连线头像行、日期分组、全部/状态变更/评论/项目和人员筛选、真实任务/评论锚点/项目链接及相对/绝对时间；个人通知保留在 `?section=notifications`，原通知布局偏好、已读/归档与收据机制不变。
- 项目详情“活动”页与通知收件箱共用主从展示：左侧审计条目列表（搜索、刷新、加载更早记录），可打开的文档、任务、项目等条目带跳转标记，点击后在右侧复用既有对象详情面板（与看板/集合的右侧检查器一致）；评论、关注、收藏等无对象详情来源保持静态且不打开右侧。审计仍只读，保留 `audit.read`/`domain.read` 裁剪与既有权限/字段边界，不新增任务或通知写入。
- 复用当前核心文件、成员目录、个人时区、项目审计和 changes 接口，不修改后端合同或权限。已有 `audit.read` 才能读取审计操作者/字段差异；普通读者只看到授权的保留事件元数据，明确生命周期事件可作为状态变更，但泛化更新不能推测状态。评论链接通过当前授权任务评论解析，不拿评论 UUID 当任务 ID。
- 同项目优先采用审计，避免以时间近似合并导致重复；因此不把审计未覆盖的外部修改冒充完整工作区历史。已删除项目无法通过当前审计接口查询；缺失/已删除/不可解析目标不链接。遵守 INV-01/20、PROJ-INV-05、SC-14/20、INF-03/06；展示动态不会改变任务或通知状态。
- 隔离 PostgreSQL schema、临时 Markdown 根和真实 HTTP 服务中的生产构建浏览器已验证：四类筛选、成员与无结果清除、评论目标锚点、个人通知已读/归档（API 重读 version=3）、返回活动、实际发布事件后的实时刷新、普通读者只见单项目且未请求审计、390px 浅色中文/深色英文无横向溢出。截图在 `.local/evidence/activity-replica/`。
- Activity 和通知模型回归17项通过、0失败/跳过；首次两项失败来自测试夹具把已审计项目当流来源、给关注记录套用状态差异，已按真实持久记录修正。前端 ESLint、TypeScript 与 Vite 构建通过，保留既有大 chunk 和混合导入提示。未迁移/重启既有业务服务、向真实工作区写入验收数据或执行 commit/push。
- 会话与持久化尚未经过统一设计，当前仍沿用 Agent Chat 的保存方式；本次只读活动页不改变这一边界。

## Provider 原生配置流程切换

- 按用户要求取消 Provider 强制独立 Home，现有 CLI 沿用服务用户的原生配置和凭据，实例环境覆盖宿主同名值；应用私有 runtime/profile 状态仍独立保存。服务与桌面启动器、Usage、原生续聊 revision 和离线备份同步切换，PM 权限与业务规则不变。
- Codex 改为来源的“使用现有 CLI / 继续使用 ChatGPT”入口；删除配置文件路径教程和常驻模式选择器。Cursor 密钥与浏览器登录切换、ACP local 短流程及草稿保护均已实际操作。
- 本节取代上方 Codex / Provider 记录中的强制独立 Home、全局原生账号禁用和配置文件引导。两个 `gpt-6.1-sol / xhigh` 子代理实现，主线程完成集成与实际验证。
- Agent 全量534项、客户端运行时11项、桌面相关5项均通过，无失败 / 跳过；类型检查、受影响文件 oxlint 与生产构建通过。空配置字段的现有 CLI 实际调用 `gpt-6.1-sol` 返回 `NATIVE_HOST_PROVIDER_OK`。另通过生产 Web 与实际 Codex 验证无配置文件的启动参数、宿主变量继承、敏感覆盖及两轮原生回复。使用临时 Agent 数据与 PM scope fixture，不宣称真实业务工具验收。
- 受管运行时准备成功；ChatGPT discovery 在本机返回HTTP403，真实 OAuth 尚未通过。完整证据与发布状态见[专项记录第15节](../reference/t3code-provider-config-diff-30eb7e7bb1.zh.md#v4-native-provider-flow)。
- 2026-10-29 已更新 `3224` 的生产 Web 并恢复新 Agent `4325`；实际设置页 Codex 检查成功，空 Home / Shadow / 启动参数和零实例变量下识别原生认证、列出 `gpt-6.1-sol`。PM API / Worker / 网关进程均保留。
- PM 就绪检查仍为503：只读核查数据库缺少已有的 `0039_document_sources.sql`，其余38项与生产目录 checksum 一致。未擅自迁移无关文档来源功能，不把 Provider 验证扩大成整套 PM 已就绪。

## 输入框模型列表空状态修复

- 新会话默认模型为空时，选择器曾用空 Provider ID 过滤掉已有模型。`composer-model-picker.aui.tsx` 现在单独解析浏览分区，使空 / 已移除分区及异步目录可以展示真实模型；不自动替换或保存实际模型选择，刷新中不显示假空列表。
- 已发布至 `3224`，无服务重启。真实聊天输入框直接展示8个 Codex 模型；明确选择 `gpt-6.1-sol` 后服务端保存成功、刷新保持、输入文字后可发送。打开 / 取消不创建会话或修改默认值；用于验收的新空会话已删除，未执行模型或写入 PM 业务对象。
- 暂缓并放行真实模型目录请求，加载状态与后续列表均正确；390px 无横向溢出。受影响文件 oxlint、Web 类型检查及构建通过。详情与证据见[专项记录第16节](../reference/t3code-provider-config-diff-30eb7e7bb1.zh.md#v4-composer-model-picker-fix)。

## 输入框思考程度与隐藏用量

- 对照 t3code 能力菜单，模型旁直接显示当前思考程度；实际 descriptor 决定可选档位、默认标记和其他能力项。当前会话保存保留其他选项，失败可重试且不能发送，不改全局默认、Provider 配置或原生 Home。
- 隐藏上下文 / token / 费用和本轮供应商用量，移除对应轮询与无用展示辅助代码；后台记账、独立 Usage 页和显式 `/usage-limits` 不变。
- 两个 `gpt-6.1-sol / xhigh` 子代理交付菜单及临时原生协议服务；主线程验证浏览器保存、刷新、失败 / 延迟 / 重试、键盘、运行中保护和390px布局。实际 Codex 连续两轮向受控 Responses 端点发送 `reasoning.effort=xhigh` 并完成；原生账本有用量时仍隐藏两块展示，额度命令不执行模型。
- Web 类型检查、受影响文件 oxlint、2项既有 Usage 行为测试和生产构建通过；无后端合同、数据库或权限修改。验证边界与本机证据见[专项记录第17节](../reference/t3code-provider-config-diff-30eb7e7bb1.zh.md#v4-composer-effort)。
- 已在实际 `3224` 当前并行聊天布局验证保存 `xhigh`、刷新回读、输入可发送、390px菜单和隐藏用量；不覆盖并行 UI，不重启既有服务。只删除本轮创建的空验收会话，原会话与全局默认不变；真实工作区未发送模型请求。

## Agent 主页排列对齐 t3code

- 2026-10-29，三个 `gpt-6.1-terra / max` 子代理分别交付侧栏/外壳、Composer、详情/Inspector，主线程集成；项目内 `.omp/agents/layout-terra.md` 固定该模型及思考等级。只读参考 t3code `d53873b6a4799e87afd63c8d288ef0089f5a3748`，不替换 PM 前端或修改参考仓库。
- 侧栏集中搜索、筛选、完整授权目录选择和新建入口；会话按 Pinned / Active / Snoozed / Settled 平铺，保留原操作菜单。自动化改成独立导航行；设置、用量和快捷键工具栏位于登录信息上方。顶栏整合面包屑、侧栏、会话详情、终端、Inspector 及内嵌页展开/关闭；工具标签收进已打开的 Inspector。
- 项目化欢迎区与 Composer 在新会话/成功读取的空历史居中，消息出现后停靠底部。模型、能力选项、交互模式在左，任务引用、附件、可选听写和发送/停止在右；逐段/整轮移入更多菜单。设置确认回包同步会话元数据，避免新 Provider 已保存而侧栏仍显示未选择。
- 实际浏览器复现并修复自动化草稿绕过离页确认，以及同一路径查询参数变化的浏览器后退未受保护。显式导航共用现有草稿检查，浏览器前进/后退由 Router blocker 处理；取消仍留在自动化，确认离开后草稿仍可恢复。窄幅自动化按实际容器宽度适配，不再按整个浏览器宽度保留固定规则侧栏。
- 真实 `3224` 验证：空项目选择、作用域欢迎区、模型/Max/计划模式保存、逐段/整轮切换、附件添加/移除及取消离页保护、详情/会话参数、Files/Git/Browser、Inspector 键盘标签切换、终端 `pwd`、Usage 页面、快捷键帮助、内嵌详情及展开完整 Chat。390px 页面无横向溢出；379px 内嵌自动化为单列且无横向溢出。注入单次历史503后显示错误、隐藏欢迎区并禁止发送；刷新恢复真实历史及文字草稿，成功空历史刷新仍显示欢迎区。
- Codex `gpt-6.1-terra` 实际返回“布局验收通过”，输入框完成从欢迎区到消息底部的切换。该轮同时出现 PM 访问范围核验/核心观察不可用提示；当前 PM `agent-issues` 路由返回404，任务引用成功路径未验收，不冒充完整 PM 工具或真实 Agent 总体验收。
- 受影响 Agent 前端 oxlint、最终 Web TypeScript 与 Vite 生产构建通过；会话访问竞争、设置并发保存、自动化 journal 和 Usage 命令共12项既有行为回归通过，无跳过。首次测试使用缺少 dist 的默认包条件，改用仓库 `development` 条件后 Usage 两项通过；刷新合同声明后完成类型检查。构建保留大 chunk 与混合导入提示。
- 已更新生产 Web，未重启 PM / Worker / Agent / 网关，未迁移数据库或写入 PM 业务对象；仅删除本轮两条验收会话和临时附件输入。截图位于 `.local/evidence/t3code-layout-20261029/`。会话与持久化尚未经过统一设计，当前仍沿用 Agent Chat 保存方式；本次没有新增权限、PR、自动完成规则或持久化方案。

## gr8r-studio 新建项目界面（2026-10-30）

- 两个 `gpt-6.1-sol / xhigh` 子代理分别交付专用项目表单与紧凑保存位置；主代理集成宿主、创建字段映射并实看参考和目标浏览器。参考只读，未替换既有前端、后端或权限体系。
- 项目创建显示名称/描述、图标色板、真实负责人、目标日期和七张模板卡片；只有空白模板可用。团队关联仍在创建后的项目设置独立保存，不制造未落盘的选择或样例任务。`x-pm-icon` / `x-pm-color` 使用既有 Markdown 扩展字段，在原创建请求内保存。
- 580px 弹窗采用单个正文滚动区和固定标题/底部操作；390px 保持页面宽度390px。中英、浅色中文/深色英文已实看；目录失败在保存位置附近展示，预检失败禁止创建。初始化安全说明和高级属性折叠但可访问。
- 隔离 PostgreSQL schema、真实 API/Worker、临时项目根目录与 Web 中实际创建两个项目。名称、完整 Markdown 正文、图标、颜色、负责人和日期经权威 workspace API 重读核对；没有生成任务。取消/刷新后字段恢复，刷新要求重新预检；目录重名拒绝、键盘图标切换、Ctrl/Cmd+Enter 及合成 IME 组合事件不提交均已操作。修复快速切换焦点时异步旧草稿短暂覆盖新输入的显示问题；原恢复与冻结请求协议不变。
- 创建、子任务及项目菜单既有回归24项通过，0失败、0跳过。浏览器未观察到运行时 pageerror；不把合成输入法事件等同于真实设备/输入法验收。没有数据库迁移或既有服务重启，也未向原工作区写入验收项目。
- 最终 `pnpm check:web`（ESLint、TypeScript、Vite 构建）通过，构建保留既有大 chunk/混合导入提示。`pnpm check:docs` 未通过：README 既有 `v4-usage-page-replica-plan.zh.md#8-实施与验收记录2026-10-30` 锚点无法解析，本批未改该 Usage 链接。
- `3224` 已实看新的580px项目弹窗、8个既有图标选项、7张模板卡片、真实负责人和保存位置；仅打开/取消，未提交真实工作区项目。临时脚本和参考副本已删除，两个隔离根目录及临时监听端口均已核对清理；验收夹具关闭时分别将 SIGINT / exit143 记为清理异常，不将进程退出码当作无异常关闭通过。
- 会话与持久化尚未经过统一设计，当前仍沿用 Agent Chat 保存方式；本次项目创建界面没有改变该边界。

## MCP / Skills 与 MCP Apps 宿主接入（2026-11-04，验收中）

按已接受的 [MCP / Skills 复制与适配计划](t3code-mcp-skills-replication-plan.zh.md)先复制固定 `d53873b6a4799e87afd63c8d288ef0089f5a3748` 原始源码，再复用现有 `30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c` vendor 与 PM 宿主接线。以下是本轮独立证据，不继承上方历史全绿结果；不宣称生产部署或全 Provider 真实账号通过。

- 对外 scoped HTTP MCP 与 OAuth authorization code／S256、发现／同意／客户端管理／撤销已实现。入口为 `/agent/settings/mcp-clients`、`/connect-agent` 与 `/mcp`；授权默认只读，明确绑定 PM 主体、workspace／project 和允许的线程集合。外部 token 不接受于普通 PM／Agent API，不以共享 Agent Cookie 冒充批准人。
- 原生 PM 工具继续按 Provider MCP／ACP／SDK／Host Tools 注入，共用当前授权、审批、revision、operationId 与结果核对。Full access 不批准受保护动作；只读也不能经创建／发送 Chat 间接触发写入。未映射的完整上游 delegation／scheduler／设备工具不发布；Chat 成功不完成 WorkItem。
- scoped Skills／commands DTO、按 PM scope 解出的 cwd 目录刷新、Composer `$`／`/`／chip 和显式 session restart 已接入；历史保留、原生 continuation 失效。各 Provider 仍使用自己的目录和 dispatch，disabled／不可用户调用条目不开放；WorkspaceSkill 指令块不改作原生 Skill。OpenCode 只借用匹配已授权 live session 发现，不能为刷新启动插件；Muse／ACP Registry／OMP 的独立 Skill 调用禁用，OMP 命令仅既有 `session` 白名单。完整逐家支持与 transport 限制见计划第10.2节。
- 类型化 MCP App 输出、私有资源、producing item／Server／thread／session 绑定、live lifecycle、工具／资源请求与按项替换／清除的模型上下文已接入。当前原生 live App adapter 为 Codex，其他 Provider 不假报支持。工具完成后可保留可交互 session，停止／配置／范围变更／restart／撤权／shutdown 失效；不会为打开 App 启动新模型轮次。隔离 frame 不加 `allow-same-origin`，UI 工具确认不代替服务端授权。
- Agent 的 `MCP_PUBLIC_ORIGIN` 必须是固定可信 origin；PM 私有回调用 `PM_MCP_AGENT_URL`，只回退既有 `PM_AUTOMATION_AGENT_URL`，不猜 localhost。内部委托复用 `PM_AUTOMATION_SERVICE_SECRET`，以 `pm-mcp-service-v1` 域／audience 分离；实时校验 grant／批准人／范围／能力，秘密不外发。网关不能把内部 introspection 暴露公网；HTTPS、外部可达性与受控部署仍是环境前提。
- 撤销并非 SQLite 与 PostgreSQL 跨存储原子事务，也不回滚已提交业务动作。备份 `--secrets exclude` 和 `include` 均使**导出副本**中的 MCP grants／tokens／consent 与 App model context 失效，不修改源数据库；恢复后重新授权，不恢复 live App session。现有 PM 应用规则及临时 Agent Chat 保存方式保持，统一会话／持久化设计未收口。

### 已收到的主集成证据与缺口

| 检查／场景 | 已观察结果及边界 |
| --- | --- |
| 来源与依赖 | 不可变来源PASS28,234文件；post-lifecycle bg42最终recapture：补充88 outputs、基线164 patches／1214 outputs；imports1295文件／7715 edges／18 packages。最终离线重建／repeat-no-diff／pristine／conflict／mode／symlink／wrong-source／tool drift拒绝检查均true（1296files） |
| 编译／构建 | 最终post-lifecycle bg42 PASS：typecheck:agent、lint:agent、Web tsc、隔离Vite build；PM定向ESLint bg45 exit0。此前lint15项既有automation warnings、client-runtime18/18、contracts112命令／143路径、docs150 Markdown／27计划通过。最终Agent＋隔离Web linux-x64包167 packages／22001 files／292 links；迁址bg46在无关cwd `/tmp`运行PASS，七项artifactHashesAndInternalLinks／diskSdkImports／nativePtyLoad／oneEffectSingleton／documentWorker／productionClaudeHistoryDispatch／apiOnlyProductionHttp均true，取代修正前bg40产物证据；不代表付费推理 |
| 原 vendor 回归 | 311/312文件通过，唯一 Claude metadata失败随后修复，定向 Claude241/241通过；不改写为原全套312/312 |
| 原 Codex pending-output 回归 | 43/43通过，含 terminal 后两项 completed-only Apps、保留 native tools、仅一个模型 turn；受控协议不是付费账号 |
| 真实 CLI Skills 发现 | 实际安装的 codex-cli0.163.0在隔离 HOME 通过 `skills/list` 发现实际 scoped `SKILL.md`；未启动 MCP 或模型 turn。未证明付费／真实账号 Skill 模型行为或所有 Provider |
| OAuth／撤销浏览器 | 同意页默认readonly、显式workspace／thread；callback＋S256200；active MCP session200→UI revoke200→同 session401 |
| Skills 浏览器 | 菜单／选择／chip／显式重启保留草稿与历史，无额外 turn；内嵌菜单白色对比度修复已用截图核对。完整窄屏／键盘／IME矩阵未因此通过 |
| App 浏览器正向 | 原 Codex adapter＋受控 native CLI实际渲染；标准 SDK JSON-RPC初始化、resource read、tool call、context update成功；sandbox恰为`allow-scripts allow-forms`。内嵌此前持续409，修正后隔离fixture6选Skill、新建项目线程POST/chat200、原生turn完成、snapshot GET200、App无需刷新初始化；trace无失败／取消请求。内嵌tool/resource后续结果见交互续验行；不是付费或真实账号turn |
| 原始App grant撤销 | 认证浏览器API确认原full grant仍active；SQLite对应context namespace恰有一条匹配grant／sentinel的revision1记录。携带当前CSRF撤销200后，同namespace为0条；证明已保存model context清除，不仅是bearer session拒绝，不证明跨库原子性 |
| App 导航安全 | 为隔离 port attestation，刻意移除原 pagehide/unload 通知；同 opaque origin、同 WindowProxy 导航，在 image响应被扣留、iframe load之前发送 context/resource/tool三请求。fresh-port超时约2秒失效；后端 call/resource/context POST均0，迟到回复0，context sentinel仍revision1，native日志无额外tool/read/turn。正常pagehide立即失效亦已观察；不替代全部攻击矩阵 |
| App迟到响应隔离 | fixture6通过CDP response stage扣留原App真实resources/read HTTP200，仅移除原pagehide/unload通知以隔离port binding；导航同iframe后，替换页沿用同WindowProxy，在image阻塞load期间发context/resource/tool候选及伪造port。原200在攻击开始后、frame失效／load前释放：替换页JSON-RPC回复0，后端仅原合法resource POST1次，无攻击者context/tool/read POST；frame失效、load未触发。未替换认证或mock响应，与前述候选拦截是独立证据 |
| 内嵌窄屏／键盘／IME | 实际390×844视口，document.scrollWidth390，无横向溢出，Composer／Skills控件可见且已截图。`$`菜单ArrowDown＋Enter选中Smoke Skill chip，Escape关闭，native turn仍2。Chromium CDP原生IME composition产生实际Enter／keyCode229／isComposing=true，中文草稿保留、POST/chat为0；不推及全部实例／scope组合或实体输入法设备 |
| 迟到攻击后的状态核对 | context仍为revision1 sentinel；native日志累计2 turns／4 resource reads（原始捕获资源及合法点击）／1合法tool call，不把合法调用误算为攻击者请求 |
| 完整 Agent suite | bg43 bounded concurrency2：996total／994pass／0fail／1cancel／1skip，628.6秒、exit1。此前unscoped draft及ten-turn修正均在本次完整运行通过；取消为Claude `beforeCacheExpires` compaction（`chat-runtime.test.ts:640`），10秒deadline在10941ms触发。测试deadline随后改30秒，行为断言不变，onReturn／beforeCacheExpires定向2/2通过（2.85秒／2.72秒）；没有之后完整全绿结果，1项真实Linux sandbox skip保留 |
| 完整 backend suite | 1027 total／967 pass／6 fail／7 skip／47 cancel。本轮actorId resolve整对象期望改为行为断言后，定向文件6/6通过；不把局部结果改写为全套通过 |
| 内嵌App交互续验 | 原生tool返回`structuredContent.clicked=true`及native text；resource read返回原native session数据；Set model context返回`{}`。全屏／退出全屏已实看；显式Close App→“重新读取 App”→重新初始化通过，native fixture日志`rpc.method === 'turn/start'`计数前后均2，无额外原生turn。截图：`.tmp/omp-sshots-15bfe177ac813cf1.webp`（内嵌）、`.tmp/omp-sshots-15bfe18ea3813cf2.webp`（全屏） |
| 官方SDK及安全回归 | bg49官方MCP SDK1.32.2 Client＋StreamableHTTPClientTransport真实loopback HTTP通过initialize／readonly目录过滤／允许thread读取／ping／terminateSession／重连后撤权拒绝；使用预批准synthetic grant与受控PM catalog，不是完整SDK OAuth流程。此前两次失败为fixture目录shape及可选isError断言。bg43有界OAuth／权限／HTTP session／工具安全回归均通过，详见计划E3及主集成记录artifact225:2790-2876，不扩大为全部真实PM攻击／unknown副作用通过 |
| 剩余检查槽 | 完整Agent仍非全绿，deadline修正仅定向通过；T13完成。完整SDK OAuth、剩余真实PM安全／浏览器组合、付费模型、逐Provider账号与生产发布，以及backend环境／无关阻塞仍保留 |

backend剩余环境／无关阻塞保留：guard只接受55444，拒绝自有临时PG16的32768；缺少`pg_dump16`、不安全TMPDIR Git根、Web filter模型迁移／project-audit失败及S3不可用。生产55444不可用，临时库不代表生产就绪。root类型检查的无关Web错误未变。此前root unit459pass／2个旧OpenAPI失败／6 DBskip、Agent strip-only TS parameter property和过时runtime mocks记录是历史，不能以修正或当前定向结果宣称完整回归全绿。文档代理未执行测试／构建／浏览器；上述结果来自主集成提供的观察，逐标准缺口见计划第10.3节。

内嵌lifecycle修正：取消snapshot授权请求不再错误关闭保留lease，并增加generation完成后的UI gating。此前409的旧trace不能区分readiness与取消授权检查丢失lease，不能单因归因；两处均已修正并回归覆盖。隔离fixture6的无需刷新初始化、后续交互及重新打开无额外turn已通过上述浏览器复验；execution＋App requests定向55/55通过，包含取消保留仍获授权lease及取消仍撤销已拒绝authority。不是完整Agent suite重新通过。

本轮未获生产部署／重启或真实凭据导入授权，未执行这些操作；未commit／push，未写业务审核或完成任务。

主集成已清理自有smoke脚本5个及服务／临时数据库／浏览器与测试数据，生产未触及。源码＋产物交付保留在`.local/mcp-skills-artifact-HWjm8O/agent`：仅Agent＋Web，不是整套PM／DB部署；从已通过迁址验证的包复制并保留相对symlink。保留副本bg50在cwd `/tmp`、linux-x64下通过与bg46相同的七项runtime验证；最终docs／contract／import检查通过：150份Markdown／27计划、112命令／143路径、1295文件／7715 imports／18 packages。T1—T13按有界证据完成；T14受真实Provider／账号／平台矩阵及backend环境／无关失败阻塞；T15未授权、未执行，M5／M6不签收。

## Windows / macOS Desktop 独立运行时

- 按用户选择，以六个 `openai-codex/gpt-6.1-sol:xhigh` 子代理实现 Electron 宿主、受管 PostgreSQL、进程生命周期、跨平台核心文件/附件存储和原生打包；主线程集成初始化、完整备份恢复及实际运行验证。只读参考 t3code，不替换已有 Web，不复用或重启原开发服务，不导入真实凭据。
- 目标为 Windows x64 NSIS、macOS 15+ arm64/x64 DMG/ZIP。安装资源包含 Node 24.21.0、PostgreSQL 16.15 完整运行时、PM/Worker、Agent 原生依赖闭包及生产 Web；运行时按目标平台下载、固定校验、离线启动。没有 Linux 发布目标、自动更新源或自动 Release。
- 本地实例自行初始化数据库、应用存储、账号及工作区；不保存初始账号明文密码。稳定公共 origin 与实例身份绑定浏览器分区；仅监督自有进程，端口/数据身份冲突拒绝接管。数据库关机超时保留进程与锁，允许重试，避免以 SIGKILL 冒充正常停止。
- 复用现有 HTTP/Agent 授权和业务规则。Electron 启用 renderer sandbox/contextIsolation，禁用 Node 集成；原生 IPC 仅限可信顶层连接窗口。跨平台路径和文件身份规则落到核心/基础设施，新增 `0046_native_absolute_paths.sql` 正向迁移，不改写旧迁移。Windows ACL/reparse 检查及 Job Object 监督由原生 CI 单独验证，不把 Linux 用例视为 Windows 证据。
- 离线完整备份通过真实 `pg_dump`、现有 PM 检查点/附件备份与 Agent 备份实现；恢复使用新目录、新 PG 凭据、新实例身份和存储绑定，最后登记 bootstrap。账号和业务对象保留，浏览器 Cookie/客户端日志不复制；外部目录需重新关联。备份明确包含私密数据，只接受同 OS 恢复。详细范围与操作见 [README Desktop](../../README.md#desktopwindows--macos)。
- 已在隔离 Debian 12 容器、实际 bundled Node/PG 下完成：真实初始化/登录/授权工作区、项目和 Markdown 文档创建、附件上传、停止/重启、稳定 origin、完整备份、独立恢复后原账号/文档/附件内容一致。匿名附件请求401，非空恢复目标拒绝，所有本次拥有的服务退出。没有用 mock 数据库或业务 API 替代这条路径。
- 已用真实 electron-builder 组装含 `app.asar`、生产 workspace 和完整运行时的 Linux 目录验证产物；对该产物资源执行原生 SDK/PTY 加载、初始化、登录、Agent 访问、Web 服务、同一实例重启与进程清理冒烟，全部通过，`PATH` 不依赖宿主开发工具。这是验证资源闭包，不是 Windows/macOS 安装包，也不证明真实 Provider 推理。
- 实际 Electron GUI 验证发现安装资源继承构建目录 `0700`，导致不同用户无法读取启动文件；`afterPack` 现在把公共程序目录规范为 `0755`、普通源码文件 `0644`，保留可执行位及 pinned runtime 文件模式，不改变私有工作区权限。在安装资源由 root 拥有、桌面以普通用户运行的容器中完成了修复后验证。
- 实际界面完成首次账号创建、PM 登录/授权工作区选择、产品菜单切到 Agent、关闭工作区窗口仍保留5个自有服务、重新打开、原生取消停止保持认证、确认 Disconnect 后自有服务为0，以及完整退出/再启动后的稳定 origin、localStorage 标记和 PM 登录态保留。初始密码未回填，业务 renderer 的 Node/原生桥均不可见。原生 Quit 确认后应用退出0；修复重新打开后仍显示“窗口已关闭”的状态文字。截图与结构化证据：`.local/evidence/desktop-runtime-QMmTDz/`。
- 桌面原有52项全通过；新增默认项目目录和数据库慢关机回归后，受影响23项通过，均无跳过。Agent 备份/访问19项通过。PM、Agent、Web 与 Desktop 的对应类型检查/生产构建通过，文档与 OpenAPI 检查通过。受影响 oxlint 无 error、保留4条 warning（控制字符匹配和 finally 清理错误）；不宣称零警告。
- 后端入口的153文件清单按隔离运行及失败/未完成文件续跑覆盖，逐文件最后结果合并为 **1043项：1034通过、2失败、7跳过、0取消；150/153文件通过**，不是一次连续全绿。保留失败为 `artifact-files-model.test.ts` 的旧 filter 合同、`project-audit.integration.test.ts` 的原始正文留存断言；S3 的7项因未配置服务跳过，不计通过。未放宽这些断言或改动无关 Web 逻辑。完整逐文件记录在上述证据目录 `backend-evidence.json`。
- 回归修复了本次跨平台目录 guard 把已知不安全路径转成409/503的问题：底层静态拒绝保留 `EPERM`，文档边界在变更前转换为原有403；目录身份变化/未知副作用不改成成功。原有文档读写及安全真实 HTTP 回归16项最终全通过，另以直接文件系统冒烟确认正常文档读写、链接读写均403且外部文件未改变。原生平台/权限5项、附件10项、完整项目备份恢复和 Worker/outbox/UUID 回归也通过。
- 回归使用自有 PostgreSQL、独立网络命名空间、Git/完整 PG 客户端及私有临时目录；命名空间内部55444只用于满足既有测试防护，未连接宿主55444。只读源码挂载下的 `.local` 写入通过独立临时挂载隔离，不向仓库原测试/审计目录写入。已清理自有 GUI 账号/数据、临时脚本/构建目录、验证容器和命名镜像；仅保留证据与开发运行时缓存。
- 全仓根类型检查仍被无关 Web/测试合同错误阻塞：notification-inbox、project-files、agent-file-areas 测试 actorId、artifact filter、document-sources fixture exactOptionalPropertyTypes、graph-flow 可空值。未覆盖并行改动，不把局部检查记为全仓 `pnpm check` 通过。
- 用户已授权并执行全部项目更新的 commit/push，首批提交为 `4bcf7f276f1fe5ec55a35348adeec592edf01207`（504 个文件）；后续原生 CI 修复单独提交。[GitHub Actions](../../.github/workflows/desktop.yml) 使用 Windows 2025、macOS 15 Intel/arm64 原生 runner，显式构建 unsigned 测试包、执行真实 PG/文件权限回归及打包资源的登录/停止/重连冒烟；产物含 SHA256 清单，保留14天，不自动创建 GitHub Release。
- Agent bundler 先识别原生绝对文件路径，再处理外部包，避免 Windows 盘符入口被误标为 external。构建脚本变更仅重采集已审阅的对应 `hostBuildInputs` SHA256；保留 SDK/Effect 外部依赖边界、测试支持拒绝规则与构建输入的严格校验。
- 最终同提交原生验证：[Actions run 41750883115](https://github.com/Crsei/project-management-agent-v4/actions/runs/41750883115)，源码 `a063dc07b06f82c1123dfeeb3f93b22b0fb33542`，Windows x64、macOS Intel 与 Apple Silicon 三个 unsigned 任务全部成功。macOS 两架构各为桌面55/55、原生文件/附件15/15通过；Windows 为桌面53通过、2项符号链接用例跳过，原生文件/附件17/17通过，均无失败。跳过项不计通过；signed 任务按本次 unsigned 输入未执行。
- 三架构均对实际打包资源完成 SDK/PTY 原生依赖加载、受管 PG 初始化、迁移及存储 bootstrap、密码登录、授权工作区、Agent/Web 访问、同一实例停止/重启和自有进程清理，全部返回成功且不依赖宿主开发工具 `PATH`。输出读取回归以真实子进程的缓冲输出延迟消费覆盖 `exit`/`close` 边界，不依赖 POSIX 后代管道继承。日志保存在 `.local/evidence/desktop-ci-a063dc0/`。
- 本次可下载产物：[Windows x64 NSIS](https://github.com/Crsei/project-management-agent-v4/actions/runs/41750883115/artifacts/13288840567)、[macOS Intel DMG/ZIP](https://github.com/Crsei/project-management-agent-v4/actions/runs/41750883115/artifacts/13286788249)、[macOS Apple Silicon DMG/ZIP](https://github.com/Crsei/project-management-agent-v4/actions/runs/41750883115/artifacts/13286046556)。这些是私有仓库的限时 Actions artifacts，需仓库访问权限；含 `desktop-package.json` SHA256 清单，不是正式 Release。
- 原生构建和服务冒烟不等于已完成目标系统的安装/卸载、GUI 人工验收或真实 Provider 推理。正式 Windows Authenticode、macOS Developer ID 签名与公证仍需发布者材料及受保护的 `desktop-signing` 环境；signed 缺少材料时失败，不退化为 unsigned。macOS ad-hoc 测试签名不算正式签名或公证。
- 会话与持久化尚未统一设计收口，仍沿用 Agent Chat 保存方式；桌面备份不消除尚未确认客户端操作的未知副作用。Linux descriptor-relative 保证不等同于 macOS/Windows 路径校验，Windows 目录元数据断电持久性受 Node 能力限制；不宣称新增同用户文件系统安全沙箱。
