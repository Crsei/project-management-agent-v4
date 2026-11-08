# 变更记录

本文件记录公开产品与发布边界，不汇总私有机器路径、业务数据或内部验收流水。`Unreleased` 表示尚未正式发布，不代表以下代码已经通过最新工作树全量检查。

## Unreleased

### 产品与架构

- 统一 PM 与 Agent Chat 入口、Provider、会话和运行时；Markdown 核心拥有项目/任务/正式关系，PostgreSQL 保存 PM 附加事实，Agent SQLite 保存聊天及运行附属记录。
- Agent Chat 改为独立“文件夹 → Sessions”：打开服务器已有绝对路径，一个 Agent Workspace 对应一个目录，不再绑定 PM 工作区／项目。移除 Code Workspace 多根组合、登记页及 PM API；目录身份归 Agent SQLite，元数据重命名／关闭／重开不改绑 Sessions。Files、Git、Skills、Provider 与终端共用执行目录核验，禁止 PM 文档及父 Git 仓库回退。
- 终端改为服务内稳定 PTY：Workspace 与 Session 两种范围、统一右侧／底部停靠、重附着、有界回放、创建与输入去重及目录身份复核；服务重启后不恢复进程或重放命令。终端复用 Provider 原生环境过滤规则，不继承服务端 PM／Agent 凭据。
- 增加显式离线旧 Session 切换工具和交付／工作流替代会话入口；旧 v1 Session 可清理，新 v2 Session／目录和业务证据保留，不在启动时自动删除。迁移 `0051_retire_pm_agent_code_workspaces.sql` 只退役旧登记表，不删除 PM 数据、源码、Worktree、附件或 Provider 数据；备份纳入应用私有 chat-scratch，但不收集外部代码目录。
- 普通代码会话不依赖 PM 可用性；PM 通过目标发现、带明确工作区／项目的工具和引用访问。同一 Session 可使用多个已授权 PM 目标，凭据仅存在当前请求，不用后台计时器保存认证。自动化、交付和工作流保留明确 PM 授权及原请求收据，另行选择独立 v2 执行目录；旧配置须显式重选，不能自动重放。
- 提供项目/任务多视图、Markdown 文档工作台、授权外部来源、成员/团队、人工交付、Files 版本管理与定向通知。
- 增加任务、需求、PM／已登记外部文档的前后版本历史、字段与 Markdown Diff、固定水位累计比较，以及看板个人“待审阅”提示／筛选；已完成待阅任务仍可查找。任务完成沿用现有通知路由，通知已读、变更已阅与人工验收独立，不改变 Submission 或完成规则。迁移 `0050_change_history.sql` 配合私有不可变快照和原操作证明恢复，不补造外部编辑历史或把执行成功当作业务完成。
- 修复无效 Markdown 的原始文本修复历史：保留真实端点字节，不再把最后一次有效解析的正文／元数据标记为该端点；无法解析的字段明确不可用，界面改为原始文本比较。
- 提供原生 Provider、MCP/Skills/交互 Apps、Usage、任务代码交付/工作流、产品规划、有限 Linux 本机预览及显式授权自动化；未配置与未支持能力明确禁用。
- MCP / Skills 管理页采用重建页面的列表、目录、Agent 分配矩阵和抽屉布局，适配项目明暗主题与窄屏；接入既有 CC Switch 保存、批量分配、原生导入与显式连接探测，不使用演示状态或增加权限。
- MCP / Skills 直接管理应用中已有的 Agent / Provider 实例，移除创建上下文、选择上下文及重复绑定授权步骤；同根复用配置，不同根独立，保留旧配置数据、编辑切换保护和真实原生读写。未配置 Provider 时保留新版目录展示并引导至 Provider 设置；外部 CLI 登记、MCP 自身登录及 PM 工具权限不变。
- 已授权 MCP 客户端合并到 MCP 设置的“外部访问”分区，移除独立导航与旧页面路由；保留连接地址、PM 身份授权列表和撤销能力。部署未就绪明确提示，不隐藏历史授权管理；分区切换沿用草稿／操作保护，扩展内嵌抽屉不会遮挡离页确认。
- 已启用 Provider 的默认分组保留独立配置库与已启动的管理进程；原位刷新保留订阅和待重新加载状态，同目录别名停用后由仍启用的实例核验完整目录归属。跨 Home 物理根重叠、已登记符号链接改指明确拒绝；不兼容的原生根及 Claude Home 路径分别管理。
- 修复扩展配置目标切换后选择器消失；Skills 清除分配按 Agent 串行等待真实写入与核对，Config／Catalog 共用详情抽屉，MCP 目录按全部支持的传输方式筛选。
- Agent Chat Composer 移除原生目录工具栏、原生 Skills 管理链接和用户指令块入口；输入 `@` 文件、`$` 原生 Skill / `/` 命令共用一组可键盘导航的建议列表与引用 chip。文件建议按当前 Session 执行目录核验搜索，选中后插入可移除的 Markdown 文件链接；目录仍随输入、作用域与实例变化自动读取。
- Agent Chat durable 输出时间线改用紧凑 `Trace` 行：命令、推理、工具、计划、待办、子 Agent、搜索和错误不再逐项套大卡片；终端输出保留 xterm 流式、换行和滚动，复制按钮移到右上角；Diff 使用带行号的增删行样式。执行中或失败项默认展开，成功项默认折叠。
- Agent Chat 右侧面板采用 t3code surface 交互：Files / Git 单标签、多个 Browser 标签，以及可切换停靠位置的单一 Terminal 视图；顶部支持标签菜单、排序、最大化及窄屏抽屉。终端范围、目录、连接和终止状态明确展示；未实现 PR / Device surface 不显示。
- Agent Chat 右侧 Files surface 按 t3code 文件展示页重做：文件树与预览分栏、可切换文件树、文件类型图标、全项目文件搜索、目录展开／折叠、面包屑、语法高亮只读源码、Markdown 渲染切换和自动换行。搜索仍按当前 Session 执行目录核验、跳过忽略目录与符号链接；二进制文件继续明确拒绝，不新增写入能力。
- Agent Chat 的 Browser surface 改为 t3code 单行浏览器工具栏（后退/前进/刷新、地址栏、元素选择/截图/浮层/菜单）和“最近使用”入口；地址栏 Enter 打开 URL，非 URL 文本在新标签页搜索。修复 iframe 沙箱缺少 `allow-same-origin` 导致跨域 SPA 的模块脚本和样式被 CORS 拦截而白屏的问题；同源地址明确阻止预览并引导新标签页。最近记录仅保存在浏览器 localStorage，可删除或清空；跨域页面不提供元素选择、截图和浮层。
- 桌面版新增受控 Electron `<webview>` Browser runtime：工作区 preload 仅暴露预览 IPC，主进程管理独立 preview partition、导航/标题/favicon、截图、元素选择与只读 PiP 帧流；元素选择和截图作为图片附件加入 Composer，Browser 标签标题跟随页面标题。工作区窗口启用受 `will-attach-webview` 校验的 `webviewTag`，连接窗口、guest 的 Node 能力和工作区 session 隔离保持不变；原生预览仅本地工作区启用，远程工作区继续 iframe fallback。
- 桌面 Browser 元素选择在主框架导航时立即取消，子框架导航不误取消；关闭其他 Browser 标签不会关闭当前标签的 PiP。
- Agent Chat 设置移除“本机服务”分组及诊断、数据与存储两个页面与路由；服务端诊断/存储读取接口保留，Agent 数据目录改由 `AGENT_WORKSPACE_DATA_DIR` 配置读取。
- Agent Chat 与 PM 共用同一表层规格：暖中性侧栏配白色正文与顶栏、12/16 元数据与 13/20 控件文字、30/36 导航密度、48px 顶栏、6px 控件圆角与实心危险按钮、暖陶土选中态，以及 PM 的信息蓝 / Agent 紫和低饱和图表序列；聊天阅读轴、双行会话与 Composer 结构保持独立。
- 错误页的状态图标与 HTTP 状态码改为纵向分离布局，避免图标徽标与数字重叠；紧凑模式按比例收紧间距。
- PM “Agent 助手”合并为文字与向下箭头共用的圆角下拉按钮，项目自动化选项位于上方，最下方可携带当前范围跳转 Agent Chat；配置页可标记快捷入口，沿用已保存定义、授权分页、revision 和原请求收据。原生 PM 分析可直接执行，其他动作保留确认；受理反馈链接到准确运行记录，不自动完成业务任务。

