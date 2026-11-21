# 源码证据与桌面 GitHub 发布

两条流水线职责分开：标签触发的 **Tag source evidence** 只上传源码／构建证据到 Actions；**Desktop native installers** 独占 GitHub Release 与更新源发布。桌面默认仅构建 artifacts，只有显式 `draft`／`publish` 才进入发行门禁；本页不是某次公开发布成功的证明。

## 触发与门禁

1. 操作者把 `package.json` 版本与 CHANGELOG 更新提交到默认分支，然后创建并推送 `v<version>` 标签（必须与 `package.json` 完全一致）。
2. 标签推送会触发 [Repository checks](../../.github/workflows/ci.yml)。`checks` 成功后，`start-release` 作业用 `actions: write` 从默认分支派发 [Tag source evidence](../../.github/workflows/release.yml)。
3. `Tag source evidence` 的 `verify` 作业重新核对以下事实，任一不满足即失败：
   - 标签是 `vX.Y.Z`（可带 prerelease 后缀）且 `v` 后的版本与 `package.json` 相同；
   - 标签（含 annotated tag 解引用）仍指向传入的精确 40 位提交；
   - 该提交在默认分支历史中；
   - 提供的 `ci_run_id`（自动派发时即标签推送的 CI run）已完成、结论为 success、事件为 push、属于本仓库，且工作流为 `ci.yml`；手动派发未提供时查询该精确提交最近的已完成 push run，并要求它成功，不以更早的成功掩盖更晚的失败。
4. `license` 作业运行 `node scripts/check-third-party-notices.mjs --release`，只记录仓库内的发行授权元数据，**不是法律审查或分发授权**。存在 open blocker 时该作业失败；`package` 仍可构建未签名证据，便于复核，不能据此发布安装包。
5. `package` 作业执行 `pnpm install --frozen-lockfile` 与 `pnpm build:v4`，然后生成证据压缩包和校验和。
6. `package` 将准确验证的材料上传为 Actions artifact。此工作流没有 GitHub Release 写权限，不创建、刷新或发布 Release，避免与桌面同版本发行冲突。
7. `report` 作业始终写出各门禁结果摘要；它不把草稿、CI 成功或构建成功当成发布或业务验收。

自动派发与手动重试使用同一组输入，没有跳过 CI 核验的开关：

```sh
gh workflow run release.yml --ref main \
  -f tag=v0.1.0 -f expected_sha=<40-hex commit> -f ci_run_id=<成功 run id>
```

手动派发仍要求标签、版本、提交与成功 CI run 一致；把标签改指向别的提交会失败，也不会进入构建。标签必须在包含本流水线的提交之后创建；更早的标签缺少打包脚本，作业会明确失败。

## 产物

`node scripts/release-package.mjs prepare --tag v0.1.0 --sha <commit> --output <空目录>` 生成：

| 文件 | 内容 |
| --- | --- |
| `project-management-agent-v4-<version>-source.tar.gz` | `git archive` 的精确提交源码，前缀为 `project-management-agent-v4-<version>/` |
| `project-management-agent-v4-<version>-build-evidence.tar.gz` | 仅显式列出的构建产物：`dist/apps`、`dist/packages`、`apps/web/dist`、`apps/server/agent/dist`、`deploy`、根清单与许可文件，以及 `deploy/Dockerfile` 引用的 vendor 许可/来源材料；不含 `node_modules`、`.env*`、桌面 release 目录或日志 |
| `SHA256SUMS` | 按文件名排序的 SHA256 |
| `release-manifest.json` | 版本、标签、提交、提交时间、产物名称/大小/摘要 |

`verify` 会反向核对清单、大小、摘要、校验和文件及目录中未登记的文件：

```sh
node scripts/release-package.mjs verify --directory <已生成目录>
```

打包要求干净的已跟踪工作树和精确 `HEAD`；本地未提交修改会被拒绝。压缩包是**未签名构建证据**，不是可执行安装器、不是生产部署包，也不构成桌面发行材料。桌面安装器仍由[桌面指南](desktop.md)中的手动 `Desktop native installers` 工作流单独构建。

## 未覆盖与限制

