import test from 'node:test';
import assert from 'node:assert/strict';
import type { Entity, MemberDirectoryAccess, MemberDirectoryMember, Workspace } from '../packages/contracts/src/client.ts';
import { canManageProjectShare, canReadProjectShare, projectShareCandidates, projectShareConflict, projectShareDraft, projectShareInvitationCommand, projectShareMemberCommand, projectShareScope, projectShareUrl } from '../apps/web/src/features/pm/service/project-share-model.ts';

const workspace: Workspace = {
  id: 'f795dd3c-df42-4aa2-aaca-4eb546166d83', name: 'Real workspace', icon: 'building', color: '#3B82C4', identityVersion: 1,
  ownerId: '790ca662-5ad5-4ae8-a8a4-bc4b7f737e91', capabilities: ['domain.read', 'access.manage'], projectIds: null, version: 5, cursor: '1',
};
const project: Entity = {
  id: 'PRJ-1', workspaceId: workspace.id, projectId: null, kind: 'project', version: 7, data: { name: 'Shared project' },
  createdAt: null, updatedAt: null, createdBy: workspace.ownerId,
};
const commandId = '81c03d70-dad9-4697-ad74-76232f76a629';
function member(access: Partial<MemberDirectoryAccess> = {}, userId = 'b7e9238a-555d-405c-a2a3-b3d3625057ac'): MemberDirectoryMember {
  return {
    userId, name: 'Scoped colleague', email: 'colleague@example.invalid', jobTitle: null, phone: null, avatarDataUrl: null,
    joinedAt: '2026-10-20T00:00:00.000Z', isSelf: false, role: 'custom', teams: [], presence: { status: 'offline', lastHeartbeatAt: null }, twoFactorEnabled: null,
    access: { capabilities: ['domain.read', 'directory.read', 'planning.edit', 'delivery.review'], projectIds: ['PRJ-2'], version: 8, revokedAt: null, ...access },
  };
}

test('management requires unrestricted access.manage; read-only viewers retain only their actual project access', () => {
  assert.equal(canManageProjectShare(workspace), true);
  assert.equal(canReadProjectShare(workspace, project), true);
  const reader: Workspace = { ...workspace, capabilities: ['domain.read'], projectIds: ['PRJ-1'] };
  assert.equal(canManageProjectShare(reader), false);
  assert.equal(canReadProjectShare(reader, project), true);
  assert.equal(canReadProjectShare({ ...reader, projectIds: ['PRJ-2'] }, project), false);
  assert.equal(canManageProjectShare({ ...workspace, projectIds: ['PRJ-1'] }), false);
  assert.equal(canReadProjectShare({ ...workspace, capabilities: ['access.manage'] }, project), false);
  assert.equal(canReadProjectShare(null, project), false);
  assert.equal(canReadProjectShare(workspace, { ...project, workspaceId: 'another-workspace' }), false);
  assert.equal(canReadProjectShare(workspace, { ...project, kind: 'work_item' }), false);
  const person = member();
  const draft = projectShareDraft(person, 'add');
  assert.throws(() => projectShareMemberCommand(reader, project, draft, person.access, commandId), /unrestricted/);
  assert.throws(() => projectShareMemberCommand({ ...workspace, projectIds: ['PRJ-1'] }, project, draft, person.access, commandId), /unrestricted/);
  assert.throws(() => projectShareInvitationCommand(reader, project, 'new@example.invalid', 'guest', true, commandId), /unrestricted/);
});

test('adding one project preserves every capability and other project scope without applying role templates', () => {
  const person = member({ projectIds: ['PRJ-2', 'PRJ-999'] });
  const draft = projectShareDraft(person, 'add');
  const body = projectShareMemberCommand(workspace, project, draft, person.access, commandId);
  assert.equal(body.commandType, 'SetWorkspaceMember');
  assert.equal(body.targetId, person.userId);
  assert.equal(body.projectId, undefined);
  assert.deepEqual(body.expectedVersions, { [person.userId]: 8 });
  assert.equal(body.commandId, commandId);
  assert.deepEqual(body.payload, { userId: person.userId, capabilities: person.access!.capabilities, projectIds: ['PRJ-2', 'PRJ-999', 'PRJ-1'] });
  assert.deepEqual(person.access!.projectIds, ['PRJ-2', 'PRJ-999']);
  assert.deepEqual(draft.base.projectIds, ['PRJ-2', 'PRJ-999']);
  assert.notEqual(body.payload.capabilities, person.access!.capabilities);
});

