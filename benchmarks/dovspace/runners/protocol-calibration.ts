import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseBenchmarkConfig, type BenchmarkConfig } from '../benchmark.config.ts';
import { AgentChatAdapter } from '../adapters/agent-chat.ts';
import { createFixtureManager } from '../fixtures/manager.ts';
import type { BenchEvent, CheckResult, FixtureDiff, FixtureHandle, FixtureSnapshot } from '../schemas/types.ts';
import { collectArtifacts, repositoryDiff, writeAuthorityArtifacts } from './artifacts.ts';
import { inspectCheckpoint, type CheckpointEvidence } from './checkpoints.ts';
import { makeEvent, TraceRedactor, TraceWriter } from './telemetry.ts';

export interface ProtocolCalibrationOptions { runId?: string; outputRoot?: string; config?: Partial<BenchmarkConfig>; signal?: AbortSignal }
export interface ProtocolCalibrationResult {
  kind: 'protocol-calibration'; schemaVersion: '0.1'; runId: string; passed: boolean; modelEfficacy: null; inferencePerformed: false;
  checks: CheckResult[]; sessions: string[]; fixtureId: string | null; timeMs: number; artifacts: Record<string, string>;
  failure: { category: 'infrastructure' | 'protocol' | 'cleanup'; message: string } | null;
  limitations: string[];
}

