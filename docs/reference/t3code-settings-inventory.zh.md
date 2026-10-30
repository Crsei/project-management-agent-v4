# T3 Code 设置项全量清单（对照参考）

日期：2026-10-29。来源：只读检查 `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/t3code`，提交 `d53873b6a4799e87afd63c8d288ef0089f5a3748`（2026-10-24）。

用途：作为本项目（project-management-agent-v4）Agent Chat 设置逐项对照的基线。本文只记录 t3code 的事实，不表示本项目已实现或应当照搬；未实现能力不得据此对外宣称支持。

取证方式：

- 合同层：`packages/contracts/src/settings.ts`（客户端/服务端设置 schema 与默认值）、`keybindings.ts`、`t3ProjectFile.ts`、`scheduledTask.ts`、`providerInstance.ts`、`preview.ts`、`browserProfile.ts`、`project.ts`、`providerPolicy.ts`。
- 页面层：`apps/web/src/routes/settings.*.tsx`、`apps/web/src/components/settings/*`、`apps/mobile/src/features/settings/*`。
- 驱动层：`packages/provider-*/src/settings.ts`、`apps/server/src/settingsSecrets.ts`、`apps/desktop/src/settings/*`。

## 0. 阅读约定

作用域缩写：

| 缩写 | 含义 | 存储/生效范围 |
| --- | --- | --- |
| C | Client / device | 每台设备独立。桌面写入 `client-settings.json`；浏览器写入 `localStorage`（`t3code:client-settings:v1`）；移动端写入本机偏好 |
| S | Environment / server | 该环境的所有客户端共享，写入环境状态目录 `settings.json` |
| P | Project override | 值存放在 `settings.json` 的 `projectSettingsOverrides[projectId]`，覆盖 S；`null` 的语义按字段不同 |
| R | Repository file | 仓库根目录 `t3.json`，可被 P / S 覆盖 |
| T | Thread | 随线程保存，只影响当前线程 |
| D | Desktop only | 仅 Electron 桌面端；写入 `desktop-settings.json` |
| M | Mobile only | 仅 iOS/Android 客户端；写入本机偏好 |
| A | 只读/派生 | 展示或诊断信息，不是用户可改设置 |

统一模型：`UnifiedSettings = Omit<ServerSettings, "favorites" | "providerModelPreferences"> & ClientSettings`。客户端设置与服务端设置合并后按作用域解析；写服务端设置需要 `settings:write`，写 provider 实例/用量源额外需要 `providers:manage`。

## 1. 设置入口与作用域速览

Web/桌面设置侧栏共 13 个入口：

| 页面 | 路径 | 主要作用域 | 主要内容 |
| --- | --- | --- | --- |
| General 常规 | `/settings/general` | S + C + P | 默认模型/权限、项目与线程组织、通知、Composer 行为、确认、文本生成、关于 |
| Appearance 外观 | `/settings/appearance` | C（主题为浏览器本地；`defaultTheme` 为 S） | 主题、对比度、玻璃透明度、Diff 颜色、聊天宽度、数学渲染、动画、字体、换行 |
| Keybindings 快捷键 | `/settings/keybindings` | S（`keybindings.json`） | 命令绑定与 `when` 条件 |
| SnapShots 截图 | `/settings/snap-shot` | C + D | 截图开关、快捷键、声音、闪光、动画 |
| Providers 提供方 | `/settings/providers` | S | Provider 实例、二进制/配置目录/参数、模型收藏与显隐、用量源、健康检查 |
| Integrations 集成 | `/settings/integrations` | S + C + P | Agent 浏览器/设备访问、浏览器预览默认值、录音、链接打开方式、搜索、PR 链接 |
| Scheduled Tasks 定时任务 | `/settings/scheduled-tasks` | 任务对象 | 计划、提示词、模型、权限模式、工作区策略、Webhook |
| Source Control 版本控制 | `/settings/source-control` | S + P | 托管平台凭据、自动拉取、合并方式、分支命名、提交/PR 文案、Review Guide |
| Storage 存储 | `/settings/storage` | S + P | Worktree 保留与清理、浏览器产物/日志保留、Worktree 目录、数据库空间 |
| Connections 连接 | `/settings/connections` | D + S | 本机后端、网络暴露、Tailscale、WSL、配对、远程环境、负载均衡、PR 路由 |
| Archive 归档 | `/settings/archived` | P | 已归档线程恢复/删除 |
| Diagnostics 诊断 | `/settings/diagnostics` | S + A | 资源遥测、日志、进程、失败、OTLP 导出 |
| Project 项目 | `/settings/projects` | P + R | 项目图标、checkout、Actions/脚本、项目级覆盖 |

线程内还有独立一层：模型、Provider 实例、推理强度、运行时权限、Plan/Build、工作区模式、分支。见第 14 节。

## 2. General（常规）

### 2.1 默认值与新线程

| ID | 界面项 | 键 | 可选值 | 默认 | 作用域 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| GEN-01 | Default model / 默认模型 | `defaultModelSelection` | `{instanceId, model, options[]}` 或 `null` | `null` | S/P | 新线程默认模型；`null` 表示随 Provider 默认 |
| GEN-02 | Permissions / 权限 | `defaultRuntimeMode` | `approval-required`（Supervised）、`auto-accept-edits`、`auto`、`full-access` | `full-access` | S/P | 新线程默认运行时权限；`auto` 仅部分 Provider 支持 |
| GEN-03 | Project defaults and overrides | `projectSettingsOverrides` | 每项目一组覆盖 | `{}` | P | 见第 13 节 |
| GEN-04 | New threads / 新线程工作区 | `defaultThreadEnvMode` | `local`、`worktree`、`null` | `null` → `t3.json` → `local` | S/P/R | `null` 表示继承仓库配置 |
| GEN-05 | Submodules / 子模块 | `worktreeSubmodules` | `recursive`、`top-level`、`none`、`null` | `null` → `t3.json` → `recursive` | S/P/R | 新 worktree 的子模块初始化方式 |
| GEN-06 | Start from remote / 从远端开始 | `newWorktreesStartFromOrigin` | boolean | `true` | S/P | 新 worktree 使用远端最新提交 |
| GEN-07 | Add project starts in | `addProjectBaseDirectory` | 路径字符串 | `""` | S | 添加项目时的起始目录 |
| GEN-08 | Automatically pull | `defaultAutoPull` | boolean | `false` | S/P | 默认分支自动 fast-forward |
| GEN-09 | Project scripts / Actions | `defaultProjectScripts`、`projectScriptOverrides` | `ProjectScript[]` | `[]` / `{}` | S/P | 见 13.2 |

### 2.2 组织（Organization）

