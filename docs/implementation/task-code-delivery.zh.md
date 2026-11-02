# 任务驱动代码交付：第一版

日期：2026-10-31。范围：一个任务 → 独立分支/worktree → 用户选 Provider 的 Agent Chat → 显式验证、提交、推送 → Draft PR → 手动刷新 CI/评审。**源码与隔离测试不是 GitHub/真实 Agent 端到端验收。**

## 边界与已有设计

遵循 [Markdown 集成 ADR](markdown-integration-adr.zh.md)、[Agent 与 PM 交互矩阵](agent-pm-interaction-matrix.zh.md)。不恢复 v3 完整执行计划、业务 Run/审批模型，不新增角色或完成规则。

- 任务仍是 Markdown `work_item`；本模块不写其状态，不调用完成命令。CI、模型终态、PR 合并均不是任务完成。
- 流程决策在 `packages/application/src/task-code-delivery.ts`；Agent HTTP 仅适配当前 PM 授权、Git、GitHub 和已有 Chat。
- 当前权威任务文件、项目归属、归档和版本检查由 PM 读取。写操作要求已有 `planning.edit`（`pm_update_task` 能力）；读取要求当前任务可读。每次执行与原生运行授权回查项目目录和任务版本。
- 对应 INV-01/03/13/14/15/20、SC-03/12/13/14/20 与 INF-05/06/07 的部分路径；不宣称旧规范整个场景或 G3 已通过。
- **会话与持久化尚未统一设计，暂沿用 Agent Chat SQLite。** 只增加 `task-code-delivery-v1` 命名空间的关联收据，采用原存储的单进程所有权及事务 CAS；不是新的任务权威库。

## 使用条件与操作

1. 在 Agent 服务实际运行环境准备 Git、GitHub CLI `gh`、Git 提交身份、当前用户自己的 GitHub 认证及已就绪 Provider。不能把宿主机认证等同于容器认证；不自动挂载或复制全局凭据。
2. 将目标项目的原生文件区域通过现有项目设置登记为 Git 仓库**根目录**。`origin` 必须是无凭据 `https://github.com/owner/repo[.git]` 或 `git@github.com:owner/repo.git`，读取与推送地址一致。第一版不支持 Enterprise、SSH 别名、fork 或本地远端。
3. 保存一个项目内任务，在任务详情展开「代码交付 · GitHub」。明确填入实际远端基准分支，不能假定叫 `master` 或 `main`。空仓库需先由用户初始化基准分支。
4. 创建 `codex/task-<编号>-<交付ID前8位>`，固定 fetch 得到的 base SHA。工作目录在当前 Agent 数据目录 `task-worktrees/<deliveryId>`，不 checkout/reset/clean 用户原目录；保留原目录未提交修改。
5. 每次启动开发均由用户选择已有 Provider 和模型。会话绑定原任务，服务端收据选择 cwd，客户端 `custom`/cwd 不能改绑。会话中的 Files/Git/Terminal 也根据该绑定定位 worktree。Codex 开发请求可显式确认 `allowWorktreeWrite: true`：应用服务先持久化本次确认，启动时按当前任务授权及 owned worktree 重新核验，才选择 `workspaceWrite`；普通 Chat、旧记录或未确认请求仍为只读。
6. 在原 Agent 会话查看开发、工具交互及输出。开发结束后点击刷新，再明确填写验证命令。执行上限 120 秒，使用最小进程环境；保存退出码、代码指纹、时间和输出摘要，不保存原始输出/凭据。**退出 0 只证明该命令成功，不证明验收标准覆盖充分。** 命令失败、超时或执行期间内容变化都不产生通过证据。
7. 审查完整变更文件清单、diff 和新增文件，分别确认**提交**、**推送**、**创建 Draft PR**。首次推送使用远端分支不存在的空 lease 条件，不重写任何已有分支。独立工作目录内变更合计最多 1000 文件/16 MiB，拒绝私有管理路径、凭据类文件和符号链接；不要在当前项目仓库广泛暂存。
8. 点击刷新读取 PR 当前 HEAD 的 check runs、commit statuses 和 reviews；分页有界且不接受不完整快照，读取期间 HEAD 改变则拒绝混合快照。无 CI 是「未发现」不是通过；旧 commit 的 review 标记旧版本，远端 HEAD 变化时提示原本地测试不覆盖它。刷新失败保留上次快照及采集时间，不当作最新结果。

