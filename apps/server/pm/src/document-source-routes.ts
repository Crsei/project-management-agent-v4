import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { configureDocumentSources, listDocumentSourceDirectories, listDocumentSourceFiles, listDocumentSources, mutateDocumentSource, queryDocumentSourceMutation, readDocumentSourceContent, type DocumentSourceContext } from '../../../../packages/application/src/document-sources.ts';
import type { AgentDirectoryConfiguration } from '../../../../packages/application/src/agent-storage.ts';
import { documentSourceConfigurationInputSchema, documentSourceContentQuerySchema, documentSourceDirectoriesQuerySchema, documentSourceFilesQuerySchema, documentSourceIdSchema, documentSourceMutationSchema } from '../../../../packages/contracts/src/document-sources.ts';
import type { Actor } from '../../../../packages/domain/src/core.ts';
import { lockWorkspace } from '../../../../packages/infrastructure/src/database.ts';
import type { Workspace } from '../../../../packages/pm-core/index.ts';

type Options = { database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>; config: AgentDirectoryConfiguration; workspace: (workspaceId: string) => Promise<Workspace> };
const workspaceParams = z.strictObject({ workspaceId: z.uuid().toLowerCase() });
const sourceParams = workspaceParams.extend({ sourceId: documentSourceIdSchema });
const base = '/api/v1/workspaces/:workspaceId/document-sources';
const operationParams = sourceParams.extend({ operationId: z.uuid().toLowerCase() });
const emptyQuery = z.strictObject({});

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
  async function withMutationLocks<T>(request: FastifyRequest, workspaceId: string, operation: (context: DocumentSourceContext) => Promise<T>): Promise<T> {
    const actor = await options.actor(request), sql = await options.database().connect();
    let destroy = false;
    try {
      // Session locks intentionally survive the independently committed attempt,
      // dispatch and receipt statements. No transaction pretends to roll back IO.
      await sql.query('SELECT pg_advisory_lock(hashtextextended($1::uuid::text,724631))', [workspaceId]);
      await sql.query("SELECT pg_advisory_lock(hashtextextended('local-project-directories',724631))");
      return await operation({ sql, actor, config: options.config, workspace: options.workspace });
    } finally {
      try {
        await sql.query("SELECT pg_advisory_unlock(hashtextextended('local-project-directories',724631))");
        await sql.query('SELECT pg_advisory_unlock(hashtextextended($1::uuid::text,724631))', [workspaceId]);
      } catch { destroy = true; }
      sql.release(destroy);
    }
  }
  app.get(base, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store'); emptyQuery.parse(request.query);
    const { workspaceId } = workspaceParams.parse(request.params);
    return inWorkspace(request, workspaceId, context => listDocumentSources(context, workspaceId));
  });
  app.get(`${base}/directories`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const { workspaceId } = workspaceParams.parse(request.params), query = documentSourceDirectoriesQuerySchema.parse(request.query);
    return inWorkspace(request, workspaceId, context => listDocumentSourceDirectories(context, workspaceId, query.projectId ?? null, query.path));
  });
  app.put(`${base}/configuration`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store'); emptyQuery.parse(request.query);
    const { workspaceId } = workspaceParams.parse(request.params), input = documentSourceConfigurationInputSchema.parse(request.body);
    return inWorkspace(request, workspaceId, context => configureDocumentSources(context, workspaceId, input));
  });
  app.get(`${base}/:sourceId/files`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const reference = sourceParams.parse(request.params), query = documentSourceFilesQuerySchema.parse(request.query);
    return inWorkspace(request, reference.workspaceId, context => listDocumentSourceFiles(context, reference, { limit: query.limit, ...(query.cursor === undefined ? {} : { cursor: query.cursor }) }));
  });
  app.get(`${base}/:sourceId/content`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    const reference = sourceParams.parse(request.params), query = documentSourceContentQuerySchema.parse(request.query);
    return inWorkspace(request, reference.workspaceId, context => readDocumentSourceContent(context, reference, query.path));
  });
  app.post(`${base}/:sourceId/operations`, { bodyLimit: 25 * 1024 * 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    emptyQuery.parse(request.query);
    const reference = sourceParams.parse(request.params), input = documentSourceMutationSchema.parse(request.body);
    return withMutationLocks(request, reference.workspaceId, context => mutateDocumentSource(context, reference, input));
  });
  app.get(`${base}/:sourceId/operations/:operationId`, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    emptyQuery.parse(request.query);
    const { workspaceId, sourceId, operationId } = operationParams.parse(request.params);
    return withMutationLocks(request, workspaceId, context => queryDocumentSourceMutation(context, { workspaceId, sourceId }, operationId));
  });
}
