---
schema: pm/v1
id: TASK-105
entity: work_item
kind: task
project: PRJ-001
parent: TASK-200
status: done
priority: high
assignee: agent:codex
labels: [markdown, schema]
related_to: [ADR-002]
---

# 实现保留注释的 Markdown 属性协议

## 目标
使用 YAML Document 修改属性，以 AST 读取标题、清单与嵌入视图，避免全文重新生成造成信息丢失。

## 完成标准
- [x] 一级标题是标题的唯一来源
- [x] 未知 YAML 字段、注释和正文不因状态修改而丢失
- [x] 非法枚举、重复 YAML 键有明确错误

## 示例
以下代码只是说明，不应被解析为真正任务清单：

```markdown
- [ ] 示例，不计入验收清单
[[NOT-A-REAL-LINK]]
```

设计记录 [[ADR-002]]。
