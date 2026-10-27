# 设置中心完整设计与交付清单

日期：2026-10-21。范围：以 gr8r-studio 的 21 个设置子页和项目设置弹窗为参考，补齐本项目设置中心，并纳入已有 PM/Markdown 管理能力。用户授权使用 gpt-6.1-sol / xhigh 子代理实现。本文状态以最终验收记录为准。

## 1. 数据与安全边界

- 正式 `/pm` 不使用 fixture 充当账号、工作区、订阅、认证或通知事实。Lab 明确演示；不发送支付、OAuth、邮件或验证码请求。
- UI 完整不代表外部后端能力已交付。没有正式合同的改密、MFA、其他设备撤销、工作区删除/改名、匿名分享、支付/订阅/发票、通知投递必须提供明确原因与禁用控件，不能显示假成功或生成假二维码/恢复码。
- 已有成员、团队、个人资料、项目生命周期、字段/工作流、迁移备份、诊断使用既有服务，不复制业务规则。核心仍为 Markdown 权威；角色为能力模板，团队不授予权限。
- 设备外观/语言等偏好明确保存在当前浏览器，不声称账号跨设备同步。个人资料使用现有版本、命令收据与冲突恢复。保留安全删除确认，不新增可绕过安全约束的开关。
- 相关规范：INV-13/INV-14 的一致性与恢复边界，以及 [权限](../domain-design/permissions.md) 第 1、6、7 节；项目/成员/团队已有实施记录和当前合同优先于原型行为。

## 2. 信息架构与逐页验收清单

状态说明：`已验证` 指本次设置 UI、可用行为或既有入口已完成并按第 5 节验证；`禁用边界` 不代表缺失的后端服务已交付。正式与 Lab 使用同一 24 页注册表，桌面分组导航、移动选择器与存储范围提示齐全。

