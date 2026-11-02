import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AutomationGitConfig, AutomationGitOperation, AutomationGitReceipt, AutomationGitSave, AutomationGitStatus } from '../../contracts/src/automation-git-sync.ts';
import { AUTOMATION_TRANSFER_LIMITS, automationBundleSchema } from '../../contracts/src/automation-transfer.ts';
import { studioDefinitionSchema, type StudioConfig, type StudioDefinition, type StudioReceipt } from '../../contracts/src/automation-studio.ts';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import { createConfiguredAutomationGitPort, decryptAutomationGitDocument, encryptAutomationGitDocument, type AutomationGitPort, type AutomationGitContext } from '../../infrastructure/src/automation-git.ts';
import type { NotificationCorePort } from '../../pm-core/readonly.ts';
import { automationSnapshot, authorizeAutomationProject } from './automation-report.ts';
import { automationConfigHash, deterministicAutomationId, runAutomationTransferCycle, validateScriptFiles, type AutomationTransferStudio } from './automation-transfer.ts';
import { requestHash } from './kernel.ts';

type ConfigRow = { id: string; workspace_id: string; actor_id: string; project_id: string; revision: number; config: AutomationGitConfig; token_sealed: string | null; encryption_key_sealed: string | null; last_commit: string | null; last_synced_at: Date | null };
type OperationRow = { id: string; config_id: string; config_revision: number; status: AutomationGitOperation['status']; remote_commit: string | null; prepared_commit: string | null; error: string | null; started_at: Date | null; finished_at: Date | null };
type Mapping = { path: string; definition_id: string; config_hash: string; remote_hash: string };
type StoredGitResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string }; httpStatus: number };
export type AutomationGitSyncOptions = { database: () => Pool; core: NotificationCorePort; studio: AutomationTransferStudio; git?: AutomationGitPort };
function operationDto(row: OperationRow): AutomationGitOperation { return { id: row.id, status: row.status, commit: row.prepared_commit, startedAt: row.started_at?.toISOString() ?? null, finishedAt: row.finished_at?.toISOString() ?? null, error: row.error }; }
async function definitions(studio: AutomationTransferStudio, actor: Actor, workspaceId: string, projectId: string): Promise<StudioDefinition[]> {
  const result: StudioDefinition[] = []; let cursor: string | undefined;
  do { const page = await studio.definitions(actor, workspaceId, cursor); result.push(...page.items.filter(definition => definition.config.projectId === projectId)); cursor = page.nextCursor ?? undefined; } while (cursor);
  return result;
}
export function createAutomationGitSyncService(options: AutomationGitSyncOptions) {
  const git = options.git ?? createConfiguredAutomationGitPort();
  async function authorize(actor: Actor, workspaceId: string, projectId: string, write: boolean) { await authorizeAutomationProject(options.database(), actor, workspaceId, projectId, await automationSnapshot(options.core, workspaceId), write); }
  async function current(actor: Actor, workspaceId: string, projectId: string): Promise<ConfigRow | undefined> { return (await options.database().query<ConfigRow>('SELECT * FROM automation_git_configs WHERE workspace_id=$1 AND actor_id=$2 AND project_id=$3', [workspaceId, actor.id, projectId])).rows[0]; }
  async function status(actor: Actor, workspaceId: string, projectId: string): Promise<AutomationGitStatus> {
    await authorize(actor, workspaceId, projectId, false); const row = await current(actor, workspaceId, projectId);
    const local = await definitions(options.studio, actor, workspaceId, projectId);
    if (!row) return { revision: 0, config: null, tokenSet: false, encryptionKeySet: false, capability: git.capability(), lastCommit: null, lastSyncedAt: null, dirtyCount: local.length, operation: null };
    const operation = (await options.database().query<OperationRow>('SELECT * FROM automation_git_operations WHERE config_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [row.id])).rows[0];
    const maps = (await options.database().query<Mapping>('SELECT * FROM automation_git_mappings WHERE config_id=$1', [row.id])).rows;
    let dirtyCount = local.filter(definition => maps.find(map => map.definition_id === definition.id)?.config_hash !== automationConfigHash(definition.config)).length;
    dirtyCount += maps.filter(map => !local.some(definition => definition.id === map.definition_id)).length;
    return { revision: row.revision, config: row.config, tokenSet: !!row.token_sealed, encryptionKeySet: !!row.encryption_key_sealed, capability: git.capability(), lastCommit: row.last_commit, lastSyncedAt: row.last_synced_at?.toISOString() ?? null, dirtyCount, operation: operation ? operationDto(operation) : null };
  }
  async function mutation<T>(actor: Actor, workspaceId: string, projectId: string, input: Record<string, unknown>, requestId: string, operation: (sql: PoolClient) => Promise<T>): Promise<T> {
    const sql = await options.database().connect(), hash = requestHash(input);
    let result: StoredGitResult<T>;
    try {
      await sql.query('BEGIN'); await lockWorkspace(sql, workspaceId); await authorizeAutomationProject(sql, actor, workspaceId, projectId, await automationSnapshot(options.core, workspaceId), true);
      const prior = (await sql.query<{ request_hash: string; result: StoredGitResult<T> }>('SELECT request_hash,result FROM automation_git_receipts WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3', [workspaceId, actor.id, requestId])).rows[0];
      if (prior && prior.request_hash !== hash) throw new DomainError('idempotency_conflict', 'Git request ID already represents a different mutation', 409);
      if (prior) result = prior.result;
      else {
        await sql.query('SAVEPOINT automation_git_mutation');
        try { result = { ok: true, value: await operation(sql) }; }
        catch (error) { if (!(error instanceof DomainError)) throw error; await sql.query('ROLLBACK TO SAVEPOINT automation_git_mutation'); result = { ok: false, error: { code: error.code, message: error.message }, httpStatus: error.status }; }
        await sql.query('RELEASE SAVEPOINT automation_git_mutation');
        await sql.query('INSERT INTO automation_git_receipts(workspace_id,actor_id,request_id,project_id,request_hash,result) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [workspaceId, actor.id, requestId, projectId, hash, JSON.stringify(result)]);
      }
      await sql.query('COMMIT');
    } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
    if (!result.ok) throw new DomainError(result.error.code, result.error.message, result.httpStatus);
    return result.value;
  }
  async function enqueue(actor: Actor, workspaceId: string, input: { requestId: string; projectId: string; expectedRevision: number }, reconcileOnly: boolean): Promise<AutomationGitOperation> {
    return mutation(actor, workspaceId, input.projectId, { ...input, reconcileOnly }, input.requestId, async sql => {
      const row = (await sql.query<ConfigRow>('SELECT * FROM automation_git_configs WHERE workspace_id=$1 AND actor_id=$2 AND project_id=$3 FOR UPDATE', [workspaceId, actor.id, input.projectId])).rows[0];
      if (!row) throw new DomainError('not_found_or_forbidden', 'Git configuration is not accessible', 404);
      if (row.revision !== input.expectedRevision) throw new DomainError('version_conflict', 'Git configuration changed; reload before synchronizing', 409);
      if (!git.capability().available) throw new DomainError('automation_git_unconfigured', git.capability().reason ?? 'Git synchronization unavailable', 503);
      const active = (await sql.query<OperationRow>("SELECT * FROM automation_git_operations WHERE config_id=$1 AND status IN ('pending','running','outcome_unknown') ORDER BY created_at DESC LIMIT 1", [row.id])).rows[0];
      if (active) {
        if (reconcileOnly) return operationDto(active);
        throw new DomainError('automation_git_pending', 'An existing synchronization must finish or reconcile before another sync', 409);
      }
      if (reconcileOnly) throw new DomainError('automation_git_not_pending', 'No synchronization has an unknown result', 409);
      const operation = (await sql.query<OperationRow>('INSERT INTO automation_git_operations(id,config_id,config_revision) VALUES($1,$2,$3) RETURNING *', [randomUUID(), row.id, row.revision])).rows[0]!;
      return operationDto(operation);
    });
  }
  return {
    status,
    async save(actor: Actor, workspaceId: string, input: AutomationGitSave): Promise<AutomationGitStatus> {
      await mutation(actor, workspaceId, input.config.projectId, input, input.requestId, async sql => {
        const row = (await sql.query<ConfigRow>('SELECT * FROM automation_git_configs WHERE workspace_id=$1 AND actor_id=$2 AND project_id=$3 FOR UPDATE', [workspaceId, actor.id, input.config.projectId])).rows[0];
        if ((row?.revision ?? 0) !== input.expectedRevision) throw new DomainError('version_conflict', 'Git configuration changed; your inputs have not been overwritten', 409);
        const active = row ? (await sql.query<OperationRow>("SELECT * FROM automation_git_operations WHERE config_id=$1 AND status IN ('pending','running','outcome_unknown') LIMIT 1", [row.id])).rows[0] : undefined;
        const secretRecovery = row && active?.status === 'outcome_unknown' && active.prepared_commit && requestHash(row.config) === requestHash(input.config) && (input.token !== undefined || input.encryptionKey !== undefined);
        if (active && !secretRecovery) throw new DomainError('automation_git_pending', 'Reconcile the active synchronization before changing configuration. An unknown prepared result permits credential-only replacement/clear for recovery', 409);
        const id = row?.id ?? randomUUID(), tokenScope = `${workspaceId}:${actor.id}:${input.config.projectId}:token`, keyScope = `${workspaceId}:${actor.id}:${input.config.projectId}:encryption`;
        const token = input.token === undefined ? row?.token_sealed ?? null : input.token === null ? null : git.seal(input.token, tokenScope);
        const key = input.encryptionKey === undefined ? row?.encryption_key_sealed ?? null : input.encryptionKey === null ? null : git.seal(input.encryptionKey, keyScope);
        if (input.config.encryptionEnabled && !key) throw new DomainError('automation_git_encryption_key_required', 'Encryption requires an explicitly configured key', 400);
        if (row && (row.config.repository !== input.config.repository || row.config.branch !== input.config.branch || row.config.path !== input.config.path)) await sql.query('DELETE FROM automation_git_mappings WHERE config_id=$1', [id]);
        await sql.query(`INSERT INTO automation_git_configs(id,workspace_id,actor_id,project_id,config,token_sealed,encryption_key_sealed,next_due_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,CASE WHEN $8 THEN clock_timestamp()+make_interval(secs=>$9) ELSE NULL END)
          ON CONFLICT(workspace_id,actor_id,project_id) DO UPDATE SET config=excluded.config,token_sealed=excluded.token_sealed,encryption_key_sealed=excluded.encryption_key_sealed,next_due_at=excluded.next_due_at,revision=automation_git_configs.revision+1,updated_at=clock_timestamp()`, [id, workspaceId, actor.id, input.config.projectId, JSON.stringify(input.config), token, key, input.config.enabled && input.config.intervalSeconds > 0, input.config.intervalSeconds]);
        return { savedRevision: (row?.revision ?? 0) + 1 };
      });
      return status(actor, workspaceId, input.config.projectId);
    },
    async check(actor: Actor, workspaceId: string, input: Pick<AutomationGitSave, 'config' | 'token' | 'encryptionKey'>) {
      await authorize(actor, workspaceId, input.config.projectId, true); const row = await current(actor, workspaceId, input.config.projectId);
      const token = input.token === undefined ? git.open(row?.token_sealed ?? null, `${workspaceId}:${actor.id}:${input.config.projectId}:token`) : input.token;
      const result = await git.check({ id: row?.id ?? deterministicAutomationId(`${workspaceId}:${actor.id}:${input.config.projectId}`), config: input.config, token });
      return { readable: true as const, ...result, pushPermissionVerified: false as const, encryptionKeyVerified: false as const };
    },
    sync: (actor: Actor, workspaceId: string, input: { requestId: string; projectId: string; expectedRevision: number }) => enqueue(actor, workspaceId, input, false),
    reconcile: (actor: Actor, workspaceId: string, input: { requestId: string; projectId: string; expectedRevision: number }) => enqueue(actor, workspaceId, input, true),
    async receipt(actor: Actor, workspaceId: string, requestId: string): Promise<AutomationGitReceipt> {
      const row = (await options.database().query<{ project_id: string; result: StoredGitResult<AutomationGitStatus | AutomationGitOperation | { savedRevision: number }> }>('SELECT project_id,result FROM automation_git_receipts WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3', [workspaceId, actor.id, requestId])).rows[0];
      if (!row) throw new DomainError('not_found_or_forbidden', 'Git receipt is not accessible', 404);
      await authorize(actor, workspaceId, row.project_id, false);
      if (!row.result.ok) return { requestId, status: 'rejected', result: null, error: row.result.error };
      let result = row.result.value;
      if ('id' in result) { const latest = (await options.database().query<OperationRow>('SELECT o.* FROM automation_git_operations o JOIN automation_git_configs c ON c.id=o.config_id WHERE o.id=$1 AND c.workspace_id=$2 AND c.actor_id=$3', [result.id, workspaceId, actor.id])).rows[0]; if (latest) result = operationDto(latest); }
      return { requestId, status: 'completed', result, error: null };
    },
  };
}

/** One bounded cycle; no SQL transaction is held while Git/network or studio services run. */
export async function runAutomationGitSyncCycle(options: AutomationGitSyncOptions): Promise<void> {
  const pool = options.database(), git = options.git ?? createConfiguredAutomationGitPort();
  await runAutomationTransferCycle(options);
  if (!git.capability().available) return;
  const due = (await pool.query<ConfigRow>("SELECT c.* FROM automation_git_configs c WHERE next_due_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM automation_git_operations o WHERE o.config_id=c.id AND o.status IN ('pending','running','outcome_unknown')) ORDER BY next_due_at LIMIT 10")).rows;
  for (const row of due) {
    const actor: Actor = { id: row.actor_id, name: '', email: '' }, sql = await pool.connect();
    try {
      await sql.query('BEGIN'); await lockWorkspace(sql, row.workspace_id);
      await authorizeAutomationProject(sql, actor, row.workspace_id, row.project_id, await automationSnapshot(options.core, row.workspace_id), true);
      await sql.query("INSERT INTO automation_git_operations(id,config_id,config_revision) SELECT $1,id,revision FROM automation_git_configs c WHERE id=$2 AND next_due_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM automation_git_operations o WHERE o.config_id=c.id AND o.status IN ('pending','running','outcome_unknown'))", [randomUUID(), row.id]);
      await sql.query('UPDATE automation_git_configs SET next_due_at=CASE WHEN (config->>\'enabled\')::boolean AND (config->>\'intervalSeconds\')::integer>0 THEN clock_timestamp()+make_interval(secs=>(config->>\'intervalSeconds\')::integer) ELSE NULL END WHERE id=$1', [row.id]);
      await sql.query('COMMIT');
    } catch (error) { await sql.query('ROLLBACK'); if (!(error instanceof DomainError)) throw error; await pool.query('UPDATE automation_git_configs SET next_due_at=clock_timestamp()+interval \'5 minutes\' WHERE id=$1', [row.id]); }
    finally { sql.release(); }
  }
  const candidate = (await pool.query<OperationRow>("SELECT * FROM automation_git_operations WHERE status IN ('pending','running','outcome_unknown') ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END,coalesce(checked_at,created_at),id LIMIT 1")).rows[0];
  if (!candidate) return;
  // Session advisory lock spans network without an open transaction and prevents concurrent workers.
  const session = await pool.connect(); let locked = false;
  try {
    locked = (await session.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,41)) AS locked', [candidate.config_id])).rows[0]!.locked;
    if (!locked) return;
    const op = (await pool.query<OperationRow>("SELECT * FROM automation_git_operations WHERE id=$1 AND status IN ('pending','running','outcome_unknown')", [candidate.id])).rows[0]; if (!op) return;
    await pool.query('UPDATE automation_git_operations SET checked_at=clock_timestamp() WHERE id=$1', [op.id]);
    const row = (await pool.query<ConfigRow>('SELECT * FROM automation_git_configs WHERE id=$1', [op.config_id])).rows[0]!;
    const actor: Actor = { id: row.actor_id, name: '', email: '' };
    const authorize = async () => { await authorizeAutomationProject(pool, actor, row.workspace_id, row.project_id, await automationSnapshot(options.core, row.workspace_id), true); };
    let prepared = op.prepared_commit;
    try {
      await authorize();
      const context: AutomationGitContext = { id: row.id, config: row.config, token: git.open(row.token_sealed, `${row.workspace_id}:${row.actor_id}:${row.project_id}:token`) };
      if (prepared) {
        const accepted = await git.reconcile(context, prepared);
        if (!accepted) { await pool.query("UPDATE automation_git_operations SET status='outcome_unknown',error='Remote does not yet prove the prepared commit was accepted; no second push was attempted' WHERE id=$1", [op.id]); return; }
        await complete(pool, row, op.id, prepared); return;
      }
      if (row.revision !== op.config_revision) throw new DomainError('version_conflict', 'Configuration changed after synchronization was queued', 409);
      await pool.query("UPDATE automation_git_operations SET status='running',started_at=coalesce(started_at,clock_timestamp()),error=NULL WHERE id=$1", [op.id]);
      const remote = await git.read(context), key = git.open(row.encryption_key_sealed, `${row.workspace_id}:${row.actor_id}:${row.project_id}:encryption`);
      if (row.config.encryptionEnabled && !key) throw new DomainError('automation_git_encryption_key_required', 'Encryption key is unavailable; no files were decrypted or synchronized', 409);
      const maps = (await pool.query<Mapping>('SELECT * FROM automation_git_mappings WHERE config_id=$1', [row.id])).rows;
      const local = await definitions(options.studio, actor, row.workspace_id, row.project_id), known = new Map(local.map(definition => [definition.id, definition]));
      const remoteConfigs = new Map<string, StudioConfig>(), canonicalPaths = new Set<string>();
      for (const [path, value] of Object.entries(remote.files)) {
        const encrypted = path.endsWith('.enc');
        if (encrypted && !key) throw new DomainError('automation_git_encryption_key_required', 'An encryption key is required to authenticate current remote files, even when disabling encryption', 409);
        const canonical = path.replace(/\.enc$/, '');
        if (canonicalPaths.has(canonical)) throw new DomainError('automation_git_duplicate_file', 'Both encrypted and plaintext versions of one definition are present; resolve the remote conflict explicitly', 409);
        canonicalPaths.add(canonical);
        const text = encrypted ? decryptAutomationGitDocument(value, key!) : value;
        let document: unknown; try { document = JSON.parse(text); } catch { throw new DomainError('automation_git_file_invalid', `Invalid JSON in ${path}`, 409); }
        const parsed = automationBundleSchema.safeParse(document);
        if (!parsed.success) throw new DomainError('automation_git_file_invalid', `Invalid or unknown bundle fields in ${path}`, 409);
        const config = parsed.data.spec; validateScriptFiles(config);
        if (config.projectId !== row.project_id) throw new DomainError('automation_git_scope_mismatch', `Remote definition ${path} targets a different project`, 403);
        remoteConfigs.set(path, config);
        const map = maps.find(item => item.path === path), existing = map ? known.get(map.definition_id) : undefined, remoteHash = createHash('sha256').update(value).digest('hex');
        if (map && map.remote_hash === remoteHash) continue;
        const requestId = deterministicAutomationId(`git-import:${row.id}:${path}:${remote.remoteCommit}:${remoteHash}`);
        let saved: StudioDefinition | undefined, prior: StudioReceipt | undefined;
        try { prior = await options.studio.receipt(actor, row.workspace_id, requestId); }
        catch (error) { if (!(error instanceof DomainError) || error.status !== 404) throw error; }
        if (prior) {
          if (prior.httpStatus >= 400) {
            const rejection = prior.result as { error?: { code?: unknown; message?: unknown } } | null;
            throw new DomainError(typeof rejection?.error?.code === 'string' ? rejection.error.code : 'automation_git_import_rejected', typeof rejection?.error?.message === 'string' ? rejection.error.message : 'The original Git import was rejected', prior.httpStatus);
          }
          saved = studioDefinitionSchema.parse(prior.result);
        }
        if (!saved) {
          if (map && (!existing || automationConfigHash(existing.config) !== map.config_hash)) throw new DomainError('automation_git_conflict', `Both local definition and remote file changed: ${path}`, 409);
          if (existing && existing.status !== 'draft') throw new DomainError('automation_git_activation_conflict', `Enabled or paused definitions are never overwritten by Git. Import a separate draft or resolve the remote change explicitly: ${path}`, 409);
          await authorize();
          saved = existing ? await options.studio.update(actor, row.workspace_id, existing.id, { requestId, expectedRevision: existing.revision, config }) : await options.studio.create(actor, row.workspace_id, { requestId, config });
        }
        // Core may already have committed before a worker crash. Reconcile its receipt, not a new create/update.
        known.set(saved.id, await options.studio.definition(actor, row.workspace_id, saved.id));
        const newMap: Mapping = { path, definition_id: saved.id, config_hash: automationConfigHash(config), remote_hash: remoteHash };
        await pool.query('INSERT INTO automation_git_mappings(config_id,path,definition_id,config_hash,remote_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(config_id,path) DO UPDATE SET definition_id=excluded.definition_id,config_hash=excluded.config_hash,remote_hash=excluded.remote_hash', [row.id, path, saved.id, newMap.config_hash, remoteHash]);
        if (map) Object.assign(map, newMap); else maps.push(newMap);
      }
      // A remote deletion does not authorize deleting PM data. Local definitions are exported again.
      const files: Record<string, string> = {}, snapshots: Mapping[] = [];
      for (const definition of known.values()) {
        validateScriptFiles(definition.config);
        const map = maps.find(item => item.definition_id === definition.id), extension = row.config.encryptionEnabled ? '.automation-bundle.json.enc' : '.automation-bundle.json';
        const path = map ? map.path.replace(/\.automation-bundle\.json(?:\.enc)?$/, extension) : `${row.config.path}/${definition.id}${extension}`;
        const text = JSON.stringify({ version: 1, kind: 'pm-automation-bundle', spec: definition.config }, null, 2);
        if (Buffer.byteLength(text) > AUTOMATION_TRANSFER_LIMITS.jsonBytes) throw new DomainError('automation_git_limits_exceeded', 'A complete definition exceeds the 3 MiB JSON interchange limit', 409);
        const same = remoteConfigs.has(path) && automationConfigHash(remoteConfigs.get(path)!) === automationConfigHash(definition.config);
        const content = same ? remote.files[path]! : row.config.encryptionEnabled ? encryptAutomationGitDocument(text, key!) : text;
        if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new DomainError('automation_git_limits_exceeded', 'An encoded definition exceeds the 4 MiB per-file Git limit', 409);
        files[path] = content; snapshots.push({ path, definition_id: definition.id, config_hash: automationConfigHash(definition.config), remote_hash: createHash('sha256').update(content).digest('hex') });
      }
      if (Object.keys(files).length > 200 || Buffer.byteLength(JSON.stringify(files)) > 10 * 1024 * 1024) throw new DomainError('automation_git_limits_exceeded', 'Local definitions exceed synchronization limit (200 files/10 MiB)', 409);
      const unchanged = remote.remoteCommit !== null && Object.keys(remote.files).length === snapshots.length && snapshots.every(snapshot => remote.files[snapshot.path] === files[snapshot.path]);
      await authorize(); prepared = unchanged ? remote.remoteCommit! : await git.prepare(context, remote.remoteCommit, files, op.id);
      // Persist identity and exact snapshot BEFORE any push; crashes reconcile only, never push again.
      await session.query('BEGIN');
      try {
        for (const snapshot of snapshots) await session.query('INSERT INTO automation_git_sync_snapshots(operation_id,path,definition_id,config_hash,remote_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [op.id, snapshot.path, snapshot.definition_id, snapshot.config_hash, snapshot.remote_hash]);
        await session.query('UPDATE automation_git_operations SET status=$4,remote_commit=$2,prepared_commit=$3 WHERE id=$1', [op.id, remote.remoteCommit, prepared, unchanged ? 'running' : 'outcome_unknown']);
        await session.query('COMMIT');
      } catch (error) { await session.query('ROLLBACK'); throw error; }
      await authorize(); if (!unchanged) await git.push(context, remote.remoteCommit, prepared); await complete(pool, row, op.id, prepared);
    } catch (error) {
      const message = error instanceof DomainError ? `${error.code}: ${error.message}` : 'Git synchronization failed unexpectedly; no private command output is exposed';
      const failed = !prepared || error instanceof DomainError && error.code === 'automation_git_push_rejected';
      await pool.query('UPDATE automation_git_operations SET status=$2,error=$3,finished_at=CASE WHEN $2=\'failed\' THEN clock_timestamp() ELSE NULL END WHERE id=$1', [op.id, failed ? 'failed' : 'outcome_unknown', message]);
    }
  } finally { if (locked) await session.query('SELECT pg_advisory_unlock(hashtextextended($1,41))', [candidate.config_id]); session.release(); }
}
async function complete(pool: Pool, row: ConfigRow, operationId: string, commit: string): Promise<void> {
  const sql = await pool.connect();
  try {
    await sql.query('BEGIN'); await lockWorkspace(sql, row.workspace_id);
    await sql.query('DELETE FROM automation_git_mappings WHERE config_id=$1', [row.id]);
    await sql.query('INSERT INTO automation_git_mappings(config_id,path,definition_id,config_hash,remote_hash) SELECT $1,path,definition_id,config_hash,remote_hash FROM automation_git_sync_snapshots WHERE operation_id=$2', [row.id, operationId]);
    await sql.query('UPDATE automation_git_configs SET last_commit=$2,last_synced_at=clock_timestamp() WHERE id=$1', [row.id, commit]);
    await sql.query("UPDATE automation_git_operations SET status='completed',finished_at=clock_timestamp(),error=NULL WHERE id=$1", [operationId]); await sql.query('COMMIT');
  } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
}
