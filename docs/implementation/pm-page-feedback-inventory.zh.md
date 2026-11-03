> 2026-11-02 实施更新：本文是迁移前基线。右上角通知中心已落地；当前逐页行为见 [PM 右上角通知中心](pm-notice-center.zh.md)。下文“没有统一 toast / 只有三处浮层”等描述仅用于历史对照，不再代表当前实现。

# PM 页面操作与状态提醒清单

日期：2026-11-02。范围：正式 `/pm` 产品路由的当前前端行为，含工作区、Dashboard、项目、任务、文档、视图、成员、通知、白板、设置、账号与邀请页面；`/lab/pm` 仅作为组件演示在设置章节点出。`/agent/*` 独立应用不在此清单内，除非它由 PM 路由或 PM 侧栏打开。

依据：当前工作树源码（HEAD `5691034`，含并行未提交修改）。本文只记录已存在的提醒方式，不把 Lab 演示或不可用接口写成已交付能力。

## 1. 结论

- PM **没有统一 toast 系统**：未使用 sonner、`useToast` 或全局 `Toaster`。
- 提醒主体是 **行内 `role="status"` / `role="alert"`**，其次是 **全局壳层横幅**；多数命令成功后没有专门提示，只更新列表或状态。
- 真正的浮层提醒只有三处：
  1. 旧集合/实体工作台（任务、视图、实体页等）的底部居中 toast；
  2. 项目菜单的右下角固定通知；
  3. 设置中心“设计系统”演示页的右下角 toast。
- **没有跨页的新通知弹窗、侧栏未读角标或浏览器通知**。新通知只出现在 `/notifications` 页，且该页每 30 秒轮询刷新。
- 反馈文案、是否自动消失、是否可关闭、中文/英文并不统一；部分成功提示为英文硬编码。

## 2. 提醒机制

| 机制 | 出现范围 | 触发 | 表现 |
| --- | --- | --- | --- |
| 壳层横幅 | 所有 PM 页面 | 断网；SSE 中断或重同步；`service.error` | 内容区顶部常驻横条，恢复后消失 |
| `CommandNotice` | 概览、项目、成员、通知、任务编辑等 | 命令提交中；命令错误；结果未知 | 行内 status/alert；结果未知时显示原请求 ID 并要求核对原收据，不自动重试 |
| `QueryNotice` / `DataRegion` | 几乎所有读取页 | 加载中；刷新失败；保留上次快照；空结果 | 行内提示与重试按钮 |
| 页面/弹窗行内提示 | 多数业务页 | 保存、版本冲突、校验、权限、未知结果、只读、锁定 | `role="status"` 或 `role="alert"` |
| 浮动短时提示 | 见第 3 节 | 保存、收藏、复制链接、演示 Toast | toast 或 fixed 通知，见各页 |
| 浏览器原生确认 | 文档来源设置、任务代码交付、项目文件、工作流编辑 | 放弃草稿、解除来源、推送/PR、采用文件基线 | `window.confirm` 模态 |

## 3. 浮动与短时提示

| 位置 | 触发 | 行为 |
| --- | --- | --- |
| 旧集合/实体工作台底部居中 toast | 保存 Markdown；字段 patch（含状态、优先级、负责人、日期）；清单勾选；归档/恢复/删除；保存视图；手动排序；复制 Agent 上下文；集合内新建成功或创建到当前筛选外 | 约 5 秒自动消失；内容取自 `WorkspaceDialogs`；除“复制 Agent 上下文”外，成功文案为英文硬编码 |
| 项目菜单右下角 fixed 通知 | 收藏/取消收藏；复制项目链接；未知的项目复制命令 | 手动关闭；失败为 alert；未知命令附“打开原复制恢复” |
| 项目文件页内 notice | 复制文件链接；开始下载；上传被权限阻止；复制/下载/核对错误 | 约 2.6 秒自动清空；上传失败另在队列行内显示 |
| 文件预览对话框 notice | 复制链接成功/失败 | 约 2.6 秒自动清空 |
| 设置中心“设计系统”toast | 点击“成功 Toast / 错误 Toast”或命令菜单 | 右下角固定，手动关闭；明确标注仅本页演示 |
| 浏览器原生确认 | 文档来源设置丢弃/解除；任务代码交付创建分支、启动 Provider、执行、推送、创建 Draft PR；项目文件明确采用当前成果基线；工作流编辑放弃草稿 | 原生 `window.confirm`，取消则不发请求 |

## 4. 逐页清单

