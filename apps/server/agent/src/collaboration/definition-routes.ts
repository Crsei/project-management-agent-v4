import { Hono, type ErrorHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import {
  createAgentSchema, updateAgentSchema, createTeamSchema, updateTeamSchema,
  copyDefinitionSchema, restoreDefinitionVersionSchema, definitionListQuerySchema,
  type AgentConfig, type TeamConfig,
} from "../../../../../packages/agent-contracts/src/collaboration.ts";
import { pmToolCapabilitiesSchema } from "../../../../../packages/agent-contracts/src/pm-capabilities.ts";
import { authorizePmTarget } from "../durable/pm-context.ts";
import { DurableError } from "../durable/errors.ts";
import { requestDeliveryPm } from "../task-delivery/authority.ts";
import {
  createAgentDefinition, updateAgentDefinition, copyAgentDefinition, restoreAgentVersion,
  createTeamDefinition, updateTeamDefinition, copyTeamDefinition, restoreTeamVersion,
  getAgentDefinition, getTeamDefinition, getAgentVersion, getTeamVersion,
  listAgentDefinitions, listTeamDefinitions, listAgentVersions, listTeamVersions, getDefinitionRequest,
  type DefinitionAuthority,
} from "./definitions.ts";

const onError: ErrorHandler = (error, c) => {
  if (error instanceof DurableError) return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return c.json({ error: "The collaboration definition request is invalid.", code: "invalid_definition_request" }, 400);
  return c.json({ error: "Definition service is unavailable; no replacement configuration was selected.", code: "definition_unavailable" }, 503);
};
/** Current native PM scope/capabilities, not profile owners or project assignment metadata. */
async function authorizeWorkspace(workspaceId: string, headers: Headers, write = false): Promise<DefinitionAuthority> {
  const actor = await authorizePmTarget({ workspaceId, projectId: null }, headers);
  const capabilities = pmToolCapabilitiesSchema.parse(await requestDeliveryPm(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-capabilities`, headers));
  if (capabilities.scope.kind !== "workspace") throw new DurableError(403, "workspace_scope_required", "Reusable definitions require current workspace-wide PM access.");
  if (write && !capabilities.tools.some(tool => tool.name === "pm_create_project" && tool.allowed && tool.capabilities.includes("planning.edit")))
    throw new DurableError(403, "definition_edit_denied", "Current workspace planning.edit capability is required to manage reusable Agent or Team definitions.");
  return { workspaceId, actorId: actor.actorId };
}
async function validateProjects(workspaceId: string, config: AgentConfig | TeamConfig, headers: Headers): Promise<void> {
  // This is a reference ceiling only. Launch and every controlled PM action still reauthorize.
  for (const projectId of config.allowedProjectIds) {
    const capabilities = pmToolCapabilitiesSchema.parse(await requestDeliveryPm(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agent-capabilities?projectId=${encodeURIComponent(projectId)}`, headers));
    if (capabilities.scope.kind !== "projects" || !capabilities.scope.projectIds.includes(projectId))
      throw new DurableError(403, "definition_project_forbidden", "A referenced project is not currently accessible in this workspace.");
  }
}
function requireAgent(id: string) {
  const agent = getAgentDefinition(id);
  if (!agent) throw new DurableError(404, "definition_not_found", "Agent definition is unavailable.");
  return agent;
}
function requireTeam(id: string) {
  const team = getTeamDefinition(id);
  if (!team) throw new DurableError(404, "definition_not_found", "Team definition is unavailable.");
  return team;
}

