import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { extensionBindSchema, extensionInvokeSchema, extensionProjectScopeSchema } from "@agent-workspace/contracts/extensions";
import { verifyAutomationServiceRequest } from "../../../../../packages/infrastructure/src/automation-execution-client.ts";
import { DurableError } from "../durable/errors.ts";
import { isExtensionMutationCommand, parseExtensionCommand } from "./commands.ts";
import { ExtensionError } from "./rpc.ts";
import { getExtensionHost } from "./service.ts";
import { extensionMaintenanceSchema } from "./maintenance.ts";

export const extensionRoutes = new Hono();
extensionRoutes.use("/extensions/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  const authorization = c.req.header("authorization") ?? "";
  if (/^Bearer pm-(?:mcp|automation|service)/.test(authorization) || c.req.header("x-pm-automation-signature") || c.req.header("x-pm-automation-timestamp")) return c.json({ error: "Service and MCP credentials do not grant configuration management access.", code: "browser_access_required" }, 403);
  return next();
});
extensionRoutes.use("/extensions/contexts", bodyLimit({ maxSize: 32 * 1024 }));
extensionRoutes.use("/extensions/contexts/:contextId/invoke", bodyLimit({ maxSize: 2 * 1024 * 1024 }));
extensionRoutes.onError((error, c) => {
  if (error instanceof ExtensionError || error instanceof DurableError) return c.json({ error: error.message, code: error.code, ...(error instanceof ExtensionError && error.details ? { details: error.details } : {}) }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: "The configuration request does not match the supported command contract.", code: "invalid_request" }, 400);
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  // Provider binding errors have safe host-authored codes; do not forward raw paths or diagnostics.
  if (status === 409 || status === 403 || status === 404) return c.json({ error: "The selected Provider is unavailable or its native authority changed. Reopen the Provider's management page or reconcile its existing owner.", code: "provider_binding_changed" }, status);
  return c.json({ error: "The configuration service is unavailable. No operation completion was inferred; read its authoritative state before retrying.", code: "extension_unavailable" }, 503);
});
extensionRoutes.get("/extensions/targets", c => c.json(getExtensionHost().targets()));
extensionRoutes.post("/extensions/providers/:providerInstanceId/context", bodyLimit({ maxSize: 32 * 1024 }), async c => {
  z.strictObject({}).parse(await c.req.json());
  return c.json(await getExtensionHost().resolveProviderContext(c.req.param("providerInstanceId")));
});
extensionRoutes.get("/extensions/contexts", async c => {
  const query = z.strictObject({ workspaceId: z.uuid().optional(), projectId: z.string().regex(/^PRJ-\d+$/).optional() }).parse(c.req.query());
  if (Boolean(query.workspaceId) !== Boolean(query.projectId)) throw new ExtensionError(400, "project_scope_required", "Select both a workspace and project for a private project context.");
  return c.json(await getExtensionHost().list(c.req.raw.headers, query.workspaceId && query.projectId ? { workspaceId: query.workspaceId, projectId: query.projectId } : undefined));
});
extensionRoutes.post("/extensions/contexts", async c => c.json(await getExtensionHost().bind(extensionBindSchema.parse(await c.req.json())), 201));
extensionRoutes.post("/extensions/contexts/resolve-enabled", bodyLimit({ maxSize: 32 * 1024 }), async c => {
  const { contextId } = z.strictObject({ contextId: z.string().min(1).max(100).optional() }).parse(await c.req.json());
  return c.json(await getExtensionHost().resolveEnabledProviderContexts(contextId));
});
extensionRoutes.delete("/extensions/contexts/:contextId", async c => {
  const body = z.strictObject({ confirmed: z.literal(true) }).parse(await c.req.json());
  if (body.confirmed) await getExtensionHost().unbind(c.req.param("contextId"));
  return c.json({ unbound: true, nativeConfigurationUnchanged: true });
});
extensionRoutes.post("/extensions/contexts/:contextId/binding", bodyLimit({ maxSize: 32 * 1024 }), async c => c.json(await getExtensionHost().rebind(c.req.param("contextId"), extensionBindSchema.parse(await c.req.json()))));
extensionRoutes.post("/extensions/contexts/:contextId/invoke", async c => {
  const body = extensionInvokeSchema.parse(await c.req.json());
  const command = parseExtensionCommand(body.command, body.args);
  await getExtensionHost().browserContext(c.req.param("contextId"), c.req.raw.headers, isExtensionMutationCommand(command.command) || command.command === "start_mcp_connectivity_checks");
  const result = await getExtensionHost().invoke(c.req.param("contextId"), command.command, command.args);
  return c.json({ result });
});
extensionRoutes.post("/extensions/contexts/:contextId/uploads", async c => {
  await getExtensionHost().browserContext(c.req.param("contextId"), c.req.raw.headers, true);
  if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/zip")) throw new ExtensionError(415, "zip_content_type_required", "Upload raw ZIP bytes using Content-Type: application/zip.");
  const length = Number(c.req.header("content-length") ?? "0");
  if (length > 100 * 1024 * 1024) throw new ExtensionError(413, "zip_too_large", "ZIP uploads are limited to 100 MiB.");
  return c.json(await getExtensionHost().upload(c.req.param("contextId"), c.req.raw.body), 201);
});
extensionRoutes.get("/extensions/contexts/:contextId/events", async c => {
  const id = c.req.param("contextId");
  await getExtensionHost().browserContext(id, c.req.raw.headers);
  return streamSSE(c, async stream => {
    let closed = false;
    const unsubscribe = await getExtensionHost().subscribe(id, event => {
      if (!closed) void stream.writeSSE({ event: event.event, data: JSON.stringify(event.data) }).catch(() => { closed = true; });
    });
    stream.onAbort(() => { closed = true; unsubscribe(); });
    try {
      while (!closed && !c.req.raw.signal.aborted) {
        await stream.sleep(15_000);
        if (closed || c.req.raw.signal.aborted) break;
        await getExtensionHost().browserContext(id, c.req.raw.headers);
        await stream.writeSSE({ event: "heartbeat", data: "{}" });
      }
    } finally { closed = true; unsubscribe(); }
  });
});

