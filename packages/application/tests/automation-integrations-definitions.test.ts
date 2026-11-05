import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { automationIntegrationSaveSchema } from '../../contracts/src/automation-integrations.ts';
import { DomainError } from '../../domain/src/core.ts';
import { planAutomationMcpMigration, automationMcpMigrationPlanDigest, type AutomationMcpMigrationSource } from '../../infrastructure/src/automation-integrations-migration.ts';
import { resolveAutomationMcpDefinition, type AutomationDefinitionResolver } from '../src/automation-integrations-definitions.ts';

const scope = { actorId: randomUUID(), workspaceId: randomUUID(), projectId: 'PRJ-001' };
const ref = { contextId: 'private-project-context', serverId: 'github' };
const config = { projectId: scope.projectId, provider: 'github', label: 'Scoped GitHub', mcpDefinition: ref, readTools: ['read_repository'], writeTools: [] };
const rejected = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
describe('managed MCP reference and approved fingerprint boundary', () => {
  it('rejects old endpoint/header writes and a tool policy without a managed reference', () => {
    const input = { requestId: randomUUID(), expectedRevision: 0, config };
    assert.equal(automationIntegrationSaveSchema.safeParse(input).success, true);
    assert.equal(automationIntegrationSaveSchema.safeParse({ ...input, config: { ...config, endpoint: 'https://mcp.example.test' } }).success, false);
    assert.equal(automationIntegrationSaveSchema.safeParse({ ...input, privateHeaders: { Authorization: 'Bearer synthetic' } }).success, false);
    assert.equal(automationIntegrationSaveSchema.safeParse({ ...input, config: { ...config, mcpDefinition: undefined } }).success, false);
  });
  it('passes the exact scope to its private port and refuses changed approved bytes', async () => {
    let calls = 0;
    const resolver: AutomationDefinitionResolver = {
      resolve: async input => { calls++; assert.deepEqual(input, { scope, ...ref }); return { ...ref, configFingerprint: 'a'.repeat(64), transport: 'streamable-http', endpoint: 'https://mcp.example.org/', headers: { Authorization: 'Bearer synthetic-private' } }; },
      list: async () => ({ contextId: ref.contextId, definitions: [] }),
    };
    const value = await resolveAutomationMcpDefinition(resolver, scope, ref, 'a'.repeat(64));
    assert.equal(value.headers.authorization, 'Bearer synthetic-private');
    await assert.rejects(resolveAutomationMcpDefinition(resolver, scope, ref, 'b'.repeat(64)), rejected('integration_definition_changed'));
    await assert.rejects(resolveAutomationMcpDefinition(resolver, scope, ref, null), rejected('integration_definition_changed'));
    await assert.rejects(resolveAutomationMcpDefinition(undefined, scope, ref), rejected('integration_definition_service_unavailable'));
    assert.equal(calls, 3);
  });
  it('still rejects reserved test-domain endpoints from an otherwise matching managed definition', async () => {
    const resolver: AutomationDefinitionResolver = {
      resolve: async () => ({ ...ref, configFingerprint: 'a'.repeat(64), transport: 'streamable-http', endpoint: 'https://mcp.example.test/', headers: {} }),
      list: async () => ({ contextId: ref.contextId, definitions: [] }),
    };
    await assert.rejects(resolveAutomationMcpDefinition(resolver, scope, ref, 'a'.repeat(64)), rejected('validation_failed'));
  });
  it('creates a stable, secret-free dry-run without deduplicating different owners or same-name definitions', () => {
    const source: AutomationMcpMigrationSource = { connection_id: randomUUID(), workspace_id: scope.workspaceId, actor_id: scope.actorId, project_id: scope.projectId, source_revision: 7, source_config: { projectId: scope.projectId, provider: 'github', label: 'Same name', endpoint: 'https://private-endpoint.example.org/mcp', readTools: ['read_repository'], writeTools: [], nativeApi: { baseUrl: 'https://api.github.com', repositories: ['owner/repo'], allowWrites: false } }, sealed_headers: 'synthetic-sealed-private-input', source_status: 'verified', source_verification: { mcp: true, nativeApi: true }, source_last_error: null };
    const sameScope = { ...source, connection_id: randomUUID() };
    const otherScope = { ...source, connection_id: randomUUID(), actor_id: randomUUID() };
    const snapshots = { sqlDumpSha256: 'a'.repeat(64), agentManifestSha256: 'b'.repeat(64) };
    const plan = planAutomationMcpMigration([source, sameScope, otherScope], snapshots);
    const encoded = JSON.stringify(plan);
    assert.equal(encoded.includes('private-endpoint'), false); assert.equal(encoded.includes('synthetic-sealed-private-input'), false);
    const first = plan.entries.find(entry => entry.connectionId === source.connection_id)!;
    assert.equal(first.sourceRevision, 7); assert.equal(first.nativeApiDualChannel, true); assert.equal(first.sameNameConflict, true);
    assert.equal(first.contextId, plan.entries.find(entry => entry.connectionId === sameScope.connection_id)!.contextId);
    assert.notEqual(first.contextId, plan.entries.find(entry => entry.connectionId === otherScope.connection_id)!.contextId);
    assert.notEqual(first.serverId, plan.entries.find(entry => entry.connectionId === sameScope.connection_id)!.serverId);
    assert.equal(automationMcpMigrationPlanDigest(plan), automationMcpMigrationPlanDigest(planAutomationMcpMigration([otherScope, sameScope, source], snapshots)));
  });
});
