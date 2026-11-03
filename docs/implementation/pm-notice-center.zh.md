# PM 右上角通知中心

日期：2026-11-02。状态：已实现并通过针对性 lint、模型测试、Vite 构建与隔离端口浏览器验证。本文同时记录每个 PM 页面会进入通知中心的内容，以及仍然保留在页面内、属于字段/冲突/确认语义的反馈。

## 1. 目标与边界

- 页面运行期间，非上下文绑定的状态与操作反馈统一进入顶栏右侧的通知中心。
- 通知中心默认**不自动展开**：新消息只改变角标；用户点击铃铛后才显示列表。
- 通知面板使用 Portal + fixed 定位，不占文档流，不改变主内容区高度或位置。
- 通知只在当前浏览器会话内存中保存；不写数据库、不写账号、不跨设备同步。
- 业务通知仍由 `/pm/<workspace>/notifications` 承载；两者不合并。
- 字段校验、保存状态、冲突处理、破坏性确认继续留在原控件或模态内；这些提示与具体输入绑定，搬到全局面板会失去上下文。

## 2. 交互规则

| 规则 | 行为 |
| --- | --- |
| 打开方式 | 只通过顶栏铃铛点击展开；不自动弹出 |
| 角标 | 未读消息计数；未解决的 warning/error 即使已读也继续计数，直到解决 |
| 排序 | 未解决在前，其后按创建时间倒序 |
| 去重 | 同一 `key` 的状态更新原条目；不追加重复行 |
| 解决 | 连接恢复、命令成功后条目标记“已解决”；仍保留在列表，可清除 |
| 关闭 | 普通条目可关闭；未解决的 sticky 条目不可关闭 |
| 批量操作 | “全部已读”只改变已读状态；“清除已解决”只删除已解决条目 |
| 上限 | 50 条；超出时优先丢弃最旧的已解决条目，再丢弃最旧的非 sticky 条目 |
| 静默读取 | `silent` 条目只进入列表，不增加角标；适合“正在读取”等后台状态 |
| 瞬态读取 | `transient` 条目在状态解决时直接移除，不保留“已解决”的加载行 |
| 语言 | 标题、详情、操作按钮按当前界面语言显示 |
| 可访问性 | 铃铛有 `aria-label`；新 warning/error 通过隐藏 `aria-live` 播报；Popover 由现有焦点层管理 |

## 3. 实现位置

| 文件 | 作用 |
| --- | --- |
| `apps/web/src/features/pm/service/pm-notice-center-model.ts` | 纯状态模型：upsert、resolve、read、dismiss、cap、排序 |
| `apps/web/src/features/pm/service/pm-notice-center-model.test.ts` | 去重、已读、解决、sticky、清理与上限测试 |
| `apps/web/src/features/pm/service/pm-notice-center.tsx` | Provider、`usePmNoticeCenter`、铃铛与右上角 Popover |
| `apps/web/src/features/pm/pm-shell.tsx` | 挂载 Provider；顶栏铃铛；离线/SSE/服务错误写入；登录页工具栏铃铛 |
| `apps/web/src/features/pm/service/pm-ui.tsx` | `PmCommandRecovery` 统一桥接命令错误与未知命令；`CommandNotice` 保留为空挂载点 |
| `apps/web/src/features/pm/markdown/WorkspaceDialogs.tsx` | 旧集合/实体工作台成功 toast 迁移为通知 |
| `apps/web/src/features/pm/service/project-menu.tsx` | 收藏、复制链接、项目复制未知、侧栏排序反馈迁移 |
| `apps/web/src/features/pm/service/project-sidebar-order.ts` | 排序成功/失败写入通知中心 |
| `apps/web/src/features/pm/service/project-files/index.tsx` | 文件复制链接、下载、上传核对与基线错误迁移 |
| `apps/web/src/features/pm/service/project-files/FilePreviewDialog.tsx` | 文件预览复制链接反馈迁移 |
| `apps/web/src/features/pm/service/service-project-list.tsx` | “全部项目”补充读取状态迁移；加载态静默/瞬态，错误可重试 |

