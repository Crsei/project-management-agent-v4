import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import type { DashboardRecord } from '../../domain/src/dashboard.ts';
import type { ProjectCover, ProjectCoverData, ProjectExtras, ProjectFavorite, ProjectFavoriteData, ProjectScope, ProjectScopeData, ProjectSidebarOrder, ProjectSidebarOrderData } from '../../domain/src/project-extras.ts';
import { isProjectCoverMediaType, isProjectCoverRaster, projectSidebarOrderIds } from '../../domain/src/project-extras.ts';
import { assertProjectWritable, assertRule } from '../../domain/src/planning.ts';
import type { BlobStore } from '../../infrastructure/src/blobs.ts';
import { requireCapability } from './access.ts';
import { requireDashboardReadSelf, type DashboardReadContext } from './dashboard-read.ts';
import { emitDashboardEvent, insertDashboardRecord, listDashboardRecords, readDashboardRecord, requireDashboardSelf, updateDashboardRecord } from './dashboard-store.ts';
import type { CommandContext, CommandRegistry } from './ports.ts';

const favoritePayload = z.strictObject({ favorite: z.boolean() });
const sidebarOrderPayload = z.strictObject({
  projectIds: z.array(z.string().max(80).regex(/^[A-Z][A-Z0-9]*-\d+$/))
    .refine(ids => new Set(ids).size === ids.length, 'Duplicate project ID'),
});
const coverPayload = z.strictObject({ artifactVersionId: z.uuid().toLowerCase().nullable() });
const scopePayload = z.strictObject({
  items: z.array(z.strictObject({ id: z.uuid().toLowerCase(), text: z.string().trim().min(1).max(2000), completed: z.boolean() })).max(200)
    .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Duplicate scope item ID'),
});
const coverVersionData = z.object({ artifactId: z.uuid().toLowerCase(), objectKey: z.string().min(1), mediaType: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), contentDigest: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive() });

async function targetProject(ctx: CommandContext, editable: boolean): Promise<string> {
  assertRule(ctx.command.targetId, 'target_required');
  assertRule(!ctx.command.projectId || ctx.command.projectId === ctx.command.targetId, 'project_mismatch');
  await ctx.require(editable ? 'planning.edit' : 'domain.read', ctx.command.targetId);
  const project = await ctx.get(ctx.command.targetId, 'project');
  if (editable) {
    assertRule(project.data.archived !== true, 'object_archived');
    assertProjectWritable(project);
    if (ctx.core?.handles(project.id, 'project')) {
      const record = (await ctx.core.records()).find(file => file.id === project.id && file.entity.entity === 'project');
      assertRule(record && !record.stale && !record.error && !record.diagnostics?.some(issue => issue.severity === 'error'), 'core_project_read_only', 'The authoritative project must be valid and writable');
    }
  }
  ctx.checkVersion(project);
  return project.id;
}

/** Query only the changed project/actor so private receipts never acquire unrelated scopes. */
async function previousRecord<T>(ctx: CommandContext, projectId: string | null, kind: string, ownerId: string | null): Promise<DashboardRecord<T> | null> {
  const result = await ctx.sql.query<{ id: string }>('SELECT id FROM dashboard_records WHERE workspace_id=$1 AND project_id IS NOT DISTINCT FROM $2::text AND kind=$3 AND owner_id IS NOT DISTINCT FROM $4::uuid', [ctx.workspaceId, projectId, kind, ownerId]);
  const row = result.rows[0];
  return row ? readDashboardRecord<T>(ctx, row.id, kind) : null;
}

