# PM 与 Agent CLI 操作指南

CLI 是现有 PM／Agent 原生服务的操作入口，不是第二套业务系统。PM 命令、模型可调用的 PM 工具和 Agent 操作者管理命令是三个不同范围；拥有其中一种身份不会自动获得另外两种权限。当前仍是可信本机、单操作者工作台，**会话与持久化统一设计尚未收口**。

本文描述源码中的命令合同，不表示当前运行实例已经升级或真实 Provider、邮件、外部客户端、桌面平台已经验收。完整参数以当前 checkout 的 `pnpm run pm --help` 为准，实际可用工具以认证后的 `pnpm run pm plugin tools` 为准。

## 1. 启动方式与 PM 登录

使用项目要求的 Node／pnpm，先完成[安装](getting-started.md)。在仓库根目录运行：

```sh
pnpm run pm --help
export PM_API_URL=http://127.0.0.1:3224
pnpm run pm login --email you@example.com
pnpm run pm workspace list
pnpm run pm plugin workspaces
```

密码在终端隐藏输入，不提供 `--password`。从返回值选择真实工作区，再设置 `PM_WORKSPACE_ID`；不要复制别人的工作区 UUID。账号只能访问一个工作区时可省略，多工作区必须显式选择。

```sh
export PM_WORKSPACE_ID='替换为当前账号授权的工作区 UUID'
pnpm run pm protocol
pnpm run pm task list
pnpm run pm view list
pnpm run pm account me
pnpm run pm logout
```

上面的中文值是必须替换的说明，不是可用业务 ID。默认 PM 地址为 `http://127.0.0.1:4194`；示例显式选择公共入口 3224。远程必须 HTTPS，HTTP 仅允许回环。`pnpm run pm` 后直接传参数，不再加分隔用的 `--`。本仓库锁定 pnpm 11.9.0；直接写 `pnpm pm` 会被 pnpm 自身的内置命令截获，不会执行本仓库脚本。

- 认证优先级：`PM_SESSION_TOKEN` → 完整的 `PM_EMAIL`＋`PM_PASSWORD` → 当前 origin 保存的有限期会话。不要把秘密写进 shell 历史、源码或公共文件。
- `login` 只保存会话，不保存密码。默认私有目录为 `${XDG_CONFIG_HOME:-$HOME/.config}/dovspace/pm-cli`；`PM_CLI_SESSION_DIR` 可指定绝对私有目录。不同 origin 不共享会话；过期重新登录。
- 默认会话目录及其每个祖先必须是当前用户拥有、不可被组或其他用户写入的普通目录。若 `$HOME/.config` 等祖先权限不安全（例如 `0777`），CLI 会以 `CLI_SESSION_UNSAFE` 拒绝读写；不要放宽校验，改用 `mkdir -m 700 "$HOME/.pm-cli-sessions"` 和 `export PM_CLI_SESSION_DIR="$HOME/.pm-cli-sessions"`，或先修正祖先目录权限。`TMPDIR` 下的私有文件输入/输出同样要求安全祖先。
- PM `logout` 需确认服务端撤销成功后才清除本地状态；失败保留凭据以便核对。不读取旧 `access.json`／`PM_ACCESS_FILE`。
- **`pnpm run pm` 会通过现有脚本加载本仓库 `.env`（如果存在）。** 隔离检查使用 `node packages/pm-cli/index.ts ...`，并由调用者提供干净环境、独立 HOME 和临时服务；直接 Node 不等于自动清除了继承的环境变量。

## 2. 读、改、核对原操作

先读取对象和当前版本，再显式写入。以下变量都须取自当前服务的真实返回值：

```sh
pnpm run pm task list --project "$PROJECT_ID"
pnpm run pm file "$TASK_ID"
pnpm run pm context "$TASK_ID"
pnpm run pm task update "$TASK_ID" --title '修改后的标题' --revision "$REVISION"
pnpm run pm task body "$TASK_ID" --file body.md --revision "$REVISION"
pnpm run pm command receipt "$ORIGINAL_COMMAND_UUID"
```

`body` 文件包含原有 `# Title` 及 Markdown 正文，只替换 frontmatter 后的部分；`source` 保存完整 Markdown，仍受身份、字段与关系校验。正文／完整源文件上限为 4 MiB（包含保留的 frontmatter）。冲突不自动重读后覆盖。

