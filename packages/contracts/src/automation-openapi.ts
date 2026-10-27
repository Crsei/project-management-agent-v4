import { z } from 'zod';
import { automationCapabilitiesSchema, automationCreateSchema, automationPageSchema, automationPreviewSchema, automationRevisionSchema, automationRuleSchema, automationRunSchema, automationStatusSchema, automationTestSchema, automationUpdateSchema } from './automation.ts';

/** These schemas are the same validators used by HTTP; no browser or server dependencies. */
export function automationPaths(): Record<string, Record<string, unknown>> {
  const json = (schema: unknown) => ({ 'application/json': { schema } });
  const workspace = { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
  const id = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
  const cursor = { name: 'cursor', in: 'query', required: false, schema: { type: 'string', format: 'uuid' }, description: 'Opaque stable owner-scoped page boundary. Continue until nextCursor is null, including empty authorization-filtered pages.' };
  const endpoint = (operationId: string, output: z.ZodType, parameters: unknown[] = [], input?: z.ZodType) => ({
    operationId, security: [{ sessionCookie: [] }, { bearerAuth: [] }], parameters: [workspace, ...parameters],
    description: 'Creator-private automation. Current membership, domain.read and authorized project are required. Mutations require planning.edit and expectedRevision (except create). Reports never mutate Markdown tasks, call models, tools or external connectors. Save creates draft only. Daily Worker uses IANA timezone, skips nonexistent wall times, first fold only, no backlog bursts. Budgets use the current configured local calendar date; cooldown applies to dispatched attempts. Original immutable config/evidence are retained when rules change or are deleted. Same requestId/payload replays; mismatch is 409. Recover original receipts after transport uncertainty; never blindly retry with a new key. Business rejection receipts contain {error:{code,message},httpStatus}; validation/auth failures may have no receipt. Preview runs in a read-only SQL transaction and writes neither SQL nor files. Scheduler ready means a recent successful automation-specific Worker cycle, not merely configured or a generic Worker heartbeat.',
    ...(input ? { requestBody: { required: true, content: json(z.toJSONSchema(input)) } } : {}),
    responses: {
      200: { description: 'Success', content: json(z.toJSONSchema(output)) },
      ...Object.fromEntries([400, 401, 403, 404, 409, 503].map(status => [status, { description: 'Validation, current authorization, revision, idempotency or dependency error. Preserve original request identity when outcome is uncertain.', content: json({ $ref: '#/components/schemas/ErrorResponse' }) }])),
    },
  });
  const base = '/api/v1/workspaces/{workspaceId}/automations';
  return {
    [base + '/capabilities']: { get: endpoint('getAutomationCapabilities', automationCapabilitiesSchema) },
    [base + '/rules']: { get: endpoint('listAutomationRules', automationPageSchema(automationRuleSchema), [cursor]), post: endpoint('createAutomationRule', automationRuleSchema, [], automationCreateSchema) },
    [base + '/rules/{id}']: { put: endpoint('updateAutomationRule', automationRuleSchema, [id], automationUpdateSchema), delete: endpoint('deleteAutomationRule', z.strictObject({ deleted: z.literal(true) }), [id], automationRevisionSchema) },
    [base + '/rules/{id}/status']: { post: endpoint('setAutomationRuleStatus', automationRuleSchema, [id], automationStatusSchema) },
    [base + '/rules/{id}/run']: { post: endpoint('runAutomationRule', automationRunSchema, [id], automationRevisionSchema) },
    [base + '/test']: { post: endpoint('testAutomationReport', automationPreviewSchema, [], automationTestSchema) },
    [base + '/runs']: { get: endpoint('listAutomationRuns', automationPageSchema(automationRunSchema), [cursor, { name: 'ruleId', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } }]) },
    [base + '/runs/{id}']: { get: endpoint('getAutomationRun', automationRunSchema, [id]) },
    [base + '/receipts/{requestId}']: { get: endpoint('getAutomationReceipt', z.strictObject({ requestId: z.uuid(), result: z.unknown() }), [{ name: 'requestId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }]) },
  };
}
