# Third-party notices / 第三方归属与发布门禁

本文件整理本仓库可核对的第三方来源、原始许可位置和未解决事项，不替代组件自己的完整许可。**经用户明确选择，本项目自有代码采用 GNU Affero General Public License v3.0 only（SPDX：`AGPL-3.0-only`），全文见 [LICENSE](LICENSE)；第三方代码与资产保留各自适用的许可和 notices。** 根许可证不覆盖未知第三方版权，也不代表所有发布阻塞已解决。

来源身份、固定版本、原始文件哈希及本地适配以各组件已有 `source-manifest.json` / `source-pin.json`、`LICENSING.md`、`SYNC.md` 为准；本文件是索引和发布阻塞记录，不建立另一份源文件清单。下述本地静态审阅不代表已生成或验收发布包。

根 `LICENSE` 逐字保留用户指定 Plane 仓库的 GNU AGPL v3 标准全文，只含 FSF 对许可文本的版权，不冒用 Plane 项目版权。Plane 的 [公开声明](https://github.com/makeplane/plane#license) 为 AGPL v3.0；本次读取的本地 `package.json` 为旧标识 `AGPL-3.0`，没有项目级“or later”声明。许可证附录中的示例不自动为本项目选择 later。涉及网络交互、源码和二进制分发时，必须履行对应源码提供等适用义务；实际发布/部署的源码入口与成品对应关系尚待验收。

## Vendored source

| 组件与本地范围 | 已核实许可与著作权原文 | 来源及权威记录 |
| --- | --- | --- |
| t3code：`vendor/t3code` 及其清单覆盖的 Provider、协议与客户端适配 | MIT；`Copyright (c) 2026 T3 Tools Inc.`；[原文](vendor/t3code/LICENSE)，根 [LICENSE.t3code](LICENSE.t3code) 保留同文 | [t3code](https://github.com/pingdotgg/t3code)，固定提交 `30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c`；[source-manifest](vendor/t3code/source-manifest.json)、[SYNC](vendor/t3code/SYNC.md)。依赖 overrides 与 SPDX 文本的范围见清单 `licenses`，不扩展到其他版本或未知来源文件 |
| cc-switch：`vendor/cc-switch` 及 headless/Web 适配 | MIT；`Copyright (c) 2025 Jason Young`；[原文](vendor/cc-switch/LICENSE) | [farion1231/cc-switch](https://github.com/farion1231/cc-switch)，4.0.25，提交 `7afceec14b977ecc2f4373e8ffb40e7223b435ac`；[LICENSING](vendor/cc-switch/LICENSING.md)、[SYNC](vendor/cc-switch/SYNC.md)、[TypeScript host 来源](apps/server/cc-switch-host/PROVENANCE.md) |
| OpenHands presentation / Agent Canvas：`vendor/openhands-extensions` | MIT；`Copyright © 2025 OpenHands contributors`；[原文](vendor/openhands-extensions/LICENSE) | [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands)，提交 `b4a3f45a28f6b6c387a8deb3dc7c18b4393c59c1`；[source-manifest](vendor/openhands-extensions/source-manifest.json)、[LICENSING](vendor/openhands-extensions/LICENSING.md)、[SYNC](vendor/openhands-extensions/SYNC.md) |
| OpenHands extensions 静态 integrations registry | MIT；`Copyright (c) 2025 OpenHands`；[原文](vendor/openhands-extensions/extensions/LICENSE) | [OpenHands/extensions](https://github.com/OpenHands/extensions)，`@openhands/extensions@0.36.0`；原始 npm metadata、归档 URL/integrity 在上述既有 manifest 与 `extensions/source-package.json` |
| OpenHands automation catalog / 源 Python 文本：`vendor/openhands-automations` | 两份不同来源的 MIT 原文均保留：[Agent Canvas](vendor/openhands-automations/LICENSE.agent-canvas)、[extensions](vendor/openhands-automations/LICENSE.extensions) | [source-pin](vendor/openhands-automations/source-pin.json)、[目录说明](vendor/openhands-automations/README.md)；Agent Canvas 1.34.0 / extensions 0.36.0，同上 OpenHands 固定提交。源工作树文件另有哈希，不宣称其全部等同干净 Git 提交 |

### Existing nested notices

- `apps/web` 保留的 shadcn/ui 派生基础件沿用 [MIT 原文](apps/web/public/licenses/shadcn/LICENSE)：`Copyright (c) 2023 shadcn`。该副本覆盖 shadcn/ui 原始代码；项目自有 UI 按根 [LICENSE](LICENSE) 的 `AGPL-3.0-only` 维护，第三方部分保留各自 notice。
- [OpenHands dependency-notices](vendor/openhands-extensions/dependency-notices.json) 已保存 `react-remove-scroll-bar@2.3.8` 缺失 npm LICENSE 的实际上游 license blob、文本和哈希。继续复用这一来源，不以通用 MIT 模板替换归属。

## Fonts, icons and fixture media

| 本地资产 | 现有来源与许可证据 | 发布边界 |
| --- | --- | --- |
| `apps/web/src/assets/fonts/InterVariable.woff2` | [Inter OFL-1.1 全文](apps/web/public/fonts/Inter-LICENSE.txt)，`Copyright (c) 2016 The Inter Project Authors`；[Inter upstream](https://github.com/rsms/inter) | 许可原文随 Web `public/fonts/` 分发；当前字体文件缺少固定下载版本/归档与字节对应记录，仍需补来源链 |
| `apps/web/src/assets/fonts/MiSans-{Regular,Medium,Semibold}.woff2` | [既有 NOTICE](apps/web/public/fonts/MiSans-NOTICE.txt)；[本次保存的官方网页协议文本](apps/web/public/fonts/MiSans-LICENSE.txt)；[小米官方来源](https://hyperos.mi.com/font/en/download/)（2026-11-05 查阅） | **不是 OFL 或 MIT**。官方页面授予有条件、不可转让、可撤销的使用许可，要求明确标注使用 MiSans，禁止改编，并限制字体本体再分发。网页允许分发使用字体创作的作品，但不能据此推定公开仓库内 WOFF2 本体或转换行为已获授权；当前文件与原始下载协议版本的对应关系未记录，保留发布阻塞 |
| `apps/marketing/public/type/dm-sans-*.woff2` | [DM Sans OFL-1.1 全文](apps/marketing/public/fonts/dm-sans-OFL.txt)，`Copyright 2014 The DM Sans Project Authors`；[DM Fonts upstream](https://github.com/googlefonts/dm-fonts) | 保留 OFL；原始下载/子集版本与文件哈希的来源链仍待补齐 |
| `apps/marketing/public/type/jetbrains-mono-latin.woff2` | [JetBrains Mono OFL-1.1 全文](apps/marketing/public/fonts/jetbrains-mono-OFL.txt)，`Copyright 2020 The JetBrains Mono Project Authors`；[upstream](https://github.com/JetBrains/JetBrainsMono) | 保留 OFL；原始下载/子集版本与文件哈希的来源链仍待补齐 |
| 营销站 t3code 视觉适配与 `apps/marketing/public/harnesses/*.svg` | 根 README 与 `v4.css` 标识来自/参考 `t3code/apps/marketing`；独立站点现保留 [t3code MIT 原文](apps/marketing/public/LICENSE.t3code) 及 [静态 notices](apps/marketing/public/THIRD_PARTY_NOTICES.txt) | Provider 的 t3code manifest **未收录营销文件**，不能套用其固定提交作为营销资产来源证明。六个 Agent 标志的第三方原始来源、商标/品牌使用条件及实际字节来源仍需核对；保留 MIT 不意味着品牌授权或背书 |
| `apps/web/public/images/project-backgrounds/1.webp` 至 `10.webp`；浏览器/营销站 favicon 与品牌图形 | 背景图被页面直接引用；本仓未找到逐资产来源/许可台账。品牌命名不能证明图形权属 | 需要实际来源、作者/授权或可追溯的自制记录；不推定其来自某图库或 t3code，也不自动赋予许可 |

npm 依赖（包括图标库）按**实际安装版本及实际进入产物的依赖图**保留其自身许可，不因使用 `lucide-react`、`@phosphor-icons/react` 等包名就推定所有本地图标都来自该包。远程 registry/logo URL 不是已下载的本地资产，也不是商标使用授权。

## Distribution chain

以下是现有脚本的静态行为核对，不是一次已运行的包验收：

- **Web**：`vendor/openhands-extensions/scripts/web-build.mjs` 保留 OpenHands 原许可、现有来源/适配清单及共享 cc-switch notices，并为实际 OpenHands/cc-switch 可达模块依赖收集许可；没有 notice 且没有已审阅上游补件时失败。该范围**不是整个 PM/Provider Web bundle** 的完整许可审计。`public/` 本次补齐自有代码 AGPL、t3code MIT 与明确来源的 shadcn MIT；它们及字体 notices 需随静态产物保留，脚本核对公开许可副本的原文内容。
- **Agent**：`apps/server/agent/scripts/package.mjs` 将根 `LICENSE` 与本文件纳入真实 transfer/hash 清单并保留在 `licenses/provenance/`；同时复制实际磁盘依赖资源、按构建输入发现的 bundled notices，以及 t3code、cc-switch、OpenHands 来源记录。原生 cc-switch 的 `cc-switch.mjs` 另收集目标 Cargo 图及原许可。bundled 清单可以记录空 `notices`，因此“打包成功”本身不等于所有依赖授权齐全；最终包还需逐项核验。通用 SPDX 文本仅是许可条款，不替代上游要求的著作权/NOTICE。依赖聚合包的生成 metadata 不用于将第三方依赖统一重新声明为 AGPL。
- **Desktop**：`apps/desktop/scripts/stage-workspace.mjs` 合并 Agent legal 目录、Web 产物、automation vendor，检查根许可证与总 notices 已随 Agent 保留，并调用 `license-notices.mjs` 收集根/桌面/Web 生产依赖随包提供的 legal 文件。collector 的 `index.json` 可记录空文件列表或空 `license`，不可把它当最终授权门禁。`prepare-runtime.mjs` 保留固定 Node/PostgreSQL 完整二进制分发的 LICENSE、库/share 及 runtime notices；Electron 自身与其 bundled Chromium/其他组件 notices 仍需在目标平台成品中确认，不能只检查 Electron npm 包包装层。builder 将受管 runtime 目录复制进安装资源。
- **Marketing**：Astro 的 `public/` 保留自有代码 AGPL、两种字体 OFL、t3code MIT 和静态 notices。新增 t3code 许可副本解决独立静态目录丢失已知 MIT 原文的问题，不宣称六个品牌 SVG 的全部权利已闭合；部署时不得剔除上述 legal 文件。

## Release blockers

**当前不能宣称“许可证已全部通过”或“全仓 MIT”。** 下表由维护者在取得真实授权/来源和最终包证据后审阅关闭；`RESOLVED` 必须同时记录可公开核对的证据，不能仅因新增一个空 LICENSE、删除检查或打包成功而关闭。脚本读取这张表作为人工发布门禁，源文件哈希仍只从原组件 manifests 读取。

| ID | Status | 未解决事项 / 关闭所需证据 |
| --- | --- | --- |
| OWN-LICENSE | RESOLVED | 用户已明确采用 Plane 相同许可证；根 [LICENSE](LICENSE) 为完整 GNU AGPL v3 正文，本项目声明 `AGPL-3.0-only`。此决定仅解决自有代码许可证选择，不授予未知第三方权利。 |
| UI-OWNERSHIP | RESOLVED | 项目所有者确认历史 UI 移植代码为其本人作品；本项目将 `apps/web` 的 UI/视图作为自有代码维护，第三方部分保留各自 notice，见 [UI 归属说明](docs/architecture/ui-ownership.md)。 |
| MISANS-GRANT | OPEN | 确认当前三份 WOFF2 的原始下载/版本、是否转换及随附协议，确认源码仓库和 Web/桌面分发字体本体被许可；现存使用声明和官方网页不是这一对应关系的证明。 |
| ASSET-ORIGINS | OPEN | 补齐背景 WebP、favicon/品牌图形、营销标志/字体及 Inter 的实际来源版本/字节链；确认参考演示文字的再分发权利。不以“合成”“fixture”或目录名称代替证据。 |
| ARTIFACT-NOTICES | OPEN | 对最终源码、Web、Agent、营销站与各目标桌面安装包核对实际依赖/原生运行时/嵌套组件的许可及 notices，处理空 notice 或空 license 项，并保留本文件及适用的原始许可。现有部分 collector 不是法律兼容性或发布批准。 |
| AGPL-SOURCE | OPEN | 为实际发布/部署版本提供可访问的对应源码，包含构建/安装所需脚本及本地修改，并完成适用交互法律声明和网络源码获取入口；尚无已验收的公开源码地址与成品对应证据，不能以根 LICENSE 存在代替履约。 |

## Integrity check versus release authorization

```sh
# 只核验已知原许可与既有来源清单的字节关系、公开许可文件和发布记录结构；仍输出开放阻塞。
node scripts/check-third-party-notices.mjs --integrity

# 默认/显式发布门禁：完整性错误或任意 OPEN 项均以非零状态退出。
node scripts/check-third-party-notices.mjs --release
```

脚本只读取本仓显式列出的公开源/许可文件，不联网、不读取 `.env`、`.local`、凭据、运行数据、其他仓库或构建输出，不运行构建或修改来源清单。完整性模式成功只代表其限定检查通过；**不代表授权完整、法律兼容、商标许可、目标平台产物已验收或允许发布**。发布门禁不能替代人工许可审阅和真实最终包验收。
