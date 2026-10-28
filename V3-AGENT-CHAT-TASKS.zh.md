# v3 Agent Chat 适配任务与验收

## 用户要求与本次边界

- 新建独立 `project-management-agent-v3` 仓库，保留两份源仓库 Git 存档。
- PM 左上角切换进入纯 Agent Chat：左侧 Session 区域、对话区和输入框；不展示工作流、自动化等完整工作台导航。后续用户明确要求的 Chat Space 目录适配增加按需打开的 Files / Git / Terminal / Browser 检查器，见文末增量记录。
- Agent Chat 左上角提供返回 PM 的产品切换；页面视觉与 PM 一致。
- 左侧按真实 PM 工作区和项目预先展示会话分组，即使分组没有会话也可见；不能写死示例工作区/项目。
- 工作区和项目能配置文件区域。新会话绑定明确作用域，Agent 执行实际使用对应目录，而不是只显示路径文字。
- 本次不设计新权限体系、执行审批、业务 Session/Run 或任务完成规则；原有认证、Origin、目录检查和业务保护保持，不绕过、不扩大授权。
- 子代理按用户指定的 `gpt-6.1-sol`、`xhigh`、`fast` 调度；实际工具接受的配置在交付记录中据实登记。

## 来源与存档

| 来源 | 固定提交 | 标签 | 独立存档 |
| --- | --- | --- | --- |
| agent-workspace | ea10f69a6107362572edd4b75601af1bfb44af50 | archive/pre-v3 | ../repository-archives/agent-workspace-pre-v3.bundle |
| project-management-agent-v2 | b1be0002be89bd9ccc0cf31c5ec9fb33bbf58466 | archive/pre-v3 | ../repository-archives/project-management-agent-v2-pre-v3.bundle |

两份 bundle 已通过 `git bundle verify`。v3 基于 v2 源码提交独立 clone，未继承 origin，Agent 源码按固定提交导入。存档不包含凭据、数据库、`.local`、node_modules 和构建结果。原服务不停止、不重启、不接管；未 push。

## 共享接口合同

### 路由与运行

- v3 公共入口 `http://127.0.0.1:3223`；PM `/pm/*`，Agent Chat `/agent/workspace`，Provider 设置 `/agent/settings/providers`。
- PM API `127.0.0.1:4193`，Agent API `127.0.0.1:4323`，Agent Web 开发上游 `127.0.0.1:4324`，PostgreSQL `127.0.0.1:55443`。
- 外部 Agent API 前缀 `/agent/api/*`，代理到 Agent 内部 `/api/*`。客户端统一负责前缀；保留 same-origin 及 WS upgrade 检查，不通配 CORS。
- PM Cookie 使用独立 v3 名称；Agent Cookie 使用独立 v3 名称。PM、Worker、Agent 数据与环境配置独立；不使用 v2 数据库或原 `~/.agent-workspace`。
- Node 24 LTS、pnpm 11.9.0；保留各应用兼容的 TypeScript/Vite，单锁文件。

### PM 工作区/项目目录目录册（PM 后端所有）

新增共享 TypeScript 合同 `packages/contracts/src/agent-file-areas.ts`，所有端点沿用既有 PM actor、membership 和 local-project 管理能力，不新增角色/能力。

```ts
type AgentScope = { workspaceId: string; projectId: string | null };
type AgentFileArea = {
  path: string | null;
  status: 'available' | 'unconfigured' | 'unavailable';
  revision: number;
  source: 'explicit' | 'project_location' | 'default' | null;
  canManage: boolean;
  reason?: string;
};
type AgentCatalog = {
  workspaces: Array<{
    id: string; name: string; fileArea: AgentFileArea;
    projects: Array<{ id: string; name: string; fileArea: AgentFileArea }>;
  }>;
};
```

- `GET /api/v1/agent-contexts` 返回 `AgentCatalog`，根据真实 PM 当前主体过滤工作区/项目。已保存映射优先，其次为已登记本地项目目录，再使用 Chat Space 默认目录；读取不创建默认目录。尚未分配但可安全创建的区域返回 `source: default`、`revision: 0`、`reason: initializes_on_first_use`。
- `PUT /api/v1/workspaces/:workspaceId/agent-file-area` 与 `PUT /api/v1/workspaces/:workspaceId/projects/:projectId/agent-file-area` 接受 `{ directory: LocalDirectory, expectedRevision: number }`，返回 `{ fileArea: AgentFileArea }`。`LocalDirectory` 复用 existing/new 目录选择合同；不移动项目或改写 PM 核心目录。
- `POST /api/v1/agent-contexts/resolve` 接受 `AgentScope`，返回 `{ scope: AgentScope, workspaceName: string, projectName: string | null, path: string }`。仅未分配作用域可在首次有权解析时初始化默认目录并登记身份；已保存目录失效或调用方不能读取实际路径时明确拒绝，不回退仓库根目录。
- 配置持久化须有 revision 冲突处理。路径解析复用现有可信 allowedRoots，并纳入部署指定的 Chat Space 根目录；既有权限和实际目录检查保持。项目上下文仍由当前 PM 核心项目事实判断。
- `GET/PUT /api/v1/workspaces/:workspaceId/agent-storage-settings` 读取/修改工作区默认保存根目录；PUT 接受 `{ directory: LocalDirectory, expectedRevision: number }`，返回 `{ defaultRoot, effectiveRoot, revision, canManage }`。更改仅影响将来首次分配，不移动已有目录。
- 目录只为执行工作目录提供位置；不是新授权，不代表隔离沙箱。

### Agent 会话与目录快照（Agent 后端所有）

- `@agent-workspace/contracts/chat` 增加导出 `AgentScope`，形状同上；`RemoteThread.scope?: AgentScope`。
- `POST /api/chat/threads` 接受 `{ id, scope?: AgentScope }`，有作用域的新会话在服务端绑定；已有会话不能被相同 ID 重新归属。
- `GET /api/chat/threads` 返回持久化 scope；前端按 scope 分组，不通过 title 猜项目。
- Agent Server 用 `PM_API_URL` 调用 PM resolve；仅转发本次请求 Cookie/Authorization 给固定 PM origin，不记录秘密，不信任浏览器传入 cwd。
- Chat 接受时解析绑定目录，持久化本次 generation 的 scope/path 快照；CLI 实际 cwd 使用该快照。并发会话不得修改全局 cwd 或 Provider 全局配置。
- 目录变更影响后续请求，不改写已接受请求；原生会话复用必须与执行目录相容。
- 当前只执行原生 Agent；旧 API Provider 的历史身份保留但不再执行，继续发送须显式重选。未配置、停用或未安装的 Provider 明确报错，不伪造回复或本机文件能力。
- 保留现有持久历史、取消、流重连和未知副作用处理。无 scope 的历史会话可以查看，不默认为某项目；新 UI 必须先选 scope 再发消息。

### 前端组成与所有权

- Agent 前端 `src/pm/` 为新的 PM 风格纯聊天壳；复用原 assistant-ui 与 durable transport，不新建假聊天存储。
- 左侧列出真实工作区、工作区会话和项目分组；提供新会话、搜索、切换、重命名/删除的真实现有动作。无会话项目仍显示空组。
- 主区保留当前上下文/目录状态、消息和 Composer；目录配置通过轻量弹层。增量接入的右侧检查器按需展开，手机端使用右侧 Sheet，不恢复完整工作台。必要 Provider 配置入口保留，不将未配置假装 ready。
- PM 产品切换用文档导航到 `/agent/workspace?workspace=<id>`，有效项目入口可带 `project`；返回路径仅限本应用 PM 路径。切换前保护未发送草稿，离页不自动取消后台生成。
- 保留 PM 原任务助手及其全页/工具接口，全球产品切换不再把它当完整 Agent Workspace。
- 复用 PM 主题 token、字号、侧栏尺寸、边框、控件和暗色行为。保持桌面和 390px 窄屏可用，不显示双重 PM/Agent 侧栏。

