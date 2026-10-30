# Agent Chat 设置面板重构（t3code 对照）

日期：2026-10-29。依据：`docs/reference/t3code-settings-inventory.zh.md`。范围：`/agent/settings/*` 与 Agent Chat 浏览器偏好；不含 Providers，不含后端合同、数据库或 Worker 变更。

## 1. 结果概览

本轮把 t3code 中“有真实消费者、且属于浏览器/设备偏好”的设置迁入 Agent Chat，并补上对应的消费路径。所有新设置都保存在此浏览器（`pm-v3:agent-browser-preferences:v1`，文档版本升到 2，兼容版本 1），不会改写已保存会话或 PM 业务数据。

| t3code ID | 设置 | 现状 | 存储/消费 |
| --- | --- | --- | --- |
| GEN-12 | 会话排序（按更新 / 按创建） | 新增 | 浏览器偏好；Agent 侧栏 active/settled 行排序 |
| GEN-24 | 回复显示方式（逐段 / 整轮） | 设置页新增入口（原 Composer 快捷切换保留） | `pm-v3:response-streaming-mode`；消息渲染 |
| GEN-27 | Diff 布局（统一 / 左右分栏） | 新增 | 浏览器偏好；`@pierre/diffs` `diffStyle` |
| GEN-33 | 发送快捷键 | 保留现有两档（Enter / Ctrl·⌘+Enter） | 浏览器偏好；Composer `submitMode` |
| GEN-43 | 归档前确认 | 新增（默认关闭） | 浏览器偏好；归档动作前 `window.confirm` |
| APP-06 | 对话宽度 | 保留现有三档 | 浏览器偏好；`--agent-chat-content-width` |
| APP-11 | 输入框字号 | 新增 12–20（默认 14） | 浏览器偏好；`--agent-chat-prompt-font-size` |
| APP-12 | 代码字号 | 新增 10–18（默认 13） | 浏览器偏好；`--agent-chat-code-font-size` |
| APP-13 | 终端字号 | 新增 8–20（默认 12） | 浏览器偏好；xterm `fontSize`，打开中的终端可实时更新 |
| APP-15 | 代码/长行自动换行 | 保留现有开关（默认关闭） | 浏览器偏好；`data-agent-chat-code-wrap` |

## 2. 改动文件

| 文件 | 改动 |
| --- | --- |
| `apps/web/src/features/agent/src/settings/browser-preferences.ts` | 偏好类型/默认值/校验扩展；版本 2 文档并兼容版本 1；新增 `getChatBrowserPreferences()`；`useChatAppearance()` 写入字号 CSS 变量与数据集 |
| `apps/web/src/features/agent/src/settings/appearance-page.tsx` | 在“对话显示”中增加输入框字号、代码字号、终端字号、Diff 布局 |
| `apps/web/src/features/agent/src/settings/chat-behavior-settings.tsx` | 新增“会话与回复”：回复显示方式、会话排序、归档前确认 |
| `apps/web/src/features/agent/src/settings/general-page.tsx` | 组合默认模型、输入与快捷键、会话与回复 |
| `apps/web/src/features/agent/src/settings/chat-preferences.css` | 新增字号变量默认值与预览字号 |
| `apps/web/src/features/agent/styles/pm-chat.css` | Composer 使用输入框字号变量；消息代码块使用代码字号变量 |
| `apps/web/src/features/agent/src/pm/chat-surface.tsx` | 读取偏好；active/settled 会话排序；归档前确认 |
| `apps/web/src/features/agent/src/workspace/inspector/terminal-panel.tsx` | 终端初始字号来自偏好；偏好变化时原地更新并 refit，不重建终端/WebSocket |
| `apps/web/src/features/agent/src/workspace/inspector/diff-view.tsx` | Diff 使用 `unified` / `split` 偏好布局 |

## 3. 明确未构建

