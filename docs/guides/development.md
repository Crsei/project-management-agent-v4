# 开发、构建与验证边界

本页描述当前源码的使用方式和已知限制，不代表当前工作树已通过检查、真实供应商账号验收或生产部署。历史计划和本机验收原件保留在本地，不作为公开安装依赖。

验证：

```bash
pnpm check
pnpm test:backend
pnpm check:web
pnpm --filter @pm/web build-storybook
pnpm smoke
pnpm smoke:verify
# 备份要求先停止本项目 API/Worker 和外部核心写入者。
pnpm backup:verify --stopped
```

`check` 检查公开文档、精确导入边界、第三方许可/素材完整性（`--integrity`）、合同漂移、后端 lint、类型、无需数据库的测试并构建；不包含完整 Web/Agent/数据库回归，完整性检查也不是正式许可发布批准。`check:web` 运行前端 lint、全量 TypeScript 与 Vite 构建；`build:web` 不运行 lint，`preview:web` 在 3220 预览。`test:backend` 使用真实 PostgreSQL 和独立随机 schema，覆盖文件、HTTP、Worker、故障恢复和 SSE，仅清理自有资源。S3 验收需隔离真实 MinIO（`PM_S3_TEST_MINIO_BINARY`）或明确测试配置，并设置 `PM_REQUIRE_S3_TESTS=true` 防止静默跳过；测试临时盘必须有足够空间，不能降低存储保护阈值绕过 507。跳过的数据库/S3测试不算通过。

本地目录专项验收使用 `node --env-file=.env scripts/local-project-smoke.ts --verify`；`--browser` 启动独立临时 API/Worker/Web，SIGINT/SIGTERM 只清理自身进程、随机 schema 和临时根。备份验收需要实际 `pg_dump`/`pg_restore` 与 `CREATEDB`；可用 `PM_TEST_PG_DUMP`、`PM_TEST_PG_RESTORE` 指定受控客户端。它们不读取既有账号访问文件，也不操作业务项目。


Markdown 核心的行为测试位于 `packages/pm-core/tests/`（迁自 Lab，165 项）。宿主机 inotify 不足时以 `CHOKIDAR_USEPOLLING=true pnpm test` 运行。

```bash
# 连接已启动的 PM 服务；密码在终端隐藏输入，不使用 --password 参数。
pnpm run pm login --email you@example.com
# 认证优先 PM_SESSION_TOKEN，其次完整 PM_EMAIL/PM_PASSWORD，再使用当前 origin 保存的会话。
PM_WORKSPACE_ID=<workspace-uuid> pnpm run pm protocol
PM_WORKSPACE_ID=<workspace-uuid> pnpm run pm task list
PM_WORKSPACE_ID=<workspace-uuid> pnpm run pm file TASK-102
PM_WORKSPACE_ID=<workspace-uuid> pnpm run pm entity update TASK-102 --status done
PM_WORKSPACE_ID=<workspace-uuid> pnpm run pm migration list
pnpm run pm logout
```

CLI 默认连接 `http://127.0.0.1:4194`，可用 `PM_API_URL` 覆盖；远程要求 HTTPS，HTTP 仅允许回环。`pnpm run pm <args>` 直接传参（不要额外加 `--`）。`login` 仅保存有期限的会话，不保存密码，默认私有目录为 `${XDG_CONFIG_HOME:-$HOME/.config}/dovspace/pm-cli`，可用绝对路径 `PM_CLI_SESSION_DIR` 覆盖。会话按 origin 隔离，过期要求重新登录，`logout` 在服务端撤销确认后清除对应文件；已移除 `access.json` 和 `PM_ACCESS_FILE` 回退。更新默认先读取当前 revision；冲突返回非零退出码且不自动重试。