创建前保存稳定的原请求键；CLI 在派发前也将创建键打印到 stderr。发生断网、超时或进程中断后，只核对该原键：

```sh
pnpm run pm task create --title '隔离实例中的验收任务' --project "$PROJECT_ID" --idempotency-key "$ORIGINAL_KEY"
pnpm run pm creation-attempt get "$ORIGINAL_KEY" --kind task
pnpm run pm creation-attempt recover "$ORIGINAL_KEY" --kind task
```

`entity create` 对应 `--kind entity`；不能换 kind 探测另一个端点。`not_found`／`pending` 不证明从未执行，不允许因此生成新键重建。`recover` 只沿用该原操作的原生恢复协议。保存响应未知时按 CLI 输出的预期源摘要与 `file` 回读核对；不要盲目重发。

### 输入文件

一般 `--file` 接受至多 5 MiB 的 JSON／YAML 对象，禁止 YAML aliases。**各命令使用自己的原生 schema，不存在通用 HTTP／任意命令透传。** 参数、原始请求 ID、CAS 版本和明确确认值必须保留；不能添加 actor、grant、服务端 cwd 或任意 endpoint。

- 工作区／Dashboard 原生命令通常使用 `{projectId?, targetId?, expectedVersions?, payload}`；命令名由 CLI 动作固定，命令 UUID 通过对应 `--command-id`／`--request-id` 提供。
- Evidence／Submission／Review 等记录命令使用其自己的 `expectedVersions: [{id,version}]` 形状；不能套用其他家族的版本 map。
- `account` 密码／恢复、邀请令牌、Provider 配置／认证、MCP 凭据和自动化 Git 秘密输入使用明确的私有文件合同：绝对路径、本人拥有、安全祖先、私有目录和普通单链接 0600 文件。秘密不得作为 argv 值；含秘密的解析错误也不会回显原文。
- 文件必须使用对应命令的参数名；例如 `account password --private-file ...`，Provider 与自动化 Git 使用受保护的 `--file ...`。不要把公开配置与秘密混放进可提交文件。

## 3. PM 命令范围

表中的名字接在 `pnpm run pm` 后；完整必填参数见 `--help` 和各原生合同。未列出的任意动作不会被转发。

| 范围 | 命令与操作 | 关键边界 |
| --- | --- | --- |
| 核心对象 | `task`／`entity` list、create、update、source、body、archive、restore、delete；`file`、`context`、`protocol` | 项目／任务／文档／周期／里程碑／模块／需求／发布／目标共用 Markdown 核心；状态取当前工作流，不以 CLI 退出码认定 Done |
| 视图与配置 | `view` list/get/query/save；`config` get/set；`migration` list/preview/apply/restore | 既有视图／配置使用 CAS；迁移先预览，再凭原 revision 和明确确认应用／恢复 |
| 评论与个人审阅 | `comment`；`changes`；`notifications`；`audit`；`events` | 编辑／删除／恢复保留原评论版本；看历史不自动确认已阅，通知已读与人工验收独立；事件订阅有限时长，不重放写入 |
| 工作区／账号 | `workspace` list/create/identity 及原创建核对；`account` me/profile/security/password、会话撤销与恢复邮箱／密码恢复 | 创建绑定原 actor；安全动作仅操作者 CLI，秘密文件输入；邮件排队／SMTP 接受不证明收件箱送达 |
| 成员与组织 | `members`、`invitations`、`teams`；`capacity set`、`workload get` | 原生能力、项目范围、最后管理员与版本检查不变；团队不授予项目权限；容量是未完成工作点，不是周工时 |
| 项目菜单／目录 | `project` extras/directory/favorite/order/cover/scope/copy/copy-status/copy-recover；`directories` | 收藏属于个人；封面引用既有不可变成果版本；目录在服务端，初始化／迁移／重绑遵守原身份及停写要求 |
| 外部 Markdown | `sources`、`document` | 来源先登记授权；创建／保存／移动／删除携带原身份与版本；取消关联不删除目录；不能借父来源越过未授权的子项目根 |
| 附件与成果 | `artifact` | 上传上限 8 MiB；下载要求显式新目标，核验不可变版本大小／SHA256，不覆盖既有文件或链接；PM 模型工具不接收任意本机路径 |
| 私人协作 | `notes`、`meetings`、`watch`、`presence` | 私人记录按实际操作者隔离；读取不会心跳；不公开他人的联系人／私人正文 |
| 时间与规划 | `timer`、`worklog`、`portfolio`、`planning`、`sprint-metrics` | 退出 CLI 不停止计时器；汇总、未知值、币种和关键路径沿用原生计算，不把部分数据伪装成全量 |
| 独立交付事实 | `evidence`、`submission`、`review` | UUID 引用真实记录；`review record` 需要操作者明确 `--human-confirm true`，模型工具只有审核读取，没有模型自批工具 |
| PM 决策与路线图 | `conversation`、`intent`、`decision`；`roadmap` read/mapping/drift/save/publish/materialize/inspect | 不是 Agent Chat Session；原发布版本／依赖闭包／映射保留；核对不重建已存在任务 |
| 自动化 | `automation` definitions/definition/create/update/status/remove/run/test/executions/execution/query/logs/receipt；candidate、导入导出、Git 子命令 | 保存不执行；**test 会真实执行并可能有外部副作用**；candidate preview 保留原审计／预览收据，但不修改业务对象；未知结果仅按原键核对 |
| 集成与外发 | `integration`、`event-endpoint`、`webhook`、`im` | 凭据不回显；原操作结果可显式写私有文件；Webhook 未知发送先核对接收端收据，恢复发送是另一个明确动作；IM 链接码只写指定私有文件 |

