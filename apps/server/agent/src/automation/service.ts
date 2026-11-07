import { createHash } from "node:crypto";
import type { AutomationDispatch, QuotaRecovery } from "@agent-workspace/contracts/automation";
import type { WorkspaceRun } from "@agent-workspace/contracts/workspace";

export interface AutomationStore {
  readRecord<T>(namespace: string, key: string): T | null;
  writeRecord<T>(namespace: string, key: string, value: T): void;
  deleteRecord(namespace: string, key: string): void;
  listRecords<T>(namespace: string): T[];
  transaction<T>(fn: () => T): T;
}
export type ChatRecoveryCandidate = {
  id: string; threadId: string; status: WorkspaceRun['status']; errorClass?: string; resetAt?: string;
  providerInstanceId?: string; providerInstanceRevision?: number; startedAt: string; requestBinding: string; latest: boolean;
  continuationRunId?: string; continuationIdempotencyKey?: string;
};
export interface ChatRecoveryAdapter {
  getCandidate(id: string): ChatRecoveryCandidate | null;
  latestInThread(threadId: string): ChatRecoveryCandidate | null;
  continueRun(id: string, options: { idempotencyKey: string }): Promise<{ id: string; status: WorkspaceRun['status'] }>;
}
type RecoveryRecord = QuotaRecovery & { kind: 'chat'; revision: number; providerBinding: string; requestBinding: string };
type DispatchRecord = Omit<AutomationDispatch, 'runStatus'> & { threadId: string; idempotencyKey: string; sourceRevision: number };
type Dependencies = { store: AutomationStore; chat: ChatRecoveryAdapter; providerIdentity(id: string): string | null; latestLegacyRun?: (threadId: string) => WorkspaceRun | null; now?: () => number };
const RECOVERY = 'automation.recovery', DISPATCHES = 'automation.dispatches';
export class AutomationError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) { super(message); this.status = status; }
}
/** Only validated Chat quota recovery remains here. PM Automation Studio owns schedules/events/templates. */
export class AutomationService {
  private readonly store: AutomationStore;
  private readonly now: () => number;
  private readonly dependencies: Dependencies;
  private timer?: NodeJS.Timeout;
  private working: Promise<void> | null = null;
  private stopping = false;
  constructor(dependencies: Dependencies) { this.dependencies = dependencies; this.store = dependencies.store; this.now = dependencies.now ?? Date.now; }
  recoveries(): QuotaRecovery[] {
    return this.store.listRecords<RecoveryRecord>(RECOVERY).filter(record => record.kind === 'chat').map(({ providerBinding: _provider, requestBinding: _request, revision: _revision, kind: _kind, ...record }) => record);
  }
  dispatches(sourceId?: string): AutomationDispatch[] {
    return this.store.listRecords<DispatchRecord>(DISPATCHES).filter(record => !sourceId || record.sourceId === sourceId).reverse().map(({ threadId: _thread, idempotencyKey: _key, sourceRevision: _revision, ...record }) => {
      const run = record.runId ? this.dependencies.chat.getCandidate(record.runId) : null;
      return { ...record, ...(run ? { runStatus: run.status } : {}) };
    });
  }
  private blocked(record: RecoveryRecord): string | null {
    const run = this.dependencies.chat.getCandidate(record.runId);
    if (!run || run.status !== 'failed' || run.errorClass !== 'usage_limit') return '原聊天不再是可恢复的额度失败，或不属于新版 Session。';
    if (!run.resetAt || !Number.isFinite(Date.parse(run.resetAt)) || run.resetAt !== record.resetAt) return '聊天额度重置时间缺失或已变化。';
    if (!run.latest || run.continuationRunId) return '聊天已有更新的请求或 continuation，不自动续跑。';
    const legacy = this.dependencies.latestLegacyRun?.(run.threadId);
    if (legacy && Date.parse(legacy.startedAt) >= Date.parse(run.startedAt)) return '此 Thread 已有更新的历史资源运行，不自动续跑旧聊天。';
    if (!run.providerInstanceId || !Number.isSafeInteger(run.providerInstanceRevision) || run.providerInstanceId !== record.providerInstanceId || `${run.providerInstanceId}:${run.providerInstanceRevision}` !== record.providerBinding || this.dependencies.providerIdentity(run.providerInstanceId) !== record.providerBinding) return '聊天 Provider 实例或账号配置已变化，或失败时的实例版本未知。';
    if (run.requestBinding !== record.requestBinding) return '聊天请求快照已变化。';
    return null;
  }
  setRecovery(runId: string, enabled: boolean): QuotaRecovery {
    return this.store.transaction(() => {
      const run = this.dependencies.chat.getCandidate(runId);
      if (!run) throw new AutomationError('新版 Session 的回复不存在。', 404);
      const prior = this.store.readRecord<RecoveryRecord>(RECOVERY, runId);
      if (prior?.continuationRunId) {
        if (enabled) throw new AutomationError('该回复已经自动续跑，不重复授权。', 409);
        return this.recoveries().find(value => value.runId === runId)!;
      }
      if (enabled && this.dispatches(runId).some(dispatch => dispatch.sourceType === 'recovery' && dispatch.status === 'failed')) throw new AutomationError('恢复派发已失败；请先核对原副作用，再手动决定是否恢复。', 409);
      if (enabled && prior?.enabled && !this.blocked(prior)) return this.recoveries().find(value => value.runId === runId)!;
      const record: RecoveryRecord = { runId, enabled, state: enabled ? 'waiting' : 'cancelled', resetAt: run.resetAt ?? null, providerInstanceId: run.providerInstanceId ?? null,
        providerBinding: run.providerInstanceId && Number.isSafeInteger(run.providerInstanceRevision) ? `${run.providerInstanceId}:${run.providerInstanceRevision}` : '', requestBinding: run.requestBinding, kind: 'chat', revision: (prior?.revision ?? 0) + 1, updatedAt: new Date(this.now()).toISOString() };
      const reason = enabled ? this.blocked(record) : null;
      if (reason) throw new AutomationError(reason, 409);
      this.store.writeRecord(RECOVERY, runId, record);
      for (const dispatch of this.store.listRecords<DispatchRecord>(DISPATCHES)) if (dispatch.sourceType === 'recovery' && dispatch.sourceId === runId && dispatch.status === 'pending') this.store.writeRecord(DISPATCHES, dispatch.id, { ...dispatch, status: 'cancelled' });
      return this.recoveries().find(value => value.runId === runId)!;
    });
  }
  tick(_startup = false): Promise<void> {
    if (this.working) return this.working;
    this.working = this.performTick().finally(() => { this.working = null; });
    return this.working;
  }
  private async performTick(): Promise<void> {
    if (this.stopping) return;
    this.store.transaction(() => {
      for (const record of this.store.listRecords<RecoveryRecord>(RECOVERY)) {
        if (record.kind !== 'chat' || !record.enabled || record.state !== 'waiting') continue;
        const pending = this.store.listRecords<DispatchRecord>(DISPATCHES).find(dispatch => dispatch.sourceType === 'recovery' && dispatch.sourceId === record.runId && dispatch.status === 'pending');
        if (pending) continue;
        const reason = this.blocked(record);
        if (reason) { this.store.writeRecord(RECOVERY, record.runId, { ...record, enabled: false, state: 'blocked', error: reason, updatedAt: new Date(this.now()).toISOString() }); continue; }
        if (Date.parse(record.resetAt!) > this.now()) continue;
        const run = this.dependencies.chat.getCandidate(record.runId)!;
        const key = `recovery:${record.runId}:${record.revision}:quota-reset`;
        const id = createHash('sha256').update(key).digest('hex');
        if (this.store.readRecord(DISPATCHES, id)) continue;
        this.store.writeRecord<DispatchRecord>(DISPATCHES, id, { id, sourceType: 'recovery', sourceId: record.runId, sourceRevision: record.revision, key, idempotencyKey: `automation:${id}`, threadId: run.threadId, reason: '已授权的聊天额度到期续跑', status: 'pending', createdAt: new Date(this.now()).toISOString() });
      }
    });
    for (const dispatch of this.store.listRecords<DispatchRecord>(DISPATCHES)) {
      if (this.stopping) return;
      if (dispatch.sourceType !== 'recovery' || dispatch.status !== 'pending') continue;
      const recovery = this.store.readRecord<RecoveryRecord>(RECOVERY, dispatch.sourceId);
      if (!recovery || recovery.kind !== 'chat') continue; // Old resource schedules/watches/recoveries are historical, never executable aliases.
      const source = this.dependencies.chat.getCandidate(dispatch.sourceId);
      const accepted = source?.continuationIdempotencyKey === dispatch.idempotencyKey ? source.continuationRunId : undefined;
      if (accepted) { this.accept(dispatch, recovery, accepted); continue; }
      const reason = this.blocked(recovery);
      if (!recovery.enabled || recovery.revision !== dispatch.sourceRevision || reason) {
        this.store.writeRecord(DISPATCHES, dispatch.id, { ...dispatch, status: 'cancelled', ...(reason ? { error: reason } : {}) }); continue;
      }
      if (Date.parse(recovery.resetAt!) > this.now()) continue;
      try {
        const run = await this.dependencies.chat.continueRun(dispatch.sourceId, { idempotencyKey: dispatch.idempotencyKey });
        this.accept(dispatch, recovery, run.id);
      } catch (error) {
        const observed = this.dependencies.chat.getCandidate(dispatch.sourceId);
        if (observed?.continuationIdempotencyKey === dispatch.idempotencyKey && observed.continuationRunId) {
          this.accept(dispatch, recovery, observed.continuationRunId); continue;
        }
        const message = error instanceof Error && 'code' in error && error.code === 'side_effect_confirmation_required' ? 'CLI 副作用需要人工确认，未自动续跑。' : '恢复未被确认：请重新核验执行目录、Provider、业务操作权限与原副作用；没有自动重派。';
        this.store.transaction(() => {
          this.store.writeRecord(DISPATCHES, dispatch.id, { ...dispatch, status: 'failed', error: message });
          const current = this.store.readRecord<RecoveryRecord>(RECOVERY, recovery.runId);
          if (current) this.store.writeRecord(RECOVERY, current.runId, { ...current, enabled: false, state: 'blocked', error: message, updatedAt: new Date(this.now()).toISOString() });
        });
      }
    }
  }
  private accept(dispatch: DispatchRecord, recovery: RecoveryRecord, id: string): void {
    this.store.transaction(() => {
      this.store.writeRecord(DISPATCHES, dispatch.id, { ...dispatch, status: 'dispatched', runId: id });
      const current = this.store.readRecord<RecoveryRecord>(RECOVERY, recovery.runId);
      if (current) this.store.writeRecord(RECOVERY, recovery.runId, { ...current, enabled: false, state: 'dispatched', continuationRunId: id, updatedAt: new Date(this.now()).toISOString() });
    });
  }
  async start(): Promise<void> {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => { void this.tick().catch(() => console.error('Chat quota recovery failed')); }, 5000); this.timer.unref();
    try { await this.tick(true); } catch (error) { clearInterval(this.timer); this.timer = undefined; throw error; }
  }
  async stop(): Promise<void> { this.stopping = true; clearInterval(this.timer); this.timer = undefined; await this.working; }
}