export function projectExtrasCommands(store: BlobStore): CommandRegistry {
  return {
    SetProjectSidebarOrder: {
      payload: sidebarOrderPayload,
      async handler(ctx): Promise<Pick<ProjectSidebarOrder, 'id' | 'version'>> {
        await requireDashboardSelf(ctx);
        assertRule(!ctx.command.targetId && !ctx.command.projectId, 'sidebar_order_scope', 'Sidebar order belongs to the current actor and workspace');
        const data = sidebarOrderPayload.parse(ctx.command.payload);
        for (const id of data.projectIds) {
          const project = await ctx.get(id, 'project');
          assertRule(project.data.archived !== true && !project.data.archivedAt, 'object_archived');
        }
        const previous = await previousRecord<ProjectSidebarOrderData>(ctx, null, 'project_sidebar_order', ctx.actor.id);
        const order = previous ? await updateDashboardRecord(ctx, previous, data)
          : await insertDashboardRecord(ctx, { kind: 'project_sidebar_order', ownerId: ctx.actor.id, data });
        await emitDashboardEvent(ctx, 'ProjectSidebarOrderSet', order);
        // Receipts are durable history; current authorized IDs are read only through extras.
        return { id: order.id, version: order.version };
      },
    },
    SetProjectFavorite: {
      payload: favoritePayload,
      async handler(ctx): Promise<ProjectFavorite> {
        await requireDashboardSelf(ctx);
        const projectId = await targetProject(ctx, false);
        const data = favoritePayload.parse(ctx.command.payload);
        const previous = await previousRecord<ProjectFavoriteData>(ctx, projectId, 'project_favorite', ctx.actor.id);
        const favorite = previous ? await updateDashboardRecord(ctx, previous, data)
          : await insertDashboardRecord(ctx, { kind: 'project_favorite', projectId, ownerId: ctx.actor.id, data });
        await emitDashboardEvent(ctx, 'ProjectFavoriteSet', favorite);
        return favorite;
      },
    },
    SetProjectCover: {
      payload: coverPayload,
      async handler(ctx): Promise<ProjectCover> {
        const projectId = await targetProject(ctx, true);
        const payload = coverPayload.parse(ctx.command.payload);
        const data: ProjectCoverData = { artifactVersionId: null, mediaType: null };
        if (payload.artifactVersionId !== null) {
          const version = await ctx.get(payload.artifactVersionId, 'artifact_version');
          assertRule(version.workspaceId === ctx.workspaceId && version.projectId === projectId, 'project_mismatch');
          const metadata = coverVersionData.safeParse(version.data);
          if (!metadata.success || !isProjectCoverMediaType(metadata.data.mediaType)) throw new DomainError('unsafe_project_cover', 'Select a registered PNG, JPEG, GIF or WebP raster image', 400);
          const artifact = await ctx.get(metadata.data.artifactId, 'artifact');
          assertRule(artifact.projectId === projectId && artifact.workspaceId === ctx.workspaceId, 'project_mismatch');
          const bytes = await store.read(metadata.data.objectKey, { workspaceId: ctx.workspaceId, projectId, ...(version.data.storageId ? { storageId: version.data.storageId } : {}) });
          const digest = createHash('sha256').update(bytes).digest('hex');
          if (digest !== metadata.data.sha256 || digest !== metadata.data.contentDigest || bytes.length !== metadata.data.size) throw new DomainError('blob_integrity_error', 'Artifact metadata does not match stored content', 503);
          if (!isProjectCoverRaster(bytes, metadata.data.mediaType)) throw new DomainError('unsafe_project_cover', 'Uploaded content is not the declared safe raster image', 400);
          data.artifactVersionId = version.id;
          data.mediaType = metadata.data.mediaType;
        }
        const previous = await previousRecord<ProjectCoverData>(ctx, projectId, 'project_cover', null);
        const cover = previous ? await updateDashboardRecord(ctx, previous, data)
          : await insertDashboardRecord(ctx, { kind: 'project_cover', projectId, data });
        await emitDashboardEvent(ctx, 'ProjectCoverSet', cover);
        return cover;
      },
    },
    SetProjectScope: {
      payload: scopePayload,
      async handler(ctx): Promise<ProjectScope> {
        const projectId = await targetProject(ctx, true);
        const data = scopePayload.parse(ctx.command.payload);
        const previous = await previousRecord<ProjectScopeData>(ctx, projectId, 'project_scope', null);
        const scope = previous ? await updateDashboardRecord(ctx, previous, data)
          : await insertDashboardRecord(ctx, { kind: 'project_scope', projectId, data });
        await emitDashboardEvent(ctx, 'ProjectScopeSet', scope);
        return scope;
      },
    },
  };
}

export async function readProjectExtras(ctx: DashboardReadContext): Promise<ProjectExtras> {
  const membership = await requireDashboardReadSelf(ctx);
  const fresh = { ...ctx, membership };
  const projects = (await ctx.core.list('project')).filter(project => membership.projectIds === null || membership.projectIds.includes(project.id));
  for (const project of projects) await requireCapability(ctx.sql, ctx.actor, ctx.workspaceId, 'domain.read', project.id);
  const favorites = await listDashboardRecords<ProjectFavoriteData>(fresh, 'project_favorite');
  const covers = await listDashboardRecords<ProjectCoverData>(fresh, 'project_cover');
  const scopes = await listDashboardRecords<ProjectScopeData>(fresh, 'project_scope');
  const favoriteByProject = new Map(favorites.filter(row => row.ownerId === ctx.actor.id).map(row => [row.projectId, row]));
  const coverByProject = new Map(covers.map(row => [row.projectId, row]));
  const scopeByProject = new Map(scopes.map(row => [row.projectId, row]));
  const savedOrder = (await listDashboardRecords<ProjectSidebarOrderData>(fresh, 'project_sidebar_order')).find(row => row.ownerId === ctx.actor.id) ?? null;
  const sidebarOrder = savedOrder ? { ...savedOrder, data: { projectIds: projectSidebarOrderIds(savedOrder.data.projectIds, projects.filter(project => project.data.archived !== true && !project.data.archivedAt).map(project => project.id)) } } : null;
  return { projects: projects.map(project => ({ projectId: project.id, favorite: favoriteByProject.get(project.id) ?? null, cover: coverByProject.get(project.id) ?? null, scope: scopeByProject.get(project.id) ?? null })), sidebarOrder };
}
