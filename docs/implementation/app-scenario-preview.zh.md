# IdeaBoard 场景与隔离 App 预览

日期：2026-11-02。目标是从产品内的真实需求任务生成可操作 Web App，不在场景预设中偷放成品。遵循 Markdown 核心 ADR、INV-01/03/13/14/15/20、SC-03/12/13/14/20；预览不是完成、审核、合并或生产部署。

## 使用路径

1. 在已绑定 GitHub 仓库的项目新建任务，点「使用这个场景」。它只原子填入 IdeaBoard 标题、需求、实现约束和验收清单；保留项目/状态/负责人。已有标题、正文或已发送的创建意图不可覆盖；仍使用原草稿保存与请求核对机制。
2. 编辑并保存任务，再选择「开发并交付」。用户启动时选择现有 Provider/模型，核对基准分支、npm test、必需 CI test，分别确认开发、提交、推送、Draft PR 和状态联动。
3. Agent 在自己的任务 worktree 开发，现有工作流留下测试、提交、Draft PR、同 SHA CI 证据。预设不是自动执行许可，不新增多任务并行或完整执行计划。
4. 交付产生 Draft PR 后，任务出现「App 成品预览」。启动前确认运行已提交的 app/server.mjs；只有健康检查成功才提供「打开 App」。CI 与预览各自展示，不用其中一个替代另一个。
5. 实际提交反馈、投票、筛选、调整路线图，然后停止/再次启动核对持久化。人工核对后再决定任务状态，不自动完成。

## 首版预览协议

仅支持当前 v4 Linux 环境下无依赖、UTF-8 文本源码的 Node App，非任意框架构建器。

- 固定入口 `app/server.mjs`，`GET /health` 返回 200。
- 优先监听 `PREVIEW_SOCKET` Unix socket；本地独立运行可用 HOST/PORT。业务数据只写 `DATA_DIR`。
- 只从已确认的 Git commit 导出 `app/` 普通文件；最多100文件、4 MiB，拒绝符号链接、隐藏文件、子模块及路径穿越。启动前验证工作目录身份、HEAD、干净状态、测试通过和 PR 收据。不传入客户端 cwd、脚本或 URL。
- 前端资源与 API 同源，外部 JS/CSS 文件，不用内联脚本、事件处理、eval 或 CDN。无第三方依赖，不自动 npm install。
- 演示数据独立于源码和 Chat，位置为 Agent 数据目录的 `task-preview-data/<deliveryId>`；停止不删除数据，进程状态不跨 Agent 重启恢复，也不会静默重启代码。

## 隔离和生命周期

- 需要 `/usr/bin/bwrap`、`/usr/bin/prlimit` 和 `/usr/local/bin/node`。不可用或命名空间受限则拒绝启动，绝不退回普通子进程运行 App。当前 Debian v4 专用容器从官方软件源安装 Bubblewrap，没有改变 privileged、全局 Docker、安全策略或其他副本。
- Bubblewrap 单独建立网络、PID、挂载等命名空间；只读挂载系统运行库和应用源码，独立业务数据可写；没有主机 home、/etc、/proc、PM 数据、Git 元数据或凭据。临时目录和 socket 也只存在隔离命名空间内。环境从空白显式构造。
- 可信 relay 与 App 同处隔离空间，通过父进程标准输入/输出交换有界 HTTP 消息。**主机不连接 App 可修改的 socket 路径**，避免应用用 symlink 将主机代理引向其他本地服务。App 输出不进入主机协议或 PM 日志。
- 独立 HTTP 入口默认监听本机 `127.0.0.1:4330`，以 `<deliveryId>.preview.localhost` 区分 App；不与 PM 共用主机名、Cookie 或 Authorization。拒绝错误 Host、跨源写入；只允许跨站顶层 GET 导航打开页面。请求仅透传必要内容类型与正文，响应不透传 Cookie、重定向或任意头；严格 CSP 限制资源、连接及表单同源。
- 最多3个同时运行预览；30分钟自动停止。启动健康检查有界，进程退出或刷新健康检查失败撤销链接；停止后再启动复用演示数据。请求64 KiB、响应4 MiB、并发32，进程有CPU/单文件/句柄及Node heap限额。
- 每次管理接口按当前 PM 登录、项目能力与权威任务核验；启动还核对需求版本。已授权用户即使需求版本变化仍可停止进程。不持久化登录凭据，不改变普通 Chat 权限。
- 这是本机 POC，不是生产多租户 Runner：没有完整 cgroup 总内存/PID/磁盘配额、租户隔离和公网认证。本机其他用户可能访问活动预览，**只用虚构数据**。不应将端口发布到公网。