| ID | 分组 / 页面路径后缀 | 控件、行为与验收 | 交付状态 |
| --- | --- | --- | --- |
| SET-01 | 常规 / general | 保留组织资料、账号危险区与原地址；主题/语言使用浏览器偏好；增加正式工作区名称、图标及颜色设置入口，不混同组织税务资料 | 已实现；入口及资料真实浏览器已验证 |
| SET-02 | 常规 / workspace | 真实资料查询；工作区级 access.manage 保存名称/内置安全图标/固定色板；独立 identityVersion CAS、原 commandId 收据和 outbox；冲突保留完整草稿、未知请求先查原收据；授权工作区选择和侧栏消费同一资料。UUID、Markdown 目录、URL 不变；自定义 URL、停用及删除仍禁用 | 已实现；真实隔离 HTTP/浏览器已验证，统一回归由集成 owner 记录 |
| SET-03 | 常规 / appearance | light/dark/system、实时系统响应、六种强调色、独立侧栏/任务密度、system/reduce 动效；刷新持久化及存储异常提示 | 已验证 |
| SET-04 | 常规 / language | 简中/英文持久化；其余语种禁用；拼写检查接入富文本描述与项目讨论，源码/代码块不启用 | 已验证 |
| SET-05 | 常规 / datetime | 真实个人时区入口、日期格式与预览、周首、12/24h；日历/甘特及时间显示消费偏好，不改全天日期存储 | 已验证 |
| SET-06 | 工作区 / members | 真实成员/邀请读取，角色能力、范围、撤销与 SMTP 限制说明；操作回到既有管理页 | 已验证，复用入口 |
| SET-07 | 工作区 / teams | 真实团队读取；成员/维护者、项目关联、归档回到原页；团队不授予权限 | 已验证，复用入口 |
| SET-08 | 工作区 / projects | 默认详情标签/列表布局、看板完成项显示；有效 URL 优先；原归档/恢复/受保护删除及字段入口 | 已验证 |
| SET-09 | 工作区 / permissions | 复用领域角色模板与能力矩阵、实际授权管理入口；不伪造工作区全局策略或公开分享开关 | 已验证，复用入口 |
| SET-10 | 通知 / notifications | 总览链接四类事件页和真实活动；SSE 与提醒偏好分离，无合同的保存禁用 | 已验证，禁用边界 |
| SET-11 | 通知 / notif-email | 提及、分配、评论、工作日摘要四项；正式值未知/禁用，Lab 草稿、应用预览与重置 | 已验证，禁用边界 |
| SET-12 | 通知 / notif-push | 提及、分配、评论、到期前一天四项；明确无设备注册、权限申请或投递能力 | 已验证，禁用边界 |
| SET-13 | 通知 / notif-mentions | 个人、团队、工作区提及三项；不声称已实现提及识别或订阅 | 已验证，禁用边界 |
| SET-14 | 通知 / notif-assign | 分配给我、本人任务状态变化、逾期三项；正式未知状态与 Lab 内存预览 | 已验证，禁用边界 |
| SET-15 | 个人 / profile | 姓名、岗位、电话、时区、PNG/JPEG/WebP 头像真实保存；邮箱只读；完整草稿、CAS 和原命令收据恢复 | 已验证 |
| SET-16 | 个人 / preferences | 启动页支持首页、Dashboard、任务、项目、活动；新浏览器默认首页，保留已保存选择；任务面板/完整页默认方式接入消费者，删除确认不可关闭 | 已验证 |
| SET-17 | 个人 / shortcuts | 分组说明、真实作用范围、输入框冲突提示；已绑定与参考但未绑定项明确区分，不新增全局劫持 | 已验证 |
| SET-18 | 安全 / password | 真实本人改密：验证当前密码、12–256 字符、持久限流、凭据版本 CAS；撤销其他会话并保留当前；丢响应按安全 action 核对，不持久保存密码 | 已实现；真实 HTTP 证据见第 7 节 |
| SET-19 | 安全 / sessions | 真实本人有效会话列表、单个/批量撤销其他会话、现有当前退出；返回随机会话 ID 与可信创建/到期时间，设备/IP/位置/活动明确未知 | 已实现；真实 HTTP 证据见第 7 节 |
| SET-20 | 安全 / two-factor | 未知状态、认证器流程/验证码/恢复码/停用区域；无 MFA 服务，不生成假二维码或凭据 | 已验证，禁用边界 |
| SET-21 | 计费 / plans | 订阅/续费/额度未知、分级权益与周期示例；正式无价格事实/订阅写入，Lab 明确样例 | 已验证，禁用边界 |
| SET-22 | 计费 / billing | 默认支付方式、账单邮箱/公司/地址/税号；正式禁用，Lab 安全固定卡片示意，不收集卡号/CVC | 已验证，禁用边界 |
| SET-23 | 计费 / invoices | 发票字段/状态表、未接入说明；正式不把未知当空账单，Lab 明确固定样例和筛选空态 | 已验证，禁用边界 |
| SET-24 | 集成 / plugins | 19 项适配目录、分类/搜索/详情；SMTP 邀请真实配置状态与原成员管理入口，其他连接不可用；Lab 不再模拟已连接 | 已验证，见[插件适配交付](plugin-settings-adaptation-plan.zh.md) |
| SET-25 | 本项目 / `?section=preferences` | 七类原正式页面展示偏好；保留重置、工作区浏览器存储及 URL 覆盖语义 | 已验证，复用入口 |
| SET-26 | 本项目 / `?section=configuration` | 原工作流、字段与关系等 Markdown 配置编辑器，保留权限/revision | 已验证，复用入口 |
| SET-27 | 本项目 / `?section=migrations` | 原迁移预览、确认应用、历史备份与受保护恢复；不混同浏览器偏好重置 | 已验证，复用入口 |
| SET-28 | 本项目 / `?section=diagnostics` | 原源码诊断与同步状态；不以健康或就绪状态声称 Agent/SMTP/支付已接通 | 已验证，复用入口 |
| SET-29 | 项目详情 / 设置关联入口 | 名称/描述/负责人/日期回到完整对象，团队/封面回到真实项目；图标/颜色无合同禁用，不新增假字段 | 已验证，复用入口 |

