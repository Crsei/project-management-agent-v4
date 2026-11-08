# Turbo 全仓工程任务落地计划与证据边界

## 授权、文档身份与目标

本轮用户已明确授权在**新的独立 linked worktree** 一次性交付原四阶段：全仓显式叶调度与 lint 缓存、声明/完整类型缓存、PM/Agent/TypeScript host/Web/营销站构建缓存，以及 GitHub Actions 对本地任务缓存的保守持久化。原“仅阶段 1、阶段 2–4 未授权”的限制属于下方历史记录，**不再是本轮执行范围**。实现由各所有者并行，最终冻结后由主线程串行审阅、来源 authoring 与验收；不设置逐阶段再次批准停点。

`draft:T*` / `draft:M*` 仍只是本工程文档的追踪编号，**不是 PM 业务任务或里程碑 ID**。本轮未查询、创建、派发或发布 PM 对象，未核对现有业务任务，也不声称已去重。未提供真实资源容量、工期或发布日期，不据此编造承诺。

目标是复用相同公共工程输入的成功结果，不是把缓存日志当作完整 CI 验收。`scripts/check-ci.mjs` 继续独占 preflight、私有环境、阶段屏障、真实夹具、串行回归、信号、清理与 JSONL。Turbo 只调度原有明确叶命令，不注册整体 `check` / `check:ci` / `check:affected` / `build:v4` / 桌面打包等 wrapper，不增加通用 `^build` 推断。

**会话与持久化仍暂沿用 Agent Chat，统一设计尚未收口；本轮不改变业务或运行数据设计。**

## 本轮基线与证据口径

| 项目 | 已确认事实 / 限制 | 来源 |
| --- | --- | --- |
| 宿主版本 | 新 linked worktree 的基准 HEAD 为 `c8acf1409f0c98d65d9f176393783fc4ae71c18c`；叠加上一轮精确公共源码选集与已审阅前提，不以 HEAD 冒充最终 dirty 内容身份 | S0、S10 |
| 与 live 的关系 | 原 checkout 和运行中的公共入口不作为写入/构建目标；新 worktree 有独立依赖与输出，不链接原 checkout 的 node_modules，不替换 live dist | S0、S4 |
| 已认证桌面前提 | 新 worktree 使用当前已提交桌面 staging 字节，其 SHA-256 为 `0d086da506d320d98827a258585635b8716c8ddc82023cf36e4335b7b08f5d03`；不是历史 B 导出替换，也不能替旧 dirty A 树关闭来源阻塞 | S0、S10 |
| 固定工具链 | Node `24.21.0`、pnpm `11.9.0`、Turbo `2.11.10`；本轮不升级 pin | S1、S10 |
| 依赖前提 | 主线程报告新 worktree 的 frozen/offline 安装完成：31 workspace、1,570 packages；这仅是安装前提，不是 build、测试或 full CI 通过 | S10 |
| 当前交付与结果 | 16 叶本地缓存、Actions trusted-only 配置已实现；本机 16 叶对照/恢复、完整独立 Agent、fresh static/build/host、隐私及 tar transport 有实测。默认 `all` 仍在 MinIO Docker FROM 的镜像域名 DNS 处失败，backend 0 用例、该轮 agent 未执行，hosted 未触发 | S5–S10 |

下方旧 A/B 导出、单 Web lint 与六 lint 数字均为**历史证据**，保留原失败和限定范围。公开材料只记录安全的 runId、源码身份、范围、状态和测量值，不公开私有 Home、日志、业务数据或上游临时绝对路径。

本节实测以 Main 冻结的公共源码快照（26 文件）身份 `7cdec149cefcf4a9fc4b0cc84b62a12e621085e6bf291c05adcadb289e8c2122` 为准。测量后只更新公开证据文档，代码保持冻结；公开文档本身属于合法缓存输入，因此不把测量时 hash 冒称为之后文档字节的 HIT。最终交付整体身份记录在本机内容清单，不在本页自引用。

## 范围与非目标

- 一个共享注册表、包限定 Turbo ID、原 package scripts 和显式串行 build 前置链；保留声明/完整 noEmit、PM 生产 emit/测试类型、源码 host/随包 host 的不同覆盖。
- 六 lint 与十个声明/类型/构建叶已全部启用缓存；本机真实 native dry 为精确 6/9/1、全部 `cache:true`，有效三次 MISS 均 0/16、HIT 均 16/16。只复用完整声明输入/输出，是否命中始终以实际 native summary 为准。
- `check-ci` 默认仍是 `all`：static → build → host → backend → agent。新增 `--baseline` 或 `--cache-name NAME` 只控制工程叶调度，不选择性省略任何门禁、测试、真实 fixture 或清理。
- 构建缓存只处理下表公共生成目录；恢复前拒绝符号链接/私有状态混入，清理只能针对本轮独占的声明输出，避免旧陈余文件掩盖恢复缺失。
- Actions 使用 GitHub 自带 cache 对**精确本地 task-cache 目录**持久化，不配置外部 Turbo remote backend，不索取服务账号或新凭据。
- 根 manifest、锁文件或 enrolled host 输入若确需改变，先由 Main 审阅最终字节，再运行既有受信 authoring；不手改 inventory/hash、不升级 source pin、不接受未审阅的并行修改。

不缓存或上传测试结果、数据库/MinIO fixture、私有 Home、`.env`、凭据、Agent/PM 业务状态、原生签名材料、原始业务日志。没有 commit、push、发布、真实远端 workflow 触发或 live 服务接管授权。桌面原生/真实 Provider/Skill 网络/生产部署与恢复维持独立验收。

## 全仓范围与执行所有者

### 纳入 Turbo 的明确叶任务

