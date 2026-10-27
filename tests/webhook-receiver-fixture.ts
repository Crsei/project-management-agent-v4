import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, type Server } from 'node:https';
import { connect } from 'node:tls';
import type { Pool } from 'pg';
import { z } from 'zod';
import { sha256, signWebhookReceipt, webhookBodySchema, type WebhookRequestIdentity, type WebhookReceiverReceipt } from '../packages/domain/src/webhooks.ts';
import { createWebhookTransport, verifyWebhookRequest, type WebhookTransport } from '../packages/infrastructure/src/webhook-transport.ts';

type Inbox = { endpoint_id: string; delivery_id: string; event_id: string; payload_sha256: string; accepted: boolean; closed_through: number; effect_count: number; receiver_receipt_id: string; recorded_at: Date };
export type DurableWebhookReceiver = { server: Server; transport: WebhookTransport; requests: WebhookRequestIdentity[]; bodies: Buffer[]; mode: 'accept' | 'lose_response' | 'do_not_accept' | 'unsigned' | 'redirect' | 'oversize'; port: number; close: () => Promise<void> };
/** A real isolated TLS listener and PostgreSQL inbox/fence, not a simulated transport result. */
export async function createDurableWebhookReceiver(pool: Pool, root: string, secret: Buffer): Promise<DurableWebhookReceiver> {
  await pool.query(`CREATE TABLE receiver_inbox(endpoint_id uuid NOT NULL,delivery_id uuid NOT NULL,event_id uuid NOT NULL,payload_sha256 text NOT NULL,accepted boolean NOT NULL DEFAULT false,closed_through integer NOT NULL DEFAULT 0,effect_count integer NOT NULL DEFAULT 0,receiver_receipt_id uuid NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(endpoint_id,delivery_id))`);
  const keyPath = join(root, 'tls-key.pem'); const certPath = join(root, 'tls-cert.pem');
  const generated = Promise.withResolvers<void>();
  execFile('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=receiver.pm-webhook.com','-addext','subjectAltName=DNS:receiver.pm-webhook.com'], error => { if (error) generated.reject(new Error('Could not generate isolated TLS certificate')); else generated.resolve(); });
  await generated.promise;
  const cert = await readFile(certPath); const key = await readFile(keyPath);
  const requests: WebhookRequestIdentity[] = []; const bodies: Buffer[] = [];
  const reconcileSchema = z.strictObject({ schemaVersion: z.literal(1), endpointId: z.uuid(), deliveryId: z.uuid(), eventId: z.uuid(), payloadSha256: z.string().regex(/^[a-f0-9]{64}$/), closedThroughAttemptNo: z.number().int().positive() });
  const server = createServer({ key, cert, maxHeaderSize: 8192 }, (request, response) => {
    void (async () => {
      const chunks: Buffer[] = []; let length = 0;
      for await (const bytes of request) { const chunk = Buffer.from(bytes); length += chunk.length; if (length > 4096) { response.writeHead(413).end(); return; } chunks.push(chunk); }
      const body = Buffer.concat(chunks, length);
      const header = (name: string) => { const value = request.headers[name]; return typeof value === 'string' ? value : ''; };
      const identity: WebhookRequestIdentity = { method: request.method === 'GET' ? 'GET' : 'POST', path: request.url ?? '', endpointId: header('x-pm-endpoint-id'), deliveryId: header('x-pm-delivery-id'), eventId: header('x-pm-event-id'), attemptId: header('x-pm-attempt-id'), attemptNo: Number(header('x-pm-attempt-no')), timestamp: Number(header('x-pm-timestamp')), keyId: header('x-pm-key-id'), bodySha256: sha256(body) };
      if (!['GET','POST'].includes(request.method ?? '') || identity.keyId !== 'isolated-key' || !verifyWebhookRequest(secret, identity, body, header('x-pm-signature')) || ![identity.endpointId,identity.deliveryId,identity.eventId,identity.attemptId].every(id => z.uuid().safeParse(id).success)) { response.writeHead(401).end(); return; }
      requests.push(identity); bodies.push(body);
      if (receiver.mode === 'redirect') { response.writeHead(307, { location: 'https://127.0.0.1/forbidden' }).end(); return; }
      if (receiver.mode === 'unsigned') { response.writeHead(200).end('{}'); return; }
      if (receiver.mode === 'oversize') { response.writeHead(200).end('x'.repeat(8193)); return; }
      const delivery = identity.path === '/deliver' && identity.method === 'POST';
      const reconcile = identity.path === `/reconcile/${identity.deliveryId}` && identity.method === 'POST';
      const query = identity.path === `/receipts/${identity.deliveryId}` && identity.method === 'GET';
      if (!delivery && !reconcile && !query) { response.writeHead(404).end(); return; }
      const projection = delivery ? webhookBodySchema.parse(JSON.parse(body.toString('utf8'))) : reconcile ? reconcileSchema.parse(JSON.parse(body.toString('utf8'))) : null;
      if (projection && (projection.deliveryId !== identity.deliveryId || projection.eventId !== identity.eventId)) { response.writeHead(409).end(); return; }
      const sql = await pool.connect();
      let receipt: WebhookReceiverReceipt;
      try {
        await sql.query('BEGIN');
        await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,987654))', [identity.deliveryId]);
        let inbox = (await sql.query<Inbox>('SELECT * FROM receiver_inbox WHERE endpoint_id=$1 AND delivery_id=$2 FOR UPDATE', [identity.endpointId, identity.deliveryId])).rows[0];
        const expectedHash = delivery ? sha256(body) : reconcile ? reconcileSchema.parse(projection).payloadSha256 : inbox?.payload_sha256;
        if (inbox && (inbox.event_id !== identity.eventId || expectedHash && inbox.payload_sha256 !== expectedHash)) { await sql.query('ROLLBACK'); response.writeHead(409).end(); return; }
        if (!inbox && expectedHash) {
          inbox = (await sql.query<Inbox>('INSERT INTO receiver_inbox(endpoint_id,delivery_id,event_id,payload_sha256,receiver_receipt_id) VALUES($1,$2,$3,$4,$5) RETURNING *', [identity.endpointId, identity.deliveryId, identity.eventId, expectedHash, randomUUID()])).rows[0]!;
        }
        let status: WebhookReceiverReceipt['status'] = inbox?.accepted ? 'accepted' : 'unknown';
        if (delivery && inbox) {
          if (identity.attemptNo <= inbox.closed_through) status = 'not_accepted';
          else if (receiver.mode !== 'do_not_accept' && !inbox.accepted) {
            inbox = (await sql.query<Inbox>('UPDATE receiver_inbox SET accepted=true,effect_count=effect_count+1,receiver_receipt_id=$3,recorded_at=now() WHERE endpoint_id=$1 AND delivery_id=$2 RETURNING *', [identity.endpointId, identity.deliveryId, randomUUID()])).rows[0]!; status = 'accepted';
          }
        }
        if (reconcile && inbox && !inbox.accepted) {
          const through = reconcileSchema.parse(projection).closedThroughAttemptNo;
          inbox = (await sql.query<Inbox>('UPDATE receiver_inbox SET closed_through=greatest(closed_through,$3),receiver_receipt_id=$4,recorded_at=now() WHERE endpoint_id=$1 AND delivery_id=$2 RETURNING *', [identity.endpointId, identity.deliveryId, through, randomUUID()])).rows[0]!; status = 'not_accepted';
        }
        receipt = { schemaVersion: 1, receiverReceiptId: inbox?.receiver_receipt_id ?? randomUUID(), endpointId: identity.endpointId, deliveryId: identity.deliveryId, eventId: identity.eventId, attemptId: identity.attemptId, payloadSha256: inbox?.payload_sha256 ?? '0'.repeat(64), status, ...(status === 'not_accepted' ? { closedThroughAttemptNo: inbox!.closed_through } : {}), recordedAt: inbox?.recorded_at.toISOString() ?? new Date().toISOString() };
        await sql.query('COMMIT');
      } catch (error) { await sql.query('ROLLBACK'); throw error; }
      finally { sql.release(); }
      if (receiver.mode === 'lose_response' && delivery) { response.socket?.destroy(); return; }
      const bytes = Buffer.from(JSON.stringify(receipt));
      response.writeHead(200, { 'content-type': 'application/json', 'x-pm-receipt-signature': signWebhookReceipt(secret, identity, 200, bytes) }).end(bytes);
    })().catch(() => { if (!response.headersSent) response.writeHead(400); response.end(); });
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject); server.listen(0, '127.0.0.1', listening.resolve); await listening.promise;
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Isolated receiver did not bind TCP');
  const port = address.port;
  const transport = createWebhookTransport({ resolve: async () => [{ address: '127.0.0.1', family: 4 }], connect: (url, pinned) => connect({ host: pinned.address, port, servername: url.hostname, ca: cert, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] }) });
  const receiver: DurableWebhookReceiver = { server, port, transport, requests, bodies, mode: 'accept', async close() { const stopped = Promise.withResolvers<void>(); server.close(error => error ? stopped.reject(error) : stopped.resolve()); server.closeAllConnections(); await stopped.promise; } };
  return receiver;
}
