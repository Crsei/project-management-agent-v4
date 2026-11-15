import { z } from 'zod';

const identity = z.strictObject({ userId: z.uuid(), name: z.string(), avatarDataUrl: z.string().nullable(), jobTitle: z.string().nullable() });
const version = z.strictObject({ id: z.uuid(), version: z.number().int().positive() });
const projectId = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);
const projectPeople = z.strictObject({
  projectId, projectVersion: z.number().int().positive(),
  participation: version.extend({ memberIds: z.array(z.uuid()) }).nullable(),
  participants: z.array(identity),
  teams: z.array(z.strictObject({ id: z.uuid(), name: z.string(), members: z.array(z.strictObject({ id: z.uuid(), name: z.string() })) })),
  canManage: z.boolean(), scope: z.strictObject({ projectIds: z.array(projectId).nullable() }),
});

export function peoplePaths(): Record<string, Record<string, unknown>> {
  const workspace = { name: 'workspaceId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
  const base = '/api/v1/workspaces/{workspaceId}/people';
  type Parameter = { name: string; in: string; required: boolean; schema: Record<string, unknown> };
  function endpoint(operationId: string, output: z.ZodType, parameters: Parameter[], description: string) {
    const schema = z.toJSONSchema(output, { io: 'output', target: 'draft-2020-12' });
    delete schema.$schema;
    return { operationId, security: [{ sessionCookie: [] }, { bearerAuth: [] }], parameters: [workspace, ...parameters], description,
      responses: {
        200: { description: 'Currently authorized people data. Cache-Control: private, no-store.', content: { 'application/json': { schema } } },
        ...Object.fromEntries([400, 401, 403, 404, 409, 503].map(status => [status, { description: 'PM error envelope; current identity, permission and query scope are required.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }])),
      },
    };
  }
  return {
    [`${base}/candidates`]: { get: endpoint('listPeopleCandidates', z.strictObject({ items: z.array(identity), nextCursor: z.string().nullable() }), [
      { name: 'purpose', in: 'query', required: true, schema: { type: 'string', enum: ['assignee', 'participant', 'team', 'project_owner'] } },
      { name: 'projectId', in: 'query', required: false, schema: { type: 'string', pattern: '^[A-Z][A-Z0-9]*-\\d+$' } },
      { name: 'q', in: 'query', required: false, schema: { type: 'string', maxLength: 200 } },
      { name: 'after', in: 'query', required: false, schema: { type: 'string', maxLength: 2048 } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
    ], 'Bounded UUID-keyset pagination; nextCursor null means exhaustion, not a guessed total. Search matches names only. Assignee/participant require a currently readable project and include active members with actual project read grants, regardless of participation/team labels. Team requires unrestricted access.manage. project_owner requires unrestricted planning.edit and domain.read and lists only workspace-wide readable members. Cursors bind actor/workspace/purpose/project/search and every page rechecks current access. No email, capabilities or hidden-project IDs are returned.') },
    [`${base}/projects/{projectId}`]: { get: endpoint('readProjectPeople', projectPeople, [
      { name: 'projectId', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Z][A-Z0-9]*-\\d+$' } },
    ], 'Explicit PG participation is separate from actual access, derived core owner/assignee identities, and associated human teams. No inferred/backfilled participants. Ordinary readers receive only currently eligible participant identities/IDs; unrestricted managers may see saved stale IDs to remove them. SetProjectParticipants uses the ordinary command envelope with target/project IDs and exact project plus existing participation versions. Removing participation never revokes access or changes tasks. Team restoration uses RestoreProjectTeam with exact team version; it prunes inactive roster entries, preserves team metadata and associated project references, and never restores grants.') },
    [`${base}/account`]: { get: endpoint('lookupPeopleAccount', z.strictObject({ account: identity.nullable() }), [
      { name: 'email', in: 'query', required: true, schema: { type: 'string', format: 'email', maxLength: 320 } },
    ], 'Unrestricted workspace access.manage only. Exact normalized email match to one enabled existing account or null; never a global account listing or prefix search. No invitation, grant or account mutation occurs.') },
  };
}
