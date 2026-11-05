# Agent Chat、Provider、MCP 与数据

本页描述当前源码的使用方式和已知限制，不代表当前工作树已通过检查、真实供应商账号验收或生产部署。历史计划和本机验收原件保留在本地，不作为公开安装依赖。

左上产品切换进入 `/agent/workspace?workspace=<真实ID>`。侧栏顶部集中搜索、作用域筛选、工作区/项目选择与新建会话；选择器展示真实授权目录，包括没有会话的工作区和项目。新会话先绑定作用域，服务端接受生成时重新核验目录并持久化快照，原生 Agent 使用该目录；目录不是权限或沙箱。无 scope 的旧会话只查看，不猜归属。选择器内的文件区域设置可使用现有目录或显式新建目录。目录优先级为已保存映射、已登记本地项目目录、Chat Space 默认目录；已有目录不自动迁移。Provider 在 `/agent/settings/providers` 配置，原生 Home 留空时沿用服务端 CLI 环境和账号；受管 ChatGPT 使用应用私有账号状态。旧 API Provider 历史只读保留，继续发送须显式选择原生 Agent，不自动替换模型。离页保留草稿保护，不自动取消后台生成。主题直接复用 PM 偏好存储，首次切换、刷新和双产品导航保持一致。范围、合同、已执行检查与剩余验收边界见[Agent 使用与边界](agent-chat.md)。

会话行支持右键或省略号菜单：Pin、Settle、Snooze、重命名、隔离生成标题、未读、项目筛选、Auto-settle、复制、文件区域设置、Archive 与 Delete。列表按“置顶 / 活跃 / 稍后提醒 / 已归置”平铺，每行显示作用域、时间、标题及 Provider；作用域筛选只过滤列表，不改写当前会话归属。归置不是归档，更不代表 PM 工作完成。状态由服务端持久化并用独立 revision 防止覆盖；自动归置为默认 3 天无活动，不在运行成功时立即执行。归档可从 `/agent/settings/history` 恢复，运行中不能归档；删除沿用现有停止生成后再明确确认的流程，且不可恢复。标题重生成仅对具备隔离无工具调用能力的 Codex / Claude 开放，不修改原消息或原生会话游标。

主页沿用 t3code 的排列：自动化为独立横向导航行；设置、用量、快捷键工具栏位于登录信息上方。顶栏集中面包屑、侧栏开关、会话详情、终端和右侧面板；Files / Git / Terminal / Browser 标签仅在面板打开后出现。详情显示实际作用域、文件区域与会话参数入口，`Ctrl / ⌘ + Shift + B` 切换；内嵌页保留展开、关闭和 PM 返回上下文，窄屏使用侧栏抽屉。

新会话及成功读取的空历史显示项目化欢迎区和居中输入框，已有消息时输入框停靠底部。Composer 左侧排列模型、原生能力选项和交互模式，右侧放任务引用、附件、可选听写及发送/停止；引用芯片仅在存在引用时占行。历史读取失败明确阻止发送并提供“刷新重试”，不冒充空会话；刷新仍遵循现有文字草稿恢复和附件/引用丢失提醒，不新增持久化协议。

当前只面向本机单操作者适配；尚未按 PM 成员建立 Agent 会话所有权隔离。不要将本次目录绑定视作多用户授权或文件沙箱，也不要据此开放公网使用。权限、审批和业务边界按本次要求留待后续沟通。

#### Chat Space 保存位置与检查器

默认根目录为运行 PM API 的用户主目录下 `~/.pmv4`，不是浏览器电脑或仓库根目录。通过 PM API 环境变量 `PM_CHAT_SPACE_ROOT`（程序入口 `buildApp({ chatSpaceRoot })`）指定绝对路径；服务管理器只向 PM API 转发此覆盖。`/agent/settings/file-areas` 可在现有可信根目录内按工作区更改默认保存根目录，携带 revision 保存，冲突或结果未知时先重读。设置只影响将来首次分配的默认区域，不移动已有目录、PM 数据库、Agent SQLite 或 Provider homes。

```text
<默认保存根目录>/workspaces/<workspaceId>/workspace/
<默认保存根目录>/workspaces/<workspaceId>/projects/<projectId>/
```