| ID | 界面项 | 键 | 可选值 | 默认 | 作用域 |
| --- | --- | --- | --- | --- | --- |
| GEN-10 | Project grouping / 项目分组 | `sidebarProjectGroupingMode`；`sidebarProjectGroupingOverrides` | `repository`（合并同名仓库）、`repository_path`（按路径）、`separate`（不合并）；每项目覆盖 | `repository` / `{}` | C |
| GEN-11 | Project order / 项目排序 | `sidebarProjectSortOrder` | `updated_at`、`created_at`、`manual` | `updated_at` | C |
| GEN-12 | 线程排序 | `sidebarThreadSortOrder` | `updated_at`、`created_at` | `updated_at` | C |
| GEN-13 | 线程预览条数 | `sidebarThreadPreviewCount` | 整数 1–15 | `6` | C |
| GEN-14 | Sidebar (legacy) | `legacySidebarEnabled` | boolean | `false` | C |
| GEN-15 | Working section (beta) | `sidebarWorkingShelfEnabled` | boolean | `false` | C |
| GEN-16 | Snooze limited threads | `snoozeLimitedThreads` | boolean | `false` | S |
| GEN-17 | Auto-resume limited threads | `autoResumeLimitedThreads` | boolean | `false` | S |
| GEN-18 | Auto-settle inactive threads | `sidebarAutoSettleAfterDays` | 整数 1–90 或 `null` | `3` | S/P |
| GEN-19 | Auto-settle merged threads | `sidebarAutoSettleOnMerge` | boolean | `true` | S/P |
| GEN-20 | Keep threads with a PR | `sidebarAutoSettleKeepPullRequests` | boolean | `false` | S/P |

### 2.3 行为（Behavior）

| ID | 界面项 | 键 | 可选值 | 默认 | 作用域 |
| --- | --- | --- | --- | --- | --- |
| GEN-21 | Thread notifications | `notificationMode` | `off`、`notifications`、`sound`、`notifications-and-sound` | `off` | C |
| GEN-22 | In-app notifications | `inAppNotificationsEnabled` | boolean | `false` | C |
| GEN-23 | Time format | `timestampFormat` | `locale`、`12-hour`、`24-hour` | `locale` | C |
| GEN-24 | Response streaming | `responseStreamingMode` | `turn`（等完整回复）、`paragraph`（完成一段显示一段） | `paragraph` | S/P |
| GEN-25 | Hide whitespace changes | `diffIgnoreWhitespace` | boolean | `true` | C |
| GEN-26 | Default diff file state | `diffFilesCollapsed` | boolean（true=折叠） | `true` | C |
| GEN-27 | Diff layout | `diffLayout` | `stacked`、`split` | `stacked` | C |
| GEN-28 | Proactive panels | `proactivePanelsEnabled` | boolean | `false` | C |
| GEN-29 | Show skills in slash menu | `showSkillsInSlashMenu` | boolean | `true` | C |
| GEN-30 | Rich text composer | `composerRichTextEnabled` | boolean | `true` | C |
| GEN-31 | Collapse composer on scroll | `composerCollapseOnScroll` | boolean | `true` | C |
| GEN-32 | Composer context | `persistComposerContextStrip` | boolean | `false` | C |
| GEN-33 | Send shortcut | `sendShortcut` | `enter`、`mod-enter-multiline`、`mod-enter` | `enter` | C |
| GEN-34 | Follow-up behavior | `followUpBehavior` | `queue`（排队）、`steer`（引导当前回合） | `queue` | C |
| GEN-35 | Provider update checks | `enableProviderUpdateChecks` | boolean | `true` | S |
| GEN-36 | Continue threads after restarts | `continueThreadsAfterServerUpdate` | boolean | `true` | S/P |
| GEN-37 | Background activity | `backgroundActivity` | `profile`: `balanced`、`performance`、`battery-saver`、`custom`；`overrides` | `balanced` | S |
| GEN-38 | Compact idle threads | `idleCompaction`；`compactIdleThreads`（旧字段） | `onReturn`、`beforeCacheExpires`、`off`；Claude 实例可 `default` | `onReturn` | S；Claude 实例覆盖 |
| GEN-39 | Plan mode (legacy) | `planModeEnabled` | boolean | `false` | C |
| GEN-40 | Context window indicator (legacy) | `contextWindowMeterEnabled` | boolean | `false` | C |
| GEN-41 | 首次引导完成时间 | `onboardingCompletedAt` | ISO 字符串或 `null` | `null` | C |
| GEN-42 | 已忽略的 Provider 更新提示 | `dismissedProviderUpdateNotificationKeys` | string[] | `[]` | C |

`backgroundActivity.overrides` 可单独覆盖：`automaticGitFetchInterval`、`providerHealthRefreshInterval`、`hostPowerMonitorActiveInterval`、`hostPowerMonitorIdleInterval`、`idleClientTtl`、`pauseWhenHostLocked`、`pauseWhenHostLowPower`、`pauseWhenClientLowPower`、`pauseWhenOnBattery`。预设值：

| 预设 | git fetch | Provider 健康检查 | 主机活动轮询 | 主机空闲轮询 | 客户端空闲 TTL |
| --- | --- | --- | --- | --- | --- |
| performance | 15s | 1m | 30s | 2m | 45s |
| balanced | 30s | 5m | 30s | 5m | 45s |
| battery-saver | 关闭 | 15m | 1m | 10m | 45s |

### 2.4 确认（Confirmations）

| ID | 界面项 | 键 | 可选值 | 默认 | 作用域 |
| --- | --- | --- | --- | --- | --- |
| GEN-43 | Archive confirmation | `confirmThreadArchive` | boolean | `false` | C |
| GEN-44 | Delete confirmation | `confirmThreadDelete` | boolean | `true` | C |
| GEN-45 | Unpin confirmation | `confirmThreadUnpin` | boolean | `false` | C |
| GEN-46 | Quit shortcut | `confirmQuit` | `direct`、`hold`、`double-click` | `hold` | C/D |

### 2.5 文本生成与关于

| ID | 界面项 | 键 | 可选值 | 默认 | 作用域 |
| --- | --- | --- | --- | --- | --- |
| GEN-47 | Text generation model | `textGenerationModelSelection` | `ModelSelection` | `codex` / `gpt-6-luna` / `reasoningEffort=low` | S/P |
| GEN-48 | Thread title instructions | `threadTitleInstructions` | 字符串 | `""` | S/P |
| GEN-49 | Version | — | 只读 | — | A |
| GEN-50 | Update track | — | `latest`、`nightly`（托管/发布通道） | `latest` | D/C |
| GEN-51 | t3 command | — | 只读命令路径 | — | D |
| GEN-52 | Mobile app / Privacy policy / Open source licenses / Diagnostics | — | 入口 | — | A |

## 3. Appearance（外观）

