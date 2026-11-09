import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from 'pg';
import { createPool } from '../../../../packages/infrastructure/src/database.ts';
import { LocalBlobStore } from '../../../../packages/infrastructure/src/blobs.ts';
import { login } from '../../../../packages/infrastructure/src/auth.ts';
import { readStorageBinding } from '../../../../packages/infrastructure/src/blob-storage-binding.ts';
import { blobBackupManifestSha256 } from '../../../../packages/infrastructure/src/blob-storage-backup.ts';
import { collectBlobInventory } from '../../../../packages/infrastructure/src/blob-storage-maintenance.ts';
import { readCurrentCore } from '../../../../packages/pm-core/readonly.ts';
import { ManagedPostgres } from '../managed-postgres.mjs';
import { backupDesktop, restoreDesktop } from '../maintenance.mjs';
import { decryptBackupDirectory, encryptBackupDirectory } from '../maintenance-archive.mjs';
import { ensurePrivateDirectory, readPrivateJson, securePrivateFile } from '../private-state.mjs';
import { bootstrapDesktop } from './bootstrap.ts';

const binariesDir = process.env.PM_DESKTOP_TEST_POSTGRES_ROOT;
const serverRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const backupPassword = 'independent encrypted desktop backup passphrase';

async function measured<T>(phase: string, operation: () => Promise<T>): Promise<T> {
  const start = performance.now();
  console.log(JSON.stringify({ scope: 'desktop-maintenance-regression', phase, status: 'start' }));
  try {
    const value = await operation();
    console.log(JSON.stringify({ scope: 'desktop-maintenance-regression', phase, status: 'end', elapsedMs: performance.now() - start }));
    return value;
  } catch (error) {
    console.log(JSON.stringify({ scope: 'desktop-maintenance-regression', phase, status: 'failure', elapsedMs: performance.now() - start }));
    throw error;
  }
}

async function rejectedMaintenance(input: Record<string, unknown>): Promise<{ phase: string; reason: string }> {
  const child = spawn(process.execPath, ['--conditions=development', join(serverRoot, 'apps/desktop/src/backend/maintenance.ts')], {
    cwd: serverRoot, env: { ...process.env, PM_DESKTOP_MANAGED: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 128 * 1024) child.kill(); });
  child.stderr.resume();
  child.stdin.on('error', () => {});
  const { promise, resolve, reject } = Promise.withResolvers<number | null>();
  child.once('error', () => reject(new Error('Maintenance regression child could not start.')));
  child.once('close', resolve);
  child.stdin.end(JSON.stringify(input));
  const code = await promise;
  assert.equal(code, 1);
  let result;
  try { result = JSON.parse(output); } catch { throw new Error('Maintenance regression returned no sanitized diagnostic.'); }
  assert.equal(result.completed, false);
  for (const privateValue of [input.databaseUrl, input.dataDir, input.destination]) {
    if (typeof privateValue === 'string' && privateValue) assert.equal(output.includes(privateValue), false, 'diagnostics must not expose private input');
  }
  return result.diagnostic;
}

