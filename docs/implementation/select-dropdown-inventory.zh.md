# 下拉组件与原生 Select 盘点

日期：2026-11-02
范围：`apps/web/src`、`packages/pm-views`；`vendor/*` 只作为上游实现参考，不计入本仓业务调用量。
口径：按 JSX 开标签 `<select` 计数，`NativeSelect` 单独统计；排除 `node_modules`、`dist`。

## 1. 汇总

| 类别 | 处数 | 文件数 |
| --- | ---: | ---: |
| 直接 `<select>` | 164 | 75 |
| `NativeSelect` 封装（底层仍是 `<select>`） | 13 | 9 |
| **原生 Select 合计** | **177** | **84** |

真正经过设计、非原生的下拉只有 `apps/web/src/components/ui/select.tsx`（Radix Select），当前仅 11 个文件引用。

> 以下第 1–4 节为 2026-11-02 迁移前盘点；迁移决策与执行结果见第 5、6 节。

## 2. 原生 `<select>` 分布

### 2.1 PM 生产区（88 处 / 43 文件）

| 区域 | 文件与处数 |
| --- | --- |
| `features/pm/markdown`（36 / 14） | `TaskCreationSurface` 7、`TaskDetailSurface` 5、`workspace` 5、`TaskFilterCard` 4、`DocumentObjectActions` 2、`EntityFields` 2、`ProjectCreationFields` 2、`TaskCodeDeliveryPanel` 2、`TaskCollectionView` 2、`DocumentContentEditor` 1、`DocumentSourceSettings` 1、`DocumentSources` 1、`TaskDocumentFields` 1、`WorkspaceEditors` 1 |
| `features/pm/service`（20 / 17） | `project-files/index` 2、`project-files/UploadDialog` 2、`service-dashboard-2` 2、`dashboard-sprints` 1、`dashboard-time` 1、`local-directory-fields` 1、`local-project-settings` 1、`pm-members` 1、`pm-ui` 1、`project-files/LifecycleDialog` 1、`project-local-location` 1、`project-task-editing` 1、`service-project-detail-panels` 1、`settings-invoices` 1、`settings-layout` 1、`settings-notifications` 1、`settings-preferences` 1 |
| `features/pm/workflows`（13 / 2） | `WorkflowCanvas` 10、`TaskWorkflowPanel` 3 |
| `components/blocks`（9 / 4） | `filter-card` 3、`schedule-view-controls` 2、`work-items-filter` 2、`work-items-toolbar` 2 |
| `packages/pm-views`（5 / 2） | `index.tsx` 3（status / priority / group-by）、`KnowledgeGraph` 2 |
| `features/pm/components`（4 / 3） | `service-dependency-graph` 2、`service-gantt` 1、`service-whiteboard` 1 |
| `features/pm/product-roadmap`（1 / 1） | `ProductRoadmapPage` 1 |

### 2.2 Agent UI（70 处 / 30 文件）

| 区域 | 文件与处数 |
| --- | --- |
| `agent/src/settings`（28 / 11） | `appearance-page` 9、`provider-model-settings` 4、`default-model-settings` 3、`chat-behavior-settings` 2、`model-option-controls` 2、`provider-instance-dialog` 2、`session-settings-dialog` 2、`file-areas-page` 1、`input-preferences` 1、`language-settings` 1、`provider-auth-dialog` 1 |
| `agent/src/pm/automation`（28 / 9） | `studio-editor` 8、`studio-dashboard` 4、`studio-integrations` 4、`studio-templates` 4、`studio-import` 2、`studio-pm-candidate-fields` 2、`studio-setup-action` 2、`page` 1、`studio-pm-parameters` 1 |
| `agent/src/workspace`（8 / 5） | `automation-panel` 3、`agents-panel` 2、`inspector/browser-panel` 1、`runs-panel` 1、`workflows-panel` 1 |
| `agent/components`（2 / 1） | `assistant-ui/elements/settings-panel` 2 |
| `agent/src/chat`（1 / 1） | `branches` 1 |
| `agent/src/showcase`（2 / 2） | `app` 1、`scenario-explorer` 1 |
| `agent/src/usage`（1 / 1） | `UsagePage` 1 |

### 2.3 Lab / 示例视图（6 处 / 2 文件）

`views/pm/hour-calendar` 3、`views/pm/schedule-views` 3。

### 2.4 NativeSelect 调用点（13 处 / 9 文件）

| 文件 | 处数 |
| --- | ---: |
| `features/pm/service/settings/settings-general` | 3 |
| `features/pm/service/settings/settings-workspace` | 2 |
| `features/pm/service/settings/plugin-webhook-status` | 2 |
| `features/pm/components/service-board` | 1 |
| `features/pm/components/service-table` | 1 |
| `features/pm/pm-variant-navigation` | 1 |
| `features/pm/service/settings/settings-plugins` | 1 |
| `features/pm/service/settings/settings-workspace-identity` | 1 |
| `views/pm/hour-calendar-fixture` | 1 |

