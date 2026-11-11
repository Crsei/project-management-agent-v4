import { buildApp } from '../../../apps/server/pm/src/app.ts';
import { LocalBlobStore } from '../../../packages/infrastructure/src/blobs.ts';

if (!process.send || !process.env.DOVSPACE_BENCH_FIXTURE_ID) throw new Error('PM fixture service requires an owned IPC parent');
const root = process.env.BLOB_ROOT!;
const app = buildApp({
  databaseUrl: process.env.DATABASE_URL!, coreWorkspaceRoot: process.env.CORE_WORKSPACE_ROOT!, chatSpaceRoot: process.env.PM_CHAT_SPACE_ROOT!,
  blobStore: new LocalBlobStore(root), blobStorageLocator: { provider: 'local', root }, cookieSecure: false, publicOrigin: 'http://127.0.0.1:3900',
  localProjects: { enabled: false, dataRoot: process.env.DOVSPACE_BENCH_ROOT!, defaultParent: null, allowedRoots: [], backupRoot: process.env.DOVSPACE_BENCH_ROOT! + '/backups' },
});
let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  const force = setTimeout(() => process.exit(1), 15_000);
  try { await app.close(); clearTimeout(force); if (process.connected) process.disconnect(); }
  catch { process.exitCode = 1; }
}
for (const event of ['SIGTERM', 'SIGINT', 'disconnect'] as const) process.once(event, () => { void close(); });
try {
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  process.send({ event: 'ready', origin });
} catch {
  process.send({ event: 'failed' });
  process.exitCode = 1;
  await close();
}
