# Hermes Agent 桌面安装、升级、卸载与运行时生命周期基准评审

本页是只读对标评审，不是通过报告。结论来自对本地 checkout 的静态阅读；本机为 Linux，未运行 Hermes 的打包、签名、公证、安装器、更新器或卸载流程。所有 Windows/macOS 原生行为均标记为**未验证**；「观察」指源码/配置/工作流可见，「[推断]」指依赖工具默认行为。引用的行号对应下述 commit，后续提交会使行号漂移。

| 项 | 值 |
| --- | --- |
| 参考仓库 | `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/hermes-agent`（只读） |
| commit | `856e75808d1d6d985b06e9e882f2814ab4e4aa5d`（2026-11-08 11:55:30 -0800） |
| 许可证 | MIT（`LICENSE:1-2`，Copyright (c) 2025 Nous Research） |
| 桌面栈 | Electron（`apps/desktop/package.json`）、electron-builder、Tauri 引导安装器（`apps/bootstrap-installer`）、Python agent（`hermes_cli`、PM） |
| 平台产物 | Windows `msix`（`electron-builder.config.cjs:238`）、macOS `dmg`+`zip`（`:182`）、Linux `AppImage`（`:287`）；另有签名的 `Hermes-Setup.exe` / `Hermes-Setup.dmg` 引导安装器 |
| 更新机制 | stamp 中选择 `self` / `app-installer`（MSIX 外部分发）/ `electron-updater` / `external` / `microsoft-store`（`apps/desktop/electron/install-stamp.ts:85`） |
| Dovspace 评审基线 | commit `8b9dbaacaaf3d55d75c8e1dc4bc289eb2d3c7f00`；工作树含未提交的无关用户改动，本页只新增本文件 |
| 口径 | 「测试存在」≠「测试通过」；本页不声称任何测试本次通过，也不声称未观察到的原生行为 |

## 1. 执行摘要

1. Hermes 把**「谁能删除/替换这份安装」**做成了一等数据：构建期写入不可变 `install-stamp.json`，运行时只读该常量决定卸载模式、更新策略和安装形态；不靠探测 venv、payload 或 marker 猜测（`apps/desktop/electron/install-stamp.ts:1-12,114-137`）。这是最值得迁移的设计。
2. 卸载是**四级模型**：`gui`（只删 GUI）、`lite`（删 GUI+agent，保留数据）、`full`（全删）、`data`（只删数据）；桌面端只暴露前三者，`data` 被显式排除（`desktop-uninstall.ts:130,184-186`，`hermes_cli/subcommands/uninstall.py:15-27`）。真正执行的是 Python `hermes_cli.uninstall`，Electron 只负责生成一个**等待自身退出**的分离清理脚本（`desktop-uninstall.ts:20-28,347-479`）。
3. 所有权判定有两条独立防线：Electron 侧按 stamp 的 `distribution`/`payload`/`updateMechanism` 分类（`desktop-uninstall.ts:154-182`），Python 侧要求 `.git` 或可证明的 `distribution`，无 stamp 的 sealed tree 一律拒绝删代码（`hermes_cli/steward.py:210-240`，`tests/hermes_cli/test_uninstall_install_kind.py:56-119`）。非自有安装不给任何清理模式，只给 OS/包管理器指引（`desktop-uninstall.ts:197-240`）。
4. Windows 不是 NSIS：主产物是 MSIX，更新由 OS App Installer 应用；`Hermes-Setup.exe` 只是 Tauri 引导器，负责驱动 `scripts/install.ps1`（`apps/bootstrap-installer/src-tauri/tauri.conf.json:34-42`，`tests/install/README.md:135-143`）。仓库仍有历史 NSIS 假设的注释（`desktop-uninstall.ts:298`，`main.ts:3020`），但本检出没有 NSIS 构建配置或原生驱动。因此 Hermes **在本检出中没有** NSIS 注册表项、静默安装、覆盖安装或卸载器的原生证据；Dovspace 的 NSIS 路线必须自建这部分，不能照抄。
5. 升级 handoff 的证据链最完整：`applyPackagedHandoff` 在 teardown 前注册 relaunch，失败时恢复后端（`updater/packaged-handoff.ts:16-60`）；marker 记录 PID+进程创建时间防 PID 复用（`update-marker.ts:55-70,371-386`）；下载物按 pinned size/sha256 校验且禁重定向（`updater/artifact.ts:14-83`）。
6. **没有任何卸载 E2E**：`tests/install/*` 与本仓库 E2E 目录搜索不到 uninstall 驱动；跨 OS 的 `install-e2e.yml` 只在 release/手动通道运行，只覆盖全新机器安装 + 升级，不覆盖 NSIS/静默安装/注册表/快捷方式/卸载残留。另有 PR-time 的 Windows 原生 `install.ps1` + `hermes update` 走廊（`windows-install-update-e2e.yml` → `tests/e2e/core/windows_update`），覆盖崩溃中断与损坏 checkout 修复，但仍不覆盖卸载。`apps/desktop/electron/desktop-uninstall.test.ts` 是纯函数单测 + POSIX 脚本沙箱执行；Windows 脚本只有字符串断言，没有执行证据。
7. CI 的真实边界很强也很窄：`install-e2e.yml` 只在 release/手动触发（永不跑 PR），Linux 跑脚本安装，Windows 跑真实 `Hermes-Setup.exe` GUI + AutoHotkey，macOS 跑 DMG + 原生输入；`desktop-bundle-smoke.yml` 才在原生 runner 上真正 `Add-AppxPackage` / 挂载 DMG 并启动已安装产物。macOS 安装驱动会 `xattr -dr com.apple.quarantine`（`tests/install/macos-desktop-e2e.sh:208`），因此 **Gatekeeper 拦截路径未被验证**。
8. 对 Dovspace 的最高价值不是某段代码，而是四套「可证伪」的契约：安装戳/所有权、卸载模式与分离清理、数据保留快照对比（空快照拒绝为通过）、原生安装后身份/版本/进程/数据断言。Dovspace 当前缺的正是执行层证据：`verify-delivery.mjs` 明确输出 `installationExecuted: false`、`electronGuiExecuted: false`（`apps/desktop/scripts/verify-delivery.mjs:80,141-142`）。

## 2. 相关目录树（仅列本评审涉及区域）

