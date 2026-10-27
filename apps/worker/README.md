# Worker

已实现独立 Node 进程，周期发布持久 outbox、维护连续事件游标/保留期限、清理过期认证会话并报告心跳。事件写入、游标和发布标记在同一 Workspace 锁事务内提交；唯一 eventId 及发布状态承担当前单一消费者的去重职责，不另设无用途 inbox 表。

发布失败指数退避，累计十次后隔离工作区；本机维护 CLI 查询/重试，保留原事件身份和审计。两个独立 Worker 的并发发布与重启恢复已由真实进程测试覆盖。它不派发 Agent、不替代业务审核，也尚未实现通用 job 调度或 blob GC。

构建后可用 `pnpm worker` 前台运行，或 `pnpm services:start` 与 API 一并管理。操作说明见 [运行手册](../../deploy/README.md)。
