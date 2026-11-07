# t3code / cc-switch 上游源码维护与 Skill PR 流程计划

> 状态：本地维护工具、Skill 与受控发布协议已实施；生产基线、完整版本升级及真实 GitHub 发布仍有明确前置条件。日期：2026-11-05。实施与验收记录见第 14 节。
> 保留以下原研究与计划依据。本次实施没有迁移或拆分源码，没有升级生产 pin、改写其他 fork 清单、启用 schedule、提交本项目、推送或创建真实 PR；公开操作入口为[维护指南](../guides/upstream-source-maintenance.md)。
> 本计划基于本仓库源码及公开参考仓库，未查询 PM 中已有任务，因此不宣称任务已去重、已创建或已派发。下文 `draft:*` 仅是计划内编号。

## 1. 决策与目标

采用 **ITK 的明确源码选择与版本追踪 + Electron 的最小补丁及存在理由 + Neovim 的选择性移植记录 + code-server 的更新 Draft PR**，并保留本项目已有的来源与精确重建体系。

目标不是把整个上游搬进来，也不是承诺任意新版本无人干预即可兼容，而是：

1. 上游实现尽量保持原样，宿主差异优先通过现有适配接口、依赖注入和装配解决。
2. 无法安全外置的改动保留为有明确理由、验证方法和退出条件的最小补丁。
3. 指定新上游版本后，工具自动识别本项目使用模块的变化、生成候选更新和来源记录；人工/Agent 只处理冲突、派生代码和语义变化。
4. 更新通过真实验证后交付可审阅 PR，源码、上游版本、补丁、依赖和证据对应同一候选版本。
5. 每次本地修改也可被记录和重建，避免等到下一次升级才发现基线已经失真。

**保持现有目录与产品边界。** `vendor/t3code`、`vendor/cc-switch`、现有 `apps` 和 `packages` 不搬迁、不拆分；不引入第二个 t3code 应用或完整 cc-switch/Tauri 服务，不改变 PM 权限、审批、业务完成规则和运行数据。

“尽量不修改原码”是适配优先原则，不是删除安全补丁的指标。无文本冲突、编译通过、原码占比提高都不能代替行为正确。

## 2. 已确认的本项目职责

| 范围 | 当前职责 | 不应混淆的能力 | 依据 |
| --- | --- | --- | --- |
| t3code 选定源码 | 原生 Agent Provider 驱动、协议、模型/配置能力、部分客户端与服务端实现 | 不接管 PM 业务工作流、账号授权或完整 t3code orchestrator | [Provider 宿主合同](../architecture/provider-host-contract.md)、[来源同步说明](../../vendor/t3code/SYNC.md) |
| 本地 Provider 适配 | 实例/租约、scope、执行与取消、事件映射、凭据边界、续接附属记录、PM 工具桥 | 不能复制一套上游协议以规避集成，也不能把 Provider 完成当任务完成 | [适配入口](../../apps/server/agent/src/providers/t3code/application.ts)、[宿主运行时](../../apps/server/agent/src/providers/t3code/host-runtime.ts) |
| cc-switch 选定源码 | 多 Agent 的 MCP/Skills 配置、导入、安装、原生文件投影等管理能力 | 不等于 Provider 执行、原生 Skills 发现、`/mcp` OAuth 或 MCP Apps | [配置宿主说明](../../apps/server/agent/src/extensions/README.md) |
| 本地 cc-switch host | headless Rust 装配、JSON-lines 协议、上下文、私有数据及宿主安全集成；TS 层负责认证与路径授权 | 配置保存不等于全部原生文件同步成功，也不等于运行会话已重载 | [TypeScript host 来源与更新说明](../../apps/server/cc-switch-host/PROVENANCE.md)、[Web bridge 入口](../../vendor/cc-switch/src/web/index.tsx) |

当前固定来源：

- t3code 生产基线：`30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c`。
- t3code MCP/Skills 补充来源：`d53873b6a4799e87afd63c8d288ef0089f5a3748`；不是可覆盖生产基线的“另一份最新代码”。
- cc-switch：`4.0.25`，`7afceec14b977ecc2f4373e8ffb40e7223b435ac`。
- OMP 是本地扩展，有自己的来源记录；本计划保持其原位置，不因更新 t3code 而删除或冒称它来自 t3code。

**会话与持久化尚未统一设计收口，当前暂沿用 Agent Chat。** 本计划只要求维护已有兼容性，不顺带创建新的持久化模型。当前仍是可信本机单操作者边界，不宣称多租户隔离或文件沙箱。

## 3. 研究副本与证据范围

### 3.1 本轮取得的参考代码

研究根目录是 `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/UI-package`。下载命令按用户要求，仅对子进程设置 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 为 `http://127.0.0.1:17891`；没有改全局 Git 配置、项目环境文件或业务网络设置。

| 项目 | 研究版本 | 本地位置与取得方式 |
| --- | --- | --- |
| ITK | `b114762d67034af9eaf7fe7542c29dcf9051c744` | `ITK/`，官方仓库浅克隆 |
| Electron | `6d9ec3d7433a01587615a23881ed64ed94e1fa6d` | `electron/`，官方仓库浅克隆；未下载 Chromium/Node 等依赖树 |
| code-server | `e609bb06e33ab50764959d34a406b069337275dc` | `code-server/`，官方仓库浅克隆；未初始化 VS Code 子模块 |
| Neovim | `094621e4c92a30dfe8bdca981de5799e22db3f95` | `neovim-094621e4c92a30dfe8bdca981de5799e22db3f95/`，固定 commit 的官方源码归档 |
| shadcn/ui（补充核对） | `6ea090075cd537d3b792c6c1a625e2448b6ede26` | 复用已有 `shadcn-ui/`，未更新此副本 |

Neovim Git clone/fetch 两次超时后，改从 GitHub API 解析 commit，并下载 codeload 归档。`neovim-094621e4.tar.gz` 的本地 SHA-256 为 `2801edcdcaf19e0ccaec64d9dd7c6a4e62cf56a3cceaab5ce729587ffbb75f73`。该摘要是本次下载字节身份，不冒称独立签名认证。`neovim/` 是中断的 Git 下载目录，不作为完整研究副本，也不作为任何项目依赖。

这些目录仅用于研究，不是本项目安装、构建或运行前提。公开引用使用下方固定 commit 链接；不要求其他开发者拥有本机绝对路径。浅克隆/源码归档足以阅读当前实现，但不能代替完整历史合并演练。

### 3.2 可借鉴与不可照搬

