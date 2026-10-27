# 私有 S3 兼容 BlobStore 实施规划

状态：**S01–S08 的适配器、绑定、共享接线、维护/备份实现和隔离真实 MinIO/HTTP/浏览器/新库恢复已完成；目标供应商与生产切换仍未启用**。第2节与第10节前半保留实施前/代理交接历史；最新证据见第10.5节及[统一交付](service-completion-and-acceptance.zh.md#five-package-delivery)。不读取或迁移既有业务凭据/对象，不把私有 S3 等同核心多写或 HA。

依据：[当前 Markdown ADR](markdown-integration-adr.zh.md)、[领域实施计划第七节](../domain-design/README.md#implementation-plan)、[最新交付与边界](backend-delivery.md)、[服务补齐第七节 D11/D13/D14](service-completion-and-acceptance.zh.md#plane-source-decisions)。保留 INV-01/09/10/13/14/20、SC-07/12/13/14/16/20 和 INF-01/04/05/06；任务完成规则按当前 ADR，不重新引入旧 SQL 审核前置条件。Plane 只作机制参考，不复制 AGPL 源码。

## 1. 范围与固定默认

### 1.1 本包交付边界

- 为现有 `BlobStore.init/check/put/read` 实现私有 S3 兼容 provider，保留 Local provider，并修正应用注册、API 装配、配置、健康和备份对本地实现的绑定。
- 单文件上限仍为 **8 MiB（8 × 1024 × 1024 decoded bytes）**；服务端生成 key；保持 key 格式、SHA-256、实际字节数和 SQL 元数据交叉检查。
- 浏览器继续 `StageUpload → RegisterArtifact / AddArtifactVersion`，继续通过带当前会话/项目授权的 API 下载。没有浏览器直传、长期或短期 GET 签名跳转、对象存储 CORS、公开桶、CDN 内容缓存或新的文件 URL 协议。
- Files 复制在所有 provider 上均为 `read(选定不可变版本.objectKey) → 核验版本摘要/大小 → put(bytes)`，得到独立随机 objectKey；不增加 `copy`，不调用供应商 `CopyObject`，不共享字节身份、不去重。不改变 Files 的重命名、软隐藏、恢复、来源记录或 Evidence/Review 合同。
- **仍只有一个 API 进程写 Markdown 核心**。S3 不提供 Markdown 分布式锁，不开放多 API、滚动交叠、cluster/PM2 多 worker、共享核心目录或 HA。
- 没有 `delete`、物理 GC、按年龄清理、S3 生命周期过期删除、通用 job 框架、Redis/RabbitMQ、桶自动创建或云资源部署。孤立对象和过期 upload 保留。

### 1.2 已选技术方向与需用户决定的项目

| 分类 | 本计划选择或所需输入 | 影响 |
| --- | --- | --- |
| 可直接实施 | 服务端 SDK、私有桶、授权 API 下载、单次条件写入、实际 GET 校验、原 commandId 恢复、停写切换、单活动 provider | 不以供应商或产品保留政策尚未确定为由悬置这些工程任务 |
| 可直接实施 | 使用维护中的 AWS SDK v3 `@aws-sdk/client-s3`，精确版本和锁文件在实施时固定；不自己实现 SigV4 | 当前根依赖尚无 S3 SDK；新增运行依赖须进入生产镜像 |
| 可直接实施 | 一个 PM 数据库应用 schema 对应一个活动存储绑定；不是每工作区动态选桶 | 与现有全局 `blobRoot` 模型一致，不给 HTTP 请求选择 endpoint/bucket/provider 的能力 |
| 用户/运维必须提供 | 目标供应商、区域、私有桶、独占前缀、endpoint、凭据注入方式和网络出口 | 阻塞供应商上线验收，不阻塞本地适配器和隔离 MinIO 开发 |
| 用户/安全必须选择 | 数据驻留、服务端加密模式、是否指定 KMS key、相关密钥灾难恢复责任 | 不推造合规等级；未满足批准的加密边界不得放业务内容 |
| 用户/运维必须选择 | 可接受维护窗口、备份保存位置/保留期、RPO/RTO、恢复切换授权人 | 本计划不承诺在线迁移、固定停机时长、自动回退或零数据丢失 |
| 不在此包作决定 | Files 隐藏/恢复保留期及未来物理 GC；多实例核心拓扑 | 无保留政策不自动删除对象；D11 的 S3 与多实例拆开验收 |

## 2. 当前源码证据与必须切断的本地依赖

以下是静态核实，不是本轮运行证明。

| 真实路径 | 当前事实 | 本计划实施影响 |
| --- | --- | --- |
| [blobs.ts](../../packages/infrastructure/src/blobs.ts) | `BlobStore` 只有四个方法；`StoredBlob={key,sha256,size}`；key 为 `sha256-<64位小写hex>-<UUIDv4>.blob`；每次 `put` 新 UUID。Local 使用 Linux 目录句柄、O_NOFOLLOW、临时文件、fsync、hard-link 不覆盖发布；`read` 拒绝非法 key、非安全普通文件、超限、摘要变化 | 保留公共四方法和现有 Local 安全检查；抽取可复用 key 校验，S3 不放宽 key 或大小边界 |
| [registry.ts](../../packages/application/src/registry.ts) | `createRegistry(blobs: LocalBlobStore, …)` 是具体类型绑定，但函数只把对象交给 delivery/project-extras | 改为 `BlobStore`，不把 `root` 或 SDK 客户端传入业务层 |
| [delivery.ts](../../packages/application/src/delivery.ts) | 已使用 `BlobStore`。StageUpload 先 put，后在命令事务登记 upload/outbox；租约一小时。登记要求 owner、TTL、单次消费和 upload CAS；版本/下载/审核均 read 并核验 SHA 与大小 | 不修改 StageUpload payload、upload/artifact_version 的 objectKey 语义、两阶段业务或收据结构 |
| [project-extras.ts](../../packages/application/src/project-extras.ts) | 已使用 `BlobStore`；封面会 read 版本，并核验 SQL SHA/contentDigest/size 和真实栅格签名 | S3 下保持这条真实读取，不能只凭 HEAD/MIME 设置封面 |
| [app.ts](../../apps/api/src/app.ts) | `buildApp` 接收 `blobRoot` 并直接 new LocalBlobStore；onReady 在有 DB 时 init；ready 调 check；capabilities.storage.enabled 当前只是 `Boolean(pool)` | 新增抽象注入并改造装配；禁用/错误 provider 不能因 DB 存在就称存储可用 |
| [main.ts](../../apps/api/src/main.ts)、[config.ts](../../apps/api/src/config.ts)、[runtime-config.ts](../../packages/infrastructure/src/runtime-config.ts) | main 将 runtime.blobRoot 传给 buildApp；API config 只校验 HOST/PORT；runtime 配置无 S3，默认本地 `.local/blobs` | provider 判别配置放基础设施配置层；HOST/PORT 不承载 S3 业务规则；不通过隐式 SDK profile/本机文件查找凭据 |
| [backup.mjs](../../scripts/backup.mjs) | 仅接受专用本机 Compose PG；先 dump public，再 readdir BLOB_ROOT/copyFile；没有使用 BlobStore。`--verify` 只逐项检查 artifact_version 对清单，不含所有 upload 引用；core 复制排除 cache，但脚本未协调外部写入者停写 | 不能把该脚本用于 S3 后继续报告完整备份；改成显式 provider 感知、引用集合完整且停写的一致备份 |
| [部署 Compose](../../deploy/compose.app.yaml)、[Dockerfile](../../deploy/Dockerfile)、[部署手册](../../deploy/README.md) | API 固定本地 BLOB_ROOT 和 blob 卷；Worker 不挂载 core/blob 卷；replicas=1 是运维约束。共享 backend env_file 当前也注入 Worker/migrate | 只给 API 和显式维护进程 S3 身份/网络；不把新秘密扩散到 Web、Worker、migrate；保留 core 卷和单写 |
| [blobs 测试](../../packages/infrastructure/tests/blobs.test.ts) | 真实本地目录测试独立身份、并发完整性、重启、路径逃逸、8 MiB、篡改、symlink；底层允许空 bytes | 共用 provider 行为测试保留空 bytes 和精确边界；UI 的不允许空上传不倒灌成新 BlobStore 限制 |
| [delivery 测试](../../packages/application/tests/delivery.test.ts)、[HTTP 集成测试](../../tests/backend.integration.test.ts) | delivery harness 用真实 Local；HTTP 会直接改 `join(blobRoot,key)` 造篡改，并检查 download/submission 拒绝且无成功 outbox | 留下 Local 特有文件系统测试；S3 篡改由隔离管理员身份更改测试对象，不用 fake BlobStore 替代真实集成 |
| [合同生成器](../../scripts/generate-contracts.ts)、[合同测试](../../packages/contracts/tests/openapi.test.ts) | 为生成命令 schema 构造不 init 的 LocalBlobStore | 构造须继续无 I/O/无凭据/无网络；生成合同不依赖真实 S3 |

`LocalBlobStore.root` 是 Local 实例公开属性，当前生产调用方没有取 `blobs.root` 的依赖；读 root 的行为在 Local 适配器内部。本地布局依赖实际上还包括 `BLOB_ROOT` 配置、backup 的目录遍历、Compose/Dockerfile 卷路径、测试的本地破坏夹具，而非仅改 registry 类型即可完成。

API `buildApp({blobRoot})` 的调用还在 [dashboard fixture](../../tests/dashboard-fixture.ts)、[邀请 fixture](../../tests/member-invitations-fixture.ts)、[核心创建恢复](../../tests/core-creation.integration.test.ts)、[工时恢复](../../tests/dashboard-time.integration.test.ts)、[独立 Worker 测试](../../tests/worker-process.integration.test.ts)。实施时用 LSP references（可用时）列全 `BlobStore/createRegistry/buildApp/runtimeConfig` 导出引用，迁移全部调用；不留下另一套 blobRoot 专用应用入口或永久兼容别名。

## 3. 拟配置与装配合同

### 3.1 配置字段（仅说明，不含秘密值）

以下除已存在 BLOB_ROOT 外均拟新增；秘密只说明存在性，不展示样值。

| 字段 | 规则和默认 | 是否秘密 |
| --- | --- | --- |
| `BLOB_PROVIDER` | 严格 `local / s3 / disabled`；未设置默认 local，保留当前部署语义；拼写错误直接配置失败，不降级 local | 否 |
| `BLOB_ROOT` | 已存在；只在 local 解析/校验。S3 模式不创建、不检查、不备份此路径 | 路径是运维信息，不公开返回 |
| `S3_ENDPOINT` | s3 必填；绝对 HTTPS origin，不含 userinfo/path/query/fragment；不接受请求体输入，不跟随跨 origin/区域自动重定向 | 否，但不向匿名 API 返回 |
| `S3_REGION` | s3 必填，非空合法区域标识；与签名/目标桶相符，不猜区域 | 否 |
| `S3_BUCKET` | s3 必填，限定普通桶名；不接受 URL/ARN/access point/directory bucket；不自动创建 | 否 |
| `S3_PREFIX` | s3 必填且非空，ASCII 安全路径段，无空段、点段、反斜杠、百分号或前后 `/`；必须是本部署独占命名空间 | 否 |
| `S3_FORCE_PATH_STYLE` | 严格 true/false，默认 false；MinIO 验收显式 true；写入 locator 指纹，不能临时猜测后改路由 | 否 |
| `S3_EXPECTED_BUCKET_OWNER` | AWS endpoint 必填 12 位账号 ID；兼容供应商若支持则配置并真实校验，不支持不能假装已做 owner 校验；不能替代 store marker | 否，受限运维信息 |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | s3 首版要求成对完整，API 从受限环境/运行时秘密注入；禁用隐式 ~/.aws、凭据文件、其他 profile、IMDS 自动发现 | 是，不记录键值、不回显错误内容 |
| `S3_SESSION_TOKEN` | 仅在供应商给临时身份时同时注入；到期必须真正失去就绪，不假成功 | 是 |
| `S3_TIMEOUT_MS` | 默认 15000，整数 1000–120000；单个数据请求有界；终止流并释放 socket | 否 |
| `S3_ENCRYPTION_MODE` | 严格 `bucket-default / AES256 / aws:kms`，默认 bucket-default；生产必须证明批准的静态加密确实启用，默认名不等于已加密 | 否 |
| `S3_KMS_KEY_ID` | 仅 aws:kms 必填；与 key policy、区域和恢复权限共同验证；其他模式设置时报配置错误 | 标识非密钥材料，但不公开 |
| `S3_ALLOW_INSECURE_LOOPBACK` | 默认 false；仅隔离测试可显式 true 且目标实际解析为 loopback 才允许 HTTP。不能用来批准公网/容器任意 HTTP | 否 |

- `local/disabled` 模式若显式提供 S3 配置字段，报“配置与 provider 不一致”，而非误以为 S3 生效；默认环境里没有这些字段时不要求 S3。切换只改字段但没完成第 6 节绑定迁移，必须拒绝就绪。
- 配置结构错误立即安全失败；错误只含字段名/分类，不含 endpoint 凭据、SDK request、签名、token、数据库 URL。无 DATABASE_URL 的 bootstrap 不执行存储 I/O，也不宣称 S3 ready。
- workload identity 不是本计划虚构的现有能力；若目标环境要求它，由运维先指定受支持身份源，再在同一配置读取端增加显式认证模式与过期验收，不能偷偷启用默认 credential chain。

### 3.2 抽象注入与进程责任

拟新增基础设施 factory `createBlobStore(providerConfig): BlobStore`，构造本身无 I/O。`main` 解析 provider 配置，创建实现并将 `blobStore: BlobStore` 和非秘密 `blobStorageLocator` 注入 `buildApp`；`buildApp` 在基础设施装配边界用拟 `bindBlobStore(pool, locator, store): BlobStore` 包装绑定门禁，registry、下载和cover统一只拿此受保护实例，`createRegistry` 改收 `BlobStore`。门禁的 init/check 读取DB binding并匹配marker，未初始化、migrating或校验失败时read/put必须拒绝；网络恢复可重新check，但不能自动接受变更后的storeId/locator。底层Local/S3适配器不直接依赖pg或业务SQL。应用集成fixture初始化自有binding并注入受保护Local；纯适配器测试/静态合同生成可直接构造不带应用门禁的Local。所有buildApp调用迁移，不保留blobRoot专用入口；SDK、root、bucket不进入delivery或Files。

`runtimeConfig` 是 Worker 也会调用的共享函数（见 [Worker](../../apps/worker/src/main.ts)）；通用 DB/间隔配置与 `readBlobStoreConfig` 作为同一基础设施配置模块的独立入口，只有 API/维护进程调用后者。Worker 继续 outbox/SSE、维护和独立 SMTP 循环，不为 S3 新增后台发送循环，也不需要 S3 凭据或出网。合同生成继续使用不 init 的 Local 实例，仅生成静态 schema。

## 4. 存储行为、错误与网络未知结果

### 4.1 四方法的精确映射

真实 S3 地址仅由已验证配置生成：业务 key 对应 `<prefix>/objects/<key>`；`key` 本身仍是原来的裸文件名。控制对象在 `<prefix>/_pm/`，绝不接受浏览器给控制路径。

| 方法 | 拟实现 |
| --- | --- |
| `init()` | 应用绑定门禁先匹配第6节DB binding/marker，底层S3连接已存在桶并核验写探针。**不**自动建桶、修改ACL/policy、自动认领未知旧桶、初始化空marker掩盖错挂载。配置合法但网络不可达时进入degraded，由API保留live/ready诊断入口，不启动业务成功回退 |
| `check()` | 对同一个已绑定 locator 校验 marker；对固定 `<prefix>/_pm/health/write-probe` 写入极小随机挑战并实际 GET 比对（单 API 下串行，合并同一时刻并发 check），证明读和写，不仅 HeadBucket。探针不是业务不可变对象，可原地覆写固定对象；不增加 delete，不按每次 readiness 产生永久随机对象。readiness 专用探针预算固定 2000ms 总时限，超时即 storage=false，不放大 Compose 3s 健康请求。全检查结束前不返回 ready |
| `put(bytes)` | 在网络前检查 ≤8 MiB；SHA-256 一次计算并派生 hex/base64，生成新 UUIDv4 key。单次 `PutObject` 携带正确 ContentLength、`ChecksumSHA256`、`If-None-Match: *` 和所选加密参数，不发送 public ACL。确认后对本 key 实际 GET 校验 key摘要/字节数再返回 StoredBlob。SDK 数据写 `maxAttempts=1`，关闭自动重 PUT、跨域/改区域重发和 multipart；允许供应商的最终接收承诺，不能声称获得本地 fsync 或跨 key 事务 |
| `read(key)` | 在网络前执行与 Local 同一严格 key regex；固定绑定桶/前缀 GET。响应长度必须是 0–8 MiB 整数；按上限有界消费流，缺长度、提前结束、超出声明/上限或摘要不符均拒绝，及时 abort/release。实际 SHA 必须匹配 key；delivery/cover 再匹配 SQL sha256/contentDigest/size。不得先无界 `transformToByteArray()` 后再检查，也不把 ETag、用户 metadata 或 MIME 当内容摘要 |

供应商必须实际支持条件 Put、SHA-256 checksum 和写后读的上述行为；不支持时明确不兼容，不用“先 HEAD 再无条件 PUT”、对象版本控制或随机 key 的低碰撞概率假装不可变条件写。Versioning 是可选运维防护，不替代条件写，且禁止业务对象的 delete marker/过期规则。

### 4.2 网络未知与命令事务分开核对

[现有 kernel](../../packages/application/src/kernel.ts) 在命令 SAVEPOINT 外持久化收据：DomainError 会回滚业务变更并形成 rejected 原收据；SQL COMMIT 响应丢失仍可能让客户端 unknown。本包不新增 upload 或 copy 专用收据系统。

1. **PUT 200 + GET 摘要/大小匹配**：只说明该对象持久化并可读；随后仍须原 SQL 事务提交 upload/artifact、收据、outbox 才能报告业务成功。
2. **PUT timeout/socket reset/5xx/409，或PUT成功后的校验GET中断**：保留本次候选key，只对这个key在原绑定执行HEAD（定位/大小预筛）和实际GET；HEAD不能证明内容。结果不明的本次写入，只有候选对象字节全部匹配才可返回原候选StoredBlob。**不自动重PUT，不生成第二个key。** 明确收到412表示本次条件写未创建对象，即使GET发现相同bytes也拒绝，拟报`blob_key_conflict`（503）；不能在普通put中采纳已有身份或把碰撞变成去重。维护import对已存在key的显式采纳仅限第6节受控迁移。
3. **回查缺失/403/超时/不可验证**：不把 404 当“绝对未写入”，不把 403 当缺失。抛拟错误 `blob_write_outcome_unknown`（503），本次业务事务被回滚；若原 rejected 收据已持久化，它只证明“没有 upload/artifact/outbox 成功事实”，**不证明远端没有孤立字节**。保留结构化安全诊断（storeId、候选 key、错误类别、时间及供应商 requestId），不存文件内容/签名/凭据，不新增业务成功事件。
4. **API 在 put 后、SQL 提交前崩溃**：可能留下孤立对象；没有自动清理、重放或补建 Artifact。按原 commandId 查收据；进程崩溃后候选 key 是否可从安全运维记录定位，不能影响“不从桶枚举猜业务成功”的原则。
5. **SQL 已提交但 HTTP 响应丢失**：浏览器现有 journal 只 GET 原收据；有 committed 才采用原 upload/新 artifact ID；同 commandId 同参数重复调用由 kernel 返回原收据，不再次访问 put。
6. **无原收据**：仍可能处于原事务执行/提交未知；不得凭收据 404 换 commandId 重传。先由运维确认原进程/事务已终结并查明未提交，调用方才可显式创建新动作；原物理对象即使存在也保持孤立。没有跨崩溃自动恢复对象写入的承诺。

其他错误保持既有 `upload_too_large` 413、`invalid_blob_key` 400、`blob_integrity_error` 503、`blob_read_failed` 503；拟增加 `blob_provider_disabled / blob_storage_binding_mismatch / blob_storage_unavailable` 503。已授权且 SQL 存在的版本若对象缺失返回 503 存储错误，不映射为业务 404；未授权版本继续先由应用返回隐藏存在性的 401/403/404，不出 S3 请求。

### 4.3 健康与 UI

| 状态 | `/health/live` | `/health/ready` 存储检查 | capabilities / 业务行为 |
| --- | --- | --- | --- |
| 未配置 S3、默认 local | 200 | 检查真实 Local，满足其余条件才200 | 只表示现有 local 存储能力；无 S3 ready 声明 |
| 显式 disabled | 200 | storage=false、总体503 | storage.enabled=false；业务 put/read 明确503，不返回空 Buffer/假对象 |
| s3 配置结构不完整/无效 | 不启动该错误配置进程 | 无就绪声明 | 安全配置错误；不能自动切回 Local |
| s3 绑定不符/桶不可达/凭据失效 | 200（配置结构合法时保留诊断进程） | storage=false、总体503 | 没有 storage ready；业务请求真实失败。网络恢复后只对相同绑定 check，成功才恢复 |
| s3 检查通过 | 200 | storage=true；DB/core/Worker/失败隔离同时满足才200 | 仍不证明供应商 SLA、备份或多实例就绪 |

保持现有 `Capabilities.storage={enabled:boolean}` 外形：enabled 表示已配置且非 disabled，不表示网络健康；不增加会泄露桶/endpoint 的匿名诊断。健康检查各依赖分别处理，S3失败不遮蔽真实 Worker/core 检查。文件入口沿用 [Files](../../apps/web/src/features/pm/service/project-files/index.tsx) 的能力禁用、真实错误、unknown 原请求恢复和 [预览](../../apps/web/src/features/pm/service/project-files/FileContentPreview.tsx) 的授权字节校验；不能因为 capability=true 展示“已连接S3”，也不能让禁用/故障回退样例。无需新建 provider 管理 UI 或配置凭据表单。

## 5. 权限、桶私有性与外部上线门禁

### 5.1 身份和最小权限

| 身份 | 允许 | 禁止 |
| --- | --- | --- |
| 浏览器/普通 PM 用户 | PM 会话授权后的命令和版本内容 API；每次下载重新查当前 domain.read/项目范围 | S3 身份、桶列表、直接对象 URL、签名 GET/PUT、选择目标桶、以 objectKey 绕过版本授权 |
| API 存储身份 | 精确 `<bucket>/<prefix>/objects/*` 的 GetObject/PutObject（含 HEAD 授权）；`_pm/store.json` 只读；`_pm/health/write-probe` 的 Get/Put。AWS owner guard 用于支持的每次桶/对象请求 | ListAllMyBuckets、CreateBucket、DeleteObject/DeleteObjectVersion、PutObjectAcl、改 bucket policy/lifecycle、业务对象无条件覆盖；不授予其他 bucket/prefix |
| 现有 Worker/migrate/Web | 各自原 DB、SMTP或静态职责 | 不注入 S3 凭据、不挂载 S3秘密、不为Blob执行外联；migrate 不联网自动初始化桶 |
| 显式备份身份 | 从 dump 引用的对象 Get；若执行受限 inventory，ListBucket 仅允许批准前缀；写受控备份目标 | 修改源业务对象、删除源对象、访问未批准桶 |
| 显式迁移/恢复身份 | 停写窗口中对指定源只读、目标条件 Put 和 marker 初始化；受控 DB binding 更新 | 运行中路由切换、覆盖冲突对象、跨桶任意复制、放宽约束、向应用发放该管理身份 |
| 桶安全管理员 | 在独立运维流程预建私有桶，核验 policy/ACL/加密/生命周期和目标身份 | 不通过 PM 用户界面管理云凭据；不能把管理身份当 API 最小权限验收 |

AWS 上可将业务对象 `PutObject` 限制为必须 `If-None-Match:*`，探针限定独立前缀允许覆盖；兼容供应商必须证明等价约束或记录不能由 bucket policy 强制的边界。条件写不保护拥有管理员权限的外部篡改，因此仍需应用读取校验，且 API身份无删除权限。KMS 模式只给目标 key 所需 GenerateDataKey/Decrypt，并同时收紧 key policy；无跨账号广泛 decrypt。

### 5.2 私有性不能仅由成功 HEAD 推断

- 预生产由桶管理员提供脱敏配置证据：AWS Block Public Access 全开、BucketOwnerEnforced/ACL关闭、无公共 bucket/access-point policy、无 website/CDN公开入口、批准的加密与非过期生命周期；兼容供应商提供对应真实配置。API 不需要取得改 policy 的权限，也不声称仅凭自己的 Get 成功证明整桶私有。
- 在独立无凭据 HTTP 客户端对已存在探针、真实测试业务对象、桶/前缀列表请求必须拒绝访问；403或策略隐藏型404可接受，200/列举内容是失败，网络错误不是“私有性通过”。对其他 prefix/bucket 用 API 身份实际拒绝。
- 无凭据探针检查加管理员 policy 复核是供应商上线门禁，不伪装为完全跨供应商通用的运行时审计能力。后续 policy 改动必须重验，readiness 只证明当前绑定下有界读写可用，不证明所有历史对象/ACL无误。
- HTTPS/TLS证书真实校验；不关闭 TLS、日志脱敏或审计来“接通”。只有隔离 loopback MinIO 的合成数据测试可例外 HTTP；该结果不算供应商生产加密/TLS通过。

AWS 一手语义参考：[条件写入及 409/412](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)、[expected bucket owner](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucket-owner-condition.html)、[读后写一致性与私有访问模型](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel)。这些说明不自动证明任意“S3兼容”供应商具有相同行为；SDK 对409建议重试也不覆盖本计划的 unknown 先核对规则。

## 6. 旧 key 的模式迁移：停写、全量验证、单路切换

### 6.1 拟持久绑定：避免错 provider 静默 404 或跨桶误读

现有 upload/artifact_version 只保存裸 `objectKey`，不包含 provider/bucket。若仅修改环境开关，所有旧 key 会被解释成新桶地址；即使另一桶恰好存在相同 key/SHA，也不能证明是本部署应读的对象。因此不采用“缺了再去 Local找”的永久 dual-read。

拟新增 schema 级单行 `blob_storage_binding`（迁移编号由集成 owner 分配）：

| 字段 | 拟约束 |
| --- | --- |
| `singleton` | 主键且只能为 true，一个应用 schema 一条活动绑定 |
| `store_id` | 维护流程随机 UUID，必须匹配存储 marker，不能从 bucket 名推导 |
| `provider` | `local / s3`；disabled 是运行禁用态，不覆盖历史绑定 |
| `locator_sha256` | 对规范化 Local绝对root，或 S3 endpoint/region/bucket/prefix/path-style/expected-owner 的非秘密 locator 序列化摘要；不包括凭据或可轮换秘密 |
| `epoch` | 正整数 CAS版本；改绑定或迁移冻结/恢复必须比较原 epoch |
| `state` | `active / migrating`；migrating 时API存储读写不就绪 |
| `verified_manifest_sha256`、`verified_at` | 上一次完整引用核验的清单摘要/时间；不是持续完整性保证 |

拟存储 marker：Local 根下 `.pm-store.json`，或 S3 `<prefix>/_pm/store.json`，含格式版本、storeId、provider、locator摘要；由受控 bind/import 初始化且不可覆盖。API只读 marker/DB binding，相同四方法的运行期不能创建绑定。绑定存在但 marker 缺失、反之、locator不符、migrating、DB不可达，全部 fail closed。没有 binding 的空新库先执行显式 `bind --new`，有历史引用的旧库先执行 `bind --adopt` 的离线核验；不能自动把任何新建空目录认作旧库内容。

SQL业务数据、命令收据中的历史裸 key不改写；存储绑定是部署级路由事实，不是第二份 Files/任务事实源。API应用身份仅有 binding 读取权限，初始化/迁移由维护身份写；测试 schema自有 owner 可以初始化夹具。现有通用 DB owner 不自动等同已经实现此角色隔离，部署步骤必须落实相应 grants。

### 6.2 拟维护入口与输入输出

实施时新增单个维护入口 `scripts/blob-storage.ts`，配套维护逻辑在infrastructure，而不扩展业务BlobStore接口。拟子命令：`bind --new|--adopt`、`inventory`、`migrate`、`verify`、`activate`、`restore-rebind`；接受明确source/target的非秘密配置描述文件位置与原epoch/清单SHA，凭据仅从独立秘密注入读取；拒绝隐式源/目标、相同locator、非空未批准目标和无停写确认的activate。维护配置描述不包含凭据。

- 输出权限受限 JSON manifest/journal：格式版本、迁移ID、源/目标storeId与locator摘要、原binding epoch、DB dump摘要、core清单摘要、每个 key 的SHA/size/引用计数、验证结果、失败分类、切换状态；不含URL签名/原文件内容/密钥。
- inventory 从停写数据库的 **所有 upload（含已消费和已过期）及 artifact_version** 提取 objectKey，按key合并并检查所有 SHA/size/contentDigest 一致；cover/Evidence/Submission通过引用的版本闭合。过期 upload 未删除仍是持久元数据引用，不能漏备份或因TTL过滤。历史收据中的相同引用必须被保留；数据库若存在坏引用或其他持久 blob引用则纳入清单或停止，不能忽略。
- source 每项实际 read校验，target 每项条件写且保持**原 key**，再实际 read核验；已有目标 key只有字节/SHA/size完全一致才可在显式迁移恢复中采纳，否则硬失败。维护用内部 `importVerifiedObject(key,bytes)`/等价实现，不把保留key写入口暴露给应用，也不能调用普通 put后重写不可变SQL版本。没有新增 `copy` 方法。
- 迁移 journal 按原迁移ID续作：先核对 source/target/epoch/清单完全相同，再对已有目标逐项read，缺失项才显式条件import。对 unknown 写入先查原目标key；不可验证时保留失败，不自动跑到另一桶或开始另一次迁移。

### 6.3 切换操作顺序

1. 独立目标先用合成数据完成供应商矩阵，确认 bucket私有、读写/条件语义、权限、加密、恢复入口；不拿现有业务目录作验收夹具。
2. 维护窗口阻断新请求，停**本项目**API/Worker并核对退出；阻止外部 Markdown写入者。操作对象必须先核对PID/容器ID/cwd/归属，不能停其他项目。S3不能改变单API停写要求。
3. 记录原镜像/配置、binding epoch、原收据/对象ID及原SQL/core/blob备份集；完整备份且先完成新资源恢复验证。对无binding旧库以 Local原路径 adopt，逐key核验后建立原marker与binding；不迁移编号抢号。
4. CAS把原binding置migrating；形成冻结的SQL/core/所有blob引用清单。对每个key从源真实读取后条件导入私有新桶/新前缀，逐项比对。所有引用必须100%通过，不以样本或HEAD代替；未引用孤立对象不为业务恢复必需，如保留其副本应单列 inventory，绝不删除源。
5. 新目标生成自身新storeId/marker，清单和marker对齐；只在源仍停写、原epoch匹配、清单100%验证后，由维护身份一个SQL事务将provider/locator/storeId切为目标、epoch递增、state=active。保留不可变迁移报告；不改变entity/receipt/outbox的业务内容。
6. 切换私有配置并只启动新单API/Worker；临时受限Web路径先检查ready、原收据、历史/当前版本下载SHA、cover/Evidence，再开放新写入。原API不得重叠启动；不是同时写两处后观察“哪边有”。
7. 恢复写入后立即形成目标模式新备份集并恢复到新库/新桶验证。源保持离线只读，不是常驻fallback；后续源保留/销毁须另经运维/保留决策，不在此包物理删除。

### 6.4 前向/回退规则

| 故障点 | 允许动作 | 禁止动作 |
| --- | --- | --- |
| 复制或验证未完成，尚未activate | 源无新业务写；保留目标/journal，修复后续作，或CAS将原binding恢复active并恢复原配置 | 部分复制就启动S3；删除源；改SQL版本key来迁就缺对象 |
| activate后、尚未恢复任何业务写 | 再停全部自有进程；核对无新事实/引用后CAS绑定回原store、epoch递增并验证原配置 | 只改.env不改binding；让旧API与新API交叠 |
| 目标已接受任何新业务写 | 优先修复目标前向恢复；如必须回Local/另一个S3，重新停写，将**当前DB全部引用**迁移到新目标并完整验证，再CAS切换 | 回指旧Local并丢掉切换后的key；直接回滚旧数据库/旧core快照；永远dual-read掩盖缺失 |
| DB binding已提交但维护进程丢响应 | 读取原epoch/storeId/manifest与迁移journal，判定切换事实 | 再次activate或猜旧配置仍有效 |
| 目标桶/marker不符或临时不可达 | live可用、ready503；同一绑定修复网络/权限后复核 | 静默跨桶查找、空目录兜底、把对象503变404 |

## 7. 备份与新库/新桶恢复

- 改造现有 [backup.mjs](../../scripts/backup.mjs) 时保留它对专用本机PG和public schema的安全范围限制，不趁S3扩为任意DATABASE_URL管理工具。应用Compose的 scoped pg_dump/new volumes步骤仍按 [部署手册](../../deploy/README.md)独立执行；二者复用 provider感知内容导出/导入/校验，不假装目录脚本能直接访问容器卷。
- 一致备份必须停API/Worker及外部core写入者。SQL dump为基线，再从该dump恢复的隔离临时库提取完整引用集合并逐key导出实际bytes；core/config/views/.pm/state同窗口归档，排除cache。清单记录镜像/迁移摘要、binding/storeId/locator摘要、SQL/core/blob摘要、备份集ID与时间，不含秘密。
- S3不再readdir/copy本地BLOB_ROOT；通过配置factory的read读取准确引用对象。归档保存可携带的裸key+bytes+SHA/size，0700/0600；也可按已批准目标写私有独立备份桶，但必须与源故障域/授权分离，不能只保存原桶URL。bucket versioning、replication和HEAD列表不等于已完成备份。
- 恢复仅使用**新数据库、新core根/卷、新桶或新独占前缀**。保留原dump；先校验归档manifest、恢复SQL与全部约束，按需使用现有pre-0024项目审计恢复规则，不关闭CHECK/触发器。恢复core状态并重建cache，条件import保持每个原key，不用普通put生成新key。
- 新恢复目标必须使用新storeId/marker；数据库里恢复出的旧binding不能直接指向新桶，也不能原样复制旧marker欺骗绑定。显式restore-rebind操作保留原binding/备份来源，比较旧epoch并核验全部引用和core manifest后更新目标binding；这是部署恢复元数据变更，不修改历史ArtifactVersion/收据/审核。
- 以隔离端口启动一个API与其Worker，核验原实体/收据、所有对象SHA/大小和不可变关系、core状态、真实登录/SSE，以及新暂存→登记→下载。仅摘要检查不等于真实HTTP恢复；新假对象不能替代原对象。成功后才停写切换；原业务库、源桶不覆盖。
- 部分blob丢失/损坏、解密失败、binding不符、缺`.pm/state`、约束失败均终止恢复就绪；有明确失败清单。未恢复写入可切回未变旧部署；新恢复部署已写入后必须按第6.4节前向/完整反向迁移，不以“回退”丢失新收据和新对象。

## 8. 稳定实施步骤与文件责任

本包负责 S 前缀；下表保留批准的工作分解，实际落地和待集成/验证边界见第 10 节。迁移固定为 `0028_blob_storage_binding.sql`；schema、runtime/app/registry、根依赖、备份入口与 deploy 由集成 owner 唯一接线。

| 步骤 | 前置 | 文件责任与实施内容 | 退出条件/交接 |
| --- | --- | --- | --- |
| **S01 冻结provider和配置合同** | 本规划 | 实际独立入口 `blob-storage-config.ts`，不经 Worker 的 runtimeConfig 读取 S3；`blobs.ts`复用key规则，保持四方法；最终SDK固定 `@aws-sdk/client-s3@3.1155.0`（owner按24h供应链年龄策略替换初次请求的3.1156.0，不放宽策略），根依赖/lock归owner | 默认Local无S3要求、显式disabled、错误配置不降级；构造无网络；LSP不可用时已用目标搜索列出所有caller并交接 |
| **S02 实现真实S3适配器** | S01 | `s3-blobs.ts`与`blob-storage-provider.ts`：SDK SigV4、单次条件Put、checksum、有界Get、unknown原key回查、连接释放、固定探针；保留Local symlink/fsync | 实现无copy/delete、签名URL、无界缓冲、自动重Put；真实协议矩阵待owner运行 |
| **S03 建立部署绑定和离线维护** | S01 | `0028_blob_storage_binding.sql`、`blob-storage-binding.ts`、`blob-storage-inventory.ts`、`blob-storage-maintenance.ts`及`scripts/blob-storage.ts`实现marker/全部引用/原key导入/journal/epochCAS | 显式new/adopt、错root/prefix、partial import和恢复路径有专项测试；未实际运行不称通过 |
| **S04 切换应用抽象与健康** | S02、S03；与Files约定read+put | `registry.ts`去Local具体类型；`app.ts/main.ts`改blobStore注入及存储绑定/健康；`config.ts`只保留HOST/PORT；迁移所有buildApp调用fixture及合同生成/测试引用 | 业务下载/cover仍走相同authorization+read；合法配置不可达可live/ready503并在原绑定恢复；不新增Files业务命令 |
| **S05 补齐备份与恢复工具** | S02、S03 | `scripts/backup.mjs`复用provider感知内容导出/完整引用校验；新增维护入口处理new store restore-rebind；保留本机PG限制，说明Compose独立路径 | 同备份集SQL/core/所有upload和version齐全；真实新库/新桶恢复及错误拒绝路径可执行 |
| **S06 接入部署与操作说明** | S04、S05 | `deploy/compose.app.yaml`拆S3秘密作用域，API外联/目标配置，Local卷按模式使用且保留core卷；Dockerfile不注入S3秘密；`deploy/README.md`、infrastructure README、当前实现记录更新 | Worker/Web/migrate无S3身份；停写无重叠切换/回退规则有操作序列；未配置不声称S3上线 |
| **S07 建立真实验收矩阵** | S04–S06；Files复制实现已集成时验证该分支 | 保留`blobs.test.ts`；拟`s3-blobs.integration.test.ts`、storage配置/绑定测试；扩delivery/cover/HTTP/恢复夹具；不改现有业务期待使其绕过错误 | 完成第9节中的Local、隔离MinIO、供应商分列证据；缺配置的供应商项显式未执行而非skip通过 |
| **S08 集成owner统一检查和上线门禁** | 所有S步骤及其他包合并 | owner一次执行统一文档/合同/lint/types/build和真实DB/storage/browser/restore验收；更新本规划的实施状态与真实证据索引 | 检查与现场环境分别记录；仅通过的目标provider可启用，不以MinIO代供应商、健康代恢复、S3代HA |

S03/S06 同时覆盖默认 Local 的安装升级路径：本地初始化／bootstrap 操作说明及部署启动顺序必须显式安排空库 `bind --new` 或旧库离线 `bind --adopt`，再启动业务 API；不得让正常启动静默认领目录或把新增绑定要求留成默认 Local 的启动回归。实际入口脚本由实施时收齐调用者后修改，并将全新安装、旧 Local 升级、恢复到新 root 三条路径纳入 S07。

可并行边界：S02和S03可在S01固定输入/输出后独立实施；S05的引用导出可在维护合同固定后进行，S04必须等抽象/绑定落地。Files可先以Local实现read+put，S04后只换注入、S07增加S3同行为验收。其余通知/找回/Webhook不依赖S3，也不能共享本包存储身份。API/registry/runtime-config/迁移/根依赖/deploy属于共享集成热点，由owner分配唯一编辑者，不由多个包各自改一次。

## 9. 可执行的隔离验收矩阵

### 9.1 资源与执行方法

后续集成owner创建唯一测试运行ID：独立PG schema或新恢复DB、临时core/Local根、独立MinIO进程或容器和卷、loopback动态端口、私有测试桶/前缀、API最小权限身份及分离管理员身份、临时Web/API/Worker。不得使用默认业务schema/桶/端口或读取现有凭据。测试凭据只供隔离资源私密注入，不写命令行/公开证据。只清理此运行ID拥有的进程/容器/卷/桶，不全局prune或停其他服务。

新增测试使用现有Node test和真实HTTP/PG模式；可由测试harness创建有归属的HTTP故障代理，真实转发S3请求后截断响应/中断流，不mock成功。测试所需的固定key碰撞注入仅在测试构造依赖中控制随机源，不新增公开绕过接口。由owner实施后运行既有`pnpm check`、`pnpm test:backend`，有前端改动才运行`pnpm check:web`；新增S3测试入口应明确资源配置且在要求该provider的验收批次中缺配置即失败，不把skip算通过。本轮规划没有执行这些命令。

| 场景 | Local | 隔离MinIO（真实S3协议） | 真实目标供应商 | 通过证据 |
| --- | --- | --- | --- | --- |
| 配置/禁用/不可达 | 原默认+disabled | 漏bucket/凭据、非法endpoint、断开网络、权限拒绝、恢复同绑定 | 区域/endpoint/owner错误、证书错误、凭据到期和轮换 | 无隐式Local fallback；live/ready/capability按表区分；原绑定恢复 |
| 字节/边界/身份 | 保留原测试 | 0、1、8MiB、8MiB+1；两次相同内容不同key；并发20次、进程重启读 | 同一矩阵至少重复关键边界/重启 | 每项SHA/size/实际bytes一致；超限在发送前拒绝；没有业务对象覆盖 |
| 不可变条件写 | hard-link不覆盖 | 固定候选key碰撞、同时条件Put、412/409，测实际header与源对象未变 | 确认供应商未忽略If-None-Match/checksum | 冲突不被无条件Put替代；只查原key；SDK未多发PUT |
| 读取安全/资源边界 | traversal/symlink/大小变化 | 非法key无网络；伪造ContentLength、断流、超大流、篡改bytes、伪ETag/SHAmetadata | 真实对象管理员篡改与缺失 | 503完整性/存储错误，内存/流有界，无下载成功/Submission/成功outbox |
| 私有性/身份权限 | 文件0700/0600检查 | 无凭据GET/list拒绝；API跨prefix/bucket拒绝；Delete/ACL写拒绝 | 管理员脱敏policy/ACL/加密证据+真实匿名访问拒绝 | 200或网络故障不计“私有通过”；AWS expected-owner错误真实拒绝 |
| 应用授权/CAS | 既有delivery/HTTP | owner/reader/无权项目、上传owner/TTL/单次消费、旧expectedVersions、撤权后下载 | 真实目标重复授权关键分支 | 无权时不GET对象；撤权后新API请求拒绝；旧ArtifactVersion/Evidence不变 |
| PUT响应丢失 | 原本地崩溃窗口 | 故障代理转发PUT落对象后丢200；原keyGET确认后只有一次业务提交；GET也断则rejected且可有孤立对象 | 在批准测试环境做同一故障代理 | PUT次数、原key/原commandId、SQL upload/artifact/outbox数量；unknown未自动重放 |
| 提交/进程崩溃 | 原有HTTP收据恢复 | put完成后SQL前杀自有API；SQL commit后截断HTTP；重启原收据核对 | 批准窗口重复关键边界 | 前者孤立保留、无假成功；后者原ID/原收据、一个对象引用，不重上传 |
| Files复制/cover | Local read+put | 选旧版本复制、新对象独立；SQL回滚孤立保留；封面真实字节校验 | 相同业务HTTP/browser路径 | 新artifact/version/key，来源准确；不复制Review/Evidence身份，不走CopyObject/签名URL |
| 模式迁移/错桶防护 | 原Local adopt | Local→新MinIO桶、错provider/错prefix/同名不同marker；中断后原journal续作；未100%不能activate | Local或验收桶→目标测试桶 | 全引用清单100%、epochCAS、历史key不变；无静默404/跨桶读取/永久dual-read |
| 备份/恢复/回退 | 新DB+新Local/core根 | 新DB+新桶+新core卷，含已过期upload/历史版本；坏blob/缺state/约束错误拒绝；写前回退和写后前向 | 批准备份目标/密钥恢复和新桶恢复 | 原收据/审核/版本/全部SHA/core状态一致；写后新key不丢，失败不报告ready |
| 无长期直链 | 浏览器原下载 | Files预览、下载、图片封面、复制链接、StageUpload未知恢复 | 实际目标下浏览器复验 | 网络仅授权API内容；无S3 credential/GET签名/redirect；撤权后不发新内容请求 |

### 9.2 上线退出门槛与证据缺口

必须同时满足：S01–S08工程交付、无业务合同漂移、绑定/停写迁移100%验证、最小权限/私有性/加密证据、供应商条件写与实际GET矩阵、新库新桶恢复演练、原对象/原收据HTTP与浏览器复核，以及批准的备份/恢复责任人和维护窗口。外部凭据、桶、供应商、加密策略和RPO/RTO当前未提供，**因此不得宣称目标供应商或生产 S3 就绪**；这不是跳过可实现适配器/维护/恢复代码的理由。

实现代理首轮交付证据为源码、迁移、专项测试/真实协议夹具、维护命令和 caller 静态枚举。后续按 owner 明确指派进行了第 10.3 节的新隔离 MinIO SDK 操作级诊断；没有读取 `.env/access.json` 或已有凭据，没有运行全套 tests/build/lint/formatter、业务服务、部署或用户数据迁移。owner须补记统一检查及实际HTTP/browser/restore结果；不能沿用旧批次通过或把未配置skip计为S3验收。

## 10. 本次实际实现与集成交接

| 范围 | 实际路径/合同 | 实现/验证边界 |
| --- | --- | --- |
| 配置与factory | `packages/infrastructure/src/blob-storage-config.ts`、`blob-storage-provider.ts`、`blob-storage-admin.ts` | 严格provider、显式成对凭据、origin/region/bucket/prefix/owner/加密校验；HTTP只准显式loopback且真实DNS结果必须loopback；locator不含秘密；构造不IO |
| Local/S3数据操作 | `blobs.ts`、`s3-blobs.ts` | Local既有目录句柄/fsync/不覆盖发布保留；S3单条件PUT+实际GET，8MiB真实bytes，unknown只原候选HEAD/GET；412不采纳；API数据端口仍四方法 |
| 绑定与维护 | `blob-storage-binding.ts`、`blob-storage-inventory.ts`、`blob-storage-maintenance.ts`、`blob-storage-sql-checkpoint.ts`、`blob-storage-schema.ts`及迁移`0028` | DB单活动绑定、marker、首次epoch固定；维护history不可变；显式new/adopt；全部SQL事实摘要+原rollbackId保护写前回退；migrate/verify/activate/resume-source/restore-rebind完整实现；namespace未批准/原引用或事实改变/坏对象均终止 |
| 可携带备份 | `blob-storage-backup.ts`、`blob-storage-checkpoint.ts` | 从同停写dump隔离恢复库提取所有持久JSON引用并导出真实bytes；全量核验、原key条件import、新storeId/epoch恢复；core规范清单要求真实`.pm/state/config`、拒绝symlink、只排cache。入口的PG安全范围/真实dump恢复/HTTP恢复归owner |
| 维护CLI | `scripts/blob-storage.ts` | `bind --new/--adopt`、inventory、migrate、verify、activate（含`--resume-source`）、import、restore-rebind；源/目标描述文件不含秘密，身份从独立SOURCE_/TARGET_环境注入；原journal先持久再冻结，0600+原子rename/fsync |
| 测试/故障夹具 | `packages/infrastructure/tests/blob-storage-config.test.ts`、`blob-storage-binding.test.ts`、`blob-storage-checkpoint.test.ts`、`tests/s3-storage-fixture.ts`、`tests/s3-blobs.integration.test.ts`，保留原`blobs.test.ts` | Local显式初始化/adopt、坏内容/错marker/epoch、部分迁移续作、写前回退/新事实拒绝、原key新库恢复、core缺state/篡改/symlink；自有MinIO真实条件写/未知PUT/断GET/大小边界/错prefix；尚未运行 |
| 操作说明 | `packages/infrastructure/README.md` | 实际可运行参数、默认Local新装/离线升级/新root恢复、停写/前向迁移/备份责任和专用测试命令 |

### 10.1 共享接口

- `readBlobStoreConfig(env): BlobStoreConfig`、`blobStorageLocator(config): BlobStorageLocator|null`、`createBlobStore(config): BlobStorageProvider`；API/维护直接引入独立模块，Worker不读S3。
- `bindBlobStore(pool,locator,provider): BlobStore`；`buildApp`注入`blobStore + blobStorageLocator`，有DB才包装/检查。无DB bootstrap不IO；disabled原样拒绝。不保留blobRoot应用别名；registry只收BlobStore。onClose调用provider.close释放SDK连接。guard的独立只读pool预算由owner接线，避免命令持有业务pool client时嵌套借连接饥饿。
- `bindStorage({pool,provider,locator,mode:'new'|'adopt',stopped:true,...})`是显式离线初始化；fixture先bindnew再listen，restart复用原绑定root；不得在普通API启动认领目录。
- `exportBlobBackup / verifyBlobBackup / importBlobBackup / restoreBlobBackup`为provider感知模块。导出pool必须来自本备份dump的隔离恢复库；目录必须尚不存在；调用者传真实dump SHA及规范core SHA。恢复由调用者固定保存新的targetStoreId/operationId，原epoch CAS，绝不改历史key/收据/业务实体。
- `restoreRebindStorage` 仅在停写恢复出的新目标数据库事务内、binding 激活前调用共享 `fenceRestoredServices(sql)`；失败与新binding一起回滚。CLI与备份恢复同路，源库/普通迁移不调用。原restore操作已提交的恢复分支提前返回，不对新会话二次fence。专项测试覆盖恢复目标旧session清除、源session不变与原操作查询不清后来会话。

### 10.2 Caller 与验证交接

本会话工具没有LSP references入口；已用目标搜索完整枚举导出引用并交给owner：生产`app.ts/main.ts/registry.ts`；Worker独立runtimeConfig；静态`generate-contracts.ts`与合同openapi测试的Local构造保持无IO；delivery/project-extras纯适配器测试不加应用绑定。DB buildApp caller为`tests/backend.integration.test.ts`、`dashboard-fixture.ts`、`member-invitations-fixture.ts`、`core-creation.integration.test.ts`、`dashboard-time.integration.test.ts`、`worker-process.integration.test.ts`；前两类restart旧用新空root，必须迁移为原绑定root而非绕过门禁。无DB bootstrap/client/openapi调用不需要资源。

owner统一运行既有检查，并以独立PG schema/临时root/自有MinIO/临时HTTP和浏览器验证真实changed path。专用命令为`PM_REQUIRE_S3_TESTS=true PM_S3_TEST_MINIO_BINARY=/approved/path/to/minio node --test tests/s3-blobs.integration.test.ts`；缺真实fixture或PG即失败。夹具只生成/清理自己的随机桶和进程。其管理员协议身份不等于最小权限API身份，隔离HTTP不等于生产TLS/静态加密。

仍须用户/运维提供而本包不虚构的决定：供应商/区域/私有桶/独占前缀/endpoint/网络与身份注入；数据驻留/批准加密/KMS恢复责任；维护窗口/备份位置和保留期/RPO/RTO/切换授权人。保留期和GC、多实例核心写入仍不在本包。统一检查/实际HTTP恢复/浏览器/供应商验收未运行部分不能标记完成。


### 10.3 隔离 MinIO 诊断、原故障根因与证据边界

owner 报告真实浏览器 smoke 在业务用户创建前的 S3 bind 阶段失败；未重跑该 smoke。经授权，用新建、自有临时 MinIO进程/目录/随机凭据/随机桶做SDK操作级诊断，日志只保留操作名、error.name、HTTP status等无内容元数据，不打印SDK原始错误、签名、凭据或正文。

- 实际捕获：MinIO `RELEASE.2025-09-07T16-13-09Z` 的 `/minio/health/ready` 已返回200，但紧接的真实S3 `CreateBucket` 返回 `XMinioServerNotInitialized / 503`；HTTP健康并非对象层初始化完成证明。
- 修正 `tests/s3-storage-fixture.ts`：仅对夹具自己启动的MinIO，先以带认证的 `HeadBucket` 读取尚不存在的随机目标桶；只有明确404才越过初始化屏障，有限等待初始化503/启动连接错误；之后只执行一次CreateBucket。没有重试任何未知写，没有降低生产adapter的2秒readiness、条件写、checksum或unknown规则。
- 操作级观察：精确checksum PUT/GET分别200、provider.check的PUT/GET分别200；修正后 marker路径捕获缺marker的 `NoSuchKey / 404`，namespace list200、条件marker PUT200、marker GET200，缺失分类正常。
- 每次诊断只清理其自有MinIO/随机桶/临时目录；一次性诊断脚本已删除，未改父层 `.local` 浏览器smoke/backup入口。原smoke是否还有其他失败原因由owner复验，不能把这些操作级结果称为全套或浏览器验收通过。
- 后续按owner要求，另用自有PG16容器/随机schema执行完整真实 `migrate → s3StorageFixture → createBlobStore → bindStorage(mode:new)`，SDK序列为HeadBucket404、CreateBucket200、probe PUT200/GET200、List200、缺marker GET404、条件marker PUT200/GET200，SQL bind提交成功。另新增 `tests/s3-blobs.integration.test.ts` 的空S3首次绑定端到端回归，断言业务用户0、binding提交及受保护put/read；此新增test尚未运行，交owner统一复验。
- **原浏览器smoke根因由owner安全middleware实际定位**：explicit-bind 的首个PutObject返回 **`XMinioStorageFull / HTTP507`**，adapter正确映射`blob_storage_unavailable / 503`。初始化屏障没有解决这个独立空间不足故障；生产SDK/条件写/checksum/绑定逻辑不据此改动，也不降低MinIO空间保护阈值。owner负责把本轮验收TMPDIR改到有足够空间的自有临时目录后复验；不得把上述隔离bind成功当原smoke通过。


### 10.4 备份恢复专项夹具合同修正与真实调用诊断

owner报告provider backup用例失败，但整套被停止后没有该用例完整stack；其余binding/adopt/migrate/rollback/checkpoint已由owner观察通过。源码确定：该用例独有的已消费历史fixture直接插入artifact时遗漏Files迁移0025规定必需的`hiddenAt/hiddenBy`，违反`artifact_metadata_valid`，在真正备份前即可能失败。只修正自有`blob-storage-binding.test.ts` helper，按正式Files合同写入两个null字段；未删除/放宽SQL约束、恢复fence或授权。

经owner明确授权，使用给定隔离PostgreSQL的两个新随机schema和数据盘`.local/pm-five-712e-tmp`下自有目录，执行分阶段真实调用（非重跑整套test）：真实已消费/已过期upload + ArtifactVersion → 约束保持开启的独立schema复制 → provider export/verify → 原key import + target-only `fenceRestoredServices` + restore-rebind → 身份/内容/unknown恢复核对。实际完成：epoch1→2、新storeId；所有已消费/过期引用保留；旧target session拒绝、source session仍有效；新target session在原operationId恢复后仍有效；原key字节一致；坏归档拒绝。输出为`restore-diagnostic-completed`，耗时4.87s；源binding不变。新schema/目录和一次性诊断脚本均已清理，未触及浏览器source库或现有凭据。

此证据不等同父层真实S3源的`backup.mjs --verify --stopped`、pg_dump/pg_restore或浏览器恢复通过；这些仍由owner验证。未中途运行全套lint/build/test，也未修改生产backup或安全fence来迁就测试。


### 10.5 集成后的真实验收与修复

- 统一真实数据库回归启用 `PM_REQUIRE_S3_TESTS=true`，S3 用例实际使用自有 MinIO、未跳过；覆盖条件 PUT/不重试、冲突、原 key 丢响应核对、流/摘要/大小边界、私有匿名拒绝、绑定/迁移/恢复与历史引用。
- 固定 key 的真实412后，MinIO 未声明 close 却关闭 socket，下一 GET 误复用连接。现在错误响应完整消费后退役该 socket，正常连接仍复用；保留单次写尝试、原 key、字节与离线导入边界，未新增 PUT/自动重试。
- 正式 Files 浏览器在真实 S3 完成显示名、软隐藏/恢复及旧版独立复制；授权下载31字节与原版本相同，source/target objectKey 不同。
- 实际 `scripts/backup.mjs --verify --stopped` 从同一停写 dump 提取引用并导出 S3：3对象、9核心文件；恢复到随机新库、新核心副本和新 Local 根，epoch1→2，4核心对象0错误，3份真实授权 HTTP 下载全部通过，匿名均拒绝；源库/归档不被验证 API 修改。
- 默认配置工作区合法缺少 `.pm/config.yaml`，checkpoint 现保留缺省、不补写配置，仍拒绝缺 state/符号链接/内容变化；真实 Workspace 回归先失败后通过。public schema 冲突仅通过清理工具刚创建的新恢复库解决，不作用源库或禁用约束。
- 恢复报告仍未批准旧凭据生产信任，Webhook/通知/身份/邮件围栏只作用目标库。角色隔离、显式编译 storage CLI 和实际 ready/login 已证明；最终检查见[统一交付](service-completion-and-acceptance.zh.md#five-package-delivery)。目标供应商权限/加密、外部备份责任和生产恢复仍需独立演练。
