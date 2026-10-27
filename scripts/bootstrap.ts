import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createPool } from '../packages/infrastructure/src/database.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
await mkdir('.local', { recursive: true, mode: 0o700 });
const pool = createPool(process.env.DATABASE_URL);
try {
  let existing: unknown;
  try { existing = JSON.parse(await readFile('.local/access.json', 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing) {
    console.log('Existing .local/access.json preserved; bootstrap did not change the account.');
  } else {
    const password = randomBytes(24).toString('base64url');
    const email = 'admin@project-management.local';
    const actor = await createUser(pool, { email, password, name: 'Local Administrator' });
    const workspace = await createWorkspace(pool, actor.id, 'Project Management');
    await writeFile('.local/access.json', JSON.stringify({ email, password, userId: actor.id, workspaceId: workspace.id }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await chmod('.local/access.json', 0o600);
    console.log('Local workspace created. Login details saved privately in .local/access.json (0600).');
  }
} finally { await pool.end(); }
