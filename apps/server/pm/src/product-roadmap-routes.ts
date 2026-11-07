import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { ROADMAP_FIELD, roadmapActionSchema } from '../../../../packages/contracts/src/product-roadmap.ts';
import { publishRoadmap, readRoadmap, roadmapRead, saveRoadmapDraft, taskInput } from '../../../../packages/application/src/product-roadmap.ts';
import { requestHash } from '../../../../packages/application/src/kernel.ts';
import { resolveProductDesign } from '../../../../packages/application/src/product-design.ts';
import { downloadArtifactVersion } from '../../../../packages/application/src/delivery.ts';
import { readEntity } from '../../../../packages/application/src/queries.ts';
import type { BlobStore } from '../../../../packages/infrastructure/src/blobs.ts';
import type { ProductDesign } from '../../../../packages/contracts/src/product-design.ts';
import { DomainError, type Actor } from '../../../../packages/domain/src/core.ts';
import { authorizeCoreScope, executeAuditedCoreMutation, nativeCommandId, recoverAuditedCoreMutation, type CoreWorkspacePool } from './core-routes.ts';

type Options = { database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>; coreWorkspaces: CoreWorkspacePool | undefined; blobs?: BlobStore };
export function registerProductRoadmapRoutes(app: FastifyInstance, options: Options) {
  const path = '/api/v1/workspaces/:workspaceId/projects/:projectId/product-roadmap';
  async function context(request: FastifyRequest, write: boolean) {
    const { workspaceId, projectId } = z.object({ workspaceId: z.uuid(), projectId: z.string().min(1).max(100) }).parse(request.params);
    const principal = await options.actor(request);
    const scope = await authorizeCoreScope(options.database(), principal, workspaceId, write ? 'planning.edit' : 'domain.read');
    if (!options.coreWorkspaces) throw new DomainError('backend_not_initialized', 'Markdown 核心未就绪。', 503);
    const workspace = await options.coreWorkspaces.get(workspaceId), project = workspace.get(projectId);
    scope.entity(project); readRoadmap(project);
    if (write && project.entity.archived) throw new DomainError('roadmap_archived', '项目已归档，不可修改产品规划。', 409);
    return { workspaceId, projectId, principal, scope, workspace, project };
  }
  async function design(c:Awaited<ReturnType<typeof context>>,versionId:string,expected?:ProductDesign) {
    if(!options.blobs)throw new DomainError('design_unavailable','设计文件存储未就绪。',503);
    return resolveProductDesign({versionId,projectId:c.projectId,...(expected?{expected}:{})},{
      version:id=>readEntity(options.database(),c.principal,c.workspaceId,id),
      content:id=>downloadArtifactVersion(options.database(),c.principal,c.workspaceId,id,options.blobs!),
    });
  }
  app.get(`${path}/design/:versionId`, async (request,reply)=>{
    reply.header('Cache-Control','private, no-store');
    const c=await context(request,false),{versionId}=z.object({versionId:z.uuid()}).parse(request.params);
    return design(c,versionId);
  });
  app.get(path, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const c = await context(request, false);
    return roadmapRead(c.project, c.workspace.snapshot().files);
  });
  app.post(path, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const input = roadmapActionSchema.parse(request.body), c = await context(request, true);
    const { workspace, project, principal, scope, workspaceId, projectId } = c;
    const store = readRoadmap(project);
    const selectedDesign=input.action==='save'?input.plan.design:input.action==='publish'?store.draft.design:store.releases.find(r=>r.id===input.releaseId)?.plan.design;
    if(selectedDesign)await design(c,selectedDesign.versionId,selectedDesign);
    if (input.action === 'materialize') {
      const release = store.releases.find(r => r.id === input.releaseId);
      if (!release) throw new DomainError('roadmap_missing', '请先发布并核对当前计划版本。', 409);
      const read = roadmapRead(project, workspace.snapshot().files), rows = read.tasks[release.id] ?? [];
      const action = 'MaterializeRoadmapTask', key = `${release.id}:${input.nodeId}`;
      // Recovery uses the frozen requirements and original real dependency identities.
      const payload = taskInput(projectId, release, input.nodeId, rows.map(t => ({ ...t, drifted: false, archived: false })));
      const commandId = nativeCommandId(workspaceId, principal.id, action, undefined, key);
      const receipt = await recoverAuditedCoreMutation({ database: options.database, pool: options.coreWorkspaces!, principal, workspaceId, commandId,
        hash: requestHash({ action, targetId: undefined, input: payload }), checkProject: id => { if (id !== projectId) throw new DomainError('roadmap_scope', '原收据范围不符。', 409); } });
      const matches = rows.filter(t => t.nodeId === input.nodeId);
      if (receipt?.kind === 'http_pending' || receipt?.kind === 'http_rejected') throw new DomainError('roadmap_unknown', '原请求未确认或已拒绝；请核对原创建收据，不会自动重建。', 409);
      if (matches.length > 1) throw new DomainError('roadmap_duplicate', '存在重复关联，请人工核对。', 409);
      if (matches.length === 1) return roadmapRead(workspace.get(projectId), workspace.snapshot().files);
      if (receipt) throw new DomainError('roadmap_missing_source', '原任务已创建但当前来源不可用；不会重建。', 409);
      taskInput(projectId, release, input.nodeId, rows); // Strict dependency validation for a new write.
      await executeAuditedCoreMutation({ database: options.database, principal, workspace, scope, action, input: payload, key,
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
        commandId: nativeCommandId(workspaceId, principal.id, action, projectId, input.commandId), hash: requestHash({ action, targetId: projectId, input }),
        checkProject: id => { if (id !== projectId) throw new DomainError('roadmap_scope', '原收据范围不符。', 409); } });
      if (receipt?.kind === 'http_completed') return roadmapRead(workspace.get(projectId), workspace.snapshot().files);
      if (receipt) throw new DomainError('roadmap_unknown', '原写入未确认或已拒绝，请核对，不会重放。', 409);
      const next = input.action === 'save' ? saveRoadmapDraft(store, input.plan) : publishRoadmap(store, input.releaseId, principal.id, new Date().toISOString());
      await executeAuditedCoreMutation({ database: options.database, principal, workspace, scope, action: 'UpdateProductRoadmap', input, targetId: projectId, before: project, key: input.commandId,
        mutate: (_key, guard) => workspace.patch(projectId, { [ROADMAP_FIELD]: next }, input.revision, guard) });
    }
    return roadmapRead(workspace.get(projectId), workspace.snapshot().files);
  });
}