```text
hermes-agent/
├── apps/desktop/
│   ├── electron-builder.config.cjs        # 唯一打包配置；win=msix, mac=dmg/zip, linux=AppImage
│   ├── electron/
│   │   ├── install-stamp.ts               # 构建期戳类型 + installShape()
│   │   ├── desktop-uninstall.ts           # 卸载模式/所有权/分离清理脚本
│   │   ├── desktop-installation.ts        # installationId + repair lock（非安装器）
│   │   ├── local-backend-lifecycle.ts     # 本地后端启动/停止/退出屏障
│   │   ├── package-process-reap.ts        # Windows 包根进程回收（仅 quit 路径）
│   │   ├── windows-remote-lifecycle.ts    # 远程 Windows 主机 SSH 生命周期（非本地）
│   │   ├── update-marker.ts               # 升级 marker + PID/创建时间判定
│   │   ├── bundle-swap.ts / bundle-skew.ts# 检测 bundle 被替换 / renderer 落后
│   │   └── updater/                       # 策略、artifact 校验、handoff、relaunch waiter
│   ├── e2e/
│   │   ├── core/{packaged-smoke,boot-lifecycle}.spec.ts
│   │   └── update/*.spec.ts               # Update now / first-run / build-fail / 并发
│   ├── scripts/{write-build-stamp,notarize,mac-sign,after-pack,batch-sign-binaries}.mjs
│   └── src/app/settings/uninstall-section.tsx
├── apps/bootstrap-installer/              # Tauri Hermes-Setup（Win exe / mac dmg）
├── hermes_cli/
│   ├── uninstall.py                       # 模式执行、服务停止、PATH/注册表/残留清理
│   ├── gui_uninstall.py                   # GUI-only：构建产物、应用包、Electron userData
│   ├── data_cleanup.py                    # 只删数据：受保护 runtime/sibling profile
│   └── steward.py                         # sealed tree 分类与拒绝文案
├── scripts/install.ps1 | install.sh       # 真正安装 agent/desktop 的脚本
├── tests/install/                         # 安装/更新 E2E 驱动与 fixture
├── tests/hermes_cli/test_uninstall_*.py   # 卸载语义单测（含 install-kind gate）
├── tests/scripts/test_verify_{user_state,plugin_preservation}.py
└── .github/workflows/{install-e2e*,desktop-*,e2e-desktop-*}.yml
```

## 3. 关键文件与符号

| 文件:行 | 符号/职责 | 证据类型 |
| --- | --- | --- |
| `apps/desktop/electron/install-stamp.ts:62-98,113-115` | `InstallStamp`：commit/source/distribution/updateMechanism/payload/runtime/tag；`freezeStamp` 冻结 | 观察 |
| `install-stamp.ts:114` | `INSTALL_STAMP` 由构建期 `__HERMES_INSTALL_STAMP__` 烘焙；dev 为 null | 观察 |
| `install-stamp.ts:133-137` | `installShape()`：`bundled` vs `checkout`，所有生命周期决策的唯一分叉 | 观察 |
| `apps/desktop/scripts/write-build-stamp.mjs:1-90` | 生成 `build/install-stamp.json`；CI/本地/fallback 三种来源；`git status -uno` 判 dirty | 观察 |
| `electron-builder.config.cjs:127-132` | `install-stamp.json` 作为 `extraResources` 旁车；bundle 另含 `agent-payload` | 观察 |
| `apps/desktop/electron/desktop-uninstall.ts:73-128` | IPC：`summary` / `openAppsSettings` / `run`；非自有安装返回 `externally-managed` | 观察 |
| `desktop-uninstall.ts:154-195` | `resolveInstallKind`、`installKindAllowsCodeRemoval`、`allowedUninstallModes` | 观察 + 单测 |
| `desktop-uninstall.ts:197-240` | 按 kind/OS 生成原生卸载指引（含 Linux AppImage 路径） | 观察 |
| `desktop-uninstall.ts:243-270` | 模式→`python -m hermes_cli.uninstall --mode`；非法模式抛错 | 观察 + 单测 |
| `desktop-uninstall.ts:272-345` | `resolveRemovableAppPath`：mac `.app` / win 安装目录 / AppImage / `*-unpacked` | 观察 + 单测 |
| `desktop-uninstall.ts:347-479` | POSIX/Windows 清理脚本生成：PID 等待、系统 Python、删 bundle、自删；Windows `rmdir` 最多 10 次 | 观察 + POSIX 执行测试 |
| `apps/desktop/electron/desktop-installation.ts:63-266` | installationId 原子创建；repair lock 以 PID+创建时间判活，rename 认领防误删 | 观察 + 12 项单测 |
| `apps/desktop/electron/package-process-reap.ts:71-300` | `isSharedRuntime`、`isUnderInstallRoot`、`protectedRuntimePids`、`reapPackageRootedProcesses` | 观察 + 单测 |
| `apps/desktop/electron/local-backend-lifecycle.ts:5-119` | `waitForTeardown` 有界等待；`createLocalBackendLifecycle` 跟踪 start/child/stop，退出后禁止新 spawn | 观察 + 单测 |
| `apps/desktop/electron/updater/packaged-handoff.ts:16-60` | 先注册 relaunch 再 teardown；失败按序 cancel/restore 并聚合错误 | 观察 + 单测 |
| `apps/desktop/electron/updater/artifact.ts:14-83` | pinned size/sha256、`redirect: 'error'`、0600 临时文件、fsync、下载后再校验 | 观察 + 单测 |
| `apps/desktop/electron/updater/app-installer.ts:65-140` | MSIX 策略：OS 拥有应用；check 未知不得报「无更新」 | 观察 + 单测 |
| `apps/desktop/electron/app-installer-file.ts:5-52` | `.appinstaller` 描述符 ≤1 MiB、禁重定向、原子 rename | 观察 |
| `apps/desktop/electron/update-marker.ts:55-70,371-437` | marker 最大年龄、handoff claim 超时、PID 存活/创建时间、僵尸态 | 观察 + 多处单测 |
| `hermes_cli/uninstall.py:71-97` | `code_removal_refusal` / `_refuse_if_steward_owned` | 观察 + 单测 |
| `uninstall.py:458-486` | macOS launchd/缓存/XDG 残留清理范围 | 观察 + 单测（darwin-only skip） |
| `uninstall.py:643-686` | `run_data_uninstall`：plan → 确认 → quiescent → remove | 观察 + 单测 |
| `uninstall.py:689-755` | `run_gui_uninstall`：dry-run、确认、审计输出 | 观察 |
| `uninstall.py:757-899` | `run_uninstall`：交互 1 Keep data / 2 Full / 3 Cancel | 观察 |
| `uninstall.py:1003-1100` | `_perform_uninstall`：停 gateway→PATH/注册表→wrapper→GUI→残留→checkout→便携工具→home | 观察 |
| `hermes_cli/gui_uninstall.py:27-174` | userData 路径、已安装应用路径、`uninstall_gui(remove_userdata=...)` | 观察 |
| `hermes_cli/data_cleanup.py:18-103` | 数据删除计划：拒绝根/家目录；保护 runtime、canonical source、sibling profile | 观察 + 单测 |
| `hermes_cli/steward.py:210-240` | `.git` 或 stamp `distribution` 决定 sealed steward | 观察 + 单测 |

