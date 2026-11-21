import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import type { Actor } from '../../../../packages/domain/src/core.ts';
import { DomainError } from '../../../../packages/domain/src/core.ts';
import type { RoadmapAction, RoadmapRead } from '../../../../packages/contracts/src/product-roadmap.ts';
import { ROADMAP_FIELD, roadmapActionSchema } from '../../../../packages/contracts/src/product-roadmap.ts';
import { publishRoadmap, readRoadmap, roadmapRead, roadmapDependencyClosure, saveRoadmapDraft, taskInput } from '../../../../packages/application/src/product-roadmap.ts';
import { requestHash } from '../../../../packages/application/src/kernel.ts';
import type { SqlExecutor } from '../../../../packages/application/src/ports.ts';
import { authorizeCoreScope, executeAuditedCoreMutation, nativeCommandId, recoverAuditedCoreMutation, type CoreWorkspacePool } from './routes/core-routes.ts';
import { CoreCommandJournal } from './core-journal.ts';

import type { BlobStore } from '../../../../packages/infrastructure/src/blobs.ts';
import { resolveProductDesign } from '../../../../packages/application/src/product-design.ts';
import { downloadArtifactVersion } from '../../../../packages/application/src/delivery.ts';
import { readEntity } from '../../../../packages/application/src/queries.ts';
import type { ProductDesign } from '../../../../packages/contracts/src/product-design.ts';

export type ProductRoadmapServiceOptions = { blobs?: BlobStore; database: () => Pool; coreWorkspaces: CoreWorkspacePool | undefined };
export type ProductRoadmapMutationContext = { actor: Actor; workspaceId: string; projectId: string; checkAuthorization?: (sql: SqlExecutor) => Promise<void> };
export type ProductRoadmapMaterialization = { roadmap: RoadmapRead; selectedNodeIds: string[]; dependencyClosure: string[]; idMap: { nodeId: string; taskId: string; revision: string }[] };
export type ProductRoadmapService = {
  design(actor: Actor, workspaceId: string, projectId: string, versionId: string): ReturnType<typeof resolveProductDesign>;
  read(actor: Actor, workspaceId: string, projectId: string): Promise<RoadmapRead>;
  act(context: ProductRoadmapMutationContext, input: RoadmapAction): Promise<RoadmapRead>;
  materialize(context: ProductRoadmapMutationContext, releaseId: string, nodeIds: string[]): Promise<ProductRoadmapMaterialization>;
  recover(context: ProductRoadmapMutationContext, input: RoadmapAction): Promise<RoadmapRead | null>;
};

