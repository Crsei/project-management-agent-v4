# PM 目录型文档来源实施清单

状态：实现、专项真实 PG 回归与浏览器验收完成；全仓回归未通过，具体限制见第六节。来源：用户确认的目录文档计划及本轮明确实施授权。范围为本仓库，未创建 PM 业务任务、未发布业务计划。会话与持久化尚未统一设计，继续沿用 Agent Chat；本次不调整聊天保存方式。

## 1. 目标与边界

- PM 文档页右上角增加“文档来源设置”，按工作区或项目关联一个后端可访问的已有目录。
- 递归发现该目录及子目录内所有普通 `.md` 文件（扩展名大小写不敏感），无需 PM frontmatter、ID 或标题。文件名与相对路径共同区分文件。
- 原有 PM 文档保持现有创建、编辑、revision 和详情入口；目录文件明确标识外部只读来源，不能伪装成 PM 实体或附件版本。
- 后端按需读取正文；页面提供安全 Markdown 预览。外部新增、修改、删除在进入页面或显式刷新后反映，不引入后台监听。
- 不复制、移动、改写或删除源文件，不创建目录；取消来源只清除配置且保留 revision。配置独立于 Agent cwd，可显式选用已有 Agent 区域路径但不能更新它。
- 路径是后端机器的路径，不是浏览器电脑目录。保存前进行实际预检；目录丢失或身份变化不回退、不重建。
- 每个工作区/项目各一个来源；文档页可切换来源范围。来源可以复用或包含 Agent/原生项目目录；只有已配置的文档来源之间不得相同或互为父子目录。文件按来源内相对路径去重，不按同名或正文相同误删不同文件。

## 2. 复用及安全约束

复用 `packages/application/src/agent-file-areas.ts`、`agent-storage.ts` 与本地目录的 allowedRoots/身份校验模式；复用现有认证、workspace/project ACL、目录管理能力，不新增权限体系。配置管理要求当前无限制工作区 access.manage、planning.edit 及实际读取能力；内容读取要求 domain.read 和对应 scope，工作区源不对仅项目成员开放。普通读者只获得相对路径，主机绝对路径仅向现有允许查看路径的管理者返回。

每次配置、枚举、读取均检查当前授权及目录身份。拒绝路径穿越、绝对文件路径、软链接（含中间路径）、特殊文件、越界和目录替换；安全检查不能仅在保存时执行。Agent cwd、原生项目目录和历史存储操作不再作为互斥的文档来源。枚举前过滤当前成员无权读取的原生项目子树及其他工作区的已登记项目/Agent 区域；文件正文同样检查，不泄漏被过滤路径，也不因嵌套关系使整个来源失效。原有核心/凭据/私有存储边界不能通过这个入口绕过。

列表分页必须可穷尽；扫描失败/安全排除/资源限制不能伪装成完整或空列表。大文件读取按现有文件大小保护明确拒绝，不静默截断正文。Markdown 使用已有安全渲染机制，禁止原始 HTML/脚本及越界相对资源请求。INV-01/20、SC-14/20、INF-01/04/05/06 为相关隔离、权威读取、持久化与合同依据，不改变旧业务完成规则。

## 3. 共享 HTTP/TypeScript 合同

新合同归 `packages/contracts/src/document-sources.ts`；后端 owner 创建并维护该文件。前端只导入类型，不另建竞争合同。HTTP 路径均在 `/api/v1/workspaces/:workspaceId/document-sources` 下，复用 PM Cookie/Bearer 和 Origin 校验，响应 private/no-store。`scopeKey` 固定为 `workspace` 或真实 `PRJ-*` ID，禁止任意路径成为 scope。

