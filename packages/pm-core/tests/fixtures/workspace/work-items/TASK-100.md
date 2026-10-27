---
schema: pm/v1
id: TASK-100
entity: work_item
kind: epic
project: PRJ-001
status: in_progress
priority: high
assignee: team:runtime
labels: [runtime, milestone]
due: "2026-10-30"
---

# 统一 Agent Runtime 生命周期

## 目标
为不同 Coding Agent 提供一致的 Session、Run 与恢复语义，不侵入 Agent 原生数据。

## 范围
基础协议 [[TASK-101]]、Session 管理 [[TASK-102]]、恢复 [[TASK-103]] 与运行日志 [[TASK-104]]。

## 完成标准
- [x] 约定 Session 与 Run 的独立身份
- [ ] 断线后可找回正确的原生会话
- [ ] 同一任务的多个 Run 可追踪且不串流

## 设计依据
见 [[ADR-001]]。
