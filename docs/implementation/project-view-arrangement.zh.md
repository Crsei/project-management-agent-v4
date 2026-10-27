# 项目视图顶栏与任务工具栏重构记录

状态：已实现并接入正式 `/pm` 项目详情 · 日期：2026-10-22

参考对象：`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/UI-package/gr8r-studio` 项目页顶部：项目标题下方直接排列视图标签，标签下方是一条统一的任务工具栏，再往下才是当前视图内容。

## 1. 目标

把当前项目详情中混合的“任务 / Issue / 依赖”分区，改成参考站的视图标签结构：

`概览 · 看板 · 列表 · 表格 · 日历 · 时间线 · 关系图 · 文件 · 动态 · 评论`

并让工具栏、指标卡和视图内容按同一顺序排列：

1. 项目标题与元信息。
2. 视图标签。
3. 共享任务工具栏（仅任务型视图）。
4. 当前视图内容。

## 2. 已实现

| 项 | 结果 |
| --- | --- |
| 视图标签 | `board`、`list`、`table`、`calendar`、`timeline`、`graph` 成为一级标签；`detail1` 不含评论，`detail2` 含评论 |
| 工具栏 | 视图标签下方新增共享工具栏：搜索、状态筛选、排序（默认/标题/截止日期/优先级）、新建任务 |
| 视图内工具栏 | 看板/列表/表格的旧内部搜索与新建按钮隐藏，避免重复；日历/时间线/关系图复用同一筛选与排序结果 |
| 指标位置 | 指标卡从标签上方移到“概览”内容顶部，标签直接位于项目标题下方 |
| 概览布局 | 详情 1/2 共用同一组卡片网格：指标 + 目标成果 / 范围 / 项目简报 / 里程碑；不再使用简报页的纯文本稀疏布局 |
| 日历 | 新增项目日历视图，日期写入与时间线共用同一 Markdown task revision 和 `editing.schedule` |
| 旧链接 | `?tab=tasks` → 看板；`?tab=issues` + `taskView` → 列表/表格；`?tab=dependencies` → 关系图 |
| 显示偏好 | 现有 `projectTab` 的 `overview/list/board/table/timeline` 直接映射到新标签 |
| 视觉 | 标签改为紧凑排列（2px 间距、10px 左右内边距、12.5px 字号、36px 高）；详情 1/2 均调整 |
| 响应式 | 工具栏在窄屏换行；标签横向滚动；390px 无页面横向溢出 |

工具栏只提供真实可执行的控制：没有加入 Group、Columns 等当前没有对应状态/能力的按钮。

## 3. 主要文件

- `apps/web/src/views/pm/controlled-contracts.ts`：`ProjectDetailTab`、视图区域、`toolbar`、`metricsInOverview`。
- `apps/web/src/views/pm/project-detail.tsx`：新标签文案、工具栏插槽、指标位置开关、视图 fallback。
- `apps/web/src/features/pm/service/service-project-detail.tsx`：新标签顺序、旧 URL 映射、共享筛选/排序、视图区域。
- `apps/web/src/features/pm/service/project-task-toolbar.tsx`：共享工具栏。
- `apps/web/src/features/pm/service/service-project-detail-panels.tsx`：看板/列表隐藏内部工具栏，接受外部筛选结果。
- `apps/web/src/features/pm/service/project-task-editing.tsx`：`ProjectCalendar`、时间线/日历按可见任务 ID 过滤。
- `apps/web/src/features/pm/service/service-project-detail.module.css`：工具栏与概览指标位置样式。
- `apps/web/src/views/pm/project-detail-1.module.css`、`project-detail-2.module.css`：紧凑标签与工具栏相邻间距。

## 4. 验证

已运行并通过：

```bash
pnpm --filter @pm/web typecheck
pnpm --filter @pm/web lint
pnpm --filter @pm/web build
pnpm check:docs
```

以下是 2026-10-22 的历史布局验收：使用 `vite preview` 静态产物与实际 Chromium，API 由请求拦截注入固定响应，未读取任何账号凭据。它只证明布局，不证明真实写入、权限或恢复；真实服务增量验收另列在第 6 节：

- 详情 1 / 详情 2 标签顺序与选中状态正确。
- 看板、列表、表格、日历、时间线、关系图均能切换；共享工具栏只出现一次。
- 看板搜索 `API` 只保留 `TASK-2`；状态筛选 `in_progress` 只保留 `TASK-1`。
- 列表按截止日期排序为 `TASK-3 → TASK-2 → TASK-1`。
- 概览显示指标卡且无任务工具栏；看板显示任务工具栏且无指标卡。
- 390px 视口页面宽度等于视口宽度，标签与工具栏换行正常。

证据：

