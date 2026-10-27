# 前端设计模式采用记录：Project Management

版本：0.2 · 日期：2026-10-17 · 状态：表层与真实服务人工链路已有浏览器证据；最新组件/移动端修复的最终回归待汇总，物理环境复访未完成

本记录登记本应用对 [AI 与项目协作工作台设计模式](../../DESIGN-PATTERNS.md)（下称“方案”）的采用范围、Token 映射、局部例外与验收证据。方案是设计提案；本应用按方案的“语义 Token → 基础控件 → 业务组合 → 页面布局 → 宿主适配”顺序落地，并在下文列出偏离项与理由。

## 1. 采用范围

| 项 | 内容 |
| --- | --- |
| 影响范围 | `apps/web` 表层：`src/styles/theme.css`、`src/index.css`、`components/ui`、`components/blocks`、`views/pm/*.module.css` 的字面量与状态样式、工作区外壳几何 |
| 历史采用边界 | 最初表层批次不改 fixture/受控契约；后续真实服务接入已调整路由、会话及日期 metadata 合同，不能继续视为纯样式改动 |
| 当前数据边界 | `/pm` 由本仓库真实服务提供身份、能力、数据与命令；`/lab/pm` 独立保留固定时钟 2026-01-12T09:00Z、UTC 的确定性 fixture；两者不回退混用 |
| 交互基元 | Radix UI + Tailwind v4 + Vite 8 + React 19；专用 dnd-kit、FullCalendar、TanStack Table/Virtual、React Flow/ELK、Recharts、Tiptap、cmdk 复用同一主题，清单与备选见 [移植清单](frontend-porting-manifest.md) 第11节 |

## 2. Token 映射

方案候选值映射到本应用既有语义变量，不新增并行的全局主题。浅色/深色各自完整定义。

| 方案角色 | 方案初值（浅/深） | 本应用变量 | 实际值（浅 / 深） | 说明 |
| --- | --- | --- | --- | --- |
| canvas | `#FAFAF9` / `#111110` | `--background` | `#fafaf9` / `#111110` | 应用背景 |
| surface | `#FFFFFF` / `#181817` | `--surface` | `#ffffff` / `#181817` | 阅读区、主体面板 |
| surface-raised | `#F4F4F2` / `#222220` | `--surface-raised`、`--surface-hover` | `#f4f4f2` / `#222220` | 工具栏、次级区域、hover 底色 |
| foreground | `#232322` / `#ECECE8` | `--foreground`、`--primary` | `#232322` / `#ecece8` | 主按钮填充改用前景色与反相文字 |
| secondary | `#666660` / `#B0B0A8` | `--text-secondary` | `#666660` / `#b0b0a8` | 辅助文字与元数据 |
| — | — | `--text-muted` | `#6f6f68` / `#a0a099` | 更弱的元数据；对比度按合成后背景校验 |
| border | `rgba(0,0,0,.10)` / `rgba(255,255,255,.10)` | `--border`、`--border-hover` | 同方案 / `.18` | 普通结构边界 |
| accent | `#A6533A` / `#DE9A7B` | `--accent`、`--selection-marker` | `#a6533a` / `#de9a7b` | 少量暖色：选中标记、未读入口、封面晕染 |
| focus | `#A6533A` / `#DE9A7B` | `--focus`、`--ring` | `#a6533a` / `#de9a7b` | 独立键盘焦点环，与 hover/选中区分 |
| 状态色 | 绿/红/琥珀附文字或图标 | `--success`、`--destructive`、`--warning`、`--info`、`--agent` 及 `--status-*` | 保留独立语义，具体值见 `theme.css` | 状态不合并为单一“成功”标记；未读取完成不显示为零 |
| 图表 | 默认降低饱和度 | `--chart-1..5` | `#7a6a63`… / `#b9a79d`… | 多系列保留区分色，不强制灰阶 |