这是**受信任本机 CLI**的使用约定，不是完整隔离 Runner。已确认的 Codex 任务使用原生沙箱限制写入根目录，关闭原生命令网络与额外临时目录写入；越界权限请求仍拒绝。这不保证容器内其他文件不可读，也不把用户手动 Terminal 操作变成受限 Runner。Agent 原生 shell 和 Terminal 本来就可执行命令；提示词中的「不要提交/推送」不是安全权限边界。本模块保证自己的发布接口分别确认，不声称能拦截任意原生 shell 副作用。若需强制发布隔离，需要另行设计隔离 Runner、凭据分离及网络策略。

## 接口（Agent API，经网关加 `/agent` 前缀）

| 接口 | 行为 |
| --- | --- |
| `GET /api/task-deliveries?workspaceId=...&projectId=PRJ-...&taskId=TASK-...` | 当前授权范围内的任务交付记录 |
| `POST /api/task-deliveries` | `{id,workspaceId,projectId,taskId,taskRevision,baseBranch}`；客户端稳定 UUID 为准备幂等键 |
| `GET /api/task-deliveries/:id` | 收据、当前差异及任务版本是否变化 |
| `POST /api/task-deliveries/:id/actions` | `develop`、`test`、`commit`、`push`、`draft-pr`、`refresh`；严格输入 schema，验证/发布须明确确认 |

每步写前保存 pending 收据并进行 CAS，原生进程/外部 API 副作用与本地 SQLite **不是跨系统原子事务**。并发、网络丢响应、服务重启不能直接重放副作用：

- 开发：按原 generation 幂等键查已有 Chat；模型终态只更新交付阶段。
- 提交：只在独立分支、提交 marker、精确父 SHA、代码指纹和干净目录均匹配时核对成功。
- 推送：查询原远端分支 SHA。
- PR：查询原 repo/head/base 和 delivery marker；不能唯一匹配就停止。
- 未确认的 worktree 创建、找不到原 generation、丢失验证进程结果等保持待核对。第一版没有「忽略未知结果并重试」按钮，也不自动删除目录/记录。

## 第一版刻意保留的限制

- 每个任务一条交付链；测试失败可重新开发/测试，但已提交后暂不做自动返修、多 PR、重选基准或重绑需求版本。任务内容/状态版本改变后阻止旧交付继续执行，先人工核对。
- CI/评审手动刷新，无 webhook、后台 watch、自动修复、自动 merge/deploy/Done。
- GitHub API 认证与 Git transport 认证分别检查。不能用 SSH clone 成功推断 API 可创建仓库/PR。
- 没有代用户自动创建 GitHub 仓库的产品入口；验收仓库可以单独通过 GitHub 官方 `POST /user/repos` 创建，必须先完成服务执行环境认证。

## 验证记录

- 新增应用状态机、GitHub 模拟响应、真实临时 Git/worktree/commit、SQLite 重启/CAS/任务唯一性、权限与伪造 cwd 拒绝测试；原 Chat 授权与运行时回归单列运行。
- GitHub 网络响应测试使用注入适配器；原生 Provider 回归使用项目既有 fixture。没有将其记为真实 GitHub 或真实模型通过。
- 2026-10-31 宿主机 `gh api user` 返回未登录，未创建验收仓库、未推送本项目、未创建远端 PR。后续登录后仍需在实际 Agent 服务环境完成 Git/API/Provider 认证并验证整个闭环。

### 本轮实际检查结果（2026-10-31）

