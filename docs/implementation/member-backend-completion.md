# Member 1–3 后端补齐计划

状态：实现、真实浏览器验收、最终回归与本机后端激活完成；公网 SMTP 配置和 MFA 身份源仍明确未提供。由用户指定的三个 `gpt-6.1-sol:xhigh` 子代理分工执行。入口为正式 `/pm/<workspace>/members?view=member1..3`，Lab 不作为业务完成证据。

## 1. 基线与决策

- 复用 `access.ts` 的成员授权/撤销、最后管理员保护、事务收据与 CAS；复用 `dashboard-personal` 的本人资料版本、`project-directory` 的真实团队及 `dashboard-time` 的心跳 TTL。不再造第二套成员、团队或在线状态。
- 业务权限仍为 capability + projectIds。角色只是显式模板，不授予隐含审核/完成权。Admin 为工作区 `domain.read`、`directory.read`、`access.manage`；Member 为 `domain.read`、`directory.read`、`intent.propose`、`planning.edit`、`delivery.write`、`delivery.submit`；Guest 为 `domain.read`、`directory.read`。其他能力组合显示 Custom，不强行改写已有授权。Admin 必须整个工作区；既有授权不自动迁移。
- 普通目录新增显式 `directory.read`，按实际共享项目范围裁剪；只有工作区 `access.manage` 可读全部管理数据。普通目录不泄露其他人的邮箱、电话、完整能力/项目范围或已撤销记录；本人资料允许本人读取。团队组织关系不产生任何权限。
- 邮件邀请与直接给已有 UUID 授权是不同动作。邀请接受支持已有账号密码确认或受邀邮箱创建账号，不开放无邀请的公开注册。邀请令牌放在链接 fragment，不放日志、事件、命令收据或一般查询响应。
- 邮件通过配置的 SMTP 适配器和独立 Worker 持久队列投递。SMTP 接收不等于收件箱送达；发送结果不明进入 unknown，不能自动重发。显式重发旋转令牌，旧链接失效；撤销/过期不再允许接受。
- 2FA 目前没有身份系统权威来源；本轮不另建 MFA 登录系统。返回明确的不可用能力及 null 状态，不把未知显示成未启用，不开放虚假的安全筛选。若部署接入 MFA 身份源，须另行实现可信读取适配。
- 外部 SMTP 未配置时邀请写入明确拒绝，不生成永远 pending 的假投递。本轮使用临时 SMTP 接收端验证真实网络协议、真实数据库与 Worker；外部邮箱投递依赖运营配置，不将本机接收端等同公网邮件送达。

## 2. 工作包与退出条件

| 工作包 | 内容 | 退出条件 | 状态 |
| --- | --- | --- | --- |
| M01 邀请闭环 | 创建、查询、接受、撤销、重发、过期；新/已有账号；唯一活动邀请、token digest、版本、幂等与权限重验 | 真实 PG/HTTP 并发接受只有一份授权；旧/过期/撤销 token 拒绝；已有账号不得凭邀请改密 | 已实现并验证 |
| M02 邮件投递 | SMTP 配置、持久队列、独立 Worker、发送状态与 unknown 恢复；敏感值不进日志/事件 | 本机 SMTP 实际收到链接；崩溃/未知不自动重复外部效果；未配置明确禁用 | 本机闭环已验证；外部 SMTP 待配置 |
| M03 目录与资料 | 新脱敏目录、真实加入时间、岗位/电话/安全头像本人编辑、团队与 TTL 在线状态 | 资料刷新保留、跨工作区本人资料 CAS；受限成员看不到无共同范围者及敏感字段 | 已实现并验证 |
| M04 角色与授权 | 服务端模板映射、保留自定义能力、最后管理员保护、当前权限/范围再校验 | 不能通过角色或邀请越权；旧版本失败；原有自定义授权不被隐式替换 | 已实现并验证 |
| M05 正式前端 | 三个变体接权威目录、邀请表单/状态/重发/撤销、链接接受页、资料编辑、排序筛选 | 浏览器真实创建→邮件链接→接受→成员刷新；普通目录、移动端与错误态可用 | 已实现并验证 |
| M06 验证与交付 | 生成合同、受影响 lint/types/build、真实后端测试、浏览器冒烟、部署配置说明 | 检查结果逐项记录；缺少的外部配置明确列出，不以 mock 数据代替 | 已完成；外部依赖边界见 5.3 |

