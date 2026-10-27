# 插件设置入口适配计划与交付

日期：2026-10-22。用户选择的本轮范围：**插件设置入口与适配计划**。两个 `settings-builder`（gpt-6.1-sol / xhigh）子代理分别实施目录与 SMTP 状态，主执行者负责集成和真实浏览器验收。状态：指定范围已实现并通过前端检查与浏览器验收。

五包实施增量：安全 Webhook 的应用/协议/持久模型与插件卡片已接入，隔离 PG/HTTPS/DNS/Worker/浏览器已执行，见[当前交付](service-completion-and-acceptance.zh.md#five-package-delivery)。下方原目录/SMTP记录是历史，不替代新增证明或生产接收器验收。


## 1. 决策与范围

- 在正式 `/pm/<workspace>/settings/plugins` 建立插件中心，替换旧 `connected-apps` 页面及其导航消费方；Lab 使用同一目录，不再模拟外部账号已连接。
- 本轮“插件”指随应用发布的内置适配能力目录，不是可下载安装任意代码的插件运行时。没有插件包上传、第三方代码执行、OAuth 授权或连接凭据表单。
- 提供分类、搜索、详情、范围/权限说明、接入要求和当前实现边界。保留既有应用目录的信息，增加 SMTP 邀请、通用 IMAP、Microsoft 365 和通用 Webhook 的准确能力说明。
- 唯一已有的邮件能力是 SMTP 成员邀请。其配置状态读取现有管理员邀请列表合同 `InvitationListDto.enabled`；它不证明 SMTP 连通、公网送达、邮箱读取或一般任务通知已可用。
- 未实现适配器明确标注“未实现 / 不可用”，不标记为未配置，不允许安装、连接、发送或同步。无权限、加载中、读取失败与未配置分开；错误时不把旧快照显示为当前可用。
- 配置密钥仍由部署管理，不在浏览器收集或展示。邀请创建、撤销、重发继续使用既有成员页面和应用服务，不新增业务命令、数据库迁移或第二套权限逻辑。

相关规则：[INV-01/02/09/14/15/20、MEMBER-INV-01/03](../domain-design/invariants.md)，[权限规范](../domain-design/permissions.md)，[成员邀请交付](member-backend-completion.md)，[部署手册中的成员邀请 SMTP 要求](../../deploy/README.md)。

## 2. Plane 对照与后续适配方向

本机 Plane 的 SMTP 为实例级出站配置；其 Inbox/Intake 是事项分诊而非收件箱。集成目录、工作区连接、项目资源绑定的分层可借鉴，但本地 GitHub/Slack 仅找到模型和前端接线，不能视为完整后端。通用出站 Webhook 有实际实现；没有发现动态插件安装器或邮箱收信链路。运行观察：公开实例接口 200 且 SMTP 未配置，集成目录接口 404；不将其他版本能力当成本地事实。

后续接入方向（**不属于本轮实现验收**）：

| 层次 | 适配要求 | 实际开放前的门槛 |
| --- | --- | --- |
| 内置适配器定义 | 按 SMTP、IMAP、Gmail API、Microsoft Graph 或具体服务 API 划分；声明收信、发信、订阅事件等能力 | 有真实实现和准确合同，不以目录项代替能力 |
| 连接实例 | 区分系统发信、个人私有账号、工作区共享连接；同一供应商支持多个邮箱 | 凭据加密、权限裁剪、撤销和授权失效可核对；API 不回显秘密 |
| 项目绑定 | 关联邮箱文件夹、仓库、频道等远端资源，引用连接而不复制凭据 | 服务端验证资源和项目作用域 |
| 收信与同步 | 持久游标、远端 ID 去重、断线恢复、正文/附件安全处理；任务调度不能假定现有 Worker 已通用化 | 真实协议/服务验收，重复与中断不丢失或重复消息 |
| 业务转换 | 邮件先保存为消息，关联项目或转任务为显式动作 | 通过已有应用服务写入 Markdown 核心，不直接决定任务完成 |
| 动态插件 | 仅在明确需要第三方独立安装发布时另行设计 | 版本兼容、权限/执行隔离、签名与升级卸载方案完整 |

## 3. 工作包与文件所有权

所有子代理跳过中途 build/lint/tests/format，主执行者在合并后统一执行。不得读凭据文件，不改 Plane 或既有业务数据，不重启用户服务。

| 工作包 | 所有权 | 合同与验收 |
| --- | --- | --- |
| PluginCatalog | 新 `apps/web/src/features/pm/service/settings/settings-plugins.tsx`，必要的新 `plugin-catalog.ts` | 导出 `SettingsPlugins({mode})`，复用 SettingsSection/Notice 与现有 Dialog/Button；分类/搜索/空态/详情，中英和窄屏；保留原 15 个应用的信息并增加四项；无模拟连接状态或网络写入 |
| PluginSmtp | 新 `apps/web/src/features/pm/service/settings/plugin-smtp-status.tsx` | 导出 `PluginSmtpStatus({mode}: SettingsPageProps)`，插入 SMTP 卡片；service 内调用既有成员邀请 hook，区分 loading/error/forbidden/configured/unconfigured；Lab 不查询业务；管理员进入 `/members?view=member3`，配置要求只显示变量名与安全说明 |
| 主执行者 | settings-catalog/layout、命令菜单、旧页面移除、文档、临时验收环境 | 新旧入口干净切换；真实服务授权/错误/恢复验证，桌面及 390px 视觉检查；保留不相关修改 |

共享契约：`SettingsPlugins` 只在 SMTP 目录卡片插入 `PluginSmtpStatus`；目录详情中的 SMTP 技术说明是静态产品说明，不独立推断部署状态。所有外部服务条目说明预期能力与缺口，不渲染可执行的安装/连接按钮。搜索匹配中英文名称及说明，分类与搜索取交集；详情只允许读取说明。实验页面亦不发送真实请求。

## 4. 验收清单

- [x] 设置分组、移动选择器、命令菜单与 Lab 目录均指向 plugins；旧组件及模拟连接流程移除。
- [x] 分类、搜索、清除筛选、无结果与详情关闭/键盘焦点可用，条目状态不误导。
- [x] 正式管理员 SMTP 状态来自真实接口，未配置与失败不同；失败后可以显式重试；成员邀请管理入口正确。
- [x] 非管理员不请求邀请数据，不泄露配置/邀请记录；Lab 不查询业务或写入外部账号。
- [x] 桌面、390px、中英/深色检查，无横向溢出；未实现连接无外部授权或写请求。
- [x] 前端 lint、类型、构建通过；没有数据库/事务变更，不将未运行的全量后端测试算作通过。

## 5. 实际交付与验证

### 实现

- `settings-plugins.tsx` 与 `plugin-catalog.ts`：七类、19 项目录；搜索匹配中英文名称/说明及别名，分类与搜索取交集；详情为只读信息，关闭后恢复触发焦点。
- `plugin-smtp-status.tsx`：复用现有邀请查询，不新建配置或邀请逻辑；权限检查在挂载查询前完成，错误和刷新期间不以旧快照判断可用。沿用已有 hook 的待处理邀请轮询，不增加另一套轮询。
- `settings-catalog.ts`、`settings-layout.tsx`、`pm-command-palette.tsx` 统一使用 `/settings/plugins`；Lab 目录消费同一注册表。原 `settings-connected-apps.tsx` 及模拟连接确认流程已删除，不保留第二套页面。
- 首次前端检查暴露分类标签联合元组的 spread 类型错误，已改为明确的中英两个参数；修正后的 `pnpm check:web`（ESLint、全量 TypeScript、Vite 构建）通过。构建仍有既有大 chunk 和 workflow-canvas 静态/动态导入混用提示。

### 浏览器与真实服务证据

复用既有 fixture 创建两套随机 PostgreSQL schema、测试账号、临时存储和随机 API 端口。Web 使用临时 3365/3366；其中一套未配置 SMTP，另一套采用真实 loopback SMTP 接收端配置，但本轮不发送邮件。不操作既有用户工作区，不重启常驻 API/Worker/Web。

| 场景 | 实际观察 |
| --- | --- |
| 管理员状态 | 两套邀请查询分别真实返回 `enabled=false` / `true`，页面分别显示未配置与已配置；不宣称连通或送达 |
| 非管理员 | API 直接查询邀请返回 403；浏览器登录普通成员后显示无权查看，页面发起的邀请查询为 0，无邀请管理链接 |
| 分类/搜索 | 邮箱收信分类显示 IMAP、Gmail、Microsoft 365；搜索 Outlook 仅剩 Microsoft 365；切到开发分类得到无结果；清除恢复目录并聚焦搜索 |
| 详情 | Gmail 与 Microsoft 365 说明、不可用边界可读；Escape 关闭后恢复触发按钮焦点；Skype 保留退役标记 |
| 错误与恢复 | 对已有真实快照的邀请读取注入 HTTP 503，显示“配置状态未知”，不再显示原未配置或已配置结论；撤销故障后显式重试恢复真实状态 |
| 入口 | 设置导航、移动选择器与命令菜单可进入插件页；“管理邀请记录”进入当前工作区 `/members?view=member3`，未配置时原发送控件仍禁用 |
| 视觉 | 1440×1000 桌面和 390×844 窄屏实际查看；移动文档宽度 390，详情宽度 358；英文深色 SMTP 部署说明换行正常，无密码输入框 |
| Lab | 同一只读目录、详情及 Skype 退役说明；观察到业务 API 请求为 0，不模拟已连接 |

未观察到运行时 pageerror；记录中包含页面跳转取消请求及主动注入失败，不能称为零网络错误。证据保存于 `.local/evidence/plugin-settings/`：`browser-results.json`、`desktop.png`、`mobile-intake.png`、`mobile-dark-smtp.png`、`reader.png`、`configured.png`。

文档检查：修正部署手册的非显式锚点链接后，`pnpm check:docs` 通过（69 份 Markdown、27 个计划步骤与领域引用；14 个可选仓库外链接排除于可移植检查）。浏览器标签、两套临时 Web 和 API 均已关闭；验收进程 exit 0 并输出 `PLUGIN_SMOKE_CLEANED`，隔离 schema、账号和临时存储已清理。一次性验收脚本已移除，仅保留上述证据。未提交或推送 Git。

### 交付边界

本轮没有新增后端接口、数据库迁移、任务调度或业务命令；未运行全量后端集成测试，也不把原有邮件发送验收算成本轮结果。邮箱收信、外部 OAuth、任务邮件通知及动态插件运行时不在用户选定的本轮交付内。配置已启用仅是服务器合同事实，不是公网邮件送达证明。

## 6. 安全出站 Webhook 增量边界

- `plugin-catalog.ts` 仅将通用 Webhook 新增为 builtin；SMTP 既有邀请卡片不变，其他供应商连接器仍未实现，Skype 仍退役。builtin 不等于已配置、网络可达或接收器接受。
- `plugin-webhook-status.tsx` 与 `use-webhooks.ts` 仅在当前全工作区 `access.manage`、`domain.read`、`audit.read` 时挂载真实管理查询。正式 UI 从批准 targetKey/项目/事件集合创建 paused 端点，提供版本确认的启用/暂停/退役/接管/换钥、投递分页和认证收据详情，没有 URL、secret、headers 或测试发送输入。
- 管理命令继续使用共享持久 command journal、原 commandId 收据恢复与 expectedVersions。unknown 没有盲重发/强制 delivered；只有接收器认证的否定屏障才显示按原投递恢复。暂停明确不撤销已经 sending 的外部请求，“接收器已持久接受”不写成任务处理成功。
- Lab 不调用会话/管理 hooks，不模拟 accepted。未配置、非法配置、循环失联、刷新中、离线和读取错误分开；旧快照不能批准新操作。
- 实际运行 PG/HTTPS/DNS/Worker 回归；浏览器创建 paused 端点并配置专属测试键后启用，接收账本 accepted、effect_count=1，页面显示持久接受。错配 keyId 的401/unknown零效果负向证据也保留。检查和边界见[本轮记录](service-completion-and-acceptance.zh.md#five-package-delivery)，生产目标/密钥/接收账本仍须批准及验收。