test('removing current project preserves other projects and custom grants', () => {
  const person = member({ projectIds: ['PRJ-2', 'PRJ-1', 'PRJ-3'] });
  const body = projectShareMemberCommand(workspace, project, projectShareDraft(person, 'remove'), person.access, commandId);
  assert.equal(body.commandType, 'SetWorkspaceMember');
  assert.deepEqual(body.payload, { userId: person.userId, capabilities: person.access!.capabilities, projectIds: ['PRJ-2', 'PRJ-3'] });
  assert.deepEqual(person.access!.projectIds, ['PRJ-2', 'PRJ-1', 'PRJ-3']);
});

test('removing final project saves an empty scope rather than revoking membership or clearing capabilities', () => {
  const person = member({ projectIds: ['PRJ-1'] });
  const body = projectShareMemberCommand(workspace, project, projectShareDraft(person, 'remove'), person.access, commandId);
  assert.equal(body.commandType, 'SetWorkspaceMember');
  assert.deepEqual(body.payload, { userId: person.userId, capabilities: person.access!.capabilities, projectIds: [] });
  assert.equal('revokedAt' in body.payload, false);
  assert.equal('role' in body.payload, false);
});

test('workspace-wide grants are inherited, redacted grants stay unavailable, and revoked grants are never reactivated', () => {
  const inherited = member({ projectIds: null });
  assert.equal(projectShareScope(inherited.access, project.id), 'inherited');
  assert.equal(projectShareScope(null, project.id), 'unavailable');
  assert.throws(() => projectShareDraft({ ...inherited, access: null }, 'remove'), /not available/);
  for (const action of ['add', 'remove'] as const) {
    assert.throws(() => projectShareMemberCommand(workspace, project, projectShareDraft(inherited, action), inherited.access, commandId), /inherited/);
  }
  const revoked = member({ projectIds: ['PRJ-2', 'PRJ-1'], revokedAt: '2026-10-26T00:00:00.000Z' });
  assert.equal(projectShareScope(revoked.access, project.id), 'revoked');
  assert.throws(() => projectShareMemberCommand(workspace, project, projectShareDraft(revoked, 'remove'), revoked.access, commandId), /revoked/);
});

test('name and email search uses existing visible active membership records, not guessed identities', () => {
  const first = member();
  const other = { ...member({}, '62b164cb-851a-4070-92b5-b61f740641c0'), name: 'Another person', email: 'other@example.invalid' };
  const revoked = { ...member({ revokedAt: '2026-10-26T00:00:00.000Z' }), name: 'Revoked' };
  const redacted = { ...member(), access: null, name: 'Hidden grants' };
  assert.deepEqual(projectShareCandidates([first, other, revoked, redacted], ' SCOPED '), [first]);
  assert.deepEqual(projectShareCandidates([first, other], 'COLLEAGUE@'), [first]);
  assert.deepEqual(projectShareCandidates([first, other, revoked, redacted], ''), [first, other]);
  assert.deepEqual(projectShareCandidates([first], 'unknown@example.invalid'), []);
});

