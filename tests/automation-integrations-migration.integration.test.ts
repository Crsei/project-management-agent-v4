import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createAutomationPrivateStore } from '../packages/infrastructure/src/automation-integrations.ts';
import { applyAutomationMcpMigration, automationMcpDefinitionFingerprint, automationMcpMigrationPlanDigest, automationMcpProjectContextId, finalizeAutomationMcpMigration, planAutomationMcpMigration, readAutomationMcpMigrationSources, withAutomationMcpMigrationLock } from '../packages/infrastructure/src/automation-integrations-migration.ts';
import type { AutomationDefinitionMigrationTarget } from '../packages/infrastructure/src/automation-integrations-definitions.ts';
import type { ResolvedAutomationMcpDefinition } from '../packages/application/src/automation-integrations-definitions.ts';
import { createAutomationIntegrationsService } from '../packages/application/src/automation-integrations.ts';
import { createAutomationIntegrationRuntimeService } from '../packages/application/src/automation-integrations-runtime.ts';
import { registerAutomationEventsRoutes } from '../apps/server/pm/src/automation-events-routes.ts';
import { automationServiceHeaders } from '../packages/infrastructure/src/automation-execution-client.ts';
import { DomainError } from '../packages/domain/src/core.ts';
import { readonlyCorePort } from '../packages/pm-core/readonly.ts';
import { acquireMailFixtureDatabase, createMailFixtureDatabase, type MailFixtureDatabase } from './mail-fixture-database.ts';
import { MailFixtureScope, mailSchemaInitTimeout } from './mail-fixture-lifecycle.ts';
import { assertV4WorkerTestDatabase } from './worker-environment.ts';

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const rejected = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
let database: MailFixtureDatabase;
async function fixture(signal: AbortSignal) {
  const cleanup = new MailFixtureScope(signal);
  return cleanup.initialize(async () => {
    const { pool } = await acquireMailFixtureDatabase(cleanup, database);
    const actor = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Migration fixture', password: 'Synthetic-Migration-Only-Password' });
    const workspaceId = (await createWorkspace(pool, actor.id, 'Managed MCP migration')).id;
    const root = await cleanup.acquire(() => mkdtemp(join(tmpdir(), 'pm-mcp-migration-')), path => rm(path, { recursive: true, force: true }));
    await mkdir(join(root, workspaceId, 'projects'), { recursive: true });
    await writeFile(join(root, workspaceId, 'projects', 'PRJ-001.md'), '---\nschema: pm/v1\nid: PRJ-001\nentity: project\nstatus: active\n---\n# Migration fixture\n');
    const core = readonlyCorePort(id => join(root, id));
    const privateStore = createAutomationPrivateStore(Buffer.alloc(32, 19).toString('base64'));
    const headers = { authorization: 'Bearer synthetic-scoped-migration-value' };
    const connectionId = randomUUID(); const sealed = privateStore.seal(headers, `${workspaceId}:${actor.id}:${connectionId}:connection`);
    const policy = { projectId: 'PRJ-001', provider: 'github' as const, label: 'Original dual-channel connection', readTools: ['read_repository'], writeTools: [], nativeApi: { baseUrl: 'https://api.github.com', repositories: ['owner/repo'], allowWrites: false } };
    await pool.query(`INSERT INTO automation_integration_connections(id,workspace_id,actor_id,project_id,revision,config,native_private_config,has_credentials,status,verification,last_error) VALUES($1,$2,$3,'PRJ-001',7,$4::jsonb,$5,true,'configured','{"mcp":false,"nativeApi":true}','integration_definition_migration_required')`, [connectionId, workspaceId, actor.id, JSON.stringify(policy), sealed]);
    await pool.query(`INSERT INTO automation_integration_migration_sources(connection_id,workspace_id,actor_id,project_id,source_revision,source_config,sealed_headers,source_status,source_verification,source_last_error) VALUES($1,$2,$3,'PRJ-001',7,$4::jsonb,$5,'verified','{"mcp":true,"nativeApi":true}',NULL)`, [connectionId, workspaceId, actor.id, JSON.stringify({ ...policy, endpoint: 'https://mcp.example.org/' }), sealed]);
    const definitions = new Map<string, ResolvedAutomationMcpDefinition>(); let imports = 0; let loseImport = false;
    const target: AutomationDefinitionMigrationTarget = {
      beginMaintenance: async migrationId => ({ migrationId }),
      endMaintenance: async migrationId => ({ migrationId }),
      list: async () => ({ contextId: [...definitions.values()][0]?.contextId ?? 'not-created', definitions: [...definitions.values()].map(value => ({ contextId: value.contextId, serverId: value.serverId, name: policy.label, configFingerprint: value.configFingerprint, transport: value.transport })) }),
      resolve: async input => { const found = definitions.get(`${input.contextId}/${input.serverId}`); if (!found) throw new DomainError('integration_definition_missing', 'Synthetic missing definition', 409); return found; },
      ensureProjectContext: async () => ({ contextId: automationMcpProjectContextId({ actorId: actor.id, workspaceId, projectId: 'PRJ-001' }) }),
      importDefinition: async input => {
        const { contextId } = await target.ensureProjectContext(input.scope); imports++;
        const value: ResolvedAutomationMcpDefinition = { contextId, serverId: input.serverId, transport: 'streamable-http', endpoint: input.endpoint, headers: input.headers ?? {}, configFingerprint: automationMcpDefinitionFingerprint(input.endpoint, input.headers ?? {}) };
        definitions.set(`${contextId}/${input.serverId}`, value);
        if (loseImport) { loseImport = false; throw new DomainError('integration_definition_service_unavailable', 'Synthetic response lost after durable import', 503); }
        return value;
      },
    };
    const service = createAutomationIntegrationsService({ database: () => pool, core, privateStore, definitionResolver: target });
    return { pool, actor, workspaceId, core, privateStore, connectionId, sealed, policy, target, definitions, service, cleanup, stats: () => ({ imports }), loseNextImport: () => { loseImport = true; } };
  });
}
describe('PostgreSQL managed MCP offline cutover and signed PM policy callbacks', { skip: !source }, () => {
  before(async t => {
    assert.ok(source);
    assertV4WorkerTestDatabase(source);
    database = await createMailFixtureDatabase({ signal: t.signal });
  }, { timeout: mailSchemaInitTimeout });
  after(async () => { await database?.close(); }, { timeout: 30000 });
  it('reconciles an import crash without duplicate definitions and preserves exact approved revision/native secrets', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.cleanup.close);
    const before = (await f.service.list(f.actor, f.workspaceId, 'PRJ-001')).connections[0]!;
    assert.equal(before.lastError, 'integration_definition_migration_required'); assert.equal(before.verification.mcp, false);
    await withAutomationMcpMigrationLock(f.pool, true, async sql => {
      const plan = planAutomationMcpMigration(await readAutomationMcpMigrationSources(sql), { sqlDumpSha256: 'a'.repeat(64), agentManifestSha256: 'b'.repeat(64) });
      const input = { plan, expectedPlanDigest: automationMcpMigrationPlanDigest(plan), target: f.target, privateStore: f.privateStore };
      f.loseNextImport(); await assert.rejects(applyAutomationMcpMigration(sql, input), rejected('integration_definition_service_unavailable'));
      assert.equal((await sql.query('SELECT phase FROM automation_integration_definition_migrations')).rows[0].phase, 'prepared');
      assert.equal((await sql.query('SELECT config FROM automation_integration_connections')).rows[0].config.mcpDefinition, undefined);
      const conflicting = [...f.definitions.values()][0]!; const originalFingerprint = conflicting.configFingerprint;
      conflicting.configFingerprint = 'f'.repeat(64);
      await assert.rejects(applyAutomationMcpMigration(sql, input), rejected('integration_migration_conflict'));
      assert.equal(conflicting.configFingerprint, 'f'.repeat(64), 'Unknown conflicting target must not be overwritten');
      conflicting.configFingerprint = originalFingerprint;
      assert.deepEqual(await applyAutomationMcpMigration(sql, { ...input, reconcileOnly: true }), { imported: 0, cutover: 0 });
      assert.equal((await sql.query('SELECT phase FROM automation_integration_definition_migrations')).rows[0].phase, 'imported');
      assert.deepEqual(await applyAutomationMcpMigration(sql, input), { imported: 0, cutover: 1 });
      assert.deepEqual(await applyAutomationMcpMigration(sql, input), { imported: 0, cutover: 1 });
      assert.equal(f.stats().imports, 1);
      const row = (await sql.query('SELECT * FROM automation_integration_connections')).rows[0];
      assert.equal(row.revision, 7); assert.equal(row.status, 'verified'); assert.deepEqual(row.verification, { mcp: true, nativeApi: true });
      assert.equal(row.native_private_config, f.sealed); assert.equal(row.config.endpoint, undefined); assert.equal('private_config' in row, false);
      assert.equal(JSON.stringify(row).includes('synthetic-scoped-migration-value'), false);
      await finalizeAutomationMcpMigration(sql, plan, input.expectedPlanDigest);
      assert.equal((await sql.query('SELECT count(*)::int AS count FROM automation_integration_migration_sources')).rows[0].count, 0);
      assert.deepEqual(await applyAutomationMcpMigration(sql, { ...input, privateStore: createAutomationPrivateStore('') }), { imported: 0, cutover: 1 }, 'Finalized rerun consults only exact managed authority and journal, never removed legacy credentials');
    });
    const migrated = (await f.service.list(f.actor, f.workspaceId, 'PRJ-001')).connections[0]!;
    assert.equal(migrated.id, f.connectionId); assert.equal(migrated.revision, 7); assert.equal(migrated.verification.mcp, true);
    const definition = [...f.definitions.values()][0]!; definition.configFingerprint = 'f'.repeat(64);
    const changed = (await f.service.list(f.actor, f.workspaceId, 'PRJ-001')).connections[0]!;
    assert.equal(changed.verification.mcp, false); assert.equal(changed.lastError, 'integration_definition_changed'); assert.equal(changed.verification.nativeApi, true);
  });
  it('excludes actual project writes and generation grants while maintenance owns the advisory key', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.cleanup.close);
    const save = () => f.service.save(f.actor, f.workspaceId, randomUUID(), { requestId: randomUUID(), expectedRevision: 0, config: { ...f.policy, readTools: [] }, nativePrivateHeaders: { Authorization: 'Bearer synthetic-native-only' } });
    const broker = createAutomationIntegrationRuntimeService({ database: () => f.pool, core: f.core, privateStore: f.privateStore, definitionResolver: f.target });
    const id = randomUUID(); const generationId = randomUUID(); const identity = { actorId: f.actor.id, workspaceId: f.workspaceId, projectId: 'PRJ-001', executionId: id, requestId: randomUUID(), definitionId: randomUUID(), definitionRevision: 1, audience: 'automation-integrations' as const, generationId, issuedAt: Date.now(), expiresAt: Date.now() + 60000 };
    await withAutomationMcpMigrationLock(f.pool, true, async () => {
      await assert.rejects(save(), rejected('integration_maintenance_active'));
      await assert.rejects(broker.handle(identity, { executionId: id, generationId, method: 'grant/open' }), rejected('integration_maintenance_active'));
      assert.equal((await f.service.list(f.actor, f.workspaceId, 'PRJ-001')).connections.length, 1, 'Metadata reads remain available');
    });
    assert.equal((await save()).status, 'configured');
    await assert.rejects(broker.handle(identity, { executionId: id, generationId, method: 'grant/open' }), rejected('not_found_or_forbidden'));
  });
  it('rejects dangling references and never retargets a frozen execution when managed endpoint/secret bytes change', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.cleanup.close);
    await assert.rejects(f.service.save(f.actor, f.workspaceId, randomUUID(), { requestId: randomUUID(), expectedRevision: 0, config: { ...f.policy, mcpDefinition: { contextId: 'missing-context', serverId: 'missing-server' } } }), rejected('integration_definition_missing'));
    await withAutomationMcpMigrationLock(f.pool, true, async sql => {
      const plan = planAutomationMcpMigration(await readAutomationMcpMigrationSources(sql), { sqlDumpSha256: 'a'.repeat(64), agentManifestSha256: 'b'.repeat(64) });
      await applyAutomationMcpMigration(sql, { plan, expectedPlanDigest: automationMcpMigrationPlanDigest(plan), target: f.target, privateStore: f.privateStore });
    });
    const definitionId = randomUUID(); const executionId = randomUUID(); const requestId = randomUUID(); const generationId = randomUUID();
    const frozen = { name: 'Frozen scoped connector', projectId: 'PRJ-001', description: '', tags: [], templateId: null, trigger: { kind: 'manual' }, dailyLimit: 10, cooldownMinutes: 0, action: { kind: 'prompt', providerInstanceId: 'controlled-provider', model: 'controlled-model', options: {}, prompt: 'Read only the authorized repository', repositories: [], plugins: [{ id: `integration:${f.connectionId}`, version: '7' }], timeoutSeconds: 30 } };
    await f.pool.query("INSERT INTO automation_studio_definitions(id,workspace_id,actor_id,project_id,config,status) VALUES($1,$2,$3,'PRJ-001',$4::jsonb,'enabled')", [definitionId, f.workspaceId, f.actor.id, JSON.stringify(frozen)]);
    await f.pool.query("INSERT INTO automation_studio_executions(id,workspace_id,actor_id,project_id,definition_id,definition_revision,config_snapshot,request_id,trigger,dispatched_at) VALUES($1,$2,$3,'PRJ-001',$4,1,$5::jsonb,$6,'manual',clock_timestamp())", [executionId, f.workspaceId, f.actor.id, definitionId, JSON.stringify(frozen), requestId]);
    const identity = { actorId: f.actor.id, workspaceId: f.workspaceId, projectId: 'PRJ-001', executionId, requestId, definitionId, definitionRevision: 1, audience: 'automation-integrations' as const, generationId, issuedAt: Date.now(), expiresAt: Date.now() + 60000 };
    let contacts = 0;
    const broker = createAutomationIntegrationRuntimeService({ database: () => f.pool, core: f.core, privateStore: f.privateStore, definitionResolver: f.target, adapter: { list: async target => { contacts++; assert.equal(target.endpoint, 'https://mcp.example.org/'); return []; }, call: async () => { throw new Error('No tool dispatch authorized by this test'); } } });
    assert.deepEqual(await broker.handle(identity, { executionId, generationId, method: 'grant/open' }), { opened: true, mcpAvailable: true });
    assert.deepEqual(await broker.handle(identity, { executionId, generationId, method: 'tools/list' }), { tools: [] }); assert.equal(contacts, 1);
    const managed = [...f.definitions.values()][0]!;
    managed.endpoint = 'https://changed.example.org/'; managed.headers = { authorization: 'Bearer synthetic-new-credential' };
    managed.configFingerprint = automationMcpDefinitionFingerprint(managed.endpoint, managed.headers);
    await assert.rejects(broker.handle(identity, { executionId, generationId, method: 'tools/list' }), rejected('integration_definition_changed'));
    assert.equal(contacts, 1, 'A stale approved fingerprint must fail before any request to the replacement endpoint');
    await assert.rejects(withAutomationMcpMigrationLock(f.pool, true, async () => undefined), rejected('integration_migration_active_execution'));
  });
  it('requires real signed service bytes for scope/reference/invalidation callbacks and retains native verification', { timeout: 60000 }, async t => {
    const f = await fixture(t.signal); t.after(f.cleanup.close);
    const originalSecret = process.env.PM_AUTOMATION_SERVICE_SECRET; process.env.PM_AUTOMATION_SERVICE_SECRET = 'Synthetic-PM-Agent-Only-Service-Signing-Key';
    t.after(() => { if (originalSecret === undefined) delete process.env.PM_AUTOMATION_SERVICE_SECRET; else process.env.PM_AUTOMATION_SERVICE_SECRET = originalSecret; });
    await withAutomationMcpMigrationLock(f.pool, true, async sql => { const plan = planAutomationMcpMigration(await readAutomationMcpMigrationSources(sql), { sqlDumpSha256: 'a'.repeat(64), agentManifestSha256: 'b'.repeat(64) }); await applyAutomationMcpMigration(sql, { plan, expectedPlanDigest: automationMcpMigrationPlanDigest(plan), target: f.target, privateStore: f.privateStore }); });
    const app = Fastify(); t.after(() => app.close());
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500).send({ code: error instanceof DomainError ? error.code : 'unexpected' }));
    registerAutomationEventsRoutes(app, { database: () => f.pool, core: f.core, actor: async () => f.actor, definitionResolver: f.target });
    const definition = [...f.definitions.values()][0]!; const scope = { actorId: f.actor.id, workspaceId: f.workspaceId, projectId: 'PRJ-001' };
    const post = (operation: string, value: unknown) => { const url = `/internal/extensions/${operation}`; const payload = JSON.stringify(value); return app.inject({ method: 'POST', url, payload, headers: Object.fromEntries(automationServiceHeaders('POST', url, payload).entries()) }); };
    assert.equal((await app.inject({ method: 'POST', url: '/internal/extensions/authorize', payload: { scope } })).statusCode, 401);
    assert.deepEqual((await post('authorize', { scope, write: true })).json(), { authorized: true });
    const references = (await post('references', { scope, contextId: definition.contextId, serverId: definition.serverId })).json();
    assert.equal(references.references[0].id, f.connectionId); assert.equal(JSON.stringify(references).includes('synthetic-scoped'), false);
    await withAutomationMcpMigrationLock(f.pool, true, async () => {
      assert.equal((await post('authorize', { scope, write: true })).statusCode, 409);
      assert.equal((await post('authorize', { scope, write: true, maintenance: true })).statusCode, 200, 'Only signed offline import authority bypasses the browser-write exclusion');
      assert.equal((await post('authorize', { scope })).statusCode, 200);
      assert.equal((await post('references', { scope, contextId: definition.contextId, serverId: definition.serverId })).statusCode, 200);
    });
    assert.equal((await post('invalidate', { scope, contextId: definition.contextId, serverId: definition.serverId, configFingerprint: 'f'.repeat(64) })).json().invalidated, 1);
    assert.equal((await post('invalidate', { scope, contextId: definition.contextId, serverId: definition.serverId, configFingerprint: 'f'.repeat(64) })).json().invalidated, 0);
    const row = (await f.pool.query('SELECT revision,verification,native_private_config FROM automation_integration_connections WHERE id=$1', [f.connectionId])).rows[0];
    assert.equal(row.revision, 8); assert.deepEqual(row.verification, { mcp: false, nativeApi: true }); assert.equal(row.native_private_config, f.sealed);
    const orphan = await f.target.importDefinition({ scope, serverId: 'orphan-definition', name: 'Explicit unbound fixture', endpoint: 'https://mcp.example.org/', headers: {} });
    assert.deepEqual((await post('references', { scope, contextId: orphan.contextId, serverId: orphan.serverId, reserveDelete: true })).json(), { references: [] });
    const saveOrphan = () => f.service.save(f.actor, f.workspaceId, randomUUID(), { requestId: randomUUID(), expectedRevision: 0, config: { ...f.policy, mcpDefinition: { contextId: orphan.contextId, serverId: orphan.serverId } } });
    await assert.rejects(saveOrphan(), rejected('integration_definition_deleting'));
    assert.equal((await post('invalidate', { scope, contextId: orphan.contextId, serverId: orphan.serverId, configFingerprint: orphan.configFingerprint })).statusCode, 200);
    const rebound = await saveOrphan(); assert.equal(rebound.status, 'configured');
    const guarded = (await post('references', { scope, contextId: orphan.contextId, serverId: orphan.serverId, reserveDelete: true })).json();
    assert.equal(guarded.references[0].id, rebound.id, 'A live PM binding is returned instead of reserving deletion');
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM automation_integration_definition_deletions')).rows[0].count, 0);
  });
});