| 逻辑 ID | Turbo ID | 原叶命令 / 真实范围 | 本轮缓存与公共输出 |
| --- | --- | --- | --- |
| `lint:pm` | `//#lint` | PM/Worker、application/domain/infrastructure/contracts、automation-resources、pm-cli、scripts/tests 原 ESLint 范围 | 可缓存成功 lint；无产品输出 |
| `lint:gateway` | `//#lint:gateway` | gateway.ts 与 gateway.test.ts 原 ESLint 参数 | 可缓存成功 lint；无产品输出 |
| `lint:agent` | `//#lint:agent` | Agent、host、Web Agent、desktop、marketing、contracts/client-runtime 原 oxlint 范围 | 可缓存成功 lint；无产品输出 |
| `lint:web` | `@pm/web#lint` | 全部自有 src、Storybook、Vite/ESLint 配置，`--max-warnings=0` | 可缓存成功 lint；无产品输出 |
| `lint:ci` | `//#lint:ci` | 原 CI/process/source/affected 工具及测试、registry/runner 与行为测试 | 可缓存成功 lint；无产品输出 |
| `lint:upstream` | `//#lint:upstream` | 上游维护/发布工具及原协议测试源码的 oxlint | 可缓存成功 lint；不缓存协议测试执行 |
| `build:contracts` | `@agent-workspace/contracts#build` | contracts 全 src 的 JS/声明 | `packages/agent-contracts/dist/**` |
| `build:client` | `@agent-workspace/client-runtime#build` | client-runtime 导出声明构建 | `packages/agent-client-runtime/dist/**` |
| `build:client-types` | `@agent-workspace/client-runtime#typecheck` | 完整 noEmit，含测试/provider 导出 | 可缓存完整成功结果；无 emit 输出 |
| `build:pm-types` | `//#typecheck` | PM/Gateway/测试/集成夹具完整 noEmit | 可缓存完整成功结果；无 emit 输出 |
| `build:pm` | `//#build` | 生产 emit 与实际运行资产复制 | 根 `dist/**`，含 PM/Worker/Gateway 及所需资产 |
| `build:agent` | `@agent-workspace/server#build` | 生产/测试两套类型图、bundle、随包 host/runtime/legal | `apps/server/agent/dist/**`；不以外部 native 安装或私有 Provider 状态作为缓存 |
| `build:web` | `@pm/web#build` | CC Switch CSS → 完整 TypeScript → Vite，保留来源/许可插件 | `apps/web/dist/**`；跟踪的 CC CSS 是已声明公共输入，不删除/恢复；dist 闭包包含实际 public/runtime/legal |
| `build:marketing-types` | `@agent-workspace/marketing#typecheck` | 完整 `astro check` | 可缓存完整成功结果；`outputs: []`，不把 check 的 scratch 当恢复前提 |
| `build:marketing` | `@agent-workspace/marketing#build` | 原 `astro build` | `apps/marketing/dist/**` 与 `.astro/**` 生成状态，含 public 资产 |
| `host:build` | `@agent-workspace/cc-switch-host#build` | 原 host 阶段独立 TypeScript host build | `apps/server/cc-switch-host/dist/**`；不合并源码 host 与随包入口覆盖 |

`build` 仍按 contracts → client declarations → client 完整类型 → PM 完整类型 → PM emit → Agent → Web → marketing 类型 → marketing build 九项显式连接；`host-build` 仅选独立 host。lint 无互相依赖，默认并发 1。实际命令、输出与输入权威为 S1/S5；表格不是绕过实际配置的第二份 registry。

输入闭包保守覆盖实际源码/测试、跨包/vendor 依赖、assets/public/legal、tsconfig/Vite/Astro/ESLint 配置与 ignore/suppression、根 manifest/lock/workspace、补丁、Node/pnpm/Turbo/native ABI、registry/runner/supervisor。新增、删除、未跟踪文件与模式变化也属于失效边界。空 output 的完整类型成功可缓存，但不能删除其检查或用较窄声明构建替代。

产品恢复合同包括 Agent 全部 workers/tools/chunks/maps/build-inputs、随包和独立 host 五份原法律/来源材料、实际 esbuild metafile npm notice tree/index 与递归 manifest。standalone 原 manifest 字段保留、`files` additive；bundled `verifyHost` API 不变，递归拒绝未知/缺失/字节或模式漂移。Main 从两份真实 index 各读到 **22 个 npm package**，并实删 bundled 嵌套 LICENSE 得到拒绝，HIT 恢复后再次验真成功。node_modules/SDK/native externals 不缓存，固定已安装依赖仍是前提。Web 隔离清空 dist、普通部署保留旧 hashed assets；marketing check scratch 非权威，build 独占 `.astro`/dist 并自行 sync。完整 byte/mode 恢复和真实消费者结果见本轮证据表，不以这些材料关闭第三方发布授权。

### 始终新鲜执行 / Turbo 之外的所有者

| 所有者 / 入口 | 保留范围与顺序 | 不可替代关系 |
| --- | --- | --- |
| `check-ci` preflight | doctor、隔离工具/私有目录、本轮所需公开 source 身份 | 缺工具/source 明确失败；不自动安装，不回退无隔离 |
| dispatcher 每次调用前 | 真实 pnpm 依赖状态预检、固定 native/工具链与路径安全 | 即使 HIT 仍新鲜检查；陈旧依赖不隐式安装 |
| `check-ci` static | 公开文档、PM 合同漂移、导入边界、第三方 notice/素材完整性、来源库存 | 叶 HIT 不重放这些门禁的“通过” |
| `check-ci` build 收尾 | 九叶完成/恢复后再运行 `check-sources.mjs` | 恢复公共产物也不免除新鲜来源校验 |
| `check-ci` host | host build/恢复后真实 host-protocol 与 Agent 扩展集成测试 | 测试执行不缓存，源码 host 与随包 host 各自覆盖 |
| `backend-tests.mjs backend` | 全部原后端文件，真实本轮 PostgreSQL/MinIO/SMTP/HTTP/Worker/恢复、`flock` | 不缩清单、不复用业务数据库、不缓存 fixture 或通过结果 |
| `check-ci` agent | 原 gateway/client-runtime/Agent/Web model/scripts/OpenHands provenance 文件清单、真实 Linux sandbox | 随包 host 清单/哈希/入口校验新鲜；缺 authoring source 不算 skip 成功 |
| `check-ci` 生命周期 | 私有 HOME/XDG/TMP、环境白名单、阶段屏障、fixture/进程组/信号、JSONL 与清理 | 调度复用 caller owner；skip/todo/cancelled/缺 summary/清理失败均不成功 |
| Repository checks workflow | 冻结安装与原 upstream-sync/upstream-publish 协议测试 | pnpm store 缓存不是 task cache，协议测试每轮执行 |
| 其他独立入口 | 原 `check`/`check:web`、Storybook、release 门禁、原生 Desktop workflow、Provider/Skill/部署恢复 | 本轮不削减原范围，不以 Linux Turbo 或 hosted 配置冒充平台/账号通过 |

### Actions 信任、隐私与 hosted 限制

