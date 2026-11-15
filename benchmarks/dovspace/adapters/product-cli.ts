import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Arm, BenchAgentAdapter, BenchEvent, GenerationAdmission, PrepareAdapterInput } from '../schemas/types.ts';
import { hashValue, makeEvent } from '../runners/telemetry.ts';
import { AdapterError, beginGenerationAdmission, buildArmSystemPrompt } from './agent-chat.ts';
import { ProductCliProcess, type CliCommandOptions, type CliCommandResult } from './product-cli-process.ts';

type Json = Record<string, unknown>;
type ObservationKind = 'session' | 'execution' | 'message-context' | 'generation' | 'output' | 'usage';
type Session = {
  id: string; taskId: string; messageId: string; idempotencyKey: string; generationId: string;
  events: BenchEvent[]; waiter?: () => void; observed: boolean; ended: boolean; interrupted: boolean; interrupting: boolean;
  controller: AbortController; work: Promise<void>; submissionAttempted: boolean; stopIssued: boolean; interruption?: Promise<void>; outputHash?: string;
};
const terminal: Record<string, true> = { completed: true, failed: true, cancelled: true, interrupted: true };
function object(value: unknown): Json | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined; }

/** Runs the product's staged operator CLI; never falls back to an HTTP client. */
export class ProductCliAdapter implements BenchAgentAdapter {
  private input?: PrepareAdapterInput;
  private cli?: ProductCliProcess;
  private selection?: { version: 2; agentWorkspaceId: string; agentWorkspaceRevision: number };
  private providerInstanceId = '';
  private selectedModel = '';
  private systemPrompt = '';
  private readonly sessions = new Map<string, Session>();
  private failed = false;
  private disposed = false;
  private closing?: Promise<void>;
  private readonly arm: Arm;
  constructor(arm: Arm = 'dovspace') { this.arm = arm; }

