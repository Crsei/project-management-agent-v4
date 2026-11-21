# vendor 目录说明

`vendor/` 保存按固定上游版本选择的源码、生成资产和 provenance 账本。它们是可审阅的只读输入，不是运行时可自由修改的项目代码，也不在运行时读取相邻来源仓库。四个子树各有独立来源和校验脚本，不能混用账本或把某个子树的输出登记到另一个子树。

共同规则：

- 不手工编辑已登记的上游原始字节、补丁、输出清单或生成资产；变更走对应的 capture/审阅流程。
- 不运行上游安装、hooks、构建或 Provider 调用；同步/校验只读本仓库和显式传入的本地 checkout。
- 不移动已登记路径；provenance 按路径、字节、模式和补丁前像/后像校验。
- 许可证与第三方通知见根 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)；维护与发布授权见[上游源码维护指南](../docs/guides/upstream-source-maintenance.md)。

| 子树 | upstream / pin | 同步、生成与补丁 | 许可证 | 验证命令 |
| --- | --- | --- | --- | --- |
| `vendor/t3code` | <https://github.com/T3Tools/t3code>，commit `30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c`（0.1.3） | [SYNC.md](t3code/SYNC.md)；`scripts/sync.mjs`、`scripts/capture.py`、`scripts/imports.mjs`、`scripts/verify-sync.mjs`、`scripts/host-inputs.mjs`；补丁按族记录在 `integration-patches/*.json`、`*-patches.json`、`integration-patches.json`、`mcp-skills-adaptations.json` | MIT，Copyright (c) 2026 T3 Tools Inc.；[LICENSE](t3code/LICENSE) | `node scripts/check-sources.mjs`；`node vendor/t3code/scripts/imports.mjs --check`；`node vendor/t3code/scripts/verify-sync.mjs --source /ABS/pinned-t3code`；`pnpm check:licenses` |
| `vendor/cc-switch` | <https://github.com/farion1231/cc-switch>，4.0.25，commit `7afceec14b977ecc2f4373e8ffb40e7223b435ac` | 保留选定 React Web UI 与共享 provenance/closure 工具；headless host 已行为移植到 `apps/server/cc-switch-host`，更新政策与来源映射见 [PROVENANCE.md](../apps/server/cc-switch-host/PROVENANCE.md) 和 [UPSTREAM-SOURCES.md](../apps/server/cc-switch-host/UPSTREAM-SOURCES.md)；历史 replay/补丁契约见 [SYNC.md](cc-switch/SYNC.md) | MIT，Copyright (c) 2025 Jason Young；[LICENSE](cc-switch/LICENSE) | `node scripts/check-sources.mjs`；`pnpm --filter @agent-workspace/cc-switch-host test`；`pnpm check:licenses` |
| `vendor/openhands-extensions` | <https://github.com/OpenHands/OpenHands>，commit `b4a3f45a28f6b6c387a8deb3dc7c18b4393c59c1`；`@openhands/extensions@0.36.0` | [SYNC.md](openhands-extensions/SYNC.md)；`scripts/capture.mjs`、`scripts/sync.mjs`、`scripts/provenance.mjs`；选择输入见 `source-manifest.json`，补丁见 `integration-patches/**`，输出闭包见 `resource-closure.json`/`output-inventory.json` | MIT，OpenHands contributors；[LICENSE](openhands-extensions/LICENSE) 与 [LICENSING.md](openhands-extensions/LICENSING.md) | `node scripts/check-sources.mjs`；`node --test vendor/openhands-extensions/scripts/provenance.test.mjs`；`node vendor/openhands-extensions/scripts/sync.mjs --destination . --check`；`pnpm check:licenses` |

## 子树边界

- `t3code` 是 Provider/UI 选择快照，`@pm` host 只通过登记的公共入口消费；补丁是零基精确行拼接，不做模糊匹配或整树上覆盖。
- `cc-switch` 的 Rust/Tauri 快照不再构建；行为由 `apps/server/cc-switch-host` 的 TypeScript 翻译承担，UI 保留为 `@pm/cc-switch-ui` 的公共入口。
- `openhands-extensions` 是独立的展示与扩展选择；产品自动化目录仅保留 PM 原生模板，不包含 OpenHands runtime、凭据或第二套调度器。
- 任一子树的 capture、replay、补丁或输出清单缺失都是构建/打包门禁失败，不是可跳过的脚手架；capture 是作者操作，不等于行为验收。