1. 仅默认分支的 `push` / `workflow_dispatch` 可以 restore/save `actions-trusted` 持久缓存，且 save 要求完整 job 前置检查成功。**所有 PR（包括同仓 PR/fork PR）及其他分支不读写共享 task/dependency cache**，只使用本 job 的临时本地缓存；没有 `pull_request_target` 特权路径。
2. Turbo 上传路径只为 `.local/check-turbo/actions-trusted`，不上传 `.local` 父目录、`.turbo`、HOME、fixture、业务目录或原始业务日志。native archive 内含隔离工程任务自己的日志，本轮实际为 16 个，不冒称 task cache 无日志；不单独上传任意原始日志。上传前拒绝目录 symlink、非规范 cache 文件名、非普通文件、硬链接或非本用户文件。安全 JSONL 仍按既有精确路径单独保留 14 天。
3. namespace `full-v1-trusted` 绑定 OS/arch、托管 image、固定 Node/pnpm/Turbo/native 工具链与 manifest/lock/workspace/patch/runner/graph/workflow policy。外层缓存以提交区分 immutable key，只允许同一 policy 前缀回退；每个 archive 仍由 native Turbo task hash 绑定实际源输入，不信任旧 stdout 代替来源门禁。
4. 无外部 SaaS cache、发布 token 或真实 Provider 凭据；checkout 不持久化 Git credentials。Actions 必须显式拉取下节固定 PUBLIC source，不能上传或借用开发者来源目录。
5. 本轮**没有触发实际 hosted workflow**。本机 linked-worktree HIT、静态 workflow 审阅或旧 Actions 记录都不能证明 hosted restore/save 成功、传输/存储成本或完整 `all` 提速。真实 hosted 冷/暖执行仍需另行可用授权与证据。

## 里程碑、任务表与门禁

“已实现”与“已实测”分开；网络/hosted/真实账号/平台缺口不由本地成功抵消。以下结论来自本轮 Main 实际记录，历史结果不并入。

| 里程碑 | 本轮成果 / 退出门禁 | 前置 | 本轮结论 |
| --- | --- | --- | --- |
| `draft:M1` | 16 叶共享调度、原生命周期/覆盖不变 | `draft:T1`–`draft:T7` | 已实现；精确 6/9/1、76/76 行为及 fresh CI 三阶段双轮已证实；完整 `all` 仍有外部网络阻塞 |
| `draft:M2` | 完整声明/类型闭包、恢复/失败边界 | `draft:M1`、`draft:T8`–`draft:T10` | 已实现；三轮全叶对照、声明恢复与 client 完整类型双失败反证已证实，未用较窄声明代替 noEmit |
| `draft:M3` | PM/Agent/host/Web/marketing 公共产物与消费者 | `draft:M2`、`draft:T11`–`draft:T14` | 已实现；8 roots 精确恢复、Web/marketing 渲染、完整 restored Agent 和 host 通过；真实 backend/生产/平台/Provider 不记通过 |
| `draft:M4` | Actions trusted-only 持久化、PR 隔离/隐私 | `draft:M3`、`draft:T15`–`draft:T17` | 配置已交付；本机真实 tar transport 后 16/16 HIT 已证实；未触发实际 hosted workflow，不能标 hosted 验收通过 |

| 候选编号 | 目标 / 成果 | 范围与非目标 | 可观察验收 | 前置依赖 | 来源 | 实现 / 实际验收 / 外部限制 |
| --- | --- | --- | --- | --- | --- | --- |
| `draft:T1` | registry 与 native 图 | 16 原叶、包限定 ID、原九 build 链，无 wrapper | 精确任务/命令/顺序/依赖 | 无 | S1、S5、S10 | 已实现；真实 native 精确 6/9/1 全部可缓存，原清单/串行闭包保留 |
| `draft:T2` | 安全 dispatcher / CLI | stage/task/dry/baseline/cache-name、私有环境、唯一 owner | 参数/native/pnpm/信号/失败/清理安全 | 与 `draft:T1` 共享接口 | S5、S6、S10 | 已实现；最终 76/76 行为、真实 linked MISS/HIT、路径/隐私/恢复证据支持本机范围；原失败保留 |
| `draft:T3` | 默认完整 CI 接入 | cache 选项不减 fresh gates/测试/fixture | 原默认 `all` 与原测试监督器 | `draft:T1`、`draft:T2` | S6、S7、S10 | 已实现；static/build/host 各 MISS/HIT 通过且 fresh gates 真实执行；默认 all 在 backend fixture 网络处失败，不能拼接独立阶段造绿 |
| `draft:T4` | 精确来源与 authoring | pinned PUBLIC Git/npm、已审批最终字节、原工具 | approval/hash/inventory 与 fresh sources | `draft:T3`、各源冻结 | S8、S10 | 已完成精确 Vite authoring，仅 host-input SHA/bytes 变化；fresh sources 和原 OH 真 authoring 9/9 已通过，pin/enrollment 不扩大 |
| `draft:T5` | 行为与安全边界 | registry/输入/输出、lifecycle、私有 marker | 失败不缓存、取消/清理/路径/工件安全 | `draft:T3` | S5、S6、S10 | 最终 76/76、只读输入合法硬链修复后 security findings[]、全部枚举 archive/metadata/产品/JSONL/summary marker 0 命中；不宣称普遍 secret 扫描 |
| `draft:T6` | 匹配性能与 live 归属 | 同 source/env 的 16 叶 baseline/MISS/HIT/changed-input | 原始值、n、中位数、恢复/消费者、失败分列 | `draft:T4`、`draft:T5` | S3、S4、S10 | n=3 中位 178.507/182.319/13.388 秒；Gateway changed n=1 为 8 HIT/8 MISS、161.982 秒；仅工程反馈收益，不是 full CI |
| `draft:T7` | 当前文档与单次交付 | 完整任务表、公开用法、证据与 changelog | 当前授权/限制准确、旧表历史、会话提醒 | 最终证据 depends_on `draft:T6` | S0、S2–S10 | 本轮实测/失败/外部限制已统一落公开文档，不设新阶段批准停点，不替文档/来源最终检查预报通过 |
| `draft:T8` | 声明/完整类型闭包 | contracts/client/PM/marketing；原测试/provider 图 | 声明与完整 noEmit 各保留 | `draft:M1` | S1、S5、S10 | 已实现；原图与全叶执行保留；真实 client `.test.ts` TS2322 仅被完整类型拒绝，声明叶成功，反证未缩窄 |
| `draft:T9` | 声明恢复/类型成功缓存 | 精确 output、无私有 state | 产物删除后恢复；真实错误两次 MISS | `draft:T8` | S5、S10 | 8 roots 全删与 8 个陈余文件均恢复相同清单；真实 TS2322 两次同 hash exit 1、无失败 archive，移除错误后 3/3 HIT |
| `draft:T10` | 类型缓存采纳证据 | 全工程对照、恢复/失效/失败/隐私 | 成功/冷 miss 成本分列 | `draft:T9` | S3、S10 | 已据实保留本地全量缓存；n=3 冷 MISS 中位增加约 2.14%，暖 HIT 降约 92.50%；不外推全部修改/平台 |
| `draft:T11` | marketing 闭包 | 原 Astro check/build、src/public/config | 静态恢复/渲染与失效 | `draft:M2` | S1、S5、S10 | 已实现；dist/.astro 精确恢复，首页/下载导航真实渲染、0 pageerror；Astro config/favicon 各使 6 key 变化 |
| `draft:T12` | PM emit/运行资产 | root dist、PM/Worker/Gateway/模板/SQL/迁移 | 公共产物恢复；真实 backend 另新建 fixture | `draft:M2` | S1、S5、S6、S10 | emit/资产恢复 byte/mode 一致；完整 backend 尚未进入测试，MinIO Docker FROM DNS 阻塞，不能标真实后端或生产通过 |
| `draft:T13` | Agent 与独立 host | 完整 bundle/workers/tools/host/runtime/legal | 真实清单/入口/协议/扩展/完整 Agent | `draft:M2`、`draft:T4` | S1、S5、S6、S8、S10 | restored Agent 166/166 文件、1434/1434 用例；host 3 + integration 8 新鲜通过；两 legal index 各 22 包、nested LICENSE 损坏拒绝/恢复通过；真实 Provider/原生平台独立 |
| `draft:T14` | Web 与整体恢复 | 原 CSS→完整类型→Vite/public/runtime/legal | 干净恢复、可浏览、新鲜来源/许可 | `draft:M2`、`draft:T4` | S1、S4、S5、S10 | 全 2121 文件/197 目录恢复一致；Web `/pm` 登录页真实渲染、0 pageerror；tracked CSS 不删除/恢复，HIT 后来源/许可照常执行 |
| `draft:T15` | Actions 信任/隐私 | GitHub local task cache，无外部 backend | trusted-only、PR/fork 隔离、精确上传 | `draft:M3` | S7、S8、S10 | 配置已实现，真实 prepare/upload-check/tar 及不安全目录拒绝通过；48 个 cache 文件传输后字节不变；实际 hosted 未执行 |
| `draft:T16` | linked / transport / hosted | 真实 Git 身份、OS/arch/toolchain，不触发远端 | 本机真 HIT；不将模拟当 hosted | `draft:T15` | S5、S7、S10 | genuine linked 三次 16/16 HIT，真实 tar transport 后再 16/16 HIT、13.438 秒；hosted cache 服务/成本未测，不宣称通过 |
| `draft:T17` | 最终采纳/撤回边界 | 本地全量保留、外部验收显式 | 不能拼接旧样本或绕过门禁 | `draft:T6`、`draft:T10`–`draft:T16` | S3、S7、S10 | 推荐保留已验本地完整缓存与保守 Actions 配置；backend 网络、hosted、真实账号/平台/生产及四项发布许可 blocker 均未关闭，不代表项目/发行完成 |