### 发布准备

- README 整理为公共入口，完整用法与限制移至 `docs/guides/`；内部计划和历史验收原件留在本地，公共安装/检查不依赖它们。
- 当前架构/领域文档明确 Markdown、PostgreSQL、Agent SQLite 的不同权威，保留历史 ADR 和 INV/SC 追踪语义。
- 提供贡献与安全政策、工具链 doctor 和隔离 CI 入口；文档检查不再绑定内部27步实施计划。
- 修复 Claude 外部 CLI 交付边界：保留通信 SDK 与完整资源，但按包身份排除 SDK 的平台 CLI 执行包，并覆盖 Agent、自有桌面打包及独立 `pnpm deploy`／容器闭包；缺失或无效的用户 Claude 路径明确失败，不改用内置 CLI。保留 Cursor SDK 引擎／原生工具、SQLite、PTY，以及 Codex / Antigravity managed 和 ACP 原生安装语义；不宣称所有 Provider 都已切换为外部 CLI。
- 按只读 t3code 发布工作流与近期实际 stable/nightly assets 补齐本项目桌面交付设计；默认只构建 Windows x64 unsigned，不移植上游 CLI、便携版、自动更新/nightly、relay/mobile 或发布账号。最终 app.asar、unpacked 与受管 runtime 复用外部 Claude CLI 包身份检查；发行集增加准确源码/版本身份、对应源码与最终许可材料、非自引用 SHA256SUMS 和分层验证报告，Actions 只上传精确校验的完整材料。材料收集/测试包不代表签名、GUI、真实安装或正式分发授权通过，见[发布设计](docs/reference/desktop-release-alignment-2026-11-08.zh.md)与[Windows 操作手册](docs/reference/windows-build-runbook.zh.md)。
- 加固发行材料的派生边界：源码根及全部祖先复用现有安全目录/文件句柄检查，拒绝内部 symlink/junction、身份漂移和构建期间公开选集变化；dirty 由实际字节/模式与固定 HEAD 对象比较，不能被 assume-unchanged 隐藏。legal 目录复制后按自身根重新检查链接，成品 ASAR 摘要必须匹配原验证报告，不能用同名称/版本的另一份归档替换。
- 桌面依赖改为 PM、Agent、Electron 各自独立的物理生产 `node_modules`，保留版本/peer 上下文、完整包资源和 Agent Effect 4.0.5 单实例，不跨闭包按 hash 删包。成品门禁需全功能 7-Zip，检查实际 NSIS 内层 payload 与 macOS DMG/ZIP 的依赖图、资源摘要及文件数/逻辑字节；`--native-smoke` 改用最终提取资源，`--installed-resources` 可将所供资源树精确绑定当前发行文件。控制器仍来自构建检出，均不代替安装/升级/卸载或 Electron GUI；本批次已明确授权精确提交、公开推送、Windows-only unsigned 构建和 artifact 下载，但授权不是成功证据，不宣称尚未实测的新安装器体积或原生验收结果，详见[桌面指南](docs/guides/desktop.md)。
- 原生安装包工作流支持只运行 Windows x64，不启动 macOS Job；修复 MSVC 链接器帮助返回 1100 时被构建预检误报为缺失，仍拒绝缺失工具、真正链接错误和无效帮助输出。
- 桌面预览回归移除把预加载文件 URL 写死为 POSIX 路径的断言，保留导航归一化、分区与权限行为检查，避免 Windows 正确的驱动器路径被误判。
- Windows 原生辅助程序清单按实际平台记录规范文件模式，不再要求不存在的 POSIX 执行位；文件哈希、大小、模式、目标平台与资源闭包校验保持启用。
- Web 许可证依赖遍历统一 Vite 模块 ID 与平台目录分隔符，避免 Windows 将实际依赖误判为空；保留依赖许可证闭包缺失时拒绝打包的检查。
- CC Switch 来源记录支持精确退役已删除的宿主自有输出：必须核对旧摘要、完整重放配方及消费者，禁止退役上游源码、生产入口或外部所有者输出，不绕过生产构建校验。
- T3 MCP/Skills 宿主输出支持精确退役：保留原始来源与历史配方，要求旧摘要和逐项理由，检查剩余消费者及恢复路径；现存输出变更仍须逐项批准，不放宽构建来源门禁。
- 收口独立 Agent Workspace 的同 pin 来源记录：九个重复登记的宿主输出转交现有 T3 所有者，CC 不再保存第二份重放副本；保留原来源、退役证明及跨 fork 构建检查，不变更上游 pin。
- 自有代码采用 `AGPL-3.0-only`；第三方保留原始许可，未闭合分发授权继续作为[发布阻塞](THIRD_PARTY_NOTICES.md#release-blockers)。
- 自动化目录与脚本资源迁至 `packages/automation-resources`，合同保留 DTO/schema；Provider 深层源码访问限制在明确适配器，纯筛选模型不再把 React 组件带入后端类型检查。
- 修复 Linux 预览对新版 Bubblewrap 参数、固定全局 Node 和合并 `/usr` 布局的隐含依赖；沿用空环境、只读代码、独立网络及有界 relay，不放宽隔离。
- Agent 文件区域上下文在应用服务与公开 schema 中统一携带已认证 `actorId`，不再依赖 HTTP 层补字段。
- Provider 配置映射改为纯投影，由 Host 读取持久化设置，消除驱动注册表的 ESM 初始化循环；隔离 CI 显式使用已校验的原生 sidecar 构建产物。
- 修复组合框的非受控默认选择，以及受控创建 Sheet 未使用显式关闭焦点目标的问题。
- 隔离 CI 的真实备份/恢复使用自有 PostgreSQL 容器内的同版本客户端，仅挂载本轮测试临时文件，不依赖宿主 PostgreSQL 客户端或开发者 Docker 配置；明确临时目录必须在 Git 工作树之外。测试数据库销毁使用独立有界清理期限，应用查询限制不变。
- 增加 t3code / cc-switch 选定源码维护工具、隔离候选与精确 generation 重建、来源绑定与受控 Draft PR 发布器；沿用现有适配边界，不迁移业务源码。新增仓库维护 Skill、只读手动发现 workflow 及协议回归；commit、push、PR 分别授权，定时发现、真实 GitHub 发布与生产升级不自动启用。用法与验收限制见[维护指南](docs/guides/upstream-source-maintenance.md)。
- CI 增加命令/阶段耗时工件与每 120 秒的输出静默、自有进程 CPU/I/O 诊断，保留失败、中断及清理错误；Actions 缓存精确锁定的 pnpm 内容仓和桌面运行时下载归档，命中后仍执行完整安装、验证与打包。实测范围、阻塞及不可混用的本机/托管耗时见 [CI 耗时记录](docs/reference/ci-performance-2026-11-06.zh.md)。

### 尚未作为发布保证的事项

- Agent 仍为本机单操作者，非多租户产品，cwd 不是文件沙箱；会话与持久化统一设计未收口。
- 单 API/本地 Markdown 核心、同工作区写入串行；无自动孤立文件 GC、通用业务 Runner、多实例/HA 或公网生产验收保证。
- Windows/macOS 为桌面交付目标；`a063dc0` 原生 CI 历史通过不代表当前树、正式签名/公证、安装卸载或 GUI 验收。没有确认的正式下载/自动更新地址。
- 真实 Provider/账号/额度、SMTP/S3/Webhook、私密漏洞报告渠道、生产恢复与真实设备仍须逐项配置并验证。文档、构建、fixture 或健康检查均不能替代这些结果。
