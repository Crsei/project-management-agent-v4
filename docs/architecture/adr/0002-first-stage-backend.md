# ADR-0002：第一阶段后端实现选择

日期：2026-10-16。状态：采用，受第一阶段范围约束。

| 决策 | 选择与理由 | 备选方案与代价 |
| --- | --- | --- |
| 后端事务 | PostgreSQL 16；每 Workspace 串行写事务；业务、收据和 outbox 原子提交 | 细粒度聚合锁吞吐更高，但依赖图、成员与审核竞态更复杂，后续优化时再细分 |
| 聚合存储 | 关系元数据 + JSONB；Drizzle 描述 schema，SQL migrations/pg 明确约束和事务 | 每个实体单独强类型表更利于大规模报表，但初期模型演进会增加迁移成本；JSONB 仍严格校验而非无 schema |
| 身份 | Node 平台维护的 crypto.scrypt（N=32768,r=8,p=1）及随机 opaque 会话；@fastify/cookie 负责 Cookie；本机管理 CLI 创建账号 | 完整身份框架/OIDC 可减少账号生命周期自建工作，但需独立提供方配置；首版不承诺注册、密码找回、MFA 或 SSO |
| 后台 | 持久 outbox → 授权变更流，由独立 Worker 执行；失败隔离和受审计操作员恢复 | Redis/消息队列增加服务和跨系统一致性复杂度；当前未实现通用任意任务编排 |
| 成果存储 | Linux 本地卷、目录句柄防 symlink、不可变文件、摘要与上传租约 | S3 适合多机部署，但不是当前首个部署的依赖；BlobStore 接口保持可替换 |
| 查询与实时 | REST 实体快照 + SSE 变更通知；独立持久 cursor | 将完整业务状态推入事件流会增加授权与状态恢复负担；客户端应按通知重新查询 |
| 接口 | 从实际命令 Zod schema 生成 OpenAPI3.1 和 payload 类型；Node/浏览器 fetch 客户端 | 手工维护两套 schema 容易漂移；细粒度结果 DTO 留作后续增量收紧 |
| 执行 | 第一阶段始终未初始化真实 Execution；不创建假 Run | 提前接现有 Agent Host 会混淆用户确定的第三阶段边界 |
| 验证工具 | 使用 Node 24 内置 node:test 执行真实 HTTP/PG/文件/子进程测试；TypeScript 固定 6.0.3，ESLint 10 + typescript-eslint | 初始化时 TypeScript 7 可编译，但当前 typescript-eslint 不支持它；固定兼容工具组合比关闭 lint 更可复现。参考 [官方支持范围](https://typescript-eslint.io/users/dependency-versions/) |

这份决策落实原领域 P-01 至 P-09。HTTP 外观采用命令入口和实体读取，而不是复制参考项目的路由。生命周期修复保留旧定义、旧审核和成员历史，不覆盖已经发生的事实。

当前限制：8 MiB base64 上传、Linux 本地存储、会话/成员管理以首版能力为限、无通用 job 编排或自动 blob GC。同 Workspace 写入串行，多实例吞吐和公开互联网部署加固未验收。相关限制见运行手册，不把局部检查称为生产级验收。