## 依赖、顺序与可并行组

统一 `A depends_on B` 表示 B 是 A 的验收前提；文档分组不是业务父子任务。Graph/Runner/ProductBuild/CI-docs 在明确共享接口后并行，shared registry、root/package/lock 和 provenance 由指定所有者/Main 串行集成。`draft:T11`–`draft:T14` 的源码调查与独占编辑可并行，整体恢复证据须等待完整声明链与所有来源输出冻结；不机械重启分阶段批准。所有 build/lint/tests/install/format 的正式验收由 Main 在最终冻结后统一串行，不让兄弟工作者并发运行半成品。

## 完整 CI 与 source 前提的可执行验收

以下命令是入口，**不是已运行/已通过声明**。构建/恢复只在新的自有 worktree，`TMPDIR` 位于任何 Git 工作树之外；不清共享 pnpm store、Docker cache、live 输出或其他所有者目录来制造“冷”样本。

```sh
# 真实 native dry：只证明图，不算叶执行或 HIT。
node scripts/check-turbo.mjs --stage lint --dry --cache-name full-review
node scripts/check-turbo.mjs --stage build --dry --cache-name full-review
node scripts/check-turbo.mjs --stage host-build --dry --cache-name full-review
# 同一 source/env/固定依赖，完整 all：baseline / 空 task cache / 同名暖 cache。
PM_OPENHANDS_AUTHORING_SOURCE=/ABS/authenticated-public-openhands node scripts/check-ci.mjs --baseline
PM_OPENHANDS_AUTHORING_SOURCE=/ABS/authenticated-public-openhands node scripts/check-ci.mjs --cache-name full-review
PM_OPENHANDS_AUTHORING_SOURCE=/ABS/authenticated-public-openhands node scripts/check-ci.mjs --cache-name full-review
# 分阶段定位不等于 full all；CI stage 与底层 Turbo stage 不同。
node scripts/check-ci.mjs --stage build --baseline
node scripts/check-ci.mjs --stage host --cache-name full-review
```

`check-ci` 接受原 `--stage all|static|build|host|backend|agent` 加互斥 `--baseline` / `--cache-name NAME`；默认仍 `all`，未知/重复/冲突参数失败。底层 Turbo 仍为 `--stage lint|build|host-build` 或可重复 `--task ID`；`--dry`/`--baseline` 互斥，baseline 拒绝显式 cache-name，缓存名只允许 1–64 位字母数字/下划线/连字符且首位字母数字。default cache 在 `.local/check-turbo/default/`，summary/log 不在该 task-cache 上传目录。

完整 agent/all 要求显式 `PM_OPENHANDS_AUTHORING_SOURCE` 指向**仓库外 canonical PUBLIC checkout**：[OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) 固定 commit `b4a3f45a28f6b6c387a8deb3dc7c18b4393c59c1`。入口只把这一路径加入私有测试环境白名单；在实际用例前，以既有 `originalsFrom` 在相同私有环境认证 pinned HEAD、Git tree/blob、选中 worktree 字节/模式、随仓固定 npm tarball 和许可身份。原真实 authoring 用例、拒绝/无写入/精确批准语义完全保留；缺来源明确失败，不能删用例、去 skip 或造假 fixture。来源只读，不运行 upstream 安装/脚本/hooks，不需要发布凭据。Actions 显式准备同一固定公开 commit；本机可以使用 Main 已认证的原公共 source archive 解出的新 owned checkout，不把私有来源目录作为隐含依赖。

runner 在每次 pnpm/cache 边界固定 `pnpm_config_verify_deps_before_run=error` 并新鲜预检，不隐式安装。完整外层保护用 direct Node 或 `pnpm_config_verify_deps_before_run=error pnpm check:turbo ...`；普通外层 pnpm 在 Node 启动前的策略不由尚未运行的 runner 控制。固定 pnpm 对后代下传字符串 `false` 不等于关闭调用边界保护。

