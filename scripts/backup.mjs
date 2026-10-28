import { execFile, spawn } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { open, mkdir, mkdtemp, rm, lstat } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp } from '../apps/api/src/app.ts';
import { createUser } from '../packages/infrastructure/src/auth.ts';
import { createPool } from '../packages/infrastructure/src/database.ts';
import { readBlobStoreConfig, blobStorageLocator } from '../packages/infrastructure/src/blob-storage-config.ts';
import { createBlobStore } from '../packages/infrastructure/src/blob-storage-provider.ts';
import { readStorageBinding, bindBlobStore } from '../packages/infrastructure/src/blob-storage-binding.ts';
import { exportBlobBackup, restoreBlobBackup } from '../packages/infrastructure/src/blob-storage-backup.ts';
import { hashCheckpointFile } from '../packages/infrastructure/src/blob-storage-checkpoint.ts';
import { Workspace } from '../packages/pm-core/index.ts';
import { DomainError } from '../packages/domain/src/core.ts';
import { runtimeConfig } from '../packages/infrastructure/src/runtime-config.ts';
import { exportLocalProjectCheckpoint, restoreLocalProjectCheckpoint, captureLocalProjectCheckpoint, localProjectCheckpointSha256 } from '../packages/infrastructure/src/project-storage-checkpoint.ts';
import { readProjectLocation } from '../packages/pm-core/project-locations.ts';
import { readStoredBlob } from '../packages/infrastructure/src/project-blobs.ts';

