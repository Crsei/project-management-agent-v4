import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Arm, BenchAgentAdapter, BenchEvent, PrepareAdapterInput } from '../schemas/types.ts';
import { makeEvent } from '../runners/telemetry.ts';
import { parseSse } from './sse.ts';

type Json = Record<string, unknown>;
type Session = { id: string; taskId: string; generationId: string; events: BenchEvent[]; waiter?: () => void; ended: boolean; controller: AbortController; work: Promise<void>; observed: boolean; interrupted: boolean; interrupting: boolean };

export class AdapterError extends Error {
  readonly category: 'infrastructure' | 'provider' | 'budget' | 'interrupted' | 'safety' | 'tool' | 'permission' | 'model';
  readonly code: string | undefined;
  constructor(category: AdapterError['category'], message: string, code?: string) {
    super(message); this.name = 'AdapterError'; this.category = category; this.code = code;
  }
}

/** The arms deliberately share the product's real native transport, not model replay. */
export class AgentChatAdapter implements BenchAgentAdapter {
  private input?: PrepareAdapterInput;
  private baseUrl = '';
  private headers = new Headers();
  private selection?: { version: 2; agentWorkspaceId: string; agentWorkspaceRevision: number };
  private sessions = new Map<string, Session>();
  private systemPrompt = '';
  private readonly arm: Arm;
  private readonly transport: typeof fetch;
  constructor(arm: Arm = 'dovspace', transport: typeof fetch = fetch) { this.arm = arm; this.transport = transport; }

  async prepare(input: PrepareAdapterInput): Promise<void> {
    if (this.input) throw new AdapterError('infrastructure', 'Adapter prepare is single-use; each run requires an independent fixture.');
    const runtime = input.fixture.runtime;
    if (!runtime || !runtime.isolationVerified || !input.fixture.isolation?.verified) throw new AdapterError('infrastructure', 'Verified OS-isolated Agent runtime is required.');
    const url = new URL(runtime.agentBaseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || ['3224', '4194', '4325', '55444'].includes(url.port) || url.username || url.password || url.search || url.hash) throw new AdapterError('infrastructure', 'Agent control URL must be an isolated non-production loopback endpoint.');
    if (input.provider !== 'codex') throw new AdapterError('provider', 'Lite v0.1 requires an explicitly configured native Codex provider.', 'unsupported_provider');
    if (!input.model.trim() || !runtime.agentAccessToken || !runtime.pmCookie) throw new AdapterError('infrastructure', 'Isolated Agent credentials and an explicit fixed model are required.', 'provider_prerequisite');
    this.input = input;
    this.baseUrl = url.origin;
    this.headers = new Headers({ 'content-type': 'application/json', authorization: `Bearer ${runtime.agentAccessToken}`, cookie: runtime.pmCookie });
    const provision = runtime.providerConfig;
    if (!provision || provision.driver !== 'codex' || provision.instanceId !== 'codex') throw new AdapterError('infrastructure', 'Missing isolated native Codex broker configuration.', 'provider_prerequisite');
    const catalog = await this.request('/api/providers');
    const providers = Array.isArray(catalog.providers) ? catalog.providers as Json[] : [];
    const current = providers.find(provider => provider.instanceId === provision.instanceId);
    if (!current || typeof current.revision !== 'number') throw new AdapterError('provider', 'Native Codex configuration was not initialized by the isolated service.', 'provider_unavailable');
    await this.request(`/api/providers/${encodeURIComponent(provision.instanceId)}`, { method: 'PUT', body: JSON.stringify({ revision: current.revision, enabled: true, config: provision.config, environment: provision.environment, customModels: [{ id: input.model, label: input.model }] }) }, 'provider');
    const health = await this.request(`/api/providers/${encodeURIComponent(provision.instanceId)}/test`, { method: 'POST', body: '{}' }, 'provider');
    if (health.ok !== true || health.nativeSessionReady !== true) throw new AdapterError('infrastructure', `Native Codex prerequisite is not ready; no inference was attempted. ${String(health.error ?? '')}`, 'provider_prerequisite');
    const opened = await this.request('/api/agent-workspaces/open', { method: 'POST', body: JSON.stringify({ path: runtime.workingDirectory, name: `Benchmark ${input.runId}` }) });
    const workspace = opened.workspace as Json | undefined;
    if (!workspace || typeof workspace.id !== 'string' || typeof workspace.revision !== 'number' || workspace.path !== runtime.workingDirectory || workspace.status !== 'available') throw new AdapterError('infrastructure', 'Agent did not attest the isolated workspace directory.');
    this.selection = { version: 2, agentWorkspaceId: workspace.id, agentWorkspaceRevision: workspace.revision };
    // Rights and source data are identical. Raw gets no generated index or workflow coaching.
    this.systemPrompt = [
      'Complete the user task using the available tools. The working directory contains the original fictional benchmark source documents, repository and output folder.',
      `Every PM tool requires an explicit target. Authorized targets: ${JSON.stringify(input.allowedTargets.map(target => ({ key: target.key, target: { workspaceId: target.workspaceId, projectId: target.projectId }, entityId: target.entityId })))}`,
      `Available benchmark tool policy: ${JSON.stringify(input.allowedTools)}. This policy is enforced by transport; it does not hide these tools in any arm.`,
      'Write deliverables under artifacts/ and change repository files only when requested. Never treat a successful model generation as PM task completion. Unknown write results must be reconciled using the original operation identity; do not recreate the write with a new identity.',
      ...(this.arm === 'raw' ? [] : ['Knowledge workflow: read original source documents, distinguish superseded history from the current decision, and cite exact source paths plus current revisions. Any index you create must derive only from these sources.']),
      ...(this.arm === 'dovspace' ? ['Dovspace workflow: verify explicit PM target, current revision and receipt before claiming a mutation. Save your own factual progress and unresolved original operation identities to artifacts/handoff.json before a requested checkpoint. On a new Session, re-read current authority and your saved deliverables; do not infer that interrupted work rolled back.'] : []),
    ].join('\n');
  }

