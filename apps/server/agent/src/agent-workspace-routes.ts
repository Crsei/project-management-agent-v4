import { Hono, type ErrorHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { executionSelectionSchema } from "../../../../packages/agent-contracts/src/execution.ts";
import { verifyAutomationServiceRequest } from "../../../../packages/infrastructure/src/automation-execution-client.ts";
import { browseAgentDirectories, listAgentWorkspaces, openAgentWorkspace, resolveAgentWorkspaceExecution, updateAgentWorkspace } from "./agent-workspaces.ts";
import { DurableError } from "./durable/errors.ts";

const onError: ErrorHandler = (error, c) => {
  if (error instanceof DurableError) return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: "The Agent workspace request is invalid.", code: "invalid_workspace_request" }, 400);
  return c.json({ error: "The Agent workspace service is unavailable. No replacement directory was selected.", code: "workspace_unavailable" }, 503);
};

/** Mounted only below Agent accessGuard; delegated grants are not directory-management authority. */
export const agentWorkspaceRoutes = new Hono();
agentWorkspaceRoutes.use("/agent-workspaces/*", bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: "Agent workspace request exceeds 16 KiB.", code: "request_too_large" }, 413) }));
agentWorkspaceRoutes.use("/agent-workspaces/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  const authorization = c.req.header("authorization") ?? "";
  if (/^Bearer pm-(?:mcp|automation|service)/.test(authorization) || c.req.raw.headers.has("x-pm-automation-signature") || c.req.raw.headers.has("x-pm-automation-timestamp")) {
    return c.json({ error: "Delegated credentials do not grant Agent directory access.", code: "agent_access_required" }, 403);
  }
  return next();
});
agentWorkspaceRoutes.onError(onError);
agentWorkspaceRoutes.get("/agent-workspaces", c => c.json({ workspaces: listAgentWorkspaces() }));
agentWorkspaceRoutes.get("/agent-workspaces/directories", c => {
  const query = z.strictObject({ path: z.string().optional() }).parse(c.req.query());
  return c.json(browseAgentDirectories(query.path));
});
agentWorkspaceRoutes.post("/agent-workspaces/open", async c => c.json({ workspace: openAgentWorkspace(await c.req.json()) }));
agentWorkspaceRoutes.patch("/agent-workspaces/:id", async c => c.json({ workspace: updateAgentWorkspace(c.req.param("id"), await c.req.json()) }));

/** Owned PM business preflight uses the existing method/path/body-bound service HMAC, never access-cookie bypass. */
export const internalAgentWorkspaceRoutes = new Hono();
internalAgentWorkspaceRoutes.use("*", bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: "Agent workspace request exceeds 16 KiB.", code: "request_too_large" }, 413) }));
internalAgentWorkspaceRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  const headers = c.req.raw.headers;
  if (headers.has("origin") || [...headers.keys()].some(name => name.startsWith("sec-fetch-"))) {
    return c.json({ code: "service_only", error: "Workspace preflight accepts authenticated owned-service requests only." }, 403);
  }
  const body = await c.req.text();
  if (!verifyAutomationServiceRequest(c.req.method, new URL(c.req.url).pathname, body, headers)) {
    return c.json({ code: "service_auth_required", error: "A valid dedicated PM service signature is required." }, 401);
  }
  return next();
});
internalAgentWorkspaceRoutes.onError(onError);
internalAgentWorkspaceRoutes.post("/resolve", async c => {
  const { executionSelection } = z.strictObject({ executionSelection: executionSelectionSchema }).parse(await c.req.json());
  if (executionSelection.agentWorkspaceId === null) throw new DurableError(400, "agent_workspace_required", "Business directory preflight requires an explicit Agent workspace selection.");
  return c.json(resolveAgentWorkspaceExecution(executionSelection));
});