常用只读检查：

```sh
pnpm run pm members directory
pnpm run pm teams list
pnpm run pm workload get
pnpm run pm project extras
pnpm run pm directories settings
pnpm run pm notes list
pnpm run pm timer read
pnpm run pm portfolio totals
pnpm run pm automation definitions
pnpm run pm webhook status
pnpm run pm im status
```

API 载荷详见[生成 OpenAPI](../contracts/openapi.yaml)、[PM 管理](project-management.md)、[产品路线图](product-roadmap.md)、[自动化](automations.md)和[集成](integrations.md)。命令解析源码在 [packages/pm-cli](../../packages/pm-cli)。列表分页须原样使用服务端返回游标；游标失效时重新读取，不拼接不同授权／快照的页面。

## 4. 模型工具与 Plugin

```sh
pnpm run pm plugin tools
pnpm run pm plugin workspaces
pnpm run pm plugin call --file "$ORIGINAL_REQUEST_FILE"
pnpm run pm plugin result --file "$ORIGINAL_REQUEST_FILE"
```

请求外形是 `{operationId, name, target:{workspaceId,projectId}, arguments}`；工具名／参数来自实际目录，`projectId:null` 表示明确工作区目标，不表示绕过项目授权。原请求文件可能含私人业务文本，必须保护；不能放凭据、操作者声明或伪造 Chat 关联字段。

同一 origin＋operationId 首次派发前写入私有操作记录；重复 `call`、并发或进程重启只查 `/result`。不要删除记录或换 profile 绕过未知状态。历史成功与当前可见性分离：撤权、源对象移动／删除或读取不可用时，可以保留原成功事实同时拒绝展示旧正文。

只有原生服务能证明派发前拒绝，或已取得原命令的持久拒绝证据时，才把该操作标为 `failed`；已有 pending 原命令、断流或普通 HTTP 错误仍可能是 `unknown`。不要根据权限变化推断较早的写入没有发生。

**`plugin call/result` 退出 0 只代表传输／投影处理完成，不代表业务成功。** 自动化脚本必须检查结构化成功条件：

```sh
umask 077
pnpm run pm plugin result --file "$ORIGINAL_REQUEST_FILE" > "$PRIVATE_RESULT_FILE" &&
  pnpm run pm plugin check --file "$PRIVATE_RESULT_FILE" &&
  your-next-command
```

只有 `visibility=visible`、`status=succeeded`、`result` 存在且 `error=null` 才能继续；unknown、running、pending_approval、failed、redacted、unavailable 都必须停止。`check` 只在本地校验结果，不发送业务请求。`PRIVATE_RESULT_FILE` 必须指向私有目录中的结果文件；`your-next-command` 替换为已授权的后续动作。

