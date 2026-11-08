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
PM_OPENHANDS_AUTHORING_SOURCE=/ABS/authenticated-public-openhands node scripts/check-ci.mjs
# 等价根入口：pnpm check:ci
```

要求 Linux `/proc`、可访问的本机 `/var/run/docker.sock`、`flock`、Bubblewrap、`prlimit`，以及仓库 `.node-version` / `packageManager` 固定的 Node 24.21.0 / pnpm 11.9.0 和原生编译工具；当前 TypeScript host 不要求 Rust/Cargo。真实 namespace 冒烟要求宿主允许 Bubblewrap 建立隔离命名空间；缺少隔离能力直接失败，不回退无隔离执行。预览将当前 Agent 的 Node 可执行文件只读绑定到隔离空间的 `/node`，不依赖或替换主机 `/usr/local/bin/node`，也不挂载 Node 所在的用户目录。

`TMPDIR` 必须位于任何 Git 工作树之外，且磁盘空间充足；自动化 Git 的专用 checkout 会检查所有祖先的 `.git`，即使临时目录本身没有 `.git` 也不能放宽此规则。若系统默认临时目录不满足条件，显式选择已核对的独立临时目录再运行入口。

入口不加载 `.env`，不读取旧 `.local/access.json`，也不连接现有 55444 或其他副本。它用摘要固定的 PostgreSQL 16 镜像及本轮从官方源码构建的 MinIO 镜像，新建仅映射回环随机端口的容器；数据库/桶/账号与密码均为本轮合成值，数据在临时容器存储内。S3 必须经过真实带认证的对象层就绪检查。每轮使用私有临时 HOME/XDG/Agent/Chat Space 目录及子进程环境白名单，不继承 Provider、PM、GitHub 或云凭据。隔离入口显式设置 `DOVSPACE_ISOLATED_CHECKS=1`，同时关闭 Web 手动 `loadEnv` 和 Web/Astro 的框架 dotenv 加载；普通开发/生产构建未设置该标记时仍沿用原配置。

完整 `agent` / 默认 `all` 须显式 `PM_OPENHANDS_AUTHORING_SOURCE` 指向仓库外 canonical PUBLIC checkout：[OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) 固定 `b4a3f45a28f6b6c387a8deb3dc7c18b4393c59c1`。入口仅放行这一路径，并在相同私有环境调用既有 verifier 认证 pinned HEAD、选中 Git tree/blob/worktree 字节/模式、随仓固定 npm tarball 与许可身份；实际 provenance authoring 用例仍完整执行。缺少来源会失败，不通过删用例、去 skip 或 fake upstream 造绿，不读取私有来源/凭据、不执行 upstream 安装/hooks/脚本。Actions 无凭据显式 fetch 此 PUBLIC pin；本机可用 Main 已认证 archive 解出的新 owned checkout。source 是该真实回归的前提，不是安装/生产常驻依赖；`static`/`build`/`host` 无此要求。

备份/恢复使用本轮 PostgreSQL 容器内的 `pg_dump` / `pg_restore`，版本与固定服务镜像一致，不要求宿主另装客户端。只绑定本轮私有测试临时目录，以宿主测试进程的 UID/GID 执行客户端；固定容器 ID、容器内回环连接、合成密码环境变量和独立 HOME 避免读取开发者 Docker 配置或连接既有数据库。转储文件仍由真实备份/恢复测试读取、校验并恢复到新数据库。

备份验收在关闭恢复后的 API 和连接池后，使用专用连接销毁本轮随机数据库，清理语句上限为 60 秒。[PostgreSQL 16 的数据库删除会同步等待 checkpoint](https://github.com/postgres/postgres/blob/REL_16_15/src/backend/commands/dbcommands.c#L1783-L1786)，不应套用普通业务查询的 15 秒期限；应用查询期限不变，不强制终止其他连接、不忽略清理失败。

MinIO 测试镜像的[构建定义](../scripts/ci-minio.Dockerfile)固定[官方 release](https://github.com/minio/minio/releases/tag/RELEASE.2025-09-07T16-13-09Z)的提交 `07c3a429bfed433e49018cb0f78a52145d4bedeb`、归档 SHA-256 `8819e3e7817e46b7b3798f8f200ead208562e571563c2e040352378031abe9f2`，以及 Go 1.24.7 构建镜像的多架构摘要。首次执行 `backend` 需要联网拉取 Docker 镜像、官方源码及 `go.sum` 约束的 Go 依赖；Go 只在构建容器里运行，不要求宿主安装。Docker 构建上下文是新建空临时目录，不发送仓库、`.env` 或业务数据；测试镜像保留 MinIO 原 AGPL 许可证及对应完整源码归档，仅作本机临时夹具，不作为产品运行时发布或推送。

失败或中断后按随机名称、完整容器身份和 owner label 再核对，只移除本轮拥有的容器、MinIO 镜像标签及临时目录；不停止业务服务、按端口杀进程、挂载已有数据卷或清理他人的容器/镜像及共享构建缓存。Node 测试沿用受监督后端入口：失败、skip、todo、cancelled、缺失 summary 和活跃遗留进程均返回非零，不将跳过计入通过。

默认范围：

| 阶段 | 实际检查范围 |
| --- | --- |
| `static` | 公开文档、PM 合同漂移、导入边界、第三方声明/资产完整性、三家来源库存均每轮新鲜执行；PM、Gateway、Agent/host/桌面/营销站、完整 Web、CI 工具、上游维护工具六个 lint 范围经共享 Turbo 调度，可本地缓存；不格式化 vendor |
| `build` | 原九叶顺序完整保留：contracts 声明 → client-runtime 声明 → client-runtime 完整类型（测试/provider）→ PM/Gateway 类型 → PM 生产 emit/资产 → Agent 生产/测试类型及 bundle/host/runtime/legal → Web CSS/完整类型/Vite → 营销站类型 → 静态构建；工程成功可缓存/恢复，最后新鲜来源复核 |
| `host` | 共享 `host-build` 只构建/恢复独立 TypeScript host 的完整 dist/legal/manifest；随后每轮新鲜运行 `apps/server/cc-switch-host/tests/host-protocol.test.ts` 与 `apps/server/agent/src/extensions/service.integration.test.ts` |
| `backend` | 完整原后端文件清单，含真实独立 PostgreSQL、SMTP/TLS/Worker/SSE、Markdown/Blob/MinIO、事务和恢复；不缩清单 |
| `agent` | 校验随包 TypeScript host 清单/哈希并设置其入口；全部本仓 Agent、client-runtime、Gateway、自有 Web model、根脚本和 OpenHands provenance Node 回归；含显式启用的真实 Linux sandbox 冒烟 |

默认 `all` 按上述顺序执行。为定位失败、避免重复已通过阶段，可显式执行：

```sh
node scripts/check-ci.mjs --stage static
node scripts/check-ci.mjs --stage build
node scripts/check-ci.mjs --stage host
node scripts/check-ci.mjs --stage backend
PM_OPENHANDS_AUTHORING_SOURCE=/ABS/authenticated-public-openhands node scripts/check-ci.mjs --stage agent
```

单独 `backend` / `agent` 阶段要求同一检出的 `build` 阶段已完成；缺少必要产物会明确失败，不临时跳过或伪报完整检查。分阶段结果只证明相应范围，不代表默认 `all` 已通过。

`pnpm check:turbo` / `node scripts/check-turbo.mjs` 是底层工程叶入口，默认 `lint`，stage 为 `lint|build|host-build`，不同于 CI 的 `static|build|host|backend|agent|all`。六 lint、九声明/完整类型/构建叶与独立 host 均按公共闭包缓存；**不包含** preflight、文档/合同/边界/许可/来源门禁、host 测试、真实夹具或完整回归。`--task` 按逻辑 ID 可重复，选择叶仍带明确前置；`--baseline` 同环境/闭包直接跑原命令不使用 task cache；`--dry` 不执行叶，互斥且不算通过。具体输出、命令与本轮一次性交付授权见[开发指南](../docs/guides/development.md#turbo-显式任务调度与本地-lint-缓存)和[完整任务表](../docs/reference/turbo-rollout-plan.zh.md)。

缓存身份支持普通 Git 与严格认证的 sibling-linked worktree（绝对 gitdir、精确 commondir/backlink、无 symlink 元数据），本轮必须真实启用后才能称 HIT。common Git exclude、输入模式与输出策略参与 hash，不读原 Git config/includes/hooks。危险 Git 身份下实际 lint 跑原 uncached 叶，dry 明确失败；产物任务不能证明输出所有权/无跟踪源码/路径安全则删除或恢复前 fail closed。无 Git 导出保持 cache-off 执行，不代表 HIT；目录存在或 dry hash 不变也不是命中证据。只处理互不重叠的声明产物根，不能触碰私有状态/live 输出。

runner 每次 pnpm 调用边界固定 `pnpm_config_verify_deps_before_run=error`，每次 cache read 前新鲜执行真实依赖预检，暖 HIT 不绕过缺失/陈旧状态；冻结安装另行执行。固定 pnpm 对后代下传 `false` 不否认调用边界保护。完整外层 no-implicit-install 用 direct Node 或显式 error 变量，普通外层 pnpm 在 Node 启动前仍遵循自身策略。[本轮证据表](../docs/reference/turbo-rollout-plan.zh.md#本阶段执行证据与未决事项)记录全 16 叶实测、恢复/失败反证与默认 all 的真实网络阻塞；旧单任务/六 lint/A/B 均为历史，不能拼接当前完整通过。

总入口 `check-ci.mjs` 只接受 `all|static|build|host|backend|agent`，不再接受历史 `rust` / `rust-network` 参数。外部真实 Skill 下载仍为独立网络验收，本机范围通过不代表它已通过。Windows/macOS 原生安装、签名/公证与真实 PostgreSQL 桌面管理另由手动 Desktop workflow 验证；真实 Provider 账号/模型、生产供应商和完整浏览器业务验收不在这里宣称通过。来源检查验证随仓发布的输出摘要、配方身份、宿主工具和资源闭包；需要外部固定 Git 对象库的全量上游重建，以及未选定的上游测试工程仍是独立范围。第三方完整性门禁也不等于尚未关闭的授权/资产/发布履约事项已获批准，正式发布另用 `pnpm check:release`。

`.github/workflows/ci.yml` 对原 push / PR / manual 范围仍执行默认入口；PR token 只读、不持久 checkout 凭据、无签名环境/Provider secret。新增 task/dependency 共享缓存只对默认分支 trusted push/manual restore/save，所有 PR（同仓/fork）与其他分支不读写共享缓存。task-cache 上传仅 `.local/check-turbo/actions-trusted`，按 OS/arch/hosted image/固定工具链和 policy 分区，native task hash 核验实际输入；上传前拒绝 symlink/未知文件/硬链接。未授权触发真实远端作业，本轮不宣称 hosted restore/save、全量成功或性能收益。会话与持久化仍暂沿用 Agent Chat，统一设计尚未收口。

全量 Node 文件选择以 `scripts/backend-tests.mjs` 和 `scripts/check-ci.mjs` 为准，不改用 Web 包中较窄的 `test` 脚本：

- backend：`apps/server/pm/tests/*.test.ts`、`packages/{application,contracts,domain,infrastructure,pm-core,pm-markdown,pm-cli}/tests/*.test.ts` 和 `tests/*.test.ts`。
- agent：`apps/server/gateway.test.ts`、`packages/agent-client-runtime/src/**/*.test.ts`、`apps/server/agent/src/**/*.test.ts`、`apps/web/src/**/*.test.ts`、`scripts/*.test.mjs` 和 `vendor/openhands-extensions/scripts/provenance.test.mjs`，全部经原监督器串行运行。
- Actions 在默认 `all` 之前仍新鲜运行 `scripts/upstream-sync/*.test.mjs`、`scripts/upstream-publish.test.mjs`。对应维护工具 lint 由默认 static 的 `lint:upstream` 统一覆盖，workflow 不再重复执行；协议测试未转成缓存任务。受影响选择器或 lint 缓存不能省略这些额外工作流测试。

## CI 计时与长任务诊断

`check-ci.mjs` 将每次执行的命令、阶段、总运行及清理结果追加到 `.local/ci-runs/<UUID>.jsonl`；文件权限为 `0600`，拒绝目录符号链接。记录包含范围、UTC 时间、单调时钟耗时、状态、退出码/信号，不保存命令参数、环境、捕获输出或错误对象。每 120 秒输出当前命令的输出静默时间、输出字节数及经进程出生身份核对的自有进程 CPU/I/O 活动；子进程心跳可能增加输出计数，因此这些指标不是测试推进或无死锁的证明。

失败、中断、清理失败及写计时文件失败仍返回非零；硬杀后只有 start 而无 end 的记录必须视为未完成。不会仅因静默自动杀进程；原有后端每文件期限继续生效。命令时间包含输出收齐与自有子进程清理；阶段/fixture 记录可能嵌套，不能相加当作总时长。run 时间不包含工作流的依赖安装、缓存恢复和计时器初始化/关闭。

GitHub 仓库检查 workflow 仍用 `always()` 保存安全 JSONL，14 天，不上传原始业务日志或 HOME。task-cache 只上传 `.local/check-turbo/actions-trusted`，不上传 `.local` 父目录、`.turbo` summary/日志、fixture、凭据或业务数据；native archive 自带隔离工程 task log（本轮 16 个），不冒称无日志，也不任意追加原始日志。受信默认分支成功 job 才 save，所有 PR/其他分支无共享 cache 访问。pnpm 内容仓同样 trusted-only、精确锁定 OS/架构/镜像/工具链，恢复后仍冻结安装。桌面另有 SHA256 验证的下载归档，不缓存签名/运行数据；Windows/macOS 不使用此 Linux 监督器，真实耗时须读取实际 Actions job。

一次失败耗时不能作为完整测试耗时，本机结果不能代替 hosted 冷/暖对比。历史见 [2026-11-06 耗时记录](../docs/reference/ci-performance-2026-11-06.zh.md)；当前全 16 叶、真实消费者及 fresh CI 范围见[本轮证据](../docs/reference/turbo-rollout-plan.zh.md#本阶段执行证据与未决事项)。

### 可复现的前后对比协议

复用现有 JSONL 与 Node TAP，不引入第二套监控或测试运行器。先由主线程核对服务归属，再串行安排测量；实现期间不并发运行重检查。

1. **冻结源码而不是重置工作树。** 记录精确 HEAD、当前已暂存/未暂存的二进制 diff、明确审核的 untracked 公共源码及关键输入 SHA256；保留用户既有修改。不要把 HEAD 当作 dirty 工作树身份，也不要归档 `.env`、私有 `.local`、Home、数据库、`node_modules` 或构建产物。对运行中的安装，导出到工作树外的新独立目录，冻结安装依赖，在该目录测量；不能覆盖公共服务正在使用的 `apps/web/dist`。
2. **把正确性修复与性能改动分开。** 原始失败保留；修复已退役的 Cargo preflight 输入、隔离 dotenv 边界等前提后，另存“修复后参考基线”。失败前后耗时不是提速，不与成功样本混算。新目录中的 workspace 链接必须指向该目录，不复用原 checkout 的 `node_modules`。
3. **记录环境与缓存状态。** 每轮记录源码/配置/锁文件身份、Node/pnpm、OS/架构/CPU、运行目录、可用临时盘、网络与镜像前提、已有产物及明确的冷/暖状态。任务缓存首次空命名空间、同名暖缓存、已安装依赖和 OS 页缓存是不同概念。不要清理共享 pnpm store、Docker 构建缓存或其他操作者的数据来制造“冷”样本；独立源码目录也不等于托管 runner 冷启动。
4. **执行相同完整范围。** 在冻结目录中指定已核对且位于所有 Git 工作树之外的 `TMPDIR`，先运行下列阶段序列定位问题，再保留独立默认 `all` 的证据。backend/agent 必须用同一目录刚构建的产物；每次仍创建自有 PostgreSQL/MinIO、随机 schema 和私有目录，保留原 `flock` 与清理判定。不用现有业务数据库或手动缩清单获得样本。

   对完整同范围缓存对照，另在同一冻结源码/工具链/显式 PUBLIC source 下运行默认 `all` 三组，不把独立阶段相加，也不以工程叶 HIT 替代真实回归：

   ```sh
   PM_OPENHANDS_AUTHORING_SOURCE=/ABS/authenticated-public-openhands node scripts/check-ci.mjs --baseline
   PM_OPENHANDS_AUTHORING_SOURCE=/ABS/authenticated-public-openhands node scripts/check-ci.mjs --cache-name full-review
   PM_OPENHANDS_AUTHORING_SOURCE=/ABS/authenticated-public-openhands node scripts/check-ci.mjs --cache-name full-review
   ```

   ```sh
   node scripts/check-ci.mjs --stage static
   node scripts/check-ci.mjs --stage build
   node scripts/check-ci.mjs --stage host
   node scripts/check-ci.mjs --stage backend
   PM_OPENHANDS_AUTHORING_SOURCE=/ABS/authenticated-public-openhands node scripts/check-ci.mjs --stage agent
   PM_OPENHANDS_AUTHORING_SOURCE=/ABS/authenticated-public-openhands node scripts/check-ci.mjs
   ```

5. **按结果而不是只按秒数汇总。** 保留 runId、范围、UTC、最终退出码、run/cleanup end 状态及各命令耗时；失败、超时、中断、skip/cancelled/todo 或缺少 end 的运行单列。仅对源码、工具链、检查范围和缓存状态匹配的成功样本重复测量（建议每组至少 3 次），报告原始值、样本数与中位数。只完成独立阶段不能声称完整 CI；嵌套阶段、fixture 与 command 耗时不相加。
6. **先测再改回归夹具。** 现有 `backend-tests.mjs` 保留逐文件进度与原生 TAP duration，可在同一轮自有 fixture 下定位慢文件；公开材料只摘录安全的文件/用例标识、结果和耗时，不上传原始业务输出。要进一步分解 schema 迁移、服务启动、用例和清理，先形成可重复成功样本，再选择最小受监督测量，不因源码看似重复就共享 schema/服务或取消清理。

2026-11-06 的历史记录中 all/build/backend/agent 都未完成，backend 在 MinIO 构建失败前尚未启动用例；Rust-only 成功不再代表当前 TypeScript host。2026-11-08 的夹具源码评估确认邮件 suite 已复用真实迁移与受 guard 的逐 case reset，Dashboard/本地目录仍各自拥有 schema、HTTP/进程和文件根；现有记录不足以证明新的可安全优化热点，因此不推测重写，也不宣称回归提速。以后的测量需保留真实服务、迁移/授权、失败恢复与清理语义。

### 本轮全 16 工程叶与恢复验收

以下是 Main 在新 linked worktree、固定 Node/pnpm/Turbo 和冻结代码/配置下串行执行的当前结果；公开证据文档随后更新，不能把测量身份当作之后文档输入仍旧命中的证明。worker 未重跑检查。完整 runId、原始值与限制见[落地计划](../docs/reference/turbo-rollout-plan.zh.md#本阶段执行证据与未决事项)。

| 范围 | 本轮实际结果 | 边界 |
| --- | --- | --- |
| 16 工程叶匹配 n=3 | baseline 174.865/178.507/185.016 秒；MISS 181.785/182.319/183.261 秒；HIT 11.500/13.718/13.388 秒。中位 178.507/182.319/13.388 秒；MISS 各 0/16、HIT 各 16/16 | 暖降约 92.50%、空任务缓存 miss 增约 2.14%，不是 full CI/OS 冷启动/hosted 收益；首轮全 bypass 不计统计 |
| 全输出恢复 | 8 roots 全删后 2121 files/197 dirs、103,480,412 bytes 的 byte/mode 完全相同；8 个陈余文件均被 HIT 清除 | tracked CSS 不恢复/删除，依赖 node_modules 不缓存 |
| 完整 restored Agent | run `259e7860-4971-4bee-9afe-76e3fddbb07b`：166/166 文件、1434/1434 passed、0 fail/skip/cancel/todo；含真实 OH authoring 9/9；stage 867.034 秒、总 877.584 秒、cleanup 0.012 秒 | 使用 HIT 恢复的 Agent/声明，没有重新 build；是独立 Agent 阶段，不改写失败 all |
| 行为/类型反证 | 最终三文件 76/76、0 skip/cancel/todo、125.896 秒；真实 client `.test.ts` TS2322 两次同 hash MISS/exit 1，无失败 archive，移除后 3/3 HIT | 声明 build 可成功（MISS→HIT）而完整 types 真实失败，未用较窄声明替代 noEmit；原行为失败记录保留 |
| host/legal | 两个真实 npm legal index 各 22 包；删 bundled 嵌套 LICENSE 后 verifier 拒绝，16 HIT 恢复后通过 | 来源/许可门禁仍新鲜，不关闭四项发行许可 blocker |
| fresh CI 三阶段 | MISS static/build/host 72.999/180.013/39.857 秒、0/6+0/9+0/1；HIT 34.400/30.501/39.227 秒、6/6+9/9+1/1 | docs/contracts/boundaries/notice/sources/post-build sources、host 3 + integration 8 均真实执行，cleanup 全通过；各 n=1，不相加冒充 all |
| 失效/隐私/本机 transport | 公开指南/Astro/favicon/lock/Node/Gateway 实际 key 矩阵成立，私有 doc 不进 inputs；Gateway changed n=1 为 8 HIT/8 MISS、161.982 秒，全部探针恢复。16 archives/32 metadata/2147 产品与安全记录 canary 0 命中；48 cache 文件真实 tar restore 后 native 16/16 HIT、13.438 秒，再跑 host 3/3 与 upstream 120/120、75.270 秒 | 限定合成 marker/枚举工件，不是普遍秘密扫描；GNU tar/umask 022 本机传输不是 hosted run |
| 当前默认 `all --baseline` | static/build/host 通过；backend 在 MinIO Docker FROM 的镜像域名 DNS 失败，0 后端用例，Agent 未被该轮执行，cleanup 通过 | 完整 all/backend 不通过，不以独立 Agent/阶段/HIT 或更快失败替代；真实 hosted/Provider/平台/生产另验 |
| 实际表面与 live | 恢复 Web `/pm` 登录页、marketing 首页/下载导航实际渲染，0 pageerror，临时服务/browser 清理；3224 现有登录页及四个 HTTP 表面正常、原进程身份/built mode 对应 | 仅核对现有服务/部署前置，不部署或覆盖 parallel primary/live 产物；不声称原工作树全部字节未变 |

采纳本地完整工程缓存，保留真实数据库/fixture/回归/来源/许可与清理门禁。没有实际 hosted workflow、真实 Provider/平台/生产完成或正式发行授权结论，不设置新的阶段批准停点。下节全部是历史，不能混入本轮数字。

### 2026-11-08 验证范围与未通过项

以下是**阶段 1 全仓显式调度扩展之前**的独立源码导出历史执行结果，不是新 runner/六 lint/当前发布批准，也不能把多个独立阶段拼成完整 CI。新阶段的实际结果单列在[落地计划证据表](../docs/reference/turbo-rollout-plan.zh.md#本阶段执行证据与未决事项)：

| 范围 | 观察结果与边界 |
| --- | --- |
| 来源对齐后的默认 `all` | static、完整 build、host 均通过；build 167.648 秒，host 32.569 秒（3 项协议与 8 项扩展集成）。backend 在 MinIO 镜像准备失败，清理通过；293.468 秒只是到失败为止的总耗时，不是完整 CI 时间，agent 未被该轮执行 |
| backend / T4 | 固定 Go 镜像的已配置 Docker mirror DNS 失败；同一摘要直连官方 registry 的受控尝试又发生 TLS handshake timeout。未改 daemon、镜像 pin、共享缓存或连接业务数据库。后端用例尚未启动，因此 T4 是环境阻塞，既未通过，也没有可用于夹具提速的真实用例样本 |
| 独立完整 agent 阶段 | 原 166 文件清单全部运行，1,389 项：1,388 passed、0 failed、1 skipped；监督器按合同返回失败，清理通过。该 skip 是现有来源 authoring 用例缺少显式 `PM_OPENHANDS_AUTHORING_SOURCE`，不是被计入成功 |
| 单列来源用例补证 | 另在原监督器下显式提供已认证的固定公共源码 checkout，运行同一 provenance 文件，9/9 passed、无 skip/cancelled/todo。它补充了该用例证据，**不把原 agent 或 all 聚合失败改成通过** |
| 受影响入口与监督/隔离行为 | 20/20 受影响入口及原监督器行为通过；真实 Web/Astro loader 验证普通模式仍加载配置、专用隔离模式不读 dotenv；实际 docs-only 入口通过公开文档检查，但仅为部分反馈。Turbo 安全行为 11/11 通过，另有真实 33 命令缓存/失效/失败/隐私验收；可选且不存在的 `.npmrc` 变更探针未执行 |
| 历史 Web lint 缓存试点 | 当时最终无本任务并发的交错 9 样本全部退出 0，每组 n=3；baseline / MISS / HIT 入口端到端墙钟中位数为 29.443 / 32.579 / 6.769 秒，包含 pnpm 启动/策略检查/实际重新链接开销，不是纯 ESLint CPU。缓存日志重放不代表内层检查重执行，pnpm 供应链策略未改变。当时证据只支持单任务 opt-in，后续阶段 1 扩展是独立授权；这些值不是当前六 lint、完整 CI 或托管缓存提速证明，原始值与波动见[开发指南](../docs/guides/development.md#2026-11-08-试点测量与决策) |

T3 保留范围不同的现有检查，没有以“看似重复”为由删掉声明、完整类型、生产 emit 或源码/随包宿主入口覆盖。T4 没有修改真实 schema/服务/清理夹具。完整后端回归及完整 `all` 仍缺通过证据，不以文档、初始化健康检查、单文件补证或暖缓存命中替代。2026-11-06 历史报告保持原样，本轮未重写它的旧 Rust 或失败记录。
