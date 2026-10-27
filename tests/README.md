# 跨包验收测试

按 [场景规格](../docs/domain-design/scenarios.md) 与实施计划 INF 场景实现真实 PostgreSQL、文件存储、HTTP、Worker 与 SSE 集成测试。

| 文件 | 范围 |
| --- | --- |
| backend.integration.test.ts | 人工完整业务闭环、幂等/CAS、审核竞态、授权、文件字节、事件分页及 SSE |
| uuid-audit.test.ts | UUID 大小写、依赖环、唯一转化、最后管理员、历史引用和重开恢复 |
| worker-process.integration.test.ts | 两个真实 Worker 进程并发、停止后积压、新进程恢复、心跳与 readiness |
| outbox-recovery.integration.test.ts | 十次失败隔离、真实进程重启、受审计 CLI 恢复、日志失败回滚 |

`pnpm test:backend` 从私有 `.env` 加载 DATABASE_URL，并串行运行全部后端单元/合同/集成测试。每个数据库套件使用独立随机 schema；文件和子进程由各测试创建并仅清理自有资源。未配置数据库时的 skip 不是通过证据。

实际常驻服务验收另用 `pnpm smoke` / `pnpm smoke:verify`，备份另用 `pnpm backup:verify`。真实 Agent 和浏览器 UI 不在本轮后端测试范围。