排版、圆角、动效与几何同样以变量给出，命名与职责一一对应：

| 组 | 变量 | 值 |
| --- | --- | --- |
| 排版 | `--text-meta` / `--text-control` / `--text-body` / `--text-reading` / `--text-section` / `--text-page` | 12/16、13/20、14/20、14/24、16/24、20/28 |
| 圆角 | `--radius-inline-value` / `--control-radius` / `--radius-popover-value` / `--radius-module-value` / `--radius-panel-value` / `--radius-bubble-value` / `--radius-composer-value` / `--pill-radius` | 4、6、8、12、16、20、24、999px |
| 几何 | `--workspace-header-height` / `--workspace-sidebar-width` / `--workspace-sidebar-collapsed` / `--workspace-secondary-width` / `--workspace-inspector-width` / `--row-height` | 56、256、56、234、360、44px |
| 控件 | `--control-height(-sm/-lg)` / `--touch-target` | 32（28/36）、44px |
| 动效 | `--motion-hover` / `--motion-button` / `--motion-popover` / `--motion-panel` / `--motion-drawer` / `--motion-layout` | 140、160、180、200、240、280ms（ease-out 族） |
| 材质 | `--shadow-composer` / `--shadow-floating` | 一层轻阴影 / 一层浮层阴影（含 1px 顶边高光） |
| 输入区 | `--composer-min-height` / `--composer-max-height` | 68 / 240px（超出后内滚） |

Tailwind 侧通过 `@theme inline` 暴露同名工具类（`rounded-module`、`rounded-panel`、`text-meta` 等）。此前 `rounded-panel` 未定义，本轮补齐并修正使用方：对话框/警告对话框/抽屉使用面板圆角，内容模块使用 `rounded-module`。

## 3. 页面声明

| 页面族 | 用户目标 | 布局模式 | 几何与滚动 | 材质角色 |
| --- | --- | --- | --- | --- |
| 项目集合（list1–4） | 比较项目进展并进入项目 | 集合 | 业务页头 56px；集合二级栏 234px；卡片网格 3 列、间距 20px；主区独立滚动 | 卡片不透明表面，无装饰阴影；封面为中性身份区 |
| 任务集合（list1/2、看板、日历、甘特、表格） | 筛选、比较、切换同一批任务的视图 | 集合 + 多视图 | 单行数据行 ≥44px；看板列 320px、卡间距 12px，列内纵滚、看板横滚 | 行与卡片平坦；选中为持久底色加标记 |
| 详情（项目 detail1/2、Lab 任务 detail1/2） | 阅读理解正文并编辑属性 | 详情 | 正文与属性栏各自滚动；属性栏自 360px 起 | 正文表面平静；属性保存失败保留输入 |
| 正式任务共享详情 | 在任务集合右侧连续阅读、编辑同一 Markdown 对象 | 右侧详情 / 完整对象页 | 常规侧栏约 620px；源码模式在宽屏并排展示编辑器与实时任务视图，窄屏切换；390px 无页面级横向溢出 | 标题、属性、阻塞项、描述、真实子任务、成果证据与审计；字段与检查项暂存到同一源码草稿，显式保存；高级能力保留 |
| 仪表盘（dashboard1–4） | 判断范围与进展，再下钻到集合 | 分析 | 摘要 → 图表 → 可下钻列表；指标与列表共用同一筛选 | 图表降低饱和度；数字使用等宽数字 |
| 成员/团队展示（member1–3、team1–3） | 正式入口由设置页选择成员/团队布局；team1 为空团队，team2 使用真实成员目录，team3 使用真实分派工作量 | 集合/详情 | 表格与卡片两种密度；行 ≥44px | 不伪造团队、在线状态或容量 |
| 收件箱展示（inbox3/4；inbox1/2、email1 仅 Lab） | 正式 notifications 使用 inbox3/inbox4 展示真实活动事件；邮件线程与已读/归档状态不伪造 | 收件箱/活动 | 展示阅读区独立滚动，正文轴最大 720px | 不把邮件 Composer 当作已接通邮件服务 |
| 设置（浏览器偏好与页面布局） | 管理三态主题、强调色、独立密度、动效、语言、日期时间与默认入口 | 设置 | 即时生效；一般偏好按网站、原页面布局按工作区存于当前浏览器；URL 明确参数优先 | 不写业务数据，不声称账号同步；存储损坏/写入失败明确降级 |
| 完整设置中心（24 页、7 分组） | 管理真实本人资料并连接既有成员/团队/权限/项目管理；准确标明缺失的安全、支付、OAuth 与通知能力 | 设置 | 桌面 190px 分组子导航独立滚动，窄屏选择器；正文最大 36rem，复杂页使用宽分组；保留 4 个原生管理入口 | 正式禁用缺失能力；Lab 业务表单离页重置，外观与操作偏好真实影响同一浏览器 |
| 小时排期（events） | 查看小时布局中的真实全天日期 | 集合/日历 | 月/周/日切换，日历内部滚动 | 服务不保存时刻；只编辑全天行 |

