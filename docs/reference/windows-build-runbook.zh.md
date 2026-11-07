# Windows x64 原生构建与测试交付操作手册

本手册先记录环境、操作、权限与失败恢复，再执行验证和打包。范围仅为本项目 **Windows x64 unsigned NSIS 测试安装包**；不是公开 Release、签名、自动更新、便携版、CLI、WSL 或其他平台交付授权。实现与材料设计见[桌面发布对照](desktop-release-alignment-2026-11-08.zh.md)，使用和数据边界见[桌面指南](../guides/desktop.md)。下列命令是集成冻结后的执行步骤，**不是本阶段已经运行的结果**。

## 预检结论与可执行路线

2026-11-08 的只读预检：

| 项目 | 实际观察及边界 |
| --- | --- |
| 本机 | Linux x64；没有 `cmd.exe`、PowerShell、WSL interop 或 Windows 系统目录，不能原生运行 Windows 构建。存在 QEMU 二进制、`libvirtd` 和 `/dev/kvm`，但没有已获授权的 Windows guest、镜像、许可证、账号或连接方式；这些工具不等于可用 runner，不启动或接管虚拟机 |
| 远程执行 | 会话 SSH capability 没有已配置主机；未提供获授权的 Windows remote runner。没有尝试连接猜测的主机，也没有读取 SSH/Provider 凭据文件；后续仅按操作者明确授权在进程内使用指定 GitHub 凭据进行只读预检，未显示或存储其内容 |
| Git 身份 | 本地 `main`，HEAD `575c11bdca253e731b4121a1507159931a601af9`；初次状态有上轮外部 Claude CLI 边界的 16 个未提交路径，必须保留。HEAD 不能代表这些本地字节，也不能代表随后完成的集成冻结身份 |
| 远端 | origin 的 fetch/push 目的地均为 `https://github.com/Crsei/project-management-agent-v4.git`；[仓库 API](https://api.github.com/repos/Crsei/project-management-agent-v4) 显示 **public**、默认分支 `main`，[分支 API](https://api.github.com/repos/Crsei/project-management-agent-v4/branches/main) 当时也是上述完整 HEAD。推送任何分支都会公开源码，不是私有构建上传 |
| GitHub 工具/权限 | 本机未发现 `gh`。匿名 API 可读历史元数据；后续获明确凭据使用授权的只读 API 确认 actor `Crsei`、仓库 `permissions.admin/push=true`、远端 main 未漂移、desktop workflow `406191743` active、Actions enabled。API 未返回 classic scopes header，GET 不能最终证明细粒度 token 的 Contents/Workflows/Actions 写范围，也不证明额度、审批或新 runner 的下载条件；写阶段若拒绝则停止，不擅自扩权 |
| 磁盘 | Linux 仓库所在卷当时约有 6.61 TB 可用，`/tmp` 约 81.2 GB 可用，均为十进制字节换算；**不证明 Windows runner 的磁盘容量** |
| 既有公共入口 | 只读监听及 procfs 显示 3224 网关 PID 31669、4194 PM PID 31667、4325 Agent PID 31668、Worker PID 31655 的 cwd/入口均属于本仓库，55444 仍有既有监听，4326 未监听。本阶段未访问账号、停启服务或部署新产物 |

因此，当前有已知可用的 **GitHub 托管 Windows 构建机制**，没有本地或已登记 remote Windows 主机。本轮操作者随后明确授权直接在 **main** 精确 commit、push origin main、执行 unsigned Windows-only 测试构建并下载本轮 artifact，且已知仓库 public、push 会公开源码。执行路线已选择 A，仍须等待完整集成冻结/必要本地门禁，不能把授权当作已经完成远端写入、Windows 构建或测试。路线 B 仅保留为明确条件下的替代机制，不自动启用；不跨平台绕过 `requireNativeTarget`。

### 路线 A：本轮已授权 main 的 GitHub Actions

1. 父级完成实现/来源审阅并冻结完整源码，列出本轮和保留的上轮修改，生成精确内容身份；先确认没有秘密、运行数据或无关修改进入交付集。
2. 本轮授权为 **直接在 main 提交本轮精确改动（含上轮 16 路径）并推送 origin main**，不建独立分支、不 force、不创建 tag/PR/Release/merge。先核对 local HEAD、remote main 与冻结基线；发现远端漂移或未知并行修改立即停止，不覆盖。授权 commit 不普遍隐含 push；本轮两项均已分别明确，后续其他内容或渠道不得借用此授权。
3. 必要本地门禁通过且准确内容提交/推送后，通过仓库 Actions 页面手动运行 [desktop.yml](../../.github/workflows/desktop.yml)：选择 `main`，`distribution=unsigned`、`windows_only=true`，并绑定刚推送的确切 SHA。这不创建 tag、PR 或 GitHub Release。也可由已配置且获授权的操作者使用 GitHub CLI：

   ```sh
   gh workflow run desktop.yml --repo Crsei/project-management-agent-v4 \
     --ref main -f distribution=unsigned -f windows_only=true
   ```

   本机没有 GitHub CLI 时可由唯一交付 owner 使用 GitHub HTTPS API，不为此安装依赖或引入新的发布脚本。指定凭据只在该进程内读取/trim，并限定发送到 GitHub HTTPS/API；不放入 argv、URL、Git 配置、日志、源码包或构建环境，不打印请求 headers/原始异常。dispatch 需要 repository Actions 写权限；发布源码/工作流需要 Contents 写权限及工作流更新所需的 Workflows 写权限，只读 GET 成功不能保证写入成功。禁止向 unsigned 构建环境注入 publisher token、签名密钥或 Provider 账号。
4. 记录实际 run ID、attempt、workflow 路径、repository/head-repository、branch 和完整 `head_sha`，核对它等于批准的提交。工作树仍 dirty 时，Actions 默认 checkout 不会包含这些本地字节；不能只重新运行当前 `main` 来交付本轮。
5. 下载该 run 的精确 Windows artifact，核对 API artifact digest、下载归档 SHA256、内层交付清单/源码身份和全部文件 SHA256。artifact 名称、绿色结论或下载时间不能替代这些核对。

现有工作流为手动触发，checkout `persist-credentials: false`、`contents: read`，使用 `windows-2025` x64 和已加载的 MSVC 环境。unsigned/signed 分支保持显式隔离；本任务不选择 `signed` 或进入 `desktop-signing` 环境。若仓库策略需要人工批准或 Actions 配额不足，保留实际 pending/拒绝结果，不改权限、建立新发布渠道或换仓库绕过。

### 路线 B：操作者提供已授权 Windows x64 主机，无需 commit/push

操作者可以提供专用本机/VM/remote runner 的身份、访问方式、可写构建目录及 **私有源码传输许可**，在该机直接构建冻结快照。这不要求把本轮改动公开推送；但不能自动把另一台未知主机当作获授权 runner，也不能为了取 runner 自行开云资源、安装 Windows 或配置新凭据。

传输内容必须来自父级审阅的完整公开源码/构建闭包，而不是只有 diff 或干净 HEAD：包括批准的 modified/untracked 文件、各 workspace、现有 vendor 来源记录/recipes、patches、固定 manifests/lockfile、构建脚本及适用许可证。逐文件记录路径、字节数、模式/链接规则和 SHA256；另记录完整 base HEAD、dirty 状态、内容清单及其摘要、传输 archive 摘要。接收方在安装依赖前核对精确清单，任何丢文件、行尾变化或新增未知文件都停止。

**不复制** `.env*`、`.npmrc`、`.local`、Provider Home、SSH/云/GitHub 凭据、用户数据、`node_modules`、旧 dist、旧安装器、下载缓存或整个开发 Home。不得把包含 remote token/config/hooks 的 `.git` 整目录当作普通源码传输。本轮交付设计约定：无 `.git` 时必须携带根 `desktop-source.json`，由父级通过独立可信渠道核验完整 base commit、dirty 身份、逐文件清单与摘要，打包工具再次严格核对记录字节；没有可信 manifest 的普通 tar 不可打包，manifest 自报 hash 不代替外部信任。对现有 Agent/Web/desktop 与 `check-sources` 的静态调用分析未发现需要宿主 Git 的活动构建/离线核对分支，上游 Git 对象重建是另一条维护流程；这不是无 Git 整链运行通过证据，新工具及第三方依赖仍须实际执行核对。构建快照和最终对应源码材料绑定同一内容身份，但不是数据库/私有 Chat 的备份。

## Windows 执行环境与下载前提

以下是必要配置和执行时应记录的事实，当前未在新 Windows runner 上验收：

| 项目 | 要求 |
| --- | --- |
| 原生平台 | 实际 Node `process.platform=win32`、`process.arch=x64`，不是 WSL/Linux Node、Wine、Windows ARM64 仿真或 Linux 交叉打包 |
| 工具链 | Node **24.21.0**、pnpm **11.9.0**；Visual Studio 2022 C++ x64/x86 Build Tools、Windows SDK，并加载包含 `cl.exe`、`link.exe`、`rc.exe` 的开发者环境。当前 cc-switch host 为 TypeScript，本次桌面链不需要恢复已退役 Rust sidecar 或安装另一套 Rust |
| Shell | 操作示例使用 PowerShell 7，`&&` 确保首个失败停止；系统 Windows PowerShell 及系统模块仍须可用，供 ACL/reparse/进程监督的既有实现调用。不要把仅能运行 `pwsh` 当成系统 PowerShell 前提已满足 |
| 文件系统/权限 | 当前用户拥有的本地真实目录，支持原生 ACL、文件身份和正常路径语义；不用网络盘、OneDrive 同步目录、junction/reparse 替代根或共享生产目录。若安装依赖确需 symlink 权限，由主机操作者预先准备最小开发权限，不为构建全局放宽 ACL/ExecutionPolicy 或关闭系统保护 |
| 路径/临时目录 | 使用较短 checkout（例如专用 `C:\b\pm`）和短私有 Temp。先读取 Git `core.longpaths` 及系统 `LongPathsEnabled`；保留 [`.gitattributes`](../../.gitattributes) 的 LF，不能以 CRLF/hash 刷新绕过来源。NSIS/其他原生工具不保证全部支持长路径，即使注册表启用仍优先短路径；未经授权不改系统注册表 |
| 磁盘/内存 | checkout、pnpm store、runtime 解压、两套 deploy staging、unpacked app、NSIS、对应源码/许可材料和上传 staging 同时占空间。代码没有可据此宣称足够的统一最低磁盘阈值；操作上建议构建卷及 Temp 合计预留至少 30 GiB 并记录各卷实值，实际峰值以本轮测量为准。保留 `NODE_OPTIONS=--max-old-space-size=4096` 及额外系统/native 内存，不能缩小检查范围应付 OOM |
| 数据隔离 | 新建私有构建/测试根，使用随机测试端口与自有临时 PG/存储。不加载开发 `.env`，不连接现有 55444 或其他项目库；不导入真实 Provider/PM 账号、签名和发布凭据。使用用户原生 Provider 授权环境的验证另由父级明确执行 |
| 安装器 | Electron **45.0.0**、electron-builder **26.18.0**，Windows 仅 x64 NSIS；当前 `oneClick=false`、`perMachine=false`、允许选择安装目录，卸载不删除用户数据。使用 `package` 显式 unsigned，不读证书、不尝试自动签名。SmartScreen/未知发布者不代表构建失败，也不能据此关闭保护或改称正式签名版本 |

[Windows 托管镜像说明](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md) 只证明镜像公布的工具集合，不保证新 job 的实际 image/version；工作流会记录 `ImageOS`/`ImageVersion`。镜像预装/缓存的 Node、PostgreSQL 可能与本项目 pin 不同，**不得直接复用**。本项目 doctor 检查准确 Node/pnpm 和编译器，不自动安装工具；也不覆盖磁盘、完整网络、所有运行时模块或 GUI 前提。

### 固定 runtime 与其他下载

运行时权威为 [runtime-manifest.mjs](../../apps/desktop/scripts/runtime-manifest.mjs)，不解析 latest。Windows x64 固定资源：

| 资源 | 固定位置与 SHA256 |
| --- | --- |
| Node ZIP | [node-v24.21.0-win-x64.zip](https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip)，`158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541` |
| Node 官方 checksum | [SHASUMS256.txt](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt)；预检只读取得的 Windows ZIP 条目与上述 pin 一致。prepare 仍须实时交叉核对官方条目并验证下载字节 |
| PostgreSQL | [postgresql-16.15.0-x86_64-pc-windows-msvc.tar.gz](https://github.com/theseus-rs/postgresql-binaries/releases/download/16.15.0/postgresql-16.15.0-x86_64-pc-windows-msvc.tar.gz)，`157bd7322f8c653f06b0373d1b2280e9cb238b6a6d3bd05541aeb8f33885a8ad`。公开 [release API](https://api.github.com/repos/theseus-rs/postgresql-binaries/releases/tags/16.15.0) 当时记录 46,608,717 bytes、相同 digest；版本 16.15、release 16.15.0，来源 commit `2954f800589f74265f136cdb490b87749e209e7c` |

上述只是公开 metadata/checksum 的只读证据；本阶段没有下载二进制，也没有证明 Windows 主机可达资源或归档实际可执行。最终执行仍须 SHA256、重新解压、完整文件清单、LICENSE/库/share 检查及 runtime smoke。

构建时还需要锁定 npm registry 包、pnpm/action 工具、Electron Windows x64 分发及其 checksum、electron-builder NSIS 编译器/资源和原生依赖资源。默认下载域涉及 `registry.npmjs.org`、`nodejs.org`、`github.com`、`api.github.com` 及 GitHub 资产跳转/CDN；允许列表应由执行环境操作者按真实目标配置，不能只允许网页域或擅改全局代理。锁定的 builder 当前默认 NSIS toolset 使用 `nsis-3.0.4.1.7z` 与 `nsis-resources-3.4.1.7z`，由其既有下载器校验；不在本轮升级 NSIS 或换未审阅镜像。

代理只在获授权的构建进程配置；Node fetch 需要时设置 `NODE_USE_ENV_PROXY=1`，Electron 下载遵守其既有代理机制。不要输出含认证信息的代理 URL、全量环境或 HTTP headers。缓存只作为字节复用：现有 Actions 缓存 pnpm 内容仓及 `apps/desktop/.cache/runtime-downloads` 的归档，按 OS/arch/image/lock/脚本精确 key 且 signed/unsigned 分开；不缓存 node_modules、已解压 runtime、应用、Home 或密钥。命中缓存不能省略冻结安装、pin/hash、来源门禁或实际 native smoke；Electron/NSIS 自身缓存也不等于已获离线构建能力。

## 集成冻结后唯一执行批次

此阶段只做预检/文档；**下面所有检查、安装、构建、smoke 和部署均尚未执行**。父级完成全部实现及来源记录并发出冻结交接后，唯一交付执行者再依次执行，不让多个 owner 同时测试或写构建目录。

### 1. 绑定当前源码

保存完整 HEAD、批准分支或私有 snapshot 身份、dirty 内容清单/摘要、vendor 来源代次、关键脚本/lock 摘要、实际工具链/OS/image。确认本轮修改与上轮 16 路径都在同一快照，未知并行修改不混入。现有 `thread.aui.tsx`/MCP ledger 与 OpenHands 旧 `web-build.mjs` recipe 的历史不一致，由来源 owner 逐字节解释并获准修复后再开始总门禁；不得简单 recapture、改 marker 或跳过检查。

源码、依赖、来源记录、打包工具或配置在冻结后改变时，旧验证立即失效，应重新冻结并只引用对应代次。仅有 Git HEAD、`git archive HEAD`、旧 dist 或旧 installer 都不能代表 dirty 工作树。

### 2. 准备独立原生检出并执行必要检查

先由主机操作者准备上述工具/短私有目录；不要在未知 host 上自动安装依赖或全局改配置。在批准的源码根、已加载 x64 MSVC 的 PowerShell 7 中，按同一批次记录每条 argv、cwd、环境边界、退出码、开始/结束与日志：

```powershell
# 必须实际输出 win32-x64；失败则停止，不修改 native target 守卫。
node -p "process.platform + '-' + process.arch"
Get-PSDrive -PSProvider FileSystem | Select-Object Name, Used, Free
Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled
# Git 元数据存在的检出才读取；不是自动修改 global/system 配置。
git config --show-origin --get core.longpaths

$env:NODE_OPTIONS = '--max-old-space-size=4096'
$env:PM_DESKTOP_TEST_POSTGRES_ROOT = Join-Path (Get-Location) 'apps/desktop/.runtime/desktop-runtime/postgres'
node scripts/doctor.mjs &&
  pnpm install --frozen-lockfile &&
  pnpm check:docs &&
  node scripts/check-sources.mjs &&
  pnpm check:licenses &&
  pnpm --filter @agent-workspace/desktop runtime:prepare --platform win32 --arch x64 &&
  pnpm --filter @agent-workspace/desktop runtime:smoke &&
  pnpm --filter @agent-workspace/contracts build &&
  pnpm --filter @agent-workspace/client-runtime build &&
  pnpm --filter @agent-workspace/desktop typecheck &&
  pnpm --filter @agent-workspace/desktop test &&
  pnpm exec node --conditions=development --test packages/pm-core/tests/platform.test.ts packages/infrastructure/tests/blobs.test.ts
if ($LASTEXITCODE -ne 0) { throw 'Windows prerequisite or regression batch failed; do not package.' }
```

Git `core.longpaths` 未设置时可能返回非零，应作为配置记录解释，不伪报构建失败或擅改系统。具体受影响 Agent、Web、来源工具和交付验证回归还须采用父级冻结交接的准确清单；上面不是全仓回归通过声明。`pnpm check:licenses` 是 integrity，不是 release authorization。真实 PG/bootstrap 测试必须使用此次准备的固定 Windows PG；skip、初始化失败或不兼容均单列，不借系统预装数据库补绿。

### 3. 生成新目录、验证实际成品、精确暂存

以下为本轮交付 owner 冻结的工具接口，详见[桌面发布设计](desktop-release-alignment-2026-11-08.zh.md)；接口已落地不代表本阶段执行或验证通过。

```powershell
# 这两个路径须为此次执行者拥有、从未存在的新目录；不要覆盖历史安装器。
$Output = 'C:\b\out\APPROVED_RUN_ID'
$Upload = 'C:\b\upload\APPROVED_RUN_ID'
pnpm --filter @agent-workspace/desktop package --platform win32 --arch x64 --output $Output &&
  node apps/desktop/scripts/verify-delivery.mjs --output $Output --native-smoke --stage $Upload
if ($LASTEXITCODE -ne 0) { throw 'Native delivery failed; preserve diagnostics and do not distribute.' }
```

将 `APPROVED_RUN_ID` 换成已经登记的实际执行身份；`package` 会自行构建 Agent/Web/desktop 并 staging，不需要把旧 Linux dist 复制到 Windows。输出目录已存在时应选择新的执行身份/目录，不删除别人的成品来复用路径。

`--native-smoke` 必须在本次原生构建目录、实际 unpacked resources 仍存在时执行；`--stage` 要求报告中的 native smoke 已通过，只复制并再次核对 manifest 精确文件。`--files-only` 与 `--native-smoke` 互斥，不得用于跳过 Windows 原生验证后暂存上传。

实际交付集包括 NSIS 安装器、`desktop-package.json`、`desktop-verification.json`、`SHA256SUMS`、`desktop-source.tar.gz`、`desktop-source.json`、`desktop-legal.tar.gz` 及 manifest 明确列出的辅助产物。不可只上传 `.exe` 后缀而丢报告/源码/许可，也不将 `win-unpacked`、临时测试实例、日志/任意 ZIP 通配上传。用于本机 native smoke 的 unpacked resources 不是额外的便携版产品。

最终核对至少包括：

- manifest 的版本、完整 source identity/dirty/source digest、目标 `win32-x64`、`unsigned`、runtime 来源和实际文件 bytes/SHA256；checksum 文件与报告的关系由真实实现定义，不伪造自引用 checksum。
- 对最终 `app.asar`、unpacked sibling、`workspace-runtime`、`desktop-runtime` 检查 Claude 平台 CLI 包身份（包括 alias），保留通信 SDK/PTY/SQLite/Cursor 及其必要资源，不按文件名泛删。
- 执行 bundled runtime smoke、真实 packaged managed-instance 初始化/登录/正常停止/重连，且只处理此次拥有的私有测试实例/进程；每条 smoke 的失败、skip 和未运行范围保留。
- 对应源码和 legal 材料与本次成品一致，记录其 SHA256；根 AGPL 和第三方 notices 完整性不等于所有分发权利已获准。
- 下载/私有传输后再次核对全部 SHA256；若 artifact 外层 archive 有 GitHub digest，分别记录它与内层 installer digest，不混用。

下载到 Linux/其他接收端的 artifact 只有发行材料，没有 unpacked resources；此时使用准确冻结工具的传输完整性模式：

```sh
node apps/desktop/scripts/verify-delivery.mjs --output /ABS/DOWNLOADED_DELIVERY --files-only
```

该模式检查完整文件集合、bytes/hash、源码清单摘要及 `SHA256SUMS`，不执行或重新证明 native smoke；原生结果仍须绑定可信 Windows run/attempt/确切 SHA，不能把接收端检查改称 Windows 验收。

没有执行的检查不能写为 passed。`--native-smoke` 通过也不等于安装了 NSIS、运行了 Electron GUI、完成真实账号/模型或正式发布。

## 真实 Windows 验收分层

| 范围 | 所需证据；不能被什么替代 |
| --- | --- |
| 原生构建与脚本回归 | 当前源码身份、真实 Windows x64 工具链、固定 runtime、回归日志、打包与成品 verifier；不能用旧 CI、Linux smoke、配置存在或成功缓存替代 |
| packaged backend smoke | 本次成品资源下初始化/登录/停止/重连、native 模块加载、ACL/reparse/进程所有权；不是已安装 GUI 验收 |
| 真实安装/升级/卸载 | 在批准的干净 Windows 测试账号/设备运行准确 SHA256 的 NSIS，确认安装位置/快捷方式、用户权限、升级保持数据、卸载不删数据；不要对操作者工作实例做破坏性试验 |
| GUI 与备份恢复 | 真实 Electron 启动/页面/关闭/重连、私有数据目录与自有进程、同 OS 备份到新空实例恢复；不能以 HTTP 200 或后台 smoke 宣称 GUI 全部通过 |
| Provider/PM | 真实外部 CLI、原生 Home/环境、缺失 Claude 显式失败无包内 fallback、PM 授权/revision/审批/收据，真实账号与模型调用独立获准并记录；受控协议程序不等于供应商账号验收 |
| 正式发布 | 另行授权与关闭[第三方发布门禁](../../THIRD_PARTY_NOTICES.md#release-blockers)、正式对应源码可访问性、签名身份及最终验签；unsigned 安装成功不授予 commit/push/Release/签名配置权限 |

会话与持久化仍暂沿用 Agent Chat，**统一设计尚未收口**。此交付不统一 Chat/PM 存储，不让 Run 成功代替业务完成，也不改变数据回滚语义。

## 失败恢复与服务保护

| 失败点 | 必要处置 |
| --- | --- |
| 无原生环境或公开上传未授权 | 保留源码和现有服务，报告缺失 Windows host/连接/传输许可，或分别缺失 commit、公开 push、Actions dispatch 权限；不改 Linux target、不启动未知 VM、不使用旧 exe |
| 网络/DNS/代理/资产 404 | 保留目标 URL 的非秘密身份、状态、实际脚本错误；由环境 owner 处理访问。校验 pin 缺失/不一致时停止并单独审阅，不能改 latest、跳过 SHA256、临时换 PG 或关闭 TLS 校验 |
| 下载缓存损坏 | 保留错误和实际 hash，仅由本次缓存 owner 清理报错的精确归档再重新 prepare；不删全局缓存、node_modules、用户数据或别人构建目录 |
| runtime/staging 已存在或不匹配 | 不覆盖；选新的 owned 输出路径重新准备。不能编辑 runtime manifest、Web marker 或来源 ledger 让旧字节冒充当前版本 |
| 路径、ACL、reparse、EPERM | 记录准确路径/操作/退出码，核对本地真实短目录、文件身份、进程锁和最小权限；不放宽产品链接/权限保护，不关闭杀软或全局安全策略 |
| OOM/磁盘满/原生依赖错误 | 保留真实失败，先增加获授权资源或修复准确工具链/下载前提；不跳过类型检查、裁剪未审阅的依赖资源、复制其他 OS 的 node_modules 或改锁补绿 |
| smoke/进程停止失败 | 只查询本次实例身份、PID/启动时间与数据库身份；结果未知先核对。不杀所有 node/postgres、不删除未停止的实例、不重放未知初始化或改用业务数据库 |
| manifest/checksum/source 不一致 | 整组交付失效；回到同一源码身份重建。不要重命名旧 exe、只重写 checksum、从另一 run 拼接合法材料，或把 verifier 失败隐藏成 warning |
| Actions 中断/超时/artifact 缺失 | 保存 run/attempt/head/job/step/结论，核对原 run 的实际状态再决定新尝试；旧 artifact 只作历史证据，不能填补本次未产出的 installer |
| 3224 发布前提失败 | 维持现有本项目可用服务；来源、构建、归属或数据前提未满足则不部署。正常停止/备份/切换按[部署手册](../../deploy/README.md)和父级冻结方案执行，Windows installer 不是 Linux 3224 的部署产物 |

代码回退不能自动逆转 PostgreSQL migration、Markdown revision/state、审批/收据、Chat SQLite 或外部副作用。先核对兼容性，必要时将同检查点完整备份恢复到**新的空实例**；不能让旧安装器直接打开已升级数据来假装回滚成功。

### 已知历史失败不重复确认

上一轮的来源门禁失败、Docker daemon 镜像 DNS 失败及 host glibc 2.28 与固定 PG 所需 GLIBC_2.33/2.34 不兼容均保留为既有事实；本阶段没有重新运行来“确认”。不能修改共享 daemon、接管其他服务或复用业务 PG。来源修复后的新代次最终门禁由父级在集成冻结后统一授权执行；Docker/兼容 Linux runtime 前提未解决时对应验收单列阻塞，不因为 Windows 成功而涂绿。

## 历史 CI 只证明机制

匿名只读 API 观察到本仓库 [run 42400940859](https://github.com/Crsei/project-management-agent-v4/actions/runs/42400940859)，attempt 1、`workflow_dispatch`、`main`、HEAD `575c11bdca253e731b4121a1507159931a601af9`，整体 success。其 Windows [job 128488327546](https://github.com/Crsei/project-management-agent-v4/actions/runs/42400940859/job/128488327546) 的 label 为 `windows-2025`，原生准备/回归/打包/managed smoke/upload steps 记录 success，signed job skipped。

该 run 的 [artifact 元数据](https://api.github.com/repos/Crsei/project-management-agent-v4/actions/runs/42400940859/artifacts?per_page=20) 记录 `desktop-unsigned-win32-x64`，ID `13586362459`，1,104,206,173 bytes，外层 digest `sha256:110e8320e240d85632ef2d3dd89a66787282783cc82c2ad58ce18c66d5d627bb`，观察时未过期、过期时刻 2026-11-21 18:49:14 UTC。**本阶段没有下载、打开或执行该 artifact**；上述摘要不是内层 exe 的摘要，历史 run 不包含本轮 dirty 改动，也没有本轮新材料/验证行为，不交作当前安装包。

## 当前未执行与交接要求

本阶段仅进行文档/源码/元数据/工具路径/磁盘/限定服务归属的只读调查及编写本手册。没有运行 build、lint、tests、formatters、dependency install、runtime smoke、GUI、真实账号调用、打包、3224 部署、commit、push、workflow dispatch、公开 Release 或签名配置。

集成后交付报告必须给出实际选择的执行路线、授权阶段、完整源码身份/摘要、准确命令与退出码、真实 Windows 范围、installer 及全部材料 SHA256、未执行 GUI/安装/账号范围、来源/环境/分发阻塞和 3224 当前/新版本状态。本轮 **main commit + 公开 push + unsigned Windows-only dispatch/下载已经获准，但均未执行**；当前等待完整集成冻结、必要本地门禁与同一精确 SHA 的远端写入/原生 job 实际结果。若原生 job 权限、额度、下载或回归失败，应记录准确失败而不是退回旧 artifact。公共仓库可读、权限预检和历史 CI 绿色均不是本轮 installer 已生成的证据。