## 工作包与文件所有权

| 工作包 | 所有权 | 交付 |
| --- | --- | --- |
| P1 PM 文件区域 | PM application/infrastructure/contracts 新模块、PM API 新路由及注册、相关 SQL 迁移和行为回归 | 真实目录目录册、配置与 resolve |
| P2 Agent 会话目录 | apps/agent-server 除 index/paths/access 打包入口；packages/agent-contracts/chat | scope 持久化、目录快照、实际 CLI cwd、会话回归 |
| P3 纯聊天前端 | apps/agent-web 的 src/components/hooks/styles（不含 vite/index/package/tsconfig） | PM 风格 Chat、真实分组、双向切换、目录弹层及消息链路 |
| P4 合仓运行与宿主导航 | 根构建/运行配置、Agent 路径/代理、PM 产品切换、Agent server index/paths/access cookie、Desktop/Marketing 路径 | 独立启动、同源双入口、前缀兼容 |
| 主集成 | 本任务文件、AGENTS、最终集成修复、真实服务与浏览器验收 | 可运行 v3 与真实证据 |

所有代理编辑前先读取自身范围。共享接口以本文件为准，变更需通知主集成人和受影响工作包。代理中途不运行 build/lint/tests/formatters，主集成在合并后统一执行；不复制或读取源凭据，不停止旧服务。

## 任务状态

- [x] A01 两源独立 Git 基线、标签与 bundle
- [x] A02 独立 v3 仓库和源码导入
- [x] A03 本任务与共享接口登记
- [x] A04 四个子代理已按 `openai-codex/gpt-6.1-sol:xhigh`、`priority`（fast）会话级配置启动；未保存全局默认
- [x] B01 PM 左上产品切换
- [x] B02 纯 Agent Chat 三段布局
- [x] B03 真实工作区/项目 Session 分组
- [x] B04 Agent 左上返回 PM
- [x] B05 工作区/项目文件区域配置
- [x] B06 会话目录绑定与实际执行 cwd
- [x] B07 PM 统一主题、暗色、窄屏
- [x] B08 原保护与 PM 任务助手保持
- [x] C01 独立安装与受影响工程检查已执行；全量后端回归未通过，见下文
- [x] C02 真实 HTTP/持久化/目录和并发场景
- [x] C03 实际浏览器导航、会话、目录配置与刷新
- [x] C04 文档与实测边界记录

## 验收要求

1. 从 PM 左上进入 v3 纯 Chat，不出现完整工作台导航或第二套 PM 外壳；能从 Agent 左上返回原 PM 工作区。
2. 左侧工作区/项目来自真实 API，空组也可见；新会话归属、切换、刷新及历史恢复一致，两个项目会话不互串。
3. 工作区与项目可选现有目录或显式新建目录；未分配时可在用户级默认根内首次初始化。默认根可配置且只影响后续分配；保存后刷新保持、版本冲突保留输入；已登记目录缺失或不安全时明确拒绝，不能悄悄回退。
4. 通过实际受控原生 Agent 进程验证两个会话使用各自目录，目录快照不被后续配置变更覆盖；旧 API Provider 历史保留且不可继续执行，不静默替换为其他 Agent。
5. 消息请求使用已有真实协议和持久存储；Provider 未配置、错误、停止、断线/刷新不产生假成功或盲目重复提交。
6. PM 原任务助手和项目/任务/文档路径保留；没有新增业务完成或审批规则。
7. 新服务使用独立端口、卷和目录，不连接/修改源服务；真实后端检查中跳过不算通过。
8. 最终记录实际检查、浏览器和模型/CLI证据；真实供应商未配置时明确写未验收，不把固定响应当真实模型。

## 交付记录

本次适配已实现并完成下列实测；**不等于全量回归通过，也不等于真实模型或生产部署验收完成**。

### 仓库与本机运行

- v3 路径：`../project-management-agent-v3`，分支 `v3/agent-chat`。来源存档提交与 bundle 见上表；v3 合并改动保留在工作区，未额外 commit 或 push。
- 已统一安装、迁移至 `0036_agent_file_areas.sql`、创建本副本账号并显式绑定本地附件存储。账号仅在本仓 `.local/access.json`，没有读取或输出凭据内容。
- 已运行本仓五个进程：PM Web、PM API、Worker、Agent Web、Agent API；公共入口 `http://127.0.0.1:3223/pm`，聊天入口 `http://127.0.0.1:3223/agent/workspace`。监听为 loopback，端口与卷不复用来源仓库。
- `services:status` 五进程存活、四项 HTTP 探测返回 200；PM `/health/ready` 的 database/storage/worker/core 均为 true。`providerExecution` 保持 `not-verified`，不是模型就绪证明。
- 本机共享 inotify 配额已耗尽，采用 `CHOKIDAR_USEPOLLING=true` 运行及检查，没有调整全局限额。重启方式见 README。
- v3 为独立新库；没有迁入 v2 示例项目、旧业务数据、旧 Agent 会话或供应商登录。预设分组指读取真实 v3 目录册，不是写死演示数据。

### 已通过的工程检查

| 检查 | 实际结果 |
| --- | --- |
| `pnpm check:docs`、`pnpm contracts:check` | 通过；OpenAPI/命令合同与实现同步 |
| `pnpm lint`、`pnpm typecheck`、`pnpm lint:agent` | 通过 |
| PM 后端 `pnpm build` 与 `pnpm check:web` | 通过，包括 PM Web lint、类型与构建 |
| Agent contracts/client-runtime/server/web 构建 | 通过；最后的窄屏层级与共享主题修复已重新构建 |
| Desktop、Marketing 构建 | 通过；不是 Electron GUI、安装包或真实设备验收 |
| `pnpm test:agent` | 118/118 通过，无跳过；覆盖持久历史、取消/重连/重启、scope、CLI cwd、原生会话复用、Provider 隔离和客户端前缀 |
| `CHOKIDAR_USEPOLLING=true node --env-file=.env --test tests/agent-file-areas.test.ts tests/agent-file-areas.integration.test.ts` | 5/5 通过，无跳过；使用真实 PostgreSQL、HTTP、磁盘和 PM 授权 |

构建仍有既有大 chunk 与依赖注释提示；Agent 字体通过公共入口实际加载，浏览器确认 `Dashboard Inter` 为 loaded，没有把构建时字体 URL 提示当加载成功证据。

### 实际浏览器与 CLI 证据

验收使用独立临时 PostgreSQL schema、真实 PM API/Worker、Agent Hono/SQLite、两套 Vite 与 Chromium；没有替换目录册、聊天传输或持久化为前端假数据。

1. 从 PM 左上进入纯 Chat，再从 Agent 左上返回原 PM；未挂载完整工作台 Inspector/工作流导航。原 `/pm/<workspace>/agent` 任务助手仍可访问，未配置模型时输入禁用。
2. 左侧显示真实两个工作区、Alpha/Beta 两项目及空组。新建、切换、重命名、删除会话后刷新，归属和历史保持；删除 Alpha 会话后项目空组仍保留。
3. 工作区选择现有目录，项目显式新建并保存目录。非法路径被拒绝且输入保留；真实并发更新造成 revision 冲突，读取最新版本后原输入仍保留，可明确重新提交。
4. 实际启动“目录实测 CLI（非模型）”子进程，分别读取 Alpha、Beta、工作区目录内的 marker；同一 Beta 会话更换目录后读取新 marker。四次实际 cwd 分别为 `projects-a/alpha`、`projects-a/beta`、`projects-b/workspace-files`、`projects-b/beta-rebound`，没有全局 cwd 串用。刷新/重命名没有再次执行这些进程。
5. 未发送草稿离页时可取消导航；确认离开后回到相应会话，草稿恢复。PM 带工作区入口打开该范围的新草稿，不擅自选择无关旧会话。
6. 浅色、深色、桌面与 390px 窄屏实际检查；窄屏无横向溢出。修复侧栏遮住重命名/目录弹窗的层级问题，保存与删除均经实际点击。
7. 修复首次尚无 PM 偏好记录时切换主题不持久的问题：直接使用 PM `createWorkspaceStore`。首次切深色后刷新、返回 PM、再回 Agent 均保持深色；正式 3223 编译入口也已验证。
8. 正式 3223 入口实际打开 PM 登录页和 Agent 深链接；未登录时明确提示前往 PM，发送禁用。没有读取账号文件来伪造已登录的正式数据验收。