### 2.5 相关原生控件

4 处 `<datalist>` 自动补全，不属于 Select，但同属原生表单下拉体验：

- `features/pm/markdown/TaskCreationSurface.tsx`（labels）
- `features/pm/markdown/TaskDetailSurface.tsx`（labels）
- `features/pm/markdown/TaskDocumentFields.tsx`（labels）
- `features/pm/service/project-task-editing.tsx`（assignee）

## 3. 经过设计的下拉组件

以下为迁移前组件清单；`native-select.tsx` 与 `menu.tsx` 已在迁移中删除。

### 3.1 本仓主设计系统：`apps/web/src/components/ui`

| 组件 | 实现 | 引用文件数 | 说明 |
| --- | --- | ---: | --- |
| `select.tsx` | Radix `@radix-ui/react-select` | 11 | 自定义 `SelectTrigger` / `SelectContent` / `SelectItem`，统一 `OverlayLayer`、主题 Portal、44px 触屏高度；兼容 Base UI `items` 入参但直接丢弃 |
| `dropdown-menu.tsx` | Radix `@radix-ui/react-dropdown-menu` | 27 | 操作菜单、筛选菜单、子菜单；统一浮层样式和 `render` 触发元素 |
| `menu.tsx` | 同一 Radix DropdownMenu | **0** | 与 `dropdown-menu.tsx` 并行的第二套封装，当前无调用方 |
| `combobox.tsx` | Radix Popover + 自管输入/过滤/多选 | 1 | 仅 `components/blocks/work-item-properties.tsx`（标签/指派人选择）使用 |
| `popover.tsx` | Radix `@radix-ui/react-popover` | 38 | 日期、筛选、账户菜单等自建浮层；多个选择器用它手搓，而不是用 Select |
| `native-select.tsx` | 原生 `<select>` | 9 | 只统一样式，不改变原生弹层 |
| `segmented.tsx` | 自定义分段控件 | 5 | 非下拉，但承担部分“选项切换”语义 |

`select.tsx` 的调用方：`components/blocks/work-item-properties`、`settings-profile`、`views/pm/{dashboard-1-fixture,dashboards-views,inbox-1,issues-views,member-directory-3,people-controlled-fixture,project-collection,project-detail-2-panels,projects-views}`。

### 3.2 Agent 本地设计系统：`apps/web/src/features/agent/components/ui`

Base UI（`@base-ui/react`）子集：`avatar`、`button`、`collapsible`、`dialog`、`input`、`separator`、`sheet`、`sidebar`、`tooltip`。**没有** Select、Dropdown、Combobox、Popover 封装。

Agent 业务代码因此直接使用 Base UI：

| 文件 | 直接使用的原语 |
| --- | --- |
| `agent/src/pm/product-switcher.tsx` | `@base-ui/react/menu` |
| `agent/src/pm/session-menu.tsx` | `@base-ui/react/menu` |
| `agent/src/pm/chat-surface.tsx` | `@base-ui/react/menu` |
| `agent/src/pm/sidebar-project-chooser.tsx` | `@base-ui/react/popover` |
| `agent/src/pm/user-menu.tsx` | `@base-ui/react/popover` |

另外两处跨栈引用：

- `agent/components/assistant-ui/elements/composer-traits-picker.aui.tsx`、`thread.aui.tsx`、`usage/UsagePage.tsx` 使用主设计系统的 `dropdown-menu`。
- `composer-model-picker.aui.tsx` 使用 `@easyuse-ui/ui/components/ui/popover`（上游 Base UI 实现）。

### 3.3 上游 EasyuseUI：`vendor/ui`

`vendor/ui`（包名 `@easyuse-ui/ui`）是 Base UI 版本：`select.tsx`、`native-select.tsx`、`combobox.tsx`、`dropdown-menu.tsx`、`popover.tsx` 均为 Base UI 原语 + 同一套 Token/Overlay 封装。

本仓主设计系统的 `select.tsx` / `combobox.tsx` 是它的 Radix 重写版，不是直接复用：

- 上游 `select.tsx`：`@base-ui/react/select`。
- 本仓 `select.tsx`：`@radix-ui/react-select`，并保留 Base UI 调用形状的兼容层。
- 上游 `combobox.tsx`：`@base-ui/react/combobox`。
- 本仓 `combobox.tsx`：Radix Popover + 自行实现过滤/多选。

`vendor/agent-workspace-views` 中有 35 个文件引用 EasyuseUI 的 select/native-select/combobox/dropdown-menu，主要集中在 Agent showcase 视图；这些不在本仓 `apps/web/src` 的直接改造范围。

