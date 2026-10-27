# 浏览器身份隔离与写入恢复验收

本专项对应 INV-01/13/14/20、SC-12/13/14/20 的人工客户端部分及 INF-03/05/06，不代表全部命令/所有分支或完整 G2 通过。真实 Agent、公开生产环境和硬件验收不在本记录中。

## 实现与修复

- 查询缓存、命令状态按后端 origin、actor、workspace 和成员版本/会话 epoch 隔离。切换真实身份先卸载旧 actor，再恢复新 actor 的记录；成员历史比较也按 actor 隔离。
- 退出/撤权立即清空可见查询、收据与完成缓存，但不删除可能已提交的未知命令 journal，更不能删除其他标签页的记录。只有同一 actor/backend/workspace/tab 恢复原 commandId；收到原收据后才清除该恢复意图。
- 全局原命令恢复入口在内容页、首页等工作区路由都可见；局部面板不再重复渲染第二个恢复按钮。
- SSE 410 后保留旧游标，先完成授权权威快照读取，再提交新水位、续订。需要恢复的查询在取消前固定；直接 `fetchQuery` 不把被取消的读取误当成功。路由切换可能暂时没有任何 active query，此时仍必须实际读取核心工作区，不能把空观察者集合当作已读快照。
- 流连接回调捕获所属订阅，不再比较可能已由超时控制器组合过的 AbortSignal 对象。旧订阅的迟到响应不能更新新会话状态。
- 父线程负责的 contracts 客户端增加 45 秒无数据超时；任意真实字节（包括注释心跳）续期，超时终止实际读取后由现有重连逻辑恢复，不推进游标或自动重发写入。

## 隔离环境与故障方式

使用随机 PostgreSQL schema `accept_recovery_bfc57f4c4f7b4393a3958dfa70f4ad0c`、临时 Markdown/blob 根目录、API 4167、自有 Web 3367 与独立 Worker；最终浏览器使用父线程构建产物的 Vite preview。两个真实独立 Chromium browserContext 隔离 cookie，未清除共享浏览器其他会话。默认 API/Worker/Web 和业务文件没有作为夹具。

真实成功全部来自服务：SQL 响应丢失发生在实际 `command_receipts` 已 committed 之后；原生响应丢失保留实际文件 ID/revision，随后重新读取权威文件。失败注入仅在自有 API 拒绝 `core/workspace`（真实 HTTP 503）、关闭自有 HTTP/SSE 连接或删除自有 schema 的事件保留行；没有返回拦截的成功响应。

## 已观察情境与边界

| 情境 | 实际观察 | 未扩大的范围 |
| --- | --- | --- |
| Owner → 退出 → Reader → Owner | 退出页面没有旧项目/原命令 ID；Reader 只见授权项目，不能读取 Owner 原收据（404）；Owner 再登录恢复同一原 commandId | 不代表所有账号安全策略；会话 token 撤销后的旧流由 AccountSecurity 专项覆盖 |
| 不同工作区 | 通过真实切换菜单进入 B，A 的私有项目/任务不出现；Reader 直访未授权 B 无业务快照 | 两个工作区、两个账号的有界矩阵，不是任意租户规模证明 |
| SQL 提交成功、响应丢失 | `CreateConversation` 的原 ID `dbd2ae1b-266e-4ca2-b226-acc550f5a72d` 在刷新和重新登录后保留；内容标签页有唯一恢复按钮；点击仅发送原 ID 的 GET 收据请求 | 不将一个命令推为全量命令分支验收 |
| 原生 Markdown 创建响应丢失 | `TASK-003` 与 revision `03e7e93b769b9d0d9a449d6b77475b01efefca0ef04a6ee6cbde5bc677ee392e` 真实提交；原请求键 `4f93cd39-7464-49ab-8470-c492f031a86f`、标题及完整正文刷新保留；GET creation-attempt 后进入同一 ID，权威快照只有一个同名文件 | 原生创建结果不是 PM SQL command receipt；没有重发 POST |
| 原生 PATCH 未知结果 | CalendarAcceptance 独立证据：上游真实 200 后丢响应；刷新后读取权威源、明确 observation-not-a-receipt，再显式放弃；PATCH 次数 13→14，恢复后仍 14 | 引用独立同轮证据，不冒充本 slice 重新执行 |
| 真正断线与代理静默 | 停止自有浏览器侧 HTTP 服务后显示重连；仅切断 API 上游但代理悬挂时，45 秒 watchdog 后也显示重连；恢复后从旧 `after=6` 续订，草稿未覆盖 | 不声称大规模慢客户端、代理容量或公网网络设备通过 |
| 410 与快照 503 | 实际保留窗失效 `after=9` 返回 410；最终产物在 18:10:37 与 18:11:07/08 多次实际快照 503 后持续显示重新同步，未误报 Live；移除故障后才于 18:11:38 续订 `after=10`，权威读取 200、错误提示消失、草稿与冲突保留 | 已保留空 active query 缺陷的 fail-before/pass-after，不以瞬间状态冒充收敛 |
| 订阅后成员撤权 | Reader 先处于 Live，真实 RevokeWorkspaceMember 后所有项目/任务内容清空；直读 `core/files/TASK-001` 返回 404 `not_found_or_forbidden` | 只覆盖成员撤权，不替代改密/撤销 token 的安全专项 |
| 本地草稿与远端 revision | `LOCAL_DRAFT_RETAINED_AFTER_410_503` 经过真实断线、外部原生 PATCH、失败快照及恢复仍保留；权威标题为 `REMOTE_AFTER_RECONNECT`，页面显示源码已变更/比较版本，未静默覆盖 | 不宣称逐键协作或跨标签页实时锁 |

