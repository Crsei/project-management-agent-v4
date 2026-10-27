---
schema: pm/v1
id: TASK-108
entity: work_item
kind: subtask
project: PRJ-001
parent: TASK-107
status: todo
priority: low
assignee: human:chen
blocked_by: [TASK-107]
labels: [interface, relationships]
related_to: [TASK-106, ADR-002]
---

# 展示任务层级与阻塞关系图

## 目标
分别呈现 parent 层级与 blocked_by 依赖，不把文档引用误认为阻塞关系。

## 完成标准
- [ ] 树中可折叠 Epic、Task 与 Subtask
- [ ] 图中用不同边样式区分父子、阻塞与相关关系
- [ ] 点击节点能跳到同一 Markdown 文件
- [ ] 缺失目标与循环引用不会造成界面死循环

本任务是 [[TASK-107]] 下的独立子任务，不是其正文中的复选框。
