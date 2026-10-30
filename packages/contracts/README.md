# Contracts

现行正式 HTTP 合同为 [openapi.yaml](../../docs/contracts/openapi.yaml)，运行时由 `GET /openapi.json` 提供。它取代 [bootstrap.openapi.yaml](../../docs/contracts/bootstrap.openapi.yaml) 的现行合同地位；旧文件保留为初始化记录。命令与路径清单以生成合同为准，不开放第三阶段执行能力。

## 生成与检查

```bash
pnpm contracts:generate
node scripts/generate-contracts.ts --check
node --test packages/contracts/tests/*.test.ts
```

[openapi.ts](src/openapi.ts) 从 CommandRegistry 的严格 Zod payload 生成 OpenAPI 3.1 `oneOf` 和 `commandType` discriminator。[生成脚本](../../scripts/generate-contracts.ts) 同时更新 YAML 与 [client.ts](src/client.ts) 中的命令 payload 类型；`--check` 只检查并在漂移时失败，不写文件。无需连接数据库或读取配置秘密。新 schema 含生成器不支持的类型会直接失败，不能静默放宽类型。

输入默认字段保持可选；字符串长度、格式等约束在 schema 中保留，但 TypeScript 不能表达全部约束。Zod 自定义 refinement、命令作用域、状态机、对象版本及跨聚合约束仍由应用服务验证。实体 `data` 和命令 `result` 首版保留为 `Record<string, unknown>` / `unknown`，尚未生成每种实体的内容模型或命令返回值类型。

## 浏览器与 Node 客户端

客户端只依赖标准 fetch，不导入后端、数据库或 Zod，支持 Node 24 与现代浏览器。所有实例必须显式选择身份模式；`none` 和 `bearer` 使用 `credentials: 'omit'`。浏览器会话示例：

```ts
import { ProjectManagementClient, CommandOutcomeUnknown } from './packages/contracts/src/client.ts';

const api = new ProjectManagementClient({
  baseUrl: window.location.origin,
  auth: { type: 'cookie', credentials: 'same-origin' },
});
await api.login({ email, password });
const { items: workspaces } = await api.listWorkspaces();
const workspace = workspaces[0];
if (!workspace) throw new Error('No workspace membership');
const command = {
  commandId: crypto.randomUUID(),
  commandType: 'CreateProject' as const,
  payload: { name: 'Release', goal: 'Ship an accepted release', ownerId: null, completionCriteria: [] },
};
try {
  const receipt = await api.executeCommand(workspace.id, command);
  if (receipt.status === 'rejected') console.error(receipt.error.code);
} catch (error) {
  if (error instanceof CommandOutcomeUnknown) {
    // This read uses the original ID. It never sends a new command.
    const receipt = await api.getCommandReceipt(error.workspaceId, error.commandId);
    console.log(receipt.status);
  } else throw error;
}
```

Node 调用方可通过 `auth: { type: 'bearer', token: () => currentSessionToken }` 显式注入已有会话，或提供 cookie 适配器。HTTP 登录只通过 `Set-Cookie` 返回令牌，不在 JSON 中公开令牌。客户端不读取环境变量、磁盘凭据或 localStorage，也不自动持久化身份。

```ts
let sessionCookie: string | undefined;
const api = new ProjectManagementClient({
  baseUrl: 'http://127.0.0.1:4194',
  auth: {
    type: 'cookie', credentials: 'same-origin',
    cookie: () => sessionCookie,
    onSetCookie: cookies => {
      const session = cookies.find(cookie => cookie.startsWith('pm_v4_session='));
      if (session) sessionCookie = session.split(';', 1)[0];
    },
  },
});
await api.login({ email, password });
```

`cookie`/`onSetCookie` 用于 Node 等能访问 Cookie 请求和响应头的宿主；浏览器由自身处理 HttpOnly cookie。服务端校验配置的 Origin，当前没有跨域 CORS；`credentials: 'include'` 本身不能开启跨域访问。

