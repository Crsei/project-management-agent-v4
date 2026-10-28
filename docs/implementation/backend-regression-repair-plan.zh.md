# 后端回归耗时与稳定性修复计划

日期：2026-10-28。范围：修复 PM 后端测试生命周期、重复初始化、全量回归调度与邮件 Worker 诊断；独立处理已发现的工作流歧义。Agent 设置专项验收与 PM 全量回归继续分开记录，不降低业务保护或通过跳过宣称成功。

## 已有证据

- 一次账号恢复 fixture 初始化 26.15 秒、邮箱绑定额外 0.75 秒、关闭额外 0.37 秒。
- 独立新 schema 的 37 个迁移耗时 25.38 秒；已迁移 schema 重查 0.17 秒。
- 账号恢复套件 16 个用例反复初始化，但整个 suite 仅 120 秒期限。
- 已用真实 TCP 监听器复现：suite 超时后才注册的 `t.after` 不执行，异步初始化不自动取消，监听器残留。
- 观察到两轮全量回归重叠；串行参数只约束各自进程。迁移使用同一数据库级 advisory lock。
- 工作流歧义及 SMTP/Worker 失败是独立失败，不能仅以耗时解释或忽略。

## 分工与文件所有权

| 包 | 所有权 | 要求 |
| --- | --- | --- |
| R1 Fixture 生命周期与成本 | `tests/account-recovery-fixture.ts`、`tests/member-invitations-fixture.ts`、对应非 Worker 集成套件及必要新测试辅助模块 | 初始化前建立资源所有权；中途失败/取消仍清理；取消后不遗留迟到资源；同一套件只对自有隔离数据库结构迁移一次，逐用例数据隔离；合理逐用例/初始化/清理期限 |
| R2 全量回归入口 | `scripts` 中新的后端测试入口、`package.json` 的后端测试命令、入口回归测试 | 原测试清单完整保留；单实例门禁；明确失败/取消/超时与退出码；只管理自己创建的进程；不以强制成功退出隐藏句柄泄漏；无凭据日志 |
| R3 邮件 Worker | `tests/account-recovery-worker.integration.test.ts`、`tests/member-invitations-worker.integration.test.ts`、必要专属 Worker 测试辅助模块 | 子进程早退即时失败；有界脱敏诊断；准备阶段失败也关闭 fixture；SIGTERM/必要 SIGKILL 只针对自有子进程；真实 SMTP、心跳与未知结果语义不变 |
| R4 工作流歧义 | `apps/api/src/core-adapter.ts`、`apps/api/tests/core-adapter.test.ts`、`packages/pm-schema/index.ts`、`packages/pm-core/tests/protocol.test.ts` | 查清实际歧义与应有语义；保留用户配置多目的地拒绝；不改完成/权限规则、不删除有效断言换取通过 |
| 主集成 | 本计划、`tests/README.md`、根 README 必要说明、跨包集成与最终检查 | 合并接口、处理剩余调用点、统一运行检查与真实烟测、单轮全量回归、准确记录失败和未通过项 |

## 共享合同

- R1 保留 fixture 返回值现有字段；增加 `options.signal?: AbortSignal` 以便调用方使用当前测试 `t.signal`。`close()` 并发调用返回同一清理过程；所有已创建资源均能收口。必要的新共享数据库参数由 R1 明确告知 R3，R3 迁移自己所有的调用点。
- 共享数据库仅限本次创建的随机测试命名空间。禁止清空 public、正式数据、其他 schema，禁止修改正式迁移以加速测试。迁移专项测试仍真实执行迁移。
- R3 将测试上下文传入并使用 `createRecoveryFixture({ signal: t.signal })` / `createInvitationFixture({ signal: t.signal })`；不能删除 SMTP 断线、未知发送结果、心跳独立性验收。
- R2 不自动终止既有未知测试或服务；发现冲突应给出可定位且不含秘密的错误。Node 测试取消不代表异步资源已清理。入口的最终兜底必须报告失败，而非 `--test-force-exit` 掩盖泄漏。
- 各代理只编辑自己的路径，必要共享变更先消息协调。保留已有并行修改。中途不运行 build/lint/tests/formatter，由主集成统一执行。
- 请求模型为 `openai-codex/gpt-6.1-sol:xhigh`；实际调度是否接受在执行记录如实登记。

## 验收

1. 初始化中失败/取消、重复 close、关闭期间取消均无遗留 HTTP/SMTP/数据库/子进程资源；真实进程自然退出。
2. 逐用例数据互不污染；迁移专项仍覆盖真实迁移；记录修复后的 fixture 与 suite 耗时。
3. 同一回归入口的第二轮不能并发执行；正常失败、子进程早退和超时均非零退出；门禁正常释放。
4. Worker 早退可立即定位原因；SMTP 真实投递/断线与心跳行为仍验收。
5. 默认工作流生命周期符合当前合同，自定义歧义仍明确拒绝。
6. 运行受影响 lint、类型检查、测试、后端构建与真实烟测；最后执行一轮完整 `pnpm test:backend`，不把跳过/取消算通过。

