# Dovspace 的 Koishi + Satori 运行时

这是**独立于本仓库 pnpm workspace** 的可选 IM 网关运行时说明。不要把本目录安装的 `node_modules`、Koishi 账号数据或 token 提交到仓库；不要修改相邻的 Koishi 源码检出。

## 组件与端口

| 组件 | 端口 | 绑定 |
| --- | --- | --- |
| Koishi + Satori server | 5140 | `127.0.0.1` |
| Koishi Console（可选） | 5141 | `127.0.0.1` |
| Dovspace PM API | 4194 | 现有配置 |
| Dovspace Worker | 无监听 | 现有配置 |

Satori 只提供消息、事件与发送接口；PM 身份、项目权限、任务命令和通知仍由 Dovspace 处理。

## 1. 创建独立运行时

在本仓库外创建目录，例如 `~/.local/share/dovspace/koishi`，复制 `package.json.example` 为 `package.json`，然后安装并锁定精确版本：

```bash
mkdir -p ~/.local/share/dovspace/koishi
cd ~/.local/share/dovspace/koishi
cp /path/to/project-management-agent-v4/deploy/koishi/package.json.example package.json
cp /path/to/project-management-agent-v4/deploy/koishi/koishi.example.yml koishi.yml
npm install
```

不要使用本仓库的 `pnpm install`，也不要让 Koishi 运行时读取本仓库的 `.env`。

## 2. 生成并注入秘密

在本仓库根目录生成 Satori server token：

```bash
node scripts/setup-satori-token.mjs
# 默认写入 .local/satori-token（0600），已有文件不覆盖
```

Telegram bot token 由 BotFather 生成，写入 Koishi 运行时的私有 `.env`：

```dotenv
SATORI_TOKEN=<复制 .local/satori-token 的内容>
TELEGRAM_BOT_TOKEN=<Telegram bot token>
```

`.env` 必须为 0600，且不要提交。`koishi.example.yml` 使用 `${{ env.* }}` 插值；如果你的 Koishi 版本不支持该写法，改为在 Console 中配置，仍然不要把 token 写入可提交文件。

## 3. 配置 Dovspace

PM API 与 Worker 需要同一组连接值。将以下内容加入本仓库的 `.env` **和** `.env.worker`，路径按实际绝对路径替换：

```dotenv
IM_SATORI_WS_URL=ws://127.0.0.1:5140/satori
IM_SATORI_API_URL=http://127.0.0.1:5140/satori
IM_SATORI_TOKEN_FILE=/absolute/path/to/project-management-agent-v4/.local/satori-token
IM_PLATFORM_ALLOWLIST=telegram
# Optional but required for the “Open Telegram” button:
IM_BOT_USERNAME=your_telegram_bot
# Stable identity for this gateway; keep it unchanged when reconnecting the same bot.
IM_GATEWAY_ID=default
```

可选：`IM_DELIVERY_TIMEOUT_MS`（1000–60000，默认 10000）、`IM_LINK_TTL_SECONDS`（300–900，默认 300）。`IM_GATEWAY_ID` 标识同一网关实例；`IM_BOT_USERNAME` 用于设置页生成 `https://t.me/...` 链接。

API 主动连接 Satori 并处理入站命令；绑定后的常规回复和通知由 Worker 持久投递，`/help`、未绑定提示等直连回复由 API 发送。两者都必须能读取同一 token 文件。不要设置 `IM_SATORI_*` 的一部分后重启，部分配置会直接失败。

## 4. 启动顺序

1. 启动 Koishi：`npm start`（或你的 systemd 用户单元）。
2. 启动/重启 PM API 与 Worker，使配置生效。
3. 打开 `/pm/<workspace>/settings/im` 生成链接码。
4. 在获准的 Telegram 测试私聊中发送 `/link <链接码>`（默认 5 分钟内有效，128 位随机值，服务端只保存摘要），再发送 `/use <专用验收项目ID>` 和 `/tasks`。这会绑定账号、设置默认项目并发送真实回复，不创建任务。`/task <标题>` 是另行授权的业务写入，不属于启动必需步骤。

PM API 启动时连接 `IM_SATORI_WS_URL`；Worker 消费 `im_delivery_jobs`。停止顺序相反：先停 PM API/Worker，再停 Koishi。

## 5. 安全边界

