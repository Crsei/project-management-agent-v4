# Tag 发布流水线

标签发布由 GitHub Actions 执行：**先在精确提交上跑完整 `Repository checks`，通过后才构建发布证据并创建 draft GitHub Release**。流水线不自动点击“发布”，不签名、不生成桌面安装器，也不部署任何实例。

## 触发与门禁

1. 操作者把 `package.json` 版本与 CHANGELOG 更新提交到默认分支，然后创建并推送 `v<version>` 标签（必须与 `package.json` 完全一致）。
2. 标签推送会触发 [Repository checks](../../.github/workflows/ci.yml)。`checks` 成功后，`start-release` 作业用 `actions: write` 从默认分支派发 [Tag release](../../.github/workflows/release.yml)。
3. `Tag release` 的 `verify` 作业重新核对以下事实，任一不满足即失败：
   - 标签是 `vX.Y.Z`（可带 prerelease 后缀）且 `v` 后的版本与 `package.json` 相同；
   - 标签（含 annotated tag 解引用）仍指向传入的精确 40 位提交；
   - 该提交在默认分支历史中；
   - 提供的 `ci_run_id`（自动派发时即标签推送的 CI run）已完成、结论为 success、事件为 push、属于本仓库，且工作流为 `ci.yml`；手动派发未提供时查询该精确提交最近的已完成 push run，并要求它成功，不以更早的成功掩盖更晚的失败。
4. `license` 作业运行 `node scripts/check-third-party-notices.mjs --release`，只记录仓库内的发行授权元数据，**不是法律审查或分发授权**。存在 open blocker 时该作业失败，`publish` 被跳过；`package` 仍会构建未签名证据，便于复核失败原因。
5. `package` 作业执行 `pnpm install --frozen-lockfile` 与 `pnpm build:v4`，然后生成证据压缩包和校验和。
6. `publish` 要求 `verify`、`license`、`package` 全部成功，重新核验 tag 与已下载产物，创建或刷新 **draft** release。已存在的已发布 release 一律拒绝覆盖。
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
- 仓库/组织必须允许工作流请求 `contents: write` 才能创建 draft；策略限制时 `publish` 失败关闭，不降级为无校验发布。
- 不会自动发布 draft；维护者必须自行审阅源码、许可、证据与目标渠道后手动发布。
- 不推送容器镜像、npm 包或自动更新源，不创建签名/公证材料。
- 四个记录在案的发行 blocker（字体授权、素材来源、最终产物 notices、AGPL 对应源码入口）仍以 [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md#release-blockers) 为准；流水线通过许可脚本不代表这些事项已经闭合。
- 真实 Provider、桌面 GUI、安装器生命周期、TLS/公网部署与业务验收必须分别提供证据。
