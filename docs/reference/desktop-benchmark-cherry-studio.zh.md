# Cherry Studio 桌面安装、签名与更新基准评审

本页是只读对标评审，不是通过报告。结论来自对本地 checkout 的静态阅读；本机为 Linux，未运行 Cherry Studio 的打包、签名、公证、安装器或更新流程，所有 Windows/macOS 原生行为均标记为**未验证**。引用的行号对应下述完整 commit，工作树后续变化可能使行号漂移。

| 项 | 值 |
| --- | --- |
| 参考仓库 | `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/cherry-studio` |
| commit | `27a61a606566fd60800e466ebfd041f858b89f9e`（2026-11-09 04:51:52 +0800） |
| 许可证 | AGPL-3.0（`LICENSE:1-2`） |
| 产品版本 | 2.1.10（`package.json`） |
| 工具链 | Electron 45.2.2、electron-builder 26.15.6、electron-updater 6.7.0、@electron/notarize ^2.5.0、Node `.node-version` = 24.18.1 |
| Dovspace 评审基线 | commit `8b9dbaacaaf3d55d75c8e1dc4bc289eb2d3c7f00`；工作树含无关用户改动，本页只新增本文件 |
| 口径 | 「观察」= 源码/配置可见；「[推断]」= 依赖工具默认行为但本检出未安装 `node_modules`、未执行；「未验证」= 需对应原生平台执行 |

## 1. 执行摘要

1. Cherry 的打包骨架值得参考的是**钩子分工**：`beforePack` 准备并证明运行时闭包，`afterPack` 在签名前校验并复制 asar 之外的资源，`afterSign` 只做公证，`artifactBuildCompleted` 只做发布命名归一。四段职责清晰；除公证在凭据缺失时静默跳过外，其余资源缺失均直接失败，而非静默降级。
2. **NSIS 预检只解决三件事**：架构不匹配、VC++ 运行库缺失、已存在 per-machine 安装时提权。它没有自定义卸载、升级迁移、服务停止或安装后验证；运行中应用的处理仍交给 electron-builder 模板（[推断]）。
3. Cherry **不是“签名/公证默认开启”的样本**：`win.verifyUpdateCodeSignature: false`、`mac.notarize: false`，且没有配置 `publisherName`。Windows 更新不校验发布者签名，macOS 公证依赖 `afterSign` 脚本在凭据存在时“尽力执行”，凭据缺失时静默跳过。
4. `publish.provider: generic` 指向 `https://releases.cherry-ai.com`，更新清单由该服务端选择目标版本与区域镜像；仓库只证明“生成并上传清单”，不证明清单签名、发布者真实性或回滚保护。
5. 发布工作流的证据边界强在**字节一致性与精确 SHA**：CI 通过才构建、按允许清单暂存、归档内逐文件哈希、发布前要求 GitHub 资产与归档逐字节一致、发布需受保护环境审批。它**不验证** Authenticode/codesign/spctl、不安装、不升级、不卸载、无 SBOM/漏洞扫描。
6. 唯一的原生安装**代码路径**在手动 E2E：Windows 静默执行已发布 NSIS 到临时目录，macOS 挂载 DMG 后 `ditto` 到临时目录并启动（本评审未执行）。没有卸载、升级、per-machine、注册表/快捷方式或 Gatekeeper 断言；安装器 SHA256 只被记录，未与期望值比对。
7. 对 Dovspace 的直接价值集中在：NSIS 预检的失败语义、`beforePack/afterPack` 的运行时闭包证明、发布资产允许清单与字节复核、以及 `verify-delivery` 已有的“最终分发文件展开而非 `win-unpacked`”思路。Dovspace 在 `publish: null`、签名前置失败、最终 NSIS payload 展开、SHA256SUMS/源码/许可材料方面已领先，缺的是**真实安装/升级/卸载执行证据**与**NSIS 预检**。
8. 明确不可照搬：`verifyUpdateCodeSignature: false`、无 `publisherName` 的 generic feed、凭据缺失时静默不公证、安装时下载并执行未固定哈希的 VC++ redist、删除 Electron/Chromium 许可文件、放宽 Hardened Runtime 的 entitlements 组合。

## 2. 相关目录树

