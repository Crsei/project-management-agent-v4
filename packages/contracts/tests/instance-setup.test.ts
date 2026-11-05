import assert from 'node:assert/strict';
import { test } from 'node:test';
import { instanceSetupStatusSchema, setupRequestSchema, setupResponseSchema } from '../src/instance-setup.ts';

const request = { setupToken: 'A'.repeat(43), email: 'owner@example.test', password: 'isolated-setup-password', name: 'Owner', workspaceName: 'Workspace' };

test('setup rejects privilege injection and credentials outside the declared boundary', () => {
  for (const extra of [{ capabilities: ['access.manage'] }, { userId: 'another-user' }, { workspaceId: 'another-workspace' }, { initialized: true }]) {
    assert.equal(setupRequestSchema.safeParse({ ...request, ...extra }).success, false);
  }
  for (const invalid of [
    { password: 'short' },
    { password: 'x'.repeat(257) },
    { setupToken: 'not-a-token' },
    { email: 'not-an-email' },
    { name: '   ' },
    { workspaceName: '   ' },
  ]) assert.equal(setupRequestSchema.safeParse({ ...request, ...invalid }).success, false);
  const parsed = setupRequestSchema.parse({ ...request, name: ' Owner ', workspaceName: ' Workspace ' });
  assert.equal(parsed.name, 'Owner');
  assert.equal(parsed.workspaceName, 'Workspace');
  assert.equal(parsed.password, request.password);
});

test('public setup state cannot carry private deployment data or enable public registration', () => {
  const state = { initialized: false, setupAllowed: true, registrationMode: 'invite_only' };
  for (const extra of [{ setupToken: request.setupToken }, { tokenHash: 'private-digest' }, { email: request.email }, { databaseUrl: 'private-connection' }]) {
    assert.equal(instanceSetupStatusSchema.safeParse({ ...state, ...extra }).success, false);
  }
  assert.equal(instanceSetupStatusSchema.safeParse({ ...state, registrationMode: 'public' }).success, false);
  assert.equal(instanceSetupStatusSchema.safeParse({ ...state, initialized: 'false' }).success, false);
});

test('setup success refuses secret-bearing or unusable account and workspace responses', () => {
  const response = {
    actor: { id: '00000000-0000-4000-8000-000000000001', email: request.email, name: request.name },
    workspaceId: '00000000-0000-4000-8000-000000000002', expiresAt: '2026-11-04T12:00:00.000Z',
  };
  for (const extra of [{ password: request.password }, { setupToken: request.setupToken }, { token: 'session-token' }]) {
    assert.equal(setupResponseSchema.safeParse({ ...response, ...extra }).success, false);
  }
  assert.equal(setupResponseSchema.safeParse({ ...response, actor: { ...response.actor, password_hash: 'private-hash' } }).success, false);
  assert.equal(setupResponseSchema.safeParse({ ...response, workspaceId: 'default' }).success, false);
  assert.equal(setupResponseSchema.safeParse({ ...response, expiresAt: 'never' }).success, false);
});
