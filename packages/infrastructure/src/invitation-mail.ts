import { z } from 'zod';
import { readMailFeature, readSystemMailConfig, sendSystemMail, type SystemMailConfig, type SystemMailOutcome } from './system-mail.ts';

export type InvitationMailConfig = SystemMailConfig & { webOrigin: string; tokenKey: Buffer; ttlSeconds: number };
/** SMTP alone never enables a feature. Partial invitation configuration is an error. */
export function readInvitationMailConfig(env: NodeJS.ProcessEnv = process.env): InvitationMailConfig | undefined {
  if (!['INVITATION_WEB_ORIGIN', 'INVITATION_TOKEN_KEY', 'INVITATION_TTL_SECONDS'].some(key => Boolean(env[key]))) return undefined;
  const ttl = z.coerce.number().int().min(300).max(30 * 86400).safeParse(env.INVITATION_TTL_SECONDS || 7 * 86400);
  if (!ttl.success) throw new Error('Invitation mail configuration is incomplete or invalid');
  return { ...readSystemMailConfig(env), ...readMailFeature(env, 'INVITATION_WEB_ORIGIN', 'INVITATION_TOKEN_KEY'), ttlSeconds: ttl.data };
}
export type InvitationMail = { invitationId: string; deliveryId: string; email: string; token: string; expiresAt: string };
export async function sendInvitationMail(config: InvitationMailConfig, mail: InvitationMail): Promise<SystemMailOutcome> {
  const link = `${config.webOrigin}/pm/invitations/accept#token=${mail.token}`;
  return sendSystemMail(config, { email: mail.email, subject: 'Workspace membership invitation', messageId: `<invitation-${mail.deliveryId}@${new URL(config.webOrigin).hostname}>`, text: `You have been invited to a workspace.\n\nAccept your invitation: ${link}\n\nThis link expires at ${mail.expiresAt}. If you already have an account, use its existing password.\nIf you did not expect this invitation, ignore this email.` });
}