/** Explicit controlled-peer integration proof. It is never selected by runTask or a missing-provider fallback. */
export async function runProtocolCalibration(options: ProtocolCalibrationOptions = {}): Promise<ProtocolCalibrationResult> {
  if (options.config?.providerApiKey || options.config?.providerEndpoint) throw new Error('Protocol calibration does not accept paid-provider credentials or endpoints.');
  const config = parseBenchmarkConfig({ ...options.config, model: 'protocol-calibration', modelOptions: {}, ...(options.outputRoot ? { outputsRoot: options.outputRoot } : {}) });
  const runId = options.runId ?? `protocol-${randomUUID()}`;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new Error('Invalid protocol calibration identity.');
  let current = path.parse(config.outputsRoot).root;
  for (const part of path.resolve(config.outputsRoot).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Protocol output root cannot contain links.');
  }
  const directory = path.join(config.outputsRoot, runId);
  await mkdir(directory, { mode: 0o700 });
  await mkdir(path.join(directory, 'artifacts'), { mode: 0o700 });
  const started = Date.now(), redactor = new TraceRedactor();
  const trace = new TraceWriter(path.join(directory, 'trace.jsonl'), redactor);
  await trace.initialize();
  const manager = createFixtureManager(config), adapter = new AgentChatAdapter('raw');
  const control = new AbortController(), signal = options.signal ? AbortSignal.any([options.signal, control.signal]) : control.signal;
  const interrupt = () => control.abort(new Error('Protocol calibration interrupted by operator.'));
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  let fixture: FixtureHandle | undefined, before: FixtureSnapshot | undefined, after: FixtureSnapshot | undefined, diff: FixtureDiff | undefined, activeSession: string | undefined;
  let observing: Promise<void> | undefined, cursor = 0;
  const result: ProtocolCalibrationResult = { kind: 'protocol-calibration', schemaVersion: '0.1', runId, passed: false, modelEfficacy: null, inferencePerformed: false, checks: [], sessions: [], fixtureId: null, timeMs: 0,
    artifacts: { result: path.join(directory, 'result.json'), trace: trace.file, report: path.join(directory, 'report.md'), pmDiff: path.join(directory, 'pm-diff.json'), gitDiff: path.join(directory, 'git.diff') }, failure: null,
    limitations: ['This controlled native JSON-RPC peer performs no model inference, reasoning, provider authentication or paid transport request.', 'Passing proves only the exercised real Agent Chat, isolated fixture, committed-response-loss and original-receipt recovery protocol; it is not task/model efficacy or an A/B experiment.'] };
  async function append(event: BenchEvent): Promise<void> { await trace.append({ ...event, taskId: 'L02', scenarioId: 'protocol-L02', provider: 'controlled-codex-protocol-peer', model: 'NO-INFERENCE' }); }
  async function audit(): Promise<void> { const events = fixture?.runtime?.auditEvents ?? []; while (cursor < events.length) await append(events[cursor++]!); }
  function check(id: string, passed: boolean, evidence: string[]): void { result.checks.push({ id, passed, required: true, score: passed ? 1 : 0, evidence }); }
  try {
    await append(makeEvent(runId, 'runner', 'protocol_calibration_started', { kind: 'protocol-calibration', inferencePerformed: false }));
    if (signal.aborted) throw signal.reason;
    fixture = await manager.reset({ runId }); result.fixtureId = fixture.fixtureId;
    redactor.addSecrets([fixture.pm.token]);
    before = await manager.snapshot(fixture);
    const target = fixture.targets['beacon-receipt']!;
    const budget = { maxDurationMinutes: 2, maxModelCalls: 1, maxToolCalls: 20, maxCostUsd: null };
    await manager.startProtocolRuntime(fixture, { runId, taskId: 'L02', budget, allowedTools: ['pm_list_workspaces', 'pm_query', 'pm_read', 'pm_read_comments', 'pm_read_relations', 'pm_update_task'], allowedTargets: [target], controlledProviderScript: await readFile(new URL('./protocol-codex-peer.mjs', import.meta.url), 'utf8') });
    redactor.addSecrets([fixture.runtime!.agentAccessToken, fixture.runtime!.pmCookie, ...fixture.runtime!.providerConfig.environment.map(value => value.value)]);
    result.artifacts.environment = path.join(directory, 'artifacts', 'runtime-environment.json');
    await writeFile(result.artifacts.environment, JSON.stringify(redactor.value({ environmentHash: fixture.runtime!.environmentHash, ...fixture.runtime!.environmentEvidence }), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    check('actual-os-isolation-denial-probes', fixture.isolation?.verified === true && fixture.isolation.checks.every(value => value.passed), fixture.isolation?.checks.flatMap(value => value.evidence) ?? []);
    await append(makeEvent(runId, 'isolation', 'isolation_verified', { ...fixture.isolation }));
    await adapter.prepare({ runId, fixtureId: fixture.fixtureId, fixture, arm: 'raw', model: 'protocol-calibration', provider: 'codex', modelOptions: {}, allowedTools: ['pm_read', 'pm_update_task'], allowedTargets: [target], budget });
    manager.armResponseLoss(fixture, { targetId: target.entityId });
    activeSession = (await adapter.start({ taskId: 'L02', instruction: 'PROTOCOL_CALIBRATION_WRITE: use the real generation-scoped PM CLI transport to read beacon-receipt, persist original operation handoff, issue one revision-safe priority=high mutation, then remain active for the scheduled real interruption. This is controlled protocol calibration, NOT inference.' })).sessionId;
    manager.bindActiveSession(fixture, adapter.sessionIdentity(activeSession)); result.sessions.push(activeSession);
    let settled = false;
    observing = (async () => { try { for await (const event of adapter.observe(activeSession!)) await append(event); } finally { settled = true; } })();
    void observing.catch(() => undefined);
    const deadline = Date.now() + 90_000;
    let checkpoint: CheckpointEvidence | null = null;
    while (!checkpoint) {
      if (signal.aborted) throw signal.reason;
      await audit();
      after = await manager.snapshot(fixture);
      checkpoint = inspectCheckpoint('L02', 'write', fixture, before, after, trace.events);
      if (checkpoint) break;
      if (settled || Date.now() >= deadline) throw new Error('Controlled native peer did not produce a real committed lost-response checkpoint while active.');
      await delay(50);
    }
    await append(makeEvent(runId, 'runner', 'phase_checkpoint', checkpoint, { phaseId: 'write', sessionId: activeSession, operationId: checkpoint.operationId }));
    const priorSession = activeSession;
    await adapter.interrupt(priorSession, 'Explicit protocol committed-response-loss checkpoint'); await observing; await audit();
    const acknowledgement = trace.events.find(event => event.type === 'interrupt_acknowledged' && event.sessionId === priorSession);
    check('real-active-interruption-acknowledged', acknowledgement?.data.wasActive === true, acknowledgement ? [acknowledgement.id] : []);
    if (!acknowledgement?.data.wasActive) throw new Error('A real active native turn interruption was not established.');
    await append(makeEvent(runId, 'runner', 'context_compressed', { priorSessionId: priorSession, handoffPath: 'artifacts/handoff.json', originalOperationId: checkpoint.operationId, droppedConversation: true, source: 'handoff-only' }));
    activeSession = (await adapter.resume({ priorSessionId: priorSession, instruction: `PROTOCOL_CALIBRATION_RESUME: read your original handoff; recover original operation ${checkpoint.operationId} only through the run-scoped READ-ONLY real receipt capability http://127.0.0.1:3901/bench/receipts/${checkpoint.operationId}. Never redispatch the committed mutation. No previous conversation/native cursor is supplied. This is protocol calibration, NOT inference.` })).sessionId;
    manager.bindActiveSession(fixture, adapter.sessionIdentity(activeSession)); result.sessions.push(activeSession);
    settled = false;
    observing = (async () => { try { for await (const event of adapter.observe(activeSession!)) await append(event); } finally { settled = true; } })();
    void observing.catch(() => undefined);
    while (!settled) { if (signal.aborted) throw signal.reason; await audit(); if (Date.now() >= deadline) throw new Error('Fresh-Session original receipt recovery timed out.'); await delay(50); }
    await observing; await audit();
    await manager.stopRuntime(fixture);
    after = await manager.snapshot(fixture);
    const lost = trace.events.find(event => event.source === 'transport' && event.type === 'response_lost' && event.operationId === checkpoint!.operationId);
    const reconciled = trace.events.find(event => event.source === 'transport' && event.type === 'receipt_reconciled' && event.operationId === checkpoint!.operationId && event.sessionId === activeSession);
    const original = after.receipts.find(receipt => receipt.kind === 'native' && receipt.operationId === checkpoint!.operationId && receipt.status === 'succeeded');
    const mutationAttempts = trace.events.filter(event => event.source === 'transport' && event.type === 'pm_request' && event.data.mutation === true && event.data.targetId === target.entityId);
    const entity = after.entities.find(value => value.id === target.entityId), previous = before.entities.find(value => value.id === target.entityId);
    check('actual-committed-response-dropped', lost?.data.committed === true && original?.targetId === target.entityId && lost.data.revision === original?.revision, lost ? [lost.id, checkpoint.operationId] : []);
    check('fresh-product-sessions', result.sessions.length === 2 && new Set(result.sessions).size === 2 && trace.events.some(event => event.type === 'session_resumed' && event.data.fresh === true && event.data.copiedHistory === false), [...result.sessions]);
    check('real-original-receipt-new-session', !!reconciled && reconciled.data.status === 'succeeded' && typeof reconciled.data.receiptIdentity === 'string' && reconciled.data.receiptIdentity === lost?.data.receiptIdentity && reconciled.data.targetId === original?.targetId && (reconciled.data.revision ?? reconciled.data.resultRevision) === original?.revision && reconciled.generationId === adapter.sessionIdentity(activeSession).generationId, reconciled ? [reconciled.id, String(reconciled.data.receiptIdentity)] : []);
    check('no-original-write-replay', mutationAttempts.length === 1 && mutationAttempts[0]?.operationId === checkpoint.operationId, mutationAttempts.map(event => event.id));
    check('actual-business-state-not-generation-status', entity?.entity.priority === 'high' && entity.entity.status === previous?.entity.status && before.entities.filter(value => value.id !== target.entityId).every(value => after!.entities.find(current => current.id === value.id)?.revision === value.revision), [target.entityId, String(entity?.revision)]);
    check('no-capability-violations', !trace.events.some(event => event.type === 'safety_violation'), trace.events.filter(event => event.type === 'safety_violation').map(event => event.id));
    check('no-provider-inference', !trace.events.some(event => event.type === 'provider_request'), ['controlled native protocol peer only']);
    result.passed = result.checks.every(value => value.passed);
    if (!result.passed) result.failure = { category: 'protocol', message: 'One or more independent real protocol checks failed.' };
  } catch (error) {
    result.failure = { category: fixture?.runtime ? 'protocol' : 'infrastructure', message: redactor.text(error instanceof Error ? error.message : String(error)) };
    await append(makeEvent(runId, 'runner', 'protocol_calibration_failed', { ...result.failure }));
  } finally {
    try {
      if (activeSession) await adapter.stop(activeSession).catch(() => undefined);
      if (fixture) {
        await manager.stopRuntime(fixture).catch(error => { result.failure ??= { category: 'cleanup', message: redactor.text(String(error)) }; });
        if (observing) await observing.catch(() => undefined);
        await audit();
        try {
          after = await manager.snapshot(fixture);
          if (before) {
            diff = manager.diff(before, after, { allowedEntityIds: [fixture.targets['beacon-receipt']!.entityId] });
            check('authority-diff-no-unexpected-mutations', diff.unexpectedMutations.length === 0, diff.unexpectedMutations.map(mutation => `${mutation.domain}:${mutation.identity}`));
            Object.assign(result.artifacts, await writeAuthorityArtifacts(before, after, path.join(directory, 'artifacts'), redactor));
          }
          const collected = await collectArtifacts(fixture.publicRoot, path.join(directory, 'artifacts', 'agent'), redactor);
          Object.assign(result.artifacts, collected.files);
          check('safe-artifact-export', collected.violations.length === 0, collected.violations);
        } catch (error) { result.failure ??= { category: 'infrastructure', message: redactor.text(String(error)) }; }
        try { await manager.destroy(fixture); } catch (error) { result.failure = { category: 'cleanup', message: redactor.text(String(error)) }; }
      }
      result.passed = result.passed && result.failure === null && result.checks.every(value => value.passed);
      result.timeMs = Date.now() - started;
      await writeFile(result.artifacts.pmDiff!, JSON.stringify(redactor.value(diff ?? { unavailable: true }), null, 2) + '\n', { mode: 0o600 });
      await writeFile(result.artifacts.gitDiff!, before && after ? redactor.text(repositoryDiff(before, after)) : '# No complete code snapshots available.\n', { mode: 0o600 });
      await append(makeEvent(runId, 'runner', 'protocol_calibration_finished', { passed: result.passed, modelEfficacy: null }));
      await trace.flush();
      await writeFile(result.artifacts.result!, JSON.stringify(redactor.value(result), null, 2) + '\n', { mode: 0o600 });
      const report = ['# Controlled protocol calibration', '', `Kind: **protocol-calibration**; real protocol checks: **${result.passed ? 'passed' : 'failed'}**.`, '', '**Model efficacy: UNKNOWN. No inference or paid-provider authentication was evaluated.**', '', ...result.checks.map(value => `- [${value.passed ? 'x' : ' '}] ${value.id}: ${value.evidence.join(', ')}`), '', ...(result.failure ? [`Failure (${result.failure.category}): ${result.failure.message}`, ''] : []), ...result.limitations.map(value => `- ${value}`), ''].join('\n');
      await writeFile(result.artifacts.report!, redactor.text(report), { mode: 0o600 });
    } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const supplied: Partial<BenchmarkConfig> = {};
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index += 2) {
      const value = args[index + 1];
      if (!value) throw new Error('Protocol calibration flags require a value.');
      if (args[index] === '--agent-image') supplied.agentImage = value;
      else if (args[index] === '--code-image') supplied.codeImage = value;
      else if (args[index] === '--outputs-root') supplied.outputsRoot = value;
      else throw new Error(`Unsupported protocol calibration option ${args[index]}`);
    }
    const result = await runProtocolCalibration({ config: supplied });
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
