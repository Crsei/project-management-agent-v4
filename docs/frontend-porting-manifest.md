# 前端移植清单：EasyuseUI Project Management → 本项目前端

版本：0.2 · 更新日期：2026-10-17 · 状态：独立前端已接真实服务；展示与业务证据分开，最终前端回归待汇总

## 1. 目标与决策

| 决策 | 内容 |
| --- | --- |
| 目标 | 把 EasyuseUI 的 project management 页面复制为本项目前端，页面元素位置与布局与原项目一致 |
| 技术基元 | Radix UI（dialog/dropdown/select/checkbox/switch/tabs/tooltip/popover/progress/alert-dialog/collapsible/radio-group）+ Tailwind v4 + Vite 8 + React 19 + react-router 7 |
| 依赖边界 | 不依赖 EasyuseUI 的任何 npm 包；组件按其源码移植到本项目 `apps/web` |
| 宿主 | `apps/web`（Vite 8 SPA；根目录 `pnpm dev:web` / `pnpm build:web`；Tailwind 经 `@tailwindcss/vite`，路由经 react-router 7；Next 已移除） |
| 数据 | 正式 `/pm` 使用本仓库生成客户端、真实认证/能力与 TanStack Query；仅 `/lab/pm` 使用确定性 fixture。后端失败不回退样例 |
| 参照物 | 外部 `EasyuseUI/examples/agent-workspace/PAGES-PROJECT-MANAGEMENT.md` 的 32 页目录与受控边界；历史截图/DOM 在 `.ref/shots/<slug>.png`、`.ref/dom/<slug>.html`，不作为运行依赖 |

## 2. 移植闭包（实测）

2026-10-16 初始移植的 import 图闭包：**223 个文件 / 52,085 行**，下表是该批次统计，不是接入服务后的当前源码总量。

| 层 | 源路径 | 目标路径 | 文件数 |
| --- | --- | --- | --- |
| 受控 View + fixture + 域模型 | `EasyuseUI/packages/agent-workspace-views/project-management/` | `apps/web/src/views/pm/` | 120（32,479 行） |
| 复合块 | `EasyuseUI/packages/ui/components/blocks/` | `apps/web/src/components/blocks/` | 38 |
| 基础件 | `EasyuseUI/packages/ui/components/ui/` | `apps/web/src/components/ui/` | 39 |
| 模型/工具 | `EasyuseUI/packages/ui/lib/` | `apps/web/src/lib/` | 25 |

该批次移植已经落地；当前新增服务适配与专用组件见第 11 节，不再以初始“lib 8 个、ui 10 个”作为进度。

## 3. 路径映射（统一规则）

| 源码 import | 新项目 import |
| --- | --- |
| `@easyuse-ui/ui/lib/X` | `@/lib/X` |
| `@easyuse-ui/ui/components/ui/X` | `@/components/ui/X` |
| `@easyuse-ui/ui/components/blocks/X` | `@/components/blocks/X` |
| `@easyuse-ui/agent-workspace-views/project-management/X` | `@/views/pm/X` |
| 相对 import | 不变 |
| `*.module.css` | 同名跟随，内容不变 |

初始移植保留 className、导出名、props、aria/data 与 DOM 顺序，交互基元由 Base UI 换成 Radix。后续设计采用与真实服务专用组件有意调整结构及样式，不能据此宣称当前页面逐字或逐像素等同来源。

## 4. 32 个视图入口（slug = 模块名，一一对应）

`project-list-1..4`（cover/browse/table/compact）、`project-detail-1/2`、`issue-list-1/2`、`issue-kanban-1/2/3`、`issue-calendar-1/2`、`issue-gantt-1`、`issue-spreadsheet-1`、`issue-detail-1/2`、`dashboard-1..4`、`member-list-1..3`、`team-list-1..3`、`inbox-1..4`、`inbox-email-1`。

显式 Lab 适配器提供内存 controller 与模拟写入；固定时钟 `pmClock=2026-01-12T09:00Z`、时区 UTC。当前目录为 `apps/web/src/features/pm/pm-showcase-catalog.tsx`，`/lab/pm` 可导航原 32 项与 24 个设置页，共 56 项。原视图在同一 Lab 会话内跨视图共享状态；设置业务表单离页重置，浏览器外观与操作偏好则真实持久化并与正式页面共享。正式服务路由不挂载 Lab provider，也不使用其示例身份。

## 5. 当前正式产品路由与展示边界

路由权威为 `apps/web/src/routes.tsx`。`[w]` 为真实授权工作区路由标识，`[p]` / `[i]` 为服务实体 ID；原 Plane 的 ID、连接与数据不迁移。

| 路由 | 当前正式行为 | 变体/限制 |
| --- | --- | --- |
| `/pm` | 登录、会话、真实工作区选择 | 不自动进入示例工作区 |
| `/pm/[w]/home`、`/pm/[w]` | 参考 gr8r-studio Home 的个人工作台；工作区根按浏览器启动偏好跳转 | 真实 Markdown 项目/任务、个人资料时区和授权变更事件；四项统计、我的任务、项目进度、截止分组。无可靠完成时间不推造本周完成，取消不计入完成；新浏览器默认 Home，已有偏好保留，Dashboard 独立 |
| `/pm/[w]/dashboard` | 关注、计时/工时、资料、会议、便签、Sprint、健康/财务、在线状态、关键路径、项目依赖及里程碑改期 | `dashboard1..4`；使用五个真实 Dashboard 查询与受权限/CAS 保护的命令，缺失评估或计算输入不伪造 |
| `/pm/[w]/projects` | 真实项目集合、创建/修改 | `cover/browse/table/compact` |
| `/pm/[w]/projects/[p]` | 项目详情、规划/里程碑、对话/意图与依赖 | `detail1/2` |
| `/pm/[w]/projects/[p]/issues`、`/pm/[w]/issues` | 项目或工作区任务集合 | `list1/2,board1/2/3,calendar1/2,gantt1,spreadsheet1`；专用 `dnd-board,calendar,hour-calendar,gantt,table,dependencies,tree` |
| `/pm/[w]/projects/[p]/issues/[i]` | 任务详情、元数据、真实成果与审核闭环 | `detail1/2`；审核通过仍须显式完成 |
| `/pm/[w]/members` | 真实脱敏目录、角色/能力及项目范围、本人资料、既有团队/加入时间/TTL 在线状态、SMTP 邀请闭环 | SMTP 未配置禁用邀请；2FA 无可信来源时保持未知；见[补齐计划](implementation/member-backend-completion.md) |
| `/pm/[w]/teams` | 明示未支持团队；显示真实按成员分派工作量 | 创建团队/发送邀请禁用 |
| `/pm/[w]/notifications` | 真实变更事件活动 | 不是邮件，也无通知已读/归档语义 |
| `/pm/[w]/projects/[p]/events` | FullCalendar 小时布局与全天任务日期 | 此任务日历不混入会议；Dashboard 1 的 Meetings 单独读取真实项目会议时刻 |
| `/pm/[w]/whiteboard` | 个人本地白板 | 不提供服务端保存或多人协作 |
| `/pm/[w]/settings` | 原工作流/字段、迁移/备份、诊断与 `?section=preferences` | 保留旧入口；新设置页提供返回链接 |
| `/pm/[w]/settings/:page` | 24 页、7 分组设置中心 | 真实本人资料五字段、版本/收据恢复及浏览器偏好；成员/团队/权限/项目接回已有管理入口，无后端合同的写入口禁用，详见[完整设置设计清单](implementation/settings-completion-plan.zh.md) |
| `/` | 重定向 `/pm` | — |