## 执行记录

- 已通过会话级 `task.agentModelOverrides` 设置 `openai-codex/gpt-6.1-sol:xhigh`，启动 `FixtureRepair`、`BackendRunnerRepair`、`MailWorkerRepair`、`WorkflowRepair` 四个代理。工具不接受普通 task 的逐次 model 字段，故采用明确的会话级覆盖；用户选择仅本次使用，未保存长期设置。
- 用户明确允许结束旧回归后，核对工作目录、命令和启动身份，通过进程句柄只终止 PID 21122 的旧测试树（21122、21537、21538、58345）；没有向业务服务发送信号。
- 随后 `pnpm services:status` 显示原五个业务进程仍存活；PM readiness 为 503，Agent 与两 Web HTTP 为 200。此处仅记录现状，未重启或修复常驻服务，不把进程存活当依赖就绪。
- 初轮邮件专项 5 文件共 36 用例，仅 7 通过、29 失败，零跳过/取消；主要失败为新全表 TRUNCATE 重置超过 15 秒，另发现取消迁移后 PostgreSQL backend 尚未结束。此轮不计验收通过，已退回 R1 修正。
- 工作流/协议/集合、fixture 生命周期与 Worker 辅助检查合计 65/65 通过；入口专项在修正真实发现的问题后独立 12/12 通过，零失败/取消/跳过。入口 `.mjs` 严格类型检查通过。
- 入口真实信号烟测揭示全 `/proc` 异步扫描耗时 173–411ms，可能耗尽短清理宽限；改为同步读取内存文件系统后为 64–72ms，300ms 宽限下 SIGINT/SIGTERM 均由自有测试进程实际收到，分别退出 130/143。真实重叠启动返回 75，原回归不受影响。
- 真实 HTTP/PostgreSQL/Markdown 烟测通过：默认开始/完成/重开、自定义多目标无首选返回 409、显式 review 首选、已在 review 再开始保持状态和 revision；资源关闭后进程自然退出。
- 完整回归清单已通过实际 `pnpm … test:backend --list` 展开。并行 Agent 依赖修改与锁文件尚未同步，默认 pnpm 执行前自动安装因此失败；本次使用命令级 `--config.verify-deps-before-run=false` 运行现有依赖，不改 Agent manifests、锁文件或持久 pnpm 配置。
- 邮件专项分批复验：账号恢复 16/16、两个真实 Worker 套件合计 4/4、共享数据库 fixture 与邀请套件合计 16/16，通过且零跳过/取消。实际发现并修正 deferred FK 队列阻止恢复 DELETE guard 的问题；事务内保持 FK 启用并提前执行检查。数据库取消在仍持锁时结算，服务端 backend 消失，已执行删除完整回滚。
- 使用 pg-pool 的 awaitable `onConnect` 采集完整 backend 身份，避免 acquire 事件中查询与借方查询并发；真实数据库回归确认没有新增并发 query 弃用 warning。
- 邀请 fixture 改为 API 对空测试数据库正常就绪后再创建案例工作区，避免每例将既存工作区 Markdown 冷初始化放进 Fastify 的 10 秒 ready hook。真实后台导入和首次项目访问仍执行，不禁用核心或放宽任何期限；邀请套件的业务操作仍有实际文件提交成本。
- 最终真实烟测完成 HTTP 邀请、SMTP 投递、匿名接受和 membership 落库，以及账号恢复隔离、重复关闭、初始化取消后复用；进程自然退出。以下为同一轮实测，冷迁移只发生一次，后续耗时含重置和新 fixture 初始化，不是整个业务用例耗时：

| 阶段 | 耗时 |
| --- | ---: |
| 套件冷建 schema 与真实迁移 | 17.851 秒 |
| 首次账号恢复 fixture 初始化 | 1.368 秒 |
| 复用 schema 的账号恢复 fixture 初始化 | 1.177 秒 |
| 复用 schema 的邀请 fixture 初始化 | 1.445 秒 |

- 后端限定 lint、检查/构建 TypeScript、后端资产构建、入口 `.mjs` strict 检查均通过；OpenAPI/合同漂移检查通过（112 command payload types、90 paths）。最新文档检查通过（100 Markdown、27 计划步骤）。
- 第一轮完整 `pnpm --config.verify-deps-before-run=false test:backend` 已结束：117/117 文件执行，10 文件失败，退出 124，耗时 10929.03 秒。115 文件收到完整用例汇总：846 用例中 820 通过、25 失败、1 取消、0 跳过；另 2 文件缺失完整汇总，不能算通过。使用真实 MinIO、PostgreSQL 16 dump/restore 与 `PM_REQUIRE_S3_TESTS=true`，没有跳过 S3/备份。

## 第一轮全量暴露的同类问题与追加修复

