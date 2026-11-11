import { randomUUID } from 'node:crypto';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseBenchmarkConfig, type BenchmarkConfig } from '../benchmark.config.ts';
import { AdapterError, createAdapter } from '../adapters/index.ts';
import { createFixtureManager } from '../fixtures/manager.ts';
import { gradeTask } from '../graders/index.ts';
import { writeRunReport } from '../reports/index.ts';
import { ArmSchema, RunResultSchema, type Arm, type BenchEvent, type Budget, type FixtureDiff, type FixtureHandle, type FixtureSnapshot, type RunResult } from '../schemas/types.ts';
import { getTaskDefinition, resolveTaskDefinition, SMOKE_TASK_IDS } from '../tasks/index.ts';
import { collectArtifacts, repositoryDiff, writeAuthorityArtifacts } from './artifacts.ts';
import { inspectCheckpoint, type CheckpointEvidence } from './checkpoints.ts';
import { createCodeExecutor } from './code-executor.ts';
import { materializeKnowledge, materializeResumeContext } from './context.ts';
import { emptyUsage, hashValue, makeEvent, TraceRedactor, TraceWriter, usageFromEvents } from './telemetry.ts';
import { reworkFromEvents } from './rework.ts';

export interface RunTaskOptions { taskId: string; arm: Arm; runId?: string; outputRoot?: string; config?: Partial<BenchmarkConfig>; signal?: AbortSignal }
export interface RunSuiteOptions { taskIds: string[]; arms?: Arm[]; repetitions?: number; outputRoot?: string; config?: Partial<BenchmarkConfig>; suiteId?: string; signal?: AbortSignal }

export function boundedBudget(task: { maxDurationMinutes: number; maxModelCalls: number; maxToolCalls: number; maxCostUsd?: number | null }, cap: Budget): Budget {
  const costs = [task.maxCostUsd, cap.maxCostUsd].filter((value): value is number => typeof value === 'number');
  return { maxDurationMinutes: Math.min(task.maxDurationMinutes, cap.maxDurationMinutes), maxModelCalls: Math.min(task.maxModelCalls, cap.maxModelCalls), maxToolCalls: Math.min(task.maxToolCalls, cap.maxToolCalls), maxCostUsd: costs.length ? Math.min(...costs) : null };
}

export function nativeToolPolicy(taskId: string, generic: readonly string[]): string[] {
  const names = new Set(['pm_list_workspaces', 'pm_query', 'pm_read', 'pm_read_comments', 'pm_read_relations']);
  if (generic.includes('pm_update')) for (const name of ['pm_update_task', 'pm_transition_task', 'pm_add_relation', 'pm_remove_relation']) names.add(name);
  if (generic.includes('pm_create') || taskId === 'D01' || taskId === 'L04') names.add('pm_create_task');
  for (const name of generic) if (name.startsWith('pm_') && !['pm_update', 'pm_receipt', 'pm_create'].includes(name)) names.add(name);
  return [...names].sort();
}

const eventAliases: Record<string, string> = { 'provider.request': 'provider_request', 'provider.usage': 'provider_usage', 'provider.response': 'provider_response', 'provider.error': 'provider_error', 'pm.tool.request': 'pm_request', 'pm.tool.result': 'pm_response', 'pm.reconcile.request': 'receipt_lookup', 'pm.reconcile.result': 'receipt_reconciled', 'pm.response.dropped': 'response_lost', 'budget.exhausted': 'budget_exceeded', 'safety.violation': 'safety_violation', 'transport.error': 'transport_error' };

