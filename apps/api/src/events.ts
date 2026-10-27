import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { setTimeout } from 'node:timers/promises';
import { DomainError, type Actor } from '../../../packages/domain/src/core.ts';
import { readChanges } from '../../../packages/application/src/changes.ts';

export function registerEventStream(app: FastifyInstance, database: () => Pool, actor: (request: FastifyRequest) => Promise<Actor>) {
  const streams = new Set<AbortController>();
  app.addHook('preClose', async () => { for (const stream of streams) stream.abort(); });
  app.get('/api/v1/workspaces/:workspaceId/events', async (request, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.uuid().toLowerCase() }).parse(request.params);
    const query = z.strictObject({ after: z.string().optional(), projectId: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).optional() }).parse(request.query);
    const header = request.headers['last-event-id'];
    let cursor = query.after ?? (typeof header === 'string' ? header : '0');
    let batch = await readChanges(database(), await actor(request), workspaceId, cursor, query.projectId);
    const controller = new AbortController();
    streams.add(controller);
    reply.raw.once('close', () => controller.abort());
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    try {
      reply.raw.write(': connected\n\n');
      while (!controller.signal.aborted) {
        for (const notification of batch.events) reply.raw.write(`id: ${notification.cursor}\nevent: change\ndata: ${JSON.stringify(notification.event)}\n\n`);
        if (batch.cursor !== cursor) {
          cursor = batch.cursor;
          reply.raw.write(`id: ${cursor}\nevent: checkpoint\ndata: ${JSON.stringify({ cursor })}\n\n`);
        } else reply.raw.write(': heartbeat\n\n');
        if (reply.raw.writableLength > 1024 * 1024) break;
        await setTimeout(750, undefined, { signal: controller.signal }).catch(() => {});
        if (controller.signal.aborted) break;
        batch = await readChanges(database(), await actor(request), workspaceId, cursor, query.projectId);
      }
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'temporarily_unavailable';
      if (!reply.raw.destroyed) reply.raw.write(`event: stream_error\ndata: ${JSON.stringify({ code })}\n\n`);
    } finally { streams.delete(controller); reply.raw.end(); }
  });
}
