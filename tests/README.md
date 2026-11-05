# 跨包验收测试

按 [场景规格](../docs/domain-design/scenarios.md) 与实施计划 INF 场景实现真实 PostgreSQL、文件存储、HTTP、Worker 与 SSE 集成测试。

| 文件 | 范围 |
| --- | --- |
| backend.integration.test.ts | 人工完整业务闭环、幂等/CAS、审核竞态、授权、文件字节、事件分页及 SSE |
| uuid-audit.test.ts | UUID 大小写、依赖环、唯一转化、最后管理员、历史引用和重开恢复 |
| worker-process.integration.test.ts | 两个真实 Worker 进程并发、停止后积压、新进程恢复、心跳与 readiness |
| outbox-recovery.integration.test.ts | 十次失败隔离、真实进程重启、受审计 CLI 恢复、日志失败回滚 |
| agent-file-areas.test.ts | v3 AgentScope / LocalDirectory / revision 严格合同；用户主目录默认值、安全默认目录预检与无写入读取 |
| agent-file-areas.integration.test.ts | v3 真实授权目录册、空组、原项目挂载、两级保存/重读、默认目录隔离与优先级、根设置 CAS/权限、缺盘/替换/软链接拒绝及 PM 原文件不变 |

`pnpm test:backend` 从私有 `.env` 加载 DATABASE_URL，并通过受监督入口串行运行全部后端单元/合同/集成测试。数据库套件使用独立随机 schema；文件和子进程由各测试创建并仅清理自有资源。未配置数据库、缺少 S3 输入等造成的 skip 不是通过证据，入口返回非零。

实际常驻服务验收另用 `pnpm smoke` / `pnpm smoke:verify`，备份另用 `pnpm backup:verify`。真实 Agent 和浏览器 UI 不在本轮后端测试范围。

v3 文件区域测试复用隔离的 `local-project-fixture.ts`，需要真实 `TEST_DATABASE_URL`（或测试环境显式注入的 `DATABASE_URL`），没有数据库时明确失败而非跳过。fixture 默认将 Chat Space 放在临时根下，可通过 `createLocalProjectFixture({ chatSpaceRoot })` 显式指定验收路径。迁移 `0036_agent_file_areas.sql`、`0037_agent_storage_defaults.sql` 保存目录映射、设备/inode 身份、来源与工作区默认根设置，不存项目或任务副本。`revision: 0` 表示尚未保存映射；原项目挂载来源为 `project_location`，显式配置为 `explicit`，默认分配为 `default`。首次默认 resolve 登记 revision 1；目录与根设置分别校验版本，冲突后保留输入并重新读取。

目录可见性沿用原 local-project 路径限制：不受限且具有 `access.manage` 才可读取真实路径，配置及首次默认初始化另需 `planning.edit`；没有新增权限。其他授权读者仍可见真实项目空组，但路径置空并明确 `path_not_visible`，resolve 返回 403。默认区域在首次授权 resolve 或显式新建配置时创建；目录册不创建，已登记目录缺失或身份改变拒绝，不替换丢失磁盘、不移动 PM 核心数据。文件区域只是执行位置，不是隔离沙箱。保存响应未知时先重读；文件系统创建不能由 SQL 回滚，失败提交可能留下已创建空目录，不自动删除用户目录。

## 回归运行与资源边界

