import { createHash, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import type { SqlExecutor } from '../../application/src/ports.ts';
import { DomainError } from '../../domain/src/core.ts';
import { setupTokenSchema, type InstanceSetupStatus } from '../../contracts/src/instance-setup.ts';

export function instanceSetupTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
export function instanceSetupTokenMatches(token: string, digest: string): boolean {
  return /^[a-f0-9]{64}$/.test(digest)
    && timingSafeEqual(Buffer.from(instanceSetupTokenHash(token), 'hex'), Buffer.from(digest, 'hex'));
}

/** Order all prepare/claim transactions, including before a singleton exists. */
export async function lockInstanceSetup(sql: SqlExecutor): Promise<void> {
  await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('project-management:instance-setup', 724631))");
  // Old administrative callers do not know the setup advisory lock. These table
  // locks also fence their user/workspace inserts until the empty check commits.
  await sql.query('LOCK TABLE users,workspaces IN SHARE ROW EXCLUSIVE MODE');
}

export async function getInstanceSetupStatus(sql: SqlExecutor): Promise<InstanceSetupStatus> {
  // One snapshot; missing relations/columns must throw, never resemble an empty
  // installation. Parse references to every table required by setup and login.
  const result = await sql.query<{ initialized: boolean; pending: boolean }>(`SELECT
    (EXISTS(SELECT id,email,name,password_hash,disabled_at,credential_version FROM users) OR EXISTS(SELECT id,name,owner_id FROM workspaces)
      OR EXISTS(SELECT 1 FROM instance_setup WHERE singleton AND completed_at IS NOT NULL)) AS initialized,
    EXISTS(SELECT 1 FROM instance_setup WHERE singleton AND completed_at IS NULL AND token_hash IS NOT NULL) AS pending,
    EXISTS(SELECT token_hash,user_id,expires_at FROM sessions WHERE false) AS session_schema,
    EXISTS(SELECT workspace_id,user_id,capabilities,project_ids FROM memberships WHERE false) AS member_schema,
    EXISTS(SELECT key,attempts,expires_at FROM account_auth_limits WHERE false) AS limit_schema`);
  const row = result.rows[0]!;
  return { initialized: row.initialized, setupAllowed: !row.initialized && row.pending, registrationMode: 'invite_only' };
}

/**
 * Prepare exactly the caller's durable 32-byte base64url deployment token.
 * Repeating the same token recovers a lost response. A different pending token
 * conflicts: restore the original private file, never silently rotate a claim.
 * Existing installations return closed without changing accounts or setup state.
 */
export async function prepareInstanceSetup(pool: Pool, token: string): Promise<InstanceSetupStatus> {
  setupTokenSchema.parse(token);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockInstanceSetup(client);
    const status = await getInstanceSetupStatus(client);
    if (status.initialized) {
      await client.query('COMMIT');
      return status;
    }
    const pending = await client.query<{ token_hash: string }>('SELECT token_hash FROM instance_setup WHERE singleton FOR UPDATE');
    if (pending.rows[0]) {
      if (!instanceSetupTokenMatches(token, pending.rows[0].token_hash)) throw new DomainError('setup_token_conflict', 'Setup is already prepared; restore the original private setup-token file', 409);
    } else {
      await client.query('INSERT INTO instance_setup(singleton,token_hash) VALUES(true,$1)', [instanceSetupTokenHash(token)]);
    }
    await client.query('COMMIT');
    return { initialized: false, setupAllowed: true, registrationMode: 'invite_only' };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
