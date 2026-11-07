# t3code / cc-switch / OpenHands 集成边界整理计划

## 目标与授权

本计划对应本轮用户授权：整理三方关系、解决不合理耦合，并由子代理执行。仅修改本仓库；不迁移或拆分源码目录，不升级上游 pin，不创建 PM 业务任务，不提交、推送或发布 PR。以下 draft 编号只是实施计划引用，不是正式任务 ID。

会话与持久化仍暂沿用 Agent Chat，统一设计尚未收口；本轮不修改该设计。

## 已核对基线

- t3code 提供 Provider 能力；cc-switch 提供 MCP/Skills 管理能力；PM 宿主协调配置变更与 Provider 缓存刷新。
- `apps/server/agent/src/providers/t3code/management.ts` 和 `packages/agent-contracts/src/provider.ts` 同时被 t3code 派生账本和 cc-switch 整文件 asset recipe 认领。上一轮只读检查确认两套已接受哈希及实际文件一致，无需提取 CC 专属差异。
- OpenHands 是既有 CC 管理宿主中的展示层。上一轮实际重算发现 23 个 CC 独立边界输入；上游更新命中的五个只是交集。四个涉及运行时组件/Hook，`types.ts` 的直接引用仅用于类型。
- 本轮开始时工作树有 85 个已跟踪修改和一个未跟踪目录，涉及并行 UI 工作及既有维护工具修订。不得重置、覆盖或替其批量批准来源指纹。
- 当前未查询 PM 业务任务；本计划不声称与项目管理系统里的任务去重。

## 目标关系

1. PM 分别消费 Provider 和扩展管理适配能力；PM 已有的配置通知链继续存在，不为形式上的解耦增加空壳服务。
2. 每份宿主派生输出只有一个重放权威。CC 不再复制或重放上述两个 T3/PM 宿主文件；通过明确的所有者引用与消费者验证检查兼容性，不用另一份旧字节冻结实现。
3. OpenHands 通过 CC 已有公开包入口消费必要能力，不直接导入 CC 内部源码路径。保留真实组件、Hook、授权上下文、管理 portal 和单例 providers，不重写功能。
4. 上游源码、适配配方、真实依赖闭包、许可证和产物身份继续校验。公开入口收敛不等于运行时依赖消失。

## 候选工作与验收

| 编号 | 成果 | 范围与非目标 | 验收 | 前置依赖 |
| --- | --- | --- | --- | --- |
| draft:T1 | 单一宿主输出所有权 | CC capture/replay/维护 profile 和相关策略；保留两个宿主实现及 T3 来源元组，不改业务规则 | CC 不重放或重新登记两个文件；实际文件由其所有者账本核验；消费者类型/行为门禁保留；非法重登记和失配失败 | 无 |
| draft:T2 | OpenHands 公开消费边界 | 现有 CC Web 入口、OpenHands 消费者及其 alias 策略；不迁移组件、不复制类型、不降低 strict 检查 | OpenHands 不再直接导入 CC 内部文件；CC 自身闭包覆盖所有公开实现；不存在新增循环；管理功能和 portal/lifecycle 行为保留 | 无 |
| draft:T3 | 一致的来源记录 | 父代理独占整合 CC/OH inventory、recipes、resource closure，以及真正受影响的 T3 宿主工具指纹 | 精确重建修改后输出；旧副本删除；既有并行修改不被默许捕获；未知来源/路径/接口变动仍阻塞 | draft:T1、draft:T2 |
| draft:T4 | 实际验证与公开说明 | 受影响 lint、类型、回归、构建及真实管理界面 smoke；更新已有公开维护指南 | 报告实际命令和结果；功能验证与来源验证分开；环境/并行工作阻塞明确记录，不写成全通过 | draft:T3 |

`draft:T3 depends_on draft:T1` 与 `draft:T3 depends_on draft:T2`：来源生成必须基于最终源码和策略。