缓存支持普通 Git 与严格认证的真实 sibling-linked worktree：绝对 gitdir 指针、common `.git/worktrees/<安全名>`、精确 `../..` commondir/backlink，拒绝 symlink 元数据；hash 使用 common exclude/输入模式/输出策略，不使用机器路径。本轮 genuine linked 必须实际启用再测量，不能禁缓存后宣称 HIT。危险 Git 身份下实际 lint 可跑原 uncached 叶、dry 明确失败；产物任务无法证明声明根互不重叠、不含跟踪源码且全路径安全则 fail closed，删除/恢复前拒绝。无 Git 导出 cache-off 执行不是 HIT。原 Git config/includes/hooks 不被读取，tracked source 核验使用独立认证 index 副本和固定合成配置；是否 HIT 只看本轮 native 实际结果。

验收要求包括：删除声明产物后的 HIT byte/mode、真实消费者与无陈余额外文件；source/config/lock/toolchain/assets 失效；真实错误重复不缓存；native/参数拒绝、信号/清理/合成私有 marker；HIT 后来源/许可/回归仍新鲜。下表按实际覆盖报告，不以历史测试替补未运行的真实 backend/hosted/平台。成功对照每组 n=3，Gateway changed 仅 n=1；空 task cache 不是 OS/依赖冷启动，更快失败不计收益。

## 本阶段执行证据与未决事项

本节仅属于**当前新 worktree 的一次性交付**，由 Main 串行实测回报整理。测量身份见上文；实现存在、授权和历史绿色结果不计本轮 passed。主线程统一运行检查，文档所有者没有重跑 build/test/lint。

| 验收项 | 本轮实际结论 | 证据 / 边界 |
| --- | --- | --- |
| 依赖、任务图、行为 | 本机该专项通过 | frozen/offline 31 workspace / 1,570 packages；native 精确 6/9/1、16 项 cache:true；最终三文件 **76/76 passed、0 skip/cancelled/todo，125.896 秒**（`behavior-final-76-passed.log`）。原 74 项中 72 pass/2 fail 与中间轮保留，不混入最终成功样本 |
| 首轮 bypass 与合法硬链修复 | 原轮不合格，排除性能统计 | 89 个 pnpm `file:` 的 `vendor/t3code/third-party` 公开常规源文件，合法硬链到本 NEW worktree node_modules，曾令全 16 bypass `unsupported-task-inputs`；最小修复仅放行只读公共 regular 输入的 nlink，Git/control/write targets 仍拒绝 hardlink，安全审阅 findings[]。不是 primary 依赖复用；不把 bypass 当 MISS/HIT |
| linked-worktree 缓存 | 真正启用并命中 | 有效三次 MISS 各 0/16、HIT 各 16/16；不是静默禁缓存。三组原值见性能表 |
| 公共产物恢复 | 精确 byte/mode 一致 | 全删 8 owned roots 后 HIT 恢复 **2121 files + 197 dirs、103,480,412 bytes**；各 root 植入共 8 个陈余文件后 HIT 清除，清单仍一致；tracked CSS 未作为恢复/删除对象 |
| 实际 host legal 闭包 | 真索引/损坏拒绝/恢复通过 | standalone/bundled `licenses/dependencies/index.json` 各 **22 npm packages**。实删 bundled 嵌套 LICENSE 后 `verifyHost` 拒绝；run `42daa784-e1a9-4ab4-a983-0351e16335fe` 全 16 HIT 恢复后 verifier exit 0，2121 files/197 dirs 与首 MISS byte/mode 相同 |
| 完整类型失败不缓存 | 真实 TS2322 双失败反证通过 | 临时 client `.test.ts` 错误：完整 noEmit 两次同 hash `4a2edd96e201fa0e` 均 MISS/exit 1、无失败 archive；较窄声明两次成功（MISS→HIT），证明不以声明代替完整类型。移除后 run `61132436-f95f-4c6d-9afe-3527e0bb4908` 为 3/3 HIT。未据此声称对每个产品都注入过真实编译错误 |
| 原 Agent authoring 前提与完整 restored Agent | 独立完整阶段通过，不改写 all | run `259e7860-4971-4bee-9afe-76e3fddbb07b`，实际使用 HIT 恢复的 Agent/声明、未重建；**166/166 files、1434/1434 passed，0 fail/skip/cancel/todo**，含原 OH authoring **9/9**；stage 867.034 秒、总 877.584 秒、cleanup 0.012 秒 |
| fresh CI 入口 | static/build/host 两轮独立通过 | MISS 的 0/6、0/9、0/1 与 HIT 的 6/6、9/9、1/1 均通过；HIT 仍实际运行 docs/contracts/boundaries/notice/sources/post-build sources、host 3 + integration 8，cleanup 全成功。精确 runId/耗时见下表与 `ci-stage-cache-and-fresh-gates.json` |
| native 输入失效 | 已证实实际枚举范围 | 私有 docs/implementation 新 marker：16 key 不变且 inputs 无该路径；公开指南内容 5 key 变；Astro config/marketing favicon 各 6 变；lock 注释/Node pin 空白各 16 变；Gateway 源码注释 8 变/8 不变。探针结束时，6 个公共输入恢复原字节、私有探针删除，原 16 hash 全恢复；不冒称每种源码增删/所有配置都做过真实探针 |
| changed-input 实际执行 | n=1，不能当稳定收益估计 | run `c133bfc8-46eb-4326-a8df-5e806192ee8b`，summary `3Loe116G0SRKRSU4Kdxws9Judoq`，Gateway 注释改动后 **8 HIT/8 MISS、161.982 秒**；与未变 HIT/n=3 分开 |
| archive / 合成隐私 | 枚举工件内 0 marker 命中 | 16 个真实 tar.zst 解码，共 **36,659,279 压缩 bytes、2137 归档文件（含 16 logs）**；全部 archive、32 metadata、2147 产品/安全 JSONL/native summary 文件合成 canary 0 命中。构建 worktree 的绝对路径仅在 3 个 task log 中检出，产品中未检出该路径；不宣称扫描任意真实 secret 或任意日志 |
| 本机实际 workflow transport | prepare/上传边界/native HIT 均通过；非 hosted | GNU tar/umask 022 真实恢复 48 cache 文件；3 parent 0700，guard/upload-check 通过；文件 0666→0644 是正常 umask 收紧，archive bytes 不变。未准备的 0755、existing 0755/symlink 均拒绝且不改；`hosted-local-tar-restore-smoke.json`。随后 run `6dd7ca18-2624-4507-8e9c-fa5de096a22e` / summary `3Lod5f5mbvhg6mLGU7GwEpjfbUA`，**16/16 HIT、13.438 秒**；再跑 host **3/3** 与 upstream **120/120、75.270 秒**，均 0 skip |
| 精确来源 authoring | 已完成且 fresh sources/真用例通过 | Main 批准 Vite SHA `ebc151eaac58eb679093836ce012df405682189fe8bf28327f4396caed076762`，原受信 capture exit 0；仅 OH host-input Vite SHA/5352→5367 bytes 变化，mode 0644、301 outputs、74 recipes、260 input artifacts/closure 不变，其他 2,585 vendor 公共文件 byte/mode 不变；不扩大 pin/enrollment，也不把 authoring 自身当功能通过 |
| 完整默认 `all` baseline | **失败，真实 backend 受外部网络阻塞** | static/build/host 通过；MinIO Docker FROM 镜像域名 DNS 失败，**0 backend 用例、该轮 Agent 未执行**，cleanup 成功。保持原镜像 pin/daemon/测试/fixture，无失败加速结论；不能拼接后来的独立 Agent 或 CI 三阶段称 all 成功 |
| Web / marketing / 3224 | 所列真实表面/归属核验通过，不是部署新产物 | 恢复后临时 Web `/pm` 登录页、marketing 首页/下载导航均实际渲染、0 pageerror，临时服务/browser 已停。3224 现有登录页 0 error；Worker/API/Agent/gateway 同 primary cwd/startTime、built mode，4 HTTP ready/access/pm/agentworkspace 200；仅部署前置/现有健康核验，无接管或替换 live 输出。primary 24 项对照中 23 字节不变，CHANGELOG 外部并行变化保留未覆盖，不声称整棵原树 unchanged |
| hosted / 真实账号 / 平台 / 发行 | **未关闭的独立边界** | 没有实际 hosted workflow；没有真实 Provider/生产/原生平台完成保证；既有四项发行许可 blocker 未关闭。推荐保留本地全量缓存与保守 trusted-only Actions 配置，不将本工程交付写成项目/正式发布完成 |