| 参考 | 已核实机制 | 本项目借鉴 | 不照搬 |
| --- | --- | --- | --- |
| ITK | 每模块 `UpdateFromUpstream.sh` 声明 repo/tag/paths/extraction；通用脚本处理来源导入与合并；已有更新 Skill | 明确选择规则、旧导入身份、重建与冲突步骤；Skill 编排维护者工作 | 不把当前 vendor 改成 subtree，不复制其直接 checkout/commit/push 指令，不假定本仓已有 ITK 的导入历史 |
| Electron | 有序补丁集、导入/导出、上游 HEAD 记录、三方冲突处理；每个补丁须解释必要性 | 最小补丁、存在理由、上游反馈和移除条件、确定性重建检查 | 不引入 Chromium 规模工具链；不并存第二套手工维护的 Git patch 与 JSON recipe |
| Neovim | 按上游 commit/patch 追踪已移植与不适用项；路径转换、相关补丁及 PR 辅助 | 已深度派生代码按变更意图移植；记录已处理、延期、不适用及理由 | 不自动采纳所有上游提交，不把“忽略”记成“已实现”，不照搬 fuzzy patch 或强制覆盖 |
| code-server | 定时/手动更新 VS Code、Quilt 补丁刷新、去重分支、Draft PR 与 checklist | 更新候选 PR、冲突与人工项显式呈现、按目标版本去重 | 不改成 submodule，不照搬 `git add .`、全局 Git 配置或失败返回成功的流程 |
| shadcn/ui | `add --diff/--view/--dry-run` 预览；旧 `diff` 命令标为弃用 | 更新前预览和逐文件审阅体验 | 两方 diff 不能辨别上游与本地改动来源，不能替代三方基线或协议验收 |

固定源码入口：

