type JsonSchema = Record<string, any>;

const uuid: JsonSchema = { type: 'string', format: 'uuid' };
const workspace = { name: 'workspaceId', in: 'path', required: true, schema: uuid };
const binding = { name: 'bindingId', in: 'path', required: true, schema: uuid };
const security = [{ sessionCookie: [] }, { bearerAuth: [] }];
const errorResponse = { description: 'Rejected request. See error.code.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } };
const errors = (statuses: number[]) => Object.fromEntries(statuses.map(status => [status, errorResponse]));
const response = (description: string, schema: JsonSchema) => ({ description, content: { 'application/json': { schema } } });
const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
const secured = (operationId: string, summary: string, result: JsonSchema, parameters: unknown[] = []) => ({
  operationId, summary, security, parameters, responses: { 200: response('Success', result), ...errors([400, 401, 403, 404, 409, 429, 503]) },
});

export const imGatewayPaths: Record<string, Record<string, any>> = {
  '/api/v1/workspaces/{workspaceId}/im': {
    get: secured('getImSettings', 'Read the current actor’s IM binding and connection state', ref('ImSettings'), [workspace]),
  },
  '/api/v1/workspaces/{workspaceId}/im/link-codes': {
    post: {
      ...secured('createImLinkCode', 'Create a one-time private-chat link code for the current actor', ref('ImLinkCode'), [workspace]),
      requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: false } } } },
      description: 'The plaintext code is returned once and is never stored. It expires after the deployment-configured TTL and is consumed in a private chat.',
    },
  },
  '/api/v1/workspaces/{workspaceId}/im/bindings/{bindingId}': {
    patch: {
      ...secured('setImBindingNotify', 'Enable or disable routed notifications for one of the current actor’s bindings', ref('ImBinding'), [workspace, binding]),
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { notifyEnabled: { type: 'boolean' } }, required: ['notifyEnabled'], additionalProperties: false } } } },
    },
  },
  '/api/v1/workspaces/{workspaceId}/im/bindings/{bindingId}/revoke': {
    post: {
      ...secured('revokeImBinding', 'Revoke one of the current actor’s bindings and suppress its queued messages', { type: 'object', properties: { revoked: { const: true } }, required: ['revoked'], additionalProperties: false }, [workspace, binding]),
      requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', additionalProperties: false } } } },
    },
  },
};
