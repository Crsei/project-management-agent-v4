# v4 部署

> 当前运行合同与历史证据分开：本文后部0024批次是历史记录，不证明最新工作树或生产部署。Agent仅面向可信本机单操作者，尚无PM成员会话隔离，cwd/Terminal不是文件沙箱。会话与持久化仍暂沿用Agent Chat，统一设计尚未收口；私有恢复journal/备份可含任务正文和自动化快照，不是脱敏日志。

独立 `project-management-agent-v4`：公共入口 `3224`、PM API `4194`、Agent API `4325`、Web 开发上游 `4326`、PostgreSQL `55444`。本机 server 网关、PM API、Worker、Agent API 与统一 Web 产物共同组成服务组；生产 Caddy/Compose 使用同一份 Web 产物。数据库、项目及应用私有 Agent 状态与 v3 分离；原生 CLI 按服务用户的 Home / 环境规则运行。真实 Provider/CLI 和生产部署验收必须分别验证。

## 启动与配置

在项目根目录使用 Node 24.21.0、pnpm 11.9.0 和[原生编译工具](../docs/guides/development.md#工具链与隔离聚合入口)；当前 TypeScript MCP/Skills host 不需要 Rust/Cargo：

工程验证与部署构建分开：`pnpm check:ci` 仍持有完整门禁、真实夹具、回归和清理，仅将明确的 lint/build/host-build 工程叶交由共享调度；本轮覆盖六 lint、声明/完整类型及 PM/Agent/host/Web/marketing 公共产物缓存。`pnpm check:turbo --stage build` 关闭 dotenv 读取，可恢复声明的隔离检查产物，**不是**本节按部署环境生成产物的替代命令，也不证明来源/许可或生产验收通过。已有实例直接托管 checkout 产物时，检查/缓存恢复必须使用新的独立 worktree，不覆盖 live dist；配置/工具修改不自动要求重启业务服务。source 前提、fresh 门禁及未执行的 hosted 范围见[开发与验证](../docs/guides/development.md#turbo-显式任务调度与本地-lint-缓存)。

本轮全 16 叶缓存/8 roots 恢复与独立 Agent 回归的实际通过仅发生在新的自有 worktree；没有用这些隔离产物替换现有公共服务。Main 对 3224 的真实登录页（0 pageerror）、四个 ready/access/PM/Agent Web HTTP 200、原 Worker/API/Agent/gateway cwd/出生身份及 built mode 作了部署前置/现有健康核验；**不是已部署本轮新产物**。primary 的 24 项对照中 23 字节未变，CHANGELOG 的外部并行变化原样保留，没有覆盖 parallel primary/live 输出，也不声称原树全部 unchanged。默认 all 仍因 MinIO Docker FROM 镜像域名 DNS 失败而没有 backend 用例；hosted、真实 Provider/平台/生产与四项发行许可 blocker 不由此关闭，见[本轮证据](../docs/reference/turbo-rollout-plan.zh.md#本阶段执行证据与未决事项)。

```bash
node scripts/doctor.mjs
pnpm install --frozen-lockfile
pnpm setup:local
pnpm db:up
pnpm db:migrate
pnpm bootstrap
pnpm build:v4
# 仅全新空库/空存储；setup 的描述符对应默认 .local/blobs。
pnpm storage bind --new --stopped --target-config .local/blob-target.json
pnpm services:start
pnpm services:status
```

`setup:local` 创建 0600 的 `.env`、`.env.worker`、`.env.agent` 并随机生成新 v4 数据库密码，已有文件不覆盖，不自动复制账号或 Provider 凭据。独立应用数据在本仓 `.local/`；Agent 默认 `.local/agent-data`，不复用 `~/.agent-workspace`。本机服务与桌面启动器继承宿主原生 CLI 环境，实例设置覆盖同名变量；空 Home 不创建独立原生账号目录。容器仅能继承容器服务进程实际可见的配置，不会自动挂载宿主 Home。新安装显式选择 Local，仍须停写绑定；`blob-target.json` 的绝对 BLOB_ROOT 必须与 API 配置一致。已有成果使用 `bind --adopt` 全量核验，不能用 `--new` 冒充空库。数据库 Compose project 为 `project-management-agent-v4-backend`，宿主默认55444。

`pnpm bootstrap` 仅为**空库**准备一次性 Web 设置：将随机令牌持久化到 `.local/setup-token`（0600），数据库仅保存摘要；终端只显示文件路径，不生成账号或明文密码。启动后打开本实例 `/pm`，从私有文件安全取用令牌，输入姓名、邮箱、密码和工作区名称完成设置。默认仅邀请注册；有账号或工作区的旧库直接 no-op，不读取、改写或删除既有凭据，不重置密码。数据库/schema 错误不会当作空库。正式业务命令仍需真实登录会话、当前成员能力和版本；新成员使用工作区邀请，现有受控 `account:create` 入口仍须管理员显式授权。

### 工作区示例初始化升级与恢复

首次设置及明确新建工作区的 Nova 初始化需要 `0052_workspace_samples.sql` 和增量 `0053_workspace_sample_storage.sql`，并同步更新 PM API、Web 与桌面后端；仅到 `0051` 的既有部署不能按 Web-only 更新。升级前核对本项目进程、工作目录、服务模式和数据库身份，按现有停写／一致备份流程执行迁移，不在业务库运行验证夹具。`0052` 原迁移不改写，`0053` 不推断或回填旧目录所有权，已有行初始为 `unclaimed`。旧 `ready` 记录保持原样；旧 `pending` 只有在合法原 state 已存在并通过既有校验后，才可登记其目录身份为 `established`，不由缺失的 state 猜测原所有权。

- 新目录必须独占创建，随后将准确设备／inode 身份及 `prestate` 提交到原初始化记录，才允许写首份核心 state；state 持久后先提交 `established`，再写任何示例内容。每个阶段重新取得原工作区锁并核对当前创建者／成员能力。
- 原请求仅能续接已有持久所有权证明、身份未变的 `prestate`。替换或丢失的原目录、未知已有但没有 state 的目录、`established` 后缺失的 state 均拒绝自动接管或重种。独占建目录后、所有权提交前中断尚无证明，也保持拒绝，不自动删除目录。
- readiness 将全部示例初始化记录与既有审计／收据／项目操作一并作为核心权威证据；即使未启用本地项目目录，缺失或不安全的 state 也不能视作空实例就绪。健康检查不代替数据库迁移、真实恢复或业务验收。
- 创建和显式恢复请求必须提供原发起主体的 `expectedActorId`；服务端先以实际认证主体核对，不匹配返回 `409 session_changed` 且不执行创建／初始化。客户端仍保留原键、先查询结果和离页／会话变化保护。该前置条件不增加权限，不统一 Chat／PM 会话或跨存储事务。

### 首次设置令牌与恢复

重复运行 bootstrap 复用同一有效令牌。脚本先持久化并刷新私有令牌文件，再提交数据库摘要；数据库失败或进程中断后保留文件供原样重试。文件及其目录不能是符号链接，令牌文件必须归当前用户所有、为普通单链接 0600 文件，`.local` 必须为私有目录；不安全路径不会自动 chmod 或覆盖。不要将令牌放入日志、URL、环境文件、前端配置或工单。完成设置后数据库永远关闭首次认领；设置响应丢失时先刷新状态，再使用刚设的账号密码登录，不能再次 bootstrap 另建账号。

保护不只检查 `.local`：祖先目录也不能可被组/其他用户写入，唯一例外是 root 拥有的 sticky 共享祖先（例如系统 `/tmp`）；脚本不会自动 chmod 用户的挂载盘或仓库祖先。若当前磁盘树含 0777 祖先，新空库必须改从**安全、私有的工作目录**调用 bootstrap 脚本的绝对路径，并保留同一目标数据库/schema 配置，例如在该安全目录由秘密管理器提供原 `DATABASE_URL` 后执行 `node /absolute/repository/scripts/bootstrap.ts`。令牌会写入该工作目录的 `.local/setup-token`，后续重复准备仍须使用同一安全工作目录；不能仅修改 `TMPDIR` 就假定仓库工作目录已安全，也不能为了通过检查放宽私有路径保护。旧库状态查询成功时仍直接 no-op，不触碰令牌路径。

pending 状态遇到不同令牌会拒绝，**不会自动轮转**。丢失 `.local/setup-token` 时优先从安全备份恢复原文件及 0600 权限。如果原令牌确实无法恢复，仅数据库 owner 可按下面步骤显式恢复尚未初始化的实例：

1. 停止本实例 API 以及所有 bootstrap 进程，核对目标是本实例拥有的正确数据库/schema，保持其他实例不受影响。
2. 在该数据库同一连接执行下列事务；任一步异常都应回滚并停止。它只允许账号、工作区和完成标记均不存在时清除 pending 摘要，绝不能用于已有实例。

```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('project-management:instance-setup', 724631));
LOCK TABLE users, workspaces IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users)
     OR EXISTS (SELECT 1 FROM workspaces)
     OR EXISTS (SELECT 1 FROM instance_setup WHERE completed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Refusing setup recovery for an initialized instance';
  END IF;
  DELETE FROM instance_setup WHERE singleton AND completed_at IS NULL;
END
$$;
COMMIT;
```

3. 仅由操作者显式移走不可用的 `.local/setup-token`（如存在），再运行 bootstrap 准备新令牌，最后恢复 API。不要读取、修改或删除旧账号访问文件；脚本不会替你清理。若原令牌文件仍可用，复用它即可，无需生成另一个。

### CLI 登录与隔离验收

```bash
PM_API_URL=http://127.0.0.1:4194 pnpm pm login --email you@example.com
# 密码从终端隐藏输入；没有 --password 参数，不要把密码写入 shell 历史。
PM_API_URL=http://127.0.0.1:4194 pnpm pm task list
PM_API_URL=http://127.0.0.1:4194 pnpm pm logout
```

CLI 凭据优先级为 `PM_SESSION_TOKEN` > **完整** `PM_EMAIL` + `PM_PASSWORD` > 当前服务 origin 的已保存会话；不从旧访问文件读取密码，没有旧文件覆盖变量。`login` 使用邮箱/密码建立有期限会话，仅保存服务器返回的令牌及到期时间，绝不保存密码。`PM_SESSION_TOKEN` 供显式自动化请求使用，不会被悄悄持久化。自动化密码只能通过私有进程环境/秘密管理器提供，不要放进参数、日志或版本库。

默认会话目录为 `${XDG_CONFIG_HOME:-$HOME/.config}/dovspace/pm-cli`；`PM_CLI_SESSION_DIR` 可选择绝对私有目录。目录为 0700、每个服务文件为 0600，并拒绝符号链接、硬链接及不安全权限。规范化的 origin（协议、主机、端口）分别保存会话，`localhost` 与 `127.0.0.1` 是不同 CLI origin；退出只清当前 origin。远程必须 HTTPS，HTTP 仅限回环；重定向不会收到秘密。过期会话要求重新登录。

`logout` 真实调用服务端撤销，成功或服务端已返回未认证后才删除当前 origin 的本地文件；连接/服务错误保留文件并返回失败，不伪报已撤销。若显式环境凭据和保存会话不同，两者都核对退出，其他 origin 不受影响。迁移已有安装时，先显式登录，按账号安全入口更改已暴露密码并核对恢复邮箱，切换自动化后由用户自行清理旧访问文件；此批次不自动改密码或清理文件。

`pnpm smoke` / `pnpm smoke:verify` 使用相同显式凭据或安全 CLI 会话来源，目标为 `PUBLIC_ORIGIN`，未设则取 `PM_API_URL`，最后才使用本机公共入口。`PM_WORKSPACE_ID` 选择工作区；省略时创建验收只接受唯一授权工作区，verify 可复用证据中仍被授权的工作区。先对**隔离实例/数据库**执行 login，再以相同 origin 运行 smoke；不要在既有业务库创建验收数据。smoke 仅撤销自己通过密码创建的临时会话，不撤销调用者传入的令牌/保存会话。隔离测试可将 `PM_CLI_SESSION_DIR` 指向 mkdtemp 下的 0700 目录，不能借用真实用户 Home 或旧凭据。

| 配置 | 默认/职责 |
| --- | --- |
| HOST / PORT | 127.0.0.1 / 4194，PM API 监听地址 |
| PUBLIC_ORIGIN | http://127.0.0.1:3224，精确浏览器来源；配置为 loopback 时，同端口的 localhost / 127.0.0.1 / [::1] 视为同一来源 |
| DATABASE_URL | 私有数据库连接；不得写入文档、日志或版本库 |
| BLOB_PROVIDER / BLOB_ROOT | 默认 local，根目录 `.local/blobs`；仍须显式绑定才可用。disabled 明确禁用，S3 必须显式选择和配置，不隐式回退 Local |
| CORE_WORKSPACE_ROOT | `.local/pm-workspaces`；每个 PM workspace 一个真实目录，存放权威 Markdown/配置/状态 |
| PM_CHAT_SPACE_ROOT | 默认 PM API 服务用户的 `~/.pmv4`；仅保留 PM 文件区域／保存位置职责，不作为 Agent 代码或 scratch 执行目录 |
| AGENT_WORKSPACE_ALLOWED_ROOTS | Agent 角色配置的绝对路径 JSON 数组；默认服务用户 Home，限制目录打开／浏览／执行解析。升级时显式核对既有代码目录所在范围，不自动从 PM 登记导入 |
| CHOKIDAR_USEPOLLING | 默认 false；宿主 inotify 配额耗尽时设为 true，文件监听改为轮询（权威不变） |
| COOKIE_SECURE | 本地 HTTP 为 false；HTTPS 部署需 true，并在该部署下重新验证认证 |
| WORKER_INTERVAL_MS | 500；失败时指数退避，最大 30 秒 |
| EVENT_RETENTION_DAYS | 7；事件过期后通过实体快照恢复 |

Worker 使用独立 `.env.worker`，不继承 API 的 S3/AWS 凭据；管理脚本只传系统运行变量和该角色配置。升级已有安装需由操作者准备 Worker 文件，不能把 API 整份环境复制过去。Worker 需要 `DATABASE_URL`、只读核心目录及按功能分配的邮件/Webhook 配置；迁移角色只需数据库，Web 不得取得这些秘密。

### 开发与本机服务管理

`pnpm dev:v4` 启动 PM API/Worker/Agent API、公共网关和统一 Web dev；Web 有 HMR，后端源码修改后显式重启。`pnpm services:start` 使用 `build:v4` 的 API/Worker/Agent 产物，由公共网关直接托管统一 Web 产物。两者不能在同一端口并行；切换模式先 `pnpm services:stop`。`services:status` 分别显示进程身份与 HTTP 就绪，不声明模型已配置或执行成功。Ctrl-C 只停止该次 dev 启动的自身进程；常驻进程由 `services:stop` 管理。

管理器记录 `.local/services.json`，发送信号前同时验证 PID、Linux `/proc` 启动时间、精确 cwd 与允许入口；端口占用时拒绝启动，不按端口查杀，不删除数据库/Agent 数据。日志在 `.local/logs`。PM 认证 Cookie 为 `pm_v4_session`，Agent 为 `agent_v4_access`，保留原 Origin/认证/目录保护，没有新增角色或授权规则。

公共网关将 `/api`、`/health` 和 `/openapi.json` 转发 PM API，将 `/agent/api/*` 去掉 `/agent` 转发 Agent API，其他页面和资源来自同一 Web 构建；WebSocket 与 SSE 保持同源。Provider 设置为 `/agent/settings/providers`，私有环境为 `.env.agent`，没有模型配置不会返回假成功。

统一 Web 构建保留旧的带哈希 JS/CSS，避免已经打开的页面稍后加载旧 chunk 失败；历史资源只在停止服务并确认旧页面不再使用后显式清理。

现行执行环境使用独立 Agent Workspace v2，需同时更新 PM API、Agent API 和 Agent Web，并在备份后应用 `0051_retire_pm_agent_code_workspaces.sql`。规范化目录、元数据 revision 与设备/inode 身份保存在 Agent SQLite，不绑定 PM 项目。旧 `0037_agent_storage_defaults.sql` 保存位置及 PM file-area 配置不自动转换为 Agent 目录，也不移动文档。纯对话 scratch 位于 Agent 数据目录的 `chat-scratch`；首次分配后丢失或身份改变时拒绝重建。

Files / Git 请求只携带 Session 与相对路径；Session Terminal 使用实际执行目录／Worktree，Workspace Terminal 使用明确打开的文件夹。普通代码环境仅要求 Agent 能访问对应绝对目录；PM 业务预检通过已有服务 HMAC 调用 Agent 的内部解析接口，不把该接口暴露给浏览器或网关。容器挂载须显式配置，不把宿主 `~` 当容器用户主目录。终端拥有服务进程 shell 权限，不是安全沙箱；不跨 Agent 服务重启存活，不自动重放创建请求或命令。

#### Agent Session 执行环境切换

1. 先完成受影响检查、真实隔离回归、来源校验及 PM／Agent／Web 构建；Web 保留旧哈希资源。任一门禁失败时保留现有服务，**不先删除旧 Session**。
2. 核对本副本端口、PID、启动身份、cwd 与服务模式，再停止本副本 API／Worker／Agent；不停止数据库或其他项目服务。先制作并核对私有 Agent 离线备份及 PM 登记数据备份，再通过既有迁移入口应用 `0051_retire_pm_agent_code_workspaces.sql`。该迁移只退役旧目录登记／scratch 身份表，不移动或删除磁盘目录；仅回滚代码不能恢复旧登记或已删除聊天。
3. 对 Agent 角色配置中实际的绝对数据目录生成新的私有清单，人工核对候选 ID、保留业务证据、命名空间分类和 blocker：

   ```sh
   node scripts/agent-session-cutover.ts --data /ABS/AgentData --stopped --output /PRIVATE/new-session-plan.json
   node scripts/agent-session-cutover.ts --data /ABS/AgentData --stopped --apply --plan /PRIVATE/new-session-plan.json
   ```

   工具获取既有独占锁，拒绝活动进程、未核对操作、未知命名空间或指纹变化，不替操作者杀进程、不在启动时自动删除。先核对原结果，不换清单或请求 ID 绕过不确定状态。
4. 清理执行选择为旧版 v1 或未登记版本的应用 Chat 消息／索引，更新旧删除标记为不可执行的 v2 最小标记；保留任务／工作流关联的 generation 和输出证据、PM 数据、代码／Worktree、附件字节、Provider 配置／账号和外部原生 CLI 历史。无法证明独占归属的附件不自动 GC。新版 v2 Session、Agent Workspace 和私有 scratch 记录不在删除对象中；未知的未来执行版本会阻止整次清理，不被当成旧数据。旧清单格式或指纹不匹配时必须重新盘点，不能直接套用。
5. 安装匹配产物后重新启动本副本，在公共入口验证“打开文件夹 → Workspace → Sessions”、Files／Git、终端及旧会话不可继续。普通代码会话不要求 PM 登录或 PM 归属；PM 资料通过明确目标的工具访问。旧交付／工作流须显式重新选择 Agent 文件夹并通过受控“新建会话”保留原证据，不重放执行。纯对话仍可使用无代码环境。

该切换不是统一 Session／持久化设计收口，也不代表真实 Provider、桌面 GUI、容器或公网部署已验收。


### 本地项目目录与附件身份

本机进程部署可启用受信任的 `LOCAL_PROJECTS_ENABLED=true`、`LOCAL_PROJECT_ALLOWED_ROOTS`（绝对父目录 JSON 数组）及 `LOCAL_PROJECT_DEFAULT_PARENT`；`setup:local` 维护独立的本机目录配置。`LOCAL_DATA_ROOT` 决定共享工作区状态的默认位置，`LOCAL_BACKUP_ROOT` 决定真实备份输出位置。目录授权是服务配置，不由浏览器提交的路径扩权；宿主目录浏览仅对已认证的工作区全局管理员开放。

新项目的 Markdown 位于所选根 `.pm/core`，附件**实际位于该项目 `.pm/attachments`**；`.pm/project.json` 与附件 `.pm-store.json` 固定工作区、项目和 storageId。共享 `.pm/state` 仍在工作区数据根。项目切换不修改全局 `BLOB_ROOT`；未登记旧项目继续使用原 Local/S3。上传/版本保留不可变 storageId，历史 SQL 收据/事件不改写，受控维护以独立对象路由和旧存储身份别名解析历史引用。目录缺失、盘卸载、符号链接或身份冲突均拒绝访问，不自动创建空根或回退到其他目录。

显式项目迁移与重定位：

```bash
# 停止本应用 API/Worker 与外部 Markdown 编辑器后；数据库保持运行。
# 先记录一次 operation UUID，崩溃/丢响应后复用，不重新生成。
pnpm storage:projects migrate --stopped --workspace-id WORKSPACE_UUID --project-id PRJ-001 \
  --target-root /approved/existing-project --target-mode existing --operation-id OPERATION_UUID
pnpm storage:projects relocate --stopped --workspace-id WORKSPACE_UUID --project-id PRJ-001 \
  --target-root /approved/new-project --target-mode new --operation-id ANOTHER_OPERATION_UUID
# 用户已移动完整目录、旧根确实不存在时，显式验证并重新绑定；不是自动缺盘回退。
pnpm storage:projects rebind --stopped --workspace-id WORKSPACE_UUID --project-id PRJ-001 \
  --target-root /approved/moved-project --operation-id REBIND_OPERATION_UUID
pnpm storage:projects recover --stopped --operation-id ORIGINAL_OPERATION_UUID
```

`DATABASE_URL` 与原 Local/S3 配置由维护角色的私有进程环境提供；可用 `--core-root` 指明工作区数据根。API/UI 的迁移使用同一原语、固定请求键、工作区串行锁与持久项目写入围栏，并要求显式 `writersStopped:true` 确认外部编辑器已停止；这不是防止外部程序写盘的 OS 锁。中断后围栏保持，只允许核对/恢复原操作；源或目标字节/revision 改变则停止，不删除改变的用户文件。独立停写 CLI 不自动停止任何服务。成果原 ID、Markdown revision、历史版本/审核/复制来源保持，旧全局对象不按年龄清理。

全局 `pnpm storage inventory/migrate/verify/activate` 现在只维护 legacy global provider；独立项目存储不被错误地搬入最新全局根。全根恢复使用下面的恢复流程。


### 私有 S3、通知与 Webhook

- S3 配置与受控维护步骤见 [公开集成配置与协议](../docs/guides/integrations.md)。只使用显式凭据、私有桶/prefix、条件单次 PUT 与真实字节校验；下载仍经当前授权 API，不返回长期对象直链。`SOURCE_S3_*`/`TARGET_S3_*` 凭据仅用于维护角色，描述符及 manifest 不保存秘密。绑定/迁移/激活前停止 API、Worker 和外部核心写入者。
- API 是唯一 Workspace/文件事实导入进程；Worker 只读核心文件并独立消费通知事实，不初始化第二个 Workspace/watcher。`pnpm notifications:status --workspace WORKSPACE_UUID` 查看实际进度，失败事实只在修复后用原序列显式处理；不伪造停机期间未观测的历史。
- Webhook 默认禁用。API/Worker 使用同一批准目标元数据，只有 Worker 挂载签名密钥；需要有效接收器协议、持久去重/收据及核对屏障。`unknown` 不自动重新投递；恢复数据库后的外部账本对齐是启用门禁，不能靠更换 deliveryId 绕过。配置与操作边界见 [公开集成配置与协议](../docs/guides/integrations.md)。

### 成员邀请 SMTP

成员目录和角色授权不依赖邮件配置。邮件邀请默认关闭；配置不完整时服务启动报安全错误，不回显配置内容。API 与 Worker 必须使用同一组配置，升级先应用 `0016_member_directory.sql`、`0017_member_invitations.sql` 并构建。

| 配置 | 要求 |
| --- | --- |
| SMTP_HOST / SMTP_PORT | 邮件服务主机；端口默认 587 |
| SMTP_SECURE / SMTP_REQUIRE_TLS | 默认 false / true，即要求 STARTTLS；465 通常设 secure=true。只有可信 loopback 测试接收端才允许关闭 REQUIRE_TLS |
| SMTP_USER / SMTP_PASSWORD | 如需认证必须成对配置；不得写入仓库或日志 |
| SMTP_FROM | 合法发件邮箱 |
| INVITATION_WEB_ORIGIN | 实际前端 origin，不带路径/查询/凭据；公网必须 HTTPS，仅 loopback 允许 HTTP |
| INVITATION_TOKEN_KEY | 安全随机 32 bytes 的 canonical base64；用于 AES-256-GCM 加密未发送队列令牌，API/Worker 必须一致且需秘密备份 |
| INVITATION_TTL_SECONDS | 默认 604800；范围 300–2592000 |
| SMTP_TIMEOUT_MS | 默认 15000；范围 1000–120000 |

不要在未知发送结果上自动重试：`smtp_accepted` 只证明 SMTP 接收，`unknown` 表示可能已发送。管理员可显式重发并作废旧链接，但应先检查邮件服务日志并确认可能产生重复邮件。Worker 发送租约过期进入 unknown，不回到 queued。更换 token key 会使旧队列不可解密；应先处理旧队列，不能将解密失败冒充发送成功。

邀请令牌仅存在邮件 fragment 和接受页内存；公开接受接口通过 POST body 接收，不进入查询串、审计事件或命令收据。已接受命令的原收据可凭原 token、当前账号密码及原 commandId 在原邀请期限后恢复，但不会恢复之后被撤销的成员权限。2FA 未接入身份源，不提供虚假安全开关。

### 独立可信恢复邮箱

找回与邀请使用不同门禁及队列。API/Worker 需一致设置 `ACCOUNT_RECOVERY_WEB_ORIGIN` 与独立的 `ACCOUNT_RECOVERY_TOKEN_KEY`，以及上述 SMTP 传输；精确选项见 [公开集成配置与协议](../docs/guides/integrations.md)。历史登录邮箱和已接受邀请不自动成为可信恢复邮箱。匿名申请保持统一响应，令牌仅经邮件 fragment/页面内存及 POST body 传递；密码重置撤销全部旧会话。生产 Caddy 对账号路径设置 no-store、no-referrer 与限制性 CSP，并从错误日志中移除原请求对象，避免查询串令牌被代理记录。真实外部收信、域名/TLS 与旧备份凭据重新开放仍需单独批准及验收。

## 运行与恢复

`services:start` 只复用经过 PID/startTime/cwd/入口校验的本项目进程，启动后等待 ready。日志位于 `.local/logs/api.log` 和 `worker.log`。`services:stop` 只发 SIGTERM 给验证归属的 API/Worker，不停止数据库、不删除卷、不强制杀进程。

升级顺序为停止本项目 API/Worker、安装锁定依赖、执行迁移、构建、再启动。迁移记录包含文件摘要，已应用迁移不可原地改写，修复使用后续迁移。readiness 要求已应用 schema 与当前构建携带的迁移集合和摘要一致。

数据库暂时不可用时 API 返回未就绪/暂不可用，Worker 退避重试。空闲连接错误只记录安全错误码，不使整个进程因未处理连接事件退出。恢复后重新检查 readiness 与原收据；不要把新的示例数据当作持久化恢复证据。

```bash
pnpm smoke
pnpm smoke:verify
pnpm outbox:failed --workspace WORKSPACE_UUID
pnpm outbox:retry --workspace WORKSPACE_UUID
```

`smoke` 创建实际验收数据；`smoke:verify` 只复核已有验收对象和字节（登录/退出会创建/撤销认证会话）。outbox 达到十次发布失败后整工作区隔离，不能跳过原事件。修复故障后显式 retry，原 eventId、命令收据及业务实体保持；CLI 审计写入失败时恢复事务回滚。

## 备份与恢复验证

```bash
pnpm services:stop
pnpm backup --stopped
pnpm backup:verify --stopped
```

备份位于 `LOCAL_BACKUP_ROOT/{timestamp-id}`（默认应用数据根的 `backups`），v3 包含**仅 `public` 业务 schema** 的 custom-format `database.dump`、`files/core` 的全部工作区权威 Markdown/配置/共享状态、`files/projects/{storageId}` 的每个已登记项目 `.pm`（含项目与附件标记、核心文件和附件）、`blobs` 的全部 SQL 历史引用对象及摘要清单。清单不依赖源机器的绝对项目路径，项目原有代码/README 不导入。0700/0600；仅排除可重建 cache。命令只接受专用本机 Compose 数据库配置，要求 `--stopped` 并拒绝残留业务连接；外部 Markdown 写入者也必须停止。缺失/不安全根、未完成目录转移、未知或损坏历史对象都使备份失败，不能用局部副本冒充完整备份。

`backup:verify` 在新随机数据库、新核心根、新项目父目录及新 Local 存储根恢复；先核对全部原始 checkpoint，再从复制的身份标记重新绑定所有项目，不打开源项目根。全局存储激活与通知 epoch、Webhook、认证 token/会话和邮件队列恢复围栏在目标库同一事务提交。随后真实 API 用新验收账号检查匿名拒绝及授权历史版本下载原字节；不覆盖源库、不修改归档，结束只删除自己的恢复库/目录。报告保留 `productionCredentialPolicyApproved=false`：清理旧会话和队列不等于批准恢复旧密码、邮箱或外部 Webhook 账本。

正式恢复先由数据库 owner 将 `database.dump` 恢复到**新独立目标库**并保留全部约束，再使用目标库私有环境执行：

```bash
pnpm storage:projects restore --stopped --restored-target \
  --backup-directory /backup/SET \
  --target-core-root /recovery/core --target-projects-root /recovery/projects \
  --target-blob-root /recovery/blobs --target-store-id NEW_STORE_UUID \
  --expected-epoch ORIGINAL_EPOCH --operation-id RESTORE_OPERATION_UUID
```

三个目标根须独立、未占用，父目录已存在；不得指向源根或其他用户目录。`--restored-target` 是对目标数据库隔离的显式操作者确认，不会自动创建/覆盖数据库。旧项目 storageId 保持，旧全局 storageId 通过恢复别名解析，不修改不可变业务历史。未知结果保留原操作 UUID与归档，禁止换键覆盖目录；文件复制阶段失败保留目标证据，修复前不得启动目标服务。SQL/core/blob 的摘要必须属于同一停写备份集。

原参数重放会核对已有完整文件和仅包含批准新根变化的映射；不会覆盖冲突文件或自动再次撤销后来合法会话。磁盘部分写入、额外文件或字节冲突保留证据并失败，不能把它们当作已完成恢复。


`0024` 之前含非空 `project_audit` 的历史备份不能直接声称单步恢复通过：需在全新目标库分段 `pre-data → 仅应用0024函数作用域元数据修复 → data → post-data`，保留原 dump、业务行及 CHECK/触发器。应用 `0024` 后生成的新备份携带正确函数作用域。该历史过程留在本机证据中；不得据此推断新版本/当前目标已经恢复通过，仍须在独立目标按本手册核对全部约束与摘要。

## 生产 Web、同源 API 与 Lab 门禁

- `pnpm dev:web` 的 Vite 开发操作默认保留 `/lab/pm`，这是显式隔离的展示入口；`PM_ENABLE_LAB=false pnpm dev:web` 可关闭。Lab 不作为 `/pm` 失败时的回退路径。
- **任何 Vite build 操作默认关闭 Lab**，包括 `--mode development`、自定义 mode 或外部 `NODE_ENV`；不能仅以 `import.meta.env.PROD` 推断生产安全策略。根 `build:web` 调用前端 TypeScript + Vite 默认 production build，根后端 `build` 不构建 Web。
- 只有在受控非生产展示环境中，操作者可通过进程环境 `PM_ENABLE_LAB=true` 显式构建带 Lab 的静态产物；不是运行时 URL、localStorage 或浏览器可切换的开关。`PM_ENABLE_LAB` 仅接受 `true`/`false`，无效值导致配置报错。Vite 配置仅读取注入的进程环境，不把 `.env` 里的服务秘密加载到浏览器。
- 默认生产产物中 Lab 路由不注册，客户端导航进入 not-found；`deploy/Caddyfile` 另在 HTTP 层对 `/lab` 和所有子路径返回 **404**，即使误用了带 Lab 的展示产物也拒绝访问。该生产代理不提供 Lab 开放开关；受控展示应使用独立非生产 preview，不修改此代理。
- 公共网关和 Caddy 将 `/api`、`/health`、`/openapi.json` 转发 PM API；`/agent/api/*` 优先剥离 `/agent` 到 Agent API，其他页面使用统一 Web 产物。代理保留 Cookie、Host、Origin、Last-Event-ID、SSE 与 WebSocket；`PUBLIC_ORIGIN` 必须精确匹配公共来源（配置为 loopback 时同端口的 localhost / 127.0.0.1 / [::1] 等价）。
- Caddy 为统一 SPA 提供深链接回退。PM Lab 在 HTTP 层返回 404，不使用 fixture 冒充真实后端。

## PM API / Worker / Agent API / 统一 Web 容器部署

### 职责、拓扑与秘密

| 服务 | 职责与边界 |
| --- | --- |
| PostgreSQL | 继续由原 `deploy/compose.yaml` 管理专用库、SQL 记录和 PostgreSQL 命名卷；应用 Compose 不拥有它的启停。 |
| migrate | 一次性运行当前镜像的迁移与摘要检查；失败阻止 API/Worker 启动。只连接指定数据库，不自动建业务样例或账号。 |
| API | 唯一 HTTP/认证/命令入口及 Markdown 核心进程；独占核心写权限，使用显式绑定的 Local/S3 provider；readiness 检查真实依赖，初始化不等于外部服务验收。 |
| Worker | 独立 outbox/保留维护、通知、邀请/找回邮件和受限 Webhook 循环；核心卷只读，不挂载 blob 卷，不取得 S3/AWS 凭据，不执行 Agent。心跳不等于邮件送达或接收器就绪。 |
| Agent API | 独立 SQLite 与应用自有 runtime/profile 状态的执行服务，原生 CLI Home 可由服务环境或实例配置提供；用固定 `PM_API_URL=http://api:4194` resolve，本次用户 Cookie/Authorization 只向该 PM origin 转发。与 PM 挂载相同绝对项目路径以使用真实 cwd，不增加 PM 权限或自动完成任务。 |
| storage | maintenance profile 下的编译后维护 CLI；仅停写时显式绑定/核验/迁移/激活/恢复，不随 API 启动自动修复绑定。 |
| Web | 多阶段构建后的静态产物与 Caddy 同源反代；只在 loopback 发布临时可配置端口，不注入数据库或 SMTP 凭据。 |

`deploy/Dockerfile` 使用 Node24.21.0/pnpm11.9.0及根pin的Rust工具链 单锁文件构建 PM 与 Agent。PM 后端携带生产依赖、产物及迁移入口；Agent 镜像通过 pnpm deploy 携带独立生产图；Web 镜像包含统一静态构建和 Caddy。`.dockerignore` 排除秘密、`.local`、node_modules 与历史产物；不将凭据放入 ARG/COPY/前端变量。生产构建与部署须另行验收。

默认镜像来自官方仓库；若宿主 Docker daemon 的仓库镜像配置不可达，可由操作者显式设置 `PM_NODE_IMAGE`、`PM_CADDY_IMAGE` 为批准的同版本镜像来源（或固定 digest），不改 daemon、不静默替换运行时。本机实际使用 `docker.m.daocloud.io/library/node:24-bookworm-slim` 与 `docker.m.daocloud.io/library/caddy:2`，这是受控替代来源的烟测，不证明任意镜像/网络环境可用。

**CORE 限制仍是单 API 进程、单宿主本地文件系统，不是已实现分布式锁。** `replicas: 1` 仅声明部署期望，不能防止人工 `--scale api=2` 或另起 Compose project 共享卷；禁止这些操作、cluster/PM2 多 worker 及滚动交叠。升级先停旧 API，再启新 API。私有 S3 只迁移不可变 blob，不解决 Markdown 多写、共享卷协议或 HA；多个 Worker 的 outbox 测试不代表整个系统支持多实例核心。

### 首次启动与升级

先由操作者准备独立的 `/secure/pm-deploy.env`（0600，不在仓库/构建上下文），只包含部署参数：

```dotenv
PM_APP_PROJECT=project-management-agent-v4-app
PM_RUNTIME_ENV_FILE=/secure/pm-runtime.env
PM_MIGRATION_ENV_FILE=/secure/pm-migration.env
PM_WORKER_ENV_FILE=/secure/pm-worker.env
PM_STORAGE_ENV_FILE=/secure/pm-storage-maintenance.env
AGENT_RUNTIME_ENV_FILE=/secure/pm-v4-agent.env
PM_MAINTENANCE_DIRECTORY=/secure/pm-maintenance
PM_DATABASE_NETWORK=project-management-agent-v4-backend_default
PM_PUBLIC_ORIGIN=http://127.0.0.1:3224
PM_WEB_PORT=3224
PM_COOKIE_SECURE=false
```

环境按角色隔离：migration仅数据库；runtime为 PM API 的数据库/存储及按需邮件；worker为数据库、邮件及批准 Webhook 元数据/密钥，禁止 S3/AWS；storage仅维护配置；Agent只有 v4 Provider 配置和新32+字符 `AGENT_WORKSPACE_ACCESS_TOKEN`，不复制 PM 数据库/旧 Provider 凭据。Agent容器非loopback监听仍要求原访问令牌保护，不能借部署关闭。Compose插值需要这些路径，即使未开maintenance。数据库主机为本 v4 专用网络中的 `postgres:5432`，不是宿主loopback；HTTPS必须secure Cookie并独立验收。

本地项目功能在应用 Compose 中默认关闭；显式 `PM_LOCAL_PROJECTS_ENABLED=true` 后，API 使用 `/var/lib/pm/projects` 的 `project-data` 卷，Worker 将同一项目卷只读挂载以解析映射后的核心文件，不获得 legacy blob 卷或 S3 凭据。该只读项目卷本身包含附件，不能宣称 OS 层附件保密隔离；Worker 实现仅消费核心事实。容器 UI 选择的是容器可见目录，不是假装浏览任意宿主路径。需要既有宿主代码目录时，操作者必须给 API/维护角色可写、Worker 只读的相同绝对路径 bind mount，并同步可信 allowedRoots；禁止以 symlink 模拟挂载。`project-storage` maintenance service 运行编译后的项目维护 CLI，挂载核心/项目/legacy 卷和 `/maintenance`，仅显式停写操作，不随 API 自行修复。外部根备份必须逐根导出，不能只归档 `core-data`/`blob-data`。

Agent 与 API 同挂载 `project-data:/var/lib/pm/projects`，因此 resolve 返回的绝对目录在执行容器中真实存在；添加其他宿主 bind mount 必须给两者提供相同绝对路径并同步原可信 allowedRoots。Agent 数据使用独立 `agent-data` 卷，不共享来源 Provider homes。`scripts/agent-docker.sh build|start|stop|status|logs` 只管理 `project-management-agent-v4-app`，读取 `V4_DEPLOY_ENV_FILE`（默认本仓私有 `.env.deploy`），不能用于停止数据库或其他项目。


`project-storage` 使用当前原 provider 的 `BLOB_PROVIDER`/`BLOB_ROOT` 或显式 `S3_*` 环境；跨 global-provider 迁移的旧 `storage` CLI 仍使用无凭据描述符及 `SOURCE_S3_*`/`TARGET_S3_*`。这些只属于停写维护角色，不复制给 Worker/Web，也不写入项目标记或备份清单。


在项目根目录执行（不要将既有数据库 Compose 加入这组 down/stop 命令）：

```bash
docker compose --env-file /secure/pm-deploy.env -f deploy/compose.app.yaml build
# 首次使用空库时，先显式迁移；失败时停止，不启动业务服务。
docker compose --env-file /secure/pm-deploy.env -f deploy/compose.app.yaml run --rm migrate
# 在维护目录准备 target.json；Local 容器根为 /var/lib/pm/blobs，S3 则填写明确的无凭据描述符。
docker compose --env-file /secure/pm-deploy.env -f deploy/compose.app.yaml run --rm storage bind --new --stopped --target-config /maintenance/target.json
# 首次设置由受控管理宿主准备私有一次性令牌；镜像不会生成或打印口令。
# 仅在全新安装执行；私有 host 配置需连接同一个库的管理员可达地址。
node --env-file=/secure/pm-runtime-host.env scripts/bootstrap.ts
docker compose --env-file /secure/pm-deploy.env -f deploy/compose.app.yaml up -d --wait
curl --fail http://127.0.0.1:3224/health/ready
curl -i http://127.0.0.1:3224/lab/pm
```

源代码 bootstrap 前需 `pnpm install --frozen-lockfile`；管理宿主只保存 `.local/setup-token`（0600），不进入镜像、不输出令牌。它需连接同一个目标库，启动后在正式 HTTPS Web 入口完成首次设置；已有安装可跳过，误运行也不会重置已有账号。重复准备/丢失 pending 令牌按上面的受控恢复步骤处理。不要对已有业务库执行 smoke 创建验收数据，实际验收应另建隔离 schema/临时内容根。

升级先构建新镜像，记录本 v4 容器ID，再 `stop web agent api worker`（仅本应用 Compose）并用 `docker wait` 核对全部退出；迁移成功后显式 `up -d --no-build --force-recreate --wait`。迁移失败不启动新进程、不改历史迁移，未知请求沿原ID核对；日志不导出环境、Cookie、令牌或口令。

同一镜像的暂停/恢复也按停写后的显式替换流程处理：先记录本应用 `ps -q api worker web` 的容器 ID，`stop` 后以 `docker wait` 核对旧进程全部退出，再 `up -d --no-build --force-recreate --wait`，最后检查同源 `/health/ready` 与原对象/字节。本机 Compose v2.18.1 曾在停止后 `up --wait` 报 `exited (0)`，随后 `start` 返回 0 却未启动 API；不把命令退出码当健康证据，不忽略真实 502，不允许新旧 API 交叠。初次启动仍使用上面的 `up`。

`stop web api worker` 保留数据库与应用卷；`down` 只移除这组应用容器和自身网络，外部数据库网络及命名数据卷保留。**禁止 `down -v` 用作日常停机。** 不运行原数据库 Compose 的 stop/down。容器为 unless-stopped，Docker daemon 重启行为不等于已验收宿主机自启或 HA。

### 容器数据备份与恢复边界

本机 `pnpm backup[:verify] --stopped` 不能直接覆盖这组容器卷。容器部署必须先阻断写入并停止 API、Worker 和外部核心写入者；由数据库 owner 执行 scoped custom-format dump，记录同一 SQL/core checkpoint，再通过实际 provider 全量核验、导出引用对象。S3 不能用复制 `blob-data` 卷代替导出。维护 CLI 通过 `storage` profile 运行，迁移日志/摘要写入 `/maintenance`；配置说明见 [公开集成配置与协议](../docs/guides/integrations.md)。备份包含镜像标识、迁移摘要与私有配置恢复说明；加密 key 单独秘密备份，不进入公共 manifest。约束/摘要错误必须停止，不关闭约束掩盖失败。

恢复使用**新数据库、新核心根及新存储身份**。导入 SQL/core/对象后，必须执行受控 `restore-rebind`，核对原 epoch、备份 manifest 与 SQL/core 摘要，在目标库同一事务中完成恢复围栏和绑定激活；不能直接改环境指向新桶后启动。保留 UID/GID 1000 的必要目录权限；核验当前及历史引用字节、原收据和核心状态后，才在临时入口执行真实登录/下载/SSE。恢复目标默认不获得旧凭据信任批准，Webhook 接收端账本也不能仅靠恢复 PM 库推定同步。下方较早的容器恢复记录不能替代新增围栏或目标生产环境演练。

## 发布验收与测量范围

运行证据仅使用自有临时 HTTP 端口、随机 PostgreSQL schema、临时 Markdown/blob 根与实际浏览器，不操作公网或真实业务夹具。生产构建及统一检查由集成 owner 完成后再运行；不能把本文配置、Dockerfile 或开发代理配置提交当作部署通过。

有界性能记录只报告实际样本数、并发、请求范围、测量环境及延迟分位数；健康/API 小样本不是负载测试或 SLO。真实硬件显示缩放、IME/触摸设备、公网目标/域名/TLS/边缘代理、HA/故障域、共享存储拓扑、容量与可用性 SLO 均待讨论。完整 INF-01（容器备份恢复）、INF-03（长连接/慢客户端/大规模并发）、INF-06（公网 HTTPS Cookie/来源）不能由本机烟测提前关闭。

<a id="release-acceptance-evidence"></a>
## 历史隔离部署证据（0024批次，非当前发布验收）

本轮实际构建了 backend/Web 两个镜像 target，并在独立 `pm-release-*` PostgreSQL、网络与命名卷中运行；浏览器使用隔离主机 `pm-release.localhost:33165`。不复用默认业务库/卷，不占默认 Web/API/PG 端口。最后 API 镜像在接收超时修复后增量重建并停写切换，既有恢复库/卷不重置。

| 场景 | 实际观察 |
| --- | --- |
| Lab 策略 | Vite 实际配置加载矩阵：默认 production/development/custom-mode build 均关闭；显式 true 才开放展示产物，非法值拒绝；开发默认 Lab 目录及 dashboard-1 点击已操作。默认生产 SPA 内导航显示 404，Caddy `/lab`、`/lab/pm` 及嵌套路径均 HTTP 404 |
| 镜像秘密与权限 | 实际 COPY 上下文 probe、本轮 API/Web 运行镜像私有路径检查均为 false，未读取秘密；最后 API 传输补丁重建也通过构建内私有路径拒绝，但未再做一次容器路径 probe，具体镜像 ID 分列于证据。Caddy filecap 曾在 cap_drop ALL 下产生真实 exec EPERM，已移除无用 filecap，保留只读根、cap_drop ALL 与 no-new-privileges |
| API / Worker / PG / Web | 空库实际迁移至 `0024`；最终同源 ready 的 database/storage/worker/core 全 true、quarantinedEvents=0；OpenAPI3.1、43路径；实际登录 Cookie 为 HttpOnly / SameSite Strict，外部 Origin 403 |
| 单进程切换 | 停 API/Worker 后真实同源 502；记录旧容器并 `docker wait` 得到 0/0/0 后才 force-recreate；新 API/Worker/Web 容器 ID 均不同，原 Markdown/收据/成果保持 |
| 新库 / 新卷恢复 | 停写后 scoped custom-format SQL dump + core/blob 卷归档，恢复到新数据库与两份新命名卷；恢复前后 **5 条非空 project_audit、3 份原命令收据、相同 Markdown SHA、70 字节成果 SHA** 一致；未禁用约束，恢复后 unvalidatedConstraints=0，函数 search_path 为 pg_catalog 与实际隔离 schema |
| 最终 API 增量切换 | 新镜像实际 ID 与运行容器一致，包含 connectionTimeout=0 / requestTimeout=120000；在同一恢复库/卷复读原对象/3原收据/相同70字节，再验证 ready、两路 SSE 与正常退出登录，没有重试掩盖失败 |
| 同源 SSE | 最终 SQL 流 HTTP200，实际 change/checkpoint 与 cursor ID；核心流 HTTP200，ready 后由真实 CreateProject 触发 change。首字节分别约18.44ms / 10.44ms；不是固定成功响应或大规模长连接验收 |
| 浏览器 | 真实填写登录并提交、选择授权工作区、点击项目导航，显示实际 PRJ-001/002；最后 API 切换后重访实际 PRJ-003，再点击账号菜单“退出登录”，返回登录表单，实际 auth/me=401；未观察到 pageerror |
| 有界性能 | 最终同源已认证 workspace listing，热态、本机 Docker、30次串行、并发1、nearest-rank：min7.60ms、p50 **9.55ms**、p95 **47.87ms**、max49.50ms；不代表负载、容量、首屏或可用性 SLO。前端仍有约5.99MB minified / 1.85MB gzip主 chunk 及既有混合导入提示 |

成果字节 SHA-256 为 `d506e7df5b1de4b576e8d5239d714e6a8aa4396f02e2ab5d044ec808237be411`。安全机器证据和截图在 `.local/evidence/release-acceptance/`：`image-build.json`、`context-security.json`、`containers.json`、`restored-constraints.json`、`cutover.json`、`browser.json`、`cleanup.json` 及运行日志。`containers.json` 明确保留一次 throwaway controller 在写完 browser_ready 后因无 event-loop keeper 而 Node 13 退出的事实；部署容器继续运行，随后真实浏览器与最终有限切换控制器完成验收，不能将这次控制器退出称为产品零失败。最终有限切换与显式清理控制器均实际 exit0。

已显式清理 **9个自有容器、5个卷、3个网络、9个自有导出镜像**、临时根/秘密配置/归档、临时控制器及自有浏览器 tab；共享基础镜像/构建缓存保留，未做全局 prune，默认服务未改。此前镜像仓库 DNS、pre-0024 审计恢复及 Compose 停后 up/start 问题都保留失败证据，没有绕过 CHECK 或伪造 readiness。

本节仅覆盖上述矩阵。未独立构建并浏览器巡检显式带 Lab 的展示产物、未巡检全部56展示页；真实设备/IME/触摸、公网域名/TLS/边缘代理、宿主/Docker daemon 整机重启、HA/共享存储、容量/慢客户端并发与 SLO 仍未验收，不能据此关闭完整 G1/G2 或宣称生产公网发布。



## 当前运维边界

没有注册系统级开机启动服务，也未验收公开互联网、多机共享存储或高可用部署。本机 Node 进程方式仍由管理脚本启动，宿主重启后需再次执行 `services:start`；数据库及新增应用 Compose 的长驻服务配置 `unless-stopped`，但未演练宿主/Docker daemon 整机重启。两种管理方式不可同时启动 API 进程共享同一 CORE 根目录。

孤立/过期上传仍保留，不自动 GC；未实现通用 job 编排。私有 S3 已提供显式绑定、停写迁移与 provider 感知备份，但目标供应商、凭据、加密/保留策略及生产恢复仍需配置与验收。不能按文件年龄删除可能被历史成果引用的内容。当前范围见[公开能力指南](../docs/guides/project-management.md)，生产门禁不能用历史结果关闭。