### 3.1 生命周期总览（按代码顺序）

**安装（脚本/引导器）**：`Hermes-Setup`（Tauri）或用户执行 `scripts/install.ps1|install.sh` → 解析 `HERMES_HOME`/`InstallDir` → 下载/克隆 agent → 创建 venv 与 PM 工具链 → 可选构建 desktop → 写 `install-stamp.json` → 写 PATH/env/wrapper/快捷方式。没有卸载注册表写入，也没有「安装完成」的系统级事务。

**安装（MSIX/打包 app）**：构建期写 `build/install-stamp.json` → `bundle-electron-main` 烘焙常量 + `extraResources` 旁车 → `afterPack` 批量签名/公证 → OS 安装。启动时 `INSTALL_STAMP` 决定 `bundled`/`checkout`；`detectBundleSwap` 只做替换检测。

**运行**：Electron `app.whenReady` → 读配置/`installShape` → bundled 直接启动 payload；checkout 启动本地后端或 bootstrap → `createLocalBackendLifecycle` 记录 start/child → 健康检查/首次对话 → `boot-lifecycle.spec.ts` 断言恰好一个后端、退出无孤儿。

**升级**：用户点 Update → 下载并 pinned 校验 artifact（`artifact.ts`）→ 注册 relaunch marker → `stop()` 停后端/交接 → OS 或脚本应用 → 新进程启动消费 marker → 校验新 stamp/commit/version；失败则 `restore()` 并保留旧安装可运行。

**卸载**：Settings → About → 选模式 → IPC `hermes:uninstall:run` → 生成分离脚本（等 PID、系统 Python、删 bundle/数据）→ `app.quit` → 脚本执行 `hermes_cli.uninstall --mode ...` → 停 gateway、清 PATH/注册表/wrapper/GUI/残留/checkout/home → 自删脚本。

**数据**：`data`/`full` 先 `plan_data_removal`（拒绝根/家目录，保护 runtime/sibling/canonical source）→ `quiescent_home` 确认无占用 → 删除或保留；升级路径用 snapshot/verify 保护用户状态与插件树。

## 4. 安装形态与所有权

### 4.1 平台安装形态（观察）

| 平台 | 实际形态 | 由谁安装/更新/删除 |
| --- | --- | --- |
| Windows | `msix` 主产物 + 可选 `Hermes-Setup.exe`（Tauri 引导器，驱动 `scripts/install.ps1`） | MSIX：OS/App Installer；脚本安装：应用自身（`standard`） |
| macOS | `dmg`/`zip` 主产物 + `Hermes-Setup.dmg` 引导器 | `.app` 拖入 Applications 属 `bundled`；脚本安装属 `standard` |
| Linux | `AppImage` + 脚本安装 | AppImage：用户文件；脚本安装：`standard` |

关键事实：当前 electron-builder 的 Windows target 是 `msix`（`electron-builder.config.cjs:236-243`），不是 NSIS；MSIX 由 OS 出现在 Apps & Features【推断：Windows 平台行为，本机未验证】。脚本安装路径 `scripts/install.ps1` 安装到 `%LOCALAPPDATA%\hermes`，只写 PATH/env 和快捷方式（`scripts/install.ps1:28-29,1568-1615`），不写卸载注册表项。因此「Windows NSIS 卸载注册表项/静默安装/覆盖安装」在 Hermes **没有可借鉴实现**。

### 4.2 install stamp 的生命周期

1. `scripts/write-build-stamp.mjs` 写 `build/install-stamp.json`，字段含 `schemaVersion`、`commit`、`dirty`、`source`、`distribution`、`updateMechanism`、`payload`、`runtime`、`channelBuild`。
2. `bundle-electron-main.mjs` 把该 JSON 作为 `__HERMES_INSTALL_STAMP__` 常量烘焙进主进程包；同时 `extraResources` 复制旁车文件（`electron-builder.config.cjs:127-132`）。
3. 运行时 `INSTALL_STAMP` 只读、冻结；`installShape()` 决定走 bundled 还是 checkout 分支。旁车文件**不用于选择运行时**，只用于检测安装目录被替换：`detectBundleSwap` 比较启动时与当前磁盘上的 commit/`builtAt`（`bundle-swap.ts:36-70`）。
4. 版本 skew 另有只读检测：`detectBundleSkew` 用 `git merge-base`/`rev-list` 判断 renderer 是否落后于运行时路径（`bundle-skew.ts:76-180`），失败时 fail-quiet，不误报。

### 4.3 所有权判定（Q2）

- Electron：`resolveInstallKind` 优先级 `distribution==='nix'` → `payload in {bundled, light}` → `updateMechanism==='external'` → 否则 `standard`（`desktop-uninstall.ts:154-177`）。只有 `standard` 允许删代码；`allowedUninstallModes` 对非 standard 返回空数组（`:184-186`）。
- Python：`classify_install` 要求项目根有 `.git`，或 stamp 的 `distribution` 属于已知 steward；两者都不满足则拒绝（`steward.py:210-240`；测试 `test_uninstall_install_kind.py:56-119`，含「无 stamp 的 sealed tree 仍拒绝」）。
- **不删包管理器文件**的做法不是「识别文件属于谁」，而是「不接管非自有安装」：Nix 让用户改 flake；`external` 让用户用原包管理器；`bundled` 让用户走 OS（Windows Apps & Features / macOS 废纸篓 / 删除 AppImage）（`desktop-uninstall.ts:197-240`）。
- 数据删除也有保护：`plan_data_removal` 拒绝整个文件系统或家目录；保护 bundled payload、canonical `hermes-agent`、sibling profile、`installs/`、`bin/hermes.cmd`、共享 tool-store（`data_cleanup.py:18-79`）。