| 分工 | 文件/边界 | 实际失败与修复要求 |
| --- | --- | --- |
| R5 核心测试生命周期 | `backend.integration`、`core-creation.integration`、`project-locations`，必要的 API 启动边界 | suite 总期限在正常耐久操作尚未完成时触发，已关闭 pool 又被后续案例使用；创建套件残留句柄拖到 30 分钟；另有 10 秒文件操作/ready hook 期限失配。改明确阶段与逐例所有权，保留真实重启恢复，不能靠跳过/强制成功退出。API 共享路径仅 R5 修改 |
| R6 本地目录 fixture | `local-project-fixture`、`local-project.integration`、`agent-file-areas.integration` 及其调用点 | 两例隔离服务启动失败且诊断被完全丢弃；本地目录 suite 超时后残留资源，又拖到 30 分钟。修复取消、迟到资源和有界安全诊断，保留备份/重启/权限及真实文件能力 |
| R7 其余 Worker 与副本环境 | `worker-process.integration`、`outbox-recovery.integration`、`automation.integration` | 非邮件 Worker 启动退出 1；自动化仍硬编码来源副本 55442，11 例全部拒绝当前 55443。使用已有环境白名单模式、保留独立真实进程；不连接旧副本，不移除端口防护 |
| 主集成 | 时间记录/通知路由的删除请求与统一验证 | 真实 DELETE 的 422 为 `DELETE_REFERENCED`，既存 SQL 业务记录/不可变历史要求保留源对象。修正旧测试：先断言拒绝删除，再显式模拟权威 Markdown 被外部移除，验证脱敏与计时器停止；未修改生产删除保护 |

本轮发现的两次 30 分钟等待均为其他套件超时后的资源残留，并非前述邮件修复失败。追加工作继续处理同一测试耗时/生命周期问题；原 Agent 设置专项验收仍单列。

## 第二轮修复与验证

- 继续使用本会话的 `openai-codex/gpt-6.1-sol:xhigh`，由 `CoreLifecycleFix`、`LocalLifecycleFix`、`WorkerEnvironmentFix` 分别实现 R5–R7；三个代理均已结束，主集成统一验证。
- Dashboard/core/local fixture 在异步初始化前登记所有权，传递测试取消信号并等待迟到资源；重复关闭返回同一 Promise。取消不会留下继续使用已关闭 pool 的后续案例。API 数据库启动的 blob/core 恢复各有 60 秒阶段边界，无数据库启动仍为 10 秒；未改变 HTTP 请求期限，也不把 listen 成功当业务就绪。
- 本地 API/Worker 子进程保留有界安全阶段/退出诊断，正常关闭必须收到正常退出；必要强杀仍使测试失败。真实 crash/recovery 场景单独显式允许崩溃。`local-project-smoke --verify` 已接入统一门禁，真实重叠调用返回 75，未停止已有回归。
- 非邮件 Worker 改为隔离环境白名单；自动化保留本副本 loopback/55443 边界并使用套件迁移、逐例重置，不再连接或要求来源副本。
- 新一轮限定 lint、TypeScript 检查/后端编译及资产构建通过。真实 HTTP/数据库/Markdown 烟测证明引用删除保护、外部源丢失脱敏与计时器停止；另一次冷启动/既存工作区重启烟测证明初始化取消、启动期间取消、同一关闭 Promise 和自然退出。
- 15 个针对性回归文件全部通过：92/92 用例，0 失败、0 取消、0 跳过，耗时 1890.04 秒；包含第一轮全部 10 个失败文件和真实 dump/restore 等受影响调用方。

| 曾残留到文件兜底的套件 | 第一轮结果 | 第二轮完整正常退出耗时 |
| --- | --- | ---: |
| `core-creation.integration.test.ts` | 触发 1800 秒文件期限，无完整汇总 | 182.693 秒 |
| `local-project.integration.test.ts` | 触发 1800 秒文件期限，无完整汇总 | 339.165 秒 |

- 真实独立 Worker 烟测通过：HTTP 创建会话并追加消息，原始两个 outbox event ID 均被发布；Worker 正常退出 0、记录 `worker_stopped`，未强杀；API 原端口停止监听且自有临时目录被清除。烟测进程自然退出，用时 29.19 秒。最初烟测误用不写 PM outbox 的原生 Markdown 工作项命令，已改用真实 PM 会话命令，未为烟测修改生产语义。
- 最新限定工程检查全部通过：lint、TypeScript 检查/后端编译、资产构建、OpenAPI 合同检查，以及 101 个 Markdown 文件/27 个计划步骤的文档检查。

第二轮完整 `pnpm --config.verify-deps-before-run=false test:backend` 已通过：118/118 文件全部正常结束并收到完整汇总，864/864 用例通过，0 失败、0 取消、0 跳过、0 todo，退出码 0。耗时 7624.43 秒（2 小时 7 分 4 秒），真实 MinIO、PostgreSQL dump/restore 与强制 S3 验收均已执行，没有文件期限兜底或缺失汇总。

全量仍包含真实迁移、耐久文件提交、独立进程、S3 和备份恢复，不能将本次修复解释为全量只需数分钟。第一轮失败且缺失两个文件汇总，与最终通过轮次不是等价性能基准；前述逐 fixture 测量单独记录。Agent 设置专项 145/145 是此前独立验收，本次 PM 全量结果不替代真实 Agent 的验收边界。