- 自动派发要求默认分支已经包含本流水线；更早的标签（包括在合并本流水线之前创建的标签）不会自动派发，且缺少打包脚本时会明确失败。
- 源码证据不推送容器镜像、npm 包、桌面安装器或更新源；不创建签名／公证材料，也不部署服务。
- 桌面发行需要仓库／组织允许对应作业请求 `contents: write`；权限不足直接失败，不降级为无校验发布。
- draft 不会被客户端识别为可用更新；只有显式 `publish` 且全部门禁通过才改变可见性。
- 四个记录在案的发行 blocker（字体授权、素材来源、最终产物 notices、AGPL 对应源码入口）的逐项状态以 [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md#release-blockers) 为准；流水线通过许可脚本不代表这些事项已经闭合。
- 真实 Provider、桌面 GUI、安装器生命周期、TLS/公网部署与业务验收必须分别提供证据。

## 桌面更新发行

固定源为 [Crsei/project-management-agent-v4 Releases](https://github.com/Crsei/project-management-agent-v4/releases)。客户端不携带 GitHub token；工作流使用短期 `GITHUB_TOKEN`，操作者推送／dispatch 的凭据只在操作者环境使用。原生构建、签名及运行库前提见[桌面指南](desktop.md)。

### 仅构建测试版本

在每个准确的版本提交上手动触发；此操作不生成公开 Release：

每次升版先同步根与桌面 `package.json`。根 manifest 和锁文件属于已登记的宿主构建输入：逐项审阅版本／桌面依赖差异，通过既有来源记录工具更新精确绑定，保持上游 pin、无关输出及 recipes 不变，再运行 `node scripts/check-sources.mjs` 和 Agent 构建。只改版本而遗漏来源记录会被 `Host build tool hash mismatch` 拒绝；不得跳过检查或沿用旧提交的构建。

```sh
gh workflow run desktop.yml --ref main \
  -f distribution=unsigned -f windows_only=true \
  -f install_e2e=false -f release_action=none
```

默认只构建 Windows x64 unsigned。macOS 两种架构由 `windows_only=false` 启用；应用内更新要求 signed、公证的 macOS 包，unsigned macOS 不能冒充可自动安装版本。真实安装器生命周期另需显式 `install_e2e` 和精确旧版材料，不因构建授权自动运行。

### 先暂存，再显式发布

根／桌面 `package.json`、安装器、清单、tag 必须使用同一个版本；支持 `X.Y.Z-preview.N` 与稳定 `X.Y.Z`。先提交、推送并建立准确 tag，等待该 SHA 的完整 `Repository checks` push run 成功；再用 `release_action=none` 完成准确 native build，并准备下述已审阅的 evaluation material。draft／publish 复用这个成功 run／attempt 的原生成品，**不重新构建已审阅字节**：

```sh
gh workflow run desktop.yml --ref "v$VERSION" \
  -f distribution=unsigned -f windows_only=true \
  -f install_e2e=false -f release_action=draft \
  -f release_channel=preview -f release_tag="v$VERSION" \
  -f expected_sha="$SHA" -f ci_run_id="$CI_RUN" \
  -f native_run_id="$NATIVE_RUN" -f native_run_attempt="$NATIVE_ATTEMPT" \
  -f evaluation_material_run_id="$EVALUATION_RUN" \
  -f evaluation_material_artifact="$EVALUATION_ARTIFACT" \
  -f evaluation_material_sha256="$EVALUATION_MATERIAL_SHA256"
```

`VERSION`、`SHA`、`CI_RUN` 必须替换为本次准确版本、40 位提交和成功 CI run。`NATIVE_RUN`／`NATIVE_ATTEMPT` 指向同一候选的完整成功桌面构建；`EVALUATION_RUN`／`EVALUATION_ARTIFACT` 指向同仓库受控 Actions 材料，`EVALUATION_MATERIAL_SHA256` 独立钉住其原始 material 文件字节。不能从下载包自取一个摘要充当授权。稳定版需 `distribution=signed`、`release_channel=stable`；signed 的全部目标发布须完成 Windows、macOS x64／arm64 的原生成品检查与签名门禁。

在检查完完整 draft 后，用相同来源参数再次 dispatch，改为 `release_action=publish`。已完整暂存且来源／资产身份一致的 draft 可直接复验并提升可见性，不重新构建或替换；已发布且准确一致的版本只读核对，不覆盖。冲突、不完整或来源未知的旧 draft 失败关闭，保留现场供人工核对。

发行流程强制核对：

1. 固定仓库、tag 指向、dispatch ref／SHA、根与桌面版本、通道、签名模式、准确成功 CI。
2. 完整目标集合、相同公开源码字节、准确 native run／attempt、最终发行文件检查与 native payload smoke；Actions artifact 不是安装／GUI 验收。
3. 原有 `--release` 授权、来源、OSV、签名及材料门禁。**任一 OPEN 即阻塞，包括 unsigned preview；不提供跳过开关。**
4. 先创建 draft，上传完整材料，核对远端资产名、数量、大小与 SHA256，再在改变可见性前重复门禁。上传失败保持不可见；重试不删除／覆盖已有资产。
5. Evaluation 材料、独立预登记的采集公钥与实验、当前默认分支的批准／撤销记录，以及精确候选的原始签名执行证据。创建 draft、上传和改变可见性前均重新验证；缺失材料不会退回旧发布流程。

### Evaluation 发布证据

离线入口为 `bench evaluation release-decide`／`release-validate`，用法见 [Benchmark 指南](../../benchmarks/dovspace/README.md#evaluation-evidence-and-feedback-loop)。它们只生成、核对决定，不调用 GitHub 或部署服务。

- **先登记再执行。** 来源控制中的 registry 独立钉住策略、实验设计、可信 Ed25519 公钥与 ledger ID。真实 runner 在模型调用前登记 admission，以宿主私钥签名 admission／封存结果；闭合 ledger 保留失败、重复、未封存和中断尝试。私钥必须在 Agent 挂载与发布材料之外；包内自带的公钥、`producer` 字段或哈希不能自证可信。
- **准确的数据与版本。** 新模型运行使用已登记的 `canonical-task` 成员和准确 task／fixture／criterion 合同；旧 trace 的 `frozen-reproduction` pass/fail 标签不能代替新任务期望。候选／基线、模型控制、evaluator、校准、完整分母、cohort、成本／未知量、来源时效和撤销状态均参与判断。原始完整失败是有效负证据，不是被丢掉的重试；合成、导入声称、离线 regrade 或缺少安全观察的记录不能放行真实质量。
- **产物绑定。** 桌面公开源码 inventory 与 Benchmark 的服务器源码闭包分别校验，并核对实际投影关系；不能把两种不同范围的摘要直接当成相同。准确 native run 的原始发布字节用于最终发行，不用“同一提交重新构建”替代原审核产物。
- **私有材料。** Actions 下载会改变文件权限；工作流只从受控下载树读取普通单链接文件，在新的 0700／0600 私有树中重新暂存，再按独立摘要与签名验证。拒绝符号链接、硬链接、特殊文件和已有目标；不通过放宽证据读取权限解决下载格式差异。
- **批准与例外。** registry 默认没有预登记或批准，不会自动制造绿色决定。批准绑定精确材料和 ledger closure 摘要；当前撤销、到期、数据删除或新增未决尝试都会阻止旧结论继续放行。有限期例外不能绕过权限、安全、来源和许可门禁。

准备 evaluation artifact、真实模型预算、可信采集账号、默认分支批准及 GitHub dispatch 都须各自授权。本地校验或合成正反例通过不代表云端发布、真实模型效果或线上观察已经通过。发布后观察见 [Agent 指南](agent-chat.md#evaluation-元数据观察与发布后回顾)：观察决定只记录证据／建议，不自动部署或回退。

### 更新材料

- Windows：完整 NSIS 安装器、`.blockmap`、准确通道的 `preview.yml`／`latest.yml`。
- macOS：DMG、ZIP、ZIP blockmap，目标独立的 `preview-mac-<arch>.yml`／`latest-mac-<arch>.yml`；发布时合并两个已校验架构的 ZIP 信息为客户端读取的 `preview-mac.yml`／`latest-mac.yml`，不互相覆盖。
- 每目标都有 `desktop-install-stamp-<platform>-<arch>.json`。`desktop-package.json`、source/legal/security 等同名材料在公开 Release 中加 `<platform>-<arch>-<signing>-` 前缀；客户端读取对应目标的 manifest，候选 stamp 保留固定公开名。
- `desktop-release.json` 列出所有公开资产及其原材料名／目标／摘要；根 `SHA256SUMS` 覆盖完整发布集。新更新源不是任意 YAML 白名单：版本、文件名、目标、大小、摘要、blockmap 和不可变安装身份均须对账。

## 两个递增版本的用户测试

本次基线为 `0.1.1-preview.1`，候选为 `0.1.1-preview.2`。两个包均包含更新客户端，第二个版本保持相同数据兼容指纹，分别绑定独立 SHA 和原生构建 run。历史 `v0.1.0-preview.1` 的包内部版本是 `0.1.0`，没有更新客户端，不能直接用作测试基线。

先手动安装第一版并确认界面版本；第二版完整发布后，在第一版点击检查更新、下载、取消安装确认，再选择正常重启安装并核对第二版与数据。若要验证发布前后状态变化，可先构建两个版本，等待第一版安装确认后才发布第二版。仅构建成功、停在 draft 或门禁阻塞时，客户端不会得到第二版的公开更新；不能写成“双版本自动更新已通过”。完整范围与待办属于内部计划，不随公开树分发。

### 仅发布 macOS（两个架构，必须签名）

按[逐项发行材料核对](distribution-audit.md)准备，`desktop-signing` 环境配置 `DESKTOP_MAC_CSC_LINK`、`DESKTOP_MAC_CSC_KEY_PASSWORD`（Developer ID Application）、`DESKTOP_APPLE_ID`、`DESKTOP_APPLE_APP_SPECIFIC_PASSWORD`、`DESKTOP_APPLE_TEAM_ID`，并将期望 Team ID 环境变量 `DESKTOP_MAC_TEAM_ID` 与证书、公证团队核对一致。私钥/密码只放受保护的 secrets，不进仓库、日志或讨论。只选择两个 Mac 目标，不需 Windows 证书，不能改为 unsigned，也不能少一个架构。使用签名测试模式先取得两个架构的审阅材料；与正式发布分开：

```sh
gh workflow run desktop.yml --ref main -f distribution=signed \
  -f windows_only=false -f macos_only=true -f install_e2e=false -f release_action=none
```

待准确 tag、同 SHA CI、授权门禁与受保护环境满足，再按上面的 draft/publish 命令显式指定 `distribution=signed windows_only=false macos_only=true` 及同一组版本、通道和来源参数。