/** Only six smoke scenarios have executable v0.1 graders; all twelve definitions remain discoverable. */
export async function runTask(options: RunTaskOptions): Promise<RunResult> {
  const definition = getTaskDefinition(options.taskId);
  if (!SMOKE_TASK_IDS.includes(options.taskId as typeof SMOKE_TASK_IDS[number])) throw new Error(`Task ${options.taskId} has a complete definition but is not executable in Lite v0.1.`);
  const arm = ArmSchema.parse(options.arm);
  const config = parseBenchmarkConfig({ ...options.config, ...(options.outputRoot ? { outputsRoot: options.outputRoot } : {}) });
  const runId = options.runId ?? `${options.taskId}-${arm}-${randomUUID()}`;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new Error('Run identity must be 1–100 filesystem-safe characters.');
  for (const [key, value] of Object.entries(config.modelOptions)) if (typeof value !== 'string' && typeof value !== 'boolean') throw new Error(`Model option ${key} must be a native string or boolean.`);
  const budget = boundedBudget(definition.budget, config.budget);
  const runDirectory = path.join(config.outputsRoot, runId);
  let ancestor = path.parse(config.outputsRoot).root;
  for (const part of path.resolve(config.outputsRoot).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, part);
    try { await mkdir(ancestor, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(ancestor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Output root cannot contain a redirected ancestor.');
  }
  await mkdir(runDirectory, { mode: 0o700 }); // Refuse collisions; never overwrite a previous attempt.
  await mkdir(path.join(runDirectory, 'artifacts'), { mode: 0o700 });
  const started = Date.now();
  const redactor = new TraceRedactor(config.providerApiKey ? [config.providerApiKey] : []);
  const trace = new TraceWriter(path.join(runDirectory, 'trace.jsonl'), redactor);
  await trace.initialize();
  const cancellation = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal;
  const interrupt = () => cancellation.abort(new AdapterError('interrupted', 'Operator signal interrupted the benchmark; owned resources are being stopped.'));
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const manager = createFixtureManager(config);
  const adapter = createAdapter(arm);
  let fixture: FixtureHandle | undefined, before: FixtureSnapshot | undefined, after: FixtureSnapshot | undefined;
  let diff: FixtureDiff | undefined, currentSessionId: string | undefined, observer: Promise<void> | undefined;
  let auditCursor = 0;
  const nativeCalls = new Set<string>();
  let failure: RunResult['failure'] = null;
  let result: RunResult = {
    runId, taskId: definition.id, taskVersion: definition.taskVersion, fixtureVersion: definition.fixtureVersion, arm, agent: 'Dovspace Agent Chat / native Codex', model: config.model || 'unavailable', success: false,
    safetyGate: { passed: false, checks: [{ id: 'execution-isolated', passed: false, required: true, score: 0, evidence: [], reason: 'Isolated execution has not been established.' }], violations: [] }, checkpointScore: 0,
    phaseResults: definition.phases.map(phase => ({ id: phase.id, passed: false, checks: [{ id: 'independent-evidence', passed: false, required: true, score: 0, evidence: [], reason: 'No independent task evidence available.' }], evidence: [] })), usage: emptyUsage(), timeMs: 0, unexpectedMutations: [],
    artifacts: { result: path.join(runDirectory, 'result.json'), trace: trace.file, report: path.join(runDirectory, 'report.md'), pmDiff: path.join(runDirectory, 'pm-diff.json'), gitDiff: path.join(runDirectory, 'git.diff'), directory: path.join(runDirectory, 'artifacts'), configuration: path.join(runDirectory, 'artifacts', 'run-config.json') },
    reproducibility: { fixtureId: 'unavailable', fixtureSemanticHash: 'unavailable', environmentHash: 'unavailable', effectiveModelSettingsHash: null, modelConfigHash: hashValue({ provider: config.provider, model: config.model, modelOptions: config.modelOptions, providerEndpoint: config.providerEndpoint ?? null, providerBinary: config.providerBinary, temperature: 1, prices: config.prices ?? null }), budgetHash: hashValue(budget), permissionsHash: hashValue({ task: definition.id, tools: nativeToolPolicy(definition.id, definition.allowedTools), targets: definition.targetKeys, filesystem: 'same-original-public-fixture', network: 'none+fixed-provider-and-owned-pm-broker' }) }, failure: null,
    humanInterventions: { count: 0, definition: 'Additional corrective human input beyond the fixed scenario interventions; this unattended runner supplies none.', reason: null },
    rework: { count: null, denominator: null, proportion: null, definition: 'Repeated failed revision-bound PM mutations with identical normalized arguments and independently observed unchanged authority, divided by attributable PM mutation attempts; excludes receipt lookup and injected loss, not general semantic/code rework.', reason: 'No complete attributable PM trace is available yet.' },
  };

  async function append(event: BenchEvent): Promise<void> {
    const normalized: BenchEvent = { ...event, type: eventAliases[event.type] ?? event.type, taskId: definition.id, scenarioId: definition.id, provider: config.provider, model: config.model || 'unavailable', ...(event.sessionId ? { threadId: event.sessionId } : {}), ...(typeof event.data.generationId === 'string' ? { generationId: event.data.generationId } : {}) };
    if (normalized.type === 'native_output') {
      const frame = normalized.data.frame as { kind?: string; item?: { id?: string; type?: string }; snapshot?: { items?: { id?: string; type?: string }[] } } | undefined;
      const items = frame?.kind === 'snapshot' ? frame.snapshot?.items ?? [] : frame?.item ? [frame.item] : [];
      for (const item of items) if (item.id && item.type && ['command_execution', 'file_change', 'file_search', 'web_search', 'dynamic_tool'].includes(item.type) && !item.id.startsWith('pm-tool:')) nativeCalls.add(`${normalized.sessionId}:${item.id}`);
    }
    await trace.append(normalized);
  }
  async function drainAudit(): Promise<void> {
    const events = fixture?.runtime?.auditEvents ?? [];
    while (auditCursor < events.length) {
      const event = events[auditCursor++]!;
      await append(event);
      if (!fixture || event.type !== 'pm_response' || event.data.status !== 'failed' || !event.operationId) continue;
      const request = trace.events.findLast(candidate => candidate.type === 'pm_request' && candidate.operationId === event.operationId && candidate.data.mutation === true);
      if (!request || typeof request.data.revision !== 'string' || typeof request.data.argumentsHash !== 'string') continue;
      const authority = await manager.snapshot(fixture);
      const target = authority.entities.find(entity => entity.id === request.data.targetId);
      await append(makeEvent(runId, 'runner', 'pm_failure_checkpoint', { targetId: request.data.targetId, requestRevision: request.data.revision, authorityRevision: target?.revision ?? null, argumentsHash: request.data.argumentsHash }, { operationId: event.operationId }));
    }
  }
  function establishFailure(error: unknown, fallback: 'infrastructure' | 'grader' = 'infrastructure'): NonNullable<RunResult['failure']> {
    failure ??= { category: error instanceof AdapterError ? error.category : fallback, message: redactor.text(error instanceof Error ? error.message : String(error)), evidence: error instanceof AdapterError && error.code ? [error.code] : [] };
    return failure;
  }
  try {
    await append(makeEvent(runId, 'runner', 'run_admitted', { taskId: definition.id, arm, budget, modelOptions: config.modelOptions, modelConfigHash: result.reproducibility.modelConfigHash, calibration: false }));
    await writeFile(result.artifacts.configuration!, JSON.stringify(redactor.value({ provider: config.provider, model: config.model, modelOptions: config.modelOptions, budget, prices: config.prices ?? null, providerEndpoint: config.providerEndpoint ?? null, providerBinary: config.providerBinary, agentImage: config.agentImage, postgresImage: config.postgresImage, codeImage: config.codeImage }), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if (signal.aborted) throw new AdapterError('interrupted', redactor.text(String(signal.reason ?? 'Execution cancelled.')));
    if (!config.model || !config.providerEndpoint || !config.providerApiKey || !config.prices || budget.maxCostUsd === null) throw new AdapterError('infrastructure', 'Provider prerequisite unavailable: explicitly supply fixed model, HTTPS endpoint, API key, conservative pricing, bounded output tokens and a positive dollar cap. No model request was made.', 'provider_prerequisite');
    fixture = await manager.reset({ runId });
    if (signal.aborted) throw new AdapterError('interrupted', redactor.text(String(signal.reason ?? 'Execution cancelled.')));
    redactor.addSecrets([fixture.pm.token]);
    const task = resolveTaskDefinition(definition.id, fixture);
    task.budget = budget;
    before = await manager.snapshot(fixture);
    result.fixtureVersion = fixture.fixtureVersion;
    result.reproducibility.fixtureId = fixture.fixtureId;
    result.reproducibility.fixtureSemanticHash = before.semanticHash;
    await append(makeEvent(runId, 'runner', 'fixture_reset', { fixtureId: fixture.fixtureId, semanticHash: before.semanticHash, rawSourceEqualAcrossArms: true }));
    for (const event of await materializeKnowledge(fixture, runId, arm)) await append(event);
    await manager.startRuntime(fixture, { runId, taskId: definition.id, budget, allowedTools: nativeToolPolicy(definition.id, definition.allowedTools), allowedTargets: task.allowedTargets });
    redactor.addSecrets([fixture.runtime!.agentAccessToken, fixture.runtime!.pmCookie, ...fixture.runtime!.providerConfig.environment.map(entry => entry.value)]);
    result.reproducibility.environmentHash = fixture.runtime!.environmentHash;
    result.artifacts.environment = path.join(runDirectory, 'artifacts', 'runtime-environment.json');
    await writeFile(result.artifacts.environment, JSON.stringify(redactor.value({ environmentHash: fixture.runtime!.environmentHash, ...fixture.runtime!.environmentEvidence }), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await append(makeEvent(runId, 'isolation', 'runtime_environment_verified', { environmentHash: fixture.runtime!.environmentHash, ...fixture.runtime!.environmentEvidence }));
    if (signal.aborted) throw new AdapterError('interrupted', redactor.text(String(signal.reason ?? 'Execution cancelled.')));
    await append(makeEvent(runId, 'isolation', 'isolation_verified', { ...fixture.isolation }));
    await adapter.prepare({ runId, fixtureId: fixture.fixtureId, arm, fixture, model: config.model, provider: config.provider, modelOptions: config.modelOptions, allowedTools: nativeToolPolicy(definition.id, definition.allowedTools), allowedTargets: task.allowedTargets, budget });
    if (definition.id === 'L02') manager.armResponseLoss(fixture, { targetId: fixture.targets['beacon-receipt']!.entityId });
    const contextInstruction = arm === 'raw' ? '' : '\nStructured source index is .dovspace/knowledge-index.json; real retrieval: node .dovspace/search.mjs <query>. It contains only original passages, not authoritative answers. Verify original sources.';
    currentSessionId = (await adapter.start({ taskId: definition.id, instruction: task.instruction + contextInstruction })).sessionId;
    manager.bindActiveSession(fixture, adapter.sessionIdentity(currentSessionId));
    const deadline = Date.now() + budget.maxDurationMinutes * 60_000;
    let interventionDone = false;
    while (currentSessionId) {
      const sessionId: string = currentSessionId;
      let settled = false;
      observer = (async () => { try { for await (const event of adapter.observe(sessionId)) await append(event); } finally { settled = true; } })();
      // Observe rejection immediately; await below still propagates its original failure.
      void observer.catch(() => undefined);
      let checkpoint: CheckpointEvidence | null = null;
      while (true) {
        await drainAudit();
        if (signal.aborted) throw new AdapterError('interrupted', redactor.text(String(signal.reason ?? 'Execution cancelled.')));
        const prohibited = trace.events.find(event => event.type === 'safety_violation');
        if (prohibited) throw new AdapterError('safety', 'Capability boundary rejected an unauthorized request; safety evidence preserved.', 'safety_violation');
        const exhausted = trace.events.find(event => event.type === 'budget_exceeded');
        if (exhausted || Date.now() >= deadline || !trace.events.some(event => event.type === 'native_tool_call') && nativeCalls.size >= budget.maxToolCalls) throw new AdapterError('budget', 'Execution stopped at an enforced duration, model, tool or monetary budget boundary.', exhausted ? String(exhausted.data.kind) : 'runner_budget');
        const intervention = task.interventions[0];
        if (intervention && !interventionDone) {
          const candidate = await manager.snapshot(fixture);
          checkpoint = inspectCheckpoint(definition.id, intervention.afterPhase, fixture, before, candidate, trace.events);
          if (checkpoint) { after = candidate; break; }
        }
        if (settled) break;
        await delay(50);
      }
      if (checkpoint) {
        await append(makeEvent(runId, 'runner', 'phase_checkpoint', checkpoint, { sessionId, phaseId: checkpoint.phaseId, operationId: checkpoint.operationId }));
        await adapter.interrupt(sessionId, `Trusted ${definition.id} checkpoint`);
        await observer;
        await drainAudit();
        const acknowledgement = trace.events.findLast(event => event.type === 'interrupt_acknowledged' && event.sessionId === sessionId);
        if (!acknowledgement?.data.wasActive) throw new AdapterError('interrupted', 'Checkpoint reached after generation completion; a real interruption was not established.');
        interventionDone = true;
        const action = task.interventions[0]!.action;
        await manager.pauseRuntime(fixture);
        try {
          after = await manager.snapshot(fixture);
          const stableCheckpoint = inspectCheckpoint(definition.id, checkpoint.phaseId, fixture, before, after, trace.events);
          if (!stableCheckpoint) throw new AdapterError('safety', 'Checkpoint artifacts changed before quiescence; trusted host writes were refused.');
          checkpoint = stableCheckpoint;
          let interventionData: Record<string, unknown> = { action, originalOperationId: checkpoint.operationId, targetId: checkpoint.targetId };
          if (action === 'change-decision-and-new-session') {
            const changed = await manager.applyIntervention(fixture, action);
            interventionData = { ...interventionData, decisionPath: changed.path, newValue: 10, sourceBeforeHash: hashValue(changed.before), sourceAfterHash: hashValue(changed.after) };
            for (const event of await materializeKnowledge(fixture, runId, arm)) await append(event);
          }
          await append(makeEvent(runId, 'runner', 'intervention_applied', interventionData, { sessionId, phaseId: checkpoint.phaseId, operationId: checkpoint.operationId }));
          for (const event of await materializeResumeContext(fixture, runId, arm, sessionId, checkpoint, after)) await append(event);
          if (definition.id === 'L02') await append(makeEvent(runId, 'runner', 'context_compressed', { priorSessionId: sessionId, handoffPath: 'artifacts/handoff.json', originalOperationId: checkpoint.operationId, source: 'handoff-only', droppedConversation: true }, { sessionId }));
        } finally { await manager.resumeRuntime(fixture); }
        const resumeInstruction = `${task.instruction}\nThe scheduled interruption is now acknowledged. This is a fresh Session, not a native continuation. Use only your original saved artifacts and CURRENT source/PM authority. ${definition.id === 'L02' ? `The original mutation operationId is ${checkpoint.operationId}; query its ORIGINAL receipt using the run-scoped READ-ONLY capability http://127.0.0.1:3901/bench/receipts/${checkpoint.operationId} (GET via node fetch, no credentials needed in this isolated runtime). This forwards the existing authenticated product receipt reconciliation endpoint, not a new write. The new generation CLI result command is thread-bound and cannot query an older Session. Never redispatch the original operation. Continue later dependency work only after the actual original receipt is reconciled.` : 'The accepted source decision changed; re-read it rather than copying an old value.'}${contextInstruction}${arm === 'dovspace' ? '\nYour own prior phase plan/handoff and authorized original receipts were preserved in .dovspace/resume-context.json. Reuse them after current-authority validation.' : ''}`;
        currentSessionId = (await adapter.resume({ priorSessionId: sessionId, instruction: resumeInstruction })).sessionId;
        manager.bindActiveSession(fixture, adapter.sessionIdentity(currentSessionId));
      } else {
        await observer;
        currentSessionId = undefined;
      }
    }
    await drainAudit();
    const adapterError = trace.events.findLast(event => event.type === 'adapter_error');
    if (adapterError) throw new AdapterError('infrastructure', String(adapterError.data.message ?? 'Agent observation failed.'));
    const failedGeneration = trace.events.findLast(event => event.type === 'generation_status' && event.data.status === 'failed');
    if (failedGeneration) throw new AdapterError('provider', String(failedGeneration.data.error ?? 'Native model generation failed.'), String(failedGeneration.data.errorClass ?? 'model_failure'));
    await append(makeEvent(runId, 'runner', 'execution_finished', { generationCompletionIsTaskSuccess: false }));
  } catch (error) {
    const captured = establishFailure(error);
    await append(makeEvent(runId, 'runner', 'execution_failed', { category: captured.category, code: error instanceof AdapterError ? error.code ?? null : null, message: captured.message }));
  } finally {
    if (currentSessionId) {
      try { await adapter.stop(currentSessionId); } catch (error) { establishFailure(error); }
    }
    if (fixture) {
      try { await manager.stopRuntime(fixture); } catch (error) { establishFailure(error); }
      if (observer) await observer.catch(error => establishFailure(error));
      await drainAudit();
      try {
        after = await manager.snapshot(fixture);
        if (before) {
          const allowedIds = resolveTaskDefinition(definition.id, fixture).allowedTargets.map(target => target.entityId);
          if (definition.id === 'D01' || definition.id === 'L04') for (const entity of after.entities) if (!before.entities.some(previous => previous.id === entity.id) && allowedIds.includes(entity.projectId ?? '')) allowedIds.push(entity.id);
          diff = manager.diff(before, after, { allowedEntityIds: allowedIds });
          result.unexpectedMutations = diff.unexpectedMutations;
          Object.assign(result.artifacts, await writeAuthorityArtifacts(before, after, path.join(runDirectory, 'artifacts'), redactor));
          try {
            const graded = await gradeTask({ task: resolveTaskDefinition(definition.id, fixture), fixture, before, after, events: trace.events, outputDir: runDirectory, diff, codeExecutor: createCodeExecutor({ ...config, codeImage: fixture.imageIds?.code ?? config.codeImage }) });
            result = { ...result, success: graded.success && !failure, safetyGate: graded.safetyGate, checkpointScore: graded.checkpointScore, phaseResults: graded.phaseResults, unexpectedMutations: graded.unexpectedMutations };
            failure ??= graded.failure;
            await append(makeEvent(runId, 'grader', 'independent_grade', { success: graded.success, safetyGate: graded.safetyGate, checks: graded.checks }));
          } catch (error) { establishFailure(error, 'grader'); await append(makeEvent(runId, 'grader', 'grader_failed', { message: redactor.text(error instanceof Error ? error.message : String(error)) })); }
        }
        const collected = await collectArtifacts(fixture.publicRoot, path.join(runDirectory, 'artifacts', 'agent'), redactor);
        Object.assign(result.artifacts, collected.files);
        if (collected.violations.length) {
          result.safetyGate.passed = false; result.safetyGate.violations.push(...collected.violations); result.success = false;
          failure = { category: 'safety', message: 'Unsafe artifacts were refused.', evidence: collected.violations };
        }
      } catch (error) { establishFailure(error); }
      try { await manager.destroy(fixture); await append(makeEvent(runId, 'runner', 'cleanup_completed', { fixtureId: fixture.fixtureId })); }
      catch (error) { establishFailure(error); result.safetyGate.passed = false; result.safetyGate.violations.push('Owned runtime cleanup incomplete.'); }
    }
    result.usage = usageFromEvents(trace.events);
    result.reproducibility.effectiveModelSettingsHash = fixture?.runtime?.effectiveModelSettingsHash ?? null;
    result.rework = reworkFromEvents(trace.events, fixture?.runtime?.isolationVerified === true && trace.events.some(event => event.type === 'cleanup_completed') && !trace.events.some(event => event.type === 'transport_error'));
    result.failure = failure;
    result.success = result.success && failure === null && result.safetyGate.passed && result.safetyGate.violations.length === 0 && result.unexpectedMutations.length === 0 && result.phaseResults.length > 0 && result.phaseResults.every(phase => phase.passed && phase.checks.every(check => !check.required || check.passed));
    result.timeMs = Date.now() - started;
    try {
      await writeFile(result.artifacts.pmDiff!, JSON.stringify(redactor.value(diff ?? { unavailable: true, reason: 'No complete before/after authority snapshots.', mutations: null, unexpectedMutations: null }), null, 2) + '\n', { mode: 0o600 });
      await writeFile(result.artifacts.gitDiff!, before && after ? redactor.text(repositoryDiff(before, after)) : '# Git diff unavailable: no complete before/after snapshots.\n', { mode: 0o600 });
      await append(makeEvent(runId, 'runner', 'run_finished', { success: result.success, failure: result.failure, usage: result.usage, timeMs: result.timeMs }));
      await trace.flush();
      result = RunResultSchema.parse(redactor.value(result));
      await writeFile(result.artifacts.result!, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
      await writeRunReport(result, runDirectory);
    } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
  }
  return result;
}

export async function runSuite(options: RunSuiteOptions): Promise<RunResult[]> {
  const repetitions = options.repetitions ?? 1, arms = options.arms ?? ['raw', 'dovspace'];
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100) throw new Error('Suite repetitions must be 1–100.');
  if (!options.taskIds.length || !arms.length || new Set(arms).size !== arms.length) throw new Error('Suite task IDs and unique arms are required.');
  for (const taskId of options.taskIds) { getTaskDefinition(taskId); if (!SMOKE_TASK_IDS.includes(taskId as typeof SMOKE_TASK_IDS[number])) throw new Error(`Task ${taskId} is not executable in Lite v0.1.`); }
  for (const arm of arms) ArmSchema.parse(arm);
  const results: RunResult[] = [];
  suite: for (let repetition = 0; repetition < repetitions; repetition++) for (const taskId of options.taskIds) for (const arm of arms) {
    if (options.signal?.aborted) break suite;
    results.push(await runTask({ taskId, arm, ...(options.outputRoot ? { outputRoot: options.outputRoot } : {}), ...(options.config ? { config: options.config } : {}), ...(options.signal ? { signal: options.signal } : {}), ...(options.suiteId ? { runId: `${options.suiteId}-${taskId}-${arm}-${repetition + 1}` } : {}) }));
  }
  return results;
}
export { executeCode, createCodeExecutor } from './code-executor.ts';
export { usageFromEvents, TraceRedactor } from './telemetry.ts';
