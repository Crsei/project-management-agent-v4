# Windows x64 原生构建与测试交付操作手册

本手册记录环境、操作、权限与失败恢复。范围仅为本项目 **Windows x64 unsigned NSIS 测试安装包**；不是公开 Release、签名、自动更新、便携版、CLI、WSL 或其他平台交付授权。实现与材料设计见[桌面发布对照](desktop-release-alignment-2026-11-08.zh.md)，使用和数据边界见[桌面指南](../guides/desktop.md)。命令是具备对应权限及原生环境后才能执行的操作说明，不是已经运行的结果。

**当前依赖去重批次的权限与环境：** 2026-11-08 操作者已重新明确授权本项目本次依赖去重改动的精确 commit、公开 push 到 `main`、`windows_only=true` / `distribution=unsigned` 的 GitHub Actions 构建及该轮 artifact 下载。仅发布经父级审阅和必要门禁通过的隔离冻结候选；无关并行改动、凭据和运行数据不进入提交或构建。唯一交付 owner 在父级放行后执行远端写入，构建/检查进程不获得发布凭据；授权本身不表示操作已执行、权限足够或构建成功。没有新增本地/SSH Windows 主机或交互桌面，本轮仍未授权 macOS 构建、签名、tag/PR/Release/merge、真实安装器/GUI 执行或接管既有服务。Linux 上真实依赖闭包物化/重打包实验保留为该实验的证据，不升级为新 Windows 安装器或原生 GUI 结果。

## 历史预检结论与可执行路线

以下保留 2026-11-08 **上一轮发布准备**的只读预检与当时授权。表中的 HEAD、权限、磁盘和 PID 是当时观察，不自动成为当前值或本批次授权：

