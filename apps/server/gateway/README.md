# 同源网关（Gateway）

`apps/server/gateway/src/index.ts` 是 v4 的公共入口（默认 `http://127.0.0.1:3224`）。它把 PM API、Agent API 与 Web 静态资源收敛到同一个源上，使浏览器 Cookie、CSP 与相对路径调用保持一致，避免跨源配置。

## 职责

- 按路径把请求反向代理到 PM 或 Agent 上游，保留方法、请求头、响应头与流式响应。
- 代理 WebSocket `upgrade` 握手（`/agent/api` 等路径）。
- 对非 API 请求回退到 `apps/web/dist` 的静态资源；缺失的 SPA 路由回退到 `index.html`。
- 对内部服务路由与外部 MCP 路由做例外处理（见下表）。
- 收到 `SIGINT`/`SIGTERM` 时优雅关闭，并设置 5 秒的强制断开上限。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PUBLIC_HOST` | `127.0.0.1` | 监听地址 |
| `PUBLIC_PORT` | `3224` | 监听端口，必须为 1–65535 的整数 |
| `PM_URL` | `http://127.0.0.1:4194` | PM API 上游，仅接受无凭据、无路径/查询/片段的 `http:`/`https:` 源 |
| `AGENT_URL` | `http://127.0.0.1:4325` | Agent API 上游，校验规则同上 |
| `WEB_DEV_URL` | 未设置 | 设置后，非 API 请求代理到该开发服务器，而不是读取静态文件 |
| `WEB_DIST` | `apps/web/dist`（相对仓库根） | Web 构建产物目录 |

## 路由

| 路径 | 目标 |
| --- | --- |
| `/api`、`/api/*`、`/health`、`/health/*`、`/openapi.json` | PM 上游，路径不变 |
| `/agent/api`、`/agent/api/*` | Agent 上游，去掉 `/agent` 前缀 |
| `/mcp`、`/.well-known/oauth-protected-resource`、`/.well-known/oauth-protected-resource/mcp`、`/.well-known/oauth-authorization-server`、`/oauth/mcp/{register,authorize,approval,decision,token}` | Agent 上游，路径不变 |
| `/api/v1/internal`、`/api/v1/internal/*` | **不代理**：直接 `404`，仅允许服务间私有传输访问（百分号编码变体同样拦截） |
| 其余路径 | 静态回退：`WEB_DEV_URL` 已设置时代理到开发服务器，否则读取 `WEB_DIST` |

静态回退的细节：`/pm/**`、`/agent/**` 等应用路由在文件缺失时回退 `index.html`；带扩展名的缺失文件、`/assets/**`、`/fixtures/**` 返回 `404`，不会用 HTML 冒充资源。`/assets/**` 使用一年期的不可变缓存；`/connect-agent`、`/pm/account/**` 使用 `no-store` 与更严格的 CSP/Referrer-Policy。路径穿越、编码分隔符与非法请求目标返回 `400`/`403`。

网关本身不解析鉴权、也不做业务判断；Cookie 与认证头原样透传，鉴权仍由 PM/Agent 上游负责。

## 启动

```sh
node apps/server/gateway/src/index.ts
```

生产/本地编排由 `scripts/services.mjs` 启动同一入口，并注入 `PUBLIC_HOST`、`PUBLIC_PORT`、`PM_URL`、`AGENT_URL`（开发模式额外注入 `WEB_DEV_URL`）。

## 测试

```sh
node --test apps/server/gateway/tests/gateway.test.ts
```
