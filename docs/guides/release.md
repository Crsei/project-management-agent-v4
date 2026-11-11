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
- 四个记录在案的发行 blocker（字体授权、素材来源、最终产物 notices、AGPL 对应源码入口）仍以 [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md#release-blockers) 为准；流水线通过许可脚本不代表这些事项已经闭合。
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

根／桌面 `package.json`、安装器、清单、tag 必须使用同一个版本；支持 `X.Y.Z-preview.N` 与稳定 `X.Y.Z`。先提交、推送并建立准确 tag，等待该 SHA 的完整 `Repository checks` push run 成功，再执行：

```sh
gh workflow run desktop.yml --ref "v$VERSION" \
  -f distribution=unsigned -f windows_only=true \
  -f install_e2e=false -f release_action=draft \
  -f release_channel=preview -f release_tag="v$VERSION" \
  -f expected_sha="$SHA" -f ci_run_id="$CI_RUN"
```

`VERSION`、`SHA`、`CI_RUN` 必须替换为本次准确版本、40 位提交和成功 CI run。稳定版需 `distribution=signed`、`release_channel=stable`；signed 的全部目标发布须完成 Windows、macOS x64／arm64 的原生成品检查与签名门禁。

在检查完完整 draft 后，用相同来源参数再次 dispatch，改为 `release_action=publish`。已完整暂存且来源／资产身份一致的 draft 可直接复验并提升可见性，不重新构建或替换；已发布且准确一致的版本只读核对，不覆盖。冲突、不完整或来源未知的旧 draft 失败关闭，保留现场供人工核对。

发行流程强制核对：

1. 固定仓库、tag 指向、dispatch ref／SHA、根与桌面版本、通道、签名模式、准确成功 CI。
2. 完整目标集合、相同公开源码字节、准确 native run／attempt、最终发行文件检查与 native payload smoke；Actions artifact 不是安装／GUI 验收。
3. 原有 `--release` 授权、来源、OSV、签名及材料门禁。**四项 OPEN 仍阻塞，包括 unsigned preview；不提供跳过开关。**
4. 先创建 draft，上传完整材料，核对远端资产名、数量、大小与 SHA256，再在改变可见性前重复门禁。上传失败保持不可见；重试不删除／覆盖已有资产。

### 更新材料

- Windows：完整 NSIS 安装器、`.blockmap`、准确通道的 `preview.yml`／`latest.yml`。
- macOS：DMG、ZIP、ZIP blockmap，目标独立的 `preview-mac-<arch>.yml`／`latest-mac-<arch>.yml`；发布时合并两个已校验架构的 ZIP 信息为客户端读取的 `preview-mac.yml`／`latest-mac.yml`，不互相覆盖。
- 每目标都有 `desktop-install-stamp-<platform>-<arch>.json`。`desktop-package.json`、source/legal/security 等同名材料在公开 Release 中加 `<platform>-<arch>-<signing>-` 前缀；客户端读取对应目标的 manifest，候选 stamp 保留固定公开名。
- `desktop-release.json` 列出所有公开资产及其原材料名／目标／摘要；根 `SHA256SUMS` 覆盖完整发布集。新更新源不是任意 YAML 白名单：版本、文件名、目标、大小、摘要、blockmap 和不可变安装身份均须对账。

## 两个递增版本的用户测试

本次基线为 `0.1.1-preview.1`，候选为 `0.1.1-preview.2`。两个包均包含更新客户端，第二个版本保持相同数据兼容指纹，分别绑定独立 SHA 和原生构建 run。历史 `v0.1.0-preview.1` 的包内部版本是 `0.1.0`，没有更新客户端，不能直接用作测试基线。

先手动安装第一版并确认界面版本；第二版完整发布后，在第一版点击检查更新、下载、取消安装确认，再选择正常重启安装并核对第二版与数据。若要验证发布前后状态变化，可先构建两个版本，等待第一版安装确认后才发布第二版。仅构建成功、停在 draft 或门禁阻塞时，客户端不会得到第二版的公开更新；不能写成“双版本自动更新已通过”。完整范围与待办见[实施计划](../reference/desktop-github-updates-plan.zh.md)。