  async start(input: { instruction: string; taskId: string }): Promise<{ sessionId: string }> {
    if (!this.input || !this.selection) throw new AdapterError('infrastructure', 'Prepare the isolated adapter before starting.');
    const id = `bench-${randomUUID()}`;
    const created = await this.request('/api/chat/threads', { method: 'POST', body: JSON.stringify({ id, executionSelection: this.selection }) });
    const thread = created.thread as Json | undefined;
    if (!thread || typeof thread.revision !== 'number') throw new AdapterError('infrastructure', 'Agent did not return a persisted new Session.');
    const modelOptions = Object.entries(this.input.modelOptions ?? {}).map(([key, value]) => {
      if (typeof value !== 'string' && typeof value !== 'boolean') throw new AdapterError('provider', `Invalid native model option ${key}.`);
      return { id: key, value };
    });
    const configured = await this.request(`/api/chat/threads/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ revision: thread.revision, settings: { providerInstanceId: 'codex', model: this.input.model, systemPrompt: this.systemPrompt, temperature: 1, modelOptions, interactionMode: 'default' } }) }, 'provider');
    const settingsRevision = (configured.thread as Json | undefined)?.revision;
    const controller = new AbortController();
    const acceptanceTimer = setTimeout(() => controller.abort(new Error('Agent acceptance timed out.')), 45_000);
    let response: Response;
    try {
      response = await this.transport(new URL('/api/chat', this.baseUrl), { method: 'POST', headers: this.headers, redirect: 'error', signal: controller.signal, body: JSON.stringify({ id, messages: [{ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: input.instruction }] }], idempotencyKey: randomUUID(), config: { providerInstanceId: 'codex', modelName: this.input.model, modelOptions, threadSettingsRevision: settingsRevision, responseStreamingMode: 'paragraph' } }) });
    } catch (error) {
      // A lost POST response is unknown acceptance, never retried or recreated.
      throw new AdapterError('infrastructure', `Agent submit outcome unknown; Session ${id} must be inspected, not resubmitted. ${error instanceof Error ? error.message : String(error)}`, 'unknown_acceptance');
    } finally { clearTimeout(acceptanceTimer); }
    if (!response.ok) await this.failResponse(response, 'provider');
    const generationId = response.headers.get('x-resumable-stream-id');
    if (!generationId || !response.body) throw new AdapterError('infrastructure', 'Accepted Agent response lacks persisted generation identity or SSE body.', 'unknown_acceptance');
    const session: Session = { id, taskId: input.taskId, generationId, events: [], ended: false, controller, work: Promise.resolve(), observed: false, interrupted: false, interrupting: false };
    this.sessions.set(id, session);
    this.push(session, makeEvent(this.input.runId, 'transport', 'session_started', { generationId, taskId: input.taskId, model: this.input.model, arm: this.arm, fresh: true }, { sessionId: id }));
    session.work = this.consume(session, response.body);
    return { sessionId: id };
  }

  sessionIdentity(sessionId: string): { sessionId: string; generationId: string } {
    const session = this.session(sessionId);
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
      if (session.ended && !session.interrupting) break;
      const { promise, resolve } = Promise.withResolvers<void>();
      session.waiter = resolve;
      await promise;
    }
  }

  async interrupt(sessionId: string, reason: string): Promise<void> {
    const session = this.session(sessionId);
    session.interrupting = true;
    try {
      await this.request(`/api/chat/threads/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST', body: JSON.stringify({ generationId: session.generationId }) });
      const deadline = Date.now() + 20_000;
      while (true) {
        const view = await this.generation(session);
        if (['cancelled', 'interrupted', 'failed', 'completed'].includes(String(view.status))) {
          session.interrupted = true;
          this.push(session, makeEvent(this.input!.runId, 'transport', 'interrupt_acknowledged', { generationId: session.generationId, reason, status: view.status, wasActive: view.status === 'cancelled' || view.status === 'interrupted' }, { sessionId }));
          break;
        }
        if (Date.now() >= deadline) throw new AdapterError('interrupted', 'Agent did not acknowledge interruption; new Session resume is forbidden.');
        await delay(100);
      }
    } finally {
      session.controller.abort(new Error('Runner interruption ended.'));
      await session.work;
      session.interrupting = false;
      session.waiter?.(); delete session.waiter;
    }
  }

