---
schema: pm/v1
id: TASK-106
entity: work_item
kind: task
project: PRJ-001
parent: TASK-200
status: in_progress
priority: high
assignee: human:lin
blocked_by: [TASK-105]
labels: [interface, kanban]
---

# 实现可回写 Markdown 的看板拖拽

## 目标
拖动卡片改变状态，并让编辑器与磁盘文件同步展示同一次修改。

## 交互约束
拖拽只修改 status；失败必须回滚。选中文档有未保存草稿时，不允许模糊地合并属性操作。

## 完成标准
- [x] 展示四种工作流状态
- [ ] 拖拽跨列写回正确文件
- [ ] 保存失败后显示原因并恢复卡片
- [ ] 支持在项目文档内嵌入同一看板

接口基于 [[TASK-105]]；并发策略参见 [[ADR-003]]。