## 4. 是否统一（迁移前）

以下为 2026-11-02 迁移前状态；迁移结果见第 6 节。

**不统一。** 当前至少四套并存：

| 栈 | 原语 | 使用范围 | 状态 |
| --- | --- | --- | --- |
| A. PM 主设计系统 | Radix | PM 正式页面、部分 Agent assistant-ui | 有完整 Select/Dropdown/Combobox/Popover，但 Select 采用率低 |
| B. Agent 本地栈 | Base UI | Agent 外壳菜单/浮层 | 无下拉封装，直接调用原语 |
| C. 上游 EasyuseUI | Base UI | Agent showcase、vendor 视图 | 与本仓 Radix 版本并行 |
| D. 原生 `<select>` | 浏览器 | 177 处、84 文件 | 仍为主流“下拉”实现 |

主设计系统内部也有重复：

1. `dropdown-menu.tsx` 与 `menu.tsx` 封装同一 Radix primitive，后者零引用。
2. `select.tsx` 采用率 11 个文件，而原生 `<select>` 有 177 处；同一设置页族里 `settings-general` 用 `NativeSelect`、`settings-preferences` 用裸 `<select>`、`settings-profile` 用 Radix Select。
3. 多个“选择器”实际用 `popover.tsx` 手搓（日期、筛选、账户菜单），交互与键盘语义和 Select/Combobox 不共享。
4. `combobox.tsx` 只有 1 个调用方，能力没有扩散。
5. `packages/pm-views` 完全不依赖主设计系统，直接输出裸 `<select>`；它同时被 PM 正式详情页和 markdown 任务面引用。

## 5. 决策（2026-11-02）

唯一标准：**Radix**。所有下拉、菜单、Popover 选择器只使用 `apps/web/src/components/ui` 中的 Radix 封装；不再新增 Base UI 或原生 `<select>` 入口。

- 单/多选下拉：`components/ui/radix-select.tsx`（Radix Select + Radix Popover）承接既有 `<option>` 调用形状。
- 新代码优先使用 `components/ui/select.tsx` 复合 API；需要沿用原生 `<option>` 结构时使用 `RadixSelect`。
- 菜单统一 `components/ui/dropdown-menu.tsx`；浮层统一 `components/ui/popover.tsx`。
- `packages/pm-views` 不能依赖 `apps/web`，使用包内 `RadixSelect.tsx`（仍为 Radix Select），并新增 `@radix-ui/react-select` 依赖。

## 6. 执行记录（2026-11-02）

已完成：

| 项 | 结果 |
| --- | --- |
| `apps/web/src` 原生 `<select>` | 0（`native-select.tsx` 已删除） |
| `packages/pm-views` 原生 `<select>` | 0（改用包内 `RadixSelect.tsx`） |
| `NativeSelect` 调用点 | 13 处全部改为 `RadixSelect` |
| Agent Base UI Menu/Popover | 5 个直接调用文件改为主设计系统 Radix 封装 |
| Agent EasyuseUI Popover | 2 个调用文件改为本地 Radix Popover |
| 死代码 | 删除 `components/ui/menu.tsx`（0 引用） |
| CSS | 39 个 CSS 文件、129 个 `select` 类型选择器改为 `[data-slot="select-trigger"]` |
| 触发器元素 | 使用 `div role="combobox"` + `data-slot="select-trigger"`，避免被通用 `button` 选择器覆盖 |
| `closeOnClick` | `DropdownMenuItem` / CheckboxItem / RadioItem 在 `false` 时 `preventDefault()`，保持菜单打开 |

边界说明：

- Radix Select 会渲染一个隐藏的原生 `<select>` 用于表单与辅助技术；可见下拉由 Radix 弹层提供，不构成浏览器原生下拉。
- `vendor/ui` 与 `vendor/agent-workspace-views` 是外部 EasyuseUI 源码，仍为 Base UI；本仓未改写。
- `@base-ui/react` 仍用于 Agent 的 Dialog、Sheet、Tooltip 等非下拉组件，不属于本次范围。

验证：

- `pnpm --filter @pm/web exec vite build` 通过。
- `pnpm --filter @pm/web lint` 通过；Agent 迁移文件定向 ESLint 通过。
- `pnpm --filter @pm/web typecheck` 的迁移文件无错误；当前仅剩并行开发中的 `packages/pm-views/KnowledgeGraphCanvas.tsx` 自身类型错误，不属于本次下拉改动。
- Storybook 临时冒烟：单选空值、多选、`optgroup`、菜单 `closeOnClick={false}`、子菜单；实际点击打开/选择与菜单保持打开通过。临时 Story/预览改动已移除。
- `pnpm check:docs` 通过。