test('stale versions cannot overwrite grants and retained drafts require explicit rebase onto fresh capabilities', () => {
  const person = member();
  const draft = projectShareDraft(person, 'add');
  const latest = member({ version: 9, capabilities: ['domain.read', 'delivery.submit'], projectIds: ['PRJ-2', 'PRJ-3'] });
  assert.equal(projectShareConflict(draft, latest.access), true);
  assert.equal(projectShareConflict(draft, null), true);
  assert.equal(projectShareConflict(draft, undefined), true);
  assert.throws(() => projectShareMemberCommand(workspace, project, draft, latest.access, commandId), /changed/);
  assert.deepEqual(draft.base.capabilities, ['domain.read', 'directory.read', 'planning.edit', 'delivery.review']);
  assert.deepEqual(draft.base.projectIds, ['PRJ-2']);
  const rebased = projectShareDraft(latest, draft.action);
  const body = projectShareMemberCommand(workspace, project, rebased, latest.access, commandId);
  assert.deepEqual(body.payload, { userId: latest.userId, capabilities: ['domain.read', 'delivery.submit'], projectIds: ['PRJ-2', 'PRJ-3', 'PRJ-1'] });
  assert.deepEqual(body.expectedVersions, { [latest.userId]: 9 });
});

test('selection freezes the original arrays and never silently adds domain.read or repeats an inapplicable change', () => {
  const person = member();
  const draft = projectShareDraft(person, 'add');
  person.access!.projectIds!.push('PRJ-3');
  person.access!.capabilities.push('workitem.complete');
  assert.deepEqual(draft.base.projectIds, ['PRJ-2']);
  assert.deepEqual(draft.base.capabilities, ['domain.read', 'directory.read', 'planning.edit', 'delivery.review']);
  const noRead = member({ capabilities: ['directory.read'] });
  assert.throws(() => projectShareMemberCommand(workspace, project, projectShareDraft(noRead, 'add'), noRead.access, commandId), /No capabilities will be added/);
  const existing = member({ projectIds: ['PRJ-1'] });
  assert.throws(() => projectShareMemberCommand(workspace, project, projectShareDraft(existing, 'add'), existing.access, commandId), /no longer applicable/);
  assert.throws(() => projectShareMemberCommand(workspace, project, projectShareDraft(member(), 'remove'), member().access, commandId), /no longer applicable/);
});

test('disabled SMTP cannot create an invitation, and enabled invitations are fixed to the current project', () => {
  assert.throws(() => projectShareInvitationCommand(workspace, project, 'new@example.invalid', 'guest', false, commandId), /SMTP/);
  const body = projectShareInvitationCommand(workspace, project, ' NEW@example.invalid ', 'guest', true, commandId);
  assert.equal(body.commandType, 'CreateMemberInvitation');
  assert.equal(body.commandId, commandId);
  assert.equal(body.projectId, undefined);
  assert.equal(body.targetId, undefined);
  assert.deepEqual(body.payload, { email: 'new@example.invalid', role: 'guest', projectIds: ['PRJ-1'] });
  assert.throws(() => projectShareInvitationCommand(workspace, project, 'new@example.invalid', 'admin', true, commandId), /Guest or Member/);
  assert.throws(() => projectShareInvitationCommand(workspace, project, 'not-an-email', 'guest', true, commandId));
});

test('archived projects reject new scopes and invitations but permit narrowing their existing scope', () => {
  const archived = { ...project, data: { ...project.data, archivedAt: '2026-10-26T00:00:00.000Z' } };
  const person = member();
  assert.throws(() => projectShareMemberCommand(workspace, archived, projectShareDraft(person, 'add'), person.access, commandId), /unarchived/);
  assert.throws(() => projectShareInvitationCommand(workspace, archived, 'new@example.invalid', 'guest', true, commandId), /unarchived/);
  const granted = member({ projectIds: ['PRJ-1', 'PRJ-2'] });
  const body = projectShareMemberCommand(workspace, archived, projectShareDraft(granted, 'remove'), granted.access, commandId);
  assert.equal(body.commandType, 'SetWorkspaceMember');
  assert.deepEqual(body.payload.projectIds, ['PRJ-2']);
});

test('copied links use the current origin and the stable workspace/project route without a public-access token', () => {
  const value = projectShareUrl('https://pm.example.invalid:8443', workspace.id, project.id);
  assert.equal(value, `https://pm.example.invalid:8443/pm/${workspace.id}/projects/PRJ-1`);
  const url = new URL(value);
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
});
