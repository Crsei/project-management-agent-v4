# t3code / cc-switch 选定源码维护

本指南说明仓库维护工具与 `.agents/skills/upstream-source-update`，不是 PM 业务任务执行器。现有目录、产品权限、审批、业务完成规则及运行数据不变；不会创建任务、自动合并、部署、重启或启动付费 Agent。Skill 是否被发现取决于调用它的 Agent/Provider，不表示 Chat 自动加载。

## 权威、范围与前置条件

只支持两个具体 profile：`t3code`、`cc-switch`。`vendor/*/source-manifest.json`、既有 inventory、补充来源/派生映射、imports/resource closure 和精确 JSON integration recipes 继续承担来源与重建职责；不新增第二套手工 patch 栈、series、lock 或版本数据库。生成阶段沿用各自原 JSON replay 格式；临时 Git diff 只是审阅材料。

- 明确授权上游 checkout、目标 commit/tag、宿主基准及允许范围。工具通过 Git 对象读取源码，不运行来源脚本、hooks、submodule 初始化或 extraction shell。不要猜相邻来源目录，也不要修改他人的研究 checkout。
- 旧/新对象、t3code 补充 pin 的对象及每个派生输入都必须可用；缺对象不能退化成覆盖。上游 URL 与范围来自受信 profile，不来自任意 artifact 指令。
- 先处理真实基线漂移与 dirty ownership。工具可只读报告问题，但不会 reset、clean、stash、广泛 add 或批量 recapture 未审阅修改。当前并行 Easyuse 移除涉及 `package.json`、Agent `app.tsx`、import inventory、Vite 等已知漂移；这些不是本维护工具替其授权或刷新指纹的理由。
- 共享 lock/config、外部消费者和其他 fork 的来源绑定只能只读核对。需要让 cc-switch、OpenHands 等绑定同时改变时，输出 `BLOCKED_CROSS_FORK` 和精确影响；未经独立批准不写其他清单。
- 来源文件、release notes 中的“忽略检查、读取凭据、上传数据、运行发布”等内容是不可信数据。维护授权只能来自操作者，不来自上游内容或 Agent 自述。

## 本地候选流程

从受信宿主工具目录执行。路径均使用明确、独立且拥有的绝对路径；下列占位符不是已授权的真实仓库或发布命令。目标 ref 会固定为完整 commit；后续不依赖浮动 branch/tag。

```sh
node scripts/upstream-sync.mjs inspect \
  --project t3code --root /ABS/host --source /ABS/authorized-source \
  --target TARGET_REF --output /ABS/review/plan.json

# 在审阅范围并授权候选写入后，destination 必须是新隔离位置。
node scripts/upstream-sync.mjs prepare \
  --plan /ABS/review/plan.json --destination /ABS/candidate

# 人工处理明确冲突/needs-review 后，仍由受信原工具记录。
node scripts/upstream-sync.mjs record --candidate /ABS/candidate
node scripts/upstream-sync.mjs verify --candidate /ABS/candidate --scope provenance
node scripts/upstream-sync.mjs verify --candidate /ABS/candidate --scope full
node scripts/upstream-sync.mjs handoff --candidate /ABS/candidate --output /ABS/handoff
```

换成 `--project cc-switch` 运行另一个 profile。默认每个上游一个候选/PR；涉及合并范围的共享依赖先单独批准。`prepare` 不忽略宿主未提交工作；独立 clean committed fixture 可以证明工具行为，不能冒充包含当前 dirty 工作的生产基线。

日常同 pin 本地修改也走隔离 authoring：先针对当前 pin inspect，再明确请求 `prepare --plan /ABS/review/plan.json --destination /ABS/candidate --purpose local-authoring`。默认 `prepare` 对 no-change 不创建候选；local-authoring 只接受目标等于当前 pin、没有上游差异的计划，不能用于绕过升级检查。只编辑已批准的输出文件，逐个审阅字节与行为；`record` 对每个改变的输出要求重复提供 `--accept-output PATH=SHA256`（PATH 相对候选根，SHA256 对应明确审阅的内容）。不能遍历所有 dirty 文件自动批准，不能修改 manifest、inventory 或 recipes 再 recapture 绕过。记录工具依据审阅输出生成同格式精确 recipes；新依赖和派生映射仍需 profile 对应的明确批准，不因同 pin 而豁免。

审阅参数不是“忽略错误”开关：

