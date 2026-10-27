# 项目侧栏菜单实现计划

日期：2026-10-27。目标：将只读参考 gr8r-studio 的项目 `…` 交互接入当前 PM 正式工作区，不修改参考仓库、不复制样例事实、不替换既有项目视图。用户授权按计划实施，工作包使用 `gpt-6.1-sol / xhigh` 子代理。

## 1. 现状与原则

- 当前侧栏在 `apps/web/src/features/pm/service/service-project-layout.tsx`，已有真实授权项目、收藏标记、展开偏好和四个子视图，缺少项目菜单。
- `SetProjectFavorite`、成员授权/邀请、核心字段修改、`ArchiveObject` / `RestoreArchivedObject` 和原生永久删除已有真实服务；项目复制、个人侧栏排序需要补齐。
- 核心项目与任务继续由 Markdown 所有；权限与收据由既有应用服务管理。适用 INV-01/10/12/13/14/17/20，SC-12/13/14/17/20；以当前 Markdown 实现契约为准，不恢复已替换的旧完成工作流。
- 业务操作保留版本检查、原请求身份、未知结果核对、当前授权与审计。错误不显示成功；刷新不自动重发。
- Git 当前整个项目以未跟踪内容存在；不得清理、广泛暂存、提交或覆盖无关文件。API4192/Web3222/PG55442是本副本既有服务，验收使用临时端口和随机 schema，不修改既有业务数据。

## 2. 逐项交付与验收

| 项目 | 实现 | 验收 |
| --- | --- | --- |
| Open | 使用真实项目稳定 URL，复用现有项目页与默认视图 | 导航、刷新、返回和项目作用域正确 |
| Add / Remove from favorites | 复用 SetProjectFavorite 与本人版本化附加记录 | 侧栏、项目列表、详情同步；另一账号独立 |
| Rename & edit | 项目设置弹窗；名称、正文/描述、负责人、日期及可安全保存的图标颜色，团队关联复用已有命令 | 保存后重读/刷新一致；取消不写入；冲突保留草稿 |
| Share | 独立分享弹窗，真实成员和授权范围；已有成员添加/移除只改当前项目范围并保留其他范围与能力；全工作区授权显示继承，不伪装成可撤销单项目权限；邀请复用真实邮件能力 | 只读者不获管理能力；不扩大其他项目权限；未配置 SMTP 时禁用邮件邀请；真实收据核对 |
| Copy link | 复制当前 origin 下真实工作区/项目 URL | 新标签打开同一对象；复制失败明确提示 |
| Duplicate | 新服务端操作；新项目名称与本地目录预检，复制项目内容及可选未归档任务；重置工作流到配置初始状态，分配新 ID，重映射复制集合内依赖/父子关系；不复制授权、审计、评论、审核、附件字节、其他代码或项目目录 | 新旧 ID 不重用、无指向源任务的内部关系；源数据不变；同键/丢响应不重复创建；失败不伪装为完整成功 |
| Move up in sidebar | 本人/工作区隔离的服务端排序偏好；仅相邻授权可见项目互换 | 边界禁用；刷新保留；其他账号顺序不变 |
| Move down in sidebar | 同上 | 搜索不破坏全量排序；新增/撤权/归档项目收敛 |
| Archive project | 复用真实归档命令，确认后隐藏侧栏并提供可达恢复入口 | 不完成项目/任务、不删除文件；刷新与恢复正确 |
| Delete project | 复用永久删除语义，完整项目名称确认；必须已归档、无入站引用且来源可验证；不自动级联删除业务数据，不删除本地用户代码目录，不提供虚假 Undo | 未归档/有引用时明确阻止；无引用归档项目实际删除；版本冲突/越权拒绝 |

永久删除的引用保护是当前产品既有约束，不复制参考项目的任意级联删除与全局快照 Undo。复制范围在弹窗明示，不声称完整历史克隆。分享不建立第二套与 membership 脱节的权限状态。

## 3. 工作包、接口与所有权

### A：NativeProjectCopy — 服务端复制与生命周期接入

所有权：新的项目复制 application/domain/contracts 模块、`apps/api/src/core-adapter.ts`、所需 `packages/pm-core` 文件、对应行为测试；必要的 HTTP 接入由该包与主集成者确认后修改。不得修改前端、project-extras 排序模块或共享计划文档。

接口约定：通过正式 `DuplicateProject` 命令，targetId/projectId 为源项目，expectedVersions 包含源项目版本；payload `{ name, includeTasks, localDirectory? }`。返回包含新项目 `id` 的结果及任务 ID 映射/复制数量。使用原 commandId 幂等/核对，遵守本地目录配置和预检。如现有复制事务需要专门恢复接口，由该包负责完整实现并在实现前通知主线程和 B，不以客户端循环请求代替业务操作。永久删除复用现有安全守卫，若发现 SQL 不可变历史引用未保护，则补齐守卫而不破坏历史。

### B：ProjectMenuUI — 菜单、编辑及生命周期界面

所有权：`service-project-layout.tsx`、新的项目菜单/编辑/复制/生命周期组件、必要的项目列表/详情统一菜单调用、专属样式。复用现有 Dialog / DropdownMenu / 草稿 / usePmCommand / CoreSession 能力。避免为每个项目挂载重查询弹窗，弹窗按选中项目打开。

共享接口：C 提供 `ProjectShareDialog({ project, open, onOpenChange })`；D 提供 `useProjectSidebarOrder(projects)` 返回 `{ orderedProjects, moveProject(projectId, direction), pending, error, notice }`，direction 为 `up | down`。B 与 C/D 直接沟通实际导出类型，不重复实现分享和排序持久化。Unknown 状态不允许关闭后再次提交新请求。

