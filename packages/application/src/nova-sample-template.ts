/** Built-in Nova demonstration content. No deployment identities, credentials or history.
 * Stable local keys are remapped to each new workspace’s persisted Markdown IDs.
 * Dates are fixed examples, not a current delivery commitment.
 */
export const novaSampleTemplate = {
  "version": 1,
  "key": "nova-v1",
  "project": {
    "title": "Nova 客户门户 · 示例项目",
    "body": "这是一个可安全编辑的演示项目，用来展示工作区从规划到交付的主要功能。所有内容都由工作区初始化流程写入当前工作区的真实 Markdown，不是只读截图。\n\n## 从这里开始\n\n1. 打开 [[tour|示例项目导览]] 查看功能地图。\n2. 在项目看板、列表和时间线之间切换，观察同一批任务的三种视图。\n3. 打开 [[navigation]] 查看依赖、设置负责人和添加评论。\n4. 在文档中尝试编辑、双链跳转和保存。\n\n## 演示内容\n\n| 对象 | 数量 | 说明 |\n| --- | --- | --- |\n| 任务 | 8 | 覆盖 done / in_progress / todo / canceled 与 epic、bug、subtask |\n| 里程碑 | 2 | 一个进行中、一个计划中 |\n| 迭代 | 2 | 当前迭代与下一迭代 |\n| 模块 | 3 | 设计、客户端、文档 |\n| 需求 | 3 | approved 与 draft |\n| 发布 | 2 | 内部演示与公开预览 |\n| 目标 | 2 | 包含目标值与单位 |\n| 文档 | 4 | 导览、设计、决策、验收 |\n\n> [!warning]\n> 示例项目用于功能演示，不承诺真实交付。删除或修改前请确认受众。",
    "fields": {
      "goal": "用一组真实可编辑的示例数据，展示工作区从规划、协作到交付的完整流程。",
      "labels": [
        "示例项目",
        "功能导览"
      ],
      "status": "active",
      "start": "2026-10-01",
      "due": "2026-12-20"
    }
  },
  "items": [
    {
      "key": "journey",
      "entity": "work_item",
      "title": "梳理客户门户用户旅程",
      "body": "- [x] 访谈管理员、项目负责人和只读成员\n- [x] 输出登录 → 工作区 → 项目 → 任务的旅程图\n- [x] 标记三个高频入口\n\n结论已同步到 [[design|交付设计说明]]。",
      "fields": {
        "kind": "task",
        "priority": "high",
        "labels": [
          "研究",
          "体验"
        ],
        "due": "2026-10-17",
        "milestone": "demo-milestone",
        "cycle": "experience-cycle",
        "module": "design-module",
        "requirement": "real-data",
        "goals": [
          "demo-goal"
        ],
        "status": "done"
      }
    },
    {
      "key": "navigation",
      "entity": "work_item",
      "title": "设计工作区首页与项目导航",
      "body": "- [x] 首页信息层级方案 A 确认\n- [x] 项目树展开偏好按账号和工作区隔离\n- [ ] 补充键盘路径和无障碍标签\n\n依赖已完成的需求梳理 [[journey]]。",
      "fields": {
        "kind": "task",
        "priority": "urgent",
        "labels": [
          "设计",
          "UI"
        ],
        "due": "2026-10-28",
        "estimated_duration_days": 3,
        "milestone": "demo-milestone",
        "cycle": "experience-cycle",
        "module": "design-module",
        "requirement": "real-data",
        "goals": [
          "demo-goal"
        ],
        "blocked_by": [
          "journey"
        ],
        "status": "in_progress"
      }
    },
    {
      "key": "project-views",
      "entity": "work_item",
      "title": "实现项目看板与列表视图",
      "body": "- [ ] 看板按工作流状态分组\n- [ ] 列表展示负责人、优先级和截止日期\n- [ ] 空态与后端错误态明确区分\n\n上游设计见 [[navigation]]。",
      "fields": {
        "kind": "task",
        "priority": "high",
        "labels": [
          "前端",
          "项目视图"
        ],
        "due": "2026-11-05",
        "estimated_duration_days": 5,
        "milestone": "demo-milestone",
        "cycle": "collaboration-cycle",
        "module": "web-module",
        "requirement": "editable-data",
        "goals": [
          "demo-goal"
        ],
        "blocked_by": [
          "navigation"
        ],
        "status": "in_progress"
      }
    },
    {
      "key": "activity-order",
      "entity": "work_item",
      "title": "活动流按发生时间稳定排序",
      "body": "复现：同一分钟内产生的两条事件偶发顺序颠倒。\n\n- [ ] 用事件时间 + 序号作为稳定排序键\n- [ ] 回归同一分钟的事件顺序",
      "fields": {
        "kind": "bug",
        "priority": "medium",
        "labels": [
          "缺陷",
          "活动流"
        ],
        "due": "2026-10-26",
        "milestone": "demo-milestone",
        "cycle": "collaboration-cycle",
        "module": "web-module",
        "requirement": "editable-data",
        "status": "done"
      }
    },
    {
      "key": "release-notes",
      "entity": "work_item",
      "title": "编写发布说明与迁移指引",
      "body": "该任务被 [[acceptance|验收清单]] 取代了部分范围，已取消，保留记录用于演示 canceled 状态。",
      "fields": {
        "kind": "task",
        "priority": "low",
        "labels": [
          "文档"
        ],
        "due": "2026-11-25",
        "milestone": "preview-milestone",
        "module": "docs-module",
        "requirement": "narrow-screen",
        "goals": [
          "docs-goal"
        ],
        "status": "canceled"
      }
    },
    {
      "key": "drag-hints",
      "entity": "work_item",
      "title": "为看板卡片补齐拖拽提示",
      "body": "子任务展示：父项为 [[project-views]]。",
      "fields": {
        "kind": "subtask",
        "priority": "low",
        "due": "2026-11-01",
        "milestone": "demo-milestone",
        "cycle": "collaboration-cycle",
        "module": "web-module",
        "parent": "project-views",
        "status": "todo"
      }
    },
    {
      "key": "faq-migration",
      "entity": "work_item",
      "title": "整理旧版 FAQ 迁移清单",
      "body": "该任务已逾期，用于演示工作区的「逾期」分组。\n\n- [ ] 列出旧版 FAQ 链接\n- [ ] 标记需要重写或删除的条目",
      "fields": {
        "kind": "task",
        "priority": "medium",
        "labels": [
          "文档",
          "迁移"
        ],
        "due": "2026-10-19",
        "module": "docs-module",
        "requirement": "narrow-screen",
        "status": "todo"
      }
    },
    {
      "key": "portal-epic",
      "entity": "work_item",
      "title": "客户门户 MVP",
      "body": "用于演示 epic 类型的汇总任务，具体工作由关联任务承载。",
      "fields": {
        "kind": "epic",
        "priority": "high",
        "due": "2026-11-15",
        "milestone": "demo-milestone",
        "cycle": "experience-cycle",
        "goals": [
          "demo-goal"
        ],
        "status": "in_progress"
      }
    },
    {
      "key": "tour",
      "entity": "document",
      "title": "示例项目导览：功能地图与操作说明",
      "body": "这份文档属于 [[nova|Nova 客户门户 · 示例项目]]，用于展示工作区的主要功能。它是真实保存的 Markdown 文档，不是截图或只读演示。\n\n> [!note] 打开内容就能编辑\n> 「内容」页直接提供 Markdown 正文和实时预览。修改后点击保存或按 Ctrl/Cmd+S；「高级源码」同时显示属性与正文。\n\n## 1. 功能地图\n\n| 入口 | 可以观察什么 |\n| --- | --- |\n| 项目概览 | 目标、负责人、状态、进度、里程碑与近况 |\n| 看板 / 列表 / 时间线 | 任务状态分布、字段排序与日期视图 |\n| 工作区首页 | 我的任务、即将截止、最近动态与项目进度 |\n| 文档 | 本导览、设计与决策记录；双链可跳转对象 |\n| 任务详情 | 状态、优先级、负责人、依赖和评论 |\n\n## 2. 实时任务表格\n\n下面的表格由当前项目任务生成，修改任务状态后读取的是同一份保存事实。\n\n```pm-view\nentity: work_item\nproject: nova\nlayout: table\ncolumns: [id, title, status, priority, assignee, due]\norder_by:\n  - field: id\n    direction: asc\n```\n\n## 3. 看板\n\n```pm-view\nentity: work_item\nproject: nova\nlayout: kanban\ngroup_by: status\n```\n\n> [!warning]\n> 看板中的卡片是真实任务。拖动卡片会写入业务状态，不要仅为体验而打乱示例流程。\n\n## 4. 关系图\n\n```pm-view\nproject: nova\nlayout: graph\n```\n\n## 5. 依赖与层级\n\n- [[navigation]] 依赖已完成的需求梳理 [[journey]]。\n- [[project-views]] 依赖设计任务；[[drag-hints]] 是它的子任务。\n- [[activity-order]] 是缺陷，[[portal-epic]] 是 epic，[[release-notes]] 已取消，[[faq-migration]] 已逾期。\n\n依赖写在任务属性 blocked_by 中；文内双链只是导航，不改变工作流。\n\n## 6. Markdown 能力\n\n**粗体**、*斜体*、~~删除线~~、`行内代码`、++下划线++、H~2~O 和 x^2^。\n\n- [x] 提示块、清单、表格与代码块可以保存\n- [ ] 勾选这个清单项只会修改本文档草稿\n  - [ ] 嵌套清单同样不会创建子任务\n\n> [!tip]\n> 行首输入 / 或按 Ctrl/Cmd+P 可以搜索编辑命令。\n\n> [!risk]\n> 并发修改会产生 revision 冲突；核对双方内容后再保存，不要重复覆盖。\n\n> [!decision]\n> 示例数据与真实业务数据分离，删除示例项目不会影响其他项目。\n\n行内公式：$E=mc^2$。\n\n$$\n\\text{完成比例}=\\frac{\\text{已完成任务}}{\\text{任务总数}}\n$$\n\n```mermaid\nflowchart LR\n  A[登录] --> B[选择工作区]\n  B --> C[项目]\n  C --> D[任务与文档]\n```\n\n```ts\nconst task = { project: 'nova', status: 'todo' };\nconsole.log(task.status);\n```\n\n=={yellow}黄色高亮==、=={green}绿色高亮==、{color:blue}蓝色文字{/color}。\n\n## 7. 评论与协作\n\n可以在 [[navigation]] 和 [[activity-order]] 添加你自己的评论；模板不复制原部署的评论、账号或历史。评论保存在 PostgreSQL，不写入任务 Markdown。编辑、删除和恢复都会记录版本。\n\n## 8. 数据边界\n\n| 能力 | 当前状态 |\n| --- | --- |\n| 项目、任务、文档、评论编辑 | 已启用 |\n| 里程碑、迭代、模块、需求、发布、目标 | 已用示例数据展示 |\n| 附件与文件 | 项目文件页按真实上传结果显示；本项目未上传附件 |\n| Agent Chat | 按实际 Provider 配置和授权使用；模板不携带账号、凭据或执行历史 |\n| 多人逐键合编 | 未启用；当前是 revision 冲突与 SSE 通知 |\n\n> 示例内容可直接编辑，也可以整体删除；删除前请确认没有其他成员把它当作草稿。\n\n本模板保留固定示例日期，用于练习日历和时间线，不代表实际交付排期。负责人默认不分配，请按本工作区真实成员选择。",
      "fields": {
        "document_kind": "note",
        "labels": [
          "示例",
          "导览"
        ],
        "related_to": [
          "nova",
          "journey",
          "navigation",
          "project-views",
          "activity-order",
          "faq-migration",
          "demo-milestone",
          "experience-cycle",
          "design-module",
          "real-data",
          "internal-release",
          "demo-goal",
          "design",
          "decision",
          "acceptance"
        ]
      }
    },
    {
      "key": "design",
      "entity": "document",
      "title": "交付设计说明：工作区信息架构",
      "body": "## 目标\n\n让新成员在三次点击内回答三个问题：我在哪个工作区、项目进行到哪一步、我接下来要做什么。\n\n## 结构\n\n1. 侧栏顶部切换工作区，下面依次是个人入口、工作区聚合入口和项目树。\n2. 内容区只有一条上下文顶栏，避免重复标题。\n3. 项目内固定项目范围；工作区聚合页面可跨项目筛选。\n\n## 首页优先级\n\n| 区域 | 内容 | 数据来源 |\n| --- | --- | --- |\n| 问候与快捷入口 | 真实姓名、权限入口 | 会话与权限 |\n| 我的任务 | 待办、进行中、已完成 | 当前项目事实 |\n| 项目进度 | 任务完成比例 | 项目聚合 |\n| 最近动态 | 评论、状态与文档变化 | 活动投影 |\n\n## 检查项\n\n- [x] 首页不加载伪造示例数组\n- [x] 工作区根路径按保存偏好跳转\n- [ ] 窄屏下检查横向溢出\n\n参考任务 [[journey]] 与 [[navigation]]。",
      "fields": {
        "document_kind": "design",
        "labels": [
          "设计",
          "信息架构"
        ],
        "related_to": [
          "nova",
          "journey",
          "navigation",
          "project-views",
          "real-data",
          "demo-milestone"
        ]
      }
    },
    {
      "key": "decision",
      "entity": "document",
      "title": "决策记录：示例数据与真实业务分离",
      "body": "- 状态：已采纳\n- 日期：2026-10-25\n\n## 背景\n\n演示需要可操作的数据，但示例内容不能冒充客户交付，也不能污染其他工作区。\n\n## 决策\n\n示例项目使用独立目录、独立项目 ID 和显式「示例项目」标签；所有内容通过工作区初始化流程写入，复制或删除只影响本工作区。\n\n## 后果\n\n- 演示可以直接编辑、评论和调整状态。\n- 删除或归档示例内容沿用现有关系检查与显式确认，不影响其他工作区。\n- 自动化验收不把示例数据当作交付证据。",
      "fields": {
        "document_kind": "decision",
        "labels": [
          "决策",
          "安全"
        ],
        "related_to": [
          "nova",
          "tour"
        ]
      }
    },
    {
      "key": "acceptance",
      "entity": "document",
      "title": "验收清单：v0.1 内部演示",
      "body": "| 编号 | 检查项 | 关联 |\n| --- | --- | --- |\n| AC-1 | 登录后进入授权工作区，无示例回退 | [[real-data]] |\n| AC-2 | 项目看板、列表和时间线读取真实任务 | [[project-views]] |\n| AC-3 | 活动流同一分钟事件顺序稳定 | [[activity-order]] |\n| AC-4 | 任务评论可编辑并保留历史 | [[navigation]] |\n| AC-5 | 窄屏 390px 无横向溢出 | [[narrow-screen]] |\n\n- [ ] 手动走查全部入口\n- [ ] 记录截图与失败项\n- [ ] 发布前确认示例数据保留还是删除",
      "fields": {
        "document_kind": "specification",
        "labels": [
          "验收",
          "发布"
        ],
        "related_to": [
          "nova",
          "internal-release",
          "real-data",
          "project-views",
          "activity-order"
        ]
      }
    },
    {
      "key": "real-data",
      "entity": "requirement",
      "title": "首次登录即可看到真实项目数据",
      "body": "不加载示例数组，不伪造空态；后端不可用时明确报错。",
      "fields": {
        "priority": "high",
        "milestone": "demo-milestone",
        "module": "web-module",
        "release": "internal-release",
        "status": "approved"
      }
    },
    {
      "key": "editable-data",
      "entity": "requirement",
      "title": "示例数据可直接编辑并持久化",
      "body": "正文、状态和评论写入 Markdown 与数据库，刷新后保持。",
      "fields": {
        "priority": "medium",
        "milestone": "demo-milestone",
        "module": "design-module",
        "release": "internal-release",
        "status": "approved"
      }
    },
    {
      "key": "narrow-screen",
      "entity": "requirement",
      "title": "窄屏也能完成核心浏览",
      "body": "登录、项目列表、任务详情和评论在 390px 宽度无横向溢出。",
      "fields": {
        "priority": "medium",
        "module": "web-module",
        "status": "draft"
      }
    },
    {
      "key": "demo-goal",
      "entity": "goal",
      "title": "完成可演示的端到端工作区",
      "body": "从登录、工作区浏览到项目协作都能走通真实数据路径。",
      "fields": {
        "target": 8,
        "unit": "关键任务",
        "start": "2026-10-01",
        "due": "2026-11-15",
        "status": "active"
      }
    },
    {
      "key": "docs-goal",
      "entity": "goal",
      "title": "交付文档与发布说明",
      "body": "让新成员能自助理解示例数据和功能边界。",
      "fields": {
        "target": 3,
        "unit": "文档与发布条目",
        "start": "2026-10-15",
        "due": "2026-11-30",
        "status": "planned"
      }
    },
    {
      "key": "demo-milestone",
      "entity": "milestone",
      "title": "MVP 可演示版本",
      "body": "- [ ] 项目看板、列表与时间线可用\n- [ ] 示例文档和评论可编辑\n- [ ] 发布说明完成",
      "fields": {
        "due": "2026-11-15",
        "goals": [
          "demo-goal"
        ],
        "status": "active"
      }
    },
    {
      "key": "preview-milestone",
      "entity": "milestone",
      "title": "公开预览版本",
      "body": "- [ ] 迁移指引完成\n- [ ] 示例数据清理路径确认",
      "fields": {
        "due": "2026-12-20",
        "goals": [
          "docs-goal"
        ],
        "status": "planned"
      }
    },
    {
      "key": "design-module",
      "entity": "module",
      "title": "体验设计",
      "body": "旅程、信息架构与交互稿。",
      "fields": {
        "start": "2026-10-12",
        "due": "2026-10-31",
        "status": "active"
      }
    },
    {
      "key": "web-module",
      "entity": "module",
      "title": "Web 客户端",
      "body": "项目视图、任务编辑与评论。",
      "fields": {
        "start": "2026-10-20",
        "due": "2026-11-15",
        "goals": [
          "demo-goal"
        ],
        "status": "active"
      }
    },
    {
      "key": "docs-module",
      "entity": "module",
      "title": "文档与发布",
      "body": "导览、验收清单和发布说明。",
      "fields": {
        "start": "2026-11-01",
        "due": "2026-11-30",
        "goals": [
          "docs-goal"
        ],
        "status": "planned"
      }
    },
    {
      "key": "internal-release",
      "entity": "release",
      "title": "v0.1 内部演示",
      "body": "只用于内部功能演示。",
      "fields": {
        "version": "0.1.0",
        "start": "2026-10-25",
        "due": "2026-11-20",
        "goals": [
          "demo-goal"
        ],
        "status": "planned"
      }
    },
    {
      "key": "preview-release",
      "entity": "release",
      "title": "v0.2 公开预览",
      "body": "补齐迁移与运维说明。",
      "fields": {
        "version": "0.2.0",
        "start": "2026-11-21",
        "due": "2026-12-20",
        "goals": [
          "docs-goal"
        ],
        "status": "planned"
      }
    },
    {
      "key": "experience-cycle",
      "entity": "cycle",
      "title": "Sprint 1 · 体验基座",
      "body": "用户旅程、首页与导航。",
      "fields": {
        "start": "2026-10-19",
        "due": "2026-11-01",
        "goals": [
          "demo-goal"
        ],
        "status": "active"
      }
    },
    {
      "key": "collaboration-cycle",
      "entity": "cycle",
      "title": "Sprint 2 · 协作闭环",
      "body": "看板、列表、活动流与评论。",
      "fields": {
        "start": "2026-11-02",
        "due": "2026-11-15",
        "goals": [
          "demo-goal"
        ],
        "status": "planned"
      }
    }
  ]
} as const;
