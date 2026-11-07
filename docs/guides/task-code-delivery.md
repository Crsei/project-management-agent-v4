# 任务驱动代码交付

> 公共使用合同摘录；历史验收结果不作为最新工作树通过证明。会话与持久化尚未统一设计收口。


日期：2026-10-31。范围：一个任务 → 独立分支/worktree → 用户选 Provider 的 Agent Chat → 显式验证、提交、推送 → Draft PR → 手动刷新 CI/评审。**源码与隔离测试不是 GitHub/真实 Agent 端到端验收。**

## 边界与已有设计

遵循 [Markdown 集成 ADR](../architecture/adr/0003-markdown-core.md)、[Agent 与 PM 交互矩阵](agent-chat.md)。不恢复 v3 完整执行计划、业务 Run/审批模型，不新增角色或完成规则。

- 任务仍是 Markdown `work_item`；手动交付模块不写其状态，不调用完成命令；另行授权的工作流状态联动见[状态联动](workflow-task-state.md)。CI、模型终态、PR 合并均不是任务完成。
- 流程决策在 `packages/application/src/task-code-delivery.ts`；Agent HTTP 仅适配当前 PM 授权、Git、GitHub 和已有 Chat。
- 当前权威任务文件、项目归属、归档和版本检查由 PM 读取。写操作要求已有 `planning.edit`（`pm_update_task` 能力）；读取要求当前任务可读。每次执行与原生运行授权分别回查任务权限／版本和独立 Agent 目录身份。
- 对应 INV-01/03/13/14/15/20、SC-03/12/13/14/20 与 INF-05/06/07 的部分路径；不宣称旧规范整个场景或 G3 已通过。
- **会话与持久化尚未统一设计，暂沿用 Agent Chat SQLite。** 只增加 `task-code-delivery-v1` 命名空间的关联收据，采用原存储的单进程所有权及事务 CAS；不是新的任务权威库。

## 使用条件与操作

1. 在 Agent 服务实际运行环境准备 Git、GitHub CLI `gh`、Git 提交身份、当前用户自己的 GitHub 认证及已就绪 Provider。不能把宿主机认证等同于容器认证；不自动挂载或复制全局凭据。
2. 在 Agent Chat 打开实际 Git 仓库**根目录**，准备交付时明确选择该独立 Agent Workspace；不要求目录归属于 PM 项目。多个仓库各自独立，不使用旧项目 file-area 或 PM 文档存储回退。`origin` 必须是无凭据 `https://github.com/owner/repo[.git]` 或 `git@github.com:owner/repo.git`，读取与推送地址一致。第一版不支持 Enterprise、SSH 别名、fork 或本地远端。
3. 保存一个项目内任务，在任务详情展开「代码交付 · GitHub」。明确填入实际远端基准分支，不能假定叫 `master` 或 `main`。空仓库需先由用户初始化基准分支。
4. 创建 `codex/task-<编号>-<交付ID前8位>`，固定 fetch 得到的 base SHA。工作目录在当前 Agent 数据目录 `task-worktrees/<deliveryId>`，不 checkout/reset/clean 用户原目录；保留原目录未提交修改。
5. 每次启动开发均由用户选择已有 Provider 和模型。交付收据绑定原 PM 任务、明确的业务授权和 v2 目录选择，服务端解析 owned worktree；普通 Session 本身不具有 PM 项目所有者，客户端 `custom`/cwd 不能改绑。会话中的 Files/Git/Terminal 根据交付收据定位 worktree。Codex 开发请求可显式确认 `allowWorktreeWrite: true`：应用服务先持久化本次确认，启动时按当前任务授权及 owned worktree 重新核验，才选择 `workspaceWrite`；普通 Chat、旧记录或未确认请求仍为只读。
6. 在原 Agent 会话查看开发、工具交互及输出。开发结束后点击刷新，再明确填写验证命令。执行上限 120 秒，使用最小进程环境；保存退出码、代码指纹、时间和输出摘要，不保存原始输出/凭据。**退出 0 只证明该命令成功，不证明验收标准覆盖充分。** 命令失败、超时或执行期间内容变化都不产生通过证据。
7. 审查完整变更文件清单、diff 和新增文件，分别确认**提交**、**推送**、**创建 Draft PR**。首次推送使用远端分支不存在的空 lease 条件，不重写任何已有分支。独立工作目录内变更合计最多 1000 文件/16 MiB，拒绝私有管理路径、凭据类文件和符号链接；不要在当前项目仓库广泛暂存。
8. 点击刷新读取 PR 当前 HEAD 的 check runs、commit statuses 和 reviews；分页有界且不接受不完整快照，读取期间 HEAD 改变则拒绝混合快照。无 CI 是「未发现」不是通过；旧 commit 的 review 标记旧版本，远端 HEAD 变化时提示原本地测试不覆盖它。刷新失败保留上次快照及采集时间，不当作最新结果。

旧 Session 清理后，可显式“新建会话”关联原交付：必须重新核验同一仓库与当前授权，保留之前的线程 ID、generation、测试和 Git 证据；该动作本身不启动模型、不重放提交或推送。正在执行、原操作未核对或仓库身份改变时拒绝替换。

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