### C：ProjectSharing — 真实项目分享界面

所有权：新的 `project-share-dialog.tsx` 及专属 helpers/tests。仅复用现有 membership / invitation 服务，不修改全局授权语义。项目范围增加/移除保留其他项目及能力；继承全工作区访问如实显示，不能单项目撤销。读/评论/编辑等级必须来自真实能力，不能保存无意义标签或悄悄改变其他项目权限。邀请固定目标项目，SMTP 缺失禁用。输出简洁的实际能力说明和必要的成员管理入口。

### D：ProjectSidebarOrder — 本人服务端顺序

所有权：`packages/domain/src/project-extras.ts`、`packages/application/src/project-extras.ts`、必要的迁移与既有 extras DTO、前端新 `project-sidebar-order.ts` hook、对应隔离行为测试。新增 `SetProjectSidebarOrder` 命令和 extras 查询排序字段；复用 dashboard_records 本人数据、版本与事件模式，不把业务数据存入 localStorage。迁移编号如需要先与主线程确认；不要修改共享生成合同文件。

### 主集成者

负责共享接口冻结、合同生成、共享入口冲突解决、文档更新、单次集成检查和真实浏览器/服务验收。子代理跳过中途 build/lint/tests/formatters；完成后统一运行。所有子代理使用 `gpt-6.1-sol:xhigh`，不擅自切换模型。

## 4. 验证

- 源码完成后生成合同，运行受影响行为测试、`pnpm check`、`pnpm check:web`；数据库/事务变更运行 `pnpm test:backend`，跳过项不算通过。
- 使用随机 PostgreSQL schema、临时 Markdown 与项目目录、临时 API/Web 验收，不读取已有 access.json、不向用户工作区写验收对象。
- 浏览器逐项操作菜单、编辑/取消/冲突、收藏、复制链接、分享/范围边界、复制任务关系、顺序、归档/恢复、永久删除保护与正向路径；检查390px窄屏和键盘可达。
- 源码、编译、真实服务与部署分开记录；本批不自动重启或迁移现有 API/Worker，不声明生产部署完成。

## 5. 实施记录

四个指定模型/推理级别子代理已完成各自工作包；主线程完成接口整合、合同生成和真实浏览器验收。正式菜单覆盖第 2 节全部十项，侧栏、列表、详情复用同一弹窗宿主。

- 合同：112 个命令、85 条路径；新增 `DuplicateProject`、`SetProjectSidebarOrder`、正式 `DeleteObject` 及 `POST /commands/{commandId}/recover`。GET 收据只查询，不恢复写入。
- 数据：增量迁移 `0035_project_sidebar_order.sql`；原生复制持久化冻结清单、全部预留 ID 与进度，缺失绑定/审计沿原请求恢复。两种删除入口同时保护原生与 SQL 业务引用。
- 浏览器使用随机 schema、临时 API/Worker/Web 和临时项目目录。验证名称/Markdown/负责人/日期/图标/颜色保存及重读、取消、冲突保留草稿、真实范围分享及最后范围移除、只读有效命令被拒、个人收藏隔离、稳定链接、全量搜索排序及另一标签页不刷新收敛。
- 独立复制的新任务父子、阻塞和正文链接均映射到新 ID，源任务不变。另在真实 `DuplicateProject` 提交成功后丢弃 HTTP 响应：表单保留原 commandId、禁止再次提交，查询原收据打开唯一的 `Receipt Reconciled Copy`。
- 归档后可从 `?archive=archived` 恢复；未归档/仍被任务引用的项目禁止永久删除，无引用归档项目完整名称确认后删除。390px 已加载设置弹窗为358×812px，无横向溢出；菜单边界、Escape 返回触发器、Tab 留在弹窗均实际检查。
- 集成修复：归档项目必须保留在 PM 项目目录中；无原负责人时编辑器从当前有权成员提供候选；复制 ID 数字解析及正式生命周期 payload 合同对齐。
- 工程检查：`TMPDIR=/tmp pnpm check`、最终 `pnpm check:web` 及文档链接/领域引用检查通过。前端仍有大 chunk 和静态/动态导入混用提示，未隐藏告警。
- 最终专项：`TMPDIR=/tmp node --env-file=.env --test --test-concurrency=1 tests/project-copy.integration.test.ts tests/project-sidebar-order.integration.test.ts tests/project-menu-model.test.ts tests/project-share-model.test.ts`：26 项通过，0 失败、0 取消、0 跳过；包括重启/绑定故障后的原复制恢复、两种删除入口及用户代码保留、私有排序/权限/CAS、分享范围和菜单模型。
- 全量数据库回归未通过：`pnpm test:backend` 的账号邮件 Worker 用例失败；密码找回套件在120001ms触及其120秒总时限，后续用例取消。运行在这些失败后中止，未取得全量最终汇总，也不计为通过。这些账号/邮件模块未改动，Worker 失败根因尚未独立定位；不通过改动无关实现或放宽测试来制造全绿。
- 环境记录：默认 HDD 临时目录的并发检查曾因既有 watcher 测试10秒超时取消；`/dev/shm` 被真实项目目录安全策略拒绝，未放宽守卫。改用允许的 `/tmp` 后 watcher 通过，不将前两次失败计为通过。
- 清理：浏览器标签与临时服务已关闭；按三个生成工作区 ID 精确核验并删除自有随机 schema 和临时目录，未读取生成凭据文件。临时冒烟脚本和指定模型代理预设已移除。
- 激活边界：需要迁移0035并更新配套 API/Worker/Web；本批不升级既有业务数据库、不重启既有服务、不提交或推送，也不声称真实 Agent 或生产部署验收完成。
