import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { automationConfigSchema, type AutomationCapabilities, type AutomationConfig, type AutomationPage, type AutomationReceipt, type AutomationRejectedResult, type AutomationRule, type AutomationRun } from '../../contracts/src/automation.ts';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import type { NotificationCorePort, ReadonlyCoreSnapshot } from '../../pm-core/readonly.ts';
import { getMembership } from './access.ts';
import { requestHash } from './kernel.ts';
import type { SqlExecutor } from './ports.ts';
import { automationSnapshot, authorizeAutomationProject, observeAutomation } from './automation-report.ts';
import { automationBudgetReason, automationMissedDate, nextAutomationDue } from './automation-schedule.ts';

type RuleRow = { id: string; workspace_id: string; actor_id: string; project_id: string; revision: number; config: AutomationConfig; status: AutomationRule['status']; created_at: Date; updated_at: Date; last_run_at: Date | null; next_due_at: Date | null; deleted_at: Date | null };
type ReceiptRow = { request_hash: string; project_ids: string[]; http_status: number; result: unknown };
type Mutation = { requestId: string } & ({ kind: 'create'; config: AutomationConfig } | { kind: 'update'; id: string; expectedRevision: number; config: AutomationConfig } | { kind: 'status'; id: string; expectedRevision: number; status: 'enabled' | 'paused' } | { kind: 'remove' | 'run'; id: string; expectedRevision: number });
function ruleDto(row: RuleRow): AutomationRule {
  return { id: row.id, revision: row.revision, config: row.config, status: row.status, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), lastRunAt: row.last_run_at?.toISOString() ?? null, nextDueAt: row.next_due_at?.toISOString() ?? null };
}
async function clock(sql: SqlExecutor): Promise<Date> { return (await sql.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now; }
async function membership(sql: SqlExecutor, actor: Actor, workspaceId: string) {
  const member = await getMembership(sql, actor, workspaceId);
  if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
  return member;
}
async function historyReadable(sql: SqlExecutor, actor: Actor, workspaceId: string, run: AutomationRun, snapshot: ReadonlyCoreSnapshot): Promise<void> {
  await authorizeAutomationProject(sql, actor, workspaceId, run.config.projectId, snapshot);
  // A moved source cannot leak its frozen evidence to a creator who lost its current scope.
  for (const evidence of run.evidence) {
    const current = snapshot.files.find(record => record.id === evidence.id);
    if (current?.entity.project && current.entity.project !== run.config.projectId) await authorizeAutomationProject(sql, actor, workspaceId, current.entity.project, snapshot);
  }
}
async function recordRun(sql: SqlExecutor, core: NotificationCorePort, row: RuleRow, now: Date, dueAt: Date | null): Promise<AutomationRun> {
  const actor: Actor = { id: row.actor_id, email: '', name: '' };
  const config = automationConfigSchema.parse(row.config);
  let reason: string | null = null, status: AutomationRun['status'] = 'skipped', summary = '', evidence: AutomationRun['evidence'] = [], consumed = false;
  try {
    const snapshot = await automationSnapshot(core, row.workspace_id);
    await authorizeAutomationProject(sql, actor, row.workspace_id, config.projectId, snapshot, true);
    if (dueAt && automationMissedDate(config, dueAt, now)) reason = 'schedule_missed';
    const budget = (await sql.query<{ consumed_today: string; last_at: Date | null }>('SELECT count(*) FILTER (WHERE (started_at AT TIME ZONE $2)::date=($3::timestamptz AT TIME ZONE $2)::date)::text AS consumed_today,max(started_at) AS last_at FROM automation_runs WHERE rule_id=$1 AND budget_consumed', [row.id, config.trigger.timezone, now])).rows[0]!;
    reason ??= automationBudgetReason(config, now, Number(budget.consumed_today), budget.last_at);
    if (reason === null) {
      consumed = true;
      const report = await observeAutomation(sql, core, actor, row.workspace_id, config, now, snapshot);
      status = 'completed'; summary = report.summary; evidence = report.evidence;
    }
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    reason = error.code;
    status = consumed || error.code === 'automation_source_unavailable' ? 'failed' : 'skipped';
  }
  if (!summary) summary = `${status === 'failed' ? 'Report failed' : 'Report skipped'}: ${reason}. No task state was changed.`;
  const finishedAt = await clock(sql);
  if (finishedAt.getTime() < now.getTime()) throw new DomainError('automation_clock_reversed', 'Server clock precedes the report start; no run was committed', 503);
  const run: AutomationRun = { id: randomUUID(), ruleId: row.id, ruleName: config.name, ruleRevision: row.revision, config, trigger: dueAt ? 'scheduled' : 'manual', status, startedAt: now.toISOString(), finishedAt: finishedAt.toISOString(), summary, reason, evidence };
  await sql.query('INSERT INTO automation_runs(id,workspace_id,actor_id,rule_id,due_at,budget_consumed,started_at,run) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [run.id, row.workspace_id, row.actor_id, row.id, dueAt, consumed, now, JSON.stringify(run)]);
  await sql.query('UPDATE automation_rules SET last_run_at=$2,next_due_at=$3 WHERE id=$1', [row.id, now, dueAt ? nextAutomationDue(config, now) : row.next_due_at]);
  return run;
}

export function createAutomationService(options: { database: () => Pool; core: NotificationCorePort }) {
  async function read<T>(actor: Actor, workspaceId: string, operation: (sql: PoolClient) => Promise<T>): Promise<T> {
    const sql = await options.database().connect();
    try {
      await sql.query('BEGIN READ ONLY');
      await lockWorkspace(sql, workspaceId);
      await membership(sql, actor, workspaceId);
      const result = await operation(sql);
      await sql.query('COMMIT'); return result;
    } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
  }
  async function receiptReadable(sql: SqlExecutor, actor: Actor, workspaceId: string, row: ReceiptRow) {
    if (!row.project_ids.length) return;
    const snapshot = await automationSnapshot(options.core, workspaceId);
    for (const id of row.project_ids) await authorizeAutomationProject(sql, actor, workspaceId, id, snapshot);
    if (row.result && typeof row.result === 'object' && 'evidence' in row.result) await historyReadable(sql, actor, workspaceId, row.result as AutomationRun, snapshot);
  }
  async function mutate(actor: Actor, workspaceId: string, input: Mutation): Promise<unknown> {
    const sql = await options.database().connect();
    const hash = requestHash(input);
    let result: unknown, httpStatus = 200;
    try {
      await sql.query('BEGIN'); await lockWorkspace(sql, workspaceId); await membership(sql, actor, workspaceId);
      const prior = (await sql.query<ReceiptRow>('SELECT * FROM automation_receipts WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3', [workspaceId, actor.id, input.requestId])).rows[0];
      if (prior) {
        await receiptReadable(sql, actor, workspaceId, prior);
        if (prior.request_hash !== hash) throw new DomainError('idempotency_conflict', 'Request ID already represents a different automation request', 409);
        result = prior.result; httpStatus = prior.http_status;
      } else {
        const projects = new Set<string>();
        if ('config' in input) projects.add(input.config.projectId);
        const existing = input.kind === 'create' ? undefined : (await sql.query<RuleRow>('SELECT * FROM automation_rules WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND deleted_at IS NULL FOR UPDATE', [input.id, workspaceId, actor.id])).rows[0];
        if (existing) projects.add(existing.project_id);
        await sql.query('SAVEPOINT automation_mutation');
        try {
          const snapshot = await automationSnapshot(options.core, workspaceId);
          const requireActive = input.kind !== 'remove' && !(input.kind === 'status' && input.status === 'paused');
          for (const id of projects) await authorizeAutomationProject(sql, actor, workspaceId, id, snapshot, true, requireActive);
          const now = await clock(sql);
          if (input.kind === 'create') {
            const rows = await sql.query<RuleRow>('INSERT INTO automation_rules(id,workspace_id,actor_id,project_id,config) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING *', [randomUUID(), workspaceId, actor.id, input.config.projectId, JSON.stringify(input.config)]);
            result = ruleDto(rows.rows[0]!);
          } else {
            if (!existing) throw new DomainError('not_found_or_forbidden', 'Automation rule is not accessible', 404);
            if (existing.revision !== input.expectedRevision) throw new DomainError('version_conflict', 'Automation rule changed; reload before deciding again', 409);
            if (input.kind === 'run') result = await recordRun(sql, options.core, existing, now, null);
            else if (input.kind === 'remove') {
              await sql.query('UPDATE automation_rules SET deleted_at=$2,next_due_at=NULL,revision=revision+1,updated_at=$2 WHERE id=$1 AND revision=$3', [existing.id, now, input.expectedRevision]);
              result = { deleted: true };
            } else {
              const config = automationConfigSchema.parse(input.kind === 'update' ? input.config : existing.config);
              const status = input.kind === 'status' ? input.status : existing.status;
              const due = status === 'enabled' ? nextAutomationDue(config, now) : null;
              const updated = await sql.query<RuleRow>('UPDATE automation_rules SET project_id=$2,config=$3::jsonb,status=$4,next_due_at=$5,revision=revision+1,updated_at=$6 WHERE id=$1 AND revision=$7 RETURNING *', [existing.id, config.projectId, JSON.stringify(config), status, due, now, input.expectedRevision]);
              if (!updated.rows[0]) throw new DomainError('version_conflict', 'Automation rule changed', 409);
              result = ruleDto(updated.rows[0]);
            }
          }
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          await sql.query('ROLLBACK TO SAVEPOINT automation_mutation');
          httpStatus = error.status;
          result = { error: { code: error.code, message: error.message }, httpStatus } satisfies AutomationRejectedResult;
        }
        await sql.query('RELEASE SAVEPOINT automation_mutation');
        await sql.query('INSERT INTO automation_receipts(workspace_id,actor_id,request_id,request_hash,project_ids,http_status,result) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [workspaceId, actor.id, input.requestId, hash, [...projects], httpStatus, JSON.stringify(result)]);
      }
      await sql.query('COMMIT');
    } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
    if (httpStatus !== 200) { const rejected = result as AutomationRejectedResult; throw new DomainError(rejected.error.code, rejected.error.message, httpStatus); }
    return result;
  }
  return {
    async capabilities(actor: Actor, workspaceId: string): Promise<AutomationCapabilities> {
      return read(actor, workspaceId, async sql => {
        const member = await membership(sql, actor, workspaceId);
        const heartbeat = await sql.query<{ ready: boolean }>("SELECT EXISTS(SELECT 1 FROM automation_scheduler_heartbeats WHERE heartbeat_at>clock_timestamp()-interval '20 seconds') AS ready");
        const ready = heartbeat.rows[0]!.ready;
        return { canWrite: member.capabilities.includes('planning.edit'), scheduler: { authority: 'worker', ready, reason: ready ? null : 'automation_worker_not_observed' }, actions: [{ id: 'report', available: true, reason: null }, { id: 'model', available: false, reason: 'Model actions are not implemented by this report scheduler' }, { id: 'host', available: false, reason: 'Host execution is not implemented by this report scheduler' }, { id: 'external', available: false, reason: 'External connector actions are not configured or implemented' }] };
      });
    },
    async rules(actor: Actor, workspaceId: string, cursor?: string): Promise<AutomationPage<AutomationRule>> {
      return read(actor, workspaceId, async sql => {
        const snapshot = await automationSnapshot(options.core, workspaceId);
        const rows = await sql.query<RuleRow>('SELECT * FROM automation_rules r WHERE workspace_id=$1 AND actor_id=$2 AND deleted_at IS NULL AND ($3::uuid IS NULL OR (r.created_at,r.id)<(SELECT c.created_at,c.id FROM automation_rules c WHERE c.id=$3::uuid AND c.workspace_id=$1 AND c.actor_id=$2)) ORDER BY created_at DESC,id DESC LIMIT 51', [workspaceId, actor.id, cursor ?? null]);
        const items: AutomationRule[] = [];
        for (const row of rows.rows.slice(0, 50)) {
          try { await authorizeAutomationProject(sql, actor, workspaceId, row.project_id, snapshot); items.push(ruleDto(row)); }
          catch (error) { if (!(error instanceof DomainError) || ![403, 404].includes(error.status)) throw error; }
        }
        return { items, nextCursor: rows.rows.length > 50 ? rows.rows[49]!.id : null };
      });
    },
    create: (actor: Actor, workspaceId: string, input: { requestId: string; config: AutomationConfig }) => mutate(actor, workspaceId, { ...input, kind: 'create' }) as Promise<AutomationRule>,
    update: (actor: Actor, workspaceId: string, id: string, input: { requestId: string; expectedRevision: number; config: AutomationConfig }) => mutate(actor, workspaceId, { ...input, kind: 'update', id }) as Promise<AutomationRule>,
    setStatus: (actor: Actor, workspaceId: string, id: string, input: { requestId: string; expectedRevision: number; status: 'enabled' | 'paused' }) => mutate(actor, workspaceId, { ...input, kind: 'status', id }) as Promise<AutomationRule>,
    remove: (actor: Actor, workspaceId: string, id: string, input: { requestId: string; expectedRevision: number }) => mutate(actor, workspaceId, { ...input, kind: 'remove', id }) as Promise<{ deleted: true }>,
    run: (actor: Actor, workspaceId: string, id: string, input: { requestId: string; expectedRevision: number }) => mutate(actor, workspaceId, { ...input, kind: 'run', id }) as Promise<AutomationRun>,
    test: (actor: Actor, workspaceId: string, config: AutomationConfig) => read(actor, workspaceId, async sql => observeAutomation(sql, options.core, actor, workspaceId, config, await clock(sql))),
    async runs(actor: Actor, workspaceId: string, ruleId?: string, cursor?: string): Promise<AutomationPage<AutomationRun>> {
      return read(actor, workspaceId, async sql => {
        const snapshot = await automationSnapshot(options.core, workspaceId);
        const rows = await sql.query<{ id: string; run: AutomationRun }>('SELECT id,run FROM automation_runs r WHERE workspace_id=$1 AND actor_id=$2 AND ($3::uuid IS NULL OR rule_id=$3::uuid) AND ($4::uuid IS NULL OR (r.started_at,r.id)<(SELECT c.started_at,c.id FROM automation_runs c WHERE c.id=$4::uuid AND c.workspace_id=$1 AND c.actor_id=$2)) ORDER BY started_at DESC,id DESC LIMIT 51', [workspaceId, actor.id, ruleId ?? null, cursor ?? null]);
        const items: AutomationRun[] = [];
        for (const row of rows.rows.slice(0, 50)) {
          try { await historyReadable(sql, actor, workspaceId, row.run, snapshot); items.push(row.run); }
          catch (error) { if (!(error instanceof DomainError) || ![403, 404].includes(error.status)) throw error; }
        }
        return { items, nextCursor: rows.rows.length > 50 ? rows.rows[49]!.id : null };
      });
    },
    detail: (actor: Actor, workspaceId: string, id: string) => read(actor, workspaceId, async sql => {
      const row = (await sql.query<{ run: AutomationRun }>('SELECT run FROM automation_runs WHERE id=$1 AND workspace_id=$2 AND actor_id=$3', [id, workspaceId, actor.id])).rows[0];
      if (!row) throw new DomainError('not_found_or_forbidden', 'Automation run is not accessible', 404);
      await historyReadable(sql, actor, workspaceId, row.run, await automationSnapshot(options.core, workspaceId));
      return row.run;
    }),
    receipt: (actor: Actor, workspaceId: string, requestId: string): Promise<AutomationReceipt> => read(actor, workspaceId, async sql => {
      const row = (await sql.query<ReceiptRow>('SELECT * FROM automation_receipts WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3', [workspaceId, actor.id, requestId])).rows[0];
      if (!row) throw new DomainError('not_found_or_forbidden', 'Automation receipt is not accessible', 404);
      await receiptReadable(sql, actor, workspaceId, row); return { requestId, result: row.result };
    }),
  };
}

/** Workspace lock first, then row lock: same permission boundary as API writes. Entire read-only report and dedup record commit together. */
export async function runAutomationBatch(pool: Pool, core: NotificationCorePort, workerId: string, options: { limit?: number; now?: Date } = {}): Promise<{ processed: number }> {
  const candidates = await pool.query<{ id: string; workspace_id: string }>("SELECT id,workspace_id FROM automation_rules WHERE status='enabled' AND deleted_at IS NULL AND next_due_at<=coalesce($2::timestamptz,clock_timestamp()) ORDER BY next_due_at,id LIMIT $1", [Math.min(100, Math.max(1, options.limit ?? 10)), options.now ?? null]);
  let processed = 0;
  for (const candidate of candidates.rows) {
    const sql = await pool.connect();
    try {
      await sql.query('BEGIN'); await lockWorkspace(sql, candidate.workspace_id);
      const now = options.now ?? await clock(sql);
      const row = (await sql.query<RuleRow>("SELECT * FROM automation_rules WHERE id=$1 AND status='enabled' AND deleted_at IS NULL AND next_due_at<=$2 FOR UPDATE SKIP LOCKED", [candidate.id, now])).rows[0];
      if (row?.next_due_at) { await recordRun(sql, core, row, now, row.next_due_at); processed++; }
      await sql.query('COMMIT');
    } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
  }
  // Only this scheduler implementation emits this heartbeat, and only after a successful cycle.
  await pool.query('INSERT INTO automation_scheduler_heartbeats(worker_id) VALUES($1) ON CONFLICT(worker_id) DO UPDATE SET heartbeat_at=clock_timestamp()', [workerId]);
  return { processed };
}
export const automationCursorSchema = z.uuid().toLowerCase();
