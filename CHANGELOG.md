# 变更记录

本文件记录公开产品与发布边界，不汇总私有机器路径、业务数据或内部验收流水。`Unreleased` 表示尚未正式发布，不代表以下代码已经通过最新工作树全量检查。

## Unreleased

### 产品与架构

- 新增标签发布流水线与 `scripts/release-package.mjs`：标签推送先完成精确提交的完整 `Repository checks`，成功后由 `start-release` 派发 `Tag release`；发布作业再次核对标签、版本、默认分支和成功 CI run，记录发行授权门禁并构建未签名源码/构建证据。仅创建或刷新 draft GitHub Release；存在 open blocker 时停在校验或打包阶段，不自动发布、签名、生成安装器或部署。
- 修复 Windows 桌面停机中的同步进程身份检查及服务初始化时丢失停止消息；保持自有句柄／Job Object 与持久出生身份的分离，EOF helper 取消后回收整个受管树，长期服务仍正常关闭。备份／恢复不再将准确识别的 PostgreSQL 监督连接误判为活动应用；其他连接仍拒绝。ACL／维护诊断仅输出脱敏的阶段和错误类别，测试夹具按原生私有目录规则创建。
- 桌面 Actions 将合同、生命周期／私有文件系统、真实 PostgreSQL／加密备份拆为独立限时步骤；原生重型测试按文件串行，保留全部回归和 Agent 维护入口构建，不以扩大 Job 超时代替修复。新增 bootstrap 后代进程回收、顶层 await 期间停机和冒名数据库连接拒绝回归；本机 Linux 验证不代表 Windows 安装器或 GUI 验收。
- 将发行材料／最终归档回归独立为 25 分钟步骤，保留生命周期组的 15 分钟期限及全部用例；修复未知后代进程夹具的目录清理竞态，原生确认进程退出后才删除工作目录，不将 HTTP 关闭标记当作退出证明。
- 卸载快照的 Windows reparse 辅助程序显式加载系统 Utility 模块，避免隔离环境中的自动模块发现耗尽测试期限；保留原生路径检查，辅助程序失败在 15 秒期限内返回脱敏错误类别，不等待整组超时。
- 根据 Windows 实测将完整加密备份往返独立为 25 分钟步骤、单用例 20 分钟；PostgreSQL／低权限 bootstrap 保留独立 20 分钟步骤。保留全部恢复拒绝、数据保留和原生权限回归，阶段计时不输出私有内容；unsigned Job 为完整检查与打包保留 120 分钟。
- 修复 Windows 打包期 PE 依赖解析器将合法的可执行文件／驱动模块导入误判为损坏 DLL 表；支持 PostgreSQL 扩展的 `postgres.exe` 与系统 `WINSPOOL.DRV` 等模块名，保留 basename、路径与表边界检查，不跳过固定运行时依赖预检。
- 修复 NSIS 自定义生命周期函数早于插件目录注册而导致 `StdUtils::TestParameter` 缺失的编译竞态；通过 `customHeader` 延迟展开函数，保留升级识别、卸载所有权检查与安装失败回滚，不依赖下载缓存命中顺序。
- 当前用户 Windows 安装器显式关闭 builder 默认的提权辅助程序注入，避免 `elevate.exe` 在所有权清单生成后被追加到最终归档；不放宽完整文件清单或删除安全检查。
- 桌面运行库明确改为仅执行应用的 Node 分发，不随包提供 npm/npx/corepack 或工具链安装脚本；固定官方归档与完整源文件清单仍校验，运行库 v2 记录准确裁剪规则，省略工具的原始许可证另行保留，完整 PostgreSQL 不变。旧完整运行库须在新目录重新准备；需要包管理器的外部 Provider 使用操作者另行配置的工具，不新增下载或凭据回退。
- 修复实际随包依赖的安全公告：Hono 2.1.3、MCP SDK 1.32.2、KaTeX 0.18.2、fast-uri 3.1.9/4.2.3；通过精确宿主覆盖保留封存 vendor 源码，tar 固定既有安全版本 7.5.22。保留完整 OSV 阻断门禁和 KaTeX 不可信输入回归；失败日志输出公开组件／公告身份，最终包文件数报告读取已验证归档而非已清理的 staging 目录。