## 4. 逐页内容

“通知中心”列是点击右上角铃铛后可见的内容；“页面内保留”列是刻意不迁移的上下文反馈。

| 页面 | 通知中心会显示 | 页面内保留 |
| --- | --- | --- |
| `/pm` 登录/工作区选择 | 离线；SSE 中断/重同步；会话或服务错误 | 登录失败、找回密码/邀请提示、工作区读取失败、退出失败 |
| `/pm/:workspace/home` | 离线/重连；服务错误；任何命令失败；未知命令 | 工作区/个人资料/动态读取失败与旧快照提示；配置无效；源码排除；无新建权限原因 |
| `/pm/:workspace/dashboard` | 离线/重连；服务错误；依赖增删等命令失败；未知命令 | 面板查询失败/旧快照；项目不可用；个人便签/会议/计时的行内错误；工作流配置错误 |
| `/pm/:workspace/projects` | 离线/重连；服务错误；命令失败；收藏/取消收藏；复制项目链接成功或失败；项目复制结果未知；**正在读取项目数据**（项目任务/里程碑/收藏封面/项目身份团队/健康评估，静默且加载完成后移除）；补充读取失败+重试 | 项目主列表加载；侧栏“正在读取收藏…”；搜索无匹配；展开偏好保存失败 |
| `/pm/:workspace/projects/:projectId` 及其 `/overview`、`/issues`、`/files`、`/activity` 子路由 | 同项目目录；项目菜单操作；侧栏排序成功/失败；文件复制链接、下载开始/失败、上传核对失败、文件基线错误；未知项目复制；项目访问记录未确认+核对原访问记录（仅真实失败时；路由缺失的 404 视为可选能力不可用，不显示） | 看板拖动/行内字段草稿阶段；日期保存中；任务字段冲突/写锁定；源文件诊断；分享/设置/生命周期弹窗内的回执与错误；文件列表读取失败；上传队列行内进度/错误；Agent 侧栏错误 |
| 项目文件页（`/files`） | 上传被权限阻止；复制文件链接；开始下载；下载失败；原上传请求核对失败；文件基线确认失败 | 文件读取失败/旧快照；未找到文件；历史读取失败；上传队列每行错误 |
| `/pm/:workspace/issues`、`/views`、`/entities/:id`（旧集合/实体工作台） | 保存成功；字段/状态/优先级/负责人/日期更新成功；清单勾选保存；归档/恢复/删除；保存视图；手动排序；复制 Agent 上下文；集合内新建成功/创建到当前筛选外；命令失败；未知命令 | 读取失败横幅；配置无效；只读；写入锁定；草稿恢复存储失败；版本冲突模态；关闭未保存模态；视图无效；任务字段草稿状态 |
| `/pm/:workspace/issues/new` 新建任务 | 命令失败；未知命令（如关注/创建相关命令） | 字段校验；项目/负责人权限；草稿备份失败；创建阶段与未知结果；“所有请求均已确认” |
| `/pm/:workspace/documents` 文档集合 | 旧集合工作台的保存/创建/归档等成功通知；命令失败；未知命令 | 原生文档工作台保存中/未知/失败；文档恢复记录；快照过期；关闭未保存；外部目录扫描不完整/来源不可用；来源预检/保存消息 |
| `/pm/:workspace/notifications` | 通知已读/归档等命令失败；未知命令 | 通知安全说明；采集/路由未追平；列表读取失败/旧快照；已读/归档成功只更新列表，不产生成功通知 |
| `/pm/:workspace/members` | 成员/邀请相关命令失败；未知命令 | 复制联系方式回执；授权/邀请保存确认；版本冲突保留草稿；SMTP 未配置；目录/邀请读取失败；工作量与容量行内错误 |
| `/pm/:workspace/whiteboard` | 无 | 本地保存状态；localStorage 失败；导入失败 |
| `/pm/:workspace/settings/*` | 设置相关命令失败；未知命令 | 个人资料/工作区身份保存回执；冲突；读取失败；密码/会话/恢复邮箱结果；浏览器存储不可用/已恢复默认值；演示页回执；设计系统页 demo toast |
| `/pm/:workspace/settings/notifications` 及通知子页 | 无真实保存命令 | Service 模式接口不可用，按钮禁用；Lab 演示使用本页内存回执 |
| `/pm/account/security`、`/pm/account/recovery`、`/pm/account/verify-recovery-email` | 无 | 密码/会话/恢复邮箱结果；未知结果；限流；恢复存储不可用 |
| `/pm/invitations/accept` | 无 | 缺少令牌；检查中；接受确认；接受后普通登录失败 |
| 错误页/404 | 不显示通知中心（整页错误态） | 错误码、request ID、重试/返回 |


