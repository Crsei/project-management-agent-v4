import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPool, migrate } from '../packages/infrastructure/src/database.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { Workspace } from '../packages/pm-core/index.ts';
import { readonlyCorePort } from '../packages/pm-core/readonly.ts';
import { enqueueImNotifications, deliverImBatch } from '../packages/application/src/im-delivery.ts';
import type { ImGatewayConfig } from '../packages/infrastructure/src/im-gateway-config.ts';

test('IM notification enqueue uses routed recipients, renders only task identity and drains once', { timeout: 90_000 }, async t => {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  assert.ok(url, 'Real PostgreSQL required; a skipped database test is not acceptance');
  const schema = `test_im_notifications_${randomUUID().replaceAll('-', '')}`;
  const bootstrap = createPool(url);
  await bootstrap.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(url);
  scoped.searchParams.set('options', `-c search_path=${schema},public`);
  const pool = createPool(scoped.toString());
  const root = await mkdtemp(join(tmpdir(), 'pm-im-notifications-'));
  const workspace = new Workspace(join(root, 'workspace'));
  await migrate(pool);
  await workspace.init();
  const owner = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'IM notification owner', password: 'isolated-im-notification-password' });
  const ws = await createWorkspace(pool, owner.id, 'IM notifications');
  const project = await workspace.createEntity({ entity: 'project', title: 'Notification project' });
  const task = await workspace.createEntity({ entity: 'work_item', project: project.id, title: 'Notification task' });
  const bindingId = randomUUID(), factId = randomUUID(), cursor = '1';
  await pool.query(
    'INSERT INTO im_identities(id,workspace_id,user_id,platform,bot_self_id,platform_user_id,reply_channel_id,notify_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,true)',
    [bindingId, ws.id, owner.id, 'telegram', 'bot-1', 'platform-user-1', 'dm-1'],
  );
  await pool.query('UPDATE workspaces SET notification_head=$2,service_fact_head=$2 WHERE id=$1', [ws.id, cursor]);
  await pool.query(
    `INSERT INTO service_fact_events(fact_id,workspace_id,fact_sequence,schema_version,source_kind,source_key,source_digest,project_id,entity_kind,entity_id,after_revision,change_kinds,safety_class)
     VALUES($1,$2,1,1,'command',$3,$4,$5,'work_item',$6,'1',ARRAY['lifecycle_changed'],'project_fact')`,
    [factId, ws.id, randomUUID(), createHash('sha256').update(factId).digest('hex'), project.id, task.id],
  );
  await pool.query(
    `INSERT INTO notification_fact_inputs(workspace_id,fact_id,actor_id,task_id,original_project_id,watch_candidates,new_mention_ids,completion,trusted_origin)
     VALUES($1,$2,$3,$4,$5,'[]'::jsonb,'{}',false,'manual')`,
    [ws.id, factId, owner.id, task.id, project.id],
  );
  await pool.query(
    `INSERT INTO notification_recipients(workspace_id,fact_id,recipient_id,reason_set,origin,delivery_cursor)
     VALUES($1,$2,$3,ARRAY['watch'],'routed',$4)`,
    [ws.id, factId, owner.id, cursor],
  );
  await pool.query(
    `INSERT INTO notification_activations(workspace_id,activation_fact_sequence,migration_manifest,legacy_stream_cursor)
     VALUES($1,0,'{}'::jsonb,0)`,
    [ws.id],
  );

  const captured: string[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || !('content' in body) || typeof body.content !== 'string') throw new Error('Unexpected Satori body');
    captured.push(body.content);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const port = (server.address() as AddressInfo).port;
  const config: ImGatewayConfig = { wsUrl: 'ws://127.0.0.1:1/satori', apiUrl: `http://127.0.0.1:${port}/satori`, token: 'T'.repeat(32), platforms: ['telegram'], timeoutMs: 2_000, linkTtlSeconds: 600, gatewayId: 'test-gateway', botUsername: 'dovspace_test_bot' };
  t.after(async () => {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    await workspace.close();
    await pool.end();
    await bootstrap.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await bootstrap.end();
    await rm(root, { recursive: true, force: true });
  });

  const queued = await enqueueImNotifications(pool, readonlyCorePort(() => join(root, 'workspace')), 'http://127.0.0.1:3224');
  assert.equal(queued.enqueued, 1);
  assert.equal(await enqueueImNotifications(pool, readonlyCorePort(() => join(root, 'workspace')), 'http://127.0.0.1:3224').then(value => value.enqueued), 0);
  const delivered = await deliverImBatch(pool, config);
  assert.equal(delivered.accepted, 1);
  assert.equal(captured.length, 1);
  assert.match(captured[0]!, /Notification project/);
  assert.match(captured[0]!, /Notification task/);
  assert.match(captured[0]!, new RegExp(task.id));
  assert.doesNotMatch(captured[0]!, /Original scope|description|comment/i);
});