## 5. 卸载级别：定义、实现、测试（Q1）

| 级别 | 用户语义 | 代码 | 删除内容 | 保留内容 | 测试 |
| --- | --- | --- | --- | --- | --- |
| `gui` | 只卸 GUI | `run_gui_uninstall`（`uninstall.py:689`）；`uninstall_gui`（`gui_uninstall.py:136`） | 构建产物、已安装 `.app`/目录、Electron userData | agent、venv、config、sessions、`.env` | `test_gui_uninstall.py`、`test_uninstall_gui_userdata.py`（回归：keep-data 不得删 userData）、`test_gui_uninstall_retention.py`（dry-run 与删除都保留 agent source/venv/shared node_modules/config/.env/sessions） |
| `lite`（默认 Keep data） | 卸 GUI+agent，保留数据 | `run_uninstall` 交互选项 1；桌面 `--mode lite` | code checkout、GUI、PATH/注册表/wrapper、node 符号链接、便携工具；**不删** userData | `$HERMES_HOME`（config/sessions/.env/logs）、Electron userData | `test_uninstall_dry_run.py`、`test_uninstall_leftovers.py`、`test_uninstall_shell_configs.py`、`test_uninstall_windows_bin_launchers.py` |
| `full` | 全删 | 交互选项 2；`--mode full` | lite 的全部 + `$HERMES_HOME` + userData + macOS launchd/缓存/XDG data | 无（named profiles 默认保留，需二次确认） | `test_uninstall_full_wipe_sweep.py`（darwin-only）、`test_uninstall_gateway_service.py` |
| `data` | 只删数据，保留代码 | `run_data_uninstall`（`uninstall.py:643`） | 当前 home 的用户数据 + userData | 已安装 runtime、sibling profiles、canonical source | `test_data_uninstall.py`、`test_data_uninstall_holders.py`、`test_cmd_uninstall.py`（确保 data 入口永不走代码删除） |

桌面端**不提供 `data`**：`allowedUninstallModes` 只返回 `gui/lite/full`，`run` 对 `data` 返回 `invalid-mode`；注释明确「包括 CLI 的 data-only 模式在内，任何模式都不安全，因为清理脚本总是删 bundle」（`desktop-uninstall.ts:181-195`）。这与「桌面清理永远删 GUI」的产品语义一致，但与 CLI 的 data-only 能力不对称，属于有意取舍而非遗漏。

清理执行细节（观察）：
- 分离脚本先等待桌面 PID 退出（POSIX ≤30s，Windows 计数 60 次、精确 PID 过滤），再由**venv 外**的系统 Python 执行 `python -m hermes_cli.uninstall`，最后删 bundle；Windows 额外重试 `rmdir /s /q` 10 次（`desktop-uninstall.ts:347-479`）。
- POSIX 脚本在测试中真实执行（`desktop-uninstall.test.ts:187-235`，skip win32）：验证 argv、`HERMES_HOME`、`PYTHONPATH`、bundle 删除、兄弟目录保留、脚本自删。Windows 脚本只有字符串断言（`desktop-uninstall.test.ts:264-303`），**未在 Windows 执行**。
- GUI summary 由本机 stamp 决定，不信任远端 backend 的安装事实（`desktop-uninstall.ts:94-121` 注释与实现）。

## 6. 升级 handoff、进程回收与本地后端生命周期（Q3）

### 6.1 handoff

- `applyPackagedHandoff`（`updater/packaged-handoff.ts:16`）：`stop()` 先 `relaunch.register()`，注册失败则不 teardown；teardown 已开始后任何错误都会 `restore()`，并抛出 `AggregateError`。单测覆盖「handoff 错误保留 cleanup 失败同时恢复后端」（`updater/app-installer-recovery.test.ts:101`）。
- marker：`markerPath` + `UPDATE_MARKER_MAX_AGE_MS` + `HANDOFF_CLAIM_TIMEOUT_MS`；`lockHolderIsLiveSync` 用 PID + 进程创建时间（Linux `/proc`、macOS `ps lstart`、Windows dotnet ticks）避免 PID 复用误判（`update-marker.ts:55-70,164-386`）。
- relaunch：每个安装写自己的 marker（`relaunch-isolation.test.ts:56,95`）；waiter 是随包 PowerShell 资源（`electron-builder.config.cjs:242`），生命周期/日志/取消均有单测（`relaunch-waiter-lifecycle.test.ts:191-269`）。
- 下载完整性：`downloadPinnedArtifact` 先尝试复用已存在且校验通过的文件；新下载到 `*.partial`（0600），超 pinned size 立即失败，`fsync` 后再次校验再 rename（`artifact.ts:33-83`）。单测存在；未在真实网络执行。

### 6.2 进程回收

- `reapPackageRootedProcesses` **只在 Windows、且仅在 quit 路径**运行；调用点只把 bundled 形态的 `process.resourcesPath` 作为 root，checkout 形态传 null（`main.ts:11347-11377`）；`installRoots` 为空则完全跳过（`package-process-reap.ts:238-300`）。
- 保护边界：共享解释器/入口（`python*`、`node`、`hermes*`）、路径或命令行不可读的进程、以及它们的全部后代都不杀（`package-process-reap.ts:71-80,188-236`）。路径匹配做分隔符/大小写归一，避免 `HermesBundled_0.21` 误杀 `0.21.20`（`:143-186`）。
- 枚举用 `Get-CimInstance Win32_Process`，10s 硬超时，失败返回空列表并记录日志，不阻塞退出（`:90-140`）。
- 测试：`package-process-reap.test.ts` 10 项，覆盖前缀陷阱、多 root、null root、kill 失败后继续、解析含管道/空格的命令行、隐藏窗口与超时参数。**没有**原生 Windows 退出 E2E 断言「进程确实消失」。

### 6.3 本地后端生命周期

- `createLocalBackendLifecycle` 维护 `AbortController`、进行中的 start、已 spawn 的 child、每个 child 的 stop promise；`shutdown` 由 `createBackendShutdownCoordinator` 保证单次执行（`local-backend-lifecycle.ts:44-119`）。
- `waitForTeardown` 对每个 task 做有界等待，超时后仍返回，避免退出被丢失的回调永久挂起（`:5-25`）。
- 测试 6 项：shutdown 加入已移除的 start、阻止 late spawn、异步 claim 前保留 child、启动忽略取消仍有界、真实首启取消 + 本地/SSH 双 drain、退出 abort 标记为预期 shutdown（`local-backend-lifecycle.test.ts:23-184`）。
- 原生验证在 Linux 的 `e2e/core/boot-lifecycle.spec.ts`：连续采样 `/proc` 中带 sandbox `HERMES_HOME` 的进程，断言 kill -9 后端后恰好一个替补、退出后 Electron 进程全消失、恰好一个 gateway 仍在、重复启动只 attach 同一 gateway（README 描述 + spec 头注释）。该测试**只在 Linux CI 运行**，未覆盖 Windows PG/Node 子进程。

