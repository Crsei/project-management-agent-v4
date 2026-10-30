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
- 非邮件 Worker、outbox 恢复和自动化同样使用独立环境白名单；数据库防护只允许本副本 loopback 55444，旧 55442 不再被误当作验收目标。自动化复用真实 suite schema，不复用业务数据。正常服务关闭若被迫强杀或异常退出会报告失败；显式崩溃场景单独标记，不能借清理吞掉错误。

```bash
# 只列出原后端测试清单，不连接数据库或取得运行锁。
node scripts/backend-tests.mjs backend --list
# 宿主 inotify 不足时使用已有 polling 方式。
CHOKIDAR_USEPOLLING=true pnpm test:backend
# 定位单个测试文件，仍使用相同门禁与失败判定。
node --env-file=.env scripts/backend-tests.mjs files -- tests/account-recovery.integration.test.ts
```

可显式配置 `--file-timeout-ms`、`--shutdown-grace-ms`、`--progress-interval-ms`。`--lock-file` 仅用于独立 runner 烟测；不要用不同锁路径绕开共享数据库上的互斥。源代码修复、专项证据和全量结果见[后端回归修复记录](../docs/implementation/backend-regression-repair-plan.zh.md)。
