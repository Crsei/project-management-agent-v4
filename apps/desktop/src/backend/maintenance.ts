import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import type { Pool } from 'pg';
import { createPool, migrate } from '../../../../packages/infrastructure/src/database.ts';
import { createBlobStore } from '../../../../packages/infrastructure/src/blob-storage-provider.ts';
import { bindBlobStore, readStorageBinding } from '../../../../packages/infrastructure/src/blob-storage-binding.ts';
import { blobBackupManifestSha256, exportBlobBackup, readBlobBackupManifest, restoreBlobBackup } from '../../../../packages/infrastructure/src/blob-storage-backup.ts';
import { exportLocalProjectCheckpoint, restoreLocalProjectCheckpoint, captureLocalProjectCheckpoint, localProjectCheckpointSha256, localProjectCheckpointSchema } from '../../../../packages/infrastructure/src/project-storage-checkpoint.ts';
import { readProjectLocation } from '../../../../packages/pm-core/project-locations.ts';
import { readStoredBlob } from '../../../../packages/infrastructure/src/project-blobs.ts';
import { registerRestoredBootstrap, validateBootstrapState } from './bootstrap.ts';
import { ensurePrivateDirectory } from '../private-state.mjs';
import { copyTree, hashFile, snapshotTree, treeManifestSchema, verifyTree } from './maintenance-files.ts';
import { LocalBlobStore } from '../../../../packages/infrastructure/src/blobs.ts';
import { verifyInventoryObjects } from '../../../../packages/infrastructure/src/blob-storage-inventory.ts';
import { assertBackupCompatibility, requireTrustedBackupSource, withPrivateMaintenanceDirectory } from '../maintenance-archive.mjs';
import { directoryIdentity } from '../../../../packages/pm-core/platform.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z.strictObject({
  operation: z.enum(['backup', 'restore', 'validate']), databaseUrl: z.string(), dataDir: z.string(),
  destination: z.string().optional(), source: z.string().optional(), postgresRoot: z.string(), serverRoot: z.string(),
  trustedSourceAcknowledged: z.boolean().optional(),
});
type Request = z.infer<typeof requestSchema>;
const manifestSchema = z.strictObject({
  format: z.literal('pm-agent-desktop-backup'), version: z.union([z.literal(1), z.literal(2)]), applicationVersion: z.string().min(1).optional(), createdAt: z.iso.datetime(), postgresMajor: z.literal(16),
  platform: z.enum(['win32', 'darwin', 'linux']),
  privateData: z.literal(true), bootstrap: z.unknown(), databaseDumpSha256: digest, coreManifestSha256: digest,
  blobManifestSha256: digest, files: localProjectCheckpointSchema, sourceChatRoot: z.string(),
  chatFiles: treeManifestSchema.nullable(), agentPresent: z.boolean(), agentManifestSha256: digest.nullable(),
  exclusions: z.array(z.string()),
});

