import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test, { type TestContext } from 'node:test';
import { createPool } from '../../../../packages/infrastructure/src/database.ts';
import { login } from '../../../../packages/infrastructure/src/auth.ts';
import { completeInstanceSetup } from '../../../../packages/application/src/instance-setup.ts';
import { ManagedPostgres } from '../managed-postgres.mjs';
import { readPrivateJson, writePrivateJson } from '../private-state.mjs';
import { bootstrapDesktop, validateBootstrapState } from './bootstrap.ts';
import { readCurrentCore } from '../../../../packages/pm-core/readonly.ts';
import { getWindowsPathAttributeMetrics } from '../../../../packages/pm-core/windows-reparse.ts';

const binariesDir = process.env.PM_DESKTOP_TEST_POSTGRES_ROOT;
const setup = { email: 'desktop-smoke@example.invalid', password: `desktop-test-${randomUUID()}`, name: 'Desktop Test', workspaceName: 'Desktop Workspace' };
const fixture = () => ({ formatVersion: 1, instanceId: randomUUID(), phase: 'ready', storeId: randomUUID(), operationId: randomUUID(), email: setup.email, name: setup.name, workspaceName: setup.workspaceName, userId: randomUUID(), workspaceId: randomUUID() });

async function completeSetup(databaseUrl: string, dataDir: string, projectRoot: string) {
  const token = (await readPrivateJson(join(dataDir, 'setup-token.json'), 1024)) as { token: string };
  const sample = { coreRoot: join(dataDir, 'pm-workspaces'), localProjects: { enabled: true, dataRoot: dataDir, defaultParent: projectRoot, allowedRoots: [projectRoot], backupRoot: join(dataDir, 'backups'), coreRoot: join(dataDir, 'pm-workspaces') } };
  const pool = createPool(databaseUrl, 2);
  try { return await completeInstanceSetup(pool, { setupToken: token.token, ...setup }, { sample }); }
  finally { await pool.end(); }
}

async function observedBootstrap(t: TestContext, phase: string, options: Parameters<typeof bootstrapDesktop>[0]) {
  const before = getWindowsPathAttributeMetrics(), started = performance.now();
  let completed = false;
  t.diagnostic(JSON.stringify({ scope: 'desktop-bootstrap', phase, status: 'start' }));
  try {
    const result = await bootstrapDesktop(options);
    completed = true;
    return result;
  } finally {
    const after = getWindowsPathAttributeMetrics();
    const delta = Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - before[key as keyof typeof before]]));
    t.diagnostic(JSON.stringify({ scope: 'desktop-bootstrap', phase, status: completed ? 'end' : 'error', elapsedMs: performance.now() - started, ...delta }));
  }
}

test('bootstrap metadata is strict, complete and never persists the initial password', () => {
  const state = fixture();
  assert.equal(validateBootstrapState(state).phase, 'ready');
  assert.throws(() => validateBootstrapState({ ...state, password: setup.password }));
  assert.throws(() => validateBootstrapState({ ...state, userId: null }));
  assert.throws(() => validateBootstrapState({ ...state, workspaceId: 'foreign' }));
  const pending = validateBootstrapState({ ...state, phase: 'pending', userId: null, workspaceId: null, email: null, name: null, workspaceName: null });
  assert.equal(pending.phase, 'pending');
  assert.throws(() => validateBootstrapState({ ...state, name: null }));
});