## 3. 子代理所有权与集成合同

所有子代理使用 settings-builder（gpt-6.1-sol，xhigh）。跳过中途 build/lint/tests/format；主代理统一检查和浏览器验收。禁止改后端/合同/迁移以伪造外部能力。

| 工作包 | 文件所有权 / 输出 |
| --- | --- |
| Preferences | workspace/store.ts、workspace/preferences.tsx、新 settings-preferences.tsx 及新偏好模块/样式；真实消费者的偏好接入。导出 SettingsAppearance、SettingsLanguage、SettingsDateTime、SettingsPreferences。与 Workspace 包协商 project defaultTab/showCompleted 接入，Workspace 只画控件 |
| Workspace | 新 settings-workspace.tsx：导出 SettingsWorkspace、SettingsMembers、SettingsTeams、SettingsProjects、SettingsPermissions；真实服务入口与权限解释。不要修改 pm-shell/路由/原成员团队业务模块 |
| Security | 新 settings-security.tsx：导出 SettingsPassword、SettingsSessions、SettingsTwoFactor；准确未知/禁用状态及既有退出当前会话 |
| Notifications | settings-notifications.tsx 与新 settings-notification-events.tsx：导出 SettingsEmailNotifications、SettingsPushNotifications、SettingsMentionNotifications、SettingsAssignmentNotifications |
| Billing | settings-plans.tsx、settings-billing.tsx、新 settings-invoices.tsx：导出 SettingsInvoices；真实/演示明确区分 |
| Personal | settings-profile.tsx、新 settings-shortcuts.tsx：导出 SettingsShortcuts；岗位/电话/头像使用现有本人资料实现与恢复语义 |
| 主代理 | settings-layout.tsx 分组注册及额外管理入口、settings-general.tsx 文案、pm-pages.tsx 必要导航接入、README/本清单、统一检查与真实浏览器证据 |

共享组件 SettingsSection/SettingsNotice/SettingsPageProps 保持原接口。新页面接受 `{mode: "service" | "lab"}`；只在 service 子组件中调用依赖真实工作区的 hooks。所有支持项有明确真实消费者，不能只保存未使用的偏好。

## 4. 验收任务

- [x] 29 项设计落到 24 个页面、4 个原生管理入口及项目详情设置关联；未接入服务明确禁用。
- [x] 7 分组导航、移动选择器、当前页、未知路由返回与旧六页/原工作区深链接均保留。
- [x] 浏览器偏好接入实际消费者；主题/语言刷新保留，损坏与写入失败降级已观察。
- [x] 正式个人资料真实持久化、头像上传/移除、SSE 草稿冲突、刷新后原命令收据恢复、退出与未登录隔离已验证。
- [x] 正式通知/安全/支付能力明确未知和不可用；Lab 通知应用预览后刷新恢复，不混入正式数据。
- [x] 受影响 lint、TypeScript、Vite 构建与 26 项相关现有测试通过。没有修改后端/数据库/事务；未运行全量 `test:backend`，另运行已有隔离个人资料集成测试。
- [x] 浏览器遍历正式/Lab 各 24 页，在桌面与 390px 共 96 次页面检查，并验证真实服务及偏好关键交互。

## 5. 实际交付与证据

### 实现范围

- 6 个 settings-builder 子代理使用 gpt-6.1-sol / xhigh，分别负责 Preferences、Workspace、Security、Notifications、Billing、Personal；主代理整合共享目录、导航、旧入口与文档。
- 页面实现位于 `apps/web/src/features/pm/service/settings/`；共享偏好位于 `apps/web/src/features/workspace/`。Lab 目录由原 38 项增至 56 项。
- 当前浏览器偏好使用版本化键 `pm.display-preferences.v1` 和字段白名单；不会保存资料、密码、支付信息或授权令牌。个人资料继续由服务端保存。
- 首批集成将工作区 URL 指向实际 `/dashboard`；Home 接入后改为 `/pm/<workspace>`，按浏览器启动偏好打开，新浏览器默认 Home。Dashboard 的通用实体回调只对真实工作项应用任务打开偏好，项目/里程碑保持完整对象入口。

