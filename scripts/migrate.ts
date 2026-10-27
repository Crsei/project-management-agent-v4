import { createPool, migrate, checkDatabase } from '../packages/infrastructure/src/database.ts';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = createPool(process.env.DATABASE_URL);
try {
  await migrate(pool);
  console.log(JSON.stringify({ event: 'migrations_applied', ...await checkDatabase(pool) }));
} finally { await pool.end(); }
