# 持久执行与主动恢复实施清单

## 范围与原则

用户确认实施全部五阶段：服务端持久化执行、Provider 多账号与会话连续性、Fork/上下文回传、定时与额度恢复、PR Watch；包含 Web/移动布局 UI、旧数据迁移、运行验证与操作文档。

保留 Hono / React / assistant-ui。SQLite（Node `node:sqlite`）为执行事实源；浏览器关闭只停止订阅，显式 Cancel 才停止任务。保留旧执行，新建 continuation；不承诺外部副作用 exactly-once。Fork 是对话分支，默认共享工作目录；Merge back 是上下文回传，不是 Git merge。无真实 Provider/PR 凭据时不制造成功结果。

参考源码已通过用户指定的 `127.0.0.1:17891` 代理更新：`t3code/main` → `d53873b6a4799e87afd63c8d288ef0089f5a3748`。实现由五个 `studio-sol` 子代理按本会话指定的 `gpt-6.1-sol:xhigh` 并行完成，主线程负责共享入口、集成修复及最终验收；模型覆盖未保存为全局配置。

## 清单

- [x] A. SQLite 存储、事务、持久化请求快照、事件序号、排队与取消
- [x] A. Run/步骤结果服务端权威；断线补读；重启结算和显式/授权续跑
- [x] B. 可配置 Provider 实例及账号隔离；保留现有 API Key/CLI 入口
- [x] B. CLI 原生 session/turn 引用、resume/native fork 能力；模型切换与 portable handoff
- [x] C. 服务端聊天历史和 Thread 级模型设置；幂等迁移 localStorage 历史
- [x] C. 稳定边界 Fork、来源标记、上下文回传预览和单次消费
- [x] D. 定时任务创建/编辑/暂停/恢复/立即执行/删除，明确时区和错过策略
- [x] D. 结构化额度错误、reset 时间、授权/取消恢复、实例绑定和去重
- [x] E. GitHub PR checks/review/comments/conflicts 轮询、水位去重、停止和排队唤醒
- [x] F. Runs/Automation/Provider/Thread 控件接入桌面和移动 Sheet
- [x] G. 集成检查、真实页面交互、重启/断线/取消/幂等场景冒烟
- [x] G. README、设计采用记录及本清单更新为实际验证状态

## 并行边界

1. DurableCore：`server/durable/**`（除 threads.ts/chat*.ts）、`server/workspace.ts`、`lib/workspace-types.ts`、`lib/durable-types.ts`。负责执行和 Fork/merge API。
2. ProviderSessions：`server/providers/**`、`server/agents/**`、`lib/provider-types.ts`、`hooks/use-providers.ts`、`src/settings/**`。负责实例和原生能力。
3. ChatContinuity：`server/chat.ts`、`server/durable/threads.ts`、`server/durable/chat*.ts`、`src/assistant.tsx`、新增 `src/chat/**`、`hooks/use-chat-settings.ts`。负责远程历史、聊天生命周期和 Thread 设置。
4. Automation：`server/automation/**`、`lib/automation-types.ts`。负责定时、额度和 GitHub PR 监测，复用 durable engine。
5. WorkspaceUI：`src/workspace/**`、`styles/live-workspace.css`、工作区导航组件。负责资源持久化迁移、运行控制、Fork/merge、自动化界面；不改 Provider settings 页面。
6. 主线程：共享入口 `server/app.ts`、`server/index.ts`、`vite.config.ts`、部署/依赖、文档、最终集成与验证。子代理不得中途运行 build/lint/tests/formatters。

## 固定共享接口

### 存储（DurableCore 提供）

`server/durable/store.ts`：

- `getDatabase(): DatabaseSync`（懒打开，`AGENT_WORKSPACE_DATA_DIR` 下 workspace.sqlite，默认 ~/.agent-workspace）
- `readRecord<T>(namespace: string, key: string): T | null`
- `writeRecord<T>(namespace: string, key: string, value: T): void`
- `deleteRecord(namespace: string, key: string): void`
- `listRecords<T>(namespace: string): T[]`
- `transaction<T>(fn: () => T): T`

命名空间各模块独占；运行、事件、幂等提交必须用事务。初始化/迁移不覆写用户数据。单机单服务进程，重复进程必须明确拒绝或正确租约化。

### 执行（DurableCore 提供）

`lib/durable-types.ts`：`DurableRunRequest = WorkspaceRunRequest & { threadId: string; name: string; kind: 'agent' | 'workflow'; idempotencyKey?: string; continuationOf?: string }`。

`server/durable/engine.ts`：

