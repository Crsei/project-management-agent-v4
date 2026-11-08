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

严格隔离总入口为 `pnpm check:ci`（等价 `node scripts/check-ci.mjs`）：Linux + Docker 与 Bubblewrap，默认 `all` 依次覆盖 static/build/host/backend/agent。`host` 使用 TypeScript，不要求 Rust/Cargo。后端阶段自建临时 PostgreSQL/真实 MinIO，各阶段使用私有 HOME/目录，不加载本机 `.env`；失败或非豁免跳过返回非零。详见[测试说明](../../tests/README.md)。它不证明真实付费 Provider、原生桌面 GUI、正式签名或生产部署。不要在同一机器重叠运行检查，也不要对业务实例运行 smoke。

`pnpm check:docs` 检查公开 Markdown 的本地链接、锚点、代码围栏和领域 INV/SC 引用；不绑定内部27步计划，也不需要内部历史文件。

### 选定上游源码维护

t3code Provider 与 cc-switch MCP/Skills 沿用现有 vendor、宿主适配器及精确来源账本，不迁移目录、不引入第二套补丁栈。跨版本和同 pin 维护流程见[上游源码维护指南](upstream-source-maintenance.md)；工具默认不提交、不推送、不创建 PR，发现 workflow 初始仅手动触发。

维护工具专项检查为：

```sh
node --test scripts/upstream-sync/*.test.mjs scripts/upstream-publish.test.mjs
node_modules/.bin/oxlint --deny-warnings scripts/upstream-sync.mjs scripts/upstream-sync scripts/upstream-publish.mjs scripts/upstream-publish.test.mjs
```

这些协议测试覆盖临时 Git 仓库中的来源与发布协议，并实际调用 Linux namespace；远端 GitHub 使用 fixture，不代表真实 PR 权限或实际 Provider 验收。Actions 在原全仓检查之前继续新鲜执行协议测试；对应工具 lint 已由默认 `check-ci` static 的 `lint:upstream` 统一调度，不再在 workflow 重复执行。上面的直接命令仍可用于专项反馈。维护流程的 `verify --scope full` 是受影响 profile 的隔离验证，不等于 `check-ci` 全仓通过。

### 分阶段运行与外部网络范围

```sh
node scripts/check-ci.mjs --stage static
node scripts/check-ci.mjs --stage build
node scripts/check-ci.mjs --stage host
node scripts/check-ci.mjs --stage backend
PM_OPENHANDS_AUTHORING_SOURCE=/ABS/authenticated-public-openhands node scripts/check-ci.mjs --stage agent
```

单个阶段通过只证明该阶段，不能替代默认 `all`。独立 backend/agent 要先在同一检出完成 build。CI 仍只接受 `--stage all|static|build|host|backend|agent`，现在可叠加互斥 `--baseline` / `--cache-name NAME`，只控制工程叶，不改变 fresh 门禁/完整测试/fixture/清理；未知/重复/冲突参数失败。完整 agent/all 另须下述显式公开 source。旧 `rust` / `rust-network` 不可用；真实 GitHub Skill 网络和第三方授权/AGPL 履约仍单列，`--integrity` 不是发布批准。

### 构建依赖与不可合并的检查

完整生命周期与阶段屏障在 `scripts/check-ci.mjs`；显式叶任务、包限定 Turbo ID 与阶段列表在 `scripts/check-task-graph.mjs`，依赖及输入在 `turbo.json`，叶实现仍由原有各 `package.json` 和 tsconfig 定义：

1. Agent contracts `build` 生成整个 `src` 的 JS/声明；client-runtime `build` 从 `src/index.ts` 生成导出声明。下游 PM/Agent/Web 类型解析依赖这些 `dist/*.d.ts`，不能依赖开发机遗留产物。
2. client-runtime 完整 `typecheck` 另覆盖测试与 provider 导出；它不是声明构建的重复命令。PM/Gateway `typecheck` 含测试、Gateway 和集成夹具，PM `build` 则按生产配置 emit 并复制运行资产，两者保留。
3. Agent `build` 先检查生产与测试两套类型图，再打包服务及 TypeScript host；Web `build` 先构建 CC Switch CSS，再执行完整 TypeScript 与 Vite。营销站 `astro check` 和 `astro build` 分别负责类型检查与静态产物，不能互相代替。
4. `host` 阶段单独构建宿主并运行协议和 Agent 扩展集成；`agent` 阶段校验 Agent 随包 host 的清单/哈希并显式使用其入口运行全量 Node 回归。源码宿主和打包入口的行为覆盖不合并。
5. 独立 backend/agent 先检查 contracts/client 声明、PM 主入口及 Agent bundle；这些存在性检查只是前提，不能证明产物仍对应当前源码。源码变化后先重新执行 build。

