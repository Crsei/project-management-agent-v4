---
schema: pm/v1
id: TASK-200
entity: work_item
kind: epic
project: PRJ-001
status: in_progress
priority: high
assignee: team:experience
labels: [markdown, collaboration]
due: "2026-11-03"
---

# 打通 Markdown 与项目面板

## 目标
让文档、属性编辑、看板与 Agent CLI 操作同一份文件，并清楚呈现草稿与磁盘冲突。

## 交付内容
- [[TASK-105]]：无损属性协议
- [[TASK-106]]：看板操作
- [[TASK-107]]：属性表格
- [[TASK-108]]：关系图与任务树
- [[TASK-109]]：文件监听与冲突处理
- [[TASK-110]]：上下文导出

## 完成标准
- [x] Markdown 协议可独立阅读
- [ ] 四种视图与正文数据一致
- [ ] 外部编辑不会被静默覆盖

参考 [[ADR-002]] 与 [[ADR-003]]。