## 4.1 加载/读取状态

主数据读取的整页/区域骨架承担占位作用，继续留在原位置；叠加在已有内容之上、会额外插入一行的补充读取（`QueryNotice`、首页 `HomeReadNotice`、全部项目页补充读取）迁入通知中心。读取中条目使用 `silent + transient`：不增加角标，加载完成后移除；失败时保留可重试的 sticky 错误条目。

| 页面 | 读取/加载提示 | 处理 |
| --- | --- | --- |
| `/pm` 登录/选择工作区 | “正在读取当前会话，请稍候”“正在加载工作区…”“正在刷新工作区…” | 登录表单/选择器内保留 |
| `/pm/:workspace/home` | “工作区任务与项目 · 正在读取…”“个人资料与时区 · 正在读取…”“最近动态 · 正在读取…”及对应读取错误 | **通知中心**（静默加载、sticky 错误+重试）；任务/项目/截止区块内部空态仍保留 |
| `/pm/:workspace/dashboard` | “加载个人工作台…”“加载规划数据…”“加载项目评估…”“加载 Sprint…”以及 `QueryNotice` 的读取/刷新失败 | 面板内部加载与 DataRegion 旧快照提示保留；`QueryNotice` 状态进入**通知中心** |
| `/pm/:workspace/projects` | “正在读取项目数据”及补充读取错误 | **通知中心**（静默加载 + 瞬态移除；错误 sticky） |
| `/pm/:workspace/projects` 侧栏 | `QueryNotice` 读取/刷新失败；项目收藏补充读取（`silent + transient`） | 全部进入**通知中心**；侧栏不再插入“正在读取收藏…”行 |
| `/pm/:workspace/projects/:projectId/*` | 任务 `QueryNotice`、项目源文件/引用/团队/收藏等补充读取状态 | 整页/区域加载保留；`QueryNotice` 状态进入**通知中心**；弹窗内部读取保留 |
| `/pm/:workspace/issues`、`/views`、`/entities/:id` | “正在加载工作区…”“正在读取个人任务上下文…”“正在读取个人时区…”“加载历史/评论/审计…”，以及 `QueryNotice` 读取状态 | 工作台/详情区域与弹窗内部保留；`QueryNotice` 状态进入**通知中心** |
| `/pm/:workspace/issues/new` | “正在读取授权工作区…”“正在读取有权访问新项目的成员…”“正在读取本地项目目录…” | 创建表单内保留 |
| `/pm/:workspace/documents` | “正在加载文档…”“正在读取授权文件…”“正在扫描 Markdown 文件…”“正在加载下一页…”“正在读取当前来源权限…”“正在读取来源目录…” | 文档树/工作台/来源设置内保留 |
| `/pm/:workspace/notifications` | “正在加载工作区动态…”“正在刷新…”；通知收件箱 DataRegion 加载/旧快照 | 列表/详情区域保留 |
| `/pm/:workspace/members` | “加载成员…”“正在读取本人资料…”“正在读取收藏…” | 目录/编辑弹窗内保留 |
| `/pm/:workspace/whiteboard` | “正在加载工作区…”“正在加载画布…” | 页面内保留 |
| `/pm/:workspace/settings/*` | “正在读取个人资料…”“正在读取安全状态…”“正在读取会话…”“正在读取个人时区…”“正在读取服务…”等；`QueryNotice` 读取状态 | 卡片/面板内部保留；`QueryNotice` 状态进入**通知中心** |
| `/pm/account/*`、`/pm/invitations/accept` | “正在检查重置链接…”“正在检查邀请…”等 | 页面提示块内保留 |