/** Mount under /api, after Agent accessGuard. No service/delegated credentials become config authority. */
export const collaborationDefinitionRoutes = new Hono();
collaborationDefinitionRoutes.use("/collaboration/*", bodyLimit({ maxSize: 512 * 1024, onError: c => c.json({ code: "request_too_large", error: "Definition request exceeds 512 KiB." }, 413) }));
collaborationDefinitionRoutes.use("/collaboration/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  const authorization = c.req.header("authorization") ?? "";
  if (/^Bearer pm-(?:mcp|automation|service)/.test(authorization) || c.req.raw.headers.has("x-pm-automation-signature") || c.req.raw.headers.has("x-pm-automation-timestamp"))
    return c.json({ code: "agent_access_required", error: "Delegated execution credentials do not authorize reusable definition management." }, 403);
  return next();
});
collaborationDefinitionRoutes.onError(onError);
collaborationDefinitionRoutes.get("/collaboration/requests/:requestId", async c => {
  const { workspaceId } = definitionListQuerySchema.parse(c.req.query());
  const authority = await authorizeWorkspace(workspaceId, c.req.raw.headers);
  return c.json({ request: getDefinitionRequest(c.req.param("requestId"), authority) });
});
collaborationDefinitionRoutes.get("/collaboration/agents", async c => {
  const { workspaceId } = definitionListQuerySchema.parse(c.req.query());
  await authorizeWorkspace(workspaceId, c.req.raw.headers);
  return c.json({ agents: listAgentDefinitions(workspaceId) });
});
collaborationDefinitionRoutes.post("/collaboration/agents", async c => {
  const input = createAgentSchema.parse(await c.req.json());
  await validateProjects(input.workspaceId, input.config, c.req.raw.headers);
  const authority = await authorizeWorkspace(input.workspaceId, c.req.raw.headers, true);
  return c.json({ agent: createAgentDefinition(input, authority) });
});
collaborationDefinitionRoutes.get("/collaboration/agents/:id", async c => {
  const agent = requireAgent(c.req.param("id"));
  await authorizeWorkspace(agent.workspaceId, c.req.raw.headers);
  return c.json({ agent, versions: listAgentVersions(agent.id) });
});
collaborationDefinitionRoutes.put("/collaboration/agents/:id", async c => {
  const agent = requireAgent(c.req.param("id")), input = updateAgentSchema.parse(await c.req.json());
  if (input.config) await validateProjects(agent.workspaceId, input.config, c.req.raw.headers);
  const authority = await authorizeWorkspace(agent.workspaceId, c.req.raw.headers, true);
  return c.json({ agent: updateAgentDefinition(agent.id, input, authority) });
});
collaborationDefinitionRoutes.post("/collaboration/agents/:id/copy", async c => {
  const agent = requireAgent(c.req.param("id")), input = copyDefinitionSchema.parse(await c.req.json());
  const authority = await authorizeWorkspace(agent.workspaceId, c.req.raw.headers, true);
  return c.json({ agent: copyAgentDefinition(agent.id, input, authority) });
});
collaborationDefinitionRoutes.post("/collaboration/agents/:id/restore-version", async c => {
  const agent = requireAgent(c.req.param("id")), input = restoreDefinitionVersionSchema.parse(await c.req.json());
  const source = getAgentVersion(agent.id, input.version);
  if (source) await validateProjects(agent.workspaceId, source.config, c.req.raw.headers);
  const authority = await authorizeWorkspace(agent.workspaceId, c.req.raw.headers, true);
  return c.json({ agent: restoreAgentVersion(agent.id, input, authority) });
});
collaborationDefinitionRoutes.get("/collaboration/teams", async c => {
  const { workspaceId } = definitionListQuerySchema.parse(c.req.query());
  await authorizeWorkspace(workspaceId, c.req.raw.headers);
  return c.json({ teams: listTeamDefinitions(workspaceId) });
});
collaborationDefinitionRoutes.post("/collaboration/teams", async c => {
  const input = createTeamSchema.parse(await c.req.json());
  await validateProjects(input.workspaceId, input.config, c.req.raw.headers);
  const authority = await authorizeWorkspace(input.workspaceId, c.req.raw.headers, true);
  return c.json({ team: createTeamDefinition(input, authority) });
});
collaborationDefinitionRoutes.get("/collaboration/teams/:id", async c => {
  const team = requireTeam(c.req.param("id"));
  await authorizeWorkspace(team.workspaceId, c.req.raw.headers);
  return c.json({ team, versions: listTeamVersions(team.id) });
});
collaborationDefinitionRoutes.put("/collaboration/teams/:id", async c => {
  const team = requireTeam(c.req.param("id")), input = updateTeamSchema.parse(await c.req.json());
  if (input.config) await validateProjects(team.workspaceId, input.config, c.req.raw.headers);
  const authority = await authorizeWorkspace(team.workspaceId, c.req.raw.headers, true);
  return c.json({ team: updateTeamDefinition(team.id, input, authority) });
});
collaborationDefinitionRoutes.post("/collaboration/teams/:id/copy", async c => {
  const team = requireTeam(c.req.param("id")), input = copyDefinitionSchema.parse(await c.req.json());
  const authority = await authorizeWorkspace(team.workspaceId, c.req.raw.headers, true);
  return c.json({ team: copyTeamDefinition(team.id, input, authority) });
});
collaborationDefinitionRoutes.post("/collaboration/teams/:id/restore-version", async c => {
  const team = requireTeam(c.req.param("id")), input = restoreDefinitionVersionSchema.parse(await c.req.json());
  const source = getTeamVersion(team.id, input.version);
  if (source) await validateProjects(team.workspaceId, source.config, c.req.raw.headers);
  const authority = await authorizeWorkspace(team.workspaceId, c.req.raw.headers, true);
  return c.json({ team: restoreTeamVersion(team.id, input, authority) });
});
