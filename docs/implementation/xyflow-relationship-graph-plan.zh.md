# xyflow 关系图展示重构计划与交付

状态：用户批准后已完成实现和隔离浏览器验收；2026-11-03 补充项目顶栏入口，并将验收过的前端静态资源更新至本副本 3224，见第八节。初次调研与交付日期：2026-11-02。相关检查通过，既有 SSE 集成用例仍触发固定 45 秒超时，详见第七节；不宣称该批次全绿。

## 1. 基线与范围

目标：用 xyflow 的 React Flow 重构现有知识关系图展示，改善节点信息、关系辨识与画布导航；保留真实数据、授权与现有入口。

来源：

- 本地参考 `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/UI-package/xyflow`，提交 `d4bc936edad07aba995dbdb8e2c63af8cdd631c9`，`packages/react/package.json` 为 `@xyflow/react@12.12.0`，MIT。
- [Web 依赖](../../apps/web/package.json) 已声明 `@xyflow/react@12.12.0` 和 `elkjs`；实际 Node 导入核对得到 React Flow 12.12.0、ELK 0.12.0，画布、缩略图、控件、自定义边等导出存在。
- 调研时[共享视图依赖](../../packages/pm-views/package.json) 使用 `react-force-graph-2d`；本轮已直接安装固定版 `@xyflow/react@12.12.0`、`elkjs@0.12.0`，并通过 pnpm 移除旧引擎及其不再使用的依赖。
- [图页面](../../packages/pm-views/KnowledgeGraph.tsx)、[图画布](../../packages/pm-views/KnowledgeGraphCanvas.tsx)、[图样式](../../packages/pm-views/knowledge-graph.css) 是主要改动面。
- [现有知识图谱合同与历史验收](knowledge-graph-plan.zh.md)、[图 DTO](../../packages/pm-schema/graph.ts)、[既有依赖图 ELK Worker 模式](../../apps/web/src/features/pm/components/service-dependency-graph.tsx) 继续复用。

本轮计划覆盖：工作区/项目集合的 graph 视图、共享详情与完整实体页局部图、嵌入 pm-view 图。既有任务依赖图、Dashboard 画布、任务工作流画布只做共享依赖/CSS 的受影响回归，不统一改写其业务交互。

不在范围：新增图查询 API、数据库迁移、修改关系语义、拖线创建/删除业务关系、自动推进任务、坐标持久化、导出、协作编辑或任意 Vault 导入。不会复制或修改参考仓库。

未查询真实 PM 任务列表；此计划基于代码和文档，未核对现有任务或完成业务任务去重。负责人、容量、日期约束未提供，不承诺工期。工作树已有大量并行修改，实现时仅处理任务相关路径。

## 2. 安装与组件选择

### 2.1 依赖归属

不在 Web 重复安装、不升级到浮动最新版，也不使用外部目录的 file/link 依赖。直接使用库的发布包；参考仓库只用于查看实现和示例。

已在实际拥有图组件的 `@pm/views` 执行：

```bash
pnpm --filter @pm/views add --save-exact @xyflow/react@12.12.0 elkjs@0.12.0
```

迁移冒烟通过、确认 apps/packages/vendor 无旧引擎调用后，已执行 `pnpm --filter @pm/views remove react-force-graph-2d` 并更新锁文件；未手工删除共享传递依赖。只通过 `@xyflow/react` 使用公共 API，未直接安装 `@xyflow/system`、旧版 `reactflow`、Svelte 包或新增 Dagre。

### 2.2 本地示例与采用方式

以下路径相对于参考仓库的 `examples/react/src/examples/`：

| 已查看的示例 | 采用内容 | 不照搬内容 |
| --- | --- | --- |
| `CustomNode/ColorSelectorNode.tsx` | 自定义节点、Handle、nodrag 交互隔离 | 颜色编辑器、演示数据和日志 |
| `Edges/CustomEdge3.tsx` | BaseEdge、关系标签与自定义路径 | 演示点击行为；默认路径不能直接解决所有自环/平行边 |
| `InteractiveMinimap/index.tsx` | MiniMap、pannable、zoomable、视口操作 | 随机位置和演示按钮 |
| `Layouting/index.tsx` | 布局与 React Flow 分离、fitView、方向控制 | Dagre 依赖；本项目复用 ELK Worker 模式 |
| `A11y/index.tsx` | ariaLabelConfig、键盘焦点与自动视口移动 | 演示专用 tabIndex |