  async resume(input: { priorSessionId: string; instruction: string }): Promise<{ sessionId: string }> {
    const previous = this.session(input.priorSessionId);
    if (!previous.interrupted) throw new AdapterError('interrupted', 'Resume requires trusted acknowledgement of the previous Session interruption.');
    // Intentionally no /continue, fork, copied messages or provider native cursor.
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

  private session(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new AdapterError('infrastructure', 'Unknown Session identity.');
    return session;
  }
  private push(session: Session, event: BenchEvent): void { session.events.push(event); session.waiter?.(); delete session.waiter; }
  private async request(route: string, init: RequestInit = {}, category: 'infrastructure' | 'provider' = 'infrastructure'): Promise<Json> {
    const response = await this.transport(new URL(route, this.baseUrl), { ...init, headers: this.headers, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(30_000) });
    if (!response.ok) await this.failResponse(response, category);
    return await response.json() as Json;
  }
  private async failResponse(response: Response, category: 'infrastructure' | 'provider'): Promise<never> {
    const message = (await response.text()).slice(0, 16_384);
    throw new AdapterError(category, `Agent HTTP ${response.status}: ${message}`, `http_${response.status}`);
  }
  private async generation(session: Session): Promise<Json> {
    const result = await this.request(`/api/chat/threads/${encodeURIComponent(session.id)}/generations`);
    const generations = Array.isArray(result.generations) ? result.generations as Json[] : [];
    const generation = generations.find(candidate => candidate.id === session.generationId);
    if (!generation) throw new AdapterError('infrastructure', 'Persisted generation disappeared; never recreating it.');
    return generation;
  }
  private async consume(session: Session, body: ReadableStream<Uint8Array>): Promise<void> {
    const native = this.consumeNative(session);
    try {
      for await (const frame of parseSse(body, session.controller.signal)) {
        if (frame.data === '[DONE]') continue;
        let payload: unknown;
        try { payload = JSON.parse(frame.data); } catch { throw new AdapterError('infrastructure', 'Agent UI stream contained malformed JSON.'); }
        this.push(session, makeEvent(this.input!.runId, 'agent', 'agent_stream', { generationId: session.generationId, frame: payload }, { sessionId: session.id }));
      }
      const generation = await this.generation(session);
      this.push(session, makeEvent(this.input!.runId, 'transport', 'generation_status', { ...generation }, { sessionId: session.id }));
      const history = await this.request(`/api/chat/threads/${encodeURIComponent(session.id)}/history`);
      const messages = Array.isArray(history.messages) ? history.messages as Json[] : [];
      for (const message of messages) {
        const content = message.content as Json | undefined;
        const durable = (content?.metadata as Json | undefined)?.durable as Json | undefined;
        if (durable?.generationId !== session.generationId || !durable.usage) continue;
        const usage = durable.usage as Json;
        const totals = usage.totals as Json | undefined;
        const reported = usage.reportedTurn as Json | undefined;
        this.push(session, makeEvent(this.input!.runId, 'provider', 'usage', { generationId: session.generationId, inputTokens: totals ? Number(totals.uncachedInputTokens) + Number(totals.cachedInputTokens) + Number(totals.cacheCreationTokens) : reported?.inputTokens ?? null, outputTokens: totals?.outputTokens ?? reported?.outputTokens ?? null, cacheReadTokens: totals?.cachedInputTokens ?? reported?.cachedInputTokens ?? null, cacheWriteTokens: totals?.cacheCreationTokens ?? reported?.cacheCreationTokens ?? null, costUsd: usage.costUsd ?? null }, { sessionId: session.id }));
      }
    } catch (error) {
      if (!session.controller.signal.aborted) this.push(session, makeEvent(this.input!.runId, 'transport', 'adapter_error', { message: error instanceof Error ? error.message : String(error), category: error instanceof AdapterError ? error.category : 'infrastructure' }, { sessionId: session.id }));
    } finally {
      session.controller.abort();
      await native;
      session.ended = true;
      session.waiter?.(); delete session.waiter;
    }
  }
  private async consumeNative(session: Session): Promise<void> {
    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt < 50 && !session.controller.signal.aborted; attempt++) {
        response = await this.transport(new URL(`/api/chat/generations/${encodeURIComponent(session.generationId)}/output`, this.baseUrl), { headers: this.headers, redirect: 'error', signal: session.controller.signal });
        if (response.status !== 404) break;
        await response.body?.cancel();
        await delay(100, undefined, { signal: session.controller.signal });
      }
      if (!response?.ok || !response.body) return;
      for await (const frame of parseSse(response.body, session.controller.signal)) {
        const payload = JSON.parse(frame.data) as Json;
        this.push(session, makeEvent(this.input!.runId, 'provider', 'native_output', { generationId: session.generationId, frame: payload }, { sessionId: session.id }));
      }
    } catch (error) {
      if (!session.controller.signal.aborted) this.push(session, makeEvent(this.input!.runId, 'transport', 'native_observation_error', { message: error instanceof Error ? error.message : String(error) }, { sessionId: session.id }));
    }
  }
}