const exec = promisify(execFile);
async function dockerWithFiles(args, stdio) {
  const child = spawn('docker', args, { stdio });
  child.stderr.resume();
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('PostgreSQL checkpoint command failed')));
  });
}
async function main() {
  const { values } = parseArgs({ strict: true, options: { stopped: { type: 'boolean' }, verify: { type: 'boolean' } } });
  if (!values.stopped) throw new Error('--stopped must attest API, Worker and every external Markdown writer are stopped');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const database = new URL(process.env.DATABASE_URL);
  if (database.hostname !== '127.0.0.1' || database.port !== (process.env.POSTGRES_PORT ?? '55443') || database.pathname !== '/project_management' || database.username !== 'project_management' || database.search) throw new Error('Only the dedicated local PostgreSQL public schema is supported');
  const container = process.env.PM_BACKUP_POSTGRES_CONTAINER ?? (await exec('docker', ['compose', '--env-file', '.env', '-f', 'deploy/compose.yaml', 'ps', '-q', 'postgres'])).stdout.trim();
  if (!/^[a-f0-9]{12,64}$/.test(container)) throw new Error('A single explicit PostgreSQL container is required');
  const ports = JSON.parse((await exec('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', container])).stdout);
  if (!ports?.['5432/tcp']?.some(port => port.HostIp === '127.0.0.1' && port.HostPort === database.port)) throw new Error('Container does not own the configured local PostgreSQL port');
  const pg = ['exec', container];
  const clients = (await exec('docker', [...pg, 'psql', '-U', 'project_management', '-d', 'project_management', '-At', '-c', "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='project-management' AND pid<>pg_backend_pid()"])).stdout.trim();
  if (clients !== '0') throw new Error('Application database clients are still connected; no service was stopped automatically');

  const sourceConfig = readBlobStoreConfig();
  const sourceLocator = blobStorageLocator(sourceConfig);
  if (!sourceLocator) throw new Error('Disabled storage cannot produce a recovery set');
  const source = createBlobStore(sourceConfig);
  const runtime = runtimeConfig();
  const directory = path.join(runtime.localProjects.backupRoot, new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID());
  const dumpPath = path.join(directory, 'database.dump');
  const coreRoot = runtime.coreWorkspaceRoot;
  const filesDirectory = path.join(directory, 'files');
  const restoredName = 'pm_backup_inventory_' + randomUUID().replaceAll('-', '');
  const restoredUrl = new URL(database); restoredUrl.pathname = '/' + restoredName;
  let created = false;
  let pool;
  let app;
  let verificationRoot;
  let target;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const checkpoint = await exportLocalProjectCheckpoint({ coreRoot, directory: filesDirectory, stopped: true });
    const dump = await open(dumpPath, 'wx', 0o600);
    try {
      await dockerWithFiles([...pg, 'pg_dump', '-U', 'project_management', '-d', 'project_management', '--schema=public', '-Fc'], ['ignore', dump.fd, 'pipe']);
      await dump.sync();
    } finally { await dump.close(); }
    const coreManifestSha256 = checkpoint.manifestSha256;
    if (localProjectCheckpointSha256(await captureLocalProjectCheckpoint(coreRoot)) !== coreManifestSha256) throw new Error('Project roots changed during the stopped dump');
    const databaseDumpSha256 = (await hashCheckpointFile(dumpPath)).sha256;

    // Inventory always comes from the stopped dump, never a later live SQL view.
    await exec('docker', [...pg, 'createdb', '-U', 'project_management', restoredName]);
    created = true;
    const input = await open(dumpPath, 'r');
    try {
      // Cleaning is confined to the random database just created above, never the source.
      await dockerWithFiles(['exec', '-i', container, 'pg_restore', '-U', 'project_management', '-d', restoredName, '--exit-on-error', '--no-owner', '--clean', '--if-exists'], [input.fd, 'ignore', 'pipe']);
    } finally { await input.close(); }
    pool = createPool(restoredUrl.toString());
    const binding = await readStorageBinding(pool);
    if (binding?.state !== 'active') throw new Error('Backup requires the original active storage binding');
    const blobsDirectory = path.join(directory, 'blobs');
    const backup = await exportBlobBackup({ pool, source: { provider: source, locator: sourceLocator }, directory: blobsDirectory, databaseDumpSha256, coreManifestSha256, stopped: true, readObject: entry => readStoredBlob({ sql: pool, legacy: bindBlobStore(pool, sourceLocator, source), resolveProject: (workspaceId, projectId) => readProjectLocation(path.join(coreRoot, workspaceId), projectId) }, entry) });
    const report = { formatVersion: 3, createdAt: new Date().toISOString(), directory, databaseSchema: 'public', databaseDumpSha256, coreManifestSha256, blobManifestSha256: backup.manifestSha256, sourceBinding: backup.manifest.source, objects: backup.manifest.entries.length, coreFiles: checkpoint.manifest.core.length, projectRoots: checkpoint.manifest.projects.length, verification: null };

    if (values.verify) {
      verificationRoot = await mkdtemp(path.join(tmpdir(), 'pm-backup-verify-'));
      const targetCore = path.join(verificationRoot, 'core');
      const targetBlobRoot = path.join(verificationRoot, 'blobs');
      await restoreLocalProjectCheckpoint({ directory: filesDirectory, manifest: checkpoint.manifest, expectedManifestSha256: coreManifestSha256, targetCoreRoot: targetCore, targetProjectsRoot: path.join(verificationRoot, 'projects'), stopped: true });
      target = createBlobStore({ provider: 'local', root: targetBlobRoot });
      const targetLocator = { provider: 'local', root: targetBlobRoot };
      const restoredBinding = await restoreBlobBackup({ pool, target: { provider: target, locator: targetLocator }, directory: blobsDirectory, expectedManifestSha256: backup.manifestSha256, databaseDumpSha256, coreManifestSha256, stopped: true, targetStoreId: randomUUID(), expectedEpoch: binding.epoch, operationId: randomUUID() });
      const workspaces = await pool.query('SELECT id FROM workspaces ORDER BY id');
      const coreWorkspaces = [];
      const readableProjects = new Map();
      process.env.CHOKIDAR_USEPOLLING ??= 'true';
      for (const { id } of workspaces.rows) {
        const root = path.join(targetCore, id);
        if (!(await lstat(root)).isDirectory()) throw new Error('Restored workspace core is missing');
        const workspace = new Workspace(root);
        try {
          await workspace.init();
          const snapshot = workspace.snapshot();
          if (snapshot.errors.length) throw new Error('Restored authoritative core has validation errors');
          readableProjects.set(id, new Set(snapshot.files.filter(file => file.entity.entity === 'project').map(file => file.id)));
          coreWorkspaces.push({ id, files: snapshot.files.length, unsupported: snapshot.unsupportedFiles.length, errors: snapshot.errors.length });
        } finally { await workspace.close(); }
      }
      const password = randomBytes(32).toString('base64url');
      const reader = await createUser(pool, { email: `backup-${randomUUID()}@example.test`, name: 'Isolated backup verifier', password });
      await pool.query("INSERT INTO memberships(workspace_id,user_id,capabilities,project_ids) SELECT id,$1,ARRAY['domain.read']::text[],NULL FROM workspaces", [reader.id]);
      app = buildApp({ databaseUrl: restoredUrl.toString(), blobStore: target, blobStorageLocator: targetLocator, coreWorkspaceRoot: targetCore });
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      const login = await fetch(`${origin}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: reader.email, password }), signal: AbortSignal.timeout(20_000) });
      const cookie = login.headers.get('set-cookie')?.split(';')[0];
      if (!login.ok || !cookie) throw new Error('Restored API authentication failed');
      const versions = await pool.query("SELECT id,workspace_id,project_id,data->>'sha256' AS sha256,(data->>'size')::bigint AS size FROM entities WHERE kind='artifact_version' ORDER BY id");
      let httpVerifiedArtifacts = 0;
      let notCurrentlyReadableArtifacts = 0;
      for (const version of versions.rows) {
        if (!readableProjects.get(version.workspace_id)?.has(version.project_id)) { notCurrentlyReadableArtifacts++; continue; }
        const url = `${origin}/api/v1/workspaces/${version.workspace_id}/artifact-versions/${version.id}/content`;
        const anonymous = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (anonymous.status !== 401) throw new Error('Restored content bypasses authentication');
        const response = await fetch(url, { headers: { cookie }, signal: AbortSignal.timeout(20_000) });
        if (!response.ok || response.headers.get('content-type') !== 'application/octet-stream') throw new Error('Restored authorized download failed');
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length !== Number(version.size) || createHash('sha256').update(bytes).digest('hex') !== version.sha256) throw new Error('Restored HTTP content differs from the frozen SQL reference');
        httpVerifiedArtifacts++;
      }
      report.verification = { status: 'passed', restoredIntoIsolatedDatabase: true, restoredIntoNewBlobAndCoreRoots: true, storageEpoch: restoredBinding.epoch, httpVerifiedArtifacts, notCurrentlyReadableArtifacts, coreWorkspaces, outboundServicesFenced: true, productionCredentialPolicyApproved: false };
    }
    if (localProjectCheckpointSha256(await captureLocalProjectCheckpoint(coreRoot)) !== coreManifestSha256) throw new Error('Source roots changed during the stopped backup');
    const file = await open(path.join(directory, 'manifest.json'), 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(report, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    console.log(JSON.stringify(report));
  } finally {
    try { await app?.close(); }
    finally {
      try { target?.close(); source.close(); await pool?.end(); }
      finally {
        try { if (created) await exec('docker', [...pg, 'dropdb', '-U', 'project_management', restoredName]); }
        finally { if (verificationRoot) await rm(verificationRoot, { recursive: true, force: true }); }
      }
    }
  }
}
try { await main(); }
catch (error) { console.error(JSON.stringify({ error: error instanceof DomainError ? error.code : 'backup_failed', message: 'Backup or isolated verification failed; no source services were stopped or source database modified.' })); process.exitCode = 1; }
