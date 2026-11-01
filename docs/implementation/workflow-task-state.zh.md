# 工作流节点与任务状态联动

2026-11-01，用户确认按节点结果联动任务阶段。范围：INV-01/03/05/09/13/14/15/20、SC-03/12/13/14。遵守 [Markdown 核心 ADR](markdown-integration-adr.zh.md)；不恢复历史 SQL 完成守卫，不新增权限或修改既有任务状态机。

- 第一版支持进入开发节点时 `todo → in_progress`（已经进行中可记录同状态收据），以及同提交的测试、Draft PR 与 CI 成功后 `in_progress → review`。自定义状态 ID 不做猜测；核心配置不支持这些状态/边时明确拒绝。
- 节点可选择关闭、自动联动、人工确认。进入开发节点联动在派发 Agent 前执行，以免在途 Agent 在状态 revision 切换窗口误失去绑定；表示开始处理，不冒充模型已完成或成功启动。待审核仅为任务阶段，Submission/Review 仍是独立附加流程，不自动生成验收结论。此链不能写 done/canceled，也不回退人工状态。
- 工作流应用服务验证触发条件，PM 应用策略限制目标状态，再由现有 `executeAuditedCoreMutation` 调用核心 CAS、配置状态边、实时成员权限和审计。没有直接写 Markdown、SQL 或客户端状态的旁路。
- 首次请求前持久化 run/node/原 revision 和稳定操作键；失败/丢响应暂停。显式恢复只查询原核心收据（可补齐原审计，不重写任务）。没有收据不推断成功或重放。人工提前改为相同目标状态也不能冒充系统收据。
- 固定需求输入 revision 永不更改；另记 `acceptedTaskRevision`，只接纳本运行已确认状态转换收据产生的 revision。任何额外编辑、取消、归档或项目改绑仍暂停。原手动交付没有版本豁免。不会全局改变内容版本或正式提交的版本语义。
- 旧模板 v1、旧运行保持原行为；新预制版本显式包含联动，并在启动授权中列出，未勾选不得执行。执行状态、节点结果、状态转换结果分别展示。工作流结束不代表任务完成。

**会话与持久化仍暂沿用 Agent Chat 基础存储；统一设计尚未收口。** 本模块沿用工作流 SQLite 和 PM 核心收据，不宣称跨存储分布式事务或完整多实例 Runner。

## 前一轮验证记录

以下保留当时结果；后续真实闭环与已修复项见[投资人 POC 验收](investor-poc.zh.md)。

- 定向工作流/交付/运行时测试 52 项通过；新增真实 PostgreSQL + Markdown 核心集成测试 1 项通过（未跳过），覆盖原生状态边、CAS 并发、精确作用域、权限撤销、审计去重与重启后的原收据恢复。Agent/GitHub 仍使用测试替身，不算真实模型端到端验收。
- OpenAPI 测试 7 项通过，生成与漂移检查通过。重新生成契约同时补齐生成器中已存在的 lifecycle 结果定义，未更改该领域实现。
- 受影响 ESLint/oxlint、定向 application/PM/contracts 类型检查、Agent 和 Web 类型检查，以及后端、Agent、Web 构建通过。Web 保留既有 chunk 和混合 import 提示。
- 全量 `pnpm test:backend --file-timeout-ms 180000`：126 文件，889 用例，879 通过、3 失败、7 跳过。失败仍为既有不可写目录测试（root 环境）、artifact-files-model、local-project-backup；S3 7 项跳过且按未通过计入文件结果。4 个文件未全通过，不宣称全绿。原 OpenAPI 漂移失败已由重新生成契约消除。
- `pnpm check` 仍被既有文档缺失链接 `.omp/agents/codex-sol.md` 阻断；全根类型检查仍有 notification-inbox / project-files / artifact-files-model 的 6 项既有错误，未扩大修改范围修复。
- 已仅重启 v4 服务，PM / Agent / Web / Worker HTTP 检查正常，实时 OpenAPI 已包含新状态转换与收据核对入口；这不代表 Provider 或真实 Agent 执行验收通过。
- 浏览器实测（v4 前端 4326）：确认开发模板 v2、开发节点默认自动联动、CI 默认人工确认；切换关闭/自动/人工模式，发布隔离项目模板“开发交付 · 状态联动示例”，重新读取仍保留配置。未启动 TASK-002、未创建分支/提交/PR，任务仍为 todo。截图位于本地 `.local/logs/workflow-state-link.png`。
- 公共入口 3224 的工作流目录请求超时，而直接请求与同后端 4326 入口正常；多个实时连接占用为待核实原因，不宣称已修复。刷新后 Provider 返回明确未就绪：Codex 的 workspace routing discovery timed out，Claude CLI 未安装；故未验证启动授权弹窗或真实 Agent → CI → 状态流转端到端。

## 后续真实闭环（2026-11-01）

公共入口 3224 的 TASK-002 已通过 `builtin-deliver` v3 完成真实 Codex 开发、独立验证、提交/推送、Draft PR #2 与同提交必需 CI `test`。开发节点自动申请 `todo → in_progress`，CI 成功后经明确确认申请 `in_progress → review`；两个状态转换均记录原始请求与回执，刷新后仍可读。工作流结束，任务停在待审核，暂无人工 GitHub 评审；没有合并、部署或自动完成。详细链接、SHA、运行 ID 与检查边界见[本轮 POC 记录](investor-poc.zh.md)。
