import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerRequestSchema, registerResponseSchema } from '../src/registration.ts';

const input = { email: '  Person@Example.test  ', name: '  Person  ', password: 'valid-registration-password' };
test('registration canonicalizes identity and rejects privilege or invalid credential fields', () => {
  assert.deepEqual(registerRequestSchema.parse(input), { ...input, email: 'person@example.test', name: 'Person' });
  for (const extra of [{ role: 'admin' }, { workspaceId: 'workspace' }, { capabilities: [] }, { token: 'invitation' }]) assert.equal(registerRequestSchema.safeParse({ ...input, ...extra }).success, false);
  for (const invalid of [{ email: 'invalid' }, { email: `${'x'.repeat(250)}@example.test` }, { name: ' ' }, { name: 'x'.repeat(201) }, { password: 'short' }, { password: 'x'.repeat(257) }]) assert.equal(registerRequestSchema.safeParse({ ...input, ...invalid }).success, false);
});
test('registration response rejects secrets and invalid session data', () => {
  const response = { actor: { id: '00000000-0000-4000-8000-000000000001', email: 'person@example.test', name: 'Person' }, expiresAt: '2026-11-04T12:00:00.000Z' };
  assert.equal(registerResponseSchema.safeParse(response).success, true);
  for (const extra of [{ token: 'secret' }, { password: input.password }, { workspaceId: 'workspace' }]) assert.equal(registerResponseSchema.safeParse({ ...response, ...extra }).success, false);
  assert.equal(registerResponseSchema.safeParse({ ...response, expiresAt: 'never' }).success, false);
});