| ID | 界面项 | 键 | 可选值 | 默认 | 作用域 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| APP-01 | Color scheme / 主题 | 浏览器 `t3code:theme-appearance-mode`、`t3code:theme`、`t3code:theme-halves:v1` | `system`、`light`、`dark`；主题 id 可分别指定 light/dark | `system` | C | `defaultTheme` 是环境发布主题（S，`t3 theme set`），客户端首次应用后用户选择优先 |
| APP-02 | Themes | `t3code:themes:v1` | 内置：`t3-chat`（T3 Chat）、`grove`、`ocean`、`ember`、`iris`；支持自定义/导入/环境主题 | — | C | 主题编辑器可改颜色角色 |
| APP-03 | Contrast | `appearanceContrast` | 50–200（%） | `100` | C | 界面/边框对比度 |
| APP-04 | Glass opacity | `glassOpacity` | 40–100（%） | `80` | C | 菜单、对话框、Composer 透明感 |
| APP-05 | Diff colors | `diffColorScheme` | `red-green`、`blue-orange` | `red-green` | C | 增删配色（色盲友好） |
| APP-06 | Chat width | `chatWidth` | `comfortable`、`wide`、`full` | `comfortable` | C | 消息列与 Composer 宽度 |
| APP-07 | Render math | `mathRenderingEnabled` | boolean | `false` | C | 关闭时不解析 KaTeX |
| APP-08 | Panel animations | `panelAnimationDurationMs` | 0–400 ms | `0` | C | 默认 0 以避免低性能设备逐帧布局 |
| APP-09 | Environment identification | `environmentIdentificationMode` | `artwork`、`pill`（版本标签）、`none` | `artwork` | C | 开发/夜间构建标识 |
| APP-10 | Interface font | `fontSizeInterface`；`fontFamilySans` | 12–20；字体族 ≤200 字符 | `16` / `""` | C | `""` 表示系统字体 |
| APP-11 | Prompt font | `fontSizePrompt`；`fontFamilyComposer` | 12–20；≤200 | `14` / `""` | C | Composer 输入区 |
| APP-12 | Code font | `fontSizeCode`；`fontFamilyCode` | 10–18；≤200 | `13` / `""` | C | 代码块、Diff、文件预览 |
| APP-13 | Terminal font | `fontSizeTerminal`；`fontFamilyTerminal` | 8–20；≤200 | `12` / `""` | C | 终端 |
| APP-14 | Font smoothing | `fontSmoothing` | boolean | `true` | C（macOS） | 灰度抗锯齿 |
| APP-15 | Word wrap | `wordWrap` | boolean | `true` | C | 长行、代码块、表格、Diff |

## 4. Keybindings（快捷键）

存储：环境状态目录 `keybindings.json`，类型为规则数组：

```json
{ "key": "mod+shift+m", "command": "modelPicker.toggle", "when": "!terminalFocus" }
```

约束：`key` 1–64 字符；`when` 1–256 字符；最多 256 条；`when` 支持 `!`、`&&`、`||`、括号与标识符（如 `composerFocus`、`terminalFocus`、`modelPickerOpen`、`isDesktop`）。自定义只覆盖同一 `command` 的默认绑定，其余默认保留。

### 4.1 默认绑定（按领域）

| 命令 | 默认键 | 条件 | 作用 |
| --- | --- | --- | --- |
| `sidebar.toggle` | `mod+b` | — | 侧栏 |
| `navigation.back` / `forward` | `mod+[` / `mod+]` | `!terminalFocus` | 前进后退 |
| `terminal.toggle` | `mod+j` | — | 终端开关 |
| `terminal.split` / `splitVertical` | `mod+d` / `mod+shift+d` | `terminalFocus` | 终端分屏 |
| `terminal.new` / `close` | `mod+n` / `mod+w` | `terminalFocus` | 终端标签 |
| `rightPanel.toggle` / `new` / `close` | `mod+alt+b` / `mod+t` / `mod+w` | 各自条件 | 右侧面板 |
| `threadPanel.toggle` | `mod+shift+b` | `!terminalFocus` | 线程面板 |
| `view.reopenClosed` | `mod+shift+t` | — | 恢复关闭的面板 |
| `diff.toggle` | `mod+d` | `!terminalFocus` | Diff 面板 |
| `preview.toggle` / `refresh` / `focusUrl` | `mod+shift+j` / `mod+r` / `mod+l` | `previewFocus`（后两者） | 浏览器预览 |
| `preview.zoomIn` / `zoomOut` / `resetZoom` | `mod+=` 或 `mod++` / `mod+-` / `mod+0` | `previewFocus` | 预览缩放 |
| `commandPalette.toggle` | `mod+k` | `!terminalFocus` | 命令面板 |
| `filePicker.toggle` | `mod+p` | `!terminalFocus` | 文件选择 |
| `projectSearch.toggle` | `mod+shift+f` | `!terminalFocus` | 项目搜索 |
| `usage.open` | `mod+u` | `!terminalFocus` | 用量页 |
| `theme.select` / `appearance.cycle` / `themeEditor.toggle` | `mod+alt+a` / `mod+alt+shift+a` / `mod+alt+shift+t` | 前两者 `!terminalFocus` | 主题 |
| `composer.stash` | `mod+s` | `!terminalFocus` | 暂存 Composer |
| `composer.sendAlternate` | `mod+enter` | `composerFocus && turnRunning` | 运行中发送替代行为 |
| `composer.sendBackground` | `mod+enter` / `mod+alt+enter` | `composerFocus && draftThreadRoute` | 后台发送 |
| `composer.sendAndNewThread` | `mod+alt+enter` | `composerFocus && !draftThreadRoute` | 发送并新线程 |
| `thread.steerQueuedMessage` | `mod+shift+enter` | `!terminalFocus` | 引导排队消息 |
| `thread.editQueuedMessage` | `alt+arrowup` | `composerFocus` | 编辑排队消息 |
| `chat.new` | `mod+n` / `mod+shift+o` | `!terminalFocus` | 新线程 |
| `chat.newLocal` / `chat.newWithoutProject` | `mod+shift+n` / `mod+alt+n` | `!terminalFocus` | 本地/无项目新线程 |
| `chat.find` | `mod+f` | `!terminalFocus && !previewFocus` | 会话内查找 |
| `modelPicker.toggle` | `mod+shift+m` | `!terminalFocus` | 模型选择器 |
| `modelPicker.previousProvider` / `nextProvider` | `mod+shift+arrowup` / `mod+shift+arrowdown` | `modelPickerOpen` | Provider 切换 |
| `composer.host` / `effort` / `mode` / `workspace` / `branch` / `previousWorktree` | `mod+shift+h` / `e` / `a` / `x` / `g` / `l` | `!terminalFocus` | Composer 上下文 |
| `pullRequest.copyNumber` | `mod+shift+k` | `!terminalFocus` | 复制 PR 编号 |
| `thread.previous` / `next` | `mod+shift+[` / `mod+shift+]` | — | 线程切换 |
| `thread.copyReference` | `mod+shift+c` | `!terminalFocus` | 复制线程引用 |
| `thread.settle` / `pin` / `undo` | `mod+shift+s` / `mod+shift+p` / `mod+z` | 各自条件 | 线程状态；`thread.stop` 无默认绑定 |
| `thread.jump.1`–`.9` | `mod+1`–`mod+9` | `!modelPickerOpen && isDesktop` | 跳线程 |
| `modelPicker.jump.1`–`.9` | `mod+1`–`mod+9` | `modelPickerOpen && isDesktop` | 跳模型 |
| `editor.openFavorite` | `mod+o` | — | 打开收藏编辑器 |
| `usage.cost` / `tokens` / `limits` | `c` / `t` / `l` | `usagePageOpen` | 用量页 |
| `usage.period.day` … `quarter` | `mod+shift+1` … `4` | `usagePageOpen` | 用量周期 |
| `script.<id>` | 用户自定 | — | 运行项目脚本 |

