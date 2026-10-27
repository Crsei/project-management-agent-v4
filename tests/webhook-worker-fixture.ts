import { readFile } from 'node:fs/promises';
import { connect } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '../packages/infrastructure/src/database.ts';
import { readWebhookConfig } from '../packages/infrastructure/src/webhook-config.ts';
import { createWebhookTransport, type WebhookTransport } from '../packages/infrastructure/src/webhook-transport.ts';
import { runWebhookLoop } from '../packages/application/src/webhook-delivery.ts';

// This entrypoint is test-only. No production config or Worker imports this network policy.
const url = process.env.PM_WEBHOOK_TEST_DATABASE_URL;
const certFile = process.env.PM_WEBHOOK_TEST_CERT;
const port = Number(process.env.PM_WEBHOOK_TEST_PORT);
if (!url || !certFile || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Isolated worker fixture inputs are required');
const ca = await readFile(certFile);
const config = readWebhookConfig();
const pool = createPool(url);
const controller = new AbortController();
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, () => controller.abort());
const actual = createWebhookTransport({ resolve: async () => [{ address: '127.0.0.1', family: 4 }], connect: (target, pinned) => connect({ host: pinned.address, port, servername: target.hostname, ca, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] }) });
const transport: WebhookTransport = {
  async prepare(...args) {
    const prepared = await actual.prepare(...args);
    if (process.env.PM_WEBHOOK_TEST_HOLD === 'preparing') await delay(60000, undefined, { signal: controller.signal });
    return prepared;
  },
  async send(...args) {
    if (process.env.PM_WEBHOOK_TEST_HOLD === 'sending') await delay(60000, undefined, { signal: controller.signal });
    return actual.send(...args);
  },
};
try { await runWebhookLoop(pool, config, controller.signal, { intervalMs: 50, workerId: process.env.PM_WEBHOOK_TEST_WORKER_ID ?? 'isolated-worker', transport }); }
finally { await pool.end(); }
