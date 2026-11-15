const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const text = { type: 'string' };
const uuid = { type: 'string', format: 'uuid' };
const version = { type: 'integer', minimum: 1 };
const nullableText = { type: ['string', 'null'] };
const bool = { type: 'boolean' };
const array = (items: unknown) => ({ type: 'array', items });
const duty = object({ id: text, kind: { enum: ['work_item', 'project', 'milestone', 'team'] }, title: text, projectId: nullableText, version, parentId: nullableText, transferable: bool });
const receipt = { $ref: '#/components/schemas/CommandReceipt' };
const impact = object({ userId: uuid, membershipVersion: version, revokedAt: nullableText, duties: array(duty), scopeComplete: bool, blockers: array(text), canHandover: bool, canRevoke: bool, canLeave: bool,
  evidence: array(object({ source: { enum: ['pm_review', 'automation_execution'] }, id: text, projectId: text, status: text })), executionCoverage: { enum: ['partial', 'unavailable'] } });
const command = { type: 'object', additionalProperties: false, required: ['commandId', 'commandType', 'payload'],
  properties: { commandId: uuid, commandType: text, targetId: text, projectId: text, expectedVersions: { type: 'object', additionalProperties: version }, payload: { type: 'object', additionalProperties: true } } };
const handover = object({ id: uuid, userId: uuid, recipientId: uuid, actorId: uuid, version, status: { enum: ['pending', 'partial', 'unknown', 'completed'] },
  items: array(object({ duty, command, state: { enum: ['pending', 'unknown', 'committed', 'rejected'] }, receipt: { oneOf: [receipt, { type: 'null' }] } })) });

export function memberLifecyclePaths(): Record<string, Record<string, unknown>> {
  const param = (name: string) => ({ name, in: 'path', required: true, schema: uuid });
  const endpoint = (operationId: string, schema: unknown, parameters: unknown[], input?: unknown) => ({ operationId,
    security: [{ sessionCookie: [] }, { bearerAuth: [] }], parameters: [param('workspaceId'), ...parameters],
    description: 'Current authorization is checked on every read/write. Impact is self or workspace-manager only; incomplete sources block normal LeaveWorkspace, never immediate RevokeWorkspaceMember. PrepareMemberHandover is a command; per-item original commands use exact versions and real core/SQL write paths. Unknown is not failure and is never replayed. Continue only executes untouched pending items; reconcile queries original receipts. External executions are not automatically terminated. Self departure receipt is a narrow authenticated original-actor lookup after revocation.',
    ...(input ? { requestBody: { required: true, content: { 'application/json': { schema: input } } } } : {}),
    responses: { 200: { description: 'Authorized result (Cache-Control: no-store)', content: { 'application/json': { schema } } },
      ...Object.fromEntries([400, 401, 403, 404, 409, 503].map(status => [status, { description: 'Validation, authorization, conflict or unknown outcome; preserve original operation identity', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }])) } });
  const base = '/api/v1/workspaces/{workspaceId}/people';
  return {
    [base + '/members/{userId}/impact']: { get: endpoint('getMemberDepartureImpact', impact, [param('userId')]) },
    [base + '/members/{userId}/handovers']: { get: endpoint('listMemberHandovers', object({ items: array(handover) }), [param('userId')]) },
    [base + '/members/{userId}/departure-receipts/{commandId}']: { get: endpoint('getSelfDepartureReceipt', receipt, [param('userId'), param('commandId')]) },
    [base + '/handovers/{operationId}']: { get: endpoint('getMemberHandover', handover, [param('operationId')]) },
    [base + '/handovers/{operationId}/continue']: { post: endpoint('continueMemberHandover', handover, [param('operationId')], object({ expectedVersion: version })) },
    [base + '/handovers/{operationId}/reconcile']: { post: endpoint('reconcileMemberHandover', handover, [param('operationId')], object({})) },
  };
}
