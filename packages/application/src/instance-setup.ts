import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { CAPABILITIES, DomainError } from '../../domain/src/core.ts';
import { setupRequestSchema, type SetupResponse } from '../../contracts/src/instance-setup.ts';
import { consumeAuthRateLimit, hashPassword, login } from '../../infrastructure/src/auth.ts';
import { getInstanceSetupStatus, instanceSetupTokenMatches, lockInstanceSetup } from '../../infrastructure/src/instance-setup.ts';
import { initializeNovaWorkspaceSample, queueNovaWorkspaceSample, type WorkspaceSampleOptions } from './workspace-samples.ts';

export async function completeInstanceSetup(pool: Pool, input: unknown, options: { sourceIp?: string; sample: WorkspaceSampleOptions }): Promise<SetupResponse & { token: string }> {
  if (options.sourceIp) await consumeAuthRateLimit(pool, `setup-source:${options.sourceIp}`, 10, 900);
  await consumeAuthRateLimit(pool, 'instance-setup', 30, 900);
  const body = setupRequestSchema.parse(input);
  const email = body.email.toLowerCase();
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockInstanceSetup(client);
    const status = await getInstanceSetupStatus(client);
    if (status.initialized) throw new DomainError('instance_initialized', 'This instance is already initialized; sign in with an existing account', 409);
    if (!status.setupAllowed) throw new DomainError('setup_unavailable', 'An administrator must prepare this instance before setup', 403);
    const pending = await client.query<{ token_hash: string }>('SELECT token_hash FROM instance_setup WHERE singleton FOR UPDATE');
    if (!pending.rows[0] || !instanceSetupTokenMatches(body.setupToken, pending.rows[0].token_hash)) throw new DomainError('setup_token_invalid', 'The setup token is invalid', 403);
    const passwordHash = await hashPassword(body.password);
    await client.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [userId, email, body.name, passwordHash]);
    await client.query('INSERT INTO workspaces(id,name,owner_id) VALUES($1,$2,$3)', [workspaceId, body.workspaceName, userId]);
    // Exactly the existing bootstrap grants. Ownership alone is not authority.
    await client.query('INSERT INTO memberships(workspace_id,user_id,capabilities,project_ids) VALUES($1,$2,$3,NULL)', [workspaceId, userId, [...CAPABILITIES]]);
    await queueNovaWorkspaceSample(client, workspaceId, userId, body.workspaceName, options.sample);
    await client.query('UPDATE instance_setup SET token_hash=NULL,completed_at=clock_timestamp() WHERE singleton AND completed_at IS NULL');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  await initializeNovaWorkspaceSample(pool, workspaceId, options.sample);
  // Account/workspace/membership/completion have committed before session work.
  // A failed session or lost response never reopens setup; ordinary login with
  // the chosen password is the recovery path, using the existing auth checks.
  const session = await login(pool, { email, password: body.password }, options.sourceIp ? { sourceIp: options.sourceIp } : {});
  return { ...session, workspaceId };
}
