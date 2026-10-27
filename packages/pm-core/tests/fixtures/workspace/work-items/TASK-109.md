---
schema: pm/v1
id: TASK-109
entity: work_item
kind: bug
project: PRJ-001
parent: TASK-200
status: todo
priority: urgent
assignee: agent:claude
blocked_by: [TASK-105]
labels: [filesystem, concurrency]
related_to: [ADR-003]
---

# 防止外部编辑被过期草稿覆盖

## 问题
用户在编辑器输入时，Agent 可能直接修改同一个磁盘文件。仅凭界面中的旧对象写回会丢失 Agent 的更新。

## 方案
提交携带源文件 revision；服务端提交前比较实际磁盘哈希。监听事件更新索引，但不替换本地草稿。

## 完成标准
- [ ] 外部变更触发 SSE 刷新
- [ ] 冲突返回当前磁盘内容供人工比较
- [ ] 非法外部 YAML 保留最后有效索引并显式标记过期
- [ ] 重复 ID 不会静默覆盖其他文件

决策详见 [[ADR-003]]。
