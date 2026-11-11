import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import type { FixtureDiff, FixtureEntity, FixtureHandle, FixtureReceipt, FixtureSnapshot, Mutation } from '../schemas/types.ts';

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
}
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export async function readTree(root: string, options: { authority?: boolean } = {}): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: FileHandle, prefix: string): Promise<void> {
    for (const entry of (await readdir(`/proc/self/fd/${directory.fd}`, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git' || options.authority && entry.name === 'cache') continue;
      const relative = path.join(prefix, entry.name);
      const child = await open(`/proc/self/fd/${directory.fd}/${entry.name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (entry.isDirectory() ? constants.O_DIRECTORY : 0));
      try {
        const stat = await child.stat();
        if (stat.isDirectory()) await visit(child, relative);
        else {
          if (!stat.isFile() || stat.nlink !== 1) throw new Error('Fixture contains a hardlink or special file');
          if (stat.size > 8 * 1024 * 1024) throw new Error('Fixture file exceeds snapshot limit');
          result[relative] = (await child.readFile()).toString('base64');
        }
      } finally { await child.close(); }
    }
  }
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await visit(directory, ''); } finally { await directory.close(); }
  return result;
}
function safeRow(value: unknown, key = ''): unknown {
  if (/(?:password|token_hash|secret|credential|session_token)/i.test(key)) return { privateDigest: digest(value) };
  if (Array.isArray(value)) return value.map(entry => safeRow(entry));
  if (value && typeof value === 'object' && !(value instanceof Date)) return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, safeRow(entry, name)]));
  return value instanceof Date ? value.toISOString() : value;
}
function semanticEntity(entity: FixtureEntity, targets: FixtureHandle['targets']): unknown {
  const replacements = new Map(Object.values(targets).map(target => [target.entityId, target.key]));
  function normalize(value: unknown, key = ''): unknown {
    if (['created', 'updated', 'createdAt', 'updatedAt', 'created_at', 'updated_at', 'revision'].includes(key)) return undefined;
    if (Array.isArray(value)) return value.map(entry => normalize(entry));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([name]) => !['created', 'updated', 'revision'].includes(name)).map(([name, entry]) => [name, normalize(entry, name)]));
    if (typeof value === 'string') { for (const [id, semantic] of replacements) value = (value as string).replaceAll(id, `{${semantic}}`); }
    return value;
  }
  return { key: entity.key, kind: entity.kind, project: entity.projectId ? replacements.get(entity.projectId) ?? entity.projectId : null, entity: normalize(entity.entity) };
}
export function semanticTables(tables: FixtureSnapshot['tables'], handle: Pick<FixtureHandle, 'root' | 'workspaceId' | 'actorId'>): unknown {
  function normalize(value: unknown, key = ''): unknown {
    if (value !== null && (['created_at', 'updated_at', 'expires_at', 'applied_at', 'finished_at', 'started_at', 'observed_at', 'received_at', 'recorded_at', 'verified_at', 'heartbeat_at', 'createdAt', 'updatedAt', 'verifiedAt', 'device', 'inode', 'dev', 'ino'].includes(key))) return '{generated}';
    if (Array.isArray(value)) return value.map(entry => normalize(entry));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, normalize(entry, name)]));
    if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(value)) return '{timestamp}';
    if (typeof value === 'string') return value.replaceAll(handle.root, '{root}').replaceAll(handle.workspaceId, '{workspace}').replaceAll(handle.actorId, '{actor}').replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '{uuid}').replace(/\b[a-f0-9]{64}\b/gi, '{digest}');
    return value;
  }
  return Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.map(row => normalize(name === 'service_fact_import_checkpoints' ? { workspace_id: row.workspace_id, last_error_code: row.last_error_code, observation_sequence: row.observation_sequence } : row)).sort((a, b) => canonical(a).localeCompare(canonical(b)))]));
}
export async function takeSnapshot(handle: FixtureHandle, pool: Pool, entities: FixtureEntity[], seedReceipts: FixtureReceipt[] = []): Promise<FixtureSnapshot> {
  const sql = await pool.connect();
  const tables: FixtureSnapshot['tables'] = {};
  let files: Record<string, string>;
  try {
    await sql.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text,724631))', [handle.workspaceId]);
    const names = await sql.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
    for (const { tablename } of names.rows) {
      if (!/^[a-z][a-z0-9_]*$/.test(tablename)) throw new Error('Unexpected database table identifier');
      const rows = await sql.query(`SELECT to_jsonb(t) AS row FROM public."${tablename}" t`);
      tables[tablename] = rows.rows.map(row => safeRow(row.row) as Record<string, unknown>).sort((a, b) => canonical(a).localeCompare(canonical(b)));
    }
    files = await readTree(handle.authorityRoot, { authority: true });
    await sql.query('COMMIT');
  } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
  const receipts: FixtureReceipt[] = [...seedReceipts];
  for (const row of tables.command_receipts ?? []) receipts.push({ operationId: String(row.command_id), kind: 'command', targetId: row.target_id ? String(row.target_id) : null, revision: null, status: String((row.receipt as Record<string, unknown> | undefined)?.status ?? 'committed'), result: row.receipt ?? row.result });
  for (const row of tables.pm_agent_tool_operations ?? []) {
    const result = row.result as { items?: { id?: string; revision?: string }[]; receipt?: { targetId?: string; revision?: string } } | null;
    const mutation = /^pm_(?:create|update|transition|add|remove|archive|restore|delete)/.test(String(row.name));
    receipts.push({ operationId: String(row.operation_id), kind: 'native', targetId: result?.receipt?.targetId ?? (mutation ? result?.items?.[0]?.id ?? null : null), revision: result?.receipt?.revision ?? (mutation ? result?.items?.[0]?.revision ?? null : null), status: String(row.status), result: row.result });
  }
  const publicFiles = await readTree(handle.publicRoot);
  const semanticPublicFiles = { ...publicFiles };
  if (semanticPublicFiles['pm-targets.json']) semanticPublicFiles['pm-targets.json'] = canonical({ workspaceId: '{workspace}', targets: Object.fromEntries(Object.values(handle.targets).map(target => [target.key, { ...target, workspaceId: '{workspace}', revision: '{revision}' }])) });
  const semanticConfiguration = Object.fromEntries(Object.entries(files!).filter(([name]) => name.includes('/.pm/config.') || name.includes('/.pm/views/')).map(([name, content]) => [name.replaceAll(handle.workspaceId, '{workspace}'), content]));
  const semanticHash = digest({ version: handle.fixtureVersion, entities: entities.map(entity => semanticEntity(entity, handle.targets)).sort((a, b) => canonical(a).localeCompare(canonical(b))), publicFiles: semanticPublicFiles, tables: semanticTables(tables, handle), configuration: semanticConfiguration });
  return { fixtureId: handle.fixtureId, fixtureVersion: handle.fixtureVersion, capturedAt: new Date().toISOString(), semanticHash, entities, receipts, tables, files: files!, publicFiles, transportEvents: structuredClone(handle.runtime?.auditEvents ?? []) };
}
function compareDomain(domain: string, before: Record<string, unknown>, after: Record<string, unknown>): Mutation[] {
  const result: Mutation[] = [];
  for (const identity of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (canonical(before[identity]) === canonical(after[identity])) continue;
    result.push({ domain, identity, kind: !(identity in before) ? 'added' : !(identity in after) ? 'removed' : 'changed', ...(identity in before ? { before: before[identity] } : {}), ...(identity in after ? { after: after[identity] } : {}) });
  }
  return result;
}
type JournalFact = { fact: { factId: string; sourceKey: string; entityId: string; beforeRevision: string | null; afterRevision: string | null }; history?: unknown };
type JournalEntry = { kind: string; commandId: string; actorId: string; targetId?: string; audit?: Record<string, unknown>[]; receipt?: { result?: { id?: string } }; facts?: JournalFact[]; captured?: JournalFact };
function journalEntries(snapshot: FixtureSnapshot): JournalEntry[] {
  return Object.entries(snapshot.files).filter(([name]) => name.endsWith('/.pm/state/pm-command-journal.ndjson')).flatMap(([, content]) => Buffer.from(content, 'base64').toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as JournalEntry));
}
function additions(before: Record<string, unknown>[], after: Record<string, unknown>[]): Record<string, unknown>[] | null {
  const remaining = new Map<string, number>();
  for (const row of before) { const key = canonical(row); remaining.set(key, (remaining.get(key) ?? 0) + 1); }
  const added: Record<string, unknown>[] = [];
  for (const row of after) { const key = canonical(row), count = remaining.get(key) ?? 0; if (count) remaining.set(key, count - 1); else added.push(row); }
  return [...remaining.values()].some(count => count > 0) ? null : added;
}
function authorizedSqlTables(before: FixtureSnapshot, after: FixtureSnapshot, allowed: Set<string>): Set<string> {
  const expected = new Set<string>(), oldIds = new Set(before.entities.map(entity => entity.id));
  for (const entity of after.entities) if (!oldIds.has(entity.id) && entity.projectId && allowed.has(entity.projectId)) allowed.add(entity.id);
  const journal = journalEntries(after);
  const completed = journal.filter(entry => (entry.kind === 'http_completed' || entry.kind === 'completed') && allowed.has(entry.targetId ?? entry.receipt?.result?.id ?? '') && (entry.facts ?? []).every(captured => allowed.has(captured.fact.entityId)));
  const commands = new Set(completed.map(entry => entry.commandId)), facts = new Map<string, JournalFact>();
  for (const entry of journal) {
    if (!commands.has(entry.commandId)) continue;
    for (const captured of [...(entry.facts ?? []), ...(entry.kind === 'fact_completed' && entry.captured ? [entry.captured] : [])]) if (allowed.has(captured.fact.entityId)) facts.set(captured.fact.factId, captured);
  }
  const workspaceIds = new Set((before.tables.workspaces ?? []).map(row => String(row.id)));
  const newFacts = additions(before.tables.service_fact_events ?? [], after.tables.service_fact_events ?? []);
  const newHistory = additions(before.tables.change_history_entries ?? [], after.tables.change_history_entries ?? []);
  const inWorkspace = (row: Record<string, unknown>) => workspaceIds.has(String(row.workspace_id));
  const target = (row: Record<string, unknown>) => String((row.target as { entityId?: string } | undefined)?.entityId ?? row.entity_id ?? row.target_id ?? '');
  const acceptedPlatformSignals = (after.transportEvents ?? []).filter(event => event.source === 'transport' && event.type === 'platform_signal_accepted');
  const addedChecks: Record<string, (row: Record<string, unknown>) => boolean> = {
    project_audit: row => inWorkspace(row) && allowed.has(String(row.target_id)) && completed.some(entry => entry.commandId === row.command_id && (entry.audit ?? []).some(audit => canonical([audit.projectId, audit.source, audit.commandId, audit.action, audit.actorId, audit.targetId, audit.targetKind, audit.beforeVersion, audit.afterVersion, audit.changes, audit.audienceActorId]) === canonical([row.project_id, row.source, row.command_id, row.action, row.actor_id, row.target_id, row.target_kind, row.before_version, row.after_version, row.changes, row.audience_actor_id]))),
    service_fact_events: row => { const fact = facts.get(String(row.fact_id))?.fact; return inWorkspace(row) && !!fact && row.entity_id === fact.entityId && row.source_key === fact.sourceKey && row.before_revision === fact.beforeRevision && row.after_revision === fact.afterRevision; },
    change_history_entries: row => inWorkspace(row) && facts.has(String(row.change_id)) && allowed.has(target(row)) && row.source_key === `fact:${String(row.change_id)}`,
    change_history_streams: row => inWorkspace(row) && allowed.has(target(row)),
    change_history_aliases: row => inWorkspace(row) && (after.tables.change_history_streams ?? []).some(stream => stream.stream_key === row.stream_key && allowed.has(target(stream))),
    notification_fact_inputs: row => inWorkspace(row) && facts.has(String(row.fact_id)) && (!row.task_id || allowed.has(String(row.task_id))) && row.completion !== true,
    notification_route_jobs: row => inWorkspace(row) && facts.has(String(row.fact_id)) && row.state === 'pending' && Number(row.attempts) === 0,
    automation_pm_signals: row => inWorkspace(row) && ([...facts.keys()].some(id => String(row.source_key).startsWith(`${id}:`)) && allowed.has(String(((row.payload as { sourceRef?: { id?: string } } | undefined)?.sourceRef)?.id ?? '')) || acceptedPlatformSignals.some(event => {
      const payload = event.data.payload as { eventId?: string; workspaceId?: string; projectId?: string; actorId?: string } | undefined;
      const scoped = payload?.projectId && (allowed.has(payload.projectId) || after.entities.some(entity => allowed.has(entity.id) && entity.projectId === payload.projectId));
      return scoped && payload && event.sessionId && event.generationId && event.data.payloadHash === digest(payload) && row.source_key === payload.eventId && row.workspace_id === payload.workspaceId && row.project_id === payload.projectId && row.actor_id === payload.actorId && canonical(row.payload) === canonical(payload) && (after.transportEvents ?? []).some(prior => prior.id === event.data.pmRequestEventId && prior.source === 'transport' && prior.type === 'pm_request' && prior.sessionId === event.sessionId && prior.generationId === event.generationId && prior.data.workspaceId === payload.workspaceId && prior.data.projectId === payload.projectId);
    })),
    command_receipts: row => inWorkspace(row) && commands.has(String(row.command_id)),
  };
  for (const [table, check] of Object.entries(addedChecks)) { const added = additions(before.tables[table] ?? [], after.tables[table] ?? []); if (added && added.every(check)) expected.add(table); }
  const oldOperations = new Map((before.tables.pm_agent_tool_operations ?? []).map(row => [String(row.operation_id), row]));
  const afterOperations = after.tables.pm_agent_tool_operations ?? [];
  const immutableOperation = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([name]) => !['status', 'result', 'error', 'finished_at', 'outcome_evidence'].includes(name)));
  if (afterOperations.length >= oldOperations.size && afterOperations.every(row => {
    const original = oldOperations.get(String(row.operation_id)), scope = row.target as { workspaceId?: string; projectId?: string | null } | null;
    const result = row.result as { receipt?: { targetId?: string; commandId?: string } } | null;
    const read = /^pm_(?:read|query|search|list)/.test(String(row.name));
    const scoped = scope?.projectId && (allowed.has(scope.projectId) || after.entities.some(entity => allowed.has(entity.id) && entity.projectId === scope.projectId));
    return inWorkspace(row) && scope?.workspaceId === row.workspace_id && (read || result?.receipt?.targetId && allowed.has(result.receipt.targetId) && commands.has(result.receipt.commandId ?? '') || scoped && ['failed', 'unknown', 'running'].includes(String(row.status))) && (!original || canonical(immutableOperation(original)) === canonical(immutableOperation(row)));
  }) && [...oldOperations.keys()].every(id => afterOperations.some(row => row.operation_id === id))) expected.add('pm_agent_tool_operations');
  const oldWorkspaces = before.tables.workspaces ?? [], newWorkspaces = after.tables.workspaces ?? [];
  if (oldWorkspaces.length === newWorkspaces.length && oldWorkspaces.every(row => {
    const next = newWorkspaces.find(value => value.id === row.id); if (!next) return false;
    const withoutHeads = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([name]) => !['service_fact_head', 'change_history_head'].includes(name)));
    return canonical(withoutHeads(row)) === canonical(withoutHeads(next)) && newFacts !== null && newHistory !== null && expected.has('service_fact_events') && expected.has('change_history_entries') && Number(next.service_fact_head) - Number(row.service_fact_head) === newFacts.filter(fact => fact.workspace_id === row.id).length && Number(next.change_history_head) - Number(row.change_history_head) === newHistory.filter(history => history.workspace_id === row.id).length;
  })) expected.add('workspaces');
  const oldCheckpoints = before.tables.service_fact_import_checkpoints ?? [], newCheckpoints = after.tables.service_fact_import_checkpoints ?? [];
  if (oldCheckpoints.length === newCheckpoints.length && oldCheckpoints.every(row => {
    const next = newCheckpoints.find(value => value.workspace_id === row.workspace_id); if (!next) return false;
    const offset = Number(row.journal_offset), end = Number(next.journal_offset);
    const immutable = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([name]) => !['journal_offset', 'imported_count', 'status', 'observed_at'].includes(name)));
    return canonical(immutable(row)) === canonical(immutable(next)) && end >= offset && end <= journal.length && ['current', 'pending'].includes(String(next.status)) && Number(next.imported_count) - Number(row.imported_count) === journal.slice(offset, end).filter(entry => entry.kind === 'fact_completed').length;
  })) expected.add('service_fact_import_checkpoints');
  const proofNonces = new Set((after.transportEvents ?? []).filter(event => event.source === 'transport' && event.type === 'pm_reconcile_proof' && allowed.has(String(event.data.targetId))).map(event => String(event.data.nonce)));
  const oldNonces = new Map((before.tables.pm_agent_tool_service_nonces ?? []).map(row => [String(row.nonce), row]));
  const newNonces = new Map((after.tables.pm_agent_tool_service_nonces ?? []).map(row => [String(row.nonce), row]));
  if ([...newNonces].every(([nonce, row]) => oldNonces.has(nonce) ? canonical(oldNonces.get(nonce)) === canonical(row) : proofNonces.has(nonce)) && [...oldNonces].every(([nonce, row]) => newNonces.has(nonce) || new Date(String(row.expires_at)).getTime() <= new Date(after.capturedAt).getTime())) expected.add('pm_agent_tool_service_nonces');
  return expected;
}
export function diffSnapshots(before: FixtureSnapshot, after: FixtureSnapshot, options: { allowedEntityIds?: string[] } = {}): FixtureDiff {
  if (before.fixtureId !== after.fixtureId) throw new Error('Cannot diff authority from independent fixture identities');
  const mutations = [
    ...compareDomain('entity', Object.fromEntries(before.entities.map(entity => [entity.id, entity])), Object.fromEntries(after.entities.map(entity => [entity.id, entity]))),
    ...compareDomain('authority-file', before.files, after.files),
    ...compareDomain('public-file', before.publicFiles, after.publicFiles),
    ...compareDomain('postgres', before.tables, after.tables),
  ];
  const allowed = new Set(options.allowedEntityIds ?? []);
  const expectedTables = authorizedSqlTables(before, after, allowed);
  const unexpectedMutations = mutations.filter(mutation => mutation.domain === 'entity' ? !allowed.has(mutation.identity) : mutation.domain === 'postgres' ? !expectedTables.has(mutation.identity) : mutation.domain === 'authority-file' ? ![...allowed].some(id => mutation.identity.endsWith(`/${id}.md`)) && !mutation.identity.includes('/.pm/state/') : false);
  return { beforeHash: before.semanticHash, afterHash: after.semanticHash, mutations, unexpectedMutations };
}
