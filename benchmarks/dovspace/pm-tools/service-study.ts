import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pmToolCallRecordSchema, type PmToolRequest } from '../../../packages/agent-contracts/src/pm-tools.ts';
import type { FileRecord } from '../../../packages/pm-schema/index.ts';
import { parseBenchmarkConfig, type BenchmarkConfig } from '../benchmark.config.ts';
import { createFixtureManager } from '../fixtures/manager.ts';
import { collectSourceManifest, type SourceStage } from '../isolation/source.ts';
import { prepareReportDirectory, writeReportFile } from '../reports/files.ts';
import { gradePmCorpus, type PmServiceObservation } from './grade.ts';
import { corpusSemanticHash, PM_CORPUS_VERSION, PM_TARGETED_SCENARIOS, seedPmCorpus } from './corpus.ts';
import { measureBriefBytes } from './measurement.ts';

export interface PmServiceStudyOptions {
  runId?: string; repetitions?: number; config?: Partial<BenchmarkConfig>; sourceStage?: SourceStage;
}

/** Actual isolated PostgreSQL + Markdown + authenticated PM API. Never starts a Provider or supplies a synthetic model success. */
export async function runPmServiceStudy(options: PmServiceStudyOptions = {}) {
  if (options.config?.providerApiKey || options.config?.providerEndpoint) throw new Error('The no-model PM service study refuses provider credentials/endpoints');
  const config = parseBenchmarkConfig({ ...options.config, model: '', modelOptions: {} });
  const repetitions = options.repetitions ?? 3;
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 100) throw new Error('Repetitions must be an integer from 1 through 100');
  const runId = options.runId ?? `pm-tools-${randomUUID()}`;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new Error('Invalid PM service study identity');
  const directory = path.join(config.outputsRoot, runId);
  await prepareReportDirectory(directory, true);
  const manager = createFixtureManager(config, options.sourceStage ? { sourceStage: options.sourceStage } : {});
  const fixture = await manager.reset({ runId });
  const calls: PmServiceObservation[] = [];
  try {
    const corpus = await seedPmCorpus(manager, fixture);
    const reader = await manager.provisionProjectReader(fixture, { projectIds: [corpus.project.id] });
    const before = await manager.snapshot(fixture);
    const sourceManifest = await collectSourceManifest(path.join(fixture.root, 'runtime-source'));
    async function call(id: string, scenarioId: string, name: string, args: unknown, options: { projectId?: string | null; cookie?: string } = {}) {
      const request: PmToolRequest = { operationId: randomUUID(), name, arguments: args, target: { workspaceId: fixture.workspaceId, projectId: options.projectId === undefined ? corpus.project.id : options.projectId }, executionRoot: 'external', threadId: '', messageId: '', generationId: '' };
      const started = performance.now();
      const response = await fetch(`${fixture.pm.baseUrl}/api/v1/workspaces/${fixture.workspaceId}/agent-tools/call`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000), headers: { 'content-type': 'application/json', cookie: options.cookie ?? fixture.pm.token }, body: JSON.stringify(request) });
      const raw = await response.text();
      const elapsedMs = performance.now() - started;
      let decoded: unknown;
      try { decoded = JSON.parse(raw); } catch { throw new Error('The real PM service did not return a JSON result'); }
      const parsed = pmToolCallRecordSchema.safeParse(decoded);
      if (response.ok && !parsed.success) throw new Error('The real PM service returned a malformed operation result');
      const error = decoded && typeof decoded === 'object' && 'error' in decoded ? decoded.error : undefined;
      const errorCode = parsed.success ? parsed.data.error?.code ?? null : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
      const observation: PmServiceObservation = { id, scenarioId, boundary: 'authenticated-pm-http', request, httpStatus: response.status, responseUtf8Bytes: Buffer.byteLength(raw, 'utf8'), elapsedMs, record: parsed.success ? parsed.data : null, errorCode };
      calls.push(observation);
      return observation;
    }
    const briefArgs = (task: FileRecord, bodyOffset: number | null = null) => ({ projectId: corpus.project.id, taskId: task.id, revision: task.revision, stage: 'development', bodyOffset, bodyLimit: null });
    await call('standard-brief', 'PMT10', 'pm_task_brief', briefArgs(corpus.briefTask));
    await call('heading-brief', 'PMT03', 'pm_task_brief', briefArgs(corpus.headingTask));
    const longFirst = await call('long-first-brief', 'PMT01', 'pm_task_brief', briefArgs(corpus.longTask));
    const longFirstResult = longFirst.record?.result;
    if (longFirstResult?.kind !== 'task_brief' || longFirstResult.brief.task.nextBodyOffset === null) throw new Error('Long corpus did not exercise actual brief pagination');
    await call('long-tail-brief', 'PMT01', 'pm_task_brief', briefArgs(corpus.longTask, longFirstResult.brief.task.nextBodyOffset));
    let bodyOffset: number | null = 0, page = 0;
    while (bodyOffset !== null) {
      const observation = await call(`long-page-${page++}`, 'PMT01', 'pm_read', { id: corpus.longTask.id, bodyOffset, bodyLimit: 12000 });
      if (observation.record?.result?.kind !== 'task') throw new Error('Long task page did not return an actual PM task');
      const next = observation.record.result.items[0]?.nextBodyOffset;
      if (next === undefined || next !== null && next <= bodyOffset) throw new Error('PM body cursor did not advance');
      bodyOffset = next;
    }
    let after: string | null = null; page = 0;
    do {
      const observation = await call(`inventory-${page++}`, 'PMT02', 'pm_query', { entity: 'work_item', projectId: corpus.project.id, query: null, after, limit: 20 });
      if (observation.record?.result?.kind !== 'query') throw new Error('Inventory did not return a real query page');
      const next = observation.record.result.nextCursor;
      if (next !== null && next === after) throw new Error('PM inventory cursor did not advance');
      after = next;
    } while (after !== null);
    const knowledgeArgs = { projectId: corpus.project.id, taskId: corpus.briefTask.id, revision: corpus.briefTask.revision, query: 'migration', projectIds: null, cursor: null, limit: 20 };
    await call('knowledge-own', 'PMT05', 'pm_search_knowledge', knowledgeArgs);
    await call('knowledge-explicit', 'PMT04', 'pm_search_knowledge', { ...knowledgeArgs, projectIds: [corpus.project.id, corpus.otherProject.id] }, { projectId: null });
    await call('restricted-own', 'PMT04', 'pm_search_knowledge', knowledgeArgs, { cookie: reader.cookie });
    await call('restricted-hidden-read', 'PMT04', 'pm_read', { id: corpus.hiddenDecision.id, bodyOffset: 0, bodyLimit: 12000 }, { cookie: reader.cookie });
    await call('restricted-hidden-scope', 'PMT04', 'pm_search_knowledge', { ...knowledgeArgs, projectIds: [corpus.project.id, corpus.hiddenProject.id] }, { cookie: reader.cookie });
    for (let iteration = 0; iteration < repetitions; iteration++) {
      await call(`micro-brief-${iteration}`, 'microbenchmark', 'pm_task_brief', briefArgs(corpus.briefTask));
      await call(`micro-query-${iteration}`, 'microbenchmark', 'pm_query', { entity: 'work_item', projectId: corpus.project.id, query: null, after: null, limit: 20 });
      await call(`micro-read-${iteration}`, 'microbenchmark', 'pm_read', { id: corpus.longTask.id, bodyOffset: 0, bodyLimit: 12000 });
    }
    // Trusted scheduled revision change, not a microbenchmark write or automatic retry.
    const changed = await manager.request<FileRecord>(fixture, `/api/v1/workspaces/${fixture.workspaceId}/core/files/${corpus.longTask.id}`, { method: 'PUT', headers: { 'Idempotency-Key': randomUUID() }, body: { revision: corpus.longTask.revision, raw: `${corpus.longTask.raw}\nREVISION-V2: do not use the old body revision to authorize any write.\n` } });
    await call('revision-old-brief', 'PMT06', 'pm_task_brief', briefArgs(corpus.longTask, 48000));
    await call('revision-unpinned-read', 'PMT06', 'pm_read', { id: corpus.longTask.id, bodyOffset: 12000, bodyLimit: 12000 });
    await call('revision-new-brief', 'PMT06', 'pm_task_brief', briefArgs(changed));
    const final = await manager.snapshot(fixture);
    const protocol = { freshProductSessionReread: null, compactionRetainedRequirements: null, lostReceiptRecovery: null };
    const grade = gradePmCorpus({ corpus, before, after: final, calls, protocol, restrictedActorId: reader.actorId });
    const measurements = calls.flatMap(observation => observation.record?.result?.kind === 'task_brief' ? [{ id: observation.id, responseUtf8Bytes: observation.responseUtf8Bytes, ...measureBriefBytes(observation.record.result.brief, observation.record.result) }] : []);
    const microbenchmark = ['pm_task_brief', 'pm_query', 'pm_read'].map(name => {
      const samples = calls.filter(observation => observation.scenarioId === 'microbenchmark' && observation.request.name === name);
      const values = samples.map(observation => observation.elapsedMs).sort((a, b) => a - b);
      const middle = Math.floor(values.length / 2);
      return { name, samples: samples.map(observation => ({ id: observation.id, elapsedMs: observation.elapsedMs, responseUtf8Bytes: observation.responseUtf8Bytes, status: observation.record?.status ?? null })), n: samples.length,
        p50Ms: values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2, p95Ms: values.length >= 20 ? values[Math.ceil(values.length * 0.95) - 1]! : null, cacheState: 'uncontrolled' as const };
    });
    const result = { kind: 'pm-tools-service-study' as const, schemaVersion: 1, runId, corpusVersion: PM_CORPUS_VERSION, corpusSemanticHash: corpusSemanticHash(), fixtureId: fixture.fixtureId, sourceManifest,
      passed: grade.passed, checks: grade.checks, inferencePerformed: false, modelQuality: null, providerRequestBytes: null, tokens: null, avoidableRepeatReads: null,
      protocolObservations: protocol, consumerObservations: { mixedRevisionPageRefusal: null }, measurements, microbenchmark, authoritativeSemanticHashes: { before: before.semanticHash, after: final.semanticHash },
      scenarios: PM_TARGETED_SCENARIOS.map(scenario => ({ ...scenario, observation: ['PMT07', 'PMT08', 'PMT09'].includes(scenario.id) ? 'requires-product-protocol' : scenario.id === 'PMT06' ? 'authenticated-pm-service-only-consumer-unobserved' : 'authenticated-pm-service' })),
      limitations: ['Dedicated PM-tool corpus, not a replacement for raw/knowledge/dovspace tasks; source-access differs: no public raw-file copy of targeted sources.', 'Microbenchmark is read-tool service latency including HTTP/authorization/operation-ledger persistence, not isolated database/bridge timing or task latency; cache coldness is not controlled.', 'Fresh external operation IDs are not product Sessions. New-Session reread and lost-receipt evidence must come from the existing controlled OMP/product recovery runner, never this local helper.', 'PMT06 observes service rejection of a stale brief and the changed revision returned by an unpinned body read. No consumer assembled pages, detected mixed revisions or refused their concatenation; that consumer behavior remains unobserved.', 'Native compaction/model-request retention is unobserved. No inferred duplicate reading, token/cost savings, quality improvement or model noninferiority.'],
      artifacts: { calls: path.join(directory, 'pm-service-calls.json'), before: path.join(directory, 'authority-before.json'), after: path.join(directory, 'authority-after.json'), result: path.join(directory, 'result.json') } };
    for (const [filename, value] of [['pm-service-calls.json', calls], ['authority-before.json', before], ['authority-after.json', final], ['result.json', result]] as const) await writeReportFile(path.join(directory, filename), JSON.stringify(value, null, 2) + '\n');
    return result;
  } finally { await manager.destroy(fixture); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let repetitions = 3;
    const args = process.argv.slice(2);
    if (args.length) { if (args.length !== 2 || args[0] !== '--repetitions') throw new Error('Usage: service-study.ts [--repetitions 1..100]'); repetitions = Number(args[1]); }
    const result = await runPmServiceStudy({ repetitions });
    console.log(JSON.stringify(result, null, 2)); if (!result.passed) process.exitCode = 1;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
