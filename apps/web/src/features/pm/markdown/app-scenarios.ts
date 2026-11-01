/** Requirements only: applying a scenario never creates a task or executes an Agent. */
export const ideaBoardScenario = {
  id: 'ideaboard-v1',
  title: 'IdeaBoard · 用户反馈与路线图 App',
  body: `## 场景：IdeaBoard / v1
做一个可实际操作的中文用户反馈与路线图 Web App，而不是静态展示或预填成品。用于本地投资人演示，所有样例明确标为虚构演示数据，无登录、支付或公网部署。

## 用户故事
- 访客能提交标题、描述、分类（功能建议 / 问题反馈 / 体验优化），看到成功或明确的失败提示。
- 能浏览反馈、按关键词搜索、按分类和状态筛选，按最新或票数排序；无结果有空状态。
- 能投票，同一个演示浏览器对同条反馈只能投一票，可取消；不将浏览器标识冒充真实账号。
- 演示操作者可以将反馈调整为待处理、计划中、开发中、已完成；路线图按后三种状态分栏展示。
- 桌面与 390px 手机宽度均可用；设计简洁精致，有清晰标题、统计、卡片、表单校验、加载和错误提示。

## 实现约束
1. 复用仓库结构，保留已有功能、测试与 CI。使用 Node.js 24 内置 HTTP / 文件 API 和原生 HTML、CSS、JavaScript，不添加第三方依赖、远程脚本、字体或 CDN。
2. 应用放在 app/，入口固定 app/server.mjs。直接运行 node app/server.mjs 即可启动；有 PREVIEW_SOCKET 时监听该 Unix socket，否则监听 HOST（默认 127.0.0.1）和 PORT（默认 3000）。不要硬编码开发机路径。
3. 所有业务数据写入 DATA_DIR 指定目录，默认 .local/ideaboard-data；不可写入应用源码。使用原子写入和串行更新，确保并发提交/投票不丢失。服务重启保留数据。损坏存储须报错，不静默重置。
4. 真正实现后端 API；验证输入长度、分类、状态、空白标题和不存在 ID。文字使用 textContent 等安全方式展示；拒绝路径穿越，不开放目录列表或任意文件读取。提交/投票错误不能伪装成功。
5. GET /health 返回 HTTP 200 的 JSON；无需访问外网。前端资源与 API 均使用相对同源 URL，脚本使用外部文件，不使用内联事件处理、eval 或外部资源，兼容严格 self CSP。
6. 为 npm test 补充真实自动化测试：API 创建/非法输入/搜索筛选排序/投票去重与取消/状态变化/并发不丢数据/重启持久化/静态路径防穿越。测试使用临时数据目录和临时端口或 socket，关闭服务并清理自己的临时目录；不要污染演示数据。
7. 更新 README：运行、测试、数据位置、重启方法、功能范围与已知限制。数据文件、socket、日志和运行缓存必须被 Git 忽略。不得读取凭据、修改 PM 元数据、提交、推送或创建 PR。

## 验收清单
- [ ] 在浏览器真实新增一条反馈，搜索到它；投票后刷新仍显示一票，再次操作可取消。
- [ ] 修改状态后路线图出现在正确分栏；搜索无匹配有空状态。
- [ ] 停止并重启 App，反馈、票数、状态仍然保留。
- [ ] npm test 全部通过，无跳过；已有用例不回退。
- [ ] Draft PR 和必需 CI test 指向同一提交；未知、失败、跳过不能算通过。
- [ ] 通过任务的隔离预览入口实际操作；运行结束不自动完成任务。

## 推荐交付流程
保存后选择「开发并交付」，启动时选择现有 Provider 与模型，检查 npm test 和必需 CI test，并分别确认执行范围、提交、推送与 Draft PR。完成后手动启动隔离 App 预览。仅预置需求，不预置结果。`,
} as const;

/** Refuse rather than overwrite any authored title/body, even if the UI is stale. */
export function scenarioFitsDraft(draft: { kind: string; values: Record<string, unknown>; body: string; attempt?: unknown }): boolean {
  return draft.kind === 'work_item' && !draft.attempt && !String(draft.values.title ?? '').trim() && !draft.body.trim();
}