Agent API：`GET /api/task-deliveries/:id/preview` 读取实际状态；`POST` 仅接受严格的 `{action:"start",head,confirm:true}` 或 `{action:"stop",confirm:true}`。通过原网关加 `/agent` 前缀。启动响应丢失先 GET 核对；重复启动同版本返回既有进程，不创建第二份。停止不删除业务数据。

## 持久化设计提醒

会话与持久化尚未统一设计，当前仍沿用 Agent Chat 基础存储。本次只增加演示 App 独立数据目录及进程生命周期，不宣称统一会话、备份恢复、生产 Runner 或业务完成设计收口。

## 验证记录

实现中的测试与真实场景验收分别记录；不把夹具测试冒充真实 Agent 交付。

### 最终检查结果

- 定向检查18项全部通过、无跳过，包含实际 Linux 隔离测试；Agent/Web lint、根类型检查、Agent类型检查（含测试）与构建、Web构建、PM后端构建通过。OpenAPI核对112个命令类型、95条路径；文档和 `git diff --check` 通过。Web保留既有大包及混合静态/动态导入警告。
- `pnpm check` **不是全绿**：426项中419通过、1失败、6跳过，停在测试阶段。失败为 `project-locations.test.ts` 的真实不可写目录用例：容器以root运行仍可写。将该文件以nobody身份独立复核，15项全部通过，但不将原整套失败改记为成功；构建另行执行并通过。
- `pnpm test:backend --file-timeout-ms 180000` 跑完129/129文件：899项，890通过、2失败、7跳过。失败为上述root权限用例和真实备份测试（容器中 `pg_dump` 不可用）；7项S3协议测试缺少独立夹具而跳过。运行器因此报告3个未通过文件，退出1。未通过/跳过均不计作验收成功，不为演示去修改断言或扩大环境权限。
- App自身的4项独立真实HTTP测试全部通过；产品管理接口与浏览器端到端另有下文证据。以上全量环境缺口不影响已实测的本机App展示，但不支持宣称生产就绪、完整备份恢复或S3验收完成。
- 全量结果：`.local/logs/ideaboard-backend-full.log`；基础检查：`ideaboard-final-checks.log`；定向/构建：`ideaboard-final-build.log`；非root权限复核：`ideaboard-nonroot-permissions.log`。本项目源码尚未提交/推送，保留先前并行修改；只在已授权隔离验收仓库生成App提交和Draft PR。

### 真实 App 端到端（2026-11-02，Asia/Shanghai）