## 5. SnapShots（窗口截图）

| ID | 界面项 | 键 | 可选值 | 默认 | 作用域 |
| --- | --- | --- | --- | --- | --- |
| SNAP-01 | SnapShots | `snapShotEnabled` | boolean | `false` | C |
| SNAP-02 | Include app text | `snapShotIncludeAccessibility` | boolean | `true` | C |
| SNAP-03 | Capture shortcut | `snapShotShortcut` | `{kind:"both-shift-keys"}`、`{kind:"modifier-pair", modifier}`（`shift`/`meta`/`control`/`alt`）、或键位 chord（必须含修饰键） | `both-shift-keys` | C |
| SNAP-04 | Capture sound | `snapShotPlaySound`；`snapShotSound` | boolean；`soft-pop`、`camera-shutter` | `true` / `soft-pop` | C |
| SNAP-05 | Capture flash | `snapShotFlash` | boolean | `true` | C |
| SNAP-06 | Capture animations | `snapShotAnimations` | boolean | `true` | C |

## 6. Providers（Agent 提供方）

### 6.1 Provider 实例

`providerInstances: Record<ProviderInstanceId, ProviderInstanceConfig>`：

| ID | 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| PROV-01 | `driver` | `codex`、`claudeAgent`、`cursor`、`grok`、`muse`、`pi`、`opencode`、`acpRegistry`、`antigravity` | — | 驱动类型 |
| PROV-02 | `displayName` | 非空字符串 | 驱动名 | 显示名 |
| PROV-03 | `accentColor` | 字符串 | 无 | 实例强调色 |
| PROV-04 | `enabled` | boolean | 未配置时仅 codex/claudeAgent 默认启用；已配置实例省略该字段时，cursor/grok/muse/pi/opencode/antigravity 默认关，codex/claudeAgent/acpRegistry 默认开 | 实例开关 |
| PROV-05 | `environment` | `{name, value, sensitive, valueRedacted?}[]` | `[]` | 注入进程的环境变量；`sensitive` 值单独存储 |
| PROV-06 | `config` | 驱动特定对象 | 见 6.2 | 驱动配置 |

项目级还有 `providerInstances[instanceId].enabled` 的逐实例覆盖；未配置时按驱动默认。

### 6.2 驱动配置（用户可见字段）

| 驱动 | 字段 | 默认 | 说明 |
| --- | --- | --- | --- |
| Codex | `binaryPath` | `codex` | Codex 可执行文件 |
| Codex | `homePath` | `""` | `CODEX_HOME` 配置目录 |
| Codex | `shadowHomePath` | `""` | 账户独立 home，独立 `auth.json`、共享 `CODEX_HOME` 状态 |
| Codex | `launchArgs` | `""` | 传给 `codex app-server` 的额外参数 |
| Codex | `setupMode` / `customModels` | `managed` / `[]` | 隐藏字段 |
| Claude | `binaryPath` | `claude` | Claude 可执行文件 |
| Claude | `homePath` | `""` | `CLAUDE_CONFIG_DIR` |
| Claude | `autoCompactWindow` | `""` | 100000–1000000 tokens，空=Claude 默认 |
| Claude | `idleCompaction` | `default` | `default`、`onReturn`、`beforeCacheExpires`、`off` |
| Claude | `launchArgs` | `""` | 额外 CLI 参数（如 `--chrome`） |
| Claude | `customModels` | `[]` | 隐藏字段 |
| Antigravity | `authMethod` | `oauth-personal` | `oauth-personal`（Google 账号）、`oauth-business`（Gemini Enterprise）、`gemini-api-key`、`agent-platform`（Vertex AI） |
| Antigravity | `apiKey` | `""` | 敏感字段，单独存储 |
| Antigravity | `gcpProject` / `gcpLocation` | `""` | Gemini Enterprise / Vertex |
| Antigravity | `binaryPath` | `""` | ACP 可执行文件，空=自动 |
| Cursor | `binaryPath` / `apiEndpoint` | 隐藏 | V1 兼容字段 |
| Grok | `binaryPath` | `grok` | Grok CLI |
| OpenCode | `binaryPath` | `opencode` | OpenCode |
| OpenCode | `serverUrl` | `""` | 空=按需启动本地 server |
| OpenCode | `serverPassword` | `""` | 敏感字段 |
| Pi | `binaryPath` | `pi` | Pi CLI |
| Pi | `launchArgs` | `""` | 传给 `pi --mode rpc` |
| Muse | `binaryPath` | `muse` | Muse Code，需在该主机 `muse login` |
| ACP Registry | `source` | `registry` | `registry` 或 `local` |
| ACP Registry | `agentId` | `""` | 官方 Registry agent id（如 `devin`） |
| ACP Registry | `commandPath` | `""` | 可执行文件覆盖 |
| ACP Registry | `authMethodId` | `""` | 认证方式，空=自动 |
| ACP Registry | `distribution` / `commandArgs` | `auto` / `[]` | 隐藏字段；distribution 可选 `auto`、`binary`、`npx`、`uvx` |

### 6.3 模型与用量

| ID | 界面项 | 键 | 默认 | 作用域 |
| --- | --- | --- | --- | --- |
| PROV-07 | Model favorites | `favorites` | `[]` | S（旧客户端可回退到 C 的 `favorites`） |
| PROV-08 | Hidden models / model order | `providerModelPreferences` | `{}` | S |
| PROV-09 | Custom models | 各驱动 `config.customModels` | `[]` | S |
| PROV-10 | Health check interval | `providerHealthRefreshInterval` | 5 分钟（`backgroundActivity` 可覆盖） | S |
| PROV-11 | Provider update checks | `enableProviderUpdateChecks` | `true` | S |
| PROV-12 | Usage providers / CLIProxyAPI | `usageLimitSources` | `{}`；每项 `{kind:"cliproxy", label?, url, managementKey(secret), enabled}` | S |
| PROV-13 | Cursor account usage | `cursorKeychainUsageEnabled` | `false` | S（macOS） |
| PROV-14 | 价格覆盖 | `usagePriceOverrides` | `{}`；输入/输出（必填）、缓存读/写（可省，省=输入价） 每百万 token | S |
| PROV-15 | 模型别名 | `usageModelAliases` | `{}` | S |
| PROV-16 | 密钥存储 | — | 敏感字段与 `sensitive` 环境变量不写入 `settings.json`，存于状态目录 secrets，读取时返回掩码 | S/A |

