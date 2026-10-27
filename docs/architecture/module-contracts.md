# 当前模块契约

| 模块 | 实际入口 | 职责与边界 |
| --- | --- | --- |
| 领域规则 | `packages/domain/src` | 对象定义、状态及图约束；不处理 HTTP/数据库事务 |
| 命令内核 | `packages/application/src/kernel.ts` | 规范化 UUID、请求摘要、收据、当前授权、CAS、事务、outbox |
| 规划/意图/交付 | application 下同名模块 | 严格 Zod payload 与 handler，组成 43 个正式命令；通过 CommandContext 变更对象 |
| 查询与访问 | `queries.ts`、`access.ts` | 同一读取快照中的权限与实体，projectIds 过滤及分页、成员能力管理 |
| 内容存储 | `infrastructure/src/blobs.ts` | 8 MiB 单文件上限、原子不可变发布、路径安全、SHA-256 校验；Linux 文件描述符实现 |
| 持久化 | `database.ts`、`schema.ts`、migrations | Drizzle schema 描述、可审阅 SQL 迁移；显式事务及复杂约束使用 pg SQL |
| 身份 | `auth.ts` | scrypt 密码、散列后的 opaque 会话、过期/退出；API 以 HttpOnly Cookie 或 Bearer 会话鉴权 |
| 后台与流 | `outbox.ts`、`changes.ts`、Worker | 同工作区锁内发布、连续持久 cursor、去重、保留期限、失败隔离与受控重试 |
| HTTP 及客户端 | `apps/api`、`packages/contracts` | 16 个路径；Zod 注册表生成 OpenAPI 与命令 payload 类型；客户端写入不盲重试 |

跨模块接口在 [并行实现约定](../implementation/backend-interface-agreement.md) 定义。OpenAPI 和客户端由 `pnpm contracts:generate` 生成，`pnpm contracts:check` 防止漂移。实体 `data` 和命令 `result` 当前保持通用 JSON/unknown，细粒度查询 DTO 是第二阶段适配时可增量收紧的部分。

外部命令统一使用 `/api/v1/workspaces/{workspaceId}/commands`，并不提供可以直接改任意状态字段的 CRUD 接口。targetId 与 expectedVersions 由命令决定；RecordReview 同时要求 Submission 和 WorkItem 的版本。

错误返回分为 HTTP 错误信封和已持久化的 rejected 命令收据。对网络超时或丢失响应，客户端保留原 commandId 查询结果；查不到结果不等于已经证明外部执行失败。本阶段没有外部 Agent 副作用。
