import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { workflowTransitionRequestSchema, type WorkflowTransitionResult } from '../../../../packages/contracts/src/task-workflow.ts';
import { workflowTransitionChanges } from '../../../../packages/application/src/workflow-task-transition.ts';
import { requestHash } from '../../../../packages/application/src/kernel.ts';
import { DomainError, type Actor } from '../../../../packages/domain/src/core.ts';
import { authorizeCoreScope, executeAuditedCoreMutation, recoverAuditedCoreMutation, nativeCommandId, type CoreWorkspacePool } from './core-routes.ts';

type Options = { database: () => Pool; actor: (request: FastifyRequest) => Promise<Actor>; coreWorkspaces: CoreWorkspacePool | undefined };
export function registerWorkflowTaskTransitionRoutes(app: FastifyInstance, options: Options) {
  for (const reconcile of [false, true]) app.post(`/api/v1/workspaces/:workspaceId/workflow-task-transitions${reconcile ? '/reconcile' : ''}`, async (request, reply): Promise<WorkflowTransitionResult> => {
    reply.header('Cache-Control', 'private, no-store');
    const input = workflowTransitionRequestSchema.parse(request.body);
    const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(request.params);
    if (input.workspaceId !== workspaceId) throw new DomainError('workflow_scope', '工作区不一致。', 400);
    const principal = await options.actor(request);
    const scope = await authorizeCoreScope(options.database(), principal, workspaceId, 'planning.edit');
    if (!options.coreWorkspaces) throw new DomainError('backend_not_initialized', 'Markdown 核心未就绪。', 503);
    const workspace = await options.coreWorkspaces.get(workspaceId), before = workspace.get(input.taskId);
    scope.entity(before);
    if (before.entity.project !== input.projectId) throw new DomainError('workflow_scope', '任务项目不一致。', 409);
    const action = 'WorkflowTaskTransition', key = `${input.runId}:${input.nodeId}:${input.phase}`;
    const commandId = nativeCommandId(workspaceId, principal.id, action, input.taskId, key);
    const saved = await recoverAuditedCoreMutation({ database: options.database, pool: options.coreWorkspaces, principal, workspaceId, commandId,
      hash: requestHash({ action, targetId: input.taskId, input }), checkProject: project => { if (project !== input.projectId) throw new DomainError('workflow_scope', '收据项目不一致。', 409); } });
    if (saved?.kind === 'http_completed' && saved.revision) return { status: 'applied', revision: saved.revision, commandId };
    if (saved?.kind === 'http_rejected') throw new DomainError('workflow_transition_rejected', '原状态转换已被业务服务拒绝，请人工处理；不会重新执行。', 409);
    if (saved) return { status: 'pending' };
    if (reconcile) return { status: 'not_found' };
    const changes = workflowTransitionChanges(input, before);
    const result = await executeAuditedCoreMutation({ database: options.database, principal, workspace, scope, action, input, targetId: input.taskId, before, key,
      mutate: (_key, guard) => workspace.patch(input.taskId, changes, input.revision, guard),
      guard: previous => { if (!previous) throw new DomainError('workflow_scope', '任务不存在。', 409); workflowTransitionChanges(input, previous); } });
    if (!('revision' in result)) throw new DomainError('workflow_transition_unknown', '转换结果未知，请核对原收据。', 503);
    return { status: 'applied', revision: result.revision, commandId };
  });
}
