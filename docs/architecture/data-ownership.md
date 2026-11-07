# 数据所有权与一致性

本页描述当前权威，不沿用早期 SQL 核心 `entities` 一表拥有全部任务的描述。历史取舍保留在 [ADR-0002](adr/0002-first-stage-backend.md)；后续已采纳的文件权威决策见 [ADR-0003](adr/0003-markdown-core.md)。

| 数据 | 权威与保存位置 | 保护 / 可重建性 |
| --- | --- | --- |
| 九类核心实体、正文和正式关系 | 未映射项目在 `CORE_WORKSPACE_ROOT/<workspaceId>`；已登记本地项目在所选目录 `.pm/core/` | Markdown为权威，稳定 `PRJ-001` / `TASK-102` 等ID，不用SQL任务副本代替 |
| 工作流、字段、保存视图、排序 | 共享工作区 `.pm/config.yaml` / `.pm/views/` | 权威配置；合法缺省使用内置配置，但已存在内容必须校验 |
| 统一ID、幂等、墓碑、目录映射、事实观测与恢复 | 共享工作区 `.pm/state/`；项目 `.pm/project.json` 固定workspace/project/storageId | 不可当缓存删除；私有恢复journal可含任务正文前后内容/自动化快照，不是脱敏日志；缺失已有state/身份时拒绝空白初始化 |
| 核心查询索引 | `.pm/cache/index.sqlite` | 可从权威文件重建；不是Agent聊天数据库 |
| 用户、认证会话、成员/能力 | PostgreSQL身份/访问模块 | 会话存摘要；当前授权逐次检查；历史成员引用不自动获得现行权限 |
| Intent/Decision、评论、审核/证据/提交、Dashboard与项目协作附加事实 | PostgreSQL所属应用模块 | 保留不可变历史和当前版本；不能覆盖核心状态或创建SQL任务权威副本 |
| 命令结果、审计、outbox与变更流 | PostgreSQL `command_receipts` /审计/事件表 | 原主体/workspace/commandId收据；原生文件写入与SQL审计使用journal恢复，不伪称跨介质原子提交 |
| 修改前后版本与个人已阅位置 | PostgreSQL `change_history_*`；核心文件受控写入及磁盘观测先保留共享 `.pm/state/change-snapshots/` 不可变分块快照，外部文档操作保留私有原操作证据 | 历史与当前 Markdown 权威分离；采集账本只保留引用，正文不进入公开审计/outbox/通知。当前及历史来源授权逐次检查；个人水位不改任务、通知或人工验收 |
| 附件元数据与字节 | 元数据/引用在PostgreSQL；已登记项目字节在 `.pm/attachments`，旧项目在原Local/S3 | 持久storageId/marker定位历史版本；不可变字节、SHA-256及8MiB上限；不自动物理GC |
| Agent Workspace目录登记与私有对话scratch身份 | Agent私有SQLite `agent:workspaces:v1`／`agent:scratch:v1`，scratch内容在数据目录的`chat-scratch` | 独立于PM；元数据revision CAS与设备/inode核验，路径身份不改写，不自动复制仓库或补建丢失目录。`0051`退役旧PM Code Workspace登记表 |
| Chat线程/消息/输出、执行选择/冻结环境、Provider续聊、工具/任务交付/工作流等记录 | Agent私有SQLite `durable/store.ts`及应用拥有目录 | 单进程所有权和CAS；旧Session仅显式停服清理，保留业务证据；不是PM任务事实源，不按PM成员实现多租户会话隔离 |
| Workspace／Session Terminal及输入确认/有界输出 | 当前Agent服务内存与其拥有的PTY进程 | 断开视图不终止；当前授权/目录身份复核；服务重启不恢复进程或重放命令，终端cd不改变Session主目录 |
| Provider账号/原生历史 | 驱动原生Home/外部环境，或明确选择的应用私有managed状态 | 不统一搬入应用目录，不自动复制/删外部账号；缓存/用量记录不能证明远端余额或执行成功 |
| 浏览器草稿、偏好、个人白板 | 当前origin/账号/workspace及功能定义的浏览器存储或内存 | 非跨设备统一持久化；外部文档正文草稿仅内存，刷新前须显式保存 |

## 一致性与身份

同一Workspace的受控写入仍使用规范化UUID的PostgreSQL advisory lock串行协调，并执行文件revision/CAS、幂等journal和SQL审计恢复。文件系统写入不能由数据库rollback撤回；外部编辑、Git、Provider或接收器也不是本地事务的一部分。响应未知保留原请求和冻结输入，查询/恢复原结果，不能仅因404或超时换键重放。

核心ID与PM附加对象UUID分开。查询和授权依据当前权威文件/成员范围，异步投影和目录位置不是授权；历史owner/assignee/审核引用与当前有效成员资格分开。当前任务完成按原生配置工作流和独立能力执行，Submission/Review是独立附加流程，不恢复旧SQL的强制完成前置。

SQL SSE使用Workspace级数字cursor，以字符串传输但按数字排序；核心SSE、通知delivery cursor和事实sequence各有含义，不可混用。SQL事件默认保留7天，过期410后重读快照。失败outbox达到10次隔离相关Workspace；修复后由操作员受审计重试原事件，不跳过或伪造成功。

变更历史 sequence 与通知 cursor 分离：查询固定本次历史 head，只有服务端向该主体、目标及关联范围发出的观测凭据才能确认相同水位；单调更新各来源的个人已阅位置，不清除之后的修改。任务正式需求/文档关系各有审阅位置，不能用自有任务的已阅状态吞掉新关联文档的旧历史。历史正文只在已授权的具体差异查询中读取，列表和看板提示不加载全量正文。

核心受控修改通过原 mutation 证明与私有 journal 恢复，普通保存结果不明时不重放文件写入，也不以当前内容替换原快照。首次外部观测是基线；后续只证明观察端点。快照缺失、来源重绑定或权限不足明确失败；`.pm/state/change-snapshots/` 不是可丢弃缓存，须随完整 PM checkpoint 备份。

## 单写与备份

核心只支持单API/单宿主本地文件系统写者。Worker读取核心事实，不初始化第二个Workspace/watcher；S3只改变不可变附件的存储，不实现核心多写或HA。目录缺盘、身份冲突、符号链接或损坏拒绝访问，不创建空替代根。

私有恢复journal/备份可能含description前后内容、任务正文和自动化来源快照，不能按公开审计日志处理或上传。完整PM备份必须在API/Worker及外部核心编辑器停写后覆盖同一SQL/core checkpoint、全部登记项目托管 `.pm`、共享配置/state、引用附件及存储身份。Agent离线备份另行处理私有SQLite/会话，不能替代PM完整备份；外部源码/文档目录/Provider Home和浏览器存储不因此自动纳入。恢复使用新库/新根/新存储身份并核对摘要、账号信任、通知和外发围栏，不覆盖源业务实例。操作见[部署手册](../../deploy/README.md)和[Agent备份指南](../guides/agent-chat.md#agent-离线备份与恢复)。

**会话与持久化尚未统一设计收口，当前仍暂沿用Agent Chat。** SQLite、PostgreSQL、Markdown和外部副作用之间没有全系统原子提交/撤销保证；恢复检查通过也不证明Provider已登录或业务验收完成。
