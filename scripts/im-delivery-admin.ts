import { createPool } from '../packages/infrastructure/src/database.ts';
import { readImDeliveryStatus, retryImDelivery } from '../packages/application/src/im-delivery.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for IM delivery administration');
const pool = createPool(databaseUrl, 2);
try {
  const [command, id] = process.argv.slice(2);
  if (command === 'status') {
    const status = await readImDeliveryStatus(pool);
    console.log(JSON.stringify(status));
  } else if (command === 'retry' && id) {
    console.log(JSON.stringify(await retryImDelivery(pool, id)));
  } else {
    console.error('Usage: node --env-file=.env.worker scripts/im-delivery-admin.ts <status|retry DELIVERY_ID>');
    process.exitCode = 1;
  }
} finally { await pool.end(); }
