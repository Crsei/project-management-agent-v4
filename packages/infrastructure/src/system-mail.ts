/// <reference lib="es2024.promise" />
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import { z } from 'zod';

export type SystemMailConfig = { host: string; port: number; secure: boolean; requireTls?: boolean; auth?: { user: string; pass: string }; from: string; timeoutMs: number };
export type SystemMailOutcome = { status: 'smtp_accepted' } | { status: 'failed' | 'unknown'; failureCode: 'smtp_rejected' | 'smtp_configuration' | 'smtp_unavailable' | 'send_outcome_unknown' };
const loopbackHosts: Record<string, true | undefined> = { localhost: true, '127.0.0.1': true, '[::1]': true, '::1': true };
export function readSystemMailConfig(env: NodeJS.ProcessEnv): SystemMailConfig {
  const parsed = z.strictObject({ host: z.string().trim().min(1).max(253), port: z.coerce.number().int().min(1).max(65535).default(587), secure: z.enum(['true', 'false']).default('false'), tls: z.enum(['true', 'false']).default('true'), from: z.email().max(254), timeout: z.coerce.number().int().min(1000).max(120000).default(15000) }).safeParse({ host: env.SMTP_HOST, port: env.SMTP_PORT || undefined, secure: env.SMTP_SECURE || undefined, tls: env.SMTP_REQUIRE_TLS || undefined, from: env.SMTP_FROM, timeout: env.SMTP_TIMEOUT_MS || undefined });
  if (!parsed.success || Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD)) throw new Error('System SMTP configuration is incomplete or invalid');
  const v = parsed.data;
  if (v.secure !== 'true' && v.tls !== 'true' && !Object.hasOwn(loopbackHosts,v.host)) throw new Error('System SMTP configuration is incomplete or invalid');
  return { host: v.host, port: v.port, secure: v.secure === 'true', requireTls: v.tls === 'true', from: v.from, timeoutMs: v.timeout, ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD! } } : {}) };
}
export function readMailFeature(env: NodeJS.ProcessEnv, originKey: string, keyKey: string): { webOrigin: string; tokenKey: Buffer } {
  try {
    const origin = new URL(env[originKey] ?? '');
    const encoded = env[keyKey] ?? '', tokenKey = Buffer.from(encoded, 'base64');
    if (!['http:', 'https:'].includes(origin.protocol) || origin.protocol === 'http:' && !Object.hasOwn(loopbackHosts,origin.hostname) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || tokenKey.length !== 32 || tokenKey.toString('base64') !== encoded) throw new Error();
    return { webOrigin: origin.origin, tokenKey };
  } catch { throw new Error('Mail feature configuration is incomplete or invalid'); }
}
/** Format and caller-supplied AAD preserve existing invitation queue ciphertext exactly. */
export function encryptMailToken(key: Buffer, aad: string, token: string): string {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
}
export function decryptMailToken(key: Buffer, aad: string, encrypted: string): string {
  const data = Buffer.from(encrypted, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}
const smtpFailure = z.object({ code: z.string().optional(), responseCode: z.number().optional() });
/** One attempt, fresh non-pooled transport, bounded deadline, no MIME/URL/file logging. */
export async function sendSystemMail(config: SystemMailConfig, mail: { email: string; subject: string; messageId: string; text: string }): Promise<SystemMailOutcome> {
  const transport = nodemailer.createTransport({ host: config.host, port: config.port, secure: config.secure, requireTLS: config.requireTls ?? true, auth: config.auth, connectionTimeout: config.timeoutMs, greetingTimeout: config.timeoutMs, socketTimeout: config.timeoutMs, disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false, pool: false });
  let timer: NodeJS.Timeout | undefined;
  try {
    const deadline = Promise.withResolvers<never>();
    timer = setTimeout(() => deadline.reject(new Error('SMTP deadline')), config.timeoutMs);
    const response = await Promise.race([transport.sendMail({ from: config.from, to: mail.email, subject: mail.subject, messageId: mail.messageId, text: mail.text, disableFileAccess: true, disableUrlAccess: true }), deadline.promise]);
    return response.accepted.some(address => address.toLowerCase() === mail.email.toLowerCase()) ? { status: 'smtp_accepted' } : { status: 'failed', failureCode: 'smtp_rejected' };
  } catch (error) {
    const parsed = smtpFailure.safeParse(error);
    if (!parsed.success) return { status: 'unknown', failureCode: 'send_outcome_unknown' };
    if (parsed.data.responseCode && parsed.data.responseCode >= 400 && parsed.data.responseCode <= 599) return { status: 'failed', failureCode: 'smtp_rejected' };
    if (parsed.data.code === 'EAUTH') return { status: 'failed', failureCode: 'smtp_configuration' };
    if (['EDNS', 'ECONNREFUSED', 'ENOTFOUND'].includes(parsed.data.code ?? '')) return { status: 'failed', failureCode: 'smtp_unavailable' };
    return { status: 'unknown', failureCode: 'send_outcome_unknown' };
  } finally { clearTimeout(timer); transport.close(); }
}