用量页还提供按日/周/月/季的 token、成本、限额视图；这是展示，不是设置。

## 7. Integrations（集成）

### 7.1 Agent 浏览器与设备

| ID | 界面项 | 键 | 默认 | 作用域 |
| --- | --- | --- | --- | --- |
| INT-01 | Agent browser access | `enableAgentBrowserAccess` | `true` | S/P |
| INT-02 | 项目级浏览器访问覆盖 | `projectAgentBrowserAccessOverrides` | `{}` | S |
| INT-03 | Agent device access | `enableAgentDeviceAccess` | `false` | S/P |
| INT-04 | Simulator support / Device hub | `enableDeviceSupport` | `false` | S |
| INT-05 | 设备引导完成 | `deviceOnboardingCompleted` | `false` | S |
| INT-06 | Device hosts | `deviceHosts` | `[]`（SSH 主机配置） | S |
| INT-07 | EAS device hosts | `easDeviceHosts` | `[]` | S |

### 7.2 浏览器预览与链接

| ID | 界面项 | 键 | 可选值 | 默认 | 作用域 |
| --- | --- | --- | --- | --- | --- |
| INT-08 | Browser profiles | `browserProfiles` | 最多 24 个；内置 `default`（persistent）、`incognito` | `[]` | C |
| INT-09 | Default browser profile | `browserDefaultProfileId` | profile id | `default` | C |
| INT-10 | Default browser viewport | `browserDefaultViewport` | `fill`、`preset`、`freeform` | `fill` | C |
| INT-11 | Default browser zoom | `browserDefaultZoomFactor` | 缩放档位 | `1.0` | C |
| INT-12 | Default browser appearance | `browserDefaultAppearance` | `system`、`light`、`dark` | `system` | C |
| INT-13 | Browser recording frame rate | `browserRecordingFrameRate` | 30、60 | `30` | C |
| INT-14 | Show key presses in recordings | `browserRecordingShowKeyPresses` | boolean | `false` | C |
| INT-15 | Show mouse presses in recordings | `browserRecordingShowMousePresses` | boolean | `false` | C |
| INT-16 | Open links in | `browserLinkTarget` | `system`、`app` | `system` | C |
| INT-17 | Search engine | `browserSearchEngine` | `duckduckgo`、`google`、`bing`、`brave`、`kagi`、`ecosia`、`custom` | `duckduckgo` | C |
| INT-18 | 自定义搜索 URL | `browserCustomSearchUrl` | ≤2048 字符，含 `%s` | `""` | C |
| INT-19 | Auto-show floating preview | `browserAutoShowFloatingPreview` | boolean | `true` | C |
| INT-20 | Open pull requests in T3 Code | `pullRequestLinksOpenInApp` | boolean | `true` | C |
| INT-21 | PR 合并方式覆盖 | `pullRequestMergeMethodOverrides` | repo → `merge`/`squash`/`rebase` | `{}` | C |

## 8. Scheduled Tasks（定时任务）

定时任务是一个对象，不是全局设置。字段：

| ID | 字段 | 类型/可选值 | 说明 |
| --- | --- | --- | --- |
| TASK-01 | `title` | 非空字符串 | 名称 |
| TASK-02 | `prompt` | 非空字符串 | 到点发送给 Agent 的提示词 |
| TASK-03 | `enabled` | boolean | 开关 |
| TASK-04 | `schedule` | `{type:"interval", everyMs>0}` 或 `{type:"fixed_time", timeOfDay:"HH:MM", weekdays?:0–6[]}` | 最小间隔 60 秒；weekday 0=周日 |
| TASK-05 | `projectId` | 项目 id | 归属项目 |
| TASK-06 | `threadId` | 线程 id 或 `null` | 续用线程或新建 |
| TASK-07 | `workspaceStrategy` | `{type:"root", branch?}`、`{type:"existing_worktree", worktreePath, branch?}`、`{type:"worktree", baseRef, ...}` | 新线程工作区策略 |
| TASK-08 | `modelSelection` | `ModelSelection` | 任务模型 |
| TASK-09 | `runtimeMode` | 同 GEN-02 | 任务权限 |
| TASK-10 | `interactionMode` | `default`、`plan` | Build/Plan |
| TASK-11 | `webhook` | 可选：签名（header/encoding/prefix）、filters（path/op/value）、dedupe（replayKey/coalesceKey/coalesceWindowSeconds）、maxDeliveryAgeMinutes | 外部触发 |
| TASK-12 | 运行状态 | `nextRunAt`、`lastRunAt`、`lastRunStatus`、`lastRunError`、`runCount` | A |

## 9. Source Control（版本控制）

| ID | 界面项 | 键 | 可选值 | 默认 | 作用域 |
| --- | --- | --- | --- | --- | --- |
| SC-01 | Automatically pull | `defaultAutoPull` | boolean | `false` | S/P |
| SC-02 | Remove agent credits when merging | `removeAgentCreditsOnMerge` | boolean | `false` | S/P |
| SC-03 | Default merge method | `pullRequestMergeMethod` | `merge`、`squash`、`rebase`、`null` | `null` | S/P |
| SC-04 | Git fetch interval | `automaticGitFetchInterval` | 毫秒；0=关闭 | `30000` | S |
| SC-05 | Source control 主机 | `sourceControlHosts` | 每主机对象：`hosts`（小写域名 → `{account?, enabled=true}`）、`tokens`（域名 → token，敏感、单独存储）；也可用对应 CLI 登录 | `{}` | S |
| SC-06 | Worktree branch naming | `branchNamingMode`；`branchNamePrefix`；`branchNameInstructions` | `static`、`semantic`、`custom`；前缀；说明 | `static` / `t3` / `""` | S/P |
| SC-07 | Source control writing style | `sourceControlWritingStyle` | `{mode: repo_conventions/conventional_commits/custom, customInstructions, followChangeRequestTemplates}` | `repo_conventions` / `""` / `true` | S/P |
| SC-08 | Source control writer model | `sourceControlWriterModelSelection` | `ModelSelection` 或 `null` | `null` | S/P |
| SC-09 | Review guides (beta) | `reviewGuidesEnabled` | boolean | `false` | S |
| SC-10 | Review guide model / instructions | `reviewGuideModelSelection`；`reviewGuideInstructions` | `ModelSelection` 或 `null`；字符串 | `null` / `""` | S/P |

已内置的托管平台：GitHub、GitLab、Bitbucket、Azure DevOps、Forgejo、GitCafe。每个平台的 `sourceControlHosts[host]` 保存服务器地址/账号/令牌或 CLI 登录状态；敏感值单独存储，客户端只看到是否已配置。

## 10. Storage（存储）

### 10.1 Worktree 与清理