- 通过新建任务页面的场景按钮填充并保存 `TASK-003`「IdeaBoard · 用户反馈与路线图 App」，在既有隔离项目 `96f238af-0c25-4c8c-b417-f11d9192e34b / PRJ-001` 启动 `builtin-deliver` v3，Provider 为现有 Codex / `gpt-6-sol`。
- Run / delivery：`5fa11d9c-b441-44a4-9e6c-210bcb19108b`；Agent 真实生成 `app/server.mjs`、`app/app.js`、`app/index.html`、`app/style.css` 和集成测试，更新 README/忽略规则，未替它预写成品。
- 分支 `codex/task-003-5fa11d9c`，SHA `d1b789e8168ada81e9f28a8d21d6b51228e2809f`。[Draft PR #3](https://github.com/MoyInGxing/pm-v4-delivery-smoke-20261031/pull/3) 为 OPEN/Draft；[acceptance-ci / test](https://github.com/MoyInGxing/pm-v4-delivery-smoke-20261031/actions/runs/41324910225/job/124902714722) SUCCESS，同 SHA，完成时间00:10:15。没有人工 GitHub review、合并或公网部署。
- Agent 沙箱拒绝监听端口及额外权限，保留这段失败/拒绝。Agent 测试在 EPERM 下回退为对同一 HTTP handler 的模拟请求，**这段不记为真实 HTTP 验收**。后续工作流的已授权验证命令和独立复核均在服务执行环境运行；独立复核记录了4个真实 `127.0.0.1` 临时监听端口，4项测试通过、0失败、0跳过。工作树干净，HEAD 与 PR 一致。
- CI 通过后，显式确认任务进入 `review`；工作流结束，不是 `done`。v4 应用服务重启后同一任务/运行仍可读，没有重新开发、提交、推送或创建 PR。
- 经产品按钮启动隔离预览，固定上述 SHA。浏览器实测：空白标题被拒绝；新增3条虚构反馈；投票→刷新仍为1票→取消为0票→再次投票；分类筛选、搜索空状态与票数排序；路线图三栏各有一条对应反馈。
- 从产品停止预览后，原地址返回不可用；再次启动后3条反馈、1票、三种状态均保留。390px宽度下页面和滚动宽度均为390，手机搜索可用；浏览器控制台未观察到 error/warn。
- v4服务整体重启后预览保持停止，不自动执行App；经产品再次显式启动，同一数据仍保留。验收证据已保存到TASK-003评论（11月2日00:21，v1），没有替代人工业务审核或标记完成。
- 当前预览地址为 [本机 IdeaBoard](http://5fa11d9c-b441-44a4-9e6c-210bcb19108b.preview.localhost:4330/)。30分钟有效期或服务重启后，从[任务详情](http://127.0.0.1:3224/pm/96f238af-0c25-4c8c-b417-f11d9192e34b/projects/PRJ-001/entities/TASK-003)重新启动；不是公网分享地址。

本机证据（忽略目录，不提交）：

- `.local/logs/ideaboard-app-desktop.png`、`ideaboard-app-mobile.png`：实际成品和390px验收。
- `.local/logs/ideaboard-task-delivery.png`、`ideaboard-task-evidence.json`：任务上的真实测试、PR、CI、运行中预览及验收评论。
- `.local/logs/ideaboard-app-independent-test.log`：真实 HTTP 监听、测试结果与 HEAD。
- `.local/logs/ideaboard-pr-3.json`：GitHub 独立读取的 PR/CI/SHA。
- `.local/logs/ideaboard-http-boundaries.log`：管理接口无登录401、跨源403、错误预览Host403、实际App健康200与安全头。
- `.local/logs/ideaboard-security-checks.log`：18项定向检查全通过，无跳过，包括真实 Linux namespace、只读代码、隐藏host/home、网络拒绝、凭据剥离、重启数据保留，以及恶意socket symlink不能到达主机socket。

### 演示讲解（建议使用已跑出的真实成果）

1. 新建任务展示 IdeaBoard 场景，强调只填入可编辑需求，**不要为讲解再启动一次**。
2. 打开 TASK-003，说明需求如何作为执行输入，查看 Agent 的真实开发过程及被拒绝的越界测试请求。
3. 打开 PR #3 与同 SHA CI，说明验证与发布由工作流处理，任务停在待审核。
4. 点「打开 App」，现场提交一条虚构反馈、投票并调整状态，展示路线图；最后停止/重启，证明数据不是页面内存假象。
5. 明确边界：本机 POC、有限框架、已有账号与仓库条件、非生产 Runner；会话持久化仍待统一设计。