### 已运行检查

- `pnpm check:web`：前端 ESLint、全量 TypeScript、Vite 生产构建通过；集成修正后重新通过。
- 补充 ESLint：`workspace/store.ts`、`preferences.tsx`、`preference-format.ts`、`views/pm/hour-calendar.tsx`、`hour-calendar-contracts.ts` 通过。
- `node --env-file=.env --test tests/task-collection.test.ts tests/project-task-editing.test.ts tests/team-frontend-model.test.ts tests/dashboard-personal.integration.test.ts`：26 通过、0 失败、0 跳过。
- 构建保留大 chunk 和 `workflow-canvas.tsx` 混合静态/动态导入警告；没有借本次设置工作改动全局打包策略。

### 真实浏览器证据

临时 Web 端口 3358，API 端口 36453；使用既有隔离 fixture 创建临时 PostgreSQL schema、测试账号和临时存储，种入 1 个真实项目、1 个开放任务、1 个完成任务。通过实际 Outbox 发布驱动 SSE，不伪造 Worker 心跳或 Agent 就绪；未操作既有业务工作区。

| 场景 | 实际结果 |
| --- | --- |
| 页面与响应式 | 正式/Lab 各 24 页在 1440px、390px 均渲染，共 96 次；文档无横向溢出，未观察到 pageerror。移动选择器成功切换发票页；4 个原生管理编辑器正常打开 |
| 外观与语言 | dark 刷新保留；system 实时响应模拟 OS 的 light/dark；青绿语义色生效，紧凑侧栏实测 30px、任务行 token 34px；英文刷新保留 |
| 日期与操作偏好 | yyyy-MM-dd/12h 示例正确，真实任务日历从星期日开始；启动页进入项目列表；任务侧栏与完整对象页均实际点击验证 |
| 项目偏好 | 默认进入看板，隐藏完成任务后 TASK-001 保留、TASK-002 隐藏，统计仍为 1/2；显式 `tab=overview` 优先；项目讨论容器消费关闭拼写检查的偏好 |
| 浏览器存储异常 | 损坏 JSON 使用默认值并提示；实际注入 Storage 写入失败后当前主题仍应用、显示会话级限制，刷新恢复此前已存值 |
| 本人资料 | 姓名/岗位/电话/时区提交后重新读取仍一致；真实 PNG 头像保存、刷新可读，移除后服务字段为 null |
| 并发与未知收据 | 双页面更新触发 SSE，新服务版本不覆盖本地完整草稿；显式采用最新版本后保存成功。故意丢弃一次已 committed 的 HTTP 响应，刷新后查询原 commandId 恢复，资料版本为 8，未重复提交 |
| 能力与会话 | 正式邮件事件显示 mixed/unknown 且禁用；Lab 应用预览后刷新回到初始样例；当前会话退出实际返回 `/pm`，之后受保护资料页显示登录入口且无私有资料 |

证据保存在 `.local/evidence/settings-completion/`：`browser-results.json`、`appearance-desktop-dark.png`、`invoices-mobile-service.png`、`profile-real.png`。这不是全量分支、支付/邮件/认证提供商或生产部署验收；原生配置/迁移/生命周期编辑器本次验证入口，沿用既有业务合同与测试，不执行不必要的破坏性操作。

### 仍明确不可用的服务能力

工作区改名/自定义 URL/图标/颜色/删除、改密、MFA 注册与恢复码、其他设备查询/撤销、通知订阅与投递、订阅计费/付款/发票、外部 OAuth 仍无正式合同。本次完成的是完整设置界面、已有真实能力接入和明确禁用边界，不将这些外部服务标记为已实现。真实 Agent 仍未验收。

