# Application

已实现 43 个命令、查询、授权检查、幂等、跨聚合协调、outbox 发布与变更流读取。API 和 Worker 使用同一应用边界，未来 Runner 回报也须接入该边界。

`kernel.ts` 统一处理 UUID 规范化、当前授权、版本、原子收据和 outbox；`registry.ts` 组合规划、意图、交付与访问命令。SQL 适配和命令上下文的稳定边界见 `ports.ts`，正式 payload 契约由同一 registry 生成。