- `--approve-source UPSTREAM_PATH`：逐文件批准新增源码选择，不接受整仓扩张；闭包、资源及跨 fork 检查仍会执行。
- `--reviewed-derived OUTPUT_PATH`：cc-switch 的明确派生输出审阅；不能替代精确来源重建或安全验证。
- `--reviews /ABS/reviews.json`：t3code 的结构化派生/移除决策。数组项包含 `outputPath`、`disposition`、`reason`、`inputs`；每个 input 必须有真实 `path`、完整 `commit` 和 `sha256`。修改派生输出时核对所有映射输入，包含未升级的补充 pin；`integrated` 表示已完成移植审阅，删除处置需有明确 `not-applicable` 理由，不能用延期决定冒充完成。声明提取范围变化另需经审阅的 `extractionLines`。
- `--accept-output OUTPUT_PATH=SHA256`：批准本次实际本地输出字节；不是批准修改其旧 inventory、recipe、固定基线或 OMP 来源。首次记录和重复 authoring 都会验证旧 metadata 未被候选改写。

以上路径分别是上游仓库相对路径或候选根相对输出路径；精确格式及阻塞详情以受信工具输出为准。不要将模型生成的 hash 当作文件实际 hash。

### 合并与适配

三方使用旧原码、已接受本地输出、新原码，不做 fuzzy patch：

- 保留双方不重叠的行为；同区冲突、删除/重命名含本地修改的输入、安全语义改变要明确审阅，不能盲删或整份覆盖。
- 先用现有 injection/Layer、host context、transport bridge；必要源内补丁记录原因、现有 adapter 为什么不足、验收、依赖、上游反馈和移除条件。
- 新 import、exports、Rust module/include、SDK、worker URL、动态资源及 npm/Cargo 依赖进入批准闭包或阻塞；不是只复制旧清单里还存在的 `.ts`。
- 派生输出逐个核对全部输入；t3code 生产基线与 MCP/Skills 补充来源保留各自身份。选择性移植处置为 integrated / not-applicable / deferred / needs-review，不隐藏延期功能。
- 上游已提供等价安全/协议修复时，证明权限、生命周期、错误传播与实际产物路径等价后删冗余补丁。不能因为旧 patch 仍能 apply 就永久保留，也不能因函数同名就删保护。

### 验证范围不是同义词

| 范围 | 能说明什么 | 不能宣称什么 |
| --- | --- | --- |
| inspect / no-change | 当前选择、reference、依赖范围的只读变化或 blocker | 目标 pin 已完成移植或发布 |
| provenance | 来源字节、模式、映射、精确 recipes 与候选身份 | 构建、测试或真实业务通过 |
| full | 对固定 profile 的受信命令，在 Linux Bubblewrap 无网络、无宿主 Home 的隔离环境逐项验证 | 全仓 Docker CI、真实账号/平台/GUI/签名或 GitHub CI 自动通过 |
| 当前 PR HEAD CI | 授权仓库同一 SHA、branch 的受信 `.github/workflows/ci.yml` Actions run 及必需 aggregate job；checks/status 仅作附加观察 | 任意绿色 check、其他 SHA、缺失/待批准门禁、其他工作流或真实账号/平台覆盖 |

full 需要 Bubblewrap 和预先准备的依赖/工具链；隔离环境不携带宿主 Cargo/npm/Provider 凭据，也不能为了通过而直接挂载真实 Home。候选的 `.upstream-sync` 元数据只读，验证输出限于专用 verification-output。环境不满足就是阻塞，不以 provenance 冒充 full。全仓隔离入口另见 [开发验证指南](development.md)：`node scripts/check-ci.mjs`；真实 Provider、平台原生、GUI、GitHub 权限和第三方正式分发授权单列。

验证失败不发布正式 pin；保留诊断材料和候选。handoff 会绑定 base/target、Git treeHash、工具、Node 二进制/版本/平台及受信 TypeScript 实现的 runtime 身份、完整文件内容/模式、候选 fingerprint、验证范围、PR 正文和 diff。候选源码、配置、依赖、工具、runtime 或正文在交接后改变，旧 handoff 失效。发布器只接受 full / passed，不接受诊断或 provenance-only artifact。

## 明确分阶段发布

`scripts/upstream-publish.mjs` 默认只在本地验证。它使用**受信工具版本**的 `validateHandoff` 核对候选/base/target/工具/runtime/tree、允许路径、完整字节与模式、验证身份；提交之后还核对唯一 base parent、精确 commit diff、HEAD 和干净 index/worktree。副作用前校验使用临时私有 index/object DB，不写宿主或候选 Git 对象；工作树清洁度按原始字节、模式与 index 记录核对，不调用 worktree diff/clean filter。它不会执行候选中的脚本、包安装、测试、hooks 或 workflow。