### 本轮 16 工程叶匹配性能

Main 在同一测量身份、固定依赖/环境下串行取得每组 n=3；首次空命名空间仅表示 task cache 空。范围是 lint + 声明/完整类型/PM/Agent/host/Web/marketing 工程叶，**不包含完整 fresh CI 门禁、真实 backend/Agent 回归或 hosted 传输耗时**。

| 范围 | 原始墙钟秒数 | n | 中位数（秒） | 实际缓存 |
| --- | --- | ---: | ---: | --- |
| baseline | 174.865 / 178.507 / 185.016 | 3 | 178.507 | 原命令，不读写 task cache |
| 空 namespace MISS | 181.785 / 182.319 / 183.261 | 3 | 182.319 | 每次 0/16 |
| 同名未变 HIT | 11.500 / 13.718 / 13.388 | 3 | 13.388 | 每次 16/16 |

相同口径中位数，暖 HIT 降约 **92.50%**，空任务缓存 MISS 增约 **2.14%**。这是本机重复工程反馈，不是默认 all/托管 CI/OS 冷启动/所有修改收益；Gateway changed 161.982 秒仅 n=1 单列。原不合格 bypass pair、行为失败及历史数字全部保留且不混算。

### 本轮 fresh CI 三阶段 MISS / HIT

每行仅本阶段 n=1，两轮均保留 fresh gates 和 cleanup，不相加冒充一次完整 `all`，不对小样本给稳定提速保证。

| 阶段 | MISS runId / 秒 / cached | HIT runId / 秒 / cached | 新鲜执行 |
| --- | --- | --- | --- |
| static | `cbfe04d3-cb59-4790-b964-fa0d2b8379b3` / 72.999 / 0/6 | `b7a61fba-1e66-4616-bcb2-c670115d74c5` / 34.400 / 6/6 | docs、合同、边界、notice、sources |
| build | `25c823bb-f289-48e9-8518-f574ad635d7c` / 180.013 / 0/9 | `e40ece03-6624-4b12-a61b-7bb712a41b27` / 30.501 / 9/9 | 完整原九叶执行/恢复后 post-build sources |
| host | `f1e2cd82-e7f5-434e-bc01-0a4f40ec1f75` / 39.857 / 0/1 | `ea289fcb-d561-4824-bead-df650155fd7f` / 39.227 / 1/1 | 协议 3 + 扩展集成 8，均非缓存 |

**采纳结论：保留已实测的本地全 16 叶缓存和保守 Actions 配置。** 默认完整 CI/backend 的网络前提、真实 hosted、Provider/平台/生产和四项发行许可仍是明确未关闭边界；不删除任何 gate，不新增阶段批准停点，不以缓存或独立阶段替代正式验收。


## 历史阶段 1 执行证据（不代表本次全量结果）

本节保留**上一轮**主线程实际执行回报；不是当前新 worktree 的验收。历史 **A** 是保留当时 dirty 公共源码的独立导出；历史 **B** 是只有桌面 staging 输入改用已认证旧字节的受控参考导出。B 不是当时当前工作树，更不能把 B 成功、独立阶段或 dry 图拼接成本轮默认 `all` 通过。