```text
cherry-studio/
├── electron-builder.yml                     # 248 行，唯一主配置
├── electron-builder.cn.config.cjs           # extends 主配置；改 appId / edition / channel
├── dev-app-update.yml                       # 开发 feed: generic http://127.0.0.1:3378
├── package.json                             # build:win / build:mac / build:linux 入口
├── build/
│   ├── nsis-installer.nsh                   # 172 行；仅 customInit
│   ├── entitlements.mac.plist
│   ├── entitlements.system-speech.plist     # 空 dict，仅给 Helper
│   ├── icon.ico / icon.icns / icon.png / logo.png / tray_icon*.png / icons/
├── scripts/packaging/
│   ├── before-pack.js                       # 258 行
│   ├── after-pack.js                        # 74 行
│   ├── notarize.js                          # 25 行；afterSign
│   ├── win-sign.js                          # 121 行；signtoolOptions.sign
│   ├── mac-sign.js                          # 28 行；mac.sign
│   ├── artifact-build-completed.js          # 69 行
│   └── README.md
├── scripts/release/
│   ├── edition.js                           # 版本/edition → channel、期望资产名
│   ├── validate-edition-artifacts.js        # 构建后清单存在性与引用校验
│   ├── release-artifacts.js                 # 归档/哈希/GitHub 资产复核
│   └── validate-release-state.js            # 发布状态与 hotfix 门禁
├── scripts/e2e/regression/
│   ├── installation.ts                      # 真实 NSIS 静默安装 / DMG 复制
│   ├── artifacts.ts                         # 资产选择、SHA256
│   └── cli.ts                               # release / launch / cleanup / gate
├── src/main/services/AppUpdaterService.ts   # 542 行，electron-updater 客户端
├── resources/cherry-studio/
│   ├── release-history.json                 # 离线更新历史
│   └── license.html / privacy-*.html
└── .github/workflows/
    ├── release.yml                          # 1073 行；构建→草稿→审批→发布→镜像
    ├── prepare-release.yml                  # 424 行；创建 release/v* 分支
    ├── auto-release-build.yml               # 68 行；精确 SHA 派发
    ├── preview-release.yml                  # 233 行；内部预览，不发更新清单
    ├── nightly-build.yml                    # 266 行；仅 installer artifacts
    ├── post-release.yml                     # 268 行；元数据回同步 main
    ├── release-packages.yml                 # npm 包发布，与桌面无关
    └── e2e-regression-test.yml              # 手动；windows/macos 安装+启动
```

## 3. 关键文件与符号

| 文件 | 关键符号 / 配置 | 实际作用 |
| --- | --- | --- |
| `electron-builder.yml:1-20` | `appId`、`productName`、`extraMetadata.cherryEdition`、`electronLanguages`、`directories.buildResources` | 产品身份与语言裁剪 |
| `electron-builder.yml:22-98` | `files`、`asarUnpack` | 白/黑名单裁剪依赖、测试、源码；仅解包运行时需要的原生资源 |
| `electron-builder.yml:99-108` | `extraResources` | migrations、provider registry、pdfjs、voice NOTICE 放到 `resources/` |
| `electron-builder.yml:110-124` | `win.executableName`、`target`、`signtoolOptions.sign`、`signExts: ['.node']`、`verifyUpdateCodeSignature: false` | Windows 目标与自定义签名 |
| `electron-builder.yml:125-136` | `nsis.guid`、`oneClick:false`、`allowToChangeInstallationDirectory:true`、`include`、`differentialPackage:true` | assisted installer、固定升级身份、差分包 |
| `electron-builder.yml:137-141` | `portable.unpackDirName:true` | 便携版每次唯一解包目录 |
| `electron-builder.yml:142-169` | `mac.sign`、`notarize:false`、`target:[dmg,zip]`、`dmg.writeUpdateInfo:false` | macOS 签名/更新产物边界 |
| `electron-builder.yml:189-198` | `publish.provider/url`、`beforePack`、`afterPack`、`afterSign`、`artifactBuildCompleted` | 更新源与四类钩子 |
| `build/nsis-installer.nsh:17-22` | `checkVCRedist` | 读 HKLM 判断 VC++ 14.x |
| `build/nsis-installer.nsh:25-80` | `checkArchitectureCompatibility` | 系统/应用架构判定 |
| `build/nsis-installer.nsh:83-172` | `!macro customInit` | 提权、架构、VC++ 三段预检 |
| `scripts/packaging/before-pack.js:101-151` | `prepareNativeModulesForElectron` | 按 Electron ABI 重建 better-sqlite3，Linux 走固定 GLIBC 产物 |
| `scripts/packaging/before-pack.js:156-182` | `keepPackages`、`assertPrebuiltPackages` | 只保留目标平台/架构原生包；缺失即失败 |
| `scripts/packaging/before-pack.js:217-258` | `default` | 构建 helper、下载 bundled binaries、验证、追加 files 过滤器 |
| `scripts/packaging/after-pack.js:8-50` | `installComputerUseRuntime` | 校验 SDK/平台包版本与可执行位后复制到 `resources/computer-use` |
| `scripts/packaging/after-pack.js:52-74` | `default` | Windows 删除 Electron 许可文件；Linux 替换 ABI 匹配的 SQLite |
| `scripts/packaging/win-sign.js:15-64` | `shouldSignFile` | 校验 PE 头；跳过 node_modules 内非 PE 依赖 |
| `scripts/packaging/win-sign.js:67-94` | `signFileWithRetry` | 多时间戳服务器 × 3 次重试 |
| `scripts/packaging/win-sign.js:96-121` | `default` | `WIN_SIGN` 开关 + 三环境变量证书；失败抛出 |
| `scripts/packaging/mac-sign.js:8-28` | `createOptionsForFile`、`signMacApp` | 保留原签名策略，仅 Helper 用空 entitlements |
| `scripts/packaging/notarize.js:4-25` | `notarizing` | 仅 darwin；三凭据齐全才公证，否则直接 return |
| `scripts/packaging/artifact-build-completed.js:20-49` | `normalizeArtifactFilePath` | 发布资产名固定为 `<Product>-<Version>-<platform>-<arch>...` |
| `scripts/release/edition.js:12-27,64-117` | `getReleaseChannel`、`getExpectedReleaseArtifacts` | channel 与每平台期望文件/清单 |
| `scripts/release/validate-edition-artifacts.js:13-37` | `validateEditionArtifacts` | 文件存在、清单引用、`sha512` 与大小匹配 |
| `scripts/release/release-artifacts.js:39-94,96-111` | `validateFiles`、`verifyArchive` | 归档允许清单、跨 edition 引用、逐文件哈希 |
| `scripts/release/release-artifacts.js:155-189` | `verifyGithubAssets`、`verifyGithubRelease` | GitHub 资产集合与归档逐字节一致 |
| `src/main/services/AppUpdaterService.ts:44-46,258-276` | channel、headers、`allowDowngrade=false`、`disableDifferentialDownload=false` | 更新策略 |
| `src/main/services/AppUpdaterService.ts:397-437` | `isPortable`、`performUpdateCheck` | 便携版不检查；`autoDownload` 受偏好控制 |
| `src/main/services/AppUpdaterService.ts:490-493` | `quitAndInstall` | `quitAndInstall(true, true)` |