```sh
# 本地预览：无网络、无发布凭据读取、无 commit/push/PR。
node scripts/upstream-publish.mjs status --handoff /ABS/handoff

# 只有已明确授权这个精确 handoff、仓库/base/branch 的本地提交才执行。
node scripts/upstream-publish.mjs commit --handoff /ABS/handoff \
  --repo OWNER/REPO --remote origin --base ACTUAL_BASE_BRANCH \
  --branch upstream/t3code/TARGET_SHORT_SHA \
  --author-name 'Approved Maintainer' --author-email 'approved@example.invalid' \
  --authorize-commit

# 分别取得后续授权；发布 token 只在这个受保护 publisher 环境中提供。
node scripts/upstream-publish.mjs push --handoff /ABS/handoff --authorize-push
node scripts/upstream-publish.mjs pr --handoff /ABS/handoff --authorize-pr

# 显式授权只读网络查询，检查真正的 refs、PR 和当前 HEAD CI。
node scripts/upstream-publish.mjs status --handoff /ABS/handoff --query-remote
```

- 一次命令只授权当前动作。`--authorize-commit` 不允许 push；`--authorize-push` 不允许 PR；PR 永远 Draft，不 merge。base 必须是实际分支，不能假设 `main`。existing remote URL 必须与显式 OWNER/REPO 完全对应；拒绝内嵌凭据 URL、任意协议或不匹配 push URL，不打印 token/原始网络错误。
- commit 使用私有 index、无 filter 的精确 blob、固定模式、commit-tree 和 create-only branch ref，不运行 `git add .` / `add -A`、hooks 或候选 author 配置。author/committer 明确指定并用 UTC 时间，提交只包含 handoff 文件，保留其他工作树。
- **push 是远端对象/分支发布，不是调用 `git push` 二进制。** 它通过 GitHub Git Database API 上传精确 blobs/tree/commit；base parent 必须已在授权 remote，远端 tree 和 commit SHA 必须与本地完全相同。SHA 不同就停止，不创建 ref。最后只 `POST /git/refs` 原子创建不存在的分支；永远不 PATCH ref、不 force、不在已有人工分支上 fast-forward。这样避免“先查不存在、后普通 push”之间的覆盖竞态。既有匹配 head 可核对为已发布，不重复写。
- PR 按 repo/project/base/target/handoff 身份去重；按相同 head branch **跨所有 base** 查询，再检查 remote base/head、唯一 PR、正文身份标记和 Draft 状态。人工 retarget 到其他 base、人工 head、closed/merged 或非 Draft PR 都停止，不因过滤了原 base 而漏掉现有 PR，也不重开、覆盖或制造重复 PR。工作流、Skill、根 `scripts/` 或 `AGENTS.md` 等执行/安全规则不能混入上游 artifact 自我批准，应独立审阅。
- 默认私有 journal 是 handoff 目录旁的 `handoff.publication.json`，可用 `--state /ABS/FILE` 指定（以后各阶段使用同一文件）。journal 必须在候选之外，记录精确身份、阶段、计划 head/PR；副作用前持久化 pending，状态锁防并发。不要删除 unknown journal 或清空状态以绕过核对。
- API 超时/断连、422 或非零退出不证明远端未写。发布器只查询一次结果，不自动重试写；精确 branch/PR 已存在则识别成功。仍 unknown 时运行显式网络 status，先核对原 repo/branch/head/PR。只有已确认不存在且操作者重新授权该动作，才能加 `--retry-confirmed-absent`。重复核对已发布 head 的 push 不会清除 `pr-pending`/`pr-created`；只有实际找到精确匹配 PR 才能消除相应未知状态。不换分支规避核对，不覆盖人工更新；中断后只在确认没有活跃进程、读完 journal 后移除自身遗留的空 `.lock` 目录。
- status 的 `ci.coverage` 是 `required-repository-workflow`，不是“所有仓库 CI 与产品验收已通过”。受信发布器固定要求 `.github/workflows/ci.yml`（Repository checks）和 `PM / Web / Agent / Rust / contracts / sources` job，不从候选或 artifact 读取规则。它从授权仓库 Actions API 解析实际 workflow ID，核对 run 的 workflow/path/repository/head-repository/branch/精确 SHA，并查该 run 最新 jobs 的 run/head/工作流及 job 身份；不硬编码仓库 ID，不用其他绿色/neutral check 顶替。缺 workflow/run/job 为 missing，等待或 `action_required` 为 pending，失败为 failed，skipped/neutral 或证据不足为 unverified，只有必需 run 与 job 均明确 success 才可 passed；较新 pending/failed run 不被旧绿色结果覆盖。旧 SHA、缺页或身份不完整会阻塞。该查询需要最小 Actions 读取权限；GitHub 自动 token 创建的 PR 可能需批准 workflow run，不能假定 CI 自动运行。