## 7. 数据生命周期与防误删

| 场景 | 机制 | 证据 |
| --- | --- | --- |
| 升级保留用户状态 | 每次升级 leg 前后快照/对比：`.env`、`auth.json`、`state.db`（按行数而非字节）、`memories/`、`cron/`、`sessions/`、`profiles/`、`plugins/**` 等；删除或修改即失败 | `tests/install/README.md:189-267`；`e2e-assets/verify-user-state.py`（689 行）、`verify-plugin-preservation.py`（320 行）；单测 `tests/scripts/test_verify_user_state.py`（605 行） |
| 空快照不得算通过 | verifier 拒绝空快照为「inconclusive」；fixture 已存在时拒绝重播种 | 同上 README；`preserve-user-state.sh` |
| 只删数据 | plan 保护 runtime/sibling/canonical source；`quiescent_home` 要求无进程占用后才删 | `data_cleanup.py:18-103`；`test_data_uninstall.py`、`test_data_uninstall_holders.py` |
| keep-data 不删 userData | 专门回归 #122548：`_perform_uninstall` 必须传 `remove_userdata=full_uninstall` | `test_uninstall_gui_userdata.py:1-20` |
| 卸载后残留 | 停 gateway（systemd/launchd/Windows）、清 PATH/注册表 env、wrapper、node 符号链接、macOS caches/launchd | `uninstall.py:234-486,1003-1100`；对应 6 个单测文件 |
| 应用数据隔离 | `desktop_userdata_dir()` 与 `$HERMES_HOME` 分离；`data` 模式可选传 `--desktop-userdata` | `gui_uninstall.py:27-33`；`uninstall.py:643-686` |
| GUI 卸载保留 agent 状态 | 临时文件系统 fixture 断言 dry-run 与 `--gui --yes` 都保留 agent source/venv/`node_modules`/config/`.env`/sessions，只删 GUI 产物/userData | `tests/hermes_cli/test_gui_uninstall_retention.py:1-83` |

注意：Hermes 有**临时文件系统级**的保留/删除单测（`test_gui_uninstall_retention.py`、`test_data_uninstall*.py`），但**没有**「真实安装 → 卸载 → 检查数据/残留」的原生 E2E；升级路径的 snapshot/verify 也不覆盖卸载。

## 8. CI 与安装 E2E 实际执行了什么（Q4）

### 8.1 工作流与驱动

| 工作流 | 触发 | 实际执行 | 不证明 |
| --- | --- | --- | --- |
| `install-e2e.yml` | 仅 `workflow_call`（stable release）与手动；**永不 PR/push/schedule** | 从 release tags 采样 OLD，展开 `{os, install-method, update-method}`，分发到各 OS run workflow | 未运行的 leg 显示 skipped；工作流绿色不等于每个组合都跑过（README 明确） |
| `install-e2e-run.yml`（Linux） | 被调用 | `curl \| bash` 脚本安装；`serve.git` 本地裸克隆重定向；旧 release → HEAD/NEXT 升级；`hermes update` / app update | 无桌面安装器物证；Linux 仅有 AppImage/源码形态 |
| `install-e2e-windows-run.yml`（Windows） | 被调用 | `windows-e2e.ps1` 四阶段 `stage/install/update/verify-stamp`；`desktop-installer@latest` 用 AutoHotkey 点 `Hermes-Setup.exe`，`open-app-update` 用 Playwright 点 “Update now” | 无静默安装、无覆盖安装、无注册表/快捷方式/卸载断言 |
| `install-e2e-macos-run.yml`（macOS） | 被调用 | 脚本安装共用 driver；`desktop-installer@latest` 挂载 `Hermes-Setup.dmg` 并用原生输入点安装；`macos-bundled-e2e.sh` 用真实签名 zip/feed 做 packaged update | `xattr -dr com.apple.quarantine` 绕过 Gatekeeper；脚本 leg 不验公证 |
| `desktop-bundle-smoke.yml` | 被 `desktop-bundled-release.yml` 调用 | 原生 runner 下载已准入字节，Windows `Add-AppxPackage`、macOS DMG 挂载/ZIP 解压，校验 ident/version/exe/stamp，再跑安装后 chat smoke；Windows 卸载只清自己装的 package | 只对已签名 bundle；不覆盖脚本安装、不覆盖卸载用户数据 |
| `e2e-desktop-core.yml`（Linux） | 被调用 | 真实 Electron + 真实 `hermes serve` + 脚本化 LLM；`packaged-smoke.spec.ts`（asar unpack 契约 + packaged 首聊）、`boot-lifecycle.spec.ts`（进程 census/孤儿） | 不执行安装器；packaged smoke 只跑 `linux-unpacked`，且后端指向检出而非 bundle |
| `e2e-desktop-update.yml`（Linux） | 被调用 | 真实本地安装（`install.sh` + `hermes desktop --build-only`），Playwright 覆盖 first-run、Update now、build-fail、并发拒绝 | 不覆盖 Windows/macOS；不覆盖卸载 |
| `windows-install-update-e2e.yml` | PR（classifier 命中 install/update 代码）、push main、手动 | 真实 `scripts/install.ps1`（fake 用户 profile、PATH 无 git/python/uv、git 重定向）→ `hermes update` HEAD→NEXT；`tests/e2e/core/windows_update/test_*.py` 覆盖 fresh install、首轮对话、gateway 跨升级、崩溃注入（fetch/git/写 launch/移动 tree/handoff 中途被杀）、损坏 checkout 重装修复、提权 gateway 拒绝 | 仍不覆盖 NSIS/静默安装/覆盖安装/卸载；部分已知 bug 以 message-gated xfail 记录（`strict_acceptance` 才强制失败） |

### 8.2 证据分级