工具目录由同一注册表生成，涵盖核心、协作、管理、文档／成果、Dashboard、规划记录、自动化及集成的明确动作；缺失后端家族会标为不可用。账号秘密、Agent 主机管理、真实文件路径、Provider 凭据和人工审核批准不因此开放给 PM 模型工具。管理员工具仍受实际原生管理能力与非受限成员要求约束。

Plugin 分发／更新／卸载与 Codex、Claude、Pi、OpenCode 的真实加载步骤见 [dovspace-pm README](../../plugins/dovspace-pm/README.md)。分发能力快照不是授权，也不证明 OAuth／真实客户端闭环；卸载包、移除客户端注册和撤销服务端授权是三个动作。

## 5. Agent 本机连接与可选令牌登录

当前面向可信本机、单用户使用。显式选择本实例地址；当目标是回环地址且服务端 `/api/access` 确认 `configured:false`、`authorized:true` 时，**直接运行 Agent 命令，无需令牌或 `agent login`**：

```sh
export PM_AGENT_URL=http://127.0.0.1:3224/agent
pnpm run pm agent status
pnpm run pm agent folder list
pnpm run pm agent session list
```

此时状态为 `identity: "local_unprotected"`、`credentialSource: "none"`，没有 Cookie、身份文件或虚构的到期时间；不会读取旧 Agent 凭据或自动导入 PM／Provider 身份。`logout` 只能关闭本地连接／清除已有本地凭据，不能关闭服务端允许的本机直接访问。

**PM 登录与工作区／项目权限仍然有效。** 普通 Agent-only 操作不要求 PM 登录；涉及 PM 业务的操作仍须提供当前合法 PM 身份。本机直连不是多用户隔离，也不是已经完成的“PM 登录统一 Agent 身份”；会话／持久化统一设计仍未收口。不要将未配置保护的 Agent 开放到公网。

若该实例已经配置 `AGENT_WORKSPACE_ACCESS_TOKEN`，或目标不是回环地址，CLI 不走无令牌模式。已配置的服务继续使用操作者明确取得的现行令牌：

```sh
pnpm run pm agent login --token-file "$PRIVATE_AGENT_TOKEN_FILE"
pnpm run pm agent status
pnpm run pm agent logout
```

也可显式使用 `--token-stdin true` 管道输入，不能与 `--token-file` 同时使用；不把令牌放在命令参数中。直接 Agent 地址是 `http://127.0.0.1:4325`，它和网关 `/agent` 使用不同连接记录。未设置地址时不会猜测实例；远程必须 HTTPS 且配置访问保护，不能匿名回退。服务异常、无效短令牌、拒绝或重定向也不能推断为“未配置”。

令牌登录后的本地会话有效期为 8 小时，**不是服务端 Cookie 到期保证**。`agent logout` 返回 `serverRevoked:false`；现行服务端需要轮换访问令牌才能使旧副本失效。CLI 不创建服务端令牌，不自动修改认证配置或 `approvalMode`，不从 PM 密码、浏览器或全局 Provider Home 推导凭据。

## 6. Agent 管理与运行

