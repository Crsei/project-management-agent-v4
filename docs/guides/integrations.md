# 邮件、私有 S3、出站 Webhook 与即时通讯

这些能力默认按配置门禁开放；“源码存在”“配置合法”“依赖就绪”“外部送达”和“生产验收”不是同一结果。不复制历史凭据，不提供假接收器或静默Local回退。角色、存储绑定和完整恢复见[部署手册](../../deploy/README.md)。

## 先核对状态，不自动启用

下表描述源码中的配置门禁，不是当前部署已通过外部验收的声明。没有实际账号、目标及授权时，保留禁用或待核实；不要为获得绿色结果添加配置、启动网关、建立测试接收器或重发积压。

| 能力 | 禁用与配置错误的区别 | 既有状态入口及可核实范围 |
| --- | --- | --- |
| 邮件邀请 | 所有 `INVITATION_*` 功能字段为空时禁用；任一非空便要求合法 origin、独立 key、TTL 和完整 SMTP。仅有 SMTP 不启用邀请，也不会单独校验该传输 | 已授权的 `pnpm pm invitations list` 对应 `GET /api/v1/workspaces/{workspaceId}/members/invitations`，返回 `enabled` 与各邀请的投递状态；不证明 Worker 使用相同配置或收件箱收到邮件 |
| 可信恢复邮箱 | origin/key/两个 TTL 字段均为空时禁用；任一非空而不完整则启动失败；邀请配置不启用恢复 | `GET /api/v1/capabilities` 的 `accountRecovery.request.enabled` / `verification.enabled` 只说明 API 已注入该功能配置且创建了数据库 pool；不说明数据库、可信邮箱或邮件就绪 |
| 私有 S3 | `BLOB_PROVIDER` 默认 `local`，`disabled` 才是关闭存储；非 S3 模式出现任意显式 `S3_*` 字段是错误，`s3` 模式缺必填字段则启动失败 | `capabilities.storage.enabled` 不区分 Local/S3，也不验证绑定、桶或凭据。须由部署操作者另核对非秘密 provider 与实际 storeId/epoch；没有独立的在线 `storage status` 命令 |
| 出站 Webhook | 未设置 `WEBHOOK_TARGETS_FILE` 或合法 manifest 的 targets 为空是 `disabled`；显式空路径、文件不安全或 schema 错误是 `configuration_error`，不等于禁用 | `pnpm pm webhook status` 对应 `GET /api/v1/workspaces/{workspaceId}/webhooks`；分别核对 configuration、digest、loopHealthy、restoreFenced、端点 state 和 safeBlockCode。`configured` 不等于端点 enabled 或接收器可达 |
| Koishi / Satori | 三个 `IM_SATORI_*` 连接字段均为空时禁用；部分非空或 token/URL 非法则启动失败。仅配置 `IM_BOT_USERNAME` 等可选字段不会启用 | `pnpm pm im status` 对应 `GET /api/v1/workspaces/{workspaceId}/im`；configuration、Satori state、机器人 status 和自己的 bindings 分开核对，`ready` 不证明 Telegram 双向消息已送达 |

### 安全只读核对

- 公共 `GET /api/v1/capabilities` 不查询业务数据、不探测外部目标；它不提供邀请、Webhook 或 IM 的完整状态。未出现某功能字段不能解释为该功能已禁用。
- 上表的工作区接口需要本实例真实 PM 身份与范围；CLI 沿用[现有认证与工作区选择](cli.md)。邀请列表、账号安全页和 IM 状态虽不含凭据，仍可能含邮箱、账号标签、会话或项目身份，不应为配置普查批量读取或附入公开报告。只需记录功能布尔、有限状态和获准的原操作标识。
- 环境文件存在性只能证明文件存在。无需打开秘密 `.env`，可先只核对文件元数据；需要配置存在性时，由获准操作者在隔离子进程中加载**明确的角色配置**，仅输出白名单变量的“已设置／非空”布尔及 `local/s3/disabled/invalid` 模式，不输出值、路径、key 摘要或完整 `process.env`。字段齐全不代表解析合法，也不证明运行进程已经加载它；API 与 Worker 必须分别核对，不能把当前 shell 当运行配置。
- **`GET /health/ready` 不是零写入的 S3 检查。** 它会检查绑定，并通过 [S3 实现](../../packages/infrastructure/src/s3-blobs.ts) PUT/GET 固定 `<prefix>/_pm/health/write-probe`；还会访问数据库与核心目录。不得把普通 GET 等同于无外部副作用，也不得用该探针证明桶私有性或生产验收。
- `pnpm storage` 只有停写维护子命令；`verify` 也需要原 journal/checkpoint 并更新维护 journal，不是在线只读探针。Webhook `reconcile` 和 IM `retry` 是可能外发的动作，不是状态查询。