- **存在且有明确断言**：install-stamp 在安装包内的 commit/version/identity 校验（`tests/install/windows-bundle-smoke.ps1:49-88`）；MSIX 签名 `Get-AuthenticodeSignature`；macOS `codesign`/team/identity/stamp（`macos-bundled-e2e.sh:210,356`）；升级后用户/插件状态快照；packaged asar unpack 契约（`packaged-smoke.spec.ts:1-30`）；本地后端孤儿进程（`boot-lifecycle.spec.ts:1-25`）；Windows 原生安装/升级崩溃注入与重装修复（`tests/e2e/core/windows_update/test_crash_cells.py:782-870`、`test_damaged_checkout.py:54-68`）。
- **存在但本次未运行**：上述所有原生 leg；本页不声称任何 run 通过。`js-tests.yml` 通过 `run-workspace-checks.mjs` 运行所有 workspace check（含 desktop 的 lint/ui/electron 套件），但本次未执行。
- **不存在**：卸载 E2E、NSIS 覆盖安装/静默安装断言、NSIS 注册表断言、Gatekeeper 拒绝路径、备份加密验收、SBOM 产物、PostgreSQL 大版本升级验收。

## 9. 迁移判定：哪些能用于 Dovspace（Q5）

| Hermes 机制 | 可迁移性 | 理由 / Dovspace 对应 |
| --- | --- | --- |
| 不可变 install stamp + `installShape` | **高** | 与语言无关；Dovspace 已有 `desktop-package.json` 身份，可把 stamp 烘焙进 `apps/desktop/dist` 并在 `extraResources` 放旁车 |
| 安装类型 → 卸载模式 gate | **高** | 纯策略函数；Dovspace 需把 `standard/bundled/external` 映射成 NSIS per-user 安装 vs 便携/开发 |
| 分离清理脚本（等 PID 退出 → 执行删除 → 删自身） | **高** | NSIS 卸载器无法删除正在运行的 `$INSTDIR`【推断：Windows 文件锁行为】；Dovspace 需 stop PG/Node 后再删，脚本模式可直接复用 |
| 四模式数据边界（gui/lite/full/data） | **高** | 直接对应 Dovspace「只删应用 / 删应用+运行时保留数据 / 全删 / 只删数据」 |
| 数据保留 snapshot/verify（拒绝空快照） | **高** | 可复用到 Dovspace 的 `dataDir`、`%APPDATA%\PM Agent v4`、PG 数据目录、`.pm` 文件 |
| 原生安装后身份/版本/stamp 校验 | **高** | Dovspace 已有 `inspectInstalledApplication`/`verifyInstalledApplication` 可复用，只缺「真实安装目录」输入 |
| PR-time 原生安装/升级崩溃注入与修复 | **高** | `tests/e2e/core/windows_update/test_crash_cells.py` 的「中途被杀仍可运行」模型可直接映射为 Dovspace 的 PG/Node 升级中断；Dovspace 需把 gateway 断言换成 PM/Agent/PG 健康与数据完整性 |
| 进程回收（install-root + 保护共享 runtime） | **中** | 思路可迁移；但 Dovspace 的子进程是 Node/PG，需改为按 pid 文件/`pg_ctl` 所有权停止，不能按镜像名 sweep |
| relaunch marker + PID 创建时间 | **中** | Dovspace 目前无自动更新；若做升级 handoff，可直接复用该判定 |
| bundle swap/skew 检测 | **中** | 依赖 git 工作树；Dovspace 的 `workspace-runtime` 是固定闭包，需要改为对 `desktop-package.json` stamp 比较 |
| Python venv 自删 / `hermes_cli.uninstall` | **低** | Dovspace 无 Python agent；PG 停机和 Node 进程停止必须自己实现 |
| MSIX/.appinstaller / AppImage / macOS 原生指引 | **低** | 平台形态不同；Dovspace Windows 是 NSIS，macOS 是 DMG/ZIP |
| `windows-remote-lifecycle.ts`（SSH） | **不适用** | Dovspace 当前仅本地工作台；不要引入远程主机生命周期 |
| Tauri `Hermes-Setup` 引导器 | **低** | Dovspace 已有 NSIS；引导器会再引入一套 WebView/签名链 |

## 10. Dovspace 对照矩阵（P0/P1）

Dovspace 现状基线：Electron 45.0.0 / electron-builder 26.18.0；Windows x64 NSIS per-user、unsigned；macOS DMG/ZIP（ad-hoc 视为 unsigned）；Linux 不发布；bundled Node 24.21.0 + PostgreSQL 16.15；`deleteAppDataOnUninstall: false`（`apps/desktop/electron-builder.config.mjs:62-76`）。

| 审计项 | Hermes 证据 | Dovspace 现状 | 差距/优先级 |
| --- | --- | --- | --- |
| Windows 安装/覆盖/静默安装 + 真实 NSIS 日志/目录/注册表 | 无 NSIS，只有 MSIX/引导器 + 脚本安装 E2E | 无任何安装执行 E2E；`verify-delivery` 明示 `installationExecuted:false` | **P0**：新建 NSIS 原生 E2E |
| macOS 签名/公证/Gatekeeper | `notarize.mjs` afterSign + stapler；bundle smoke 验 codesign；桌面 driver 绕过 quarantine | 配置有 signed 分支但未验证；unsigned ad-hoc | **P1**：签名 job + `spctl`/`stapler` 断言 |
| Linux 打包 | AppImage + 脚本安装 | 不发布桌面 | 不适用（保持） |
| Node/PostgreSQL/Agent 进程生命周期 | `local-backend-lifecycle` + reap + Linux boot-lifecycle | `local-server`/`managed-postgres` 已有 stop/所有权；无原生退出 E2E | **P0**：进程停止/回收的 Windows E2E |
| 安装文件/依赖裁剪与体积基线 | MSIX 打包 + 安装后 stamp；不裁 PG | 39,809 文件/1,023,987,590 B；45k 上限；无安装后实测 | **P1**：安装后测量 + 预算下调 |
| Electron sandbox/IPC/CSP/导航隔离 | main 进程大量隔离逻辑（未逐条审计） | `securePreferences`（sandbox/contextIsolation/nodeIntegration=false）+ `policy.mjs` + 窗口帧信任 | 已有；补 CSP/导航回归即可（P1） |
| runtime 目录与 Agent 文件执行权限 | `normalizeInstallationModes`/私有状态/ACL 测试 | `private-state.mjs` + platform tests；Windows ACL 未原生验证 | **P1** |
| 更新包签名/完整性 | pinned size/sha256 + MSIX OS 校验 + Azure 签名 | 无 updater、无 feed；仅 `SHA256SUMS` | **P0/P1**：先决定是否做更新 |
| 跨版本升级/数据迁移/失败恢复 | 升级 E2E + user-state/plugin preservation + handoff restore | 无升级执行证据；备份恢复仅到空实例（guide:38） | **P0** |
| 卸载服务停止/文件锁/残留 | 分离脚本 + PID 等待 + Windows rmdir 重试 + Python 残留清理 | NSIS 默认 `RMDir /r`；无 stop/重试/残留断言 | **P0** |
| 用户数据保留/删除/防误删 | 4 模式 + plan 保护 + 空快照拒绝 | 仅 `deleteAppDataOnUninstall:false`；无模式/测试 | **P0** |
| 原生安装 E2E | release-only 矩阵 + 原生 bundle smoke | 无 | **P0** |
| SBOM/漏洞/许可扫描 | OSV 周扫（`osv-scanner.yml`，不阻塞合并）；许可材料 | `license-notices.mjs`/legal 包；无 SBOM/OSV | **P1** |
| 备份加密/恢复/隐私 | 无加密证据（本页未发现备份加密） | 备份不加密（guide:38），恢复仅空实例 | **P1** |

