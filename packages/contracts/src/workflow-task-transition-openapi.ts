import { z } from 'zod';
import { workflowTransitionRequestSchema } from './task-workflow.ts';

export function workflowTaskTransitionPaths(): Record<string, Record<string, unknown>> {
  const json = (schema: unknown) => ({ 'application/json': { schema } });
  const result = z.union([z.strictObject({ status: z.literal('applied'), revision: z.string(), commandId: z.string() }), z.strictObject({ status: z.enum(['not_found', 'pending']) })]);
  const endpoint = (reconcile: boolean) => ({
    operationId: reconcile ? 'reconcileWorkflowTaskTransition' : 'applyWorkflowTaskTransition',
    description: reconcile ? 'Recover only the original actor/run/node/phase receipt; never replay a task mutation or adopt a later revision.' : 'Workflow-originated start/review only. Requires current planning.edit, project scope, exact task revision and a permitted native workflow edge. Never completes, cancels or reopens a task. Stable run/node/phase identity is immutable and journaled.',
    security: [{ sessionCookie: [] }, { bearerAuth: [] }],
    parameters: [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    requestBody: { required: true, content: json(z.toJSONSchema(workflowTransitionRequestSchema)) },
    responses: { 200: { description: 'Original transition receipt or unresolved result', content: json(z.toJSONSchema(result)) }, ...Object.fromEntries([400, 401, 403, 404, 409, 503].map(status => [status, { description: 'Validation, authorization, revision, state or recovery rejection', content: json({ $ref: '#/components/schemas/ErrorResponse' }) }])) },
  });
  const base = '/api/v1/workspaces/{workspaceId}/workflow-task-transitions';
  return { [base]: { post: endpoint(false) }, [base + '/reconcile']: { post: endpoint(true) } };
}
