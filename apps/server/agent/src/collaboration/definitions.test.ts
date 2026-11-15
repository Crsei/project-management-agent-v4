import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, afterEach, test } from "node:test";
import {
  agentConfigSchema, teamConfigSchema, defaultCollaborationResourceLimits,
  type AgentConfig, type TeamConfig,
} from "../../../../../packages/agent-contracts/src/collaboration.ts";
import { closeStore, listRecords, transaction } from "../durable/store.ts";
import { DurableError } from "../durable/errors.ts";
import {
  createAgentDefinition, updateAgentDefinition, copyAgentDefinition, restoreAgentVersion,
  getAgentDefinition, getAgentVersion, listAgentVersions, listAgentDefinitions,
  createTeamDefinition, updateTeamDefinition, copyTeamDefinition, restoreTeamVersion,
  getTeamVersion, listTeamVersions, getDefinitionRequest, assertDefinitionLaunchable,
} from "./definitions.ts";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const actorId = "20000000-0000-4000-8000-000000000001";
const authority = { workspaceId, actorId };
const foreignWorkspace = "10000000-0000-4000-8000-000000000002";
let directory: string;
let previousDirectory: string | undefined;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "collaboration-definitions-"));
  previousDirectory = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = directory;
});
afterEach(async () => {
  closeStore();
  if (previousDirectory === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
  else process.env.AGENT_WORKSPACE_DATA_DIR = previousDirectory;
  await rm(directory, { recursive: true, force: true });
});
function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { name: "Developer", role: "Implement scoped changes", instructions: "Preserve original evidence.",
    providerInstanceId: "codex", model: "gpt-5.3-codex", modelOptions: [{ id: "reasoningEffort", value: "high" }],
    interactionMode: "default", temperature: 1, owner: { label: "Maintainer", actorId }, allowedProjectIds: ["PRJ-1"],
    capabilityBindings: { restriction: "observe", mcp: [{ contextId: "native", serverId: "docs", configFingerprint: null, schemaFingerprint: null }],
      skills: [{ contextId: null, skillId: "review", contentFingerprint: null }], hostTools: ["delegate_task", "ask_agent"] },
    resourceLimits: { ...defaultCollaborationResourceLimits }, executionMode: "write", ...overrides };
}
function agent(id = "developer", overrides: Partial<AgentConfig> = {}) {
  return createAgentDefinition({ requestId: `create-${id}`, id, workspaceId, config: config(overrides) }, authority);
}
function teamConfig(overrides: Partial<TeamConfig> = {}): TeamConfig {
  return { name: "Build and review", description: "Fixed-version serial handoff", members: [{ agentId: "developer", agentVersion: 1 }, { agentId: "reviewer", agentVersion: 1 }],
    strategy: "sequential", supervisorAgentId: null, allowedProjectIds: ["PRJ-1"], resourceLimits: { ...defaultCollaborationResourceLimits }, ...overrides };
}
function fails(operation: () => unknown, code: string): void {
  assert.throws(operation, error => error instanceof DurableError && error.code === code);
}

