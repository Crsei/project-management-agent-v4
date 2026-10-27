import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Membership } from '../packages/application/src/access.ts';
import { readMemberDirectory } from '../packages/application/src/member-directory.ts';
import type { Command, Entity } from '../packages/domain/src/core.ts';
import type { SelfProfile } from '../packages/domain/src/dashboard-personal.ts';
import { MAX_PROFILE_AVATAR_BYTES } from '../packages/domain/src/dashboard-personal.ts';
import { PRESENCE_TTL_MS } from '../packages/domain/src/dashboard-time.ts';
import { MEMBER_ROLE_PRESETS } from '../packages/domain/src/members.ts';
import type { MemberDirectory } from '../packages/domain/src/members.ts';
import { createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createDashboardFixture, dashboardDatabaseUrl } from './dashboard-fixture.ts';
import type { DashboardFixture } from './dashboard-fixture.ts';

const pngAvatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6QWQAAAAASUVORK5CYII=';

function command(commandType: string, payload: Record<string, unknown>, extra: Partial<Command> = {}): Command {
  return { commandId: randomUUID(), commandType, payload, ...extra };
}

describe('member directory: explicit authority, safe personal data and existing access invariants', { skip: !dashboardDatabaseUrl, timeout: 180_000 }, () => {
  let fixture: DashboardFixture;
  before(async () => { fixture = await createDashboardFixture(); });
  after(async () => { await fixture?.close(); });

  async function project(name: string): Promise<Entity> {
    return fixture.command('CreateProject', { name, goal: 'Member directory privacy', ownerId: fixture.owner.id, completionCriteria: ['Verified'] });
  }
  async function grant(userId: string, capabilities: string[], projectIds: string[] | null, previous?: Membership): Promise<Membership> {
    return fixture.command('SetWorkspaceMember', { userId, capabilities, projectIds }, { extra: { targetId: userId, ...(previous ? { expectedVersions: { [userId]: previous.version } } : {}) } });
  }
  async function directory(cookie?: string, workspaceId = fixture.workspaceId): Promise<MemberDirectory> {
    const response = await fixture.request<MemberDirectory>(`/api/v1/workspaces/${workspaceId}/members/directory`, cookie ? { cookie } : {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }

  it('does not migrate existing grants and permits directory-only self access without domain.read', async () => {
    const reader = await fixture.member('Explicit directory permission');
    const previous = await grant(reader.user.id, ['domain.read'], null);
    const denied = await fixture.request(`/api/v1/workspaces/${fixture.workspaceId}/members/directory`, { cookie: reader.cookie });
    assert.equal(denied.status, 403);
    await grant(reader.user.id, ['directory.read'], null, previous);
    const self = await directory(reader.cookie);
    assert.deepEqual(self.members.map(member => member.userId), [reader.user.id]);
    assert.equal(self.members[0]!.email, reader.user.email);
    assert.equal(self.capabilities.canManageMembers, false);
    assert.equal(self.capabilities.canEditSelfProfile, false);
    assert.equal(self.capabilities.twoFactor.supported, false);
    assert.equal(self.members[0]!.twoFactorEnabled, null);
    const manager = await fixture.member('Custom access-only manager');
    await grant(manager.user.id, ['access.manage'], null);
    const all = await directory(manager.cookie);
    assert.equal(all.capabilities.canManageMembers, true);
    assert.ok(all.members.some(member => member.userId === fixture.owner.id));
    const scoped = await project('Access-only manager can grant existing scope');
    const target = await fixture.member('Role grant without domain read');
    const assigned = await fixture.command<Membership>('SetMemberRole', { userId: target.user.id, role: 'guest', projectIds: [scoped.id] }, { cookie: manager.cookie, extra: { targetId: target.user.id } });
    assert.deepEqual(assigned.projectIds, [scoped.id]);
  });

  it('intersects actual common project read access and redacts other users, revoked rows and unrelated teams', async () => {
    const common = await project('Common directory scope');
    const hidden = await project('Unshared directory scope');
    const reader = await fixture.member('Scoped directory reader');
    const peer = await fixture.member('Common member');
    const outsider = await fixture.member('Unshared member');
    const noRead = await fixture.member('No project read');
    const revoked = await fixture.member('Revoked common member');
    const phantom = await fixture.member('Stale project member');
    const readerGrant = await grant(reader.user.id, ['domain.read', 'directory.read'], [common.id]);
    await grant(peer.user.id, ['domain.read', 'directory.read', 'planning.edit'], [common.id, hidden.id]);
    await grant(outsider.user.id, ['domain.read', 'directory.read'], [hidden.id]);
    await grant(noRead.user.id, ['directory.read'], [common.id]);
    const revokedGrant = await grant(revoked.user.id, ['domain.read', 'directory.read'], [common.id]);
    await grant(phantom.user.id, ['domain.read', 'directory.read'], [common.id]);
    // Legacy stale grant arrays must not create a common project that is not real.
    await fixture.pool.query('UPDATE memberships SET project_ids=$3 WHERE workspace_id=$1 AND user_id=$2', [fixture.workspaceId, reader.user.id, [common.id, 'PRJ-999998']]);
    await fixture.pool.query('UPDATE memberships SET project_ids=$3 WHERE workspace_id=$1 AND user_id=$2', [fixture.workspaceId, phantom.user.id, ['PRJ-999998']]);
    await fixture.pool.query('UPDATE users SET phone=$2 WHERE id=$1', [peer.user.id, 'hidden-contact-number']);
    const associated = await fixture.command<{ id: string; version: number }>('CreateProjectTeam', { name: 'Visible real team', memberIds: [reader.user.id, peer.user.id, outsider.user.id] });
    const unrelated = await fixture.command<{ id: string; version: number }>('CreateProjectTeam', { name: 'Unrelated private team', memberIds: [peer.user.id] });
    for (const [scope, team] of [[common, associated], [hidden, unrelated]] as const) {
      await fixture.command('SetProjectTeams', { teamIds: [team.id] }, { extra: { targetId: scope.id, projectId: scope.id, expectedVersions: { [scope.id]: scope.version, [team.id]: team.version } } });
    }
    await fixture.command('RevokeWorkspaceMember', { userId: revoked.user.id }, { extra: { targetId: revoked.user.id, expectedVersions: { [revoked.user.id]: revokedGrant.version } } });
    const result = await directory(reader.cookie);
    const visiblePeer = result.members.find(member => member.userId === peer.user.id)!;
    assert.ok(visiblePeer);
    assert.equal(visiblePeer.email, null);
    assert.equal(visiblePeer.phone, null);
    assert.equal(visiblePeer.access, null);
    assert.equal(visiblePeer.role, 'unknown');
    assert.deepEqual(visiblePeer.teams, [{ id: associated.id, name: 'Visible real team' }]);
    for (const user of [outsider, noRead, revoked, phantom]) assert.equal(result.members.some(member => member.userId === user.user.id), false);
    const serialized = JSON.stringify(result);
    for (const secret of [peer.user.email, 'hidden-contact-number', unrelated.id, 'Unrelated private team', hidden.id]) assert.equal(serialized.includes(secret), false, secret);
    assert.equal(result.members.find(member => member.isSelf)?.access?.version, readerGrant.version);
    const management = await directory();
    assert.ok(management.members.find(member => member.userId === revoked.user.id)?.access?.revokedAt);
    assert.equal(management.members.find(member => member.userId === peer.user.id)?.phone, 'hidden-contact-number');
  });

  it('uses the workspace membership join date and global partial profile CAS, preserving omitted fields and clearing nulls', async () => {
    const user = await fixture.member('Personal directory editor');
    await grant(user.user.id, ['domain.read', 'directory.read'], null);
    const joinedAt = '2025-02-03T04:05:06.000Z';
    await fixture.pool.query("UPDATE users SET created_at='2020-01-01' WHERE id=$1", [user.user.id]);
    await fixture.pool.query('UPDATE memberships SET created_at=$3 WHERE workspace_id=$1 AND user_id=$2', [fixture.workspaceId, user.user.id, joinedAt]);
    let profile = (await directory(user.cookie)).selfProfile;
    assert.equal(profile.joinedAt, joinedAt);
    profile = await fixture.command<SelfProfile>('UpdateSelfProfile', { jobTitle: 'Engineer', phone: '+1 555 0100', avatarDataUrl: pngAvatar }, { cookie: user.cookie, extra: { targetId: user.user.id, expectedVersions: { [user.user.id]: profile.version } } });
    assert.equal(profile.name, user.user.name);
    assert.equal(profile.jobTitle, 'Engineer');
    assert.equal(profile.avatarDataUrl, pngAvatar);
    const base = profile;
    const otherWorkspace = await createWorkspace(fixture.pool, user.user.id, 'Shared global profile version');
    const concurrent = await Promise.all([
      fixture.send(command('UpdateSelfProfile', { name: 'Global rename' }, { targetId: user.user.id, expectedVersions: { [user.user.id]: base.version } }), { cookie: user.cookie }),
      fixture.send(command('UpdateSelfProfile', { timeZone: 'Asia/Shanghai' }, { targetId: user.user.id, expectedVersions: { [user.user.id]: base.version } }), { cookie: user.cookie, workspace: otherWorkspace.id }),
    ]);
    assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
    profile = (await directory(user.cookie)).selfProfile;
    assert.equal(profile.phone, base.phone);
    assert.equal(profile.jobTitle, base.jobTitle);
    assert.equal(profile.avatarDataUrl, base.avatarDataUrl);
    profile = await fixture.command<SelfProfile>('UpdateSelfProfile', { jobTitle: null, phone: null, avatarDataUrl: null }, { cookie: user.cookie, extra: { targetId: user.user.id, expectedVersions: { [user.user.id]: profile.version } } });
    assert.equal(profile.jobTitle, null);
    assert.equal(profile.phone, null);
    assert.equal(profile.avatarDataUrl, null);
    assert.equal((await directory(user.cookie)).selfProfile.version, profile.version);
    const impersonation = await fixture.send(command('UpdateSelfProfile', { phone: 'not permitted' }, { targetId: fixture.owner.id, expectedVersions: { [fixture.owner.id]: 1 } }), { cookie: user.cookie });
    assert.equal(impersonation.body.error?.code, 'invalid_scope');
  });

  it('rejects external, SVG, mismatched, malformed and oversized avatar data without modifying the profile', async () => {
    const user = await fixture.member('Safe avatar editor');
    await grant(user.user.id, ['domain.read', 'directory.read'], null);
    const before = (await directory(user.cookie)).selfProfile;
    const invalid = [
      'https://external.example/avatar.png',
      `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`,
      pngAvatar.replace('image/png', 'image/jpeg'),
      'data:image/png;base64,not-an-image',
      `data:image/png;base64,${Buffer.alloc(MAX_PROFILE_AVATAR_BYTES + 1).toString('base64')}`,
    ];
    for (const avatarDataUrl of invalid) {
      const response = await fixture.send(command('UpdateSelfProfile', { avatarDataUrl }, { targetId: user.user.id, expectedVersions: { [user.user.id]: before.version } }), { cookie: user.cookie });
      assert.equal(response.body.error?.code, 'validation_failed');
    }
    assert.deepEqual((await directory(user.cookie)).selfProfile, before);
  });

  it('role templates share CAS, authorization, real-project validation and last-administrator protection with explicit grants', async () => {
    const workspace = await createWorkspace(fixture.pool, fixture.owner.id, 'Isolated role CAS');
    const user = await fixture.member('Role CAS target');
    const initial = await fixture.command<Membership>('SetMemberRole', { userId: user.user.id, role: 'guest', projectIds: null }, { workspace: workspace.id, extra: { targetId: user.user.id } });
    assert.deepEqual(initial.capabilities, [...MEMBER_ROLE_PRESETS.guest]);
    const writes = await Promise.all(['member', 'admin'].map(role => fixture.send(command('SetMemberRole', { userId: user.user.id, role, projectIds: null }, { targetId: user.user.id, expectedVersions: { [user.user.id]: initial.version } }), { workspace: workspace.id })));
    assert.deepEqual(writes.map(response => response.status).sort(), [200, 409]);
    const winner = writes.find(response => response.status === 200)!.body.result as Membership;
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS count FROM outbox WHERE workspace_id=$1 AND aggregate_id=$2', [workspace.id, user.user.id])).rows[0].count, 2);
    if (winner.capabilities.includes('access.manage')) {
      await fixture.command('SetMemberRole', { userId: user.user.id, role: 'guest', projectIds: null }, { workspace: workspace.id, extra: { targetId: user.user.id, expectedVersions: { [user.user.id]: winner.version } } });
    }
    const ownerVersion = (await directory(undefined, workspace.id)).members.find(member => member.isSelf)!.access!.version;
    const last = await fixture.send(command('SetMemberRole', { userId: fixture.owner.id, role: 'guest', projectIds: null }, { targetId: fixture.owner.id, expectedVersions: { [fixture.owner.id]: ownerVersion } }), { workspace: workspace.id });
    assert.equal(last.body.error?.code, 'last_administrator');
    const forbidden = await fixture.send(command('SetMemberRole', { userId: fixture.owner.id, role: 'admin', projectIds: null }, { targetId: fixture.owner.id, expectedVersions: { [fixture.owner.id]: ownerVersion } }), { cookie: user.cookie, workspace: workspace.id });
    assert.ok([403, 404].includes(forbidden.status));
    const roleScope = await fixture.command<Entity>('CreateProject', { name: 'Role validation project', goal: 'Reject scoped administrators', ownerId: fixture.owner.id, completionCriteria: ['Verified'] }, { workspace: workspace.id });
    const scopedAdmin = await fixture.send(command('SetMemberRole', { userId: user.user.id, role: 'admin', projectIds: [roleScope.id] }), { workspace: workspace.id });
    assert.equal(scopedAdmin.body.error?.code, 'validation_failed');
    const nonexistent = await fixture.send(command('SetMemberRole', { userId: user.user.id, role: 'guest', projectIds: ['PRJ-999999'] }), { workspace: workspace.id });
    assert.equal(nonexistent.status, 400);
    assert.equal(nonexistent.body.error?.code, 'scope_mismatch');
    const custom = await fixture.member('Custom remains custom');
    await fixture.command('SetWorkspaceMember', { userId: custom.user.id, capabilities: ['domain.read', 'delivery.review'], projectIds: null }, { workspace: workspace.id });
    assert.equal((await directory(undefined, workspace.id)).members.find(member => member.userId === custom.user.id)?.role, 'custom');
  });

  it('uses persisted heartbeat preference and the shared TTL boundary rather than treating a saved online preference as online', async () => {
    const user = await fixture.member('TTL presence member');
    await grant(user.user.id, ['domain.read', 'directory.read'], null);
    await fixture.command('SetPresencePreference', { preference: 'away' }, { cookie: user.cookie });
    const heartbeatAt = '2026-01-01T00:00:00.000Z';
    const heartbeatId = randomUUID();
    await fixture.pool.query(`INSERT INTO dashboard_records(id,workspace_id,kind,owner_id,data,created_by)
      VALUES($1,$2,'presence_heartbeat',$3,$4::jsonb,$3)`, [heartbeatId, fixture.workspaceId, user.user.id, JSON.stringify({ heartbeatAt })]);
    // Management reads need no core access. Real SQL rechecks the caller's
    // membership; only the observation clock is fixed at the exact TTL.
    const context = { sql: fixture.pool, actor: fixture.owner, workspaceId: fixture.workspaceId,
      now: new Date(Date.parse(heartbeatAt) + PRESENCE_TTL_MS - 1) };
    const live = await readMemberDirectory(context);
    assert.equal(live.members.find(member => member.userId === user.user.id)?.presence.status, 'away');
    const expired = await readMemberDirectory({ ...context, now: new Date(Date.parse(heartbeatAt) + PRESENCE_TTL_MS) });
    assert.equal(expired.members.find(member => member.userId === user.user.id)?.presence.status, 'offline');
    const future = await readMemberDirectory({ ...context, now: new Date(Date.parse(heartbeatAt) - 1) });
    assert.equal(future.members.find(member => member.userId === user.user.id)?.presence.status, 'offline');
    assert.equal(expired.presenceTtlMs, PRESENCE_TTL_MS);
    assert.equal(expired.members.find(member => member.userId === user.user.id)?.twoFactorEnabled, null);
  });
});
