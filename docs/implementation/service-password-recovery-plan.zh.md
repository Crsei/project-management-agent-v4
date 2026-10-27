# 账号可信邮箱与邮件密码找回实施规划

状态：**R01–R09 的协议、持久化、SMTP、正式 UI 与共享接线已完成，并运行隔离真实 PG/HTTP/SMTP/Worker/浏览器及恢复围栏；R10 公网启用仍受外部门禁约束**。实现代理未执行检查的历史说明保留于第11节，当前集成证据见第12节与[统一交付](service-completion-and-acceptance.zh.md#five-package-delivery)，不以旧历史测试数代替本轮结果。

## 1. 目标、权威与范围

交付闭环：本人用现有账号认证登记候选恢复邮箱 → 邮箱持有人完成新的专用验证 → 匿名申请找回统一响应 → 邮件携带短期单用途令牌 → 原子消费令牌、更新密码并撤销**全部**会话 → 丢响应仍能识别原结果，不能盲目重发密码或邮件。

- 账号、会话、验证事实、找回令牌与安全操作属于 PostgreSQL 的 PM 账号上下文，不属于任何 workspace。无工作区成员资格的有效账号也必须能登记邮箱、找回密码。
- 不新增 workspace 命令，不写普通 `command_receipts`、工作区 outbox、活动/通知/Webhook 或 Markdown；不改变九类核心文件权威与成员权限。
- 复用现有 scrypt、真实会话、用户行锁、持久认证限流、安全 action 原结果/取消围栏模式及现有 SMTP/Nodemailer 传输。新增专用身份协议，不引入第二套认证系统、Redis、RabbitMQ 或全能任务框架。
- 明确不做：公开注册、修改登录邮箱、账号合并、MFA/SSO、恢复码、管理员代收链接/代重置、邮箱失联人工恢复、一般安全提醒邮件、任务邮件/Push、供应商收信 API、HA。后述人工失联政策是需要用户决定的范围，不以隐藏接口代替。
- 约束依据：[Markdown ADR](markdown-integration-adr.zh.md)、[领域不变量](../domain-design/invariants.md) INV-09/13/14/20、[一致性与授权场景](../domain-design/scenarios.md) SC-12/13/14/20、[基础设施验收](../domain-design/README.md#implementation-plan) INF-01/02/03/05/06。账号协议不硬套业务聚合，而是保留原请求识别、当前身份、并发与 unknown 的相同原则。

## 2. 已核实基线与必须保留的行为

| 当前事实 | 代码/已交付文档证据 | 对本包的约束 |
| --- | --- | --- |
| `users.email` 唯一，但没有邮箱验证时间、恢复邮箱或验证凭据；有 `credential_version`、`password_changed_at`。`sessions` 仅持有会话摘要及真实时间、随机公开 UUID。 | [schema.ts](../../packages/infrastructure/src/schema.ts)、[0021 账号安全迁移](../../packages/infrastructure/migrations/0021_account_security.sql) | 不能把 email 存在、能登录或 membership 存在当作邮箱已验证。 |
| `createUser` 只规范化邮箱并存 scrypt；账号 CLI 和 bootstrap 都没有邮箱挑战。bootstrap 初始登录名固定为 `admin@project-management.local`，生成密码写私有文件；重复 bootstrap 不轮换。 | [auth.ts](../../packages/infrastructure/src/auth.ts)、[bootstrap.ts](../../scripts/bootstrap.ts)、[create-account.ts](../../scripts/create-account.ts) | 初始管理员没有天然可收信恢复地址。本文只读脚本源码，未读取脚本引用的私有文件。 |
| 本人改密验证当前密码、凭据版本 CAS，保留当前会话、不延长到期时间，撤销其他会话。取得用户锁后重新验证真实 token；取消恢复可围栏迟到请求。 | [account-security.ts](../../packages/application/src/account-security.ts)、[账号 HTTP routes](../../apps/api/src/account-security-routes.ts)、[安全交付第 7 节](settings-completion-plan.zh.md) | 匿名重置不能错误复用“保留当前会话”策略；账号锁及安全恢复模式必须复用。 |
| 登录先做 scrypt，后在 `users FOR UPDATE` 内重查 hash/credential version/disabled；旧密码校验排在改密之后不能创建存活会话。退出也持有同一用户锁。 | [auth.ts](../../packages/infrastructure/src/auth.ts) | 重置也必须使用这一锁，不能只 UPDATE 密码后异步删除会话。 |
| 邀请创建/重发是 workspace 命令；token 摘要定位，未发送 token 以 AES-GCM 加密入专用队列；重发旋转 generation。 | [invitations.ts](../../packages/application/src/invitations.ts)、[0017 邀请迁移](../../packages/infrastructure/migrations/0017_member_invitations.sql) | 复用邮件机制而非邀请命令、TTL、授权或收据身份。 |
| 邀请接受按 workspace → invitation → 规范化登录邮箱 advisory lock → user 排序。已有账号必须验证原密码，新账号可通过有效邀请创建；接受不会登录，也没有写任何“已验证邮箱”事实。 | [invitation-acceptance.ts](../../packages/application/src/invitation-acceptance.ts) | 历史 accepted 邀请不是可信邮箱迁移依据；不能以旧邀请重置已有密码。 |
| SMTP 适配器要求受控 origin，正文链接使用 fragment；非池化、有截止时间、无隐式重试，返回 `smtp_accepted/failed/unknown`。邮件队列发送前移除 ciphertext；sending 租约过期成为 unknown，不重回 queued。 | [invitation-mail.ts](../../packages/infrastructure/src/invitation-mail.ts)、[invitation-delivery.ts](../../packages/application/src/invitation-delivery.ts) | `smtp_accepted` 不是收件箱送达；unknown 不再派发。 |
| Worker 的 SMTP 是独立 bounded 循环，outbox/SSE/心跳是另一循环；`outbox.published_at` 只表明发布进本地事件流。 | [Worker main](../../apps/worker/src/main.ts)、[outbox.ts](../../packages/application/src/outbox.ts) | 找回邮件不能阻塞现有心跳/SSE，也不能用 published_at 当邮件投递收据。 |
| 安全 routes 已设置 no-store/no-referrer、拒绝 query；API 有同源写入检查，错误只记录白名单 code，当前 logger 只显式 redact Authorization/Cookie。邀请公开限流则是进程内 Map。 | [account-security-routes.ts](../../apps/api/src/account-security-routes.ts)、[app.ts](../../apps/api/src/app.ts)、[invitation-routes.ts](../../apps/api/src/invitation-routes.ts) | 不能照搬邀请的内存限流或误称日志已对未来所有敏感字段自动防漏。 |
| 登录页当前说明“无公开注册/自助找回”；安全页和 hook 属于真实服务，marker 只存 actionId/kind，但安全设置 URL 依赖 workspace。邀请页会消费 fragment 并立即清 URL。 | [pm-auth-page.tsx](../../apps/web/src/features/pm/service/pm-auth-page.tsx)、[settings-security.tsx](../../apps/web/src/features/pm/service/settings/settings-security.tsx)、[use-account-security.ts](../../apps/web/src/features/pm/service/settings/use-account-security.ts)、[marker 白名单](../../apps/web/src/features/pm/service/settings/account-security-recovery.ts)、[邀请页](../../apps/web/src/features/pm/service/pm-invitation-accept.tsx)、[routes.tsx](../../apps/web/src/routes.tsx) | 复用视觉、身份清理和 fragment 处理；不复制邀请页保存原密码并显式重放接受请求的方式。新密码提交后即清空，找回写入永不自动重放。 |
| 现有测试覆盖真实 PG/HTTP 的 CAS、用户锁等待、撤销、原 action 恢复；邀请 fixture 提供真实 TCP SMTP、DATA 后断流/挂起和独立 Worker。 | [账号集成测试](../../tests/account-security.integration.test.ts)、[marker 测试](../../tests/account-security-recovery.test.ts)、[邀请集成测试](../../tests/member-invitations.integration.test.ts)、[SMTP fixture](../../tests/member-invitations-fixture.ts)、[Worker 测试](../../tests/member-invitations-worker.integration.test.ts) | 扩展相同隔离资源与故障模式，不能以 mock sendMail 或 fixture API 假数据代替验收。 |

[成员交付](member-backend-completion.md)与[设置交付](settings-completion-plan.zh.md)只证明各自记录的本机范围；其中关于本机 SMTP 未配置的记录是历史证据，不是本轮配置探测。本文没有读取当前 SMTP 凭据，也不判断当前部署已可用。[总计划第七节](service-completion-and-acceptance.zh.md#plane-source-decisions)已将邮件找回从 MFA/SSO 独立，本文不复制 Plane 源码。

## 3. 选定实施默认与仍需用户选择

### 3.1 本规划采用的默认

1. **恢复邮箱独立于登录邮箱**：拟增加一个账号级、唯一的已验证 `recovery_email`；允许与 `users.email` 不同。找回表单明确要求“已登记并验证的恢复邮箱”，不是“任意账号邮箱”。一个已验证地址只能指向一个账号；不合并账号、不修改登录名、不授予工作区权限。候选地址沿用现有 trim/lowercase 与 254 字符规则，不做 Gmail 去点/加号等供应商归一化。
2. **全量从未验证开始**：所有现有用户包括管理员、CLI 账号和邀请账号的恢复邮箱为空、verified 时间为空。历史 email、accepted 邀请、SMTP 接受、旧 session、管理员声明均不回填成验证事实。未来邀请账号也走本包的新挑战；邀请页最多预填候选地址，不能自动信任。
3. **验证需要两种真实证明**：发起登记需要有效本人会话、当前密码、凭据版本和恢复邮箱版本；邮件链接证明候选邮箱控制权。完成验证还要求同一账号的有效会话，锁内重查，并匹配挑战记录的 credential/email version；不要求同一个浏览器，但不能匿名把邮箱绑定给任意 userId。改密或恢复邮箱版本变化后，旧验证挑战失效。
4. **替换先验证、后生效；解绑显式降级**：候选邮箱不改变旧已验证邮箱；新挑战成功时才原子替换，递增 email version，使旧找回/验证令牌失效。取消或过期只清候选，不丢弃旧信任。解绑必须本人有效会话、当前密码及 credential/email version CAS；原子清空已验证地址/时间、递增 email version、撤销该用户全部 reset/verify token、取消 queued 邮件并清密文。已发或 sending 邮件可能仍到达，但旧链接无效。登记/换绑/取消/解绑均不修改密码、不创建会话、不撤销或延长既有会话；用户主动管理会话仍走原接口。只有密码重置执行全会话撤销。解绑须明确确认“此后不能通过邮件找回”，不能把取消候选误作解绑。
5. **令牌参数**：安全随机 32 bytes、base64url 43 字符；密码重置默认 15 分钟、邮箱验证默认 30 分钟，使用 DB `clock_timestamp()`；用途分离，不沿用邀请默认七天 TTL。每账号每用途至多一条 active token，所有消费/失效都受用户锁保护。
6. **匿名发起统一**：格式合法且基础设施可处理时恒定 `202 {requestId,status:"accepted"}`，正文为“若此地址已登记且符合条件，将收到邮件”。不存在、未验证、停用、命中地址限流或已有活动令牌均不透露差异。accepted 仅表示本次匿名请求被处理，不表示存在账号、已排队、SMTP 接受或收件人送达。
7. **已有活动令牌不被匿名请求旋转**：有效期内重复申请只记录同样的公开 accepted 结果，不新增邮件、不延长有效期，避免攻击者持续使用户已收到的链接失效。unknown 邮件保持原身份、原令牌有效期；没有匿名“立即重发”按钮。过期后用户显式申请才可创建新令牌/新 delivery，旧记录仍保留真实 unknown。
8. **找回成功撤销全部会话**：包含发起浏览器可能附带的旧 cookie；不保留“当前会话”，不自动登录、不发替换 cookie。用户必须普通登录。本人已登录改密仍保持原“当前保留、其他撤销”规则，但会使找回令牌失效。
9. **原结果优先**：安全写入使用原 actionId；原键关闭后拒绝携新密码再次提交，必须查询原结果。只读缺失不是重试许可；显式 recover 先在同一锁内写取消 fence，再允许用户重新填写发起新 action。密码不参与请求摘要或持久参数比较。

这些是可执行的安全/工程默认，不代表产品支持任意邮箱多账号、管理员接管或人工破窗。若用户要求改动，应先修改本合同，而不是实现时悄悄改策略。

### 3.2 需要用户/部署负责人提供的精确决定

| 项目 | 必须明确的问题 | 未提供时的真实行为/阻塞范围 |
| --- | --- | --- |
| 对外发信身份与收信门禁 | 目标前端 HTTPS origin、发件域名/邮箱、获准的 SMTP 供应商、受控验收收件箱、负责核对的人；供应商是否能按 Message-ID 查询只能按真实能力登记。 | 不启用发起验证/找回，不声称外网送达。凭据由部署端注入，不交给规划代理。 |
| 已失联且没有可信邮箱的账号 | 谁具有实例级人工恢复权、如何核验本人、是否双人审批、如何记录事故、如何处理初始管理员失联。workspace `access.manage` 不是答案。 | 本包不提供绕过接口；保持无法自助找回，明确联系实例运维。若管理员已丢失密码且从未验证恢复邮箱，本包不能凭 .local 登录名或邀请救回。 |
| 安全记录的法务/运营保留 | 是否接受令牌的 receipt-only 核对窗口默认 30 天，以及安全 action 历史按现有不可变策略保留；若要不同保留/擦除，确认法务与备份政策。 | 不物理删除安全 action、不提前删除 token tombstone；30 天后可停止匿名凭证查询，但不能因此重放旧 action 或删除防重身份。 |
| 整库恢复后的凭据安全 | 恢复旧备份可能恢复旧密码与旧邮箱绑定，哪些账号必须重新核验/轮换、由谁决定可重新开放。 | 隔离恢复、先围栏会话/令牌；不能把存储恢复通过当作凭据回滚安全。缺少可执行安全重新开放策略，不通过公开上线门禁。 |

MFA/IdP、公共注册及多账号共享恢复邮箱不是本次上线的隐含前提。对合法账号保留普通密码登录；不强迫未验证用户立刻退出以“完成迁移”。

## 4. 拟数据合同与状态机

以下数据合同由 `0027_account_recovery.sql` 实现；用户/安全 action 的 Drizzle 映射由集成 owner 统一同步。迁移不回填任何历史验证事实。

| 存储 | 拟字段及约束 | 隐私/并发边界 |
| --- | --- | --- |
| `users` 扩展 | `recovery_email text NULL UNIQUE`、`recovery_email_verified_at timestamptz NULL`、`recovery_email_version int NOT NULL DEFAULT 1 CHECK >0`；email 与 verified_at 必须同时为空/非空，地址存规范形式。 | 非空 verified 事实只有本包成功消费新挑战可以写，清空仅由显式解绑执行；profile 更新、邀请、bootstrap 不可写。初始版本 1 只是 CAS 基线，不是验证证明。 |
| `account_recovery_tokens` 新表 | `id UUID PK,user_id FK,purpose('verify_recovery_email','reset_password'),token_hash UNIQUE,candidate_email NULL,credential_version,recovery_email_version,status('active','consumed','revoked','expired'),created_at,expires_at,consumed_at`；验证用途必须有 candidate，重置用途必须无 candidate；部分唯一索引 `(user_id,purpose) WHERE status='active'`；token 摘要格式、时间/终态 CHECK。 | 原文只短暂存在 API/Worker 内存和 encrypted queued payload；摘要只在此私有凭证表，不进入 action/事件/日志/DTO。先按用户锁把过期 active 转 expired，再签发下一条。终态保留用于一次性与原结果核对。 |
| `account_recovery_mail_queue` 新表 | `id UUID PK,token_id FK UNIQUE,purpose,status,token_ciphertext,lease_id,lease_expires_at,failure_code,created_at,updated_at`。状态沿用 `queued/sending/smtp_accepted/failed/unknown/cancelled`；ciphertext 仅 queued 非空，sending 才有租约；失败码为固定白名单。 | 身份邮件专用队列，不借邀请外键、不借 workspace。Message-ID 稳定绑定 queue id。一次 token 对应一次外部发送身份，不重排同一条。 |
| `account_recovery_requests` 新表 | `request_id UUID PK,address_key NULL,token_id NULL,status('accepted','cancelled'),occurred_at`；address_key 是用途隔离的规范化地址摘要，不是密码/令牌摘要；cancel fence 可先无地址插入。 | 私有请求关联和幂等身份，不输出 eligibility、token_id 或发送状态。accepted 对不合格/限流/重复申请同样持久化。相同 requestId 不允许换地址；同键查询不发信。 |
| `account_security_actions` 扩展 | 保留原不可变规则；新增 `recovery_email_begin/recovery_email_confirm/recovery_email_cancel/recovery_email_unbind` kinds，新增白名单 `recovery_email_version`、可空 `challenge_id`，对应固定错误码与 httpStatus；既有 action 的 challenge 为 null，历史 email version 为 1。 | 复用本人安全 action 查询/取消 fence；返回原 credential version、email version、challenge ID 等非凭据元数据，不记录候选邮箱、密码、token 或请求参数摘要。所有旧 DTO/client/marker 消费者一起迁移，不能留兼容别名。 |
| `account_password_reset_actions` 新表 | `(token_id,action_id) PK` 且 `action_id UUID UNIQUE`，加 `status('committed','rejected','cancelled'),credential_version_after NULL,revoked_count,error_code,http_status,occurred_at`；提交终态不可变，字段/错误码为白名单。 | actionId 全局不可改绑到另一个 token；token_id 为内部普通关联 ID，不是 bearer。不存 token/hash、密码/hash、任意 JSON 请求体。匿名公开结果只含 actionId/status/occurredAt/errorCode，committed 表示全部会话已在同一事务撤销。 |
| `account_auth_limits` 复用 | 增加 purpose 隔离的来源、地址、token 计数作用域；仍只持久化 hashed key/attempts/expires_at。 | 与失败写事务分开提交，跨进程与重启持续有效；不把原 IP/邮箱/凭据写入限流行或日志。 |

状态转换：

- **邮箱信任**：`unregistered` 或 `verified(old)` → `pending(candidate)` → 成功消费后 `verified(candidate,emailVersion+1)`；pending 的 cancelled/expired 不改变旧绑定。已有候选时只读显示原挑战；换候选须先显式取消，CAS 后新建，不因 UI 双击重发。`verified → unregistered(emailVersion+1)` 仅由本人带当前密码的显式解绑执行，并同时撤销所有旧 token/challenge；无已验证绑定时不把取消候选伪装成解绑。
- **令牌**：`active → consumed` 仅成功完成对应用途；`active → revoked` 由取消、密码版本变化、邮箱替换/解绑、账号停用触发；到期变 expired。终态不能复活。邮件是否 smtp_accepted 不决定 token 是否有效；unknown 邮件中的 token 在尚未失效时仍可使用。
- **邮件**：queued 在锁内领取后变 sending 并擦除持久 ciphertext；SMTP 在事务外执行；最终按 lease id CAS 写 smtp_accepted/failed/unknown。领取后崩溃、SMTP DATA 后断流、成功后落库失败、租约过期均不能退回 queued。Token 消费/撤销可取消 queued；不能声称已发出的邮件被撤回。
- **密码重置**：新 action 在用户锁内确认可用 token/版本/期限/账号，成功时原子更新 scrypt hash、凭据版本与时间，消费当前 token，失效该用户所有其他恢复/验证 token，取消其 queued 邮件，删除该用户所有 sessions，写 committed action。任何一步失败整笔回滚。
- **安全 action**：关闭后只能查询，不再携密码重放。recover 若读到原 action 返回原结果；否则先插 cancelled 再提交，迟到原请求看到 fence 必须拒绝。取消某个 action 不消费尚有效 token；只有取消结果已确认，用户才可显式填新密码、创建新 action。

## 5. 拟 HTTP/客户端合同

所有新增 HTTP 路径均为账号级。严格对象 schema 拒绝额外 `userId/actorId/workspaceId`，无 query 参数；邮箱/token/password 只在 POST JSON body。所有成功、验证失败、认证失败、限流与异常响应设置 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`。保留现有 Origin/Sec-Fetch-Site 校验、同源 cookie 和 body 大小约束。

| 拟新增/扩展入口 | 认证与输入 | 输出/错误与恢复 |
| --- | --- | --- |
| 扩展 `GET /api/v1/capabilities` | 公开，仅实例能力。 | 新增 `accountRecovery` 的 request/verification 配置开关；不含地址/密钥。配置可用不代表 SMTP 连通、Worker 正常或实际收信。读取失败显示 unknown，不把失败当 disabled。 |
| 扩展 `GET /api/v1/auth/security` | 本人有效 session。 | 加 `recoveryEmail:{email:null或本人已验证地址,verifiedAt,emailVersion,pending:null或{challengeId,candidateEmail,expiresAt,delivery:{id,status,failureCode}}}`。候选地址只在本人专用状态 DTO 内返回；不进入 action 收据或普通目录。保留原会话/密码 policy。 |
| `POST /api/v1/auth/security/recovery-email` | session + `{actionId,expectedCredentialVersion,expectedRecoveryEmailVersion,email,currentPassword}`；bodyLimit 4096。 | 本人 action；不匹配版本 409、密码不符 403、候选冲突/已有 pending 409、未配置 503。成功是挑战已持久排队，不是邮箱 verified/送达。 |
| `POST /api/v1/auth/security/recovery-email/confirm` | 同一账号 session + `{actionId,token,expectedRecoveryEmailVersion}`。 | 锁内再次验证 session、用途、版本、期限；原子绑定后返回 action。无效/过期/被替换统一 `recovery_link_unavailable`，不泄露其他账号。收不到邮件不能点“已验证”。 |
| `POST /api/v1/auth/security/recovery-email/cancel` | session + `{actionId,currentPassword,challengeId,expectedCredentialVersion,expectedRecoveryEmailVersion}`。 | 只取消本人当前候选，不清旧绑定。返回 action；CAS/身份重验。sending 邮件可能继续到达，但其链接必须已失效；发送尚有未过期租约时禁止立即另签同用途邮件。 |
| `POST /api/v1/auth/security/recovery-email/unbind` | session + `{actionId,currentPassword,expectedCredentialVersion,expectedRecoveryEmailVersion}`，UI 必须明确二次确认。 | 原子清空可信邮箱、version+1、撤销全部 reset/verify token/challenge、取消 queued 并清密文；既有会话保持不变、不延长。无已验证绑定记 `recovery_email_not_registered` 拒绝；原 action 可按现有安全恢复路径核对。 |
| 扩展现有 `GET .../security/actions/:actionId` 与 `POST .../:actionId/recover` | session；recover body kind 白名单扩展。 | 本人邮箱 action 与原改密/会话 action 使用相同原结果/围栏，不带 token/password。kind 不匹配 409。 |
| `POST /api/v1/auth/password-recovery/requests` | 匿名 `{requestId,email}`，无 cookie 依赖；bodyLimit 1024。 | 可处理时固定 202 accepted；全局缺配置、DB/schema 不可用统一 503，来源 IP 超限统一 429；不因账号资格改变状态/body/可见字段。请求 ID 重用不能再次入队。 |
| `POST /api/v1/auth/password-recovery/requests/lookup` | 匿名 `{requestId}`。 | 仅公开原请求的 accepted/cancelled/null，不返回账号资格、SMTP、token 或地址。UUID 不是身份凭证；该结果本身没有敏感账号事实。 |
| `POST /api/v1/auth/password-recovery/requests/recover` | 匿名 `{requestId}`。 | 同一 request lock 内返回原结果或插入 cancelled fence；不签发 token、不发送邮件。null 不能自动换 requestId。 |
| `POST /api/v1/auth/password-recovery/inspect` | 匿名 `{token}`；是 bearer，用途限定为 reset_password。 | 有效时只返回 passwordPolicy/到期时间/可用状态，不返回 userId、邮箱、姓名、workspace。无效、过期、被消费/替换或停用统一 `recovery_link_unavailable`。此读取不消费令牌。 |
| `POST /api/v1/auth/password-recovery/complete` | 匿名 `{actionId,token,newPassword}`；新密码 12–256 字符且不能等于旧密码；bodyLimit 4096。 | committed/rejected 原结果 DTO；同键关闭返回 409 `security_action_already_recorded` 并要求查原结果，不重算/重写密码；不设置 session cookie。未提交时的密码策略/链接拒绝不得伪装 committed。 |
| `POST /api/v1/auth/password-recovery/actions/lookup` | 匿名 `{actionId,token}`。 | 原 token 的摘要仍可用于**receipt-only**认证；优先返回其同键原 action，即使 token 后来已消费/过期。不允许藉此再次改密。无原 action 可返回 null；若 action 已绑定另一 token，固定冲突且不泄露结果，不能误报 null。null 不代表原写失败。 |
| `POST /api/v1/auth/password-recovery/actions/recover` | 匿名 `{actionId,token}`，不收密码。 | user → token 锁内读原 action 或持久 cancelled fence，防止迟到写；actionId 已属于另一 token 时拒绝，不能为新邮件 token 创建假的取消结果来清掉旧 unknown。已过期/停用 token 仅可核对/围栏本身的原 action，不能重新取得写资格；不返回账号资料。 |

安全收据仅对有权限的本人 session 或该 token 的持有人可读；token A + action B 不能读 B 的结果。receipt-only 查询默认开放至 token 创建后 30 天；超过窗口统一不可用，UI 不声称“原操作失败”。已消费/过期 token 及 committed 收据只能证明原 action 结果，**不能获得 session、登录资格、账号资料或新的改密权**，即使核对发生在密码/邮箱版本再次变化以后也不例外。认证普通登录可验证用户当前密码，但它不是原 action 的替代收据。

限流默认（实施时纳入合同与验收）：

- 匿名发起按可信 `request.ip` 20 次/分钟；不信任用户自填 X-Forwarded-For。每规范化地址 3 次/15 分钟，存在与不存在地址都计数，超过地址额度仍固定 202，但不新签发/发信，避免形成账号探测。活动 token 存在时也不新增邮件。
- 邮箱登记/取消/解绑需要当前密码，沿用账号安全 5 次/15 分钟的同等级持久限制；confirm、inspect、complete、lookup/recover 分别使用 purpose/source 30 次/分钟与 token 10 次/15 分钟。查询有独立额度，不能由一次 complete 429 永久堵住核对。
- 请求形状/长度校验先行；邮箱存在与不存在的合法匿名申请使用同样持久请求路径和公开响应。不返回资格相关 Retry-After，不为某类资格增加可观察的网络/SMTP 等待。绝不在 API 请求内等待 SMTP；真实 HTTP 验收比较结果结构与分布，不能宣称严格恒定时延。
- 持久限流计数不随业务事务回滚/进程重启清零；只返回固定错误码，不记录 SMTP 错误原文、邮箱、token、密码或整份 request。

## 6. 锁顺序、并发与不明结果

### 6.1 统一锁顺序

1. 匿名申请/recover 先按 `requestId` 取得事务 advisory fence（仅此用途），再找用户；本人安全请求先正常 authenticate。初始 token/email 查询只是定位，不是授权。
2. 取得 `users FOR UPDATE`；受保护请求随后再次查询真实 session 是否存活、用户是否停用、凭据和 email version 是否匹配。不要沿用等待锁前的 Actor 快照。
3. 再锁该用户相关 token 行，再锁/更新关联 queue 行，最后插不可变 action。密码 scrypt 可在速率限制后用快照预计算；进入锁后必须重核 snapshot hash/credential version/token 状态，不因已完成计算跳过重验。原 action 已关闭可先读出并拒绝，不能为了幂等比较保存密码摘要。
4. 邮件领取也按 user → token → queue，短事务只做当前有效性/用途/地址版本复核与租约 CAS；候选读取不抢 queue 锁再等 user。SMTP 始终在提交并释放用户锁之后。finalize 仅以 queue id + lease id CAS，不再反向取得 user/workspace 锁。租约清扫不派发邮件。
5. 不在账号路径取得 workspace 或 invitation 锁，不在 user 锁后取得邀请的规范化登录邮箱 advisory lock。邀请原 workspace→invitation→email→user 路径保持，不由找回反向等待它。恢复邮箱唯一性以唯一索引裁决；冲突事务回滚，不抢另一个用户行做手工迁移。

### 6.2 必须实际验证的排序结果

| 竞争 | 唯一允许的结果 |
| --- | --- |
| 同 token、相同/不同 action 并发 complete | 至多一次凭据版本增加和一次成功；同键关闭后查原结果，不再执行；异键败者明确拒绝，不能覆盖胜者。 |
| 两个不同 token、同一账号重置 | 发行约束只允许一个 active；即使历史/故障夹具制造两个可定位 token，也由用户锁和 credential/email version 使至多一个提交。 |
| 普通改密与匿名重置 | 改密先赢：重置 token 凭据版本过期；重置先赢：所有原 sessions 已删除，排队改密重验返回 401。不能保留改密的“当前”会话绕过全撤销。 |
| 已验证旧密码登录与重置 | 登录先提交的 session 被随后 reset 删除；reset 先提交则旧登录锁内重查失败。新密码登录若排在 reset 后，可正常新建会话；不能把 reset 之后的合法登录一并当作旧会话清掉。 |
| 验证新恢复邮箱与旧地址 reset | 绑定先提交使 email version 变化，旧 token 拒绝；reset 先提交使 credential version 变化且所有 session 撤销，排队绑定拒绝。 |
| 账号停用、退出/会话撤销与验证 | 同一 user 锁排序，取得锁后 session/disabled 再验；被撤销的旧会话不能完成邮箱绑定。账号停用流程也必须在锁内撤销 token，不能只在异步投影显示停用。 |
| 回应丢失与 recover | 原事务先提交则返回同一个 committed/rejected；recover 先提交 cancelled fence，迟到原请求不能修改密码/邮箱或入队。只读 lookup 的 null 不允许重新派发。 |
| 邮件领取与取消/版本变化 | 取消先行则 queued 取消；领取先行可导致邮件到达，但链接锁内已无效。系统只承诺不能兑换，不承诺撤回外部邮件。 |

“认证版本不再匹配”需要在领取及消费时再次判定，不依赖异步 Worker 失效；queued 清理只是减少无效邮件，不是安全正确性的唯一屏障。现有核心/PM SSE 按真实会话重验的已交付行为继续有效，reset 后旧流不能再泄露后续事件。

### 6.3 SMTP unknown 的具体恢复

- 沿用现有 `smtp_accepted/failed/unknown` 固定分类；超时、DATA 后断线、发送成功后记账失败、sending 租约失效都保守进入 unknown。smtp_accepted 只是 MTA 接受；没有回执/供应商接口时不制造 delivered 状态。
- queue id 构成稳定 Message-ID；仅记录 deliveryId、用途、状态、白名单 failureCode、计数/时间，不保留 MIME/链接/收件人/异常原文。经授权的运维可按该 ID 核对供应商的真实投递记录；找不到记录不等于没发送。产品不要求虚构 SMTP 查询 API。
- unknown/smtp_accepted/failed 都不自动再入队。匿名页面只能核对原请求的公开结果，不能泄露某地址的 mail 状态；有效 token 窗口内也不因“没收到”申请重发。用户检查邮箱/垃圾箱、等待窗口后再显式申请；新申请产生新 token/delivery，而不是重放旧发送。
- 本人候选邮箱可以显示自己的真实 delivery 状态。用户核对后若需要换挑战，须显式取消原候选并确认旧链接作废；等待 sending 租约结束后，才可在限流/CAS 下创建新挑战。原 unknown 不改写成 cancelled/delivered，也不复用原 token 或 queue id。
- Worker 未配置时不领取新邮件，仍可将超时 sending 收敛为 unknown；已签发 token 的 inspect/confirm/complete/原结果核对不以 SMTP 配置存在为前提，安全地保留其既定期限与版本条件。

## 7. SMTP 复用、秘密边界与前端行为

### 7.1 一套传输、两个功能配置、独立身份邮件循环

拟从现有 [invitation-mail.ts](../../packages/infrastructure/src/invitation-mail.ts) 提取 `packages/infrastructure/src/system-mail.ts`：唯一的 SMTP 配置解析/发送适配、超时/错误分类、禁用 URL/file access、禁止 debug/logger、非池化无重试，以及带明确用途 AAD 的 AES-GCM 队列加解密。`invitation-mail.ts` 保留邀请模板/feature config；拟新增 `account-recovery-mail.ts` 只处理验证/找回模板与 feature config。全部现有邀请调用、测试 fixture 与类型一起迁移，不另造 SMTP 客户端、不留下旧新两套发送实现或兼容 re-export。

- 继续复用 `SMTP_HOST/PORT/SECURE/REQUIRE_TLS/USER/PASSWORD/FROM/TIMEOUT_MS`；不新增第二组 SMTP 凭据。要求公共网络 TLS；仅隔离 loopback 接收端允许关闭 STARTTLS。
- 拟新增 `ACCOUNT_RECOVERY_WEB_ORIGIN`、`ACCOUNT_RECOVERY_TOKEN_KEY`（32-byte canonical base64，独立用途密钥）、`PASSWORD_RESET_TTL_SECONDS`、`RECOVERY_EMAIL_VERIFY_TTL_SECONDS`。默认 TTL 为 900/1800 秒，限制在 300–3600 秒；不沿用 `INVITATION_TTL_SECONDS`。
- 拆开 feature enable 判定：共享 SMTP 配好不自动启用邀请或找回；某功能自身 origin/key 全未给时该功能 disabled，给了一部分则是 sanitized 部署错误，不当成成功/静默禁用。这必须修正当前“任一 SMTP 变量出现即要求完整邀请配置”的耦合，保证恢复可单独配置，也不让邀请被意外启用。
- API/Worker 对同一功能使用相同 origin/密钥/TTL。key 不提供给浏览器；新恢复邮件 AAD 至少绑定 purpose/tokenId/deliveryId。提取通用加解密 helper 时，邀请调用仍传原 invitationId AAD，既有 queued 邀请密文格式不变、无需解密重写，不用两套兼容发送实现维持旧队列。已领取即清 ciphertext；轮换前处理或取消旧 queued，禁止因解密失败自动重新生成并发信。
- 拟新增 application 身份邮件 batch + Worker 独立 bounded 循环，每轮默认最多 1 条并有截止时间；不阻塞原 outbox/SSE/heartbeat，也不把邀请与找回隐式放进未定义的通用任务框架。共享 Worker 注册由集成 owner 统一处理。

### 7.2 不允许秘密落点

新链接形如 `/pm/account/recovery#token=…` 与 `/pm/account/verify-recovery-email#token=…`，仅用 fragment；从受控 origin 构造，不使用 Host/returnUrl 生成任意目标。不把 token 放 query、路径、Referer、可复制错误或日志。

- 页面消费 fragment 后立即 `history.replaceState` 清除；处理同一路径 hashchange、React StrictMode、慢导航，不依赖重复 render 保留链接。验证页需登录时只在当前页面内存保留 token，不能塞进 login return URL；刷新后从邮件重开。
- token/password 不进 localStorage/sessionStorage/IndexedDB、TanStack query key/cache、通用命令 journal、路由 state、遥测、错误栈/MIME 调试、普通收据/事件。新密码发出时输入框立即清空，请求结束不保留可重放对象；服务端不得记录 body、请求摘要或 SQL 参数。
- 浏览器只持久化白名单 `{kind,actionId}` 或匿名 `{kind,requestId}` 非秘密 marker；不保存邮箱/token/密码或其 hash。token 丢失时重新打开同一邮件才能按 marker 核对原 action；若误开新邮件，服务端 actionId/token 关联冲突必须保持旧 unknown，提示找原邮件而非取消新 token 后清 marker。不能从服务端重新取出原 token，也不能因页面刷新直接发新邮件。marker 损坏/存储拒绝时禁止新的写入，先恢复记录能力，不把 unknown 当不存在。
- API 固定路由拒绝 query 尚不足以阻止框架 access log 记录误入 URL 的秘密。实施需对这些认证路由在最早请求日志/代理边界只记录固定 route label，拒绝/脱敏 query 后也不能回显；扩展 logger/redaction 与代理日志测试。页面不加载第三方分析脚本、图片追踪或预览；CSP/no-referrer/no-store 覆盖静态页面和 API。
- 原结果核对默认 30 天后只停止旧 token 的 receipt-only 权限；持久 action/fence 身份不能重新可用。无经过批准的记录保留策略时不增加物理清理任务。

### 7.3 真实入口与未配置行为

| 用户状态/场景 | 应呈现和执行的行为 |
| --- | --- |
| 已登录、没有 workspace 的 CLI 账号 | 拟新增 `/pm/account/security` 的本人认证入口，可从工作区选择页/账号菜单进入；使用 account guard，不使用必须有 workspace 的 ServiceGuard。嵌套设置密码页复用同一恢复邮箱面板，不另存一套状态。 |
| 初始 `admin@project-management.local` | 用现有登录密码进入账号安全，登记一个真实可收信地址并完成新挑战；登录名保持不变，不发信到 .local 冒充成功，不替用户选择收件邮箱，不重新运行 bootstrap/读取 access.json。 |
| email 存在但从未验证 | 显示“未登记可信恢复邮箱”，匿名申请仍统一响应但不发信。已登录本人可走登记挑战；忘记密码后不能凭旧 email/邀请补验证，不提供注册伪入口。 |
| 已验证旧地址，正在验证新地址 | 旧地址继续有效，候选清晰标为未验证；新地址成功后旧 token 全失效。两个标签页版本冲突保留候选表单并提示重读，不静默覆盖。 |
| SMTP 完全未配置 | capabilities 明确 disabled；登录页找回链接可解释禁用原因，登记/申请控件禁用；直接 HTTP 发起统一 503 `account_recovery_unavailable`，不创建假的 token/queued。普通登录/本人改密/会话管理照常工作。 |
| SMTP 部分配置、Worker 不可达或状态读取失败 | 显示真实配置错误/unknown，不显示“已关闭”或“邮件已发送”。发行能力与 Worker/SMTP 健康、收件人送达分开；已持久化的 queued 可等待至 token 过期，不能无限延长期限。 |
| 匿名申请已确认 202 | 显示条件性提示与窗口规则，不显示“账号存在”“已发送到某地址”，也不轮询透露资格。响应未知时锁住新申请，只查原 requestId/recover。 |
| complete 响应丢失、503、malformed 2xx | 保留非秘密 marker，清空密码、禁止新提交；以原 token/actionId lookup，再由用户显式 recover。查到 committed 才宣告成功并普通登录；cancelled 才允许显式重填。 |
| reset 成功时浏览器原已登录 | 不复用旧会话；刷新会话并清私有 query/cache/流订阅，回普通登录。其他标签页在真实 401/流撤销后同样清理，不删除其他账号尚未核对的普通命令日志。 |
| Lab | 只做清楚标记的禁用说明，不输入真实 token/password，不模拟验证/重置/投递成功。 |

## 8. 稳定实施步骤、文件责任与依赖

R01–R10 是稳定实施任务身份，不重编号。第11节为实现代理首轮交接，第12节记录集成后的实际证据；生产门禁仍按第10节执行。

| 步骤 | 文件责任与具体工作 | 依赖与退出条件 |
| --- | --- | --- |
| **R01 账号协议与共享合同冻结** | 在现有 [account-security 合同](../../packages/contracts/src/account-security.ts)、[schemas](../../packages/contracts/src/account-security-schemas.ts)、[openapi.ts](../../packages/contracts/src/openapi.ts) 及 client 的生成来源增加上述 DTO/路由/capability；按用途区分 authenticated email actions 与 anonymous request/reset actions。确认原结果、统一响应、TTL/限流、独立 recovery_email 与全撤销语义。更新相关权限/恢复说明，不新增 workspace 命令。 | 入口任务；产出字段/错误码/状态与本计划一一对应的合同。导出函数/类型改变时使用可用 LSP references 收齐旧调用方；不可用才以源码搜索逐项列出，不声称已做 references。 |
| **R02 持久化与不可变约束** | [schema.ts](../../packages/infrastructure/src/schema.ts)、`packages/infrastructure/migrations/` 新迁移，新增用户信任字段、token/request/mail/reset-action 表、唯一/状态/时间/immutable CHECK、索引；扩展现有安全 action 白名单和历史默认元数据。 | 依赖 R01；迁移全部用户为未登记，不扫描 email/accepted 邀请回填；空库和已有用户库均有验收。编号集成时统一分配。 |
| **R03 提取既有邮件传输** | [invitation-mail.ts](../../packages/infrastructure/src/invitation-mail.ts)、拟新增 `system-mail.ts` / `account-recovery-mail.ts`；同步 [invitations.ts](../../packages/application/src/invitations.ts)、[invitation-delivery.ts](../../packages/application/src/invitation-delivery.ts)、配置注入及 SMTP fixture。实现单一 SMTP 传输、用途密钥/AAD、分离 feature enable、fragment 模板、稳定 Message-ID、固定失败分类。 | 依赖 R01，可与 R02 并行；现有邀请行为/unknown/fragment/禁用态不回退，不能保留第二套发送实现。共享 app/config/Worker 接口先交接 owner。 |
| **R04 可信邮箱登记与验证闭环** | 拟新增 `packages/application/src/account-recovery.ts` 负责本人 begin/confirm/cancel/unbind；[account-security.ts](../../packages/application/src/account-security.ts) 与 [auth.ts](../../packages/infrastructure/src/auth.ts) 提供同一用户锁/实际 session 重验与 action fence，不另建弱化锁 helper。邀请/CLI/bootstrap 保持不验证；邀请页只提供独立登记引导。 | 依赖 R01/R02/R03；R-A01/02/03/08 的信任、换绑/解绑及会话保持分支可通过真实 HTTP/DB 验证，不只返回 pending scaffold。 |
| **R05 匿名申请、令牌消费与原结果恢复** | `account-recovery.ts` 实现 request fence、所有地址统一响应/持久限流、单活动 token、inspect/complete/lookup/recover；[auth.ts](../../packages/infrastructure/src/auth.ts) 与 [account-security.ts](../../packages/application/src/account-security.ts) 在原改密/停用相关入口同步失效 token，复用登录锁规则，全会话撤销。 | 依赖 R02/R04；R-A04/05/06/07/08/11 全部具备真实路径；不写 workspace 收据、无 secret request hash、无自动密码重放。 |
| **R06 身份邮件领取及 unknown 运维** | 拟新增 `packages/application/src/account-recovery-delivery.ts`；按 user→token→queue 复核、短租约、SMTP 外发、lease CAS 和过期 unknown；[Worker main](../../apps/worker/src/main.ts) 由集成 owner 注册独立 bounded 循环；提供仅展示安全 metadata/Message-ID 的部署运维核对流程，不承诺不存在的供应商 API。 | 依赖 R02/R03/R04；双 Worker、发送后落库失败、DATA 断流、杀进程及心跳继续均可验收。邮件不是 outbox published 标记。 |
| **R07 HTTP 安全边界与合同集成** | 拟新增 `apps/api/src/account-recovery-routes.ts`；扩展 [account-security-routes.ts](../../apps/api/src/account-security-routes.ts)、[app.ts](../../apps/api/src/app.ts)、配置注入、生成 client/OpenAPI。所有错误/no-store/referrer/query/bodyLimit/日志白名单、匿名实例 disabled、Origin 和固定路由日志一起接入。 | 依赖 R01/R04/R05；R06 的最终发送不阻塞匿名 HTTP。共享 app/contracts 的唯一 owner 集成，不在切片内竞改。 |
| **R08 真实认证与账号安全 UI** | [routes.tsx](../../apps/web/src/routes.tsx)、[pm-auth-page.tsx](../../apps/web/src/features/pm/service/pm-auth-page.tsx)、[settings-security.tsx](../../apps/web/src/features/pm/service/settings/settings-security.tsx)、[安全 hook](../../apps/web/src/features/pm/service/settings/use-account-security.ts)/[marker](../../apps/web/src/features/pm/service/settings/account-security-recovery.ts)，拟新增账号恢复页/邮箱验证页与共享 recovery panel/hook。增加无 workspace 的账号入口、条件性响应、fragment 内存处理、unknown 原键核对、成功后真实会话清理。 | 依赖 R01；可先按固定 DTO 编写，但只在 R07 真接口集成后宣称完成。保留现有改密/会话与邀请页真实行为，所有导出改动收齐消费者。 |
| **R09 隔离验收与故障矩阵** | 扩展 [账号测试](../../tests/account-security.integration.test.ts)、[marker 测试](../../tests/account-security-recovery.test.ts)、[邀请集成](../../tests/member-invitations.integration.test.ts)/[Worker 测试](../../tests/member-invitations-worker.integration.test.ts)；拟新增 `tests/account-recovery.integration.test.ts`、`tests/account-recovery-worker.integration.test.ts` 和对应 fixture。复用真实 PG schema/TCP SMTP/临时 API/Web，完成下一节全部场景。 | 依赖 R02–R08 全落地；仅集成 owner 一次统一运行检查，再行真实 changed path/browser/故障演练。跳过 DB、模拟 API 或仅本地 SMTP 不关闭外网门禁。 |
| **R10 上线、恢复与交付文档** | 更新 [部署手册](../../deploy/README.md)、[账号安全交付](settings-completion-plan.zh.md)、[成员交付边界](member-backend-completion.md)、[服务总计划](service-completion-and-acceptance.zh.md)、[后端交付](backend-delivery.md) 与 README 的找回禁用说明；记录真实 SMTP/外部收件人与恢复演练，不保留 throwaway 脚本/秘密夹具。 | 依赖 R09 和第 10 节外部输入；未通过外部门禁时只能记“内部实现/本机闭环已验证，公网功能未启用”，不能把计划状态直接改为服务完成。 |

共享 ownership：本包实现账号/恢复独立模块、既有 account-security/auth 锁复用、SMTP 提取与邀请调用迁移、正式 UI 和真实测试；集成 owner 独占 schema、API/main/config、Worker、capabilities、client/OpenAPI 合并与 routes 注册。既有 auth 登录/退出用户锁保持不变；改密/邮箱版本/停用通过用户行锁内的数据库触发器同步失效恢复令牌，不依赖 Worker。

## 9. 集成后的可运行验收矩阵

这里是必须执行的验收合同，**不是本轮已运行结果**。集成 owner 使用随机 PostgreSQL schema、临时 Markdown/blob 根目录、随机 API 端口、独立 cookie origin 的 Web、真实 TCP SMTP receiver、自建账号；只操作自有服务/进程，不读取当前凭据、不拿默认工作区做夹具。沿用现有 node:test + 真实 HTTP/Worker 模式。故障用真实服务提交后的代理截断、真实 socket 模式及 PG 锁观测，不伪造服务成功。

| 场景 | 真实操作 | 必须观测的断言/证据 |
| --- | --- | --- |
| **R-A01 历史迁移与初始管理员** | 在隔离库建 CLI/旧 email/accepted 邀请账号及 bootstrap 同型 .local 管理员，应用新迁移；管理员登录后绑定受控收件邮箱，再独立登录。 | 所有旧账号最初 recovery_email/verified_at 均为空；accepted 邀请不被回填。管理员验证后仅恢复邮箱有值，登录 email/password、membership、Markdown 未被改写。无工作区账号可访问账号安全入口。 |
| **R-A02 邮箱信任正向、替换与解绑** | 本人 begin，真实 SMTP 收到 fragment 链接；确认前申请找回；完成 confirm 后申请找回；再登记新候选、取消/过期，最后成功替换；准备 pending/reset 链接后显式解绑。 | 未验证不发 reset；验证事务后才发 reset。旧绑定在候选取消/过期时保留，替换成功后 email version +1、旧地址 token 无效；解绑后地址/verified_at 为空、email version 再+1、旧 reset/verify 全拒绝。以上不改变已有 sessions/到期时间。相同恢复邮箱并发绑定至两账号至多一份成功；UI 明确登录邮箱与恢复邮箱可不同，无多账号共用或自动选择账号。 |
| **R-A03 验证身份与用途隔离** | 另一账号 session 提交该验证 token、无 session 提交、改密后用旧 token、reset token 交给 confirm、verify token 交给 complete；撤销 session 后释放排队 confirm。 | 全部不越权、不改绑定、不改密码；锁后 session 重验；无任何 token 可跨用途。原邮箱/邀请记录不能绕过当前挑战。 |
| **R-A04 匿名统一与幂等** | 分别对不存在、未验证、停用、已验证、达到地址额度、已有 active token 的地址发送相同形状 HTTP；同 requestId 重复/换地址；丢弃真实 accepted 响应并 lookup/recover。 | 合法资格差异始终同 202 schema/条件文案、无 accountExists/delivery。合格首次仅一个 token/queue；其余零新邮件。原 requestId 不重复入队，改参数冲突；recover 先写 fence 时迟到请求不能签发。原结果 accepted 不被解释成已发送。 |
| **R-A05 单次消费与全部撤销** | 同一账号用两个浏览器及 API 建多会话、开 PM/核心 SSE，真实邮件 token complete，之后旧 token 重复/新 action 重复，旧/新密码登录。 | 凭据版本恰 +1，password_changed_at 真更新，全部旧 sessions 为零；旧 token 不再写，旧密码 401，新密码普通登录成功；未设置自动登录 cookie；旧两路 SSE 后续真实新事件零泄漏且清理 UI。 |
| **R-A06 并发 reset/login/change** | 按现有 pg_blocking_pids 测试方式持有 user 行锁，安排同/异 action reset、旧密码已验证登录、正常改密、新密码登录的不同排队次序。 | 严格符合 6.2 排序；至多一次 reset 成功，旧已验证登录不创建存活会话；reset 前创建者被删，reset 后新密码登录者可存活；无死锁遗留/孤立 action。 |
| **R-A07 提交后断流与取消 fence** | 在真实 complete 提交后截断响应、替换 malformed 2xx、返回代理 503；刷新/重开邮件后带原 token/actionId lookup。另在原请求未落锁时 recover，再释放迟到原写。 | UI unknown 锁写且密码清空；找到同一 committed action，不二次 hash/update/send；token 消费/到期后仍能 receipt-only 找原结果；recover 先行则 cancelled、原写拒绝且 password/version 不变。换 token/action 不能读另一结果。 |
| **R-A08 期限、邮箱版本及账号变化** | DB 将 token 置边界时间，制造检查后等待锁至到期；并发邮箱替换/解绑/停用/退出/会话撤销/改密；尝试旧链接。 | 按锁内 clock_timestamp/真实版本判定，无检查-使用窗口；旧 reset/verify 失效；未成功事务不部分改密码/绑定。普通登录、已有授权不因“未验证”被擅自禁止；已提交原 action 仍只可核对、不能借旧 token 登录。 |
| **R-A09 双 Worker 与未知发送** | 两个自有 Worker 同取一 queue；SMTP drop_after_data/hang_after_data；分别在领取后、SMTP 接受后落库前杀自有 Worker；等真实租约到期重启。 | 每 delivery 外部 DATA 至多一次；未知均保留原 delivery/Message-ID、ciphertext 已清，不退 queued、不自动重发；API 202 不等待 SMTP，outbox 发布/心跳继续。活动 token 期内再匿名申请零 DATA；过期后显式新申请才有新身份。 |
| **R-A10 配置与外部失败** | 用注入测试配置覆盖完全缺失、半配置、错误 key、拒绝 RCPT、DNS/连接失败、TLS 错误、Worker 未启动；保留现有邀请回归。 | 缺配置发起统一 503、零 token/queue；半配置 sanitized 错误且不打印值；确定失败与 unknown 分类真实；共享 SMTP 不自动启用另一 feature；邀请 fragment/重发/接受原密码/unknown 语义不变。已有有效链接在缺 SMTP 后仍按原期限可消费/核对。 |
| **R-A11 持久限流与泄密** | 多进程并发请求、业务回滚/进程重启后再试；来源/地址/token 分别超限；扫描自有浏览器存储、HTTP/代理日志、DB 收据/outbox/错误输出及 URL/history；故意把秘密放 query。 | 计数持续、来源429一致、地址超限仍202；核对额度独立。无密码/token/secret-derived request digest 进入收据/事件/日志/query/浏览器存储；非法 query 也不在框架/代理日志泄露；邮箱不进入工作区事件。只有 credential/token 私有表保留其必要密码hash/token摘要。 |
| **R-A12 Browser 入口与恢复** | 桌面/390px、中英、键盘完成登录→无workspace账号安全→验证→匿名找回→重置→普通登录；同路由新 fragment、StrictMode、刷新、存储损坏/拒绝、双标签页旧 CAS。 | 非 fixture，状态来源真实；secret fragment 立即清、密码发出清空、marker 仅白名单 ID/kind。缺 token 指导重开同邮件，不能点击盲重发；冲突保留普通候选草稿但不保留密码；未配置/unknown 文案不假成功，Lab 无安全请求。 |
| **R-A13 备份与恢复围栏** | 隔离备份中包含已验证绑定、active/consumed token、unknown mail、committed/cancelled actions，恢复到全新库；开放流量前执行安全围栏。 | 原 action/fence 与密码/邮箱版本历史可查且约束有效；恢复 sessions 清空、token 撤销、queued 取消并擦ciphertext、sending 记unknown，Worker 不重发；旧链接不能重新消费。明确旧密码可随旧备份回滚，未完成用户批准的凭据处置不声称安全重新开放。 |
| **R-A14 外部实际收信** | 部署负责人在获准目标环境注入凭据；自建受控账号绑定真实邮箱，收验证邮件后确认，再收重置邮件并完整完成，核对丢响应/旧链接与普通登录。 | 真实收件人确认收到两种邮件、实际 HTTPS origin/fragment、发件域身份/时间、Message-ID 与对应 DB metadata、旧会话401。证据脱敏，无原链接/token/正文/密码。仅 SMTP250、loopback receiver、readiness 或配置 enabled 均不能替代本场景。 |

最终建议由集成 owner 按实际改动运行合同一致性、受影响后端 lint/typecheck/build、账号/邀请/恢复真实 PG 测试、前端检查、文档链接检查，再执行上述真实 HTTP/browser/SMTP/恢复路径；共享检查只统一运行，不在并行实现阶段运行。本规划阶段未执行任何上述命令，既有历史通过数不移作本功能证据。

## 10. 迁移、前向恢复、停用与上线门禁

### 10.1 迁移顺序

1. 保存一致性 PostgreSQL/Markdown/blob 备份；本包不修改核心文件，但不能把单库备份冒充全系统恢复。新 schema/action 字段先就绪，所有历史恢复邮箱保持空。
2. 发布能读取新字段但发行仍禁用的 API/Worker/Web；保留普通登录、改密、会话与邀请服务原行为。不要将仅设置共享 SMTP 的环境误判为邀请/找回都开启。
3. 通过隔离 R-A01–R-A13、核对 API/Worker 的 feature 配置一致性，再由部署负责人配置真实发信身份及受控收件箱；不打印配置值、不读取当前 .env 或账号文件。
4. 至少一个实例管理员完成真实恢复邮箱验证；新/旧账号通过本人认证逐个登记，不批量信任 email 或历史 invitation。然后完成 R-A14，才开放匿名发行入口并更新“功能可用”的交付状态。

### 10.2 故障/停用

- 关闭发行能力时立即拒绝新 begin/request，不伪造 pending；普通登录/本人安全功能不受影响。已签发 token 的消费/原结果核对在 DB 与协议可用时仍按既定规则服务；若是安全事件，应显式在用户锁内撤销相关 token，而非只隐藏按钮。
- 暂停身份邮件 loop 不阻塞 outbox/SSE；queued 到期只取消/清密文，不无限重试。已发送或 sending 的邮件不可撤回，unknown 保留。恢复服务不会把它们置回 queued。
- 不做破坏性 down migration，不回滚已变更密码/邮箱验证事实。应用回退只选已适配新 schema 和发行禁用的产物；旧版不知道新协议时不得靠回退来恢复“未消费”凭证。迁移/数据库失败用前向修复，保留 action/fence。
- 密钥泄露时禁用发行并撤销受影响 token/取消 queued；队列 key 轮换不能重新发信。密钥丢失的 queued 记 token_unavailable，原申请可核对；密码与 verified 事实不因此自动变更。当前密码遗失又没有可用恢复邮箱时仍属于待定人工恢复，不提供静默后门。

### 10.3 备份恢复与最终门禁

数据库备份包含 verified 绑定、版本、不可变 actions/fences、token tombstone、邮件状态和限流；备份按敏感认证数据控制访问。队列密钥由运维独立秘密备份，不进入证据。恢复到隔离库时先禁止 API 流量及所有外发，撤销恢复出的 sessions/token，取消 queued 并清密文，将未决 sending 收敛 unknown；核对后才能启动新流量。**旧备份可能恢复旧密码和旧恢复邮箱，围栏 token/session 不能消除此事实**；按用户批准的事故/重新核验政策处置，不能凭 backup:verify 通过就恢复公网登录。

已提供 `packages/application/src/account-recovery-restore.ts` 的 `fenceRestoredAccountRecovery(sql)`：由共享恢复 owner 在同一停写目标库事务中调用，按 user 锁顺序撤销 sessions/active token，queued 清密文取消、sending 清租约记 unknown；不删除或改写不可变收据，也不擅自修改备份恢复的密码/可信邮箱。集成测试已增加该真实 PG 路径及幂等/历史保留/不可兑换/不再发信断言，尚未运行。共享 restore-safety、备份恢复和 S3 restore-rebind 激活前接线由集成 owner 组合，禁止对 source DB 调用。

上线逐项门禁：R01–R10 实现责任闭合、R-A01–R-A13 无跳过且证据脱敏；真实 SMTP/HTTPS origin/受控收件箱与 R-A14 通过；管理员已验证可收信恢复邮箱；API/Worker 配置一致、发送循环有截止时间/租约/unknown 核对；日志/代理/CSP/浏览器秘密扫描通过；备份恢复与凭据重新开放政策已确认。未满足外部输入只阻塞对应公开启用，不阻止完成隔离实现，但必须如实标为“外部真实收信未验收”。

## 11. 本轮交接与证据边界

- 实现文件：`packages/application/src/account-recovery.ts`（本人邮箱 begin/confirm/cancel/unbind、匿名统一申请、短令牌 inspect/complete、原 request/action lookup/recover 与取消 fence）、`account-recovery-delivery.ts`（user→token→queue 领取、SMTP 锁外单次发送、lease CAS/unknown），`packages/infrastructure/migrations/0027_account_recovery.sql`（独立邮箱、不可变 actions/requests、单 active token 与终态/queue 约束）。`account-security.ts` 复用原用户锁及锁后真实 session 重验，安全收据增加恢复邮箱版本与非秘密 challenge ID。
- 传输切换：`system-mail.ts` 是唯一 Nodemailer 发送与 AES-GCM 实现；`invitation-mail.ts` 只保留邀请 feature 配置和模板，邀请 callers 直接使用共享加解密并保持原 invitationId AAD/密文格式；`account-recovery-mail.ts` 只拥有恢复 feature 配置、专用 AAD 与模板。SMTP 变量不再隐式启用另一 feature。DATA 后断线、超时与记账失败不重排队；disabled Worker 仍收敛发送租约并取消到期 queued 密文。
- HTTP/合同：`apps/api/src/account-recovery-routes.ts`、`packages/contracts/src/account-recovery-schemas.ts`、`account-recovery-openapi.ts`、`account-recovery-client.ts`；专用客户端注入既有 `#send`，没有第二套 cookie/bearer 认证。客户端核对 HTTP 状态、action/request ID、kind 与 action.httpStatus；malformed 2xx/错误身份/503 携合法旧 DTO 不能清除恢复 marker。既有 account-security DTO/schema 同步扩展。
- 正式入口：`account-recovery-pages.tsx` 提供无 workspace 的账号安全、fragment 验证与找回页；设置密码页共享 `recovery-email-panel.tsx`，登录、选择工作区和账号菜单链接真实入口。邮箱/password/token 不进入 query/cache/journal/storage；匿名及本人 marker 仅白名单 kind+ID。新密码发出即清空，unknown 只核对原身份，换 token 的原 action 冲突不会被当作缺失清除；reset committed 后用真实 session refresh 清理私有状态，不自动登录。Lab 不收真实凭据。
- 已编写、**未运行**：`tests/account-recovery.integration.test.ts`、`account-recovery-worker.integration.test.ts`、`account-recovery-migration.integration.test.ts`、`account-recovery-fixture.ts`、`account-recovery.test.ts`，以及邀请配置回归更新。夹具使用随机 schema/端口、自建无 workspace 账号、真实 TCP SMTP 和独立 Worker；覆盖新挑战/用途与本人隔离、统一请求、单次重置和全部撤销、收据/fence/换 token 冲突、候选取消/解绑、并发 reset/正常改密/旧密码登录排序、期限/持久限流、SMTP unknown/双领取/心跳、旧库不回填、密文兼容与 marker/客户端异常响应。不能将编写的断言或历史测试通过数称为本包证据。
- 统一验证入口由 owner 执行：`node --test tests/account-recovery.test.ts tests/account-security-recovery.test.ts`；真实库 `node --test tests/account-recovery.integration.test.ts tests/account-recovery-worker.integration.test.ts tests/account-recovery-migration.integration.test.ts tests/account-security.integration.test.ts tests/member-invitations.integration.test.ts tests/member-invitations-worker.integration.test.ts`；随后正式 browser/HTTP/SMTP/备份围栏矩阵。没有真实数据库而 skip 不算通过。
- 未读取当前凭据、探测生产 SMTP、操作用户资源或停服务。外部实际阻塞仍是获准 HTTPS origin/发件域与受控收件人（R-A14）、失联人工恢复权/身份核验政策、30 天 receipt-only/不可变历史保留政策及旧备份凭据重新开放政策。以上只阻塞对应公网启用，不以假验证字段、假送达或隐藏人工重置接口替代。

## 12. 集成后的实际证据

- 真实 PG/HTTP/SMTP/独立 Worker 回归已运行，覆盖验证/换绑/解绑、匿名申请、一次性重置/会话撤销、原收据/取消围栏、并发/期限/限流、SMTP unknown、旧库不回填与目标恢复围栏；无数据库 skip 冒充通过。
- 正式浏览器在独立账号路由登记邮箱，从真实 SMTP 验证邮件取 fragment 并确认；再匿名申请找回、消费第二封邮件并重置。旧会话 `/auth/me=401`，新密码普通登录后200；fragment清空，令牌未写 localStorage/sessionStorage。没有读取用户凭据或公网发信。
- 真实页面发现独立账号路由缺少 `PmServiceProvider`，修复为无工作区依赖的父级 provider；未知能力页面不可发信。实际 Caddy 验证 no-store/no-referrer/CSP，并以错误日志查询串探针确认不记录原请求。
- 实际 S3 源备份含已验证邮箱和已消费令牌；新目标绑定激活前执行统一恢复围栏。验证账号另建，报告仍为 `productionCredentialPolicyApproved=false`，不代表旧密码/旧可信邮箱重新开放许可。公网 R-A14、失联恢复权与生产策略仍未关闭。