视觉记录：[桌面对话](docs/implementation/v3-agent-chat-evidence/chat-desktop.webp)、[窄屏 Session 区域](docs/implementation/v3-agent-chat-evidence/mobile-sessions.webp)、[窄屏文件区域配置](docs/implementation/v3-agent-chat-evidence/mobile-file-area.webp)。图片中的账号、项目和 CLI 回复仅为隔离验收数据。

浏览器验收的临时脚本、三个自建 schema/目录和受控 Provider 已清理；正式 v3 服务保留运行，来源服务未接管。

### 全量回归未通过

- 初次 `pnpm check` 遇到宿主 inotify `ENOSPC`；随后受影响实测使用 polling。该次失败及跳过不能算通过。
- `CHOKIDAR_USEPOLLING=true pnpm test:backend` 已执行，但在命令期限结束时仅得到 398 通过、3 失败、80 取消，不能宣称完整回归通过。
- `apps/api/tests/core-adapter.test.ts` 的工作项生命周期案例报 `configured task workflow has ambiguous destinations`。对应测试及 `apps/api/src/core-adapter.ts` 与 v2 的 SHA-256 相同；没有为了本次适配修改任务生命周期规则或缩窄断言。
- 另外观测到 Blob 存储中断迁移案例的 SQL statement timeout，以及账号找回独立 Worker 的 SMTP DATA/心跳等待失败和 suite 超时。这些检查没有用跳过冒充成功。

### 本次明确不宣称的能力

- 未配置和验收真实供应商模型、真实 CLI 登录账号；受控进程只证明消息链路、协议及实际目录，不证明模型质量或外部服务可用性。
- 未新增 PM 成员到 Agent 会话的所有权隔离、授权模型、审批或业务完成规则；保留既有保护。当前面向本机单操作者，目录不是文件沙箱，不作为公网多用户上线依据。
- CLI 不自动导入全局 home/凭据。无当前 PM HTTP 身份的后台恢复不能借用保存的 Cookie；缺少条件时明确拒绝执行。
- 显式新建目录后若 SQL 提交失败，空目录可能保留；文件系统创建不伪装成可回滚事务，应先核对再操作，不自动递归删除或盲目重试。
- 尚未实测生产 Docker/Caddy/TLS、Electron GUI/安装包、真实设备与多实例部署；相关构建通过不替代这些验收。

### 子代理调度

- 工作包：`PMFileAreas`、`AgentScopeRuntime`、`AgentChatSurface`、`V3HostIntegration`。
- 当前工具不接受普通 task 的逐次 `model` 字段；通过 `task.agentModelOverrides` 与 `task.agentServiceTierOverrides` 设置后启动，而非仅在提示词中声明模型。
- 两个设置仅当前会话生效；没有更改用户全局默认。所有代理中途不运行检查，最终由主集成统一执行。

### Providers 设置界面重构（2026-10-28）

以下为首次布局改造的历史记录；独立 API 卡片和旧配置合同已由文末“严格对齐 t3code 原生 Provider”记录替代，不代表当前可用入口。

- 参考用户截图 `Screenshot 2026-10-27 170932.png` 及本机 `t3code/apps/web/src/routes/settings.providers.tsx`、`components/settings/ProviderSettingsPanel.tsx`、`ProviderInstanceCard.tsx` 的列表 / 编辑器分栏和分组设置行；未修改参考仓库。
- `/agent/settings/providers` 改为设置侧栏、真实实例列表与右侧详情。支持提供商搜索、身份与连接状态、行内显示名称、CLI 运行路径 / 独立 home / 默认目录、API 地址 / 环境变量引用、只写环境变量行、模型列表与实例详情。创建使用同一表单；登录、密钥、测试、退出和删除继续走既有实例 API。
- 配置范围如实标为本机 Agent 服务的所有工作区 / 项目，不伪造项目级覆盖、启停开关、CLI 版本 / 自动更新、Shadow home 或启动参数。内置模型列表不作为连接成功证据。未改变后端认证、目录检查、Provider 隔离、PM 权限或业务完成规则（INV-03/09/13/20 边界保持）。
- 编辑草稿保留原 revision；刷新不覆盖输入，冲突明确失败且保留草稿，可显式放弃后载入新版本。切换实例、返回对话、关闭创建弹窗与刷新离页保留未保存提示；保存期间阻止界面切换。环境变量值不进入浏览器持久存储，保存后清空输入。
- 实测：临时 Web `4334` 对接本副本真实 Agent API，浏览器创建临时 OpenAI 实例、改名、保存 / 删除非秘密环境变量，重载后确认持久化；API 读回只有变量名、没有变量值。并发 API 更新使旧草稿保存被拒绝；刷新与取消切换保持草稿。搜索无结果、密钥显隐、取消删除 / 确认删除均已操作；临时实例已通过 UI 删除并经 API 核对不存在。
- 桌面 `1440×1000`、窄屏 `390×844` 与深浅主题已实际检查；窄屏文档宽度为390，创建弹窗未超出视口。已构建并复访正式 `3223/agent/settings/providers`，新布局与字体实际加载，不需重启其他服务。
- 检查：`pnpm exec oxlint apps/agent-web/src/settings`、Agent Web TypeScript / Vite build 通过；`node --test apps/agent-server/src/providers/instances.test.ts` 8/8 通过，无跳过。构建仍有既有字体运行时解析、Zod 注释与大 chunk 提示；正式入口 `Dashboard Inter` 加载通过。
- CLI 登录入口实测启动现有独立 Codex 登录流程，供应商设备码请求返回 HTTP 403，界面明确显示失败；没有重试、登录成功或真实模型推理验收。本次不将 UI 与实例 CRUD 通过视作供应商可用性验收。

### v2 数据迁入（用户显式授权）

- 本次按用户“直接迁移”的要求覆盖 v3 初始 PM 数据；此前交付记录中的空工作区状态已被此次迁入替代。使用停写备份与受支持的完整恢复流程，v2 已恢复运行，v3 继续使用自身端口、数据库、存储和服务配置。
- 源快照时间为 `2026-10-27T21:24:19.102Z`；操作 ID 为 `2369a6de-4876-4b03-abe0-b7815bd0e47a`。恢复后应用 v3 的 `0036_agent_file_areas.sql`，存储 epoch 为 `2`。
- 迁入账号、工作区与项目各 1 个；工作项 13、文档 4、迭代 2、里程碑 2、模块 3、需求 3、发布 2、目标 2。PM 原任务助手保留 2 个线程、14 条消息和 7 条工具调用；其历史仍在原 PM 入口，不伪造为新 Agent Chat 会话。
- 工作区保留 `e317b803-5c03-4eb9-a7d9-79d7a38927bf`。`PRJ-001`（Nova 客户门户 · 示例项目）已复制到 `.local/projects/e317b803-5c03-4eb9-a7d9-79d7a38927bf/762dee3c-41af-468a-a624-351cc478522e`，注册路径与物理身份由恢复流程重新绑定。工作区默认项目父目录和 Agent 文件区域经正式 HTTP 应用服务设为该项目目录的父目录；项目复用其登记路径，两种作用域解析均为 `available`。
- 停写状态校验：34 份项目文件与备份校验一致，33 份核心文件保持一致，仅 `project-locations.json` 按目标路径与物理身份重写。备份引用附件为 0 个，没有附件下载样本。
- 使用复制后的访问文件，通过正常 CLI 登录与 `task list` 读取到 13 个任务；未读取或输出凭据内容。真实浏览器显示迁入项目与 4 份文档，左上角切换后 Agent Chat 显示实际工作区、项目分组及可用目录。v3 五项进程运行、各 HTTP 探测返回 200；v2 API/Worker 恢复且数据库、存储、Worker、核心就绪检查通过。
- `.local/access.json` 已保持 0600 并同步 v2 账号；旧会话由恢复流程失效，需要重新登录。v3 的 `.env*`、Agent SQLite 与 Provider homes 未被来源配置覆盖；未新增权限或业务规则，也未进行真实 Provider 推理验收。
- 源备份保留于 `.local/backups/v2-source/`，原 v3 数据备份保留于 `.local/backups/pre-v2-import/`，原文件与私有 tar 保留于 `.local/backups/pre-v2-import-files-2369a6de-4876-4b03-abe0-b7815bd0e47a/`；原数据库保留为 `pm_v3_before_v2_2369a6de48764b03abe0b7815bd0e47a`。精确路径和无凭据核验结果记录在 `.local/migrations/2369a6de-4876-4b03-abe0-b7815bd0e47a/`，这些本地备份不提交 Git。

