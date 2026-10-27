# Markdown 核心能力台账（L01–L30）

状态标记：`已实现` = 代码与验证均在本仓库完成；`实现中` = 代码已接入但验收证据未齐；`待做` = 尚未接入。
验收证据记录在 [Markdown 核心交付记录](markdown-core-delivery.zh.md)：统一 PM 页面重构见第 7 节，任务五页与共享创建见第 8 节；各轮检查范围分别记录。Lab 三套 Hono transport 测试保留在 `packages/pm-core/tests/transport-later/`，目标服务由 Fastify 真实 HTTP smoke 覆盖；不计入通过数。

| 编号 | 能力 | 目标模块 | Web / API / CLI 入口 | 状态 |
| --- | --- | --- | --- | --- |
| L01 | 九类模型与字段注册表 | `packages/pm-schema` | `/pm/{ws}/issues/new`、任务快速/弹窗创建、`/documents`、`/views` 共用创建意图及高级字段；`GET core/protocol`；`pm protocol`、`pm entity create` | 已实现 |
| L02 | Markdown 文件权威与稳定身份 | `packages/pm-core`、`pm-markdown` | 核心路由、`pm file`；文件名无关解析 | 已实现 |
| L03 | 原文编辑与 Draft 投影 | `apps/web/.../markdown` | 内容默认直接编辑；工具栏/右键菜单、命令搜索、结构操作、Source、Ctrl/Cmd+S；文档字段与正文共享草稿 | 已实现 |
| L04 | 属性/看板/表格写回 | `pm-views`、`markdown` | Board/Table 拖拽与属性保存 | 已实现 |
| L05 | 编辑布局与草稿恢复 | `markdown` | 集合详情/完整页共用草稿；可选文件浏览器与高级分栏；按宿主/账号/工作区持久化；窄屏阅读布局 | 已实现 |
| L06 | Markdown 预览 | `Preview.tsx`、`preview-*` | 六色高亮、公式、Mermaid、代码高亮、脚注/隐藏注释、可折叠 callout、checklist 草稿、授权嵌入/附件、Wikilink 标题/块定位、pm-view；见[编辑补全验收](markdown-editor-completion-plan.zh.md) | 已实现 |
| L07 | 嵌入 pm-view | `Preview.tsx`、`pm-views` | ` ```pm-view ` 块 | 已实现 |
| L08 | 关系、树与图 | `pm-schema/relations`、`pm-schema/graph`、`pm-views` | Properties、Tree；`POST core/graph`、集合力导向图、详情一至三层局部图；见[图谱计划与验收](knowledge-graph-plan.zh.md) | 已实现 |
| L09 | Agent context | `pm-core` | `GET core/context/:id`；`pm context`；统一详情的上下文页签 | 已实现 |
| L10 | 可配置工作流 | `pm-schema`、核心配置路由 | `/settings` 工作流与字段编辑器、`pm config` | 已实现 |
| L11 | 状态类别语义 | `pm-schema`、`pm-views` | completed/canceled 类别解除阻塞 | 已实现 |
| L12 | 自定义字段 | `pm-schema`、`EntityFields.tsx` | 配置 + 属性/创建表单 + 查询 | 已实现 |
| L13 | 配置校验和修复 | `pm-core` | 无效配置锁写、revision 冲突、草稿保留 | 已实现 |
| L14 | 完整 View DSL | `pm-schema/query.ts` | 查询、嵌入、API、CLI 共用 | 已实现 |
| L15 | 分组和表格列 | `pm-views`、`pm-schema` | group_by/columns/order_by | 已实现 |
| L16 | 保存视图与手动排序 | `pm-core`、`.pm/views` | ViewEditor、上下移动、revision；`savedView` 身份与 `view` 布局分离并同步 URL | 已实现 |
| L17 | 过滤与默认展示 | `pm-views`、`markdown` | 实体/项目/状态/优先级/归档过滤；all/today/upcoming/important 与布局独立，个人读取失败不显示虚假空集合或逾期零计数 | 已实现 |
| L18 | 归档、恢复与永久删除 | `pm-core` | Properties 生命周期、确认 ID、CLI | 已实现 |
| L19 | 完整删除保护 | `pm-core` | 引用、Wikilink、视图 order 检查 | 已实现 |
| L20 | 外部文件编辑与 SSE | `pm-core`、核心事件路由 | 文件监听、stale 投影、SSE；工作台复用会话原生流，双标签页不重复占用原生连接 | 已实现 |
| L21 | revision 冲突处理 | `pm-core`、`markdown` | SHA-256 CAS、冲突对照、rebase/disk | 已实现 |
| L22 | 类型化诊断与未知版本 | `pm-schema`、`pm-markdown` | 诊断列表、只读 source | 已实现 |
| L23 | 内容与格式保留 | `pm-markdown` | 节点级 patch、原文保存 | 已实现 |
| L24 | 创建幂等及身份历史 | `pm-core/state.ts`、原生 journal | Idempotency-Key、墓碑；`core/creation-attempts/:key` 查询与显式 `/recover`；原键恢复、跨标签页冻结及父子项分项进度；`pm entity create` | 已实现 |
| L25 | 文件仓库与投影重建 | `pm-core/repository.ts`、`projection.ts` | 安全路径、4 MiB、串行命令 | 已实现 |
| L26 | 协议迁移预览 | `pm-core/migrations.ts` | MigrationEditor、`pm migration preview` | 已实现 |
| L27 | 迁移应用/历史/恢复 | `pm-core/migrations.ts` | 确认 ID、备份、过期预览拒绝 | 已实现 |
| L28 | 崩溃恢复与大文件边界 | `pm-core` | `.pm/state` 分块、事务恢复 | 已实现 |
| L29 | 完整 HTTP 与 CLI 能力 | 核心路由、`pm-cli` | file/protocol/context/task/entity/config/view/lifecycle/migration | 已实现 |
| L30 | 可运行交付与安全基线 | 核心路由、PM API | 同源/Origin、路径/链接拒绝、鉴权、HTML 跳过 | 已实现 |

## PM 附加能力（E01–E12）

| 编号 | 能力 | 权威存储 | 本轮接入 |
| --- | --- | --- | --- |
| E01 | 账号、会话、工作区、成员授权 | PostgreSQL | 核心路由复用 `getMembership` 与项目范围 |
| E02 | Conversation/Intent/Decision | PostgreSQL | Intent 创建核心任务走幂等桥接 |
| E03 | 成果/Artifact/Blob | PostgreSQL + BlobStore | 引用核心对象与快照 |
| E04 | Evidence/Submission/Review | PostgreSQL | 独立审核，不阻塞 Lab 状态转换 |
| E05 | 日历/甘特/排期 | 核心 Markdown | 工作项 `x-pm-start/due`；其他排期模型 `start/due`；个人 IANA 时区决定今天与七天范围，全天截止包含当天；里程碑仅截止日期，文档不写日期 |
| E06 | 内容编辑与 PM 富文本 | 核心 Markdown；PM-only 业务记录 | React/CodeMirror 直接正文编辑与实时预览，不做 HTML 全文件往返；选区转真实任务与附件复用原服务/恢复；独立业务表单保留原有富文本 |
| E07 | 命令面板/搜索/集合变体 | 前端 | 查询适配核心身份 |
| E08 | 仪表盘/成员/活动/图表 | 聚合查询 | 共有统计读核心 |
| E09 | 个人 SVG 白板 | 浏览器本地 | 不冒充服务器协作成果 |
| E10 | outbox/Worker/游标/重试 | PostgreSQL | 保留；核心事件独立 SSE |
| E11 | OpenAPI/健康检查/备份 | 工程入口 | readiness 区分核心与数据库 |
| E12 | `/lab/pm` 与 Storybook | 前端 fixture | 明确样例，不进入正式 `/pm` |
