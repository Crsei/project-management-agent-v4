# 邮件、私有 S3 与出站 Webhook

这些能力默认按配置门禁开放；“源码存在”“配置合法”“依赖就绪”“外部送达”和“生产验收”不是同一结果。不复制历史凭据，不提供假接收器或静默Local回退。角色、存储绑定和完整恢复见[部署手册](../../deploy/README.md)。

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

SMTP传输配置见[部署表](../../deploy/README.md#成员邀请-smtp)。邀请与恢复各自具有origin/key/TTL门禁，配置共享SMTP不会自动启用另一功能；完全未配置明确disabled，部分配置是部署错误。API/Worker须使用相同功能配置，只有可信loopback测试接收端允许关闭TLS。

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