### t3code 必要设置 S01–S10 实现（2026-10-28）

按本次设置清单完成纯 Chat 适配，没有恢复完整 Agent 工作台、引入新权限体系或修改工作项完成规则。六个子代理使用当前会话的 `openai-codex/gpt-6.1-sol:xhigh` 调度覆盖：`SettingsShell`、`ChatDefaults`、`ProviderCapability`、`ChatExperience`、`HistoryFileAreas`、`DataDiagnostics`；共享接口先冻结，检查由主集成统一执行。模型覆盖未保存为全局默认。

| 编号 | 已交付范围 |
| --- | --- |
| S01 | 七个设置路由、统一侧栏 / 作用范围、加载 / 失败状态、保存中及未保存离页保护；浏览器前进 / 后退也经过保护 |
| S02 | 服务端 revision 默认 Provider / 模型，创建时一次快照，历史不覆盖；无默认、失效模型和显式选择均不静默降级 |
| S03 | 内置 / 发现 / 自定义模型目录、注册 ID 与执行校验统一；未知 temperature / reasoning 能力不伪造，CLI 任意模型 ID 不绕过目录 |
| S04 | CLI 路径 / 版本与独立登录、凭据存在、实际认证、最近连接观察分离；观察记录绑定配置 revision，过时结果明确标失效 |
| S05 | 授权工作区 / 项目和空组文件区域汇总；真实状态、来源、路径与 revision；复用既有浏览、配置和冲突流程 |
| S06 | 当前会话模型 / system prompt / 支持的 temperature 原子保存；版本冲突保留输入、阻止发送并允许明确重试 |
| S07 | Enter / Ctrl-Cmd+Enter、IME 保护、新建 / 搜索 / 停止快捷键与帮助；停止等待真实持久终态，不靠断流假装成功 |
| S08 | PM 共用主题、系统跟随、密度与减少动态；Agent 正文字号、宽度和代码换行，刷新保持且作用于真实正文 |
| S09 | 会话归档、按原范围恢复、永久删除确认；运行中拒绝归档，不因缺目录迁移归属或自动取消执行 |
| S10 | 实际存储 / 诊断和白名单报告；离线 Agent 备份、私有权限、显式秘密策略、一致快照、独立恢复与覆盖核验 |

#### 本轮工程检查

- `pnpm lint:agent`、备份 CLI 的 ESLint、Agent contracts / client-runtime / server / web 构建和类型检查通过；最后的字号、减少动态与代码换行修复已重新构建。
- Agent client-runtime **11/11**、server **131/131**、desktop **3/3** 通过，均无跳过。服务端最终使用 `node --test --test-concurrency=1 'src/**/*.test.ts'`；首轮发现的缺 scope 错误优先级回归已修复，CLI 超时案例在最终串行检查通过。
- `pnpm check` 的文档 / 合同 / lint / 类型检查通过；该次测试结果为 368 通过、3 失败、1 取消、6 跳过，不能视作全量通过。失败包括既有 `core-adapter` 工作流目的地歧义，以及宿主 inotify `ENOSPC` / watcher 等待超时；没有改写无关 PM 生命周期规则。
- PM 后端 `pnpm build` 通过。Web 构建仍有既有运行时字体路径、Zod 注释和大 chunk 提示；不将这些构建结果当作生产部署或模型验收。
- `TMPDIR=/tmp CHOKIDAR_USEPOLLING=true pnpm test:backend` 已按用户要求停止，未重启。停止前观测到工作流目的地歧义、独立 SMTP Worker 心跳及账号恢复并发 / suite 超时失败；没有完整结束统计，不记作全量回归通过。

#### 本轮真实运行与浏览器证据

使用独立 PostgreSQL schema、真实 PM API、Agent Hono / SQLite、受控 HTTP Provider 和 Chromium，在临时 `4338` 入口验证；没有读取正式账号文件、修改来源仓库或接管正式服务。

1. 自定义模型注册后出现在默认模型和当前会话选择器；受控 HTTP 请求实际收到注册 ID，未知模型未携带 temperature。当前会话选择已知模型后，真实请求携带所保存的 system prompt 和 temperature；服务默认不随之改变。
2. 新默认仅进入新会话，原会话保留模型与提示词。移除已选模型后，默认状态为 unavailable、会话仍保留原 ID 且发送禁用；清空默认后，新会话必须显式选择模型，保存后可发送，不自动创建全局默认。
3. 实际并发 PUT 造成会话设置 409，编辑内容保留，发送禁用；明确重试保存后恢复。Provider 未保存编辑跨设置页及浏览器后退均出现离页保护。配置更新后显示旧检查已失效。
4. `/models` 实际返回 401 时，界面区分“凭据已配置”和“未认证 / 连接失败”；恢复受控接口后再次手动检查通过。没有用凭据文件存在推断可连接。
5. Ctrl/Cmd+Enter 模式下 Enter 插入换行，IME 组合输入不发送；实际快捷键新建、搜索和停止成功。运行中归档返回 409，停止经服务端记录确认为 cancelled，未因归档请求偷偷取消。
6. 通过侧栏归档会话，在历史页恢复后，原工作区 / 项目与历史保持。文件区域页显示原生项目目录和空工作区；通过弹窗在允许父目录显式新建并保存空工作区目录，服务端返回 revision 1。
7. 主题跟随系统深浅变化，刷新保留共享 PM 偏好；桌面及 390px 窄屏实测。真实正文字号为 16px，减少动态后的动画时长为 0.00001s；长代码块宽度与 scrollWidth 均为 344，文档宽度为 390。修复了原先错误的正文 CSS 选择器和高亮器内联样式导致的换行失效。
8. 实际下载 `agent-diagnostics.json`，SQLite 所有权与 quick_check 通过；报告不含验收消息 / 提示词、Provider 名称、路径或合成凭据。存储页展示实际路径和备份边界，窄屏无横向溢出。
9. 真实 `agent:backup create` 对运行中的 Agent 明确拒绝且不发送进程信号。停止自建 Agent 后，`create --secrets exclude`、独立目标 `restore` 与 `verify` 成功，记录覆盖摘要一致：4 会话、2 历史、8 消息、1 份默认设置。另行启动恢复目录的真实服务，通过 HTTP 核对历史 / 会话参数 / 默认值保留，Provider 凭据和自定义 endpoint 已排除、不可伪装为已配置。

浏览器、自建服务、三个已识别验收 schema / 目录、离线备份及恢复副本均已清理。真实供应商模型、真实 CLI 登录与生产升级仍未验收；受控响应只证明配置传递、HTTP / 持久化和恢复链路。备份命令与秘密策略见 [README](README.md) 的“Agent 离线备份与恢复”一节。

### Chat Space 默认位置与作用域检查器（2026-10-28）