test("Agent create/update requests are durable, fingerprinted and atomically CAS-versioned", () => {
  const input = { requestId: "create", id: "developer", workspaceId, config: config() };
  const original = createAgentDefinition(input, authority);
  assert.deepEqual(createAgentDefinition(input, authority), original);
  fails(() => createAgentDefinition({ ...input, config: config({ name: "Other" }) }, authority), "idempotency_conflict");
  fails(() => createAgentDefinition({ ...input, requestId: "second-key" }, authority), "definition_id_conflict");
  const updatedConfig = config({ instructions: "Version two instructions" });
  const updated = updateAgentDefinition(original.id, { requestId: "edit", revision: 1, config: updatedConfig }, authority);
  assert.equal(updated.revision, 2); assert.equal(updated.currentVersion, 2);
  assert.equal(getAgentVersion(original.id, 1)!.config.instructions, original.config.instructions);
  assert.equal(getAgentVersion(original.id, 2)!.config.instructions, updatedConfig.instructions);
  assert.deepEqual(updateAgentDefinition(original.id, { requestId: "edit", revision: 1, config: updatedConfig }, authority), updated);
  fails(() => updateAgentDefinition(original.id, { requestId: "edit", revision: 2, state: "disabled" }, authority), "idempotency_conflict");
  fails(() => updateAgentDefinition(original.id, { requestId: "stale", revision: 1, state: "disabled" }, authority), "definition_revision_conflict");
  assert.equal(getDefinitionRequest("stale", authority), null);
  assert.equal(getDefinitionRequest("edit", authority)!.definitionId, original.id);
  assert.equal(getDefinitionRequest("edit", { ...authority, actorId: "20000000-0000-4000-8000-000000000002" }), null);
  assert.deepEqual(listAgentVersions(original.id).map(version => version.version), [2, 1]);
  closeStore();
  assert.deepEqual(getAgentDefinition(original.id), updated);
  assert.equal(listAgentDefinitions(workspaceId).length, 1);
  assert.equal(listAgentDefinitions(foreignWorkspace).length, 0);
});

test("disable/archive block new dispatch without rewriting immutable versions or execution evidence", () => {
  const original = agent();
  const launched = transaction(() => assertDefinitionLaunchable({ kind: "agent", agentId: original.id, agentVersion: 1 }, workspaceId, "PRJ-1"));
  const disabled = updateAgentDefinition(original.id, { requestId: "disable", revision: 1, state: "disabled" }, authority);
  assert.equal(disabled.currentVersion, 1);
  fails(() => assertDefinitionLaunchable({ kind: "agent", agentId: original.id, agentVersion: 1 }, workspaceId, "PRJ-1"), "definition_not_active");
  assert.deepEqual(launched.agentVersions[0], getAgentVersion(original.id, 1));
  const archived = updateAgentDefinition(original.id, { requestId: "archive", revision: 2, state: "archived" }, authority);
  assert.equal(archived.state, "archived"); assert.equal(listAgentVersions(original.id).length, 1);
  fails(() => assertDefinitionLaunchable({ kind: "agent", agentId: original.id, agentVersion: 1 }, workspaceId, "PRJ-1"), "definition_not_active");
  updateAgentDefinition(original.id, { requestId: "enable", revision: 3, state: "active" }, authority);
  assert.equal(assertDefinitionLaunchable({ kind: "agent", agentId: original.id, agentVersion: 1 }, workspaceId, "PRJ-1").agentVersions.length, 1);
});

test("rollback publishes a fresh version and copy carries configuration but no owner authorization or executions", () => {
  const original = agent();
  updateAgentDefinition(original.id, { requestId: "v2", revision: 1, config: config({ instructions: "Changed" }) }, authority);
  const restored = restoreAgentVersion(original.id, { requestId: "rollback", revision: 2, version: 1 }, authority);
  assert.equal(restored.currentVersion, 3); assert.equal(restored.config.instructions, original.config.instructions);
  assert.equal(getAgentVersion(original.id, 3)!.restoredFromVersion, 1);
  assert.equal(getAgentVersion(original.id, 2)!.config.instructions, "Changed");
  const copied = copyAgentDefinition(original.id, { requestId: "copy", id: "new-agent", revision: 3, name: "Copy" }, authority);
  assert.equal(copied.currentVersion, 1); assert.equal(copied.revision, 1);
  assert.equal(copied.config.owner.actorId, null); assert.deepEqual(copied.config.allowedProjectIds, []);
  assert.equal(copied.config.providerInstanceId, original.config.providerInstanceId);
  assert.deepEqual(copied.config.capabilityBindings, original.config.capabilityBindings);
  fails(() => assertDefinitionLaunchable({ kind: "agent", agentId: copied.id, agentVersion: 1 }, workspaceId, "PRJ-1"), "definition_project_restricted");
  assert.equal("authorization" in copied, false); assert.equal("executionGrantId" in copied, false);
  assert.equal(listRecords("collaboration:runs").length, 0);
  fails(() => copyAgentDefinition(original.id, { requestId: "copy-stale", id: "other", revision: 1, name: "No overwrite" }, authority), "definition_revision_conflict");
  fails(() => restoreAgentVersion(original.id, { requestId: "bad-rollback", revision: 3, version: 99 }, authority), "definition_not_found");
});

