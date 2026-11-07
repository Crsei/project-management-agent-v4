import { z } from 'zod';
import { agentCatalogSchema, agentFileAreaResponseSchema, agentFileAreaUpdateSchema, agentScopeSchema, agentStorageSettingsSchema, agentStorageSettingsUpdateSchema, authorizedAgentContextSchema } from './agent-file-areas.ts';

/** Browser-safe source contract; generation is performed by the normal contract pipeline. */
export function agentFileAreaPaths(): Record<string, Record<string, unknown>> {
  const workspace = { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
  const project = { name: 'projectId', in: 'path', required: true, schema: { type: 'string', pattern: '^PRJ-\\d+$' } };
  function endpoint(operationId: string, output: z.ZodType, parameters: unknown[], input?: z.ZodType) {
    const schema = z.toJSONSchema(output, { io: 'output', target: 'draft-2020-12' }); delete schema.$schema;
    const failures = Object.fromEntries([400, 401, 403, 404, 409, 503].map(status => [status, {
      description: 'Authenticated PM error. Revision conflicts return agent_file_area_revision_conflict and details.currentRevision. Preserve unsaved input; re-read before any retry.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
    }]));
    return { operationId, security: [{ sessionCookie: [] }, { bearerAuth: [] }], parameters,
      description: 'PM business authorization and document/storage metadata only; these routes never resolve an Agent execution directory or allocate chat scratch. Real membership/domain.read filters contexts, including empty projects. Host path visibility requires unrestricted access.manage; configuration additionally requires planning.edit. Saves use trusted LocalDirectory rules and revision CAS and never move PM data. Agent folders are selected independently through the authenticated Agent directory service. An uncertain save must be re-read before retrying.',
      ...(input ? { requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(input, { io: 'input', target: 'draft-2020-12' }) } } } } : {}),
      responses: { 200: { description: 'Current authorized context or saved directory mapping. Private, no-store.', content: { 'application/json': { schema } } }, ...failures },
    };
  }
  return {
    '/api/v1/agent-contexts': { get: endpoint('getAgentContexts', agentCatalogSchema, []) },
    '/api/v1/workspaces/{workspaceId}/agent-storage-settings': {
      get: endpoint('getAgentStorageSettings', agentStorageSettingsSchema, [workspace]),
      put: endpoint('saveAgentStorageSettings', agentStorageSettingsSchema, [workspace], agentStorageSettingsUpdateSchema),
    },
    '/api/v1/workspaces/{workspaceId}/agent-file-area': { put: endpoint('saveWorkspaceAgentFileArea', agentFileAreaResponseSchema, [workspace], agentFileAreaUpdateSchema) },
    '/api/v1/workspaces/{workspaceId}/projects/{projectId}/agent-file-area': { put: endpoint('saveProjectAgentFileArea', agentFileAreaResponseSchema, [workspace, project], agentFileAreaUpdateSchema) },
    '/api/v1/agent-contexts/authorize': { post: endpoint('authorizeAgentContext', authorizedAgentContextSchema, [], agentScopeSchema) },
  };
}