/** This is a separate HMAC service audience, never mounted below the browser access guard. */
export const extensionDefinitionRoutes = new Hono();
extensionDefinitionRoutes.use("*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));
extensionDefinitionRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.header("origin") || c.req.header("sec-fetch-site")) return c.json({ code: "service_only", error: "Private definitions accept owned PM service requests only." }, 403);
  const body = await c.req.text();
  if (!verifyAutomationServiceRequest(c.req.method, new URL(c.req.url).pathname, body, c.req.raw.headers)) return c.json({ code: "service_auth_required", error: "A valid dedicated PM service signature is required." }, 401);
  return next();
});
extensionDefinitionRoutes.onError((error, c) => {
  if (error instanceof ExtensionError) return c.json({ code: error.code, error: error.message }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ code: "invalid_definition_request", error: "Invalid private definition request." }, 400);
  return c.json({ code: "definition_unavailable", error: "The private definition authority is unavailable; no fallback configuration was read." }, 503);
});
extensionDefinitionRoutes.post("/list", async c => {
  const { scope } = z.strictObject({ scope: extensionProjectScopeSchema }).parse(await c.req.json());
  return c.json(await getExtensionHost().listDefinitions(scope));
});
extensionDefinitionRoutes.post("/resolve", async c => {
  const input = z.strictObject({ scope: extensionProjectScopeSchema, contextId: z.string().min(1).max(100), serverId: z.string().min(1).max(300) }).parse(await c.req.json());
  return c.json(await getExtensionHost().resolveDefinition(input));
});
extensionDefinitionRoutes.post("/ensure-context", async c => {
  const { scope, migrationId } = z.strictObject({ scope: extensionProjectScopeSchema, migrationId: z.string().regex(/^[0-9a-f]{64}$/).optional() }).parse(await c.req.json());
  return c.json(await getExtensionHost().ensureProjectContext(scope, true, true, migrationId));
});
extensionDefinitionRoutes.post("/import", async c => {
  const input = z.strictObject({ scope: extensionProjectScopeSchema, serverId: z.string().min(1).max(300), name: z.string().min(1).max(300), endpoint: z.string().min(1).max(8192), headers: z.record(z.string(), z.string()).optional(), migrationId: z.string().regex(/^[0-9a-f]{64}$/).optional() }).parse(await c.req.json());
  return c.json(await getExtensionHost().importDefinition(input));
});
extensionDefinitionRoutes.post("/begin-maintenance", async c => c.json(await getExtensionHost().beginMaintenance(extensionMaintenanceSchema.parse(await c.req.json()), c.req.raw.signal)));
extensionDefinitionRoutes.post("/end-maintenance", async c => c.json(await getExtensionHost().endMaintenance(extensionMaintenanceSchema.parse(await c.req.json()), c.req.raw.signal)));
