import { createPool, migrate, checkDatabase } from '../dist/packages/infrastructure/src/database.js';

if (process.argv[2] !== 'migrate') throw new Error('Usage: node deploy/manage.mjs migrate');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be injected');
const pool = createPool(process.env.DATABASE_URL);
try {
  await migrate(pool);
  console.log(JSON.stringify({ event: 'migrations_applied', ...await checkDatabase(pool) }));
} finally {
  await pool.end();
}