`smoke` 使用显式环境凭据或上述 CLI 会话（通过 `PUBLIC_ORIGIN` 选择同一 origin），从真实授权目录确定 `PM_WORKSPACE_ID`，不读取旧访问文件。它在实际服务创建人工交付/审核/关闭/归档验收数据并保存 `.local/evidence/service-smoke.json`；只应对隔离实例运行。`smoke:verify` 复读原对象、收据和成果摘要。`backup:verify --stopped` 使用实际 provider 备份 SQL、共享核心、全部已登记项目托管目录和引用 blob，在新数据库、新核心/项目目录和新 Local 存储根恢复并设置认证、通知与外发围栏，再通过真实 API 校验授权下载字节；不修改源库或归档。恢复旧凭据信任与生产切换必须另行批准，详见[部署手册](../../deploy/README.md)。

## 账号与维护

```bash
pnpm account:create --email colleague@example.test --name Colleague
pnpm outbox:failed --workspace WORKSPACE_UUID
pnpm outbox:retry --workspace WORKSPACE_UUID
```

账号 CLI 生成的密码存入 `.local/accounts/{userId}.json`，初始不授予工作区权限。管理员通过 `SetWorkspaceMember` 显式授予能力及 projectIds；`null` 表示整个工作区，UUID 数组表示限制在指定项目。Workspace 管理能力不隐含审核/完成权限。

Worker 事件发布达到 10 次失败后保留原事件并隔离该工作区。操作员先查询，修复原因，再显式重试；CLI 不改业务实体或收据，重试记录持久写入 `.local/logs/outbox-maintenance.ndjson`。SSE 默认保留 7 天；游标过期返回 410，需要重新读取快照。

详见 [运行手册](../../deploy/README.md) 与 [本轮实现说明](project-management.md)。

## 工程边界

| 路径 | 当前内容与职责 |
| --- | --- |
| `apps/server/pm` | HTTP、认证、下载、变更查询与 SSE |
| `apps/server/worker` | 持久事件发布、保留维护与心跳 |
| `apps/server/agent` | Agent API、持久会话、Provider 与 CLI 执行；目录由 PM resolve |
| `apps/server/gateway.ts` | 公共同源网关、API/WS 代理和统一静态托管 |
| `apps/web` | 统一 Vite SPA；`/pm`、`/agent`、隔离 `/lab/pm` 与 Storybook |
| `apps/desktop` / `apps/marketing` | 完整本地服务组的 Electron 宿主 / 静态营销站 |
| `packages/agent-contracts` / `agent-client-runtime` | Agent 协议与 same-origin 前缀 HTTP/WS 客户端 |
| `vendor/*` | 单 pnpm workspace 内的固定导入 UI/协议源包，不引用来源仓目录 |
| `packages/domain` | 状态、验收与图约束 |
| `packages/application` | 命令、查询、访问与事务协调 |
| `packages/contracts` | OpenAPI 生成、命令 payload 类型和客户端 |
| `packages/infrastructure` | PostgreSQL/Drizzle schema、SQL 迁移、身份与 BlobStore |
| `packages/pm-schema` / `pm-markdown` | Markdown 协议、字段/关系/DSL 校验、保留式编解码 |
| `packages/pm-core` | 权威文件仓库、投影、监听、幂等/墓碑、迁移与恢复 |
| `packages/pm-views` / `pm-cli` | 主/嵌入视图与 Markdown 核心 CLI |
| `apps/web/src/features/pm/markdown` | 独立 Markdown 能力模块：控制器/授权会话、共享详情、集合和设置；复用 PM 外壳，不再维护独立应用导航 |
| `tests` | 真实数据库、HTTP、Worker 和恢复验收 |
| `deploy` | 专用 PostgreSQL Compose 与运行手册 |

PM 后端编译到根 `dist`，Agent 服务编译到 `apps/server/agent/dist`；唯一 Web 产物为 `apps/web/dist`。`pnpm build:v4` 构建 PM、Agent 合同与运行时、Agent 服务及统一 Web。根 `check`、`check:web`、`typecheck:agent`、`test:agent`、`typecheck:marketing`、`build:desktop`、`build:marketing` 分别覆盖对应工程，不能相互代替。