async function exists(filename: string): Promise<boolean> {
  try { await lstat(filename); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function jsonFile(filename: string): Promise<unknown> {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64 * 1024 * 1024) throw new Error('Unsafe maintenance metadata.');
  return JSON.parse(await readFile(filename, 'utf8'));
}
async function writeJson(filename: string, data: unknown): Promise<void> {
  const file = await open(filename, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(data, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
}
async function command(executable: string, args: string[], environment: NodeJS.ProcessEnv, input?: unknown): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn(executable, args, { env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  let overflow = false;
  child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 128 * 1024) { overflow = true; child.kill(); } });
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.once('error', () => reject(new Error('A bundled maintenance executable could not start.')));
  child.once('close', code => code === 0 && !overflow ? resolve(output) : reject(new Error('A bundled maintenance command failed.')));
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  return promise;
}
function pgEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  const database = new URL(databaseUrl);
  if (database.protocol !== 'postgresql:' || database.hostname !== '127.0.0.1') throw new Error('Maintenance is limited to the owned loopback PostgreSQL instance.');
  return { ...process.env, PGHOST: database.hostname, PGPORT: database.port, PGUSER: decodeURIComponent(database.username),
    PGPASSWORD: decodeURIComponent(database.password), PGDATABASE: decodeURIComponent(database.pathname.slice(1)), PGCONNECT_TIMEOUT: '10' };
}
function pgCommand(request: Request, name: string): string { return join(request.postgresRoot, 'bin', name + (process.platform === 'win32' ? '.exe' : '')); }
async function agentMaintenance(request: Request, operation: 'backup' | 'restore', source: string, destination: string): Promise<void> {
  const entry = join(request.serverRoot, 'apps/server/agent/dist/desktop-agent-maintenance.mjs');
  await command(process.execPath, [entry], { ...process.env, PM_DESKTOP_MANAGED: '1' }, { operation, source, destination });
}
async function assertStopped(pool: Pool): Promise<void> {
  const result = await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()');
  if (result.rows[0]?.count !== 0) throw new Error('Application database clients are still connected. Stop the desktop before maintenance.');
}

