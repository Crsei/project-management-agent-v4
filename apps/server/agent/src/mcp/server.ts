import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpProtocol, McpSchema, McpServer } from "effect/ai";
import { HttpRouter } from "effect/http";
import { authenticateMcpRequest, assertMcpIdentity, mcpPublicOrigin, type McpInvocationIdentity } from "./identity.ts";
import { invokeMcpTool, listMcpTools } from "./tools.ts";

// Transport derivation: copied apps/server/src/mcp/McpHttpServer.ts layerMcpTransport.
// Effect owns initialize, sessions, list/call, ping, notifications, DELETE and JSON-RPC errors.
// A runtime per grant/version prevents an authenticated caller adopting another grant's session.
type Session = { identity: McpInvocationIdentity; catalog: string; touchedAt: number; users: number; handler: (request: Request) => Promise<Response>; dispose: () => Promise<void> };
const sessions = new Map<string, Promise<Session>>();
const maximumGrants = 256;
let accepting = false;
/** Only the host runtime lifecycle may reopen external admissions. */
export function startMcpServer(): void { accepting = true; }
async function makeSession(identity: McpInvocationIdentity): Promise<Session> {
  const definitions = await listMcpTools(identity);
  const session = { identity, catalog: JSON.stringify(definitions), touchedAt: Date.now(), users: 0 } as Session;
  const registration = Layer.effectDiscard(Effect.gen(function* () {
    const registry = yield* McpServer.McpServer;
    for (const definition of definitions) yield* registry.addTool({
      tool: new McpSchema.Tool(definition), annotations: Context.empty(),
      handle: parameters => Effect.tryPromise({
        try: () => invokeMcpTool(session.identity, definition.name, parameters),
        catch: error => error,
      }).pipe(Effect.match({
        onSuccess: result => {
          const text = JSON.stringify(result);
          return new McpSchema.CallToolResult({ structuredContent: JSON.parse(text), content: [{ type: "text", text }] });
        },
        onFailure: error => new McpSchema.CallToolResult({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Tool call failed" }] }),
      })),
    });
  }));
  const transport = McpServer.layerHttp({ name: "PM Agent", version: "1.0.0", path: "/mcp", protocols: [McpProtocol.v2025_06_18], allowSessionTermination: true });
  const web = HttpRouter.toWebHandler(registration.pipe(Layer.provideMerge(transport)), { disableLogger: true });
  session.handler = web.handler; session.dispose = web.dispose;
  return session;
}
export async function closeMcpServer(): Promise<void> {
  accepting = false;
  const current = [...sessions.values()]; sessions.clear();
  await Promise.all(current.map(async pending => { const session = await pending.catch(() => null); await session?.dispose(); }));
}
export const mcpRoutes = new Hono();
mcpRoutes.onError((error, c) => {
  const status = "status" in error ? Number(error.status) : 503;
  if (status === 401 || status === 403 || status === 404 || status === 409)
    return c.json({ error: "MCP authorization or session is no longer current" }, status);
  return c.json({ error: "MCP service unavailable" }, 503);
});
mcpRoutes.use("/mcp", bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json({ error: "MCP request exceeds 1 MiB" }, 413) }));
mcpRoutes.all("/mcp", async c => {
  if (!accepting) return c.json({ error: "MCP server is stopping" }, 503);
  let identity: McpInvocationIdentity;
  try { identity = await authenticateMcpRequest(c.req.raw); await assertMcpIdentity(identity); }
  catch {
    // Issuer is configured, never inferred from a caller-controlled Host/Forwarded header.
    let issuer: string | undefined;
    try { issuer = mcpPublicOrigin(); } catch { /* Missing deployment configuration must not trust Host. */ }
    const challenge = issuer ? `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", error="invalid_token"` : 'Bearer error="invalid_token"';
    return c.json({ error: "invalid_mcp_credential" }, 401, { "www-authenticate": challenge, "cache-control": "no-store" });
  }
  const key = JSON.stringify([identity.grantId, identity.version]);
  let pending = sessions.get(key);
  if (!pending) {
    for (const [oldKey, oldPending] of sessions) {
      const old = await oldPending.catch(() => null);
      if (!old || old.users === 0 && Date.now() - old.touchedAt > 30 * 60_000) { sessions.delete(oldKey); await old?.dispose(); }
    }
    if (!accepting) return c.json({ error: "MCP server is stopping" }, 503);
    if (sessions.size >= maximumGrants) return c.json({ error: "MCP session capacity reached" }, 503);
    pending = makeSession(identity); sessions.set(key, pending);
    void pending.catch(() => { if (sessions.get(key) === pending) sessions.delete(key); });
  }
  let session: Session;
  try { session = await pending; }
  catch { return c.json({ error: "MCP scope or tool catalog unavailable" }, 503); }
  session.identity = identity; session.touchedAt = Date.now(); session.users++;
  try {
    await assertMcpIdentity(identity);
    if (JSON.stringify(await listMcpTools(identity)) !== session.catalog) {
      if (sessions.get(key) === pending) sessions.delete(key);
      await session.dispose();
      return c.json({ error: "MCP tool authority changed; initialize a new session" }, 404);
    }
    if (!accepting) return c.json({ error: "MCP server is stopping" }, 503);
    const response = await session.handler(c.req.raw);
    response.headers.set("cache-control", "no-store");
    // Source normalization: notifications accepted without content return HTTP 202.
    if (response.status === 200 && (response.body === null || response.headers.get("content-length") === "0")) return new Response(null, { status: 202, headers: response.headers });
    return response;
  } finally { session.users--; session.touchedAt = Date.now(); }
});