## 4. NSIS 安装器实际检查了什么

### 4.1 预检顺序（`customInit`，`build/nsis-installer.nsh:83-172`）

1. **per-machine 提权**（`:88-101`）：读取 `HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}` 的 `QuietUninstallString`。非空说明历史上装过 per-machine；若 `UserInfo::GetAccountType` 不是 `admin`，用 `ExecShell "runas" "$EXEPATH" "$R2"` 原参数重启自身，然后 `Quit`。`ExecShell` 报错时 `SetErrorLevel 1`，成功则 `0`。这里**没有**用户提示，也没有“取消 UAC 后继续 per-user 安装”的降级。
2. **架构匹配**（`:111-122`）：`RunningX64` + `PROCESSOR_ARCHITECTURE`/`PROCESSOR_ARCHITEW6432` 判定系统是 `x64`/`arm64`/`x86`；用 electron-builder 注入的 `APP_64_NAME`/`APP_ARM64_NAME` 判定应用是 `x64`/`arm64`/`universal`。不匹配时弹框写明系统和应用架构，打开官网，`Abort`。没有自动选择正确安装包。
3. **VC++ 运行库**（`:124-165`）：读 `HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64`（ARM64 用 `...\ARM64`）的 `Installed` DWORD。缺失时用 `inetc::get` 从 `https://aka.ms/vs/17/release/vc_redist.{x64,arm64}.exe` 下载到 `$TEMP`，`ExecWait "$3 /install /quiet /norestart"`，再读注册表复核。下载失败或安装失败都弹框给下载页链接并 `Abort`。
4. **未包含**：运行中应用检测、磁盘空间、安装目录可写性、旧版本数据迁移、服务停止、安装后自检。运行中应用由 electron-builder 的 assisted installer 模板处理（[推断]，本检出未安装 `node_modules`，未读模板）。

### 4.2 失败处理特征

- 全部为**硬失败**：`Abort` 或抛错，不存在“继续安装但功能缺失”的分支。
- 唯一静默点是 `customInit` 内的提权：`SetErrorLevel` 后 `Quit`，安装器退出码可区分，但用户看不到原因。
- VC++ 路径是**安装时联网下载并直接执行远程可执行文件**，没有固定 URL 版本、没有下载哈希、没有 Authenticode 校验；企业离线/代理环境会直接失败。这是明确的**不可照搬项**。

### 4.3 安装语义

- `oneClick:false` + `allowToChangeInstallationDirectory:true` → assisted installer，用户可选目录。
- `perMachine` 未显式设置；从脚本同时兼容 HKLM 卸载键与不提权路径看，作者预期存在 per-machine 与 per-user 两种历史安装（[推断]）。
- `guid: 41a4ccd8-...`（`electron-builder.yml:127`）让 global/cn 两个 edition 互相覆盖同一安装，而不是并存。
- `deleteAppDataOnUninstall` 未设置；数据保留语义不由本仓库自定义卸载脚本保证。

## 5. 签名、公证与更新元数据

### 5.1 Windows

- 签名入口是 `win.signtoolOptions.sign: scripts/packaging/win-sign.js`（`:120-121`），不是 electron-builder 内置证书路径。脚本从 `CHERRY_CERT_PATH` / `CHERRY_CERT_KEY` / `CHERRY_CERT_CSP` 取证书，`WIN_SIGN` 未设置时**直接不签名且不报错**（`win-sign.js:96-99`）。发布工作流显式设置 `WIN_SIGN: true`（`release.yml:285`），因此正式发布缺证书会抛错失败；preview/nightly 未设置 `WIN_SIGN`，Windows 产物静默 unsigned（`nightly-build.yml`、`preview-release.yml` 无该变量）。
- `signExts: ['.node']` 让 `app.asar.unpacked` 中的原生模块也进入签名流程；`shouldSignFile` 会先读 magic：ELF/Mach-O 且在 `node_modules` 内则跳过，其余非 PE 直接报错，避免把错误平台的二进制签成“已签名”。
- 时间戳使用 4 个公共 TSA，每台 3 次重试（`win-sign.js:7-11,67-94`）。这是可复用的稳健性细节。
- **`win.verifyUpdateCodeSignature: false`（`electron-builder.yml:124`）会被写入打包后的 `app-update.yml`，关闭 electron-updater 对 NSIS 更新包的发布者签名校验**；仓库中没有 `publisherName`。因此更新真实性只剩：TLS + `latest.yml` 内的 `sha512`（清单本身未签名）。攻击面是更新源或 TLS 终端被控制时的任意安装器执行。
- 没有 `signtool verify` / `Get-AuthenticodeSignature` 后置验证步骤；签名成功只由 `signtool` 退出码证明。