| 项目 | 实际观察及边界 |
| --- | --- |
| 本机 | Linux x64；没有 `cmd.exe`、PowerShell、WSL interop 或 Windows 系统目录，不能原生运行 Windows 构建。存在 QEMU 二进制、`libvirtd` 和 `/dev/kvm`，但没有已获授权的 Windows guest、镜像、许可证、账号或连接方式；这些工具不等于可用 runner，不启动或接管虚拟机 |
| 远程执行 | 会话 SSH capability 没有已配置主机；未提供获授权的 Windows remote runner。没有尝试连接猜测的主机，也没有读取 SSH/Provider 凭据文件；后续仅按操作者明确授权在进程内使用指定 GitHub 凭据进行只读预检，未显示或存储其内容 |
| Git 身份 | 本地 `main`，HEAD `575c11bdca253e731b4121a1507159931a601af9`；初次状态有上轮外部 Claude CLI 边界的 16 个未提交路径，必须保留。HEAD 不能代表这些本地字节，也不能代表随后完成的集成冻结身份 |
| 远端 | origin 的 fetch/push 目的地均为 `https://github.com/Crsei/project-management-agent-v4.git`；[仓库 API](https://api.github.com/repos/Crsei/project-management-agent-v4) 显示 **public**、默认分支 `main`，[分支 API](https://api.github.com/repos/Crsei/project-management-agent-v4/branches/main) 当时也是上述完整 HEAD。推送任何分支都会公开源码，不是私有构建上传 |
| GitHub 工具/权限 | 本机未发现 `gh`。匿名 API 可读历史元数据；后续获明确凭据使用授权的只读 API 确认 actor `Crsei`、仓库 `permissions.admin/push=true`、远端 main 未漂移、desktop workflow `406191743` active、Actions enabled。API 未返回 classic scopes header，GET 不能最终证明细粒度 token 的 Contents/Workflows/Actions 写范围，也不证明额度、审批或新 runner 的下载条件；写阶段若拒绝则停止，不擅自扩权 |
| 磁盘 | Linux 仓库所在卷当时约有 6.61 TB 可用，`/tmp` 约 81.2 GB 可用，均为十进制字节换算；**不证明 Windows runner 的磁盘容量** |
| 既有公共入口 | 只读监听及 procfs 显示 3224 网关 PID 31669、4194 PM PID 31667、4325 Agent PID 31668、Worker PID 31655 的 cwd/入口均属于本仓库，55444 仍有既有监听，4326 未监听。本阶段未访问账号、停启服务或部署新产物 |

当时确认有已知的 **GitHub 托管 Windows 构建机制**，没有本地或已登记 remote Windows 主机。上一轮操作者随后明确授权直接在 **main** 精确 commit、push origin main、执行 unsigned Windows-only 测试构建并下载该轮 artifact，且已知仓库 public、push 会公开源码；当时选择路线 A，仍须完整集成冻结/必要本地门禁。该历史授权不是远端动作或原生测试已完成的证据，也不能单独授予当前批次权限；**本次依赖去重使用上方记录的新明确授权**，不是复用旧授权或旧产物。以下保留操作机制与历史预检，不跨平台绕过 `requireNativeTarget`。

### 路线 A：main / GitHub Actions 机制（本批次已重新授权）

1. 父级完成实现/来源审阅并冻结完整源码，列出该轮及保留修改，生成精确内容身份；先确认没有秘密、运行数据或无关修改进入交付集。
2. 本批次已明确授权 **直接在 main 提交并推送本次去重候选的精确改动**，不是再次提交上一轮 16 路径，也不包含并行 turbo、根 package/lock 或其他来源维护改动；不建独立分支、不 force、不创建 tag/PR/Release/merge。唯一交付 owner 先核对实际 remote main 和本地对象，基于准确远端祖先创建独立候选并记录逐文件内容；保留主检出、既有历史、index 及无关 dirty/untracked 内容。发现远端漂移或未知候选变动立即停止，不覆盖。commit、公开 push 和 Actions 写入按各自已明确授权的范围执行，不能扩大到其他改动。
3. 必要门禁通过、父级放行且准确内容已提交/推送后，才可通过仓库 Actions 页面手动运行 [desktop.yml](../../.github/workflows/desktop.yml)：选择获准 `main`，`distribution=unsigned`、`windows_only=true`，绑定确切 SHA。这不创建 tag、PR 或 GitHub Release。下例是本批次授权路线的操作说明，且要求已配置工具；不是已经 dispatch 的证据：

   ```sh
   gh workflow run desktop.yml --repo Crsei/project-management-agent-v4 \
     --ref main -f distribution=unsigned -f windows_only=true
   ```

   本机没有 GitHub CLI 时可由唯一交付 owner 使用 GitHub HTTPS API，不为此安装依赖或引入新的发布脚本。指定凭据只在该进程内读取/trim，并限定发送到 GitHub HTTPS/API；不放入 argv、URL、Git 配置、日志、源码包或构建环境，不打印请求 headers/原始异常。dispatch 需要 repository Actions 写权限；发布源码/工作流需要 Contents 写权限及工作流更新所需的 Workflows 写权限，只读 GET 成功不能保证写入成功。禁止向 unsigned 构建环境注入 publisher token、签名密钥或 Provider 账号。
4. 记录实际 run ID、attempt、workflow 路径、repository/head-repository、branch 和完整 `head_sha`，核对它等于批准的提交。工作树仍 dirty 时，Actions 默认 checkout 不会包含这些本地字节；不能只重新运行当前 `main` 来交付本轮。
5. 下载该 run 的精确 Windows artifact，核对 API artifact digest、下载归档 SHA256、内层交付清单/源码身份和全部文件 SHA256。artifact 名称、绿色结论或下载时间不能替代这些核对。

现有工作流为手动触发，checkout `persist-credentials: false`、`contents: read`，使用 `windows-2025` x64 和已加载的 MSVC 环境。unsigned/signed 分支保持显式隔离；本任务不选择 `signed` 或进入 `desktop-signing` 环境。若仓库策略需要人工批准或 Actions 配额不足，保留实际 pending/拒绝结果，不改权限、建立新发布渠道或换仓库绕过。

### 路线 B：操作者提供已授权 Windows x64 主机，无需 commit/push

操作者可以另行提供专用本机/VM/remote runner 的身份、访问方式、可写构建目录及 **私有源码传输许可**，在该机直接构建冻结快照；当前未提供。这不要求把改动公开推送，但不能自动把另一台未知主机当作获授权 runner，也不能为了取得 runner 自行开云资源、安装 Windows 或配置新凭据。

传输内容必须来自父级审阅的完整公开源码/构建闭包，而不是只有 diff 或干净 HEAD：包括批准的 modified/untracked 文件、各 workspace、现有 vendor 来源记录/recipes、patches、固定 manifests/lockfile、构建脚本及适用许可证。逐文件记录路径、字节数、模式/链接规则和 SHA256；另记录完整 base HEAD、dirty 状态、内容清单及其摘要、传输 archive 摘要。接收方在安装依赖前核对精确清单，任何丢文件、行尾变化或新增未知文件都停止。

**不复制** `.env*`、`.npmrc`、`.local`、Provider Home、SSH/云/GitHub 凭据、用户数据、`node_modules`、旧 dist、旧安装器、下载缓存或整个开发 Home。不得把包含 remote token/config/hooks 的 `.git` 整目录当作普通源码传输。本轮交付设计约定：无 `.git` 时必须携带根 `desktop-source.json`，由父级通过独立可信渠道核验完整 base commit、dirty 身份、逐文件清单与摘要，打包工具再次严格核对记录字节；没有可信 manifest 的普通 tar 不可打包，manifest 自报 hash 不代替外部信任。对现有 Agent/Web/desktop 与 `check-sources` 的静态调用分析未发现需要宿主 Git 的活动构建/离线核对分支，上游 Git 对象重建是另一条维护流程；这不是无 Git 整链运行通过证据，新工具及第三方依赖仍须实际执行核对。构建快照和最终对应源码材料绑定同一内容身份，但不是数据库/私有 Chat 的备份。

## Windows 执行环境与下载前提

以下是必要配置和执行时应记录的事实，当前未在新 Windows runner 上验收：

| 项目 | 要求 |
| --- | --- |
| 原生平台 | 实际 Node `process.platform=win32`、`process.arch=x64`，不是 WSL/Linux Node、Wine、Windows ARM64 仿真或 Linux 交叉打包 |
| 工具链 | Node **24.21.0**、pnpm **11.9.0**；Visual Studio 2022 C++ x64/x86 Build Tools、Windows SDK，并加载包含 `cl.exe`、`link.exe`、`rc.exe` 的开发者环境。当前 cc-switch host 为 TypeScript，本次桌面链不需要恢复已退役 Rust sidecar 或安装另一套 Rust |
| Shell | 操作示例使用 PowerShell 7，`&&` 确保首个失败停止；系统 Windows PowerShell 及系统模块仍须可用，供 ACL/reparse/进程监督的既有实现调用。不要把仅能运行 `pwsh` 当成系统 PowerShell 前提已满足 |
| 归档成品门禁 | **全功能 7-Zip**，支持 NSIS、7z、ZIP；验证器优先 `%ProgramFiles%\7-Zip\7z.exe`、`%ProgramFiles(x86)%\7-Zip\7z.exe`，再使用 PATH 上的 `7z`。必须记录真实路径/版本/格式支持；builder 的独立 `7za` 不保证 NSIS，不能替代。缺失即停止，不在预检中调用 builder 下载新 toolset |
| 文件系统/权限 | 当前用户拥有的本地真实目录，支持原生 ACL、文件身份和正常路径语义；不用网络盘、OneDrive 同步目录、junction/reparse 替代根或共享生产目录。若安装依赖确需 symlink 权限，由主机操作者预先准备最小开发权限，不为构建全局放宽 ACL/ExecutionPolicy 或关闭系统保护 |
| 路径/临时目录 | 使用较短 checkout（例如专用 `C:\b\pm`）和短私有 Temp。先读取 Git `core.longpaths` 及系统 `LongPathsEnabled`；保留 [`.gitattributes`](../../.gitattributes) 的 LF，不能以 CRLF/hash 刷新绕过来源。NSIS/其他原生工具不保证全部支持长路径，即使注册表启用仍优先短路径；未经授权不改系统注册表 |
| 磁盘/内存 | checkout、pnpm store、runtime 解压、两套 deploy staging、unpacked app、NSIS、对应源码/许可材料和上传 staging 同时占空间。代码没有可据此宣称足够的统一最低磁盘阈值；操作上建议构建卷及 Temp 合计预留至少 30 GiB 并记录各卷实值，实际峰值以本轮测量为准。保留 `NODE_OPTIONS=--max-old-space-size=4096` 及额外系统/native 内存，不能缩小检查范围应付 OOM |
| 数据隔离 | 新建私有构建/测试根，使用随机测试端口与自有临时 PG/存储。不加载开发 `.env`，不连接现有 55444 或其他项目库；不导入真实 Provider/PM 账号、签名和发布凭据。使用用户原生 Provider 授权环境的验证另由父级明确执行 |
| 安装器 | Electron **45.0.0**、electron-builder **26.18.0**，Windows 仅 x64 NSIS；当前 `oneClick=false`、`perMachine=false`、允许选择安装目录，卸载不删除用户数据。使用 `package` 显式 unsigned，不读证书、不尝试自动签名。SmartScreen/未知发布者不代表构建失败，也不能据此关闭保护或改称正式签名版本 |

[Windows 托管镜像说明](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md) 只证明镜像公布的工具集合，不保证新 job 的实际 image/version 或全功能 7-Zip 可执行；工作流会记录 `ImageOS`/`ImageVersion`。镜像预装/缓存的 Node、PostgreSQL 可能与本项目 pin 不同，**不得直接复用**。本项目 doctor 检查准确 Node/pnpm 和编译器，不自动安装工具；不覆盖磁盘、7-Zip 全格式支持、完整网络、所有运行时模块或 GUI 前提。macOS 若另行获准构建，还需要 PATH 上的全功能 `7z` 及原生 `/usr/bin/hdiutil`、`/usr/bin/ditto`、`/usr/bin/codesign`；Linux 工具不能替代 DMG 挂载或最终 Mach-O 验签。

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

本批次已授权上方限定的 Windows-only unsigned 远端交付；下面是集成冻结、必要门禁和父级放行后的唯一执行批次，**不是当前已执行结果**。唯一交付执行者依次执行，不让多个 owner 同时测试或写构建目录。原生构建必须使用独立 checkout/冻结源码快照：`package` 会重建 Agent、Web、desktop，不能在服务正在使用的检出中覆盖其输出；构建和检查环境不携带发布凭据。

### 1. 绑定当前源码

保存完整 HEAD、批准分支或私有 snapshot 身份、dirty 内容清单/摘要、vendor 来源代次、关键脚本/lock 摘要、实际工具链/OS/image。明确列出本轮批准改动与刻意排除的并行路径，只从实际已审阅基线叠加批准内容，不将所有 dirty 文件混入。历史上 `thread.aui.tsx`/MCP ledger 与 OpenHands 旧 `web-build.mjs` recipe 曾有来源不一致；旧失败保留为历史事实，新冻结代次按准确字节及来源 owner 交接核对，不简单 recapture、改 marker 或跳过检查。

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
# 检查本机真实工具，不能仅引用托管镜像清单。
Get-Command cl.exe, link.exe, rc.exe -ErrorAction Stop | Select-Object Name, Source
# 下面示例要求全功能 7-Zip 位于默认 ProgramFiles；若在另一受支持位置，替换为其实际路径。
$SevenZip = Join-Path $env:ProgramFiles '7-Zip\7z.exe'
& $SevenZip i
if ($LASTEXITCODE -ne 0) { throw 'Full 7-Zip unavailable; do not package.' }
# 保存输出并确认 Formats 包含 Nsis、7z、zip；只有 7za 或版本文本不满足要求。

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

以下为当前源码实现的工具接口；接口存在不代表已执行或验证通过。仅在上述权限与原生前提满足后使用，详见[桌面发布设计](desktop-release-alignment-2026-11-08.zh.md)及[桌面指南](../guides/desktop.md)。

```powershell
# 这两个路径须为此次执行者拥有、从未存在的新目录；不要覆盖历史安装器。
$Output = 'C:\b\out\APPROVED_RUN_ID'
$Upload = 'C:\b\upload\APPROVED_RUN_ID'
pnpm --filter @agent-workspace/desktop package --platform win32 --arch x64 --output $Output &&
  node apps/desktop/scripts/verify-delivery.mjs --output $Output --native-smoke --stage $Upload
if ($LASTEXITCODE -ne 0) { throw 'Native delivery failed; preserve diagnostics and do not distribute.' }
```

将 `APPROVED_RUN_ID` 换成已经登记的实际执行身份；`package` 会自行构建 Agent/Web/desktop 并 staging，不需要把旧 Linux dist 复制到 Windows。输出目录已存在时应选择新的执行身份/目录，不删除别人的成品来复用路径。

`package` 的最终门禁必须读取本次准确 `.exe`，先列举/检查外层 NSIS，再读取其中唯一非空 `$PLUGINSDIR/app-64.7z` 并展开，检查所得 `resources`；不能改用 sibling `win-unpacked` 或旧 `dist/nsis/app-64.7z`。macOS 则分别检查本次 DMG/ZIP。`desktop-verification.json` 的 `checks.finalArtifacts.artifacts[]` 绑定每份发行文件的 path/SHA256/bytes、NSIS 内层 payload SHA256/bytes、应用检查、`tree` 文件数/逻辑字节/链接数及 `resourcesTree` 精确摘要。依赖检查按包身份/解析图解释必要实例，拒绝递归展开，而不是按相同 hash 删除路径；逻辑字节也不是实际磁盘占用。

`--native-smoke` 在本次原生检出中重验全部最终发行 payload，默认从第一份已核验发行文件提取的资源执行 smoke；不依赖原始 `win-unpacked/resources`，但仍需要当前检出的已构建 `apps/desktop/dist` service controller。报告 scope 为 `final-distributable-payload`；它运行打包的 backend/runtime，不执行安装后的 Electron `app.asar` controller 或 GUI。`--stage` 要求成功的 native smoke 与当前发行文件 SHA256/bytes 绑定，只复制并复核 manifest 精确材料集；旧 staging-only smoke 报告不合格。`--files-only` 与 `--native-smoke` 互斥，不得用于跳过原生执行后冒充当前 smoke 成功。

若已经在单独获准的测试账号/设备安装准确安装器，可核对该安装目录的资源并在其中执行 backend smoke：

```powershell
# InstallRoot 必须来自已完成且单独记录的安装；此命令本身不会安装。
$InstallRoot = 'C:\b\installed\APPROVED_RUN_ID'
node apps/desktop/scripts/verify-delivery.mjs --output $Output --native-smoke --installed-resources (Join-Path $InstallRoot 'resources')
if ($LASTEXITCODE -ne 0) { throw 'Supplied installed resources failed current-payload binding or native smoke.' }
```

`--installed-resources` 必须与 `--native-smoke` 一起使用，不能与 `--files-only` 合用。它先核验当前完整发行集，再将 supplied tree 的应用检查及整个 `resources` 树精确摘要与当前第一份发行 payload 对照；报告 `installedTree.sourceArtifact` 与 `nativeSmoke.scope=supplied-installed-tree`。不只是相信所供目录自带 manifest，也不检查 resources 外的 Electron 可执行文件、快捷方式、注册表或数据目录；不能证明目录来自真实安装。报告的 `installationExecuted` / `electronGuiExecuted` 仍为 `false`，安装/升级/卸载/GUI 必须另行执行和记录。

实际交付集包括 NSIS 安装器、`desktop-package.json`、`desktop-verification.json`、`SHA256SUMS`、`desktop-source.tar.gz`、`desktop-source.json`、`desktop-legal.tar.gz` 及 manifest 明确列出的辅助产物。不可只上传 `.exe` 后缀而丢报告/源码/许可，也不将 `win-unpacked`、临时测试实例、日志/任意 ZIP 通配上传。构建 unpacked tree、最终提取资源和所供 installed tree 都不是额外的便携版产品。

最终核对至少包括：

- manifest 的版本、完整 source identity/dirty/source digest、目标 `win32-x64`、`unsigned`、runtime 来源和实际文件 bytes/SHA256；checksum 文件与报告的关系由真实实现定义，不伪造自引用 checksum。
- 最终 `app.asar`、unpacked sibling、`workspace-runtime`、`desktop-runtime` 的 Claude 平台 CLI 包身份（包括 alias），保留通信 SDK/PTY/SQLite/Cursor 及必要资源，不按文件名泛删。
- PM、Agent、Electron 保持独立物理生产依赖闭包，`desktop-dependency-layout.json` 中实际包/版本/peer/缺席 optional 边、资源 hash 与文件数一致；Agent 只有一个物理 Effect 4.0.5。包自有嵌套 fixture/template `node_modules` 仍属于资源清单，不误判为依赖展开。原 Agent manifest 的 `.packages`/links 仅为来源记录。
- 执行最终提取资源（或与当前 payload 精确绑定的 supplied tree）上的 bundled runtime、原生依赖/Effect 运行时身份与 managed-instance 初始化/登录/正常停止/重连，且只处理此次拥有的私有测试实例/进程；逐条保留失败、skip 与未运行范围。macOS 只允许签名前 magic 记录的 Mach-O 在原生 bundle/逐文件验签后改变，其他依赖/runtime 资源仍精确匹配。
- 对应源码和 legal 材料与本次成品一致，记录其 SHA256；根 AGPL 和第三方 notices 完整性不等于所有分发权利已获准。
- 下载/私有传输后再次核对全部 SHA256；若 artifact 外层 archive 有 GitHub digest，分别记录它与内层 installer digest，不混用。

下载到 Linux/其他接收端的 artifact 通常只有发行材料，不含原始构建 unpacked tree 或 checkout-built controller；此时使用准确冻结工具的传输完整性模式：

```sh
node apps/desktop/scripts/verify-delivery.mjs --output /ABS/DOWNLOADED_DELIVERY --files-only
```

该模式检查完整材料集合、bytes/hash、源码清单摘要及 `SHA256SUMS`，不展开最终 payload、不执行或重新证明 native smoke，也不补齐旧格式报告缺失的成品门禁。原生结果仍须绑定可信 Windows run/attempt/确切 SHA，不能把接收端 hash 检查改称 Windows 验收。

没有执行的检查不能写为 passed。`--native-smoke` 通过也不等于安装了 NSIS、运行了 Electron GUI、完成真实账号/模型或正式发布。

## 真实 Windows 验收分层

| 范围 | 所需证据；不能被什么替代 |
| --- | --- |
| 脚本/合同测试 | 准确源码身份、实际执行命令/平台、通过/失败/skip；fixtures 或测试通过不能证明本次最终包、安装目录或 GUI |
| 原生构建 | 当前源码身份、真实 Windows x64 工具链、固定 runtime、回归日志、打包与 verifier；不能用旧 CI、Linux smoke、配置存在或成功缓存替代 |
| 最终发行 payload | 从本次准确 NSIS 的内层 7z（或 macOS DMG/ZIP）取得资源，记录 artifact/payload/资源树摘要、包图、必要实例、文件数与逻辑字节；不是安装器生命周期或实际安装磁盘占用 |
| 所供 installed resources | `--installed-resources` 对整个所供 resources 树与当前 payload 精确绑定并记录来源 artifact；不证明实际安装、resources 外的完整安装内容、快捷方式/注册表或 GUI |
| native backend smoke | 最终提取资源或上述所供树中的 Node/PG/依赖/Effect 身份、初始化/登录/停止/重连，控制器仍为 checkout-built；不是已安装 Electron controller/GUI 验收 |
| 真实安装/升级/卸载 | 在批准的干净 Windows 测试账号/设备运行准确 SHA256 的 NSIS，确认位置/快捷方式/权限、资源核对、安装占用、升级数据身份和卸载保留数据；不对工作实例试验。基线与候选同为 0.1.0 时只能记同版本替换/重装，不称版本升级 |
| GUI 与备份恢复 | 真实 Electron 启动/页面/关闭/重连、私有数据目录与自有进程、同 OS 备份到新空实例恢复；HTTP 200 或 backend smoke 不能证明 GUI。`--data-dir` 不隔离固定 Electron userData/浏览器状态，应使用获准的独立测试账号 |
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

本节保留**上一轮手册编写阶段**的未执行范围：当时仅进行文档/源码/元数据/工具路径/磁盘/限定服务归属的只读调查及编写本手册，没有运行 build、lint、tests、formatters、dependency install、runtime smoke、GUI、真实账号调用、打包、3224 部署、commit、push、workflow dispatch、公开 Release 或签名配置。它不是对随后其他批次实际执行情况的改写。

历史交接曾记录 **main commit + 公开 push + unsigned Windows-only dispatch/下载获准但当时未执行**；该历史权限不自动沿用，当前依赖去重已有上方记录的新明确授权。新的交付报告必须独立给出授权阶段、完整源码身份/摘要、准确命令与退出码、真实原生范围、installer 及全部材料 SHA256、未执行安装/GUI/账号范围和来源/环境/分发阻塞。本批次获准使用 GitHub 托管 Windows 构建机制，但没有新增已登记 Windows/macOS host 或交互桌面，也未授权现有机器上的真实安装器/GUI 执行；不能用公共仓库可读、权限预检、历史 CI 或旧 artifact 补成当前 installer 已生成。桌面打包脚本/文档不生成 Linux 3224 运行产物，无运行时源码变化时保持既有服务、不重建或重启；实际入口归属/健康由协调验证 owner 只读记录。

### 旧安装器基线与仍需测量的证据

依赖展开调查使用的**历史 unsigned Windows x64 基线**来自 run `42425753593`、源码 commit `c8acf1409f0c98d65d9f176393783fc4ae71c18c`：`PM-Agent-v4-0.1.0-win-x64-unsigned.exe` 为 **914,109,877 bytes**，SHA256 `58a2533d392ea827bb5f83198d780132e5f613fc123806955d3a43952ae76962`；其内层 archive 有 **614,801 个普通文件、3,721,634,600 逻辑字节**。这是旧包的归档观察，不是当前去重实现的新原生构建、实际安装大小或 GUI 结果；不得拿旧 `dist/nsis/app-64.7z` 代替本次准确 EXE。

本次新安装器 bytes、最终 payload/安装树文件数与逻辑字节、实际磁盘占用、原生模块执行、同版本替换或版本升级的数据保留、卸载保留数据及 Electron GUI 均须绑定新源码/产物身份另行提供实测。Linux 的真实闭包物化/7z 重打包对比须标为隔离实验并记录输入身份、工具和范围；即使改善也不宣称已产出新 Windows 安装器或完成原生安装验收。会话/持久化仍沿用 Agent Chat，统一设计未收口，不随依赖体积修复改变。