`draft:T4 depends_on draft:T3`：不能用旧 inventory 或旧构建证明新边界。

T1/T2 可并行；各子代理只编辑自身源码/策略，不运行测试、构建、格式化或 capture。父代理统一生成来源记录并执行验证。CC fork-policy 由 T1 所有；OpenHands fork-policy 与 CC Web 入口由 T2 所有，跨片需求通过消息交接。

## 实施约束

- 公开入口仅显式导出消费者确实使用的 API，避免 `export *` 和新增低层 bridge→UI 循环。
- 所有权移交必须是两个精确路径的受审阅处置，不是忽略所有宿主文件、所有 type-only import 或所有 snapshot-only 文件。
- 仅将整文件哈希挪到 `hostBuildInputs` 不算完成更新解耦。所有者的来源证据仍必须有效，消费者的编译与配置失效行为仍必须通过。
- 不关闭 `BLOCKED_CROSS_FORK`，不自动批准其他 fork 的任意变化，不将上游升级混入本轮。
- 不接管现有服务。UI smoke 使用核对后的本项目实例或隔离临时端口；不读取真实凭据。
- 若并行修改阻塞全仓构建/来源核验，保留其原样，完成本轮可独立验证部分并准确报告缺失证据。

## 验证要点

- 两个宿主文件只保留一个重放权威；CC 清洁重放不创建它们，重复重放和冲突预检保持原语义。
- Owner reference 不接受未登记文件、错误所有者/类型、内容或模式失配；不能借此绕过生产兼容性校验。
- 配置变更仍使相关 Provider 的 Skills 快照与旧扫描 claim 失效；无关实例不受影响；不改变 revision、不结束活跃会话。
- OpenHands 的 MCP 自定义编辑、高级矩阵、显式连通性检查/取消、Skills 展示及弹窗仍走原实现。
- 生产构建继续核验 CC/OH 的实际源代次、真实依赖与许可资源；公开入口后端的实现不能变成未覆盖源码。

## 执行记录

### 已完成的实施

- `draft:T1`：CC 策略和输出清单登记两个精确 `externalHostOutputs` 引用，所有者为 T3 派生账本。删除 CC 重复输出及两个旧 asset recipe；capture 不再自动重新登记。实际校验所有者登记、不可变输入元组、反向配方、字节和模式；未将旧指纹转移到 `hostBuildInputs`。
- `draft:T2`：OpenHands 的 23 个 CC 内部模块边界收敛到现有 `@pm/cc-switch-ui` 入口。生产闭包确认原 23 个模块均由 CC 自身覆盖，OpenHands 只登记该公开入口。内部导入、type-only/dynamic/relative 绕过和 alias 换目标均有拒绝回归。
- `draft:T3`：父代理使用精确 pin 的隔离 checkout，按明确改动路径批准并生成两方 inventory、recipes 和 closure。CC 的 7 个修改输出和 OpenHands 的 22 个修改输出/共享工具输入被精确审阅；后续仅为一处 unused-binding lint 修正重录对应 helper。样式构建没有改变其已登记字节。T3 sync inventory 未改，两个宿主运行实现与上游 pin 未改。
- `draft:T4`：下列检查和真实路径已执行；公开说明已更新到 `docs/guides/upstream-source-maintenance.md` 及两方 `SYNC.md`。没有提交、推送、PR 或现有服务重启。

### 实际验证

