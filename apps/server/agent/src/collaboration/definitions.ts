import { createHash } from "node:crypto";
import {
  agentDefinitionSchema, agentVersionSchema, createAgentSchema, updateAgentSchema,
  teamDefinitionSchema, teamVersionSchema, createTeamSchema, updateTeamSchema,
  copyDefinitionSchema, restoreDefinitionVersionSchema, definitionRequestSchema,
  type AgentConfig, type AgentDefinition, type AgentVersion, type TeamConfig, type TeamDefinition, type TeamVersion,
  type CollaborationResourceLimits, type RunDefinition, type DefinitionRequest,
} from "../../../../../packages/agent-contracts/src/collaboration.ts";
import { DurableError } from "../durable/errors.ts";
import { listRecords, readRecord, transaction, writeRecord } from "../durable/store.ts";

/** Constructed only after current PM authorization; never persisted with browser credentials. */
export type DefinitionAuthority = { workspaceId: string; actorId: string };
type Config = AgentConfig | TeamConfig;
type Definition<C extends Config> = {
  id: string; workspaceId: string; revision: number; state: "active" | "disabled" | "archived";
  currentVersion: number; config: C; createdBy: string; createdAt: string; updatedAt: string;
};
type Version<C extends Config> = {
  workspaceId: string; version: number; config: C; createdBy: string; createdAt: string; restoredFromVersion?: number;
};
type Spec<C extends Config, D extends Definition<C>, V extends Version<C>> = {
  kind: "agent" | "team"; namespace: string; versionNamespace: string;
  parseDefinition: (input: unknown) => D; parseVersion: (input: unknown) => V;
  versionIdentity: (id: string) => { agentId: string } | { teamId: string };
  validateConfig: (config: C, workspaceId: string) => void;
  copyConfig: (config: C, name: string) => C;
};
const agentSpec: Spec<AgentConfig, AgentDefinition, AgentVersion> = {
  kind: "agent", namespace: "collaboration:agents", versionNamespace: "collaboration:agent-versions",
  parseDefinition: input => agentDefinitionSchema.parse(input), parseVersion: input => agentVersionSchema.parse(input),
  versionIdentity: agentId => ({ agentId }), validateConfig: () => {},
  copyConfig: (config, name) => ({ ...config, name, owner: { ...config.owner, actorId: null }, allowedProjectIds: [] }),
};
const teamSpec: Spec<TeamConfig, TeamDefinition, TeamVersion> = {
  kind: "team", namespace: "collaboration:teams", versionNamespace: "collaboration:team-versions",
  parseDefinition: input => teamDefinitionSchema.parse(input), parseVersion: input => teamVersionSchema.parse(input),
  versionIdentity: teamId => ({ teamId }), validateConfig: assertTeamMembers,
  copyConfig: (config, name) => ({ ...config, name, allowedProjectIds: [] }),
};
const requestNamespace = "collaboration:definition-requests";
const versionKey = (id: string, version: number) => JSON.stringify([id, version]);
const requestKey = (authority: DefinitionAuthority, requestId: string) => JSON.stringify([authority.workspaceId, authority.actorId, requestId]);
function unavailable(): never { throw new DurableError(404, "definition_not_found", "Agent or Team definition is unavailable in this workspace."); }
function scope(definition: { workspaceId: string }, authority: DefinitionAuthority): void {
  if (definition.workspaceId !== authority.workspaceId) unavailable();
}
function expectedRevision(definition: { revision: number }, revision: number): void {
  if (definition.revision !== revision) throw new DurableError(409, "definition_revision_conflict", "Definition changed. Read the current version before explicitly saving again.");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function mutate<C extends Config, D extends Definition<C>, V extends Version<C>>(
  spec: Spec<C, D, V>, authority: DefinitionAuthority, requestId: string, operation: string,
  input: unknown, apply: () => D,
): D {
  const fingerprint = createHash("sha256").update(canonical({ operation, input })).digest("hex");
  return transaction(() => {
    const key = requestKey(authority, requestId), previous = readRecord<DefinitionRequest>(requestNamespace, key);
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.kind !== spec.kind)
        throw new DurableError(409, "idempotency_conflict", "This definition request ID was already used with different parameters.");
      return spec.parseDefinition(previous.result);
    }
    const result = apply();
    const receipt = definitionRequestSchema.parse({ requestId, fingerprint, kind: spec.kind, definitionId: result.id, result });
    writeRecord(requestNamespace, key, receipt);
    return result;
  });
}
function get<C extends Config, D extends Definition<C>, V extends Version<C>>(spec: Spec<C, D, V>, id: string): D | null {
  const record = readRecord<unknown>(spec.namespace, id);
  return record === null ? null : spec.parseDefinition(record);
}
function getVersion<C extends Config, D extends Definition<C>, V extends Version<C>>(spec: Spec<C, D, V>, id: string, version: number): V | null {
  const record = readRecord<unknown>(spec.versionNamespace, versionKey(id, version));
  return record === null ? null : spec.parseVersion(record);
}
function persistVersion<C extends Config, D extends Definition<C>, V extends Version<C>>(
  spec: Spec<C, D, V>, definition: D, actorId: string, restoredFromVersion?: number,
): void {
  const key = versionKey(definition.id, definition.currentVersion);
  if (readRecord(spec.versionNamespace, key) !== null) throw new DurableError(409, "definition_version_exists", "Published definition versions are immutable.");
  const frozen = spec.parseVersion({ ...spec.versionIdentity(definition.id), workspaceId: definition.workspaceId,
    version: definition.currentVersion, config: definition.config, createdBy: actorId, createdAt: definition.updatedAt,
    ...(restoredFromVersion === undefined ? {} : { restoredFromVersion }),
  });
  writeRecord(spec.versionNamespace, key, frozen);
}
function create<C extends Config, D extends Definition<C>, V extends Version<C>>(
  spec: Spec<C, D, V>, authority: DefinitionAuthority, input: { id: string; workspaceId: string; requestId: string; config: C },
): D {
  scope(input, authority);
  return mutate(spec, authority, input.requestId, `${spec.kind}:create`, input, () => {
    if (get(spec, input.id)) throw new DurableError(409, "definition_id_conflict", "Definition ID already exists; it was not replaced.");
    spec.validateConfig(input.config, input.workspaceId);
    const now = new Date().toISOString();
    const definition = spec.parseDefinition({ id: input.id, workspaceId: input.workspaceId, revision: 1, state: "active", currentVersion: 1,
      config: input.config, createdBy: authority.actorId, createdAt: now, updatedAt: now });
    persistVersion(spec, definition, authority.actorId);
    writeRecord(spec.namespace, definition.id, definition);
    return definition;
  });
}
function update<C extends Config, D extends Definition<C>, V extends Version<C>>(
  spec: Spec<C, D, V>, id: string, authority: DefinitionAuthority,
  input: { requestId: string; revision: number; config?: C; state?: "active" | "disabled" | "archived" },
): D {
  return mutate(spec, authority, input.requestId, `${spec.kind}:update`, { id, ...input }, () => {
    const previous = get(spec, id) ?? unavailable(); scope(previous, authority); expectedRevision(previous, input.revision);
    if (input.config) spec.validateConfig(input.config, authority.workspaceId);
    const next = spec.parseDefinition({ ...previous, revision: previous.revision + 1,
      state: input.state ?? previous.state, config: input.config ?? previous.config,
      currentVersion: previous.currentVersion + (input.config ? 1 : 0), updatedAt: new Date().toISOString() });
    if (input.config) persistVersion(spec, next, authority.actorId);
    writeRecord(spec.namespace, id, next);
    return next;
  });
}
function copy<C extends Config, D extends Definition<C>, V extends Version<C>>(
  spec: Spec<C, D, V>, id: string, authority: DefinitionAuthority,
  input: { requestId: string; id: string; revision: number; name: string },
): D {
  return mutate(spec, authority, input.requestId, `${spec.kind}:copy`, { sourceId: id, ...input }, () => {
    const previous = get(spec, id) ?? unavailable(); scope(previous, authority); expectedRevision(previous, input.revision);
    if (get(spec, input.id)) throw new DurableError(409, "definition_id_conflict", "Copy target already exists; it was not replaced.");
    const config = spec.copyConfig(previous.config, input.name); spec.validateConfig(config, authority.workspaceId);
    const now = new Date().toISOString();
    const next = spec.parseDefinition({ id: input.id, workspaceId: authority.workspaceId, revision: 1, state: "active", currentVersion: 1,
      config, createdBy: authority.actorId, createdAt: now, updatedAt: now });
    persistVersion(spec, next, authority.actorId); writeRecord(spec.namespace, next.id, next);
    return next;
  });
}
function restore<C extends Config, D extends Definition<C>, V extends Version<C>>(
  spec: Spec<C, D, V>, id: string, authority: DefinitionAuthority,
  input: { requestId: string; revision: number; version: number },
): D {
  return mutate(spec, authority, input.requestId, `${spec.kind}:restore-version`, { id, ...input }, () => {
    const previous = get(spec, id) ?? unavailable(); scope(previous, authority); expectedRevision(previous, input.revision);
    const source = getVersion(spec, id, input.version) ?? unavailable(); scope(source, authority);
    spec.validateConfig(source.config, authority.workspaceId);
    const next = spec.parseDefinition({ ...previous, revision: previous.revision + 1, currentVersion: previous.currentVersion + 1,
      config: source.config, updatedAt: new Date().toISOString() });
    persistVersion(spec, next, authority.actorId, source.version); writeRecord(spec.namespace, id, next);
    return next;
  });
}
function list<C extends Config, D extends Definition<C>, V extends Version<C>>(spec: Spec<C, D, V>, workspaceId: string): D[] {
  return listRecords<unknown>(spec.namespace).map(spec.parseDefinition).filter(item => item.workspaceId === workspaceId);
}
function versions<C extends Config, D extends Definition<C>, V extends Version<C>>(spec: Spec<C, D, V>, id: string): V[] {
  return listRecords<unknown>(spec.versionNamespace).map(spec.parseVersion)
    .filter(item => ("agentId" in item ? item.agentId : "teamId" in item ? item.teamId : null) === id).sort((a, b) => b.version - a.version);
}
function assertTeamMembers(config: TeamConfig, workspaceId: string): void {
  for (const member of config.members) {
    const definition = getAgentDefinition(member.agentId), frozen = getAgentVersion(member.agentId, member.agentVersion);
    if (!definition || !frozen || definition.workspaceId !== workspaceId || frozen.workspaceId !== workspaceId)
      throw new DurableError(412, "team_member_unavailable", "Every Team member must reference a published Agent version in this workspace.");
  }
  if (config.strategy === "supervisor") {
    if (config.members.length < 2 || config.resourceLimits.maxDelegationDepth < 1)
      throw new DurableError(412, "invalid_supervisor_team", "Supervisor Teams require another member and a delegation depth of at least one.");
    const member = config.members.find(item => item.agentId === config.supervisorAgentId)!;
    const supervisor = getAgentVersion(member.agentId, member.agentVersion)!;
    if (!supervisor.config.capabilityBindings.hostTools.includes("delegate_task"))
      throw new DurableError(412, "supervisor_delegation_required", "The fixed supervisor Agent version must bind delegate_task.");
  }
}

