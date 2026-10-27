import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { z } from 'zod';
import { CAPABILITIES, DomainError } from '../../domain/src/core.ts';
import type { Actor, Command, Entity } from '../../domain/src/core.ts';
import { accessCommands, listMembers, requireCapability } from '../../application/src/access.ts';
import { getCommandReceipt, runCommand } from '../../application/src/kernel.ts';
import { listEntities, listWorkspaces, readEntity } from '../../application/src/queries.ts';
import type { CommandRegistry } from '../../application/src/ports.ts';
import { authenticate, createUser, createWorkspace, login, logout } from '../src/auth.ts';
import { checkDatabase, createPool, databaseFor, migrate } from '../src/database.ts';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
describe('PostgreSQL foundation: durable commands, authority and history', { skip: !databaseUrl }, () => {
  let pool: Pool;
  let bootstrap: Pool;
  let actor: Actor;
  let guest: Actor;
  let workspaceId: string;
  const namespace = `test_foundation_${randomUUID().replaceAll('-', '')}`;
  // Project/work-item/milestone identities belong to the Markdown core and are
  // rejected by the kernel. These fixtures use PM-only aggregates instead:
  // workspace-level conversations and project-scoped intents. The project IDs
  // are core-style strings, mirroring how PM aggregates reference core scopes.
  const commands: CommandRegistry = {
    ...accessCommands,
    CreateFixtureConversation: {
      payload: z.object({ title: z.string().min(1) }).strict(),
      async handler(ctx) {
        await ctx.require('planning.edit');
        const entity = await ctx.insert('conversation', { title: ctx.command.payload.title, status: 'open', createdBy: ctx.actor.id });
        await ctx.emit('ConversationCreated', entity);
        return entity;
      },
    },
    CreateFixtureIntent: {
      payload: z.object({ title: z.string().min(1) }).strict(),
      async handler(ctx) {
        await ctx.require('planning.edit', ctx.command.projectId);
        const entity = await ctx.insert('intent', {
          title: ctx.command.payload.title, summary: ctx.command.payload.title, goal: '', status: 'proposed', revision: 1,
        }, ctx.command.projectId);
        await ctx.emit('IntentProposed', entity);
        return entity;
      },
    },
    RenameFixtureAggregate: {
      payload: z.object({ title: z.string().min(1) }).strict(),
      async handler(ctx) {
        const entity = await ctx.get(ctx.command.targetId!);
        await ctx.require('planning.edit', entity.projectId);
        const updated = await ctx.update(entity, { ...entity.data, title: ctx.command.payload.title });
        await ctx.emit('FixtureRenamed', updated);
        return updated;
      },
    },
    RejectAfterWrite: {
      payload: z.object({}).strict(),
      async handler(ctx) {
        const entity = await ctx.get(ctx.command.targetId!);
        await ctx.require('planning.edit', entity.projectId);
        const updated = await ctx.update(entity, { ...entity.data, title: 'must roll back' });
        await ctx.emit('MustNotPublish', updated);
        throw new DomainError('blocked', 'Deliberately rejected after tentative writes', 409);
      },
    },
    CreateInvalidReference: {
      payload: z.object({ subjectRef: z.object({ kind: z.literal('intent'), id: z.uuid() }).strict() }).strict(),
      async handler(ctx) {
        await ctx.require('planning.edit', ctx.command.projectId);
        const decision = await ctx.insert('decision', {
          decisionType: 'note', subjectRef: ctx.command.payload.subjectRef, actorId: ctx.actor.id, reason: 'scope constraint', basisRefs: [],
        }, ctx.command.projectId);
        await ctx.emit('MustNotPublish', decision);
        return decision;
      },
    },
  };
  async function command(commandType: string, payload: Record<string, unknown>, extra: Partial<Command> = {}, principal = actor) {
    return runCommand(pool, principal, workspaceId, { commandId: randomUUID(), commandType, payload, ...extra }, commands);
  }
  async function intent(title: string, projectId: string): Promise<Entity> {
    const receipt = await command('CreateFixtureIntent', { title }, { projectId });
    assert.equal(receipt.status, 'committed');
    return receipt.result as Entity;
  }
  before(async () => {
    bootstrap = createPool(databaseUrl!);
    await bootstrap.query(`CREATE SCHEMA ${namespace}`);
    const url = new URL(databaseUrl!);
    url.searchParams.set('options', `-c search_path=${namespace},public`);
    pool = createPool(url.toString());
    await migrate(pool);
    actor = await createUser(pool, { email: 'admin@example.test', name: 'Administrator', password: 'testing-password-01' });
    guest = await createUser(pool, { email: 'guest@example.test', name: 'Guest', password: 'testing-password-02' });
    workspaceId = (await createWorkspace(pool, actor.id, 'Foundation test')).id;
  });
  after(async () => {
    await pool?.end();
    if (bootstrap) { await bootstrap.query(`DROP SCHEMA ${namespace} CASCADE`); await bootstrap.end(); }
  });
  it('migrates repeatedly, exposes Drizzle schema and gives bootstrap owner explicit capabilities', async () => {
    await migrate(pool);
    assert.equal((await checkDatabase(pool)).ready, true);
    assert.ok(databaseFor(pool));
    assert.deepEqual((await listMembers(pool, actor, workspaceId))[0]!.capabilities, [...CAPABILITIES]);
    assert.equal((await listWorkspaces(pool, actor))[0]!.id, workspaceId);
  });
  it('stores scrypt passwords and only hashed session tokens; logout and expiry revoke access', async () => {
    const session = await login(pool, { email: actor.email.toUpperCase(), password: 'testing-password-01' });
    assert.equal((await authenticate(pool, session.token)).id, actor.id);
    const stored = await pool.query<{ password_hash: string; token_hash: string }>('SELECT u.password_hash,s.token_hash FROM users u JOIN sessions s ON u.id=s.user_id WHERE u.id=$1', [actor.id]);
    assert.match(stored.rows[0]!.password_hash, /^scrypt\$32768\$8\$1\$/);
    assert.notEqual(stored.rows[0]!.token_hash, session.token);
    await assert.rejects(login(pool, { email: actor.email, password: 'wrong' }), { code: 'invalid_credentials' });
    await logout(pool, session.token);
    await assert.rejects(authenticate(pool, session.token), { code: 'unauthenticated' });
    const expired = await login(pool, { email: actor.email, password: 'testing-password-01' });
    await pool.query("UPDATE sessions SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE user_id=$1", [actor.id]);
    await assert.rejects(authenticate(pool, expired.token), { code: 'unauthenticated' });
  });
  it('reuses canonical same-key requests after reconnect and refuses a changed request', async () => {
    const input: Command = { commandId: randomUUID(), commandType: 'CreateFixtureConversation', payload: { title: 'Idempotent' } };
    const original = await runCommand(pool, actor, workspaceId, input, commands);
    const replay = await runCommand(pool, actor, workspaceId, { payload: { title: 'Idempotent' }, commandType: input.commandType, commandId: input.commandId }, commands);
    assert.deepEqual(replay, original);
    const count = await pool.query<{ n: string }>('SELECT count(*) AS n FROM outbox WHERE command_id=$1', [input.commandId]);
    assert.equal(count.rows[0]!.n, '1');
    assert.deepEqual(await getCommandReceipt(pool, actor, workspaceId, input.commandId), original);
    await assert.rejects(runCommand(pool, actor, workspaceId, { ...input, payload: { title: 'Changed' } }, commands), { code: 'idempotency_conflict' });
  });
  it('serializes concurrent writers and CAS rejects the stale version without success events', async () => {
    const entity = await intent('Concurrent', 'PRJ-1');
    const extra = { targetId: entity.id, expectedVersions: { [entity.id]: entity.version } };
    const results = await Promise.all([command('RenameFixtureAggregate', { title: 'Writer A' }, extra), command('RenameFixtureAggregate', { title: 'Writer B' }, extra)]);
    assert.equal(results.filter((result) => result.status === 'committed').length, 1);
    const rejected = results.find((result) => result.status === 'rejected')!;
    assert.equal(rejected.error?.code, 'version_conflict');
    assert.deepEqual(await getCommandReceipt(pool, actor, workspaceId, rejected.commandId), rejected);
    assert.equal((await readEntity(pool, actor, workspaceId, entity.id)).version, 2);
    assert.equal((await pool.query<{ n: string }>('SELECT count(*) AS n FROM outbox WHERE command_id=$1', [rejected.commandId])).rows[0]!.n, '0');
  });
  it('rolls back tentative business/outbox writes and retains the exact rejection for replay', async () => {
    const entity = await intent('Rollback', 'PRJ-2');
    const input: Command = { commandId: randomUUID(), commandType: 'RejectAfterWrite', targetId: entity.id, expectedVersions: { [entity.id]: 1 }, payload: {} };
    const receipt = await runCommand(pool, actor, workspaceId, input, commands);
    assert.equal(receipt.error?.code, 'blocked');
    assert.equal((await readEntity(pool, actor, workspaceId, entity.id)).data.title, 'Rollback');
    assert.deepEqual(await runCommand(pool, actor, workspaceId, input, commands), receipt);
    assert.equal((await pool.query<{ n: string }>('SELECT count(*) AS n FROM outbox WHERE command_id=$1', [input.commandId])).rows[0]!.n, '0');
  });
  it('checks every update version even when a handler forgets checkVersion', async () => {
    const entity = await intent('Missing version', 'PRJ-3');
    const receipt = await command('RenameFixtureAggregate', { title: 'No' }, { targetId: entity.id });
    assert.equal(receipt.error?.code, 'version_conflict');
    assert.equal((await readEntity(pool, actor, workspaceId, entity.id)).version, 1);
  });
  it('pairs entity pages and stream cursor from one snapshot while publication commits concurrently', async () => {
    const entity = await intent('Snapshot before', 'PRJ-4');
    const baseline = (await listEntities(pool, actor, workspaceId, { kind: 'intent', projectId: entity.projectId! })).cursor;
    let injected = false;
    const intercepted = new Proxy(pool, {
      get(target, property, receiver) {
        if (property !== 'connect') return Reflect.get(target, property, receiver);
        return async () => {
          const connection = await target.connect();
          return new Proxy(connection, {
            get(client, member) {
              if (member === 'release') return client.release.bind(client);
              if (member !== 'query') return Reflect.get(client, member);
              return async (sql: string, values?: unknown[]) => {
                const result = await client.query(sql, values);
                if (!injected && result.rows.some(row => row.id === entity.id)) {
                  injected = true;
                  const changed = await command('RenameFixtureAggregate', { title: 'Snapshot after' }, { targetId: entity.id, expectedVersions: { [entity.id]: entity.version } });
                  assert.equal(changed.status, 'committed');
                  await pool.query('UPDATE workspaces SET stream_cursor=stream_cursor+1 WHERE id=$1', [workspaceId]);
                }
                return result;
              };
            },
          });
        };
      },
    });
    const snapshot = await listEntities(intercepted, actor, workspaceId, { kind: 'intent', projectId: entity.projectId! });
    assert.equal(injected, true);
    assert.equal(snapshot.items[0]!.data.title, 'Snapshot before');
    assert.equal(snapshot.cursor, baseline);
    assert.equal((await readEntity(pool, actor, workspaceId, entity.id)).data.title, 'Snapshot after');
  });
  it('rejects cross-project JSONB references at deferred constraints and records the rejection', async () => {
    const one = await intent('First scope', 'PRJ-5');
    const two = await intent('Second scope', 'PRJ-6');
    const rejected = await command('CreateInvalidReference', { subjectRef: { kind: 'intent', id: two.id } }, { projectId: one.projectId! });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.error?.code, 'validation_failed');
    assert.equal((await listEntities(pool, actor, workspaceId, { kind: 'decision', projectId: one.projectId! })).items.length, 0);
    assert.deepEqual(await getCommandReceipt(pool, actor, workspaceId, rejected.commandId), rejected);
  });
  it('retains immutable records and prevents direct historical modification or deletion', async () => {
    const entity = await intent('History scope', 'PRJ-7');
    const id = randomUUID();
    await pool.query("INSERT INTO entities(id,workspace_id,project_id,kind,data,created_by) VALUES($1,$2,$3,'decision',$4,$5)", [id, workspaceId, entity.projectId, JSON.stringify({ decisionType: 'note', subjectRef: { kind: 'intent', id: entity.id }, actorId: actor.id, reason: 'Record', basisRefs: [] }), actor.id]);
    await assert.rejects(pool.query("UPDATE entities SET data=data||'{\"reason\":\"overwritten\"}',version=version+1 WHERE id=$1", [id]), { constraint: 'entity_immutable' });
    await assert.rejects(pool.query('DELETE FROM entities WHERE id=$1', [id]), { constraint: 'entity_history_retained' });
  });
  it('filters project scope, checks permission at replay, and protects the final administrator', async () => {
    const allowed = await intent('Visible', 'PRJ-8');
    const hidden = await intent('Hidden', 'PRJ-9');
    const grant = await command('SetWorkspaceMember', { userId: guest.id, capabilities: ['domain.read', 'planning.edit'], projectIds: [allowed.projectId!] });
    assert.equal(grant.status, 'committed');
    const visible = await listEntities(pool, guest, workspaceId, { kind: 'intent' });
    assert.deepEqual(visible.items.map((item) => item.id), [allowed.id]);
    await assert.rejects(readEntity(pool, guest, workspaceId, hidden.id), { code: 'not_found_or_forbidden' });
    await assert.rejects(requireCapability(pool, guest, workspaceId, 'planning.edit'), { code: 'not_found_or_forbidden' });
    const input: Command = { commandId: randomUUID(), commandType: 'RenameFixtureAggregate', targetId: allowed.id, expectedVersions: { [allowed.id]: 1 }, payload: { title: 'Guest write' } };
    const written = await runCommand(pool, guest, workspaceId, input, commands);
    assert.equal(written.status, 'committed');
    const member = (await listMembers(pool, actor, workspaceId)).find((item) => item.userId === guest.id)!;
    assert.equal((await command('RevokeWorkspaceMember', { userId: guest.id }, { expectedVersions: { [guest.id]: member.version } })).status, 'committed');
    await assert.rejects(runCommand(pool, guest, workspaceId, input, commands), { code: 'not_found_or_forbidden' });
    await assert.rejects(getCommandReceipt(pool, guest, workspaceId, input.commandId), { code: 'not_found_or_forbidden' });
    const admin = (await listMembers(pool, actor, workspaceId)).find((item) => item.userId === actor.id)!;
    const rejected = await command('RevokeWorkspaceMember', { userId: actor.id }, { expectedVersions: { [actor.id]: admin.version } });
    assert.equal(rejected.error?.code, 'last_administrator');
    const current = (await listMembers(pool, actor, workspaceId)).find((item) => item.userId === guest.id)!;
    await command('SetWorkspaceMember', { userId: guest.id, capabilities: ['access.manage'], projectIds: null }, { expectedVersions: { [guest.id]: current.version } });
    await requireCapability(pool, guest, workspaceId, 'access.manage');
    await assert.rejects(requireCapability(pool, guest, workspaceId, 'delivery.review'), { code: 'permission_denied' });
    await assert.rejects(runCommand(pool, guest, workspaceId, input, commands), { code: 'permission_denied' });
  });
  it('rejects execution commands without creating execution records', async () => {
    const receipt = await command('CreateRun', {});
    assert.equal(receipt.error?.code, 'capability_not_enabled');
    assert.deepEqual(await getCommandReceipt(pool, actor, workspaceId, receipt.commandId), receipt);
  });
});