当前 PM 限制仍包括单文件 8 MiB、单 API/本地 Markdown 核心、同工作区写入串行，实体 data/命令 result 仍较通用；尚无自动孤立文件 GC、通用 job 编排、公开注册、MFA/SSO 或业务 Session/Run/Runner。独立 Agent Chat 不改变这些业务边界。私有 S3、可信邮箱找回与受限 Webhook 的供应商/SMTP/接收器、生产恢复、公网 TLS、多实例/HA、容量和真实设备仍需独立输入及验收；Provider 未配置或未实测时不宣称真实模型通过。

## 工具链与隔离聚合入口

工具链固定为 Node 24.21.0、pnpm 11.9.0。MCP/Skills 管理宿主已从 Rust sidecar 切换为 `apps/server/cc-switch-host` 的 TypeScript 实现，不再需要 Rust/Cargo。安装依赖前运行 `node scripts/doctor.mjs`，它仅检查本机前提，不安装工具、不读取 `.env` 或连接业务服务。

- Linux：C/C++ 编译器、链接器、make、pkg-config（通常为 build-essential 与 pkg-config）。
- macOS：Xcode Command Line Tools（clang/clang++/ld/make）及 pkg-config。
- Windows：Visual Studio 2022 C++ x64/x86 Build Tools、Windows SDK，且 cl/link/rc 所在开发者环境已加载。

严格隔离总入口为 `pnpm check:ci`（等价 `node scripts/check-ci.mjs`）：Linux + Docker + Rust 与 Bubblewrap，默认 `all` 依次覆盖 static/build/rust/backend/agent。后端阶段自建临时 PostgreSQL/真实 MinIO，各阶段使用私有 HOME/目录，不加载本机 `.env`；失败或非豁免跳过返回非零。详见[测试说明](../../tests/README.md)。它不证明真实付费 Provider、原生桌面 GUI、正式签名或生产部署。不要在同一机器重叠运行检查，也不要对业务实例运行 smoke。

`pnpm check:docs` 检查公开 Markdown 的本地链接、锚点、代码围栏和领域 INV/SC 引用；不绑定内部27步计划，也不需要内部历史文件。

### 选定上游源码维护

t3code Provider 与 cc-switch MCP/Skills 沿用现有 vendor、宿主适配器及精确来源账本，不迁移目录、不引入第二套补丁栈。跨版本和同 pin 维护流程见[上游源码维护指南](upstream-source-maintenance.md)；工具默认不提交、不推送、不创建 PR，发现 workflow 初始仅手动触发。

维护工具专项检查为：

```sh
node --test scripts/upstream-sync/*.test.mjs scripts/upstream-publish.test.mjs
node_modules/.bin/oxlint --deny-warnings scripts/upstream-sync.mjs scripts/upstream-sync scripts/upstream-publish.mjs scripts/upstream-publish.test.mjs
```

这些检查覆盖临时 Git 仓库中的来源与发布协议，并实际调用 Linux namespace；远端 GitHub 使用 fixture，不代表真实 PR 权限或实际 Provider 验收。CI 将此专项放在原全仓检查之前；两者结果分开解释。维护流程的 `verify --scope full` 是受影响 profile 的隔离验证，不等于 `check-ci` 全仓通过。

### 分阶段运行与外部网络范围

```sh
node scripts/check-ci.mjs --stage static
node scripts/check-ci.mjs --stage build
node scripts/check-ci.mjs --stage rust
node scripts/check-ci.mjs --stage backend
node scripts/check-ci.mjs --stage agent
# 单列依赖外部 GitHub 的 Skill 冒烟：
node scripts/check-ci.mjs --stage rust-network
```

单个阶段通过只证明该阶段；不能替代默认 `all`。独立 backend/agent 阶段要求先在同一检出完成 build。默认 `all` 包含本机 Rust 范围，但显式排除上述外部 GitHub Skill 冒烟；需另行报告 `rust-network`，不能把离线范围成功等同外部网络验收。许可/素材 `--integrity` 仅核对文件与来源完整性，不关闭尚未取得的第三方权利或 AGPL 对应源码履约门禁。