## 3. 文件所有权与接口

- InvitationBackend：`packages/domain/src/invitations.ts`、`packages/application/src/invitations.ts`、邀请接受应用服务、`packages/infrastructure/src/invitation-mail.ts`、`packages/application/src/invitation-delivery.ts`、`0017_member_invitations.sql`、`apps/worker/src/main.ts`、邀请 HTTP route module、对应测试。可增加 SMTP 依赖但先通知主代理；不修改共享 app/registry/client/OpenAPI。
- MemberDirectoryBackend：`packages/domain/src/members.ts`、`packages/application/src/member-directory.ts`、`0016_member_directory.sql`、`access.ts`、`dashboard-personal.ts`/资料类型、`core.ts` 能力枚举与对应测试；不修改共享 app/registry/client/OpenAPI。
- MemberFrontend：`pm-members.tsx`、成员受控视图/契约、成员专用 hooks、邀请接受页与路由注册、必要的本人资料编辑；保持现有复刻布局，保留并行项目/团队/设置页面修改。
- 主代理：共享 API 注册、registry、kernel 收据权限分类、contracts/client/OpenAPI、计划与领域文档、跨切片集成、最终检查及隔离服务/浏览器验收。
- 邀请命令：`CreateMemberInvitation`、`RevokeMemberInvitation`、`ResendMemberInvitation`。创建 payload `{email, role: 'admin'|'member'|'guest', projectIds: string[]|null}`；修改使用 targetId + expectedVersions。
- 角色命令：`SetMemberRole` payload `{userId,role,projectIds}`，继承 `SetWorkspaceMember` 的保护及 CAS。
- 查询：`GET /api/v1/workspaces/:workspaceId/members/directory` 返回脱敏具名 DTO；管理邀请 `GET .../members/invitations`。公开入口 `POST /api/v1/invitations/inspect`、`/accept`、`/receipt`，令牌只在请求体；与普通成员命令隔离，接受应用服务仍持有事务和规则。
- 后端导出的 DTO 是前端类型权威；子代理在类型落盘后互通符号名称。共享文件仅主代理集成，生成器在实现收敛后运行。

## 4. 必须保持的规则与验收

关联 INV-01/08/09/13/14/15/20、SC-12/13/14/20，以及 DASH-INV-02/03、PROJ-INV-03。

1. 跨工作区、项目范围越界、非管理员邀请/修改授权全部服务端拒绝；接受时重新检查邀请人当前授权，不凭旧页面批准。
2. 账号邮箱与邀请邮箱绑定。已有账号必须验证原密码或可信会话；不能借邀请设置已有账号密码。邀请接受、账号创建（若需要）、成员授权和审计事件原子提交。
3. 相同命令不会再次创建邀请/邮件；同键改参数报冲突。CAS 冲突不自动重试。发送结果未知时先展示查询状态并要求显式处理。
4. 普通目录不返回敏感字段；邀请列表仅管理能力可读。邮箱/原 token/密码/SMTP 凭据不进入公开事件与普通错误日志。
5. 未配置邮件和未提供 2FA 来源明确不可用；不得靠健康检查或 UI 标签宣称已就绪。
6. 不读取 `.env` 或账号凭据文件内容；可由既有脚本加载环境执行检查。测试与 smoke 使用随机数据库 schema、临时端口和自建账号；不重启其他服务、不写用户业务数据。

## 5. 实际验证记录

### 5.1 真实浏览器闭环