目录册读取不创建目录；安全且未分配的默认区域显示“首次使用时创建”，首次有权解析才创建并登记设备/inode 身份。父目录缺失、软链接、越界或已登记目录丢失时拒绝，不重建丢失磁盘、不回退仓库根目录。文件和 Git 只读；终端为真实本机 shell，不是隔离沙箱。Inspector HTTP / WebSocket 请求必须携带 `workspaceId`、可选 `projectId`，已持久会话另带 `threadId` 核验绑定；每次由 PM 使用当前请求身份解析。终端连接固定本次 cwd，切换会话/目录或关闭面板即断开，聊天后台生成不因此取消。顶栏提供“切换终端抽屉”和“切换右侧面板”按钮，分别对应 `Ctrl / ⌘ + J`、`Ctrl / ⌘ + Alt + B`；抽屉高度可拖动或键盘调整并保存在当前浏览器。网页预览保留 iframe sandbox，不放开同源权限。


若已打开的页面在更新后点击面板出现“页面暂时不可用”，还需检查动态模块请求，而不是重发消息。本机 Web 重建现在保留旧哈希资源，避免已打开页面依赖的模块被删除；历史资源只在停机维护时清理，见[部署手册](../../deploy/README.md)。修复前已经缺失的模块仍需手动重新加载一次页面；不会自动提交、重试消息或取消后台生成。

#### Chat 设置

统一入口为 `/agent/settings/general`；设置页共用导航、作用范围标识和未保存 / 保存中离页保护。这里的服务配置适用于本机 Agent 的全部工作区 / 项目，不是新增的 PM 权限或项目级 Provider 覆盖。

设置布局参考 t3code 的“全宽外壳与独立正文宽度”分层：PM 设置导航贴齐主工作区左侧内边距，不再与正文一起限制在 1440px 居中容器；Agent 设置侧栏保持贴左，正文紧随侧栏左对齐。两者正文最大宽度为 1160px，避免超宽表单；窄屏保留 PM 页面选择器与 Agent 横向导航，不按 2560×1440 固定比例缩放。布局调整不改变保存、权限或会话持久化。

| 页面 / 入口 | 实际配置与边界 |
| --- | --- |
| 通用 | 持久保存新会话默认 Provider / 模型、模型能力选项和交互模式；仅创建时快照，不改写历史会话。可明确不设置默认值；失效选择不自动替换，发送前必须显式选择有效模型 |
| 提供商 | 按 t3code 原生驱动定义配置、启停、认证与显式维护运行环境；内置、实际发现和显式登记的自定义模型共用执行校验。安装 / 版本、实际认证及最近状态检查分开展示；健康刷新间隔默认300秒，0关闭；revision 变更使旧检查失效，模型目录不代表付费推理成功 |
| 输入框模型选择器 | 沿用 t3code 的紧凑触发器、提供商侧栏、跨提供商搜索、收藏与键盘操作；隐藏、排序、收藏和模型默认选项按实例保存于本机 Agent 服务，设置页与各浏览器共享。直接保存当前会话，不更改新会话默认值；失效选择不自动替换 |
| 当前会话参数 | 模型右侧直接显示当前思考程度（如 Extra High = `xhigh`）；点击后按 t3code 的分组单选菜单选择原生声明的档位和其他 select / boolean 能力，保存成功后关闭；default / plan 由相邻独立按钮切换。共用当前会话原子保存和 revision 检查，不改新会话默认值；失败保留修改并提供重试、阻止发送，不凭空生成 reasoning 档位。system prompt 与支持的 temperature 仍由会话参数编辑 |
| 输入与快捷键 | Enter 或 Ctrl/Cmd+Enter 发送，保留 IME 组合输入；Ctrl/Cmd+Shift+O 新会话、Ctrl/Cmd+K 搜索、Ctrl/Cmd+. 停止、`?` 帮助。输入和弹窗不触发全局快捷键；停止需服务端确认 |
| 外观 | 主题 / 跟随系统、减少动态效果、侧栏密度复用 PM 浏览器偏好；Agent 正文字号、内容宽度、代码换行仅影响阅读，不改写消息 |
| 文件区域 | 汇总真实授权工作区 / 项目、空组、路径来源、状态和 revision；保存继续使用既有权限、allowedRoots 和版本检查 |
| 历史与归档 | 归档保留历史，恢复到原工作区 / 项目；运行中不可归档。恢复 / 删除重新核验原范围，永久删除需明确确认 |
| 诊断、数据与存储 | 展示实际版本、SQLite 所有权 / 完整性 / 计数、最近失败类别及私有目录；安全诊断下载采用状态白名单，不导出消息、提示词、凭据、目录或原始日志 |

