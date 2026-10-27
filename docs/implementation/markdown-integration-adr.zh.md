# ADR：Markdown 核心接入 PM（P0）

状态：已采纳，随实现更新。依据：[Markdown PM 移植计划](markdown-porting-plan.zh.md)。

## 决策 1：复用 Lab 实现，不重写协议

- `packages/pm-schema`、`pm-markdown`、`pm-core` 从 `markdown-pm-lab` 原样迁入 PM，作为唯一协议实现；`pm-views`、`pm-cli` 一并迁入。
- 依赖统一由 PM 的 pnpm workspace 管理；PM 不启动第二个 Lab 服务、不引用 Lab 源码目录。
- PM 的严格 TypeScript 选项（`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）通过修正类型满足，未放宽配置。

## 决策 2：工作区映射与权威位置

| 数据 | 权威位置 | 可重建 |
| --- | --- | --- |
| 九类 Lab 实体、正文、正式关系 | 未映射项目在 `CORE_WORKSPACE_ROOT/<workspaceId>/**.md`；本地映射项目在所选目录 `.pm/core/**.md` | 否 |
| 工作流、自定义字段、保存视图与 order | `<workspace>/.pm/config.yaml`、`.pm/views/*.yaml` | 否 |
| ID 台账、幂等、墓碑、项目目录映射、迁移及事实观测/恢复日志 | `<workspace>/.pm/state/` | 否 |
| 查询索引 | `<workspace>/.pm/cache/index.sqlite` | 是 |
| PM 账号、会话、成员、Intent/Decision/交付、附件元数据及字节 | PostgreSQL / BlobStore；映射项目字节在所选目录 `.pm/attachments`，历史对象按持久存储身份定位 | 否（PM 独有） |

- `CORE_WORKSPACE_ROOT` 默认 `.local/pm-workspaces`，每个 PM workspace UUID 一个共享权威目录；本地项目目录不是独立 Workspace。所有根拒绝符号链接，工作区统一维护 ID、配置、关系和恢复台账。
- 映射由 `.pm/state/project-locations.json` 登记；所选根 `.pm/project.json` 固定工作区/项目/storageId。普通 FileRecord 使用 `project-roots/<projectId>/<core-relative-path>`，不暴露主机绝对路径；管理路径仅对全局管理权限开放。迁移、移动、找回、Worker readonly 和备份复用该映射，见[本地项目存储计划](local-project-storage-plan.zh.md)。
- API 核心访问或后台事实 importer 可首次初始化唯一工作区；已有 SQL 审计/恢复证据但权威 state 缺失时拒绝空白初始化。缓存获取等待既有串行磁盘刷新完成，不依赖 watcher 防抖后才读到当前文件。API 关闭时统一关闭 watcher 与 SQLite，Worker 不创建第二个 Workspace，也不修复缺盘。
- 外部文件监听使用 chokidar，外部项目仅监听受管 `.pm/core` 和身份标记，不导入原代码文件。宿主机 inotify 配额不足时设置 `CHOKIDAR_USEPOLLING=true`；该设置不改变文件权威，只改变监听方式。
- `.pm/config.yaml` 可以合法缺省并使用当前核心版本内置配置；备份保留缺省，不为通过恢复而补写配置。已存在配置、views 与 state 须完整校验，state 缺失不按默认值重建。

## 决策 3：身份规则

- 核心对象使用 Lab 稳定身份（`PRJ-001`、`TASK-102` 等），不依赖文件名，不使用 PM UUID。
- PM 独有对象继续使用 UUID。命令信封的 `targetId`/`projectId` 接受两类 ID；核心命令在进入 SQL 内核前被拦截并交给核心适配器，PM 独有命令仍由 UUID 内核校验。
- 旧数据不迁移、不做 UUID ↔ 核心 ID 映射。迁移 `0005_markdown_core_identity.sql` 删除旧核心聚合，并把 `project_ids`、`project_id`、`scope_project_ids` 改为 `text`/`text[]`。

## 决策 4：路由、授权与权限映射

核心 API 前缀：`/api/v1/workspaces/{workspaceId}/core`，载荷与错误码与 Lab 服务一致（`{error, diagnostics, current?}`）。

| 操作 | 能力 | 项目范围 |
| --- | --- | --- |
| protocol/workspace/items/query/files/context/events | `domain.read` | 按 `memberships.project_ids` 过滤 |
| 创建/更新原文或属性、创建实体、保存视图 | `planning.edit` | 非项目对象需项目在范围内；创建项目需工作区范围 |
| archive/restore/delete | `planning.lifecycle` | 对象项目必须在范围内 |
| config、migration、视图定义 | 管理员（`project_ids IS NULL`） | 工作区级 |

- 缺少数据库/会话时返回 401/503，绝不回退无鉴权模式。
- SSE 对受限成员只发送事件类型与原因，不泄露范围外对象 ID；project-scoped 过滤器不改变工作区视图定义本身。

## 决策 5：核心命令与 PM 视图

- `isCoreEntityKind`（project/work_item/milestone）的命令由 `core-adapter` 转换为核心文件写入，返回与旧内核相同形状的 `CommandReceipt`，并把回执写入 `command_receipts` 以支持丢响应后的查询。
- 创建命令使用 `commandId` 作为核心幂等键；更新命令先读取当前文件 revision，冲突时不自动重试。
- 旧 PM 视图通过映射后的 `Entity` 读取核心对象；`x-pm-start` 等 `x-pm-*` 扩展承载 PM 专用排期，共有 `due` 不再写 SQL。
- 旧规则中“完成必须审核”“跨项目 blocked_by 禁止”“cancelled 仍阻塞”等守卫在核心命令映射中移除；审核仍作为独立附加流程存在。

## 决策 6：不变量边界

- Lab 的类型、引用、防环、状态转换、revision、归档/删除保护、未知版本只读、迁移与恢复必须保留。
- PM 附加模块不得成为核心状态转换的前置门槛；核心对象删除后，历史审核/证据保留快照并显示“对象已删除”，不级联删除。
- 文件恢复不回滚 PM 数据库中的审核/证据历史；跨模块整体恢复需一致检查点，单独文件恢复不宣称全系统恢复。

## 决策 7：原生创建意图与恢复（2026-10-21）

- 任务五页和通用工作台共用持久 `CreationDraft`；创建前没有正式 ID/revision，不能混入已保存文件的源码草稿。创建成功后仍使用原 FileRecord 和共享详情。
- 新 UI 的写入合同是 `POST core/entities` + Idempotency-Key。显式业务命令继续使用自身 CommandReceipt；原生创建结果不伪装成命令收据。两条入口共享应用规则及 Markdown 持久化内核，不双写任务内容。
- `GET core/creation-attempts/:key` 只读核对；`POST .../recover` 仅恢复原写入的缺失审计。原提交 ID/revision 与当前文件状态分开；未知/not_found 不允许换键重建，删除后的原实体也不重建。
- 父项、正式子项与个人关注按各自原键逐项确认；不宣称跨文件/SQL 原子提交。WorkItem 完成仍只由显式、已授权的配置工作流动作决定。
- 前端每个会话 provider 拥有一条原生 SSE，工作台订阅它而不另开重复连接。权限变化切换流作用域，源码冲突仍需人工比较与显式保存。

## 遗留与后续

- 旧数据清理按计划 D11 执行；本轮只在空业务工作区验证。
- 项目级配置覆盖、个人视图、多实例协同、真实 Agent 执行不属于本轮。