- `test:backend`、`test:integration`、`test:db` 和 `local-project-smoke.ts --verify` 共用 `.local/backend-tests.lock` 的内核 `flock`，需要 Linux `/proc` 与 util-linux `flock`。第二轮立即退出 75，不停止已有 owner。锁文件长期保留；**不要删除或替换锁文件 inode**，进程退出后由内核释放锁。
- 原测试文件清单完整保留。每文件单独监督，默认期限 30 分钟（自动化套件原有 20 分钟期限），每 30 秒输出当前文件进度；没有短暂的全局期限。文件超时退出 124；SIGINT/SIGTERM 分别返回 130/143，并仅清理本轮自有测试进程组。清理宽限默认 10 秒。
- 保留原生 TAP 和实际用例汇总；失败、skip、cancelled、todo、缺失最终 summary、测试退出后的活跃子进程均不能被当作全量成功。不会使用强制成功退出掩盖句柄泄漏。
- 邮箱邀请与账号恢复套件通过 `createMailFixtureDatabase` 每 suite 真实迁移一次。每 case 独占该随机 schema；首 case 使用已验证为空的基线，后续在单个事务中按外键顺序 DELETE 并重置已用 sequence，避免 TRUNCATE 重建大量表/index 文件。保留迁移账本，重新创建账号、SMTP 接收器、HTTP 服务及文件根。校验 namespace、OID 和 current_schema，无 public 回退、无跨 schema CASCADE；外部外键或不支持的跨表环明确失败。未来迁移若加入非空种子基线，必须先更新 fixture，不会悄悄清空种子。
- 邮件 fixture 接受 `signal`；初始化中取消也等待迟到资源收口，重复 `close()` 返回同一清理 Promise。数据库取消按自有连接的 PID、完整 backend_start 和当前用户核验，并等待服务端确认终止，不只关闭本地 socket。suite 数据库初始化最多 60 秒，已迁移环境的 case 初始化最多 15 秒；普通 case 30 秒，真实 SMTP 挂起场景单独设定期限。清理失败仍尝试其余 disposer。
- 邮件 Worker 仅接收测试环境白名单，不继承云凭据、Node 注入参数或常驻项目配置。早退与启动错误立即中断状态等待；诊断按白名单脱敏并限量保留。SMTP 未知结果不重投、投递期间心跳独立性仍由真实进程验证。
- Dashboard/core 创建与本地目录 fixture 也在初始化前建立所有权，案例传入 `t.signal`；重启 API、外部 Workspace、子进程须登记在同一 owner 下，先关闭迟到资源再删目录/schema。慢磁盘下不再用短 suite 总期限取消尚在正常工作的后续案例：Dashboard 初始化 120 秒，core 创建/时间/通知案例各 180 秒；本地目录 schema 60 秒、服务启动 125 秒、总初始化 210 秒、案例各 240 秒。
- API 的 blob 与 core 恢复各自作为真实 ready phase；配置数据库时 Fastify 启动 phase 为 60 秒，无数据库保持 10 秒，HTTP 请求期限不变。关闭等待未完成的启动工作与导入循环，不能在后台初始化尚未收口时删目录。依赖失败仍由 readiness 表达，HTTP 开始监听不代表数据库/存储/Worker/Agent 已就绪。
- 非邮件 Worker、outbox 恢复和自动化同样使用独立环境白名单。原本机入口仍只允许本副本 loopback 55444；隔离 CI 的随机端口必须另外通过 Docker 全 ID、运行状态、本轮随机 owner label、owner PID/进程 birth、唯一回环映射，以及 URL 中数据库/用户/合成密码与实际容器配置的完整校验。CI URL 只允许最多一个 fixture 所需的 `options` 参数，拒绝可覆盖连接 authority 的 query、重复 options 和 fragment。不能用 `CI=true`、单独数据库名或旧 55442/55443 绕过。自动化复用真实 suite schema，不复用业务数据。正常服务关闭若被迫强杀或异常退出会报告失败；显式崩溃场景单独标记，不能借清理吞掉错误。

```bash
# 只列出原后端测试清单，不连接数据库或取得运行锁。
node scripts/backend-tests.mjs backend --list
# 宿主 inotify 不足时使用已有 polling 方式。
CHOKIDAR_USEPOLLING=true pnpm test:backend
# 定位单个测试文件，仍使用相同门禁与失败判定。
node --env-file=.env scripts/backend-tests.mjs files -- tests/account-recovery.integration.test.ts
```

可显式配置 `--file-timeout-ms`、`--shutdown-grace-ms`、`--progress-interval-ms`。`--lock-file` 仅用于独立 runner 烟测；不要用不同锁路径绕开共享数据库上的互斥。公开开发与检查入口见[开发指南](../docs/guides/development.md)；内部历史修复记录不随公开树分发。

## 自动 PR 检查与独立验收入口

```sh
pnpm install --frozen-lockfile
node scripts/check-ci.mjs
# 等价根入口：pnpm check:ci
```

要求 Linux `/proc`、可访问的本机 `/var/run/docker.sock`、`flock`、Bubblewrap、`prlimit`，以及仓库 `.node-version` / `rust-toolchain.toml` / `packageManager` 固定的工具链。真实 namespace 冒烟要求宿主允许 Bubblewrap 建立隔离命名空间；缺少隔离能力直接失败，不回退无隔离执行。预览将当前 Agent 的 Node 可执行文件只读绑定到隔离空间的 `/node`，不依赖或替换主机 `/usr/local/bin/node`，也不挂载 Node 所在的用户目录。

`TMPDIR` 必须位于任何 Git 工作树之外，且磁盘空间充足；自动化 Git 的专用 checkout 会检查所有祖先的 `.git`，即使临时目录本身没有 `.git` 也不能放宽此规则。若系统默认临时目录不满足条件，显式选择已核对的独立临时目录再运行入口。

入口不加载 `.env`，不读取旧 `.local/access.json`，也不连接现有 55444 或其他副本。它用摘要固定的 PostgreSQL 16 镜像及本轮从官方源码构建的 MinIO 镜像，新建仅映射回环随机端口的容器；数据库/桶/账号与密码均为本轮合成值，数据在临时容器存储内。S3 必须经过真实带认证的对象层就绪检查。每轮使用私有临时 HOME/XDG/Agent/Chat Space/Cargo 目录及子进程环境白名单，不继承 Provider、PM、GitHub 或云凭据。Rust 工具链目录只复用已安装编译器，不加载宿主 Cargo 配置/凭据。

