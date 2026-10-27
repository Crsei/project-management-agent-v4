# Teams 1–3 正式能力补齐计划

状态：T01–T08 已完成实现、回归、真实浏览器验收与本机激活。用户授权制定计划并由 `gpt-6.1-sol / xhigh` 子代理执行；正式入口为 `/pm/<workspace>/teams?view=team1..3`，不以 Lab 或浏览器假响应交付。

## 1. 基线与复用

- 依据[领域计划第七节](../domain-design/README.md#implementation-plan)、[不变量](../domain-design/invariants.md)、[权限](../domain-design/permissions.md)、[后端交付记录](backend-delivery.md)及[Markdown 权威 ADR](markdown-integration-adr.zh.md)。
- 仓库已完成[项目团队与关联](project-backend-completion.md)、[成员资料/邀请/目录](member-backend-completion.md)及 Dashboard 在线心跳。旧 Teams 适配器未接入这些事实，不再建设第二套团队、成员、邀请或在线状态存储。
- 核心项目和工作项仍以 Markdown 为权威；团队组织与个人容量为 SQL 协作记录。维护者是团队职责，不授予工作区/项目能力。
- 邮件邀请复用真实 SMTP/Worker 生命周期。缺少运营配置时仍禁用，不把本机接收测试称为公网送达。

## 2. 工作包与验收

| 编号 | 能力 | 决策与验收 | 状态 |
| --- | --- | --- | --- |
| T01 | 团队定义与职责 | 扩展既有 project_team：标识、说明、工作方向、响应目标小时数、维护者；维护者必须是当前团队有效成员。新增/编辑/归档/成员关系沿用既有 CAS、命令收据和 outbox。旧记录增量迁移，不伪造既有事实 | 已实现并烟测 |
| T02 | 团队项目与统计 | 复用 SetProjectTeams；查询只汇总当前可见关联项目的未终结工作项，去重；最近活动来自真实团队/关联记录时间，不制造历史。受限读者不得获得隐藏成员、项目或统计 | 已实现并烟测 |
| T03 | 成员目录、资料、邀请、在线 | 接入 MemberDirectory 脱敏数据、本人资料编辑、既有邀请表单及管理入口和真实 TTL 在线状态；未知联系方式不能复制。普通成员不需要 access.manage 才能读取合法目录 | 已实现并烟测 |
| T04 | 工作量与容量 | 新增显式成员容量，单位为“并行未完成工作估算点”，不是周工时；null 是未知，0 是明确零。工作项估算使用 Markdown 数值扩展字段 x-pm-estimate，不创建 SQL 任务副本 | 已实现并烟测 |
| T05 | 超载与筛选 | 应用层基于当前授权工作项计算已知点数、缺估算数量和容量；已知点数超容量可确认超载，其余在估算不全或读取范围不完整时为未知。终结/归档任务不占用开放容量。团队/状态/任务池筛选一致 | 已实现并烟测 |
| T06 | 任务卡写入 | 从成员任务卡选择合法项目创建并分配任务；复用已有核心创建命令、revision 和未知结果核对。估算通过原生文件 PATCH，保留冲突草稿，不绕过真实配置与权限 | 已实现并烟测 |
| T07 | 三页正式接入 | 保留已复刻布局，接入真实命令、统计、分组、头像、维护者及容量编辑；加载/空/错误/撤权分开处理；手机无页面横溢 | 已实现并烟测 |
| T08 | 真实验收与激活 | 合同生成、后端 lint/types/build、真实 PostgreSQL 事务与权限回归、前端检查，隔离 API/Worker/Web 的真实浏览器写入刷新；核对本项目进程后激活，不写用户业务数据 | 已验证并激活 |

## 3. 规则

沿用 INV-01/08/13/14/15/20、SC-12/13/14/20、PROJ-INV-03/06、MEMBER-INV-01/03/04、DASH-INV-02。业务守卫在 application/domain；前端统计不得扩大可见范围或决定任务完成。

- 团队及容量维护要求无限制工作区 access.manage；关联项目另外要求实际项目读取及可写性，团队归属不等于权限。
- 维护者集合必须包含于有效团队成员；移除成员同步移除其维护者职责。历史撤权成员不可成为新关系目标。
- 估算和容量仅接受 0–1,000,000 的有限数值；缺失/清空不同于零。容量首次写入不带旧记录目标；已有容量必须提供记录 targetId 及 expectedVersions。部分授权范围不能用局部负载宣称全局未超载。
- `x-pm-estimate` 是 work_item 专用保留字段，不允许工作区再定义同名自定义字段；原有自定义配置若占用此名，需先移除该自定义定义并使用原生数值字段。PATCH null 删除字段，不能把缺失值强制转换成零。
- 已知开放点数与超载覆盖当前授权的全部开放工作，UI 搜索/状态筛选只缩小任务列表，不重算成虚假的个人总容量。当前授权内的任务即使受派人已失效也保留，身份置空并标记 unavailable。
- 响应目标是显式配置，不表示已提供计时、告警或 SLA 达标评估。团队不是部门，不伪造部门标签。
- 命令丢响应查询原收据；原生 PATCH 丢响应读取原文件再显式处理，不自动重放。

## 4. 子代理所有权与共享接口

统一使用项目级 `gpt-6.1-sol / xhigh` 代理；禁止中途 build/lint/test/formatter，最终由主代理统一验证。不得读取凭据文件、改动其他页面、重启既有服务或生成中间合同。

1. **TeamsDomain**：project-directory 领域/应用扩展、新 team-directory 领域/reader、迁移 `0018_team_details.sql`、团队业务回归。导出 `readTeamDirectory(ctx)` / `TeamDirectory`，扩展既有 `projectDirectoryCommands`。不改共享 registry/API/client/OpenAPI/hooks。
2. **TeamsWorkload**：新 domain/application/team-workload.ts、迁移 `0019_team_capacity.sql`、必要核心估算读出及领域验证、容量/工作量回归。导出 `teamWorkloadCommands`、`readTeamWorkload(ctx)` / `TeamWorkload`；命令 `SetMemberCapacity`。不改共享注册或前端。
3. **TeamsFrontend**：service-teams.tsx、团队三种受控内容和 CSS/契约、团队编辑器；复用现有成员编辑器与邀请 hooks。拥有三个页面的整合，不改共享 API/client/pm-service。调用主代理提供 `useTeamDirectory()` / `useTeamWorkload()`。
4. **TeamsTaskActions**：新 team-task-actions.tsx、必要独立原生估算编辑工具及行为回归。提供成员卡创建任务、任务估算、成员容量编辑的可嵌入组件，由 TeamsFrontend 接入；不改 service-teams 或三种视图主体。
5. **主代理**：本计划/领域规则、registry/API/client/OpenAPI/hooks/缓存和收据分类的唯一整合负责人；统一测试、真实服务与浏览器烟测、部署核验及文档记录。

共享新增查询：`GET /api/v1/workspaces/:workspaceId/teams/directory`、`/teams/workload`；客户端 `getTeamDirectory(workspaceId, options?)`、`getTeamWorkload(workspaceId, options?)` 返回具名 DTO。DTO 由所属后端子代理先落盘并通知其他代理；不通过未验证的强制类型转换消除接口差异。

## 5. 验证记录

### 5.1 已执行检查

- `TMPDIR=/dev/shm pnpm check`：文档、92 个命令/32 条路径合同、后端 ESLint、类型、278 个单元测试（零跳过）及后端构建通过。
- 前端 `lint`、Teams 三个内容组件/共享契约定向 ESLint、全量 `typecheck` 与隔离 Vite 构建通过；产物在 `/dev/shm/pm-teams-completion-build`，未覆盖默认产物。大 chunk 和 `workflow-canvas.tsx` 混合导入告警保留。
- 首轮真实 PostgreSQL 回归暴露已有团队数据迁移的延迟触发器问题：回填后立即重新启用触发器会被 PostgreSQL 拒绝。已在重新启用前执行现有 `dashboard_time_validation`，随后恢复其延迟模式；不跳过约束、不伪造历史时间或 CAS 版本。针对历史活动/归档团队的迁移回归 2/2 通过；随后 `TMPDIR=/dev/shm pnpm test:backend` 418/418 通过，零失败、零取消、零跳过；最终后端构建通过。

### 5.2 真实浏览器与权限

使用两个自有随机 schema、临时 Markdown/blob 目录、独立 API/Worker、回环 SMTP 接收端和 `3349` 临时 Web；正常账号登录，无浏览器假响应。所有验收数据均不在既有业务工作区。

- Team 1 页面创建完整团队字段，保存成员与维护者、关联真实项目，读取实际未完成数量；另一个真实命令引发版本变化后，当前编辑器保留说明草稿、禁止保存，显式采用版本后提交成功；另建团队并确认归档后退出活动列表。
- Team 2 页面保存本人岗位/电话；从邀请入口提交，独立 Worker 经真实 SMTP 发送，接受接口使用邮件中的实际 token 完成接受；刷新目录显示新成员。不把 SMTP 接受等同公网收件箱送达。
- Team 3 页面从 Ada 成员卡创建并分配实际任务，结果保留配置初始状态 todo，未自动完成；原生估算依次写入零、清空和 8，容量 5 时确认超载，刷新后保留。容量改为 10 后，部分项目读者的超载仍为 null，而不是假称全局未超载。
- 真实受限账号：隐藏项目/任务/成员 ID 不出现在两个 Teams DTO；其他人的电话/邮箱不展示，写入口禁用。可见项目中历史受派人失效的任务保留在任务池，assigneeId 为 null、assigneeStatus 为 unavailable。
- 三页桌面 1440×1000、手机 390×844 实际表面均检查，手机 document/body scrollWidth 均为 390；Team 1 宽表采用内部横滚。

证据目录 `.local/evidence/teams-backend/`：`team1..3-desktop.png`、`team1..3-mobile.png`、`team-conflict.png`、`task-pool.png`、`scoped-reader.png`、`viewports.json`、`scoped-reader.json`、两轮 `service-snapshot*.json`。首轮 SMTP 测试配置使用不被安全配置接受的 HTTP 主机，独立 Worker 未启动；已销毁该隔离环境，改用合法 localhost 配置重跑邮件闭环，不修改生产安全校验。

### 5.3 激活与边界

- 经脚本核对 PID、启动身份、工作目录及编译入口，仅停止本项目 API `58552` / Worker `58539`，迁移到 `0019_team_capacity.sql` 后启动 API `33004` / Worker `33003`。`4100/health/ready` 返回 200，database/storage/worker/core 全部为 true，quarantinedEvents 为 0；两个新增 Teams 路由未认证实测返回 401，而不是 404。
- 既有前端 `3220` / `3221` 的 PID `43740` / `12179` 保持不变；临时 Web/API/Worker 已停止，两套随机 schema 与临时业务目录已销毁，烟测脚本已移除。证据保留；未 commit、push 或向现有业务工作区写入测试记录。
- 正式 SMTP、邀请网页来源和加密密钥仍需运营配置；未配置时邀请保持禁用。SLA 引擎、周工时排班、部门主数据与 Agent 执行未在本次范围内实现。本机激活不等于公网生产部署或负载验收。