| ID | 界面项 | 键 | 可选值 | 默认 | 作用域 |
| --- | --- | --- | --- | --- | --- |
| STOR-01 | Worktree cleanup | `worktreeCleanup` | `null`（不使用自定义规则；项目覆盖层 `null`=删除覆盖）、`{mode:"off"}`、`{mode:"custom", rules}` | `null` | S/P |
| STOR-02 | Keep worktrees with local changes | `rules.worktreeKeepWhen` | `any-local-files`、`uncommitted-changes`、`tracked-changes` | `uncommitted-changes` | S/P |
| STOR-03 | 按天数清理 | `rules.worktreeAfterDays` | 1–3650 或 `null` | `null` | S/P |
| STOR-04 | 已结算 worktree 清理 | `rules.worktreeSettledAfterDays` | 0–3650 或 `null` | `null` | S/P |
| STOR-05 | Merge 后清理 | `rules.worktreeOnMerge` | boolean | `false` | S/P |
| STOR-06 | 删除线程后清理 | `rules.worktreeOnDelete` | boolean | `false` | S/P |
| STOR-07 | 未修改 worktree 清理 | `rules.worktreeUnchanged` | boolean | `false` | S/P |
| STOR-08 | 浏览器产物保留 | `storageCleanup.browserArtifactsAfterDays` | 1–3650 或 `null` | `null` | S |
| STOR-09 | 日志保留 | `storageCleanup.logsAfterDays` | 1–3650 或 `null` | `null` | S |
| STOR-10 | Worktree location | `worktreesDirectory`；`previousWorktreesDirectories` | 路径；历史路径数组 | `""` / `[]` | S |
| STOR-11 | Delete now | — | 手动清理 | — | S |
| STOR-12 | 数据库空间 | 只读：`databaseBytes`、`reclaimableBytes`、`incrementalVacuumEnabled`、`compactCommand` | — | A | A |

`storageCleanup` 是默认规则；`worktreeCleanup` 是项目可覆盖模式。`null` 表示未设置/继承，不等于 `off`。

## 11. Connections（连接）

| ID | 界面项 | 键/机制 | 默认 | 作用域 |
| --- | --- | --- | --- | --- |
| CONN-01 | Local environment | `localEnvironmentEnabled` | `true` | D |
| CONN-02 | Network access / Server exposure | `serverExposureMode`（`local-only` / `network-accessible`） | `local-only` | D |
| CONN-03 | Tailscale HTTPS | `tailscaleServeEnabled`；`tailscaleServePort` | `false` / `443` | D |
| CONN-04 | WSL backend | `wslBackendEnabled`；`wslDistro`；`wslOnly` | `false` / `null` / `false` | D（Windows） |
| CONN-05 | Linux password store | `linuxPasswordStore` | 平台默认 | D |
| CONN-06 | Environment icon | `environmentIcon` | `null` | S |
| CONN-07 | 默认主题 | `defaultTheme`；`defaultThemeSetAt` | `""` / `""` | S |
| CONN-08 | 配对/授权客户端 | Authorized clients、pairing links、revoke sessions | — | D/S |
| CONN-09 | 远程环境 | 保存的 environment 连接（SSH/配对码/隧道） | `[]` | D/C |
| CONN-10 | Load balancing | `loadBalancingEnabled`；`loadBalancingWeights`（0–100 每环境） | `false` / `{}` | C |
| CONN-11 | Pull request sharing | 每主机 trusted environments/凭据共享 | — | S |
| CONN-12 | T3 Connect / hold webhooks / publish agent activity | 托管隧道相关 | 关闭 | D/S（cloud） |

### 11.1 Diagnostics（诊断页的 OTLP 导出）

| ID | 设置 | 键 | 默认 | 作用域 |
| --- | --- | --- | --- | --- |
| OBS-01 | OTLP traces endpoint | `observability.otlpTracesUrl` | `""` | S |
| OBS-02 | OTLP metrics endpoint | `observability.otlpMetricsUrl` | `""` | S |
| OBS-03 | OTLP logs endpoint | `observability.otlpLogsUrl` | `""` | S |
| OBS-04 | 资源遥测/进程/失败/日志/span 视图 | — | 只读 | A |

## 12. Archive（归档）

| ID | 界面项 | 行为 | 作用域 |
| --- | --- | --- | --- |
| ARCH-01 | Archived threads | 列出已归档线程，可恢复/删除 | P |
| ARCH-02 | 归档相关确认 | 由 `confirmThreadArchive`、`confirmThreadDelete` 控制 | C |
| ARCH-03 | 自动归档/结算 | `sidebarAutoSettle*` | S/P |

## 13. Project 与项目级覆盖

### 13.1 项目概览与 Actions

| ID | 界面项 | 键/对象 | 说明 |
| --- | --- | --- | --- |
| PROJ-01 | Project overview | 项目名称、图标/emoji、checkout、移除 | 复用项目对象 |
| PROJ-02 | Actions / scripts | `defaultProjectScripts`、`projectScriptOverrides` | 见 13.2 |
| PROJ-03 | 导入 `t3.json` 脚本 | `T3ProjectFile.scripts` | 团队成员可导入 |
| PROJ-04 | 项目级设置覆盖 | `projectSettingsOverrides[projectId]` | 见 13.3 |
| PROJ-05 | 覆盖迁移标记 | `projectSettingsFolded` | 一次性把旧全局值折叠进项目覆盖，默认 `false`；折叠后重置不会被下次启动撤销 |

### 13.2 项目脚本（`ProjectScript` / `t3.json`）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `name` | 非空字符串 | — | 菜单显示名 |
| `command` | 非空字符串 | — | 在项目根执行的 shell 命令 |
| `icon` | `play`、`test`、`lint`、`configure`、`build`、`debug` | `ProjectScript` 必填；`t3.json` 省略时默认 `play` | 图标 |
| `runOnWorktreeCreate` | boolean | `false` | 新 worktree 创建后自动运行 |
| `runOnSettle` | boolean | `false` | 每次线程结算时在该 worktree 运行 |
| `async` | boolean | `true` | 仅 `runOnWorktreeCreate`；false 时等待脚本退出再启动 Agent |
| `previewUrl` | URL | 无 | 脚本运行时在应用内浏览器打开（桌面） |
| `autoOpenPreview` | boolean | `false` | 脚本开始即打开预览 |

### 13.3 可项目覆盖的服务端键

`PROJECT_SCOPED_SERVER_SETTING_KEYS` 共 26 个：

`worktreeCleanup`、`defaultModelSelection`、`defaultRuntimeMode`、`defaultThreadEnvMode`、`newWorktreesStartFromOrigin`、`worktreeSubmodules`、`defaultAutoPull`、`defaultProjectScripts`、`enableAgentBrowserAccess`、`enableAgentDeviceAccess`、`textGenerationModelSelection`、`threadTitleInstructions`、`sourceControlWriterModelSelection`、`reviewGuideModelSelection`、`reviewGuideInstructions`、`sourceControlWritingStyle`、`removeAgentCreditsOnMerge`、`branchNamingMode`、`branchNamePrefix`、`branchNameInstructions`、`pullRequestMergeMethod`、`sidebarAutoSettleOnMerge`、`sidebarAutoSettleAfterDays`、`sidebarAutoSettleKeepPullRequests`、`continueThreadsAfterServerUpdate`、`responseStreamingMode`。