| 页面 | 会提醒的触发 | 形式与位置 |
| --- | --- | --- |
| `/pm` 登录/选择工作区 | 登录失败；会话检查失败；工作区读取失败；确认当前无会话 | 表单下方 Alert（error/warning）；行内 status；登录成功直接跳转，无成功提示 |
| `/pm/:workspace/home` | 工作区/个人资料/活动读取失败并保留旧快照；工作流配置无效；源码被排除；无新建任务权限 | 页内 alert/status + 重试；按钮成功仅导航 |
| `/pm/:workspace/dashboard`（4 种视图） | 部分快照失败或刷新中；依赖增删；个人便签/会议/计时命令；项目不可用；查询失败 | `QueryNotice` 保留上次快照；`CommandNotice`；面板内 `localError`；无保存成功 toast |
| 项目目录与侧栏 | 收藏/取消收藏；复制链接；侧栏项目排序；搜索无匹配；收藏读取失败；展开偏好保存失败 | 收藏/复制 → 右下角 fixed 通知；排序保存/失败/未知 → 侧栏行内；搜索/读取 → 行内 status/alert |
| 项目详情：概览/看板/列表/表格/日历/时间线/树/图 | 看板拖动；行内字段保存；版本冲突；写锁定；日历/时间线保存日期；源文件诊断；项目菜单命令 | 任务字段草稿阶段 → `ProjectTaskEditingNotice` 行内；日期保存 → “正在保存日期…”；收藏/复制 → 右下角通知；诊断/命令 → feedback 内 alert 或 `CommandNotice`；无成功 toast |
| 项目详情：分享/设置/生命周期/复制/归档/删除 | 复制项目链接；授权范围保存；邀请创建；项目设置保存；生命周期确认；复制结果未知 | 分享弹窗内 status/alert；设置与生命周期弹窗内错误与恢复入口；未知复制命令在项目菜单通知中恢复 |
| 项目详情：文件 | 上传被禁止；上传失败；复制链接；开始下载；核对上传收据错误；采用当前成果基线 | 页内 notice（约 2.6 秒）；上传队列行内进度/错误；采用基线 → `window.confirm` |
| 项目详情：Agent 侧栏 | 会话读取、设置保存、切换会话失败 | 侧栏行内 alert；不弹全局 toast |
| `/pm/:workspace/issues`、`/views`、`/entities/:id`（旧 Markdown 集合/实体工作台） | 保存、字段 patch、状态切换/完成、清单勾选、归档/恢复/删除、保存视图、手动排序、复制 Agent 上下文、集合内新建 | 底部居中 toast（约 5 秒）；创建超出筛选范围时 toast 带“打开”；保存冲突/关闭未保存 → 模态 + 行内 alert；读取/配置/只读/写锁定 → 顶部 error banner 或行内 status |
| 任务详情（实体页或面板） | 修改状态/优先级/负责人/日期；复制任务链接；评论、工作流、代码交付错误 | 字段修改触发工作台 toast；“未保存/已保存”为常驻行内状态；复制链接为行内 status；评论/工作流/交付为行内 alert；推送/PR 前原生确认 |
| `/pm/:workspace/issues/new` 新建任务 | 字段校验；子任务/关注/项目权限；草稿备份失败；创建阶段；结果未知 | 全部行内 status/alert；完成后跳转，无成功 toast |
| `/pm/:workspace/documents` 文档列表与工作台 | 旧集合内新建/保存；新文档工作台保存中/未知/失败、恢复记录、快照过期、关闭未保存；外部目录扫描不完整；来源预检/保存 | 旧集合沿用工作台 toast；新文档工作台只有行内保存状态与恢复条，无 toast；来源设置行内 status；丢弃/解除关联 → `window.confirm` |
| `/pm/:workspace/notifications` | 标为已读/未读；归档；全部标已读；采集未追平；刷新失败 | `CommandNotice` 显示提交中/错误/未知 + 请求 ID；成功仅列表更新，无 toast；安全说明常驻 status；每 30 秒轮询 |
| `/pm/:workspace/members` 成员/团队/工作量 | 复制联系方式；授权保存；邀请保存；版本冲突；邀请撤销/重发；SMTP 未配置；目录/邀请读取失败 | 复制回执行内 status；保存/冲突行内；邀请操作弹窗内状态；查询错误 alert |
| `/pm/:workspace/whiteboard` | 本地保存状态变化；localStorage 失败；导入失败 | 行内“已保存到本地/未保存”；失败为 alert |
| `/pm/:workspace/settings/profile`、`workspace` | 保存回执；版本冲突；读取失败 | 行内 status/alert |
| 设置中心：密码/会话/2FA | 修改成功；撤销数量；拒绝原因；未知结果；浏览器恢复存储失败 | `StatusNotice` 或行内 status/alert；存储失败时禁止提交 |
| 设置中心：外观/语言/日期时间/偏好 | 立即生效；浏览器存储不可用；恢复安全默认值 | 行内 status/alert |
| 设置中心：通知偏好及邮件/推送/提及/分派 | Service 模式无真实接口，保存按钮禁用；Lab 模式仅内存预览 | 没有真实保存反馈；Lab 演示有行内 status |
| 设置中心：常规/账单/方案/发票 | 均为演示或只读；不调用真实账单、支付或订阅服务 | 页内示例回执；无全局 toast |
| 设置中心：设计系统 | 点击成功/错误 Toast、命令菜单、确认示例 | 右下角 demo toast（手动关闭）；页内示例回执 |
| 设置中心：插件 | SMTP/Webhook 状态；投递详情；Open 原投递核对 | 状态行内；无成功 toast |
| 设置中心：项目/成员/团队/权限 | 读取失败；导航到真实对象页；不直接执行归档/删除 | 行内错误与说明；命令结果由目标页反馈 |
| `/pm/account/security`、`recovery`、`verify-recovery-email` | 密码重置；撤销会话；恢复邮箱结果；未知结果；限流；存储不可用 | `StatusNotice` 或行内 status/alert；未知结果提示先核对原请求 |
| `/pm/invitations/accept` | 缺少令牌；检查中；接受确认；接受后普通登录失败 | alert/status；接受成功显示确认区 |
| 错误页/404 | 401/403/404/500/503 | 错误码、request ID、返回/重试入口 |