### 5.2 macOS

- `mac.sign: scripts/packaging/mac-sign.js` 包装 `@electron/osx-sign`，只为 `Contents/Helpers/cherry-system-speech` 换空 entitlements（`mac-sign.js:8-24`），其余继承 electron-builder 策略。
- `build/entitlements.mac.plist` 含 `allow-jit`、`allow-unsigned-executable-memory`、`allow-dyld-environment-variables`、`disable-library-validation`、`apple-events`、`calendars`、`audio-input`。这是为 Electron + 本地 MCP/AppleScript 功能放开的组合；**不应整份复制**，Dovspace 应按实际能力最小化。
- **`mac.notarize: false`（`electron-builder.yml:148`）关闭 electron-builder 内置公证**；真正公证在 `afterSign: scripts/packaging/notarize.js`。该脚本只在 `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` 全存在时调用 `@electron/notarize`，否则**静默 return**（`notarize.js:7-9`）。因此“构建成功”不等于“已公证”：正式发布工作流传入了三凭据（`release.yml:264-266`），但仓库没有步骤证明公证结果、staple 状态或 Gatekeeper 接受。
- `target: [dmg, zip]`，`dmg.writeUpdateInfo: false`（`:162-167`）：DMG 不参与更新清单，macOS 更新走 ZIP 及其 `.blockmap`（`validate-edition-artifacts.js` 对 mac 明确要求两个 ZIP blockmap）。未配置 `dmg.sign`，`notarize.js` 也只处理 `.app`；仓库没有对 DMG 单独签名或公证的步骤（原生结果未验证）。
- `hardenedRuntime` 与 `identity` 未显式设置：签名身份由 `CSC_LINK` 自动发现，Hardened Runtime 取 electron-builder 默认值（[推断]）。

### 5.3 更新源与客户端行为

- 打包时 `publish.provider: generic` + `url: https://releases.cherry-ai.com` + `useMultipleRangeRequest:false`（`electron-builder.yml:189-192`）写入 `app-update.yml`；CN edition 通过 `electron-builder.cn.config.cjs` 改 `appId` 与 `publish.channel`。
- 开发态 `forceDevUpdateConfig = !app.isPackaged`（`AppUpdaterService.ts:111`），读根目录 `dev-app-update.yml` 的 `http://127.0.0.1:3378`。
- channel 由 edition 拼接（`getEditionUpdateChannel`，`:44-46`）；检查前设置 `channel`、`allowDowngrade=false`、保留 differential（`:270-275`）；`autoInstallOnAppQuit=false`（`:116`）；便携版直接不检查（`:397-415`）。
- `latest*.yml` 的生成、存在性与 `sha512`/size 一致性由 `validate-edition-artifacts.js` 和 `release-artifacts.js` 校验；这证明**构建产物自洽**，不证明**发布者身份**。
- 服务端的目标版本选择、区域镜像、灰度/撤回策略不在本仓库，无法评审。

### 5.4 明确不可照搬

| 配置 | 原因 |
| --- | --- |
| `win.verifyUpdateCodeSignature: false` | 关闭 NSIS 更新签名校验；Dovspace 若启用更新必须先有可信发布者名与签名链 |
| 无 `publisherName` 的 `publish.provider: generic` | 清单与安装器无发布者绑定；TLS 之外无真实性根 |
| `notarize.js` 凭据缺失静默 return | 会把未公证包当成功产物；signed 模式必须 fail closed |
| VC++ redist 安装时远程下载并执行 | 无固定版本/哈希/签名校验，离线不可用 |
| `after-pack.js` 删除 `LICENSE.electron.txt` / `LICENSES.chromium.html` | 削弱许可材料完整性；Dovspace 走 legal 归档，不应删除 |
| `entitlements.mac.plist` 全量 | `disable-library-validation` + `allow-dyld-environment-variables` 等明显放宽 |
| `portable` 目标 | 第二套未安装身份、独立更新语义；Dovspace 无此产品需求 |
| `differentialPackage` / blockmap | 没有签名与可信 feed 前只会扩大攻击面与维护面 |

### 5.5 可直接复用 / 项目特定 / 不安全

