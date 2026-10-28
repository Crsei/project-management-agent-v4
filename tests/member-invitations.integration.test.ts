import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Command, Entity } from '../packages/domain/src/core.ts';
import type { InvitationAcceptDto, InvitationInspectDto, InvitationListDto, InvitationReceiptDto, MemberInvitationDto } from '../packages/domain/src/invitations.ts';
import { memberRoleCapabilities } from '../packages/domain/src/members.ts';
import { deliverInvitationMailBatch } from '../packages/application/src/invitation-delivery.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { readInvitationMailConfig } from '../packages/infrastructure/src/invitation-mail.ts';
import { createInvitationFixture, invitationDatabaseUrl } from './member-invitations-fixture.ts';
import type { InvitationFixture } from './member-invitations-fixture.ts';
import { createMailFixtureDatabase } from './mail-fixture-database.ts';
import type { MailFixtureDatabase } from './mail-fixture-database.ts';
import { mailFixtureCaseTimeout, mailFixtureCleanupTimeout, mailFixtureInitTimeout, mailSchemaInitTimeout } from './mail-fixture-lifecycle.ts';

function mutation(commandType: string, invitation: MemberInvitationDto): Command {
  return { commandId: randomUUID(), commandType, targetId: invitation.id, expectedVersions: { [invitation.id]: invitation.version }, payload: {} };
}

describe('invitation SMTP configuration', () => {
  it('is disabled by default and rejects partial configuration without echoing secrets', () => {
    assert.equal(readInvitationMailConfig({}), undefined);
    assert.equal(readInvitationMailConfig({ SMTP_PASSWORD: 'private-smtp-password' }), undefined);
    assert.throws(() => readInvitationMailConfig({ INVITATION_TOKEN_KEY: 'private-feature-key', SMTP_PASSWORD: 'private-smtp-password' }), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes('private-smtp-password'), false);
      return true;
    });
    assert.throws(() => readInvitationMailConfig({ SMTP_HOST: 'localhost', SMTP_FROM: 'mail@example.test',
      INVITATION_WEB_ORIGIN: 'https://example.test', INVITATION_TOKEN_KEY: 'short' }));
  });
});

