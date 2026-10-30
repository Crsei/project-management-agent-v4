import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, type Actor } from '../../../../packages/domain/src/core.ts';
import { inspectMarkdown } from '../../../../packages/pm-markdown/index.ts';
import { FileRepository } from '../../../../packages/pm-core/repository.ts';
import { ProjectLocations } from '../../../../packages/pm-core/project-locations.ts';
import { authorizeCoreScope, type CoreWorkspacePool } from './core-routes.ts';

type Options = { database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>; coreWorkspaces: CoreWorkspacePool | undefined };
const params = z.strictObject({ workspaceId: z.uuid().toLowerCase() });
const query = z.strictObject({ projectId: z.string().regex(/^PRJ-\d+$/) });

/** Only the PM core repository and its registered project mount are traversed. */
export function registerAgentCoreFilesRoutes(app: FastifyInstance, options: Options): void {
  app.get('/api/v1/workspaces/:workspaceId/agent-tools/core-files', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const { workspaceId } = params.parse(request.params), { projectId } = query.parse(request.query);
    const scope = await authorizeCoreScope(options.database(), await options.actor(request), workspaceId, 'domain.read');
    if (!options.coreWorkspaces) throw new DomainError('backend_not_initialized', 'The Markdown core is unavailable', 503);
    if (!scope.allowsProject(projectId)) throw new DomainError('not_found_or_forbidden', 'Project is not accessible', 404);
    const workspace = await options.coreWorkspaces.get(workspaceId);
    const locations = new ProjectLocations(workspace.root);
    locations.assertSettled();
    const mount = locations.get(projectId);
    const snapshot = workspace.snapshot();
    const known = new Map(snapshot.files.map(file => [file.path, file]));
    const shared = new FileRepository(workspace.root, false).collect();
    const retired = locations.retiredPaths();
    const files: { path: string; projectId: string; entityId: string | null; content: string }[] = [];
    let incomplete = shared.errors.length > 0;
    for (const file of shared.files) {
      if (retired.has(file.path)) continue;
      const prior = known.get(file.path);
      const entityId = prior?.id ?? null;
      // A shared-root source has no trusted project boundary of its own. In
      // particular, invalid frontmatter must not grant access to another project.
      const owner = prior ? prior.entity.entity === 'project' ? prior.id : typeof prior.entity.project === 'string' ? prior.entity.project : undefined : undefined;
      if (!owner) { incomplete = true; continue; }
      if (owner === projectId) files.push({ path: file.path, projectId, entityId, content: file.raw });
    }
    if (mount) {
      const mounted = new FileRepository(mount.corePath, false).collect();
      if (mounted.errors.length) incomplete = true;
      for (const file of mounted.files) {
        const virtualPath = `${mount.virtualPrefix}/${file.path}`;
        const entityId = known.get(virtualPath)?.id ?? inspectMarkdown(file.raw).id ?? null;
        files.push({ path: virtualPath, projectId, entityId, content: file.raw });
      }
      // Revalidate the registered identity after reading, not merely before traversal.
      locations.get(projectId);
    }
    let bytes = 0;
    const bounded = files.filter(file => {
      bytes += Buffer.byteLength(file.content, 'utf8');
      return bytes <= 32 * 1024 * 1024;
    }).slice(0, 10000);
    if (bounded.length !== files.length) incomplete = true;
    return { files: bounded, complete: !incomplete, ...(incomplete ? { error: 'Some core files could not be read, assigned safely, or exceeded the observation limit; deletion detection is suspended.' } : {}) };
  });
}
