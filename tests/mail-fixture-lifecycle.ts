import type { FastifyInstance } from 'fastify';
import type { ClientBase, Pool, PoolClient } from 'pg';
import assert from 'node:assert/strict';

// One real migration run measured 25.38s. Only schema creation gets this allowance;
// ordinary cases initialize in 15s and have their own 30s test deadline.
export const mailSchemaInitTimeout = 60_000;
export const mailFixtureInitTimeout = 15_000;
export const mailFixtureCaseTimeout = 30_000;
export const mailFixtureCleanupTimeout = 15_000;

type Cleanup = () => void | Promise<unknown>;

/** Own resources before the first await, including resources delivered after abort. */
export class MailFixtureScope {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly cleanup: Cleanup[] = [];
  private initializing: Promise<unknown> = Promise.resolve();
  private completion: Promise<void> | undefined;
  private readonly timer: NodeJS.Timeout;
  private readonly parent: AbortSignal | undefined;
  private readonly abortFromParent: () => void;

  constructor(signal?: AbortSignal, timeout = mailFixtureInitTimeout) {
    this.parent = signal;
    this.abortFromParent = () => this.cancel(signal?.reason);
    signal?.addEventListener('abort', this.abortFromParent, { once: true });
    this.timer = setTimeout(() => this.cancel(new Error(`Mail fixture initialization exceeded ${timeout}ms`)), timeout);
    this.timer.unref();
    if (signal?.aborted) this.controller.abort(signal.reason);
  }

  checkpoint(): void {
    this.signal.throwIfAborted();
  }

  own<T>(resource: T, dispose: (resource: T) => void | Promise<unknown>): T {
    this.cleanup.push(() => dispose(resource));
    return resource;
  }

  defer(dispose: Cleanup): void {
    this.cleanup.push(dispose);
  }

  async acquire<T>(create: () => T | Promise<T>, dispose: (resource: T) => void | Promise<unknown>): Promise<T> {
    this.checkpoint();
    const resource = await create();
    // Do not checkpoint between acquisition and ownership: abort may have won.
    this.own(resource, dispose);
    this.checkpoint();
    return resource;
  }

  async step<T>(operation: () => T | Promise<T>): Promise<T> {
    this.checkpoint();
    const result = await operation();
    this.checkpoint();
    return result;
  }

  async initialize<T>(operation: () => Promise<T>, detachSignalWhenReady = false): Promise<T> {
    this.initializing = Promise.resolve().then(() => {
      this.checkpoint();
      return operation();
    });
    try {
      const result = await this.initializing as T;
      this.checkpoint();
      clearTimeout(this.timer);
      // A suite database's signal covers initialization. Its suite owns close;
      // case scopes independently cover their complete lifetimes.
      if (detachSignalWhenReady) this.parent?.removeEventListener('abort', this.abortFromParent);
      return result;
    } catch (error) {
      const failure = this.signal.aborted ? this.signal.reason : error;
      try { await this.close(); }
      catch (cleanupError) { throw new AggregateError([failure, cleanupError], 'Mail fixture initialization and cleanup failed'); }
      throw failure;
    }
  }

  private cancel(reason: unknown): void {
    if (!this.signal.aborted) this.controller.abort(reason);
    // The caller/after hook receives the same completion and any cleanup error.
    void this.close().catch(() => undefined);
  }

  // Not async: concurrent callers must get the actual identical completion.
  close = (): Promise<void> => {
    if (this.completion) return this.completion;
    this.completion = Promise.resolve().then(async () => {
      clearTimeout(this.timer);
      this.parent?.removeEventListener('abort', this.abortFromParent);
      if (!this.signal.aborted) this.controller.abort(new Error('Mail fixture closed'));
      // Never race initialization and cleanup. An uncancellable mkdir/listen/etc
      // may still complete, and must register its ownership before we dispose it.
      await this.initializing.catch(() => undefined);
      const errors: unknown[] = [];
      while (this.cleanup.length) {
        try { await this.cleanup.pop()!(); }
        catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Mail fixture cleanup failed');
    });
    return this.completion;
  };
}

export type MailPoolInterrupt = { detach(): void; finish(): Promise<void> };
type BackendIdentity = { pid: number; started: string };
const poolIdentities = new WeakMap<Pool, WeakMap<ClientBase, BackendIdentity>>();

function identitiesForPool(pool: Pool) {
  const existing = poolIdentities.get(pool);
  if (existing) return existing;
  assert.equal(pool.totalCount, 0, 'Install mail fixture identity capture before opening this owned pool');
  const identities = new WeakMap<ClientBase, BackendIdentity>();
  const beforeConnect = pool.options.onConnect;
  // pg-pool awaits onConnect before emitting acquire or handing the client to a
  // borrower. An async acquire-event listener cannot provide that ordering.
  pool.options.onConnect = async client => {
    await beforeConnect?.(client);
    const result = await client.query<BackendIdentity>(
      'SELECT pid,backend_start::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()');
    assert.ok(result.rows[0], 'The owned client must have a PostgreSQL backend identity');
    identities.set(client, result.rows[0]);
  };
  poolIdentities.set(pool, identities);
  return identities;
}

/** Terminate only this pool's checked-out, same-user backend identities. */
export function interruptMailPoolOnAbort(pool: Pool, signal: AbortSignal, control: Pool): MailPoolInterrupt {
  const clients = new Map<PoolClient, BackendIdentity>();
  const identities = identitiesForPool(pool);
  const terminating = new WeakSet<PoolClient>();
  const pending: Promise<void>[] = [];
  const interrupt = (client: PoolClient, backend: BackendIdentity) => {
    if (terminating.has(client)) return;
    terminating.add(client);
    // Termination intentionally produces a client error/end event even while a
    // checked-out query is rejecting. Own that expected cancellation event until
    // end() finishes; never ask the pool to release someone else's client.
    const expectedTermination = () => {};
    client.on('error', expectedTermination);
    const completion = (async () => {
      try {
        const result = await control.query<{ terminated: boolean }>(
          `SELECT pg_terminate_backend(pid,5000) AS terminated FROM pg_stat_activity
           WHERE pid=$1 AND backend_start=$2::timestamptz AND usename=current_user`, [backend.pid, backend.started]);
        assert.ok(result.rows.every(row => row.terminated), 'The owned PostgreSQL backend did not terminate');
      } finally {
        try { await client.end(); }
        finally { client.off('error', expectedTermination); }
      }
    })();
    pending.push(completion);
    void completion.catch(() => undefined);
  };
  const acquire = (client: PoolClient) => {
    const identity = identities.get(client);
    assert.ok(identity, 'The awaited connection hook must identify a client before acquisition');
    clients.set(client, identity);
    if (signal.aborted) interrupt(client, identity);
  };
  const release = (_error: Error | undefined, client: PoolClient) => { clients.delete(client); };
  const abort = () => { for (const [client, identity] of clients) interrupt(client, identity); };
  const detach = () => {
    pool.off('acquire', acquire);
    pool.off('release', release);
    signal.removeEventListener('abort', abort);
  };
  pool.on('acquire', acquire);
  pool.on('release', release);
  signal.addEventListener('abort', abort, { once: true });
  return {
    detach,
    async finish() {
      detach();
      const results = await Promise.allSettled(pending);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Owned PostgreSQL cancellation failed');
    },
  };
}

export async function closeMailApp(app: FastifyInstance): Promise<void> {
  // A canceled fetch must not keep Fastify.close waiting for an owned HTTP peer.
  app.server.closeAllConnections();
  await app.close();
}