## 私有 S3 配置

当前解析入口是[blob-storage-config.ts](../../packages/infrastructure/src/blob-storage-config.ts)。API使用无前缀S3变量，Worker不取得S3/AWS凭据；停写维护的源/目标凭据分别使用 `SOURCE_S3_*` / `TARGET_S3_*`，不得写入无凭据描述符或manifest。

| 变量 | 要求与默认 |
| --- | --- |
| `BLOB_PROVIDER` | `local`（默认）/ `s3` / `disabled`，拼写错误失败，不降级 |
| `BLOB_ROOT` | Local专用，默认 `.local/blobs`；S3不以此目录代替对象导出 |
| `S3_ENDPOINT` | 明确HTTPS origin，无凭据/路径/query/fragment，不跟随重定向 |
| `S3_REGION` / `S3_BUCKET` / `S3_PREFIX` | 必填；已存在的普通私有桶、本部署独占非空安全前缀；不自动建桶 |
| `S3_FORCE_PATH_STYLE` | 严格true/false，默认false；隔离MinIO通常显式true |
| `S3_EXPECTED_BUCKET_OWNER` | AWS endpoint必填12位账号ID；兼容供应商的支持/校验不能推测 |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | 成对显式注入；不读取 `~/.aws`、profile、凭据文件或IMDS |
| `S3_SESSION_TOKEN` | 仅临时身份需要；真实到期按失败处理 |
| `S3_TIMEOUT_MS` | 默认15000，1000–120000 |
| `S3_ENCRYPTION_MODE` | `bucket-default`（默认）/ `AES256` / `aws:kms`；默认名称不证明桶已加密 |
| `S3_KMS_KEY_ID` | 仅aws:kms必填；同时核对key policy、区域与灾备权限 |
| `S3_ALLOW_INSECURE_LOOPBACK` | 默认false，仅明确隔离loopback测试可开；不批准公网或任意容器HTTP |

Local/disabled下显式S3变量是配置冲突，不当作已启用。供应商必须实际支持条件PUT、SHA-256 checksum和写后GET验证；私有桶策略、加密、保留/驻留、凭据最小权限和灾备仍需供应商侧证据。

单对象上限8MiB；只执行条件单次PUT，再实际GET核对。写响应未知只核对原key，不重PUT/换key；412不采纳旧身份。授权下载由PM API逐次检查，不提供长期签名直链；没有物理GC、CopyObject、双读回退或多实例核心保证。

### 绑定、迁移与恢复

首次绑定前停止本实例API/Worker及外部核心编辑器；`--stopped`是操作者确认，不替你停止进程。空库/空namespace才使用 `bind --new`，已有Local数据使用 `bind --adopt`全量核对引用与字节。更换endpoint、桶、prefix或Local根不是只改环境变量；按同SQL/core checkpoint执行inventory → migrate → verify → activate，保留原journal/operation/epoch，不换键“重来”。