选用 ReactFlow / ReactFlowProvider、Background、Controls、MiniMap、Panel、Handle、BaseEdge 和标签渲染能力。React Flow 是渲染/交互层，不自带业务图自动布局。

## 3. 展示与交互方案

- 页面顶部：保留全局/局部、中心实体、1–3 层邻域、搜索及关系筛选；全局明确指当前授权和筛选范围，不代表整个数据库。
- 主画布：取代当前力导向小圆点，使用紧凑实体卡片，展示类型、ID、标题、已有状态及归档/草稿/过期标记。连接数改为可读徽标，不靠卡片面积暗示业务重要性。
- 布局：默认采用 ELK 分层布局，支持横向/纵向和显式重新布局。知识关系允许一般环；布局只能调整坐标，不反转、删除或重写 DTO 中的边。
- 关系：按实际 kind 区分样式并提供图例；默认低干扰，悬停/聚焦时展示类型和端点。保留同端点多类型边、双向边和自引用，分别偏移/绘制回环，不能按端点合并不同关系。
- 导航：保留点击打开实体；拖动结束不误触打开。悬停或键盘聚焦高亮邻域，提供适配全部、缩放、聚焦中心、标签开关与可交互缩略图。
- 窄屏/嵌入：筛选可折叠、缩略图可收起；按容器尺寸计算画布，不将详情面板撑宽。保留现有无障碍节点导航作为可靠入口。
- 数据刷新：同一授权/查询范围内尽可能保留节点坐标和视口；身份、工作区、查询范围切换或权限失效时立即清除旧图及其布局缓存。过时的异步布局结果不得恢复旧节点。
- 状态：加载、空结果、请求失败、布局失败、草稿预览分开。布局失败可明确显示可拖动网格并提供重试；远程图查询失败不能退回本地预览冒充真实结果。
- 只读关系：禁用连接、重连和删除；节点拖动仅影响当前画布坐标，不触发业务写入。
- 主题：复用 PM 主题令牌和中英文文案，样式限定在知识图容器，不覆盖其他 React Flow 页面。

## 4. 候选任务与验收

以下保留获批计划的本地候选编号；来源为本次用户要求、固定版本源码和现有图谱合同，未发布为 PM 业务任务。T1–T4 已实现，T5 的实际验收与环境限制逐项记录于第七节。

| 候选编号 | 目标/成果 | 范围与非目标 | 验收 | 前置依赖 | 来源 | 待确认项 |
| --- | --- | --- | --- | --- | --- | --- |
| draft:T1 | 正确安装依赖并冻结渲染合同 | `packages/pm-views/package.json`、锁文件；不升级其他画布 | 共享包可解析固定版 React Flow/ELK；保留 GraphData、GraphSource、onSelect 边界 | 无 | 依赖清单、图 DTO | 无阻塞项 |
| draft:T2 | 关系图数据适配与异步布局 | GraphData 转独立 nodes/edges；ELK Worker 生命周期；不改后端事实 | 类型边、孤点、一般环、自引用、多类型边不丢失；输入不被变更；旧请求布局不得覆盖新范围 | T1 | 图 DTO、现有 ELK 模式 | 容量目标未提供，记录实测而非承诺万级 |
| draft:T3 | React Flow 画布和实体卡片 | 替换 KnowledgeGraphCanvas；局部样式；不引入业务编辑 | 卡片、边标签、导航/拖动/缩放、缩略图、邻域高亮及键盘操作真实可用；无业务写请求 | T2 | CustomNode、Edges、MiniMap、A11y 示例 | 采用上述紧凑卡片默认方案 |
| draft:T4 | 所有关系图入口与页面布局收口 | KnowledgeGraph、集合/详情/嵌入入口、响应式；不新增路由体系 | 全部入口消费同一新渲染器；筛选/搜索/局部层数/详情跳转无回退；主题、语言和窄屏可用 | T3 | 现有图页面及调用入口 | 无阻塞项 |
| draft:T5 | 隔离环境验收与交付记录 | 受影响检查、真实服务和浏览器；旧依赖与失效样式清理；文档更新 | 下述验收矩阵有实际证据；没有第二套旧图引擎入口；共享画布不退化 | T4 | 原图谱验收及本计划 | 实现时核对可用隔离环境，不接管常驻服务 |