跨页连续性：正式路径由 TanStack Query 管权威快照，服务表单保留未提交草稿，未知命令用 IndexedDB 保存原请求身份；Lab 的 session/controller 单独管理样例交互。关闭面板、退出编辑与放弃草稿是不同动作；目前证据不等同于所有页面阅读位置均已持久化。

## 4. 状态与动效

| 状态轴 | 实现 | 证据入口 |
| --- | --- | --- |
| Interaction | hover 使用 `--surface-hover` 弱底色；选中使用 `--selection` 持久底色加 `--selection-marker` 标记；键盘焦点使用 2px `--focus` 环（紧凑列表内用 `outline-offset: -2px`） | 任意集合页；本项目实测「选中底色 ≠ hover 底色（暖色 vs 中性）」 |
| Data | loading、empty、refresh-error 保留快照、unavailable/readonly 说明；命令冲突保留草稿、unknown 阻止后续写入并提供原收据核对 | 正式服务状态与双会话/丢响应实测；`?scenario=` 仅在 Lab 复现样例 |
| Runtime | 正式 Agent 能力明确未启用，不显示模拟运行成功；人工命令 unknown 与 Agent Run 状态分开 | 正式 capability/禁用说明；Lab 运行文案仅展示 |

动效按方案的节奏分离实现：hover/颜色 140ms、按钮 160ms、浮层 180ms、面板 200ms，布局动画与运行提示分开；`prefers-reduced-motion: reduce` 下动画与过渡降到 0.01ms 且不依赖动画传达语义。

## 5. 局部例外（登记）

| 项 | 本项目取值 | 方案初值 | 理由 | 作用域 | 复访条件 |
| --- | --- | --- | --- | --- | --- |
| 集合二级栏宽度 | 234px（Lab 可拖拽 200–320，正式服务 200–360）；窄屏改抽屉 | 新页面导航 256px | 复用现有 adaptive shell、48px 快捷导航和抽屉，避免窄屏把文字压成单字列 | `features/pm/pm-shell.tsx`、`workspace-shell` | 引入第二套外壳或调整导航层级时 |
| 看板卡片圆角 | 8px | 内容模块 12px | 卡片位于看板列内，内部控件小于外部容器；列已为 12px | `components/blocks/work-items.module.css`、看板视图 | 看板列改为无圆角表面时 |
| 项目卡片封面 | 保留 160px 身份区，改为中性表面 + 低对比纹理 + 浅陶土晕染 | 不在页面铺设大面积渐变与光晕 | 原多色渐变与压暗层与方案的克制材质冲突；身份改由编号、名称、状态承担 | `views/pm/project-list-1.module.css` | 产品确需图像封面时另立条目 |
| 邮箱/通知 Composer 高度 | 变体初始 90/106/128px | 初值 68px，上限 240px | 邮件正文比即时输入更长；上限与内滚已按方案统一 | `views/pm/inbox.module.css` | 引入对话式输入区时 |
| 紧凑活动流行高 | 40px | 单行数据行 ≥44px | `data-compact` 是刻意的密排时间线，正文未被裁切 | `components/blocks/activity-timeline.module.css` | 活动流改为可操作行时 |
| 图表轴刻度与密集标注 | 12px | 元数据 12px | 本轮已把 ≤11px 的元数据提升到 12px 下限；轴刻度不再继续缩小，也不再增大以免重叠 | `views/pm/schedule-views.module.css`、`components/ui/chart.module.css` | 图表密度规则变化时 |
| 数据来源 | 正式服务与 Lab 明确分开 | 宿主提供真实结果 | 原 fixture-only 例外已结束；仍保留样例目录便于设计回归 | `/pm` / `/lab/pm` | 新服务能力接入、生产 Lab 门禁验收时 |

