import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { createPool } from '../packages/infrastructure/src/database.ts';
import { getInstanceSetupStatus, prepareInstanceSetup } from '../packages/infrastructure/src/instance-setup.ts';
import { createPrivateFile, readPrivateFile } from '../packages/pm-cli/private-files.ts';

export async function bootstrapInstance(pool: Pool, directory = '.local'): Promise<'initialized' | 'prepared'> {
  // Database state is authoritative. Existing instances do not touch credential files.
  if ((await getInstanceSetupStatus(pool)).initialized) return 'initialized';
  const filename = path.resolve(directory, 'setup-token');
  let token = await readPrivateFile(filename);
  if (token === undefined) {
    // Persist and fsync before committing its digest. A crash or DB failure can retry
    // with this exact token instead of leaving an unrecoverable pending digest.
    await createPrivateFile(filename, `${randomBytes(32).toString('base64url')}\n`);
    token = await readPrivateFile(filename);
  }
  if (token === undefined || !/^[A-Za-z0-9_-]{43,512}\n?$/.test(token)) throw new Error('Private setup-token file is invalid. Restore the original private file; do not replace a pending setup token.');
  const state = await prepareInstanceSetup(pool, token.trim());
  return state.initialized ? 'initialized' : 'prepared';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = createPool(process.env.DATABASE_URL);
  try {
    const state = await bootstrapInstance(pool);
    if (state === 'initialized') console.log('Instance is already initialized; no account, password, or workspace was changed.');
    else {
      console.log(`First-use setup token is ready in ${path.resolve('.local/setup-token')} (0600).`);
      console.log('Open this instance’s /pm page and enter the token privately to create your account and workspace. No password was generated.');
    }
  } catch {
    // Do not serialize database/driver errors, token arguments, or private contents.
    console.error('Bootstrap did not complete. Check database/schema availability and private setup-token permissions. If setup is pending, restore its original token file; use the deployment guide’s controlled recovery if it is lost. Existing accounts were not reset.');
    process.exitCode = 1;
  } finally { await pool.end(); }
}