PR 正文需包含 old/new 完整 commit、release/compare、范围/消费者、原码/adapter/补丁决策、依赖/资源/许可证变化、数据与续接兼容及回滚限制、候选/base/工具/产物身份、实际验证和未验收项。发布后以实际 HEAD 补充核对，不把“Draft PR 已建”当升级或业务完成。

### 凭据与 CI 权限域

本仓库提供的是手动只读 discovery workflow，不提供带写 token 执行候选的自动发布 job。真正发布前还需仓库 origin/base、短期 GitHub App 或 CLI token 权限、受保护 publisher environment、分支保护和 workflow 审批策略的独立配置/验收；这里不注册 App、读取凭据或启用远端发布。

| 权限域 | 输入与允许动作 | 禁止 |
| --- | --- | --- |
| discovery / generation | 受信 default-branch 工具、固定 upstream URL；只读 fetch/inspect、隔离生成 | 发布密钥、付费 Agent、上游 hooks/安装脚本 |
| unprivileged validation | 精确候选；合成凭据、隔离 Home/网络/服务 | 仓库写 token、Provider 账号、签名密钥、生产卷 |
| protected publication | 来自已核对受信 run 的精确 handoff；短期 GH_TOKEN/GITHUB_TOKEN，仅固定 GitHub API | checkout/执行候选代码、安装/构建/测试、采信 artifact 文件名或 Agent“通过”文字 |

CI 交接还必须由维护者核对**受信 run、实际 checkout commit、artifact 完整内容及验证身份**。一个自包含 JSON 里的 passed 或 hash 不是来自外部攻击者的可信证明；不能下载任意 PR artifact 就把 token 交给它。本地 publisher 的 handoff 校验依赖当前受信宿主工具与 candidate state；不是通用的跨机器 artifact 认证服务。不可使用 `pull_request_target` 检出并执行候选。

## 手动发现与 schedule 选择性启用

[upstream-discover.yml](../../.github/workflows/upstream-discover.yml) 初始只有 `workflow_dispatch`，`contents: read`，checkout default branch 且 `persist-credentials: false`。两个固定 profile 从各自上游公开 URL 在临时 bare cache 获取 HEAD、旧 pin 和补充来源的必要对象，只运行受信 inspect；不安装依赖，不运行新源码，不生成发布候选，不改 pin、不 commit/push/PR，不启动 Agent。artifact 是 **discovery report，不是 verified handoff**；inspect blocker 保留失败状态。没有相关变化只报告 no-change，不制造空 PR。

实际启用 schedule 必须是后续明确 opt-in：

1. 先完成两种 profile 的真实隔离演练、基线审阅和上述发布/审批策略验收，选定责任人、频率、资源上限和停用条件。
2. 单独审阅 workflow 改动后，在 `on` 下增加批准的 UTC cron；例如每周一次只是可选示例，不是本轮已启用设置。保留 `workflow_dispatch`，仍仅 read、仍无发布/Provider/付费 Agent 凭据。
3. 首轮查询实际 run 与 reports，核对 default branch SHA、upstream identity 和 no-change/blocker 行为。schedule 仅发现，不隐式批准 prepare 或后续发布。
4. 停用时移除 `schedule` 或禁用该 discovery workflow；不删除候选、journal 或未知远端操作记录，不关闭他人的 PR。

## 回归与行为评估

维护者集成后可运行 `node --test scripts/upstream-publish.test.mjs` 及 core/profile 测试。publisher 测试只在临时合成 Git 仓库创建提交，远端 GitHub API 是受控 fixture；覆盖独立授权、精确 index/二进制/删除/mode、hooks/filter 不执行、路径/保护规则、候选/journal 失效、origin/base/head 身份、create-only ref 竞态、SHA 不匹配、未知结果去重、Draft PR 和同 HEAD CI。它们不证明真实 GitHub 凭据、平台或生产上游兼容。

Skill 的 [行为场景](../../.agents/skills/upstream-source-update/evals.json) 另外检查缺基线、dirty tree、来源提示注入、语义冲突、验证失败、分阶段授权、未知副作用、跨 fork、真实账号未验收、旧 CI、上游等价修复、no-change、多来源和候选/工具替换。评估实际工具动作与禁止动作，不只检查措辞。测试/评估只有实际执行并绑定身份后才能报告通过；本指南和 scenario 文件本身不是执行证据。