  async prepare(input: PrepareAdapterInput): Promise<void> {
    if (this.input || this.disposed) throw new AdapterError('infrastructure', 'Adapter prepare is single-use; each run requires an independent fixture.');
    const runtime = input.fixture.runtime;
    if (!runtime?.isolationVerified || !input.fixture.isolation?.verified) throw new AdapterError('infrastructure', 'Verified OS-isolated Agent runtime is required.');
    for (const [kind, value] of [['Agent', runtime.agentBaseUrl], ['PM', input.fixture.pm.baseUrl]]) {
      const url = new URL(value!);
      if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || ['3224', '4194', '4325', '55444'].includes(url.port) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new AdapterError('infrastructure', `${kind} control URL must be an isolated non-production loopback origin.`);
    }
    if (input.provider !== 'codex' && input.provider !== 'omp') throw new AdapterError('provider', 'Benchmark supports explicit native Codex or OMP only; no provider fallback.', 'unsupported_provider');
    if (!input.model.trim() || !runtime.agentAccessToken || !runtime.pmCookie) throw new AdapterError('infrastructure', 'Isolated Agent credentials and an explicit fixed model are required.', 'provider_prerequisite');
    const provision = runtime.providerConfig;
    if (!provision || provision.driver !== input.provider || provision.instanceId !== input.provider) throw new AdapterError('infrastructure', 'Native broker configuration does not match the explicitly selected runtime provider.', 'provider_prerequisite');
    this.input = input;
    try {
      this.cli = await ProductCliProcess.open(input.runId, input.fixture, event => runtime.auditEvents.push(event));
      runtime.auditEvents.push(makeEvent(input.runId, 'transport', 'cli_source_attestation', { productSource: this.cli.productSource, executable: 'node', conditions: ['development'], controller: 'trusted-host', nativeIsolation: 'existing-fixture' }));
      const login = await this.command(['agent', 'login', '--token-stdin', 'true'], { stdin: runtime.agentAccessToken });
      const expiry = typeof login.localExpiresAt === 'string' ? Date.parse(login.localExpiresAt) : NaN;
      if (login.identity !== 'agent_operator' || login.credentialSource !== 'saved' || login.serviceUrl !== new URL(runtime.agentBaseUrl).origin || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 8 * 60 * 60 * 1000) throw new AdapterError('infrastructure', 'Native CLI did not establish a finite saved independent Agent connection.', 'cli_identity');
      this.providerInstanceId = provision.instanceId;
      this.selectedModel = input.provider === 'omp' ? input.nativeModel ?? `bench/${input.model}` : input.model;
      const catalog = await this.command(['agent', 'provider', 'list', '--consent', 'native-probe'], { timeoutMs: 180_000 });
      const providers = Array.isArray(catalog.providers) ? catalog.providers as Json[] : [];
      const current = providers.find(provider => provider.instanceId === provision.instanceId);
      const configuration = { enabled: true, config: provision.config, environment: provision.environment, customModels: input.provider === 'omp' ? [] : [{ id: input.model, label: input.model }] };
      if (current && typeof current.revision === 'number') {
        await this.command(['agent', 'provider', 'update', provision.instanceId, '--consent', 'native-probe'], { file: { revision: current.revision, ...configuration }, timeoutMs: 180_000 }, true);
      } else if (input.provider === 'omp') {
        await this.command(['agent', 'provider', 'create', '--consent', 'native-probe'], { file: { instanceId: provision.instanceId, driver: 'omp', ...configuration }, timeoutMs: 180_000 }, true);
      } else throw new AdapterError('provider', 'Native Codex configuration was not initialized by the isolated service.', 'provider_unavailable');
      const health = await this.command(['agent', 'provider', 'health', provision.instanceId, '--consent', 'native-probe'], { timeoutMs: 180_000 });
      if (health.ok !== true || health.nativeSessionReady !== true) throw new AdapterError('infrastructure', `Native ${input.provider} prerequisite is not ready; no inference was attempted.`, 'provider_prerequisite');
      if (input.provider === 'omp' && (!Array.isArray(health.models) || !health.models.some(model => object(model)?.id === this.selectedModel))) throw new AdapterError('provider', 'The exact broker-backed OMP model was not discovered; no custom catalog or default-model fallback is allowed.', 'model_unavailable');
      runtime.auditEvents.push(makeEvent(input.runId, 'transport', 'provider_selection', this.cli.redactor.value({ provider: input.provider, instanceId: this.providerInstanceId, requestedModel: input.model, nativeModel: this.selectedModel, health, inferencePerformed: false }) as Json));
      const opened = await this.command(['agent', 'folder', 'register', '--path', runtime.workingDirectory, '--name', `Benchmark ${input.runId}`], {}, true);
      const workspace = object(opened.workspace);
      if (!workspace || typeof workspace.id !== 'string' || typeof workspace.revision !== 'number' || workspace.path !== runtime.workingDirectory || workspace.status !== 'available') throw new AdapterError('infrastructure', 'Agent did not attest the isolated workspace directory.');
      this.selection = { version: 2, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
      this.systemPrompt = buildArmSystemPrompt(this.arm, input);
    } catch (error) { this.failed = true; await this.cli?.dispose(); throw error; }
  }

  async start(input: { instruction: string; taskId: string }): Promise<{ sessionId: string }> {
    if (!this.input || !this.cli || !this.selection || this.failed || this.disposed) throw new AdapterError('infrastructure', 'Prepare a healthy isolated CLI adapter before starting; unknown outcomes cannot be replayed.');
    if ([...this.sessions.values()].some(session => !session.ended)) throw new AdapterError('infrastructure', 'A benchmark adapter permits only one active Session.');
    const modelOptions = Object.entries(this.input.modelOptions ?? {}).map(([key, value]) => {
      if (typeof value !== 'string' && typeof value !== 'boolean') throw new AdapterError('provider', `Invalid native model option ${key}.`);
      return { id: key, value };
    });
    const id = `bench-${randomUUID()}`;
    const session: Session = { id, taskId: input.taskId, messageId: randomUUID(), idempotencyKey: randomUUID(), generationId: '', events: [], observed: false, ended: false, interrupted: false, interrupting: false, controller: new AbortController(), work: Promise.resolve(), submissionAttempted: false, stopIssued: false };
    this.sessions.set(id, session);
    this.input.fixture.runtime!.activeGenerationAdmission?.settle(null);
    delete this.input.fixture.runtime!.activeGenerationAdmission;
    this.input.fixture.runtime!.activeSessionId = id;
    delete this.input.fixture.runtime!.activeGenerationId;
    let admission: GenerationAdmission | undefined;
    try {
      const created = await this.command(['agent', 'session', 'create', '--pm-context', 'true'], { file: { id, executionSelection: this.selection } }, true, session);
      this.observation(session, 'session', created);
      const thread = object(created.thread);
      if (!thread || typeof thread.revision !== 'number' || thread.id !== undefined && thread.id !== id || thread.remoteId !== undefined && thread.remoteId !== id) throw new AdapterError('infrastructure', 'Agent did not return the original persisted new Session.', 'unknown_acceptance');
      const configured = await this.command(['agent', 'session', 'update', id, '--pm-context', 'true'], { file: { revision: thread.revision, settings: { providerInstanceId: this.providerInstanceId, model: this.selectedModel, systemPrompt: this.systemPrompt, temperature: 1, modelOptions, interactionMode: 'default' } } }, true, session);
      this.observation(session, 'session', configured);
      const settingsRevision = object(configured.thread)?.revision;
      if (typeof settingsRevision !== 'number') throw new AdapterError('provider', 'Agent did not persist fixed provider/model settings.', 'unknown_acceptance');
      admission = beginGenerationAdmission(this.input.fixture.runtime!, id, session.controller.signal);
      session.submissionAttempted = true;
      const sent = await this.cli.run(['agent', 'message', 'send', id, '--pm-context', 'true', '--follow', 'false', '--timeout-ms', '40000'], {
        file: { id, messages: [{ id: session.messageId, role: 'user', parts: [{ type: 'text', text: input.instruction }] }], idempotencyKey: session.idempotencyKey,
          config: { providerInstanceId: this.providerInstanceId, modelName: this.selectedModel, modelOptions, threadSettingsRevision: settingsRevision, responseStreamingMode: 'paragraph' } }, timeoutMs: 45_000, signal: session.controller.signal,
      });
      const accepted = sent.records.filter(record => record.kind === 'stream-open');
      if (accepted.length === 1 && typeof accepted[0]!.generationId === 'string') {
        session.generationId = accepted[0]!.generationId;
      }
      if (sent.outcome !== 'completed' || accepted.length !== 1 || !session.generationId || accepted[0]!.inputMessageId !== undefined && accepted[0]!.inputMessageId !== session.messageId || !sent.records.some(record => record.kind === 'stream-closed' && record.generationId === session.generationId && record.reason === 'detached')) throw new AdapterError('infrastructure', `Agent CLI submit outcome unknown; inspect original Session ${id}, message ${session.messageId} and idempotency key ${session.idempotencyKey}; never resubmit.`, 'unknown_acceptance');
      if (!admission.settle(session.generationId)) throw new AdapterError('infrastructure', 'Agent CLI acceptance was cancelled, expired or superseded; inspect the original Session without resubmitting.', 'unknown_acceptance');
      this.push(session, makeEvent(this.input.runId, 'transport', 'session_started', { generationId: session.generationId, taskId: input.taskId, model: this.input.model, arm: this.arm, fresh: true }, { sessionId: id }));
      session.work = this.consume(session);
      return { sessionId: id };
    } catch (error) {
      admission?.settle(null); session.controller.abort();
      this.failed = true; session.ended = true;
      this.observation(session, session.submissionAttempted ? 'generation' : 'session', null, error);
      this.input.fixture.runtime!.auditEvents.push(makeEvent(this.input.runId, 'transport', 'cli_mutation_unknown', { sessionId: id, messageId: session.messageId, idempotencyKey: session.idempotencyKey, generationId: session.generationId || null, error: this.safeError(error), replayed: false }, { sessionId: id }));
      // No controller process survives a failed start. Generation cleanup is exact-ID reconciliation in dispose.
      throw error;
    }
  }

  sessionIdentity(sessionId: string): { sessionId: string; generationId: string } {
    const session = this.session(sessionId);
    if (!session.generationId) throw new AdapterError('infrastructure', 'Original generation acceptance remains unknown.', 'unknown_acceptance');
    return { sessionId: session.id, generationId: session.generationId };
  }

  async *observe(sessionId: string): AsyncIterable<BenchEvent> {
    const session = this.session(sessionId);
    if (session.observed) throw new AdapterError('infrastructure', 'Each Session observation stream has one consumer.');
    session.observed = true;
    let cursor = 0;
    while (true) {
      while (cursor < session.events.length) yield session.events[cursor++]!;
      session.events.length = 0; cursor = 0;
      if (session.ended && !session.interrupting) return;
      const { promise, resolve } = Promise.withResolvers<void>();
      session.waiter = resolve;
      await promise;
    }
  }

  async interrupt(sessionId: string, reason: string): Promise<void> {
    const session = this.session(sessionId);
    if (session.interrupted) return;
    return session.interruption ??= this.acknowledgeInterruption(session, reason);
  }

  async resume(input: { priorSessionId: string; instruction: string }): Promise<{ sessionId: string }> {
    const previous = this.session(input.priorSessionId);
    if (!previous.interrupted) throw new AdapterError('interrupted', 'Resume requires trusted acknowledgement of the previous Session interruption.');
    const next = await this.start({ instruction: input.instruction, taskId: previous.taskId });
    const session = this.session(next.sessionId);
    this.push(session, makeEvent(this.input!.runId, 'transport', 'session_resumed', { priorSessionId: previous.id, generationId: session.generationId, fresh: true, copiedHistory: false }, { sessionId: next.sessionId }));
    return next;
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.session(sessionId);
    try { if (!session.ended) await this.interrupt(sessionId, 'Runner cleanup'); }
    finally { session.controller.abort(); await session.work; }
  }

  dispose(): Promise<void> {
    return this.closing ??= (async () => {
      this.disposed = true;
      this.input?.fixture.runtime?.activeGenerationAdmission?.settle(null);
      const failures: unknown[] = [];
      try {
        for (const session of this.sessions.values()) {
          try {
            if (!session.generationId && session.submissionAttempted && this.cli) {
              // A lost submit response is reconciled by the ORIGINAL input, never by another send.
              const listed = await this.command(['agent', 'generation', 'list', session.id, '--pm-context', 'true'], { purpose: 'observation' });
              const matches = Array.isArray(listed.generations) ? listed.generations.map(object).filter(generation => generation?.inputMessageId === session.messageId && generation.threadId === session.id) : [];
              if (matches.length === 1 && typeof matches[0]!.id === 'string') session.generationId = matches[0]!.id;
              else if (this.failed) throw new AdapterError('infrastructure', 'Unknown submit could not be reconciled to one original generation; fixture shutdown must terminate it.', 'unknown_acceptance');
            }
            if (session.generationId && !session.interrupted) {
              const generation = await this.generation(session);
              if (!terminal[String(generation.status)]) {
                if (session.stopIssued) throw new AdapterError('interrupted', 'Original stop remains unconfirmed; fixture shutdown must terminate it without replay.');
                await this.interrupt(session.id, 'CLI controller disposal');
              }
            }
          } catch (error) { failures.push(error); }
          finally { session.controller.abort(); await session.work; }
        }
      } finally { try { await this.cli?.dispose(); } catch (error) { failures.push(error); } }
      if (failures.length) throw new AggregateError(failures, 'CLI controller cleanup incomplete; original identities were not replayed.');
    })();
  }

  private session(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new AdapterError('infrastructure', 'Unknown Session identity.');
    return session;
  }
  private push(session: Session, event: BenchEvent): void {
    if (session.generationId) event.generationId = session.generationId;
    session.events.push(event); session.waiter?.(); delete session.waiter;
  }
  private safeError(error: unknown): string { return this.cli?.redactor.text(error instanceof Error ? error.message : String(error)) ?? 'Product CLI failed.'; }
  private observation(session: Session, kind: ObservationKind, value: unknown | null, error?: unknown): void {
    const event = makeEvent(this.input!.runId, 'transport', 'cli_observation', {
      kind, collectionStatus: error === undefined ? 'observed' : 'unavailable', value: this.cli!.redactor.value(value),
      productSource: this.cli!.productSource, ...(kind === 'message-context' ? { messageId: session.messageId } : {}),
      ...(error === undefined ? {} : { error: this.safeError(error) }),
    }, { sessionId: session.id });
    if (session.generationId) event.generationId = session.generationId;
    // Start may fail before a consumer is attached; retain its evidence in the fixture audit lane.
    this.input!.fixture.runtime!.auditEvents.push(event);
  }
  private async command(args: readonly string[], options: CliCommandOptions = {}, mutation = false, session?: Session): Promise<Json> {
    let result: CliCommandResult;
    try { result = await this.cli!.run(args, options); }
    catch (error) {
      if (!mutation) throw error;
      this.failed = true;
      throw new AdapterError('infrastructure', `CLI mutation outcome unknown; original identity must be inspected, not repeated. ${this.safeError(error)}`, 'unknown_acceptance');
    }
    if (result.outcome !== 'completed' || result.records.length !== 1) {
      if (mutation) this.failed = true;
      throw new AdapterError('infrastructure', mutation
        ? `CLI mutation outcome unknown${session ? ` for original Session ${session.id}` : ''}; no retry or replacement is allowed.`
        : `CLI projection unavailable (exit ${result.exitCode ?? 'unknown'}, outcome ${result.outcome}).`, mutation ? 'unknown_acceptance' : 'cli_unavailable');
    }
    return result.records[0]!;
  }
  private async generation(session: Session): Promise<Json> {
    const response = await this.command(['agent', 'generation', 'status', session.id, '--generation', session.generationId, '--pm-context', 'true'], { purpose: 'observation', timeoutMs: 10_000 });
    this.observation(session, 'generation', response);
    const generation = object(response.generation);
    if (!generation || generation.id !== session.generationId || generation.threadId !== session.id || generation.inputMessageId !== undefined && generation.inputMessageId !== session.messageId) throw new AdapterError('infrastructure', 'Original Session/generation/input projection mismatch; never selecting a replacement.', 'cli_identity');
    return generation;
  }
  private async collect(session: Session, kind: ObservationKind, args: readonly string[]): Promise<void> {
    try { this.observation(session, kind, await this.command(args, { purpose: 'observation', timeoutMs: 10_000 })); }
    catch (error) { this.observation(session, kind, null, error); }
  }
  private async output(session: Session): Promise<void> {
    try {
      const result = await this.cli!.run(['agent', 'generation', 'output', session.generationId, '--pm-context', 'true', '--follow', 'false', '--timeout-ms', '8000'], { timeoutMs: 10_000, purpose: 'observation', signal: session.controller.signal });
      if (result.outcome !== 'completed') throw new AdapterError('infrastructure', 'CLI native output projection is unavailable.', 'cli_unavailable');
      this.observation(session, 'output', { records: result.records });
      const frames = result.records.filter(record => record.kind === 'native');
      if (!frames.length || result.records.some(record => record.generationId !== session.generationId)) throw new AdapterError('infrastructure', 'CLI native output lacks the original generation identity.', 'cli_identity');
      for (const record of frames) {
        const frame = object(record.event), snapshot = object(frame?.snapshot);
        if (!frame || (frame.kind === 'snapshot' ? snapshot?.generationId !== session.generationId || snapshot.threadId !== session.id : frame.generationId !== session.generationId)) throw new AdapterError('infrastructure', 'Native output Session/generation mismatch.', 'cli_identity');
        const frameHash = hashValue(frame);
        if (frameHash !== session.outputHash) {
          session.outputHash = frameHash;
          this.push(session, makeEvent(this.input!.runId, 'provider', 'native_output', { generationId: session.generationId, frame: this.cli!.redactor.value(frame) }, { sessionId: session.id }));
        }
      }
    } catch (error) {
      if (!session.controller.signal.aborted) {
        this.observation(session, 'output', null, error);
        if (error instanceof AdapterError && error.code === 'cli_identity') throw error;
      }
    }
  }
  private async consume(session: Session): Promise<void> {
    const deadline = Date.now() + this.input!.budget.maxDurationMinutes * 60_000;
    try {
      await this.collect(session, 'session', ['agent', 'session', 'read', session.id, '--pm-context', 'true']);
      await this.collect(session, 'execution', ['agent', 'session', 'execution', session.id, '--pm-context', 'true']);
      await this.collect(session, 'message-context', ['agent', 'message', 'context', session.id, session.messageId, '--pm-context', 'true']);
      while (!session.controller.signal.aborted) {
        const generation = await this.generation(session);
        await this.output(session);
        if (terminal[String(generation.status)]) {
          this.push(session, makeEvent(this.input!.runId, 'transport', 'generation_status', this.cli!.redactor.value({ ...generation }) as Json, { sessionId: session.id }));
          await this.collect(session, 'execution', ['agent', 'session', 'execution', session.id, '--pm-context', 'true']);
          await this.collect(session, 'usage', ['agent', 'usage', 'thread', session.id]);
          return;
        }
        if (Date.now() >= deadline) throw new AdapterError('budget', 'CLI observation reached the existing run duration budget.', 'runner_budget');
        await delay(250, undefined, { signal: session.controller.signal });
      }
    } catch (error) {
      if (!session.controller.signal.aborted) {
        this.failed = true;
        this.push(session, makeEvent(this.input!.runId, 'transport', 'adapter_error', { message: this.safeError(error), category: error instanceof AdapterError ? error.category : 'infrastructure' }, { sessionId: session.id }));
      }
    } finally { session.ended = true; session.waiter?.(); delete session.waiter; }
  }
  private async acknowledgeInterruption(session: Session, reason: string): Promise<void> {
    if (!session.generationId) throw new AdapterError('interrupted', 'Cannot stop an unknown generation; inspect the original submission identity first.');
    session.interrupting = true;
    try {
      let generation = await this.generation(session);
      const wasActive = !terminal[String(generation.status)];
      if (wasActive) {
        if (session.stopIssued) throw new AdapterError('interrupted', 'Original stop outcome is unknown; it cannot be replayed.');
        session.stopIssued = true;
        // A stop response may itself be unknown. Only read the original generation afterwards.
        try {
          const stopped = await this.command(['agent', 'generation', 'stop', session.id, '--generation', session.generationId, '--message', session.messageId, '--pm-context', 'true'], { timeoutMs: 10_000 });
          this.observation(session, 'generation', stopped);
        } catch (error) {
          this.observation(session, 'generation', null, error);
          const event = makeEvent(this.input!.runId, 'transport', 'cli_stop_unknown', { generationId: session.generationId, error: this.safeError(error), replayed: false }, { sessionId: session.id });
          event.generationId = session.generationId;
          this.input!.fixture.runtime!.auditEvents.push(event);
        }
        const deadline = Date.now() + 20_000;
        do {
          generation = await this.generation(session);
          if (terminal[String(generation.status)]) break;
          if (Date.now() >= deadline) throw new AdapterError('interrupted', 'Agent did not acknowledge interruption; new Session resume is forbidden.');
          await delay(100);
        } while (!terminal[String(generation.status)]);
      }
      session.interrupted = true;
      this.push(session, makeEvent(this.input!.runId, 'transport', 'interrupt_acknowledged', { generationId: session.generationId, reason, status: generation.status, wasActive: wasActive && (generation.status === 'cancelled' || generation.status === 'interrupted') }, { sessionId: session.id }));
    } finally {
      session.controller.abort(); await session.work;
      session.interrupting = false; session.waiter?.(); delete session.waiter;
    }
  }
}
