# 本地优先项目目录与初始化实施计划

状态：本地优先范围已实现并通过隔离验收；当前业务实例尚未升级。日期：2026-10-24。

## 1. 用户范围与决策

优先完成本地使用：新建项目明确选择本机服务可写文件夹；核心 Markdown、任务、文档和上传附件实际保存到所选目录；定义首次使用与新建项目初始化内容。云端新增能力、双向同步、多实例、桌面壳、Agent 执行不在本批范围，既有云端实现不删除。复用本地 API/Worker/PostgreSQL，不替换数据库。

依据：[根说明](../../README.md)、[领域实施计划](../domain-design/README.md#implementation-plan)、[Markdown 权威 ADR](markdown-integration-adr.zh.md)、[统一创建合同](task-creation-adaptation-plan.zh.md)、[部署手册](../../deploy/README.md)。适用 INV-01/13/14/15/16/20、SC-12/13/14/20、INF-01/03/05/06；核心状态仍服从已采纳 Markdown ADR，而非旧固定审核前置规则。

实施前基线：CoreWorkspacePool 按根目录/workspaceId 打开唯一 Workspace；FileRepository 拒绝符号链接并使用工作区相对路径；ID、墓碑、幂等、恢复日志和配置为工作区级权威；blob 存储绑定为全局单例；Worker 与备份直接按旧根路径读取。因此本批不是只增加前端路径字段，也不以符号链接伪造外部目录支持。

## 2. 存储与一致性合同

- 工作区仍是授权、统一 ID、配置、关系、聚合与串行写入范围；项目目录是物理存储范围，不变成新的业务工作区。
- 所选目录仅新增 `.pm/project.json`、`.pm/core/projects/PRJ-xxx.md`、`.pm/core/work-items/`、`.pm/core/docs/`、`.pm/attachments/`；其他实体目录按需建立。原有代码/README/任意文件不导入、不覆盖、不接管。
- 项目标记仅保存格式版本和存储/工作区/项目身份及相对位置，名称、状态、正文仍只在项目 Markdown。数据库账号/评论/审核不移入项目目录，不宣称目录是完整备份。
- workspace `.pm/state` 保留工作区统一权威台账；新增持久目录映射由核心独占维护。核心对外暴露安全的虚拟相对路径，绝不能让授权过滤后的普通文件 API 接受任意绝对路径。外部根的发现、恢复、缺盘、readonly 读取、watcher 与迁移均使用同一映射。
- 无目录登记的现有项目仍是原真实存储，不自动迁移；显式迁移保持所有原 ID、revision、关系、历史附件引用。切换后清理经校验的旧权威副本，未知结果不盲目重复。
- 新项目附件存所选目录，旧对象通过明确持久存储身份定位；不能把全局 BLOB_ROOT 改成最新项目目录。存储绑定与维护要支持项目存储身份，仍保留原 Local/S3 行为。
- 初始化是可恢复多步骤操作，不宣称文件和 SQL 原子提交。原请求键、参数摘要、预留身份、目录身份、步骤结果必须持久化；重复/丢响应/崩溃后核对原操作，不换键重建。未完成不能冒充可写成功。
- 目录缺失、盘卸载或标记冲突时不得重建空根；路径和身份在预检和提交时均核对。拒绝符号链接、路径逃逸、硬链接攻击、重叠/重复登记、系统敏感路径；不得递归删除用户目录回滚。
- 显式迁移/重新定位同时提供停写 CLI 与真实管理 API。管理 API 不停止整个实例，但必须持久冻结目标项目/工作区写入、取得共享 SQL/核心写锁，并要求操作者明确确认外部文件编辑器已停止；原生/命令/附件写入共同遵守围栏。源文件删除前再次核对摘要/revision，变化时保留源/目标及待恢复操作。进程重启不能自动清除围栏；数据库锁不能被描述为对外部编辑器的物理锁。
- 迁移分为托管移动（复制校验后切换到新的未托管目录）与重新定位（用户已移动整个目录，原位置缺失后，校验目标已有同身份标记与历史引用字节再重绑定）。两种操作必须显式区分；不能把仅支持复制的接口称为缺盘恢复。原位置仍有效时不得把克隆目录悄悄登记为同一项目。

## 3. 本地配置与界面

首次本地使用清楚展示应用数据根、默认项目父目录、附件按项目保存、备份位置和数据库依赖。本地服务提供目录浏览和绝对路径输入，不用上传目录控件伪装后端路径。目录枚举与路径配置仅限已认证且具备工作区全局管理能力的用户，保留 Origin/CSRF 边界；普通项目读写能力不能探测任意磁盘。目录授权来源必须由可信本机配置/管理动作限定，不能通过前端字符串自行扩权。

新建项目必填名称、工作区、最终保存位置；可填描述、负责人、日期；显示父目录/新文件夹或使用现有目录模式、最终绝对路径、初始化清单及“不修改原文件”说明。所有正式创建入口（项目列表、通用核心创建器、命令入口）必须共享目录要求和恢复机制，不能旁路生成未绑定的新项目。配置未启用本地项目能力时保留既有部署能力并明确禁用本地选择，不伪造本地成功。

项目成功后显示可用状态与授权范围内的路径/复制操作；设置支持默认父目录、存储状态、显式迁移/重新定位及失败恢复。没有原生集成时不提供假的系统文件管理器按钮。浏览器草稿保持原有 actor/workspace/host 隔离及未知请求保护。

## 4. 必需初始化与禁止事项

必需：稳定项目 ID、目录映射、身份标记、项目 Markdown、初始配置工作流状态、任务/文档目录、本地附件绑定、现有权限继承、原请求恢复记录、索引和监听注册、最终磁盘重读。可选输入一次写入，不先创建空项目再 PATCH。

不生成样例任务/预算/成员、不安装依赖、不 init Git、不启动 Agent、不创建云服务；不自动写入原目录的 README 或代码。默认项目是可用的空项目。

## 5. 工作包与文件所有权

所有实现代理使用用户指定 `gpt-6.1-sol` / `xhigh`。共享代码由下面的单一 owner 修改；跨包变更先消息协调。实现期间不跑 build/lint/tests/formatter；集成后统一执行。

| 包 | 单一 owner 范围 | 交付 |
| --- | --- | --- |
| LP-CORE | packages/pm-core/** | 多根映射、虚拟路径、统一身份/状态、监听/readonly、创建/恢复/显式迁移与重新定位原语 |
| LP-API | apps/api/**、apps/worker/**、packages/application/src/local-projects*、packages/contracts/src/local-project*、基础 runtime config、0030 migration | 本地配置/受限目录选择、预检与幂等初始化编排、权限、API/命令统一入口、Worker 集成；拥有 app.ts 共享装配 |
| LP-BLOB | infrastructure blob 文件、application delivery/files/ports、scripts/backup 与存储维护、本地迁移 CLI、0031 migration、deploy 运维配置 | 项目附件持久身份与路由、旧数据受控迁移、全根备份/恢复、角色隔离 |
| LP-WEB | apps/web/** | 本地配置、目录选择、项目初始化/恢复、路径显示、所有创建入口接入、真实错误与禁用态 |
| LP-ACCEPT | tests/local-project*、隔离验收脚本 | 真实磁盘/PG/HTTP/Worker 场景与浏览器验收 fixture，失败边界，不使用业务数据 |
| 集成 owner | 本计划、README、合同生成入口/产物、跨包集成、最终检查与浏览器运行 | 最终合同一致、证据、修复及清理 |

## 6. 已落地接口与职责

- 核心入口为 `packages/pm-core/project-locations.ts` 与原 Workspace API；持久映射固定在工作区 `.pm/state/project-locations.json`，FileRecord 使用 `project-roots/<projectId>/<core-relative-path>`。没有第二套项目内容仓库。只读端和 watcher 使用同一映射；工作区仍统一分配 ID、处理关系和状态。
- DTO/schema 位于 `packages/contracts/src/local-projects.ts`，`ProjectManagementClient.localProjects` 使用既有鉴权传输。HTTP 公共前缀为 `/api/v1/workspaces/:workspaceId/local-projects`：`GET/PUT settings`、`GET directories?path=`、`POST preview`、`POST initializations`、`GET initializations/:key`、`POST initializations/:key/recover`、`GET projects/:projectId/location`、`POST projects/:projectId/migrate`、`POST projects/:projectId/relocate`。初始化和维护使用固定 `Idempotency-Key`。
- `relocate` 明确区分 `mode: move | rebind`；迁移/重新定位都要求 `writersStopped: true`。对应停写 CLI 为 `pnpm storage:projects migrate|relocate|rebind|recover|restore`；原操作 UUID 不能因未知结果而更换，完整恢复另需显式 `--restored-target`。
- 原生 `/core/entities` 与 `CreateProject` 命令均接收 `localDirectory`，复用同一初始化原语。原生创建保留原生 journal/attempt，命令创建保留 CommandReceipt，不能互相伪造查询结果。背景事实恢复与显式命令恢复服从原工作区 SQL 写锁，不能把正在执行的文件提交提前解释为崩溃恢复。
- 项目 Blob scope 从当前授权应用上下文提供；`.pm/attachments` 使用独立持久 storageId。旧全局对象通过原身份/恢复别名定位，不由 objectKey 扩大权限。备份 v3 解析所有登记目录，包含 SQL、共享台账、全部项目标记/核心/附件及历史引用对象；恢复到新根后重绑定，不读取源机器目录。
- 本地设置页为 `/pm/:workspaceId/settings?section=local-storage`。可信本机配置控制授权根和应用/备份根，Web 只保存允许范围内的默认项目父目录。项目列表、首页/统一创建器、命令面板共用目录输入和恢复控制器；创建草稿保留 actor/workspace/host 隔离，不是权威数据备份。

## 7. 验收清单

- LP-A01 两个不同父目录各创建一个项目，文件/附件不混放，工作区聚合正确。
- LP-A02 已有代码目录初始化后原文件逐字节不变；已有/损坏标记、目录重复/嵌套拒绝。
- LP-A03 任务、文档、日期编辑确实写入所选根；重启后原 ID/revision/字节保持，外部合法文件变更可观察。
- LP-A04 重复提交、响应丢失、文件成功但 SQL 未完成、进程中断，按原键恢复而不重复建项；未知不自动重试。
- LP-A05 目录消失/权限不足/空间不足/路径攻击不伪成功、不造空替代目录、不删除用户文件。
- LP-A06 受限成员不能浏览主机目录、读取未授权路径/对象；本地 Origin 安全有效；Worker 只读。
- LP-A07 旧项目显式迁移与目录重新定位保持 ID、正文、历史附件与审计，失败可核对。
- LP-A08 停写备份恢复到新 SQL/core/project/blob 根，不读取源根，历史引用内容和共享状态保持。
- LP-A09 全部正式创建入口遵守选目录与初始化；浏览器刷新、草稿恢复、错误和窄屏真实可用。
- LP-A10 源码 lint/typecheck/build、合同与文档检查、真实 PG/backend 检查；跳过不算通过；实际浏览器和真实服务烟测与单元测试分列。

不得迁移/停止用户当前实例作验收，不读取凭据文件或输出秘密；用专用临时端口、隔离 schema、临时目录和自有进程。所有新永久行为测试针对消费者可见边界，禁止测试源码文本/简单转发。

## 8. 实际交付与证据

### 8.1 已观察的运行证据

- 真实 Chromium：1440×1000 与 390×844；已有代码目录创建后 README/二进制逐字节不变，默认父目录保存并刷新保持，中文与空格目录完整保存，草稿按原请求恢复。使用 CDP 在服务端已提交后丢弃响应，刷新只读核对得到原项目，没有重复创建。外部改名后页面报告缺盘，显式重新绑定保留原 ID/标记，不重建旧目录；无未捕获页面错误，无窄屏横向溢出。
- 实际编译产物 HTTP：在真实磁盘上执行带目录的 `CreateProject` 命令，初始完成条件保持；任务虚拟路径对应所选根中的实际文件，附件字节写入项目根；重启后 ID、revision、原收据和历史下载保持。
- 停写维护 CLI：实际执行 migrate → relocate → 外部移动 → rebind → 原操作 recover；重启后项目身份、Markdown revision、历史附件内容保持，缺失原目录没有重新生成。
- 实际 `node scripts/backup.mjs --stopped --verify`：专用临时 PostgreSQL、备份格式 v3、登记项目根、全新 SQL/core/project/blob 根恢复及 HTTP 附件读取通过；没有修改源项目身份。只备份应用托管数据，不包含项目目录内原有代码。
- 核心目录边界：15 项测试通过，包含两个根、统一 ID、只读扫描、watcher、符号/硬链接及重叠拒绝、inode 替换、缺盘、真实 chmod 不可写、迁移中断与原键恢复。ENOSPC 使用写入故障注入，不是填满用户磁盘；不宣称完成断电耐久性试验。
- 并发事实恢复回归：真实 PostgreSQL 工作区锁阻塞导入器，复现“仍在提交的创建被提前恢复”失败；修复后，导入器在同一锁内恢复，仅保留原事实 ID/时间与一次完成记录。另已通过真实进程 SIGKILL 后原键恢复和只读查询不发起创建。
- 本地集成验收 11 项全部通过：双根/权限/字节/真实 Worker、所有创建入口、丢响应、SIGKILL、缺盘、旧数据迁移、外部移动重绑定、工作区权威丢失、并发事实恢复，以及两个项目在源根不可见时通过实际 restore CLI 恢复。恢复后重新登录、历史版本/封面/跨项目独立副本、新上传和审计保留均已检查。

证据保存在 `.local/evidence/local-project-storage/`：`browser.json` 与四张截图、`compiled-api.json`、`commands.json`、`fact-race.json`、`full-backend.json`。这些是本机验收产物，不是业务数据或跨机器可用的数据库备份。

### 8.2 自动检查

- `pnpm test:backend`：**708/708 通过，36 个 suite，0 失败、0 取消、0 跳过**；使用独立 PostgreSQL，既有 S3 协议回归使用临时 MinIO，不代表新增云端功能。
- `pnpm lint`、`pnpm typecheck`、`pnpm contracts:check` 通过；合同包含 109 个命令和 69 条路径。后端 TypeScript 输出至隔离目录，确认 API/Worker 产物与 migration 资源存在，未覆盖业务 `dist`。
- Web lint/typecheck、21 项相关前端测试、隔离 Vite 构建通过；保留既有大 chunk 与混合静态/动态导入告警，没有为本批改写无关打包结构。
- 文档链接与领域引用检查通过。真实服务烟测和浏览器验收另列于 8.1，不用单元测试替代。
- 初轮全量回归为 704/708：旧 backend fixture 忽略 `TMPDIR`、固定写仓库机械盘，触发整组 240 秒超时并提前关闭服务，导致末尾四项级联失败。仅令 fixture 尊重显式临时目录，未放宽超时、删除场景或弱化断言；最终完整重跑全部通过。此前中止/超时不计入通过数。

### 8.3 生效与边界

- 没有停止、迁移或升级当前业务 API/Worker；没有覆盖其 `dist`。当前运行实例不会因源码完成而自动获得功能。部署需按受控停写顺序应用 `0030_local_projects.sql`、`0031_project_blob_stores.sql`，完成构建与重启；已有数据不自动迁移。
- “本地”仍需要本机 API、Worker 和 PostgreSQL，不是仅靠一个项目文件夹运行的无数据库程序。浏览器选的是 **API 所在机器** 的授权目录，不是远端浏览器电脑的任意目录。
- 云端新增部署能力、同步、桌面原生文件管理器和 Agent 未纳入本批。恢复后的生产凭据策略仍需管理员确认；恢复不会继承源登录会话。
- 验收只使用自有临时进程、端口、目录、schema 和数据库容器；旧验收资源清理记录在 `cleanup.json`，最终回归记录也确认其数据库与文件已清理。临时编译目录、客户端包装器和 MinIO 二进制已删除，只保留证据。业务 API/Worker 仍为原 PID 25649/25648，最终 readiness 为 200。
- 最终全量运行使用独立 PostgreSQL（fsync/synchronous_commit 均开启，数据位于临时内存盘）与真实 `/tmp` 项目文件；这不是主机断电耐久性验收。