| 检查 | 结果 |
| --- | --- |
| 新增交付测试 + 原 Chat 授权/运行时 + Inspector Files/Git/Terminal 回归 | **98 通过，0 失败，0 跳过**；真实 Git 操作仅在临时仓库，GitHub/Provider 使用 fixture |
| 受影响后端 oxlint、前端两个改动组件 ESLint、Agent 类型检查、Web 类型检查 | 通过；最终新增测试文件类型检查也通过 |
| `pnpm build`、`pnpm build:agent`、4 GiB heap 下 `pnpm build:web` | 通过；最后 Agent build 另行通过。Web 有既有大 chunk/混合静态动态导入警告 |
| `pnpm test:backend --file-timeout-ms 180000` | 124/124 文件执行完；**864 测试：852 通过、5 失败、7 跳过**。跳过项是未配置的真实 S3 协议验收，不计通过 |
| 全量后端失败文件 | `packages/contracts/tests/openapi.test.ts`、`packages/pm-core/tests/project-locations.test.ts`、`tests/artifact-files-model.test.ts`、`tests/local-project-backup.integration.test.ts`、`tests/s3-blobs.integration.test.ts`；这些文件及对应业务实现未在本轮改写，未宣称整个仓库回归通过 |
| `pnpm check` / `pnpm check:docs` | 被既有 `t3code-provider-module-migration-plan.zh.md` 引用缺失的 `.omp/agents/codex-sol.md` 阻断 |
| 单独 `pnpm contracts:check` | 现有 `docs/contracts/openapi.yaml` 被报告为 stale；未广泛重新生成合同 |
| 单独根 `tsconfig.check.json` | 未通过：未改动的 notification/project-files 模型别名/扩展名及 artifact-files 测试参数类型错误；受影响后端 build 与 Agent/Web 类型检查分别通过 |
| 本地运行 | 已重新加载本次 v4 服务，PM ready / Agent / `/pm` / Agent Web 均 HTTP 200；新交付 API 无 PM 会话返回 401，未误报未授权可用 |
| GitHub 与业务 UI | 专用 Agent 容器已装 Debian `gh`；宿主机和容器的 `gh api user` 都报告未登录。浏览器当前授权工作区无项目/任务；未为验证擅自写入业务数据。真实 GitHub、真实 Provider 和任务详情完整 UI 闭环仍待验收 |

本轮没有提交、推送本项目或创建远端 PR。现有开发网关在停止监听后仍未退出；确认 PID/启动身份/工作目录均属本 v4 后仅终止该网关，由原 supervisor 清理其自身服务，再重新启动本 v4，未接管其他副本。

后续可由用户在终端登录专用容器的 GitHub CLI（不向聊天粘贴 token）：

```sh
docker --context colima-pm-v4 exec -it project-management-agent-v4-dev gh auth login --hostname github.com
```

登录完成后再尝试创建独立私有验收仓库，并分别确认后续真实提交与推送。官方接口参考：[创建当前用户仓库](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user)、[创建 Pull Request](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request)。

### 真实 GitHub 初始化及任务分支（2026-10-31，后续推进）