`/lab/pm` 使用独立路由树与示例工作区 `execra-ai`，保留原 32 项全部页面设计（包括邮件等仅展示页面），并提供 24 个设置页。`?scenario=empty/loading/refresh-error/readonly/long-content` 是原 Lab 视图场景，不改变正式服务事实；设置页不接此场景参数。邀请接受以当前路由权威 `/pm/invitations/accept` 为准。

## 6. 验证协议

1. 每个视图渲染后与 `.ref/shots/<slug>.png` 对比（内容区截取，1440×900）。
2. DOM 结构与 `.ref/dom/<slug>.html` 的关键节点对比（标签层级、class、data 属性）。
3. 全量通过 `tsc --noEmit` 与 `vite build`。
4. 深/浅主题、中/英语言各抽查 1 页。

## 7. 执行结果（2026-10-16）

本节仅保留最初 fixture 移植批次的历史结果；不代表当前 `/pm` 数据来源，也不代替接入后的最终检查。

| 项 | 结果 |
| --- | --- |
| 移植总量 | 223 个源文件：`views/pm` 120 + `components/ui` 39 + `components/blocks` 38 + `lib` 25，约 52k 行 |
| 交互基元 | 全部 Base UI 交互层替换为 Radix（dialog/dropdown/select/checkbox/switch/tabs/tooltip/popover/progress/alert-dialog/collapsible/radio-group 等）；`@radix-ui/react-radio-group` 不可用，segmented/radio-group 按 roving-tabindex 原生按钮实现，className 逐字保留 |
| 路由 | 12 条产品路由全部 200（dev 与生产构建一致）；`/pm/invitations/[id]` 属 Plane 邀请受理流，本项目领域无对应实体，本期不实现 |
| DOM 对比 | 32 个视图与 Lab 参照对比：13 个 100% 一致；其余 85–97%，差异仅为 Base UI 渲染 `<span role=radio>` + 视觉隐藏 input、Radix 渲染 `<button>` 的元素级差别（className、布局、位置一致） |
| 视觉抽查 | project-list-1、issue-list-1、kanban-1、dashboard-1/2、member-list-1、events 小时日历、深色主题 + 英文界面均与原页面一致 |
| 构建 | `tsc --noEmit` 0 错误；生产构建通过；生产服务全路由 200（迁移前 `next build --webpack`，迁移后 `vite build`，见第 9 节） |
| 交互 | 视图内创建/编辑/移动/筛选/变体切换走移植的 fixture controller（内存模拟，不写服务）；`navigate(slug, entityId)` 已映射到产品路由，仪表盘/集合的下钻可落地真实 URL |
| 数据边界 | 全部页面由 `views/pm` 的确定性 fixture 驱动（固定时钟 2026-01-12T09:00Z、UTC）；`?scenario=` 支持 empty/loading/refresh-error/readonly/long-content；真实后端接入属第二阶段 U02+，fixture 不冒充服务结果 |

## 8. 运行

```bash
# 项目根目录；先按 README 启动真实 API/Worker/PostgreSQL
pnpm dev:web                        # http://127.0.0.1:3220/pm
pnpm check:web                      # 前端 lint + tsc --noEmit + vite build
pnpm build:web                      # 类型检查与构建 → apps/web/dist
pnpm preview:web                    # 预览生产构建 :3220
pnpm storybook                      # http://127.0.0.1:6017
pnpm --filter @pm/web build-storybook
```

`/pm` 使用本机引导或管理员创建的真实账号；`/lab/pm` 是独立样例目录。Vite 开发/preview 代理 `/api`、`/health` 至 `http://127.0.0.1:4100`；`PM_API_URL` 可改目标，`PM_API_ORIGIN` 仅在后端配置的信任 Origin 不同于目标时指定。API 文档直接访问 `http://127.0.0.1:4100/openapi.json`。生产托管的同源转发、SSE 和 Lab 访问门禁仍须部署验收。

## 9. 2026-10-17：构建基座由 Next 迁到 Vite

决策：前端统一用 Vite + React 构建，删除 Next.js 依赖与 App Router 目录。

| 项 | 迁移前 | 迁移后 |
| --- | --- | --- |
| 构建/开发 | `next dev/build/start --webpack`（宿主 glibc 2.28 无法加载 Next 16 原生 SWC/Turbopack 绑定） | `vite` 8.3.4 + `@vitejs/plugin-react` 6.1.2 |
| CSS | `@tailwindcss/postcss` + `postcss.config.mjs` | `@tailwindcss/vite` 4.3.3，入口样式 `src/index.css` |
| 路由 | `src/app/**` App Router（`page.tsx` + 动态段目录 + `layout.tsx` metadata） | `src/routes.tsx` 路由表 + `src/routes/*.tsx` 路由组件；`react-router` 7.18.4 |
| 路由 API | `next/navigation`（`useRouter`/`usePathname`/`useParams`/`notFound`/`redirect`）、`next/link` | `react-router`（`useNavigate`/`useLocation`/`useParams`/`useSearchParams`/`Link`/`Navigate`/`Outlet`） |
| 请求参数 | `params`/`searchParams` 为 Promise，页面为 async 服务端组件 | `useParams()`/`useSearchParams()`，全部为客户端组件 |
| 组件指令 | 130 个文件带 `"use client"` | 指令删除（SPA 全部在客户端渲染） |
| 未匹配路由/未知视图 | Next 默认 404 页、`notFound()` | `src/routes/not-found.tsx` 的 `PmNotFound` / `PmViewNotFound` |

该次迁移时保持不变：`views/pm`、`components/*`、`lib`、`styles` 的受控 View 与 fixture 语义。其后真实服务接入将 `execra-ai` 与 `?scenario=` 限定在 `/lab/pm`，正式 `/pm` 不再使用示例工作区。

迁移校验：240 个既有源文件与迁移前快照逐字节一致（仅去掉 `"use client"` 行）；`src/app/` 15 个文件按上表替换为 `src/routes*`；`tsc --noEmit` 0 错误；`vite build` 与 `vite dev` 均通过浏览器实测 12 条路由，控制台无报错。

## 10. 2026-10-17：采用工作台设计模式（表层）

决策：按 [AI 与项目协作工作台设计模式](../../DESIGN-PATTERNS.md) 更新本应用表层，落地范围、Token 映射、局部例外与验收证据登记在 [前端设计模式采用记录](frontend-design-adoption.md)。

| 项 | 本次改动 | 仍保持 |
| --- | --- | --- |
| 颜色 | 中性灰改为略带暖意（`--background`/`--surface`/`--surface-raised`），主按钮改用前景色填充，新增 `--accent`/`--focus`/`--selection-marker`，图表降饱和 | 语义变量名与浅/深双主题机制 |
| 圆角 | 角色化刻度（4/6/8/12/16/20/24px）并补齐 `rounded-panel`（此前未定义）、新增 `rounded-module` | 既有 `*.module.css` 中的角色内字面量 |
| 排版 | 元数据下限 12px（≤11px 的 55 条规则提升），单行元数据行高 16px，`--font-mono` 生效于代码 | 视图原有字号层级与密度 |
| 几何 | 业务页头 56px、折叠导航 56px、属性面板 360px、单行数据行 44px | 集合二级栏 234px、看板列 320px |
| 材质 | 浮层与输入区各一层阴影（含 1px 顶边高光），项目封面取消多色渐变与压暗层 | 页面/表格/看板列的平坦表面 |
| 状态 | hover = 弱中性底色，选中 = 暖色持久底色 + 标记，焦点 = 2px 陶土色独立环；`prefers-reduced-motion` 停止动效 | 三条状态轴各自独立表达 |

对比第 6 节的移植协议：DOM 层级、`data-*`、`?view=`/`?scenario=` 约定与页面元素位置不变；Token 值、材质与部分圆角/行高按方案有意偏离原项目外观，属于本文件与采用记录共同登记的偏差，不再是“与原页面逐像素一致”。