- `.local/evidence/project-views/project-views-board.png`
- `.local/evidence/project-views/project-views-final.png`
- `.local/evidence/project-views/project-views-detail2.png`
- `.local/evidence/project-views/project-views-mobile-board.png`
- `.local/evidence/project-views/project-views-overview.webp`
- `.local/evidence/project-views/project-views-overview-mobile.png`

## 5. 边界

- 未修改并行开发中的左侧项目视图导航；本次只调整项目详情顶部的标签、工具栏、指标和视图内容排列。
- 未新增 Group/Columns 等没有真实状态的控件。
- 日历视图没有独立的新建入口；统一使用共享工具栏的“新建任务”。
- 真实日期消费者的服务证据与恢复边界见第 6 节；历史固定响应截图不计入这些证据。

## 6. 真实日期消费者增量验收（2026-10-23）

### 权威与修复

项目日历和时间线都修改同一个 Markdown 文件，以 `FileRecord.revision` 进行 CAS；没有 SQL 日期副本、PM 命令收据替身或小时事件。日历适配器现在保留编辑器最初持有的完整 `FileRecord`，不会在保存时把它替换为最新查询结果。这样，服务端更新后的旧日期草稿必须走冲突处理或显式采用当前 revision，不能静默覆盖。对应 INV-01/13/14/20、SC-12/13/14/20 与 INF-03/05/06 的日期消费者分支，不表示遍历全部命令。

### 隔离服务与可重现方式

- 复用 `tests/dashboard-fixture.ts#createDashboardFixture`，通过 `node --env-file=.env` 消费环境；创建随机 PostgreSQL schema、临时 Markdown/blob 根目录和随机 loopback API 端口。不读取凭据文件，不修改既有业务夹具、默认 API/Worker 或其他服务。
- 真实浏览器使用自有 `127.0.0.57:3257` 与 `127.0.0.58:3258` 两个 Cookie host，分别登录同一隔离账号，避免其他验收服务跨端口覆盖身份。HTTP 边界使用独立真实登录，不能当作浏览器按钮证据。
- 夹具通过真实核心 HTTP 创建两个项目、项目 A 的两个任务、项目 B 的第三个任务；只读成员仅授予项目 A 的 `domain.read`。每笔日期写入后重读 `/core/files/TASK-001`，并逐字节比较该路径的实际 Markdown。原正文、未勾选验收项及扩展 `x-acceptance: preserve-me` 保持不变。
- 故障代理只转发真实服务请求；丢响应场景在读取完整真实上游 PATCH 响应后断开下游连接，不注入固定成功结果。请求计数、revision 与磁盘事实用于区分“成功后响应丢失”和“未派发”。开发 HMR 导致的排队与模块重载不冒充服务失败，也不触发重发。

### 已观察的真实 HTTP 边界

| 场景 | 实际结果 |
| --- | --- |
| 只读成员读取项目 A 日期 | 200，读取真实已授权文件 |
| 只读成员提交有效日期更新 | 403 `permission_denied`，revision 不变 |
| 只读成员读取项目 B 任务 | 404，不返回另一项目正文 |
| 两次写入使用同一旧 revision | 首次真实 PATCH 为 200；后续旧 revision 为 409，诊断为 `REVISION_CONFLICT` |
| 跨月日期写回 | 浏览器提交 `2026-10-31` 至 `2026-11-02`，服务随后读取为相同日期；Markdown 与 API 原文一致 |

机器证据位于 `.local/evidence/calendar-acceptance/matrix.json` 与 `native-requests.json`，只记录安全对象 ID、日期、revision、状态、路径与计数，不写 Cookie、token、密码或数据库 URL。浏览器使用父线程统一生成的 production `apps/web/dist`，由自有两个 `vite preview` 提供；本 slice 未运行 build/lint/tests/formatter。

### 实际浏览器操作矩阵