async function createBackup(request: Request): Promise<void> {
  if (!request.destination) throw new Error('A new backup destination is required.');
  const destination = request.destination;
  if (await exists(destination)) throw new Error('Backup destination already exists.');
  const bootstrap = validateBootstrapState(await jsonFile(join(request.dataDir, 'bootstrap.json')));
  if (bootstrap.phase !== 'ready') throw new Error('Finish or recover first-run setup before backing up.');
  const pool = createPool(request.databaseUrl, 1);
  const cloneName = 'pm_desktop_backup_' + randomUUID().replaceAll('-', '');
  const cloneUrl = new URL(request.databaseUrl); cloneUrl.pathname = '/' + cloneName;
  let cloneCreated = false;
  let clone: Pool | undefined;
  const coreRoot = join(request.dataDir, 'pm-workspaces');
  const blobRoot = join(request.dataDir, 'blobs');
  const source = createBlobStore({ provider: 'local', root: blobRoot });
  try {
    await assertStopped(pool);
    await mkdir(destination, { mode: 0o700 });
    await ensurePrivateDirectory(destination, { newlyCreated: true });
    const files = await exportLocalProjectCheckpoint({ coreRoot, directory: join(destination, 'files'), stopped: true });
    const dump = join(destination, 'database.dump');
    await command(pgCommand(request, 'pg_dump'), ['--format=custom', '--no-owner', '--no-acl', '--file', dump], pgEnvironment(request.databaseUrl));
    await chmod(dump, 0o600);
    const databaseDumpSha256 = (await hashFile(dump)).sha256;
    // Inventory and attachment references must come from the frozen dump, not a later live SQL view.
    await pool.query(`CREATE DATABASE ${cloneName}`);
    cloneCreated = true;
    await command(pgCommand(request, 'pg_restore'), ['--exit-on-error', '--no-owner', '--no-acl', '--dbname', cloneName, dump], pgEnvironment(cloneUrl.toString()));
    clone = createPool(cloneUrl.toString(), 1);
    const locator = { provider: 'local' as const, root: blobRoot };
    const blobs = await exportBlobBackup({ pool: clone, source: { provider: source, locator }, directory: join(destination, 'blobs'),
      databaseDumpSha256, coreManifestSha256: files.manifestSha256, stopped: true,
      readObject: entry => readStoredBlob({ sql: clone!, legacy: bindBlobStore(clone!, locator, source), resolveProject: (workspaceId, projectId) => readProjectLocation(join(coreRoot, workspaceId), projectId) }, entry),
    });
    const sourceChatRoot = join(request.dataDir, 'chat-spaces');
    const chatFiles = await exists(sourceChatRoot) ? await snapshotTree(sourceChatRoot) : null;
    if (chatFiles) await copyTree(sourceChatRoot, join(destination, 'chat-spaces'), chatFiles);
    const agentRoot = join(request.dataDir, 'agent-data');
    const agentPresent = await exists(join(agentRoot, 'workspace.sqlite'));
    let agentManifestSha256: string | null = null;
    if (agentPresent) {
      await agentMaintenance(request, 'backup', agentRoot, join(destination, 'agent'));
      agentManifestSha256 = (await hashFile(join(destination, 'agent/manifest.json'))).sha256;
    } else if (await exists(agentRoot) && (await readdir(agentRoot)).length) throw new Error('Uninitialized Agent directory contains unclassified data.');
    if (localProjectCheckpointSha256(await captureLocalProjectCheckpoint(coreRoot)) !== files.manifestSha256) throw new Error('Project files changed during backup.');
    const applicationVersion = z.string().min(1).parse((await jsonFile(join(request.serverRoot, 'apps/desktop/package.json')) as { version?: unknown }).version);
    const manifest = manifestSchema.parse({ format: 'pm-agent-desktop-backup', version: 2, applicationVersion, createdAt: new Date().toISOString(), postgresMajor: 16, platform: process.platform,
      privateData: true, bootstrap, databaseDumpSha256, coreManifestSha256: files.manifestSha256, blobManifestSha256: blobs.manifestSha256,
      files: files.manifest, sourceChatRoot, chatFiles, agentPresent, agentManifestSha256,
      exclusions: ['External/global Provider CLI homes and process environment', 'External project source code and external document-source directories; PM-managed .pm data is included', 'Electron browser cookies, drafts/preferences and unknown-request journal (retain original desktop profile)', 'Rebuildable Agent caches; copied MCP authority is revoked by Agent backup'],
    });
    await writeJson(join(destination, 'desktop-backup.json'), manifest);
  } finally {
    source.close();
    await clone?.end();
    try { if (cloneCreated) await pool.query(`DROP DATABASE ${cloneName}`); }
    finally { await pool.end(); }
  }
}
async function validateBackup(request: Request): Promise<void> {
  if (!request.source) throw new Error('A completed backup is required.');
  if (request.destination) {
    const tree = await snapshotTree(request.source);
    await copyTree(request.source, request.destination, tree);
  }
  const source = request.destination ?? request.source;
  const manifest = manifestSchema.parse(await jsonFile(join(source, 'desktop-backup.json')));
  const version = z.string().min(1).parse((await jsonFile(join(request.serverRoot, 'apps/desktop/package.json')) as { version?: unknown }).version);
  assertBackupCompatibility(manifest, version);
  const bootstrap = validateBootstrapState(manifest.bootstrap);
  if (bootstrap.phase !== 'ready' || (await hashFile(join(source, 'database.dump'))).sha256 !== manifest.databaseDumpSha256) throw new Error('Backup database or setup metadata does not match.');
  if (manifest.version === 1 && manifest.applicationVersion !== undefined) throw new Error('Unexpected legacy backup version metadata.');
  if (localProjectCheckpointSha256(manifest.files) !== manifest.coreManifestSha256
    || localProjectCheckpointSha256(localProjectCheckpointSchema.parse(await jsonFile(join(source, 'files/manifest.json')))) !== manifest.coreManifestSha256) throw new Error('Backup project checkpoint differs.');
  const blobs = await readBlobBackupManifest(join(source, 'blobs'));
  if (blobBackupManifestSha256(blobs) !== manifest.blobManifestSha256 || blobs.databaseDumpSha256 !== manifest.databaseDumpSha256 || blobs.coreManifestSha256 !== manifest.coreManifestSha256) throw new Error('Backup attachment manifest differs.');
  const checkpointTree = {
    directories: ['core', 'projects', ...manifest.files.coreDirectories.map(path => `core/${path}`),
      ...manifest.files.projects.flatMap(project => [`projects/${project.storageId}`, ...project.directories.map(path => `projects/${project.storageId}/${path}`)])],
    files: [{ path: 'manifest.json', ...await hashFile(join(source, 'files/manifest.json')) },
      ...manifest.files.core.map(file => ({ ...file, path: `core/${file.path}` })),
      ...manifest.files.projects.flatMap(project => project.files.map(file => ({ ...file, path: `projects/${project.storageId}/${file.path}` })))],
  };
  await verifyTree(join(source, 'files'), checkpointTree);
  await verifyTree(join(source, 'blobs'), {
    directories: ['objects'], files: [{ path: 'manifest.json', ...await hashFile(join(source, 'blobs/manifest.json')) },
      ...blobs.entries.map(entry => ({ path: `objects/${entry.key}`, size: entry.size, sha256: entry.sha256 }))],
  });
  const store = new LocalBlobStore(join(source, 'blobs/objects'));
  try { await verifyInventoryObjects(store, blobs.entries); } finally { store.close(); }
  if (manifest.agentPresent && (!manifest.agentManifestSha256 || (await hashFile(join(source, 'agent/manifest.json'))).sha256 !== manifest.agentManifestSha256)) throw new Error('Backup Agent manifest differs.');
  await withPrivateMaintenanceDirectory(async (temporary: string) => {
    // Reuse real restorers for path, registry, credential and content validation.
    // These scratch copies never initialize the selected instance or any database.
    await command(pgCommand(request, 'pg_restore'), ['--list', '--file', join(temporary, 'dump-list'), join(source, 'database.dump')], process.env);
    await restoreLocalProjectCheckpoint({ directory: join(source, 'files'), manifest: manifest.files, expectedManifestSha256: manifest.coreManifestSha256,
      targetCoreRoot: join(temporary, 'core'), targetProjectsRoot: join(temporary, 'projects'), stopped: true });
    if (manifest.chatFiles) await copyTree(join(source, 'chat-spaces'), join(temporary, 'chat-spaces'), manifest.chatFiles);
    else if (await exists(join(source, 'chat-spaces'))) throw new Error('Unclassified chat files in backup.');
    if (manifest.agentPresent) await agentMaintenance(request, 'restore', join(source, 'agent'), join(temporary, 'agent'));
    else if (await exists(join(source, 'agent'))) throw new Error('Unclassified Agent files in backup.');
  });
  // Refuse unknown top-level content instead of silently dropping it on restore.
  const allowed = new Set(['desktop-backup.json', 'database.dump', 'files', 'blobs', ...(manifest.chatFiles ? ['chat-spaces'] : []), ...(manifest.agentPresent ? ['agent'] : [])]);
  if ((await readdir(source)).some(name => !allowed.has(name))) throw new Error('Backup contains unsupported data; nothing was discarded or restored.');
}