- 用户要求默认位置为服务用户 `~/.pmv3`，支持更改默认保存位置，并先通过参数使用 `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/.pmv3` 验证。生产默认值不包含本机绝对路径；`PM_CHAT_SPACE_ROOT` / `buildApp({ chatSpaceRoot })` 覆盖部署根目录，设置页提供按工作区的 revision 覆盖。
- 默认结构为 `<root>/workspaces/<workspaceId>/workspace` 与 `<root>/workspaces/<workspaceId>/projects/<projectId>`；迁移 `0037_agent_storage_defaults.sql` 保存根设置和映射来源。显式配置、原生项目路径及已分配默认目录不迁移；SQLite、Provider homes、PM 数据库和附件位置不变。
- 默认区域首次授权 resolve 才创建并登记设备/inode 身份；只读目录册无创建副作用。缺少可信父目录、软链接、越界、失去权限或已登记目录丢失时明确拒绝。沿用 INV-01/09/13/20、SC-12/14/20 的作用域、未知结果、版本与当前授权边界，不新增权限、审批或业务完成规则。
- 当前纯 Chat 挂载 Files / Git / Terminal / Browser。请求携带真实 scope，持久会话另带 threadId；HTTP 和 WS 都通过 PM 当前身份解析，不接受浏览器 cwd/root，不再使用 Agent 服务全局项目根兜底。终端冻结连接目录，关闭/切换上下文断开；iframe 不开放 `allow-same-origin`。
- 隔离实测使用真实 PostgreSQL schema、PM HTTP、Agent Hono/SQLite、真实 PTY、Vite 与 Chromium，测试根参数为上述用户指定路径。两个工作区的文件标记、Git 状态与 patch、终端 cwd 和读文件、缺少 scope、遍历越界与 thread/scope 不匹配均已验证。
- 浏览器实测桌面文件预览与 Diff、终端 `BROWSER_PTY_OK` 回显、切换工作区清空旧面板并读到另一目录标记、sandbox 网页预览、默认根保存/刷新、真实并发 revision 冲突保留输入及显式重读恢复；已分配目录保持不变。390×844 深色检查器 document/Sheet 宽度均为390。修复 Git 面板 StrictMode effect 重放取消请求后不再加载的问题，并复验状态和 Diff。
- 本次不修改现有正式目录或重启常驻服务；新前端构建输出到隔离 `.local/chat-space-web-build`，不覆盖常驻 Web 产物。正式启用需迁移与配套服务更新。真实模型供应商、本机 shell 权限隔离及公网多用户部署不在本次验收声明内。
- 工程检查：PM `pnpm lint`、`pnpm typecheck`、`pnpm build`；Agent lint、typecheck、服务端143项测试（无跳过）、服务端构建通过。修复 Git 加载后再次通过受影响前端 oxlint、tsc 和隔离 Vite 构建；构建仍有字体资源解析与大 chunk 警告。文档链接检查和 OpenAPI 生成一致性检查通过（90 paths）。
- 真实数据库目录专项首次为8通过、1失败、0跳过：失败发生在权限用例的隔离 API 启动阶段，未进入业务断言。临时加入只含机器错误码的诊断后，该权限用例独立执行通过，未复现且无法确定首次退出原因；随后撤回临时诊断，不掩盖首次失败或声称整轮全绿。
- 全量 `CHOKIDAR_USEPOLLING=true pnpm test:backend` 未通过：397通过、5失败、79取消、0跳过，命令被中断并返回143。失败包括 `core-adapter` 的 `invalid_transition`、blob binding / project blobs 的3处迁移 SQL 超时，以及 SMTP Worker 心跳验收；account-recovery 并发套件超时后未完成后续文件。不能将这些取消项记为通过，也未为本次目录功能修改业务生命周期或账户恢复语义。目录专项另行执行的结果见上一条。
- 隔离浏览器/PTY/PM/Agent/Vite 服务、验收 schema、指定根下自建测试目录、临时脚本与隔离构建目录已清理；保留用户指定的 `.pmv3` 空根。

### 常驻实例更新尝试与阻塞

- 用户反馈实际页面看不到右侧栏。核对本机 v3 的端口/PID/cwd 后确认：3223 提供旧 Agent Web，数据库版本为 `0036_agent_file_areas.sql`，PM readiness 的 database 检查为 false。首次源码/隔离验收没有完成常驻页面交付。
- 已通过正常迁移入口应用 `0037_agent_storage_defaults.sql`，PM 后端构建通过；没有修改原工作区/项目映射。更新期间只停止服务管理器核验为本副本所有的5个进程。
- Agent 完整构建被同时进行的 Provider 改造阻断：新 driver registry 引用尚未就绪的 driver 文件，新 ProviderDriver/config/auth 合同与实现不匹配。独立 Web 类型检查也因 Provider 弹窗和 diagnostics 合同字段不一致失败；未跳过类型检查或强行发布混合前端。
- 当前清单新增 `@cursor/sdk` / `@muse-code/sdk` 时锁文件尚未同步，pnpm 的自动依赖检查阻止常规启动；未擅自安装/改写该并行依赖。改为直接执行已有 `node scripts/services.mjs start`，使用现存已构建的 Agent/Web 恢复5个常驻进程，并向 PM API 传入指定 `PM_CHAT_SPACE_ROOT`。服务管理器检查 PM readiness、Agent HTTP、公共 Web 和 Agent Web 均为200。
- 恢复后再次实际打开3223的 Chat 页面，右侧工具栏按钮仍为空；没有冒充完成上线。未覆盖 Provider 源码或其并行修改。下一步依赖 Provider 配套修改/依赖完整收口，或明确授权由本任务接手该额外范围，再构建、发布并验证当前页面。

### Agent Chat 侧栏产品切换与账户区对齐（2026-10-28）

- 左上角不再使用自定义“Agent Chat / Project Management”下拉，改为与 PM `PmWorkspaceSwitcher` 相同结构的面板：真实工作区身份与当前产品触发项；“工作空间”列出 Project Management 与当前 Agent Chat；“当前工作区入口”按能力显示工作区设置、成员与团队；随后为切换工作区、刷新工作区、全部工作区。工作区切换继续走现有 `selectScope`，没有新增项目归属或权限规则。
- 左下角改为与 PM `PmUserMenu` 相同的账户布局：头像、姓名、chevron，向上展开身份卡（姓名、邮箱）、设置、对话快捷键、三态主题和退出登录。姓名与邮箱来自既有 `GET /api/v1/auth/me`，头像按 PM 方式在首次打开时读取 `GET /api/v1/workspaces/:workspaceId/dashboard/personal`；读取失败只回退到账号姓名与首字母头像，不伪造资料。
- 复用 PM 的 `pm-user-menu.module.css` 和 `--surface` / `--text-*` / `--control-radius` 等既有 token；未扩大认证、Origin、目录或业务完成规则。Agent Web 构建通过。
- Chromium 在 3223 实测：两处面板可开合，工作区名称/产品描述、当前项、PM 跳转与工作区设置/成员链接、主题即时生效并写入 PM 共享偏好；退出登录实际使 `pm_v3_session` 失效、`/api/v1/auth/me` 返回 401 并跳到 `/pm`，随后重新登录恢复。390×844 侧栏宽 310，触发项高 48/36，无横向溢出或控制台错误。
- 同一环境 `/api/v1/agent-contexts` 返回 503，日志为宿主 `ENOSPC`（既有 watcher 限制）；该接口在本次改动前已同样失败。因此本轮未能重新核对工作区/项目分组列表与作用域快照，只验证了账户目录与既有接口在可用部分的表现，不记作分组功能通过。Agent Web `tsc` 仍有并行 Provider/diagnostics 合同错误，未将 `vite build` 结果当作类型检查通过。

### 严格对齐 t3code 原生 Provider（2026-10-28）