- GET 基础路径：`{ sources: DocumentSource[] }`，返回当前可见的工作区及项目配置（含 unconfigured 项），用于来源/作用域选择。
- POST `/preview`：`{ projectId: string | null, path: string }`；返回 `{ path: string, readable: true }`。仅管理者可用，只校验、不创建或保存。
- PUT `/:scopeKey`：`{ path: string | null, expectedRevision: number }`；null 解除关联。返回 `{ source: DocumentSource }`。CAS 冲突不能覆盖；未知响应先 GET 核对，不盲重发。
- GET `/:scopeKey/files`：可选 `cursor`、`limit`（默认 200），返回 `DocumentSourceFiles`。
- GET `/:scopeKey/content?path=<编码相对路径>`：返回 `DocumentSourceContent`。服务端根据当前 scope 配置解析，不能由调用者提供绝对根。

```ts
export type DocumentSource = {
  projectId: string | null;
  name: string; // 当前真实工作区或项目名称
  path: string | null; // 仅可披露路径的主体可见
  revision: number;
  status: 'unconfigured' | 'available' | 'unavailable';
  canManage: boolean;
  reason?: string;
};
export type DocumentSourceEntry = {
  path: string; // POSIX 风格相对路径，同时作为当前来源内身份
  name: string;
  size: number;
  modifiedAt: string;
};
export type DocumentSourceIssue = { path: string; code: string };
export type DocumentSourceFiles = {
  entries: DocumentSourceEntry[];
  nextCursor: string | null;
  scanComplete: boolean; // false 必须展示扫描不完整
  issues: DocumentSourceIssue[];
  sourceRevision: number;
};
export type DocumentSourceContent = {
  path: string;
  content: string;
  size: number;
  modifiedAt: string;
  sourceRevision: number;
};
```

新字段或错误语义确需调整时，由后端 owner 通知前端、验证 owner 与集成者，不静默偏离合同。分页必须检测配置变化/目录变化导致的无效游标并提示重新读取，不能混合不同来源。具体稳定游标实现由后端 owner 选择已有模式下的最简单安全实现。

## 4. 任务清单与分工

| 编号 | 状态 | owner | 成果与验收 | 前置 |
| --- | --- | --- | --- | --- |
| D1 | 已完成 | 主线程 | 核对文档/Agent 文件区域/目录授权，保存本清单和共享合同 | 无 |
| D2 | 已完成 | Backend 子代理，gpt-6.1-sol xhigh | 来源 schema/持久化迁移、配置预检/CAS、授权列表、递归分页与安全正文读取、API 合同；不更改 Agent cwd | D1 |
| D3 | 已完成 | Web 子代理，gpt-6.1-sol xhigh | 右上角设置、来源切换、原生/外部区分、所有分页及层级、刷新与只读预览、错误与窄屏；保留原生编辑 | D1 |
| D4 | 已完成 | Verification 子代理，gpt-6.1-sol xhigh | 真实 PG/HTTP 行为回归、隔离浏览器夹具，覆盖持久化、CAS、ACL、目录变化、分页、路径攻击及原文件不变 | D1 |
| D5 | 已完成 | 主线程 | 浏览器、Web 检查、后端构建和专项 11 个测试通过，无跳过；全仓检查的未关联失败和中断明确记录，不宣称全绿 | D2、D3、D4 |

D2、D3、D4 在共享合同下并行；D5 depends_on D2/D3/D4。没有循环或缺失前置。

文件所有权：D2 拥有新的后端/application/infrastructure/contracts 源文件及迁移、PM app 注册、OpenAPI 生成源；D3 拥有受影响 apps/web 文件；D4 拥有新增 tests/document-sources*.ts 和临时浏览器验收脚本。主线程拥有本计划、README 文档与最终集成。保留所有无关并行修改；子代理开发中不运行构建、lint、测试、格式化，统一在汇合后运行，避免并发资源冲突。

## 5. 验收清单