export function getAgentDefinition(id: string): AgentDefinition | null { return get(agentSpec, id); }
export function getTeamDefinition(id: string): TeamDefinition | null { return get(teamSpec, id); }
export function getAgentVersion(id: string, version: number): AgentVersion | null { return getVersion(agentSpec, id, version); }
export function getTeamVersion(id: string, version: number): TeamVersion | null { return getVersion(teamSpec, id, version); }
export function listAgentDefinitions(workspaceId: string): AgentDefinition[] { return list(agentSpec, workspaceId); }
export function listTeamDefinitions(workspaceId: string): TeamDefinition[] { return list(teamSpec, workspaceId); }
export function listAgentVersions(id: string): AgentVersion[] { return versions(agentSpec, id); }
export function listTeamVersions(id: string): TeamVersion[] { return versions(teamSpec, id); }
export function createAgentDefinition(input: unknown, authority: DefinitionAuthority): AgentDefinition { return create(agentSpec, authority, createAgentSchema.parse(input)); }
export function createTeamDefinition(input: unknown, authority: DefinitionAuthority): TeamDefinition { return create(teamSpec, authority, createTeamSchema.parse(input)); }
export function updateAgentDefinition(id: string, input: unknown, authority: DefinitionAuthority): AgentDefinition { return update(agentSpec, id, authority, updateAgentSchema.parse(input)); }
export function updateTeamDefinition(id: string, input: unknown, authority: DefinitionAuthority): TeamDefinition { return update(teamSpec, id, authority, updateTeamSchema.parse(input)); }
export function copyAgentDefinition(id: string, input: unknown, authority: DefinitionAuthority): AgentDefinition { return copy(agentSpec, id, authority, copyDefinitionSchema.parse(input)); }
export function copyTeamDefinition(id: string, input: unknown, authority: DefinitionAuthority): TeamDefinition { return copy(teamSpec, id, authority, copyDefinitionSchema.parse(input)); }
export function restoreAgentVersion(id: string, input: unknown, authority: DefinitionAuthority): AgentDefinition { return restore(agentSpec, id, authority, restoreDefinitionVersionSchema.parse(input)); }
export function restoreTeamVersion(id: string, input: unknown, authority: DefinitionAuthority): TeamDefinition { return restore(teamSpec, id, authority, restoreDefinitionVersionSchema.parse(input)); }
export function getDefinitionRequest(requestId: string, authority: DefinitionAuthority): DefinitionRequest | null {
  const record = readRecord<unknown>(requestNamespace, requestKey(authority, requestId));
  return record === null ? null : definitionRequestSchema.parse(record);
}
function assertActive(definition: { workspaceId: string; state: string; config: { allowedProjectIds: string[] } }, workspaceId: string, projectId: string): void {
  if (definition.workspaceId !== workspaceId) unavailable();
  if (definition.state !== "active") throw new DurableError(412, "definition_not_active", "Disabled or archived definitions reject new dispatch; existing executions are not silently cancelled.");
  if (!definition.config.allowedProjectIds.includes(projectId))
    throw new DurableError(403, "definition_project_restricted", "This project is outside the definition's configured project-reference ceiling.");
}
function assertVersionProject(config: { allowedProjectIds: string[] }, projectId: string): void {
  if (!config.allowedProjectIds.includes(projectId))
    throw new DurableError(403, "definition_project_restricted", "The published version does not permit this project reference.");
}
export type LaunchableDefinition = { agentVersions: AgentVersion[]; teamVersion: TeamVersion | null; resourceLimits: CollaborationResourceLimits; executionMode: "read-only" | "write" };
/** No credentials or Run dependencies. Call inside the same writer transaction that accepts a dispatch. */
export function assertDefinitionLaunchable(definition: RunDefinition, workspaceId: string, projectId: string): LaunchableDefinition {
  if (definition.kind === "agent") {
    const current = getAgentDefinition(definition.agentId) ?? unavailable(); assertActive(current, workspaceId, projectId);
    const frozen = getAgentVersion(definition.agentId, definition.agentVersion) ?? unavailable();
    if (frozen.workspaceId !== workspaceId) unavailable(); assertVersionProject(frozen.config, projectId);
    return { agentVersions: [frozen], teamVersion: null, resourceLimits: frozen.config.resourceLimits, executionMode: frozen.config.executionMode };
  }
  const current = getTeamDefinition(definition.teamId) ?? unavailable(); assertActive(current, workspaceId, projectId);
  const frozen = getTeamVersion(definition.teamId, definition.teamVersion) ?? unavailable();
  if (frozen.workspaceId !== workspaceId) unavailable(); assertVersionProject(frozen.config, projectId); assertTeamMembers(frozen.config, workspaceId);
  const agentVersions = frozen.config.members.map(member => assertDefinitionLaunchable({ kind: "agent", ...member }, workspaceId, projectId).agentVersions[0]!);
  return { agentVersions, teamVersion: frozen, resourceLimits: frozen.config.resourceLimits, executionMode: agentVersions.some(agent => agent.config.executionMode === "write") ? "write" : "read-only" };
}
