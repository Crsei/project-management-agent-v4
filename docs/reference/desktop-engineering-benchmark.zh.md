# 桌面工程基准：Hermes Agent 与 Cherry Studio

本页保留两份本地 checkout 静态评审的对标索引，并记录据此新增的本项目实现入口，不是原生通过报告。参考项目未在本机执行打包、签名、公证、安装、升级或卸载；本机为 Linux。所有 Windows/macOS 原生行为均为**未验证**，不能把源码存在或工作流定义当成实际通过。下方“现状”矩阵是实施前基线；当前操作说明以[桌面指南](../guides/desktop.md)为准。

## 参考身份

| 项目 | 本地路径 | commit | 许可证 | 主要参考价值 |
| --- | --- | --- | --- | --- |
| Hermes Agent | `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/hermes-agent` | `856e75808d1d6d985b06e9e882f2814ab4e4aa5d` | MIT | 安装戳/所有权、四级卸载、数据保留快照、升级 handoff、进程回收 |
| Cherry Studio | `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/cherry-studio` | `27a61a606566fd60800e466ebfd041f858b89f9e` | AGPL-3.0 | electron-builder/NSIS 预检、打包钩子、签名/公证、发布资产复核 |

详细文件、符号、工作流和缺口：

- [Hermes Agent 基准评审](desktop-benchmark-hermes-agent.zh.md)
- [Cherry Studio 基准评审](desktop-benchmark-cherry-studio.zh.md)

现有 Dovspace 边界见 [桌面发布对照](desktop-release-alignment-2026-11-08.zh.md)、[Windows 操作手册](windows-build-runbook.zh.md) 和 [桌面指南](../guides/desktop.md)。

## 怎么组合使用

- **Hermes 管生命周期语义**：用不可变 install stamp 决定安装形态和所有权；用卸载模式区分只删 GUI、删代码保留数据、全删、只删数据；用快照/校验保护升级前后的用户数据；用分离清理脚本等待应用退出后再删除。
- **Cherry 管 Windows 打包与发布**：用 NSIS 预检的硬失败语义、`beforePack/afterPack` 的运行时闭包证明、签名钩子和发布资产允许清单；但明确不采用其关闭更新签名校验、关闭公证、安装时远程下载并执行 VC++ 等不安全配置。
- **Dovspace 自己补执行证据**：两份参考都没有覆盖 bundled Node + PostgreSQL + PM/Agent 架构。普通构建与 payload smoke 仍输出 `installationExecuted:false`、`electronGuiExecuted:false`；只有完整、准确绑定的原生生命周期 receipt 可改变前者，不改变 GUI 结论。

## 合并审计矩阵