- 重新核对来源：`agent-workspace/apps/server/src/providers/catalog.ts` 原本混合了 DeepSeek / OpenAI / Anthropic API 与 Codex / Claude CLI，并不具备 t3code 的完整原生集合。本轮不再把这套旧 API 卡片当作 t3code 配置；复用其持久会话、目录、取消和恢复基础设施，缺失驱动按 t3code 实际代码移植适配。
- 集合为 Codex、Claude、Cursor、Grok、OpenCode、Antigravity、Muse Code、Pi、ACP Registry；新数据默认仅有 Codex / Claude，其他通过“添加提供商”创建。配置来自各驱动声明，涵盖对应路径 / home / 参数、原生服务连接、环境变量、模型和启停。只保留原生 Agent 确实支持的认证方法，不另设通用 OpenAI / Anthropic / DeepSeek API Provider。
- 来源包括 t3code `packages/contracts/src/settings.ts`、`apps/server/src/provider`、`orchestration-v2/Adapters`、`packages/provider-{cursor,grok,opencode,muse,pi,acp-registry}`。保留 [MIT 归属](LICENSE.t3code) 与上游 Muse SDK 补丁；补齐 Cursor SDK worker 构建入口和锁文件。未修改两个来源仓库。
- 原生执行分别接入 Codex app-server、Claude SDK、Cursor SDK worker、ACP、OpenCode 服务、Muse MSP 与 Pi RPC；安装准备只经显式操作触发。旧 API 新建、检查、认证、执行及续接入口均拒绝，原始配置 / 凭据和历史字节保留；历史不可静默换成 Codex。仅有真实原生游标时恢复或 fork，其余沿用需确认的可移植接续。
- 沿用既有 PM scope/cwd、权限与副作用检查，不新增业务完成规则。登录 / 退出与执行互斥，取消后等待原生进程退出；认证输入绑定 flowId，配置和模型观察绑定 revision。秘密写入后不回显、不进浏览器持久存储；未知身份不推断已认证，登录流程完成也不冒充账号核验成功。
- 工程检查：Agent contracts / client-runtime / server / web 构建及对应类型检查通过，服务端最终 **279/279** 通过，失败 / 取消 / 跳过均为0。修复了 Node 24 不支持的参数属性、原生模块循环依赖、SDK 消息夹具合同和 Cursor 子进程退出边界。Web 保留既有字体运行时解析、Zod 注释及大 chunk 提示；Pi 临时扩展有 Node 模块类型探测警告，不将警告隐藏为无输出。
- 浏览器实测使用隔离 `44593`、独立数据与 home、真实 Hono 服务和构建后的 Web。确认九种可创建驱动及默认两实例；创建停用的 OpenCode 实例，改名保留密码，GET 不回显，显式清除生效。检查 ACP 本地命令及独立参数编辑；Codex 设备码显示 / 取消、取消后重新认证、状态检查和真实原生运行入口均完成。原生进程为受控协议夹具，返回实际 session/turn 游标；没有调用商业模型。
- 桌面 `1440×1000`、窄屏 `390×844`、深浅主题已实际观察，文档宽度分别为1440和390；停用实例的登录 / 检查按钮不可用。未保存创建表单关闭时要求明确放弃。临时浏览器、服务和验收脚本已关闭 / 移除，未重启常驻服务。
- 本轮仅运行受影响 Agent 检查，没有重启用户已停止的 PM `pnpm test:backend`。此前原生 Provider 导致的构建阻塞已解除；不据此宣称常驻 API 已更新、Inspector 已上线或真实供应商账号 / 付费模型 / Windows 沙箱已验收。t3code 宿主专属的托管 Codex 和 Claude 空闲调度不作为已实现选项暴露。

### 常驻右侧栏禁用修复

- 新 Web 已展示 Files / Git / Terminal / Browser，但当前授权目录册返回503，四个按钮依赖的 scope/fileArea 无法就绪。真实请求 `req-4n` 对应 PM API 日志为 `ENOSPC`；磁盘剩余6.3T、inode仍有余量，现有文档已规定该宿主使用 polling。账户与工作区授权读取、默认根设置读取均为200，不是 Provider 未选模型或新增权限造成的禁用。
- 核对4193端口、服务记录、PID启动时间、cwd和入口后，仅优雅停止 PM API `43735`，使用 `CHOKIDAR_USEPOLLING=true PM_CHAT_SPACE_ROOT=/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/.pmv3 node scripts/services.mjs start` 重建 API。Worker、Agent API、Agent Web、PM Web 的既有PID保持，未修改 Provider 源码、权限条件、磁盘目录映射或系统 inotify 限额。
- 修复后真实 `/api/v1/agent-contexts` 返回200；工作区显式目录与 PRJ-001 原生项目目录均 available。当前3223登录页面实测四按钮 `disabled:false`；Files显示迁入项目目录，Git读取当前 scope 的分支/状态，Terminal连接后 `pwd` 返回既有工作区目录并回显 `INSPECTOR_READY`，Browser面板展示地址与视口控件。切出 Terminal 后关闭该验收PTY，未运行模型或改写项目文件。
- 本次是运行配置修复，无源码逻辑改动、不重复执行全量后端测试。后续重新启动这台机器上的 PM API 仍需保留 polling 参数；普通 `services:start` 不会更新已经运行进程的环境。用户可点击“刷新状态”或刷新 Chat 页面重新读取目录册。

### 自动化页面迁入 Agent Chat（2026-10-28）

- 自动化管理从 PM 外壳迁入独立 Agent Chat：左侧新增“对话 / 自动化”页签，`?view=automations` 保留在 URL；切换会话、工作区或退出页签会移除该参数。PM 侧删除 `:workspaceSlug/automations` 路由与 Agent 折叠分组入口；PM 内嵌聊天侧栏的自动化链接改为跳转 `/agent/workspace?workspace=<id>&view=automations&returnTo=...`。
- 页面继续使用 PM 所有的真实自动化 API 与收据语义：规则、能力、项目实体仍通过同一 `/api/v1/workspaces/:id/*` 读取；规则草稿/待核对请求沿用恢复 journal，写入结果只查原收据、不重发。项目、能力与访问范围仍由 PM 服务端判定，Agent Chat 不新增授权或业务完成规则。
- 前端将原 PM 自动化 UI 迁到 `apps/agent-web/src/pm/automation/`，复用 Agent Chat 的会话/工作区身份、按钮、输入与对话框；Radix 色阶改为映射 PM/Agent 共用语义 token。页面懒加载，不把自动化代码放入对话首屏。
- 验证：Chromium 在 3223 实际创建规则、启用、暂停、删除，均收到服务端成功收据并清理；运行历史显示空状态；390×844 无横向溢出。PM 导航不再出现自动化，旧 `/pm/<workspace>/automations` 返回 404，PM 内嵌聊天侧栏链接指向新视图。Agent Web 构建通过，受影响 oxlint 与 `src/pm` 类型检查通过；迁移后的 journal 测试 6/6 通过。浏览器控制台仅有导航导致的请求中止，无运行时异常。

### 输入框模型选择器对齐 t3code（2026-10-28）