- 隔离 PostgreSQL schema、临时 API `41679`、前端构建预览 `3243`、真实 TCP SMTP 接收端与独立 Worker；自建账号、项目和团队，不写现有用户业务数据。
- 从 Member 3 创建 Guest 邀请，邮件确实由 Worker 发出；链接接受页完成受邀账号创建。浏览器在 HTTP 200 响应阶段中断该接受请求，页面进入未知态，随后以原 commandId 查询原接受收据恢复成功。正常登录后实际目录仅返回可见协作者，其他人的邮箱、电话和完整授权已脱敏，管理操作不可用。
- 同一接受路径先无 token 打开、再添加 fragment 的场景发现并修复未消费新 token 的问题；现在消费后立即从地址栏清除，令牌与密码不持久化。
- 在 Member 1 将受邀者显式改为 Member；真实授权版本递增并匹配服务端模板。Member 2 创建第二份邀请并显式重发、撤销，最终列表显示实际生命周期及 SMTP 接收状态，不声称收件箱送达。
- 本人岗位、电话、真实 PNG 头像通过页面保存，整页刷新后仍存在；真实团队名称与可用电话链接实际展示。2FA 为 null / supported:false，筛选禁用；建议成员无权威来源，不生成假联系人。
- 三个正式变体均实际查看 1440×1000、390×844；移动文档宽度均为 390。Member 2 新增管理操作改为正常文档流，实测原工具栏 bottom=140、新操作 top=148，不再重叠。Member 3 邀请区保留内边距和桌面邮箱/角色双列；另查看英文/深色表面。
- 未观察到运行时 pageerror。请求记录包含主动响应中断和页面导航取消，不将这些声称为零网络错误。截图及结构化证据保留在 `.local/evidence/member-backend/`；临时浏览器、服务与 smoke 脚本已清理。

### 5.2 自动检查

- 成员针对性测试覆盖普通目录边界、全局资料 CAS、安全头像、角色模板/最后管理员、在线 TTL、真实 SMTP、独立 Worker、接受幂等、旧 token、已有账号密码保护、并发跨工作区账号创建和权限重验。
- 首次成员测试暴露 SMTP 在 DATA 已接收后断线仍报告 ECONNECTION/CONN 的情况；直接真实 SMTP 诊断确认邮件已收到。已将这种断线归入 unknown，并通过原失败回归；仅明确证明未连接或明确 SMTP 拒绝的结果才归入 failed。
- 后端 `pnpm lint`、`pnpm typecheck`、`pnpm build` 已通过；前端 lint、TypeScript 和隔离 Vite 生产构建已通过，成员视图另有定向 ESLint。构建仍有既有大 chunk 和 workflow-canvas 静态/动态混用警告。
- `pnpm contracts:check` 通过：89 个命令 payload、30 条路径；文档链接/领域引用检查通过。最终成员定向回归 **19/19 通过**；完整 `pnpm test:backend` **385/385 通过**，两次均为 **0 skipped、0 cancelled**。

### 5.3 本机激活与外部依赖

- 启动前通过管理脚本核对 PID、cwd、进程身份与端口；仅停止本项目登记的 API/Worker。迁移已应用至 `0017_member_invitations.sql`，重启后的 `/health/ready` 返回 ready。
- 未读取或输出凭据文件。仅检查环境是否存在 SMTP_HOST、INVITATION_TOKEN_KEY、INVITATION_WEB_ORIGIN，三者当前均未配置；生产邮件邀请因此保持禁用。所需配置与密钥处理见[部署手册的成员邀请 SMTP 章节](../../deploy/README.md)。
- 公网 SMTP、真实邮箱送达和 MFA 身份来源未验收；本机 SMTP 接收不冒充这些能力。未 commit 或 push，保留并行项目、团队、设置及知识图谱修改。

### 5.4 SMTP 提取与恢复邮箱边界增量

- `system-mail.ts` 现为邀请与身份恢复共用的唯一 Nodemailer/AES-GCM 适配器；邀请模板及 feature 配置仍属于 `invitation-mail.ts`。现有邀请 queued 密文继续使用原 invitationId AAD、nonce/tag/ciphertext 格式，不需要解密重写。重发 generation、workspace 收据、原密码接受与 unknown 不重发语义保持不变。
- 共享 SMTP 不会隐式启用邀请或密码恢复；各 feature 的 origin/key 全未给则 disabled，部分配置报脱敏错误。恢复使用独立 key、purpose/tokenId/deliveryId AAD、短 TTL 与独立 bounded Worker 循环，不复用邀请记录或七天期限。
- 新/旧 accepted 邀请均不产生恢复邮箱验证事实。用户须本人登录后在 `/pm/account/security` 发起独立新挑战；邀请仍不能修改已有账号密码。配置回归已更新，并新增历史邀请不回填/密文兼容断言；本增量没有运行测试或重新验证历史收信证据，统一检查由集成 owner 执行。