Provider 集合为 Codex、Claude、Cursor、Grok、FX、OpenCode、Antigravity、Muse Code、Pi、OMP（Oh My Pi）、ACP Registry。初始化仍只持久创建 Codex / Claude；其他默认位仅在已配置、有效启用或定向访问时显示，浏览页面不创建实例。FX 位于“显示更多”，ACP Registry 为独立搜索 / 准备入口；Registry 先显式准备，再填写身份并按协议认证，local 命令走较短路径。实例 ID 固定、字母开头、最多64字符，显示名称可清空回退驱动名；默认实例可重置，额外实例可删除。普通字段失焦或 Enter 保存，环境变量和模型显式保存。非敏感环境变量可回显编辑，敏感值遮蔽且空值回传保留；旧环境变量默认按敏感值迁移。模型段统一管理隐藏、排序、收藏、自定义能力选项；Antigravity 不开放自定义模型。独立 OpenAI / Anthropic / DeepSeek API 卡片及新执行入口不恢复，原始历史和私有凭据不删除。

适配以 `t3code@30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c` 为配置与协议基准；MIT 归属见 [LICENSE.t3code](../../LICENSE.t3code)。Codex 通过“使用现有 CLI”与“继续使用 ChatGPT”进入对应流程，不再展示模式下拉框。existing 复用原生配置 / 外部认证，可使用 API Key 或第三方服务，不强制 ChatGPT 登录；managed 使用受管运行时、ChatGPT 多账号 OAuth / token broker，私有状态保留在本副本 `provider-homes`。Claude 的四种 idle compaction 模式接入实际宿主调度并重新核验 PM 范围；Cursor 的 `CURSOR_API_KEY` 位于专属 Setup，填写密钥后隐藏浏览器登录，清除并保存后恢复该入口。Grok / FX / Muse / Pi / OMP 与 existing Codex / Claude / OpenCode 遵循来源的外部认证边界，不另造应用内登录 / 登出。

安装、更新、取消与移除仅对实际支持的驱动开放；“继续使用 ChatGPT”先准备运行时，再发起登录，只读检查或发送消息不会自动下载。维护与认证 / 执行互斥。原生 Home 留空时继承宿主规则，显式 Home 和实例环境覆盖对应配置，不重写进程 HOME / XDG，也不清除宿主 Provider 凭据。应用自有状态与原生 Home 分离，重置、删除和备份不收集、创建或删除外部 Home。PM 作用域、审批与完成规则不变。