收尾：`pnpm check:docs` 通过（63 个 Markdown 文件、27 个计划步骤与领域引用）；另检查本轮四份文档的 40 个本地链接，无缺失。临时浏览器已关闭，Web/API 已停止，API 以 exit 0 输出 `SETTINGS_SMOKE_CLEANED`，隔离 schema/临时存储完成清理；一次性脚本和上传图片已移除，只保留验收证据。未提交或推送 Git。

## 6. 工作区资料服务增量（2026-10-23 · WorkspaceService）

### 实现与合同

- 迁移 `0020_workspace_identity.sql` 为既有 `workspaces.name` 增加安全 `icon`、`color`、独立 `identity_version` 和更新时间；不移动目录、不新增 slug、不改变已有 UUID 或入口地址。`Workspace.version` 仍是当前成员授权版本，不能作为资料 CAS 版本。
- `GET /api/v1/workspaces/{workspaceId}/identity` 只向当前有效成员返回 `{workspaceId,name,icon,color,version,updatedAt}`；不读取或混入账号联系方式、私有便签、项目内容或其他工作区资料。授权工作区列表另含 `icon/color/identityVersion`。
- `UpdateWorkspaceIdentity` 使用现有命令内核：工作区级 `access.manage`、`targetId=workspaceId`、`expectedVersions[workspaceId]=资料version`，完整提交 `{name,icon,color}`。旧版本/缺失版本拒绝；状态、原命令收据和 metadata-only outbox 同事务提交。收据重读和幂等重放继续检查当前权限及原主体。
- 图标采用六个应用内置 Lucide 图形；颜色复用原设置页六色安全色板。不接受 URL、上传 SVG 或任意 CSS，不引入外部图片跟踪。正式设置、选择页和侧栏使用同一表示。
- 正式设置按账号/工作区保留本次应用会话内普通草稿；刷新不承诺保留普通草稿。服务更新不覆盖完整草稿，明确比较并选择采用最新版本或放弃草稿。结果未知时复用持久命令日志中的原 `commandId`，刷新后先查原收据，不自动换键重发。

### 增量验收边界

- 已添加 `tests/workspace-identity.integration.test.ts`：真实 PostgreSQL/HTTP 的管理员保存重读、列表消费者、核心文件不变、并发 CAS、缺版本、幂等与同键冲突、权限与收据撤权、最小 DTO、私有资料和跨工作区隔离、安全图标/颜色拒绝、受限成员资料 invalidation。
- 子代理未运行 build、lint、tests 或 formatter；新增回归由集成 owner 统一执行，不把该源码或历史通过结果当成本轮全量检查结果。
- 集成后使用随机 PostgreSQL schema、临时核心/内容根目录与 API `39487`，真实 HTTP 验证保存重读、原收据与幂等、旧版本 409、受限成员写入拒绝、外链图标 400、无权限工作区及他人收据 404、最小 DTO 和私有便签不泄露、真实 outbox 发布后的受限身份 invalidation。证据 `.local/evidence/workspace-identity/http.json`。
- 浏览器使用互相隔离的 `pm-workspace.localhost:3369`（受限只读）及 `pm-workspace-admin.localhost:3369`（管理员）；真实登录和入口导航、设置输入/图标/颜色选择与保存按钮已操作，命令返回 committed，重读/刷新一致。只读表单和色板禁用、无保存按钮；管理员保存后只读侧栏无需刷新即更新名称/图标/颜色。
- 初始开发入口出现模块导航超时及一次临时 503，真实重试恢复；后续采用集成 owner 构建的 production preview，未自行构建。生产预览实测：本地完整草稿遇外部版本 4 时保留名称/图标/颜色且禁止保存，显式采用最新版本后按钮保存为版本 5；真实提交版本 6 后注入响应丢失，刷新仍保留原 commandId，点击“查询原命令收据”恢复同一 committed 结果，版本只增加一次且最终版本只发布一条事件。没有固定成功 mock。
- 生产预览只读页面与最终授权工作区选择在 390px 下 `scrollWidth=390`；选择页显示最终服务名称及本地图标/颜色。证据 `.local/evidence/workspace-identity/browser.json` 及同目录截图；未观察到 pageerror。该证据不等同生产公网部署或所有历史命令分支验收。
- 两个自有浏览器 tab 已关闭，dev/preview 自有进程已停止；隔离 API 以 `WORKSPACE_IDENTITY_SMOKE_CLEANED`、exit 0 完成 schema/临时根目录清理，一次性脚本已删除。未停止默认服务或修改真实业务数据；清理记录 `.local/evidence/workspace-identity/cleanup.json`。
- 待用户决策：自定义 URL / slug 的唯一性、历史链接与改名策略；工作区停用、恢复与删除、保留期及历史/附件影响。当前安全默认是这些操作不可用，资料改名绝不自动触发它们。