- `submitRun(request: DurableRunRequest): Promise<WorkspaceRun>`：持久化后入队并返回；同 Thread 串行，不等待执行完成。
- `getRun(runId: string): WorkspaceRun | null`
- `getRunRequest(runId: string): DurableRunRequest | null`
- `listRuns(threadId?: string): WorkspaceRun[]`
- `cancelRun(runId: string): Promise<void>`
- `continueRun(runId: string, options?: { idempotencyKey?: string; confirmSideEffects?: boolean }): Promise<WorkspaceRun>`
- `startExecution(): Promise<void>` / `stopExecution(): Promise<void>`，幂等。

Run 扩展：threadId、queued 状态、完整 request 快照（服务端）、continuationOf、结构化 errorClass/resetAt/providerInstanceId、native session 信息（通过 Provider 类型）。正在执行的请求不随客户端断线取消。完成步骤只复用已确认输出；CLI 副作用未知时需确认或原生安全续接，不盲重放。

工作区 API（Hono 挂在 /api）：

- `GET/PUT /workspace/threads/:threadId`：`ThreadWorkspace` 资源；PUT 不允许覆盖服务端 runs；采用 revision 防止陈旧写覆盖。
- `POST /workspace/import`：旧 localStorage threads 的幂等迁移，仅导入历史，不执行。
- `POST /workspace/runs`：DurableRunRequest → `{run}`，202。
- `GET /workspace/runs?threadId=...` → `{runs}`。
- `GET /workspace/runs/:id` → `{run}`。
- `GET /workspace/runs/:id/events?after=N`：带持久 seq 的 NDJSON 回放/订阅。
- `POST /workspace/runs/:id/cancel`、`/continue`。
- `POST /workspace/runs/:id/fork` → `{threadId, run?}`：稳定边界、复制资源和有限上下文，原生 fork 懒执行。
- `GET /workspace/threads/:id/merge-preview` → `{text, parentThreadId, ...}`。
- `POST /workspace/threads/:id/merge`：明确确认后创建一次性 transfer；不会自动执行父 Thread。

旧 POST /workspace/run 在调用者迁移后删除，不保留另一套执行器。

### Provider（ProviderSessions 提供）

保留 `resolveProviderRuntime` / `runCliRuntime` 入口，扩展 options 的会话参数与返回的原生会话引用；新增实例级 cwd/env/config home 与 capability 声明，秘密仅服务端。向 DurableCore/ChatContinuity 发消息公布最终明确 TypeScript 参数。支持 Codex/Claude 真正原生 resume/fork；不支持的能力明确拒绝或有记录地 portable handoff，不能伪造 session ID。结构化错误至少含 usage_limit/resetAt，原错误文本仍脱敏。实例 CRUD API 与 UI 同步实现。

### 聊天/Thread（ChatContinuity 提供）

`server/durable/threads.ts` 仅依赖 store（避免循环）：`ensureThread(threadId: string, title?: string): void`、`forkThreadHistory(sourceThreadId: string, targetThreadId: string, context?: string): void`；向 Core 公布实际存储/调用契约。Thread 元数据与 assistant-ui 格式消息走服务端；迁移幂等、保留本地备份、失败不覆盖。聊天输出不能因断开丢失；重连恢复已保存结果/活动流；显式取消可用；原生会话 refs 服务端维护。全局语音偏好可保留本地，Provider/model/system/temperature 按 Thread 保存。

### 自动化（Automation 提供）

`server/automation/index.ts`：`automationRoutes`、`startAutomation(): Promise<void>`、`stopAutomation(): Promise<void>`。调用 engine，不实现第二执行器。自己负责 `lib/automation-types.ts`，尽早通知 WorkspaceUI 精确字段。

- `GET/POST /automation/schedules`，`PUT/DELETE /automation/schedules/:id`，`POST .../:id/run`：interval/fixed_time+weekdays，明确服务端时区，暂停/恢复，持久派发身份，区分 dispatch 与 run 结果。
- `PUT /automation/recovery/:runId`：`{enabled:boolean}`；可恢复信息随 Run 展示；默认不自动恢复，无 resetAt 不臆测。
- `GET/POST /automation/watches`，`PUT/DELETE /automation/watches/:id`，`POST .../:id/check`：GitHub owner/repo/number、threadId、执行模板、enabled；使用本机 gh 凭据/服务端 token，不向前端传 secret；轮询 checks/reviews/comments/conflict，去重、限频和忙时排队。

### 生命周期与安全

主线程挂路由、启动 worker、关闭 worker；Vite dev 和生产复用同一生命周期，热更新不得重复 worker。保持默认 loopback；远程监听必须显式配置访问令牌，敏感写入做同源/认证防护；不默认开放公网。后台自动化需要常驻 server，文档明确停机不执行。Provider 调用不在验证时访问真实计费模型。

## 验收矩阵