// Real PostgreSQL, real PM bootstrap/storage/checkpoints and bundled Agent backup.
// Native runners must supply both the complete pinned runtime and built Agent dist.
// Linux execution is not Windows/macOS native or Electron GUI acceptance.
test('real encrypted desktop roundtrip preserves PM, blobs, chat and Agent; rejects unsafe restores before target initialization', { skip: !binariesDir, timeout: 1_200_000 }, async t => {
  const runtimeRoot = dirname(binariesDir!);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'desktop-full-encrypted-roundtrip-')));
  await ensurePrivateDirectory(root, { newlyCreated: true });
  const dataDir = join(root, 'source'), destination = join(root, 'encrypted-backup');
  const database = new ManagedPostgres({ dataDir, binariesDir: binariesDir! });
  const databases = [database];
  t.after(async () => { for (const pg of databases) await pg.stop(); await rm(root, { recursive: true, force: true }); });
  assert.equal((await lstat(join(serverRoot, 'apps/server/agent/dist/desktop-agent-maintenance.mjs'))).isFile(), true, 'Build the Agent desktop maintenance entry before this real regression.');
  const started = await database.start();
  const setup = { email: 'backup-roundtrip@example.invalid', password: `login-${randomUUID()}`, name: 'Backup User', workspaceName: 'Backup Workspace' };
  const initialized = await bootstrapDesktop({ databaseUrl: started.databaseUrl, dataDir, projectRoot: join(dataDir, 'projects'), setup });
  const core = readCurrentCore(join(dataDir, 'pm-workspaces', initialized.workspaceId)).files.map(file => ({ id: file.id, raw: file.raw }));
  const chatRoot = join(dataDir, 'chat-spaces');
  const availableArea = join(chatRoot, 'available');
  const missingArea = join(chatRoot, 'deleted-after-registration');
  await ensurePrivateDirectory(chatRoot);
  await ensurePrivateDirectory(availableArea);
  await mkdir(missingArea, { mode: 0o700 });
  const availableIdentity = await lstat(availableArea, { bigint: true });
  const missingIdentity = await lstat(missingArea, { bigint: true });
  await rm(missingArea, { recursive: true });
  await writeFile(join(chatRoot, 'private-chat.txt'), 'managed chat file survives', { mode: 0o600 });
  const pool = createPool(started.databaseUrl, 1);
  const blobs = new LocalBlobStore(join(dataDir, 'blobs'));
  const attachment = Buffer.from([0, 255, 128, 42, 9]);
  const blob = await blobs.put(attachment);
  const uploadId = randomUUID();
  let sourceBinding;
  try {
    sourceBinding = await readStorageBinding(pool);
    await pool.query('CREATE TABLE desktop_backup_probe(id integer PRIMARY KEY, payload jsonb NOT NULL)');
    await pool.query('INSERT INTO desktop_backup_probe VALUES (1,$1::jsonb)', [JSON.stringify({ note: 'database content survives' })]);
    // The established expired-upload fixture deliberately remains part of the
    // real application inventory even though the upload is no longer active.
    await pool.query("INSERT INTO entities(id,workspace_id,project_id,kind,data,created_by) VALUES($1,$2,'PRJ-001','upload',$3,$4)", [
      uploadId, initialized.workspaceId, { objectKey: blob.key, sha256: blob.sha256, size: blob.size, ownerId: initialized.userId,
        expiresAt: '2000-01-01T00:00:00.000Z', consumedAt: null, consumedByArtifactVersionId: null, fileName: 'retained.bin', mediaType: 'application/octet-stream' }, initialized.userId,
    ]);
    assert.equal((await collectBlobInventory(pool)).some(entry => entry.key === blob.key && entry.sha256 === blob.sha256 && entry.size === attachment.length), true);
    for (const [projectKey, path, identity] of [['', missingArea, missingIdentity], ['PRJ-001', availableArea, availableIdentity]] as const) {
      await pool.query(`INSERT INTO agent_file_areas(workspace_id,project_key,path,directory_device,directory_inode,revision,updated_by,source)
        VALUES($1,$2,$3,$4,$5,7,$6,'explicit') ON CONFLICT(workspace_id,project_key) DO UPDATE SET
        path=EXCLUDED.path,directory_device=EXCLUDED.directory_device,directory_inode=EXCLUDED.directory_inode,revision=7,updated_by=EXCLUDED.updated_by,source='explicit'`,
      [initialized.workspaceId, projectKey, path, String(identity.dev), String(identity.ino), initialized.userId]);
    }
  } finally { blobs.close(); await pool.end(); }
  const agentRoot = join(dataDir, 'agent-data'); await ensurePrivateDirectory(agentRoot);
  const agent = new DatabaseSync(join(agentRoot, 'workspace.sqlite'));
  try {
    agent.exec('CREATE TABLE records(namespace TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(namespace,key)); CREATE TABLE run_events(run_id TEXT NOT NULL,seq INTEGER NOT NULL,event TEXT NOT NULL,PRIMARY KEY(run_id,seq)); CREATE TABLE worker_owner(singleton INTEGER PRIMARY KEY,pid INTEGER NOT NULL,token TEXT NOT NULL)');
    agent.prepare('INSERT INTO records VALUES (?,?,?)').run('chat:history', 'history-a', JSON.stringify({ threadId: 'thread-a', format: 'ai-sdk/v6', messages: [{ id: 'message-a', content: { role: 'user', parts: [{ type: 'text', text: 'Agent private conversation survives' }] } }], headId: 'message-a', authoritativeIds: ['message-a'] }));
  } finally { agent.close(); }
  await securePrivateFile(join(agentRoot, 'workspace.sqlite'), { newlyCreated: true });
  await writeFile(join(agentRoot, 'providers.json'), '{"version":1,"providers":{"synthetic":{"apiKey":"synthetic-credential-retained"}}}', { mode: 0o600 });
  await securePrivateFile(join(agentRoot, 'providers.json'), { newlyCreated: true });
  await t.test('maintenance rejects foreign clients even with the monitor name and rejects stale monitor identities', async () => {
    const monitor = await database.maintenanceMonitorIdentity();
    const refusedDestination = join(root, 'active-client-backup');
    const request = { operation: 'backup', databaseUrl: started.databaseUrl, dataDir, destination: refusedDestination, postgresRoot: binariesDir!, serverRoot, monitor };
    const foreign = new Client({ connectionString: started.databaseUrl, application_name: 'pm-desktop-owner' });
    await foreign.connect();
    try {
      const diagnostic = await rejectedMaintenance(request);
      assert.equal(diagnostic.phase, 'stopped-clients');
      assert.equal(diagnostic.reason, 'active-clients');
      assert.equal((await foreign.query('SELECT 1 AS retained')).rows[0].retained, 1, 'maintenance must not terminate a foreign connection');
      await assert.rejects(lstat(refusedDestination), { code: 'ENOENT' });
    } finally { await foreign.end(); }
    if (monitor) {
      const stale = await rejectedMaintenance({ ...request, monitor: { ...monitor, backendStart: '1970-01-01T00:00:00Z' } });
      assert.equal(stale.reason, 'monitor-mismatch');
      const absent = await rejectedMaintenance({ ...request, monitor: undefined });
      assert.equal(absent.reason, 'active-clients');
      await assert.rejects(lstat(refusedDestination), { code: 'ENOENT' });
    }
  });
  await measured('stop-source', () => database.stop());
  const options = { serverRoot, runtimeRoot, trustedSourceAcknowledged: true };
  const backedUp = await measured('backup', () => backupDesktop({ ...options, dataDir, destination, password: backupPassword }));
  assert.equal(backedUp.encrypted, true);
  assert.deepEqual(await readdir(destination), ['desktop-backup.enc']);
  const encrypted = await readFile(join(destination, 'desktop-backup.enc'));
  for (const secret of [backupPassword, setup.password, 'synthetic-credential-retained', 'Agent private conversation survives']) assert.equal(encrypted.includes(Buffer.from(secret)), false);
  const denied = join(root, 'denied');
  await assert.rejects(restoreDesktop({ ...options, source: destination, dataDir: denied, password: backupPassword, trustedSourceAcknowledged: false }), { code: 'DESKTOP_RESTORE_TRUST_REQUIRED' });
  await assert.rejects(lstat(denied), { code: 'ENOENT' });
  await assert.rejects(restoreDesktop({ ...options, source: destination, dataDir: denied, password: 'incorrect password' }));
  await assert.rejects(lstat(denied), { code: 'ENOENT' });
  const changed = Buffer.from(encrypted); changed[changed.length - 1]! ^= 1;
  await writeFile(join(destination, 'desktop-backup.enc'), changed);
  await assert.rejects(restoreDesktop({ ...options, source: destination, dataDir: denied, password: backupPassword }));
  await assert.rejects(lstat(denied), { code: 'ENOENT' });
  await writeFile(join(destination, 'desktop-backup.enc'), encrypted);
  const restoredDir = join(root, 'restored');
  const result = await measured('restore', () => restoreDesktop({ ...options, source: destination, dataDir: restoredDir, password: backupPassword }));
  assert.equal(result.projectRoot, join(restoredDir, 'projects'));
  assert.equal(await readFile(join(restoredDir, 'chat-spaces/private-chat.txt'), 'utf8'), 'managed chat file survives');
  assert.deepEqual(readCurrentCore(join(restoredDir, 'pm-workspaces', initialized.workspaceId)).files.map(file => ({ id: file.id, raw: file.raw })), core);
  const restoredAgent = new DatabaseSync(join(restoredDir, 'agent-data/workspace.sqlite'), { readOnly: true });
  try { assert.match(String(restoredAgent.prepare('SELECT value FROM records WHERE namespace=? AND key=?').get('chat:history', 'history-a')?.value), /Agent private conversation survives/); }
  finally { restoredAgent.close(); }
  assert.match(await readFile(join(restoredDir, 'agent-data/providers.json'), 'utf8'), /synthetic-credential-retained/);
  const restoredDatabase = new ManagedPostgres({ dataDir: restoredDir, binariesDir: binariesDir! }); databases.push(restoredDatabase);
  const restoredStarted = await restoredDatabase.start();
  const restoredPool = createPool(restoredStarted.databaseUrl, 1);
  try {
    assert.equal((await login(restoredPool, { email: setup.email, password: setup.password })).actor.id, initialized.userId);
    assert.equal((await restoredPool.query('SELECT payload FROM desktop_backup_probe WHERE id=1')).rows[0].payload.note, 'database content survives');
    assert.equal((await restoredPool.query('SELECT data FROM entities WHERE id=$1', [uploadId])).rows[0].data.objectKey, blob.key);
    const areas = (await restoredPool.query('SELECT project_key,path,directory_device,directory_inode,revision FROM agent_file_areas WHERE workspace_id=$1', [initialized.workspaceId])).rows;
    const unavailable = areas.find(row => row.project_key === '');
    assert.equal(dirname(unavailable.path), join(restoredDir, 'unrestored-areas'));
    assert.equal(unavailable.directory_device, '0'); assert.equal(unavailable.directory_inode, '0');
    assert.equal(unavailable.revision, 8);
    await assert.rejects(lstat(unavailable.path), { code: 'ENOENT' });
    const available = areas.find(row => row.project_key === 'PRJ-001');
    const restoredIdentity = await lstat(join(restoredDir, 'chat-spaces/available'), { bigint: true });
    assert.equal(available.path, join(restoredDir, 'chat-spaces/available'));
    assert.equal(available.directory_device, String(restoredIdentity.dev)); assert.equal(available.directory_inode, String(restoredIdentity.ino));
    assert.equal(available.revision, 8);
    const restoredBinding = await readStorageBinding(restoredPool);
    assert.notEqual(restoredBinding?.storeId, sourceBinding?.storeId);
  } finally { await restoredPool.end(); await restoredDatabase.stop(); }
  const restoredBlobs = new LocalBlobStore(join(restoredDir, 'blobs'));
  try { assert.deepEqual(await restoredBlobs.read(blob.key), attachment); } finally { restoredBlobs.close(); }
  const restoredBootstrap = await readPrivateJson(join(restoredDir, 'bootstrap.json'));
  assert.notEqual(restoredBootstrap.instanceId, started.instanceId);
  assert.equal(JSON.stringify(restoredBootstrap).includes(backupPassword), false);
  assert.equal(JSON.stringify(restoredBootstrap).includes(setup.password), false);
  await assert.rejects(restoreDesktop({ ...options, source: destination, dataDir: restoredDir, password: backupPassword }));
  assert.deepEqual(await readPrivateJson(join(restoredDir, 'bootstrap.json')), restoredBootstrap);
  assert.equal(await readFile(join(restoredDir, 'chat-spaces/private-chat.txt'), 'utf8'), 'managed chat file survives');
  const plaintext = join(root, 'plaintext');
  await measured('decrypt-fixture', () => decryptBackupDirectory(join(destination, 'desktop-backup.enc'), plaintext, backupPassword));
  const manifestPath = join(plaintext, 'desktop-backup.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const [label, change] of [
    ['application-version', { applicationVersion: '999.0.0' }],
    ['operating-system', { platform: process.platform === 'win32' ? 'darwin' : 'win32' }],
    ['format-version', { version: 999 }],
    ['legacy-container-downgrade', { version: 1, applicationVersion: undefined }],
  ] as const) {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, ...change }), { mode: 0o600 });
    const incompatible = join(root, label); await mkdir(incompatible);
    await measured(`encrypt-${label}`, () => encryptBackupDirectory(plaintext, join(incompatible, 'desktop-backup.enc'), backupPassword));
    await measured(`reject-${label}`, () => assert.rejects(restoreDesktop({ ...options, source: incompatible, dataDir: denied, password: backupPassword })));
    await assert.rejects(lstat(denied), { code: 'ENOENT' });
  }
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  await writeFile(join(plaintext, 'unclassified-private-data'), 'must not silently disappear', { mode: 0o600 });
  const malformed = join(root, 'malformed'); await mkdir(malformed);
  await measured('encrypt-unclassified', () => encryptBackupDirectory(plaintext, join(malformed, 'desktop-backup.enc'), backupPassword));
  await measured('reject-unclassified', () => assert.rejects(restoreDesktop({ ...options, source: malformed, dataDir: denied, password: backupPassword })));
  await assert.rejects(lstat(denied), { code: 'ENOENT' });
  await rm(join(plaintext, 'unclassified-private-data'));
  // Make an internally authenticated, filesystem-valid backup whose attachment
  // inventory disagrees with the real dump. Detection requires restored SQL;
  // failure must roll the newly initialized destination back to an empty folder.
  const blobManifestPath = join(plaintext, 'blobs/manifest.json');
  const blobManifest = JSON.parse(await readFile(blobManifestPath, 'utf8'));
  const inconsistentBlobs = { ...blobManifest, entries: [] };
  await writeFile(blobManifestPath, JSON.stringify(inconsistentBlobs), { mode: 0o600 });
  await rm(join(plaintext, 'blobs/objects', blob.key));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, blobManifestSha256: blobBackupManifestSha256(inconsistentBlobs) }), { mode: 0o600 });
  const inconsistent = join(root, 'sql-inconsistent'); await mkdir(inconsistent);
  await measured('encrypt-sql-inconsistent', () => encryptBackupDirectory(plaintext, join(inconsistent, 'desktop-backup.enc'), backupPassword));
  await ensurePrivateDirectory(denied);
  await measured('reject-sql-inconsistent', () => assert.rejects(restoreDesktop({ ...options, source: inconsistent, dataDir: denied, password: backupPassword })));
  assert.deepEqual(await readdir(denied), [], 'failed restore must not leave PostgreSQL ownership, data or a ready bootstrap');
  await rm(denied, { recursive: true });
  await writeFile(blobManifestPath, JSON.stringify(blobManifest), { mode: 0o600 });
  await writeFile(join(plaintext, 'blobs/objects', blob.key), attachment, { mode: 0o600 });
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const { applicationVersion: _applicationVersion, ...legacy } = manifest;
  await writeFile(manifestPath, JSON.stringify({ ...legacy, version: 1 }), { mode: 0o600 });
  await assert.rejects(restoreDesktop({ ...options, source: plaintext, dataDir: denied }));
  await assert.rejects(lstat(denied), { code: 'ENOENT' });
  const legacyTarget = join(root, 'legacy-restored');
  await measured('legacy-restore', () => restoreDesktop({ ...options, source: plaintext, dataDir: legacyTarget, allowLegacyUnencrypted: true }));
  assert.equal(await readFile(join(legacyTarget, 'chat-spaces/private-chat.txt'), 'utf8'), 'managed chat file survives');
  assert.equal((await readPrivateJson(join(legacyTarget, 'bootstrap.json'))).phase, 'ready');
});