## 7. 本人账号安全服务增量（2026-10-23 · AccountSecurity）

### 实现与安全合同

- 迁移 `0021_account_security.sql` 增加全账号 `credential_version`、改密时间、会话公开随机 UUID、仅白名单列的不可变私有 `account_security_actions`、跨进程持久限流计数。密码仍使用既有 scrypt（N=32768、r=8、p=1），会话令牌仍仅存 SHA-256 摘要；令牌与摘要均不进入公开 DTO。
- `GET /api/v1/auth/security` 仅返回当前认证主体的有效会话、密码规则与凭据版本。`POST .../password` 验证当前密码、CAS、五次/15 分钟限流；普通登录另按账号十次/15 分钟及来源 IP 二十次/分钟限流。过期限流行在后续认证请求中按索引清理，不因进程重启或事务回滚重置有效计数。
- 改密事务保留当前已有高熵 HttpOnly 会话且不延长到期时间，原子撤销该账号的所有其他会话。登录在 scrypt 校验后持有同一用户行锁重新核对密码摘要/凭据版本；已验证旧密码但排在改密后面的登录不能创建存活会话。改密、会话操作、退出按同一锁排序，取得锁后重新验证真实当前 token，不能沿用撤销前的认证快照。
- `POST .../sessions/revoke` 只接受本人会话 UUID 或 `others`，不接受 actor/userId；针对他人和不存在会话统一拒绝，当前会话由原 logout 单独退出。设备、浏览器、IP、地点和最近活动没有来源，返回 null 并明确显示未知；会话数不冒充设备数。
- 账号安全不属于某个工作区，不把密码投入普通工作区命令摘要、IndexedDB journal 或 outbox。仅安全 action ID/kind 写入按 actor 隔离的 sessionStorage；密码仅在输入/请求内存短暂存在并在提交时清空，不写浏览器恢复存储、收据、事件或日志。
- `GET .../actions/{actionId}` 返回本人安全收据，缺失不是“可重试”的证据。用户显式核对调用 `POST .../actions/{actionId}/recover`：同一用户锁内返回原结果，或先持久取消 fence，阻止延迟原请求以后执行。普通网络错误、503、非可信响应不自动当成改密失败，不盲重发密码或换 action 重做。
- 正式密码/会话页接通真实客户端；Lab 仍完全禁用真实凭据输入。MFA 保持未知/禁用，不将成员角色或普通登录成功当作 MFA 证据。

### 增量证据与待讨论