- 登录后的工作区选择页改为账户菜单 + 工作区列表的轻量选择器：移除重复的登录成功展示、主页面刷新／账号安全入口和默认展开的创建表单；新建工作区改为 Dialog，示例项目默认不创建。单工作区自动进入，多工作区优先恢复本账号上次使用的工作区；`?pick=1`／`?create=1` 保留显式切换与创建入口。新增 `0054_workspace_creation_without_sample.sql` 允许无示例创建，跳过与示例记录共用原请求键并保持恢复幂等。
- 修复桌面关闭被 renderer 的离页保护静默阻止：窗口关闭、断开和退出共用明确的留在页面／离开确认，取消保留窗口与服务，失败保留可重试的清理状态。
- 修复当前会话模型参数使用旧 revision 导致“参数未保存”：保存前采用已接受的较新会话快照；真实并发冲突仍保留草稿、阻止发送，用户明确重试时重新读取后保存，不改新会话默认值。
- 纯 Chat scratch 新建时设置平台私有权限，复用时核验原目录身份；Windows 使用原生 ACL／reparse 检查，不再用 POSIX mode 判断。丢失、替换或不安全的既有目录仍拒绝，不自动修复或重建。
- Windows 私有状态目录／文件改用仅持久化已修改安全节的 ACL 写入，避免 PowerShell `Set-Acl` 额外写审计信息而要求管理员权限；PM 业务权限不变。Windows 普通用户与原生 GUI 验收仍须在对应平台执行。
- 桌面连接页与工作区窗口改为 Electron 原生 Overlay 的无边框标题栏：Windows/Linux 隐藏原生标题栏和菜单行但保留应用菜单快捷键，原生最小化/最大化/关闭按钮叠加到 React 顶栏；macOS 使用 `hiddenInset` 保留红黄绿按钮。PM、Agent、设置、Usage、登录和连接页顶栏支持拖动并避开原生控件，原生控件颜色随应用主题同步；普通 Web 布局不变。Electron GUI 拖动、双击最大化、缩放与 macOS 控件仍需对应平台验证。
- 桌面连接页仅保留本地工作台，移除远程服务入口、地址表单及相关说明；旧远程设置不再影响页面提交模式。现阶段不支持远程连接，本次不删除底层历史连接代码。

- 修复桌面／Web 新建项目原生模态框中的下拉菜单失效：负责人和保存模式菜单留在模态框内；目标日期提供选择入口，字段区分必填／可选，目录草稿不会被延迟回读覆盖。
- 新 Codex／Claude 配置入口默认未启用、不自动选择模型；Codex 原生 Home 证明接受经文件系统核验的同目录别名，保留不同 Home 拒绝与重启续接校验。
- Agent 设置限制正文滚动范围；PM → Agent 显示加载、取消与失败重试。桌面本地工作区提供原生目录选择，允许根与服务器核验保持一致。
- MCP／Skills 刷新新增的已启用 Provider，独立上下文可切换；已保存配置只核验原选定归属，最新目标列表单独读取，无关外部宿主登记不再阻止进入，也不自动扩张或重绑其权限，所选失效与真实冲突仍拒绝。本机原生 Skills 单独只读列出并可明确纳入管理，不自动分配或执行。远程／自定义 OpenCode 无法绑定本机目录时显示原因。
- 原生 Skill 纳入管理固定原选目录与文件身份，保留安全的根／内部别名，拒绝越界链接、循环和无法核验的 Windows reparse；私有暂存及复核后再发布副本和登记来源，不改原生部署复制语义或新增权限。
- 首次建号与明确新建工作区初始化独立、可编辑的 Nova 示例模板；27 个真实 Markdown 对象重映射 ID 与关系，不复制来源用户、权限、凭据或历史。迁移 `0052_workspace_samples.sql` 保存原初始化意图，增量 `0053_workspace_sample_storage.sql` 保存目录身份与初始化阶段：已证明的同目录 `prestate` 可续接，未知且没有合法 state 的目录、身份替换、已建立 state 丢失及尚未提交所有权的建目录中断均拒绝自动接管／重种；已有工作区不补种，未完成的新工作区不阻断其他可用工作区，readiness 不遗漏禁用本地项目目录时的既有核心权威。
- 工作区创建／恢复在服务端强制核对必填 `expectedActorId` 与实际认证主体，不匹配在副作用前返回 `409 session_changed`；前端保留原键、先查原结果，并在卸载、已观察到的会话变化或最新账号核验不匹配后停止跟进。不是新增权限或会话／持久化统一设计收口。

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
- 桌面连接入口改为 Dovspace 中文三步引导：选择本地/远程、设置账号或服务地址、进入工作台；统一暖灰/陶土视觉、深浅主题和窄屏布局。目录配置收进高级设置，备份恢复移入独立数据管理页；保留连接中的操作锁、密码清理、失败后断开和原始诊断，不改变 IPC、账号创建、目录校验或持久化格式。桌面页面属于随包资源，不是公共 Web 路由。
- Agent Chat 设置移除“本机服务”分组及诊断、数据与存储两个页面与路由；服务端诊断/存储读取接口保留，Agent 数据目录改由 `AGENT_WORKSPACE_DATA_DIR` 配置读取。
- Agent Chat 与 PM 共用同一表层规格：暖中性侧栏配白色正文与顶栏、12/16 元数据与 13/20 控件文字、30/36 导航密度、48px 顶栏、6px 控件圆角与实心危险按钮、暖陶土选中态，以及 PM 的信息蓝 / Agent 紫和低饱和图表序列；聊天阅读轴、双行会话与 Composer 结构保持独立。
- 错误页的状态图标与 HTTP 状态码改为纵向分离布局，避免图标徽标与数字重叠；紧凑模式按比例收紧间距。
- PM “Agent 助手”合并为文字与向下箭头共用的圆角下拉按钮，项目自动化选项位于上方，最下方可携带当前范围跳转 Agent Chat；配置页可标记快捷入口，沿用已保存定义、授权分页、revision 和原请求收据。原生 PM 分析可直接执行，其他动作保留确认；受理反馈链接到准确运行记录，不自动完成业务任务。

