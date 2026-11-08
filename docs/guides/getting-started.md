# 本地安装与首次使用

本页描述当前源码的使用方式和已知限制，不代表当前工作树已通过检查、真实供应商账号验收或生产部署。历史计划和本机验收原件保留在本地，不作为公开安装依赖。

要求 Linux、Node.js 24.21.0、pnpm 11.9.0、Docker 与 Compose；当前 TypeScript MCP/Skills host 不需要 Rust/Cargo，原生编译工具见[开发与验证](development.md)。在本项目根目录对**全新 v4 空库**执行：

完整工程验收另用 `pnpm check:ci`，不是下列安装步骤已通过的保证。`pnpm check:turbo` 默认六 lint，其 `build` / `host-build` 保留完整原类型/构建叶并可恢复已声明公共产物，但仍只是隔离工程检查，不替代按部署环境运行的 `build:v4`。来源/许可/真实测试/fixture/清理不缓存，完整 agent/all 须显式固定公开 authoring source。若服务已托管当前 checkout 的产物，应在新的独立 worktree 中检查，避免覆盖 live dist；参数、source 前提、linked-worktree 和 trusted-only hosted cache 边界见[开发指南](development.md#turbo-显式任务调度与本地-lint-缓存)。

本轮本机缓存/恢复与独立完整 Agent 有实际通过证据，但默认 `all` 的真实 backend 因 MinIO Docker FROM 镜像域名 DNS 失败尚未进入用例；不把工程 HIT、独立回归或现有 3224 健康当作新安装、生产或 hosted 全量成功。实际 hosted workflow、真实 Provider/平台/生产及四项发行许可 blocker 未关闭；结果与测量范围见[本轮证据](../reference/turbo-rollout-plan.zh.md#本阶段执行证据与未决事项)。

```bash
node scripts/doctor.mjs
pnpm install --frozen-lockfile
pnpm setup:local
pnpm db:up
pnpm db:migrate
pnpm bootstrap
pnpm build:v4
# setup 生成的描述符与默认 .local/blobs 一致；改过 BLOB_ROOT 时先同步描述符。
pnpm storage bind --new --stopped --target-config .local/blob-target.json
pnpm services:start
pnpm services:status
```

默认公共入口 `http://127.0.0.1:3224/pm`（同端口的 `http://localhost:3224/pm` 等价，便于端口转发访问）；PM API `4194`、Agent API `4325`、Web 开发上游 `4326`、PostgreSQL `55444`。数据库 Compose 名称 `project-management-agent-v4-backend`，应用 Compose 名称 `project-management-agent-v4-app`。不要连接来源副本的端口/卷。

`pnpm bootstrap` 只为尚无账号和工作区的实例准备一次性设置令牌 `.local/setup-token`（0600），不再创建默认账号或明文密码文件。启动后打开 `/pm`，输入部署管理员提供的令牌、姓名、邮箱、密码和工作区名称；成功后进入真实工作区。令牌不得进入日志、URL 或前端配置；其目录及祖先路径必须安全，特殊挂载环境的私有工作目录操作见[部署手册](../../deploy/README.md#首次设置令牌与恢复)。

已有实例保留账号和业务 ID，不因旧访问文件缺失重新初始化；普通成员通过有效邀请加入，公开注册保持关闭。已有用户先用原密码正常登录，在账号安全中按需改密、验证恢复邮箱，再切换 CLI/自动化凭据；本批次不会自动改密或删除旧 `.local/access.json`。实现与隔离验收见[首次使用与凭据说明](../../deploy/README.md)。

首次账号的工作区仍初始化内置 **Nova 客户门户**示例；登录后新建工作区时可选择是否创建示例，默认不创建。示例包含 1 个项目、8 个任务、4 份文档及 14 个规划对象，均为可编辑的真实 Markdown 数据。各工作区独立分配 ID、目录及关系；不复制部署实例的账号、权限、凭据、评论或执行历史。示例日期固定，负责人留空，可能显示逾期；这不是当前团队的真实安排。已有工作区不自动补种，删除已初始化的示例也不会重新生成。

在工作区选择页或应用菜单的“新建工作区”打开弹窗，填写名称并选择是否创建示例项目。创建前保存原请求键；结果未知时使用“核对原请求／恢复原创建”，不要换键重复创建。恢复先读取原结果；页面卸载或已观察到会话改变时不继续发请求。创建和恢复写入还须携带发起时的 `expectedActorId`，服务端在任何创建／初始化副作用前与实际认证主体比较，不匹配返回 `409 session_changed`；该字段不是授权身份的替代。登录后只有一个工作区时直接进入；多个工作区优先恢复本账号上次使用的已授权工作区，选择页和应用菜单仍可切换。初始化未完成的工作区单独显示，不当作空工作区开放编辑；其他已就绪工作区仍可进入。首次设置已建立身份后若初始化失败，使用原账号正常登录，工作区列表会核对并有界恢复原初始化，不重置密码。

已有安装升级此流程须应用 `0052_workspace_samples.sql`、增量 `0053_workspace_sample_storage.sql` 和 `0054_workspace_creation_without_sample.sql`，并同时更新 PM API、Web 和对应桌面后端，不能只换前端。`0054` 允许创建工作区时跳过示例；跳过记录与示例记录共用原请求键，未知结果仍按原模式核对。原请求仅能恢复属于它的初始化目录；未知已有且没有合法 state 的目录、目录替换、已建立权威后丢失 state 均拒绝自动接管或重建。首次建目录后、所有权提交前中断的窗口同样保持拒绝，不自动删除目录。准确阶段、旧有效 state 的保留及升级边界见[部署手册](../../deploy/README.md#工作区示例初始化升级与恢复)。

`setup:local` 生成并保留已有 0600 的 `.env`、`.env.worker`、`.env.agent`，只为新 v4 生成数据库密码；不会复制秘密或导入 `~/.codex`、`~/.claude`、`~/.gemini`。PM Markdown、附件、可信目录配置、Agent SQLite 和应用管理的运行时 / 账号状态在本仓 `.local/` 下；原生 CLI Home 不再强制迁入其中。Worker 只取得自身角色配置；Agent 继承启动环境并叠加 `.env.agent`，原生子进程仍排除 PM / 数据库等应用私有变量。首次存储绑定不能因目录存在而省略；已有数据不能执行上面的 `--new`。


`services:start` 启动 PM API、Worker、Agent API 与托管统一 Web 产物的公共网关；`services:status` 报告进程与 HTTP 可达性，**不把 HTTP 就绪当 Provider/CLI 执行通过**。`services:stop` 只向记录中的 PID、启动时间、工作目录和允许入口均匹配的本仓进程发送 SIGTERM，不删除数据库、不按端口杀进程。日志为 `.local/logs/`。

宿主 inotify 限额不足时使用 `CHOKIDAR_USEPOLLING=true pnpm services:start` 或 `CHOKIDAR_USEPOLLING=true pnpm dev:v4`；服务管理器不会给已运行进程更新环境。健康检查不能替代真实工作区目录读取。

```bash
pnpm dev:v4          # 统一 Web HMR；后端改动后重启
pnpm services:status
# Ctrl-C 只停止本次 dev:v4 启动的自身进程
pnpm services:stop   # 停止本仓管理器记录的自身进程，切换 built/dev 模式前执行
curl http://127.0.0.1:3224/health/live
curl -i http://127.0.0.1:3224/health/ready
curl http://127.0.0.1:3224/agent/api/access
```

PM Cookie 为 `pm_v4_session`，Agent Cookie 为 `agent_v4_access`；原 same-origin、认证、目录 allowedRoots 与 WS upgrade 检查保留。未配置模型时明确报错或禁用，不生成假回复。

### 本地项目目录与初始化

本批不新增云端同步、多实例或业务执行规则。`pnpm setup:local` 生成并保留已有 `.local/local-projects.json`，新配置默认只允许 `.local/projects`。需要选择其他代码目录时，本机管理员先把真实绝对父目录加入 `allowedRoots`；浏览器输入路径不能扩大授权范围。配置更改须在受控升级/重启时生效，不自动迁移文件。

进入 `/pm/<workspace>/settings?section=local-storage` 查看实际核心/备份路径并设置默认项目父目录。新建项目可在该父目录下新建文件夹，或使用已有目录；必须先预检最终路径。初始化稳定项目 ID、身份标记、项目 Markdown、工作流初始状态、空任务/文档目录、附件绑定和恢复记录；不改原 README/代码，不建样例任务、不初始化 Git。

新建项目使用参考 gr8r-studio 的专用表单：名称、Markdown 描述、图标、颜色、真实负责人及目标日期随首次创建保存；支持 Ctrl/Cmd+Enter，输入法组合期间不提交。保存位置与最终路径预检保留，初始化说明和高级属性可展开。团队需在创建后的项目设置中独立关联；模板目前仅开放空白项目，其余明确禁用，不自动生成样例任务。取消或刷新保留原创建草稿，未知结果仍按原请求核对。

名称与保存位置标为必填；描述、图标、颜色、负责人和目标日期标为可选。负责人从真实成员列表选择，目标日期旁的日历按钮调用浏览器／桌面原生日期选择器；保存模式支持切换新建子目录与已有目录。下拉菜单在创建对话框内打开，不会落到原生模态层之外而无法点击。填写日期与负责人后仍须完成路径预检，再创建项目。

| 数据 | 本地保存位置 |
| --- | --- |
| 新项目 Markdown 与附件字节 | 所选目录下 `.pm/core/`、`.pm/attachments/`；身份标记 `.pm/project.json` |
| 工作区配置、统一 ID、目录映射与恢复台账 | `CORE_WORKSPACE_ROOT/<workspaceId>/`，默认 `.local/pm-workspaces/<workspaceId>/` |
| 账号、权限、评论、审核、审计、命令收据、附件元数据 | PostgreSQL；物理数据库卷独立于项目目录 |
| 旧项目及历史附件 | 原核心根与原 Local/S3；仅显式迁移改变定位，切换项目不会改全局 `BLOB_ROOT` |
| 完整备份 | `LOCAL_BACKUP_ROOT`，默认应用数据基目录下 `backups/`；包含 SQL、共享台账、全部登记项目托管文件与引用附件 |

项目详情支持目录状态、复制路径、显式迁移、托管移动及找回已由用户移动的原目录。缺盘不会创建空替代目录；未知结果先核对原请求，显式恢复仍使用原键和冻结输入。项目文件夹不是完整备份。准确配置、停写维护和恢复命令见[部署手册](../../deploy/README.md)，实施与验收见[本地项目存储说明](../../deploy/README.md)。
