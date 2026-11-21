# 仓库地图

本页按目录列出当前源码职责、入口、数据权威、测试与检查边界，用于判断一次改动应落在哪一层、需要跑什么、不能越过什么。运行角色与存储关系仍以[系统上下文](context.md)和[数据所有权](data-ownership.md)为准；本页不替代模块合同、领域规范或具体指南。

路径均为仓库相对路径。`vendor/` 下内容按上游快照和 provenance 校验对待，不是可自由重构的项目源码。表中“必跑检查”只列该目录直接影响的入口，完整聚合仍是 `pnpm check` 或 `pnpm check:ci`。

| 路径 | 角色 | 入口 | 数据/权威 | 测试 | 必跑检查 | 禁止 |
| --- | --- | --- | --- | --- | --- | --- |
| `apps/server` | 服务端进程与同源网关的集合目录；不含 Web 构建 | 各子目录入口；`apps/server/gateway` | 本身无状态；按子目录区分 | 由各子目录和根 `tests/` 覆盖 | `pnpm typecheck`、`pnpm test:backend` | 不在该层另立业务规则、第二套授权或第二个 Markdown 写者 |
| `apps/server/pm` | PM HTTP API：认证、账号/工作区/项目授权、应用命令与查询、文件、SSE、Agent 工具端点 | `src/main.ts`、`src/app.ts` | Markdown 核心唯一写者；PostgreSQL 保存身份、授权、附加事实、收据与事件；附件在 Local/私有 S3 | `apps/server/pm/tests/*.test.ts`、根 `tests/*.integration.test.ts` | `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm test:backend` | 不在路由中自行实现业务规则或直接写 Markdown/PostgreSQL；不把模型、Run、CI 或审核成功当作 WorkItem 完成 |
| `apps/server/worker` | 独立后台进程：outbox/事件游标、保留维护、通知、邮件、受限 Webhook 与可选 IM 出站 | `src/main.ts` | PostgreSQL outbox、游标、通知与投递状态；只读核心事实 | 根 `tests/worker-process.integration.test.ts`、`tests/outbox-recovery.integration.test.ts` | `pnpm lint`、`pnpm test:backend` | 不执行 Agent、不创建第二个核心 watcher、不代替业务审核或自动完成任务 |
| `apps/server/agent` | 统一 Agent API：Chat、Provider 与原生执行、版本化 Agent/Team、有界业务 Run、任务交付与自动化执行适配 | `src/index.ts` | Agent 私有 SQLite、与 PM 分离的 Chat/执行证据；原生 Provider 目录；PM 事实经 API/授权访问 | `apps/server/agent/src/**/*.test.ts`、相关根 `tests/*.integration.test.ts` | `pnpm typecheck:agent`、`pnpm test:agent`、`pnpm build:agent` | 不写 PM 核心 Markdown/数据库；不把模型回复、CLI 退出 0 或 Run 成功当任务完成；不越过 PM 授权或目录核验 |
| `apps/server/cc-switch-host` | cc-switch 4.0.25 headless host 的 TypeScript 行为移植；MCP/Skills 原生配置管理 | `src/main.ts` | 原生 MCP/Skills 配置文件、私有 host 数据库与 PM 授权事实 | `apps/server/cc-switch-host/tests/*.test.ts`（含 `host-protocol.test.ts`） | `pnpm --filter @agent-workspace/cc-switch-host test`、`pnpm typecheck:agent` | 不恢复 Rust host、不复制整棵上游源码、不接管 Provider 账号/订阅或绕过原生路径核验 |
| `apps/server/gateway` | 同源 HTTP/WebSocket/SSE 网关，把 `/api`、Agent 与 Web 路由转到对应进程 | `src/index.ts` | 只转发；不持久化业务状态 | `apps/server/gateway/tests/gateway.test.ts` | `pnpm lint:gateway`、`node --test apps/server/gateway/tests/gateway.test.ts` | 不放业务规则、存储写入或独立权限判断 |
| `apps/web` | 浏览器与 Electron 共用的唯一 Web 工程：PM 页面、Agent Chat、编辑器、桌面桥接 | `src/main.tsx`、`index.html` | 无权威数据；通过 PM/Agent API 读取和提交，禁止本地决定完成状态 | `apps/web/src/**/*.test.ts` | `pnpm check:web`、`node --test "apps/web/src/**/*.test.ts"` | 不直连数据库或服务端私有文件；不复制 `@pm/ui` 组件实现；不以本地状态冒充服务端授权或任务完成 |
| `apps/desktop` | Electron 外壳与本地服务组生命周期、安装/备份/发布脚本 | `src/main.mjs`、`package.json` 的 `start` | 本机服务组与安装状态；不拥有 PM 业务数据 | `apps/desktop/src/*.test.mjs`、`apps/desktop/scripts/test.mjs` | `pnpm --filter @agent-workspace/desktop test`、`pnpm build:desktop` | 不内嵌第二套 Web 构建、不管理 PM 数据库迁移、不把打包成功当原生安装或签名验收 |
| `apps/marketing` | 独立静态 Astro 营销站与下载入口 | `src/pages/index.astro` | 仅公开静态内容与已授权素材 | `pnpm --filter @agent-workspace/marketing typecheck` | `pnpm typecheck:marketing`、`pnpm build:marketing` | 不引用内部计划/历史验收，不发布未获授权的素材或宣称未启用的下载 |
| `packages/agent-client-runtime` | 浏览器/客户端可用的 Agent 客户端运行时与 Provider 公共入口，封装 t3code client-runtime | `src/index.ts`、`src/providers.ts` | 无服务端权威；仅客户端状态与协议调用 | `packages/agent-client-runtime/src/**/*.test.ts` | `pnpm --filter @agent-workspace/client-runtime test`、`pnpm typecheck:agent` | 不把 Node-only 依赖、凭据或服务端私有状态带入浏览器入口 |
| `packages/agent-contracts` | Agent 共享合同：Chat、扩展、自动化、PM 工具与评估 payload 类型 | `src/index.ts` 及各领域合同文件 | 合同类型与 schema；不拥有持久化 | 由 Agent/client 测试间接覆盖 | `pnpm typecheck:agent` | 不在此实现服务端逻辑，不修改固定的 t3code/OpenHands 上游版本 |
| `packages/application` | PM 应用层：命令、查询、授权检查、幂等、跨聚合协调与 outbox 发布 | `src/kernel.ts`、`src/registry.ts`、`src/ports.ts` | 业务规则与用例编排；SQL/Markdown 经 ports 与现有 infrastructure 适配边（由边界检查冻结） | `packages/application/tests/*.test.ts` | `pnpm test`、`pnpm typecheck` | 不导入 HTTP/前端；不新增 infrastructure 模块边；不在应用层之外复制完成规则或直接操作存储 |
| `packages/automation-resources` | PM 原生自动化目录与模板参数；供 Agent/Web 共用 | `catalog.ts`、`native-template-arguments.ts`、`pm-catalog.ts` | 只读派生数据；PM 目录是唯一模板来源 | 由 Agent 自动化与 Web model 测试覆盖 | `pnpm lint`、`pnpm typecheck` | 不引入外部模板目录或第二套执行定义 |
| `packages/contracts` | 现行 HTTP/OpenAPI 合同、运行时 schema 与生成客户端 | `src/client.ts`、`docs/contracts/openapi.yaml` | 正式 API 合同；以生成器输出为准 | `packages/contracts/tests/*.test.ts` | `pnpm contracts:check`、`pnpm test` | 不手改生成合同或客户端；变更需走生成器并复核调用方 |
| `packages/domain` | 纯领域类型、状态机、依赖图与审核完成规则 | `src/index.ts` 及领域模块 | 业务不变量与状态语义；不依赖基础设施 | `packages/domain/tests/*.test.ts` | `pnpm test`、`pnpm typecheck` | 不导入 HTTP、ORM、存储或 UI 框架；不把持久化便利置于不变量之上 |
| `packages/infrastructure` | PostgreSQL/Drizzle schema、SQL 迁移、认证加密与 Local/S3 BlobStore | `src/`、`migrations/` | 身份、授权、附加事实、收据、事件与附件字节的持久化实现 | `packages/infrastructure/tests/*.test.ts` | `pnpm test`、`pnpm test:db`、`pnpm build` | 不承载业务完成规则；不自动删除孤立对象或跳过校验和迁移账本 |
| `packages/pm-cli` | 本机 PM CLI 与插件/Agent 连接、交付、评估、自动化命令 | `index.ts` 及各命令模块 | 调用 PM HTTP API；不拥有独立业务权威 | `packages/pm-cli/tests/*.test.ts` | `pnpm test`、`pnpm typecheck` | 不绕过 API 直接写业务存储，不把本机文件当授权，不自动重放未知写请求 |
| `packages/pm-core` | Markdown 核心工作区：读取/写入、投影、迁移、目录与项目副本 | `index.ts`、`repository.ts`、`projection.ts` | Markdown 核心事实与可重建 SQLite 投影 | `packages/pm-core/tests/*.test.ts` | `pnpm test`、`pnpm typecheck` | 不创建第二个 watcher 或第二份权威，不把索引/投影当不可重建数据 |
| `packages/pm-markdown` | Markdown 解析、frontmatter、语法增强、引用解析与精确 patch | `index.ts`、`syntax.ts`、`mentions.ts` | 文本解析与补丁；不拥有授权或业务状态 | `packages/pm-markdown/tests/*.test.ts` | `pnpm test`、`pnpm typecheck` | 不做文件写入授权判断，不把解析结果当作任务完成 |
| `packages/pm-schema` | Markdown 协议 schema、查询语言、关系校验与图构建 | `index.ts`、`query.ts`、`relations.ts`、`graph.ts` | schema 与校验规则；无持久化 | 由 pm-core/pm-view 及其测试覆盖 | `pnpm typecheck`、`pnpm test` | 不加入持久化、HTTP 或 UI 依赖；不放宽既有 schema 校验 |
| `packages/pm-views` | 跨 Web 复用的展示组件：知识图谱、表格/看板视图与图布局 | `index.tsx`、`KnowledgeGraph.tsx` | 仅展示与交互；数据由调用方注入 | 由 `pnpm check:web` 与 Web 构建覆盖 | `pnpm --filter @pm/web typecheck`、`pnpm build:web` | 不放授权/写入逻辑，不自行获取或缓存权威数据 |
| `packages/skill-resources` | 九份随应用分发的 PM Skill 目录、哈希校验与 staging | `catalog.ts`、`stage.mjs` | 只读 Skill 源与授权/安装元数据 | `packages/skill-resources/catalog.test.mjs` | `pnpm test`、`pnpm check:licenses` | 不复制第二份 Skill 正文，不把“已安装”当作 Provider 已加载或业务成功 |
| `packages/ui` | 共享 UI 原语与主题层 `@pm/ui`；`apps/web` 只做门面转发 | `src/index.ts`、`src/{radix,base,lib}` | 仅展示组件与设计令牌 | 由 Web 类型检查与 Storybook/构建覆盖 | `pnpm --filter @pm/ui typecheck`、`pnpm check:web` | 不放业务逻辑、API 调用或权限判断 |
| `vendor/t3code` | t3code Provider/UI 精确选择快照与补丁账本；只读输入，不是运行依赖 | `scripts/sync.mjs`、`scripts/verify-sync.mjs`、`source-manifest.json` | 上游 `30eb7e7b…` 不可变字节；补丁见 `integration-patches/` | 来源门禁与供货清单校验 | `node scripts/check-sources.mjs`、`pnpm check:licenses`、`node vendor/t3code/scripts/imports.mjs --check` | 不运行上游安装/hooks/脚本，不手改快照或整树复制，不移动路径（provenance 按路径/字节校验） |
| `vendor/cc-switch` | cc-switch 选定 React Web UI 与 MIT 通知；host 行为已在 `apps/server/cc-switch-host` | `src/web/index.tsx`、`LICENSE`、`SYNC.md` | 上游 4.0.25 固定选择；host 翻译来源见 `apps/server/cc-switch-host/PROVENANCE.md` | `apps/server/cc-switch-host/tests/*.test.ts` 覆盖 host 行为 | `node scripts/check-sources.mjs`、`pnpm --filter @agent-workspace/cc-switch-host test` | 不恢复 Rust/Tauri 快照、不复制完整上游应用、不把 UI 快照扩张成第二套运行时 |
| `vendor/openhands-extensions` | OpenHands Agent Canvas / extensions 的 MCP/Skills 展示 fork 与精确补丁账本 | `scripts/sync.mjs`、`scripts/capture.mjs`、`source-manifest.json` | 上游 `b4a3f45a…` 选择输入、生成 locale、npm tarball 与适配输出 | `node --test vendor/openhands-extensions/scripts/provenance.test.mjs` | `node scripts/check-sources.mjs`、`pnpm check:licenses` | 不手改 originals/账本，不复制 CC 实现或绕过 `@pm/cc-switch-ui` 公共入口 |
| `benchmarks/dovspace` | Dovspace-Bench Lite 独立评测包：任务、隔离夹具、runner、评分与报告 | `cli.ts`、`benchmark.config.ts` | 私有评测输出与报告；被测进程不获得 PM/grader 权威 | `benchmarks/dovspace/**/*.test.ts` 由包内 `test` 入口选择 | `pnpm --dir benchmarks/dovspace typecheck`、`pnpm --dir benchmarks/dovspace test` | 不向被测进程暴露 grader/答案/PM 权限；不把 fixture 或协议校准当真实模型完成证据 |
| `plugins/dovspace-pm` | 第一方 PM Skill 与 Agent Plugins 生成源（9 份 Skill 的 3 份工作流源在此） | `plugin.json`、`skills/` | Skill 原始正文与插件元数据；安装为显式动作 | 经 `packages/skill-resources/catalog.test.mjs` 校验 | `pnpm test`、`pnpm check:licenses` | 不把它当运行时插件宿主或 MCP 服务；不在生成目录另存第二份 Skill |
| `scripts` | 仓库级开发、构建、迁移、检查、备份、发布与 CI 工具 | 各 `.mjs`/`.ts` 入口；`check-ci.mjs` 为总入口 | 无业务权威；私有状态只写 `.local`/临时目录 | `scripts/*.test.mjs` 及 CI 自检 | `pnpm lint:ci`、`pnpm test:agent` | 不在 import 时产生网络/文件副作用；不默认读取私有凭据或破坏并行工作树 |
| `tests` | 跨包真实 PostgreSQL/HTTP/Worker/SSE/恢复回归与无数据库合同测试 | 清单以 `node scripts/backend-tests.mjs backend --list` 为准 | 每轮独立随机 schema、临时文件与自有进程；不共享业务数据库 | `tests/*.test.ts` | `pnpm test:backend`、`pnpm test:integration` | 不共用数据库/锁文件 inode，不把 skip/todo/cancelled 当通过，不清理他人资源 |

## 如何选择入口

1. 先按“数据/权威”列确认改动是否触碰 Markdown 核心、PostgreSQL、Agent SQLite 或附件存储；跨存储操作必须按各自版本/收据核对，不假设原子事务。
2. 业务规则优先落在 `packages/domain` / `packages/application` / `packages/pm-core`；HTTP、Worker、Agent 和前端只调用同一应用边界。
3. 新增目录若属于 `apps/*`、`apps/server/*`、`packages/*` 或 `vendor/*`，必须同步加入本表；`scripts/check-docs.mjs` 会枚举当前目录并在缺少条目时失败。
4. 新共享 UI 组件放到 `packages/ui`；`apps/web/src/components/ui` 只是转发门面，例外与登记规则见该目录的说明。

其他顶层目录不单独承担运行角色：`deploy/` 是部署与 Compose 配置，`docs/` 是公开架构/领域/指南文档，`patches/` 是依赖补丁，根配置文件是工作区与检查入口。它们的约束见各自 README、`AGENTS.md` 与 `CONTRIBUTING.md`。