## 5. 已迁移的具体文案

### 5.1 全局壳层

- `当前离线`：联网后自动标记已解决。
- `实时更新中断`：SSE 重连或重同步时显示。
- `会话或服务错误`：非整页错误的服务错误。

### 5.2 命令

- `命令未完成` + 服务端错误消息。
- `命令结果未知` + 命令类型 + commandId + 错误消息；操作按钮为“查询原命令收据”。
- `CreateProject` 的本地项目恢复内容直接显示在通知条目内，不再占用页面顶部。

### 5.3 工作台

- `<id> saved to Markdown`
- `<id> updated · Markdown saved`
- `Checklist saved to Markdown`
- `<id> permanently deleted / archived / restored`
- `View saved with revision protection`
- `Manual order saved; temporary filters remain unchanged`
- `Save this view first to persist manual ordering.`
- `<id> created in Markdown`
- `<id> created, but outside this scope or filter. The new task is open.`（可打开新任务）
- `Agent context copied` / `已复制上下文`
- `<label> · 正在读取…`（`QueryNotice` / 首页补充读取；静默 transient）
- `<label> · 读取失败` / `刷新失败`（sticky，带“重试读取”）
- `项目任务 · 正在读取…`、`里程碑 · 正在读取…`、`收藏与封面 · 正在读取…`、`项目身份与团队 · 正在读取…`、`健康评估 · 正在读取…`（项目目录补充读取）

### 5.4 项目菜单与文件

- `已加入个人收藏。` / `已从个人收藏移除。`
- `已复制项目链接。` / `无法复制项目链接`
- `原项目复制结果未知`（sticky，可打开原复制恢复）
- `侧栏项目顺序已保存。` / `侧栏项目顺序保存失败`
- `当前项目或权限不允许上传。`
- `链接已复制` / `无法复制链接`
- `已开始下载` / `下载失败`
- `原上传请求核对失败`
- `无法确认文件基线`
- `项目访问记录未确认`（warning，sticky，带“核对原访问记录”；可选 automation visit 接口返回 404 时静默视为不可用）

## 6. 验证记录

- `node --test apps/web/src/features/pm/service/pm-notice-center-model.test.ts`：7 项通过。
- 针对性 ESLint：通过。
- 针对性 TypeScript 检查：改动文件无错误；全量 `tsc` 仍被既有 `radix-select.tsx` 与 `KnowledgeGraphCanvas.tsx` 错误阻断，未归因于本次改动。
- `vite build`：通过。
- 隔离端口浏览器验证：离线时主内容区 top/height 不变，铃铛角标变为 1，Popover 显示“当前离线/需处理”；恢复联网后标记“已解决”；收藏/取消收藏只在通知中心显示，旧右下角项目菜单通知不再出现。
- 全部项目页：加载完成后页面内不再出现“项目任务 · 正在读取…”等五条补充读取行，也没有“正在读取收藏…”侧栏行；项目主列表与原位骨架保留。
- 首页：加载完成后页面内不再出现“正在加载工作区任务与项目…”等补充读取行。
- 项目看板：运行中的旧 API 未提供 `/automations/pm/visits` 时返回 404；页面不再显示“项目访问记录未确认 / 核对原访问记录”，看板正常渲染。真实网络/服务错误仍进入通知中心。

## 7. 未纳入

- 业务通知收件箱 `/notifications` 的已读/归档状态、关注与提及路由。
- 字段校验、保存状态、冲突模态和破坏性确认。
- `/lab/pm` 组件演示与设计系统页的 demo toast。
- 跨设备/跨刷新持久化、浏览器系统通知、声音。
