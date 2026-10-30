import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../apps/server/pm/src/app.ts';
import { createPool, migrate } from '../packages/infrastructure/src/database.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { readWebhookConfig, type WebhookConfig } from '../packages/infrastructure/src/webhook-config.ts';
import { runWebhookLoop, deliverWebhookBatch } from '../packages/application/src/webhook-delivery.ts';
import type { Actor, Command, CommandReceipt, Entity } from '../packages/domain/src/core.ts';
import { createDurableWebhookReceiver, type DurableWebhookReceiver } from './webhook-receiver-fixture.ts';

export const webhookDatabaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
export type WebhookFixture = { pool: Pool; app: FastifyInstance; actor: Actor; workspaceId: string; projectId: string; root: string; config: WebhookConfig; receiver: DurableWebhookReceiver;
  request: <T>(path: string, input?: { method?: string; body?: unknown; cookie?: string }) => Promise<{ status: number; body: T }>;
  command: <T>(commandType: string, payload: Record<string, unknown>, target?: { id: string; version: number }) => Promise<T>;
  enable: (id: string, version: number) => Promise<{ version: number }>;
  task: () => Promise<Entity>;
  batch: () => Promise<unknown>;
  close: () => Promise<void>;
};
export async function createWebhookFixture(): Promise<WebhookFixture> {
  if (!webhookDatabaseUrl) throw new Error('A real isolated PostgreSQL URL is required');
  const bootstrap = createPool(webhookDatabaseUrl); const namespace = `test_webhook_${randomUUID().replaceAll('-', '')}`;
  const root = await mkdtemp(join(tmpdir(), 'pm-webhook-')); let pool: Pool | undefined; let app: FastifyInstance | undefined; let receiver: DurableWebhookReceiver | undefined; let closed = false;
  const close = async () => { if (closed) return; closed = true; try { await receiver?.close(); await app?.close(); } finally { await pool?.end(); await bootstrap.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`); await bootstrap.end(); await rm(root, { recursive: true, force: true }); } };
  try {
    await bootstrap.query(`CREATE SCHEMA ${namespace}`);
    const url = new URL(webhookDatabaseUrl); url.searchParams.set('options', `-c search_path=${namespace},public`);
    pool = createPool(url.href); await migrate(pool);
    const actor = await createUser(pool, { email: `${randomUUID()}@example.test`, name: 'Webhook owner', password: 'isolated-webhook-password' });
    const workspaceId = (await createWorkspace(pool, actor.id, 'Webhook isolated')).id;
    const config: WebhookConfig = { status: 'disabled', digest: null, targets: [] };
    app = buildApp({ databaseUrl: url.href, coreWorkspaceRoot: join(root, 'core'), webhooks: config });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 }); let cookie = '';
    async function request<T>(path: string, input: { method?: string; body?: unknown; cookie?: string } = {}) {
      const response = await fetch(`${origin}${path}`, { method: input.method ?? 'GET', headers: { cookie: input.cookie ?? cookie, ...(input.body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }) });
      if (path === '/api/v1/auth/login') cookie = response.headers.get('set-cookie')!.split(';')[0]!;
      return { status: response.status, body: await response.json() as T };
    }
    await request('/api/v1/auth/login', { method: 'POST', body: { email: actor.email, password: 'isolated-webhook-password' } });
    async function command<T>(commandType: string, payload: Record<string, unknown>, target?: { id: string; version: number }): Promise<T> {
      const command: Command = { commandId: randomUUID(), commandType, payload, ...(target ? { targetId: target.id, expectedVersions: { [target.id]: target.version } } : {}) };
      const response = await request<CommandReceipt>(`/api/v1/workspaces/${workspaceId}/commands`, { method: 'POST', body: command });
      assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.status, 'committed', JSON.stringify(response.body));
      const result = response.body.result;
      if (commandType === 'CreateWebhookEndpoint' && result && typeof result === 'object' && 'endpointId' in result && typeof result.endpointId === 'string') await writeFile(join(root, `receiver-key-${result.endpointId}`), secret, { mode: 0o600 });
      return result as T;
    }
    const project = await command<Entity>('CreateProject', { name: 'No title leaves PM', goal: 'private-goal-marker', ownerId: actor.id, completionCriteria: ['not exported'] });
    const secret = randomBytes(32); const secretFile = join(root, 'receiver-key-{endpointId}');
    const manifestPath = join(root, 'targets.json');
    await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, targets: [{ targetKey: 'isolated_receiver', workspaceId, projectIds: [project.id], eventTypes: ['pm.project.changed.v1','pm.task.changed.v1','pm.milestone.changed.v1'], deliveryUrl: 'https://receiver.pm-webhook.com/deliver', receiptBaseUrl: 'https://receiver.pm-webhook.com/receipts', reconcileBaseUrl: 'https://receiver.pm-webhook.com/reconcile', protocol: 'pm-receipt-v1', policyVersion: 1, keyring: [{ keyId: 'isolated-key', secretFile, activeFrom: '2020-01-01T00:00:00.000Z', activeUntil: null, receiverReady: true }] }] }), { mode: 0o600 });
    Object.assign(config, readWebhookConfig({ WEBHOOK_TARGETS_FILE: manifestPath })); assert.equal(config.status, 'configured');
    receiver = await createDurableWebhookReceiver(pool, root, secret);
    const fixture: WebhookFixture = { pool, app, actor, workspaceId, projectId: project.id, root, config, receiver, request, command, close,
      async task() {
        const response = await request<CommandReceipt>(`/api/v1/workspaces/${workspaceId}/commands`, { method: 'POST', body: { commandId: randomUUID(), commandType: 'CreateWorkItem', projectId: project.id, payload: { title: 'private-title-marker', description: 'private-body-marker', acceptanceCriteria: [{ id: randomUUID(), text: 'not exported' }], assigneeId: actor.id } } });
        assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.result as Entity;
      },
      async enable(id, version) {
        const controller = new AbortController();
        const work = runWebhookLoop(pool!, config, controller.signal, { intervalMs: 10000, workerId: 'isolated-webhook-loop', transport: receiver!.transport });
        try {
          for (let i = 0; i < 200; i++) { const health = await pool!.query("SELECT 1 FROM webhook_loop_health WHERE worker_id='isolated-webhook-loop' AND state='running'"); if (health.rowCount) return await command<{ version: number }>('SetWebhookEndpointState', { state: 'enabled' }, { id, version }); await delay(10); }
          throw new Error('Actual isolated webhook loop did not become healthy');
        } finally { controller.abort(); await work; }
      },
      async batch() { return deliverWebhookBatch(pool!, config, { transport: receiver!.transport }); },
    };
    return fixture;
  } catch (error) { await close(); throw error; }
}