- 两个实现子代理 `TerraPickerUI`、`TerraPickerSession` 使用本会话 `openai-codex/gpt-6.1-terra:xhigh` 调度覆盖；未保存为全局默认。来源为 t3code 的 `apps/web/src/components/chat/ProviderModelPicker.tsx`、`ModelPickerContent.tsx`、`ModelPickerSidebar.tsx`、`ModelListRow.tsx` 及搜索逻辑；接入本项目真实 Chat composer，不另建展示页。
- 复刻紧凑模型触发器、44px 提供商图标侧栏、收藏分区、跨提供商多词排序搜索、选中标记、收藏按钮及提供商管理入口。模型仍来自已有原生 Provider 实例目录；没有新增通用 API Provider、虚构模型、reasoning 档位或多模型并发能力。
- 收藏按实例 ID / 模型 ID 二元组写入浏览器 localStorage；同名模型分属不同实例时不混淆。目录加载失败不继续展示可选旧结果，保留显式刷新；停用、未配置和无模型状态保留原因与管理入口。选择器与发送守卫共用同一目录快照，不自动替换失效的当前选择。
- 选择通过原有当前会话设置合同保存，保留 system prompt / temperature，不覆盖服务默认值或其他会话。保存冲突保留修改和输入，禁止发送并提供明确重试；运行中禁止切换模型。忽略过时 revision 与目录刷新结果，选择器瞬时状态按会话隔离。
- Chromium 验证：跨实例搜索并用 Enter 选择，真实 GET 确认持久化且其他参数保留；A/B 会话分别保留模型；实际并发 PUT 产生409后草稿仍在、发送禁用、显式重试成功。受控 Codex 原生进程实际收到所选模型和 system prompt，生成期间选择器禁用，真实结束后恢复。
- 键盘实测先复现 `keyCode=229` 且 `isComposing=false` 的 Enter 误选，修复后不再提交；Escape 关闭后恢复触发器焦点。验证同名跨实例收藏、刷新持久化、存储写入被拒时内存操作、损坏 JSON 恢复、离线目录失败与在线恢复、停用当前 Provider 不自动换模型，以及管理入口。桌面1440×1000、窄屏390×844及深浅主题已实际观察，窄屏弹窗没有横向溢出。
- 工程检查：受影响六个前端文件 oxlint、Agent Web TypeScript 与 Vite 构建通过；client-runtime **11/11**、会话设置 / revision / 历史 API 隔离 / 模型执行优先级专项 **6/6**，均无失败或跳过。最终浏览器使用独立输出目录，避开并行构建替换公共产物；保留既有字体运行时解析、Zod 注释和大 chunk 警告。
- 验收使用临时44594、真实 Hono/SQLite 与受控原生协议；PM 身份 / 目录为夹具，不代表真实 PM 授权或商业模型验收。浏览器、临时服务、脚本及独立数据已清理；没有重启常驻服务或用户已停止的全量 PM 后端测试。源码与隔离验证完成，不据此宣称常驻页面已发布。

### 页面错误边界与构建资源保留

- 实际点击 Git / Terminal 捕获了与用户反馈一致的整页错误边界。主页面中的异常为 `Failed to fetch dynamically imported module: /agent/assets/terminal-panel-Ds3N5aGl.js`；随后的构建目录只剩新哈希文件。验收期间 `dist/index.html` 和资源文件名确实再次更新，旧页面仍引用已删除的 chunk。不是 PM 目录权限失效，也不能靠吞掉异常或自动重试提交修复。
- `apps/agent-web/vite.config.ts` 设置 `build.emptyOutDir:false`，保留旧页面仍会延迟请求的带哈希模块。部署说明明确禁止在线清空输出目录；代价是历史静态资源占磁盘，只在显式停机维护时清理。已经丢失依赖的旧页面仍需手动重新加载一次。
- 同时修复了一处独立版本不匹配：常驻 Agent API 原先只返回旧 `{providers}`，而新 Provider 页面需要原生 `drivers/config` 等合同，导致设置页渲染失败。核对实际监听/PID/cwd、确认 SQLite 只有1个普通会话且没有生成/执行记录后，仅重启 Agent API 加载配套产物；PM API 的 polling 进程及其余常驻进程保持。
- 首次独立 Web 类型检查遇到并行新增的 `RemoteThread.sidebar` 已在源码、尚未生成到 contracts dist 的错误；随后按现有 `pnpm build:agent` 的依赖顺序重新生成 contracts、client-runtime、server 与 web，完整构建及各类型检查通过。配置文件 oxlint 通过，仍有既有字体解析、Zod 注释与大 chunk 构建提示，未重跑用户已停止的全量 PM 后端测试。
- 实际3223浏览器保持构建前页面不刷新，跨完整构建连续读取原终端 chunk 1077次，状态/内容均无失败；构建后旧页面首次打开 Terminal 成功并连接，证明未仅验证新页面。之后刷新加载当前版本，Files目录、Git状态、Terminal连接、Browser控件均可用；Provider页面及九种驱动的新建弹窗、Diagnostics页面可打开，最终这些交互没有新增 console error。没有保存提供商、执行模型、重试消息或取消生成；临时资源监测与验收PTY/浏览器已关闭。

### 顶栏终端抽屉与右侧面板开关（2026-10-28）

- 参考 `t3code` 的 `PanelLayoutControls`：对话顶栏右侧新增“切换终端抽屉”和“切换右侧面板”按钮，使用 `PanelBottom` / `PanelRight`，以 `aria-pressed` 表示开启状态；不可用目录或作用域时禁用，不伪造可用。
- 终端抽屉位于对话主区底部，高度默认 320px，可拖动分隔条或聚焦后用方向键调整，范围 300–720px/70vh，并按浏览器保存 `pm-v3:terminal-height`。抽屉只在作用域与文件区域可用时渲染；关闭即卸载 `TerminalPanel` 并断开 PTY，切换会话/目录会以新 scope 重连，沿用原有终端固定 cwd 语义。
- 右侧面板状态由 `PmInspector` 内部提升到 `PmChatSurface`：顶栏按钮在关闭时打开上次使用的面板（默认 Files），再次点击关闭；既有关闭按钮、工具栏和移动端 Sheet 共用同一状态。切换自动化视图时右侧面板与终端抽屉不渲染，返回对话后恢复。
- 快捷键沿用 `t3code` 默认：`Ctrl / ⌘ + J` 切换终端抽屉，`Ctrl / ⌘ + Alt + B` 切换右侧面板；输入框、终端、菜单或弹窗聚焦时不接管，快捷键帮助同步列出。
- Chromium 在 3223 实测：终端抽屉打开后 PTY 显示“已连接”并输出真实 cwd；键盘与按钮均可开合；右侧面板打开 Files、关闭、快捷键重开正常；抽屉高度从 320 调到 344 并持久化；390×844 顶栏无横向溢出，终端抽屉宽 354、右侧检查器 Sheet 宽 390。Agent Web 构建通过，受影响文件 oxlint 与 `src/pm` 类型检查通过。

### Session 右键菜单对齐 t3code（2026-10-28）

- 两个实现子代理 `SessionMenuBackend`、`SessionMenuFrontend` 使用会话级 `openai-codex/gpt-6.1-terra:xhigh`，未保存全局模型配置。只读取 t3code，不修改来源仓库。
- 来源调用链：`threadActionMenu.logic.ts` 定义菜单，`useThreadActionMenu.ts` 分发，`useThreadActions.ts` 执行动作；`Sidebar.tsx` / `Sidebar.logic.ts` 决定显示，`packages/client-runtime/src/state/threadSettled.ts` 判定自动归置与提前唤醒。本项目菜单为 `apps/agent-web/src/pm/session-menu.tsx`，分组接入 `chat-surface.tsx`；合同在 `packages/agent-contracts/src/chat.ts`，持久化规则在 `apps/agent-server/src/durable/thread-sidebar.ts`。

| 来源动作 | 本项目执行及侧栏影响 |
| --- | --- |
| Pin / Unpin | 独立持久化置顶时间，进入置顶组；暂缓期间保留 pin，唤醒恢复原位置。 |
| Settle / Un-settle | 手工归置清除 pin，移入可折叠归置组；取消后回活跃组，不改归档状态或 PM 业务状态。 |
| Snooze / Wake | 提供1小时、3小时、今晚、明早、下周一与自定义时间；进入暂缓组，精确到期刷新唤醒。待处理输入/审批与新失败提前唤醒，普通后台完成不提前唤醒；正在运行本身不禁止暂缓。 |
| Rename / Regenerate title | 更新当前会话标题；重生成使用独立临时目录与原生无工具 helper，读取上下文但不续写原会话。检查模型配置、历史与 revision 未变才保存。 |
| Mark unread / Filter by project | 未读由服务端保存，真正访问时清除；筛选仅改变当前侧栏可见项目，不修改归属，清除后恢复全部授权组。空项目始终保留。 |
| Auto-settle | Enabled / Disabled 持久化；默认3天无活动才自动归置，排除置顶、暂缓、运行中、待处理输入及显式手工覆盖。不是“生成成功即完成”。 |
| Copy / Project settings | 复制真实路径、Git 分支或会话ID；不可用的路径/分支不伪造。项目设置复用既有文件区域对话框与服务端核验。 |
| Archive / Delete | 归档移出常规侧栏并可从历史恢复；删除二次确认、删除历史及侧栏状态。运行中禁用两者，不通过删除取消生成。 |

