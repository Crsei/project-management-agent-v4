import type { Capability } from './core.ts';
import type { SelfProfile } from './dashboard-personal.ts';
import type { PresenceStatus } from './dashboard-time.ts';

export const MEMBER_ROLES = ['admin', 'member', 'guest'] as const;
export type MemberRole = typeof MEMBER_ROLES[number];
export type MemberDirectoryRole = MemberRole | 'custom' | 'unknown';
export const MEMBER_ROLE_PRESETS = {
  admin: ['domain.read', 'directory.read', 'access.manage'],
  member: ['domain.read', 'directory.read', 'intent.propose', 'planning.edit', 'delivery.write', 'delivery.submit'],
  guest: ['domain.read', 'directory.read'],
} as const satisfies Record<MemberRole, readonly Capability[]>;

/** Templates are explicit grants, never an implicit migration of existing access. */
export function memberRoleCapabilities(role: MemberRole): Capability[] {
  return [...MEMBER_ROLE_PRESETS[role]];
}

export function memberRole(capabilities: readonly Capability[], projectIds: readonly string[] | null): MemberRole | 'custom' {
  for (const role of MEMBER_ROLES) {
    const preset: readonly Capability[] = MEMBER_ROLE_PRESETS[role];
    if (role === 'admin' && projectIds !== null) continue;
    if (capabilities.length === preset.length && preset.every(capability => capabilities.includes(capability))) return role;
  }
  return 'custom';
}

export type MemberDirectoryAccess = {
  capabilities: Capability[];
  projectIds: string[] | null;
  version: number;
  revokedAt: string | null;
};
export type MemberDirectoryTeam = { id: string; name: string };
export type MemberDirectoryMember = {
  userId: string;
  name: string;
  email: string | null;
  jobTitle: string | null;
  phone: string | null;
  avatarDataUrl: string | null;
  joinedAt: string;
  isSelf: boolean;
  role: MemberDirectoryRole;
  teams: MemberDirectoryTeam[];
  presence: { status: PresenceStatus; lastHeartbeatAt: string | null };
  twoFactorEnabled: null;
  /** Null means redacted, not an empty grant or an unrestricted project scope. */
  access: MemberDirectoryAccess | null;
};
export type MemberDirectory = {
  serverNow: string;
  presenceTtlMs: number;
  capabilities: {
    canReadDirectory: true;
    canManageMembers: boolean;
    canEditSelfProfile: boolean;
    twoFactor: { supported: false };
  };
  selfProfile: SelfProfile;
  members: MemberDirectoryMember[];
};