依赖统一表示为：`draft:T2 depends_on draft:T1`、`draft:T3 depends_on draft:T2`、`draft:T4 depends_on draft:T3`、`draft:T5 depends_on draft:T4`。无自环、重复边或依赖环。

顺序理由：先确定依赖和 DTO 适配，再使画布可用，最后接所有入口并验收。T1 后可并行准备 T2 的布局与 T3 的纯节点/边样式，但 T3 最终集成必须等待 T2；共享 KnowledgeGraphCanvas 文件由一个集成负责人处理。

里程碑候选：`draft:M1` 为新画布可用（T1–T3）；`draft:M2` 为全部正式入口通过验收（T4–T5）。里程碑不是任务依赖或项目完成状态。

## 5. 验收矩阵

1. **数据保真**：相同查询的新旧 nodes/links ID 集合一致；九类实体、孤立节点、双向/自引用/多类型边、一般环、长标题均可辨识。父子/依赖/正文引用不可混成同一种业务关系。
2. **真实入口**：工作区与项目集合、共享详情、完整实体页、嵌入预览全部实际打开；搜索、关系筛选、归档条件和 1–3 层局部查询继续生效。
3. **交互**：点击进入正确项目/实体；拖动不导航、不写入；缩放、平移、适配、重新布局、缩略图、邻域高亮、键盘与焦点环实际可用。
4. **安全和刷新**：真实保存后通过现有 SSE 更新；草稿不混入正式图。权限收窄、工作区切换、失败重试、旧响应/旧布局迟到均不泄露或复活旧图。对应 INV-01/INV-20、SC-14/SC-20、INF-03/INF-06；不把既有依赖规则 INV-12/SC-11 套到一般知识关联环上。
5. **视觉与性能**：浅/深主题、中/英文、1440px 桌面和 390px 窄屏截图；嵌入容器不溢出，首次适配无裁切。记录实际节点/边规模、首次布局耗时及交互表现；DOM/SVG 卡片不宣称优于原 Canvas 的大图容量，不通过静默截断数据掩盖性能问题。
6. **工程**：运行 `pnpm check:web`，另对 `packages/pm-views` 改动文件运行 ESLint（Web 脚本默认不覆盖该目录）；运行现有图模型相关回归及 `pnpm check:docs`。新永久测试仅针对多类型边/环保真、输入不变、异步范围隔离等真实行为风险。若实施触及后端、数据库或流机制，必须补 `pnpm check` / `pnpm test:backend`，跳过不算通过。
7. **浏览器证据**：临时服务运行前核对端口、PID、工作目录，使用隔离数据；真实 API 结果与前端截图分别记录。抽查既有任务依赖图、Dashboard 与工作流画布，尤其共享 CSS、Worker 和 fitView。构建成功不替代浏览器验收。

## 6. 复用、发布交接与边界

复用现有图 API、GraphData/GraphQuery、权限裁剪、查询取消/序列保护、SSE 刷新、草稿提示、详情导航及 ELK Worker 模式。旧计划 G01–G04 是历史代码工作包，不冒充当前 PM 业务任务 ID，也不重建已经交付的后端能力。

执行前按最新工作树复核引用与依赖；完成后更新原知识图谱文档和交付说明，标明原 Canvas 验收为历史事实，新批次证据独立记录。无需修改正式业务对象。

如需将本计划发布到 PM：先读取授权范围内真实任务、核对重复与版本，再确定所选候选及其前置依赖闭包；发布后建立 draft 编号到真实任务 ID 的映射。本轮未创建正式业务任务、未分配负责人；已安装依赖并修改本仓库相关源码，未重启常驻服务、未 commit 或 push。

会话与持久化统一设计仍未收口，当前暂沿用 Agent Chat 保存方式；本计划不新增图坐标持久化或改变该设计。

## 7. 实现与实际验收

### 7.1 实施分工与交付文件

按用户要求创建 [.omp/agents/graph-sol.md](../../.omp/agents/graph-sol.md)，配置 `gpt-6.1-sol`、`thinking-level: xhigh`，并行执行 GraphModel、GraphCanvas、GraphPage 三个独立切片；父代理负责依赖、集成修正、检查与运行验收。

