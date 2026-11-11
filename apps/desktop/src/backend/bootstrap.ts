import { randomBytes, randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { createPool, migrate } from '../../../../packages/infrastructure/src/database.ts';
import { createWorkspace } from '../../../../packages/infrastructure/src/auth.ts';
import { LocalBlobStore } from '../../../../packages/infrastructure/src/blobs.ts';
import { bindStorage } from '../../../../packages/infrastructure/src/blob-storage-maintenance.ts';
import { assertStorageMarker, readStorageBinding, readStorageMarker } from '../../../../packages/infrastructure/src/blob-storage-binding.ts';
import { getInstanceSetupStatus, prepareInstanceSetup } from '../../../../packages/infrastructure/src/instance-setup.ts';
import { initializeNovaWorkspaceSample, queueNovaWorkspaceSample, type WorkspaceSampleOptions } from '../../../../packages/application/src/workspace-samples.ts';
import { readManagedPostgresState } from '../managed-postgres.mjs';
import { ensurePrivateDirectory, readPrivateJson, writePrivateJson } from '../private-state.mjs';

const setupTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const bootstrapSchema = z.strictObject({
  formatVersion: z.literal(1), instanceId: z.uuid(), phase: z.enum(['pending', 'ready']),
  storeId: z.uuid(), operationId: z.uuid(),
  email: z.email().max(254).nullable(), name: z.string().min(1).max(200).nullable(), workspaceName: z.string().min(1).max(200).nullable(),
  userId: z.uuid().nullable(), workspaceId: z.uuid().nullable(),
}).refine(value => value.phase !== 'ready' || Boolean(value.userId && value.workspaceId && value.email && value.name && value.workspaceName), 'Ready bootstrap requires account and workspace identities');
export type BootstrapState = z.infer<typeof bootstrapSchema>;
export function validateBootstrapState(value: unknown): BootstrapState { return bootstrapSchema.parse(value); }
export type BootstrapInput = { databaseUrl: string; dataDir: string; projectRoot: string };
export type BootstrapResult =
  | { phase: 'pending'; instanceId: string }
  | { phase: 'ready'; instanceId: string; userId: string; workspaceId: string; initialized: boolean };
type Anchor = { instance_id: string; store_id: string; user_id: string | null; workspace_id: string | null };
const anchorTable = `CREATE TABLE desktop_bootstrap (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  instance_id uuid NOT NULL, store_id uuid NOT NULL,
  user_id uuid REFERENCES users(id), workspace_id uuid REFERENCES workspaces(id)
)`;
function mismatch(): never { throw new Error('Managed desktop bootstrap identity is missing or inconsistent; refusing account recreation'); }
async function tableExists(sql: PoolClient): Promise<boolean> {
  return Boolean((await sql.query<{ name: string | null }>("SELECT to_regclass('desktop_bootstrap')::text AS name")).rows[0]?.name);
}
async function readAnchor(sql: PoolClient): Promise<Anchor | null> {
  return (await sql.query<Anchor>('SELECT instance_id,store_id,user_id,workspace_id FROM desktop_bootstrap WHERE singleton=true')).rows[0] ?? null;
}
async function accountAndWorkspaceExist(sql: PoolClient, state: BootstrapState): Promise<void> {
  if (!state.userId || !state.workspaceId) mismatch();
  const result = await sql.query('SELECT 1 FROM users u CROSS JOIN workspaces w WHERE u.id=$1 AND w.id=$2', [state.userId, state.workspaceId]);
  if (result.rowCount !== 1) mismatch();
}
async function readOrCreateSetupToken(dataDir: string): Promise<string> {
  const filename = join(dataDir, 'setup-token.json');
  let saved = await readPrivateJson(filename, 1024);
  if (saved === null) {
    const token = randomBytes(32).toString('base64url');
    try { await writePrivateJson(filename, { token }, { exclusive: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    saved = await readPrivateJson(filename, 1024);
  }
  const token = setupTokenSchema.safeParse(saved?.token);
  if (!token.success) throw new Error('Private desktop setup token is invalid. Restore the original token file; do not rotate a pending setup token.');
  return token.data;
}
async function ensureStorageBinding(pool: Pool, dataDir: string, state: BootstrapState): Promise<void> {
  const provider = new LocalBlobStore(join(dataDir, 'blobs'));
  const binding = await readStorageBinding(pool);
  if (!binding) {
    // bindStorage permits only the exact predeclared marker on a crash retry. Unknown
    // marker/bytes and existing references fail; an existing binding is never rebound.
    await bindStorage({ pool, provider, locator: { provider: 'local', root: provider.root }, mode: 'new', stopped: true, storeId: state.storeId, operationId: state.operationId });
  }
  await assertBoundStorage(pool, dataDir, state.storeId);
}
async function removeSetupToken(dataDir: string): Promise<void> {
  await unlink(join(dataDir, 'setup-token.json')).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
}
async function assertBoundStorage(pool: Pool, dataDir: string, storeId: string): Promise<void> {
  const locator = { provider: 'local' as const, root: join(dataDir, 'blobs') };
  const provider = new LocalBlobStore(locator.root);
  const binding = await readStorageBinding(pool);
  if (!binding || binding.state !== 'active' || binding.storeId !== storeId) throw new Error('Managed desktop blob binding is missing or changed; explicit maintenance is required');
  assertStorageMarker(binding, locator, await readStorageMarker(provider));
  await provider.check();
}

function assertManagedDatabaseUrl(databaseUrl: string, owner: { username: string; password: string; port: number }): void {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.port !== String(owner.port) || url.username !== owner.username || url.password !== owner.password || url.pathname !== '/postgres' || url.search || url.hash) throw new Error('Bootstrap requires this managed instance database, not an external connection');
}

async function assertManagedServer(sql: PoolClient, dataDir: string): Promise<void> {
  const server = await sql.query<{ directory: string; version: string }>("SELECT current_setting('data_directory') AS directory,current_setting('server_version_num') AS version");
  if (resolve(server.rows[0]!.directory) !== join(dataDir, 'postgres') || Math.floor(Number(server.rows[0]!.version) / 10_000) !== 16) throw new Error('Managed desktop database identity mismatch');
}

/** All authority and password hashing remain in the existing infrastructure APIs. */
export async function bootstrapDesktop(input: BootstrapInput & { live?: boolean }): Promise<BootstrapResult> {
  const dataDir = resolve(input.dataDir);
  const sample: WorkspaceSampleOptions = { coreRoot: join(dataDir, 'pm-workspaces'), localProjects: { enabled: true, dataRoot: dataDir, defaultParent: resolve(input.projectRoot), allowedRoots: [resolve(input.projectRoot)], backupRoot: join(dataDir, 'backups'), coreRoot: join(dataDir, 'pm-workspaces') } };
  const ownership = await readManagedPostgresState(dataDir);
  if (ownership.phase !== 'ready') throw new Error('Managed PostgreSQL is not initialized');
  assertManagedDatabaseUrl(input.databaseUrl, ownership);
  await ensurePrivateDirectory(dataDir);
  const filename = join(dataDir, 'bootstrap.json');
  const pool = createPool(input.databaseUrl, 4);
  const sql = await pool.connect();
  try {
    // Session lock spans filesystem steps and the existing independent auth transactions.
    await sql.query("SELECT pg_advisory_lock(hashtextextended('pm:desktop-bootstrap',724631))");
    await assertManagedServer(sql, dataDir);
    const saved = await readPrivateJson(filename);
    let state: BootstrapState | null = saved ? validateBootstrapState(saved) : null;
    if (state && state.instanceId !== ownership.instanceId) mismatch();
    await migrate(pool);
    const exists = await tableExists(sql);
    if (!state) {
      const occupied = await sql.query<{ users: string; workspaces: string }>('SELECT (SELECT count(*) FROM users)::text AS users,(SELECT count(*) FROM workspaces)::text AS workspaces');
      if (exists || occupied.rows[0]?.users !== '0' || occupied.rows[0]?.workspaces !== '0') mismatch();
      state = { formatVersion: 1, instanceId: ownership.instanceId, phase: 'pending', storeId: randomUUID(), operationId: randomUUID(), email: null, name: null, workspaceName: null, userId: null, workspaceId: null };
      // Written before first-run setup can create an account; no password is stored.
      await writePrivateJson(filename, state, { exclusive: true });
    }
    if (!exists) {
      if (state.phase === 'ready' || state.userId || state.workspaceId) mismatch();
      const occupied = await sql.query<{ present: boolean }>('SELECT EXISTS(SELECT 1 FROM users UNION ALL SELECT 1 FROM workspaces) AS present');
      if (occupied.rows[0]?.present) mismatch();
      await sql.query('BEGIN');
      try {
        await sql.query(anchorTable);
        await sql.query('INSERT INTO desktop_bootstrap(singleton,instance_id,store_id) VALUES(true,$1,$2)', [state.instanceId, state.storeId]);
        await sql.query('COMMIT');
      } catch (error) { await sql.query('ROLLBACK'); throw error; }
    }
    const anchor = await readAnchor(sql);
    if (!anchor || anchor.instance_id !== state.instanceId || anchor.store_id !== state.storeId) mismatch();
    if (state.phase === 'ready') {
      if (anchor.user_id !== state.userId || anchor.workspace_id !== state.workspaceId) mismatch();
      await accountAndWorkspaceExist(sql, state);
      await assertBoundStorage(pool, dataDir, state.storeId);
      await removeSetupToken(dataDir).catch(() => undefined);
      return { phase: 'ready', instanceId: state.instanceId, userId: state.userId!, workspaceId: state.workspaceId!, initialized: false };
    }
    // First-run setup is completed through the ordinary HTTP setup service. This
    // process only prepares it, then adopts the one account/workspace it created.
    const users = await sql.query<{ id: string; email: string; name: string }>('SELECT id,email,name FROM users ORDER BY id');
    const workspaces = await sql.query<{ id: string; owner_id: string; name: string }>('SELECT id,owner_id,name FROM workspaces ORDER BY id');
    if (users.rows.length > 1 || workspaces.rows.length > 1) mismatch();
    if (state.email && users.rows.length && users.rows[0]!.email !== state.email) mismatch();
    let userId = anchor.user_id ?? state.userId ?? users.rows[0]?.id;
    if (userId) {
      if (users.rows[0]?.id !== userId || (state.userId && state.userId !== userId) || (anchor.user_id && anchor.user_id !== userId)) mismatch();
    }
    if (!userId && workspaces.rows.length) mismatch();
    let workspaceId = anchor.workspace_id ?? state.workspaceId ?? workspaces.rows[0]?.id;
    let workspaceName = workspaces.rows[0]?.name ?? null;
    if (workspaceId) {
      if (!userId || workspaces.rows[0]?.id !== workspaceId || workspaces.rows[0]?.owner_id !== userId || (state.workspaceId && state.workspaceId !== workspaceId) || (anchor.workspace_id && anchor.workspace_id !== workspaceId)) mismatch();
    }
    // Legacy pending recovery can finish a workspace after its account, but only
    // when that account was predeclared by the previous bootstrap metadata.
    if (userId && !workspaceId) {
      if (!state.workspaceName) mismatch();
      workspaceName = state.workspaceName;
      workspaceId = (await createWorkspace(pool, userId, state.workspaceName, { prepare: (client, workspace) => queueNovaWorkspaceSample(client, workspace.id, workspace.ownerId, workspace.name, sample) })).id;
    }
    if (!userId) {
      if (state.userId || state.workspaceId || workspaces.rows.length) mismatch();
      // A previous version predeclared account fields before creating the account.
      // No account exists, so release those uncommitted declarations to the HTTP
      // setup service rather than requiring the removed desktop password form.
      if (state.email || state.name || state.workspaceName) {
        state = { ...state, email: null, name: null, workspaceName: null };
        await writePrivateJson(filename, state);
      }
      if ((await getInstanceSetupStatus(sql)).initialized) mismatch();
      const token = await readOrCreateSetupToken(dataDir);
      await prepareInstanceSetup(pool, token);
      for (const name of ['agent-data', 'pm-workspaces', 'blobs', 'chat-spaces', 'projects']) await ensurePrivateDirectory(join(dataDir, name));
      await ensureStorageBinding(pool, dataDir, state);
      return { phase: 'pending', instanceId: state.instanceId };
    }
    if (!workspaceId) mismatch();
    if ((await sql.query('SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2', [workspaceId, userId])).rowCount !== 1) mismatch();
    await sql.query('UPDATE desktop_bootstrap SET user_id=$1,workspace_id=$2 WHERE singleton=true', [userId, workspaceId]);
    state = { ...state, userId, workspaceId, email: users.rows[0]!.email, name: users.rows[0]!.name, workspaceName: workspaceName! };
    await writePrivateJson(filename, state);
    for (const name of ['agent-data', 'pm-workspaces', 'blobs', 'chat-spaces', 'projects']) await ensurePrivateDirectory(join(dataDir, name));
    if (input.live) await assertBoundStorage(pool, dataDir, state.storeId);
    else await ensureStorageBinding(pool, dataDir, state);
    await initializeNovaWorkspaceSample(pool, workspaceId, sample);
    await removeSetupToken(dataDir).catch(() => undefined);
    state = { ...state, phase: 'ready' };
    await writePrivateJson(filename, state);
    return { phase: 'ready', instanceId: state.instanceId, userId, workspaceId, initialized: true };
  } finally {
    await sql.query("SELECT pg_advisory_unlock(hashtextextended('pm:desktop-bootstrap',724631))").catch(() => undefined);
    sql.release(); await pool.end();
  }
}

/** Called only after an isolated restore and real blob restore-rebind have completed. */
export async function registerRestoredBootstrap(input: { databaseUrl: string; dataDir: string; source: unknown; storeId: string }): Promise<BootstrapState> {
  const source = validateBootstrapState(input.source);
  if (source.phase !== 'ready') throw new Error('Only a completed desktop bootstrap can be restored');
  const dataDir = resolve(input.dataDir);
  const ownership = await readManagedPostgresState(dataDir);
  if (ownership.phase !== 'ready' || ownership.instanceId === source.instanceId) throw new Error('Restore requires a new managed PostgreSQL instance');
  assertManagedDatabaseUrl(input.databaseUrl, ownership);
  const state = validateBootstrapState({ ...source, instanceId: ownership.instanceId, storeId: input.storeId });
  const filename = join(dataDir, 'bootstrap.json');
  const pool = createPool(input.databaseUrl, 3);
  const sql = await pool.connect();
  try {
    await sql.query("SELECT pg_advisory_lock(hashtextextended('pm:desktop-bootstrap',724631))");
    await assertManagedServer(sql, dataDir);
    const previous = await readPrivateJson(filename);
    if (previous && JSON.stringify(validateBootstrapState(previous)) !== JSON.stringify(state)) throw new Error('Restore target already has another bootstrap identity');
    if (!(await tableExists(sql))) mismatch();
    const anchor = await readAnchor(sql);
    if (!anchor || ![source.instanceId, state.instanceId].includes(anchor.instance_id) || ![source.storeId, state.storeId].includes(anchor.store_id) || anchor.user_id !== state.userId || anchor.workspace_id !== state.workspaceId) mismatch();
    await accountAndWorkspaceExist(sql, state);
    await assertBoundStorage(pool, dataDir, state.storeId);
    await sql.query('UPDATE desktop_bootstrap SET instance_id=$1,store_id=$2 WHERE singleton=true', [state.instanceId, state.storeId]);
    await writePrivateJson(filename, state, { exclusive: !previous });
    return state;
  } finally {
    await sql.query("SELECT pg_advisory_unlock(hashtextextended('pm:desktop-bootstrap',724631))").catch(() => undefined);
    sql.release(); await pool.end();
  }
}

async function main(): Promise<void> {
  let bytes = '';
  for await (const chunk of process.stdin) {
    bytes += chunk.toString('utf8');
    if (Buffer.byteLength(bytes) > 16_384) throw new Error('Desktop bootstrap input is too large');
  }
  const input = z.strictObject({ databaseUrl: z.string().min(1), dataDir: z.string().min(1), projectRoot: z.string().min(1), live: z.boolean().optional() }).parse(JSON.parse(bytes));
  const result = await bootstrapDesktop(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Never print database URLs, input, SQL parameters, zod payloads or passwords.
    const code = error instanceof z.ZodError ? 'desktop_setup_invalid' : 'desktop_bootstrap_failed';
    process.stderr.write(`${JSON.stringify({ error: code })}\n`);
    process.exitCode = 1;
  });
}
