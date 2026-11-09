# Agent Chat、Provider、MCP 与数据

本页描述当前源码的使用方式和已知限制，不代表当前工作树已通过检查、真实供应商账号验收或生产部署。历史计划和本机验收原件保留在本地，不作为公开安装依赖。

左上产品切换进入 `/agent/workspace`，PM 仍为默认产品入口。Agent 侧栏按“文件夹 → Sessions”组织：点击“打开文件夹”，浏览或输入 Agent 服务器上已有目录的绝对路径，再点击该文件夹下的“会话”。一个 Agent Workspace 对应一个规范化目录，不绑定 PM 工作区或项目；同名目录以完整路径区分。也可新建“仅对话”会话。首次执行受理后目录绑定冻结，改换执行环境须新建 Session。顶部显示当前 Session 的文件夹、Local、实际执行路径及收据证明的 Worktree；点击目录标签可展开来源路径与执行路径。

PM 产品切换先显示 Agent 模块加载状态，支持取消、失败重试和重新加载；保留整页导航与未保存草稿确认，不自动重发消息。Agent 设置页限制在视口内，导航与正文分别滚动，切换设置页回到正文顶部。

Provider 在 `/agent/settings/providers` 配置，原生 Home 留空时沿用服务端 CLI 环境和账号；受管 ChatGPT 使用应用私有账号状态。旧 Provider 选择不会自动替换模型；离页保留草稿保护，不自动取消后台生成。主题直接复用 PM 偏好存储，首次切换、刷新和双产品导航保持一致。目录不是权限或文件系统沙箱。

文件夹支持重命名显示名称、关闭和重新打开；关闭只隐藏列表，不删除代码或 Sessions，也不改变已绑定目录身份。会话行支持右键或省略号菜单：Pin、Settle、Snooze、重命名、隔离生成标题、未读、文件夹筛选、Auto-settle、复制、选择文件夹、Archive 与 Delete。各文件夹内按“置顶 / 活跃 / 稍后提醒 / 已归置”组织，每行显示目录、时间、标题及 Provider；侧栏导航不改绑当前会话。归置不是归档，更不代表 PM 工作完成。状态由服务端持久化并用独立 revision 防止覆盖；自动归置为默认 3 天无活动，不在运行成功时立即执行。归档可从 `/agent/settings/history` 恢复，运行中不能归档；删除沿用现有停止生成后再明确确认的流程，且不可恢复。标题重生成仅对具备隔离无工具调用能力的 Codex / Claude 开放，不修改原消息或原生会话游标。

主页保留自动化独立导航行、设置／用量／快捷键工具栏，以及顶栏面包屑和面板开关。右侧 Files / Git 复用单标签，Browser 可以新增多个标签；Terminal 是同一组服务端终端的单一视图，可在右侧和底部停靠，不另建第二套进程。Files surface 采用 t3code 的文件展示布局：可切换的项目文件树、文件类型图标、全项目文件搜索、目录展开／折叠、面包屑与语法高亮只读源码，Markdown 可切换渲染、源码可自动换行；二进制文件继续明确拒绝，不新增写入能力。右侧面板标签支持关闭、排序、最大化和窄屏抽屉；底部终端抽屉与右侧终端只显示终端内容，并以一条横线与上方内容分隔，不显示范围、实例、状态或操作按钮。隐藏或切换停靠只断开视图，不重启服务端 PTY。底部高度可调整，`Ctrl / ⌘ + J` 切换显示。

Browser surface 使用单行浏览器工具栏：后退／前进／刷新、地址栏、元素选择／截图／浮层／菜单；地址栏按 Enter 打开 URL，非 URL 文本在新标签页搜索。跨域页面以 iframe 打开；同源地址不在沙箱中预览，改为引导至新标签页。最近使用记录只存在本机浏览器 localStorage（最多 12 条），可删除或清空；跨域 iframe 明确禁用元素选择、截图和浮层。v4 公共入口是 `3224`，v3 的 `3223` 不共享登录或数据。内嵌页保留展开、关闭和返回 PM 上下文。

#### 桌面端原生 Browser

桌面版（Electron）的 Browser surface 使用受控 `<webview>` 而不是 iframe。工作区窗口新增最小 `desktopWorkspace.preview` preload；主进程 `PreviewManager` 为每个 Browser tab 维护独立 preview session、导航状态、标题、favicon、截图、元素选择和 PiP。地址栏、前进/后退、标题和加载状态由主进程的 `did-navigate` / `page-title-updated` / `page-favicon-updated` / `did-start-loading` 事件同步，Browser 标签标题跟随页面标题；元素选择和截图会作为图片附件加入 Composer，浮动预览是只读帧流。桌面端可以安全预览同源或跨域地址，因为 guest 使用独立 partition，不共享工作区 cookie。

原生预览只对**本地工作区**启用：工作区窗口以 `--pm-native-preview` 启动参数决定是否暴露 preload bridge；远程工作区不注入 bridge，继续使用 iframe fallback，避免远程页面驱动本机网络访问。

安全边界：连接窗口仍禁用 webview；只有工作区窗口启用 `webviewTag`，`will-attach-webview` 校验 partition、http(s) URL 和预置 preload，并强制 `sandbox:true`、`nodeIntegration:false`、`webviewTag:false`。preview session 只允许 http(s)/data/blob/ws，权限只允许剪贴板写入和全屏；IPC 只接受工作区主 frame 且必须是当前工作区 origin。纯 Web（`3224`）没有这些原生能力，继续使用 iframe fallback，元素选择/截图/浮动预览按钮会显示“仅桌面版可用”。服务端无头浏览器流尚未接入。