- 侧栏分区优先级为 Snoozed → Settled → Pinned → Active，显示顺序为 Pinned / Active / Snoozed / Settled。当前会话归置或暂缓后，沿用草稿保护切换到同作用域的新会话草稿；不取消原生运行。新用户回合解除归置与暂缓，后台继续执行不冒充用户重新打开。
- 新接口 `POST /api/chat/threads/:id/sidebar` 使用独立 sidebar revision；`POST /api/chat/threads/:id/regenerate-title` 使用现有会话 metadata revision。均复用 PM scope 校验；409后重读并显示冲突，不盲目重发写入。旧 Archive 单动作组件已由完整菜单替换。
- 标题能力边界：Codex 临时 `exec --ephemeral`，read-only、禁用插件/apps并核验关闭 MCP；Claude 独立 SDK 请求，工具/MCP为空、不保存原生会话。其他驱动明确禁用，不返回伪造标题。保存前复核权限、配置与会话并发变化。
- 首轮工程检查：Agent 全量类型检查及构建通过，lint 无错误；`pnpm test:agent` **363/363**（client-runtime 11、server 349、desktop 3），无失败或跳过。清理后侧栏/标题专项 **8/8** 及全部本次 TS/TSX 文件 oxlint 通过，已消除标题校验的 lint 警告。收尾时并行 Usage 修改先出现未生成的 contracts/usage；重新构建 contracts 后，最新全量类型检查仍被不属于本菜单的 `providers/drivers/codex.ts:49`（Error 缺少 CliChatError.code）阻塞，未改写并行实现，不将首轮结果冒充最新全量通过。`pnpm test:backend` 被另一 backend 测试进程持有的 `.local/backend-tests.lock` 拒绝，exit75；未停止该进程，不计作通过。
- 收尾独立执行 `pnpm --filter @agent-workspace/web typecheck` 和 `pnpm --filter @agent-workspace/web build` 均通过；该结果覆盖最新侧栏集成与旧归档组件清理。构建仍提示字体运行时解析、Zod 注释与大 chunk，不代表上述全量服务端类型阻塞已解除。
- Chromium 验收使用临时4349/4350、真实隔离 PostgreSQL PM、Hono/SQLite、独立工作区/两个项目及受控 Codex 原生子进程。完成真实生成后验证完整菜单、置顶刷新、未读/访问、归置/恢复、定制暂缓/手动与到期唤醒、自动归置开关、项目筛选、重命名、标题生成前后历史相同、真实路径/分支/ID复制、项目设置、归档与历史恢复、删除取消与确认、保留空项目。额外实际409并发写入确认提示冲突且保留胜出状态。
- 深浅主题及390×844窄屏实际观察，菜单/子菜单无横向溢出。开发服务受并行源码变更的 HMR 干扰后，定时唤醒与最终窄屏验收改用构建后的预览。原生 Agent 为受控协议进程，不代表真实商业模型或全部供应商验收；未读取账号凭据或重启常驻服务。
- 临时浏览器、预览/隔离服务及验收脚本已关闭或移除；依据唯一验收工作区ID核验后删除其独立数据库 schema 和临时目录，未删除真实业务数据。

### Provider 运行输出时间线移植（2026-10-28）

- 按 [完整适配计划](docs/implementation/v3-provider-output-plan.zh.md) 接入九类原生 Provider 的统一输出：正文、思考、命令、工具、文件 diff、搜索、计划/待办、子代理、上下文压缩、信息问题、权限拒绝与运行状态。旧历史保持原展示；流式回复支持逐段/整轮，不替换现有 Agent Chat 或引入业务完成规则。
- 输出使用 SQLite 快照与独立 SSE；命令展开才订阅，ANSI/CR、跟随滚动、有限尾部和复制实际输出可用。合法信息问题回到原生回调，重复/过期拒绝；权限审批继续遵循既有拒绝策略。
- 隔离 HTTP smoke 覆盖完成、失败、取消、断线不中止、快照恢复、命令分块、无效回答400与重复回答409。Chromium 实测1440×1000/390×844、深浅主题，运行中命令、工具详情、红绿 diff、提问提交、复制实际stdout、终态接管保留展开、逐段/整轮释放和无横向溢出。
- 工程检查在输出阶段完成：服务端341/341、client-runtime11/11、desktop3/3；最后耗时/展开调整后专项38/38；Agent类型检查和构建通过。全量 PM backend 尝试被其他测试进程持锁拒绝（退出75），未绕过锁，不记作通过。既有字体/Zod/大chunk与并行文件lint提示保留。
- 验证为真实 Hono/SQLite/浏览器加受控原生协议子进程，不是商业模型或真实 PM 授权验收；未重启常驻服务。后续用户追加 Usage 的前后端移植另列 [Usage 计划](docs/implementation/v3-usage-plan.zh.md)，不沿用这些数字冒充新功能通过。

### Usage 前后端移植（2026-10-28）

- 按 [Usage 完整计划](docs/implementation/v3-usage-plan.zh.md) 使用8个 `gpt-6.1-terra:xhigh` 实现包接入原生历史、运行遥测、价格/别名、额度/Hub、API和前端。导航进入 `/agent/usage`，设置位于 `/agent/settings/usage`，保留当前Chat、草稿保护和返回会话状态。
- 已接通八类原生历史来源及九类驱动可实际报告的运行用量；reasoning不重复计入output，缓存分类互斥，原生历史与ledger去重。不完整计数单独保存显示，不伪造分类/费用。ACP无通用历史格式，Muse额度沿用实际运行遥测；无原生支持的手动压缩保持禁用。
- 额度按账号/窗口去重合并，失败保留有效旧窗口，未检查与不支持如实展示；Hub管理密钥不回显，重置credit明确确认。`/usage-limits` 只读现有快照、不运行模型或隐藏刷新。备份秘密排除模式清理Hub密钥和Cursor账号缓存，恢复Hub停用。
- 工程检查：client-runtime11/11、server440/440、desktop3/3、前端Usage行为24/24；后续quota/ledger/backup专项14/14，均无失败或跳过。全量Agent类型检查、服务端构建和最终Web独立构建通过，lint无输出；已解除此前并行菜单记录中的Codex错误类型阻塞。保留既有字体/Zod/大chunk提示。
- 真实Hono/SQLite/原生子进程/浏览器链路：14条history记录去重后6,160,000 tokens；受控价格$21.724并明确1条未定价。真实409保留价格草稿及并行别名，Hub改名保留密钥，取消再确认仅1次consume。partial/canonical原生回报与26,000/200,000上下文实测，完整ledger只增加26,000 tokens。
- 桌面与390×844、深浅主题、模型详情/图表、筛选/快捷键/返回会话均实测。修复长价格URL横向溢出与Usage主题订阅；额度自动检查跨路由5分钟节流实际从重复2次降为1次。未执行商业模型、真实供应商账号或macOS Keychain验收；PM身份/目录与供应商网络响应为受控fixture。全量PM backend此前仍因他人测试持锁退出75，不记作通过；未重启常驻服务、未提交或推送。
- 临时浏览器、自建服务、验收脚本、独立构建产物和临时数据已清理。文档检查通过（101个Markdown、27个计划步骤与领域引用）；源码和隔离验证完成，不代表常驻页面已发布。