- [graph-flow-model.ts](../../packages/pm-views/graph-flow-model.ts)：独立 React Flow DTO；保留孤点、一般环、不同 kind、双向边及自环，稳定分配不同路径 lane，不修改输入。
- [graph-flow-layout.ts](../../packages/pm-views/graph-flow-layout.ts)：真实 ELK Worker、横纵布局、成功/异常/取消时终止 Worker；失败时明确显示网格。
- [KnowledgeGraphCanvas.tsx](../../packages/pm-views/KnowledgeGraphCanvas.tsx)、[knowledge-graph-flow.css](../../packages/pm-views/knowledge-graph-flow.css)：实体卡片、自定义关系边、键盘打开、拖动防误触、缩放/平移/适配/中心定位、标签/缩略图、邻域高亮、局部主题样式。
- [KnowledgeGraph.tsx](../../packages/pm-views/KnowledgeGraph.tsx)、[knowledge-graph.css](../../packages/pm-views/knowledge-graph.css)：复用查询取消/序列保护与授权数据；刷新中隐藏旧 DTO，仅在同一范围保留内存坐标和视口；范围变化、错误或空结果清理布局缓存。
- [EntityDetail.tsx](../../apps/web/src/features/pm/markdown/EntityDetail.tsx)：恢复共享详情与全页详情的关系图入口，保留并行 RadixSelect 等修改。
- [graph-flow-model.test.ts](../../tests/graph-flow-model.test.ts)：六项行为回归，覆盖多类型/双向/自环、稳定排序、一般环/孤点、网格边界、不可变输入和空图；未新增接线或文案快照测试。

### 7.2 真实服务与浏览器

使用本副本 PostgreSQL 55444 上的独立 fixture schema、独立临时 Markdown/Blob 目录、随机 API 端口 36895、自有 Web 4349/4350；未读取实际访问凭据。生产构建输出到 `.local/xyflow-web-dist`，不覆盖常驻服务的 `apps/web/dist`。生成的 owner/受限 reader 使用不同 localhost 主机名，避免浏览器 Cookie 与其他会话冲突。

| 场景 | 实际结果 |
| --- | --- |
| 数据保真 | 初始真实 API 为 14 节点/25 边、九类实体，浏览器节点和边 ID 集合与 API 完全一致；另有一份归档文档，包含归档时显示卡片及归档标记 |
| 局部与筛选 | DOC-001 初始一层为 4 节点/8 边；真实新增保存关系后为 5 节点/11 边。二/三层均为 12 节点，逐一对比真实 API 的节点集合一致；TASK 搜索为三项，取消全部关系保留 14 节点/0 边 |
| 正式入口 | 实际打开工作区集合、项目任务集合、任务共享详情、完整任务页、文档详情关系图和文档嵌入 pm-view |
| 保存与草稿 | 实际保存 DOC-001 → REQ-001 后 SSE 刷新；拖动后的 DOC-001 坐标和画布视口完全保持。未保存 TASK-001 → GOAL-001 不进入正式图，显示草稿徽标；嵌入图保持明确 preview 模式并展示草稿关系 |
| 交互 | 标签开关、横纵布局、重新布局、适配、中心导航、键盘 Enter 打开、节点拖动、缩放、画布平移及缩略图拖动实际操作。节点拖动前后 URL 不变，监听到的业务写请求为零 |
| 错误与旧结果 | Graph POST 注入 503 时画布移除、仍为 saved 模式，无本地预览回退；显式重试恢复请求。延迟旧 DOC 搜索及旧 ELK Worker，切换 TASK 后再释放，最终始终仅有 TASK-001/002/003 |
| 布局失败 | 阻断真实 Worker 加载后显示“自动布局失败”和可拖动网格，不丢图事实；恢复加载并点击“重试布局”成功 |
| 授权 | 受限 reader 看不到 Private project / PRIVATE-ONLY；真实将其项目范围缩为空后，已打开页面自动变为 0 节点/0 边并移除画布，恢复授权后重新读取。切换至不可访问工作区显示 HTTP 404，旧图节点为零 |
| 视觉 | 1440×1000 浅色中文/深色英文；390×844 两种主题/语言，文档和图容器宽均为 390，工具栏和筛选内部无横向溢出。全图适配会缩小卡片，局部图和中心定位用于阅读细节 |
| 性能观测 | 14 节点/26 边时，一次真实“重新布局”从点击到布局完成约 591 ms；新主机名下加载最终构建、读取授权/API 到首次布局完成共 7.653 秒（均含浏览器自动化开销）。不是纯 Worker 基准或大图容量承诺，未静默截断数据 |
| 共享画布回归 | 正式 Dashboard4 任务依赖页及项目 detail2 依赖页均显示 3 节点/1 边；另在临时组件宿主导入新图 CSS，实际运行既有 WorkflowCanvas 的内置只读模板，显示 4 节点/3 边且点击 Agent 节点更新配置详情。未执行 Agent 或工作流任务 |

