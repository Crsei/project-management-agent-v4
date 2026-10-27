import type { MemberRole } from './members.ts';

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';
/** SMTP acceptance is not proof of inbox delivery. Unknown attempts require explicit resend. */
export type InvitationDeliveryStatus = 'queued' | 'sending' | 'smtp_accepted' | 'failed' | 'unknown' | 'cancelled';
export type InvitationFailureCode = 'smtp_rejected' | 'smtp_unavailable' | 'smtp_configuration' | 'send_outcome_unknown' | 'send_lease_expired' | 'token_unavailable';
export type MemberInvitationDto = {
  id: string;
  workspaceId: string;
  email: string;
  role: MemberRole;
  projectIds: string[] | null;
  status: InvitationStatus;
  version: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  invitedBy: string;
  acceptedAt: string | null;
  delivery: { status: InvitationDeliveryStatus; failureCode: InvitationFailureCode | null; updatedAt: string } | null;
};
export type InvitationListDto = { enabled: boolean; items: MemberInvitationDto[] };
export type InvitationInspectDto = {
  workspaceId: string;
  workspaceName: string;
  email: string;
  role: MemberRole;
  projectIds: string[] | null;
  expiresAt: string;
  accountExists: boolean;
};
export type InvitationAcceptPayload = { commandId: string; token: string; password: string; name?: string };
export type InvitationAcceptDto = { workspaceId: string; userId: string; email: string; alreadyAccepted: boolean };
export type InvitationReceiptDto = { outcome: InvitationAcceptDto | null };