完整命令、无凭据描述符、显式原参数续作和新目标 `restore-rebind` 见[基础设施运行指南](../../packages/infrastructure/README.md#显式初始化与升级)。独立项目迁移及全根恢复使用[部署手册](../../deploy/README.md#本地项目目录与附件身份)，不把legacy global provider迁移当作已搬完全部项目附件。API/SQL收据成功与远端对象孤立状态分别核对。

备份必须覆盖同一停写SQL/core/登记项目/引用对象和存储身份；私有恢复journal和备份可含任务description前后正文及自动化快照，不是脱敏日志。恢复到新库/新根/新namespace，验证摘要、约束、原收据、授权下载与外发围栏后再决定启用；不得关闭约束、删除marker或把存储可读等同于批准旧凭据信任。

## 邮件邀请与可信恢复邮箱

SMTP传输配置见[部署表](../../deploy/README.md#成员邀请-smtp)。邀请与恢复各自具有origin/key/TTL门禁，配置共享SMTP不会自动启用另一功能；功能字段完全未配置时明确disabled，功能字段部分配置是部署错误。只有SMTP字段而没有任何对应功能字段时，功能仍禁用，不能由服务成功启动推定SMTP已校验。API/Worker须使用相同功能配置，只有可信loopback测试接收端允许关闭TLS。

恢复额外使用：

| 变量 | 要求与默认 |
| --- | --- |
| `ACCOUNT_RECOVERY_WEB_ORIGIN` | 实际HTTPS前端origin；回环本机测试例外，不能从任意Host生成链接 |
| `ACCOUNT_RECOVERY_TOKEN_KEY` | 独立用途32-byte canonical base64秘密，不复用邀请key |
| `PASSWORD_RESET_TTL_SECONDS` | 默认900，300–3600 |
| `RECOVERY_EMAIL_VERIFY_TTL_SECONDS` | 默认1800，300–3600 |

历史登录邮箱/邀请不自动成为可信恢复邮箱。本人先认证并登记候选地址，再完成新的邮箱持有人挑战；匿名申请统一响应，不透露账号资格或声称已送达。重置成功撤销全部旧会话，不自动登录。

链接token只在邮件fragment、当前页面内存及POST body，不写query、URL路径、浏览器持久存储或普通命令journal。响应丢失保留非秘密marker与原请求身份，重新打开原邮件核对，不盲目重发新密码/邮件。已发生SMTP副作用不能由DB rollback撤销；`smtp_accepted`仅证明MTA接受，unknown不自动重发。轮换key前处理/取消旧queued，不将解密失败伪报成功。

## 出站 Webhook 配置与接收协议

仅发送运营批准项目的最小历史事实，不含正文/字段值，不是任意HTTP客户端、入站连接器或任务执行器。接收器响应不能改Markdown、通过审核或完成任务。

`WEBHOOK_TARGETS_FILE`为安全绝对只读manifest；未设置默认禁用，非法或部分配置标 `configuration_error`。精确schema见[webhook-config.ts](../../packages/infrastructure/src/webhook-config.ts)：

- 顶层 `{schemaVersion:1,targets:[...]}`；每目标固定 `targetKey`、workspace UUID、projectIds、eventTypes、`protocol:"pm-receipt-v1"`、`policyVersion:1`。
- `deliveryUrl` / `receiptBaseUrl` / `reconcileBaseUrl` 同一明确HTTPS DNS origin、443、固定无query路径；不接受IP literal、私网/metadata目标、重定向、任意Host/header或代理。
- 每目标keyring声明 `keyId`、`activeFrom`、可空 `activeUntil`、`receiverReady` 与 `secretFile`。绝对文件模板必须恰含一次 `{endpointId}`；先创建paused端点取得UUID，再为该端点/每key独立生成并秘密分发32–256 bytes、无组/其他用户权限的非symlink文件。API只读元数据，只有Worker读取key。
- scope/URL/协议构成不可变targetDigest；API/Worker核对总digest，目标变化不能静默重定向积压。创建/启用需当前workspace范围access.manage，并对项目检查domain.read/audit.read，不新增默认权限。

接收器必须实现持久 `(endpointId,deliveryId)` 去重，与唯一接受效果原子提交；同ID不同hash冲突。已接受重复POST返回原接受收据。receipt GET返回签名且绑定原身份的accepted/pending/unknown；404不是没发生。reconcile POST只有在持久封闭所有旧attempt、拒绝迟到写入后才可返回not_accepted；此屏障后管理员才能显式恢复原deliveryId/hash。

请求固定JSON及X-PM身份/attempt/timestamp/key/signature头；HMAC-SHA256使用 `pm-webhook-request-v1` 域，依次绑定method、精确path、endpointId、deliveryId、eventId、attemptId、attemptNo、Unix秒、keyId和原body SHA-256（UTF-8/LF无尾随空行）。响应使用独立 `pm-webhook-receipt-v1` 域并绑定原request attemptId、状态、响应原字节SHA与keyId；具体原字节规范以[协议实现](../../packages/domain/src/webhooks.ts)为准。时间偏差限制±300秒、常量时间验签、严格schema/大小，验签先于处理。HTTP2xx但签名/身份/hash不匹配不算接受。

每次派发重新校验全部DNS结果并pin实际连接IP；TLS SNI/证书仍绑定批准域名，不跟随3xx，不继承HTTP代理/关闭证书，不自动retry。unknown保留原attempt与收据，不能更换deliveryId绕过；“接收器已持久接受”不等于业务处理成功。恢复PM数据库后还需实际核对接收器永久账本与旧attempt屏障，才能重新启用外发。

## Koishi + Satori 即时通讯（可选）

IM 网关默认关闭，需要独立部署 Koishi；Dovspace 只作为 Satori 客户端，不维护 Telegram/飞书等平台适配器。首期仅支持 Telegram **私聊文字命令**，不开放群聊、文件、按钮、任意命令转发、Agent 或 Terminal 能力。

部署与端口、秘密文件、启动顺序见 [Koishi 运行时说明](../../deploy/koishi/README.md)。PM API 与 Worker 需要同一组 `IM_SATORI_WS_URL`、`IM_SATORI_API_URL`、`IM_SATORI_TOKEN_FILE`；部分配置会直接失败。用 `node scripts/setup-satori-token.mjs` 生成私有 token 文件，不要把 token 写入日志、URL、前端配置或可提交文件。

绑定入口为 `/pm/<workspace>/settings/im`，也可从“设置 → 集成 → 集成目录”的 Koishi / Satori 卡片进入：生成一次性链接码后，在机器人私聊发送 `/link <码>`，再用 `/use <项目ID>` 选择项目。可用命令以设置页和后端命令表为准；每条写操作仍逐次检查当前成员能力和项目范围。链接码为 128 位随机值，默认 5 分钟有效，服务端只保存摘要；重复或过期链接码不可用，撤销绑定后立即失效。

绑定后的常规回复与通知由 Worker 持久投递；`/help`、未绑定提示等由 API 直连回复，不能用它们证明 Worker 投递成功。持久发送结果未知时不会自动重发；先核对平台侧，再使用 `node --env-file=.env.worker scripts/im-delivery-admin.ts status` / `node --env-file=.env.worker scripts/im-delivery-admin.ts retry <id>` 显式处理。Satori 连接成功、HTTP 2xx 或聊天回复都不等于任务完成，也不代表真实平台账号或消息可达性已验收。

## 真实目标的最小验收与清理

以下是**另行获得目标与副作用授权后**的操作步骤，不是自动执行的检查清单。先冻结当前部署来源、实例/工作区、功能状态、允许收件人/桶前缀/接收器/机器人及原操作标识；只验证已启用项。当前没有这些证据时，结论保持“配置范围可核实，外部待验”。协议夹具、MinIO、SMTP 测试服务器或 Satori 假服务只能证明其限定协议分支，不能代替实际目标。

| 能力 | 缺少便不能真实验收的前提 | 最小真实验证 | 结果未知与清理边界 |
| --- | --- | --- | --- |
| SMTP 邀请 | 已启用的 API/Worker 同用途配置、实际 MTA 及发件身份、可由操作者查收的获准测试邮箱、专用工作区与 `access.manage` | 用原生邀请入口对该邮箱创建一次邀请，保留原 commandId/invitationId；核对原收据与 `invitations list` 的投递状态，再由邮箱持有人确认实际收到且链接 origin 正确。只检查送达无需接受邀请或授予成员权限 | `smtp_accepted` 不是收件箱送达；`unknown` 先以原 deliveryId/Message-ID 查 MTA 与收件箱，不以 resend 排障。结束后显式撤销测试邀请；已发送邮件、审计和收据不能靠撤销或 SQL 删除抹去 |
| SMTP 恢复 | 独立恢复配置、专用测试账号/受控邮箱、允许变更该账号及撤销其会话 | 先在测试账号登记并通过真实邮件完成邮箱挑战；若验收密码恢复，再仅对该账号执行一次匿名申请，查收原邮件，提交一次重置并核对旧测试会话失效、不自动登录。不得在日常操作者账号上试重置 | 匿名 202 不证明发信或账号资格。响应丢失按原 actionId/requestId 与原邮件走既有 lookup/收据入口，不重发新密码；取消候选或解绑仅操作该测试账号，不能撤回已发邮件或恢复已撤销会话 |
| 私有 S3 | 已启用且绑定正确的实际 provider、独占获准 namespace、受限写读身份，以及供应商侧私有性/加密/保留策略证据 | 先确认选中的验收对象**实际路由到该 S3 storeId/epoch**，不要把独立项目的 Local 附件当 S3。经既有 `upload stage` → `artifact register` → `artifact download` 使用一份小型非业务字节，核对原请求收据、版本 SHA-256/大小与真实下载；同时核对供应商策略，不能仅看上传成功 | 写响应未知只 HEAD/GET 原 key 并核对原上传请求；不换 requestId/key 重传。hide/过期不是物理删除，系统没有物理 GC；不得直接删除仍被版本/收据引用的对象、marker 或整个 prefix。需要无持久残留时必须事先选择独立验收环境，而不是事后清理业务桶 |
| 出站 Webhook | 已批准且启用的真实目标、同 digest 的 API/Worker、可用 key、无恢复围栏，接收器实现持久去重/签名收据/旧 attempt 屏障，并有专用项目事件授权 | 由该专用项目一次获准动作产生一个 allowlisted 事实，保留 eventId/endpointId/deliveryId/hash；用 `pnpm pm webhook deliveries ENDPOINT_UUID`、`pnpm pm webhook delivery DELIVERY_UUID` 核对原 attempt 与有效 accepted 收据，再由目标操作者核对实际持久账本与唯一效果。不提供任意 URL 的“试发”旁路 | unknown 或 GET 404 都不能证明未发生；先查原 delivery，只有目标完成屏障并返回有效 not_accepted 收据后，才可显式 resume 原 delivery/hash。暂停本轮自有端点只能停止后续派发，不能撤回已接受效果；保留目标账本、旧 key 与收据至原 attempt 收口，勿删除台账或换 ID 重建 |
| Koishi / Satori | 已配置且运行的独立 Koishi、真实 Telegram bot/测试用户与私聊、API/Worker 同 token/gateway 身份，以及受控绑定/专用项目授权 | 先核对 `im status` 的连接与机器人状态；由测试用户私聊一次 `/help` 核对直连回复，再用获准测试绑定执行 `/use <专用项目ID>`、`/tasks` 核对 Worker 持久回复。无需创建/完成任务；设置、真实私聊证据与队列 accepted 分别记录 | `/help` 不经过持久回复队列，单独成功不能覆盖 Worker；Satori 2xx 也不证明 Telegram 用户收到。先按原平台消息/队列身份核对，`im-delivery-admin.ts status` 只有聚合计数、不返回逐条 ID。retry 可能重复消息，不能自动执行；仅撤销本轮测试绑定/关闭其通知，不删 Koishi 账号、共享 token、既有绑定或投递历史 |

已有隔离回归入口为 `node scripts/check-ci.mjs --stage backend`，不会加载本机 `.env`，但会准备自有 PostgreSQL/MinIO 并运行完整后端范围，前提和资源清理见[测试说明](../../tests/README.md#自动-pr-检查与独立验收入口)。这是实现/协议回归，不是上述真实账号、桶策略或接收器验收；缺账号、目标或外发授权时应逐项保留精确缺口，不自动开启可选能力。