截图保留在 `.local/evidence/xyflow-relationship-graph/`：`global-light-zh.png`、`local-light-zh.png`、`local-dark-en.png`、`local-dark-en-canvas.png`、`mobile-light-zh.png`、`mobile-dark-en.png`、`dashboard4-regression.png`、`dependency-regression.png`、`workflow-regression.png`。这些是隔离验收数据，不是正式工作区的运行截图。

最终移除旧依赖后重新构建并在新浏览器 origin 实际打开：真实 API 200、14 节点/26 边，渲染节点和边 ID 集合仍逐一相等，无 pageerror；结果保存为同目录 `final-graph.json`。

### 7.3 检查结果与限制

- Web lint 与四个共享图 TS/TSX 文件、图适配测试的定向 ESLint 通过。
- `pnpm --filter @pm/web typecheck` 通过；集成中发现并修复本轮 React 19 `useRef` 初始值错误，最后检查已不再有早期并行 RadixSelect 类型错误。
- `pnpm --filter @pm/web exec vite build --outDir ../../.local/xyflow-web-dist` 通过，最后一次耗时 32.38 秒。使用 `check:web` 的 lint/typecheck 加同配置独立输出构建，避免覆盖常驻服务产物；仍有既有大 chunk 和 workflow-canvas 动态/静态导入混用警告。
- `node --test tests/graph-flow-model.test.ts packages/pm-core/tests/graph.test.ts`：13 通过、0 失败、0 取消、0 跳过。
- 加上 `tests/knowledge-graph.integration.test.ts` 的真实数据库批次：15 通过、1 取消（超时）、0 跳过；两个 HTTP/授权/保存集成用例通过。独立重跑 idle SSE 用例仍在 45 秒截止，未通过，也未修改其截止时间掩盖问题。
- 独立真实 SSE 生命周期探针：fixture 初始化耗时 42.443 秒，ready 在 42.598 秒、heartbeat 在 57.601 秒、保存/收到 change 在 57.647/57.675 秒，关闭 API 后流在 57.681 秒结束，58.223 秒完成清理。该环境初始化加 15 秒真实心跳已超过既有 45 秒总期限；探针通过不替代超时测试的结果。
- `pnpm check:docs` 通过：149 份 Markdown、27 个计划步骤和领域引用；42 个仓库外可选链接不参与可移植检查。
- 本轮未修改后端、数据库或 SSE 实现，未运行全仓 `pnpm check` / `pnpm test:backend`，不宣称后端全量验收或真实 Agent 就绪。

旧 `react-force-graph-2d` 已移除，知识图不保留旧引擎入口或兼容别名。关系图拖动仅更新当前内存；会话与持久化统一设计仍未收口，继续沿用 Agent Chat，不因此新增持久化设计。

验收结束后已关闭两个自有浏览器标签、自有 preview 和 fixture 服务；fixture 正常退出（exit 0）并清理其 schema/临时数据。临时服务脚本、SSE 探针和工作流组件宿主已删除；仅保留验收证据和用户要求的子代理配置。未部署或重启常驻 3224。

## 8. 项目顶栏入口与前端更新（2026-11-03）