- [x] 根目录、多层子目录、同名文件、中文/空格路径、无 frontmatter、`.MD` 正确列出；非 Markdown 不列出；超过单页后仍可看到全部结果。
- [x] 配置与解除跨重启保留；并发旧 revision 保存被拒绝；响应未知先读取配置核对。
- [x] 原生 PM 文档创建/编辑保持；外部来源无编辑/删除/上传副作用，选中和返回范围正确。
- [x] 浏览器从右上角完成预检、保存、列出、打开阅读；工作区与项目均可设置。
- [x] 磁盘新增/修改/删除后刷新反映真实状态；已打开文件删除明确显示不存在；配置切换清除旧来源正文。
- [x] 未授权、撤权、仅项目成员、跨工作区/跨项目、重叠目录不能泄漏；管理路径不向普通读者暴露。
- [x] 穿越、软链接、目录身份变化、不可读目录、特殊文件、超大正文有真实失败反馈；不静默截断或虚报扫描完成。
- [x] Markdown 脚本/HTML 不执行；宽屏、390px 窄屏和键盘弹窗可操作。
- [x] 受影响 lint、类型、测试、构建及专项真实 PG 回归通过；跳过不计通过。真实浏览器与工程检查分别记录，全仓回归限制另列。
- [x] 使用随机 schema/临时目录/临时端口验收；核对 PID/cwd，不重启既有业务实例、不读取业务账号凭据、不提交或推送。

## 6. 实际证据

### 浏览器与实际运行

使用自建随机 PostgreSQL schema、临时目录和独立 API/Web/登录辅助端口；未操作常驻 v4 业务实例。实际浏览器完成：

- 从右上角配置项目乙来源、预检、保存、阅读；工作区列表首批 200 条，继续加载至 223 个 Markdown 文件。项目甲 11 个文件，切换后旧正文被清除。
- 阅读中文/空格路径及深层同名文件；磁盘新增、修改、删除后刷新反映真实内容，已选文件删除后不继续展示旧正文。
- 真实 CAS 冲突保留输入，读取最新 revision 后可再次预检保存；对成功 PUT 刻意丢弃响应，页面随后 GET 核对，没有第二次 PUT。
- 只读成员无法保存且看不到绝对路径；仅项目成员只看到项目甲。通过真实 `RevokeWorkspaceMember` 撤权后，受保护页面被清除，旧正文不再存在。
- 初次验收中缺失目录预检失败且不创建目录；当时包含已登记项目的父目录也被拒绝，此旧规则已按第八节用户要求替换。含软链接/特殊文件的来源显示“扫描不完整”；超大正文后端返回 413。解除关联后页面显示未关联，源文件仍存在。
- 原始 HTML、脚本、危险链接和相对图片均未执行/加载；宽屏与 390px 窄屏无水平溢出，弹窗键盘关闭有效。
- 原生 `DOC-001` 在既有 Markdown 编辑器修改并显式保存，再 GET 原生文件接口确认正文和新 revision；目录来源不替代原生编辑。
- 对 249 个未被验收脚本主动修改的原始文件逐一校验 SHA-256 全部相同。另有 1 个主动编辑、1 个主动删除和 1 个主动新增，专用于刷新验收。

非凭据证据保存在本地 `.local/document-sources-browser-evidence.json`，不作为业务数据或提交内容。临时浏览器脚本已移除。夹具退出时报告非干净关闭；独立检查确认其随机 schema、临时根目录及三个监听端口均已释放，未停止其他服务。

### 工程检查

