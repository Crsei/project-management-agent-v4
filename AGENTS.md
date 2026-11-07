# Project Management v4 工作约定

- 先读 `README.md`、`docs/domain-design/README.md` 第七节、`docs/architecture/context.md`、`docs/architecture/adr/0003-markdown-core.md` 及受影响的公开使用指南，再读关联领域文档与 INV/SC/INF 编号。当前/历史适用性按公开入口解释，不把内部27步计划或旧批次验收当新任务指令。
- 统一 Agent 的现行用法见 `docs/guides/agent-chat.md`；根四份旧合同及 `docs/implementation` 原件仅本机历史、不作公开依赖。沿用纯 Agent Chat、工作区/项目作用域、文件区域及既有安全/业务检查，不恢复旧完整执行计划，不新增权限体系或业务完成规则。
- 本仓库是独立项目。历史设计与展示来源已归档，不是安装/构建依赖；当前 `apps/web` UI 为本项目自有代码。不自动改写外部来源仓库代码或接管既有服务。
- 业务规则由 domain/application 所有；HTTP、Worker 和未来 Runner 回报入口使用相同应用服务。前端、执行回调和后台投影不得自行决定工作项完成。
- 未实现能力明确禁用；初始化健康检查不代表数据库、存储、Worker 或 Agent 已就绪。Run 成功不代表 WorkItem 完成，未知副作用先查询核对。
- 开始编辑前检查 Git 状态和目标目录规则，保留无关并行修改。只修改任务路径；不 reset、clean 或广泛暂存。commit 与 push 需要分别获得用户授权。
- 运行和重启前核对端口、PID 与工作目录；测试优先使用临时端口。不停止其他项目服务，不在日志中输出秘密。
- 纯文档修改检查链接、格式和语义；源码修改运行受影响 lint、类型检查、测试与构建。`pnpm check` 包括公开文档、导入边界、许可/素材完整性、PM合同及无数据库检查，不含完整Web/Agent/数据库回归；数据库/事务/流变更还需真实隔离回归，跳过不算通过。`pnpm check:ci` / `node scripts/check-ci.mjs` 提供不加载本机.env的隔离聚合入口，默认all；单阶段成功不能写成完整通过，外部GitHub Skill另用rust-network。真实Provider账号、桌面GUI和生产验收单列，许可完整性也不代表第三方发布授权已闭合。
- 每次修改完成后，都必须尝试将本次变更部署到本项目公共入口 `http://127.0.0.1:3224`，不能只停留在源码或临时预览。部署前核对端口、PID、工作目录与服务模式，运行受影响检查和构建；优先只更新受影响产物，纯 Web 变更保留旧哈希资源，不无故重启后端。部署后在 3224 验证实际页面或接口，报告部署结果及验证范围。若构建、来源清单、服务归属或其他前提阻塞，保留现有可用服务，明确报告失败步骤和阻塞；不得绕过检查、覆盖未审阅的并行修改或把临时端口成功当成已部署。仅文档改动也须核对 3224 当前部署，无运行产物变化时说明无需重建或重启。
- 后端检查显式限定 apps/server/pm、apps/server/worker、apps/server/agent 及对应 packages；保留并行 apps/web、.ref 和其他未关联文件，不以全目录格式化或重建覆盖他人工作。
- `boost`、`codex-skills`、`agent-skills` MCP 当前暂停：不得调用、重试、启动、重装或重新启用；不得手动启动 Boost bridge/daemon。使用普通文件与 Shell 工具，外部 MCP 故障及时回退；`allthecodes-bridge` 不在暂停范围。

## 会话与持久化设计提醒

- 会话与持久化尚未经过统一设计，当前暂沿用 Agent Chat 的保存方式。涉及相关改动及阶段交付时，主动提醒用户这一点；直到用户明确确认设计收口，不自行移除此提醒。

## 本地副本环境

- 本目录为独立 `project-management-agent-v4`；v3仅历史来源。只修改本仓库，不修改来源代码或接管来源服务，也不假定相邻来源目录存在。
- v4 公共入口 3224、PM API 4194、Agent API 4325、Web 开发上游 4326、PostgreSQL 55444；Compose 项目 `project-management-agent-v4-backend`。数据库、Markdown、附件、Agent数据及应用私有Provider状态独立；外部原生CLI Home遵循本机操作者配置，不复制来源凭据。
- 不连接或复用 v3 的 3223/4193/4323/4324/55443，以及其他副本的 4100/4191/4192、3220/3222、55433/55440/55441/55442 服务或目录。运行前仍须核对端口、PID 和工作目录；Agent 不能默认复用 `~/.agent-workspace` 或自动导入全局 CLI 凭据。

## 登录与工作区

- 新Web安装由 `pnpm bootstrap` 仅准备私有 `.local/setup-token`（0600），数据库只存摘要；用户在 `/pm` 输入令牌、姓名、邮箱、密码和工作区名称，一次性建立账号及工作区，不生成明文密码文件。旧实例以数据库为准，账号或工作区存在即关闭设置；不读取/改写/删除旧 `.local/access.json`，不重置密码。历史副本复制不是新安装步骤。不要把密码、令牌写入日志、提交、URL、前端配置或环境文件。
- API 登录：`POST /api/v1/auth/login`，请求 `{ "email", "password" }`，v4 使用独立 `pm_v4_session` Cookie（HttpOnly、SameSite=Strict、Path=/、有效期 8 小时）。Bearer 优先；`GET /api/v1/auth/me` 校验当前会话，`POST /api/v1/auth/logout` 注销。Agent 执行服务使用独立 `agent_v4_access`，不改变原权限规则。
- CLI 认证优先级：`PM_SESSION_TOKEN` > 完整 `PM_EMAIL`/`PM_PASSWORD` > 当前服务 origin 的私有有限期会话；使用 `pnpm pm login --email EMAIL` 隐藏输入密码，`pnpm pm logout` 撤销会话。已移除 access.json / PM_ACCESS_FILE 回退。`PM_CLI_SESSION_DIR` 可指定绝对私有目录。`PM_WORKSPACE_ID` 指定工作区；省略时仅当账号可访问唯一工作区才自动选择，否则报错并列出可访问工作区。
- Web 首次设置与普通登录分开；公开注册关闭，后续账号沿用有效邀请。浏览器不读取服务器令牌或访问文件；账号安全沿用现有改密、会话撤销及独立验证的恢复邮箱。登录后从授权列表选择实际工作区；设置/会话结果不明先核对，服务不可用不得视作空实例。
- 历史副本曾显式迁入工作区/项目，保留ID不代表共享数据库或目录；新安装不得要求那些历史ID，也不自动从其他副本导入。工作区/项目侧栏来自真实授权API，空组也必须可见。
- 工作区和项目的 Agent 文件区域单独配置并服务端核验；项目可复用其原生已登记本地目录。目录位置不是新的授权或沙箱；不能因路径未配置回退源仓库根目录。
- CLI默认 `PM_API_URL=http://127.0.0.1:4194`；`PM_WORKSPACE_ID` 从本实例真实授权列表选择，禁止写死历史账号/工作区ID。项目目录从本实例登记映射读取，工作区Agent区域单独核验；不可回指来源项目目录或借缺失配置回退仓库根目录。