test("definition input rejects secret/grant transport fields and invalid capability/resource shapes", () => {
  assert.equal(agentConfigSchema.safeParse({ ...config(), apiKey: "must-not-store" }).success, false);
  assert.equal(agentConfigSchema.safeParse({ ...config(), capabilityBindings: { ...config().capabilityBindings, authorization: "Bearer forbidden" } }).success, false);
  assert.equal(agentConfigSchema.safeParse({ ...config(), capabilityBindings: { ...config().capabilityBindings, mcp: [{ contextId: "native", serverId: "s", configFingerprint: null, schemaFingerprint: null, headers: { Authorization: "forbidden" } }] } }).success, false);
  assert.equal(agentConfigSchema.safeParse({ ...config(), resourceLimits: { ...defaultCollaborationResourceLimits, maxActiveRuns: 4 } }).success, false);
  assert.equal(agentConfigSchema.safeParse({ ...config(), modelOptions: [{ id: "same", value: true }, { id: "same", value: false }] }).success, false);
  assert.equal(agentConfigSchema.safeParse({ ...config(), capabilityBindings: { ...config().capabilityBindings, hostTools: ["delegate_task", "delegate_task"] } }).success, false);
});

test("fixed Team members survive later Agent edits and rollback does not mutate published Team versions", () => {
  agent(); agent("reviewer", { executionMode: "read-only" });
  const original = createTeamDefinition({ requestId: "team-create", id: "team", workspaceId, config: teamConfig() }, authority);
  updateAgentDefinition("developer", { requestId: "agent-edit", revision: 1, config: config({ instructions: "Only v2" }) }, authority);
  const launched = assertDefinitionLaunchable({ kind: "team", teamId: original.id, teamVersion: 1 }, workspaceId, "PRJ-1");
  assert.equal(launched.agentVersions[0]!.version, 1);
  assert.notEqual(launched.agentVersions[0]!.config.instructions, "Only v2");
  assert.equal(launched.executionMode, "write");
  const changed = updateTeamDefinition(original.id, { requestId: "team-edit", revision: 1, config: teamConfig({ members: [{ agentId: "developer", agentVersion: 2 }] }) }, authority);
  assert.equal(changed.currentVersion, 2);
  assert.equal(getTeamVersion(original.id, 1)!.config.members.length, 2);
  const restored = restoreTeamVersion(original.id, { requestId: "team-restore", revision: 2, version: 1 }, authority);
  assert.equal(restored.currentVersion, 3); assert.equal(getTeamVersion(original.id, 3)!.restoredFromVersion, 1);
  assert.equal(getTeamVersion(original.id, 2)!.config.members.length, 1);
  const copied = copyTeamDefinition(original.id, { requestId: "team-copy", id: "team-copy", revision: 3, name: "Copy" }, authority);
  assert.deepEqual(copied.config.allowedProjectIds, []); assert.deepEqual(copied.config.members, original.config.members);
  fails(() => assertDefinitionLaunchable({ kind: "team", teamId: copied.id, teamVersion: 1 }, workspaceId, "PRJ-1"), "definition_project_restricted");
  assert.deepEqual(listTeamVersions(original.id).map(version => version.version), [3, 2, 1]);
  updateAgentDefinition("reviewer", { requestId: "disable-reviewer", revision: 1, state: "disabled" }, authority);
  fails(() => assertDefinitionLaunchable({ kind: "team", teamId: original.id, teamVersion: 1 }, workspaceId, "PRJ-1"), "definition_not_active");
});

