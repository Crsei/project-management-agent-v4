import { z } from 'zod';
import { roadmapActionSchema, roadmapStoreSchema } from './product-roadmap.ts';
import { designBundleSchema } from './product-design.ts';
export function productRoadmapPaths() {
  const content = (schema: unknown) => ({ 'application/json': { schema } });
  const parameters = [{ name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }, { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } }];
  const response = { type: 'object', required: ['projectId', 'title', 'revision', 'archived', 'store', 'tasks'], properties: { projectId: { type: 'string' }, title: { type: 'string' }, revision: { type: 'string' }, archived: { type: 'boolean' }, store: z.toJSONSchema(roadmapStoreSchema), tasks: { type: 'object', additionalProperties: { type: 'array', items: { type: 'object', properties: { nodeId: { type: 'string' }, taskId: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' }, revision: { type: 'string' }, archived: { type: 'boolean' }, drifted: { type: 'boolean' } } } } } } };
  const common = { parameters, security: [{ sessionCookie: [] }, { bearerAuth: [] }], responses: { 200: { description: 'Current authoritative project plan and real task mappings. No execution or integration is implied.', content: content(response) }, ...Object.fromEntries([400, 401, 403, 404, 409, 503].map(status => [status, { description: 'Authorization, validation, conflict or unknown outcome' }])) } };
  return { '/api/v1/workspaces/{workspaceId}/projects/{projectId}/product-roadmap': {
    get: { ...common, operationId: 'readProductRoadmap' },
    post: { ...common, operationId: 'changeProductRoadmap', description: 'Save with project CAS; publish immutable reviewed plan; materialize one node through native audited creation. Does not execute, merge or complete tasks. Reconcile with a read before another attempt.', requestBody: { required: true, content: content(z.toJSONSchema(roadmapActionSchema)) } },
  }, '/api/v1/workspaces/{workspaceId}/projects/{projectId}/product-roadmap/design/{versionId}': {
    get: { ...common, operationId:'readProductDesign', parameters:[...parameters,{name:'versionId',in:'path',required:true,schema:{type:'string',format:'uuid'}}],
      description:'Read an authorized immutable design artifact belonging to this project. Bounded in-memory ZIP inspection, never execution. Private/no-store; unsupported contents are listed, not run.',
      responses:{...common.responses,200:{description:'Verified design asset index and bounded base64 content.',content:content(z.toJSONSchema(designBundleSchema))},422:{description:'Unsafe, corrupt or oversized design archive.'}} },
  } };
}