头像缩写等纯装饰字形仍低于 12px；它们不是可读字段，不适用元数据下限。列表/卡片中剩余的字面量圆角值（4/6/8/12px）与角色刻度一致，未强制替换为变量，避免对非角色语义的位置做批量猜测。

## 6. 验收状态（分批记录）

下表保留最初表层采用批次的证据；其中路由、构建和几何结果不自动覆盖后续真实服务组件或最新移动端改动。

| 项 | 结果 |
| --- | --- |
| 源码 | Token 层重写；`index.css` 基底层（焦点环、选中色、等宽字体、减少动效）；基础件与视图样式按角色修正圆角、行高、材质与状态 |
| 构建 | `apps/web`：`tsc --noEmit` 0 错误，`vite build` 通过；仓库 `pnpm check`（文档、契约漂移、lint、类型、无数据库测试、后端构建）通过 |
| 浏览器实测 | 11 条产品路由与 404 页全部渲染，浅/深主题截图；中/英各抽查；`prefers-reduced-motion` 模拟下过渡折叠到 0.01ms；键盘 Tab 焦点环、行 hover/选中、对话框 16px 圆角、选择菜单、空/加载/刷新失败/只读/长内容场景 |
| 几何实测 | 外壳业务页头 56px、集合二级栏 233–234px、任务行 44px、对话框圆角 16px、Composer 24px 圆角 + 一层轻阴影、无页面级横向溢出（`scrollWidth == clientWidth`） |
| 对比度 | 浅色正文 `#232322`/`#fafaf9` = 15.1:1、次级 `#666660` = 5.5:1、弱化 `#6f6f68` = 4.9:1（在 `--surface-raised` 上 4.6:1）；深色正文 `#ecece8`/`#181817` = 15.0:1、次级 `#b0b0a8` = 8.1:1、弱化 `#a0a099` = 6.8:1；状态色与焦点色 ≥4.5:1 |
| 当时未覆盖 | 物理环境（2560×1440、系统缩放 150%）、真实 IME、触摸设备与真实服务业务；其中真实服务人工链路已由下列后续证据补充，自动化 DPR 仍不能替代物理环境 |

2026-10-17 后续接入证据：