- 按用户指定，在项目“产品规划 … 活动”横向导航中，于“树形图”与“文档”之间增加“关系图 / Graph”。修改文件为 `apps/web/src/features/pm/service/service-project-layout.tsx`，复用现有 Link、项目 base 和选中态规则。
- 点击进入 `/pm/<workspace>/projects/<projectId>/issues?view=graph`，展示当前项目任务集合的 React Flow 关系图，不跳到工作区全局图。项目 ID 来自路由；刷新和从实体页返回时仍能识别关系图选中态。旧详情 `?tab=graph` 的任务依赖入口保持独立，不将其误标为本次新入口。
- 真实隔离 API/数据库/Markdown 验收：项目 A 的按钮跳至 PRJ-001，仅显示 TASK-001/002；切换项目 B 后按钮跳至 PRJ-002，仅显示 TASK-003。刷新保留“关系图”高亮；390px 页面宽度为 390，顶栏可横向滚动，无页面横向溢出。截图位于 `.local/evidence/project-graph-navigation/project-a.png`、`project-b-mobile.png`。
- 本批次 Web lint、TypeScript 和独立 Vite 构建通过（17.98 秒）；构建保留既有 chunk 大小与 workflow-canvas 混合导入警告。仅增加导航配置和活动项映射，未新增接线/文案测试，未重跑后端业务测试。
- 核对 gateway PID 34467、项目工作目录及 3224/4194 端口后，把验证过的暂存构建同步至 `apps/web/dist`，先复制资源再原子替换 `index.html`，保留旧哈希资源供已有页面使用；未重启 gateway/API/Worker/Agent，未修改业务数据或读取真实凭据。
- 更新后 3224 返回的 HTML 与验收构建逐字相等，入口 `/assets/index-B4jcLC1y.js` 返回 200；无登录凭据的新浏览器正确显示 HTTP 401/请先登录，无浏览器 pageerror。正式账号内的点击由上面的同构建隔离验收覆盖，不冒称已登录正式账号验收。
- 本轮不改变会话/持久化设计，图坐标仍只存内存；会话暂沿用 Agent Chat，统一设计未收口。

## 9. 页面工作台改版（2026-11-03）

按用户反馈重构关系图页面的信息架构：不再把任务表格堆在画布下方，而是让画布成为主内容，左侧负责实体导航与筛选，右侧按需显示节点详情。

### 9.1 改动

- [KnowledgeGraph.tsx](../../packages/pm-views/KnowledgeGraph.tsx)：页面模式改为三栏工作台；左栏搜索、全局/局部、中心实体、邻域层数、关系类型和按状态分组的实体列表；页面默认隐藏“已完成 / 已取消”分组，画布优先显示未完成任务，分组计数仍可见并可展开；中栏画布填满剩余视口；右栏为选中节点 Inspector，提供状态、关系数、关联关系、“打开任务 / 打开对象”、“设为中心”和“定位”。嵌入模式保留紧凑布局，只显示一条来源说明。
- [KnowledgeGraphCanvas.tsx](../../packages/pm-views/KnowledgeGraphCanvas.tsx)、[knowledge-graph-flow.css](../../packages/pm-views/knowledge-graph-flow.css)：布局/显示菜单移到画布右上，缩放、适配、定位和图例移到左下，缩略图保留右下；隐藏只读连线手柄；关系标签默认只显示类型，聚焦时加粗，端点与方向放在悬停信息和标题中，避免大标签遮挡卡片；非邻居节点透明度改为 0.58，非相关边改为 0.32；新增 `focusRequest` 用于从列表定位节点；实体卡片移除左侧类型色条和选中/邻居的蓝色描边，改用中性边框、背景和阴影。
- [graph-flow-layout.ts](../../packages/pm-views/graph-flow-layout.ts)：显式开启 ELK `separateConnectedComponents`，不连通子图各自紧凑排列并保留组件间距。
- [KnowledgeGraph.tsx](../../packages/pm-views/KnowledgeGraph.tsx) 的页面头部已并入任务工具栏：页面标题改为“关系图”，全局/局部与实体/关系计数通过 portal 放在筛选前，实体导航开关放在新建任务后；不再渲染独立图头部、数据源徽标或全局模式说明。完整只读说明保留在左栏可展开的“只读说明”。
- [TaskCollectionView.tsx](../../apps/web/src/features/pm/markdown/TaskCollectionView.tsx)：graph 布局只渲染关系图，不再在下方追加已完成/已取消任务表格；graph 使用范围内全部任务，侧栏按未完成/已完成/已取消分组。
- [controller.ts](../../apps/web/src/features/pm/markdown/controller.ts)：任务上下文的图查询范围由仅未完成改为范围内全部任务，使终态任务仍可在关系图和侧栏中发现。
- [TaskCollectionControls.tsx](../../apps/web/src/features/pm/markdown/TaskCollectionControls.tsx)、[workspace.tsx](../../apps/web/src/features/pm/markdown/workspace.tsx)：graph 布局隐藏与图内搜索重复的任务搜索和排序；在工具栏中提供两个 portal 目标，将全局/局部、计数和实体导航开关嵌入现有按钮序列；页面标题显示“关系图”。
- [pm-shell.tsx](../../apps/web/src/features/pm/pm-shell.tsx)：`?view=graph` 时不再把面包屑末级标为“任务”，避免与关系图页面冲突。
- [markdown.css](../../apps/web/src/features/pm/markdown/markdown.css)：graph 布局的 `view-content` 不再整页滚动，PMView、关系图和工作台按 `min-height: 0` 链填满剩余高度。