| 场景 | 实际结果 |
| --- | --- |
| detail1 日历 | 保存 `2026-10-31` 至 `2026-11-03`，随后“清除日期”并显式保存；两个字段均为空，重读同一文件一致 |
| detail1 时间线 | 保存跨年 `2026-12-31` 至 `2027-01-02`，清空并保存；另保存仅开始 `2026-11-01`、仅截止 `2026-11-02` |
| detail2 日历 | 保存覆盖闰日的 `2028-02-28` 至 `2028-03-01`，随后清空并保存 |
| detail2 时间线 | 保存覆盖洛杉矶夏令时边界的 `2027-03-13` 至 `2027-03-15`，随后清空并保存 |
| 时区代表例 | Chromium 分别设为 `Pacific/Kiritimati` 与 `America/Los_Angeles`；上述输入重读仍为原始 `YYYY-MM-DD`，没有转换成前一天或后一天，也没有写具体小时 |
| 项目共享筛选 | 项目 A 日历/时间线搜索 primary 均仅保留 `TASK-001`；不匹配状态仅剩空选择；清除搜索后为 A 的两任务，不出现 B 的 `TASK-003` |
| 工作区跨项目筛选 | 日历全部项目为三任务，筛选 A 为两任务、B 为一任务；切换时间线仍仅 B，清空项目筛选恢复三任务，选项显示真实归属 |
| 两个真实会话冲突 | `.57` 的日历保留 `10-30` 至 `11-04` 草稿，`.58` 的时间线写入 `10-29` 至 `11-03`；SSE 更新后日历提示旧版本，保存进入 conflict 且保留字段，没有替换服务端日期。点击“采用当前版本并保留字段草稿”后显式保存才写入本地日期 |
| 丢失真实成功响应 | `.58` 时间线提交 `11-01` 至 `11-05`；代理记录上游真实 200 与实际 revision 后断开响应，页面 unknown 并锁写，磁盘/API 已是这两个日期 |
| 原结果核对而非重发 | 刷新仍保留 unknown；点击“读取权威源核对”仅进入 observed，明确标为观察而非收据。该窗口的 PATCH 计数为 13→14，刷新、读取、显式放弃后仍为14；没有补发 |
| 只读成员 | 仅项目 A 的 `domain.read` 登录后，日历与时间线的日期输入、保存和清除均 disabled；其他项目任务不出现。真实 HTTP 的有效日期写入另验证为403 |
| 授权与撤销 | 真实授予 `planning.edit` 后刷新，日期输入可用；真实撤权后 SSE 清空任务和日期编辑器，权威读取为404。该轮页面使用通用 `invalid_response` 提示及“选择工作区”，已报告 RecoveryAcceptance；不把该提示文案冒充明确的撤权诊断 |
| 刷新与原文保留 | 最后刷新同一项目日历显示已保存的 `2026-11-02` 至 `2026-11-06`，API revision 与磁盘原文一致；所有记录的日期操作均保留正文、未勾选验收项和扩展字段 |
| 窄屏代表例 | 390×844 Chromium 视口中 `document.scrollWidth = innerWidth = 390`，已截图；只代表视口模拟，不代表物理触摸设备 |

`revision` 是原文内容散列；清空得到相同原文时可再次得到相同 revision，不将其当作单调递增计数。为强制制造服务端竞争而进行的一次额外浏览器请求暂挂尝试被工具的单 tab 忙碌保护中断，清理时请求真实完成为200，不计入 conflict 通过数；冲突证据是上表的真实双会话客户端拒绝及独立 HTTP 409，二者没有混为一项。

后续交叉核验：RecoveryAcceptance 报告其完整 `0020`–`0023` 隔离夹具与 production preview 下，真实撤权后内容同样清空，显示通用 HTTP404 页，未出现 `invalid_response`。本 slice 保留当轮截图事实，不将未在另一夹具重现的文案问题认定为当前全局缺陷；差异原因未确认，也不把该独立核验称为本 slice 再次运行。

截图索引（相对于 `.local/evidence/calendar-acceptance/`）：

- `detail1-calendar-range.png`、`detail1-timeline-range.png`
- `detail2-calendar-leap-range.png`、`detail2-timeline-DST-range.png`
- `detail2-calendar-filter-scope.png`、`workspace-cross-project-filter.png`
- `calendar-old-revision-conflict.png`
- `timeline-unknown-response.png`、`timeline-authoritative-observation.png`
- `reader-calendar-disabled.png`、`revoked-cleared.png`
- `final-saved-date-editor.png`、`calendar-mobile-emulated.png`

### 尚未覆盖与产品边界

- 本轮日期写回操作使用真实页面的日期编辑控件；没有把指针拖动/缩放事件的完整组合矩阵、真实触摸、IME 或所有 IANA 时区算作已验收。
- 只读/撤权、旧 revision 与丢响应分别取得了上述有界实例，不声称四种 detail×日期视图的每种故障交叉乘积都逐项重复。
- 小时排期、重复任务的生成/时区策略、外部日历同步仍未支持；沿用全天日期与包含截止日的合同。物理设备、公网部署和完整 G2/全部命令恢复属于其他验收边界。

### 自有资源清理

已关闭本 slice 的两个最终浏览器 tab、两个 preview、开发服务及 API/故障代理。三轮隔离 fixture 的 schema 与临时核心/blob 根目录均已删除；第一次启动的残留由明确列出的自有 schema/root 清理，最终 fixture 正常关闭后没有残留。失败的自有 Chromium profile 与临时冒烟脚本也已删除。`cleanup.json` 记录所有自有 schema/root 的 `existsAfterCleanup:false`，八个自有 API/代理/前端地址均 `respondsAfterShutdown:false`。既有默认服务和业务文件未参与验收或清理。
