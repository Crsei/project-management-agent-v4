---
schema: pm/v1
id: TASK-101
entity: work_item
kind: task
project: PRJ-001
parent: TASK-100
status: done
priority: high
assignee: agent:codex
labels: [runtime, protocol]
related_to: [ADR-001]
---

# 定义 Runtime 事件与身份协议

## 目标
区分工作区 Session、原生 Agent Session 和单次 Run，避免重试造成历史消息重复归属。

## 交付说明
Session 保存稳定映射；Run 保存独立执行 ID；事件携带两者并使用单调序号去重。

## 验收清单
- [x] 定义 Session 与 Run 字段
- [x] 定义开始、输出、结束事件
- [x] 与 [[TASK-102]] 的 API 约定对齐

决策记录：[[ADR-001]]。
