import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectManagementClient, ApiError } from '../src/client.ts';
import { workspaceCreationRequestSchema, workspaceCreationRecoveryRequestSchema } from '../src/workspace-creation.ts';

const key = '11111111-1111-4111-8111-111111111111';

test('workspace client never retries an unconfirmed sample initialization', async () => {
  let calls = 0;
  const client = new ProjectManagementClient({ baseUrl: 'https://example.invalid', auth: { type: 'none' }, fetch: async () => { calls++; return Response.json({ error: { code: 'workspace_initialization_pending' } }, { status: 503 }); } });
  await assert.rejects(client.createWorkspace({ name: 'Own workspace', expectedActorId: key }, key), error => error instanceof ApiError && error.status === 503);
  assert.equal(calls, 1);
});

test('workspace creation and recovery contracts require the captured actor without a default', () => {
  assert.throws(() => workspaceCreationRequestSchema.parse({ name: 'Own workspace' }));
  assert.throws(() => workspaceCreationRecoveryRequestSchema.parse({}));
  assert.throws(() => workspaceCreationRequestSchema.parse({ name: 'Own workspace', expectedActorId: 'not-an-actor' }));
  assert.deepEqual(workspaceCreationRequestSchema.parse({ name: 'Own workspace', expectedActorId: key }), { name: 'Own workspace', expectedActorId: key });
  assert.deepEqual(workspaceCreationRequestSchema.parse({ name: 'Own workspace', expectedActorId: key, includeSample: false }), { name: 'Own workspace', expectedActorId: key, includeSample: false });
  assert.deepEqual(workspaceCreationRecoveryRequestSchema.parse({ expectedActorId: key }), { expectedActorId: key });
});

test('workspace mutation refusal retains the caller actor and original key without a retry', async () => {
  for (const mode of ['create', 'recover'] as const) {
    const requests: { path: string; body: unknown; key: string | null }[] = [];
    const client = new ProjectManagementClient({ baseUrl: 'https://example.invalid', auth: { type: 'none' }, fetch: async (input, init) => {
      requests.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get('Idempotency-Key') });
      return Response.json({ error: { code: 'session_changed' } }, { status: 409 });
    } });
    const mutation = mode === 'create'
      ? client.createWorkspace({ name: 'Own workspace', expectedActorId: key }, key)
      : client.recoverWorkspaceCreation(key, { expectedActorId: key });
    await assert.rejects(mutation, error => error instanceof ApiError && error.status === 409 && error.code === 'session_changed');
    assert.deepEqual(requests, [{
      path: mode === 'create' ? '/api/v1/workspaces' : `/api/v1/workspace-creations/${key}/recover`,
      body: mode === 'create' ? { name: 'Own workspace', expectedActorId: key } : { expectedActorId: key },
      key: mode === 'create' ? key : null,
    }]);
  }
});