| 历史验收项 | 当时结论（非本轮） | 历史实际证据 / 缺口 |
| --- | --- | --- |
| 完整计划与授权 | 当时已交付、经主线程核对 | 当时四阶段、17 个 draft、4 个里程碑；未发布 PM 对象。当时阶段 2–4 未授权/未执行，**现已由本轮一次性交付授权取代** |
| 最终行为回归 | 已证实该专项范围 | runner、原 supervisor、affected 三文件最终 **54/54 passed、0 skip，54.380 秒**；记录 `final-behavior-regressions-fixed.log`。此前 53/54 的诊断输出流断言失败保留，修正为真实非 capture 错误可见与直接 observer 后重跑，不用 wrapper 掩盖 |
| 独立审阅 | 发现已关闭，非全仓通过批准 | lifecycle 审阅 P1 关闭、无新发现；input 审阅 P2 的 root/Web suppression 输入缺口已修正，均以真实删除 suppression 后失败反证 |
| 上游协议 | 已证实该专项范围 | **120/120 passed、0 skip，73.636 秒**；首次工具 lint 发现既有 `no-useless-spread`，仅窄修 filter snapshot、保留 append 语义，无来源绑定/pin 变更；不替代全仓回归 |
| native 任务图 | 已证实选择/依赖，不计为叶执行 | 精确六 lint 可缓存、九 build/typecheck 不缓存、一个独立 host 不缓存；单选 `build:web` 得到恰好七项前置闭包且全部 uncached |
| 六 lint 源码与全局输入 | 已证实实际 native hash 矩阵 | 六叶源码 add/modify/delete/readd 均覆盖；内容修改按叶选择性失效，新增/删除因元数据身份保守使六叶都失效。root/Web ESLint 配置、`.gitignore`、lock、Node pin 无害空白、patch、Git 本地 exclude 均使六 hash 变化；所有探针源码已恢复最终六个 key。不冒称所有变化都只失效单叶 |
| suppression / 失败不缓存 | 已证实真实执行 | root 与 Web cwd 分别 MISS exit 0 → HIT exit 0 → 只删除 suppression → 两次 MISS exit 1、0 cached；失败或缺失 suppression 不复用旧绿 |
| 最终 guard 隐私与取消清理 | 已证实所列行为/限定工件范围 | 实际 ESLint secret/home/CI/NODE_OPTIONS 断言均成立，modules inode/mtime 未变、无安装；policy 字符串 `false` 是固定 pnpm 的正常后代下传，不代替调用边界 `error` 反证。最终 native SIGINT、SIGTERM 均 exit 1、真实 ESLint 子 PID 消失、自有临时目录移除；限定合成 marker/任务归档扫描见下文 |
| cache 身份降级与拒绝边界 | 已证实所列 native 场景 | 无 Git 连续两次真实 Gateway 成功、0 cached、无 archive；被排除但 lint 可见的 malformed PM `.env.ts` 连续两次真实失败、0 cached、无 archive。同字节 symlink 仍真实执行且禁缓存；unreadable、nested 私有路径 malformed 输入明确失败；nested Git / linked Gitfile 仍真实检查且禁缓存。缺失 native、错 manifest pin 无下载拒绝，未知/冲突 CLI 拒绝 |
| current A 新鲜来源门禁 | **确认受阻，不满足当前全仓通过** | static runId `3544b017-05d8-458a-ab35-a71244e8a3e6`，失败 **17.261 秒**，cleanup 通过；在既有桌面 `stage-workspace.mjs` 来源不匹配处停止，未执行后续 lint，没有因缓存绕过 |
| B 最终 guard static | **仅参考 B 通过，非当前树/全量 CI** | runId `8a8472ca-6b88-49d4-b048-c0e0909bad97`，exit 0，**72.580 秒**；六 lint 全部真实 MISS、0 cached，新鲜门禁与 cleanup 通过 |
| B 最终 guard build | **仅参考 B 通过，非当前树/全量 CI** | runId `d9a92d4f-850c-48c1-a200-5a66082419a4`，exit 0，**176.000 秒**；9/9 真实执行、0 cached；post-build sources 通过（22.163 秒），cleanup 通过。不是匹配的前后基准，不与旧 B build 耗时比较提速 |
| B 最终 guard host | **仅参考 B 通过，非当前树/全量 CI** | runId `7327fd4c-823d-48f4-812e-ef2a19faa052`，exit 0，**37.371 秒**；host build 新鲜执行，3 项协议 + 8 项真实扩展集成通过、0 skip，cleanup 通过 |
| 最终 guard 下六 lint 性能 | 已证实该本机范围，不是全仓性能保证 | n=3 baseline / MISS / HIT 中位数 **36.395 / 35.934 / 4.763 秒**，HIT 每次 6/6；同 A 源码/已安装依赖/环境、外层 fixed-error、无重任务重叠，全部 exit 0 且无安装，原始值见下表 |
| 完整 backend / agent / 默认 `all` | **未取得本阶段通过证据** | 当前 A 的来源门禁受阻；旧 MinIO 网络与来源 authoring skip 的历史失败仍保留，不机械重跑旧错误、不拼接独立阶段改写聚合状态 |
| 公共 3224 / live dist | 实施前后归属与真实表面保持 | 同一项目 gateway/API/Agent/Worker PID/cwd 与 built mode 未变，PM readiness / Agent / public Web / Agent Web 均 200；实际浏览器 `/pm` 登录页 visual 检查、0 pageerror，无重启或 live build。Provider 未实测，不外推真实模型成功 |

### 历史隐式安装发现、修复与入口边界

输入探针后，真实 pnpm run 曾自动重装 A 的依赖并下载 **1,533 个包**，该次探针 **158.44 秒**；真实任务归档日志保留。pnpm 11.9 默认 `verifyDepsBeforeRun=install` 已确认，但安装重写了 workspace state，**原事件具体过期判定未重建**，不能声称由 lockfile mtime 或某个 patch 探针触发。这个安装边界原结果不合格；私有后代环境隔离仍是真实独立证据。

最终 guard 源码下，合成 marker（非真实凭据）在 A 本轮 `.local` / `.turbo` 中以不遵守 ignore 的 literal 扫描确认无匹配，覆盖该导出的 JSONL、native summary 与普通日志；实际解码唯一最终 privacy 任务归档的 217 字节 Gateway lint 日志，没有合成值，只有布尔断言和 policy。真实 ESLint 中 policy 为字符串 `false`，是固定 pnpm 对后代的正常下传；runner 调用边界 `error` 与缓存前新鲜度拒绝已有独立反证。记录 `final-native-lifecycle-proof.json`、`final-privacy-artifact-scan.json`、`final-decoded-privacy-cache.log`。这仅证明该合成探针与限定工件范围，不宣称扫描任意真实 secret 或全部历史业务工件。pre-guard 同范围扫描也未匹配，原解码记录 `pre-guard-decoded-privacy-cache.log` 保留，不替代终态证据。

修复在 runner 的 pnpm 调用边界固定 `pnpm_config_verify_deps_before_run=error`，并在缓存之前执行真实 pnpm 依赖新鲜度检查；不承诺 pnpm 内部后代环境值永不变化。最终 54 项行为回归包含真实 pnpm offline / 缺失 workspace-state 边界。另一次真实 warm native 验证先得到 MISS/HIT，再临时移走本轮自有 `node_modules/.pnpm-workspace-state-v1.json`（不改源码 hash）：cached path 与 baseline 均在 native/version/cache/叶之前以 `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` exit 1 拒绝，伪造 ambient `install` 被覆盖，modules/cache inode/mtime 不变；恢复相同 inode 后原缓存再次 HIT。记录 `final-native-freshness-proof.json`。外层 pnpm 仍需显式 `error` 或 direct Node；没有改 workspace 全局策略、根 manifest pin 或供应链策略。