async function restoreBackup(request: Request): Promise<void> {
  requireTrustedBackupSource(request.trustedSourceAcknowledged);
  if (!request.source) throw new Error('A completed backup is required.');
  const source = request.source;
  const manifest = manifestSchema.parse(await jsonFile(join(source, 'desktop-backup.json')));
  const version = z.string().min(1).parse((await jsonFile(join(request.serverRoot, 'apps/desktop/package.json')) as { version?: unknown }).version);
  assertBackupCompatibility(manifest, version);
  const bootstrap = validateBootstrapState(manifest.bootstrap);
  const pool = createPool(request.databaseUrl, 1);
  const targetCoreRoot = join(request.dataDir, 'pm-workspaces');
  const targetProjectsRoot = join(request.dataDir, 'projects');
  const targetChatRoot = join(request.dataDir, 'chat-spaces');
  const blobRoot = join(request.dataDir, 'blobs');
  const target = createBlobStore({ provider: 'local', root: blobRoot });
  try {
    await assertStopped(pool);
    const existing = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    if (existing.rowCount) throw new Error('Restore database is not empty. Existing data was not changed.');
    await command(pgCommand(request, 'pg_restore'), ['--exit-on-error', '--no-owner', '--no-acl', '--dbname', decodeURIComponent(new URL(request.databaseUrl).pathname.slice(1)), join(source, 'database.dump')], pgEnvironment(request.databaseUrl));
    await migrate(pool);
    await restoreLocalProjectCheckpoint({ directory: join(source, 'files'), manifest: manifest.files, expectedManifestSha256: manifest.coreManifestSha256,
      targetCoreRoot, targetProjectsRoot, stopped: true });
    const binding = await readStorageBinding(pool);
    if (!binding) throw new Error('Backup has no active storage identity.');
    const storeId = randomUUID();
    await restoreBlobBackup({ pool, target: { provider: target, locator: { provider: 'local', root: blobRoot } }, directory: join(source, 'blobs'),
      expectedManifestSha256: manifest.blobManifestSha256, databaseDumpSha256: manifest.databaseDumpSha256, coreManifestSha256: manifest.coreManifestSha256,
      stopped: true, targetStoreId: storeId, expectedEpoch: binding.epoch, operationId: randomUUID() });
    if (manifest.chatFiles) await copyTree(join(source, 'chat-spaces'), targetChatRoot, manifest.chatFiles);
    else await mkdir(targetChatRoot, { mode: 0o700 });
    if (manifest.agentPresent) await agentMaintenance(request, 'restore', join(source, 'agent'), join(request.dataDir, 'agent-data'));
    else await mkdir(join(request.dataDir, 'agent-data'), { mode: 0o700 });
    // Default managed chat files have been copied. External execution directories
    // have not: pin those mappings to unavailable paths until explicitly relinked.
    const areas = await pool.query<{ workspace_id: string; project_key: string; path: string }>('SELECT workspace_id,project_key,path FROM agent_file_areas');
    for (const area of areas.rows) {
      const part = relative(manifest.sourceChatRoot, area.path);
      const internal = part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
      // A saved optional area may have disappeared or become a regular file
      // before backup. Only directories actually captured are eligible to rebind.
      const copied = internal && manifest.chatFiles !== null
        && (part === '' || manifest.chatFiles.directories.includes(part.split(sep).join('/')));
      const location = copied ? join(targetChatRoot, part) : join(request.dataDir, 'unrestored-areas', randomUUID());
      const identity = copied ? directoryIdentity(location) : null;
      await pool.query('UPDATE agent_file_areas SET path=$1,directory_device=$2,directory_inode=$3,revision=revision+1 WHERE workspace_id=$4 AND project_key=$5', [location, String(identity?.dev ?? 0), String(identity?.ino ?? 0), area.workspace_id, area.project_key]);
    }
    await pool.query('UPDATE agent_storage_settings SET default_root=$1,revision=revision+1', [targetChatRoot]);
    // External document directories are not part of this recovery set. Never
    // reactivate the source installation merely because its original path exists.
    await pool.query("UPDATE document_sources SET path=$1 || '/' || workspace_id::text || '/' || source_id,directory_device='0',directory_inode='0',revision=revision+1 WHERE path IS NOT NULL", [join(request.dataDir, 'unrestored-document-sources')]);
    await registerRestoredBootstrap({ databaseUrl: request.databaseUrl, dataDir: request.dataDir, source: bootstrap, storeId });
  } finally { target.close(); await pool.end(); }
}

async function main(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 128 * 1024) throw new Error('Maintenance request is too large.'); }
  const request = requestSchema.parse(JSON.parse(input));
  if (request.operation === 'backup') await createBackup(request);
  else if (request.operation === 'validate') await validateBackup(request);
  else await restoreBackup(request);
  console.log(JSON.stringify({ operation: request.operation, completed: true }));
}
main().catch(() => { console.error('Desktop recovery operation failed. Private details were not logged. Target cleanup does not roll back external SQL side effects.'); process.exitCode = 1; });
