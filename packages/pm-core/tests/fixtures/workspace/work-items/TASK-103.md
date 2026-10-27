---
schema: pm/v1
id: TASK-103
entity: work_item
kind: task
project: PRJ-001
parent: TASK-100
status: todo
priority: urgent
assignee: agent:claude
blocked_by: [TASK-102]
labels: [runtime, recovery]
due: "2026-10-29"
---

# 支持断线后恢复原生会话

## 目标
连接中断后，通过可靠的 Session 映射继续执行，而不是隐式创建一个新会话。

## 恢复流程
先读取 [[TASK-102]] 保存的身份与执行状态，再确认对应 Agent 是否支持 resume。不支持恢复时明确说明原因。

## 完成标准
- [ ] 重连时显示会话与最近执行状态
- [ ] 支持显式恢复，不重复提交上一条输入
- [ ] 已结束的 Run 不继续接收新事件

约束来源：[[ADR-001]]。