| 分类 | 配置或模式 | 说明 |
| --- | --- | --- |
| 可直接复用（概念） | `beforePack`/`afterPack`/`afterSign`/`artifactBuildCompleted` 四个钩子键；`nsis.oneClick:false` + `allowToChangeInstallationDirectory:true`；`nsis.include`；`dmg.writeUpdateInfo:false`；`electronLanguages` 裁剪；`publish:null` 的本地/测试构建 | 与产品身份解耦，Dovspace 可按现有脚本风格实现 |
| 需按项目改写 | `nsis.guid`（升级身份）、artifact 命名、`extraResources` 条目、`files` 黑名单、`before-pack.js` 的 `packages` 列表、edition/channel、entitlements | 依赖 Cherry 的包结构、品牌与功能；照抄会引入错误排除或错误权限 |
| 不安全，禁止照搬 | `verifyUpdateCodeSignature:false`、无 `publisherName` 的 generic feed、凭据缺失静默不公证、安装时下载执行未固定哈希的 redist、删除 Electron/Chromium 许可、放宽 Hardened Runtime 的 entitlements、`portable` 的更新例外 | 见 §5.4 与 §11 |

## 6. 发布工作流的证据边界

`release.yml` 的主链路（行号为 job/step 起点）：

1. `prepare`（`:52-165`）：校验输入 tag/SHA、release 分支版本、**精确 SHA 的 CI 成功记录**、发布状态锁；不构建。
2. `release`（`:166-390`）：matrix = `{global,cn} × {windows,macos,ubuntu}`；Windows 使用 self-hosted `windows-signing`；构建后 `validate-edition-artifacts` 校验本平台/edition 的期望文件与更新清单；按**显式允许清单**上传 `dist/*.exe`、`*.zip`、`channel*.yml`、`*.blockmap`，`if-no-files-found: error`。
3. `finalize-build`（`:439-704`）：只取可信 `main` 上的控制脚本；拼装完整归档、逐文件哈希、校验清单引用与 edition 隔离；创建/更新 draft，按 lease 移动 tag；再次核对 tag、分支、draft 状态。
4. `approve`（`:738-747`）：`environment: release`，人工审批。
5. `publish`（`:748-891`）：下载完整归档，`verifyGithubAssets` 要求 GitHub 资产集合与归档逐字节一致，再校验 release 状态、hotfix 回填门禁，最后 `draft:false`。
6. `sync-to-gitcode`（`:892-968`）：只在发布后用同一归档镜像，Global 文件必须与 GitHub 逐字节一致。

**已证明（若工作流实际成功）**：产物来自精确 commit；资产集合固定；归档内与 GitHub 上的字节一致；发布经过审批；tag 未被静默移动。

**未证明**：Authenticode/codesign 有效性；公证与 staple；Gatekeeper/SmartScreen 行为；安装、升级、卸载；数据迁移；服务停止；SBOM/漏洞/许可证完整性；更新服务端行为。仓库中没有任何 `signtool verify`、`codesign --verify`、`spctl`、`stapler validate` 步骤（全文搜索仅命中 `win-sign.js`/`mac-sign.js` 的签名动作）。

## 7. 打包钩子与资源闭包模式

### 7.1 Cherry 的做法

- `beforePack`：先解析目标平台/架构，重建 ABI 匹配的原生模块；`assertPrebuiltPackages` 对目标架构**逐个断言目录存在**，缺失直接失败并给出修复命令（`before-pack.js:169-181`）；按包名 token 过滤其他平台/架构的原生包与 `resources/binaries/<other>`；最后 `download-binaries.js` 下载并 `verifyBundledBinaries` 校验每个二进制与版本标记（`before-pack.js:239-251`）。
- `afterPack`：在**签名前**校验并复制 asar 外资源；校验 SDK 与平台包版本一致、文件存在且可执行（`after-pack.js:8-50`）；Linux 额外校验 ELF/ABI/GLIBC 后替换 SQLite。
- `artifactBuildCompleted`：只在构建完成后改发布名，不参与安装内容。
- `files`/`asarUnpack`/`extraResources` 的分工：JS 进 asar；运行时 `dlopen`/`spawn` 的原生文件与 `resources/**` 解包到磁盘；数据类资源（migrations、registry、pdfjs）走 `extraResources`。

### 7.2 对 Dovspace 的映射

Dovspace 已有等价且更严格的实现：`apps/desktop/electron-builder.config.mjs:43-59` 的内联 `afterPack` 先比对 `app.asar` 哈希未被 builder 改写，再复制 `workspace-runtime` 与 `desktop-runtime` 到 `resources/`，执行 `inspectDeployment`、目录/文件 mode 归一、`verifyRuntime`、`inspectPackagedApplication`。`package.mjs:98` 固定 `publish:"never"`，`:105-137` 在签名后验 `codesign`/Authenticode，`:137` 展开最终分发文件。

因此**不需要搬 Cherry 的钩子代码**，需要补的是它没有的两类证据：

1. `beforePack` 等价物：对 PM / Agent / Electron 三个物理闭包与 pinned Node/PostgreSQL 做**打包前存在性与身份断言**（可在 `desktopBuilderConfig` 增加 `beforePack`，或复用现有 `dependency-layout-verifier.mjs` 在 `package.mjs` 构建前调用）。具体断言：三个闭包各自的 `node_modules` 根真实存在且互不共享运行时加载器；Node 与 PostgreSQL 的版本/哈希来自 `runtime-manifest.mjs` 的 pin；PostgreSQL 的 `bin/lib/share`/许可齐全；不得因 `afterPack` 复制成功就跳过来源检查。
2. 安装后证据：`final-artifact.mjs:224-274` 目前只展开最终 `.exe`/DMG/ZIP，明确写 `installationExecuted:false`（`:274`）。这与 Cherry 的静态校验同级，不能替代真实安装。