/** HTTP and model tools share the original native publication and per-node identities. */
export function createProductRoadmapService(options: ProductRoadmapServiceOptions): ProductRoadmapService {
  async function context(actor: Actor, workspaceId: string, projectId: string, write: boolean) {
    const scope = await authorizeCoreScope(options.database(), actor, workspaceId, write ? 'planning.edit' : 'domain.read');
    if (!options.coreWorkspaces) throw new DomainError('backend_not_initialized', 'Markdown 核心未就绪。', 503);
    const workspace = await options.coreWorkspaces.get(workspaceId), project = workspace.get(projectId);
    scope.entity(project); readRoadmap(project);
    if (write && project.entity.archived) throw new DomainError('roadmap_archived', '项目已归档，不可修改产品规划。', 409);
    return { scope, workspace, project };
  }
  async function read(actor: Actor, workspaceId: string, projectId: string): Promise<RoadmapRead> {
    const c = await context(actor, workspaceId, projectId, false);
    return roadmapRead(c.project, c.workspace.snapshot().files);
  }
  async function design(actor: Actor, workspaceId: string, projectId: string, versionId: string, expected?: ProductDesign) {
    await context(actor, workspaceId, projectId, false);
    if (!options.blobs) throw new DomainError('design_unavailable', '设计文件存储未就绪。', 503);
    return resolveProductDesign({ versionId, projectId, ...(expected ? {expected} : {}) }, {
      version: id => readEntity(options.database(), actor, workspaceId, id),
      content: id => downloadArtifactVersion(options.database(), actor, workspaceId, id, options.blobs!),
    });
  }
  async function act(caller: ProductRoadmapMutationContext, incoming: RoadmapAction): Promise<RoadmapRead> {
    const input = roadmapActionSchema.parse(incoming), { actor: principal, workspaceId, projectId } = caller;
    const { workspace, project, scope } = await context(principal, workspaceId, projectId, true);
    const store = readRoadmap(project);
    const selectedDesign = input.action === 'save' ? input.plan.design : input.action === 'publish' ? store.draft.design : store.releases.find(r => r.id === input.releaseId)?.plan.design;
    if (selectedDesign) await design(principal, workspaceId, projectId, selectedDesign.versionId, selectedDesign);
    const checkProject = (id: string) => { if (id !== projectId) throw new DomainError('roadmap_scope', '原收据范围不符。', 409); };
    if (input.action === 'materialize') {
      const release = store.releases.find(r => r.id === input.releaseId);
      if (!release) throw new DomainError('roadmap_missing', '请先发布并核对当前计划版本。', 409);
      const rows = roadmapRead(project, workspace.snapshot().files).tasks[release.id] ?? [];
      const action = 'MaterializeRoadmapTask', key = `${release.id}:${input.nodeId}`;
      const payload = taskInput(projectId, release, input.nodeId, rows.map(t => ({ ...t, drifted: false, archived: false })));
      const commandId = nativeCommandId(workspaceId, principal.id, action, undefined, key);
      const receipt = await recoverAuditedCoreMutation({ database: options.database, pool: options.coreWorkspaces!, principal, workspaceId, commandId,
        hash: requestHash({ action, targetId: undefined, input: payload }), checkProject });
      const matches = rows.filter(t => t.nodeId === input.nodeId);
      if (receipt?.kind === 'http_pending' || receipt?.kind === 'http_rejected') throw new DomainError('roadmap_unknown', '原请求未确认或已拒绝；请核对原创建收据，不会自动重建。', 409);
      if (matches.length > 1) throw new DomainError('roadmap_duplicate', '存在重复关联，请人工核对。', 409);
      if (matches.length === 1) return roadmapRead(workspace.get(projectId), workspace.snapshot().files);
      if (receipt) throw new DomainError('roadmap_missing_source', '原任务已创建但当前来源不可用；不会重建。', 409);
      taskInput(projectId, release, input.nodeId, rows);
      await executeAuditedCoreMutation({ database: options.database, principal, workspace, scope, action, input: payload, key,
        ...(caller.checkAuthorization ? { checkAuthorization: caller.checkAuthorization } : {}),
        mutate: (creationKey, guard, prepared) => workspace.createEntity(payload, creationKey, guard, prepared),
        guard: () => {
          const current = workspace.get(projectId), latest = roadmapRead(current, workspace.snapshot().files);
          if (current.entity.archived || !isDeepStrictEqual(latest.store.releases.find(r => r.id === release.id), release)) throw new DomainError('roadmap_changed', '项目或计划已变化，请刷新核对。', 409);
          const actual = latest.tasks[release.id] ?? [];
          if (actual.some(t => t.nodeId === input.nodeId)) throw new DomainError('roadmap_duplicate', '另一个请求已创建此任务，请刷新核对。', 409);
          if (!isDeepStrictEqual(taskInput(projectId, release, input.nodeId, actual), payload)) throw new DomainError('roadmap_changed', '依赖已变化，请刷新核对。', 409);
        } });
    } else {
      const action = 'UpdateProductRoadmap';
      const receipt = await recoverAuditedCoreMutation({ database: options.database, pool: options.coreWorkspaces!, principal, workspaceId,
        commandId: nativeCommandId(workspaceId, principal.id, action, projectId, input.commandId), hash: requestHash({ action, targetId: projectId, input }), checkProject });
      if (receipt?.kind === 'http_completed') return roadmapRead(workspace.get(projectId), workspace.snapshot().files);
      if (receipt) throw new DomainError('roadmap_unknown', '原写入未确认或已拒绝，请核对，不会重放。', 409);
      const next = input.action === 'save' ? saveRoadmapDraft(store, input.plan) : publishRoadmap(store, input.releaseId, principal.id, new Date().toISOString());
      await executeAuditedCoreMutation({ database: options.database, principal, workspace, scope, action, input, targetId: projectId, before: project, key: input.commandId,
        ...(caller.checkAuthorization ? { checkAuthorization: caller.checkAuthorization } : {}),
        mutate: (_key, guard) => workspace.patch(projectId, { [ROADMAP_FIELD]: next }, input.revision, guard) });
    }
    return roadmapRead(workspace.get(projectId), workspace.snapshot().files);
  }
  async function materialize(caller: ProductRoadmapMutationContext, releaseId: string, nodeIds: string[]): Promise<ProductRoadmapMaterialization> {
    const initial = await read(caller.actor, caller.workspaceId, caller.projectId), release = initial.store.releases.find(r => r.id === releaseId);
    if (!release) throw new DomainError('roadmap_missing', 'Published roadmap version does not exist', 409);
    const dependencyClosure = roadmapDependencyClosure(release, nodeIds);
    let roadmap = initial;
    for (const nodeId of dependencyClosure) {
      // Stop on the first unconfirmed node; never resend that node or generate a replacement key.
      roadmap = await act(caller, { action: 'materialize', releaseId, nodeId, confirm: true });
    }
    const idMap = dependencyClosure.map(nodeId => {
      const matches = (roadmap.tasks[releaseId] ?? []).filter(row => row.nodeId === nodeId);
      if (matches.length !== 1) throw new DomainError('roadmap_mapping_unavailable', 'The original native node mapping is not uniquely available', 409);
      return { nodeId, taskId: matches[0]!.taskId, revision: matches[0]!.revision };
    });
    return { roadmap, selectedNodeIds: nodeIds, dependencyClosure, idMap };
  }
  async function recover(caller: ProductRoadmapMutationContext, input: RoadmapAction): Promise<RoadmapRead | null> {
    // Inspection only: never recoverAuditedCoreMutation, execute, patch, create, or replay a request.
    const { workspace, project } = await context(caller.actor, caller.workspaceId, caller.projectId, false);
    const roadmap = roadmapRead(project, workspace.snapshot().files);
    const action = input.action === 'materialize' ? 'MaterializeRoadmapTask' : 'UpdateProductRoadmap';
    const release = input.action === 'materialize' ? roadmap.store.releases.find(r => r.id === input.releaseId) : undefined;
    if (input.action === 'materialize' && !release) return null;
    let payload: Record<string, unknown> = input;
    if (input.action === 'materialize') {
      try { payload = taskInput(caller.projectId, release!, input.nodeId, (roadmap.tasks[input.releaseId] ?? []).map(row => ({ ...row, drifted: false, archived: false }))); }
      catch (error) { if (error instanceof DomainError && error.code === 'roadmap_conflict') return null; throw error; }
    }
    const targetId = input.action === 'materialize' ? undefined : caller.projectId;
    const key = input.action === 'materialize' ? `${input.releaseId}:${input.nodeId}` : input.commandId;
    const commandId = nativeCommandId(caller.workspaceId, caller.actor.id, action, targetId, key);
    const original = new CoreCommandJournal(workspace.root).httpOutcome(commandId, caller.actor.id);
    if (!original || original.hash !== requestHash({ action, targetId, input: payload }) || original.kind === 'http_pending') return null;
    if (original.kind === 'http_rejected') throw new DomainError('agent_tool_recovered_rejection', 'The original roadmap operation was rejected', 409);
    if (original.audit.some(entry => entry.projectId !== caller.projectId || entry.actorId !== caller.actor.id || entry.commandId !== commandId || entry.action !== action)) return null;
    const audit = await options.database().query<{ count: number }>('SELECT count(*)::int AS count FROM project_audit WHERE workspace_id=$1 AND actor_id=$2 AND command_id=$3', [caller.workspaceId, caller.actor.id, commandId]);
    if ((audit.rows[0]?.count ?? 0) < original.audit.length) return null;
    return roadmap;
  }
  return { read, act, materialize, recover, design };
}
