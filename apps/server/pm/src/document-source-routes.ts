import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { listDocumentSourceFiles, listDocumentSources, previewDocumentSource, readDocumentSourceContent, saveDocumentSource, type DocumentSourceContext } from '../../../../packages/application/src/document-sources.ts';
import type { AgentDirectoryConfiguration } from '../../../../packages/application/src/agent-storage.ts';
import { documentSourceContentQuerySchema, documentSourceFilesQuerySchema, documentSourcePreviewInputSchema, documentSourceScopeKeySchema, documentSourceUpdateSchema, type DocumentSourceScope } from '../../../../packages/contracts/src/document-sources.ts';
import type { Actor } from '../../../../packages/domain/src/core.ts';
import { lockWorkspace } from '../../../../packages/infrastructure/src/database.ts';
import type { Workspace } from '../../../../packages/pm-core/index.ts';

type Options = { database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>; config: AgentDirectoryConfiguration; workspace: (workspaceId: string) => Promise<Workspace> };
const workspaceParams = z.strictObject({ workspaceId: z.uuid().toLowerCase() });
const sourceParams = workspaceParams.extend({ scopeKey: documentSourceScopeKeySchema });
const base = '/api/v1/workspaces/:workspaceId/document-sources';
const emptyQuery = z.strictObject({});
function scopeFrom(params: z.infer<typeof sourceParams>): DocumentSourceScope { return { workspaceId: params.workspaceId, projectId: params.scopeKey === 'workspace' ? null : params.scopeKey }; }

/** Reuse PM authentication/origin handling and workspace authorization locking. */
export function registerDocumentSourceRoutes(app: FastifyInstance, options: Options): void {
  async function inWorkspace<T>(request: FastifyRequest, workspaceId: string, operation: (context: DocumentSourceContext) => Promise<T>): Promise<T> {
    const actor = await options.actor(request), sql = await options.database().connect();
    try {
      await sql.query('BEGIN'); await lockWorkspace(sql, workspaceId);
      // Same ordering/key as native project claims; sources never change Agent cwd.
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('local-project-directories',724631))");
      const result = await operation({ sql, actor, config: options.config, workspace: options.workspace });
      await sql.query('COMMIT'); return result;
    } catch (error) { await sql.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { sql.release(); }
  }
  app.get(base, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store'); emptyQuery.parse(request.query);
    const { workspaceId } = workspaceParams.parse(request.params);
    return inWorkspace(request, workspaceId, context => listDocumentSources(context, workspaceId));
  });
  app.post(`${base}/preview`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store'); emptyQuery.parse(request.query);
    const { workspaceId } = workspaceParams.parse(request.params), input = documentSourcePreviewInputSchema.parse(request.body);
    return inWorkspace(request, workspaceId, context => previewDocumentSource(context, workspaceId, input));
  });
  app.put(`${base}/:scopeKey`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store'); emptyQuery.parse(request.query);
    const scope = scopeFrom(sourceParams.parse(request.params)), input = documentSourceUpdateSchema.parse(request.body);
    return inWorkspace(request, scope.workspaceId, context => saveDocumentSource(context, scope, input));
  });
  app.get(`${base}/:scopeKey/files`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const scope = scopeFrom(sourceParams.parse(request.params)), query = documentSourceFilesQuerySchema.parse(request.query);
    return inWorkspace(request, scope.workspaceId, context => listDocumentSourceFiles(context, scope, { limit: query.limit, ...(query.cursor === undefined ? {} : { cursor: query.cursor }) }));
  });
  app.get(`${base}/:scopeKey/content`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    const scope = scopeFrom(sourceParams.parse(request.params)), query = documentSourceContentQuerySchema.parse(request.query);
    return inWorkspace(request, scope.workspaceId, context => readDocumentSourceContent(context, scope, query.path));
  });
}