所有请求均不自动重试。`executeCommand` 对业务拒绝返回持久 receipt，对明确的 HTTP 请求错误抛 `ApiError`；传输失败、无有效成功收据或服务端 5xx 无收据时抛 `CommandOutcomeUnknown`。应查询原 commandId，保留原信封供核对；查询 404 也不能证明并行中的写入永远不会提交。相同 commandId 搭配不同请求会返回 `idempotency_conflict`。修改对象时，`expectedVersions` 必须包含所有被修改的既有对象版本；拒绝收据也受到当前权限限制。

`getReadiness` 把 503 的未就绪结果作为 Readiness 返回；capabilities 的 enabled 仅代表配置状态。`downloadArtifactVersion` 返回原始 Uint8Array 和下载头信息，不把存储的 mediaType 当作响应类型。

`api.localProjects` 提供工作区 `settings/saveSettings`、受限 `directories`、`preview`、`initialize/initialization/recover`、项目 `location/migrate/relocate`。本地创建必须携带 `{input, directory}` 与固定 `Idempotency-Key`；`directory` 为已有绝对路径，或父绝对路径加新文件夹名。开启本地能力后，正式 `CreateProject` 和原生创建入口也必须携带 `localDirectory`。主机目录权限要求全局 `access.manage`，写入另要求 `planning.edit`，不能靠路径字符串扩权。

本地操作返回 `LocalProjectAttempt`，不是 `CommandReceipt`；原 PM 命令仍按原 `commandId` 查询收据。结果未知时保留原键、输入和目录；查询 `not_found` 不允许另建意图。用户显式恢复可在核对不存在后重发完全相同的初始化输入/键，服务端仍按原键去重，客户端不会自动重试。目录迁移要求 `writersStopped:true`；`relocate` 必须明确 `mode:'move'|'rebind'`，后者仅找回已完整移动、原路径缺失且身份匹配的目录。

`api.agentContexts` 提供授权 `catalog`、`resolve`、`saveWorkspace` / `saveProject` 及 `storageSettings` / `saveStorageSettings`。根设置返回工作区保存的默认根（未覆盖时为 null）、有效根、revision 和 canManage；写入采用 `{ directory, expectedRevision }`。保存映射优先于原生项目位置，未分配作用域再采用 Chat Space 默认目录。目录册只读；默认目录首次授权 resolve 才创建并登记，之后缺失不兜底或重建。根设置改变不移动已有文件，冲突与未知响应先读取核对、不自动重试。

## 实时更新与恢复

`listEntities` 返回分页 `nextCursor` 和该页一致性快照的流 `cursor`。分页游标与事件游标是两种不同值；下一页必须保留原 kind/projectId。流游标为 int64 十进制字符串，不转成 JavaScript number。

```ts
let lastEventId = initialPage.cursor;
for await (const event of api.subscribeEvents(workspaceId, { lastEventId, signal })) {
  if (event.type === 'stream_error') {
    // Decide whether to refresh the authorized snapshot or report the failure.
    break;
  }
  lastEventId = event.id;
  if (event.type === 'change') invalidateEntity(event.event.aggregateId);
}
// Reconnect only when the caller decides, using the last processed event ID.
```

客户端处理碎片化 UTF-8、CRLF、heartbeat 注释、change、checkpoint 和 stream_error；退出迭代会取消读取，不自动重连。传入 `after` 时它优先于 `Last-Event-ID`。checkpoint 可在 project 筛选未产生 change 时推进流位置；`getChanges` 同样返回扫描后的 cursor 与 head，每批最多扫描 200 个位置。通知是缓存失效提示，读取最新实体后才能判断业务状态。

HTTP 410 `cursor_expired` 或同名 stream_error 要求重新读取获授权的实体快照，再从快照 cursor 订阅。400 `invalid_cursor` 是格式无效，409 表示游标领先当前流。每批重新检查成员权限，权限丢失可在已建立的流中产生 stream_error 并关闭。关闭、网络错误、慢消费断开以及恢复时机都由调用方处理，不代表业务写入失败。

契约测试覆盖注册表/HTTP/YAML 一致性、生成漂移、显式凭据、未知写入结果、收据查询、SSE 分片与 410、下载和真实 bootstrap HTTP 读取；它们不替代 PostgreSQL、Worker、存储的真实集成验收，也不代表浏览器端到端验收已完成。
