# Infrastructure

已实现 PostgreSQL/Drizzle schema、校验摘要的 SQL 迁移、scrypt/opaque session 认证，以及 Linux Local / AWS SDK v3 私有 S3 兼容 BlobStore。关系约束、不可变历史、成员引用和 UUID 唯一性由迁移与应用规则共同保证。BlobStore 公共业务接口仍只有 `init/check/put/read`，单对象 8 MiB；不提供 delete、copy、双读回退、生命周期删除或自动 GC。孤立对象和过期 upload 保留。

## Provider 与应用边界

- `blob-storage-config.ts`：`readBlobStoreConfig` 严格解析 `local / s3 / disabled`，默认 Local；S3 只用显式环境凭据，不查询 SDK profile、凭据文件或 IMDS。配置和 factory 构造均不做 I/O。Worker 不解析 S3 配置。
- `blob-storage-provider.ts`：`createBlobStore` 构造实现；`BlobStorageProvider` 的 marker、精确 key 导入和 namespace 清单是基础设施维护端口，不传给业务/UI。`blobs.ts` 保留 Linux 目录描述符、O_NOFOLLOW、fsync、hard-link 条件发布。
- `s3-blobs.ts`：固定桶/前缀、`maxAttempts=1`、单次 `If-None-Match:*` PUT + SHA-256 checksum + 实际 GET；不使用 multipart、供应商 CopyObject、签名下载或公开 ACL。响应流按声明长度/8 MiB 有界消费并验摘要。写响应未知只 HEAD/GET 原候选 key；412 拒绝采纳；无法核对报 `blob_write_outcome_unknown`，不重 PUT。
- `blob-storage-binding.ts`：`bindBlobStore` 每次读写核对 SQL active binding/epoch/locator 与不可覆盖 marker；实例首次接受的 storeId/epoch 被固定。普通 init 不创建或认领 binding/marker。readiness 用固定探针实际 PUT+GET，门禁+探针预算 2 秒；失败不意味着可切回其他 provider。
- `blob-storage-inventory.ts`：事务内游标遍历本 schema 所有持久 JSON 列，包括 upload（过期/已消费均不筛掉）、不可变版本、收据、outbox、事件及其他历史；所有 objectKey 的 SHA/size/contentDigest 必须一致。缺少必需表权限、未知 scalar blob 引用或坏引用直接终止。

S3 配置字段、权限、生产私有性/加密和未知写语义见[完整实施计划](../../docs/implementation/service-s3-blobstore-plan.zh.md)。存储可用不意味着桶私有性、备份恢复、供应商 SLA 或多 API 已验收；Markdown 仍只有一个 API 写者。

## 显式初始化与升级

迁移 `0028_blob_storage_binding.sql` 只建立表和不可变维护历史，不创建默认行。先迁移，再在 API/Worker/外部 core 写者停写时执行显式绑定，最后启动业务 API。

维护配置描述文件只含非秘密字段，例如 Local：

```json
{"BLOB_PROVIDER":"local","BLOB_ROOT":"/absolute/owned/private/blob-root"}
```

S3 描述文件采用同名 `S3_ENDPOINT/REGION/BUCKET/PREFIX/...` 字段，值均为字符串；**不允许 access key、secret 或 session token 写入描述文件**。维护源身份仅从 `SOURCE_S3_ACCESS_KEY_ID / SOURCE_S3_SECRET_ACCESS_KEY / SOURCE_S3_SESSION_TOKEN` 注入，目标身份仅从 `TARGET_S3_*` 注入；DATABASE_URL 由维护进程环境注入，不写命令行/报告。API 自身使用不带 SOURCE_/TARGET_ 的显式 S3 字段。维护身份与 API 身份分离。

```bash
# 全新库、空目录/空独占前缀；绝不静默认领
node scripts/blob-storage.ts bind --new --target-config /owned/local.json --stopped
# 旧 Local 离线升级：全量 SQL 引用 + 实际字节验证后才建 marker/binding
node scripts/blob-storage.ts bind --adopt --target-config /owned/local.json --stopped
```

