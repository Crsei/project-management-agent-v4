import { z } from 'zod';
import { studioActionKindSchema, studioCancelSchema, studioCapabilitiesSchema, studioConfigSchema, studioCreateSchema, studioDefinitionSchema, studioDispatchSchema, studioExecutionEventSchema, studioExecutionSchema, studioPageSchema, studioRevisionSchema, studioStatusSchema, studioUpdateSchema, studioValidationSchema } from './automation-studio.ts';

export function automationStudioPaths(): Record<string, Record<string, unknown>> {
  const json = (schema: unknown) => ({ 'application/json': { schema } });
  const workspace = { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
  const id = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
  const cursor = { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } };
  const endpoint = (operationId: string, output: z.ZodType, parameters: unknown[] = [], input?: z.ZodType) => ({
    operationId, security: [{ sessionCookie: [] }, { bearerAuth: [] }], parameters: [workspace, ...parameters],
    description: 'Creator-private PM execution definition. Every operation rechecks current actor/workspace/project authorization. Writes require planning.edit, requestId and expectedRevision except create/cancel. Create persists a draft only. Validation has no execution/model/tool effects. Explicit test freezes a saved revision and queues a real potentially side-effecting execution. Worker commits intent before network, never redispatches an unknown outcome, rechecks current authority and enforces daily/cooldown budgets. Once uses a full ISO date; cron uses IANA civil time, skips gaps and takes only the first fold. Finished results, event history and receipts are immutable; soft deletion retains authorized history. Legacy report rules and history are unchanged.',
    ...(input ? { requestBody: { required: true, content: json(z.toJSONSchema(input)) } } : {}),
    responses: { 200: { description: 'Success; queued is not completed', content: json(z.toJSONSchema(output)) }, ...Object.fromEntries([400,401,403,404,409,503].map(status => [status, { description: 'Validation, current authorization, revision conflict or unavailable service; uncertain writes reconcile their original receipt' }])) },
  });
  const base = '/api/v1/workspaces/{workspaceId}/automations';
  return {
    [base + '/studio-capabilities']: { get: endpoint('getAutomationStudioCapabilities', studioCapabilitiesSchema, [{ name: 'projectId', in: 'query', required: true, schema: { type: 'string', pattern: '^PRJ-\\d+$' } }, { name: 'actionKind', in: 'query', required: false, description: 'When provided, plugin choices include only independently verified mechanisms suitable for this action. Omit for mixed Dashboard readiness.', schema: z.toJSONSchema(studioActionKindSchema) }]) },
    [base + '/definitions']: { get: endpoint('listAutomationStudioDefinitions', studioPageSchema(studioDefinitionSchema), [cursor]), post: endpoint('createAutomationStudioDefinition', studioDefinitionSchema, [], studioCreateSchema) },
    [base + '/definitions/validate']: { post: endpoint('validateAutomationStudioConfig', studioValidationSchema, [], z.strictObject({ config: studioConfigSchema })) },
    [base + '/definitions/{id}']: { get: endpoint('getAutomationStudioDefinition', studioDefinitionSchema, [id]), put: endpoint('updateAutomationStudioDefinition', studioDefinitionSchema, [id], studioUpdateSchema), delete: endpoint('deleteAutomationStudioDefinition', z.strictObject({ deleted: z.literal(true) }), [id], studioRevisionSchema) },
    [base + '/definitions/{id}/status']: { post: endpoint('setAutomationStudioDefinitionStatus', studioDefinitionSchema, [id], studioStatusSchema) },
    [base + '/definitions/{id}/run']: { post: endpoint('runAutomationStudioDefinition', studioExecutionSchema, [id], studioDispatchSchema) },
    [base + '/definitions/{id}/test']: { post: endpoint('testAutomationStudioDefinition', studioExecutionSchema, [id], studioDispatchSchema) },
    [base + '/executions']: { get: endpoint('listAutomationStudioExecutions', studioPageSchema(studioExecutionSchema), [cursor, { name: 'definitionId', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } }]) },
    [base + '/executions/{id}']: { get: endpoint('getAutomationStudioExecution', studioExecutionSchema, [id]) },
    [base + '/executions/{id}/logs']: { get: endpoint('getAutomationStudioExecutionLogs', studioPageSchema(studioExecutionEventSchema), [id,cursor]) },
    [base + '/executions/{id}/query']: { post: endpoint('queryAutomationStudioExecution', studioExecutionSchema, [id], z.strictObject({})) },
    [base + '/executions/{id}/cancel']: { post: endpoint('cancelAutomationStudioExecution', studioExecutionSchema, [id], studioCancelSchema) },
    [base + '/studio-receipts/{requestId}']: { get: endpoint('getAutomationStudioReceipt', z.strictObject({ requestId: z.uuid(), result: z.unknown(), httpStatus: z.number().int() }), [{ name: 'requestId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }]) },
  };
}
