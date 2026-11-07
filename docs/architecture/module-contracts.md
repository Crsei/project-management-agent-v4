# 当前模块契约

本页以当前模块职责和生成合同为准，不再把历史“43命令 / 16路径 / apps/api”当作现行边界。历史 ADR 的决策不被原地改写；Markdown 切换语义见 [ADR-0003](adr/0003-markdown-core.md)。

| 模块 | 当前入口 | 职责与边界 |
| --- | --- | --- |
| PM HTTP | `apps/server/pm/src` | 当前身份/项目授权、严格输入、健康/能力、下载、changes/SSE；不成为另一套领域规则 |
| 命令与业务策略 | `packages/application/src` | 命令注册/内核、查询、当前能力、CAS、原收据与 outbox；核心写入委托 `core-adapter`，PM附加聚合使用SQL |
| 领域规则 | `packages/domain/src` | PM 附加业务的对象/状态与守卫；旧 SQL 核心规则不得覆盖当前原生 Markdown 工作流 |
| Markdown 协议 | `packages/pm-schema`、`pm-markdown` | 九类核心实体、字段/关系/DSL 校验与保留式编解码；正式关系与正文同源 |
| 文件核心 | `packages/pm-core` | 权威文件仓库、目录映射、统一ID、幂等/墓碑、缓存索引、观测、迁移与恢复；API唯一拥有核心初始化/watcher |
| SQL/身份/存储 | `packages/infrastructure/src` | PostgreSQL/Drizzle、可审阅迁移、scrypt/会话、Local/S3 BlobStore与显式绑定；附件单文件8MiB，不自动GC |
| Worker | `apps/server/worker/src` | outbox/持久cursor、通知、邮件、受限Webhook与保留维护；核心只读，不是Agent执行器 |
| PM 合同/客户端 | `packages/contracts`、`docs/contracts/openapi.yaml` | Zod注册表生成命令payload/OpenAPI和客户端；当前清单以生成结果为准，不手维护数量 |
| Agent 合同/客户端 | `packages/agent-contracts`、`agent-client-runtime` | Chat/版本化执行选择与实际环境、Provider/输出/用量及同源HTTP/WS；代码目录登记由PM应用服务拥有，不把Agent记录变成PM业务权威 |
| Agent 宿主 | `apps/server/agent/src` | Chat/输出持久化、冻结环境复核、Provider lease/transport、PM工具桥、交付/自动化及服务内PTY；使用现有单进程Agent SQLite，不创建第二套任务权威或跨重启终端恢复 |
| 自动化资源 | `packages/automation-resources/{catalog,pm-catalog,native-template-arguments}.ts` | 固定OpenHands目录/脚本bundle和PM目录唯一装配；`packages/contracts/src/automation-catalog.ts`只定义宿主DTO，不新增包或dependency |
| 固定上游模块 | `vendor/t3code`、`vendor/cc-switch` | 实际协议/驱动及MCP/Skills配置能力；来源、补丁和许可按各同步/来源清单记录，不从外部仓库动态读取 |
| Web / Desktop | `apps/web`、`apps/desktop` | 一个Web工程复用于浏览器/桌面；前端只显示真实能力，桌面管理独立本地服务组 |

## 写入与恢复

PM 命令入口为 `/api/v1/workspaces/{workspaceId}/commands`。`project`、`work_item`、`milestone` 等被核心适配的命令不再将 SQL `entities` 当任务事实源；原生 `/core` 入口使用文件 revision/CAS 与创建幂等键，创建意图/核对不能伪造成通用命令收据。核心命令回执仍保存至 `command_receipts`，业务附加记录和对应 SQL 收据/outbox 由同事务维护。

`pnpm contracts:generate` 生成 PM OpenAPI 与payload类型，`pnpm contracts:check` 防漂移。原生核心API保留 `{error, diagnostics, current?}` 等诊断语义；已持久化 rejected 命令收据与HTTP传输错误分开。部分 `data/result` 仍较通用，客户端不能据此跳过schema校验。

客户端网络超时/响应丢失后保留原 commandId/operationId，查询原结果，不自动换键重派。文件与SQL的恢复由持久journal/事实收据核对，不宣称跨存储事务；外部Git/PR/Provider副作用也不能由本地回滚撤销。

## Agent 与业务规则

PM17工具共享注册表和应用执行器；Chat只短期转发当前PM认证，不把Cookie/Authorization持久化或送入Provider环境。归档/恢复/删除/状态转换仍逐次执行当前能力、确认、revision和原生守卫；模型、CLI或CI成功不决定任务完成。Provider宿主的身份/Scope/continuation规范见[宿主合同](provider-host-contract.md)。Agent自有consumer通过 `providers/t3code` 的真实配置/路径/执行适配接口；`node scripts/check-import-boundaries.mjs` 以精确importer/module pair限制vendor直连（包括type/export/dynamic/require/URL），不放行整个适配树；该导入约束不改变业务授权或完成规则。

Agent当前为本机单操作者，不是多租户会话隔离或文件沙箱。**会话与持久化仍暂沿用Agent Chat，统一设计尚未收口。**
