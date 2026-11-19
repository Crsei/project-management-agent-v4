import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, type Actor } from '../../../../packages/domain/src/core.ts';
import { lockWorkspace } from '../../../../packages/infrastructure/src/database.ts';
import type { NotificationCorePort } from '../../../../packages/pm-core/readonly.ts';
import { changeHistoryQuerySchema, changeCompareInputSchema, changeAcknowledgeInputSchema, taskAttentionQuerySchema } from '../../../../packages/contracts/src/change-history.ts';
import { readChangeHistory, readChangeDetail, compareChangeHistory, acknowledgeChangeHistory, readTaskAttention, type ChangeHistoryContext } from '../../../../packages/application/src/change-history.ts';
import { authorizeExternalDocumentHistory, resolveAuthorizedExternalDocumentHistoryAddress, type DocumentSourceContext } from '../../../../packages/application/src/document-sources.ts';

type Options = { database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>; core: NotificationCorePort; sources: Omit<DocumentSourceContext, 'sql' | 'actor'> };
const params = z.object({ workspaceId: z.uuid().toLowerCase() });
const base = '/api/v1/workspaces/:workspaceId/change-history';
export function registerChangeHistoryRoutes(app: FastifyInstance, options: Options): void {
  async function inScope<T>(request: FastifyRequest, operation: (context: ChangeHistoryContext) => Promise<T>): Promise<T> {
    const { workspaceId } = params.parse(request.params);
    const actor = await options.actor(request), sql = await options.database().connect();
    try {
      await sql.query('BEGIN');
      await lockWorkspace(sql, workspaceId);
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('local-project-directories',724631))");
      const snapshot = await options.core.read(workspaceId), sources: DocumentSourceContext = { ...options.sources, sql, actor };
      const context: ChangeHistoryContext = { sql, actor, workspaceId, snapshot,
        authorizeExternal: target => authorizeExternalDocumentHistory(sources, { workspaceId, sourceId: target.sourceId, path: target.path }),
        resolveExternal: address => resolveAuthorizedExternalDocumentHistoryAddress(sources, workspaceId, address),
      };
      const result = await operation(context);
      if ((await options.core.read(workspaceId)).fingerprint !== snapshot.fingerprint) throw new DomainError('core_source_changed', 'Read the current authoritative sources again', 409);
      await sql.query('COMMIT');
      return result;
    } catch (error) { await sql.query('ROLLBACK'); throw error; }
    finally { sql.release(); }
  }
  app.post(`${base}/query`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return inScope(request, ctx => readChangeHistory(ctx, changeHistoryQuerySchema.parse(request.body)));
  });
  app.post(`${base}/compare`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return inScope(request, ctx => compareChangeHistory(ctx, changeCompareInputSchema.parse(request.body)));
  });
  app.post(`${base}/acknowledge`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return inScope(request, ctx => acknowledgeChangeHistory(ctx, changeAcknowledgeInputSchema.parse(request.body)));
  });
  app.post(`${base}/attention`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    return inScope(request, ctx => readTaskAttention(ctx, taskAttentionQuerySchema.parse(request.body)));
  });
  app.get(`${base}/:changeId`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    const { changeId } = params.extend({ changeId: z.uuid() }).parse(request.params);
    return inScope(request, ctx => readChangeDetail(ctx, changeId));
  });
}
