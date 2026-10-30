# Project Management v4 工作约定

- 先读 `README.md`、`docs/domain-design/README.md` 第七节及 `docs/implementation/backend-delivery.md`，再读受影响的领域文档及 INV/SC/INF 编号。当前第一阶段已交付可运行后端核心，按计划完成剩余项及后续阶段。
- `V3-AGENT-CHAT-TASKS.zh.md` 是 v3 历史合同；沿用纯 Agent Chat、工作区/项目 Session、文件区域及既有安全与业务检查，不恢复旧完整执行计划，不新增权限体系或业务完成规则。
- 本仓库是独立项目。`project-management-book` 是设计来源，EasyuseUI 是第二阶段的展示接入目标；不自动改写这些仓库的代码或接管既有服务。
- 业务规则由 domain/application 所有；HTTP、Worker 和未来 Runner 回报入口使用相同应用服务。前端、执行回调和后台投影不得自行决定工作项完成。
- 未实现能力明确禁用；初始化健康检查不代表数据库、存储、Worker 或 Agent 已就绪。Run 成功不代表 WorkItem 完成，未知副作用先查询核对。
- 开始编辑前检查 Git 状态和目标目录规则，保留无关并行修改。只修改任务路径；不 reset、clean 或广泛暂存。commit 与 push 需要分别获得用户授权。
- 运行和重启前核对端口、PID 与工作目录；测试优先使用临时端口。不停止其他项目服务，不读取凭据文件或在日志中输出秘密。
- 纯文档修改检查链接、格式和语义；源码修改运行受影响 lint、类型检查、测试与构建。`pnpm check` 包括无数据库检查；数据库/事务/流变更还需 `pnpm test:backend`，其中跳过的测试不算通过。真实 Agent 仍未验收。
- 后端检查显式限定 apps/server/pm、apps/server/worker、apps/server/agent 及对应 packages；保留并行 apps/web、.ref 和其他未关联文件，不以全目录格式化或重建覆盖他人工作。
- `boost`、`codex-skills`、`agent-skills` MCP 当前暂停：不得调用、重试、启动、重装或重新启用；不得手动启动 Boost bridge/daemon。使用普通文件与 Shell 工具，外部 MCP 故障及时回退；`allthecodes-bridge` 不在暂停范围。

## 会话与持久化设计提醒

- 会话与持久化尚未经过统一设计，当前暂沿用 Agent Chat 的保存方式。涉及相关改动及阶段交付时，主动提醒用户这一点；直到用户明确确认设计收口，不自行移除此提醒。

## 本地副本环境

- 本目录为独立 `project-management-agent-v4`，来源为 `../project-management-agent-v3` 的提交；只修改本仓库，不修改来源代码或接管来源服务。
- v4 公共入口 3224、PM API 4194、Agent API 4325、Web 开发上游 4326、PostgreSQL 55444；Compose 项目 `project-management-agent-v4-backend`。数据库、Markdown、附件、Agent 数据与 Provider homes 均使用独立存储。
- 不连接或复用 v3 的 3223/4193/4323/4324/55443，以及其他副本的 4100/4191/4192、3220/3222、55433/55440/55441/55442 服务或目录。运行前仍须核对端口、PID 和工作目录；Agent 不能默认复用 `~/.agent-workspace` 或自动导入全局 CLI 凭据。

## 登录与工作区

- 常规首次初始化由 `pnpm bootstrap` 创建账号并写入 `.local/access.json`（0600，含 `email`、`password`、`userId`、`workspaceId`）；已有文件时 bootstrap 不轮换账号。本机经用户授权复制 v3 账号与访问文件。不要把凭据写入日志、提交、前端配置或环境文件。
- API 登录：`POST /api/v1/auth/login`，请求 `{ "email", "password" }`，v4 使用独立 `pm_v4_session` Cookie（HttpOnly、SameSite=Strict、Path=/、有效期 8 小时）。Bearer 优先；`GET /api/v1/auth/me` 校验当前会话，`POST /api/v1/auth/logout` 注销。Agent 执行服务使用独立 `agent_v4_access`，不改变原权限规则。
- CLI 认证优先级：`PM_SESSION_TOKEN` > `PM_EMAIL`/`PM_PASSWORD` > `.local/access.json`（`PM_ACCESS_FILE` 可覆盖路径）。`PM_WORKSPACE_ID` 指定工作区；省略时仅当账号可访问唯一工作区才自动选择，否则报错并列出可访问工作区。
- Web 登录页需手工输入 `.local/access.json` 中的邮箱与密码，浏览器不读取该文件；登录后从授权列表选择实际工作区。
- 本机按用户明确要求复制 v3 工作区 `e317b803-5c03-4eb9-a7d9-79d7a38927bf`（Project Management）及项目 `PRJ-001`。保留对象 ID 不代表共享数据库或目录；后续不自动从其他副本导入。工作区和项目侧栏来自真实授权 API，空组也必须可见。
- 工作区和项目的 Agent 文件区域单独配置并服务端核验；项目可复用其原生已登记本地目录。目录位置不是新的授权或沙箱；不能因路径未配置回退源仓库根目录。
- CLI 使用 `PM_API_URL=http://127.0.0.1:4194`、`PM_WORKSPACE_ID=e317b803-5c03-4eb9-a7d9-79d7a38927bf`；新增工作区仍从本副本真实授权列表选择。迁入项目目录为 `.local/projects/<workspaceId>/762dee3c-41af-468a-a624-351cc478522e`，工作区 Agent 文件区域为其父目录；不可回指来源项目目录。