test("Team publication validates pinned membership, workspace, supervisor and shared budgets", () => {
  agent(); agent("reviewer");
  const create = (id: string, config: TeamConfig) => createTeamDefinition({ requestId: id, id, workspaceId, config }, authority);
  fails(() => create("missing", teamConfig({ members: [{ agentId: "absent", agentVersion: 1 }] })), "team_member_unavailable");
  fails(() => create("future", teamConfig({ members: [{ agentId: "developer", agentVersion: 2 }] })), "team_member_unavailable");
  createAgentDefinition({ requestId: "foreign-agent", id: "foreign", workspaceId: foreignWorkspace, config: config() }, { workspaceId: foreignWorkspace, actorId });
  fails(() => create("cross-workspace", teamConfig({ members: [{ agentId: "foreign", agentVersion: 1 }] })), "team_member_unavailable");
  assert.equal(teamConfigSchema.safeParse(teamConfig({ supervisorAgentId: "developer" })).success, false);
  assert.equal(teamConfigSchema.safeParse(teamConfig({ strategy: "supervisor", supervisorAgentId: "absent" })).success, false);
  assert.equal(teamConfigSchema.safeParse(teamConfig({ members: [{ agentId: "developer", agentVersion: 1 }, { agentId: "developer", agentVersion: 1 }] })).success, false);
  assert.equal(teamConfigSchema.safeParse(teamConfig({ resourceLimits: { ...defaultCollaborationResourceLimits, maxRuns: 1 } })).success, false);
  fails(() => create("shallow", teamConfig({ strategy: "supervisor", supervisorAgentId: "developer", resourceLimits: { ...defaultCollaborationResourceLimits, maxDelegationDepth: 0 } })), "invalid_supervisor_team");
  updateAgentDefinition("developer", { requestId: "remove-tools", revision: 1, config: config({ capabilityBindings: { restriction: "observe", mcp: [], skills: [], hostTools: [] } }) }, authority);
  fails(() => create("no-tools", teamConfig({ strategy: "supervisor", supervisorAgentId: "developer", members: [{ agentId: "developer", agentVersion: 2 }, { agentId: "reviewer", agentVersion: 1 }] })), "supervisor_delegation_required");
  const supervisor = create("supervisor", teamConfig({ strategy: "supervisor", supervisorAgentId: "developer" }));
  assert.equal(supervisor.config.strategy, "supervisor");
});

test("current and frozen project ceilings are both checked without treating references as PM grants", () => {
  agent();
  fails(() => assertDefinitionLaunchable({ kind: "agent", agentId: "developer", agentVersion: 1 }, foreignWorkspace, "PRJ-1"), "definition_not_found");
  fails(() => assertDefinitionLaunchable({ kind: "agent", agentId: "developer", agentVersion: 1 }, workspaceId, "PRJ-2"), "definition_project_restricted");
  updateAgentDefinition("developer", { requestId: "relax", revision: 1, config: config({ allowedProjectIds: ["PRJ-1", "PRJ-2"] }) }, authority);
  fails(() => assertDefinitionLaunchable({ kind: "agent", agentId: "developer", agentVersion: 1 }, workspaceId, "PRJ-2"), "definition_project_restricted");
  updateAgentDefinition("developer", { requestId: "restrict", revision: 2, config: config({ allowedProjectIds: ["PRJ-2"] }) }, authority);
  fails(() => assertDefinitionLaunchable({ kind: "agent", agentId: "developer", agentVersion: 2 }, workspaceId, "PRJ-1"), "definition_project_restricted");
  fails(() => updateAgentDefinition("developer", { requestId: "foreign-edit", revision: 3, state: "disabled" }, { workspaceId: foreignWorkspace, actorId }), "definition_not_found");
});

test("caller transaction rollback does not leave a published version or idempotency receipt", () => {
  assert.throws(() => transaction(() => {
    agent();
    throw new Error("simulated caller failure");
  }), /simulated caller failure/);
  assert.equal(getAgentDefinition("developer"), null);
  assert.equal(getAgentVersion("developer", 1), null);
  assert.equal(getDefinitionRequest("create-developer", authority), null);
});
