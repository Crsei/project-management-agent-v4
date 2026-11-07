# 桌面发布对照与 Windows 测试交付设计

本页先于本次发布实现编写；描述只读调查、采用决定和待执行验收，不是通过报告。当前交付范围为本项目 **Windows x64 unsigned NSIS 测试安装包**；配置不会自动触发构建或发布。操作者随后明确授权由唯一交付执行者在集成冻结/必要门禁通过后，将精确变更直接 commit 到 `main`、push `origin main`，并手动执行 Windows-only unsigned Actions 和下载本轮 artifact；不是已经执行成功的声明。GitHub 正式 Release、tag、签名配置保持未授权、未执行。现有 macOS 原生目标保留，但本次不自动扩建平台。

## 来源身份与实际发布快照

只读 checkout 的 origin 为 `https://github.com/pingdotgg/t3code.git`，完整 HEAD 为 `d53873b6a4799e87afd63c8d288ef0089f5a3748`。对照该提交的 [release.yml](https://github.com/pingdotgg/t3code/blob/d53873b6a4799e87afd63c8d288ef0089f5a3748/.github/workflows/release.yml)、[release-desktop.yml](https://github.com/pingdotgg/t3code/blob/d53873b6a4799e87afd63c8d288ef0089f5a3748/.github/workflows/release-desktop.yml)、`scripts/build-desktop-artifact.ts`、`build-cli-archive.ts`、`verify-windows-desktop-artifact.ts` 及其版本、签名和 updater 配置。未运行来源脚本，未修改来源仓库。它是发布机制研究身份，**不是**本项目现有 Provider 生产 pin `30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c`；没有因研究而升级生产源码。

2026-11-08 通过匿名只读 GitHub API 查询 [latest stable](https://api.github.com/repos/pingdotgg/t3code/releases/latest) 与 [近期 releases](https://api.github.com/repos/pingdotgg/t3code/releases?per_page=8)：

| 渠道 | 实际 tag / 发布时刻 UTC | API target_commitish | 实际 asset 数 |
| --- | --- | --- | --- |
| stable | [v0.1.7](https://github.com/pingdotgg/t3code/releases/tag/v0.1.7)，2026-11-04 06:39:38 | `322f6544dfad0a3c8a0c8cbecf2c7f7874b14268` | 27 |
| 最新观察到的 nightly | [v0.1.8-nightly.20261107.4327](https://github.com/pingdotgg/t3code/releases/tag/v0.1.8-nightly.20261107.4327)，2026-11-07 16:20:41 | `e455200077ce60806a01c8f28435b58860dcfc74` | 28 |

这是观察时刻的可变公开元数据，不是下载后字节验证或签名验收。GitHub 自动提供的 Source code ZIP/tarball 不在 assets 数组内，也不能代表本地修改的对应源码。stable 的 `T3-Code-0.1.7-x64.exe` 为 290,990,320 bytes，API digest `sha256:035785bc80feb0207cdec6205ce0ff2d5ca413ddfcc48085be6dd7cf02cff3cc`；nightly 对应 x64 exe 为 325,456,952 bytes，digest `sha256:f869e76c87f5b82b103dcc7ad87dcc1f6bfef90f1c7fd770728f3ae5342e151b`。没有下载或执行这些上游安装器。

### 实际 assets 与用途

将上表版本记为 `V`，以下是两次 API 返回的完整名称族，不把计划中的产物当成已发布文件：

| 实际名称 | stable / nightly | 用途与本项目决定 |
| --- | --- | --- |
| `T3-Code-V-x64.exe`、`T3-Code-V-arm64.exe` 及各自 `.blockmap` | 两者各 4 个 | 上游 Windows NSIS / 差分更新辅助；本项目只采用现有 native x64 NSIS。无 ARM64 runtime，不跨平台绕过；无 updater，不把 blockmap 当更新能力 |
| `T3-Code-V-{arm64,x64}.dmg`、同架构 `.zip`，各自 `.blockmap` | 两者各 8 个 | macOS 安装镜像、归档及 updater 辅助；保留本项目已有原生 macOS 目标，不在本次 Windows 任务自动构建 |
| `T3-Code-V-{arm64,x86_64}.AppImage`、`T3-Code-V-{amd64,arm64}.deb` | 两者各 4 个 | 上游 Linux 桌面分发；本项目 Linux 仅用于 runtime/smoke，无安装产品，不采用 |
| `t3-V-{darwin-arm64,linux-arm64,linux-x64}.tar.gz`、`t3-V-{win32-arm64,win32-x64}.zip` | 两者各 5 个 | **自包含 CLI runtime，不是桌面便携版**。上游 Windows 还嵌入同版本 Linux CLI 供 WSL；本项目已有完整私有 Node/PG 服务架构，不新增 CLI、便携版或 WSL 产品 |
| `SHA256SUMS` | 两者各 1 个 | 上游 release job 只对最终 CLI archives 生成；本项目采用对全部实际交付安装器、材料和报告的 SHA256 清单，不照抄其窄范围 |
| `latest.yml`、`latest-mac.yml`、`latest-linux.yml`、`latest-linux-arm64.yml` | stable 4 个 | 已实现 updater 的平台/渠道索引；本项目无 updater 或正式下载地址，禁止制造假 latest/feed |
| `nightly.yml`、`nightly-mac.yml`、`nightly-linux.yml`、`nightly-linux-arm64.yml` | nightly 4 个 | 上游 nightly feed；本项目不启用 schedule/nightly/channel 或版本改写 |
| `builder-debug.yml` | 两者各 1 个 | builder 诊断，不是更新源或发布批准；不作为本项目必交材料，不上传包含构建机路径的通配诊断 |
| `t3code-android-internal-2.2.0-759.apk` | 仅本次 nightly 1 个 | 从 Play internal 镜像来的 Android 应用；与本项目 Windows 桌面无关，不采用 mobile、Play 凭据或服务 |

## 工作流对照与采用决定

上游由 tag、手动 channel 或每小时两次 schedule 解析精确构建 commit，执行质量/分片测试、公共 relay 配置、共用 JS build、各目标 desktop/CLI build、Windows 原生验证，再聚合 Release；之后发布 npm launcher/AUR、部署 Web/营销站、提交版本和公告。其 Windows 当前在 Linux 交叉打包并在同架构 Windows runner 验证；我们保留 **匹配 OS/CPU 原生构建**，不照搬 cross-build。上游签名缺失可能走 unsigned，本项目继续显式 unsigned/signed 分支，signed 缺材料必须失败。

相关脚本还明确了不能照搬的细节：`update-release-package-versions.ts` 会改写 server/desktop/web/contracts 四份 manifest；`resolve-nightly-release.ts` 按日期/run number 组合 prerelease 版本，stable 手动流程可取已发布 nightly 的 commit；`build-desktop-artifact.ts` 根据 release channel 和仓库配置生成真实 GitHub updater，preview 显式禁用。我们不在构建时改写产品版本或创建 release tag，而以现有 desktop manifest 为版本权威，核对最终 ASAR 内版本、完整宿主 commit 和实际公开源码摘要。上游 CLI archive 将 SEA executable、外置依赖/native/resource monitor 等打成独立可运行闭包，并且只在最终 signed archive 后计算 CLI checksums；本项目不引入这套第二运行时/WSL 产品，只采用最终字节生成校验材料的原则。

保守补充仅在宿主打包和交付边界：

1. 手动 Actions 默认 unsigned + Windows-only，保留显式 macOS 选择；`contents: read`、`publish: never`、无 push/tag/schedule 触发。signed 仍须受保护环境与独立授权。不复制上游 appId、账号、域名、Clerk/relay、Apple/Azure 身份、telemetry 或公告。
2. 对 **最终** `app.asar`、其 unpacked sibling、`workspace-runtime` 和 `desktop-runtime` 检查 Claude 平台 CLI 包身份（含 metadata alias），复用既有包族规则，不按 `claude.exe` 文件名泛删，不裁剪 Cursor、PTY、SQLite 或通信 SDK。检查解包后的真实 app 内容并核对 Electron app 版本；构建前裁剪不能代替最终产物验证。
3. 保留 `desktop-package.json` 现有字段，增加 schema、准确应用/工具链版本、完整宿主 commit、所选公开源码逐文件摘要、dirty 身份、runtime 来源、实际 artifacts 的 SHA256/bytes。Git checkout commit 与含本地修改的源码 digest 分开，不能把 dirty 工作树说成 HEAD。
4. 输出 `SHA256SUMS`、`desktop-verification.json`、`desktop-source.tar.gz`、`desktop-source.json`、`desktop-legal.tar.gz`。对应源码只取受控公开代码/构建/文档路径，不纳入 `.env`、Home、`.local`、依赖缓存、产物或内部历史计划；源码包包含本地修改和本次新增 helper。legal 包来自最终成品适用的 notices/runtime/Electron legal 文件。哈希不是签名，也不能自证发布授权。
5. 打包完成时报告只写实际执行的静态检查，managed-instance / GUI / 安装卸载等明确未运行。后续 native delivery 验证命令实际执行 bundled runtime、managed 登录/停止/重连并更新机器可读报告及 checksums。Actions 只从校验过的精确发行清单暂存上传内容，missing/多余/篡改必须失败；不再用多个后缀通配上传产生部分材料。

不升级依赖或锁文件，不重写 Provider、PM 授权/revision/审批/收据、原生 Home/环境或 Chat 持久化。会话与持久化仍暂沿用 Agent Chat，统一设计未收口。

## 签名、许可证与源码闭包

- unsigned Windows 测试包不具有本项目发布者 Authenticode 身份，可能触发 SmartScreen；不指导用户关闭系统保护。macOS ad-hoc 不是 Developer ID/公证。signed 仅在显式选择、证书/公证前提具备且最终验签成功后标记；不读取现有凭据或配置签名密钥。
- 校验清单在最终签名之后生成，覆盖安装器与实际交付材料，防止传输损坏；来源信任仍需操作者核对可信 run、精确 commit/source digest 和已授权交付渠道。
- 保留根 AGPL、自有修改、各 vendor 原始许可和精确来源记录、实际 SDK/native/notices、Node/PostgreSQL/Electron/Chromium legal 文件。生成对应源码和 legal archive 是技术材料闭包，不自动满足法律审阅或源码公开入口义务。
- 成品按职责分开验证：解包的 `app.asar`、孤立的 `app.asar.unpacked` 和 `workspace-runtime` 继续执行原有严格私有配置/checkout 规则；`desktop-runtime` 保留固定官方 Node（含 npm 工具链）与完整 PostgreSQL，使用既有固定来源和逐文件完整字节清单验证，而不是把它泛当 workspace 源码根。官方固定 Node 归档自带的公开 `.npmrc` 不等于用户 Home/checkout 的私有配置；不单独放行该文件名、不删除它或 npm 子树、不修改 pin 或刷新既有 runtime manifest。`afterPack` 仍在复制后完整 `verifyRuntime`，unsigned 发行 verifier 再次核对最终 runtime；签名模式仍遵守签前 inventory 与签后签名验证边界。所有 loose resources 及 ASAR 解包内容继续独立按包身份检查外部 Claude 平台 CLI，因此官方 runtime 归属不豁免 CLI 包规则。对应 Node/PostgreSQL/Electron legal 材料保持原样。
- [第三方发布门禁](../../THIRD_PARTY_NOTICES.md#release-blockers) 的 `MISANS-GRANT`、`ASSET-ORIGINS`、`ARTIFACT-NOTICES`、`AGPL-SOURCE` 仍 OPEN。测试材料可以记录这些阻塞，但不能宣称可公开分发。公开正式发布必须另跑 release authorization、审阅最终 notices/空 license 项、提供可访问且与成品相配的对应源码及适用法律入口；本次不替维护者关闭这些项。

本项目 origin 当前为公开仓库；本轮 main push 会公开源码，Actions 上传的仍是 **unsigned 验证 artifact**，不能以构建/上传代替四个 OPEN 项的审阅或正式发布批准。构建环境继续只有只读 checkout token，不获得用于 push/dispatch 的操作者凭据。对应源码生成仅选择公开根中的 tracked 文件及逐条登记的已审阅新增文件，排除 `.env*`、`.local`、`.git`/config/hooks、凭据/证书、Home、内部历史文档和生成目录/缓存；不会归档所有 untracked 文件。清单不包含运行数据或数据库备份。

源码路径保护不只检查叶文件或 `realpath` 是否还在仓库内：Git 与无 Git 入口都先核验真实根，沿用现有 `GuardedDirectory` 逐级拒绝 source 祖先的 symlink/junction/reparse，保留每级身份至复制结束。本发布边界仅以只读方式打开普通源文件，复用既有 Windows reparse 检查，并在平台支持时使用 `O_NOFOLLOW`；不沿用 PM 私有可写存储的“单硬链接”不变量，因为冻结安装可为合法 `file:` 源依赖建立 `nlink > 1` 的硬链接。多硬链接不会跳过检查：开前/开后与读后核对同一目录、叶路径、打开描述符身份及完整文件 stamp（包含 link count），构建后仍按已捕获的批准 SHA256/模式核对内容。只从已核验的同一描述符读取，不改写源 inode，也不把源硬链接带入副本；任何操作中的身份、stamp 或内容漂移都拒绝并移除该次未完成副本。这样既不能通过祖先改指仓库内部 `.local` 归档其私有字节，也不会仅因 pnpm 在稳定冻结安装后合法增加 link count 而误拒绝未改动源文件。Linux 使用已有描述符相对遍历；macOS/Windows 仍按现有平台实现做路径、reparse 和打开句柄的前后身份检查，不将其夸大为对恶意同用户进程的原生文件系统沙箱。共享 PM 存储 helper 的单链接安全语义保持不变。

源码安全回归以消费者确实拒绝、私有源字节未被改写、目标副本和最终 source manifest 未生成等事实为断言，不绑定原生错误文案。动态“文件已打开后重命名祖先目录”的特定 race fixture 仅在 POSIX 执行；Windows 的打开句柄会拒绝这次 rename，无法据此声称 fixture 已制造 race 或由应用检测到替换，因此该 case 明确标为 Windows 未覆盖。Windows 仍独立执行捕获前已建立的 junction/reparse 拒绝、Git/gitless 路径边界和合法 hardlink 回归，不跳过这些保护，也不把特定 race 的 skip 计为通过。

派生 legal 目录在 tar 之前再次按其**自身**根执行现有资源检查：即使原链接合法留在安装 resources 内，复制后越界、悬空或循环也拒绝归档，不因原闭包合法而原样接受。交付 verifier 还要求实际最终 ASAR 的 SHA256 与构建报告 `checks.application.sha256` 相同；仅保持应用名称/版本不够证明是同一成品。

Git `dirty` 只针对所选公开源码，逐项将实际复制字节/路径/可表示的文件模式与固定 HEAD tree/blob 对象比较，不信任可能被 `assume-unchanged` 隐藏的 `git status` 或 filter 后 diff。Windows 的 POSIX 执行位按 Git 记录保存。构建后除复核旧文件的描述符内容/身份，还重新核对同一公开选集；新增或删除已审阅源码路径也使本次快照失效，不扫描用户私有或 ignored 数据来扩大检查范围。

无 `.git` 的原生构建快照必须在根目录携带经独立可信渠道核验的 `desktop-source.json`；再次核对完整公开文件集合与每个文件字节，拒绝缺失或未登记源码，不把父目录 Git 当成本项目身份。metadata/hash 本身不提供外部认证。对应源码归档包含同一清单，安装前传输核对与实际 build 验证分开，详见 [Windows 操作手册](windows-build-runbook.zh.md)。

## 更新与回滚的数据边界

只支持操作者手动替换安装器；安装目录与用户数据分离，卸载继续 `deleteAppDataOnUninstall: false`。安装升级不应导入开发实例、其他副本数据或 Provider Home。升级前正常停止本项目拥有的服务，生成并安全保管包含 PG/Markdown/state/附件/Agent 私有数据的一致备份，记录应用与 schema/runtime 版本；备份含私密数据且未加密。

代码/安装器回退不能逆转数据库 migration、Markdown revision/state、审批/收据、Agent SQLite 或外部 Provider 副作用。不能用旧安装器直接打开已升级数据来宣称成功回滚；先核对兼容性，不兼容时恢复到新的空实例并按同检查点恢复完整数据。PG 大版本不自动升级；重装/卸载不删除用户工作区，外部 Home 和项目源码树不作为安装器回滚材料。

## 必要流程与平台验收

1. 冻结全部实现及 vendor 来源记录，保留上一轮外部 CLI 16 路径修改；明确来源旧/新字节含义，不能全量刷新 hash 代签未知变化。
2. 父代理在隔离无发布凭据环境统一执行 sources/docs/licenses-integrity、相关回归和全新 Agent/Web/desktop 构建；精确记录命令、exit、跳过、环境与内容身份。旧绿色结果不用于新代次。
3. 按 [Windows 操作手册](windows-build-runbook.zh.md) 绑定唯一执行者、精确 main commit/remote/run SHA 及本轮授权；准备固定 Node/pnpm/MSVC 和经过 SHA256 校验的 Node/完整 PG runtime，再执行 unsigned packaging。不能把 Linux smoke 或旧 NSIS 当新成品，不因 main push 追加正式 Release。
4. 对新成品运行 delivery verifier，重新核对 installer/material hashes、app.asar/unpacked/runtime CLI 排除、版本和 legal；执行 packaged runtime 与 managed-instance 初始化/登录/正常停止/重连。真实账号/模型仅由父代理在原授权环境执行，与受控 SDK 协议 smoke 分开。
5. Windows 真实设备另验 installer 安装/升级/卸载、GUI、本机 ACL/reparse、进程所有权、备份恢复、缺失外部 Claude 路径明确失败、原生 CLI Home/环境与 PM 审批保留。macOS 两架构、签名/公证不因 Windows 成功视为通过。
6. 将实际验证报告和 checksums 与安装器/源码/许可材料一同交付；未验收、失败、未授权和环境阻塞分别记录。父代理按本项目既有流程核对 3224 服务归属并在门禁满足时部署；不能停止来源/其他副本服务。

### 当前已知阻塞（不是本次重跑结果）

- 历史 `thread.aui.tsx` 与 MCP/Skills ledger 字节登记不一致，以及 OpenHands `web-build.mjs` 旧 recipe 与 HEAD 的历史不一致，由本轮专责来源维护者逐字节审查；本发布 slice 不补签 vendor，也不修改未知 Web 生产代码。
- 上轮 Docker base image metadata 因 daemon 镜像 DNS 失败；本机 glibc 2.28 无法执行固定 PG 所需 GLIBC_2.33/2.34。不能改 daemon、换未批准 runtime 或复用其他项目 PG 补绿。
- 当前 shell 为 Linux，无本地/已登记 remote Windows host；已授权路线是集成冻结后直接 main 精确提交/推送，再手动运行现有托管 Windows x64 Actions。权限只读预检不代表实际 dispatch/额度/构建通过；若原生 job 受阻，保留准确结果，不跨平台假造或拿旧 installer 填补。
- 上述第三方分发授权、正式源码/下载地址、签名身份及真实设备验收尚未闭合。GitHub 正式发布保持未执行。

## 交付命令与报告分层

下列是统一冻结后由父级/唯一交付执行者运行的命令，不是本 slice 已执行的验证：

```sh
node --test apps/desktop/scripts/release-materials.test.mjs
pnpm --filter @agent-workspace/desktop package --platform win32 --arch x64 --output ABS_NEW_OUTPUT
node apps/desktop/scripts/verify-delivery.mjs --output ABS_NEW_OUTPUT --native-smoke --stage ABS_NEW_UPLOAD
```

`--output`/`--stage` 替换为本次拥有的真实绝对新目录。`package` 输出安装器及 source/legal 材料后，仅把真实执行的静态 ASAR/版本/runtime 来源/签名边界记录进 `desktop-verification.json`；`nativeSmoke` 初值为 `not-run`，legal 为 `collected-not-authorized`，发布为 false。`--native-smoke` 对 Windows unsigned 最终 runtime 执行 pinned inventory/工具版本和 managed-instance 冒烟，逐条记录成功或失败，并重新生成报告摘要及 checksums。signed 路径保留签名前 pinned runtime 校验/版本检查与最终签名检查；签名会改变 executable 字节，因此不拿签后字节硬比签前 inventory，仍执行最终 signed managed-instance 冒烟。真实安装、GUI、Provider 账号等不因这些命令通过而变成 passed。

下载后的发行材料没有 unpacked runtime，可执行 `node apps/desktop/scripts/verify-delivery.mjs --output ABS_DOWNLOADED_FILES --files-only`；它只证明完整清单和传输哈希，没有重跑 native/ASAR 检查。`SHA256SUMS` 覆盖全部安装器/辅助产物、源码、legal、报告和 `desktop-package.json`，不覆盖自身；报告变化同时更新其 manifest 摘要和清单，不制造自引用。`--stage` 要求已有成功 native smoke，并只复制/重新校验精确材料，Actions 上传该独立目录，不上传 unpacked tree、运行数据、临时日志或整个源码 checkout。