## 5. 状态变化类提醒

| 状态变化 | 提醒 |
| --- | --- |
| 断网、SSE 中断/重同步 | 全局顶部横幅，提示上次快照可能过期，未知写入仍需核对原收据 |
| 读取刷新失败但已有数据 | 页内提示保留上次快照，不清空内容 |
| 命令提交中/结果未知 | `CommandNotice` 显示状态与原请求 ID；禁止自动重试或重放 |
| 编辑期间服务端版本变化 | 冲突提示保留草稿，要求比较后显式采用当前版本；不自动合并 |
| 有写入待确认或结果未知 | 工作台显示写入锁定提示，任务字段/看板/日历暂停新写入 |
| 浏览器草稿存储失败 | 行内 alert 要求保留页面，禁止发送或继续写入 |
| 文档保存结果未知/恢复记录 | 文档标签页与恢复条显示保存中/未知/需处理；提供读取权威源核对 |
| 通知采集/路由未追平 | 通知页 status 说明当前列表不代表完整处理结果 |
| 通知页数据刷新 | 每 30 秒轮询；无跨页未读提示 |
| 白板本地保存 | 行内显示“已保存到本地/未保存”，不声称服务端保存 |
| 工作流配置无效/源码诊断 | 统计、写入或编辑被禁用并显示修复入口，不使用默认规则推算 |

## 6. 当前缺口

1. **通知闭环缺失**：其他页面不会弹新通知，侧栏没有未读数角标；用户必须主动进入“活动”页。
2. **成功反馈不一致**：通知已读/归档、多数设置保存、看板拖动、任务创建成功没有明确成功提示。
3. **工作台 toast 未本地化**：保存、字段修改、清单、归档/删除、视图保存、手动排序成功文案为英文硬编码；仅“复制 Agent 上下文”按语言显示。
4. **时效不统一**：工作台 toast 约 5 秒；项目文件 notice 约 2.6 秒；项目菜单通知和设计系统 toast 需手动关闭。
5. **演示样式接近真实成功**：常规、账单、方案、发票、通知偏好、设计系统在 Service 模式明确标注 demo/不可用，但视觉上仍使用成功回执样式，容易误读。
6. **通知页无操作成功回执**：已读/归档成功只反映在列表状态；结果未知时才有提示和原请求 ID。

## 7. 证据索引

| 行为 | 主要源码位置 |
| --- | --- |
| 工作台 toast 渲染与 5 秒清除 | `apps/web/src/features/pm/markdown/WorkspaceDialogs.tsx`、`markdown/controller.ts` |
| 工作台 toast 样式 | `apps/web/src/features/pm/markdown/markdown.css` |
| 项目菜单右下角通知 | `apps/web/src/features/pm/service/project-menu.tsx` |
| 项目文件 notice 与 2.6 秒清除 | `apps/web/src/features/pm/service/project-files/index.tsx`、`project-files/FilePreviewDialog.tsx` |
| 设计系统 demo toast | `apps/web/src/features/pm/service/settings/settings-design-system.tsx` |
| 全局离线/重连/服务错误横幅 | `apps/web/src/features/pm/pm-shell.tsx` |
| 命令与查询行内反馈 | `apps/web/src/features/pm/service/pm-ui.tsx` |
| 通知命令反馈 | `apps/web/src/features/pm/service/service-notifications.tsx`、`pm-notification-hooks.ts` |
| 项目任务草稿/冲突提示 | `apps/web/src/features/pm/service/project-task-editing.tsx` |
| 看板/日历/时间线行内提示 | `apps/web/src/features/pm/components/service-board.tsx`、`service-calendar.tsx`、`service-gantt.tsx` |
| 白板本地保存/错误 | `apps/web/src/features/pm/components/service-whiteboard.tsx` |
| 文档工作台保存/恢复提示 | `apps/web/src/features/pm/markdown/DocumentWorkbench.tsx`、`DocumentTabs.tsx` |