| 审计项 | 参考证据 | Dovspace 现状 | 优先级 | 目标文件/验收 |
| --- | --- | --- | --- | --- |
| Windows 安装、覆盖安装、静默安装、NSIS 日志/目录/注册表 | Cherry 只有安装前预检和手动静默安装；Hermes 是 MSIX/引导器，无 NSIS | 无真实安装执行；`installationExecuted:false` | **P0** | 新增 `apps/desktop/scripts/install-e2e/*` 与 `.github/workflows/desktop.yml` job；记录 exit、注册表、目录树、进程表 |
| macOS 签名、公证、Gatekeeper | Hermes 有 codesign 断言但安装驱动绕过 quarantine；Cherry `notarize:false` | signed 分支存在但未原生验证 | **P1** | `package.mjs` 增加 `codesign --verify`、`stapler validate`、`spctl` 报告 |
| Linux 安装包 | Cherry 有 AppImage/deb/rpm；Hermes 有 AppImage | 不发布桌面 | 不适用 | 保持不发布；Linux 仅用于 runtime/smoke |
| Node/PostgreSQL/Agent 进程生命周期 | Hermes `local-backend-lifecycle`、`package-process-reap`、boot-lifecycle | `local-server`/`managed-postgres` 有 stop/所有权，无 Windows 原生退出 E2E | **P0** | 停机/回收测试 + Windows 进程表断言 |
| 安装文件、依赖裁剪、体积基线 | Cherry `beforePack`/`keepPackages`；Hermes 安装后 stamp | 39,809 文件/1,023,987,590 B；已有 45,000 文件预算 | **P1** | `payload-report.mjs` 分解报告；预算逐步下调 |
| Electron sandbox/IPC/CSP/导航隔离 | 两者均有相关实现；未逐条审计 | 已有 `securePreferences`、窗口帧信任和 CSP 基础 | **P1** | 负面测试：子帧、guest、导航、权限请求、IPC 来源 |
| runtime 目录与 Agent 文件执行权限 | Hermes 私有状态/ACL；Cherry 原生资源闭包 | `private-state.mjs` 与 platform tests；Windows ACL 未原生验证 | **P1** | Windows 真实 ACL/reparse 回归与安装后目录检查 |
| 更新包签名/完整性 | Hermes pinned size/sha256 + OS/MSIX；Cherry `verifyUpdateCodeSignature:false` | `publish:null`，无 updater | **P0 决策** | 维持无更新，直到签名身份、`publisherName`、公证、可信 feed 和负向测试齐备 |
| 跨版本升级、数据迁移、失败恢复 | Hermes 升级 E2E + user-state/plugin preservation + handoff restore | 无升级执行证据；备份恢复仅到空实例 | **P0** | N→N+1 安装、升级中断、旧版本仍可启动、PG/Markdown/Agent 数据快照对比 |
| 卸载服务停止、文件锁、残留 | Hermes 分离清理脚本、PID 等待、Windows rmdir 重试 | NSIS 默认 `RMDir /r`；无 stop/重试/残留断言 | **P0** | 卸载 E2E：进程退出、锁释放、目录/快捷方式/注册表清理 |
| 用户数据保留、删除、防误删 | Hermes 四模式 + plan 保护 + 空快照拒绝 | 仅 `deleteAppDataOnUninstall:false` | **P0** | 四模式 golden 清单 + dataDir/PG/`%APPDATA%` 快照验证 |
| 原生安装 E2E | Hermes release-only 矩阵 + bundle smoke；Cherry 手动安装回归 | 无 | **P0** | 同提交 runner、artifact、receipt 和日志 |
| SBOM、漏洞、许可证扫描 | Cherry 发布资产哈希/审批但无 SBOM；Hermes OSV 周扫 | legal 材料与许可完整性检查；无 SBOM/OSV | **P1** | `sbom.mjs` + OSV/SARIF + 最终 legal 对账 |
| 备份加密、恢复验证、隐私 | 两者均无 Dovspace 等价实现 | 备份含私密数据且未加密；恢复仅写新空实例 | **P1** | 加密决策、错误口令/篡改拒绝、跨版本恢复执行记录 |

## 建议实施顺序

### P0：先建立可证伪的安装/卸载闭环

1. **安装/升级/卸载 E2E 骨架**：参考 Cherry 的静默安装驱动和 Hermes 的 user-state/plugin-preservation 快照。先在 `windows-2025` 上执行“安装 → 启动/健康检查 → 覆盖安装 → 升级 → 卸载”，产出 `install-e2e-receipt.json`，再把 receipt 绑定到 `desktop-verification.json`。
2. **install stamp 与所有权门禁**：构建期写入 commit/distribution/payload/updateMechanism，运行时只读冻结；非自有安装只给 OS/包管理器指引，不自行删除。Dovspace 目标：`apps/desktop/scripts/install-stamp.mjs`、`apps/desktop/src/install-stamp.mjs`、`final-artifact.mjs`/`verify-delivery.mjs`。
3. **卸载模式与数据保留**：至少区分 `app-only`（保留数据）、`app+runtime`（保留数据）、`full`（删应用与数据）、`data-only`（保留安装）。用 golden 清单和真实文件系统快照验证，空快照判失败。
4. **停机与回收**：安装/升级/卸载前只停止本项目拥有的 Node/PostgreSQL 进程；用 pid + 创建时间/所有权记录，不按镜像名 sweep；超时失败而不是强杀。目标：`local-process.mjs`、`managed-postgres.mjs`、`main.mjs`。
5. **更新策略决策**：继续 `publish:null` / `publish:"never"`，直到签名身份、`publisherName`、公证、可信 feed、回滚策略和篡改/降级负向测试齐备。不要因为 Cherry 有更新链就照搬。

### P1：补齐发布与安全证据