## 11. 2026-10-17：真实服务接入与专用组件选型

首选基于当前受控数据/命令边界，不同时安装两套同类库。下表“备选”仅记录替代方向，**未安装、未实现、未验收**；精确解析版本以 `pnpm-lock.yaml` 为准，声明依赖见 `apps/web/package.json`。

| 能力 | 当前首选/已安装 | 实际组件与范围 | 备选（未采用） |
| --- | --- | --- | --- |
| 基础控件与主题 | Radix UI + Tailwind 4 | `components/ui`；继续既有语义 Token | Base UI；不引入第二套主题 |
| 服务快照/本地交互 | TanStack Query 5、Zustand 5 | `features/pm/service/pm-service.tsx`；主体/成员范围隔离、完整分页、草稿与服务快照分离 | SWR / Redux Toolkit |
| 看板拖拽 | `@dnd-kit/core` 6 + utilities 3 | `service-board.tsx`；指针/键盘意图，合法状态命令确认后更新，不任意拖成 done | Pragmatic drag and drop |
| 日历 | FullCalendar 6 的 React/core/daygrid/timegrid/interaction | `service-calendar.tsx`；月/周/日与小时布局、全天日期编辑 | React Big Calendar |
| 表格与虚拟列表 | TanStack Table 8 + Virtual 3 | `service-table.tsx`；搜索/排序/虚拟行，保留服务 ID | AG Grid Community |
| 甘特 | 自定义受控时间轴 | `service-gantt.tsx`；周/月/季与共享日期编辑；不新增甘特依赖 | Frappe Gantt（另需命令适配） |
| 依赖图 | `@xyflow/react` 12 + ELK 0.12 | `service-dependency-graph.tsx`；真实 Web Worker 布局、依赖增删；不是自动执行引擎 | Dagre 布局 |
| 项目树 | 自定义可访问树 | `service-project-tree.tsx`；项目/任务导航；不虚构 Session | react-arborist |
| 统计图 | Recharts 3 | `service-status-chart.tsx`；实际状态数量，不伪造财务趋势 | Apache ECharts |
| 富文本 | Tiptap 3 React/StarterKit/Markdown | `rich-text-editor.tsx`；编辑后以 Markdown 进入现有领域正文 | Lexical |
| 命令面板/快捷键 | cmdk 1 + react-hotkeys-hook 5 | `service/pm-command-palette.tsx`；真实任务搜索和导航 | 自定义 Radix Dialog 列表 |
| 白板 | 自定义本地 SVG | `service-whiteboard.tsx` / `whiteboard-model.ts`；撤销/重做、缩放/平移、便签/形状/自由画笔、JSON 导入导出 | Excalidraw / tldraw；需另行审查许可与协作边界 |
| 组件展示 | Storybook 10 + React Vite | `service-components.stories.tsx`：11 stories，显式本地样例 | 独立 Vite 展示宿主 |
| 表单与合同验证 | Zod 4 | 创建/编辑/日期及命令 payload 校验；服务端保留最终裁决 | 不复制客户端业务规则 |
| 面板与图标 | react-resizable-panels 4、Lucide React | 复用现有可调整外壳与图标，窄屏采用导航抽屉及纵向元数据 | 不引入另一套布局框架 |
| 交互动效 | 现有 CSS transition / reduced-motion | 卡片、侧栏和控件反馈；没有仅为清单而安装 motion | motion（未采用） |
| 复杂工作流状态机 | 现有领域生命周期命令与受控组件状态 | 后端执行明确转换；前端不自行判定完成 | XState / Robot（未采用） |

上述专用组件均位于 `apps/web/src/features/pm/components/`，服务适配位于相邻 `service/`。白板按浏览器 origin/主体/工作区/可选项目隔离本地存储，不写 Artifact，不提供服务端同步、协作或跨设备恢复。

### 日期元数据契约

`UpdateWorkItemMetadata` 的 `startDate` / `dueDate` 为可省略、可空的 `YYYY-MM-DD`：省略保持原值，`null` 清除，旧实体缺失值读取为 `null`。两者都存在时必须 `startDate <= dueDate`，截止日包含当天。后端校验真实日历日期；命令使用原 `commandId` 与聚合 `expectedVersions`，成功递增实体版本但不改变 `contentRevision`，不因排期变化使审核快照变为另一份工作内容。权威实现见 `packages/application/src/planning.ts`，生成客户端见 `packages/contracts/src/client.ts`。

日历在截止日期以全天单日条目显示任务（无截止日期时放在开始日期），不按起止日期铺开；拖动条目只移动截止日期（仅有开始日期时移动开始日期），不提供拉伸修改区间。日历页不显示选中工作项下拉、未排期/日期异常列表与完成/取消分组抽屉；无日期任务在其他视图处理。内部仍将 inclusive due 转为 FullCalendar exclusive end，保存时转回；所有服务任务为 all-day，单边日期仍保留另一边为空。小时网格仅供定位，不允许保存虚构会议时间。日历、甘特、表格和详情读取同一元数据；冲突保留草稿，显式基于最新版本重设后才可再次保存。

### 接入证据与待完成门槛

真实浏览器已完成人工交付闭环、刷新后同一对象读取、文件下载摘要核对、原 commandId 响应丢失恢复、双会话日期冲突与只读用户 SSE 更新；详细结果见 [交付记录](implementation/backend-delivery.md)。Storybook 已抽查指针/键盘看板、日期编辑、图布局、白板恢复、Markdown、虚拟表格与甘特刻度；这些只证明组件交互，不能替代业务服务证据。

最新响应式、ELK Worker、跨视图草稿、布局切换及离线提示修改后的 `pnpm check:web` 已通过；Storybook 构建通过。Lab **32/32** 真实浏览器巡检无 pageerror，并复验项目/任务跨视图状态。390px 窄屏导航抽屉与详情元数据复访通过；正式服务补验成员项目授权/撤销、离线提示、HTTP 503 旧快照及重试恢复。生产构建 preview 验证真实图布局与后端读取。构建仍提示大 chunk；未宣称生产部署、真实 Agent、团队/邀请/邮件或完整 G1/G2 已验收。

## 12. 2026-10-19：生产页面展示视图与设置页收口

正式 `/pm` 与 `/lab/pm` 的页面族继续分开：Lab 保留 32 个确定性 fixture 变体；正式页面复用同一批受控视图，并把非业务显示偏好集中到设置页。

| 项 | 当前落地 |
| --- | --- |
| 显示偏好 | `features/pm/service/pm-display-settings.ts`；localStorage 按工作区保存，键为 `pm.display-settings.v1:<workspaceId>`；含 `dashboardView`、`projectListView`、`projectDetailView`、`issueView`、`memberView`、`teamView`、`notificationView` |
| 设置入口 | `/pm/<workspace>/settings?section=preferences`；外观（浅/深、中/英）与页面默认布局均在此页；项目侧栏提供变体深链，正式项目详情另有简报/工作区切换 |
| 项目集合 | 规范值为 `list1..4`，映射到 `ProjectCollectionView` 的 cover/browse/table/compact；旧 URL `cover/browse/table/compact` 仍可解析为别名 |
| 任务集合 | `list1/list2/board1/board2/board3/calendar1/gantt1/spreadsheet1` 使用 `IssueCollectionView`；`calendar2` 与项目 events 使用展示稿 `HourCalendarView` 的真实全天任务适配；`dependencies`、`tree` 为服务专用视图 |
| 成员 | `member1..3` 使用 `MemberDirectoryView`；能力授权、项目范围与成员表单仍由服务层裁决 |
| 团队 | `team1..3` 使用 `TeamCollectionView`；team1 如实为空（后端无原生团队），team2 使用真实成员目录，team3 使用真实分派工作量；不伪造团队、容量、在线状态或邀请 |
| 通知 | `inbox3/inbox4` 使用 `NotificationInboxView` 展示真实变更事件；已读/归档状态不可用时不显示可写控件，inbox1/inbox2/email1 仅保留在 Lab |
| 详情页面 | 正式 `/projects/<id>` 使用 `detail1/detail2` 项目布局；`/entities/<id>`、文档与原生集合继续使用共享 Markdown 工作台，项目详情保留完整源码编辑入口 |
| 深链覆盖 | `?view=` 仍作为显式 URL 覆盖；设置页提供默认值。无法识别的值按该页默认值处理，不写回存储 |