## 11. Dovspace 落地切片（每项含目标文件与验收证据）

### P0-1 安装身份戳与所有权门禁

- 目标：新增 `apps/desktop/scripts/install-stamp.mjs`（构建期写 `install-stamp.json` + 校验字段），新增 `apps/desktop/src/install-stamp.mjs`（运行时只读、冻结、`installShape()`）；在 `apps/desktop/scripts/package.mjs` 的 `afterPack` 把 stamp 放入 `resources/`；在 `apps/desktop/scripts/final-artifact.mjs`/`verify-delivery.mjs` 把它纳入成品摘要。
- 验收：`apps/desktop/scripts/final-artifact.test.mjs` 新增「缺 stamp / commit 不匹配 / 字段非法即失败」；`desktop-package.json` 记录 stamp sha256；原生安装后 `verifyInstalledApplication` 读到同一 commit，且 `desktop-verification.json` 输出 `installationExecuted:true`（当前为 false，见 `verify-delivery.mjs:80,141-142`）。

### P0-2 卸载模式与数据保留

- 目标：新增 `apps/desktop/src/uninstall-plan.mjs`（纯函数：mode + stamp → 删除/保留清单）、`apps/desktop/src/uninstall.mjs`（写分离脚本、等 PID、调 `pg_ctl stop`、删 `$INSTDIR`/快捷方式/注册表、自删）；在 `apps/desktop/src/main.mjs` 的 `desktopAction` 增加 `uninstall-plan`/`uninstall-run`，在 `apps/desktop/src/preload.cjs` 暴露只读摘要；连接窗口渲染层加确认页。
- 模式：`app-only`（保留数据）、`app+runtime`（保留数据）、`full`（删 `%APPDATA%\PM Agent v4` 与 dataDir）、`data-only`（保留安装）。
- 验收：`apps/desktop/src/uninstall-plan.test.mjs` 覆盖四模式 × stamp kind 的 golden 清单；`main.close.test.mjs` 增加「维护/备份中拒绝卸载」「非自有安装拒绝」；新增 `apps/desktop/src/uninstall-data-retention.test.mjs`，对 dataDir、`%APPDATA%\PM Agent v4`、PG 数据目录做 snapshot/verify（保留模式不得少文件/少行，删除模式必须清空），空快照判失败；Windows 原生 E2E 断言卸载日志、`$INSTDIR` 不存在、快捷方式/`HKCU\...\Uninstall\PM Agent v4` 不存在、`%APPDATA%`/dataDir 按模式保留或删除。

### P0-3 进程停止与回收

- 目标：扩展 `apps/desktop/src/local-process.mjs`（所有权记录、pid 文件、创建时间）、`apps/desktop/src/managed-postgres.mjs`（已有 `stopOwnedProcess`/`stopWindowsOwnedProcess`，补「卸载/升级前停机」入口）、新增 `apps/desktop/src/process-guard.mjs`（Windows 仅按安装根 + 已知 pid/创建时间回收，不按镜像名 sweep）。
- 验收：`apps/desktop/src/local-process.test.mjs`、`managed-postgres.test.mjs` 新增「升级/卸载前所有 owned 进程退出」「重复 stop 幂等」「pid 复用不误杀」；Windows E2E 在卸载/覆盖安装后用 `Get-CimInstance` 断言安装根下无进程、PG 数据目录可删除。

### P0-4 原生安装/升级/卸载 E2E

- 目标：新增 `.github/workflows/desktop-install-e2e.yml`（`workflow_dispatch` + `workflow_call`，`windows-2025`、`macos-15`；默认不发布）；新增 `apps/desktop/scripts/install-e2e/windows.ps1` 与 `macos.sh`（或 `tests/desktop-install/`），复用 `apps/desktop/scripts/final-artifact.mjs` 的 `inspectInstalledApplication`/`verifyInstalledApplication`。
- Windows 断言：assisted 安装（`oneClick:false`）与 `/S` 静默安装；自定义安装目录；同版本覆盖安装；N→N+1 升级；`DisplayVersion`/`InstallLocation`/`UninstallString`；文件数 ≤45,000；启动已安装 exe 完成一次本地登录/健康检查；卸载后目录/快捷方式/注册表清理，数据按模式处理。
- macOS 断言：DMG 挂载 + `ditto`/拖拽安装；`codesign --verify --deep --strict`；`spctl -a -t exec`（signed job）；`stapler validate`；升级保留 `~/Library/Application Support/PM Agent v4`；卸载只删 `.app`。
- 验收：每次 run 产出 `install-e2e-receipt.json`（artifact sha256、安装前后目录树摘要、进程表、注册表/数据目录快照），并把它绑定到 `desktop-verification.json`；失败必须保留日志/截图。另加崩溃注入（参考 `tests/e2e/core/windows_update/test_crash_cells.py:782-870`）：在停机、复制、切换 `current`、注册卸载项之间强杀，重启后旧版本必须仍可运行且数据未半迁移。

### P1-1 升级 handoff、失败恢复与 PG 版本守卫