- 持久化：刷新、关闭订阅、重启、重复提交、旧数据导入、并发取消。
- 连续性：同实例切模型、跨 Provider handoff、账号隔离、原生 resume/fork 命令协议、失败边界 portable。
- Fork/merge：原记录不变、历史边界正确、直接父级约束、重复 merge 不重复消费。
- 调度：暂停后无触发、手动执行、重启后不爆发补跑、相同派发不重复、服务端时区。
- 额度：缺 reset 不自动恢复、到期前不恢复、取消/实例变化/已有后续运行不恢复。
- PR：重复快照不唤醒、新 CI/评论/冲突触发、停止后迟到结果无效、忙时队列、读取失败不伪成功。
- UI：桌面/390px 移动、表单失败保留输入、状态真实性、可达按钮、无横向溢出。

## 最终验收记录（2026-10-24）

实现完成。最终 `pnpm lint`（oxlint + 全项目格式检查）和 `bash -n docker.sh` 通过；验收服务均已正常退出，临时数据目录已清理。以下区分真实应用链路、协议夹具和未执行的线上验证。

| 检查         | 实际结果                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`  | 96/96 通过，覆盖隔离账号、原生 CLI 协议、迁移、执行序列、取消、重启、Fork/merge、定时派发、额度恢复和 GitHub 水位/限流。                                                                 |
| `pnpm build` | TypeScript 与生产构建通过。保留依赖 zod 的注释标注警告和大型异步 chunk 警告，没有屏蔽告警。                                                                                              |
| 生产服务     | 使用独立临时 SQLite/凭据目录启动 `node server/index.ts`；实际 HTTP/SSE、后台执行及浏览器工作区运行正常，未访问真实计费模型。                                                             |
| 断线/幂等    | 运行订阅断开后仍完成；重新提交同一请求返回原 Run，Provider 对该输入仅收到一次请求。活动聊天刷新后重新订阅且 Provider 请求数不增加。                                                      |
| 进程重启     | 对生产进程执行 SIGKILL，重启后工作区及聊天均标记 interrupted，未盲重放；显式 continuation 完成，原执行保留 interrupted。                                                                 |
| 明确取消     | 实际点击 Composer Stop，观察到 `/chat/threads/:id/cancel` 返回 200 / cancelled=true；服务端状态 cancelled，迟到 Provider 输出未改写为成功。                                              |
| Fork/merge   | 桌面完成运行 Fork 与普通聊天 Fork、打开新会话、分支回复、预览并确认回传。父会话后续一次执行包含 transfer，后续聊天不重复消费。首步失败/部分结果 portable Fork 由回归测试及独立脚本验证。 |
| Web/移动     | 1440×1000 和 390×844；实际创建 Agent、定时任务和第二账号，编辑/暂停/恢复/手动执行任务，创建暂停 PR Watch；移动页面无横向溢出。切换模型和账号后的 Thread 设置持久保存。                   |
| 额度自动恢复 | 本地 HTTP 夹具返回 429 与 reset_at；授权后真实 worker 到期派发一个 continuation 并完成，原调用与续跑合计两次。                                                                           |
| 访问保护     | 启用令牌的独立生产实例未登录 API 为 401；浏览器登录后为 200；令牌不进入 localStorage，HttpOnly cookie 不可被页面脚本读取。                                                               |

### 集成中修复的真实问题

- SDK 的已解析 error data 会丢弃 Provider 扩展字段：优先读取原始 JSON 响应中的 reset_at，保留真实额度重置证据。
- 新 Fork 尚未进入全局 Thread lookup 时导航白屏：历史适配器使用其已绑定的 item scope，不再依赖滞后的全局查找。
- Composer Stop 与命令面板 Stop 发出不同事件：同时订阅 composer.cancel 和 thread.cancelRun，显式取消请求服务端，普通断线仍只退订。
- 失败执行没有已完成步骤时原先无法 Fork：允许 terminal 部分/失败快照做 portable 分支，不赋予不成立的原生稳定边界。

### 尚未执行的线上验证与边界

- 未使用真实 Codex/Claude 登录账号完成计费模型的 resume/native fork 端到端调用；已验证已安装 CLI/SDK 的接口及隔离协议夹具。
- 未使用真实 GitHub 仓库凭据完成线上 PR 唤醒；分页、CI/review/评论/冲突、水位、停止、限流和队列行为由测试覆盖，移动 UI 保存了暂停状态 Watch，未发出远端请求。
- 本轮运行的是宿主 Node 24 的生产构建，不把它宣称为 Docker/Vite dev 的运行验收。
- 自动化要求服务常驻；单服务进程持有 SQLite 锁。Fork 共享工作目录，回传不是 Git merge；CLI 不明副作用必须人工确认，不能保证外部动作 exactly-once。

操作入口、数据目录和部署安全要求见 `README.md`；视觉采用与证据见 `DESIGN-ADOPTION.md`。