新会话及成功读取的空历史显示当前文件夹名称和居中输入框，纯对话不伪造 PM 项目名；已有消息时输入框停靠底部。Composer 左侧排列模型、原生能力选项和交互模式，右侧放任务引用、附件、可选听写及发送/停止；引用芯片仅在存在引用时占行。历史读取失败明确阻止发送并提供“刷新重试”，不冒充空会话；刷新仍遵循现有文字草稿恢复和附件/引用丢失提醒，不新增持久化协议。

当前只面向本机单操作者适配；尚未按 PM 成员建立 Agent 会话所有权隔离。不要将目录绑定视作多用户授权或文件沙箱，也不要据此开放公网使用。本次不新增权限体系；PM 工具继续逐次核验原有身份、成员能力与业务边界。

PM 中“Agent 助手”是文字与向下箭头合并的圆角下拉按钮：点击后先显示当前项目已配置的快捷自动化，菜单最下方“前往 Agent Chat”进入独立 Chat，并保留返回 PM 地址和明确的业务引用入口，不把 PM 范围设为 Session 所有者或代码目录。菜单也提供自动化管理页与运行历史。配置方法、确认规则与原请求核对见[PM Agent 助手快捷执行](automations.md#pm-agent-助手快捷执行)。快捷执行不自动发送 Chat 消息，也不以 Run 成功完成业务任务。

#### PM 文档、代码目录与终端

- **PM 文档**继续由 PM 管理。Agent 通过带明确工作区／项目目标的工具和引用读取 PM 资料；不把 PM 文档存储自动挂载为代码区。一个 Git 只管理一个独立文件夹，Git 面板不会借用父目录仓库。
- **打开文件夹**只登记服务器上的已有目录，不上传浏览器文件、不创建目录、不复制仓库。允许范围由 Agent 角色的 `AGENT_WORKSPACE_ALLOWED_ROOTS` 配置为绝对路径 JSON 数组，未设置时使用服务用户 Home。目录记录保存在 Agent SQLite，规范路径与设备/inode 身份不可改写；缺失、替换、越界或符号链接改指时拒绝，不自动重建或回退。原 Code Workspace 登记页及其 PM API 已退役。
- **选择文件夹：** 本地桌面工作区提供原生“选择文件夹”按钮；Web／远程工作区浏览的是服务器目录，并显示当前允许根。桌面 Agent 显式允许当前用户 Home、应用受管项目目录及配置的项目父目录；更改桌面配置后需重新连接。选择器不绕过服务端规范路径和目录身份核验，其他目录仍须由操作者明确配置允许根。
- **Session 环境**使用 v2 `agentWorkspaceId + agentWorkspaceRevision`，不再保存 PM 归属、代码组合或 `rootIds`。重命名、关闭、重新打开只增加元数据 revision，不使原 Session 改绑或失效；未来版本仍拒绝。Files / Git 按 Session 与相对路径读取同一实际执行目录；受控交付指向收据拥有的 Worktree，原生仓库模板显示实际仓库副本路径而不冒充 Worktree。
- **多个仓库**分别打开为不同的 Agent Workspaces，各自创建 Sessions；不存在把多个根拼成一个 Code Workspace 的运行层。普通代码会话、文件检查、Git、终端和原生 Skills 目录解析不依赖 PM 登录或 PM 服务可用。
- **纯对话**不要求代码仓库。服务端在 Agent 私有数据目录的 `chat-scratch` 下按 Session 分配 scratch 并保存目录身份；Files / Git / Terminal 不把它展示为代码环境。已登记 scratch 丢失或身份改变时拒绝重建；PM 文件区域与保存根配置不是执行回退。
- scratch 仅在新建时设置平台私有权限；复用时只核验，不自动收紧或接管已有目录。Unix 核对所有者与私有 mode，Windows 核对原生 ACL、目录身份及 reparse 属性，不将 POSIX mode 当作 Windows 权限证明。遇到身份或权限错误应核对原目录，不通过删除登记或重建目录绕过。

| 终端 | 起始目录与切换行为 |
| --- | --- |
| Workspace Terminal | 显式选择的 Agent 文件夹／子目录；跨 Session 保留，隐藏与停靠切换只重附着 |
| Session Terminal | 当前 Session 的实际目录／Worktree；切换 Session 时切走原 Session 终端 |

文件夹菜单可以从该目录打开终端；终端内 `cd` 不改变 Agent 主目录。服务端在本次进程生命周期内拥有 PTY，校验目录身份和 Session 执行身份，保留有界输出用于重附着。创建请求有稳定 ID，未知输入不重放；当前终端视图不提供范围、实例、终止或重新附加控件。**不支持跨 Agent 服务重启存活**：旧终端不可用，不恢复进程、不重放命令，用户须明确创建新终端。

Inspector 请求携带当前 Session，不接受浏览器任意 cwd 或旧 `rootId`。Terminal 使用服务进程的本机 shell 权限，不是文件沙箱；它与 Provider 共用原生环境过滤规则，保留正常 CLI 环境，但不继承服务端 PM 凭据、Agent 私有控制变量或加载器注入变量。`Ctrl / ⌘ + Alt + B` 切换右侧面板；网页预览继续保留 iframe sandbox。


若已打开的页面在更新后点击面板出现“页面暂时不可用”，还需检查动态模块请求，而不是重发消息。本机 Web 重建现在保留旧哈希资源，避免已打开页面依赖的模块被删除；历史资源只在停机维护时清理，见[部署手册](../../deploy/README.md)。修复前已经缺失的模块仍需手动重新加载一次页面；不会自动提交、重试消息或取消后台生成。

#### Chat 设置

统一入口为 `/agent/settings/general`；设置页共用导航和未保存 / 保存中离页保护。服务配置适用于本机 Agent 的全部目录与 Sessions，不是新增的 PM 权限或项目级 Provider 覆盖。

设置布局参考 t3code 的“全宽外壳与独立正文宽度”分层：PM 设置导航贴齐主工作区左侧内边距，不再与正文一起限制在 1440px 居中容器；Agent 设置侧栏保持贴左，正文紧随侧栏左对齐。两者正文最大宽度为 1160px，避免超宽表单；窄屏保留 PM 页面选择器，Agent 导航可展开收起，不按 2560×1440 固定比例缩放。布局调整不改变保存、权限或会话持久化。

| 页面 / 入口 | 实际配置与边界 |
| --- | --- |
| 通用 | 持久保存新会话默认 Provider / 模型、模型能力选项和交互模式；仅创建时快照，不改写历史会话。可明确不设置默认值；失效选择不自动替换，发送前必须显式选择有效模型 |
| 提供商 | 按 t3code 原生驱动定义配置、启停、认证与显式维护运行环境；内置、实际发现和显式登记的自定义模型共用执行校验。安装 / 版本、实际认证及最近状态检查分开展示；健康刷新间隔默认300秒，0关闭；revision 变更使旧检查失效，模型目录不代表付费推理成功 |
| 输入框模型选择器 | 沿用 t3code 的紧凑触发器、提供商侧栏、跨提供商搜索、收藏与键盘操作；隐藏、排序、收藏和模型默认选项按实例保存于本机 Agent 服务，设置页与各浏览器共享。直接保存当前会话，不更改新会话默认值；失效选择不自动替换 |
| 当前会话参数 | 模型右侧直接显示当前思考程度（如 Extra High = `xhigh`）；点击后按 t3code 的分组单选菜单选择原生声明的档位和其他 select / boolean 能力，保存成功后关闭；default / plan 由相邻独立按钮切换。共用当前会话原子保存和 revision 检查，不改新会话默认值；失败保留修改并提供重试、阻止发送，不凭空生成 reasoning 档位。system prompt 与支持的 temperature 仍由会话参数编辑 |
| 输入与快捷键 | Enter 或 Ctrl/Cmd+Enter 发送，保留 IME 组合输入；Ctrl/Cmd+Shift+O 新会话、Ctrl/Cmd+K 搜索、Ctrl/Cmd+. 停止、`?` 帮助。输入和弹窗不触发全局快捷键；停止需服务端确认 |
| 外观 | 主题 / 跟随系统、减少动态效果、侧栏密度复用 PM 浏览器偏好；Agent 正文字号、内容宽度、代码换行仅影响阅读，不改写消息 |
| 文件夹入口 | 位于 Chat 侧栏“打开文件夹”，不再提供 Code Workspace／文件区域登记设置页；目录允许范围由服务端配置 |
| 历史与归档 | 归档保留原 Session 的目录选择与历史，不按 PM 项目归属恢复；运行中不可归档，永久删除需明确确认 |

当前会话参数保存会先采用客户端已接受的较新会话 revision，例如刚完成文件夹选择后的返回快照。尚未观察到的真实并发修改仍返回冲突；失败保留本地草稿并阻止发送，用户明确点击保存／重试时重新读取当前 revision 再提交，不自动重放失败写入或修改全局默认值。

Provider 集合为 Codex、Claude、Cursor、Grok、FX、OpenCode、Antigravity、Muse Code、Pi、OMP（Oh My Pi）、ACP Registry。初始化仍只持久创建 Codex / Claude；其他默认位仅在已配置、有效启用或定向访问时显示，浏览页面不创建实例。FX 位于“显示更多”，ACP Registry 为独立搜索 / 准备入口；Registry 先显式准备，再填写身份并按协议认证，local 命令走较短路径。实例 ID 固定、字母开头、最多64字符，显示名称可清空回退驱动名；默认实例可重置，额外实例可删除。普通字段失焦或 Enter 保存，环境变量和模型显式保存。非敏感环境变量可回显编辑，敏感值遮蔽且空值回传保留；旧环境变量默认按敏感值迁移。模型段统一管理隐藏、排序、收藏、自定义能力选项；Antigravity 不开放自定义模型。独立 OpenAI / Anthropic / DeepSeek API 卡片及新执行入口不恢复，原始历史和私有凭据不删除。

新安装的 Codex／Claude 是**未启用的配置入口**，不是已经连接的账号；查看卡片也不选择会话模型。需显式启用、检查并选择模型，已有实例的启用状态与模型偏好不会被重置。显式重置默认实例也恢复为未启用。

适配以 `t3code@30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c` 为配置与协议基准；MIT 归属见 [LICENSE.t3code](../../LICENSE.t3code)。Codex 通过“使用现有 CLI”与“继续使用 ChatGPT”进入对应流程，不再展示模式下拉框。existing 复用原生配置 / 外部认证，可使用 API Key 或第三方服务，不强制 ChatGPT 登录；managed 使用受管运行时、ChatGPT 多账号 OAuth / token broker，私有状态保留在本副本 `provider-homes`。Claude 的四种 idle compaction 模式接入实际宿主调度并重新核验执行身份；业务来源仍受原授权上限约束。Cursor 的 `CURSOR_API_KEY` 位于专属 Setup，填写密钥后隐藏浏览器登录，清除并保存后恢复该入口。Grok / FX / Muse / Pi / OMP 与 existing Codex / Claude / OpenCode 遵循来源的外部认证边界，不另造应用内登录 / 登出。

**CLI 与 SDK 的交付边界：** Claude 使用服务机器／桌面用户已安装的 `claude`，也可在 Runtime binary 填写其实际路径；未安装、不可执行或路径错误时明确失败，不回退到 SDK 自带 CLI。安装包保留 Claude 通信 SDK、manifest 与许可证，但排除 `@anthropic-ai/claude-agent-sdk-*` 平台执行包。Muse 同样通过用户的 `muse serve` 通信。Cursor 当前使用本地 Agent SDK 引擎，并不是用户 Cursor CLI 的包装器；其 SDK、SQLite、搜索／sandbox／tree-sitter 等必要资源仍保留，旧 `binaryPath` / `apiEndpoint` 字段不控制当前执行，不能把它宣传为已完成外部 CLI 适配。

这不移除现有明确选择的安装流程：Codex managed、Antigravity managed 和 ACP Registry 各有原生准备／安装语义。ACP 的 npx / uvx 状态探测还可能解析并准备 Registry 包，不能概括成所有 Provider 的检查都绝不下载；该行为与桌面安装包预捆绑外部 CLI 不同，本次未重做 ACP 安装流程。

桌面随包 Node 仅用于运行应用，不包含 npm/npx。ACP 的 npx 分发路径需要有效 Provider 环境 PATH 中另行安装的 npm；缺失时检查返回缺少 runner，准备操作明确失败，不自动补装工具链。此边界不改变操作者配置的原生 CLI Home、环境覆盖或已明确触发的 Provider 安装流程。

安装、更新、取消与移除仅对实际支持的驱动开放；“继续使用 ChatGPT”先准备运行时，再发起登录，Codex 的只读检查或发送消息不会自动下载。维护与认证 / 执行互斥。原生 Home 留空时继承宿主规则，显式 Home 和实例环境覆盖对应配置，不重写进程 HOME / XDG，也不清除宿主 Provider 凭据。应用自有状态与原生 Home 分离，重置、删除和备份不收集、创建或删除外部 Home。PM 作用域、审批与完成规则不变。

Codex 执行仍要求本次原生操作确认同一个 Home。Windows 路径命名空间、分隔符或真实目录别名不再仅因字符串不同被拒绝，但必须由当前文件系统的规范路径／目录身份证明一致；不同、缺失或无法核验的 Home 仍拒绝执行，重连不会跳过证明。

当前配置流程、实际执行及发布记录见 [t3code Provider 原生流程切换](../reference/t3code-provider-config-diff-30eb7e7bb1.zh.md#v4-native-provider-flow)。原调查和前两轮实施保留为历史记录；旧的强制独立 Home 与配置文件教程已被替换。


##### 配置并使用 Provider

1. 在“提供商”选择已有实例，或“添加提供商”。Codex 选择“使用现有 CLI”复用服务所在机器的原生配置；只有选择“继续使用 ChatGPT”才走受管账号连接。
2. 原生 CLI 已可用时，无需填写 Home 或重复登录。需要覆盖时，使用驱动提供的 Runtime、Launch arguments 和 Environment；实例变量覆盖同名宿主变量，敏感值只写入、不回显。页面不展示额外 `config.toml` 路径或要求编辑配置文件。
3. 保存后“检查 Agent”，回到会话选择 Provider / 模型并发送消息。新会话未设置默认模型时，选择器也会展示可用 Provider 的模型；浏览列表不自动选中，须明确点选后才保存当前会话选择。原生 `account/read` 明确 `requiresOpenaiAuth=false` 时可就绪、身份仍未知；缺失 / 非法报告和真实认证失败不推断成功。managed 仍要求有效 ChatGPT profile。

状态检查不执行计费推理，不能证明远端接口、密钥或模型可用。真实模型、受管 OAuth、各供应商账号、额度与平台专属能力必须分别验收，不能由状态检查推断。


##### OMP（Oh My Pi）

OMP 是新增的独立 `@t3tools/provider-omp`，不是 Pi 命令别名。协议基线为 OMP `18.13.2`；实施计划、来源与分层验收见 [OMP 适配说明](agent-chat.md)。本次未发布或重启 `3224` 常驻服务。

- 在服务机器外部安装并认证 OMP；添加“OMP / Oh My Pi”，Runtime binary 默认 `omp`，也可填写实际可执行文件绝对路径。应用不代装、登录、更新或复制账号；保存后检查、明确选择发现的模型再发送消息。认证未知与运行可检查并不矛盾，也不代表推理成功。
- 原生 Home / 实例 Environment 按 OMP 自身语义生效，支持 `OMP_PROFILE`、`PI_CODING_AGENT_DIR` 等原生目录变量；不使用 Pi 的 `~/.pi/agent`。Profile 不替代显式 PM 工具目标、执行身份、revision 或 session lease，也不能绕过启动预检。
- stock OMP 无法通过一个开关关闭所有环境扩展 / 插件 / MCP。适配器启动前只检查相关路径元数据；存在无法证明安全的启动源时明确拒绝，含可能触发原生加载的 `.claude.json`。必要时明确指定无这些启动源的 Home / 项目目录，不通过启动参数绕过。该门禁不是操作系统沙箱，不读取或清除全局凭据。
- 原生工具权限遵循现有 PM `deny-ungranted`；PM 工具通过 OMP Host Tools 进入既有授权和业务审批。技术性标题 / 压缩生成显式无工具；Fork、Rollback、主动子 Agent、Goal、原生历史 Usage 和账号额度读取未开放。
- 已用真实 OMP + 受控模型验证流式、取消、多轮及重启恢复、真实 PM 查询与审批 / 拒绝，并在网页观察配置、选模、历史恢复与取消。真实模型验收尚未通过：本机 Ollama 返回 `unable to load model`，未改动该服务或读取供应商账号。运行事件 Usage 不等于历史扫描或订阅账单。

#### MCP、原生 Skills 与交互 Apps

MCP、Skills 与交互 Apps 的源码能力须与实例部署、实际账号及授权前提分别核对。

设置侧栏统一使用 **MCP** 入口，页内分为“MCP 服务器”（Agent 使用外部工具）和“外部访问”（外部客户端访问本系统）；切换分区保留 URL 中的 Provider／上下文与工作区／项目参数，并沿用未保存草稿及操作进行中的离页保护。

- **MCP 管理：** `/agent/settings/mcp-servers` 只显示已启用并绑定的 Agent / Provider 实例；同一用户 Home 下路径兼容且尚未启动管理服务的 Provider（如 Codex / Pi / OpenCode）可共用一个管理上下文，MCP / Skills 矩阵同时显示这些 Agent 列。不同 Home、同类实例的不同原生根及不兼容的 Claude 路径拼写分别管理；停用的 Provider 实例不会进入目标列表。已有独立配置库不自动合并。页面使用“已安装 / 探索 / 配置”管理连接；后端从 Provider 的真实配置解析目标；同类实例显示独立名称与实例 ID，不按“Codex”等类型名称混写。原生导入先只读预览，再逐项应用；保存、文件同步和显式连接探测分别展示，不把“已保存”当成“已连接”。
- **Skills 管理：** `/agent/settings/skills` 与 MCP 共用已启用 Provider 的管理上下文，提供“目录 / 发现 / 配置”、筛选、Agent 覆盖、分配矩阵和详情抽屉，以及真实发现、ZIP 安装、原生导入、更新与备份。MCP 与 Skills 页面间保留同一管理上下文；有草稿或操作进行中不能切换。安装不等于运行时已加载；Pi / OMP 的目录观测也不是安全隔离或可调用证明。
- **本机已安装 Skills：** 页面单独只读扫描当前绑定 Provider 的原生目录及受支持的共享 `.agents/skills`。扫描不自动加入配置库、分配、同步或启动 Skill；“纳入管理”是明确导入动作，之后仍需显式分配。导入固定所选 Skill 根及目录／文件身份，保留经核验的根和内部路径别名，拒绝越界目标、循环或无法核验的 Windows reparse；文件描述符身份／时间戳复核和私有暂存完成后才发布管理副本，不把别名当作扩大授权。远程机器的 Skills 不会被当成本机目录读取。
- **目标与保存位置：** 后端内部保留配置记录，不再作为用户绑定流程。兼容且尚未启动的上下文可以扩展绑定；已启动的管理服务不因新增目标被关闭，新目标使用独立上下文。实例 revision 更新且原生根未变时原位重新核验，保留定义、事件订阅和待重新加载状态。跨 Home 的物理根重叠、已登记根的符号链接改指等冲突明确拒绝，不自动搬迁或导出旧配置，也不删除已有定义和 Skills。共享目录的影响显示在目标详情。没有支持扩展管理的 Provider 时，MCP 仍可浏览公开目录，Skills 明确显示尚未读取，入口引导至 Provider 设置，而不是要求额外授权。
- **新增 Provider 与已保存配置：** 保留 `context` 的页面只重新核验所选上下文的原生归属，同时单独读取全部已启用实例，Provider 选择器仍可显式切换到新 OpenCode 的独立上下文。无关的已登记外部宿主上下文不会阻止访问，也不会被自动扩张或重新绑定；所选上下文失效、目录变化或真实归属冲突仍拒绝，不静默改选其他配置。不为合并列表重启活跃管理服务。远程／自定义 OpenCode 无法可靠映射本机扩展目录时显示不可管理原因，不静默消失，也不凭 loopback 地址假定拥有本机 Home。
- **保留的边界：** 仅已有 Provider 的正常管理使用上述直接流程；宿主登记的外部 CLI 仍使用其明确登记/绑定流程，不开放浏览器任意路径。旧的明确配置链接仍访问原数据；项目私有配置仍受 PM 身份与范围检查，不导出到原生 Home。MCP 自身的 API Key / OAuth 和项目工具审批不因配置页面简化而取消。事件流断开时暂停新写入，重连只重读状态，不重放操作；结果不明确时先刷新核对，配置变更不会自动重启活跃原生会话。
- **外部连接：** MCP 设置的“外部访问”（`/agent/settings/mcp-servers?section=external`）提供连接地址与已授权客户端撤销。部署未配置或元数据读取失败时明确显示外部访问尚未就绪，下方仍保留 PM 登录及已有授权的查看／撤销；不把读取失败当作没有授权。外部 HTTP MCP 客户端经 `/connect-agent` 完成 PM 登录主体同意、授权码与 S256 交换，再访问 `/mcp`。默认只读，明确选择 PM 工作区／项目上限及纯对话线程；目录型 Session 不接受外部委托，线程中的 PM 引用和工具历史也须在授权上限内。full 不绕过既有审批；外部 token 不可登录普通 PM／Agent API，也不能枚举同项目的全部历史。
- **原生工具：** 工具注册在本机读取真实 schema，不为启动普通代码会话访问 PM。`pm_list_workspaces` 只发现当前授权的业务 ID／名称，不选择目录或 Session 所有者；其他 PM 工具每次明确携带 `target: { workspaceId, projectId }`，可在同一 Session 内访问多个已授权目标。PM 不可用时工具明确失败，普通代码环境仍可用。当前成员能力、审批、revision、幂等与原结果核对不变；Chat 成功不会完成 WorkItem。OpenCode 的单 transport、Pi 的 generation-owned 扩展、OMP 的单 `pm_tools` Host Tools 桥仍有各自限制。
- **Skills 与文件引用：** 全页和 PM 内嵌 Chat 共用 Composer 的 `@` 文件、`$` 原生 Skill 与 `/` commands 建议列表及引用 chip；目录在输入、执行环境或实例变化时自动读取，Composer 不提供目录工具栏或 session 重启按钮。`@` 只搜索同一服务端核验的 Session 执行目录，跳过忽略目录与符号链接，不回落 PM 文档、来源目录或父仓库；选中后插入可移除的相对 Markdown 链接，发送内容不额外注入正文。Skill 目录绑定 Provider 实例／revision 和同一 cwd；失败、pending、空目录在建议菜单分别展示，禁用及不可由用户调用的条目不能选。原生安装／修改仍在各 Provider 支持的位置进行；既有 WorkspaceSkill 指令块不再从 Composer 进入，且不是通用 Skill 协议。
- **Provider 差异：** Codex 使用 `skills/list` 与原生 mention；Claude 保留 frontmatter／最后一个 Skill 展开；OpenCode 1.x 文本／命令与 2.x 结构化 IDs 不混同，目录只借用当前已授权且匹配的 live session，不为刷新启动插件／MCP；Grok／Pi 使用 leading mention，Cursor／FX／Antigravity 按各自发现和分派语义。Muse 只公布原生 commands，ACP Registry 只调用当前会话实际公布的 commands（虚拟 skill URI 不当作文件）；OMP 目录可见不等于可调用，Skill 调用禁用，命令仅开放既有 `session` 白名单。逐家真实账号／Skill 行为尚未全部验收。
- **MCP Apps：** 当前原生交互能力由 Codex adapter 提供；其他 Provider 保留真实工具结果，不假造 App 支持。类型化 producing item 绑定原 Server／thread／session；成功工具结果结束后可保留 live session，停止、配置／范围变化、显式重启、撤权或服务关闭使相应能力失效。历史可读不代表仍可交互，打开 App 不隐式启动新模型轮次。frame 使用 `sandbox="allow-scripts allow-forms"`，不含 `allow-same-origin`；工具确认不能替代服务端授权。App 模型上下文按产生项替换／清除，仅在匹配的有效范围／session 内送入后续轮次。

**部署前提：** Agent 配置固定可信 `MCP_PUBLIC_ORIGIN`，用于 OAuth issuer／公开地址，不从任意 Host／Forwarded 猜测。PM 配置私有 `PM_MCP_AGENT_URL` 指向可达 Agent；仅可回退已有 `PM_AUTOMATION_AGENT_URL`，没有猜测 localhost 的默认值。PM 与 Agent 使用既有服务端 `PM_AUTOMATION_SERVICE_SECRET`，MCP 委托采用独立 `pm-mcp-service-v1` 域／audience，不能把秘密放入 `VITE_*`、iframe 或外部 token。网关需显式代理 `/mcp`、OAuth 发现／授权端点及连接页，不能公开 `/internal`；公网客户端还需可信 HTTPS 与可达地址。本轮不自动配置公网，也不将单操作者 Chat 宣称为多用户隔离产品。

撤销会拒绝后续访问并使相应 live 能力失效，但不承诺 Agent SQLite 与 PM PostgreSQL 跨存储原子撤销，也不把取消视作已提交动作回滚。离线备份的 `--secrets exclude` **和** `include` 都会使导出副本中的 MCP grants／tokens／consent 与 App model context 失效，不修改源数据库；恢复后须重新授权，不能恢复 live App 会话。








#### Provider 运行输出

原生驱动共用按 generation 排序的输出投影；前端按原生协议实际事件显示回复、可折叠思考、工具输入/结果、命令终端、文件 diff、搜索、计划、子代理、上下文压缩与失败状态，未报告的能力不补造。旧历史继续原有正文显示，新输出不会再重复显示一份纯文本回复。

- Composer“更多输入选项”中的“逐段 / 整轮”只改变显示时机。逐段按完整 Markdown 边界约 400ms 释放；整轮在结束时展示正文，工具过程仍实时显示；错误和取消保留已收到的内容。
- 输出投影保存在 Agent SQLite，SSE 以序号和完整快照恢复；断开页面不取消原生执行。条目更新约 50ms 合并，慢消费者重置为快照，不无限积压。
- 命令仅在展开时单独订阅，约 100ms 合并输出；折叠释放订阅但不停止命令。终端处理 ANSI、回车覆盖和跨块控制序列，尾部有界且标明截断，最终结果持久保存。工具没有实时命令协议时只显示实际最终结果。
- Codex、OpenCode、Grok、Muse 的明确**信息提问**可回答或取消；重复、过期和不匹配回答被拒绝，服务重启后失去原生回调的请求不可回答。回答本身不写入输出投影。原有命令/文件/权限审批默认继续拒绝；Pi 通用扩展 UI、ACP 含义不明确的 elicitation 不自动当成安全提问放行。
- 部署开关 `AGENT_APPROVAL_MODE`：默认 `ask` 保留人工审批；`auto-approve` 时 assistant-ui 工具审批、PM 破坏性工具审批与原生权限审批全部自动放行并直接执行，审批代码与端点保留。该开关不改变 PM 业务校验，也不表示 WorkItem 完成。

端点、源码归属、各驱动限制和验收记录见[运行输出说明](project-management.md)。该功能不新增 PM 权限或业务完成规则；受控原生协议验证不代表真实供应商账号和模型已验收。

#### Usage 用量与额度

- Agent Chat 左下角侧栏的“用量”进入 `/agent/settings/usage`：紧凑顶栏、Cost / Tokens / Limits、24小时及7/30/90天、实例和 Provider 筛选。概览包含 Provider 汇总与平滑趋势、五项 Totals、缓存/速度费用分解，以及 Model / Day / Hour 明细。成本是 API 等价估算，不是订阅账单；未定价记录保留 token 并明确标记，不当成免费。旧的 `/agent/usage` 保留为跳转到该路由的兼容地址。
- 历史读取 Codex、Claude、Grok、Pi JSONL，以及 OpenCode、Antigravity、Muse 的原生存储；Cursor 使用账号 Dashboard 数据，不从本地对话估算。目录依据生效的原生 Home / 环境变量定位，包含已停用实例的历史；ACP / FX / OMP 没有已接入的通用历史扫描，FX / OMP 不推测历史用量。扫描缓存支持重启、追加与文件身份失效，容量与保留期有界，不能恢复已被淘汰的原生历史。Codex 速度档位仅从匹配的原生记录或冻结启动记录补全，不拿当前会话选项改写历史。
- 公开价格缓存、自定义价格和模型别名在 `/agent/settings/usage/config` 配置；保存使 Usage 查询失效，revision 冲突保留草稿。Limits 展示真实账号/窗口快照、剩余额度、重置时间和支持的 reset credits。页面自动检查有5分钟间隔，显式刷新另行执行；失败保留旧数据及其原有效时间，不伪装成新快照或推测已补满。CLIProxyAPI Hub 的管理密钥只写入、不回显，使用重置 credit 必须明确确认；动作成功但回读失败与动作结果未知分开呈现，均不自动重复兑换。
- OpenCode Go 由服务端使用原生 API Key，以 Bearer 调用 `https://opencode.ai/zen/go/v1/usage`，不以本地 token 估算订阅额度。SQLite 优先选中原生 `opencode-go` 连接，再考虑旧 `opencode` 别名；有效 v2 凭据不受旧 `auth.json` 损坏影响。保留内联认证、实例环境/Home及远程服务边界。5小时、每周、每月窗口沿用原百分比/重置时间模型，`rate-limited` 按额度耗尽显示；只有明确的 `EntitlementError` 才判定无订阅，其他403仍显示查询失败。本次修正仅更新源码，尚未部署或执行真实额度查询。
- 输入框不再显示上下文 token / 进度、费用估算或本轮供应商用量，也不再轮询会话用量；后台原生记账和独立“用量”页保留。`/usage-limits` 仍可显式读取现有额度快照，不执行模型、不自动探测或隐藏刷新。
- Cursor Keychain 只在明确启用、macOS 与对应原生认证条件满足时可用；不会自动导入全局账号。离线备份 `--secrets exclude` 清除 Hub 密钥、停用恢复的 Hub，并排除 Cursor 账号历史缓存；`include` 仍需显式离线授权。

真实供应商账单、额度及 macOS Keychain 需要对应平台和账号独立验收。

#### Agent 离线备份与恢复

先核对所属 PID、工作目录和服务，再停止**本副本 Agent**；工具不会替你停止进程。数据目录由 Agent 角色配置的 `AGENT_WORKSPACE_DATA_DIR` 指定（示例配置为 `.local/agent-data`），备份目录与恢复目标必须和源目录分离，恢复目标必须为空。不要对运行中的目录直接打包 SQLite。

```bash
pnpm agent:backup create --source <Agent数据目录> --bundle <新的私有备份目录> --secrets exclude --stopped
pnpm agent:backup restore --bundle <私有备份目录> --target <独立空目录> --stopped
pnpm agent:backup:verify --bundle <私有备份目录> --target <恢复目录> --stopped
```

必须显式选择 `--secrets exclude` 或 `--secrets include`。两种备份都包含私有会话及 `provider-attachments` 内的Agent附件，目录 / 文件权限为 0700 / 0600，不能放在公共 Web 根目录。`exclude` 保留一致的会话、历史、设置和模型配置，但排除凭据、`provider-private` 凭据/环境身份、实例环境、原生私有配置及应用自有 home，清除原生续聊引用并停用恢复的实例；恢复后必须明确检查原生配置并启用。`include` 纳入上述私有凭据/身份、私有实例配置及数据目录内部的应用自有 homes；外部 Home 只保留路径引用，不收集其内容，恢复时也不创建该目录；应用目录内的符号链接仍被拒绝。可重建的 `provider-cache` 探测缓存不进入任一备份；两种模式均不修改原始数据。

两种模式均包含应用拥有的 `chat-scratch` 内容及目录／Session 元数据，但外部代码文件夹仅保留引用，不复制源码。恢复不会把旧目录身份自动绑定到另一个路径或新建 inode；后续执行仍须通过身份核验，不能借恢复流程补建或接管丢失目录。

恢复时同样核验 `exclude` 策略：原生实例必须明确为 `enabled:false`，不得携带旧 `cliHome` 覆盖；缺失禁用标志也会拒绝，即使备份文件摘要已重新计算。拒绝发生在创建恢复目标之前。

工具校验文件摘要、SQLite 一致快照和记录覆盖，拒绝活跃 / 陈旧锁、不明确的文件、路径穿越及非空目标；不通过 HTTP 提供秘密备份。Agent 备份包含 Chat 保存的 PM 工具结果和核心文件差异快照，仍**不包含完整权威 PM 数据**：PostgreSQL、Markdown 根目录、PM附件、用户项目源码、`.env.agent`、浏览器登录或全局 / 外部 CLI home 不在其中；PM 仍需既有完整备份流程。恢复校验通过不代表 Provider 已登录、PM 范围已获授权或真实模型可执行。

### 统一 Agent Chat 与 PM 工具

PM 侧栏与完整 Chat 页共享会话、模型选择、生成订阅和草稿交接；会话列表、历史、取消、归档及删除全部归 Agent Chat。旧 `/pm/<workspace>/agent` 仅重定向到 Chat，不映射旧 PM 线程。模型统一使用 Chat Provider，不再读取 `AGENT_CHAT_BASE_URL/MODEL/API_KEY`。**会话与持久化尚未经过统一设计，当前暂沿用 Agent Chat。**

PM 业务工具共用一个注册表和执行入口：查询/读取，项目与任务创建及普通字段修改，文档创建/保存，评论读取/创建，关系读取/添加/删除，以及任务归档、恢复、永久删除和状态转换；另有 `pm_list_workspaces` 进行授权目标发现。Codex、Claude、Cursor、Grok、OpenCode、Antigravity、Muse、Pi、ACP Registry 通过原生 MCP 或 Pi 工具扩展接入，OMP 使用原生 Host Tools 接入同一 PM 桥；同一代生成还提供统一 CLI。标题生成和空闲压缩不获得业务工具。接入源码不等于真实供应商账号已验收。

PM API 的 `/api/v1/agent-tools` 提供经认证的 schema 目录，`/api/v1/workspaces/:workspaceId/agent-tools/call` 执行，`/result` 核对原结果。请求保存明确目标和原操作者证据；Chat 只在当前请求内存中转发 PM 认证，不把 Cookie/Authorization 保存进会话、后台计时器或 Provider 环境。PM 仍在服务端检查成员、项目 scope、原生能力、revision、幂等键、关系防环和领域规则；目录不是权限或沙箱。

工具卡显示状态、来源、revision、收据和原对象链接。写入结果未知时只核对原 operationId 的原收据，不自动重派，也不把后来修改的对象冒充原结果。停止生成只阻止后续派发，不回滚已经提交的业务修改。PM 工具仅开放注册表明确声明的动作；归档、恢复、删除和状态转换仍受对应能力、确认与原生生命周期保护。它们不开放 ACL 修改、跨项目移动或任意 shell；Provider 自己的本地执行能力不因此成为 PM 授权。

Chat 的“PM 核心文件变更记录”保存明确目标下已登记共享/独立核心目录的文件新增、修改、删除及前后内容，非 Git 目录和无效 Markdown 也可观察。记录是观测快照，不是完整 Git 历史或防绕过审计；无法证明操作来源时不归因给某次工具调用。扫描由当前合法请求触发，不保留 Cookie/Authorization 进行后台轮询；权限丢失或不完整快照不得推断删除。界面明确区分观测结果、空闲、过期、不完整和失败。

PM 原生详情和文档工作台另提供持久“变更记录”、Markdown Diff 与个人待审阅提示，见 [PM 变更记录说明](project-management.md#变更记录待审阅与完成通知)。来源仅由服务端工具/自动化执行上下文标记，不能由浏览器请求自行声明；无法证明来源的磁盘编辑保持未知。实际任务完成通知沿用现有 PM 通知路由，不以生成结束代替任务完成，不增加 Submission 或自动验收。打开变更、确认已阅、通知已读和人工验收彼此独立；不建立新的 Agent 执行引擎或会话存储。


## 迁移与历史

开发阶段迁移 `0038_unified_agent_tools.sql` 移除旧 PM 聊天表，不迁入旧 PM thread ID；PM业务对象、审计、命令收据和现有 Agent Chat 历史保留。旧 API Provider 历史只读，不能自动替换为另一个模型。会话与持久化尚未统一设计收口。

`0049_agent_code_workspaces.sql` 仅为旧版本历史迁移；当前 `0051_retire_pm_agent_code_workspaces.sql` 退役其 Code Workspace 与 scratch 登记表，新目录身份归 Agent SQLite。旧应用 Session 由明确的停服清理命令切换，不在启动时自动删除，也不通过浏览器旧历史导入恢复。清理保留业务关联的 generation／输出证据、PM 数据、源码／Worktree、附件字节、Provider 账号及外部 CLI 历史；旧 Session 只留下不可执行的最小删除标记，新版 v2 Session 与目录记录保留。工具核对活动操作、命名空间归属和精确清单指纹，步骤见[部署手册](../../deploy/README.md#agent-session-执行环境切换)。这不表示会话与持久化统一设计已经收口。