默认 CI 的完整阶段不由开发者选择器或缓存替换。Turbo 承接六 lint、九 build/typecheck 叶与独立 host，均按完整公共输入/输出复用成功结果；声明/完整类型/PM emit/Agent/Web/marketing 不因看似重复而合并。文档、合同、边界、许可/来源、host 测试、完整 backend/agent、真实夹具与清理始终新鲜。完整任务表、恢复输出及本轮实际证据/外部阻塞见 [Turbo 落地计划](../reference/turbo-rollout-plan.zh.md)；文件/glob 与计时协议见[测试说明](../../tests/README.md)。

### 开发者受影响检查

`pnpm check:affected` 是本地反馈入口，**不是完整 CI / 合并或发布证据**，也不替代 Actions 默认 `all`。默认读取 Git 当前已暂存、未暂存及全部未跟踪路径，包含删除与 rename 两端；不会比较已提交分支与 base。已提交改动需显式列出所有受影响路径，或直接运行完整 CI。

```sh
pnpm check:affected --dry-run
pnpm check:affected --file apps/web/src/features/agent/src/app.tsx --dry-run
# 显式清单替代 Git 发现；删除路径也可列出，rename 须同时列旧、新路径。
pnpm check:affected --file docs/guides/development.md --file CONTRIBUTING.md
```

`--dry-run` 只输出路径、原因、阶段与固定命令，不执行检查；没有变化也不表示已验证。仅公开 Markdown 文档变化运行隔离的完整文档检查；Web `src/public/index.html` 运行 static → build → backend → agent（后端测试也导入 Web 模型），营销站 `src/public` 运行 static → build，两者混合按 Web 范围。共享包/合同、vendor、scripts、工作流、补丁、配置、锁文件、server/desktop 与未知路径都保守回退 static → build → host → backend → agent。文档中的源码/合同目录与内部历史不走 docs-only 捷径。