- 目标：新增 `apps/desktop/src/update-handoff.mjs`（pending-relaunch marker、PID+创建时间、失败 restore、PG major version 检查），在 `apps/desktop/src/main.mjs` 的 `finishQuit`/启动路径接入；不做自动下载前，先做「本地安装包原地升级」。
- 验收：`apps/desktop/src/main.close.test.mjs` 增加「handoff 注册失败不 teardown」「teardown 后失败 restore」「marker 过期/其他安装不消费」；原生 E2E 升级中断后旧版本仍可启动、PG 数据未被半迁移破坏。

### P1-2 packaged smoke 与孤儿断言

- 目标：新增 `apps/desktop/e2e/packaged-smoke.spec.ts`、`boot-lifecycle.spec.ts`（Playwright），以**最终安装产物**启动，使用隔离 `HOME`/`HERMES_HOME` 等价物，验证首聊/健康检查、退出后无 Node/PG 孤儿。
- 验收：CI job（Linux 或 Windows）在真实 runner 运行；断言 `installationExecuted:true`、进程表为空、数据目录未被清空；测试失败不得用 `win-unpacked` 代替安装目录。

### P1-3 SBOM、漏洞与许可

- 目标：新增 `apps/desktop/scripts/sbom.mjs`（PM/Agent/Electron 三个物理闭包分别列出）、`.github/workflows/security-scan.yml`（OSV 扫 `pnpm-lock.yaml` + runtime manifest，SARIF 上传）；扩充 `apps/desktop/scripts/license-notices.mjs` 校验。
- 验收：SBOM 含三闭包且与 `desktop-verification.json` 的 runtime inventory 对齐；OSV 结果进入 Security tab；发布材料仍保留 `desktop-legal.tar.gz`。

### P1-4 备份加密与恢复隐私

- 目标：`apps/desktop/src/backend/maintenance-files.mjs` + `apps/desktop/src/maintenance.mjs` 增加可选加密（密钥不落盘/由用户口令派生），manifest 记录算法与 KDF 参数；恢复拒绝被篡改/跨 OS 归档。
- 验收：`apps/desktop/src/backend/maintenance-files.test.mjs` 增加「错误口令失败且不写目标」「篡改归档失败」「相同 OS 限制」；指南明确默认不加密的现状与风险。

### P1-5 macOS 签名/公证闭环

- 目标：`apps/desktop/electron-builder.config.mjs`（signed 分支）、`apps/desktop/scripts/package.mjs`、新增 `apps/desktop/scripts/notarize.mjs`；`.github/workflows/desktop.yml` signed job 增加 `codesign`/`spctl`/`stapler` 断言。
- 验收：signed run 的 `desktop-verification.json` 记录 `codesign`/`spctl`/`stapler` 实际输出；缺失凭据 fail closed；unsigned 继续显式标注，不进入公证分支。

## 12. 不可照搬、许可与安全边界

**不要照搬**
- `hermes_cli.uninstall` 的 venv/Python 自删逻辑：Dovspace 无 Python agent，且删除正在运行的 Node/PG 会失败。
- MSIX/.appinstaller、AppImage 原生指引、macOS「拖到废纸篓」文案：平台形态不同。
- `windows-remote-lifecycle.ts` 的 SSH/远程主机生命周期：Dovspace 当前无远程模式。
- `electron-updater`/R2 feed 的自动更新链：Dovspace 无 update feed，先决策再实现。
- Tauri `Hermes-Setup` 引导器：与 NSIS 重复，且引入第二套签名/WebView。
- `tests/install/README.md:187` 的「Windows driver 会杀掉所有名为 Hermes 的进程」：这是测试专用破坏行为，不能进产品。
- macOS 驱动的 `xattr -dr com.apple.quarantine`：它是 CI 便利，不是 Gatekeeper 验收；不要把它写成「安装通过」。

**许可**
- Hermes 为 MIT（`LICENSE:1-2`）。可参考实现，但复制代码需保留版权/许可声明；品牌资源（Nous 图标、DMG 背景 `packaging/nous-dmg-2b.tiff`）、产品名、签名身份、R2/GitHub 凭据不可复制。
- 其依赖（Electron/Chromium/Node/PostgreSQL/Python 包）仍受各自许可约束；Dovspace 已有 `desktop-legal.tar.gz` 闭包，应继续以最终成品为准，不因参考 Hermes 而改变自身 notices。

**安全**
- 安装戳是**来源证明**，不是签名：`resolveInstallKind` 只读构建期常量，可被替换安装目录的人篡改旁车；Hermes 用签名（MSIX/公证）+ bundle swap 检测缓解，Dovspace 需把 stamp 纳入签名后的成品摘要。
- 分离清理脚本以当前用户权限运行，路径来自 `process.execPath`/stamp；Dovspace 必须固定目标根、拒绝 reparse/junction、删除前做 realpath 校验。
- 进程回收必须 fail-closed：不可读路径/命令行、未知 runtime、其他安装根一律不杀；Dovspace 更应只杀自己记录的 pid + 创建时间。
- 数据删除必须有「拒绝根/家目录/非空实例外路径」和「空快照不作通过」两道门。

## 13. 开放问题

1. Dovspace Windows 是否坚持 per-user NSIS？per-machine 需要提权、ALLUSERS 注册表与卸载服务停止顺序，Hermes 无对应证据。
2. 是否引入自动更新？若不引入，`updateMechanism`/feed/SBOM 的优先级可降；若引入，需先定签名信任根与回滚策略。
3. `data-only` 是否对用户暴露？Hermes 桌面刻意不暴露，Dovspace 需产品决策。
4. 卸载默认保留还是删除 `dataDir`？当前 `deleteAppDataOnUninstall:false` 只覆盖 `%APPDATA%`，不覆盖用户自选 dataDir。
5. PostgreSQL 16.15 的大版本升级策略：Dovspace 明确不自动升级（guide:29），但跨版本安装包如何拒绝/提示仍需 E2E。
6. macOS 最低版本 15.0 与签名身份是否最终确定；unsigned ad-hoc 只用于内部测试。
7. Linux 是否永远不发布桌面？若未来发布，需重新评估 AppImage/NSIS 之外的卸载与数据路径。

## 14. 本页未做的事

- 未运行 Hermes 或 Dovspace 的任何安装、升级、卸载、签名、公证、打包或测试命令。
- 未启动 Windows/macOS 虚拟机或远程 runner；所有原生行为均为源码阅读结论。
- 未验证 `tests/install` 各 leg 最近一次 CI 结果，也未声称任何测试通过。
- 未修改 Hermes 仓库；Dovspace 仅新增本文件。
