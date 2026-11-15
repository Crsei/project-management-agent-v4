import { realpath } from 'node:fs/promises';
import { DurableError } from '../durable/errors.ts';
import { listRecords } from '../durable/store.ts';

export const COLLABORATION_RUNS = 'collaboration:runs:v1';
export const COLLABORATION_DELEGATIONS = 'collaboration:delegations:v1';
export const COLLABORATION_REQUESTS = 'collaboration:run-requests:v1';

const activeStatuses: Record<string, true> = { queued: true, running: true, waiting: true };
export function assertCollaborationThreadLifecycleMutation(threadId: string): void {
  const runs = listRecords<{ threadId: string | null; status: string; operationRefs?: { status: string }[] }>(COLLABORATION_RUNS);
  if (runs.some(run => run.threadId === threadId && (activeStatuses[run.status] || run.status === 'unknown' ||
      run.operationRefs?.some(operation => operation.status === 'pending' || operation.status === 'unknown'))))
    throw new DurableError(409, 'collaboration_run_unresolved', 'This Session belongs to an active or unresolved business Run; stop and reconcile its original Run first.');
}

type Waiter = { owner: string; key: string; rootId: string; limit: number; agent?: { id: string; maxActiveRuns: number }; signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: unknown) => void; onAbort: () => void };
/** A single host arbiter covers every collaboration tree and real directory alias. */
export class CollaborationCoordinator {
  private readonly leases = new Map<string, { key: string; rootId: string; agentId?: string }>();
  private readonly waiters: Waiter[] = [];

  owns(owner: string, directory: string): boolean {
    return this.leases.get(owner)?.key === directory;
  }

  acquire(owner: string, realDirectory: string, rootId: string, limit: number, signal: AbortSignal, agent?: { id: string; maxActiveRuns: number }): Promise<() => void> {
    signal.throwIfAborted();
    if (this.leases.has(owner) || this.waiters.some(item => item.owner === owner))
      throw new DurableError(409, 'duplicate_run_lease', 'The Run already owns or awaits an execution lease.');
    const { promise, resolve, reject } = Promise.withResolvers<() => void>();
    const waiter: Waiter = { owner, key: realDirectory, rootId, limit, ...(agent ? { agent } : {}), signal, resolve, reject, onAbort: () => {
      const index = this.waiters.indexOf(waiter);
      if (index >= 0) this.waiters.splice(index, 1);
      reject(signal.reason ?? new Error('Run cancelled while queued.'));
      this.drain();
    } };
    signal.addEventListener('abort', waiter.onAbort, { once: true });
    this.waiters.push(waiter);
    this.drain();
    return promise;
  }

  private drain(): void {
    for (let index = 0; index < this.waiters.length;) {
      const waiter = this.waiters[index]!;
      if (waiter.signal.aborted) { waiter.onAbort(); continue; }
      const held = [...this.leases.values()];
      if (held.some(lease => lease.key === waiter.key) || held.filter(lease => lease.rootId === waiter.rootId).length >= waiter.limit ||
          waiter.agent && held.filter(lease => lease.agentId === waiter.agent!.id).length >= waiter.agent.maxActiveRuns) {
        index++;
        continue;
      }
      this.waiters.splice(index, 1);
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      this.leases.set(waiter.owner, { key: waiter.key, rootId: waiter.rootId, ...(waiter.agent ? { agentId: waiter.agent.id } : {}) });
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.leases.delete(waiter.owner);
        this.drain();
      });
    }
  }
}

export const collaborationCoordinator = new CollaborationCoordinator();

/** Ordinary Chat participates too; otherwise a second Session could bypass a Run's writer lock. */
export async function acquireChatDirectoryWriter(threadId: string, generationId: string, directory: string, signal: AbortSignal): Promise<(() => void) | undefined> {
  const actual = await realpath(directory);
  signal.throwIfAborted();
  const run = listRecords<{ id: string; threadId: string | null }>(COLLABORATION_RUNS).find(item => item.threadId === threadId);
  if (run) {
    if (!collaborationCoordinator.owns(run.id, actual))
      throw new DurableError(409, 'run_writer_lease_missing', 'Business generation does not own the fixed actual-directory writer lease.');
    return undefined;
  }
  return collaborationCoordinator.acquire(`chat:${generationId}`, actual, `chat:${generationId}`, 1, signal);
}