当前配置流程、实际执行及发布记录见 [t3code Provider 原生流程切换](../reference/t3code-provider-config-diff-30eb7e7bb1.zh.md#v4-native-provider-flow)。原调查和前两轮实施保留为历史记录；旧的强制独立 Home 与配置文件教程已被替换。


##### 配置并使用 Provider

1. 在“提供商”选择已有实例，或“添加提供商”。Codex 选择“使用现有 CLI”复用服务所在机器的原生配置；只有选择“继续使用 ChatGPT”才走受管账号连接。
2. 原生 CLI 已可用时，无需填写 Home 或重复登录。需要覆盖时，使用驱动提供的 Runtime、Launch arguments 和 Environment；实例变量覆盖同名宿主变量，敏感值只写入、不回显。页面不展示额外 `config.toml` 路径或要求编辑配置文件。
3. 保存后“检查 Agent”，回到会话选择 Provider / 模型并发送消息。新会话未设置默认模型时，选择器也会展示可用 Provider 的模型；浏览列表不自动选中，须明确点选后才保存当前会话选择。原生 `account/read` 明确 `requiresOpenaiAuth=false` 时可就绪、身份仍未知；缺失 / 非法报告和真实认证失败不推断成功。managed 仍要求有效 ChatGPT profile。

状态检查不执行计费推理，不能证明远端接口、密钥或模型可用。真实模型、受管 OAuth、各供应商账号、额度与平台专属能力必须分别验收，不能由状态检查推断。


##### OMP（Oh My Pi）

OMP 是新增的独立 `@t3tools/provider-omp`，不是 Pi 命令别名。协议基线为 OMP `18.13.2`；实施计划、来源与分层验收见 [OMP 适配说明](agent-chat.md)。本次未发布或重启 `3224` 常驻服务。

- 在服务机器外部安装并认证 OMP；添加“OMP / Oh My Pi”，Runtime binary 默认 `omp`，也可填写实际可执行文件绝对路径。应用不代装、登录、更新或复制账号；保存后检查、明确选择发现的模型再发送消息。认证未知与运行可检查并不矛盾，也不代表推理成功。
- 原生 Home / 实例 Environment 按 OMP 自身语义生效，支持 `OMP_PROFILE`、`PI_CODING_AGENT_DIR` 等原生目录变量；不使用 Pi 的 `~/.pi/agent`。Profile 不替代 PM scope、revision 或 session lease，也不能绕过启动预检。
- stock OMP 无法通过一个开关关闭所有环境扩展 / 插件 / MCP。适配器启动前只检查相关路径元数据；存在无法证明安全的启动源时明确拒绝，含可能触发原生加载的 `.claude.json`。必要时明确指定无这些启动源的 Home / 项目目录，不通过启动参数绕过。该门禁不是操作系统沙箱，不读取或清除全局凭据。
- 原生工具权限遵循现有 PM `deny-ungranted`；PM 工具通过 OMP Host Tools 进入既有授权和业务审批。技术性标题 / 压缩生成显式无工具；Fork、Rollback、主动子 Agent、Goal、原生历史 Usage 和账号额度读取未开放。
- 已用真实 OMP + 受控模型验证流式、取消、多轮及重启恢复、真实 PM 查询与审批 / 拒绝，并在网页观察配置、选模、历史恢复与取消。真实模型验收尚未通过：本机 Ollama 返回 `unable to load model`，未改动该服务或读取供应商账号。运行事件 Usage 不等于历史扫描或订阅账单。

#### MCP、原生 Skills 与交互 Apps

MCP、Skills 与交互 Apps 的源码能力须与实例部署、实际账号及授权前提分别核对。

- **外部连接：** `/agent/settings/mcp-clients` 提供连接地址与已授权客户端撤销；外部 HTTP MCP 客户端经 `/connect-agent` 完成 PM 登录主体同意、授权码与 S256 交换，再访问 `/mcp`。默认只读，明确选择工作区／项目和线程；full 只是权限上限，不绕过既有审批。外部 token 不可登录普通 PM／Agent API，也不能枚举同项目的全部历史。
- **原生工具：** PM 工具继续经 Provider 的 MCP／ACP／SDK／Host Tools 注入，复用现有 scope、当前成员能力、审批、revision、幂等与结果核对。不是新权限系统；Chat 成功不会完成 WorkItem。OpenCode 的单 transport、Pi 的 generation-owned 扩展、OMP 的单 `pm_tools` Host Tools 桥仍有各自限制，不承诺任意多个 Server。
- **Skills：** 全页和 PM 内嵌 Chat 共用 Composer 的 `$` 搜索、原生 `/` commands、引用 chip、刷新目录及显式重启 Agent session。目录绑定 Provider 实例／revision 和 PM 核验的 cwd；失败、pending、空目录分别展示，禁用及不可由用户调用的条目不能选。原生安装／修改仍在各 Provider 支持的位置进行；刷新不安装插件，重启保留 Chat 历史但废弃原生 continuation。既有 WorkspaceSkill 指令块独立保留，不是通用 Skill 协议。
- **Provider 差异：** Codex 使用 `skills/list` 与原生 mention；Claude 保留 frontmatter／最后一个 Skill 展开；OpenCode 1.x 文本／命令与 2.x 结构化 IDs 不混同，目录只借用当前已授权且匹配的 live session，不为刷新启动插件／MCP；Grok／Pi 使用 leading mention，Cursor／FX／Antigravity 按各自发现和分派语义。Muse 只公布原生 commands，ACP Registry 只调用当前会话实际公布的 commands（虚拟 skill URI 不当作文件）；OMP 目录可见不等于可调用，Skill 调用禁用，命令仅开放既有 `session` 白名单。逐家真实账号／Skill 行为尚未全部验收。
- **MCP Apps：** 当前原生交互能力由 Codex adapter 提供；其他 Provider 保留真实工具结果，不假造 App 支持。类型化 producing item 绑定原 Server／thread／session；成功工具结果结束后可保留 live session，停止、配置／范围变化、显式重启、撤权或服务关闭使相应能力失效。历史可读不代表仍可交互，打开 App 不隐式启动新模型轮次。frame 使用 `sandbox="allow-scripts allow-forms"`，不含 `allow-same-origin`；工具确认不能替代服务端授权。App 模型上下文按产生项替换／清除，仅在匹配的有效范围／session 内送入后续轮次。

**部署前提：** Agent 配置固定可信 `MCP_PUBLIC_ORIGIN`，用于 OAuth issuer／公开地址，不从任意 Host／Forwarded 猜测。PM 配置私有 `PM_MCP_AGENT_URL` 指向可达 Agent；仅可回退已有 `PM_AUTOMATION_AGENT_URL`，没有猜测 localhost 的默认值。PM 与 Agent 使用既有服务端 `PM_AUTOMATION_SERVICE_SECRET`，MCP 委托采用独立 `pm-mcp-service-v1` 域／audience，不能把秘密放入 `VITE_*`、iframe 或外部 token。网关需显式代理 `/mcp`、OAuth 发现／授权端点及连接页，不能公开 `/internal`；公网客户端还需可信 HTTPS 与可达地址。本轮不自动配置公网，也不将单操作者 Chat 宣称为多用户隔离产品。

撤销会拒绝后续访问并使相应 live 能力失效，但不承诺 Agent SQLite 与 PM PostgreSQL 跨存储原子撤销，也不把取消视作已提交动作回滚。离线备份的 `--secrets exclude` **和** `include` 都会使导出副本中的 MCP grants／tokens／consent 与 App model context 失效，不修改源数据库；恢复后须重新授权，不能恢复 live App 会话。








#### Provider 运行输出

原生驱动共用按 generation 排序的输出投影；前端按原生协议实际事件显示回复、可折叠思考、工具输入/结果、命令终端、文件 diff、搜索、计划、子代理、上下文压缩与失败状态，未报告的能力不补造。旧历史继续原有正文显示，新输出不会再重复显示一份纯文本回复。

- Composer“更多输入选项”中的“逐段 / 整轮”只改变显示时机。逐段按完整 Markdown 边界约 400ms 释放；整轮在结束时展示正文，工具过程仍实时显示；错误和取消保留已收到的内容。
- 输出投影保存在 Agent SQLite，SSE 以序号和完整快照恢复；断开页面不取消原生执行。条目更新约 50ms 合并，慢消费者重置为快照，不无限积压。
- 命令仅在展开时单独订阅，约 100ms 合并输出；折叠释放订阅但不停止命令。终端处理 ANSI、回车覆盖和跨块控制序列，尾部有界且标明截断，最终结果持久保存。工具没有实时命令协议时只显示实际最终结果。
- Codex、OpenCode、Grok、Muse 的明确**信息提问**可回答或取消；重复、过期和不匹配回答被拒绝，服务重启后失去原生回调的请求不可回答。回答本身不写入输出投影。原有命令/文件/权限审批继续拒绝；Pi 通用扩展 UI、ACP 含义不明确的 elicitation 不自动当成安全提问放行。

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

先核对所属 PID、工作目录和服务，再停止**本副本 Agent**；工具不会替你停止进程。数据目录从“数据与存储”读取，备份目录与恢复目标必须和源目录分离，恢复目标必须为空。不要对运行中的目录直接打包 SQLite。

```bash
pnpm agent:backup create --source <Agent数据目录> --bundle <新的私有备份目录> --secrets exclude --stopped
pnpm agent:backup restore --bundle <私有备份目录> --target <独立空目录> --stopped
pnpm agent:backup:verify --bundle <私有备份目录> --target <恢复目录> --stopped
```

必须显式选择 `--secrets exclude` 或 `--secrets include`。两种备份都包含私有会话及 `provider-attachments` 内的Agent附件，目录 / 文件权限为 0700 / 0600，不能放在公共 Web 根目录。`exclude` 保留一致的会话、历史、设置和模型配置，但排除凭据、`provider-private` 凭据/环境身份、实例环境、原生私有配置及应用自有 home，清除原生续聊引用并停用恢复的实例；恢复后必须明确检查原生配置并启用。`include` 纳入上述私有凭据/身份、私有实例配置及数据目录内部的应用自有 homes；外部 Home 只保留路径引用，不收集其内容，恢复时也不创建该目录；应用目录内的符号链接仍被拒绝。可重建的 `provider-cache` 探测缓存不进入任一备份；两种模式均不修改原始数据。

恢复时同样核验 `exclude` 策略：原生实例必须明确为 `enabled:false`，不得携带旧 `cliHome` 覆盖；缺失禁用标志也会拒绝，即使备份文件摘要已重新计算。拒绝发生在创建恢复目标之前。

工具校验文件摘要、SQLite 一致快照和记录覆盖，拒绝活跃 / 陈旧锁、不明确的文件、路径穿越及非空目标；不通过 HTTP 提供秘密备份。Agent 备份包含 Chat 保存的 PM 工具结果和核心文件差异快照，仍**不包含完整权威 PM 数据**：PostgreSQL、Markdown 根目录、PM附件、用户项目源码、`.env.agent`、浏览器登录或全局 / 外部 CLI home 不在其中；PM 仍需既有完整备份流程。恢复校验通过不代表 Provider 已登录、PM 范围已获授权或真实模型可执行。

### 统一 Agent Chat 与 PM 工具

PM 侧栏与完整 Chat 页共享会话、模型选择、生成订阅和草稿交接；会话列表、历史、取消、归档及删除全部归 Agent Chat。旧 `/pm/<workspace>/agent` 仅重定向到 Chat，不映射旧 PM 线程。模型统一使用 Chat Provider，不再读取 `AGENT_CHAT_BASE_URL/MODEL/API_KEY`。**会话与持久化尚未经过统一设计，当前暂沿用 Agent Chat。**

17 个 PM 工具共用一个注册表和执行入口：查询/读取，项目与任务创建及普通字段修改，文档创建/保存，评论读取/创建，关系读取/添加/删除，以及任务归档、恢复、永久删除和状态转换。Codex、Claude、Cursor、Grok、OpenCode、Antigravity、Muse、Pi、ACP Registry 通过原生 MCP 或 Pi 工具扩展接入，OMP 使用原生 Host Tools 接入同一 PM 桥；同一代生成还提供统一 CLI。Provider 工具配置随生成建立，标题生成和空闲压缩不获得业务工具。接入源码不等于真实供应商账号已验收。

PM API 的 `/api/v1/workspaces/:workspaceId/agent-tools` 提供注册表，`/call` 执行，`/result` 核对原结果。Chat 只在内存中转发本次 PM 请求认证信息，不创建第二套工具凭据，不把 Cookie/Authorization 保存进会话或放进 Provider 环境。PM 仍在服务端检查成员、项目 scope、原生能力、revision、幂等键、关系防环和领域规则；目录不是权限或沙箱。

工具卡显示状态、来源、revision、收据和原对象链接。写入结果未知时只核对原 operationId 的原收据，不自动重派，也不把后来修改的对象冒充原结果。停止生成只阻止后续派发，不回滚已经提交的业务修改。PM 工具仅开放注册表明确声明的动作；归档、恢复、删除和状态转换仍受对应能力、确认与原生生命周期保护。它们不开放 ACL 修改、跨项目移动或任意 shell；Provider 自己的本地执行能力不因此成为 PM 授权。

Chat 的“PM 核心文件变更记录”保存已登记共享/独立核心目录的文件新增、修改、删除及前后内容，非 Git 目录和无效 Markdown 也可观察。记录是观测快照，不是完整 Git 历史或防绕过审计；无法证明操作来源时不归因给某次工具调用。当前认证活动后保持短期轮询；重启后需新的合法请求恢复扫描，权限丢失或不完整快照不得推断删除。界面明确区分正在观测、空闲、过期、不完整和失败。

## 迁移与历史

开发阶段迁移 `0038_unified_agent_tools.sql` 移除旧 PM 聊天表，不迁入旧 PM thread ID；PM业务对象、审计、命令收据和现有 Agent Chat 历史保留。旧 API Provider 历史只读，不能自动替换为另一个模型。会话与持久化尚未统一设计收口。