`--stopped` 是操作员对本项目 API、Worker、外部 Markdown 写者已停写的明确确认，不是脚本替人停止服务；脚本不读凭据文件、不停止任何服务。新库拒绝旧 SQL 引用或非空 namespace；adopt 不修补坏引用、不制造空对象。初始化若在 marker 落盘后 SQL 提交前中断，先核对事实，再使用原 `--target-store-id` 显式恢复，不能删除 marker 后盲重来。

## 离线迁移、续作和切换

`blob-storage-maintenance.ts` 实现真实 `bind/inventory/migrate/verify/activate/restore-rebind`。migration journal 为 0600、原迁移ID/activationId/rollbackId/目标storeId/epoch/完整引用/SQL与core摘要固定；状态更新原子 rename+fsync。`blob-storage-sql-checkpoint.ts` 对除binding/维护history外所有业务表的完整行多重集计算摘要，迁移/核验/激活拒绝后来新增的非blob事实。冻结、激活和恢复用 SQL epoch CAS，并记录不可变维护历史。目标 marker 先于目标数据导入建立独占身份；重启只核对相同目标，已存在对象先实际 read，缺失项才条件导入原 key。

core 清单是 `[{path,sha256,size},...]`；`blob-storage-checkpoint.ts` 的 `captureCoreCheckpoint/verifyCoreCheckpoint` 按路径排序计算规范摘要，包含 config/views/`.pm/state`，只排除 cache，拒绝符号链接和缺失 state。DB dump 文件必须是同停写窗口保存的真实 SQL dump；CLI核对其文件摘要，不替代 pg_restore 和所有约束验证。

```bash
node scripts/blob-storage.ts inventory --source-config /owned/source.json --output /owned/inventory.json --dump-file /owned/database.dump --core-root /owned/core --core-manifest /owned/core.json --stopped
node scripts/blob-storage.ts migrate --source-config /owned/source.json --target-config /owned/target.json --journal /owned/migration.json --expected-epoch EPOCH --dump-file /owned/database.dump --core-root /owned/core --core-manifest /owned/core.json --stopped
# 同 journal / source / target / checkpoint 续作，不换迁移ID
node scripts/blob-storage.ts verify --target-config /owned/target.json --journal /owned/migration.json --dump-file /owned/database.dump --core-root /owned/core --core-manifest /owned/core.json --stopped
node scripts/blob-storage.ts activate --target-config /owned/target.json --journal /owned/migration.json --manifest-sha256 MANIFEST_SHA256 --dump-file /owned/database.dump --core-root /owned/core --core-manifest /owned/core.json --stopped
```

复制/验证未完成可以保持冻结续作，或 `activate --resume-source --source-config ... --manifest-sha256 MANIFEST_SHA256` 在原 manifest/epoch、全部源对象、完整SQL事实摘要和实际core checkpoint核验后 CAS 恢复原 source（其余 journal/checkpoint 参数同上）。激活后尚无任何新SQL/core事实时同入口允许写前回退；任何新事实即拒绝回指旧source。activation/restore-rebind 响应丢失只按原操作ID/epoch/manifest读既有提交事实，已提交后不重新导入/切换。目标已写入新业务后，返回 Local 必须重新停写迁移**当前全部**引用，不能只改环境变量。

## Provider 感知备份与新目标恢复

`blob-storage-backup.ts` 的 `exportBlobBackup` 从**同一停写 dump 恢复出的隔离库**提取引用，按 provider read 导出携带原裸 key/真实 bytes/SHA/size 的 0700/0600 归档；S3 不遍历 BLOB_ROOT。`verifyBlobBackup` 逐项核对归档和 dump 引用。`importBlobBackup` 只向新的独占 namespace 条件导入原 key；`restoreBlobBackup` 在完整导入后按原 epoch/原storeId执行显式 restore-rebind，保留旧 binding 来源及 dump/core摘要。新storeId与操作ID由调用者生成一次并持久保存，以原身份续作。