### 历史阶段 1 最终 guard 六 lint 实测

主线程在同一最终 A 源码、已安装依赖与环境串行交错各三次，外层统一使用 `pnpm_config_verify_deps_before_run=error pnpm check:turbo --stage lint ...`。无重任务重叠，九次全部 exit 0、没有安装；墙钟包含公开 pnpm 入口、缓存前新鲜预检和监督器开销，不是纯 ESLint CPU。新命名空间只表示任务缓存空，不是 OS/依赖冷启动。记录 `final-phase1-performance.json`。

| 历史最终 guard 六 lint 范围 | 原始墙钟秒数 | n | 中位数（秒） |
| --- | --- | ---: | ---: |
| baseline | 36.395 / 37.152 / 35.380 | 3 | 36.395 |
| 空新命名空间 MISS | 35.934 / 35.365 / 36.801 | 3 | 35.934 |
| 同名未变 HIT，每次 6/6 cached | 4.728 / 4.763 / 5.038 | 3 | 4.763 |

该同口径 HIT 中位数比 baseline 低 **86.91%**，只证明本机相同六 lint 输入的重复反馈；不代表完整 CI、托管 runner、OS 冷启动或所有修改场景。最终 Gateway 内容修改另列为 **n=1、8.382 秒、5 HIT + 1 MISS**，仅 Gateway native hash 变化；不是中位数，不与 n=3 未变样本混算。

### Pre-guard 六 lint 历史性能（不作终态）

这些样本发生在隐式安装发现/最终 guard 之前；同 A 源码/环境、串行交错、无重任务重叠，公开入口墙钟包含 pnpm 启动等开销。首次空任务命名空间不是 OS/依赖冷启动；保留为历史，不与上述最终 guard 样本混算。

| Pre-guard 六 lint 范围 | 原始墙钟秒数 | n | 中位数（秒） |
| --- | --- | ---: | ---: |
| baseline | 35.743 / 32.330 / 34.275 | 3 | 34.275 |
| 空新命名空间 MISS | 33.708 / 33.255 / 33.484 | 3 | 33.484 |
| 同名未变 HIT，每次 6/6 cached | 3.712 / 3.804 / 3.715 | 3 | 3.715 |

该快照 HIT 中位数比 baseline 低 89.16%，仅是当时本机六 lint 的证据，不是终态、完整 CI 或托管 runner 的收益保证。另一次 Gateway 内容修改为 **n=1、9.348 秒、5 HIT + 1 MISS**，仅 Gateway native hash 变化；独立样本不混入上述 n=3 中位数，也不代表所有修改代价。1533 包重装的探针是不同范围/结果，不加入性能成功样本。

较早 B pre-guard 参考成功记录也保留：static `6ef06d43-8744-45ed-a2dd-5d8822feeef9` / 64.394 秒；build `ca9e9a70-afba-460c-a030-c2b0c75f7e95` / 215.127 秒；host `9c8cad04-407e-4092-8de5-24b71c3d0f89` / 36.377 秒。这些不是当前树、不是终态样本，也不是与最终 B 匹配的速度基准；原失败/安装事件和日志不删除。

专项摘要包括 `final-phase1-performance.json`、`final-native-freshness-proof.json`、`final-native-lifecycle-proof.json`、`final-privacy-artifact-scan.json` 与 `native-input-matrix.json`、`native-global-input-matrix.json`、`native-metadata-fallback.json`；pre-guard 的 `phase1-performance.json` / `native-lifecycle-proof.json` 只保留历史范围。公开文档只摘录上述范围/结果，不链接或依赖私有日志/源目录。不存在的可选输入不声称已探测。

以上为历史阶段 1 的本地-only、六 lint/其余十叶 fresh 方案与当时缺口。本轮已在新的 worktree 获得四阶段一次性交付授权；本轮实现和证据只看上方当前表，不追改旧 A/B、失败、skip 或历史采纳决定。

## 来源索引

- **S0**：本轮用户明确授权与主线程冻结基线；本文件记录可公开的目标、版本与边界，不依赖私有会话文件或绝对源码路径。
- **S1**：[根脚本](../../package.json)、[Web](../../apps/web/package.json)、[Agent](../../apps/server/agent/package.json)、[contracts](../../packages/agent-contracts/package.json)、[client-runtime](../../packages/agent-client-runtime/package.json)、[TypeScript host](../../apps/server/cc-switch-host/package.json)、[营销站](../../apps/marketing/package.json)；以实际叶实现为准。
- **S2**：[开发与验证指南](../guides/development.md)，含原单任务历史测量；历史采纳范围不外推到本计划。
- **S3**：[测试范围、未通过项与测量协议](../../tests/README.md)、[2026-11-06 历史耗时记录](ci-performance-2026-11-06.zh.md)；保留当时未完成及旧宿主边界。
- **S4**：[安装](../guides/getting-started.md)、[部署与服务边界](../../deploy/README.md)。
- **S5**：[共享任务注册表](../../scripts/check-task-graph.mjs)、[Turbo 配置](../../turbo.json)、[当前 runner](../../scripts/check-turbo.mjs)；为本轮实现权威，不以源码存在代替实测。
- **S6**：[完整 CI](../../scripts/check-ci.mjs)、[进程监督器](../../scripts/check-ci-process.mjs)、[后端监督器](../../scripts/backend-tests.mjs)。
- **S7**：[Repository checks](../../.github/workflows/ci.yml)、[Desktop native installers](../../.github/workflows/desktop.yml)、[只读上游发现](../../.github/workflows/upstream-discover.yml)；这些额外范围不因 Turbo 调度而消失。
- **S8**：[上游源码维护指南](../guides/upstream-source-maintenance.md)、[第三方声明与发布阻塞](../../THIRD_PARTY_NOTICES.md)、[安全政策](../../SECURITY.md)。
- **S9**：上一轮阶段 1 主线程的历史执行回报及安全记录名/runId；区分当时 A dirty 导出、B 已认证旧桌面参考、pre-guard 历史与历史终态，不依赖私有原日志或本机绝对路径。
- **S10**：本轮 Main 在新 worktree 串行执行的实际回报与安全记录：测量代码/配置身份、三组 16 叶原值、精确恢复清单、`behavior-final-76-passed.log`、真实 client 类型错误与输入矩阵、restored Agent/transport runId、`hosted-local-tar-restore-smoke.json`、`ci-stage-cache-and-fresh-gates.json`、live 归属对照及失败 all。只摘录已观察范围，不公开私有日志/路径、不将未执行的 hosted/backend/真实账号/平台/生产/发行标为通过。