规则：缺省=继承环境值；`null` 仅在字段本身可空时表示真实值（无默认模型、无专用 writer 模型、永不自结算）；其余键写 `null` 表示删除覆盖。`providerInstances` 例外：逐字段覆盖，不整块替换。

### 13.4 `t3.json`（仓库根）

| ID | 字段 | 类型/可选值 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| T3JSON-01 | `$schema` | URL | 无 | 通常 `https://t3.codes/schema/t3.json` |
| T3JSON-02 | `iconPath` | 仓库相对路径 ≤512 | 无 | 项目图标 |
| T3JSON-03 | `defaultThreadEnvMode` | `worktree`、`local` | `local`（内置） | 项目设置覆盖它 |
| T3JSON-04 | `worktreeSubmodules` | `recursive`、`top-level`、`none` | `recursive`（内置） | 项目/环境设置覆盖它 |
| T3JSON-05 | `scripts` | `T3ProjectFileScript[]`，最多 50 | `[]` | 团队共享脚本 |

示例（t3code 自身）：

```json
{
  "$schema": "https://t3.codes/schema/t3.json",
  "iconPath": "assets/dev/blueprint-web-apple-touch-180.png",
  "scripts": [
    {
      "name": "Setup Worktree",
      "command": "node scripts/setup-worktree.ts",
      "icon": "configure",
      "runOnWorktreeCreate": true
    }
  ]
}
```

## 14. 线程内 / Composer 设置（Agent Chat 核心）

这些不是设置页里的全局项，而是每个线程/每次发送时可改的状态。

| ID | 项 | 取值 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| THREAD-01 | 模型 | `ModelSelection {instanceId, model, options[]}` | 项目/环境默认模型 | Provider 实例 + 模型 + 选项（如推理强度） |
| THREAD-02 | Provider 实例 / Host | `ProviderInstanceId` | 默认实例 | 同一驱动可多实例 |
| THREAD-03 | 推理强度 / Provider 选项 | 由模型能力决定（如 `reasoningEffort` 的 low/medium/high） | 模型默认 | Composer 的 effort 控件 |
| THREAD-04 | 运行时权限 | `approval-required`、`auto-accept-edits`、`auto`、`full-access` | 环境/项目默认 | Composer 常驻控件；可在批准面板逐次选择 |
| THREAD-05 | 交互模式 | `default`（Build）、`plan` | `default` | Plan 模式只读规划 |
| THREAD-06 | 工作区模式 | `local`（当前 checkout）、`worktree` | 环境/项目/仓库默认 | 新线程决定 |
| THREAD-07 | 分支 | 当前分支或新分支 | 由命名策略生成 | 受 `branchNaming*` 影响 |
| THREAD-08 | 排队消息 | 发送时运行中则排队 | `queue` 或 `steer`（GEN-34） | 可编辑/引导/停止 |
| THREAD-09 | Composer 暂存 | `composer.stash` | — | 切线程保留草稿 |
| THREAD-10 | 附件 | 图片/文件，数量上限由 Provider 合同定义 | — | 可带剪贴板/文件引用 |
| THREAD-11 | 上下文窗口指示 | 圆形 meter，或 legacy 开关 | 新 UI 默认显示 | `contextWindowMeterEnabled` 只用于旧版 |
| THREAD-12 | 线程操作 | settle、pin、archive、delete、undo | — | 受确认项约束 |
| THREAD-13 | 线程标题 | 自动生成，可用 `threadTitleInstructions` 调整 | — | 可手动重命名 |
| THREAD-14 | 审批决策 | `accept`、`acceptForSession`、`acceptAlways`、`decline`、`cancel` | — | 命令、读文件、改文件、MCP、权限请求 |
| THREAD-15 | Slash / `$` 菜单 | 命令、Skills、MCP 工具 | — | `showSkillsInSlashMenu` 控制 Skills 是否出现在 `/` 菜单 |

## 15. 桌面端与移动端专属

### 15.1 Desktop（`desktop-settings.json`）

| ID | 设置 | 默认 | 说明 |
| --- | --- | --- | --- |
| DESK-01 | `localEnvironmentEnabled` | `true` | 本机后端开关 |
| DESK-02 | `serverExposureMode` | `local-only` | `local-only` / `network-accessible` |
| DESK-03 | `tailscaleServeEnabled` / `tailscaleServePort` | `false` / `443` | Tailscale HTTPS |
| DESK-04 | `wslBackendEnabled` / `wslDistro` / `wslOnly` | `false` / `null` / `false` | Windows WSL 后端 |
| DESK-05 | `linuxPasswordStore` | 平台默认 | Linux 凭据存储 |
| DESK-06 | `mainWindowBounds` / `mainWindowMaximized` | `null` / `false` | 窗口记忆；最小 840×620 |
| DESK-07 | `updateChannel` | `latest` | `latest` / `nightly` |
| DESK-08 | `updateChannelConfiguredByUser` | `false` | 是否用户显式选择 |
| DESK-09 | `confirmQuit` | `hold` | 退出行为（见 GEN-46） |
| DESK-10 | `snapShot*` | 见第 5 节 | 截图相关 |
| DESK-11 | `t3` CLI 命令 / 窗口玻璃 / 主题编辑器 | — | 桌面专属界面 |

### 15.2 Mobile（本机偏好）

| ID | 设置 | 默认 | 说明 |
| --- | --- | --- | --- |
| MOB-01 | `navigationTabOrder` / `hiddenNavigationTabs` | 平台默认 | 底部导航排序/隐藏 |
| MOB-02 | `themeId` / `lightThemeId` / `darkThemeId` / `themeMode` | 平台默认 | 主题 |
| MOB-03 | `baseFontSize` / `markdownFontSize` / `codeFontSize` / `terminalFontSize` | 平台默认 | 字号 |
| MOB-04 | `codeWordBreak` | 平台默认 | 代码换行 |
| MOB-05 | `mathRenderingEnabled` | `false` | 数学渲染 |
| MOB-06 | `composerEnterBehavior` | `send` | 硬件键盘 Return：`send` / `newline`（iOS） |
| MOB-07 | `followUpBehavior` | `queue` | 同 GEN-34 |
| MOB-08 | `microphones` | 未设置 | 麦克风优先级 |
| MOB-09 | `liveActivitiesEnabled` | 平台默认 | 实时活动/推送 |
| MOB-10 | `planModeEnabled` / `workingShelfEnabled` / `projectGrouping*` | 平台默认 | 与 Web 同名能力 |
| MOB-11 | `pullRequestHideTestFiles` / `pullRequestMergeMethod` | 平台默认 | PR 列表 |
| MOB-12 | `threadList*` / `pullRequestList*` filters | — | 列表筛选与折叠状态 |