describe('member invitations: real PostgreSQL, HTTP and SMTP boundaries', { skip: !invitationDatabaseUrl, concurrency: false }, () => {
  let database: MailFixtureDatabase;
  let f: InvitationFixture;
  before(async t => { database = await createMailFixtureDatabase({ signal: t.signal }); }, { timeout: mailSchemaInitTimeout });
  after(() => database?.close(), { timeout: mailFixtureCleanupTimeout });
  beforeEach(async t => { f = await createInvitationFixture({ database, signal: t.signal }); }, { timeout: mailFixtureInitTimeout });
  afterEach(async () => { await f?.close(); }, { timeout: mailFixtureCleanupTimeout });
  async function mail(invitation: MemberInvitationDto): Promise<string> {
    const delivered = await deliverInvitationMailBatch(f.pool, f.smtp.config);
    assert.equal(delivered.smtpAccepted, 1);
    return f.token(invitation.email);
  }
  async function committed(command: Command): Promise<MemberInvitationDto> {
    const response = await f.send(command);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.result as MemberInvitationDto;
  }

  it('disables writes without SMTP configuration rather than making a fake pending queue', { timeout: mailFixtureCaseTimeout }, async t => {
    await f.close();
    f = await createInvitationFixture({ database, signal: t.signal, disabled: true });
    const result = await f.send({ commandId: randomUUID(), commandType: 'CreateMemberInvitation', payload: { email: 'disabled@example.test', role: 'member', projectIds: null } });
    assert.equal(result.status, 409);
    assert.equal(result.body.error?.code, 'invitation_mail_disabled');
    const list = await f.request<InvitationListDto>(`/api/v1/workspaces/${f.workspaceId}/members/invitations`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body, { enabled: false, items: [] });
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM invitation_mail_queue')).rows[0].count, 0);
  });

  it('sends an actual fragment link and atomically creates an invited account exactly once', { timeout: mailFixtureCaseTimeout }, async () => {
    const invitation = await f.invite(undefined, { role: 'guest' });
    const encrypted = (await f.pool.query('SELECT token_ciphertext FROM invitation_mail_queue WHERE invitation_id=$1', [invitation.id])).rows[0].token_ciphertext;
    const token = await mail(invitation);
    assert.equal(encrypted.includes(token), false, 'Persistent mail payload must not contain a raw bearer token');
    assert.equal(JSON.stringify(invitation).includes(token), false);
    assert.equal((await f.pool.query('SELECT token_ciphertext FROM invitation_mail_queue WHERE invitation_id=$1', [invitation.id])).rows[0].token_ciphertext, null);
    const listed = await f.request<InvitationListDto>(`/api/v1/workspaces/${f.workspaceId}/members/invitations`);
    assert.equal(listed.body.items[0]?.delivery?.status, 'smtp_accepted');
    const inspected = await f.request<InvitationInspectDto>('/api/v1/invitations/inspect', { token }, '');
    assert.equal(inspected.status, 200);
    assert.equal(inspected.body.accountExists, false);
    assert.equal(inspected.headers.get('cache-control'), 'no-store');
    const payload = { commandId: randomUUID(), token, name: 'Invited guest', password: 'new-invited-account-password' };
    const missing = await f.request<InvitationReceiptDto>('/api/v1/invitations/receipt', { token, commandId: payload.commandId, password: payload.password }, '');
    assert.deepEqual(missing.body, { outcome: null });
    const accepted = await Promise.all([f.request<InvitationAcceptDto>('/api/v1/invitations/accept', payload, ''), f.request<InvitationAcceptDto>('/api/v1/invitations/accept', payload, '')]);
    for (const result of accepted) { assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.headers.get('set-cookie'), null); }
    assert.deepEqual(accepted[0]!.body, accepted[1]!.body);
    const outcome = accepted[0]!.body;
    const membership = (await f.pool.query('SELECT capabilities,project_ids,version FROM memberships WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, outcome.userId])).rows[0];
    assert.deepEqual(membership, { capabilities: memberRoleCapabilities('guest'), project_ids: null, version: 1 });
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM users WHERE email=$1', [invitation.email])).rows[0].count, 1);
    const recovered = await f.request<InvitationReceiptDto>('/api/v1/invitations/receipt', { token, commandId: payload.commandId, password: payload.password }, '');
    assert.deepEqual(recovered.body, { outcome });
    assert.equal((await f.request('/api/v1/invitations/receipt', { token, commandId: payload.commandId, password: 'wrong' }, '')).status, 401);
    const events = await f.pool.query<{ payload: unknown }>('SELECT payload FROM outbox WHERE command_id=$1', [payload.commandId]);
    assert.equal(events.rows.length, 2);
    const privateStores = await f.pool.query<{ data: string }>(`SELECT receipt::text AS data FROM command_receipts UNION ALL
      SELECT result::text FROM invitation_acceptance_receipts UNION ALL SELECT payload::text FROM outbox`);
    for (const row of privateStores.rows) for (const secret of [token, payload.password]) assert.equal(row.data.includes(secret), false);
    for (const row of events.rows) assert.equal(JSON.stringify(row.payload).includes(invitation.email), false);
    assert.equal((await f.request('/api/v1/auth/login', { email: invitation.email, password: payload.password }, '')).status, 200);
    await committed({ commandId: randomUUID(), commandType: 'RevokeWorkspaceMember', payload: { userId: outcome.userId }, expectedVersions: { [outcome.userId]: 1 } });
    await f.pool.query("UPDATE member_invitations SET expires_at=now()-interval '1 second' WHERE id=$1", [invitation.id]);
    const expiredReceipt = await f.request<InvitationReceiptDto>('/api/v1/invitations/receipt', { token, commandId: payload.commandId, password: payload.password }, '');
    assert.deepEqual(expiredReceipt.body, { outcome }, 'Committed outcomes remain recoverable after the original link deadline');
    assert.equal((await f.request('/api/v1/invitations/inspect', { token }, '')).status, 409);
    assert.deepEqual((await f.request<InvitationAcceptDto>('/api/v1/invitations/accept', payload, '')).body, outcome);
    const revoked = (await f.pool.query('SELECT revoked_at,version FROM memberships WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, outcome.userId])).rows[0];
    assert.ok(revoked.revoked_at);
    assert.equal(revoked.version, 2, 'Acceptance replay must never reactivate a revoked grant');
  });

  it('requires the existing account password and never resets or renames that account', { timeout: mailFixtureCaseTimeout }, async () => {
    const password = 'original-existing-account-password';
    const user = await createUser(f.pool, { email: `${randomUUID()}@example.test`, password, name: 'Existing identity' });
    const before = (await f.pool.query('SELECT password_hash,name FROM users WHERE id=$1', [user.id])).rows[0];
    const invitation = await f.invite(user.email, { role: 'admin' });
    const token = await mail(invitation);
    assert.equal((await f.request<InvitationInspectDto>('/api/v1/invitations/inspect', { token }, '')).body.accountExists, true);
    const commandId = randomUUID();
    assert.equal((await f.request('/api/v1/invitations/accept', { commandId, token, password: 'new-attacker-password', name: 'Renamed identity' }, '')).status, 401);
    const accepted = await f.request<InvitationAcceptDto>('/api/v1/invitations/accept', { commandId, token, password, name: 'Renamed identity' }, '');
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.userId, user.id);
    assert.deepEqual((await f.pool.query('SELECT password_hash,name FROM users WHERE id=$1', [user.id])).rows[0], before);
    assert.deepEqual((await f.pool.query('SELECT capabilities,project_ids FROM memberships WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, user.id])).rows[0], { capabilities: memberRoleCapabilities('admin'), project_ids: null });
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM sessions WHERE user_id=$1', [user.id])).rows[0].count, 0);
    assert.equal((await f.request('/api/v1/auth/login', { email: user.email, password: 'new-attacker-password' }, '')).status, 401);
    assert.equal((await f.request('/api/v1/auth/login', { email: user.email, password }, '')).status, 200);
  });

  it('serializes command idempotency, unique active emails and invitation CAS', { timeout: mailFixtureCaseTimeout }, async () => {
    const create: Command = { commandId: randomUUID(), commandType: 'CreateMemberInvitation', payload: { email: 'unique@example.test', role: 'member', projectIds: null } };
    const replies = await Promise.all([f.send(create), f.send(create)]);
    assert.equal(replies[0]!.status, 200);
    assert.deepEqual(replies[0]!.body, replies[1]!.body);
    const invitation = replies[0]!.body.result as MemberInvitationDto;
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM invitation_mail_queue')).rows[0].count, 1);
    assert.equal((await f.send({ ...create, payload: { ...create.payload, role: 'guest' } })).status, 409);
    assert.equal((await f.send({ ...create, commandId: randomUUID() })).body.error?.code, 'invitation_already_pending');
    const raced = await Promise.all([f.send(mutation('RevokeMemberInvitation', invitation)), f.send(mutation('ResendMemberInvitation', invitation))]);
    assert.equal(raced.filter(reply => reply.status === 200).length, 1);
    assert.equal(raced.filter(reply => reply.body.error?.code === 'version_conflict').length, 1);
  });

  it('marks ambiguous network outcomes unknown and rotates tokens only on explicit resend', { timeout: mailFixtureCaseTimeout }, async () => {
    const invitation = await f.invite();
    f.smtp.mode = 'drop_after_data';
    const ambiguous = await deliverInvitationMailBatch(f.pool, f.smtp.config);
    assert.equal(ambiguous.unknown, 1);
    const oldToken = f.token(invitation.email);
    assert.equal((await deliverInvitationMailBatch(f.pool, f.smtp.config)).attempted, 0);
    assert.equal(f.smtp.messages.length, 1, 'Unknown network effects must not be automatically retried');
    const list = await f.request<InvitationListDto>(`/api/v1/workspaces/${f.workspaceId}/members/invitations`);
    assert.equal(list.body.items[0]!.delivery?.status, 'unknown');
    const rotated = await committed(mutation('ResendMemberInvitation', list.body.items[0]!));
    f.smtp.mode = 'accept';
    const token = await mail(rotated);
    assert.notEqual(token, oldToken);
    assert.equal((await f.request('/api/v1/invitations/inspect', { token: oldToken }, '')).status, 404);
    assert.equal((await f.request('/api/v1/invitations/inspect', { token }, '')).status, 200);
    const revoked = await committed(mutation('RevokeMemberInvitation', rotated));
    assert.equal(revoked.status, 'revoked');
    assert.equal((await f.request('/api/v1/invitations/accept', { commandId: randomUUID(), token, password: 'valid-new-user-password', name: 'Revoked recipient' }, '')).status, 404);
    assert.equal((await f.send(mutation('ResendMemberInvitation', revoked))).status, 409);
  });

  it('bounds an SMTP server that accepts DATA but never acknowledges the external effect', { timeout: 15_000 }, async () => {
    await f.invite();
    f.smtp.mode = 'hang_after_data';
    // This deliberately exercises a real socket deadline; fake local clocks cannot drive the SMTP peer.
    const outcome = await deliverInvitationMailBatch(f.pool, f.smtp.config);
    assert.equal(outcome.unknown, 1);
    assert.equal(f.smtp.messages.length, 1);
    assert.equal((await deliverInvitationMailBatch(f.pool, f.smtp.config)).attempted, 0);
  });

  it('distinguishes explicit SMTP rejection and expired sending leases without leaking SMTP diagnostics', { timeout: mailFixtureCaseTimeout }, async () => {
    const rejected = await f.invite();
    f.smtp.mode = 'reject';
    assert.equal((await deliverInvitationMailBatch(f.pool, f.smtp.config)).failed, 1);
    let list = await f.request<InvitationListDto>(`/api/v1/workspaces/${f.workspaceId}/members/invitations`);
    assert.equal(list.body.items[0]!.delivery?.failureCode, 'smtp_rejected');
    assert.equal(JSON.stringify(list.body).includes('private-smtp-diagnostics'), false);
    const resent = await committed(mutation('ResendMemberInvitation', list.body.items[0]!));
    assert.equal(resent.delivery?.status, 'queued');
    await f.pool.query(`UPDATE invitation_mail_queue SET status='sending',lease_id=$2,lease_expires_at=now()-interval '1 second',token_ciphertext=NULL
      WHERE invitation_id=$1 AND generation=2`, [rejected.id, randomUUID()]);
    const recovered = await deliverInvitationMailBatch(f.pool, f.smtp.config);
    assert.equal(recovered.expiredLeases, 1);
    assert.equal(recovered.attempted, 0);
    list = await f.request<InvitationListDto>(`/api/v1/workspaces/${f.workspaceId}/members/invitations`);
    assert.equal(list.body.items[0]!.delivery?.status, 'unknown');
    assert.equal(list.body.items[0]!.delivery?.failureCode, 'send_lease_expired');
    assert.equal(f.smtp.messages.length, 0);
  });

  it('rejects expired tokens, disabled accounts and stale inviter authorization', { timeout: mailFixtureCaseTimeout }, async () => {
    const expired = await f.invite();
    const expiredToken = await mail(expired);
    await f.pool.query("UPDATE member_invitations SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
    assert.equal((await f.request('/api/v1/invitations/inspect', { token: expiredToken }, '')).status, 410);
    assert.equal((await f.request('/api/v1/invitations/accept', { commandId: randomUUID(), token: expiredToken, name: 'Expired', password: 'valid-expired-password' }, '')).status, 410);
    const disabledUser = await createUser(f.pool, { email: `${randomUUID()}@example.test`, name: 'Disabled recipient', password: 'disabled-account-password' });
    const disabled = await f.invite(disabledUser.email);
    const disabledToken = await mail(disabled);
    await f.pool.query('UPDATE users SET disabled_at=now() WHERE id=$1', [disabledUser.id]);
    assert.equal((await f.request('/api/v1/invitations/accept', { commandId: randomUUID(), token: disabledToken, password: 'disabled-account-password' }, '')).status, 403);
    const stale = await f.invite();
    const staleToken = await mail(stale);
    await f.pool.query("UPDATE memberships SET capabilities=ARRAY['domain.read']::text[],version=version+1 WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.owner.id]);
    assert.equal((await f.request('/api/v1/invitations/inspect', { token: staleToken }, '')).status, 403);
    assert.equal((await f.request('/api/v1/invitations/accept', { commandId: randomUUID(), token: staleToken, name: 'No authority', password: 'valid-no-authority-password' }, '')).status, 403);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM users WHERE email=$1', [stale.email])).rows[0].count, 0);
  });

  it('enforces workspace management boundaries, legal projects and duplicate-member protection', { timeout: mailFixtureCaseTimeout }, async () => {
    const ordinary = await createUser(f.pool, { email: `${randomUUID()}@example.test`, name: 'Ordinary member', password: 'ordinary-account-password' });
    await f.pool.query("INSERT INTO memberships(workspace_id,user_id,capabilities,project_ids) VALUES($1,$2,ARRAY['domain.read'],NULL)", [f.workspaceId, ordinary.id]);
    const signIn = await f.request('/api/v1/auth/login', { email: ordinary.email, password: 'ordinary-account-password' }, '');
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;
    assert.equal((await f.request(`/api/v1/workspaces/${f.workspaceId}/members/invitations`, undefined, cookie)).status, 403);
    assert.equal((await f.send({ commandId: randomUUID(), commandType: 'CreateMemberInvitation', payload: { email: 'forbidden@example.test', role: 'guest', projectIds: null } }, cookie)).status, 403);
    assert.equal((await f.send({ commandId: randomUUID(), commandType: 'CreateMemberInvitation', payload: { email: 'scope@example.test', role: 'admin', projectIds: ['PROJ-9999'] } })).status, 400);
    assert.ok([400, 404].includes((await f.send({ commandId: randomUUID(), commandType: 'CreateMemberInvitation', payload: { email: 'missing-project@example.test', role: 'member', projectIds: ['PROJ-9999'] } })).status));
    const invitation = await f.invite();
    const token = await mail(invitation);
    const other = await createWorkspace(f.pool, f.owner.id, 'Foreign invitation workspace');
    assert.equal((await f.send(mutation('RevokeMemberInvitation', invitation), undefined, other.id)).status, 404);
    const user = await createUser(f.pool, { email: invitation.email, name: 'Added after invitation', password: 'already-added-account-password' });
    await f.pool.query("INSERT INTO memberships(workspace_id,user_id,capabilities,project_ids) VALUES($1,$2,ARRAY['domain.read'],NULL)", [f.workspaceId, user.id]);
    assert.equal((await f.request('/api/v1/invitations/accept', { commandId: randomUUID(), token, password: 'already-added-account-password' }, '')).status, 409);
    assert.deepEqual((await f.pool.query('SELECT capabilities,version FROM memberships WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, user.id])).rows[0], { capabilities: ['domain.read'], version: 1 });
  });

  it('revalidates authoritative projects at acceptance and allows access-only administrators to invite', { timeout: mailFixtureCaseTimeout }, async () => {
    const projectReply = await f.send({ commandId: randomUUID(), commandType: 'CreateProject', payload: { name: 'Invite project', goal: 'Bounded membership', ownerId: f.owner.id, completionCriteria: ['Reviewed'] } });
    assert.equal(projectReply.status, 200, JSON.stringify(projectReply.body));
    const project = projectReply.body.result as Entity;
    await f.pool.query("UPDATE memberships SET capabilities=ARRAY['access.manage']::text[] WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.owner.id]);
    const invitation = await f.invite(undefined, { projectIds: [project.id] });
    const token = await mail(invitation);
    await f.pool.query("UPDATE memberships SET capabilities=ARRAY['domain.read','access.manage','planning.lifecycle']::text[] WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.owner.id]);
    const source = await f.request<{ revision: string }>(`/api/v1/workspaces/${f.workspaceId}/core/files/${project.id}`);
    assert.equal(source.status, 200, JSON.stringify(source.body));
    const result = await f.request(`/api/v1/workspaces/${f.workspaceId}/core/entities/${project.id}/archive`, { revision: source.body.revision });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.ok([400, 404, 409].includes((await f.request('/api/v1/invitations/accept', { commandId: randomUUID(), token, password: 'archived-project-password', name: 'Archived scope' }, '')).status));
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM users WHERE email=$1', [invitation.email])).rows[0].count, 0);
  });

  it('serializes invited account creation across workspaces without duplicate users or lost grants', { timeout: mailFixtureCaseTimeout }, async () => {
    const email = `${randomUUID()}@example.test`;
    const first = await f.invite(email, { role: 'guest' });
    const firstToken = await mail(first);
    const secondWorkspace = await createWorkspace(f.pool, f.owner.id, 'Concurrent invited workspace');
    const secondReply = await f.send({ commandId: randomUUID(), commandType: 'CreateMemberInvitation', payload: { email, role: 'member', projectIds: null } }, undefined, secondWorkspace.id);
    assert.equal(secondReply.status, 200, JSON.stringify(secondReply.body));
    const second = secondReply.body.result as MemberInvitationDto;
    const secondToken = await mail(second);
    const credentials = { password: 'shared-new-account-password', name: 'One invited identity' };
    const replies = await Promise.all([f.request<InvitationAcceptDto>('/api/v1/invitations/accept', { commandId: randomUUID(), token: firstToken, ...credentials }, ''),
      f.request<InvitationAcceptDto>('/api/v1/invitations/accept', { commandId: randomUUID(), token: secondToken, ...credentials }, '')]);
    for (const reply of replies) assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(replies[0]!.body.userId, replies[1]!.body.userId);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM users WHERE email=$1', [email])).rows[0].count, 1);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM memberships WHERE user_id=$1', [replies[0]!.body.userId])).rows[0].count, 2);
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM invitation_acceptance_receipts')).rows[0].count, 2);
  });
});