## 8. Dovspace 对照矩阵

| 维度 | Cherry 观察 | Dovspace 现状 | 差距 | 优先级 |
| --- | --- | --- | --- | --- |
| NSIS 预检 | 架构 + VC++ + 已有 per-machine 提权（`nsis-installer.nsh:83-172`） | `nsis` 仅 `oneClick:false`、`perMachine:false`、`allowElevation:true` 等（`electron-builder.config.mjs:68-76`），无 include | 缺架构/运行库/运行中服务预检 | P0 |
| 安装模式 | 未显式 `perMachine`；兼容两种历史安装 | 显式 per-user，允许提权装到受保护目录 | 需明确 per-user/per-machine 语义与迁移 | P0 |
| 安装 E2E | Windows `/S /D=` 静默安装已发布资产；macOS `hdiutil`+`ditto`（`installation.ts:74-110`） | 无；报告 `installationExecuted:false`（`final-artifact.mjs:274`、`verify-delivery.mjs:142`） | 缺真实安装执行 | P0 |
| 升级/卸载 E2E | 无 | 无 | 完全缺失 | P0 |
| Windows 签名 | 自定义 signtool 钩子 + `signExts:.node` + 时间戳重试；无后置验签 | builder 默认 `CSC_LINK`；签名后 `Get-AuthenticodeSignature`（`package.mjs:126-136`） | 签名链已有；未显式声明 `.node`/`.dll` 覆盖策略，缺安装器签名报告 | P1 |
| macOS 签名/公证 | `afterSign` 条件公证，缺凭据静默跳过；无 staple/spctl 验证 | `mac.notarize: signed`、`hardenedRuntime: signed`；`package.mjs:37-44` 缺凭据 fail closed；`package.mjs:109-110` `codesign --verify` | 缺 `spctl`/`stapler validate` 与公证结果证据 | P1 |
| 更新源 | generic + `verifyUpdateCodeSignature:false` | `publish:null`、无 updater | 不启用更新是当前正确边界；若启用需先补信任链 | P0（决策） |
| 运行时闭包 | `beforePack` 断言原生包 + 下载后校验 | `afterPack` 复制并 `verifyRuntime`；三闭包布局验证 | 缺打包前断言与安装后复核 | P1 |
| 最终产物校验 | 逐字节复核 GitHub 资产与归档 | 展开 NSIS `$PLUGINSDIR/app-64.7z` / DMG / ZIP 并校验资源树（`final-artifact.mjs:143-160`） | 已强于 Cherry；缺安装后树比对 | — |
| 发布资产 | 允许清单 + 归档哈希 + 审批环境 | `release-materials.mjs` 生成 `SHA256SUMS`/源码/legal；无 Release 发布 | 未发布，材料已更完整 | P1 |
| SBOM/漏洞/许可扫描 | 无 | 无（仅 `check:licenses` 类完整性） | 均缺 | P1 |
| 备份加密/恢复/隐私 | 无对应实现（单机应用数据模型不同），不能作为参考 | 备份含私密数据且**未加密**；恢复仅写新空实例（`docs/guides/desktop.md`） | Cherry 无答案；需 Dovspace 自行定密级与恢复验证 | P1 |
| 体积基线 | 未在配置中设预算；依赖黑名单大量裁剪 | 无预算门禁；既有测量为 unsigned Windows payload 39,809 文件 / 1,023,987,590 B | 需按闭包分解的预算与回归门禁 | P1 |

## 9. Dovspace 落地切片

### P0-1 Windows NSIS 预检

- 目标：新增 `apps/desktop/nsis/installer.nsh`；在 `apps/desktop/electron-builder.config.mjs` 的 `nsis` 增加 `include: join(import.meta.dirname, "nsis/installer.nsh")`。
- 内容：x64-only 架构断言；按打包后的 Node/PostgreSQL 二进制实际导入的 CRT（用 `dumpbin /dependents` 或等价检查确认，而不是假定）决定是否预检 VC++ 2015-2022 x64 运行库；已有 per-machine 安装时提权；运行中的 `PM Agent v4.exe` 与本项目拥有的 PM/Agent/PostgreSQL 子进程检查；失败信息给出明确下一步。**不要**安装时联网下载 redist；若确实依赖，要么随安装器携带经哈希固定的 redist，要么明确失败并给官方链接。
- 同时明确安装语义：当前 `perMachine:false` 的 per-user 默认与旧 per-machine 安装如何处理（迁移、拒绝或双实例）。不能只靠 electron-builder 默认值。
- 验收证据：Windows 原生 VM 上分别执行“缺运行库”“非管理员覆盖 per-machine”“服务运行中安装”三种场景，记录 NSIS 日志、退出码、注册表键、进程列表；报告写入 `desktop-install-e2e.json`。仅存在 `.nsh` 不算通过。

### P0-2 安装/升级/卸载 E2E