备份/恢复使用本轮 PostgreSQL 容器内的 `pg_dump` / `pg_restore`，版本与固定服务镜像一致，不要求宿主另装客户端。只绑定本轮私有测试临时目录，以宿主测试进程的 UID/GID 执行客户端；固定容器 ID、容器内回环连接、合成密码环境变量和独立 HOME 避免读取开发者 Docker 配置或连接既有数据库。转储文件仍由真实备份/恢复测试读取、校验并恢复到新数据库。

备份验收在关闭恢复后的 API 和连接池后，使用专用连接销毁本轮随机数据库，清理语句上限为 60 秒。[PostgreSQL 16 的数据库删除会同步等待 checkpoint](https://github.com/postgres/postgres/blob/REL_16_15/src/backend/commands/dbcommands.c#L1783-L1786)，不应套用普通业务查询的 15 秒期限；应用查询期限不变，不强制终止其他连接、不忽略清理失败。

MinIO 测试镜像的[构建定义](../scripts/ci-minio.Dockerfile)固定[官方 release](https://github.com/minio/minio/releases/tag/RELEASE.2025-09-07T16-13-09Z)的提交 `07c3a429bfed433e49018cb0f78a52145d4bedeb`、归档 SHA-256 `8819e3e7817e46b7b3798f8f200ead208562e571563c2e040352378031abe9f2`，以及 Go 1.24.7 构建镜像的多架构摘要。首次执行 `backend` 需要联网拉取 Docker 镜像、官方源码及 `go.sum` 约束的 Go 依赖；Go 只在构建容器里运行，不要求宿主安装。Docker 构建上下文是新建空临时目录，不发送仓库、`.env` 或业务数据；测试镜像保留 MinIO 原 AGPL 许可证及对应完整源码归档，仅作本机临时夹具，不作为产品运行时发布或推送。

失败或中断后按随机名称、完整容器身份和 owner label 再核对，只移除本轮拥有的容器、MinIO 镜像标签及临时目录；不停止业务服务、按端口杀进程、挂载已有数据卷或清理他人的容器/镜像及共享构建缓存。Node 测试沿用受监督后端入口：失败、skip、todo、cancelled、缺失 summary 和活跃遗留进程均返回非零，不将跳过计入通过。

默认范围：

| 阶段 | 实际检查范围 |
| --- | --- |
| `static` | 公开文档、PM 合同漂移、导入边界、第三方声明/资产完整性、三家来源库存、PM/Gateway/Agent lint，以及 Web 全部自有 `src`、`.storybook`、Vite/ESLint 配置 lint；不格式化 vendor |
| `build` | 先生成 Agent contracts/client-runtime 声明，再检查 PM/Gateway 类型并构建 PM、完整 Agent 类型及产物、Web 类型及 Vite、营销站，最后复核来源库存 |
| `rust` | 当前 headless host 的锁定依赖、所有 targets，以及除明确外部 GitHub Skill 实测以外的单元/协议测试；启用其余 ignored 测试，外部用例不计入此离线行为范围 |
| `backend` | 完整原后端文件清单，含真实独立 PostgreSQL、SMTP/TLS/Worker/SSE、Markdown/Blob/MinIO、事务和恢复；不缩清单 |
| `agent` | 全部本仓 Agent、client runtime、Gateway、自有 Web model、doctor 和 CC Switch/OpenHands provenance Node 回归；含显式启用的真实 Linux sandbox 冒烟 |

默认 `all` 按上述顺序执行。为定位失败、避免重复已通过阶段，可显式执行：

```sh
node scripts/check-ci.mjs --stage static
node scripts/check-ci.mjs --stage build
node scripts/check-ci.mjs --stage rust
node scripts/check-ci.mjs --stage backend
node scripts/check-ci.mjs --stage agent
```

单独 `backend` / `agent` 阶段要求同一检出的 `build` 阶段已完成；缺少必要产物会明确失败，不临时跳过或伪报完整检查。分阶段结果只证明相应范围，不代表默认 `all` 已通过。

外部真实 Skill 下载不作为默认 push/PR 网络验收条件，需单列显式执行 `node scripts/check-ci.mjs --stage rust-network`，不把它的排除解释为通过。Windows/macOS 原生安装、签名/公证与真实 PostgreSQL 桌面管理另由手动 Desktop workflow 验证；真实 Provider 账号/模型、生产供应商和完整浏览器业务验收不在这里宣称通过。来源检查验证随仓发布的输出摘要、配方身份、宿主工具和资源闭包；需要外部固定 Git 对象库的全量上游重建，以及未选定的上游测试工程仍是独立范围。第三方完整性门禁也不等于尚未关闭的授权/资产/发布履约事项已获批准，正式发布另用 `pnpm check:release`。

`.github/workflows/ci.yml` 对每次 push / PR 执行默认入口；PR 只读 token、不持久 checkout 凭据、无签名环境或 Provider secrets。上述命令是可执行检查入口，不是本次修改已运行/已通过的证据。会话与持久化仍暂沿用 Agent Chat，统一设计尚未收口。