| 范围 | 原因 |
| --- | --- |
| Providers（实例、凭据、模型目录、用量源、健康检查、价格别名） | 用户明确排除；沿用现有设置页 |
| 可配置快捷键系统（`keybindings.json`、`when` 条件、命令面板） | 当前只有静态快捷键与帮助清单，改造成本高，跳过 |
| SnapShots、窗口玻璃、面板动画、环境标识、接口字体/字体族 | 桌面端捕获或视觉层；当前 Web Agent Chat 没有对应运行时，避免假控件 |
| 通知模式 / 应用内通知 | 没有通知投递与焦点判定基础设施 |
| Integrations：浏览器预览、Browser profiles、设备/模拟器、PR 链接 | 没有浏览器或移动设备运行时 |
| Scheduled Tasks / Automation 扩展 | 现有自动化是独立业务模块，本轮不改其计划、Webhook 或模型策略 |
| Source Control：自动拉取、托管平台凭据、分支命名、提交/PR 文案、Review Guide | 没有对应集成，且不属于设置面板外观/行为层 |
| Storage：Worktree 保留、产物/日志清理、数据库整理 | 没有清理引擎；现有存储页保持不变 |
| Connections：网络暴露、Tailscale、WSL、T3 Connect、远程环境、负载均衡 | 桌面/主机基础设施 |
| 运行时权限四档、Plan/Build、排队 vs 引导、思考强度 | 后端未提供可调能力；现有 UI 继续明确显示“不可用”，不新增模拟控制 |
| 默认模型项目覆盖、`t3.json`、项目脚本 | 当前只有全局新会话默认模型；项目级覆盖需要新的服务端设置模型 |
| 文本生成模型、线程标题指令 | 没有独立的标题生成服务 |
| 自动结算、Working section、侧栏分组/预览条数 | 没有对应调度/侧栏结构；保留现有按作用域分组 |
| 删除/取消置顶确认、退出确认 | 删除保持始终确认；不为降低安全性的开关新增入口 |
| 对比度、Diff 配色、数学渲染、透明玻璃 | 当前主题来自 PM 共享外观，缺少可靠消费者 |
| 移动端 / 桌面端专属设置 | 不属于 Web Agent Chat |

## 4. 已知默认值与兼容性

- 新设置默认值保持现有显示：输入框 14 px、代码 13 px、终端 12 px、Diff 统一视图、会话按最近更新排序、归档不额外确认。
- `codeWrap` 保留现有默认 `false`；t3code 的 `wordWrap` 默认 `true`，此处未改默认，避免无提示改变现有阅读行为。
- 发送快捷键保留现有两档；t3code 的第三种 `mod-enter-multiline` 需要改 assistant-ui 提交语义，本轮跳过。
- 版本 1 偏好文档可直接读取；新字段按默认值补齐，不产生错误提示。
- 所有新增项仅在此浏览器生效，不跨设备同步，不写服务端设置。

## 5. 验证记录

已执行：

- `pnpm --filter @pm/web typecheck`：通过。
- `pnpm lint:agent`：通过。
- `pnpm --filter @pm/web build`：通过（仅既有大 chunk 警告）。
- 浏览器（真实 PM 登录、公共网关 3224）：
  - 通用页显示“会话与回复”；回复显示方式、会话排序、归档前确认可修改并持久化。
  - 外观页显示输入框/代码/终端字号与 Diff 布局；刷新后保持。
  - 根元素 CSS 变量 `--agent-chat-prompt-font-size` 为设置值；预览代码块使用代码字号，正文仍使用正文字号。
  - 版本 1 偏好文档迁移：旧值保留，新字段使用默认值，无存储错误。
  - 打开终端后，另一标签页把终端字号改为 10 px，已打开终端的字符实际变为 10 px，WebSocket 未重连。

未完成的可视验证：

- Diff 布局：当前工作区没有可显示的差异内容，未做左右分栏的截图级验证；代码路径已通过类型检查和构建。
- 会话排序、归档确认：当前测试工作区没有会话且模型未就绪，未用真实会话触发；比较器与确认分支已通过类型检查和代码审查。

## 6. 界面语言与解释性文案清理（2026-10-30）

- 通用页新增独立“语言 / Language”区块，只有“界面语言 / Interface language”（简体中文 / English），写入 PM 共用浏览器偏好 `pm.display-preferences.v1` 的 `locale`；Agent Chat 与 PM 双向同步，不新增第二份语言状态或服务端设置。
- Agent Chat 可见界面接入 `useAgentText` / `agentText`：设置导航与页面、聊天侧栏、会话参数、用量、自动化、文件/终端/差异面板、提供商设置随 locale 切换。
- 删除设置页页头说明、区块描述、纯解释性提示、预览说明与提供商弹窗说明；保留真实状态、错误、校验、破坏性确认、凭据警告和不可用原因。
- 导航不再同时显示中英双标签；当前 locale 只显示一种语言。服务端返回的动态说明与错误保持原文；模型、Provider、ID、路径、命令、cron 等数据不翻译。
- 验证（真实 PM 登录、公共网关 3224）：
  - 在通用页把界面语言切到 English，侧栏、设置页、聊天侧栏、用量页、文件/诊断/存储页和提供商页均为英文；
  - 在 PM 设置切回中文后，同一页面内导航到 `/agent/settings/general` 恢复中文；反向切换同样验证；
  - `pnpm lint:agent` 通过；`pnpm --filter @pm/web exec vite build` 通过；
  - `pnpm --filter @pm/web typecheck` 当前被并行修改的 `service-dashboard-1.tsx`、`service-dashboard-2.tsx`、`project-collection-fixture.tsx` 既有错误阻断，`features/agent` 无报错。
