import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { approvalMode } from "./approval-mode.ts";

const COOKIE = "agent_v4_access";
const TOKEN_ENV = "AGENT_WORKSPACE_ACCESS_TOKEN";

function accessToken(): string {
  return process.env[TOKEN_ENV]?.trim() ?? "";
}

function equalSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sessionValue(token: string): string {
  return createHmac("sha256", token).update("agent-workspace:browser-access:v1").digest("hex");
}

function localHost(headers: Headers): boolean {
  try {
    const hostname = new URL(`http://${headers.get("host") ?? ""}`).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/** Host headers are forgeable; unauthenticated services must bind only to loopback. */
export function assertNetworkBinding(host: string | boolean | undefined): void {
  const local =
    host === undefined ||
    host === false ||
    (typeof host === "string" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host));
  if (local || accessToken().length >= 32) return;
  // docker.sh sets this only when its published host is loopback.
  if (process.env.AGENT_WORKSPACE_LOOPBACK_PROXY === "1") return;
  throw new Error(`非本机监听必须设置 ${TOKEN_ENV}（至少 32 个字符）。`);
}

export function sameOrigin(headers: Headers): boolean {
  if (headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = headers.get("origin");
  if (!origin) return true; // Non-browser clients authenticate separately when remote.
  try {
    return new URL(origin).host.toLowerCase() === headers.get("host")?.toLowerCase();
  } catch {
    return false;
  }
}

/** Also used for PTY upgrades, which do not pass through Hono middleware. */
export function authorizeHeaders(headers: Headers): boolean {
  // MCP credentials are never an Agent HTTP/PTY credential, including on an
  // otherwise anonymous loopback installation or alongside an access cookie.
  const authorization = headers.get("authorization") ?? "";
  if (/^Bearer pm-mcp-(?:access|service)-v1\./.test(authorization)) return false;
  const token = accessToken();
  if (!token) return localHost(headers);
  if (token.length < 32) return false;
  const bearer = headers.get("authorization");
  if (bearer?.startsWith("Bearer ") && equalSecret(bearer.slice(7), token)) return true;
  const cookie = headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  return cookie !== undefined && equalSecret(cookie, sessionValue(token));
}

export const accessGuard: MiddlewareHandler = async (c, next) => {
  if (!sameOrigin(c.req.raw.headers)) {
    return c.json({ error: "拒绝跨站访问工作区。", code: "cross_origin" }, 403);
  }
  if (!authorizeHeaders(c.req.raw.headers)) {
    return c.json({ error: "请先验证工作区访问令牌。", code: "access_required" }, 401);
  }
  return next();
};

export const accessRoutes = new Hono()
  .get("/access", (c) => {
    if (!sameOrigin(c.req.raw.headers)) return c.json({ error: "拒绝跨站访问。" }, 403);
    const token = accessToken();
    return c.json({
      authorized: authorizeHeaders(c.req.raw.headers),
      configured: token.length >= 32,
      approvalMode: approvalMode(),
      message:
        token && token.length < 32
          ? `${TOKEN_ENV} 至少需要 32 个字符。`
          : !token && !localHost(c.req.raw.headers)
            ? `远程访问需要在服务端设置 ${TOKEN_ENV}（至少 32 个字符）。`
            : null,
    });
  })
  .post("/access", bodyLimit({ maxSize: 4096 }), async (c) => {
    if (!sameOrigin(c.req.raw.headers)) return c.json({ error: "拒绝跨站访问。" }, 403);
    const token = accessToken();
    const body: unknown = await c.req.json().catch(() => null);
    if (
      !token ||
      token.length < 32 ||
      !body ||
      typeof body !== "object" ||
      !("token" in body) ||
      typeof body.token !== "string" ||
      !equalSecret(body.token, token)
    ) {
      return c.json({ error: "访问令牌不正确，或服务端尚未配置有效令牌。" }, 401);
    }
    setCookie(c, COOKIE, sessionValue(token), {
      httpOnly: true,
      sameSite: "Strict",
      secure: new URL(c.req.url).protocol === "https:",
      path: "/",
    });
    return c.json({ authorized: true });
  })
  .delete("/access", (c) => {
    if (!sameOrigin(c.req.raw.headers)) return c.json({ error: "拒绝跨站访问。" }, 403);
    if (getCookie(c, COOKIE))
      setCookie(c, COOKIE, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "Strict" });
    return c.json({ authorized: false });
  });