- `pnpm check:web`：lint、TypeScript 和 Vite 构建通过；保留既有大 chunk 警告。
- `pnpm build`：后端 TypeScript 与构建资产通过。
- `node --test packages/infrastructure/tests/document-source-files.test.ts`：3/3 通过，无跳过。
- 首次 `pnpm check` 类型检查发现 Node strip-only 不支持的构造参数属性及 exactOptionalPropertyTypes 问题，已修复。后续运行的 docs/合同/lint/typecheck 通过，但测试有一个新增底层错误类型的实现细节断言失败（已删除，HTTP 层保留消费者行为覆盖），另有既有 dashboard-sprints 测试超时；该次全量检查不能算通过。
- 最终 `pnpm check:docs && pnpm contracts:check && pnpm lint && pnpm typecheck` 全部通过：121 份 Markdown、27 个计划步骤、OpenAPI 112 个命令类型及 93 条路径。
- `pnpm test:backend` 在 60 分钟命令上限被终止，完成到 59/120 个文件；已有摘要计 455 个测试，454 通过、1 失败、0 跳过，另有缺失摘要，不得认定全量通过。失败是未关联的 `tests/agent-chat-tools.test.ts` 将工具数量固定为 13，而当前注册表为 17；未改动该并行工作。`automation.integration.test.ts` 被终止而非通过。目录文档 PG 用例尚未轮到，因此另行使用同一串行 runner 执行本次三个文件。
- 目录文档专项串行回归：`TMPDIR="$PWD/.local/document-sources-tmp" CHOKIDAR_USEPOLLING=true node --env-file=.env scripts/backend-tests.mjs files -- packages/infrastructure/tests/document-source-files.test.ts tests/document-sources.integration.test.ts tests/document-sources-security.integration.test.ts`。3 个文件、11 个测试全部通过，0 失败、0 跳过、0 取消，约 619 秒；其中 8 个真实 PG/HTTP 用例覆盖跨重启配置/解除、CAS、分页与游标失效、ACL/撤权、身份替换、不可读目录、越界/链接/特殊文件/超大正文及动态注册项目后的重叠检查。
- 首次并发夹具初始化有迁移锁/启动超时与一个 503，未将失败或跳过计算为通过；以上专项回归在停止浏览器夹具、使用既有串行 runner 后完整通过，没有扩大测试超时或放宽业务断言。

### 发布边界

初次源码交付包含迁移 `0039_document_sources.sql` 与配套 API/Web，当时未迁移业务数据库或重启现有服务；常驻部署修复见下一节。不连接其他副本，不调整 Agent 执行路径，也不扩展聊天持久化设计。

## 7. 常驻设置入口故障修复（2026-10-30）

- 用户报告设置弹窗显示“范围当前不可访问”。实际原因是页面已更新，但常驻 API 仍为旧进程：直接访问 4194 及经 3224 网关请求目录来源接口均返回 Fastify `Route ... not found` 404，而非授权拒绝。数据库仅应用到 `0038_unified_agent_tools.sql`，缺少 `document_sources` 表。
- 核对本副本数据库 `127.0.0.1:55444`、全部已应用迁移摘要及待应用清单，确认唯一待应用项为仅新增配置表的 `0039_document_sources.sql`；执行 `pnpm db:migrate` 后 schema 就绪。
- 校验 API 的 PID、启动身份、命令及 cwd 后仅向旧 API 23399 发送 SIGTERM，使用既有服务管理器启动已构建的 API，当前 PID 18573。Worker 23398、Agent 20047、网关 23401 均保持原进程；未修改目录配置、项目文件或权限。
- 真实 3224 入口 `/health/ready` 返回 200，database/storage/worker/core 均为 true。未登录调用目录来源接口正确返回 401，不再是路由 404。
- 使用浏览器已有登录会话打开实际工作区文档页，目录来源 GET 返回 200；弹窗列出工作区 `Project Management` 和项目 `PRJ-001`，均为 `unconfigured`、revision 0、可管理。实际切换项目后目录输入可用，“范围当前不可访问”不再出现。只查看与切换范围，没有代用户保存任何目录或读取账号凭据文件。
- 本次是部署修复，没有修改应用源码，不将历史专项回归结果冒充本次重新运行；本次验证为真实 API、数据库 schema 与浏览器表面，另运行文档检查。

## 8. 目录嵌套与重复收录规则修正（2026-10-30）