证据位于 `.local/evidence/recovery-acceptance/`，包含机器矩阵、实际服务事实与截图；Calendar 的 PATCH 证据为 `.local/evidence/calendar-acceptance/matrix.json`、`native-requests.json`。机器记录不含 cookie、密码、token 或数据库 URL。

清理事实见同目录 `cleanup.json`：初次和最终两个自有 schema 均经实际 PostgreSQL 显式清理后不存在；自有 API/Worker/Chrome PID 和临时根目录均不存在，两个 browserContext 已关闭，preview 已停止，临时冒烟/清理脚本已删除。退出服务本身未被直接当作 schema 已清理的证明。

## 可重现步骤

1. 参照 `tests/dashboard-fixture.ts` 的真实隔离方案，新建随机 schema、临时 core/blob 根目录，创建 owner、仅获一个项目 `domain.read` 的 reader，以及两个工作区；用 `.env` 仅作为 Node 运行环境，不读取或打印其中秘密。自有端口启动 API/Worker，Web preview 只代理自有 API。
2. 使用独立 browserContext。Owner 从项目对象“业务 → 人工对话”输入并保存；在服务端提交收据后断下游响应。核对原收据 committed 和同名实体数量，再刷新、退出、Reader 登录、Owner 重新登录，逐步检查旧数据不可见与原 commandId 保留；点击全局“查询原命令收据”，记录请求只有 GET。
3. 在项目“新建任务”输入标题与完整 Markdown；服务完成原生文件写入后断响应。记录实际 ID/revision/key，刷新并接受真实离页提示，核对草稿和 key，点击“核对原生创建结果”；只读原请求结果，不重新 POST，重新读取核心快照核对单个同名文件。
4. 保留未保存源码草稿。关闭自有 Web 连接，同时通过 API 提交新的 SQL 事件、通过原生 PATCH 修改已保存标题；等待 Worker 持久发布，再删除该 schema 该工作区的事件保留行。开启只针对自有 `core/workspace` 的 503 故障，重启自有 Web；确认真实 410、可见重新同步、草稿不变，且 503 未恢复前不能宣称 Live。移除故障，确认实际快照读取成功后才续订新水位并显示冲突/收敛。
5. 单独切断自有 API 上游 SSE，让真实代理下游悬挂；保留服务断开时间与订阅游标。45 秒无字节后应终止读流、显示重连；服务恢复后从旧游标读取实际 Worker 事件。
6. Reader 已订阅并显示 Live 后，由 Owner 执行带版本的真实 RevokeWorkspaceMember；确认页面旧事实清空、直接读取 404。最后关闭自有 browserContext/进程，删除自有 schema/临时根目录，保留脱敏证据。

## 整体 G2 仍缺的矩阵

本轮不关闭整个 G2：所有现行命令各自的成功/拒绝/未知结果/幂等冲突、全部原生修改/归档/删除/迁移的故障分支、新增服务各自的完整权限/异常矩阵、全路由与真实设备输入/触摸、SSE 慢客户端与负载、公开生产部署与存储/HA 拓扑均不是本专项的全量证明。AccountSecurity、Files、Calendar、Inbox、Comments、Workspace 与 Release 的实际独立结果由父线程统一汇总；某个专项通过不替代其他退出条件。