6. **NSIS 预检**：参考 Cherry 的硬失败语义，但不要安装时联网下载并执行未固定哈希的 VC++ redist。先确认 Dovspace 的 Node/PostgreSQL 二进制实际依赖，再决定是否预检 VC++；明确 per-user/per-machine 语义。
7. **签名/公证闭环**：Windows 覆盖 `.exe/.dll/.node` 并做最终 Authenticode 验签；macOS signed 模式 fail closed，增加 `codesign --verify --deep --strict`、`stapler validate`、`spctl` 实际输出。
8. **发布资产与 SBOM**：沿用现有 `SHA256SUMS`/source/legal，增加允许清单、逐文件哈希、SBOM 和 OSV/漏洞门禁；资产集合多一个或少一个都失败。
9. **备份加密与恢复**：明确默认不加密的风险接受或实现口令派生加密；测试错误口令、篡改归档、跨 OS 恢复和“不覆盖旧实例”。
10. **文件数与体积预算**：用 `payload-report.mjs` 按 PM/Agent/Electron/runtime 分解，先维持 45,000 回归门禁，再按真实 Windows 安装/卸载计时逐步下调。

## 据此新增的实现入口

- 生命周期：[安装戳生成](../../apps/desktop/scripts/install-stamp.mjs)、[只读运行时戳](../../apps/desktop/src/install-stamp.mjs)、[进程创建身份](../../apps/desktop/src/process-identity.mjs)、[安装后 controller](../../apps/desktop/src/lifecycle-cli.mjs)、[四模式计划与执行](../../apps/desktop/src/uninstall.mjs)、[NSIS hooks](../../apps/desktop/assets/desktop-lifecycle.nsh)。
- 原生证据：[Windows 驱动](../../apps/desktop/scripts/install-e2e/windows.mjs)、[receipt 验证](../../apps/desktop/scripts/install-e2e/evidence.mjs)、[原始材料绑定](../../apps/desktop/scripts/native-receipt.mjs)。工作流默认关闭安装 E2E；需要另获执行权限与兼容的真实较低版本 baseline。同版本覆盖不冒充升级，中断恢复不冒充数据库迁移回滚。
- 交付门禁：[最终验签](../../apps/desktop/scripts/signatures.mjs)、[最终 DMG 公证](../../apps/desktop/scripts/mac-notarization.mjs)、[准确资产集](../../apps/desktop/scripts/delivery-assets.mjs)、[SBOM](../../apps/desktop/scripts/sbom.mjs)、[OSV](../../apps/desktop/scripts/osv.mjs)、[payload 报告](../../apps/desktop/scripts/payload-report.mjs)。维持无自动更新；来源型无版本组件明确列为未执行注册表漏洞查询。
- 数据保护：[认证加密归档](../../apps/desktop/src/maintenance-archive.mjs)、[维护入口](../../apps/desktop/src/maintenance.mjs)、[真实恢复](../../apps/desktop/src/backend/maintenance.ts)。新备份加密，同版本／同系统恢复；所有格式要求单次可信来源确认，SQL 不是沙箱。跨版本／跨系统拒绝记录不能代替成功迁移证据。
- 本机已执行 Linux 隔离真实服务烟测：PM／Agent 登录与聊天、停机重连、非空数据快照、加密备份、可信来源／错误口令前置拒绝及新实例恢复。原生四模式、Windows ACL／文件锁、签名／公证和 Electron GUI 仍需对应平台运行；会话与持久化仍暂沿用 Agent Chat，统一设计未收口。


## 不可照搬

- Hermes 的 Python venv 自删、MSIX/AppImage 原生卸载指引、Tauri 引导器、远程 Windows SSH 生命周期。
- Cherry 的 `win.verifyUpdateCodeSignature:false`、无 `publisherName` 的 generic feed、凭据缺失静默不公证、安装时远程下载执行 VC++、删除 Electron/Chromium 许可文件、放宽 Hardened Runtime 的 entitlements、portable 目标。
- 任何“构建成功/签名成功/工作流绿色”直接等同于“安装、升级、卸载、数据保护已验收”的结论。

## 证据边界

- 两份子评审只读源码、配置、测试和工作流定义，未执行原生安装器、GUI、签名、公证或更新。
- 既有 Dovspace 发行报告不会因新增源码或文档自动改变；没有对应原生 receipt 就保持 `installationExecuted:false`，无窗口 controller 不能将 `electronGuiExecuted` 改为 `true`。
- 真实 Windows/macOS 验收必须在对应平台 runner 或设备上执行，并绑定精确 commit、artifact SHA256、run/attempt、日志和 receipt。
- 本索引不替代 [Windows 操作手册](windows-build-runbook.zh.md) 的权限、失败恢复和交付分层要求。