- 用户明确要求：不能因为来源目录与 Agent/项目目录存在父子关系就拒绝；只禁止多个已配置的文档来源相同或互为父子目录，避免重复文档。当前仍沿用每个工作区/项目一个来源，本次不新增多目录配置形状。
- `assertClaims` 仅查询有效的 `document_sources`；不再把 Agent 区域、原生项目登记或历史目录操作当成竞争来源。现有全局目录事务锁仍串行化两个重叠来源的并发保存，解除关联后目录可重新选用。
- 授权在枚举与正文读取时执行：可读原生项目子树正常递归，不可读子树在扫描前跳过，正文请求返回 404；问题仅返回根级 `scope_excluded`，不暴露受限文件名。其他工作区的登记项目/Agent 区域不借此开放。保留私有目录、文件身份、链接、大小及 UTF-8 检查。
- 页面明确说明“仅已配置的文档来源之间不能相同或互为父子目录”，冲突提示不再把 Agent/项目目录误称为不可选来源。同名不同路径的 Markdown 保持独立，`.pm` 原生文档不重复纳入外部列表。
- 已在实际 3224 页面预检用户给出的工作区目录，以及 PRJ-001 自己的原生项目目录；两次均返回 200，显示“现有目录预检可读”，保存按钮可用。只预检，没有代用户保存或解除任何业务来源。
- 已更新并构建 API/Web，只重启本副本 API；Worker 23398、Agent 20047、网关 23401 保留。`pnpm lint && pnpm typecheck && pnpm build` 和 `pnpm check:web` 通过。
- 本次专项串行回归 3 个文件、12 个测试全部通过，0 失败/跳过/取消，约 698 秒。新增行为覆盖：工作区 Agent 父目录与原生项目目录可用、注册新项目不使来源失效、同名不同路径与完整分页、相同/双向父子来源拒绝、并发重叠只允许一个成功、解除后重新使用、无权项目子树与文件名不泄漏、权限收窄后旧游标失效。
- 文档检查通过（123 份 Markdown）。额外 `pnpm contracts:check` 报告 `docs/contracts/openapi.yaml` 生成物过期；本次未改 HTTP schema，也未覆盖其他并行工作的生成合同文件，不将该检查记为通过。历史全仓检查的限制仍见第六节。

## 9. RunLedger 工作区文档接入（2026-10-30）

- 用户指定读取 `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger` 的 Markdown。诊断时工作区实际保存的仍是旧 `.local/projects/<workspaceId>`（revision 1）；列表为 0，仅发现被排除的项目 `.pm` 数据。预检不会自动保存来源，未关联的目录不会出现在列表。
- 本地 `allowedRoots` 原先仅含本仓 `.local/projects`；在保留原配置的基础上加入 RunLedger 精确根路径，没有放开其父目录。只重启本副本 API 使配置生效；未修改 RunLedger 文件、项目默认创建目录、Agent cwd 或其他服务。
- 在实际 3224 浏览器设置中，将工作区来源从原先没有外部 Markdown 的目录切换为 RunLedger，预检后显式保存；后端 revision 2、状态 available。刷新整个页面后重新读取仍为该配置。
- 浏览器“外部目录 · 只读”实际分页加载 200 → 400 → 600 → 762 条，全部路径唯一，无后续页。打开根 `README.md` 显示“RunLedger”，打开 `docs/README.md` 显示“RunLedger 文档总览”；后端返回根 README 正文的 SHA-256 与磁盘文件一致。
- 762 为安全扫描返回的普通 Markdown 数量，不包含被排除私有树内的文件。当前扫描问题为 7 个私有路径、190 个硬链接、22 个软链接和 2 个特殊文件；未触发扫描/深度/问题数量上限，也没有单独被拒绝的 `.md` 文件路径。页面仍明确展示排除提示，未伪称整个磁盘目录无排除。
- 本次仅变更本地配置与真实来源映射，未修改应用源码。验证为真实浏览器、后端列表/正文、磁盘摘要及页面重载持久化，不重复沿用先前测试为本次执行结果。
- 本次 `pnpm check:docs` 未通过：README 的 `v4-usage-page-replica-plan.zh.md#8-实施与验收记录2026-10-30` 锚点未解析。该链接属于未关联的并行修改，未在本次目录接入中覆盖。
