import { z } from 'zod';
import { readMailFeature, readSystemMailConfig, sendSystemMail, type SystemMailConfig, type SystemMailOutcome } from './system-mail.ts';

export type RecoveryPurpose = 'verify_recovery_email' | 'reset_password';
export type AccountRecoveryMailConfig = SystemMailConfig & { webOrigin: string; tokenKey: Buffer; resetTtlSeconds: number; verifyTtlSeconds: number };
export function readAccountRecoveryMailConfig(env: NodeJS.ProcessEnv = process.env): AccountRecoveryMailConfig | undefined {
  if (!['ACCOUNT_RECOVERY_WEB_ORIGIN', 'ACCOUNT_RECOVERY_TOKEN_KEY', 'PASSWORD_RESET_TTL_SECONDS', 'RECOVERY_EMAIL_VERIFY_TTL_SECONDS'].some(key => Boolean(env[key]))) return undefined;
  const ttl = z.coerce.number().int().min(300).max(3600);
  const reset = ttl.safeParse(env.PASSWORD_RESET_TTL_SECONDS || 900), verify = ttl.safeParse(env.RECOVERY_EMAIL_VERIFY_TTL_SECONDS || 1800);
  if (!reset.success || !verify.success) throw new Error('Account recovery mail configuration is incomplete or invalid');
  return { ...readSystemMailConfig(env), ...readMailFeature(env, 'ACCOUNT_RECOVERY_WEB_ORIGIN', 'ACCOUNT_RECOVERY_TOKEN_KEY'), resetTtlSeconds: reset.data, verifyTtlSeconds: verify.data };
}
export async function sendAccountRecoveryMail(config: AccountRecoveryMailConfig, mail: { purpose: RecoveryPurpose; deliveryId: string; email: string; token: string; expiresAt: string }): Promise<SystemMailOutcome> {
  const verify = mail.purpose === 'verify_recovery_email';
  const link = `${config.webOrigin}/pm/account/${verify ? 'verify-recovery-email' : 'recovery'}#token=${mail.token}`;
  return sendSystemMail(config, { email: mail.email, subject: verify ? 'Verify your recovery email' : 'Reset your password', messageId: `<account-recovery-${mail.deliveryId}@${new URL(config.webOrigin).hostname}>`, text: `${verify ? 'Confirm this recovery email while signed in to your account.' : 'Reset your password. This revokes every existing sign-in session and does not sign you in.'}\n\n${link}\n\nThis single-purpose link expires at ${mail.expiresAt}. If you did not request this, ignore this email. SMTP acceptance is not inbox delivery.` });
}
