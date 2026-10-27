---
schema: pm/v1
id: TASK-102
entity: work_item
kind: task
project: PRJ-001
parent: TASK-100
status: in_progress # 拖拽看板时保留这条说明
priority: high
assignee: agent:codex
blocked_by:
  - TASK-101
related_to: [ADR-001]
labels: [runtime, session]
due: "2026-10-28"
# Agent 自定义数据不是 UI 的私有状态。
x-agent-context:
  native_session: "session-demo-102"
  resume_allowed: true
  notes: |
    恢复必须先确认原生会话身份。
    不修改底层 Agent 的内部数据。
---

# 实现 Session 管理

## 目标
统一 Codex、Claude Code、Pi 的会话管理。

## 背景
目前产品 Session 与原生 Agent Session 尚未建立可靠映射，页面刷新后无法判断该恢复哪个会话。

## 设计约束
- 不修改底层 Agent 的内部数据
- 允许断线后恢复
- 每次 Run 具有独立身份

## 完成标准
- [x] 定义 Session Schema
- [ ] 创建 Session API
- [ ] 实现恢复机制

## 相关文档
- [[ADR-001|Session 身份决策]]
- [[TASK-103]]：依赖本任务的恢复流程

> [!decision]
> Session 负责连续上下文，Run 负责一次执行；二者不能共用身份。

## 当前进展
已完成数据模型，正在实现后端接口。保留失败原因，避免界面把断线误报成执行成功。