`restoreRebindStorage` 在**恢复目标库**的新 binding 激活事务内调用应用层 `fenceRestoredServices(sql)`：先复核原 epoch/storeId/完整引用，再隔离旧认证会话、恢复 token、待发邮件、Webhook/通知租约和旧 Worker 健康，最后更新 binding 并登记原操作事实，任何失败全部回滚。CLI `restore-rebind` 和 `restoreBlobBackup` 共用此路径；普通 bind/migrate/activate/source rollback 不调用。源库绝不执行该隔离；原 operationId 已提交的恢复查询提前返回，不再次撤销新目标随后建立的合法会话。

```bash
node scripts/blob-storage.ts import --target-config /owned/new-target.json --backup-directory /owned/backup/blobs --manifest-sha256 BACKUP_SHA256 --target-store-id NEW_STORE_UUID --dump-file /owned/database.dump --core-root /owned/restored-core --core-manifest /owned/core.json --stopped
node scripts/blob-storage.ts restore-rebind --target-config /owned/new-target.json --backup-directory /owned/backup/blobs --manifest-sha256 BACKUP_SHA256 --target-store-id NEW_STORE_UUID --operation-id RESTORE_UUID --expected-epoch OLD_EPOCH --dump-file /owned/database.dump --core-root /owned/restored-core --core-manifest /owned/core.json --stopped
```

恢复只用新数据库、新 core 根/卷和新桶/独占前缀，不能复制旧 marker 假装原部署。SQL/core由父级备份入口负责同窗口归档和约束恢复；其专用本机 PG 安全范围保持不变。摘要通过后仍须隔离 API/Worker 的真实登录、原收据、下载/cover/Evidence、SSE 和新上传 HTTP 验收；本模块不伪造这一证据。

核心允许缺少 `.pm/config.yaml` 而使用内置默认配置；checkpoint 保留缺省，不制造配置。已存在配置及 `.pm/state` 完整验证，缺失 state/符号链接/摘要变化拒绝。S3 源备份 CLI 已在新库、新核心副本和新 Local 身份恢复并经授权 HTTP 核验，见[统一交付](../../docs/implementation/service-completion-and-acceptance.zh.md#five-package-delivery)。

## 专项测试入口与证据边界

新增 `blob-storage-config.test.ts`、`blob-storage-binding.test.ts` 和 `tests/s3-blobs.integration.test.ts`；保留原 Local 文件安全测试。S3夹具可以通过 `PM_S3_TEST_MINIO_BINARY` 启动自有临时 MinIO，生成临时凭据、动态 loopback 端口、随机桶/前缀，故障代理真实转发 PUT 后丢响应/断GET，验证原 key 回查、无重 PUT、边界/条件头/篡改/错绑定。也可显式注入 `TEST_S3_*` 指向批准的隔离测试供应商；故障代理只用于 loopback MinIO。夹具只删除它自己新建的随机测试桶/临时资源；生产适配器没有删除接口。

```bash
# 集成 owner 在全部包合并后运行；DATABASE_URL/TEST_DATABASE_URL 是隔离测试授权
node --test packages/infrastructure/tests/blob-storage-config.test.ts packages/infrastructure/tests/blobs.test.ts packages/infrastructure/tests/blob-storage-binding.test.ts
PM_REQUIRE_S3_TESTS=true PM_S3_TEST_MINIO_BINARY=/approved/path/to/minio node --test tests/s3-blobs.integration.test.ts
```

要求 S3 的批次缺少真实 fixture/PG 会失败，不能把普通未配置环境的 skip 计为 S3通过。协议夹具使用隔离管理员身份建桶/造篡改，不代表 API 最小权限、实际供应商私有性或生产加密通过；这些仍需独立受限身份和供应商管理员脱敏配置证据。owned MinIO启动还须以真实带认证HeadBucket的明确404确认对象层已初始化，再执行一次CreateBucket，不能把HTTP健康200当S3初始化完成。实现代理未运行全套 build/lint/tests/formatter、安装、业务服务或用户数据迁移；经owner授权的隔离SDK操作级诊断与实际结果见S3计划10.3，统一/浏览器验收仍由owner记录。
