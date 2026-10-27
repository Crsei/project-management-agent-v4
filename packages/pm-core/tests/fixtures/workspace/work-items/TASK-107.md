---
schema: pm/v1
id: TASK-107
entity: work_item
kind: task
project: PRJ-001
parent: TASK-200
status: todo
priority: medium
assignee: human:chen
blocked_by: [TASK-105]
labels: [interface, table]
---

# 增加任务表格与行内属性编辑

## 目标
让用户按状态、优先级与标题整理任务，并在表格中直接更新属性。

## 完成标准
- [ ] 项目、关键词、状态、优先级筛选互相组合
- [ ] 支持标题与优先级排序
- [ ] 行内编辑复用属性命令，不创建第二份数据源
- [ ] 可保存查询配置，刷新后恢复

与 [[TASK-106]] 共用写入路径，协议见 [[ADR-002]]。