### 发布准备

- 根据桌面工程基准增加不可变 install stamp、PID＋创建身份停机、Windows per-user NSIS 离线预检与四模式精确卸载；保留项目源码、外部 Provider Home 和未知用户文件，超时或所有权不明拒绝删除。升级保留旧代码恢复记录，不声称数据库迁移回滚；macOS 保持 OS/Finder 管理。
- 新增默认关闭的 Windows 原生安装／覆盖／真实较低版本升级／中断恢复／四模式卸载驱动及 source/artifact/run/attempt 绑定 receipt；无窗口安装后 controller 不代表 Electron GUI，未执行原生矩阵不写成通过。历史发布授权不扩展到本次提交、推送或 dispatch。
- 桌面交付增加准确资产允许清单、实际成品 CycloneDX SBOM、OSV/SARIF 门禁、Windows 成品／安装后卸载器验签与最终 DMG 公证／Gatekeeper 检查；私有 NSIS 插件由签名容器覆盖。无版本源码组件明确保留来源而不伪造扫描结果；继续无自动更新。
- 新桌面备份使用 scrypt＋AES-256-GCM；恢复前验证完整性、同版本／同系统与空目标，并逐次确认可信来源。数据库 SQL 可影响目标以外的数据，加密不是作者认证或 SQL 沙箱。增加失效聊天目录恢复处理、IPC／导航／权限负面覆盖及互斥 payload 分解；Linux 真实服务、备份恢复烟测与原生安装／GUI 验收分开记录。
- README 整理为公共入口，完整用法与限制移至 `docs/guides/`；内部计划和历史验收原件留在本地，公共安装/检查不依赖它们。
- 当前架构/领域文档明确 Markdown、PostgreSQL、Agent SQLite 的不同权威，保留历史 ADR 和 INV/SC 追踪语义。
- 提供贡献与安全政策、工具链 doctor 和隔离 CI 入口；文档检查不再绑定内部27步实施计划。
- 修复 Claude 外部 CLI 交付边界：保留通信 SDK 与完整资源，但按包身份排除 SDK 的平台 CLI 执行包，并覆盖 Agent、自有桌面打包及独立 `pnpm deploy`／容器闭包；缺失或无效的用户 Claude 路径明确失败，不改用内置 CLI。保留 Cursor SDK 引擎／原生工具、SQLite、PTY，以及 Codex / Antigravity managed 和 ACP 原生安装语义；不宣称所有 Provider 都已切换为外部 CLI。
- 按只读 t3code 发布工作流与近期实际 stable/nightly assets 补齐本项目桌面交付设计；默认只构建 Windows x64 unsigned，不移植上游 CLI、便携版、自动更新/nightly、relay/mobile 或发布账号。最终 app.asar、unpacked 与受管 runtime 复用外部 Claude CLI 包身份检查；发行集增加准确源码/版本身份、对应源码与最终许可材料、非自引用 SHA256SUMS 和分层验证报告，Actions 只上传精确校验的完整材料。材料收集/测试包不代表签名、GUI、真实安装或正式分发授权通过，见[发布设计](docs/reference/desktop-release-alignment-2026-11-08.zh.md)与[Windows 操作手册](docs/reference/windows-build-runbook.zh.md)。
- 加固发行材料的派生边界：源码根及全部祖先复用现有安全目录/文件句柄检查，拒绝内部 symlink/junction、身份漂移和构建期间公开选集变化；dirty 由实际字节/模式与固定 HEAD 对象比较，不能被 assume-unchanged 隐藏。legal 目录复制后按自身根重新检查链接，成品 ASAR 摘要必须匹配原验证报告，不能用同名称/版本的另一份归档替换。
- Windows 桌面源码捕获/复核增加祖先及选集的有界原生属性预热（每批至多 256 路径 / 128 KiB），保留逐文件身份/时间戳、reparse、TOCTOU、SHA256、Git dirty 身份及最终发行门禁；UNC/不规范根及设备名/尾点组件在预热 I/O 前拒绝。打包新增独立于 manifest 的阶段 start/end/failure、真实属性进程次数/耗时、文件/字节及缓存命中率记录；显式 benchmark 使用精确冻结旧模块、相同 helper/依赖及同输入新进程比较，不在每次原生 CI 中重复慢旧路径。新增 Windows 真实 helper 回归覆盖预热后替换/正文/junction、批次边界和安全多文件捕获；本轮 Linux 最终受影响 32 项、此前未受影响 blobs 10 项通过与 12 文件等价 smoke 均不是 Windows 提速或原生验收，后端隔离编译仍有既有错误，尚无新的原生执行/Actions 结果，详见[计时与证据边界](docs/guides/desktop.md#源码捕获计时与-windows-回归)。
- 对应源码补齐根 `turbo.json`：Git 与 gitless 选集、内容清单、实际源码归档和构建后复核统一保留该构建配置，修改或移除仍拒绝交付；私有路径与生成物排除规则不变。
- Windows 路径属性查询改为一次编译后复用进程私有、身份/时间戳绑定的 C# helper，编译前拒绝已有输出；非跟随 Win32 句柄、文件身份和 Write/Change 时间戳、批次与缓存守卫不变。增加顺序写入及 bootstrap 阶段计时，保留 180 秒超时与安全/恢复断言；源码捕获测试只约束真实拒绝而不绑定内部文案，通知迁移测试保留 0026 即时检查后再推进当前 schema，未改生产迁移。限定 Linux 类型/lint、源码归档/文件系统及真实 PG16 通知迁移回归已通过；Windows 原生行为与启动耗时以对应平台 Actions 实测为准，不能由 Linux 结果推断。
- 桌面依赖改为 PM、Agent、Electron 各自独立的物理生产 `node_modules`，保留版本/peer 上下文、完整包资源和 Agent Effect 4.0.5 单实例，不跨闭包按 hash 删包。成品门禁需全功能 7-Zip，检查实际 NSIS 内层 payload 与 macOS DMG/ZIP 的依赖图、资源摘要及文件数/逻辑字节；`--native-smoke` 改用最终提取资源，`--installed-resources` 可将所供资源树精确绑定当前发行文件。控制器仍来自构建检出，均不代替安装/升级/卸载或 Electron GUI；本轮最新授权覆盖所有当前可公开源码更新，以主分支既有修复和性能优化为准，先集成审阅增量并在主分支源码上测试，有实际问题先修复并复验；门禁通过并冻结后精确提交、公开推送并只手动触发一次 Windows-only unsigned 构建，不下载安装器或发行材料。授权不是成功证据，不宣称尚未实测的新安装器体积或原生验收结果，详见[桌面指南](docs/guides/desktop.md)。
  随包 `jp` / `yaml` 的 PowerShell 命令桥接在 Windows 显式查找 `node.exe`，启动失败返回非零并保留实际 Node 退出码，不再把未启动命令误报为成功。
- 原生安装包工作流支持只运行 Windows x64，不启动 macOS Job；修复 MSVC 链接器帮助返回 1100 时被构建预检误报为缺失，仍拒绝缺失工具、真正链接错误和无效帮助输出。
- Windows 桌面打包增加安装文件数预算（45,000）与 `payload-report.mjs` 分布报告，Windows 仅保留 `zh-CN`/`en-US` Electron locale；记录 t3code `server.asar`/native-only 的优化方向。预算以最新 unsigned 安装树 39,809 文件为基线，超过即失败；不改卸载器、runtime 布局或用户数据删除语义，真实安装/卸载耗时仍须对应平台验证。
- 新增 [Hermes Agent 桌面基准](docs/reference/desktop-benchmark-hermes-agent.zh.md)、[Cherry Studio 桌面基准](docs/reference/desktop-benchmark-cherry-studio.zh.md) 与[合并索引](docs/reference/desktop-engineering-benchmark.zh.md)：只读记录安装戳/所有权、卸载模式、数据保留、NSIS 预检、签名/更新和发布复核，并给出 Dovspace P0/P1 差距与目标文件；不代表原生安装/升级/卸载已执行或通过。
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
- 对齐隔离 CI 的 static/build/host/backend/agent 与 TypeScript host，保留声明、完整类型、真实回归/来源门禁和 dotenv 隔离。共享 `check:turbo` 覆盖六 lint、九声明/类型/产品构建叶及独立 host；在新的 linked worktree 实现完整公共输入/输出缓存与恢复前所有权/路径/陈余检查，不缓存真实测试、业务数据、来源/许可/合同或 fixture。`check-ci` 增加互斥 `--baseline` / `--cache-name` 保持完整覆盖；agent/all 显式认证固定 PUBLIC OpenHands source，原真实 authoring 用例完整执行；runner 每次 dispatch 保留 pnpm `error`/依赖新鲜预检。Actions 仅 trusted 默认分支 push/manual restore/save，PR/fork/其他分支不共享 cache；restore 前安全准备三个 0700 目录，不 chmod/chown 既有目录，无外部 cache 账号/secret。[当前用法](docs/guides/development.md#turbo-显式任务调度与本地-lint-缓存)与[17 项完整任务/证据表](docs/reference/turbo-rollout-plan.zh.md)保留旧历史、原失败及全部独立边界，不设新的阶段批准停点。
- 本轮 16 工程叶匹配 baseline/MISS/HIT 每组 n=3，中位 **178.507/182.319/13.388 秒**；MISS 各 0/16、HIT 各 16/16，暖降约 92.50%、空 task-cache MISS 增约 2.14%。8 roots 删除/陈余后均恢复相同 2121 files/197 dirs 与 byte/mode；恢复 Agent/声明产物上完整 Agent 166/166 文件、1434/1434 passed、0 skip，最终行为 76/76。client 完整类型的真实 TS2322 两次同 hash MISS/exit 1、无失败 archive，较窄声明仍成功；真实输入矩阵、合成隐私扫描、本机 tar transport 后 16/16 HIT 与独立 fresh static/build/host 已有证据。首轮因合法公开源硬链全 bypass 的 pair 保留并排除统计；Gateway changed 8 HIT/8 MISS、161.982 秒仅 n=1，不当作稳定收益。
- TypeScript host 独立/随包构建共享实际 esbuild metafile 的有界 npm notice 收集，保留五份原法律/来源文件；standalone 原 manifest 字段保留、增加 files，bundled verifier API 不变且递归检查 byte/mode/未知/缺失/symlink。两份实际 index 各 22 npm packages；删嵌套 LICENSE 真实拒绝、HIT 恢复后通过。Web 仅隔离检查清空 dist、普通部署保留旧哈希；tracked CSS 不删除/恢复，Astro check scratch 非权威。notice/来源完整性不关闭四项发行许可 blocker。
- 上述是**本机工程反馈与独立阶段/消费者证据，不是完整 CI 提速或 hosted 成功**。本轮默认 `all --baseline` 的 static/build/host 通过后，在 MinIO Docker FROM 镜像域名 DNS 失败，0 backend 用例、Agent 未被该轮执行，cleanup 成功；独立 Agent/阶段不拼接成 all 通过。没有触发真实 hosted workflow，没有真实 Provider/原生平台/生产或正式发行完成结论。3224 仅核验现有归属/健康与真实登录页，未覆盖 parallel primary/live 产物；原树外部并行 CHANGELOG 变化保留。

### 尚未作为发布保证的事项

- Agent 仍为本机单操作者，非多租户产品，cwd 不是文件沙箱；会话与持久化统一设计未收口。
- 单 API/本地 Markdown 核心、同工作区写入串行；无自动孤立文件 GC、通用业务 Runner、多实例/HA 或公网生产验收保证。
- Windows/macOS 为桌面交付目标；`a063dc0` 原生 CI 历史通过不代表当前树、正式签名/公证、安装卸载或 GUI 验收。没有确认的正式下载/自动更新地址。
- 真实 Provider/账号/额度、SMTP/S3/Webhook、私密漏洞报告渠道、生产恢复与真实设备仍须逐项配置并验证。文档、构建、fixture 或健康检查均不能替代这些结果。
