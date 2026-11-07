import { z } from 'zod';
import { changeHistoryQuerySchema, changeHistoryPageSchema, changeDetailSchema, changeCompareInputSchema, changeComparisonSchema, changeAcknowledgeInputSchema, changeAcknowledgementSchema, taskAttentionQuerySchema, taskAttentionPageSchema } from './change-history.ts';

export function changeHistoryPaths(): Record<string, Record<string, unknown>> {
  const workspace = { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
  const base = '/api/v1/workspaces/{workspaceId}/change-history';
  function endpoint(operationId: string, output: z.ZodType, input?: z.ZodType) {
    const schema = z.toJSONSchema(output, { io: 'output', target: 'draft-2020-12' }); delete schema.$schema;
    return {
      operationId, security: [{ sessionCookie: [] }, { bearerAuth: [] }], parameters: [workspace],
      description: 'Private immutable Markdown snapshots. Current workspace/project/source authorization is rechecked, including moved/deleted/rebound sources. Metadata pages contain no bodies and are capped at 100 entries; attention batches are capped at 500 tasks with afterTaskId pagination. More than 100 distinct retained external address-binding pairs fails closed with 503 rather than truncating authorized counts. Initial observation is a baseline, not invented prior history; filesystem observations have unknown author/time and only observed endpoints. Opening history does not acknowledge changes, mark inbox read, accept work, or complete a task. Acknowledgement requires the actor/target/exact-head observation token and unchanged authorized relation set; concurrent newer edits remain pending. Personal attention includes only formally linked currently readable requirements/documents. Decimal sequence strings are never JavaScript numbers. Writes are not automatically retried.',
      ...(input ? { requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(input, { io: 'input', target: 'draft-2020-12' }) } } } } : {}),
      responses: {
        200: { description: 'Authorized immutable history or monotonic personal state. Cache-Control: private, no-store.', content: { 'application/json': { schema } } },
        ...Object.fromEntries([400,401,403,404,409,503].map(status => [status, { description: 'PM error envelope; invalid/unobserved head, scope change and invalid comparison endpoints are rejected, never silently acknowledged.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }])),
      },
    };
  }
  const detail = endpoint('readChangeHistoryDetail', changeDetailSchema);
  detail.parameters.push({ name: 'changeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } });
  return {
    [`${base}/query`]: { post: endpoint('queryChangeHistory', changeHistoryPageSchema, changeHistoryQuerySchema) },
    [`${base}/compare`]: { post: endpoint('compareChangeHistory', changeComparisonSchema, changeCompareInputSchema) },
    [`${base}/acknowledge`]: { post: endpoint('acknowledgeChangeHistory', changeAcknowledgementSchema, changeAcknowledgeInputSchema) },
    [`${base}/attention`]: { post: endpoint('readTaskAttention', taskAttentionPageSchema, taskAttentionQuerySchema) },
    [`${base}/{changeId}`]: { get: detail },
  };
}
