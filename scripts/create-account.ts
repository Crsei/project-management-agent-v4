import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createPool } from '../packages/infrastructure/src/database.ts';
import { createUser } from '../packages/infrastructure/src/auth.ts';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
if (!values.email || !values.name) throw new Error('Usage: create-account.ts --email EMAIL --name NAME');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
await mkdir('.local/accounts', { recursive: true, mode: 0o700 });
const pool = createPool(process.env.DATABASE_URL);
try {
  const password = randomBytes(24).toString('base64url');
  const user = await createUser(pool, { email: values.email, name: values.name, password });
  const file = `.local/accounts/${user.id}.json`;
  await writeFile(file, JSON.stringify({ ...user, password }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ userId: user.id, credentialsFile: file, workspaceAccess: 'none; grant explicitly through SetWorkspaceMember' }));
} finally { await pool.end(); }
