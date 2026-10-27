import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { accessCommands } from '../packages/application/src/access.ts';
import { intentCommands } from '../packages/application/src/intent.ts';
import { runCommand } from '../packages/application/src/kernel.ts';
import type { CoreAccess } from '../packages/application/src/ports.ts';
import { DomainError } from '../packages/domain/src/core.ts';
import type { Actor, Command, CommandReceipt, Entity, EntityKind } from '../packages/domain/src/core.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createPool, lockWorkspace, migrate } from '../packages/infrastructure/src/database.ts';
import { executeCoreCommand, isCoreEntityKind, listCoreEntities, readCoreEntity } from '../apps/api/src/core-adapter.ts';
import { CoreWorkspacePool, authorizeCoreScope } from '../apps/api/src/core-routes.ts';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const registry = { ...accessCommands, ...intentCommands };

describe('UUID identity and revoked-member history regressions on PostgreSQL', { skip: !databaseUrl }, () => {
  const namespace = `test_uuid_audit_${randomUUID().replaceAll('-', '')}`;
  let bootstrap: Pool;
  let pool: Pool;
  let admin: Actor;
  let member: Actor;
  let coreRoot: string;
  let coreWorkspaces: CoreWorkspacePool;

  before(async () => {
    bootstrap = createPool(databaseUrl!);
    await bootstrap.query(`CREATE SCHEMA ${namespace}`);
    const url = new URL(databaseUrl!);
    url.searchParams.set('options', `-c search_path=${namespace},public`);
    pool = createPool(url.toString());
    await migrate(pool);
    admin = await createUser(pool, { email: 'uuid-admin@example.test', name: 'UUID administrator', password: 'uuid-audit-password-01' });
    member = await createUser(pool, { email: 'uuid-member@example.test', name: 'Historical owner', password: 'uuid-audit-password-02' });
    const testsRoot = resolve('.local/tests');
    await mkdir(testsRoot, { recursive: true });
    coreRoot = await mkdtemp(join(testsRoot, 'uuid-audit-core-'));
    coreWorkspaces = new CoreWorkspacePool(coreRoot);
  });

  after(async () => {
    await coreWorkspaces?.close();
    await pool?.end();
    if (bootstrap) {
      await bootstrap.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
      await bootstrap.end();
    }
    if (coreRoot) await rm(coreRoot, { recursive: true, force: true });
  });

  async function workspace(): Promise<string> {
    return (await createWorkspace(pool, admin.id, 'UUID audit')).id;
  }

  // The PM kernel reaches Markdown-core objects through the same adapter the API
  // uses, so PM-only commands can reference stable core IDs such as PRJ-001.
  async function coreAccess(workspaceId: string, principal: Actor = admin): Promise<CoreAccess> {
    const workspace = await coreWorkspaces.get(workspaceId);
    return {
      handles: (id: string, kind?: EntityKind) => kind ? isCoreEntityKind(kind) : /^[A-Z]/.test(id),
      get: async (id: string, kind?: EntityKind) => {
        const workspace = await coreWorkspaces.get(workspaceId);
        const scope = await authorizeCoreScope(pool, principal, workspaceId, 'domain.read');
        const entity = readCoreEntity(workspace, scope, id);
        if (kind && entity.kind !== kind) throw new DomainError('not_found_or_forbidden', 'Entity is not accessible', 404);
        return entity;
      },
      async list(kind) {
        const workspace = await coreWorkspaces.get(workspaceId);
        const scope = await authorizeCoreScope(pool, principal, workspaceId, 'domain.read');
        return (await listCoreEntities(workspace, scope, { kind })).items;
      },
      async records() {
        const workspace = await coreWorkspaces.get(workspaceId);
        const scope = await authorizeCoreScope(pool, principal, workspaceId, 'domain.read');
        return workspace.snapshot().files.filter(record => scope.allows(record));
      },
      async sprintHistory() { return (await coreWorkspaces.get(workspaceId)).sprintHistory(); },
      configuration() { return workspace.configuration().config; },
    };
  }

  async function run(workspaceId: string, commandType: string, payload: Record<string, unknown>, extra: Partial<Command> = {}): Promise<CommandReceipt> {
    return runCommand(pool, admin, workspaceId, { commandId: randomUUID(), commandType, payload, ...extra }, registry, await coreAccess(workspaceId));
  }

  async function runCore(workspaceId: string, commandType: string, payload: Record<string, unknown>, extra: Partial<Command> = {}): Promise<CommandReceipt> {
    const workspace = await coreWorkspaces.get(workspaceId);
    const scope = await authorizeCoreScope(pool, admin, workspaceId, 'domain.read');
    const command: Command = { commandId: extra.commandId ?? randomUUID(), commandType, payload, ...extra };
    return executeCoreCommand({ workspace, scope, principal: admin, command, pool }, command.commandId);
  }

  function committed<T>(receipt: CommandReceipt): T {
    assert.equal(receipt.status, 'committed', JSON.stringify(receipt.error));
    return receipt.result as T;
  }

  async function project(workspaceId: string, ownerId = admin.id): Promise<Entity> {
    return committed<Entity>(await runCore(workspaceId, 'CreateProject', { name: 'Project', goal: 'Goal', ownerId, completionCriteria: ['Accepted'] }));
  }

  async function workItem(workspaceId: string, projectId: string, assigneeId = admin.id): Promise<Entity> {
    return committed<Entity>(await runCore(workspaceId, 'CreateWorkItem', { title: 'Work', description: 'Scope', acceptanceCriteria: [], assigneeId }, { projectId }));
  }

  it('uses the same workspace lock for uppercase and lowercase UUIDs', async () => {
    const workspaceId = await workspace();
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      await lockWorkspace(first, workspaceId.toUpperCase());
      // A nonblocking probe tests mutual exclusion without a timing assumption.
      const probe = await second.query<{ acquired: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1::uuid::text, 724631)) AS acquired', [workspaceId]);
      assert.equal(probe.rows[0]!.acquired, false);
    } finally {
      await first.query('ROLLBACK');
      await second.query('ROLLBACK');
      first.release();
      second.release();
    }
  });

  it('rejects self dependencies without changing the core file or emitting an outbox event', async () => {
    const workspaceId = await workspace();
    const scope = await project(workspaceId);
    const item = await workItem(workspaceId, scope.id);
    const core = await coreWorkspaces.get(workspaceId);
    const revision = core.get(item.id).revision;
    const result = await runCore(workspaceId, 'AddDependency', { prerequisiteId: item.id.toUpperCase() }, { targetId: item.id, projectId: scope.id, expectedVersions: { [item.id]: item.version } });
    assert.equal(result.error?.code, 'SELF_REFERENCE');
    assert.equal(core.get(item.id).revision, revision);
    assert.deepEqual(readCoreEntity(core, await authorizeCoreScope(pool, admin, workspaceId, 'domain.read'), item.id).data.prerequisiteIds, []);
    const events = await pool.query<{ count: string }>('SELECT count(*)::text FROM outbox WHERE command_id=$1', [result.commandId]);
    assert.equal(events.rows[0]!.count, '0');
  });

  it('detects duplicate and cyclic dependency references in the Markdown core', async () => {
    const workspaceId = await workspace();
    const scope = await project(workspaceId);
    const first = await workItem(workspaceId, scope.id);
    const second = await workItem(workspaceId, scope.id);
    const linked = committed<Entity>(await runCore(workspaceId, 'AddDependency', { prerequisiteId: second.id }, { targetId: first.id, expectedVersions: { [first.id]: first.version } }));
    assert.deepEqual(linked.data.prerequisiteIds, [second.id]);
    const duplicate = await runCore(workspaceId, 'AddDependency', { prerequisiteId: second.id }, { targetId: first.id, expectedVersions: { [first.id]: linked.version } });
    assert.equal(duplicate.error?.code, 'duplicate_dependency');
    const cycle = await runCore(workspaceId, 'AddDependency', { prerequisiteId: first.id }, { targetId: second.id, expectedVersions: { [second.id]: second.version } });
    assert.equal(cycle.status, 'rejected');
    assert.equal(cycle.httpStatus, 422);
    // The workspace validation reports the cycle alongside the invalid edge.
    const diagnostics = cycle.error?.details as { diagnostics?: { code: string }[] } | undefined;
    assert.ok(diagnostics?.diagnostics?.some(item => item.code === 'RELATION_CYCLE'), JSON.stringify(cycle.error));
  });

  it('allows only one work item for an accepted intent across command keys', async () => {
    const workspaceId = await workspace();
    const scope = await project(workspaceId);
    const intent = committed<Entity>(await run(workspaceId, 'ProposeIntent', { summary: 'One accepted version', goal: 'Goal' }, { projectId: scope.id }));
    const accepted = committed<{ intent: Entity; decision: Entity }>(await run(workspaceId, 'AcceptIntent', { revision: 1, reason: 'Proceed' }, { targetId: intent.id, expectedVersions: { [intent.id]: intent.version } }));
    const commandId = randomUUID();
    const payload = { title: 'Converted work', description: 'Scope', acceptanceCriteria: [], assigneeId: admin.id, intentId: intent.id.toUpperCase(), acceptedRevision: 1, decisionId: accepted.decision.id };
    const first = committed<Entity>(await runCore(workspaceId, 'CreateWorkItemFromIntent', payload, { commandId, projectId: scope.id }));
    const replayed = committed<Entity>(await runCore(workspaceId, 'CreateWorkItemFromIntent', payload, { commandId, projectId: scope.id }));
    assert.equal(replayed.id, first.id);
    // The uppercase UUIDs are canonicalized in the stored origin reference.
    assert.equal(first.data.originIntentRef.intentId, intent.id);
    assert.equal(first.data.originIntentRef.decisionId, accepted.decision.id);
    const duplicate = await runCore(workspaceId, 'CreateWorkItemFromIntent', { ...payload, intentId: intent.id }, { projectId: scope.id });
    assert.equal(duplicate.error?.code, 'intent_already_converted');
    const core = await coreWorkspaces.get(workspaceId);
    assert.equal(core.items({ entity: 'work_item', project: scope.id }).length, 1);
  });

  it('protects the final administrator when the payload uses an uppercase UUID', async () => {
    const workspaceId = await workspace();
    const membership = await pool.query<{ version: number }>('SELECT version FROM memberships WHERE workspace_id=$1 AND user_id=$2', [workspaceId, admin.id]);
    const result = await run(workspaceId, 'RevokeWorkspaceMember', { userId: admin.id.toUpperCase() }, { expectedVersions: { [admin.id]: membership.rows[0]!.version } });
    assert.equal(result.error?.code, 'last_administrator');
    const remaining = await pool.query<{ count: string }>("SELECT count(*)::text FROM memberships WHERE workspace_id=$1 AND revoked_at IS NULL AND 'access.manage'=ANY(capabilities)", [workspaceId]);
    assert.equal(remaining.rows[0]!.count, '1');
  });

  it('normalizes workspace, target and expected-version IDs before an update', async () => {
    const workspaceId = await workspace();
    const scope = await project(workspaceId);
    const result = await runCore(workspaceId, 'UpdateProject', { name: 'Updated', goal: 'Goal', ownerId: admin.id.toUpperCase(), completionCriteria: ['Accepted'] }, { targetId: scope.id.toUpperCase(), projectId: scope.id.toUpperCase(), expectedVersions: { [scope.id.toUpperCase()]: scope.version } });
    const updated = committed<Entity>(result);
    assert.equal(updated.id, scope.id);
    assert.notEqual(updated.version, scope.version);
    assert.equal(updated.data.ownerId.toLowerCase(), admin.id);
  });

  it('reopens a cancelled core project and ignores a replacement definition payload', async () => {
    const workspaceId = await workspace();
    let scope = committed<Entity>(await runCore(workspaceId, 'CreateProject', { name: 'Early cancellation', goal: '', ownerId: null, completionCriteria: [] }));
    scope = committed<Entity>(await runCore(workspaceId, 'CancelProject', { reason: 'Pause before planning' }, { targetId: scope.id, expectedVersions: { [scope.id]: scope.version } }));
    assert.equal(scope.data.status, 'cancelled');
    const reopened = committed<Entity>(await runCore(workspaceId, 'ReopenProject', { reason: 'Resume after planning', definition: { goal: 'Ignored by the core adapter', ownerId: admin.id, completionCriteria: ['Accepted'] } }, { targetId: scope.id, expectedVersions: { [scope.id]: scope.version } }));
    assert.equal(reopened.data.status, 'active');
    // The Markdown core owns the project definition; a body payload cannot rewrite it.
    assert.equal(reopened.data.goal, '');
    assert.equal(reopened.data.ownerId, null);
  });

  it('archives and restores core objects after their historical owner is revoked', async () => {
    const workspaceId = await workspace();
    const grant = committed<{ version: number }>(await run(workspaceId, 'SetWorkspaceMember', { userId: member.id, capabilities: ['domain.read'], projectIds: null }));
    let archivedProject = await project(workspaceId, member.id);
    archivedProject = committed<Entity>(await runCore(workspaceId, 'CancelProject', { reason: 'Closed' }, { targetId: archivedProject.id, expectedVersions: { [archivedProject.id]: archivedProject.version } }));
    archivedProject = committed<Entity>(await runCore(workspaceId, 'ArchiveObject', { kind: 'project', reason: 'Retain' }, { targetId: archivedProject.id, expectedVersions: { [archivedProject.id]: archivedProject.version } }));
    const currentProject = await project(workspaceId);
    let archivedItem = await workItem(workspaceId, currentProject.id, member.id);
    archivedItem = committed<Entity>(await runCore(workspaceId, 'CancelWorkItem', { reason: 'Closed' }, { targetId: archivedItem.id, expectedVersions: { [archivedItem.id]: archivedItem.version } }));
    archivedItem = committed<Entity>(await runCore(workspaceId, 'ArchiveObject', { kind: 'work_item', reason: 'Retain' }, { targetId: archivedItem.id, expectedVersions: { [archivedItem.id]: archivedItem.version } }));
    committed(await run(workspaceId, 'RevokeWorkspaceMember', { userId: member.id }, { expectedVersions: { [member.id]: grant.version } }));
    const restoredProject = committed<Entity>(await runCore(workspaceId, 'RestoreArchivedObject', { kind: 'project', reason: 'Restore' }, { targetId: archivedProject.id, expectedVersions: { [archivedProject.id]: archivedProject.version } }));
    const restoredItem = committed<Entity>(await runCore(workspaceId, 'RestoreArchivedObject', { kind: 'work_item', reason: 'Restore' }, { targetId: archivedItem.id, expectedVersions: { [archivedItem.id]: archivedItem.version } }));
    assert.equal(restoredProject.data.archivedAt, null);
    assert.equal(restoredProject.data.archived, false);
    assert.equal(restoredProject.data.ownerId, member.id);
    assert.equal(restoredItem.data.archivedAt, null);
    assert.equal(restoredItem.data.assigneeId, member.id);
    const reopened = committed<Entity>(await runCore(workspaceId, 'ReopenProject', { reason: 'Continue with the recorded owner' }, { targetId: restoredProject.id, expectedVersions: { [restoredProject.id]: restoredProject.version } }));
    assert.equal(reopened.data.status, 'active');
    assert.equal(reopened.data.ownerId, member.id);
  });
});
