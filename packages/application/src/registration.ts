import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { registerRequestSchema, type RegisterResponse } from '../../contracts/src/registration.ts';
import { DomainError } from '../../domain/src/core.ts';
import { consumeAuthRateLimit, DEFAULT_SESSION_TTL_SECONDS, hashPassword } from '../../infrastructure/src/auth.ts';
import { getInstanceSetupStatus, lockInstanceSetup } from '../../infrastructure/src/instance-setup.ts';

export async function registerAccount(pool: Pool, input: unknown, sourceIp: string): Promise<RegisterResponse & { token: string }> {
  await consumeAuthRateLimit(pool, `registration-source:${sourceIp}`, 10, 900);
  const body = registerRequestSchema.parse(input);
  const passwordHash = await hashPassword(body.password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockInstanceSetup(client);
    if (!(await getInstanceSetupStatus(client)).initialized) throw new DomainError('registration_unavailable', 'Instance setup must be completed before registration', 403);
    const id = randomUUID();
    let actor: RegisterResponse['actor'];
    try {
      const result = await client.query<RegisterResponse['actor']>('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4) RETURNING id,email,name', [id, body.email, body.name, passwordHash]);
      actor = result.rows[0]!;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505' && 'constraint' in error && error.constraint === 'users_email_key') throw new DomainError('account_conflict', 'Email is already registered', 409);
      throw error;
    }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + DEFAULT_SESSION_TTL_SECONDS * 1000).toISOString();
    const digest = createHash('sha256').update(token).digest('hex');
    await client.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [digest, id, expiresAt]);
    await client.query('COMMIT');
    return { actor, token, expiresAt };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