// Windows CI includes PostgreSQL start/restart plus three complete bootstraps in one
// test; the fresh phase alone has measured ~164s. Production has no wall-clock
// bootstrap cutoff, so this test budget must not encode one.
test('real desktop bootstrap recovers every durable account/workspace boundary without password resets or duplicates', { skip: !binariesDir, timeout: 300_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pm-desktop-bootstrap-')));
  const dataDir = join(root, 'instance');
  const pg = new ManagedPostgres({ dataDir, binariesDir: binariesDir! });
  t.after(async () => { await pg.stop(); await rm(root, { recursive: true, force: true }); });
  const started = await pg.start();
  let result = await observedBootstrap(t, 'prepare', { databaseUrl: started.databaseUrl, dataDir, projectRoot: join(dataDir, 'projects') });
  assert.equal(result.phase, 'pending');
  await completeSetup(started.databaseUrl, dataDir, join(dataDir, 'projects'));
  result = await observedBootstrap(t, 'finalize', { databaseUrl: started.databaseUrl, dataDir, projectRoot: join(dataDir, 'projects') });
  assert.equal(result.phase, 'ready');
  if (result.phase !== 'ready') throw new Error('Expected finalized desktop bootstrap');
  assert.equal(result.initialized, true);
  const first = { ...result };
  const sample = readCurrentCore(join(dataDir, 'pm-workspaces', first.workspaceId)).files.map(file => ({ id: file.id, raw: file.raw }));
  assert.equal(sample.length, 27);
  const pool = createPool(started.databaseUrl, 3);
  let poolOpen = true;
  try {
    const initial = (await pool.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=$1', [first.userId])).rows[0]!.password_hash;
    const loggedIn = await login(pool, { email: setup.email, password: setup.password });
    assert.equal(loggedIn.actor.id, first.userId);
    assert.equal((await pool.query('SELECT 1 FROM memberships WHERE user_id=$1 AND workspace_id=$2', [first.userId, first.workspaceId])).rowCount, 1);
    const ready = validateBootstrapState(await readPrivateJson(join(dataDir, 'bootstrap.json')));
    assert.equal(JSON.stringify(ready).includes(setup.password), false);
    // These durable facts are the state left after createUser/createWorkspace commit,
    // but before their subsequent metadata write. No production fault hook is needed.
    await pool.query('UPDATE desktop_bootstrap SET user_id=NULL,workspace_id=NULL WHERE singleton=true');
    await writePrivateJson(join(dataDir, 'bootstrap.json'), { ...ready, phase: 'pending', userId: null, workspaceId: null });
    result = await observedBootstrap(t, 'recover-account-workspace', { databaseUrl: started.databaseUrl, dataDir, projectRoot: join(dataDir, 'projects') });
    assert.equal(result.phase, 'ready');
    if (result.phase !== 'ready') throw new Error('Expected adopted desktop bootstrap');
    assert.equal(result.userId, first.userId);
    assert.equal(result.workspaceId, first.workspaceId);
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM users')).rows[0].count, 1);
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM workspaces')).rows[0].count, 1);
    assert.equal((await pool.query('SELECT password_hash FROM users WHERE id=$1', [first.userId])).rows[0].password_hash, initial);
    assert.deepEqual(readCurrentCore(join(dataDir, 'pm-workspaces', first.workspaceId)).files.map(file => ({ id: file.id, raw: file.raw })), sample);
    await pool.end();
    poolOpen = false;
    await pg.stop();
    const restarted = await pg.start();
    result = await observedBootstrap(t, 'restart', { databaseUrl: restarted.databaseUrl, dataDir, projectRoot: join(dataDir, 'projects') });
    assert.equal(result.phase, 'ready');
    if (result.phase !== 'ready') throw new Error('Expected ready desktop bootstrap after restart');
    assert.equal(result.initialized, false);
    assert.equal(result.userId, first.userId);
    assert.equal(result.workspaceId, first.workspaceId);
  } finally { if (poolOpen) await pool.end(); }
});

test('real desktop bootstrap rejects missing blob markers and missing restore registration without reinitializing', { skip: !binariesDir, timeout: 300_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pm-desktop-bootstrap-corrupt-')));
  const dataDir = join(root, 'instance');
  const pg = new ManagedPostgres({ dataDir, binariesDir: binariesDir! });
  t.after(async () => { await pg.stop(); await rm(root, { recursive: true, force: true }); });
  const started = await pg.start();
  await observedBootstrap(t, 'fresh-marker-refusal-fixture', { databaseUrl: started.databaseUrl, dataDir, projectRoot: join(dataDir, 'projects') });
  await completeSetup(started.databaseUrl, dataDir, join(dataDir, 'projects'));
  await observedBootstrap(t, 'finalize-marker-refusal-fixture', { databaseUrl: started.databaseUrl, dataDir, projectRoot: join(dataDir, 'projects') });
  const pool = createPool(started.databaseUrl, 2);
  try {
    await unlink(join(dataDir, 'blobs', '.pm-store.json'));
    await assert.rejects(observedBootstrap(t, 'reject-missing-blob-marker', { databaseUrl: started.databaseUrl, dataDir, projectRoot: join(dataDir, 'projects') }));
    await assert.rejects(readFile(join(dataDir, 'blobs', '.pm-store.json')), { code: 'ENOENT' });
    await unlink(join(dataDir, 'bootstrap.json'));
    await assert.rejects(observedBootstrap(t, 'reject-missing-registration', { databaseUrl: started.databaseUrl, dataDir, projectRoot: join(dataDir, 'projects') }));
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM users')).rows[0].count, 1);
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM workspaces')).rows[0].count, 1);
  } finally { await pool.end(); }
});