| 项 | 已观察结果与边界 |
| --- | --- |
| 正式人工闭环 | 真实登录、创建/激活项目、任务 ready/start、文件登记/证据/提交/审核/显式完成；重新加载仍为 done，下载 SHA-256 一致 |
| 并发/未知结果 | 服务提交后丢响应，原 commandId 经 IndexedDB 跨刷新保留，查询原收据后恢复；双 owner 日期冲突保留草稿并要求显式 rebase |
| 权限/实时 | 只读用户不能创建/移动，owner 更新通过 SSE 到达 reader；日期20–22Oct2026 在 FullCalendar 与甘特一致，依赖图2节点1边持久化 |
| 组件交互 | Storybook 抽查指针/键盘看板、日期编辑、ELK、白板撤销/重做/刷新、Tiptap Markdown、虚拟表格和甘特刻度；这些是本地样例 |
| 主题/导航 | 正式路径中英切换、深浅主题、命令面板搜索任务并跳转已操作；ELK 改为真实 Worker 后未观察到 runtime pageerror |
| 最新统一检查 | `check:web`（含受影响视图/fixture lint、TypeScript、Vite）通过，Storybook 构建通过；32/32 Lab 巡检无 pageerror，跨视图草稿/选择/搜索复验通过 |
| 移动端复访 | 390×844：快捷导航、导航抽屉、正文与纵向元数据可用；detail2 保留真实元数据，document.scrollWidth=390 |
| 权限与恢复补验 | 成员单项目授权及撤销后私有内容清空；离线旧快照提示、HTTP 503 刷新失败标记及手动重试恢复；构建 preview 真实 Worker 图布局通过 |

详细真实服务证据及测试时间边界见 [交付记录](implementation/backend-delivery.md)。生产部署、真实团队/邀请/邮件与 Agent 执行均不在已通过范围。

2026-10-20 顶部页面版本切换：语言切换后新增图标下拉，在概览、项目、项目详情、成员、团队页切换当前页面版本（仪表盘 1–4、项目列表 1–4、项目详情 1–2、成员列表 1–3、团队列表 1–3）；左侧栏不再展开这些版本子项，其他页面不显示该入口。标签跟随中英界面，当前版本带选中标记。`/pm` 与 `/lab/pm` 已实际点击跳转，390×844 下 `document.scrollWidth == clientWidth`；`pnpm check:web` 通过。该改动只调整导航壳层，不改动服务能力或页面数据。

2026-10-21 侧栏底部账户菜单：正式 `/pm` 新增参考站的左下角头像入口与 260px 账户卡片，复用语义 Token、Popover 焦点归还和 Popover 碰撞检测。卡片包含身份头、查看个人资料、账号设置、三态主题、键盘快捷键和退出；头像在首次打开时才读取 `PersonalDashboard`，失败回退姓名首字母。身份、资料、主题、路由与退出均来自现有真实来源；没有新增合同或后端字段。按计划保留两项有意差异：不伪造在线绿点（缺少轻量本人 presence 来源），不显示未绑定的 `?` 键帽。`/lab/pm` 未改。桌面 1440×900、折叠侧栏、390×844 抽屉均实际打开卡片；主题切换保持卡片打开并在重载后保留，Escape/外部点击关闭并交还焦点，资料深链关闭后清除参数，退出返回登录。`pnpm check:web` 与 `pnpm check:docs` 通过。实现与证据见[侧栏底部头像用户菜单复刻计划](implementation/sidebar-user-menu-replication-plan.zh.md)。

Settings 已由六页扩充为 24 页、7 分组，原工作区配置与展示偏好入口保留。浏览器逐页检查正式/Lab 的桌面与 390px 布局；隔离真实数据库/API 验证本人五字段与头像保存、SSE 并发草稿、原命令响应丢失后的收据恢复，以及偏好持久化、存储降级和实际消费者。29 项设计清单和验收记录见[设置中心交付清单](implementation/settings-completion-plan.zh.md)。此证据不代表改密、MFA、支付、订阅、OAuth 或通知投递接通。


## 7. 复访与后续

- 本机统一前端回归与移动端复访已完成；继续覆盖完整身份切换、浏览器游标过期及所有命令分支矩阵，不把已有后端测试当作浏览器证据。大 chunk 提示仍保留，生产性能和公开部署未验收。
- 真实人工对话、成果/审核面板已加入服务层；后续执行状态组件必须另行登记几何与能力来源，不能沿用样例运行态冒充 Agent 接入。
- 方案候选值与本文实际值的差异以本文为准；方案若更新，先比对第 2 节映射再改动 Token。