- 仅绑定回环地址；远程 Koishi 必须使用 `wss://`/HTTPS 和私有网络，不能把 5140/5141 暴露到公网。
- 首期只支持私聊文字命令；群聊、文件、按钮、任意命令转发和 Agent/终端能力均不开放。
- 链接码是短期凭据；不要转发、记录或放进 URL。撤销后原绑定不能继续授权业务命令；不代表已发送消息被撤回，或在途发送从未发生。未绑定的 `/help` 等提示仍可能回复。
- 出站发送结果未知时不会自动重发；使用 `node --env-file=.env.worker scripts/im-delivery-admin.ts status` 查看，确认平台侧后再 `node --env-file=.env.worker scripts/im-delivery-admin.ts retry <id>`。
- 真实 Telegram 账号、平台限流、消息可达性和 Koishi 版本升级必须单独验收；健康检查或连接成功不等于这些结果。

## 6. 状态核对与最小真实验收

不希望启用 IM 时，不配置三个必需连接字段；仅设置用户名/allowlist 等可选字段不会启用。任一必需字段非空便要求三者完整且 URL、私有 token 文件合法，配置错误会阻止 API/Worker 启动，不会回退成 `disabled`。勿为状态检查自动创建 token、安装 Koishi、修改环境或重启服务。

既有只读入口：

```bash
# 先使用本实例真实 PM 会话，并选择已授权的 PM_API_URL / PM_WORKSPACE_ID。
pnpm run pm im status
# 只读聚合队列计数与最旧待处理时间；不输出消息正文或逐条 deliveryId。
node --env-file=.env.worker scripts/im-delivery-admin.ts status
```

`im status` 对应 `GET /api/v1/workspaces/{workspaceId}/im`。逐层记录 `configuration`、`connectivity.satori.state` / `lastErrorCode`、目标 bot 的 `status`，以及当前用户自己的绑定状态；返回值含账号/机器人身份，不要整份粘贴到公开日志。`configured` 是配置解析结果，`ready` 是 Satori 会话状态，bot `online` 也不是 Telegram 送达证明。全局 `/api/v1/capabilities` 没有 IM 字段，不能因其未列 IM 而判断禁用。

只有真实 bot、测试用户私聊、API/Worker 同一 gateway/token、专用项目和外发授权齐备时，才执行最小验收：

1. 先只读核对状态；若 `disabled`，本轮止于明确禁用，不启用来补验收。若连接异常，记录有限错误码及缺少的真实部署前提，不用模拟 Satori 作为平台通过证据。
2. 由获准测试用户私聊一次 `/help`，由同一用户确认实际回复，覆盖真实平台到 API 的直连回路；这不覆盖 Worker。
3. 已有测试绑定时复用它；没有时才经明确授权生成一次链接码并私聊绑定。仅在专用项目发送 `/use <项目ID>`、`/tasks`，由用户确认原回复，结合 Worker 队列状态覆盖持久出站回路。不要用 `/task`、`/done` 或通知业务变更来制造连通性证据；通知本身须另有获准测试事件，不能从回复成功推定通过。
4. 分别保留非秘密的部署身份、测试时间、平台原消息标识、绑定标识和操作者查收结论；不要保存 token、链接码或私聊正文。状态/队列计数不能替代这份实际平台观察。

### 未知结果与清理

- 超时或租约过期的 `unknown` 不自动重发。先核对原平台消息、对应绑定与原投递；聚合 `status` 不会告诉你哪个 ID 可重试，不能从计数猜 ID 或直接扫描/导出业务消息表。缺少获准的原 deliveryId 时保留未知，交操作者按原身份核对。
- `retry <id>` 会把 unknown/failed 重新排入队列，可能造成重复平台消息；它不是诊断命令，不会替你证明旧发送没发生。只有平台侧核对与明确授权后才考虑原 ID 的一次人工动作。
- 测试后只撤销本轮创建的测试绑定，必要时关闭本轮开启的通知；复用的既有绑定、原默认项目与通知设置由操作者按记录恢复。撤销不撤回消息、不删除投递历史。
- 不删除共享 Satori token、Koishi 平台账号/运行数据、原有绑定、队列或数据库记录；不停止不是本轮新建且拥有的服务。缺少 bot、平台用户、目标私聊或外发授权时，逐项记录为外部待验，不把协议测试或健康响应标为真实 IM 通过。