## 16. 环境变量与配置位置

| ID | 变量/路径 | 作用 |
| --- | --- | --- |
| ENV-01 | `T3CODE_HOME` | 数据根目录；默认用户数据目录。服务端状态在 `<base>/userdata`（开发为 `dev`） |
| ENV-02 | `<stateDir>/settings.json` | 服务端设置（ServerSettings） |
| ENV-03 | `<stateDir>/keybindings.json` | 快捷键规则 |
| ENV-04 | `<stateDir>/secrets/` | 敏感字段、Provider 环境变量、托管平台密钥 |
| ENV-05 | `<stateDir>/themes/` | 环境发布主题 |
| ENV-06 | `<base>/worktrees/` | 默认 worktree 目录 |
| ENV-07 | `T3CODE_CLERK_PUBLISHABLE_KEY`、`T3CODE_CLERK_JWT_TEMPLATE`、`T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`、`T3CODE_RELAY_URL`、`T3CODE_HOSTED_APP_URL` | T3 Connect/托管构建的公开标识与中继地址；不是服务端秘密 |
| ENV-08 | `T3CODE_MOBILE_OTLP_*` | 移动端 OTLP 上报（ingest-only） |

## 17. Agent Chat 对照优先级（初步索引）

仅用于后续逐项对比时排序，不代表本项目决定实现。

### P0：直接决定 Agent Chat 交互手感

| 对照项 | t3code 对应 |
| --- | --- |
| 发送/换行快捷键与替代发送 | GEN-33、THREAD-08、keybindings `composer.send*` |
| 运行时权限四档 | GEN-02、THREAD-04 |
| Plan / Build 模式 | THREAD-05、GEN-39 |
| 模型选择、Provider 实例、推理强度 | THREAD-01–03、PROV-01–09 |
| 流式输出粒度 | GEN-24 |
| 排队 vs 引导 | GEN-34 |
| Composer 富文本、滚动折叠、上下文条 | GEN-30–32 |
| 上下文窗口指示 | THREAD-11、GEN-40 |
| 技能/斜杠菜单 | GEN-29、THREAD-15 |
| 线程通知（完成/失败/需输入/审批） | GEN-21–22 |
| 线程结算/置顶/归档 | GEN-18–20、THREAD-12 |
| 审批决策与逐次批准 | THREAD-14 |
| 代码/Diff 展示默认值 | GEN-25–27 |
| 聊天阅读宽度与字体 | APP-06、APP-10–13 |

### P1：对 Agent Chat 有增益，但依赖更多基础设施

| 对照项 | t3code 对应 |
| --- | --- |
| 多 Provider 实例、每实例环境变量/配置目录 | PROV-01–06 |
| 模型收藏、隐藏、排序、自定义模型 | PROV-07–09 |
| 项目级默认覆盖（模型/权限/流式/自动拉取/脚本） | 13.3 |
| 定时任务（含 Webhook 触发） | 第 8 节 |
| 快捷键系统（含 `when` 条件） | 第 4 节 |
| 文本生成模型与线程标题指令 | GEN-47–48 |
| 空闲线程压缩 | GEN-38 |
| 后台活动/省电策略 | GEN-37 |
| 用量源、价格覆盖、模型别名 | PROV-12–15 |
| Review Guide、提交/PR 文案风格 | SC-07–10 |
| 分支命名策略 | SC-06 |

### P2 / 平台专属：通常不直接移植到 Web Agent Chat

| 对照项 | t3code 对应 | 原因 |
| --- | --- | --- |
| 截图 SnapShots | 第 5 节 | 依赖 Electron 捕获与全局快捷键 |
| 窗口玻璃、面板动画、环境标识 | APP-04、APP-08–09 | 桌面视觉层 |
| 退出确认、WSL、Tailscale、T3 Connect | GEN-46、CONN-03–04、CONN-12 | 桌面/托管基础设施 |
| 浏览器预览与录音、设备模拟器、Browser profiles | 第 7 节 | 需要本地浏览器/移动设备运行时 |
| Worktree 清理、Worktree 目录、数据库 VACUUM | 第 10 节 | Git/主机存储能力 |
| 归档线程页 | 第 12 节 | 项目/线程生命周期 UI |
| 移动端导航、麦克风、Enter 行为 | 15.2 | 移动端专属 |
| 托管平台凭据与 PR 操作 | 第 9 节 | 需要 GitHub/GitLab 等集成 |

## 18. 已知边界与易混淆点

1. **Client 与 Server 同名但不同源**：`favorites` / `providerModelPreferences` 在 `ServerSettings` 与 `ClientSettings` 都存在；服务端值为 `null` 表示尚未迁移，空数组/空对象才是权威值。
2. **`null` 不是统一语义**：项目覆盖里只有 `defaultModelSelection`、`sourceControlWriterModelSelection`、`reviewGuideModelSelection`、`pullRequestMergeMethod`、`sidebarAutoSettleAfterDays` 的 `null` 是真实值；其他键的 `null` 表示删除覆盖。
3. **默认值 ≠ 当前生效值**：`defaultThreadEnvMode`、`worktreeSubmodules` 还受 `t3.json` 与项目覆盖影响；`defaultTheme` 只在客户端首次应用。
4. **敏感值不出主机**：Provider 密钥、环境变量、托管平台令牌、CLIProxy management key 均单独存储；客户端看到的只是“已配置”或掩码。
5. **运行与完成是两件事**：定时任务/线程运行成功不等于业务对象完成；t3code 的线程状态（working/settled）只是 UI 组织状态。
6. **Web 托管模式限制**：托管 Web 若未锚定具体环境，服务端设置显示为不可改；需从桌面端或环境自身地址修改。
7. **主题存储分裂**：主题/配色模式在浏览器 `localStorage`（`t3code:*`），不随账号跨设备同步；`defaultTheme` 是环境级发布，不是用户偏好同步。
8. **键位 `mod` 是平台抽象**：macOS 为 Command，其他平台为 Ctrl；默认绑定表里的 `isDesktop` 条件使部分数字跳转仅在桌面生效。
9. **线程自动结算需要环境能力**：设置页只有目标环境声明 `threadAutoSettlement` 能力时才允许配置自动结算相关项；没有该能力的旧环境显示为不可用，而不是回退成本地假实现。

## 19. 后续对照记录建议

逐项对比时建议新增一列，固定为：

| t3code ID | 本项目对应设置 | 现状（已有/部分/缺失/不适用） | 证据（文件/路由/合同） | 决定（采纳/改造/拒绝） | 备注 |
| --- | --- | --- | --- | --- | --- |

优先级建议：先对齐 P0 的交互语义与默认值，再评估 P1 的 Provider/项目覆盖/定时任务，最后处理平台专属项。任何“采纳”都需要同时给出本项目的作用域、存储位置、权限与恢复语义，不能只复制 UI 控件。