用户完成专用容器 GitHub 登录后，API 核验账号为 `MoyInGxing`，创建了私有仓库 [pm-v4-delivery-smoke-20261031](https://github.com/MoyInGxing/pm-v4-delivery-smoke-20261031)。用户分别明确授权仅在此验收仓库创建提交、推送并创建 Draft PR；不提交本项目源码、不合并。

- 在仓库内写入 7 个独立 fixture 文件：README、AGENTS、`.gitignore`、无依赖 Node package、`add` 示例及其测试、固定 action commit SHA 的 CI；没有复制 PM 应用源码。`.pm/` 元数据忽略，不纳入提交。
- 初始化提交 `49d89aaea2a311881a6b3bb4c6d51d196b52fb6c` 已经真实 SSH 推送到 `main`；本地 1 项基线测试通过，[GitHub CI run 41169324077](https://github.com/MoyInGxing/pm-v4-delivery-smoke-20261031/actions/runs/41169324077) 结果 `success`。
- 通过当前 CLI 的标准认证与原生项目初始化应用服务，在当前账号唯一工作区 `96f238af-0c25-4c8c-b417-f11d9192e34b` 创建隔离验收项目 `PRJ-001`，将其目录绑定到 `.local/projects/96f238af-0c25-4c8c-b417-f11d9192e34b/github-delivery-smoke`。该工作区与 README 历史迁入记录中的工作区不是同一实例数据，不从其他副本导入。
- 创建 `TASK-001`「新增 clamp 数值边界函数并补齐测试」，包含有限数字、上下边界、非法参数、回归测试、文档及不得自动完成的标准。任务 revision：`4ae244f126150b69b9c162de4022b5cd852c91ebbd19fb2f99a28e232efab45f`。
- **真实浏览器 → 交付 API → Git** 已走通准备步骤：交付 ID `5a99e64a-1016-4a59-864a-1dae869026dd`，分支 `codex/task-001-5a99e64a`，独立 worktree `.local/agent-data/task-worktrees/5a99e64a-1016-4a59-864a-1dae869026dd`，固定基线为上述初始化提交。任务仍 `todo`，交付阶段 `ready`，未制造 Agent 成功或任务完成记录。
- 用户选择 Codex。通过现有 Provider maintenance 安装官方 Codex CLI `0.156.1`，然后在同一个 `codex` Provider 配置实际 binaryPath 和独立 `native-home`，不复制宿主机凭据。CLI 安装成功不等于登录或模型已就绪；已提供 `.local/codex-login.sh` 供用户自行设备登录。
- 当前尚无任务开发提交、任务测试结果、Draft PR 或 PR 评审回传；这些步骤等待 Codex 登录后继续。初始化 CI 成功不作为任务需求通过证据。

本机界面证据保存在未提交的 `.local/logs/task-delivery-ready.png`；当前项目源码仍无新增提交或推送。会话与持久化仍暂沿用 Agent Chat，统一设计尚未收口。

### 真实 Codex 开发与任务验证（2026-10-31）

- 用户完成 Codex 原生登录，状态核验 `authenticated`、`nativeSessionReady=true`。Provider 返回默认模型 `gpt-6-astra`，由任务详情选择并启动。
- 首次执行确实因既有 `readOnly` / `untrusted` / `deny-ungranted` 策略而未修改代码。保留该失败过程，不把 Provider turn completed 当作需求通过。
- 用户随后明确批准：只授权该任务 worktree 写入、普通 Chat 保持只读、越界权限请求拒绝；并单独批准仅调整专用 v4 容器使 Bubblewrap 可运行。新增可选 `allowWorktreeWrite: true`，每次开发单独记录确认；未确认/旧记录默认只读，普通线程自定义字段不能伪造授权。启动回调重查当前 PM 授权、任务/目录身份及确认，不从浏览器 cwd 或全局 Provider 配置授予写入。
- Codex 原生策略为 `workspaceWrite` + `on-request`，唯一写入根为 owned worktree，`networkAccess=false`、`excludeTmpdirEnvVar=true`、`excludeSlashTmp=true`；原有拒绝越界 approval 的代码未改。未给 Claude 或普通 Chat 扩大权限。
- 专用容器采用基于官方 Moby profile 的局部 seccomp/AppArmor 调整，以支持非特权用户命名空间；`Privileged=false`、`CapAdd=null`、seccomp 仍开启。不改全局 Docker profile、不停 PostgreSQL/其他副本。一次性原生沙箱探针证实 cwd 可写、目录外及 `/tmp` 写入拒绝；补充网络探针没有得到有效输出，不记为运行时网络隔离通过。
- 真实第二次 generation `91327ed0-0b17-45ed-859a-1d94055fe475` 在原任务会话/分支完成了 `clamp`、README 和测试。没有由人工替写 fixture 实现。
- Agent 自身报告测试通过后，再由任务面板执行 `npm test`，收据 exit `0`、代码指纹 `a85c65612a5638ffb002ae9bf211f2f9fc0b0b6c6645203befaf89eebeccc1ab`，时间 `2026-10-31T04:55:36.407Z`。随后在任务面板审查完整 diff、确认仅提交 `README.md`、`src/math.js`、`test/math.test.js`。
- 验收提交 `96bac26940bbfb2f05d479397a7151d10379992e`，包含 delivery marker；提交后工作目录干净，独立复跑 **10 项测试全部通过，无跳过**。本项目源码仍未提交/推送，任务仍 todo。
- 本轮追加受影响回归 **108 通过、0 失败、0 跳过**；后端 scoped lint、前端 ESLint/类型检查、Agent/Web 构建通过。普通线程目录快照回归曾揭示多余权限回查，已修正为仅对已确认任务生成请求传入授权回调，并复跑通过。

专用运行环境与回退说明在未提交的 `.local/sandbox/README.md`。本机容器快照包含专用运行账号状态，不能推送或导出到公共仓库/镜像仓库。会话与持久化仍暂沿用 Agent Chat，统一设计未收口。

本轮完整 `pnpm test:backend --file-timeout-ms 180000` 已执行完 124/124 文件：**866 测试，854 通过、5 失败、7 跳过**。失败仍为上文列出的五个既有文件；未以局部回归或验收 fixture 的通过替代全仓库通过。

推进到提交后，浏览器工具报告 Mac 已锁定；已请求用户解锁。在此交接点，收据为 `committed`、无 pending，尚未推送该任务分支、未创建 Draft PR，GitHub PR 列表为空。不得把此阶段写成完整闭环通过。

为加载普通 Chat 回归修正，完成全量检查后重启本 v4。容器 PID 复用触发了既有 SQLite 所有权锁的误判；在确认专用容器停止、无 Agent 进程、4325 空闲后，仅按 lock 文件与 `worker_owner` 完全匹配的 PID/token 清除旧进程所有权，保留全部会话、交付收据及业务数据。此操作恢复不代表会话持久化设计已收口。

### 真实 Draft PR 与 CI 回到任务（2026-10-31，闭环验收）

用户解锁 Mac 并手动重新登录 v4 PM 后，从原交付的 `committed` 状态继续；未重新开发、重复提交或改写任务版本。

- 通过任务面板的「确认推送」发布分支 `codex/task-001-5a99e64a`。独立 `git ls-remote` 核验远端 HEAD 为 `96bac26940bbfb2f05d479397a7151d10379992e`，与已验证的本地提交一致。
- 通过同一面板「创建 Draft PR」得到 [Draft PR #1](https://github.com/MoyInGxing/pm-v4-delivery-smoke-20261031/pull/1)。GitHub API 核验 `draft=true`、`state=open`、base=`main`，HEAD 与上述提交一致。
- PR 触发 [GitHub Actions run 41206079350](https://github.com/MoyInGxing/pm-v4-delivery-smoke-20261031/actions/runs/41206079350)：`pull_request`、`completed / success`。真实日志显示 `npm test` **10 通过、0 失败、0 跳过**。
- 首次刷新遇到 GitHub 网络读取失败，界面明确报错；只重试读取，没有重推分支或重建 PR。再次点击「刷新／核对结果」后，任务面板显示 `pr`、`GitHub · open`、`test: completed / success`，反馈 HEAD 同上，快照时间 `2026-10-31T13:34:45.727Z`（北京时间 21:34:45）。
- GitHub 评审列表为空，任务正确显示「暂无评审」；**没有伪造人工审批，实际评审事件回传仍需有评审后验证**。本次 CI 回传为显式手动刷新，不是 webhook 或后台自动同步。
- 原任务仍为 `todo`，revision `4ae244f126150b69b9c162de4022b5cd852c91ebbd19fb2f99a28e232efab45f` 未变。未合并、部署或完成任务；当前 PM 项目源码没有新增提交或推送。

浏览器证据保存在本机未提交文件 `.local/logs/task-delivery-ci-success.png`，包含任务上下文、Draft PR 和同版本 CI 成功结果。恢复后的 Provider 目录曾显示未就绪；本轮没有启动新 generation，既有真实开发结果不等于下一次启动的健康保证，后续新任务仍须检查 Provider 就绪。

本节证明隔离任务的真实「任务 → 分支 → Codex 开发/测试 → Draft PR → CI 结果回到任务」路径。前述全仓 **854 通过、5 失败、7 跳过**及文档检查阻塞仍存在，不改记为全仓通过。会话与持久化仍暂沿用 Agent Chat，统一设计尚未收口。
