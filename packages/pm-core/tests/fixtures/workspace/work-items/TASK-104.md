---
schema: pm/v1
id: TASK-104
entity: work_item
kind: bug
project: PRJ-001
parent: TASK-100
status: in_progress
priority: medium
assignee: agent:pi
blocked_by: [TASK-101]
labels: [runtime, events]
---

# 修复并行 Run 日志串流

## 问题
只按 Session 路由的输出会把前一次执行的迟到事件附加到新 Run。

## 方案
同时使用 Session ID 与 Run ID 路由事件，保留单次执行的终止标记。

## 完成标准
- [x] 定位迟到事件路径
- [ ] 对终止后的日志归档但不污染当前执行
- [ ] 两个并行任务的输出始终隔离

依赖 [[TASK-101]] 定义的事件身份。