| 检查 | 实际执行范围 | 结果 |
| --- | --- | --- |
| 来源与维护回归 | CC/OH provenance、CC profile；core/T3 profile/publisher | 133 个测试通过，0 失败、0 跳过；35 个受影响来源测试在最终 helper 修正后重新通过 |
| Provider/真实原生集成 | `extensions/provider-bindings.test.ts`、`extensions/service.integration.test.ts`、`providers/t3code/management.test.ts`、`providers/skills.test.ts`，`node --conditions=development --test` | 11 个测试通过，0 失败、0 跳过；使用真实 debug sidecar、临时 Home/配置，包括真实 MCP 握手、关联结果及取消命令 |
| 严格类型检查 | `tsc --noEmit -p apps/web/tsconfig.json`、Agent `tsconfig.json` 和 `tsconfig.test.json` | 均通过 |
| 受影响 lint | 明确修改的 CC/OH helpers、profile、公开入口和 OH 源码，`oxlint --deny-warnings` | 84 个文件，0 warning、0 error |
| 文档检查 | `node scripts/check-docs.mjs` | 113 个公开 Markdown 及其链接/领域编号通过；内部本计划不作为公开依赖 |
| CC 清洁重放 | `sync.mjs --source <exact-pin-checkout> --destination <owned-temp>`，随后同目标 `--check` | 创建 1651 个输出，重复核对创建 0；两份外部宿主文件和 T3 owner metadata 均未被创建 |
| OpenHands 清洁重放 | `sync.mjs --destination <owned-temp>`，随后同目标 `--check` | 创建 617 个输出，重复核对创建 0 |
| 生产 Web 构建 | 当前实际 Vite 配置，`vite build --configLoader runner`；Bubblewrap 只读源码、禁网络、屏蔽 `.env`、产物写临时目录 | 10757 个模块构建成功；CC/OH source-generation 与 runtime/legal 插件保持启用 |
| 实际产物复核 | `verifyWebDistribution(tempDist, repository)` | 产物、两方源代次、运行模块和许可资源核验通过 |

### 浏览器与真实宿主烟测

使用临时挂载入口加载实际 `CcSwitchManagement` 和 `OpenHandsExtensionSurface`，连接真实 `ExtensionHost` 与现有 `cc-switch-host` debug 二进制；仅登记临时 Codex Home，没有模型账号或生产数据：

- 通过表单保存 `boundary-created` HTTP 定义，服务端权威数据核对 URL 和 ID；打开页面/保存定义没有自动启动探测。
- 打开高级矩阵并显式分配 Codex，再点击连接检查。故意不可达的本地地址返回关联 `batchId` 的 `connected:false`，未伪装连接成功。
- 使用真实 ZIP 安装路径准备临时 Skill，浏览器显示实际已安装条目、内容摘要及 Codex 分配，打开详情。
- 确认 MCP 编辑器仍挂载到 CC 管理内容容器，Skill 详情仍挂载到唯一管理 portal；稳定入口复核没有页面异常。

烟测中修正了自动化选择器错误和临时入口热更新重复 `createRoot` 的验证夹具问题；后者触发了现有单实例挂载保护，不是放宽保护后继续。关闭旧页后以稳定入口完整复核编辑器、矩阵和 Skill 弹窗。浏览器只允许回环域名，外部图标 CDN 请求被主动阻止，不能据此宣称外部素材网络验收。

### 验收边界

- stylesheet 原有 `duration-[120ms]` 歧义提示、生产构建的大 chunk 和既有 workflow-canvas 混合静态/动态导入提示仍在，未为本轮改规则或压制警告。初次扩大 lint 范围发现未改动 closure scanner 的既有 control-regex warning；最终 lint 精确覆盖受影响文件。
- 未运行全仓 `check:ci all`、桌面打包、全量 Rust 重建或真实 Provider/模型账号验收。真实 native smoke 使用现有 debug binary，不等于新的发行版原生构建。
- 现有 `apps/web` alias 配置属于并行改动，本轮不删除其中已经不用的内部 source alias；OpenHands 自身源码和生产来源规则已禁止使用它。其他共享宿主工具/锁文件来源约束继续有效。
- 临时浏览器与本轮独占服务已关闭，不接管公共入口或后台服务。临时源码、重放和构建目录不是安装或发布依赖。
- 会话与持久化仍暂沿用 Agent Chat，统一设计尚未收口。
