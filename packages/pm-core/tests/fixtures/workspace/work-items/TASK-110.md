---
schema: pm/v1
id: TASK-110
entity: work_item
kind: task
project: PRJ-001
parent: TASK-200
status: canceled
priority: low
assignee: agent:pi
labels: [agent, context]
related_to: [ADR-001, ADR-002]
---

# 为每次执行自动附加完整工作区

## 原方案
在每次 Agent Run 前，将整个工作区的 Markdown 自动拼接为上下文。

## 取消原因
完整工作区会引入大量无关内容。改为按稳定 ID 显式导出任务、项目、父项、依赖与关联文档。

> [!decision]
> 使用 `pm context TASK-102` 获取可检查的最小相关上下文；不替 Agent 隐式扩大读取范围。

## 替代验收标准
- [x] 记录取消原因
- [ ] 显式上下文导出包含反向引用

相关协议 [[ADR-002]]，Session 设计 [[ADR-001]]。
