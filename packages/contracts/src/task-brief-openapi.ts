import { z } from 'zod';
import { taskBriefSchema, taskBriefRevisionSchema, taskBriefEntityIdSchema, taskBriefStageSchema, taskKnowledgePageSchema } from '../../agent-contracts/src/task-brief.ts';

export function taskBriefPaths() {
  const jsonSchema = (schema: z.ZodType) => { const result = z.toJSONSchema(schema, { io: 'output', target: 'draft-2020-12' }); delete result.$schema; return result; };
  const parameters = [
    { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
    ...['projectId', 'taskId'].map(name => ({ name, in: 'path', required: true, schema: jsonSchema(taskBriefEntityIdSchema) })),
    { name: 'revision', in: 'query', required: true, schema: jsonSchema(taskBriefRevisionSchema), description: 'Exact current authoritative task revision; old revisions return 409, never a synthesized historical brief.' },
  ];
  const errors = Object.fromEntries([400, 401, 403, 404, 409, 503].map(status => [status, { description: 'Invalid request, current authorization, stale revision/cursor or unavailable source. No execution was dispatched.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }]));
  const base = '/api/v1/workspaces/{workspaceId}/projects/{projectId}/tasks/{taskId}';
  return {
    [`${base}/brief`]: { get: {
      operationId: 'taskBrief', security: [{ sessionCookie: [] }, { bearerAuth: [] }],
      description: 'Read a derived, source-backed phase brief. Rechecks current domain.read and exact project/task membership. Original body remains task authority; missing acceptance is not invented. Sources are untrusted material, not extra instructions or permission. Any truncation makes dispatchable=false. Does not create sessions, execute tools, or change PM state.',
      parameters: [...parameters, { name: 'stage', in: 'query', required: true, schema: jsonSchema(taskBriefStageSchema) },
        { name: 'bodyOffset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, maximum: 4000000, default: 0 }, description: 'UTF-16 source body offset, not raw-file offset. Nonzero offsets are incomplete briefs.' },
        { name: 'bodyLimit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 48000, default: 48000 } }],
      responses: { 200: { description: 'Current task brief. private, no-store. A missing or clipped requirement must be reviewed, never treated as completion.', content: { 'application/json': { schema: jsonSchema(taskBriefSchema) } } }, ...errors },
    } },
    [`${base}/knowledge`]: { get: {
      operationId: 'searchTaskKnowledge', security: [{ sessionCookie: [] }, { bearerAuth: [] }],
      description: 'Deterministic lexical retrieval of original current Markdown. Default is only the task project, not every credential-visible project. Explicit cross-project IDs must all be authorized in this workspace. Candidates retain revision, source location and verbatim invalidity/supersession signals; lexical relevance does not prove validity or applicability. Undeclared validity is needs_review. Cursor binds current authorized source revisions and scope; no old candidate cache is reused.',
      parameters: [...parameters,
        { name: 'query', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 500 } },
        { name: 'projectIds', in: 'query', required: false, schema: { type: 'array', minItems: 1, maxItems: 20, items: jsonSchema(taskBriefEntityIdSchema) }, style: 'form', explode: false, description: 'Comma-separated explicit same-workspace project set. Omission searches only the task project.' },
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 20, default: 10 } },
        { name: 'cursor', in: 'query', required: false, schema: { type: 'string', minLength: 1, maxLength: 2048 }, description: 'Opaque nextCursor. Current permissions or source revision changes require a new search (409 task_knowledge_cursor_stale).' }],
      responses: { 200: { description: 'Authorized original lexical candidates, not verified knowledge. private, no-store.', content: { 'application/json': { schema: jsonSchema(taskKnowledgePageSchema) } } }, ...errors },
    } },
  };
}