- 已添加真实回归 `tests/account-security.integration.test.ts`（八个场景），覆盖双会话改密、旧/新密码、他人隔离、持久限流、CAS、真实服务提交后传输丢失、安全取消 fence、已验证旧登录排队、撤销后在途改密及已打开核心流撤销；`tests/account-security-recovery.test.ts` 覆盖恢复 marker 白名单与损坏拒绝。子代理未运行测试/build/lint/formatter，最终检查由集成 owner 统一记录。
- 隔离 PostgreSQL schema/临时内容根目录和 API 上，真实 HTTP smoke 已验证：改密返回 committed、撤销另一个会话，其受保护请求 401；旧密码登录 401、新密码 200；他人会话撤销 404、他人 action 不可见；原 action 缺失时 recover 写 cancelled，延迟原改密 409。证据：`.local/evidence/account-security/http-smoke.json`。该 HTTP 证据不替代浏览器按钮验收。
- 真实服务提交后注入传输丢失、malformed 2xx、503 三种响应故障，正式客户端均抛错而不误当拒绝；原 action 查询/重复 recover 均找回同一 committed 收据，没有重发。`.local/evidence/account-security/http-fault-matrix.json` 记录底层真实 HTTP 状态和恢复结果，不伪造服务成功。
- 集成 owner 的 production 构建由独立 `127.0.0.53:3377` preview 接入隔离 API，避免不同验收共享 Cookie 域。真实浏览器按钮验证：当前密码错误拒绝并清空字段；malformed 2xx 与丢响应都进入 unknown、禁止新写，只有 actionId/kind 的恢复 marker 跨刷新保留，显式核对恢复 committed；旧密码 401、新密码 200；单个及批量撤销其他会话后，原会话受保护请求 401；当前会话退出经服务端完成后 401 且私有页面清空。390px 窄屏 documentWidth=390；实际 localStorage/sessionStorage/IndexedDB 扫描未发现测试密码。证据 `browser-smoke.json` 与同目录四张桌面/手机截图。
- 额外真实发现并复现了旧核心 SSE 的撤销漏洞：新请求虽为 401，旧流仍在 15 秒心跳窗口内收到新的核心事件（`core-sse-before-fix.json`）。集成 owner 修复 `core-routes.ts`，每次发送前重新核对当前会话/授权，并保护关闭后的异步回调。fresh API + 已打开的旧浏览器核心/PM 双流复验：撤销后立即真实创建核心项目及私有便签并发布 outbox，旧核心流零条新 change 并关闭，旧 PM 流零条新 change 且 unauthenticated；旧浏览器显示登录且清空私有页面，保留会话仍 200 并收到核心 1 条、PM 1 条。证据 `revoked-streams-after-fix.json`、`retained-streams-after-fix.json`、`revoked-session-login.png`。
- 两轮独立 API 均通过 fixture.close 完成随机 schema/临时内容根目录清理并 exit 0；所有自有 dev/preview 及浏览器 tab 已关闭，一次性脚本与 fixture 元数据已删除，仅保留安全证据（`cleanup.json`）。未读取部署凭据，未停止默认服务或修改真实业务数据；证据不是公网部署、MFA 或 SSO 验收。
- 待用户决策：MFA 提供方、注册/挑战/恢复码与恢复策略；SSO/OIDC 提供方、账号关联与失联恢复。邮件密码找回已独立采用新挑战和独立可信邮箱的批准合同，见下节；不得把历史登录/邀请邮箱直接视为可信地址。


## 8. 独立可信恢复邮箱与密码重置增量

- 实施合同与完整外部门禁见[邮件找回计划](service-password-recovery-plan.zh.md)。`0027_account_recovery.sql` 为所有既有账号提供空的独立 recovery_email/verified_at 与 CAS 版本，绝不回填历史 email/邀请。本人登记需要真实当前密码+session+版本，打开专用新邮件并以同一账号确认才建立信任；候选取消保留旧信任，显式解绑才降级。
- 正式 `/pm/account/security` 不要求 workspace；设置密码页复用同一恢复邮箱面板与安全 action marker。新 fragment 页只在内存保留 token，立即清 URL；密码发出即清空，unknown 只查原 action/request 并由显式 recover 写取消 fence，不盲重发。匿名 reset 原子消费 token、改密并撤销全部会话，不沿用普通改密保留当前会话策略、不自动登录。
- 集成后 PG/HTTP/SMTP/Worker 与浏览器已执行：消费独立邮箱验证邮件、申请找回、一次性重置、旧会话401与新密码登录200；无 workspace 路由 provider 缺失已修复。见[五包交付](service-completion-and-acceptance.zh.md#five-package-delivery)。enabled 不证明公网送达；发件身份/收件人、失联恢复和旧备份凭据信任仍是门禁。