### 9.2 实际浏览器验收

使用常驻 3224 上的本副本构建，在 1680×1000 视口实际打开项目 PRJ-001 的任务关系图：

| 检查 | 实际结果 |
| --- | --- |
| 页面高度 | 关系图区域 1420×827，工作台 1418×825，React Flow 表面 1158×825；页面 `scrollHeight` 等于视口 1000，没有整页滚动 |
| 工具栏 | 标题为“关系图”；顺序为 全局/局部 → 实体·关系计数 → 筛选 → Agent 助手 → 新建任务 → 实体导航 → 更多；面包屑末级不再显示“任务” |
| 已删除文案 | 页面中不再出现“数据源：Markdown · 只读”和“全局模式展示所有匹配实体…”，只读说明仅在左栏折叠项内 |
| 卡片外观 | 工作项卡片使用 1px 中性边框，无左侧蓝色色条；选中和邻居卡片无蓝色描边，仅用中性背景和阴影区分 |
| 导航与筛选 | 左栏显示 13 个实体的分组计数（未完成 9 / 已完成 3 / 已取消 1）；默认隐藏终态分组，画布为 9 节点/5 边、100% 可读；展开“已完成”后变为 12 节点/8 边 |
| 节点 Inspector | 点击 TASK-012 后右栏宽 320，显示状态、关系数、1 条 `parent` 关联和打开/设为中心/定位操作；点击“打开任务”关闭 Inspector 并打开共享任务详情 |
| 邻居高亮 | 选中 TASK-012 时 7 个非邻居节点透明度为 0.58，无关边透明度为 0.32，相关边为 1 |
| 全局/局部 | 局部模式显示中心实体与 1 层邻域，选中态和侧栏中心/层数控件同步；隐藏已完成分组后自动选择可见节点作为中心 |
| 左栏折叠 | 收起后中栏宽度由 1158 变为 1418；重新展开恢复 |
| 画布控件 | 布局/显示菜单在右上；左下为缩放、适配全部、定位中心、缩放比例和图例；缩略图在右下；标签开关实际显示关系类型 |
| 窄屏 | 390×844 无横向溢出（`scrollWidth` 390），标题“关系图”保持单行，工具栏按 全局/局部 → 筛选 → Agent → 新建任务 → 实体导航 → 更多 排列；左栏默认收起并可作为 300px 覆盖层展开，右栏 Inspector 以覆盖层出现，缩略图上移避开底部操作条；全图适配在窄屏为 37%，用于概览，阅读细节需局部模式或缩放 |

截图保存在 `.local/evidence/xyflow-relationship-graph/workbench-desktop.webp`、`workbench-mobile.webp`、`workbench-mobile-sidebar.webp` 和 `embedded-graph.webp`；来自本副本 3224 的实际项目数据，不是隔离 fixture。

构建与检查：`pnpm --filter @pm/web typecheck`、`pnpm --filter @pm/web lint`、`pnpm --filter @pm/web build` 和 `node --test tests/graph-flow-model.test.ts`（6 通过）均通过；构建保留既有大 chunk 与 workflow-canvas 混合导入警告。

本轮未新增图坐标持久化，拖动仍只改变内存布局；会话与持久化统一设计仍未收口，继续沿用 Agent Chat 保存方式。
