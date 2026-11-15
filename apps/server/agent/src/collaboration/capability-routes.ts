import { Hono } from "hono";
import { z } from "zod";
import { capabilitiesQuerySchema } from "@agent-workspace/contracts/collaboration";
import { DurableError } from "../durable/errors.ts";
import { getAgentVersion } from "./definitions.ts";
import { authorizePmTarget } from "../durable/pm-context.ts";
import { defaultCapabilityBindings, readCapabilityManifest } from "./capabilities.ts";

export const collaborationCapabilityRoutes = new Hono();
collaborationCapabilityRoutes.onError((error, c) => {
  if (error instanceof z.ZodError) return c.json({ error: "Invalid capability query", code: "invalid_capability_query" }, 400);
  if (error instanceof DurableError) return c.json({ error: error.message, code: error.code }, error.status);
  const status = "status" in error ? Number(error.status) : 0;
  if (status === 401 || status === 403 || status === 404 || status === 409 || status === 412) return c.json({ error: "Capability inventory is unavailable for the current selection.", code: "capability_unavailable" }, status);
  return c.json({ error: "Capability inventory could not be read safely.", code: "capability_inventory_unavailable" }, 503);
});
collaborationCapabilityRoutes.get("/collaboration/capabilities", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const query = capabilitiesQuerySchema.parse(c.req.query());
  await authorizePmTarget({ workspaceId: query.workspaceId, projectId: query.projectId ?? null }, c.req.raw.headers);
  const agent = query.agentId && query.agentVersion ? getAgentVersion(query.agentId, query.agentVersion) : null;
  if (query.agentId && (!agent || agent.workspaceId !== query.workspaceId)) throw new DurableError(404, "agent_version_not_found", "Agent version not found in this workspace.");
  if (agent && query.providerInstanceId && agent.config.providerInstanceId !== query.providerInstanceId) throw new DurableError(409, "provider_selection_conflict", "The Provider does not match the selected Agent version.");
  const manifest = await readCapabilityManifest({
    workspaceId: query.workspaceId, providerInstanceId: agent?.config.providerInstanceId ?? query.providerInstanceId!,
    ...(query.projectId ? { projectId: query.projectId } : {}),
    capabilityBindings: agent?.config.capabilityBindings ?? defaultCapabilityBindings(), headers: c.req.raw.headers,
  });
  return c.json({ manifest });
});