- ITK：[通用更新脚本](https://github.com/InsightSoftwareConsortium/ITK/blob/b114762d67034af9eaf7fe7542c29dcf9051c744/Utilities/Maintenance/update-third-party.bash)、[更新 Skill](https://github.com/InsightSoftwareConsortium/ITK/blob/b114762d67034af9eaf7fe7542c29dcf9051c744/.github/skills/update-third-party/SKILL.md)、[维护文档](https://github.com/InsightSoftwareConsortium/ITK/blob/b114762d67034af9eaf7fe7542c29dcf9051c744/Documentation/docs/contributing/updating_third_party.md)。
- Electron：[补丁原则与流程](https://github.com/electron/electron/blob/6d9ec3d7433a01587615a23881ed64ed94e1fa6d/docs/development/patches.md)、[补丁仓库映射](https://github.com/electron/electron/blob/6d9ec3d7433a01587615a23881ed64ed94e1fa6d/patches/config.json)。
- Neovim：[工具](https://github.com/neovim/neovim/blob/094621e4c92a30dfe8bdca981de5799e22db3f95/scripts/vim-patch.sh)、[移植规则](https://github.com/neovim/neovim/blob/094621e4c92a30dfe8bdca981de5799e22db3f95/runtime/doc/dev_vimpatch.txt)。
- code-server：[更新 workflow](https://github.com/coder/code-server/blob/e609bb06e33ab50764959d34a406b069337275dc/.github/workflows/update.yaml)、[更新脚本](https://github.com/coder/code-server/blob/e609bb06e33ab50764959d34a406b069337275dc/ci/build/update-vscode.sh)、[维护说明](https://github.com/coder/code-server/blob/e609bb06e33ab50764959d34a406b069337275dc/docs/CONTRIBUTING.md)。
- shadcn/ui：[add 预览入口](https://github.com/shadcn-ui/ui/blob/6ea090075cd537d3b792c6c1a625e2448b6ede26/packages/shadcn/src/commands/add.ts)、[旧 diff 弃用说明](https://github.com/shadcn-ui/ui/blob/6ea090075cd537d3b792c6c1a625e2448b6ede26/packages/shadcn/src/commands/diff.ts)。

附件中的示例不是可原样执行的方案。ITK Skill 确实包含 push/PR 步骤，但提示词不是授权边界；code-server 更新脚本会在部分步骤失败后继续生成 checklist，Draft PR 不表示升级成功；Neovim 的 `-P` 使用 fuzzy patch，不能用于本项目最终精确重放。

vendir、Copybara、subtree、subrepo、Quilt 和 Renovate 本轮均不安装。当前已有来源清单和本地适配体系，引入它们不能消除语义冲突，反而可能增加第二套版本权威。未来只有在现有流程不能满足明确需求时，再单独评估工具替换。

## 4. 现状缺口与首个前置条件

现有 [t3code capture](../../vendor/t3code/scripts/capture.py) 是**同 commit 的记录工具**；cc-switch Rust host 已翻译为 TypeScript，后续更新只按 [PROVENANCE](../../apps/server/cc-switch-host/PROVENANCE.md) 的 agent 核查流程进行，不再使用 cc-switch capture/sync。直接修改 pin 后刷新 hash 不会完成上游移植。

此前本会话只读检查观察到：

| 检查 | 当时结果 | 本计划处理 |
| --- | --- | --- |
| 导入边界 | 603 个源码文件通过 | 只代表当时扫描范围，不代表当前并行修改后的结果 |
| 公开许可完整性 | 30 项通过，发布授权仍有阻塞 | 保留第三方许可和发布门禁，不把完整性当授权 |
| 综合来源一致性 | t3code 的 `apps/web/src/features/agent/src/app.tsx` 输出漂移 | 审阅合法宿主修改与映射，不覆盖文件 |
| t3code imports | 实际 import/export 清单漂移 | 审阅实际导入后更新，不以旧清单判断运行依赖 |
| cc-switch / OpenHands | `apps/web/vite.config.ts` 的宿主构建指纹漂移 | 精确审阅共享输入，不批量认可脏文件 |

本轮开始时工作树另有大量并行修改；没有为确认上述失败而重跑来源检查。实施前须建立**明确、已审阅的基准提交**。不能从当前 HEAD 创建 worktree 后假装包含所有未提交修改，也不能为获得干净树而 stash/reset/clean 用户工作。

源清单修复必须基于文件所有者审阅：哪些变化属于本地适配、哪些属于无关并行工作、哪些需要重建记录。生成记录只反映获准内容；不得把整个脏工作树一次 capture 成新的“可信基线”。

## 5. 原码优先的适配规则

### 5.1 采用顺序

按以下顺序解决集成差异，避免为减少 diff 另造抽象或复制业务算法：

1. 上游已有配置、公开接口、回调、Effect Service/Layer、Rust 宿主模块或 feature 接口。
2. 本项目现有宿主适配器、装配入口、DTO/事件转换、Web transport bridge。
3. 必要且可审阅的构建接线或窄接口补丁；须覆盖实际发布产物，不能只在开发 alias 生效。
4. 无法外置的安全、数据或协议修复，保留源内最小补丁。
5. 对纯宿主派生实现做选择性移植，不冒称可自动重放整份上游文件。

不接受运行时 monkey patch、全局环境伪装、按字符串大规模替换源码、吞异常/假成功、绕过权限或恢复外部 Home 默认回退。不能将“适配器”变成一套重复 Provider/MCP/Skills 实现。

### 5.2 t3code 适配方向

- 继续使用现有 `providers/t3code/{application,host-runtime,families,upstream-services}`，以及 `packages/agent-contracts`、`agent-client-runtime`；不创建平行 Provider 架构。
- 原生协议、驱动、模型 schema 保持上游所有权；PM scope、租约/revision、身份、工具许可、结果核对及 Chat 持久化保持宿主所有权。
- 对 vendor 反向导入宿主的接点，逐个核对是否可用上游已有服务注入替代。只有能保留生命周期、错误传播和发布路径时才移除相应源内改动；不能一次批量还原。
- MCP App、Skills Composer、OAuth consent 等派生代码不做全文件覆盖。清单已有多输入映射时，逐个输入分析，不仅比较第一个文件。
- 两个来源 commit 各自保留真实身份；来源不一致时不得假定主基线升级自动包含全部补充能力。
- [continuation](../../apps/server/agent/src/providers/t3code/continuation.ts) 将 upstream commit 纳入记录校验。默认继续沿用不兼容时 `409/session_mismatch` 的显式拒绝，不删除历史、不自动重发 prompt。若要跨版本恢复，须另外证明记录与原生协议兼容后才引入受审阅转换，不顺带重设持久化模型。回滚代码不能被宣传为回滚 Provider 原生状态。
- Effect 单一运行时、SDK/worker/磁盘资源和本地 Markdown 依赖补丁均属于更新闭包；不得只同步 `.ts` 文件。

本轮源码抽样进一步限定了“只写 adapter”的可行边界；这不是所有补丁的完整审计：

| 接点 | 当前差异及计划处置 |
| --- | --- |
| [ProviderRegistry](../../vendor/t3code/apps/server/src/provider/ProviderRegistry.ts) | 宿主配置 import 重定向。保留精确接线；不为减少一行 diff 添加新的 shim/module 身份 |
| [instanceEnvironment](../../vendor/t3code/packages/provider-core/src/server/instanceEnvironment.ts) | 通过 `HostProcess.Environment` 而不是 ambient `process.env` 继承环境；在无等价上游注入前保留 |
| [ProviderAdapter](../../vendor/t3code/packages/provider-core/src/server/ProviderAdapter.ts) | 原生历史边界等协议扩展涉及内部 snapshot，不能假定外层 wrapper 可以补齐 |
| [ClaudeAdapterV2](../../vendor/t3code/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts) | MCP 连接失败显式失败、受隔离 worker 执行等安全/平台差异；保留相关失败路径和环境隔离验收 |
| [ProviderAuthService](../../vendor/t3code/apps/server/src/provider/ProviderAuthService.ts) | 通过宿主失效通知 port 接入，不恢复上游会话仓储/第二套数据库 |

### 5.3 cc-switch 适配方向

- 保持现有 `apps/server/cc-switch-host` 的可执行宿主与 `#[path]` 装配方式；此计划不要求提取新 Rust crate。
- 已有 `host_context`、`settings`、`secret_codec`、`mcp_management` 及 TS `extensions` 是优先接点；不复制 MCP/Skills 算法到 HTTP 层。
- Web 继续由 `CcSwitchManagement` 的 `invoke/upload/subscribe/context` 接入宿主。复用其 bridge，而不是让上游页面直接认识 PM Cookie、业务 API 或任意路径。
- 必须保留无法仅靠外层包装保证的行为：headless 原生路径授权、DAO 凭据加密、每 Agent override/assignment、写入前校验、未知/部分成功和配置同步语义。
- 例如 [来源映射](../../apps/server/cc-switch-host/UPSTREAM-SOURCES.md) 的 headless Home/dataDir/Claude 配置路径及私有文件写入，[来源映射](../../apps/server/cc-switch-host/UPSTREAM-SOURCES.md) 的 `secret_codec`，不是“无关定制”。没有等价安全接口前不得还原。
- 原先的 cc-switch Rust 派生关系已记录在 [UPSTREAM-SOURCES](../../apps/server/cc-switch-host/UPSTREAM-SOURCES.md)；`vendor/cc-switch` 现在只保留 Web UI 与许可声明，Rust `src-tauri` 已删除。
- 验证管理能力时使用隔离原生目录、私有数据库和密钥，不读取或改写操作者的真实 CLI Home。

### 5.4 补丁准入与退出

每个必要补丁/适配项至少记录：稳定标识、来源 commit/path、本地目标、模块、原因、为什么现有 adapter 不足、行为验收、上游 issue/PR（有则记录）、移除条件、依赖的其他改动。

分类只保留四类：宿主接线、平台/构建兼容、安全/协议修复、产品特有行为。能上游化的窄扩展点可以准备上游提案，但向上游提交仍需单独授权；上游未接受前不得删除本地保护。

每次升级重新检查：上游是否已实现等价修复？若已实现，删除冗余补丁并保留回归证据；不能只因为补丁现在能无冲突应用就继续保留。

## 6. 来源、补丁和更新状态的单一权威

### 6.1 继续使用现有记录

| 记录 | 继续承担的职责 |
| --- | --- |
| `source-manifest.json` | 原始上游身份、选取路径、hash/blob/mode、许可；新版本创建新内容并由 Git 历史保留旧版，不伪改旧来源 |
| t3code `sync-inventory.json` / cc-switch `output-inventory.json` | 当前选定输出、分类、精确配方和构建输入身份 |
| `integration-patches/**` | 唯一持久化的精确重放内容；preimage/postimage 必须匹配，不做 fuzzy apply |
| t3code `mcp-skills-adaptations.json` | 补充来源与多输入派生映射，本地集成与 adapted-upstream 区分 |
| imports/resource closure | 当前可达源码、资源和边界的派生记录，不用历史快照冒充新图 |

维护者审阅后的实际源码和来源映射是 authoring 输入；现有 JSON recipes 是可分发、可验证的重建产物。**不新增第二份人工维护的 `.patch` 栈、series 或 vendir lock。** 更新工作区可临时生成标准 Git diff/patch 供三方合并和 PR 阅读，但不能与 JSON 各自修改、各自声称权威。

仅扩展现有记录缺失的模块/策略/补丁理由字段。若需要独立 `update-policy.json`，它只声明选择规则和允许的操作，不复制原始 hash、版本或同一份文件清单；工具必须检查引用的清单身份。

### 6.2 模块选择与新依赖

更新单位是“已选模块及其必要依赖”，不是“整仓所有最新功能”，也不是“旧清单里碰巧存在的文件”。

- 完整选取包：保留完整包策略，发现新增 exports、依赖、测试、许可和资源。
- 选定源码：从固定生产入口、派生映射及已批准资源规则计算候选闭包。
- 同时看旧、新版本的路径变化和依赖变化；重命名是候选匹配，低置信匹配交由审阅。
- 上游新 import、Rust module/include、worker URL、动态资源、npm/Cargo 依赖不能因为旧图没有而被漏掉。
- 包含 API/协议变更的共享依赖必须一同审查，不能制造未经支持的混合版本。
- cc-switch 的 OpenHands 消费者要进入只读影响分析；其 `snapshotOnly` 不是删除许可。
- 外部上游路径如果超出选定范围，报告“新增依赖/范围扩大待审”，不自动复制完整应用。

### 6.3 选择性移植的状态

为派生实现建立轻量、Git 跟踪的决策记录：上游 commit、相关路径、处置、理由、本地变更与验证引用。处置为 `integrated`、`not-applicable`、`deferred` 或 `needs-review`；撤销已移植改动须重新打开处置，不永久隐藏。

扫描到新 commit 不等于已经采用该版本。区分“观察到的上游 HEAD”“候选目标”“已集成来源 pin”。只有当前选择闭包和补充映射完整落地，才能声明升级到目标 pin。选择性移植不能把未处理差异用一个全局新 pin 掩盖；可在旧基线上记录精确 backport，不能伪称整批同步完成。

## 7. 更新工具设计

拟新增一个薄的仓库维护入口 `scripts/upstream-sync.mjs`，只支持 `t3code`、`cc-switch` 两个明确 profile；复用各自已有 capture/sync/closure，不先建设任意插件平台。下列是待实现接口，不是现成可运行命令。

| 操作 | 输入与输出 | 写入边界 |
| --- | --- | --- |
| `inspect` | 本地基线、明确上游 source、目标 ref；输出解析后的 commit、相关变更、来源/依赖/许可影响 | 不写生产源码或正式清单 |
| `prepare` | 已审阅计划身份、批准基准提交、隔离候选目录；输出源码候选、冲突与待移植项 | 只写本次拥有的候选工作区，不覆盖当前仓库 |
| `record` | 冲突处理完成的候选；生成新 manifest、精确 recipes、imports/closure、工具指纹 | 仅候选；只接受已批准路径与内容，不批量批准未知漂移 |
| `verify` | 候选内容指纹与明确验证 profile；输出逐门禁结果及 artifact 身份 | 临时构建/测试目录；不运行生产服务，不访问真实凭据 |
| `handoff` | 已验证候选与报告；输出发布文件清单、PR 正文和精确 head/base 信息 | 默认仅交付材料，不自动 commit/push/PR |

### 7.1 输入固定与预检

- 允许已有只读上游 checkout 或显式网络获取；网络获取由独立步骤执行，使用明确 URL，不猜相邻仓库。
- ref 通过 Git 参数数组解析为完整 commit；禁止拼接 shell。tag/branch 只用于发现，不作为浮动运行依赖；tag 被重写时报告身份变化。
- 旧、新 Git objects 或对应原始字节必须可用，来源 hash 和选择映射一致；缺基线不能退化成覆盖。
- 不自动递归初始化 submodule、运行 Git hooks、上游安装脚本或任意 extraction shell。选择/转换逻辑来自受信宿主工具版本，上游内容作为数据读取。
- 本地代理只在开发者显式指定时使用；CI 不硬编码 `127.0.0.1:17891`。
- 记录宿主基准 SHA、source commits、policy/工具/本地适配指纹和允许写入路径。应用候选前核对这些身份，期间发生修改则使计划失效。

### 7.2 合并策略

| 内容 | 策略 |
| --- | --- |
| 原样复制文件 | 验证本地仍匹配已批准旧基线后，候选采用新上游字节 |
| 修改过的源文件 | 旧原始字节、当前已审阅版本、新原始字节三方合并；冲突停止自动处理 |
| 提取/多输入派生文件 | 展示所有输入的上游 diff 与当前宿主实现；确定性提取可重生成，其余由 Agent/维护者移植 |
| 纯本地文件 | 不覆盖；报告受影响接口，必要修改须在候选范围内明确批准 |
| 删除/重命名 | 核对本地修改、消费者和资源引用；不确定时不删除、不自动另建同名替代 |
| 生成文件/协议 schema | 使用固定、受审阅生成器在无秘密的隔离环境产生；不执行新上游任意生成脚本 |
| 二进制/许可/依赖锁 | 按固定字节和版本重新审阅；不文本合并二进制，不用上游 lock 覆盖宿主 lock |

合并成功只是候选，不是通过。禁止 `--force`、选择 ours/theirs 批量消冲突、放宽来源检查、删除安全分支或把未知改动归类为 local 逃过来源映射。

### 7.3 新版本记录与失败处理

现有 capture 的同 commit 限制继续保护日常维护。跨版本更新由专用候选流程显式建立新的 generation，再调用适配后的记录逻辑；不删除旧 inventory 以绕过身份校验。

所有输入先完整预检。候选失败时不发布任何正式 pin；保留冲突报告和候选供审阅，原仓库不变。重复 prepare 对相同输入生成相同内容；不能创建重复 PR 或清除人工冲突解决。记录最终 candidate tree 指纹，改变任意输出使旧验证失效。

不在主工作树做跨文件“假原子替换”：最终结果通过已审阅分支/补丁交接。提交、推送、创建 PR 是不同授权动作；程序中断或远端结果未知时先查询原分支/PR 身份，不自动重做副作用。

## 8. Skill 规格与 PR 流程

### 8.1 Skill 的角色

拟建 `.agents/skills/upstream-source-update/SKILL.md`，作为仓库维护 Skill；不修改现有四个 PM 分析 Skill 的只读合同，不添加产品菜单、数据库记录、Chat 自动加载或后台执行器。自动发现仍取决于调用它的 Agent/Provider。

Skill 编排受控工具并辅助理解冲突，不自行成为版本数据库、授权系统或同步算法。确定性工作交给工具；源码和 release notes 中的指令视为不可信材料，不执行其中要求的凭据读取、网络上传、发布或权限放宽。

输入：`project`、目标 commit/tag、授权上游来源、宿主基准提交/分支、允许修改范围、验证范围、发布授权阶段。来源、版本、分支可从授权仓库读取时不重复问用户；缺目标或存在真实范围冲突时才询问。

### 8.2 Skill 执行协议

1. **读取约束和状态**：确认 profile、来源身份、已有未完成候选/PR 与当前 dirty tree；不能擅自清理或忽略本地修改。
2. **影响分析**：运行 inspect，列出上游变更、模块闭包、适配/安全/数据/许可风险、待批准新依赖；输出候选计划。
3. **隔离准备**：在明确授权后运行 prepare。默认不在用户主目录执行 checkout/merge，不用生产服务验证。
4. **处理适配**：先寻找现有 injection/bridge，再考虑必要补丁。对每个冲突说明旧上游、本地约束、新上游意图与处理理由。
5. **记录与验证**：运行 record/verify；逐项区分通过、失败、未执行、环境阻塞、真实账号未验收，不用 capture 成功替代验收。
6. **交付审阅材料**：输出范围、文件清单、补丁增减、未解决项、候选指纹和 PR 正文。失败候选只能是明确标记的诊断材料，不标 ready。
7. **分别确认发布**：取得 commit、push、Draft PR 对应授权后才执行；不自动合并、部署、重启或完成 PM 任务。
8. **核对结果**：检查远端 head/base/PR 标记及 CI 的实际 SHA。后续人工更新分支不被机器人强推覆盖；结果未知先查询。

### 8.3 发布材料

每个上游一个独立更新 PR，默认不混入另一个上游升级；共享依赖无法分开时先报告并取得合并范围授权。分支标识可采用 `upstream/<project>/<target-short-sha>`，但须查询实际 base branch，不能假设 `main`。

PR 正文至少包含：

- old/new 完整 commit、release/compare 链接、模块和消费者范围；
- 原码更新、adapter 修改、保留/新增/移除补丁及理由；
- 选择性移植决策、延后项与未支持功能，禁止把未处理项隐藏在版本号中；
- npm/Cargo/工具链/worker/资源/许可证变化；
- 数据和续接兼容性、代码回退限制；
- 宿主基准、候选源码指纹、验证命令/环境/结果、产物身份；
- 当前 PR HEAD 对应的 CI、真实 Provider/平台尚未验收项；
- 明确“不自动合并、不自动部署、不自动完成业务任务”。

提交仅包含报告列出的精确文件，不使用广泛暂存。自动化按仓库、project、base、target 和候选身份去重；已存在人工提交或不匹配身份时停止，不强推、不关闭其他人的 PR。

### 8.4 与现有任务代码交付的关系

复用其原则，不强接其当前产品接口。现有 [任务代码交付](../guides/task-code-delivery.md) 有 120 秒验证、1000 文件/16 MiB 交付上限，且已提交后没有自动返修链；它也需要真实 PM task/scope。一次 vendor 更新可能超过这些边界。

本计划首先交付独立仓库维护 Skill 和候选工具，不虚构 PM 任务、不放宽上述限制、不新增业务 Runner。以后若要在 PM 内提供入口，必须另行设计真实任务绑定与验收，不作为本次隐含范围。

### 8.5 自动检测与 CI 信任边界

先提供手动触发；完成真实演练和仓库策略配置后再启用定时发现。无新相关变更时只输出 no-change，不更新版本、不产生空 PR。定时检测不自动启动付费 Agent。

建议将流程拆成三个权限域，而不是让一个带写 token 的 job 同时执行更新源码：

| 权限域 | 可以做 | 不可以做 |
| --- | --- | --- |
| 检测/候选生成 | 读取固定上游、运行受信生成器、产生受限变更材料 | 获得发布密钥、执行新上游 hooks 或任意安装脚本 |
| 隔离验证 | 在临时环境构建/测试候选，使用合成凭据和隔离服务 | 获得仓库写 token、Provider 账号、签名密钥或生产卷 |
| 发布 | 用受信固定工具核对候选清单/路径/hash/head，再提交、推送、创建 Draft PR | 执行候选中的脚本、工作流、包安装、测试或未验证 artifact 可执行文件 |

发布 job 不能只信任 artifact 文件名或 Agent 的“通过”文本；需核对受信 run、来源、base/target、完整内容清单及验证身份，防止路径穿越、symlink、工作流/工具被替换和候选被调包。候选若要修改发布器或安全 workflow，应独立审阅，不能使用自己的新规则批准自己。

沿用 [现有 CI](../../.github/workflows/ci.yml) 的只读 token、`persist-credentials: false` 和隔离检查原则；不采用 `pull_request_target` 检出并执行候选代码。受信 publish 可以使用仓库范围最小权限的短期 GitHub App token；私钥和 token 只留在独立受保护发布环境，不交给 Agent 或测试 job。

截至本轮读取，[GitHub 官方触发文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow) 说明 `GITHUB_TOKEN` 创建/更新 PR 的 `opened`、`synchronize`、`reopened` 可产生 **approval-required** workflow runs；不能沿用“一概不会触发”的旧结论。需要人工批准或经配置的 App token，且必须实际查询 CI。安全依据见 [pull_request_target 指南](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)。

Actions 的发布权限、仓库实际 origin/base、App 和分支保护策略尚未验收。本计划不读取凭据、不注册 App、不创建远端仓库；这些是启用自动发布前的前置条件，不妨碍本地分析与候选生成工具交付。

## 9. 其他模块不动的边界

OpenHands 不升级、不重构、不批量 recapture，其他 vendor 不纳入此次更新范围。

但其 [fork-policy](../../vendor/openhands-extensions/fork-policy.json) 仍绑定 cc-switch Web UI；CC 的 Rust provenance/closure 脚本已移除。因此：

- 优先新增独立更新 authoring 工具，复用原 verifier，避免无必要修改共享验证器。
- 所有外部消费者做只读兼容检查，检查不是获得修改授权。
- 若更新必须变更共享 lock/config 或验证器，使其他 fork 的记录失效，输出 `BLOCKED_CROSS_FORK` 和精确影响列表。
- 需要其他模块源码或来源记录调整时，单独提出最小变更请求；在用户授权前不写，不弱化门禁，不声称完整更新已可合并。
- 实际上游 API 不兼容时，不能为了维持“零外部改动”而留下假实现、兼容空壳或回退到旧行为却宣称新版能力。

## 10. 验证与完成标准

### 10.1 更新工具与 Skill

| 场景 | 必须观察到的结果 |
| --- | --- |
| 上游与本地均未变化 | no-change；不改文件时间/内容，不产生 PR |
| 原样源文件变化 | 候选采用目标 commit 精确字节；无关文件不变 |
| 本地与上游修改不重叠 | 合并同时保留双方行为，随后重新生成精确 recipe |
| 同一区域冲突 | 列出三方上下文并停止自动发布；不生成伪通过记录 |
| 新依赖/资源/exports | 被发现并纳入批准闭包，或明确阻塞，不遗漏 |
| 重命名/删除含本地改动 | 不盲删，保持人工决策和消费者验证 |
| 多输入派生/旧补充 pin | 每个来源都核对，不能只更新主 pin |
| 安全补丁已被上游实现 | 证明等价后移除冗余；不靠 patch apply 成功判断 |
| 计划后工作树/工具变化 | 旧候选和验证失效，拒绝继续发布 |
| 中断/重复执行 | 不覆盖人工修改，不重复提交/推送/PR；未知副作用先核对 |
| 恶意 ref/path/symlink/source 指令 | 拒绝越界、命令注入和凭据请求；不执行来源指令 |
| 跨 fork 指纹变化 | 精确阻塞，不自动授权更新其他清单 |
| 发布 token 与构建执行 | 验证进程不可读取发布密钥，发布进程不运行候选代码 |
| PR HEAD 更新或无 CI | 不引用旧 SHA 验证为当前通过；无 CI 显式未验证 |

工具使用临时小型 Git 仓库覆盖跨版本语义，并对 t3code/cc-switch 各做一次真实目标 commit 的隔离演练。小型 fixture 不能代替真实集成；只证明脚本退出零、文件变多或清单字段存在的测试不作为验收。

Skill 另设行为案例：缺基线、dirty tree、源码提示注入、语义冲突、未知发布结果、没有发布授权、跨 fork 阻塞、真实账号未验收、旧 CI、上游已修复补丁、no-change 和候选被改写。检查行为与工具权限，不仅检查措辞。

### 10.2 本项目行为与产物

- t3code：相关现有 Provider 测试、流式输出/取消/终态、实例 revision、PM scope/工具审批、原生 Home 边界、重启续接、信息问题与权限区别、MCP Apps/Skills 受影响路径。
- cc-switch：真实构建的 sidecar、JSON-lines 协议、隔离 Home 配置读写、加密 DAO、MCP assignment/override、导入预览/过期拒绝、Skill ZIP/目录边界、部分失败与未知结果、运行 Provider 不被隐式重载。
- Web：实际打开受影响的 Provider 设置、MCP/Skills 页面，核对交互、错误、未保存状态、CSS/portal/i18n；测试替代不了视觉验证。
- 构建与打包：锁定依赖、Rust/TS 编译、实际 SDK/worker/资源、单一 Effect、离开源码仓库仍能启动的产物、许可材料随包保留。
- 全量隔离入口复用 [开发验证指南](../guides/development.md) 的 `node scripts/check-ci.mjs`；单阶段成功不冒称全量通过，外部 GitHub Skill 网络范围单列。
- 真实付费 Provider、平台原生行为、GUI/签名、实际 GitHub 权限另列。无法执行时写明未验收，不用模拟测试抵消。

验收记录必须绑定候选代码/配置/工具/依赖身份。生成清单后再变更源码，或构建后再改 capture 指纹，都使原证据失效。许可完整性不是正式分发授权。

### 10.3 整体完成定义

完成意味着：两种上游 profile 均可发现相关变化、生成不覆盖主工作树的候选、维护本地适配、重建新版、输出真实验证结果；Skill 可走完授权交接；已配置环境中有实际 Draft PR 和同 HEAD 的 CI 证据。

若只实现本地流程而缺发布账户/仓库策略，可交付并准确验收本地部分，但不能把自动 PR 链标为完成。若真实版本兼容性需要未授权跨模块修改，保留阻塞；不缩小验收范围或宣称完整升级成功。

## 11. 候选任务、顺序与依赖

来源代号：R1=用户本次范围；R2=第 3 节固定参考；R3=第 2/4/5 节本仓代码；R4=第 8/9/10 节安全和验收合同。未分配负责人、日期或工期。

| 候选编号 | 目标/成果 | 范围与非目标 | 验收 | 前置依赖 | 来源 | 待确认项 |
| --- | --- | --- | --- | --- | --- | --- |
| draft:T1 | 可信本地基线 | 审阅已知漂移和并行修改；不重置源码、不批量认可未知内容 | 来源记录对应批准基线；旧差异有处置理由 | 无 | R1/R3 | 文件所有者确认及基准提交授权 |
| draft:T2 | 两项目更新策略与映射 | 复用清单，补模块选择/派生/补丁理由；不建立第二份 hash 权威 | 能解释选取边界、新依赖和保护路径 | T1 | R2/R3 | 需长期保持的源内差异逐项确认 |
| draft:T3 | t3code 最小适配收口 | 逐接点复用已有注入/Layer/宿主服务；不迁移、不重写 Provider | 可外置改动被消除或有必要性说明；安全/续接回归保留 | T2 | R1/R3 | 逐补丁可替代性，不承诺零补丁 |
| draft:T4 | cc-switch 最小适配收口 | 复用 headless/context/bridge；不拆 crate、不动 OpenHands | 原生管理、加密、路径和配置语义不退化 | T2 | R1/R3 | 上游缺失接口的必要补丁 |
| draft:T5 | inspect/prepare | 受信来源固定、影响分析、三方候选、跨 fork 阻塞 | 无冲突自动候选；冲突不覆盖；闭包完整 | T2 | R2/R4 | 首次演练目标 commit |
| draft:T6 | record/verify/handoff | 新 generation、精确重建、候选指纹、证据交接；不直接发布 | 重复结果稳定；源码/清单/产物同代；旧基线可追溯 | T5 | R3/R4 | 受支持工具链与隔离环境 |
| draft:T7 | 自动化回归与两项目真实演练 | 工具语义、安全、既有集成、实际 Web/产物 | 第 10 节用例与两个真实目标版本有证据 | T3/T4/T6 | R3/R4 | 真实账号/平台范围单列 |
| draft:T8 | 仓库维护 Skill | 编排、冲突决策、授权交接和行为评估；不新增 PM 引擎 | 12 类案例不越权，能调用实际工具完成本地流程 | T6 | R2/R4 | Provider 发现方式，不默认自动加载 |
| draft:T9 | 手动 Draft PR 发布链 | 分离凭据、精确暂存、去重与未知结果查询 | 实际授权 commit/push/PR；同 HEAD CI；无自动 merge/deploy | T7/T8 | R2/R4 | origin/base、App/CLI 权限、审批策略 |
| draft:T10 | 定时发现与维护指南 | 批准后启用 schedule；无变化不提交；更新两份 SYNC 和 Skill 说明 | 不启动未授权 Agent；明确补丁日常维护和停用流程 | T9 | R1/R2/R4 | 检测频率和是否启用定时 |

依赖统一解释为 `A depends_on B`：先完成 B 才能验收 A。

- `draft:T2 depends_on draft:T1`。
- `draft:T3`、`draft:T4`、`draft:T5 depends_on draft:T2`，源码范围分开时可并行；锁文件、共享工具、来源捕获由一个集成负责人最后串行处理。
- `draft:T6 depends_on draft:T5`；`draft:T8 depends_on draft:T6`。
- `draft:T7 depends_on draft:T3/draft:T4/draft:T6`；`draft:T9 depends_on draft:T7/draft:T8`；`draft:T10 depends_on draft:T9`。

里程碑：`draft:M1` 为基线/策略闭合（T1–T2）；`draft:M2` 为两项目本地候选与真实验证（T3–T7）；`draft:M3` 为 Skill、真实 PR 与可控发现流程（T8–T10）。没有循环依赖；定时开启不是本地工具的前置条件。

范围选择必须保留依赖闭包。例如只选 T8/T9 不能跳过真实更新工具与验证，也不能用 Skill 提示词代替它们。执行前将获批候选映射为实际任务 ID；本文件不创建这些业务对象。

## 12. 预期文件改动面

实施时以最终批准范围为准，下表不是本轮已创建文件清单：

| 位置 | 预期改动 |
| --- | --- |
| `scripts/upstream-sync.mjs` 及必要的小型 helper/test | 薄入口、两 profile、候选/验证/交接；不复制现有 hash/路径安全实现 |
| `vendor/t3code/scripts/`、现有 manifest/ledger、`SYNC.md` | 新 generation authoring、模块策略、补丁理由、精确重放联动 |
| `vendor/cc-switch/src/`、`SYNC.md`、许可文件 | cc-switch 仅保留 Web UI 与许可；Rust 源码/清单已删除，TypeScript 来源见 `apps/server/cc-switch-host/PROVENANCE.md` |
| 现有 t3code 宿主适配及 cc-switch host/bridge | 仅经逐项证明可减少上游侵入的窄改动，不改变目录/公开功能 |
| `.agents/skills/upstream-source-update/` | Skill、行为案例与必要参考说明；入口 README 明确区别于只读 PM 分析 Skills |
| `.github/workflows/` | 经批准后的受信检测/发布流程；保留现有只读 PR CI，不运行带写 token 的候选代码 |
| 既有验证、公开开发说明和变更记录 | 记录实际使用方式、证据、限制；不修改历史原始来源以伪造新 pin |

不修改参考仓库代码，不把 `/UI-package` 设为源码 import 或生产依赖。若未来直接复制参考脚本而非借鉴方法，必须先核对其适用许可证、保留归属并审查危险命令；当前计划不复制其实现。

## 13. 本轮研究与文档验证记录

已执行：

- 通过指定代理取得 ITK/Electron/code-server 浅克隆；记录上述 HEAD。
- GitHub API 解析 Neovim commit，取得固定源码归档并计算本地 SHA-256；明确 Git 下载失败及归档限制。
- 读取参考项目实际维护脚本、Skill、补丁文档、PR workflow 和本项目适配合同。
- 运行 Neovim `scripts/vim-patch.sh -h`，实际观察列出查询、生成、应用、PR 和 review 参数；没有执行 `-l/-p/-P/-s`，没有克隆 Vim、应用补丁或发 PR。
- 核对 GitHub 官方触发/安全文档与现有 shadcn diff 参数。

未执行：ITK/Electron/code-server 的升级脚本、完整上游构建、真实版本移植、Provider 推理、生产配置写入、GitHub 发布。研究代码和本计划不是这些行为的通过证据。

文档验证结果：

- 单文件 Markdown 解析、本地链接/锚点、固定 commit 的参考文件路径及 10 个候选任务的依赖闭包/无环检查通过；这是本文件范围的验证，不是全仓通过。
- `pnpm check:docs` 未通过：公开文档检查在加载 cc-switch 来源清单时提前退出，错误为 `Host build input changed: package.json`，位置为 `vendor/cc-switch/scripts/provenance.mjs:126`，调用入口为 `scripts/check-docs.mjs:71`。这是本轮实际观察，区别于此前的 `vite.config.ts` 漂移；没有为了通过而修改来源记录。
- 此次 pnpm 入口在执行检查前自动整理了已安装依赖（输出 `Packages: +6 -7`）；没有主动引入新的更新工具或参考项目构建依赖。

并行研究中 cc-switch 专项代理遭遇模型服务鉴权/计费错误而未交付结论；该部分由主线程读取 Rust 装配、headless 配置、MCP DAO/服务及 Web bridge 补齐。其余参考研究和 t3code 专项返回了源码证据。子代理输出不作为未执行测试的替代。

## 14. 实施结果与实际验收边界

### 14.1 已交付的本地维护能力

实现、复核及 Skill 行为代理均使用 `openai-codex/gpt-6.1-sol:xhigh`。维护机制沿用现有来源账本与两种精确 JSON recipe，不安装 vendir/Copybara、不新增第二套补丁栈，不迁移 vendor 或拆分应用。

| 交付物 | 已实现行为 |
| --- | --- |
| [更新 CLI](../../scripts/upstream-sync.mjs)及 [core](../../scripts/upstream-sync/core.mjs) | inspect、隔离 prepare、三方合并、record、分层 verify、handoff；不可变 Git 对象读取、旧 metadata 认证、共享输出指纹、工具/候选失效、凭据隔离 |
| [t3code profile](../../scripts/upstream-sync/t3code.mjs)与[策略](../../scripts/upstream-sync/t3code-policy.json) | 生产/补充双 pin、完整/选定模块、既有 adapter 与 OMP 边界、精确行 recipe、真实导入/目录资源、pnpm alias/peer/patch 与 package self-reference 闭包、打包来源身份校验 |
| [cc-switch profile](../../scripts/upstream-sync/cc-switch.mjs)与[策略](../../scripts/upstream-sync/cc-switch-policy.json) | 原格式精确字节/本地 asset recipe、派生输入、Rust/TS/资源闭包、加密接点保护与只读 OpenHands 边界 |
| [发布器](../../scripts/upstream-publish.mjs) | 本地 status、分别授权 commit/push/Draft PR、精确私有 index、create-only GitHub ref、未知结果核对、跨 base PR 去重、当前 SHA 的固定 workflow/job 验证 |
| [维护 Skill](../../.agents/skills/upstream-source-update/SKILL.md) | 调用真实工具的授权编排、冲突/语义审阅、分阶段发布；不创建 PM 任务，不自动 merge/deploy |
| [手动发现 workflow](../../.github/workflows/upstream-discover.yml) | 固定公开来源、受信 default-branch 工具、只读 fetch/inspect、保留 blocker 与报告；无依赖安装、写 token、schedule 或付费 Agent |
| [公开指南](../guides/upstream-source-maintenance.md)与[CI](../../.github/workflows/ci.yml) | 完整命令、同 pin authoring、审阅参数、边界与停用流程；原 CI 增加维护协议回归/lint，不替代原全仓检查 |

同 pin 的本地修改使用明确的 `prepare --purpose local-authoring`：默认 no-change 仍不创建目录；逐个输出用实际 SHA256 审阅，不能手改旧清单后“重新认证”。这与跨版本升级分开，既不抹掉原始来源，也不自动批准新的源码范围。

现有适配接点已记录必要性、替代方向与移除条件；本轮没有为了追求“零补丁”而删除加密、租约、路径、权限或续接保护。两份原 `vendor/*/SYNC.md` 自身是被指纹绑定的既有资产，本轮保持原字节，不利用写文档之名 recapture 未审阅的生产账本；新的操作说明从根 README、开发指南和 Skill 索引公开链接。

### 14.2 已执行的验证

开始时已有 818 项并行修改，涉及 Easyuse/showcase 移除及来源漂移，未由本任务接管。演练使用独立的已提交宿主基线 `19be07a009c9f3dc357918b4062a01030a9a87ec`，不把它称为包含当前 dirty 工作的生产基线。

期间并行工作再次改变 `scripts/check-ci.mjs` 和 `scripts/check-third-party-notices.mjs`，实际触发 `STALE_PLAN`。没有重签旧计划；之后固定独立工具副本：宿主/verifier 使用上述提交，新增维护代码逐字节复制当前实现，TypeScript/YAML 解析器单独固定。没有读取操作员凭据、借用 CLI Home、启动或接管服务。

| 实际检查 | 观察结果 | 证据边界 |
| --- | --- | --- |
| `node --test scripts/upstream-sync/*.test.mjs scripts/upstream-publish.test.mjs` | 最终固定副本 112/112 通过，0 skipped | 包含真实临时 Git、namespace、冲突/重建/失效/发布恢复；GitHub API 使用 fixture，不是实际 PR |
| 当前主工作树维护源码 `oxlint --deny-warnings` | 通过，无 warning | 仅本次维护工具，不是全仓 lint/类型/构建 |
| 两项目真实旧 pin 的 inspect / 默认 prepare | no-change；未创建目标目录 | 不代表目标新版本已集成 |
| 两项目真实同 pin local-authoring | 隔离候选内仅追加可丢弃注释，经精确批准后 record 成功；各自 provenance 通过 | 实际运行完整真实来源账本与生成器，不是业务功能变更或生产升级 |
| t3code `full` | provenance、原 `actual-import-closure --check` 通过；随后因隔离环境无 `pnpm` 阻塞 | 未执行后续类型、构建、打包和真实 Provider 验收 |
| cc-switch `full` | provenance 通过；首组 host tests 因未预置 `@agent-workspace/contracts` 等工作区依赖失败 | 不是 native/Rust/Web/真实 Agent 行为通过；失败 stdout 已作为有界诊断保留 |
| 两项目诊断 handoff 与本地 publisher | 明确 provenance-only、`ready=false`；publisher 均拒绝 `FULL_VERIFICATION_REQUIRED` | 没有将失败/环境阻塞换成 full 成功；真实 commit/push/PR 均未执行 |
| Skill 行为烟测 | 14 个案例经输出/动作核对符合本轮边界；22 次合成调用，无发布写入请求 | 两个指定模型代理各七例、按 scenario ID 隔离，不是十四次统计独立调用或真实工具权限验收 |
| workflow 本地执行 | 原 Node body 通过指定代理真实 fetch 两个公开上游并生成报告；无安装依赖，inspect 的 TypeScript runtime 为 null | 本地脚本演练，不是已部署的 GitHub Actions run；blocker 保持非零状态 |

发现脚本的本地夹具首次额外复制了未提交的 publisher 测试文件，工具正确报告 `DIRTY_BASELINE`。仅删除本次复制的夹具文件后，使用已取得的同一 Git 对象再 inspect，dirty 列表为空，仍精确保留下面的跨 fork 阻塞；没有放宽生产 dirty 检查。

专项回归还覆盖了审查/实跑发现的修正：其他 fork 的 `destination` 与补充输出漏绑定、首轮候选伪造旧 recipe/清单、supplemental-only 路径误入主 pin、宿主 package 被误当上游 workspace、目录 URL 资源、pnpm alias/self-import、旧打包 pin 冒充新来源、无关绿色 CI、未知 PR 状态被重复 push 清除、人工 retarget 后重复 PR。没有用放宽原 verifier 或删除安全检查来让它们通过。

### 14.3 真实上游目标及共享阻塞

| 检查 | 目标完整 commit | 选定变化条目 | 精确共享阻塞 |
| --- | --- | --- | --- |
| t3code 指定目标演练 | `df0cc36dea0c36d155b39f58e33fef66b426be19` | 524 | cc-switch 绑定的两个宿主输出；prepare 拒绝且不创建目录 |
| t3code 随后手动发现的 HEAD | `2d0efd35840dd3118939cd27b096340ea522a541` | 532 | 同两个宿主输出；发现不等于已接受该版本 |
| cc-switch 目标演练与手动发现 | `4e13413ff236860b445e6c7f3f7590e999de0eea` | 169 | OpenHands 绑定的五个输出；prepare 拒绝且不创建目录 |

t3code 的共享输出为 `apps/server/agent/src/providers/t3code/management.ts`、`packages/agent-contracts/src/provider.ts`。cc-switch 的共享输出为其 `src/components/mcp/McpFormModal.tsx`、`src/components/mcp/UnifiedMcpPanel.tsx`、`src/components/ui/dialog.tsx`、`src/hooks/useMcpConnectivity.ts`、`src/types.ts`。没有自动改写 cc-switch/OpenHands 的相应清单。

此外，`apps/server/agent/scripts/package.mjs` 仍写固定旧 upstreamCommit，并由 t3code、cc-switch、OpenHands 绑定；cc-switch 还保留其精确本地 asset recipe。PM `continuation.ts` 独立固定 `PM_UPSTREAM_COMMIT` 和 schema。实际升级必须独立审阅共享打包身份及续接兼容性，不能仅修改来源版本号。新 full 验证核对实际 artifact 与五份分发 provenance 的目标 pin/精确内容，旧 stamp 或旧 JSON 不能冒充新版本。

旧 t3code adaptation replay helper 的固定 pin 只影响旧 `sync` / `verify-sync` 入口，不是新 full 命令链的前提；新 profile 已提供 generation-aware 精确重放。保持旧守卫，不冒称旧入口已经支持任意新 pin。

### 14.4 尚未闭合的计划项

- **T1：生产来源基线。** 等并行所有者完成并确认已接受的源码/来源记录；不 reset、clean、批量 capture 或接管其他 fork。
- **T7：完整版本升级与业务/产物验证。** 需要批准上述共享范围、处理实际语义移植和续接边界，并在凭据隔离、锁一致且工具链齐备的环境完成完整 profile/全仓 CI。当前来源重放成功不是升级验收。
- **T9：真实发布链。** 本地协议与恢复回归已实现；本项目 commit、push、Draft PR 仍分别需要明确授权，并需实际 GitHub 权限、审批策略及同 HEAD CI。没有创建真实 PR。
- **T10 的远端启用部分。** 手动发现和指南已交付；schedule 仍未启用，也没有将工作流发布到远端或注册自动执行 Agent。

会话与持久化仍未统一设计收口，继续沿用 Agent Chat；本次不新增存储模型、权限体系或业务完成规则。全仓 `check:docs` 的既有来源漂移阻塞仍单列，不以专项文档检查代替；真实 Provider/平台/GUI、许可发布授权和生产部署未验收。

文档专项检查覆盖本次七份 Markdown、90 个本地链接，另核对计划的 12 个固定研究源码路径及 10 个任务的依赖闭包/无环；YAML、Skill frontmatter 与 14 个场景结构有效。未重跑已知会被来源漂移前置检查阻止的全仓 `check:docs`。

本轮创建的独立候选、工具副本、下载 cache、临时注释和验证目录已删除；没有删除用户原有上游仓库或此前按要求取得的参考项目。以上是历史验证记录，不是可直接发布的存活 handoff。