- 目标：新增 `apps/desktop/scripts/installer-e2e.mjs`；在 `.github/workflows/desktop.yml` 增加 `windows-2025` 的 `installer-e2e` job；扩展 `apps/desktop/scripts/final-artifact.mjs` 与 `verify-delivery.mjs` 接受并绑定该报告。
- 流程（参考 `scripts/e2e/regression/installation.ts:74-110` 的静默安装，但必须扩展）：
  1. 安装上一版本 → 记录安装目录、卸载键、快捷方式、服务状态；
  2. 覆盖安装当前版本 → 断言同一安装目录、版本更新、用户 workspace/PG 数据未变；
  3. 启动应用并使 PM/Agent/PG 就绪 → 正常退出；
  4. 卸载 → 断言进程全部退出、文件锁释放、安装目录删除、卸载键移除、用户数据保留；
  5. 故障注入：升级中途失败 → 断言旧安装仍可启动或安装器明确失败且数据未被部分迁移；在 workspace 放哨兵文件，确认卸载/升级不会递归删除安装目录之外的数据；
  6. 可选“删除用户数据”路径单独测试并记录。
- 验收证据：`installer-e2e.json` 含每步 exit code、注册表前后快照、文件树前后摘要、进程/PID、PG 数据摘要；工作流上传该 JSON 与日志。测试文件存在但未执行不得记为通过。

### P0-3 更新策略决策

- 目标：保持 `apps/desktop/electron-builder.config.mjs:38` 的 `publish:null` 与 `package.mjs:98` 的 `publish:"never"`，直到同时满足：正式签名身份、`publisherName`、公证、可信 feed、回滚/撤回策略。
- 若启用：新增 `apps/desktop/electron-updater.mjs` 或在 `src/` 内实现；**禁止** `verifyUpdateCodeSignature:false`；清单需签名或走可验证的发布渠道；必须测试“篡改安装器/清单被拒绝”。
- 验收证据：负向测试（替换安装器字节、替换 `latest.yml` 的 `sha512`、降级到旧版本）均被拒绝；报告记录实际拒绝原因。未做负向测试前不得声称更新安全。

### P0-4 发布资产允许清单与复核

- 目标：扩展 `apps/desktop/scripts/release-materials.mjs` 或新增 `release-manifest.mjs`，复用 `final-artifact.mjs` 的展开结果生成期望资产清单；工作流上传只接受清单内文件。
- 参考：`scripts/release/validate-edition-artifacts.js`、`scripts/release/release-artifacts.js` 的“期望文件 + 清单引用 + 逐文件哈希”结构。
- 验收证据：多一个文件、少一个 blockmap、清单引用错误均使 job 失败；成功时报告列出每个文件的 SHA256/bytes 与清单条目一一对应。

### P0-5 安装/升级期间的服务与数据保护

- 目标：在 `installer.nsh` 的 `customInit`/`customInstall` 中只停止**本项目拥有**的进程（沿用现有 PID/所有权校验思路），等待 PostgreSQL 正常 checkpoint；超时则失败而不是强杀。升级前提示备份；卸载保留用户 workspace。
- 目标文件：`apps/desktop/nsis/installer.nsh`、`apps/desktop/src/main.mjs`（退出钩子）、`apps/desktop/src/managed-postgres.mjs`。
- 验收证据：E2E 在服务运行中执行安装/升级/卸载，断言无孤儿进程、PG 数据目录在重连后可读、`deleteAppDataOnUninstall` 行为与文档一致。

### P1-1 签名覆盖与 macOS 公证闭环

- Windows：确认打包依赖闭包内所有 `.exe`/`.dll`/`.node` 都进入签名流程；若 builder 默认未覆盖，显式配置 `signExts` 或自定义 `signtoolOptions.sign`，并在 `package.mjs` 的 Authenticode 验签列表中加入 unpacked 原生文件。
- macOS：在 signed 模式下，`package.mjs` 已 fail closed；再增加 `afterSign` 或构建后步骤执行 `xcrun stapler validate` 与 `spctl -a -vv`，并把结果写入 `desktop-verification.json`。
- 目标文件：`apps/desktop/scripts/package.mjs`、`apps/desktop/electron-builder.config.mjs`、`apps/desktop/scripts/final-artifact.mjs`。
- 验收证据：Windows 报告列出每个被签名文件的签名状态；macOS runner 上对最终 DMG 内 `.app` 与 ZIP 内 `.app` 分别执行 `codesign --verify --deep --strict`、`stapler validate`、`spctl`，全部成功才标记 signed 通过。

### P1-2 体积与依赖裁剪门禁

- 目标：在 `apps/desktop/scripts/payload-report.mjs` 或 `release-materials.mjs` 增加文件数/逻辑字节预算；超出即失败，并输出按闭包（PM/Agent/Electron/runtime）分解。
- 参考：Cherry 的 `files` 黑名单与 `keepPackages` 思路，但按 Dovspace 的实际资源规则实现，不按文件名泛删。
- 验收证据：连续两次构建的分解报告；预算变更需显式记录原因。

### P1-3 SBOM、漏洞与许可材料

- 目标：在 `apps/desktop/scripts/release-materials.mjs` 生成 CycloneDX（或等价）SBOM，覆盖三个闭包 + Node/PostgreSQL runtime；增加 `pnpm audit --prod` 或等价漏洞门禁；`desktop-legal.tar.gz` 必须包含最终 payload 内所有第三方 notices。
- 验收证据：SBOM 条目与最终文件清单可对账；高危漏洞为 0 或逐条豁免并记录；legal 归档内每个 runtime 包都有对应许可文件。