| 范围 | `pnpm run pm agent ...` | 关键边界 |
| --- | --- | --- |
| 目录／会话 | `folder` list/directories/register/rename/close/reopen；`session` list/read/create/update/rename/archive/restore/delete、侧栏动作、history/execution/actions | 注册服务端绝对目录；settings、sidebar 与 lifecycle revision 分开；归档／恢复／删除携带当前生命周期 CAS，删除须明确确认、原操作 ID 及精确 generation，保留业务／未决证据；关闭文件夹不删除代码 |
| 消息／上下文 | `message` list/save/context/resolve-references/send、queue/stash 操作、fork/native-fork/rewind | 使用原消息／generation／幂等身份和保存的 threadSettingsRevision；未知发送不重放；引用范围仍由 PM 校验 |
| 生成／审批 | `generation` list/status/lifecycle/output/command-output/stream/stop/continue/steer/respond；`approval` | `lifecycle` 精确选择原 generation，仅返回身份／状态／时间；list/status 保留显式内容检查与当前 PM 授权。停止核对同一轻量生命周期及原输入身份，不回退到最新 generation；输出跟随断线／SIGINT 只离开订阅 |
| Provider／模型 | `provider`、`models`、`settings chat-defaults` | 实例 CRUD、驱动能力、认证 flow、维护／profile、模型与偏好使用原生 API；`--consent native-probe` 明确接受状态探测，ACP npx/uvx 探测可能准备／下载包 |
| Usage／诊断 | `usage`、`diagnostics`、`quota` | 费用估算不是订阅账单；未知额度不猜测；reset credit／quota recovery 需单独确认，启用恢复可能继续原 generation；报告显式写私有文件 |
| 扩展 | `extensions`、`mcp`、`skills`、`apps`、`grants` | 明确 context／绑定；安装不等于原生加载／调用；Apps 需要产生它的现行 live capability；授权列表／撤销只需 PM 身份，不用 Agent cookie 冒充 |
| 文件／Git | `files` list/read/search/media；`git` status/diff | 绑定实际 Session，拒绝路径逃逸；Git 投影不执行 clean/process filter，读取目标实际选中可执行过滤器时拒绝，未使用的全局过滤器不阻止普通读取；不是通用 Git 写入口 |
| Terminal | `terminal` list/create/get/attach/input/resize/close | 真实服务端 PTY，持有服务进程权限，不是沙箱；保存 terminalId＋serviceId＋原 requestId，服务重启不恢复旧 PTY／不重跑命令 |
| Browser | `browser` status/list/create/state/navigate/capture 等有限动作 | 仅匹配的、已就绪的本地 Electron 实例；显式私有 `--desktop-file`，无 headless／远程退路；退出／断开／服务失效立即撤销桥权限 |
| 交付／工作流／预览 | `delivery`、`workflow`、`preview` | 需要 Agent 服务访问及独立 PM 身份；本机未配置令牌时无需额外 Agent 登录；原 worktree／需求版本／commit／CI 事实独立，发布动作逐项明确确认；有限节点图不是通用 Runner |
| Evaluation 元数据 | `evaluation` status/configure/pause/revoke/export/delete/retention/window-create/window/decision/decisions | 默认 OFF、明确 Session 范围与保留期限；原子导出当前可见的分母／样本／fence，不采集正文，不自行训练、部署或回退 |

示例只读命令：

```sh
pnpm run pm agent session read "$SESSION_ID"
pnpm run pm agent session execution "$SESSION_ID"
pnpm run pm agent message list "$SESSION_ID" --limit 20
pnpm run pm agent generation lifecycle "$SESSION_ID" --generation "$GENERATION_ID"
pnpm run pm agent generation output "$GENERATION_ID"
pnpm run pm agent files list --session "$SESSION_ID"
pnpm run pm agent git status --session "$SESSION_ID"
pnpm run pm agent diagnostics storage
pnpm run pm agent extensions targets
pnpm run pm agent grants list
```

会访问 PM 上下文的消息／历史／输出命令须显式 `--pm-context true`；扩展／Apps 使用自己的 `--pm-session true`。普通 Agent-only 操作不会自动读取 PM 凭据。Delivery／Workflow／Preview 需要 Agent 服务访问及当前 PM 登录，地址使用同一公共 origin 的 PM 与 `/agent`，或明确的 literal loopback 配对；本机免 Agent 登录不授予 PM 权限，也不向任意第三方 Agent 转发 PM 身份。
发送结果不明时使用原 Session／submission ID 查询受理事实，不能换键或凭空列表重发。accepted 指向实际 generation；not_accepted 须有当前 Store／恢复 epoch 的明确拒绝证据；缺少完整原始映射仍为 unknown。Session 删除是可见生命周期操作，不是物理抹除全部字节或撤销 PM／文件副作用。

自动轮询或核对停止结果使用 `generation lifecycle SESSION_ID --generation ORIGINAL_GENERATION_ID`，服务端只读取该 Session 中的原 generation，返回 `id`、`threadId`、`messageId`、可用时的 `inputMessageId`、`status`、`createdAt` 和可用时的 `endedAt`；不包含 Prompt、输出、错误正文、PM 引用或上下文，也不读取历史 PM 工具结果。该路径仍需当前 Agent 访问，不要求 PM 登录。CLI `generation stop` 的派发前／后核对沿用此路径；提供 `--message` 时，CLI 先核对原输入，不匹配则不派发停止请求。服务端原有精确 generation 守卫继续防止陈旧请求取消替代轮次。