收口验证：`pnpm --filter @pm/web typecheck`、`lint`、`build` 与 `build-storybook` 通过；生产构建 preview 使用拦截的服务快照逐页验证设置页、项目 list3、任务 board1/calendar1/calendar2/gantt1/spreadsheet1、team3、inbox3 与 events，无运行时 pageerror。该验证使用本地示例响应，不等同真实账号/后端验收。

## 13. 2026-10-20：Dashboard 1–4 在线参照复刻

本轮直接对照 Shadcnblocks Admin 在线页面，而不是沿用此前 EasyuseUI 的截图结论：

| 参照 | 本次对应内容 |
| --- | --- |
| [Dashboard 1](https://shadcnblocks-admin.vercel.app/project-management/dashboard-1) | 个人工作区页头/标签、三张概览卡、五张状态卡、工时折线与计时器、任务表格、300px 个人资料及日程栏 |
| [Dashboard 2](https://shadcnblocks-admin.vercel.app/project-management/dashboard-2) | 快捷操作、四张指标卡、胶囊甘特、项目卡、里程碑及笔记、330px 活动/成员/状态栏 |
| [Dashboard 3](https://shadcnblocks-admin.vercel.app/project-management/dashboard-3) | 六列摘要、迭代组合图、预算实际/预测图、当前项目、里程碑、成员状态和活动；补充明细由摘要按钮打开 |
| [Dashboard 4](https://shadcnblocks-admin.vercel.app/project-management/dashboard-4) | 项目交付页头、快捷操作、正交依赖图、项目表格、360px 健康度/关键路径/关注事项栏 |

- 四个 Lab 实现拆为 `apps/web/src/views/pm/dashboard-{1,2,3,4}-fixture.tsx`，共用 `dashboard-fixture-surface.tsx`；旧单体 `dashboard-fixture.tsx` 已移除。入口仍为 `/lab/pm/execra-ai/dashboard?view=dashboard1` 至 `dashboard4`。
- `dashboard.tsx` 继续作为正式与 Lab 共用的受控布局；`dashboard-navigation.tsx` 提供调用方驱动的搜索与成员/活动入口。示例站的 Invite 按钮在本项目显示为可用的成员入口，不宣称已支持发送邀请。
- 仪表盘局部使用中性浅/深色与 Inter，覆盖此前暖中性方案；字体随 `apps/web/public/fonts/` 本地分发并附 SIL OFL 许可证，不依赖在线字体请求。其他页面主题不全局重写。
- Dashboard Lab 的桌面正文起点为 x=256、y=56；移动端使用 48px 页头与导航抽屉。变体切换移至侧栏，去除额外选择栏。Dashboard 2/3 保留顶部面包屑，标题随正文滚动。只保留本项目导航，不复制示例站的电商、支付等无关模块。
- 该轮正式 `/pm/<workspace>/dashboard?view=dashboard1..4` 仅接入共享样式及部分区域，仍保留通用服务图表/树，并未完整应用上述复刻。正式路由的后续完整布局切换见第 15 节；未知预算、工时和在线状态始终不以 Lab 数字代替。
- Lab 保留本项目跨页面共享的项目/任务 ID、状态与依赖关系，故业务名称、统计值和图拓扑不承诺逐字等同参照。新增预算历史明确属于 Lab fixture，不能当作正式财务能力。
- 依赖图新增可选正交连线、隐藏边标签/箭头配置，默认行为不变；初次 fit 等待画布实际尺寸与 ReactFlow store 同步，避免首次加载右侧节点被裁切。移动抽屉选择页面后自动关闭。
- Lab 浏览器验收：四页在 1440×1000 与 390×844 均已实际打开并截图，文档无横向溢出；复核浅/深色、中/英文、空/加载/只读/长内容状态，以及计时、排期窗口、项目搜索、预算钻取、笔记、依赖筛选/定位/缩放/导出。最终四页复查未观察到浏览器错误。
- 正式适配器四个变体另用浏览器内显式测试响应检查渲染，Dashboard 3 的图表内容在卡内滚动；该验证未登录真实业务账号、未写后端，不算真实数据端到端验收。
- 检查通过：`pnpm check:web`（ESLint、TypeScript、Vite build）、额外 Dashboard/共享画布/外壳文件 ESLint、`pnpm check:docs`。构建仍提示大 chunk，以及 `workflow-canvas.tsx` 同时被静态/动态导入；未为消除警告扩展本轮范围。
- 资源边界：Inter 已本地分发；Dashboard 1 的个人资料及日程照片仍引用参照站在线资源，离线加载不保证。

## 14. Project List 1–4 与 Project Detail 1–2 在线参照复刻

六页分别对照在线参考的桌面和移动布局，共享受控数据适配器，不再用一套通用卡片或工具栏代替各变体。

| 参照 | 本次对应内容 |
| --- | --- |
| [Project List 1](https://shadcnblocks-admin.vercel.app/project-management/project-list-1) | 三列封面卡、160px 图片、状态与操作叠层、进度和日期；10 张参考封面本地 WebP 分发，总计约 724KB |
| [Project List 2](https://shadcnblocks-admin.vercel.app/project-management/project-list-2) | 280px 浏览侧栏、三列 280×277px 项目卡、成员叠层和进度；移动端侧栏改为顶部区域 |
| [Project List 3](https://shadcnblocks-admin.vercel.app/project-management/project-list-3) | 项目计数、筛选/列显示、37px 表头与 61px 数据行、负责人/健康度/里程碑/团队/更新时间；移动端表格内部横向滚动 |
| [Project List 4](https://shadcnblocks-admin.vercel.app/project-management/project-list-4) | 64px 搜索区、85px 列表标题、紧凑项目行、360px 选中项目任务栏；移动端上下排列 |
| [Project Detail 1](https://shadcnblocks-admin.vercel.app/project-management/project-detail-1) | 面包屑、标题/徽章/事实行、四项统计、简报、附件、四个标签页、时间线及属性栏 |
| [Project Detail 2](https://shadcnblocks-admin.vercel.app/project-management/project-detail-2) | 指标与摘要流带、七个标签页、三列 Overview、紧凑任务/Issue/动态、340px 属性栏与移动抽屉 |

- Lab 入口：`/lab/pm/execra-ai/projects?view=list1` 至 `list4`；详情为 `/lab/pm/execra-ai/projects/project-rev-241?view=detail1`、`detail2`。六个变体入口移至项目侧栏，去掉重复的顶部布局选择栏。
- 项目页复用已有 Dashboard 局部中性配色和本地 Inter；1440px 桌面正文起点为 x=256、y=56，移动页头为 48px。其他页面的主题与服务不被替换。
- List 2/4 的专用 surface、各变体 CSS 与共享 collection/detail renderer 分工；旧 compact renderer 和冲突表格规则已删除。正式项目列表复用相同 renderer；List 4 选择项目只更新任务摘要，不再立即跳走，排序不重复显示。
- 初次复刻只完整交付 Lab 详情，正式详情当时仍是实体 Markdown 工作台；后续已将六种布局接入正式 `/pm` 项目路由，见下文。正式人物照片、团队、日期等未知业务信息仍不以参考站样例补造。
- Lab 保留共享项目/任务 ID、任务统计、附件数和本地状态；成员只展示投影中已知身份。因此项目内容、附件数量及后续段落的绝对纵坐标不承诺逐字逐像素等同参考。
- 浏览器验收：六页在 1440×1000、390×844 实际打开并截图，浅/深色、中/英文均已查看；最终移动端文档宽 390、高 844，无页面横溢。操作覆盖搜索、日期筛选、排序、收藏、详情/新建弹窗、列显示、行菜单、选中项目摘要、详情标签/键盘激活、文件预览、时间比例、任务检查器、评论草稿及属性抽屉。
- 整合修正：手机表格标题区高 105px，新增按钮宽 32px，Filter/Display 各 175px；任务看板的绝对定位 live region 由看板建立包含块，缩屏及任务选择后外层 `scrollY=0`，不再挤出全局页头。
- 正式列表四个变体另以浏览器显式测试响应检查；List 4 桌面/移动选择、摘要和工具栏通过，未观察到运行时 pageerror。未登录真实业务账号、未写后端，不等同真实数据端到端验收。
- 截图保留在本地 `.local/evidence/project-replica/`；该目录不是业务数据源。检查：`pnpm check:web`（ESLint、TypeScript、Vite build）、额外项目共享文件 ESLint；构建仍有大 chunk 与 `workflow-canvas.tsx` 静态/动态导入警告。

### 正式 /pm 项目路由接入

- 正式列表 `/pm/<workspace>/projects?view=list1..4` 由 `service-project-list.tsx` 接入同一套四种参照布局；正式详情 `/pm/<workspace>/projects/<id>?view=detail1|detail2` 由 `service-project-detail.tsx`、`service-project-detail-panels.tsx` 提供真实数据区域，不导入 Lab fixture/controller。默认布局遵循工作区设置，URL 可显式覆盖。
- 正式项目侧栏、命令搜索、团队项目入口和项目通知目标均使用正式项目详情。原生 `/entities/<id>` 保留为源码与完整业务编辑器；列表返回地址、详情布局和标签随编辑器往返保留，不另建 Markdown 草稿或写入协议。
- 列表筛选/排序/列显示使用授权项目与任务快照；List 4 选择更新 `selected` 和真实任务摘要，不自动跳走。未知团队与里程碑摘要保持不可用，任务完成率不冒充项目健康度。未配置封面的 List 1 使用本地默认装饰图（`data-pm-cover-source="decorative-default"`），不写入或伪造项目封面元数据。
- 项目正文、任务分类/依赖/时间线来自实际 Markdown 工作区及服务投影；附件继续使用 StageUpload、RegisterArtifact/AddArtifactVersion 和不可变版本下载，讨论继续使用 CreateConversation/AppendMessage。成员目录无管理权限不阻断项目读取；写操作仍受真实能力约束。
- 真实浏览器烟测使用临时端口 3347/4127、独立随机 PostgreSQL schema、独立 Markdown/Blob 目录和隔离 owner/只读账号，没有拦截服务响应，也未修改用户现有业务数据。已验证正文通过原生编辑器保存并整页刷新、任务编辑器往返、讨论追加、附件上传登记及下载字节一致；只读账号的上传/登记/新建任务禁用，源码编辑器只读。
- 六个正式布局在 1440×1000、390×844 实际查看，页面无横向溢出；额外检查四个简报标签、七个工作区标签、列表搜索/列显示/项目行菜单/摘要选择、返回列表视图及手机属性抽屉。抽屉长任务与时间戳不再撑出容器。截图位于 `.local/evidence/formal-project-pages/`。

## 15. 正式 Dashboard 1–4 布局切换

- 正式路由 `ServiceDashboard` 现在直接选择 `apps/web/src/features/pm/service/service-dashboard-{1,2,3,4}.tsx`，不是将 Lab 页面作为另一个可选展示地址。无 `view` 参数时遵循已保存的显示设置（默认 Dashboard 1）；显式 `?view=dashboard1` 至 `dashboard4` 可覆盖设置。
- 四页复用对应参照 CSS 和 `DashboardView` 区域布局，服务专用组件只接收命名的 `ServiceDashboardProps` 授权查询快照。旧通用状态图、项目树及活动 Panel 的 Dashboard 适配代码已删除；不导入 Lab fixture/controller。
- 正式外壳也采用 256px 侧栏、中性配色、Inter 和 56px 页头；移动端为 48px 页头及可自动关闭的导航抽屉。Dashboard 1–4 切换入口就在正式侧栏；其他正在修改的项目列表布局保持不变。
- 个人页以当前 actor 的创建/分配关系计算任务；概览以实际起止日期及里程碑 `targetDate` 排期；指挥中心展示当前任务状态、项目、成员和事件元数据；依赖页仅展示授权工作项之间的真实同项目前置关系，并保留显式依赖编辑对话框。
- 本次布局切换时工时、关注、会议、便签、财务、健康/关键路径与在线状态尚未接入；后续已补齐真实服务，范围与证据见 [Dashboard 后端补齐计划](implementation/dashboard-backend-completion.md)。没有记录仍显示明确空态，任务完成比例不冒充健康度。
- 核心项目/任务读取错误参与页面错误与重试，成员/里程碑/事件读取错误在各自卡片内显示。成功的空快照仍显示真实零值和卡内空态；未加载或无权限不显示为零。未知依赖端点在展示及导出中不泄露 ID/名称。
- 正式路径浏览器验证覆盖 1440×1000、390×844、浅/深色与中/英文；四页无文档横向溢出。已实际检查个人创建/分配范围区分、项目搜索/范围、排期窗口、里程碑钻取、状态明细、依赖筛选/缩放/选择、移动侧栏切换与自动关闭。
- 四页均演练空快照、成员权限缺失、任务读取等待、读取失败后重试恢复；等待状态不产生零任务假象。依赖导出验证包含 8 个授权节点、3 条真实同项目前置边，缺失/跨项目关系不导出，缺失端点标识不出现在页面、编辑器或导出 JSON 中。
- 验证使用实际正式路由的浏览器内显式测试响应（非真实业务登录），写请求审计为空。开发服务存在并行热更新时改用临时 3327 端口的生产构建预览；没有重启现有 3220/3221 服务，没有将测试响应写入应用。
- 检查通过：`pnpm --filter @pm/web lint`、`pnpm --filter @pm/web exec tsc --noEmit`、Vite 生产构建至独立临时目录及 `pnpm check:docs`。构建仍提示大 chunk 和画布混合静态/动态导入；本轮未扩展到打包拆分。

### 后续真实能力补齐

- 五个服务模块位于 `features/pm/service/dashboard-{personal,time,sprints,portfolio,planning}.tsx`；正式四页使用对应查询 hooks，不导入 fixture。D4 默认显示正式项目依赖，可切换原任务依赖视图。
- D1 的关注管理、计时/补录、姓名/时区和项目会议；D2 的私有便签及原生 Sprint；D3 的观测趋势、健康风险、预算/支出/预测历史；D2/D3 的心跳在线状态；D4 的工期/关键路径、项目依赖和日期改期均已有真实写入路径。
- 固定高度卡片使用原有可滚动内容区域，编辑表单与历史不覆盖相邻卡片；D1 关注操作保留独立点击宽度。会话背景刷新保留已挂载表单及核对守卫；重复标签页不能覆盖持久未知命令。
- 隔离 PostgreSQL、Markdown、真实 API/Worker 与 Vite preview 的浏览器操作没有拦截后端响应。包含 390px 四页、6 日关键路径、原生 Sprint 三任务、显式风险、CNY 预算与真实支出/剩余估计、受限账号私有记录隔离和双标签页 CAS；详细检查结果集中记录在补齐计划中。

## 16. Member List 1–3 在线参照复刻

三个子代理按 `gpt-6.1-sol:xhigh` / priority 分别对照在线参照；正式 `/pm/<workspace>/members?view=member1..3` 与显式 Lab 共用新布局，侧栏提供三个入口。

| 参照 | 对应实现与布局 |
| --- | --- |
| [Member List 1](https://shadcnblocks-admin.vercel.app/project-management/member-list-1) | `member-directory-1.tsx`：57px 标题栏、37px 表头、61px 数据行；五列、状态图标、团队摘要、Filter/Display，无额外选择列 |
| [Member List 2](https://shadcnblocks-admin.vercel.app/project-management/member-list-2) | `member-directory-2.tsx`：Sort/Recent/Display、搜索、三列 368×229px 联系卡；56px 头像区域、Email/Call 均分底栏 |
| [Member List 3](https://shadcnblocks-admin.vercel.app/project-management/member-list-3) | `member-directory-3.tsx`：32px 正文边距、邮箱/角色双列邀请区、三标签、四项筛选工具、选择框与访问管理表格 |

- `MemberDirectoryView` 仅负责变体调度、共享检查器与焦点返回；旧通用成员卡已删除。局部样式复用本地 Inter 与中性主题，桌面正文从 x=256、y=56 开始；移动页头 48px，表格内部横滚，卡片单列。
- 正式适配器默认显示全部五列；移除列表前的大段能力说明，将既有账号授权入口放入页头，授权表单使用弹窗。该按钮明确为“授予访问权限”，不冒充邮件邀请；命令、版本检查和能力权限仍由既有服务负责。
- 正式数据不补造头像照片、岗位、在线状态、团队、加入时间或 2FA；缺失联系方式不能发起 Call。Lab 保留自己的跨页面成员身份与邀请结果控制，因此人物、数量和邀请卡高度不宣称逐字逐像素等同参考站。
- 浏览器已操作：列表搜索/列显示/成员详情，卡片搜索/Recent/显示切换/联系链接/邀请弹窗，访问页必填校验/本地邀请提交/待邀请与建议标签/搜索/2FA 筛选/全选/访问弹窗；三页均查看浅深色、中英文、1440×1000 与 390×844，移动端文档宽度均为 390。另检查 empty/loading/readonly/long-content；未观察到运行时 pageerror。
- 正式三个路由以浏览器显式测试读取响应验证成员渲染、真实账号 UUID 授权表单、不可用事实与移动端布局；未登录真实业务账号、未提交后端命令，不等同真实授权写入验收。
- 截图保留在 `.local/evidence/member-replica/`；隔离 Vite 构建写入 `.local/evidence/member-replica-dist/`，没有覆盖并行工作的默认产物。前端及成员相关 ESLint、最终全量 TypeScript、隔离 Vite 构建和文档检查通过；首次类型检查遇到的并行 Dashboard/项目详情/团队错误在最终检查中已消失。构建仍保留大 chunk 与共享画布静态/动态导入警告。
- 最终构建复验：三个正式路由的授权弹窗与 390px 宽度通过；权限页下拉箭头与完整角色筛选文本、邀请角色箭头均已查看，标签可用方向键与 Enter 切换。测试读取响应不作为后端就绪或真实授权写入证据。

### 16.1 正式成员后端闭环

- 三个变体改读权威 `members/directory`；按当前主体/工作区缓存，权限禁用时不暴露旧快照。普通读者只看到真实共享项目协作者，其他人的邮箱、电话和授权字段脱敏；不会为普通目录请求管理邀请接口。
- 本人岗位、电话及受限 PNG/JPEG/WebP 头像使用共享个人资料版本保存；团队、成员加入时间和在线状态分别复用既有真实记录、membership.created_at 与心跳 TTL。角色编辑走服务端显式模板，原能力编辑入口仍保留。
- 邀请包含创建、真实投递状态、显式重发/撤销；`/pm/invitations/accept` 不依赖已有登录，fragment token 只保存在内存。响应未知保留原 commandId 并核对接受收据，不重新申请成员权限。
- 实际浏览器使用隔离 PostgreSQL、HTTP API、真实 loopback SMTP 接收端和独立 Worker 验证邀请→接受→普通账号登录→脱敏目录。额外验证接受提交已生效但响应被中断后的收据恢复、同一路径重新打开 fragment 链接、资料与头像刷新保留、角色保存、重发和撤销。
- 三个正式变体实测桌面 1440×1000、移动 390×844；Member 3 邀请表单保留内边距与桌面双列，Member 2 多操作页头在手机改为正常文档流，避免覆盖原工具栏。另查看英文/深色表面。证据位于 `.local/evidence/member-backend/`；不使用 mock API，不覆盖默认前端构建。
- 上一节的显式测试响应仅属复刻历史，不替代本节真实服务验收；最终检查与 SMTP 未配置、2FA 未接入等边界统一记录在[成员补齐计划](implementation/member-backend-completion.md)。

## 17. Team List 1–3 在线参照复刻

三个子代理按 `gpt-6.1-sol:xhigh` / priority 分别对照在线参照。正式 `/pm/<workspace>/teams?view=team1..3` 与显式 Lab 共用三个独立内容组件；侧栏提供变体入口，移除正文上方重复的布局选择栏。

| 参照 | 对应实现与布局 |
| --- | --- |
| [Team List 1](https://shadcnblocks-admin.vercel.app/project-management/team-list-1) | `team-list-1-content.tsx`：57px 标题栏、37px 表头、61px 数据行；Team/Focus/SLA/Maintainers/Open work/Activity 六列，Filter/Display/Add Team 与行菜单 |
| [Team List 2](https://shadcnblocks-admin.vercel.app/project-management/team-list-2) | `team-list-2-content.tsx`：36px 标题、Directory/Departments/Tasks、搜索与布局切换；三列 368×279px 联系卡、56px 头像区域、Team/Joined 事实行 |
| [Team List 3](https://shadcnblocks-admin.vercel.app/project-management/team-list-3) | `team-list-3-content.tsx`：Workload/Departments/Task pool、搜索与状态筛选；三列 368×276px 起始高度任务卡，默认展开、任务收起及联系底栏 |

- `TeamCollectionView` 只保留变体调度、共享团队/成员检查器与焦点返回，旧通用变体主体已移除。局部复用本地 Inter 和中性主题；桌面正文起点 x=256、y=56，手机页头 48px，卡片单列、表格内部横滚。
- 正式适配器按变体重置交互状态；成员返回后初始化任务展开，缺少成员但仍有授权任务时不隐藏未分配任务。成员目录与任务继续来自实际应用查询，不导入 Lab fixture/controller。
- 团队实体、邀请、岗位、在线状态、加入时间和容量等缺失事实不以参考站样例补造；Team 1 保留六列表头与诚实空态，数量显示未知而不是假零，相关写入口禁用。头像使用已知姓名首字母，不把示例照片绑定到真实账号。来源说明移至内容下方。
- 浏览器已检查三个 Lab 页面在 1440×1000、390×844 的实际表面及浅深色、中英文；三页手机文档宽度均为 390。额外逐页检查 empty/loading/readonly/refresh-error/long-content，长内容无外层横溢，刷新失败保留旧内容并显示错误。
- 交互覆盖团队筛选与卡片切换、团队/成员检查器及 Escape 焦点返回、成员搜索与列表切换、部门分组和 Tasks 跳转、任务展开/收起及 Done 筛选；邮箱复制验证了许可拒绝提示以及许可授予后剪贴板实际文本。
- 正式三个路由使用浏览器内显式测试响应验证真实适配器，覆盖团队来源缺失、成员目录、默认展开与状态筛选、无成员但有任务、成员读取失败和 390px 任务卡。未登录真实业务账号、未执行后端写入，不等同真实账号端到端验收。
- 截图保留在 `.local/evidence/teams-replica/`。前端 ESLint、团队相关文件 ESLint、全量 TypeScript 和隔离 Vite 构建已执行；构建仍提示大 chunk 与 `workflow-canvas.tsx` 静态/动态导入。生产产物写入独立临时目录，不覆盖并行工作的默认产物。


## 18. 2026-10-20：HTTP 错误页与失败路由接管

从 EasyuseUI 的 `auth-pages` 移植错误页表面，接入正式 `/pm` 会话状态；认证与权限仍由应用服务裁决。

| 项 | 实现 |
| --- | --- |
| `ErrorPage` | `apps/web/src/components/blocks/error-page.tsx`：401/403/404/500/503 图标、大号状态码、标题/说明、恢复动作、retry/busy、参考编号、compact 与 `h1`/`h2` |
| 独立页面 | `/errors/:code` 渲染完整窗口；非法 code 与未匹配路由回退 404；`ErrorPageScreen` 提供 64px 头部、居中内容和底部说明 |
| 渲染异常 | `PmErrorBoundary` 捕获未处理渲染错误并显示 500；重试是整页 reload，不伪造恢复 |
| 服务失败 | `ServiceFrame` 接管受保护 `/pm` 路由：无会话 → 401；工作区 403/404、服务 500/503 → 对应页面；500/503 的重试调用 `service.refresh()`，失败显示已知错误描述 |
| 文案 | 复用既有 `auth.error*` 键，仅新增 `auth.errorBackHome`；未新增依赖 |

验证：隔离目录 `vite build` 通过；浏览器实测五个状态页、未匹配路由、`/errors/418` → 404、无会话 `/pm/...` → 401、模拟 403/500/503 映射，以及 503 重试后回到真实 Dashboard；中/英与浅/深主题均检查。页面无异常，除模拟断网产生的预期 requestfailed。全量 `tsc --noEmit` 仍被并行 Dashboard 命令类型的既有错误阻断，本轮改动文件无诊断；前端 ESLint 通过。

## 19. Settings 六页在线参照实现

参照 [shadcnblocks Settings](https://shadcnblocks-admin.vercel.app/original/settings) 及其 Profile、Billing、Plans、Connected Apps、Notifications 子页。六个页面分别由 `.omp/agents/settings-builder.md` 定义的 `gpt-6.1-sol`、`xhigh` 子代理实现；共享布局、路由、入口与验收由主线程集成。

代码位于 `apps/web/src/features/pm/service/settings/`；正式路径为 `/pm/[w]/settings/<slug>`，Lab 为 `/lab/pm/execra-ai/settings/<slug>`。保留项目主题 Token、原外壳、真实能力边界和中英文文案，不宣称逐像素复制参考站。

| 页面 / slug | 页面元素与行为 | 正式服务边界 |
| --- | --- | --- |
| General / `general` | 方案提示、公司 Logo、税号/地址、字体/主题/语言、保存/放弃、停用/删除确认 | 主题/语言使用既有会话展示状态；组织资料、字体切换、停用/删除均禁用。Lab 可验证图片格式/大小、预览保存与危险操作确认 |
| Profile / `profile` | 姓名、用户名、邮箱、生日、语言、时区、更新按钮 | `usePersonalDashboard` + `UpdateSelfProfile` 保存真实姓名/时区，带 expectedVersions、共享命令收据与草稿；用户名、邮箱修改和生日未提供接口 |
| Billing / `billing` | 用户名/城市、Card/PayPal/Apple Pay、支付方式明细、继续与复核 | 正式全部禁用；Lab 仅示例掩码卡，不采集完整卡号/CVC，不扣款 |
| Plans / `plans` | 月付/年付/终身选择、价格/折扣、功能/资源、详情和订阅确认 | 正式不伪造套餐/价格/权益；Lab 显示示例金额并仅确认预览，不创建订阅 |
| Plugins / `plugins` | 2026-10-22 替换原关联应用页：19 项目录、分类/搜索/详情、权限与接入说明 | SMTP 邀请配置状态读取真实管理员接口；其他适配器明确未实现，Lab 只读且不再模拟连接。见[适配计划与验收](implementation/plugin-settings-adaptation-plan.zh.md) |
| Notifications / `notifications` | 消息范围单选、四类邮件开关、移动端覆盖/锁屏预览、保存/重置 | 正式无投递偏好接口，控件禁用并链接真实活动；Lab 安全邮件强制开启仅是演示，不发送消息、不影响业务 SSE |

桌面使用设置侧栏，窄屏改为原生选择器；未知子页明确报错。主侧栏和命令菜单进入新页面；旧 `/settings` 的配置、迁移、诊断、外观/布局入口未替换。共享滚动容器建立定位上下文，避免视觉隐藏表单控件扩大文档高度。

浏览器已观察的验证：

- 六个 Lab 与六个正式路径均实际打开；1440×1000 桌面及 390×844 移动端逐页检查，移动端 `document.scrollWidth=390`。已检查中英文和浅深主题切换、移动端页面选择、命令菜单套餐跳转、旧展示偏好入口往返及套餐方向键选择；未观察到运行时 pageerror。
- Lab 实际操作了 Logo 上传、公司表单保存、停用/删除及重置；个人资料时区校验；账单必填校验、PayPal 复核与无扣款确认；套餐年付/终身切换及确认；Telegram 权限勾选前禁止连接、连接和断开；通知保存、移动端覆盖及锁屏内容切换。
- 正式验收使用真实 PostgreSQL 的隔离随机 schema、实际 API、命令收据与 outbox/SSE，临时前端端口 3247；姓名/时区提交后查询和重载均持久化。另一次真实并发命令产生新版资料，当前页通过 SSE 提示冲突、保留草稿并禁止直接保存；显式采用最新版本后保存成功。
- 六页正式能力边界逐项检查：除姓名/时区及展示偏好外，无未实现服务的可写控件，不回退 Lab 数据。本次不等同真实支付、OAuth、通知投递或生产部署验收，也未重启常驻 3220/4100 服务。
- 最终 `pnpm check:web` 的前端 ESLint、全量 TypeScript 与 Vite 构建通过；构建仍提示大 chunk 和 `workflow-canvas.tsx` 混合静态/动态导入，不将其解释为生产性能已验收。


## 19. 2026-10-20：正式外壳移除左侧图标按钮条

`/pm` 产品外壳不再渲染 48px 快捷导航图标条；左侧只保留 234/256px 工作区侧栏，避免图标条与侧栏重复同一组入口。

- `ServiceFrame` 移除 `activityBar`，并将 `mobileNavigation` 固定为开启；窄屏仍通过页头按钮打开工作区导航抽屉，`data-navigation-close` 行为不变。
- 侧栏内容、链接顺序、折叠按钮和 `referenceLayout` 的 256px 宽度不变；错误页仍使用独立全窗口外壳。
- 浏览器验证 1440×900：图标条不存在、侧栏存在、折叠/展开可用；390×844：抽屉可打开/关闭，`document.scrollWidth == clientWidth`。前端 ESLint 与隔离 Vite 构建通过。

### 2026-10-30 更新：工作区小节去掉新建任务入口，折叠改为图标栏

- 侧栏“工作区”标题旁不再渲染“+ 新建任务”；新建任务继续由各页面工具栏、看板列和命令菜单的既有入口进入，创建页与草稿恢复语义未变。
- 折叠侧栏不再整栏消失：桌面（容器 ≥1024px）折叠后保留 `--workspace-sidebar-collapsed`（56px）图标栏，含工作区徽标、导航图标（首页、我的任务、重要、概览、全部项目、全部任务、日历、时间线、文档、视图、成员与团队、活动）、账户头像和服务连接状态；悬停标题与 `aria-label` 保留完整名称，当前项仍用 `aria-current="page"`。默认仍为完整侧栏。
- 折叠入口：页头面板按钮；或向左拖动侧栏分隔条超过 100px 阈值自动吸附为图标栏，从图标栏右缘向右拖动恢复完整宽度（最小 200px）。
- 展开后恢复 234/256px 完整侧栏；窄屏（非内联侧栏）按钮仍打开完整导航抽屉，图标栏只用于内联折叠状态。
- 浏览器验证：项目列表页 1440×900 折叠显示图标栏、展开恢复完整侧栏且无“+ 新建任务”；820×800 打开抽屉为完整侧栏。`pnpm --filter @pm/web typecheck` 与 `lint` 通过。

## 20. Teams 1–3 正式后端接入

本节接替第 17 节的“事实缺失、写入口禁用”阶段；布局参照保持不变，正式页面不再使用测试响应验收。实施分工和最终检查/激活状态见 [Teams 补齐计划](implementation/teams-backend-completion.md)。

- Team 1：真实标识/说明/工作方向/响应目标，成员与维护者、项目关联、可见开放任务数及实际活动时间；新增、编辑、归档通过版本化命令。SSE 并发变化保留草稿并锁定保存，显式采用当前版本后才可重新提交。
- Team 2：复用脱敏成员目录、本人资料、邀请和在线 TTL；按真实团队分组，不把团队称为部门。邀请入口依赖管理权限和可用 SMTP；管理页提供既有撤销/显式重发。
- Team 3：实际 Markdown 工作项、并行开放估算点、显式容量和应用层三值超载；成员卡创建并分配、任务原生估算编辑及容量 CAS。不可用历史受派人的任务留在任务池，不泄露身份或丢失任务。
- 三页保留原样式并在页头整合布局选择、本人资料与刷新，未恢复重复的独立布局栏。加载、失败、撤权及未知值不回退 Lab 数据。
- 实际浏览器覆盖 1440×1000、390×844，移动端文档宽度均为 390；团队/项目写入、邀请邮件接受后目录刷新、估算零/清空/8 点、5 点容量超载、10 点容量下受限读者仍未知均已观察。源数据来自临时 schema/账号，不写既有业务工作区。
- 前端 ESLint、三种内容/共享契约定向 ESLint、全量 TypeScript 和独立目录 Vite 构建通过；大 chunk 与 `workflow-canvas.tsx` 混合静态/动态导入告警仍存在。证据位于 `.local/evidence/teams-backend/`。

## 21. 2026-10-21：登录页与授权工作区入口

参考 [Notion 登录](https://app.notion.com/login) 的简洁表单层级，以及 shadcnblocks 的[登录](https://shadcnblocks-admin.vercel.app/login)、[找回密码](https://shadcnblocks-admin.vercel.app/forgot-password)、[注册](https://shadcnblocks-admin.vercel.app/register)页面排版；只移植本项目支持的登录部分，不开放参考站的注册、找回、OAuth、Passkey 或 SSO。

- `features/pm/service/pm-auth-page.tsx` 与 CSS 从 EasyuseUI 的认证分栏设计适配：64px 页头、至少 48px 页脚、桌面 44% 品牌栏、最大 384px 表单；移动端隐藏品牌栏，保留主题和语言切换，与现有错误页使用同一品牌和主题 Token。
- `PmLoginPage` 复用真实 `usePmService`、`Field`、`Input`、`Button`、`Alert`：`username` / `current-password` 自动填充、密码显隐、必填与邮箱格式反馈、首个错误字段聚焦，以及检查会话/提交中的按钮文案。邮箱去除首尾空白，密码不裁剪，不将创建账号的最短密码限制套用到登录。
- 错误统一通过 `pmErrorMessage` 本地化，不回显后端内部消息。网络、5xx 或异常登录响应保持未知并锁定重复提交；“检查登录状态”只调用真实会话刷新，确认 401 后才允许再次登录，服务不可用不被解释为无会话。
- `pm-workspace-picker.tsx` 将真实已登录身份、授权工作区、加载、读取失败和无授权空态分开。工作区读取失败不回退登录表单，也不宣称没有工作区；显式刷新可以恢复。登录不代表数据库、Worker 或 Agent 已就绪。
- `ServiceHome` 分别选择登录表单和工作区选择内容；`ServiceFrame` 的 `/pm` 入口不再套用业务 `WorkspaceShell`，登录前后均不显示空工作区侧栏。401 的“返回登录”继续指向 `/pm`，现在落到完整认证页面。账号仍由管理员创建或通过有效邀请创建。

实际验证：

- 前端 ESLint、全量 `tsc --noEmit`、独立目录 Vite 生产构建通过；大 chunk 与 `workflow-canvas.tsx` 混合静态/动态导入警告仍存在，未修改全局打包策略。
- 隔离 PostgreSQL schema、实际 API 和临时 Web 端口 3357 完成错误密码拒绝、正确登录、工作区跳转、整页刷新保留会话、退出，以及无工作区账号的真实空态与刷新；未读取已有账号凭据、修改既有业务数据或重启常驻服务。
- 浏览器受控截断真实成功登录的响应并保留该测试会话 Cookie：表单保持未知且禁用，随后通过会话查询恢复，登录 POST 仅一次。另注入登录/会话查询 503，验证仍保持未知且不泄露原始错误；恢复后的真实 401 查询解除锁定。工作区延迟/503 则验证无错误空态、无错误登录失败判断，并通过真实刷新恢复。
- 浏览器检查 1440×900 与 390×844、中英文/浅深色、空字段与非法邮箱、显隐按钮、提交文案、独立/受保护路由 401 返回入口。实测桌面头部 64px、底部 48px、品牌栏约 633.6px、表单 384px；移动端文档宽度 390px，无横向溢出。未观察到运行时页面异常；导航时取消的请求不算服务失败。


## 22. 2026-10-21：完整设置中心与浏览器偏好

- 以 gr8r-studio 的 21 个设置页与项目设置弹窗为参考，保留原六页地址，扩充为 24 页、7 个分组。共享 `settings-catalog.ts` 驱动正式/Lab 导航与展示目录；旧 `settings?section=preferences/configuration/migrations/diagnostics` 保留，并提供双向入口。
- 外观、语言、日期时间与操作偏好按网站保存在浏览器：三态主题实时跟随系统、六色、侧栏/任务独立密度、减少动效、拼写检查、日历周首、时间格式、启动页、任务打开方式和项目默认视图。有效 URL 参数优先；完成任务筛选不改变统计或工作流。损坏与不可写存储有明确降级提示。
- Profile 复用真实姓名、岗位、电话、时区、头像合同；PNG/JPEG/WebP 不超过 256 KiB，保留完整草稿、CAS 和原命令收据恢复。账号邮箱只读。成员、团队、角色权限及项目生命周期不建立第二套业务实现。
- 改密、MFA、其他设备撤销、工作区改名/删除、支付/订阅/发票、OAuth 和提醒投递没有正式合同，页面明确未知/不可用且禁用。通知 14 个事件选项在正式模式为未知状态；Lab 的通知/账单样例不写真实服务。
- 已运行 `pnpm check:web`、workspace/小时日历定向 ESLint，以及任务集合、项目任务编辑、团队前端模型、个人 Dashboard 集成测试（26 项通过、0 跳过）。构建仍提示大 chunk 和 `workflow-canvas.tsx` 混合导入，不代表已完成性能优化。
- 隔离 schema/API/Web 验证：正式与 Lab 各 24 页，1440px 与 390px 共 96 次页面遍历无文档横向溢出；4 个原生管理入口可用。真实资料持久化/头像移除、SSE 并发冲突、提交成功但响应丢失后的原收据恢复、当前会话退出及未登录隔离均已观察。完整 29 项清单、限制和证据见[设置中心交付清单](implementation/settings-completion-plan.zh.md)。

