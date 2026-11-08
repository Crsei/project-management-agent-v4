import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { CAPABILITIES, DomainError } from '../../domain/src/core.ts';
import type { Actor } from '../../domain/src/core.ts';
import { lockWorkspace } from './database.ts';

const credentials = z.object({ email: z.email().max(254), password: z.string().min(12).max(256) }).strict();
const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, scryptOptions, (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$32768$8$1$${salt.toString('hex')}$${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts.slice(0, 4).join('$') !== 'scrypt$32768$8$1' || !/^[a-f0-9]{32}$/.test(parts[4] ?? '') || !/^[a-f0-9]{128}$/.test(parts[5] ?? '')) return false;
  const key = await derive(password, Buffer.from(parts[4]!, 'hex'));
  return timingSafeEqual(key, Buffer.from(parts[5]!, 'hex'));
}
function parse<T>(validator: z.ZodType<T>, input: unknown): T {
  const result = validator.safeParse(input);
  if (!result.success) throw new DomainError('validation_failed', 'Invalid account parameters', 400, result.error.flatten());
  return result.data;
}
function tokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }

/** Persistent, cross-process throttling. Never include a password in the key. */
export async function consumeAuthRateLimit(pool: Pool, scope: string, limit: number, windowSeconds: number): Promise<void> {
  const key = tokenHash(scope);
  await pool.query('DELETE FROM account_auth_limits WHERE expires_at <= clock_timestamp()');
  const result = await pool.query<{ attempts: number }>(`INSERT INTO account_auth_limits(key,attempts,expires_at)
    VALUES($1,1,clock_timestamp()+$2*interval '1 second')
    ON CONFLICT(key) DO UPDATE SET
      attempts=CASE WHEN account_auth_limits.expires_at<=clock_timestamp() THEN 1 ELSE account_auth_limits.attempts+1 END,
      expires_at=CASE WHEN account_auth_limits.expires_at<=clock_timestamp() THEN EXCLUDED.expires_at ELSE account_auth_limits.expires_at END
    RETURNING attempts`, [key, windowSeconds]);
  if (result.rows[0]!.attempts > limit) throw new DomainError('rate_limited', 'Too many authentication attempts; wait before trying again', 429);
}

export async function createUser(pool: Pool, input: { email: string; password: string; name: string }): Promise<Actor> {
  const data = parse(credentials.extend({ name: z.string().trim().min(1).max(200) }), { ...input, email: input.email?.trim().toLowerCase() });
  const id = randomUUID();
  const passwordHash = await hashPassword(data.password);
  try {
    const result = await pool.query<Actor>('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4) RETURNING id,email,name', [id, data.email, data.name, passwordHash]);
    return result.rows[0]!;
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new DomainError('account_conflict', 'Email is already registered', 409);
    throw error;
  }
}

export async function createWorkspace(pool: Pool, ownerId: string, name: string, options: { prepare?: (sql: PoolClient, workspace: { id: string; name: string; ownerId: string }) => Promise<void> } = {}): Promise<{ id: string; name: string; ownerId: string }> {
  parse(z.uuid(), ownerId);
  const cleanName = parse(z.string().trim().min(1).max(200), name);
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockWorkspace(client, id);
    const owner = await client.query('SELECT id FROM users WHERE id=$1 AND disabled_at IS NULL', [ownerId]);
    if (!owner.rowCount) throw new DomainError('not_found_or_forbidden', 'Owner does not exist', 404);
    await client.query('INSERT INTO workspaces(id,name,owner_id) VALUES($1,$2,$3)', [id, cleanName, ownerId]);
    // Bootstrap authority is explicit, rather than inferred from workspace ownership.
    await client.query('INSERT INTO memberships(workspace_id,user_id,capabilities,project_ids) VALUES($1,$2,$3,NULL)', [id, ownerId, [...CAPABILITIES]]);
    await options.prepare?.(client, { id, name: cleanName, ownerId });
    await client.query('COMMIT');
    return { id, name: cleanName, ownerId };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function login(pool: Pool, input: { email: string; password: string }, options: { sessionTtlSeconds?: number; sourceIp?: string } = {}): Promise<{ token: string; actor: Actor; expiresAt: string }> {
  // Login accepts a short wrong password so all invalid credentials share the same rejection.
  const data = parse(z.object({ email: z.string().max(254), password: z.string().max(256) }).strict(), input);
  const ttl = options.sessionTtlSeconds ?? 8 * 60 * 60;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 30 * 86400) throw new Error('sessionTtlSeconds must be between 60 and 2592000');
  if (options.sourceIp) await consumeAuthRateLimit(pool, `login-source:${options.sourceIp}`, 20, 60);
  await consumeAuthRateLimit(pool, `login-account:${data.email.trim().toLowerCase()}`, 10, 900);
  const result = await pool.query<Actor & { password_hash: string; credential_version: number; disabled_at: Date | null }>('SELECT id,email,name,password_hash,credential_version,disabled_at FROM users WHERE email=$1', [data.email.trim().toLowerCase()]);
  const user = result.rows[0];
  const valid = user ? await verifyPassword(data.password, user.password_hash) : (await derive(data.password, Buffer.alloc(16)), false);
  if (!valid || !user || user.disabled_at) throw new DomainError('invalid_credentials', 'Invalid email or password', 401);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Hashing stays outside the lock. A password change that won the lock makes
    // this verification stale and must not create a surviving old-password session.
    const current = await client.query<Actor & { password_hash: string; credential_version: number; disabled_at: Date | null }>('SELECT id,email,name,password_hash,credential_version,disabled_at FROM users WHERE id=$1 FOR UPDATE', [user.id]);
    const fresh = current.rows[0];
    if (!fresh || fresh.disabled_at || fresh.credential_version !== user.credential_version || fresh.password_hash !== user.password_hash) throw new DomainError('invalid_credentials', 'Invalid email or password', 401);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    await client.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [tokenHash(token), user.id, expiresAt]);
    await client.query('COMMIT');
    return { token, actor: { id: fresh.id, email: fresh.email, name: fresh.name }, expiresAt };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function authenticate(pool: Pool, token: string): Promise<Actor> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new DomainError('unauthenticated', 'Authentication required', 401);
  const result = await pool.query<Actor>('SELECT u.id,u.email,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.disabled_at IS NULL', [tokenHash(token)]);
  if (!result.rows[0]) throw new DomainError('unauthenticated', 'Session is invalid or expired', 401);
  return result.rows[0];
}
export async function logout(pool: Pool, token: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The same user-row lock orders logout with password/session management.
    await client.query('SELECT u.id FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=$1 FOR UPDATE OF u', [tokenHash(token)]);
    await client.query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash(token)]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
