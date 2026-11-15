import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.send || !process.env.DOVSPACE_BENCH_FIXTURE_ID) throw new Error('PM fixture service requires an owned IPC parent');
const source = process.env.DOVSPACE_BENCH_SOURCE_ROOT, ownerRoot = process.env.DOVSPACE_BENCH_ROOT;
if (!source || !ownerRoot || !path.isAbsolute(source) || source !== path.join(ownerRoot, 'runtime-source') || await realpath(ownerRoot) !== ownerRoot || await realpath(source) !== source) throw new Error('PM fixture requires its canonical owned product source');
for (const directory of [ownerRoot, source]) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('PM source must be an owner-private fixture directory');
}
async function sourceModule(relative: string) {
  const filename = path.join(source!, relative);
  if (await realpath(filename) !== filename || path.relative(source!, filename).startsWith('..')) throw new Error('PM source module escaped its immutable stage');
  return import(pathToFileURL(filename).href);
}
const { buildApp } = await sourceModule('apps/server/pm/src/app.ts');
const { LocalBlobStore } = await sourceModule('packages/infrastructure/src/blobs.ts');
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