执行沿用原监督器、私有 HOME/环境白名单及隔离 dotenv 标记；命令串行，backend/agent 前同轮先 build，真实数据库、`flock`、所有权与清理不变。选中 agent 时，仅该嵌套 CI 子进程额外接收调用者显式 `PM_OPENHANDS_AUTHORING_SOURCE` 路径，仍由 `check-ci` canonical/authenticate；其他阶段不转发该路径，也不放宽其他 ambient 环境。该入口会写构建产物，live checkout 仍须改用新的独立 worktree，不能覆盖 live dist；见[测量协议](../../tests/README.md#可复现的前后对比协议)。

<a id="turbo-显式任务调度与本地-lint-缓存"></a>

### Turbo 显式任务调度与工程缓存

`pnpm check:turbo`（`node scripts/check-turbo.mjs`）复用既有 Linux 监督器和共享 registry，只选择明确原叶任务。默认 `lint` 是六个原范围；`build` 是原九项声明/完整类型/生产构建链，`host-build` 是独立 TypeScript host。三组均可在安全身份和完整公共输入/输出下本地缓存，默认并发 1，不并行真实 fixture。完整 agent/all 使用 `check-ci` 而非用工程叶代替。

```sh
# direct Node 避免外层 pnpm 在 Node 启动前按自身策略安装。
node scripts/check-turbo.mjs --stage lint --baseline
node scripts/check-turbo.mjs --stage build --dry --cache-name full-review
node scripts/check-turbo.mjs --stage build --cache-name full-review
# 同名重复才是暖 task-cache 样本；空新名字不等于系统冷启动。
node scripts/check-turbo.mjs --stage build --cache-name full-review
node scripts/check-turbo.mjs --stage host-build --cache-name full-review
# task 与 stage 二选一；选中叶仍包含明确前置闭包。
node scripts/check-turbo.mjs --task lint:pm --task lint:web --dry
node scripts/check-turbo.mjs --task build:web --dry
# pnpm 外层入口同样显式禁止隐式安装。
pnpm_config_verify_deps_before_run=error pnpm check:turbo --stage lint
# full CI 同范围 baseline / MISS / HIT；source 是只读公开 checkout。
PM_OPENHANDS_AUTHORING_SOURCE=/ABS/authenticated-public-openhands node scripts/check-ci.mjs --baseline
PM_OPENHANDS_AUTHORING_SOURCE=/ABS/authenticated-public-openhands node scripts/check-ci.mjs --cache-name full-review
PM_OPENHANDS_AUTHORING_SOURCE=/ABS/authenticated-public-openhands node scripts/check-ci.mjs --cache-name full-review
```

底层 CLI 接受 `--stage lint|build|host-build` 或重复 `--task ID`，加互斥 `--dry` / `--baseline`；baseline 不读写 task cache，因此拒绝显式 `--cache-name`。缓存名为 1–64 位字母数字/下划线/连字符、首位字母数字；未知/重复/冲突选择失败，不回退 broad task。`--dry` 使用固定 native Turbo `2.11.10` 解析真实图，不执行叶、不代表检查通过；缺失/错版不自动下载。baseline 只要求固定 Node/pnpm 与 Turbo manifest pin，不要求 native Turbo。完整叶/依赖/输出见[任务表](../reference/turbo-rollout-plan.zh.md#纳入-turbo-的明确叶任务)。

依赖安装是单独前提。runner 在每次 pnpm 调用边界固定 `pnpm_config_verify_deps_before_run=error`，每次 dispatch/cache read 前都新鲜执行真实 pnpm 依赖预检；缺失/陈旧状态不能被 HIT 绕过，不隐式安装。固定 pnpm 对后代下传 `false` 是正常行为，边界保护不依赖 ESLint 内该变量仍为 `error`。**普通外层 `pnpm check:turbo` 在 Node 启动前仍遵循 pnpm 自身策略**，完整保护用 direct Node 或显式环境变量，不宣称 runner 能拦截尚未启动前的安装。

独立 CLI 建立私有 HOME/XDG/TMP、严格环境白名单及 `DOVSPACE_ISOLATED_CHECKS=1`，关闭 dotenv、遥测与外部 remote cache；嵌入 CI 复用 caller 环境/监督器/信号/清理 owner。输入保守包含源码/测试、跨包/vendor/public/assets/legal、配置/ignore/suppression、manifest/lock/workspace/patches、实际工具链及 registry/runner/supervisor，覆盖新增/删除/未跟踪输入。空输出完整类型成功也保留原检查范围；HIT 重放日志不是内层命令重新执行。

缓存范围是公共生成物：contracts/client 的 dist、根 PM dist、Agent dist（bundle/host/runtime/legal）、独立 host dist、Web dist 与 marketing dist/.astro。Web 跟踪的 CC CSS/generator/content/config 是公共输入，**不删除或恢复跟踪 CSS**；tsbuildinfo 属 scratch，不作为成功类型检查的替代。恢复前核验路径并只清理该任务独占输出，拒绝 symlink/私有状态，避免旧陈余文件掩盖缺失；不碰业务数据库、fixture、Home 或 live dist。精确输出仍以 registry/Turbo 配置为权威。

Agent 的恢复闭包是整个 dist：服务/chunks/maps、history/Cursor/document-text 等 worker、PM CLI/automation/workspace/desktop-maintenance 工具、build-inputs 及随包 `cc-switch/host/**`。随包/独立 host 都包含真实 bundle/map/可能的 `.LEGAL.txt`、五份原法律/来源材料、按实际 esbuild metafile 中 npm package root 收集的 `licenses/dependencies/**`/index；不遍历整个 node_modules。两种 builder 共用 collector，standalone manifest 原字段保留并增加 `files`；`verifyHost` 原 API 不变，递归核对 byte/mode 并拒绝未知/缺失/symlink。本轮两份真实 index 各 **22 npm packages**；删除 bundled 嵌套 LICENSE 后 verifier 真实拒绝，16 HIT 恢复后再次通过。SDK/native/Effect 等已安装 externals 不缓存，恢复的 dist 不是未经 package staging 的自包含发行包，notice 完整性不关闭四项发行许可 blocker。

Web dist 要完整恢复 CSS/JS/worker/font/public 与来源/许可输出，Vite 仅在隔离标记下清空 dist，普通部署仍保留旧 hashed chunks。营销站 build 独占 dist/.astro；`astro check` 可产生非权威 sync scratch，但其 `outputs: []` 不承诺恢复该 scratch，build 自行 sync 并保留严格 check→build 顺序。真实预览能证明静态产物可用，不证明 PM/Agent API、登录数据、Provider 或第三方发布授权通过。

这是隔离工程验收，不是部署配置下 `build:v4` 的替代；build/恢复会写 checkout，不能覆盖 live 产物。除普通 Git 外，linked 支持限定为真实 sibling checkout：绝对 `.git` 指向 sibling 的 `.git/worktrees/<安全名>`，核验精确 `../..` commondir 与 gitdir backlink，目录/元数据无 symlink。hash 包含 common `info/exclude`、选中输入模式和输出策略，不包含机器路径，也不读取原 Git config/includes/hooks。危险 Git 身份的实际 lint 可运行原 uncached 叶，dry 明确失败；产物任务无法证明所有权则 fail closed，不删除/恢复。只读公共 regular 源文件可有合法 pnpm `file:` 硬链，Git/control/write targets 仍拒绝 hardlink。无 Git 导出 cache-off 执行不是 HIT，nested Git/symlink/检查可见但被排除的输入也不被猜作安全。

安全 JSONL 为 `.local/ci-runs/`，默认 task cache 为 `.local/check-turbo/default/`，`--cache-name NAME` 选择同级隔离命名空间；summary 为 `.turbo/runs/`，任务日志在各 `.turbo/`，不与 task-cache 上传目录混合。保守输入指纹按选中任务集合计算，切换单叶/整阶段可能额外 MISS，不承诺最小失效。

#### 完整 Agent 的公开 authoring source

`check-ci --stage agent` / 默认 `all` 必须显式 `PM_OPENHANDS_AUTHORING_SOURCE`，指向仓库外 canonical 只读 PUBLIC checkout：[OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) 的完整 commit `b4a3f45a28f6b6c387a8deb3dc7c18b4393c59c1`，与随仓 source manifest 一致。入口只向私有测试环境加入这一路径，并在用例前调用既有 verifier 认证 pinned HEAD、Git tree/blob、选中 worktree 字节/模式、随仓 npm tarball 和许可身份；原真实 authoring 拒绝/无写入/精确批准用例不变。缺 source 明确失败，原 skip 不算通过；不删用例、不做 fake upstream、不复制开发者凭据/私有来源、不运行 upstream hooks/安装/脚本。

Actions 以干净临时 HOME、无 Git credentials 的显式 fetch 准备同一 PUBLIC pin；本机可用主线程已认证 archive 解出的新 owned public checkout。这个来源仅供真实 provenance authoring 回归，**不是安装/生产运行的常驻依赖**，也不把前提认证替代实际完整回归。`static`/`build`/`host` 本身不要求该 source。

#### Actions 持久化与真实 hosted 限制

Repository checks 只持久化 `.local/check-turbo/actions-trusted`，不上传 `.local` 父目录、`.turbo`、HOME、业务目录、fixture 或原始业务日志。native archive 自带隔离工程 task log（本轮 16 个），不是任意日志上传，也不应宣称 task cache 无日志；枚举扫描结果见本轮证据。上传 allowlist 拒绝未知文件、symlink、非普通文件/硬链接/非本用户文件。仅默认分支 trusted push/manual restore/save，save 要求前置检查全部成功；所有 PR/fork/其他分支不使用共享 task/dependency cache，只用本 job 本地缓存。没有 `pull_request_target`、外部 remote backend 或额外 secret。

restore 前逐层安全准备 `.local/check-turbo/actions-trusted` 的三个 0700 目录；existing 必须本用户所有、精确私有 mode、无 symlink，否则拒绝，不 chmod/chown 既有目录；PR 同样准备本地目录但无共享缓存。Main 用实际 workflow 脚本、GNU tar/umask 022 测得：未准备的 0755 拒绝，准备后 0700/guard/upload-check 成功，existing 0755/symlink 拒绝且不改。进一步真实传输 **48 cache 文件**，archive bytes 不变（文件 0666→0644 为正常 umask 收紧），随后 native **16/16 HIT、13.438 秒**。这是本机真实 transport/消费证据，**不是 hosted run**；`hosted-local-tar-restore-smoke.json` 保留该边界。

namespace `full-v1-trusted` 按 OS/arch、hosted image、固定 Node/pnpm/Turbo/native 工具链及锁定/runner/graph/workflow policy 隔离；只允许同一 policy 前缀恢复，提交用于 immutable 外层 key，native task hash 继续认证实际输入。pnpm store 是单独精确缓存，恢复后仍冻结安装。安全 JSONL 保留原 14 天工件；真实数据库/测试/来源/许可永不缓存。

本轮 Main 在相同冻结代码/配置和依赖/环境串行测得全 16 工程叶 n=3：baseline/MISS/HIT 中位 **178.507 / 182.319 / 13.388 秒**；MISS 每次 0/16、HIT 每次 16/16，暖降约 **92.50%**、冷 miss 增约 **2.14%**。Gateway 改注释后的实际 8 HIT/8 MISS 为 n=1、161.982 秒，不能当所有修改的稳定收益。最初因 89 个合法公开源硬链而全 bypass 的 pair 保留且排除统计；所有临时输入已恢复，原 16 hash 全恢复。完整原始值、失效/错误/隐私证据及测量身份见[本轮证据表](../reference/turbo-rollout-plan.zh.md#本阶段执行证据与未决事项)，文档更新之后不冒称旧 hash 仍为当前输入 HIT。

8 个输出 root 全删及植入 8 个陈余文件后，HIT 均恢复相同 **2121 files/197 dirs、103,480,412 bytes** 和模式；真实 Web `/pm` 登录页、marketing 首页/下载导航渲染且 0 pageerror。HIT 产物上未重建的完整 Agent **166/166 文件、1434/1434 用例通过，0 fail/skip/cancel/todo**，含原 OH authoring 9/9；最终行为 76/76、upstream 120/120。真实 client 完整 noEmit TS2322 同 hash 两次 MISS/exit 1 且无失败 archive，较窄声明依然成功，移除错误后 3/3 HIT，未削减完整类型检查。

static/build/host 通过各一轮 MISS/HIT，HIT 仍实际执行 docs/合同/边界/notice/sources/post-build sources、协议 3 + 扩展集成 8，cleanup 全成功；这是独立阶段，不是完整 `all`。**默认 all baseline 在 MinIO Docker FROM 镜像域名 DNS 失败，0 backend 用例、该轮 Agent 未执行，cleanup 成功。** 没有 hosted workflow 或真实 Provider/生产/原生平台通过保证，四项发行许可 blocker 不关闭；不能把工程暖缓存、独立 Agent 或阶段结果拼成 full-CI/hosted 成功。推荐保留已验本地全量缓存与保守 trusted-only Actions 配置。

#### 2026-11-08 试点测量与决策

以下为**阶段 1 扩展前的单 Web lint 历史记录**，不代表当前六 lint 或默认 CI 的实测。在 Linux、Node 24.21.0、pnpm 11.9.0、Turbo 2.11.10 下，当时由主线程交错执行 baseline → 新命名空间 MISS → 同名未变 HIT，共 3 轮、9 次，全部退出 0。三组使用相同 wrapper 和未变化的任务 hash；没有另行并发的本任务下载、安装、构建、测试或来源 authoring。保留已安装依赖、OS/共享缓存及正常业务服务，MISS 只表示空任务缓存，不是系统冷启动。

计时是入口的**端到端墙钟时间**，包含外层 pnpm 启动、依赖重新链接及供应链策略检查的实际开销，不是纯 ESLint CPU 时间。最后一轮 HIT 的实际外层 pnpm 仍重新链接 6 个复用包、下载 0 个包；HIT 重放的缓存任务日志也含内层 pnpm 准备/策略检查文字，**重放文字不表示这些内层操作重新执行**。本轮没有关闭或修改 pnpm 供应链策略；“无并发安装”不等于计时命令内部没有包管理器准备。

| Web lint 范围 | 三次墙钟耗时（秒） | 中位数（秒） |
| --- | --- | ---: |
| 原命令 baseline | 38.761 / 29.443 / 28.374 | 29.443 |
| 空命名空间 MISS | 32.579 / 31.377 / 55.801 | 32.579 |
| 相同输入 HIT | 6.769 / 6.289 / 7.334 | 6.769 |

同口径中位数中，HIT 比 baseline 减少 **77.0%**，MISS 增加 **10.7%**；MISS 的 55.801 秒样本也原样保留，说明波动明显。每组仅 n=3，结果只支持本机这一条 Web lint 的重复反馈，不代表托管 runner、修改后所有场景或完整 CI 的收益；更早有并发来源准备的探索样本不用于该结论。

独立的真实 Turbo 行为验收完成 33 条命令，覆盖源码新增/修改/删除的 miss/hit、两次真实 lint 失败均不复用、实际已存在配置/manifest/lock/workspace/补丁输入失效、Node pin 不符、真实 ESLint 子进程环境隔离及缺失 native 包拒绝；临时探针已恢复。不存在的可选 `.npmrc` 没有执行变更探针，不能写成已验证。

**当时决策：只保留显式 opt-in 的 `@pm/web#lint` 试点，不凭这些样本推广为全仓或 Actions CI 缓存。** 其后阶段 1 的六 lint 与本轮四阶段一次性交付均为新的独立授权，不能沿用这张旧单任务绿色表作为当前验收。声明/noEmit/emit/源码及随包宿主检查覆盖仍不合并；真实数据库、Provider、完整测试、来源/许可门禁永不缓存。历史后端 MinIO 前提失败没有用例热点证据，不推测夹具优化；旧 `all` 未通过与 authoring skip 仍保留在[历史验证范围](../../tests/README.md#2026-11-08-验证范围与未通过项)。
