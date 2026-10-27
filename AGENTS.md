# Project Management 工作约定

- 先读 `README.md`、`docs/domain-design/README.md` 第七节及 `docs/implementation/backend-delivery.md`，再读受影响的领域文档及 INV/SC/INF 编号。当前第一阶段已交付可运行后端核心，按计划完成剩余项及后续阶段。
- 本仓库是独立项目。`project-management-book` 是设计来源，EasyuseUI 是第二阶段的展示接入目标；不自动改写这些仓库的代码或接管既有服务。
- 业务规则由 domain/application 所有；HTTP、Worker 和未来 Runner 回报入口使用相同应用服务。前端、执行回调和后台投影不得自行决定工作项完成。
- 未实现能力明确禁用；初始化健康检查不代表数据库、存储、Worker 或 Agent 已就绪。Run 成功不代表 WorkItem 完成，未知副作用先查询核对。
- 开始编辑前检查 Git 状态和目标目录规则，保留无关并行修改。只修改任务路径；不 reset、clean 或广泛暂存。commit 与 push 需要分别获得用户授权。
- 运行和重启前核对端口、PID 与工作目录；测试优先使用临时端口。不停止其他项目服务，不读取凭据文件或在日志中输出秘密。
- 纯文档修改检查链接、格式和语义；源码修改运行受影响 lint、类型检查、测试与构建。`pnpm check` 包括无数据库检查；数据库/事务/流变更还需 `pnpm test:backend`，其中跳过的测试不算通过。真实 Agent 仍未验收。
- 后端检查显式限定 apps/api、apps/worker 及对应 packages；保留并行 apps/web、.ref 和其他未关联文件，不以全目录格式化或重建覆盖他人工作。
- `boost`、`codex-skills`、`agent-skills` MCP 当前暂停：不得调用、重试、启动、重装或重新启用；不得手动启动 Boost bridge/daemon。使用普通文件与 Shell 工具，外部 MCP 故障及时回退；`allthecodes-bridge` 不在暂停范围。

## 本地副本环境

- 本目录是 `../project-management` 的独立副本，用于 Agent 接入开发。API 4192、Web 3222、PostgreSQL 55442、Compose 项目 `project-management-agent-v2-backend`；数据库、存储、工作区与账号均在本地 `.local/`。
- Web 启动：`PM_WEB_PORT=3222 PM_API_URL=http://127.0.0.1:4192 pnpm dev:web`；API/Worker 使用 `pnpm services:start`。不要连接或复用来源项目及其他副本的 4100/4191、55433/55440/55441 服务、数据库、Markdown 根或凭据。
- 来源 `../project-management` 只读参考；`PM_WEB_PORT` 与 `PM_API_URL` 是本地隔离覆盖，默认值 3220/4100 仍与来源文档一致。

## 登录与工作区

- 本机账号仅由 `pnpm bootstrap` 首次创建时写入 `.local/access.json`（0600，含 `email`、`password`、`userId`、`workspaceId`）；已有文件时 bootstrap 不轮换账号。不要把凭据写入日志、提交、前端配置或环境文件。
- API 登录：`POST /api/v1/auth/login`，请求 `{ "email", "password" }`，成功后返回 `pm_session` Cookie（HttpOnly、SameSite=Strict、Path=/、有效期 8 小时）。后续请求使用该 Cookie 或 `Authorization: Bearer <token>`，Bearer 优先；`GET /api/v1/auth/me` 校验当前会话，`POST /api/v1/auth/logout` 注销。
- CLI 认证优先级：`PM_SESSION_TOKEN` > `PM_EMAIL`/`PM_PASSWORD` > `.local/access.json`（`PM_ACCESS_FILE` 可覆盖路径）。`PM_WORKSPACE_ID` 指定工作区；省略时仅当账号可访问唯一工作区才自动选择，否则报错并列出可访问工作区。
- Web 登录页需手工输入 `.local/access.json` 中的邮箱与密码，浏览器不读取该文件；登录后从授权列表选择实际工作区。
- 当前 `.local/access.json` 记录的 `workspaceId` 为 `e317b803-5c03-4eb9-a7d9-79d7a38927bf`（名称 Project Management，管理员 `admin@project-management.local`）。本副本只使用该工作区，其 Markdown 核心位于 `.local/pm-workspaces/<workspaceId>/`；新建项目须在 Web 设置页完成本地目录初始化。
- 使用该工作区：`PM_API_URL=http://127.0.0.1:4192 PM_WORKSPACE_ID=e317b803-5c03-4eb9-a7d9-79d7a38927bf pnpm run pm protocol`（`task list`、`file` 等命令相同）；不要把工作区 ID 换成其他副本或来源项目的值。
- 工作区内的示例项目 `PRJ-001`（Nova 客户门户 · 示例项目）位于 `.local/projects/nova-customer-portal`，包含 8 个任务、4 份文档及其里程碑/迭代/模块/需求/发布/目标示例数据，仅用于功能演示；不是真实交付或验收证据。