### P1-4 备份加密/恢复/隐私验收

- 目标：Cherry 不提供可参考实现；在 `apps/desktop/scripts/verify-delivery.mjs` 或独立 E2E 中验证备份包含 PG 快照、`.pm` 文件、附件、Agent 私密数据，恢复只写新空实例，且失败不覆盖旧数据。
- 目标文件：`docs/guides/desktop.md`、`apps/desktop/src/managed-postgres.mjs` 及现有备份/恢复实现。
- 验收证据：至少一次跨版本恢复执行记录（备份→升级→恢复→校验摘要）；加密决策（加密算法/密钥来源或明确不加密的风险接受）写入文档，不能只写“未加密”。

## 10. 测试与 CI 证据口径

| 测试/工作流 | 断言内容 | 本评审是否执行 | 结论 |
| --- | --- | --- | --- |
| `scripts/__tests__/before-pack.test.ts` | `keepPackages` 平台/架构过滤、缺失预编译包抛错 | 否 | 测试存在，未证明通过 |
| `scripts/__tests__/package-contents.test.ts` | 用 electron-builder `FileMatcher` 验证 asar 包含/排除（Claude 平台 CLI、SQLite 源码、原生 payload） | 否 | 测试存在，未证明通过 |
| `scripts/__tests__/portable-packaging.test.ts` | 固定 builder 26.15.6 与 `portable.unpackDirName:true` | 否 | 测试存在，未证明通过 |
| `scripts/__tests__/differential-download.test.ts` | 单 range 差分重建与损坏检测 | 否 | 测试存在，未证明通过 |
| `scripts/__tests__/win-sign.test.ts` | PE 判定、重试、失败传播、`WIN_SIGN` 关闭时不读凭据 | 否 | 测试存在，未证明通过 |
| `scripts/__tests__/mac-sign.test.ts` | Helper entitlements、继承策略、`osx-sign` 参数 | 否 | 测试存在，未证明通过 |
| `scripts/__tests__/artifact-build-completed.test.ts` | 发布命名归一、不误改清单名 | 否 | 测试存在，未证明通过 |
| `scripts/__tests__/edition-packaging.test.ts` | global/cn 身份、artifact 契约、mac blockmap | 否 | 测试存在，未证明通过 |
| `.github/workflows/e2e-regression-test.yml` + `scripts/e2e/regression/installation.ts` | 代码定义：下载**已发布**资产；Windows `/S /D=` 静默安装；macOS `hdiutil`+`ditto`；启动应用 | 否 | 仅 tag 模式、手动触发；无卸载/升级/注册表/Gatekeeper 断言；安装器 SHA256 只记录不比对；本评审未执行 |
| `.github/workflows/release.yml` | 精确 SHA 构建、允许清单暂存、归档哈希、审批发布、GitHub 资产逐字节复核 | 否 | 证据强在字节一致性，不含 OS 签名/安装验证 |
| CI `pnpm check --group packages` | 在受影响时运行 `scripts` 项目单测 | 否 | 单测与原生安装无关 |

## 11. 许可证与安全边界

- Cherry Studio 为 AGPL-3.0。Dovspace 根许可证同为 AGPL-3.0，**许可兼容不等于可以直接复制**：复制脚本会形成衍生作品，必须保留版权/许可声明、记录修改并以 AGPL 方式提供对应源码；`build/icon.*`、`logo.png`、`tray_icon*`、产品名与 `appId` 属于 Cherry 品牌资产，不得复用。
- 建议**参考实现、按 Dovspace 约定重写**，尤其是：签名脚本（依赖 Cherry 专用环境变量）、edition 逻辑（Dovspace 无 cn/global）、Computer Use SDK 打包、portable 目标、更新客户端。
- 安全边界：Cherry 的 `verifyUpdateCodeSignature:false`、无 `publisherName`、条件公证、安装时远程下载 VC++、放宽 entitlements、删除 Electron 许可文件均不得进入 Dovspace 的 signed/正式发布路径。
- Dovspace 继续维持：`publish:null`、`publish:"never"`、signed 缺凭据 fail closed、最终分发文件展开校验、`installationExecuted` 诚实标记为 `false`，直到 P0 E2E 真正执行。

## 12. 开放问题

1. Cherry 的 generic feed 服务端是否对 `latest*.yml` 做签名或发布者绑定？仓库无证据。
2. `verifyUpdateCodeSignature:false` 是有意为之（自定义 signtool 无法让 builder 推导 `publisherName`）还是遗留配置？仓库无注释。
3. `afterSign` 公证是否对 DMG 也执行？当前脚本只处理 `.app`；DMG 是否另行公证未见配置。
4. `@electron/notarize` 2.5 是否自动 staple？需在 macOS 上实际验证，仓库无 `stapler validate` 证据。
5. electron-builder 26.15.6 的 assisted installer 是否内置运行中应用检测？本检出未安装 `node_modules`，未读模板。
6. Cherry 的升级数据迁移由应用自身（SQLite/文件）完成还是安装器？仓库无安装器迁移逻辑，需看应用启动路径，未在本评审范围内。