`generation list|status` 是原有内容检查合同，仍按当前 PM 权限及来源版本投影；需要 PM 时明确附加 `--pm-context true`。生命周期成功不证明旧内容仍可读、PM 操作成功或任务完成，不能以轻量结果替代撤权／失效内容检查，也不能忽略原生冲突（409）。

本次不改变 Web 或公共取消 API 的消息身份语义：现行公共请求同时携带 generation 与 message 时，原生取消仍以精确 generation 为准，并未新增服务端 generation／输入消息配对校验。原输入身份检查属于 CLI／控制器的明确核对，不能据此宣称公共取消 API 的输入身份合同已统一。

业务 Run、Agents、Teams 和 Inbox 当前使用[运行面板与独立配置界面](agent-chat.md#统一运行面板)及其专用 HTTP 合同；本表的 `session`／`generation` 不冒充新增业务 Run CLI。


Provider 配置文件必须私有；认证 URL、设备码／终端交互通过明确的 `--interaction-file` 保存，不打印到 stdout，不自动打开浏览器。原生 Home、账号、安装维护与支持的驱动能力见 [Agent 指南](agent-chat.md)。不能把检查通过当成真实模型／额度可用。

PTY 使用 `Ctrl+]` 分离，`Ctrl+C` 发给 PTY；操作系统信号只断开。`--close-on-exit true` 是明确关闭选择，默认不因离开终端而销毁服务器会话。Browser 的 `browser-cli.json` 由当前本地桌面提供，不手工伪造或复用旧实例文件。

代码交付先读取 task brief、需求 revision 与当前代码指纹，再明确选择 Provider／模型；`commit`、`push`、`draft-pr` 逐步确认当前结果。工作流只执行现有有限节点与不可变已发布版本；预览只通过现有 Linux namespace 协议运行已提交的 `app/server.mjs`，隔离不可用即拒绝。详见[代码交付](task-code-delivery.md)、[工作流](task-workflows.md)和[App 预览](app-preview.md)。

### Evaluation 观察与反馈

所有命令支持显式 `--origin` 和 `--pm-context true|false`。涉及 PM 绑定 Session 时用 `--pm-context true`，沿用当前服务 origin 的有限凭据转发；并不将 Agent token 变成 PM 身份。

| 命令 | 输入与结果 |
| --- | --- |
| `evaluation status` | 读取部署身份、策略与收集器状态；不启用采样 |
| `evaluation configure --file POLICY.json` | 原生策略合同：当前 revision、明确 Session、用途、时间范围、概率、保留期限及 metadata-only 确认 |
| `evaluation pause --file ACTION.json` / `revoke --file ACTION.json` | `policyId` 与 `expectedRevision`；暂停阻止新采集，撤销还传播来源失效 |
| `evaluation export` | 当前权限下的 metadata-only 导出，含完整分母、所选观察和删除／恢复 fence；不是聊天导出 |
| `evaluation delete --file DELETE.json` | `observationIds` 与 `reason`（`deleted`／`revoked`）；不删除 PM 业务事实 |
| `evaluation retention` | 应用现行保留期限并产生失效记录，不缩小旧窗口分母 |
| `evaluation window-create --file WINDOW.json` | 预登记精确发布身份、baseline／candidate 时间与 cohorts、门槛及发布决策摘要 |
| `evaluation window WINDOW_UUID` | 读取当前窗口回顾及内容摘要；缺口为 unknown，不冒充质量或显著性结论 |
| `evaluation decision --file DECISION.json` / `decisions` | 记录或读取带当前证据摘要的人工观察决定；回退／暂停派发仅为建议，不执行部署 |

策略、数据边界及恢复语义见 [Agent 指南](agent-chat.md#evaluation-元数据观察与发布后回顾)。输入使用 [严格合同](../../packages/agent-contracts/src/evaluation-feedback.ts)，不接受任意 endpoint 或脚本。终端导出仍应保存到受控私有位置；元数据不等于可公开数据。离线 `bench evaluation …` 是独立 Benchmark 运维入口，不是 `pm agent evaluation` 的别名。

## 7. 运维与验收边界

运维继续复用既有 `doctor`、services、数据库迁移、备份／恢复、outbox 和来源维护入口，不把任意宿主命令塞进 PM 工具：见[开发指南](development.md)与[部署手册](../../deploy/README.md)。迁移、停机、恢复信任、发布、外发和真实模型调用仍需各自授权。

下列是仓库根目录的独立运维入口，不接在 `pnpm run pm` 后；不会因为 PM 登录成功就获得本机维护权限。需要私有环境的脚本只使用明确配置的本实例，禁止复制其他副本的数据库或凭据。

| 入口 | 操作身份与前提 |
| --- | --- |
| `pnpm doctor` | 仅检查本机工具链，不连接业务服务、不证明 Provider 就绪 |
| `pnpm services:status`／`services:start`／`services:stop` | 本机操作者；先核对本实例 PID、cwd、端口与模式。start/stop 改变服务生命周期 |
| `pnpm bootstrap` | 私有 `.env` 与本实例数据库；仅准备首次设置令牌，旧实例不重置账号 |
| `pnpm db:migrate` | 显式数据库维护身份；按部署手册停写、备份和升级，不作为普通成员命令 |
| `pnpm account:create --email EMAIL --name NAME` | 本机管理员明确授权；私有账号输出文件不得公开，创建不自动授予工作区权限 |
| `pnpm storage …`／`pnpm storage:projects …` | 私有数据库／存储维护配置；绑定、迁移、恢复须停 API、Worker 和外部写者；保留原 operationId，不能当作在线重试 |
| `pnpm backup --stopped`／`pnpm backup:verify --stopped` | 先停本实例写者；verify 使用独立目标验证，不覆盖源库／目录；S3 必须验证真实 provider 字节 |
| `pnpm agent:backup create\|restore\|verify … --stopped` | 先停已核验的 Agent；明确 source/bundle/target 和 secrets include/exclude；v2 校验关系与源屏障，恢复分配新 Store／epoch 并围住旧线程执行；不复制全局 CLI Home，不恢复到非空目标 |
| `node --conditions=development scripts/agent-persistence.ts … --stopped --isolated-copy` | 所有模式均要求真实停写隔离副本；明确源目录，先导出／盘点再按审阅清单 apply；标志不代表生产授权，rollback 只接受尚未新增写入的原清单 |
| `node --conditions=development scripts/verify-recovery-set.ts --directory ABS_SET --stopped` | 核对同一停写恢复集的组件身份、字节与关系；报告的 `sqlExecutionVerified:false` 不能冒充已实际还原 PostgreSQL，真实还原另由备份 verify／桌面往返完成 |
| `pnpm integrations:migrate … --stopped` | 显式维护环境；配对 SQL dump 与 Agent 私有备份，先 dry-run，再按已审阅计划摘要 apply/reconcile/finalize |
| `pnpm outbox:failed --workspace UUID`／`pnpm outbox:retry --workspace UUID` | `.env` 的维护数据库身份；先修故障再显式恢复原事件，不改业务实体／收据 |
| `pnpm notifications:status --workspace UUID`／`pnpm notifications:retry …` | `.env.worker` 的通知维护身份；读取实际水位，修复失败后处理原序列，不伪造漏失历史 |
| `node --env-file=.env.worker scripts/im-delivery-admin.ts status`／`… retry DELIVERY_ID` | 现有 IM 投递维护脚本；先查原投递，未知外发先核对。根目录没有 `im:delivery` pnpm alias |

准确参数与恢复顺序仍以[部署手册](../../deploy/README.md)、[集成指南](integrations.md)及对应脚本帮助为准。以上是入口与权限说明，不表示本轮对生产执行了备份、恢复、迁移或外发。

验证须分别记录源码／合同、真实隔离数据库和文件、CLI 进程、Agent 控制协议、Web、目标桌面平台、外部账号／邮件／Webhook／MCP，以及公共入口部署。单元测试、受控 Provider、健康 200、生成退出 0、CLI 帮助或插件可加载均不能互相替代，更不能证明任务完成。未知副作用先查询原操作；完整验证要求见[测试说明](../../tests/README.md)。
