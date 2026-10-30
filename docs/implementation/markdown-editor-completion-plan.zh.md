# Markdown 内容直接编辑与功能补全计划

## 目标与验收原则

用户要求基于 Obsidian 编辑清单及插件参考补全文档能力，使用 gpt-6.1-sol / xhigh 子代理实现；打开“内容”页面即可输入，不再以“先点编辑/源码”替代直接编辑。

- 内容页默认是正文 Markdown 编辑器，提供工具栏、右键菜单、实时预览；完整源码页保留 YAML 原文。两者修改同一个 `{raw, revision}` 草稿，不引入 HTML 往返转换或第二份文档。
- 源码、属性、检查清单、嵌入视图保留原项目/权限/冲突规则。编辑动作不自动完成任务。文档正文实时保存默认开启（停止输入后写入），任务结构化字段与检查项仍显式保存，草稿恢复与未知结果核对继续有效。
- 菜单命令必须有真实行为和适用条件；禁用项给出真实原因，不能以 mock、空处理器或复制配置冒充能力。
- 现有业务数据不作冒烟夹具。使用隔离 PostgreSQL、临时端口与 Markdown 根目录验证，最后只更新用户授权的示例 DOC-001。

## 技术选型与参考

| 参考 | 核对到的技术 | 本项目采用方式 |
| --- | --- | --- |
| [cMenu](https://github.com/chetachiezikeuzor/cMenu-Plugin) | TypeScript、React 17、Obsidian API、SortableJS，MPL-2.0 | 借鉴格式工具栏交互，不复制插件代码，不引入 Obsidian 运行时 |
| [Awesome Format Bar](https://github.com/AwesomeDog/obsidian-awesome-format-bar) | TypeScript、Obsidian API、esbuild、vanilla-picker，MIT | 借鉴命令分组、上下文工具菜单、表格和颜色操作；用本项目 React 组件实现 |
| [Notion Flow](https://github.com/xinli12/obsidian-notion-flow) | TypeScript、CodeMirror 6、Lezer Markdown、esbuild，MIT | 与本项目 CodeMirror 6 / React 19 / Vite 8 对齐；采用基于文本范围的编辑事务，不改用富文本全文序列化 |
| 当前 PM | `@uiw/react-codemirror`、`@codemirror/lang-markdown`、ReactMarkdown、remark-gfm、原生 creation 草稿 | 复用依赖和服务；父代理统一维护新增依赖，子代理不并行改 lockfile |
| 丰富内容实现 | Shiki、remark-math / KaTeX、Mermaid、DOMPurify、PDF.js 6.4.299 | 复用 React 渲染链；图表严格配置、净化与无脚本 iframe；PDF 使用官方 legacy 主包/Worker 的 canvas 分页及本地白名单资源，不使用浏览器 PDF 插件 iframe |

附件中的 Obsidian 版本发布日期和所有菜单细项不作为本项目实现事实。实现以本项目可验证能力为准。

## 功能矩阵与分工

| 包 | 范围 | 验收 |
| --- | --- | --- |
| E1 基础命令 | 粗体、斜体、粗斜体、删除线、高亮六色、代码、清除格式；H1–H6、普通段落、列表、任务列表、引用、缩进；链接、图片、代码块、分隔线、公式、脚注、标签、嵌入、模板变量 | 操作真实选区，保留未触及文本、围栏、换行；一次操作可撤销 |
| E2 结构命令 | 表格新增删除移动行列、列对齐和排序；Callout 类型/标题/折叠；代码语言、图片尺寸；块移动/复制/删除/转换，文内批注 | 基于 Markdown 语法边界，不把代码围栏里的管道/标题误当结构；边界动作明确拒绝 |
| E3 内容编辑 UI | 内容直接输入、工具栏、三级右键菜单、选择格式、剪切复制粘贴/纯文本、撤销重做、查找替换、命令搜索、斜杠入口、大纲/折叠、模板、共享草稿和只读/冲突 | 首次打开内容无需切换即可编辑；输入、预览、源码、保存与刷新一致；桌面/手机/键盘可操作 |
| E4 渲染语法 | 高亮/安全增强样式、公式、Mermaid、脚注、隐藏注释、Callout 标题/折叠、图片尺寸、授权笔记嵌入、对象标题/块定位；保留 pm-view 与双链项目跳转 | 无脚本执行或越权嵌入；递归嵌入有边界；普通代码不执行；解析和视图不把隐藏注释当关系/清单 |
| E5 PM 联动 | 授权对象链接/关联、选中文本/清单转真实任务、图片/附件引用与上传、Agent/Session 能力说明 | 复用现有创建幂等/未知结果恢复与成果上传服务；不自动提交/完成；插入真实返回 ID/链接，不伪造数据 |
| 集成 | 属性、现有版本冲突对照、增强样式、操作错误反馈、示例文件 | 全部命令可达且读写保护一致，更新真实示例与证据 |

### 真实后端依赖，不能伪装为已实现

- Agent 执行与 Session/Run 关联：当前 execution 始终 false，缺少已验收 Runner/Session 读写合同。保留明确不可用说明，不调用外部 Agent 或模拟结果；选中文本转 Issue 不依赖 Agent。
- 多人协作：现有 SSE、revision、并发冲突对照继续使用。当前没有 CRDT/OT、远端游标或逐键协同合同，不能将本地草稿称为多人实时合编。
- 批注以 Markdown 内可持久的文内注释/注解实现；不虚构独立评论线程、身份、审核历史。字体、颜色等采用可读且安全的 Markdown 扩展，而非任意 HTML/CSS 执行。

## 共享接口与文件所有权

- 父代理维护本计划、`.omp/agents/markdown-editor-builder.md`、`document-editing-types.ts`、package/lockfile、样例及最终检查。
- E1：`document-commands.ts` + 对应行为测试。导出 `documentCommands: DocumentCommandDefinition[]` 与 `applyDocumentCommand: DocumentCommand`。
- E2：`document-structure.ts` + 对应行为测试。导出 `structureCommands: DocumentCommandDefinition[]` 与 `applyStructureCommand: DocumentCommand`。
- 两种命令接收**正文**文本和 UTF-16 `[from,to]` 选区，返回 `{text,selection}`；不认识/不适用的命令抛出清晰错误，不返回假成功。空选择允许合理插入；不修改 YAML。新语法必须与 E4 及时沟通。
- E3：`DocumentContentEditor.tsx`、`document-editor.css`、`EntityDetail.tsx`、`controller.ts` 及必要草稿 helper。E3 集成 E1/E2、E5，不自行重写其模块；旧非任务阅读模式替换为直接编辑，任务既有描述入口可复用编辑器但不能破坏任务详情布局。
- E4：`Preview.tsx`、新渲染 helper/style、必要 `packages/pm-markdown` 语法 helper 和行为测试；依赖请求交父代理。保留原 Preview props；新增 props 必须可选。原文行号不因预处理漂移。
- E5：`DocumentObjectActions.tsx`、`document-object-model.ts` 及必要独立附件组件/样式；复用 TaskCreationSurface、useEntityCreation 和现有 API，不改 E3 文件。导出组件 props：`{controller: WorkspaceController; en: boolean; selection: {text: string; from: number; to: number}; disabled: boolean; onInsert: (markdown: string) => void}`。`from/to` 对应编辑器正文。插入前校验文档身份/选区未过期，异步操作不得替换另一个文档内容。
- 所有子代理禁止中途执行 build/lint/tests/formatter/服务，父代理集成后统一跑；不得修改无关并行工作或读取凭据。

## 验证清单

1. 浏览器从文档集合打开，内容页直接输入，中文输入、选区格式、撤销/重做、右键菜单、快捷键、查找替换、大纲跳转。
2. 表格结构操作、Callout、模板、图表/公式/嵌入与安全边界；对应纯函数回归覆盖真实边界而非组件接线。
3. 正文编辑保留 YAML/未知字段，保存后重读真实 API/文件；切换源码/预览、刷新恢复、只读成员、外部修改冲突。
4. 项目/任务/文档链接、转任务创建确认与原生恢复、附件上传/引用；没有 Agent 服务时不得执行。
5. 390px 和桌面截图；运行受影响 lint、类型检查、测试与构建。若改动核心解析，执行受影响核心测试及后端回归，不把跳过计为通过。

## 实施状态

E1–E5 已实现并完成真实浏览器验收；指定子代理配置保存在 `.omp/agents/markdown-editor-builder.md`。文档属性和关联也已改为共享草稿，不会因正文未保存而锁住字段或直接 PATCH 服务端。完整后端回归与本机激活结果在下方记录。

### 实际验收

| 检查 | 实际结果 |
| --- | --- |
| 前端 `pnpm check:web` | ESLint、TypeScript、Vite 构建通过；仍有大 chunk 与既有静态/动态导入混用提示，不宣称已完成性能优化 |
| 编辑/结构/正文/对象/语法/渲染/PDF 回归 | 77 通过，0 失败，0 跳过 |
| 后端静态检查与构建 | `pnpm lint`、`pnpm typecheck`、`pnpm build` 通过 |
| 完整真实后端回归 | `pnpm test:backend`：544 通过、25 suites，0 失败、0 取消、0 跳过；首次运行被600秒命令上限中断，不计为通过，取消该人为上限后完整运行通过 |
| 合同一致性 | `pnpm contracts:check`：92 个命令 payload、34 条路径一致；本次未增加业务命令 |
| 浏览器隔离 | 临时 Web 3246、随机 API、独立 PostgreSQL schema、临时 Markdown/内容根目录；没有用真实业务任务测试 |
| 文档检查 | `pnpm check:docs`：71 份 Markdown、27 个计划步骤和领域引用通过；14 条仓库外可选链接不计入可移植检查 |

浏览器实际操作：

- 从内容页直接输入中文，粗体/撤销/重做，原生查找、复制与纯文本粘贴；三级上下文菜单中的六种高亮均可达，橙色高亮实际渲染。
- 表格按当前列排序、Callout 默认折叠、模板标题/日期/时间展开、原生指针拖动内容块；源码/正文切换仍是同一草稿。文档正文停止输入后自动保存（默认开启），属性修改仍显式保存；保存后重读包含两者、YAML 注释与未知扩展值。
- 无效 H1 草稿保留原文、可继续修复并禁止保存；只读账号内容不可输入。外部 PUT 更新 revision 后，本地草稿保留，编辑锁定，“比较版本”显示双方文本且不自动覆盖。
- 项目链接进入项目页面，跨文档标题链接进入对应详情并保留编码锚点。授权文档嵌入、脚注、隐藏批注、KaTeX、中文/英文 Mermaid 标签、本地 480px 图片均实际渲染。光标和工具栏状态变化不重建图表/附件节点。
- 真实转任务保留完整中英文标题、项目与源文档关系；人为丢弃已返回 200 的创建响应后出现 unknown，核对原请求得到 TASK-004，下一任务 ID 读取为404，没有重发创建。源清单没有自动勾选。
- 实际 WebP 暂存/登记后解码为 828×620；已登记媒体类型来自授权不可变版本，而不是强制 octet-stream 的下载头或源码文件名。PDF.js 实际渲染 900×1271 canvas；两页 PDF 翻页后像素改变，期间没有新的附件下载请求。
- 390px 页面实际宽度390px，正文可输入；桌面正文与预览独立滚动，不因长嵌入内容让编辑器一侧变成整屏空白。

浏览器发现并修正了异步创建草稿回填截断标题、重复重挂载图表/附件、下载头导致图片无法预览、Mermaid 全局 HTML 标签造成文字被净化掉、PDF 插件 iframe 被拦截及新 TypedArray API 不兼容。PDF 采用官方 legacy 构建兼容，不添加无效安全开关；不实例化脚本、表单、链接或 XFA 层。

证据：`.local/evidence/markdown-editor/browser.json`、`desktop.webp`、`mobile.webp`、`pdf-pages.webp`。真实示例更新于 `.local/pm-workspaces/539993bd-4caf-4002-8340-18e789ae8a06/docs/DOC-001.md`；隔离服务重读确认稳定 ID、三条真实对象双链、四项清单及三个 pm-view 保留。没有为展示创建第二个真实工作区或改动已有任务状态。

### 本机激活与清理

完整验收后核对常驻 API/Worker 的 PID、启动入口及工作目录，通过项目自己的服务脚本仅重启本仓库进程。新 API PID 49632、Worker PID 49618；`http://127.0.0.1:4100/health/ready` 实测 database/storage/worker/core 全部为 true，quarantinedEvents 为0。前端既有3220服务未停止。

重启后实际工作区投影重读 DOC-001：`stale=0`、`error=NULL`，直接编辑说明和橙色示例已索引，仍有4项清单、3个嵌入视图；投影 diagnostics 为0。临时浏览器关闭，3246验收服务正常退出并清理独立 schema、Markdown/Blob 根目录；自建冒烟脚本和两个上传用PDF已删除，仅保留证据。未 commit 或 push，不宣称真实 Agent、生产公网部署或多人实时合编已验收。
