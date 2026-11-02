import { createHash } from 'node:crypto';
import type { NativeOutputItem } from '@agent-workspace/contracts/output';
import type { StudioExecutionRequest } from '../../../../../../packages/contracts/src/automation-studio.ts';
import { pmAutomationAgentEvidenceSchema, type PmAutomationAgentEvidence, type PmAutomationExecution, type PmAutomationSourceRef } from '../../../../../../packages/contracts/src/automation-pm.ts';
import { listChatGenerations, type ChatGeneration } from '../../durable/chat-runtime.ts';
import { getNativeOutput } from '../../durable/native-output.ts';
import { listThreads } from '../../durable/threads.ts';
import { isAutomationOriginGeneration } from '../context.ts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textOf = (message: { parts?: unknown }) => Array.isArray(message.parts) ? message.parts.flatMap(part => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n') : '';
const safePath = (path: string) => path.length > 0 && path.length <= 1000 && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') && !path.split('/').includes('..');
function isTestCommand(item: NativeOutputItem): boolean {
  const raw = typeof item.input === 'string' ? item.input : item.input && typeof item.input === 'object' && 'command' in item.input ? item.input.command : '';
  const command = (Array.isArray(raw) ? raw.join(' ') : typeof raw === 'string' ? raw : '').trim();
  return /^(?:node\s+[^\n]*--test\b|(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test(?::[\w-]+)?|vitest|jest)(?:\s|$)|(?:python(?:3)?\s+-m\s+)?pytest(?:\s|$)|(?:vitest|jest)(?:\s|$))/.test(command);
}

/** Only machine-produced test runner frames count; assistant prose and successful generic commands never do. */
export function pmNativeTestEvidence(item: NativeOutputItem, sourceRefId: string): PmAutomationExecution['tests'] {
  if (item.type !== 'command_execution' || !item.output || item.outputTruncated || Buffer.byteLength(item.output) > 128000 || !isTestCommand(item)) return [];
  const tests: PmAutomationExecution['tests'] = [];
  for (const line of item.output.split('\n')) {
    const tap = /^(not ok|ok)\s+\d+\s+-\s+(.+?)(?:\s+#\s+(SKIP|TODO)\b.*)?$/i.exec(line);
    if (tap) tests.push({ name: tap[2]!.slice(0, 2000), status: tap[3] ? 'skipped' : tap[1] === 'ok' ? 'passed' : 'failed', detail: line.slice(0, 12000), sourceRefId });
    const pytest = /^(\S+::\S+)\s+(PASSED|FAILED|SKIPPED|ERROR)(?:\s|$)/.exec(line);
    if (pytest) tests.push({ name: pytest[1]!.slice(0, 2000), status: pytest[2] === 'PASSED' ? 'passed' : pytest[2] === 'SKIPPED' ? 'skipped' : 'failed', detail: line.slice(0, 12000), sourceRefId });
  }
  return tests;
}
/** The root TAP plan must account for every captured test, without dropped bytes/rows. */
export function pmNativeTestsComplete(item: NativeOutputItem, tests: PmAutomationExecution['tests']): boolean {
  const plan = item.output?.match(/^1\.\.(\d+)\s*$/m)?.[1];
  return item.type === 'command_execution' && item.status === 'completed' && Number.isInteger(item.exitCode) && !item.outputTruncated && Boolean(plan) && Number(plan) === tests.length && tests.length > 0;
}

/** Exact persisted PM references only. Titles, cwd names, and current mutable thread bindings are not joins. */
export function pmGenerationTaskAssociations(generation: ChatGeneration, projectId: string): Array<{ id: string; revision: string | null }> {
  const refs = new Map<string, string | null>();
  for (const ref of generation.pmReferences ?? []) if (ref.kind === 'issue' && ref.projectId === projectId && /^TASK-\d+$/.test(ref.id) && (ref.availability === 'available' || ref.availability === 'stale')) refs.set(ref.id, ref.revision);
  return [...refs].map(([id, revision]) => ({ id, revision }));
}

export function collectPmAgentEvidence(request: StudioExecutionRequest): PmAutomationAgentEvidence {
  const evidence: PmAutomationAgentEvidence = { sources: [], sessions: [], executions: [], pullRequests: [], coverage: [] };
  const gaps = new Set<string>();
  let bytes = 0, observedSessions = 0, observedExecutions = 0;
  const source = (kind: PmAutomationSourceRef['kind'], id: string, revision: string, label: string, at: string | null, threadId: string): PmAutomationSourceRef => ({ refId: `agent:${kind}:${hash([id, revision]).slice(0, 32)}`, kind, id, revision, actorId: request.actorId, workspaceId: request.workspaceId, projectId: request.projectId, label: label.slice(0, 1000), url: `/agent/workspace?workspace=${encodeURIComponent(request.workspaceId)}&project=${encodeURIComponent(request.projectId)}&threadId=${encodeURIComponent(threadId)}`, updatedAt: at });
  const clip = (text: string, limit: number) => { if (text.length <= limit) return text; gaps.add('Bounded Agent text was truncated; full original remains in Agent Chat.'); return text.slice(0, limit); };
  for (const thread of listThreads()) {
    if (thread.scope?.workspaceId !== request.workspaceId || thread.scope.projectId !== request.projectId || thread.custom?.automationExecutionId) continue;
    const all = listChatGenerations(thread.remoteId).filter(generation => !generation.idleCompaction && !isAutomationOriginGeneration(generation));
    if (all.length > 200) gaps.add('A session has more than 200 generations; only its most recent accepted generations are collected.');
    const generations = all.slice(0, 200).filter(generation => generation.executionSnapshot?.actorId === request.actorId && generation.executionSnapshot.scope.workspaceId === request.workspaceId && generation.executionSnapshot.scope.projectId === request.projectId);
    if (all.some(generation => !generation.executionSnapshot?.actorId)) gaps.add('Legacy Agent generations lack PM-resolved actor identity and were excluded, not assigned to the current actor.');
    if (!generations.length) continue;
    observedSessions++;
    if (evidence.sessions.length >= 100 || bytes >= 1800000) { gaps.add('Agent collection reached 100 sessions or 1.8 MiB; later records were not exposed.'); continue; }
    const refs: PmAutomationSourceRef[] = [];
    const add = (ref: PmAutomationSourceRef) => { refs.push(ref); bytes += Buffer.byteLength(JSON.stringify(ref)); return ref.refId; };
    const ordered = [...generations].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const sessionSource = source('session', thread.remoteId, hash([thread.title, thread.custom?.pmTopics, ordered.map(g => [g.id, g.seq, g.status])]), thread.title ?? thread.remoteId, ordered.at(-1)!.endedAt ?? ordered.at(-1)!.createdAt, thread.remoteId);
    add(sessionSource);
    const messages: PmAutomationAgentEvidence['sessions'][number]['messages'] = [];
    const taskIds = new Set<string>();
    let messageBytes = 0;
    for (const generation of ordered) {
      if (bytes >= 1800000 || evidence.sources.length + refs.length >= 9000) { gaps.add('Agent evidence byte/source limit reached; remaining generations were excluded.'); break; }
      for (const association of pmGenerationTaskAssociations(generation, request.projectId)) taskIds.add(association.id);
      const input = generation.request.messages.at(-1);
      if (input && input.role === 'user' && messageBytes < 100000) {
        const ref = source('message', input.id, hash(input.parts), 'User message accepted by Agent', generation.createdAt, thread.remoteId);
        messages.push({ id: input.id, sourceRefId: add(ref), role: 'user', text: clip(textOf(input), 16000), at: generation.createdAt });
        messageBytes += Buffer.byteLength(messages.at(-1)!.text);
      }
      if (generation.output && generation.endedAt && messageBytes < 100000) {
        const ref = source('message', generation.messageId, hash([generation.output.parts, generation.seq]), 'Persisted Agent response', generation.endedAt, thread.remoteId);
        messages.push({ id: generation.messageId, sourceRefId: add(ref), role: 'assistant', text: clip(textOf(generation.output), 16000), at: generation.endedAt });
        messageBytes += Buffer.byteLength(messages.at(-1)!.text);
      }
      observedExecutions++;
      if (evidence.executions.length >= 200 || bytes >= 1800000) { gaps.add('Agent execution collection reached 200 executions or 1.8 MiB.'); continue; }
      const associations = pmGenerationTaskAssociations(generation, request.projectId);
      const association = associations.length === 1 ? associations[0] : undefined;
      if (!association) gaps.add('Some generations have no unique immutable task association; their taskId is null and no task match was inferred.');
      const output = getNativeOutput(generation.id);
      const executionSource = source('execution', generation.id, hash([generation.status, generation.seq, output?.sequence]), `Agent generation ${generation.id}`, generation.endedAt ?? generation.createdAt, thread.remoteId);
      const execution: PmAutomationExecution = { id: generation.id, sourceRefId: add(executionSource), sessionId: thread.remoteId, taskId: association?.id ?? null, taskRevision: association?.revision ?? null, status: generation.status === 'completed' ? 'succeeded' : generation.status === 'interrupted' ? 'outcome_unknown' : generation.status, startedAt: generation.createdAt, finishedAt: generation.endedAt ?? null, summary: clip(generation.output ? textOf(generation.output) : generation.error ?? '', 16000), reviewed: null, tests: [], diffPaths: [], logs: [], tools: [] };
      const items = output?.items ?? [];
      let sawTestCommand = false, completeTests = true;
      if (!output) gaps.add('Some generations have no durable native tool/test/diff journal; missing receipts are not passing evidence.');
      for (const item of items) {
        if (bytes >= 1800000 || evidence.sources.length + refs.length >= 9000) { completeTests = false; gaps.add('Native tool/diff source budget reached; evidence is partial.'); break; }
        if (item.type === 'command_execution' || item.type === 'dynamic_tool' || item.type === 'error') {
          if (execution.tools.length >= 30 || execution.logs.length >= 30) { completeTests = false; gaps.add('Per-generation tool/log evidence was bounded.'); continue; }
          const ref = source('tool', `${generation.id}:${item.id}`, hash(item), item.title ?? item.toolName ?? item.type, item.completedAt ?? item.startedAt ?? null, thread.remoteId);
          const refId = add(ref);
          const detail = clip(item.output ?? item.error ?? item.text ?? '', 2000);
          execution.tools.push({ sourceRefId: refId, name: clip(item.toolName ?? item.title ?? item.type, 300) || item.type, status: item.status === 'completed' ? 'succeeded' : item.status === 'failed' ? 'failed' : 'unknown', summary: detail });
          if (detail) execution.logs.push({ sourceRefId: refId, text: detail, at: item.completedAt ?? item.startedAt ?? null });
          if (item.outputTruncated) gaps.add('Native command output was truncated; it is not treated as a complete test snapshot.');
          const testRef = source('test', `${generation.id}:${item.id}:tests`, hash([item.output, item.status, item.exitCode]), 'Machine test runner output', item.completedAt ?? null, thread.remoteId);
          const tests = pmNativeTestEvidence(item, testRef.refId);
          if (item.type === 'command_execution' && isTestCommand(item)) {
            sawTestCommand = true;
            if (!pmNativeTestsComplete(item, tests) || execution.tests.length + tests.length > 200) completeTests = false;
          }
          if (tests.length && execution.tests.length + tests.length <= 200) { add(testRef); execution.tests.push(...tests); }
          else if (tests.length) gaps.add('Per-generation test facts exceeded 200 records; incomplete rows were not treated as a passing snapshot.');
        }
        if (item.type === 'file_change' && item.status === 'completed') {
          const paths = item.changes?.map(change => change.path) ?? (item.fileName ? [item.fileName] : []);
          const valid = paths.filter(safePath);
          if (valid.length !== paths.length) gaps.add('Unsafe or absolute native diff paths were excluded.');
          execution.diffPaths.push(...valid);
          add(source('diff', `${generation.id}:${item.id}`, hash(item), 'Native completed file-change receipt', item.completedAt ?? null, thread.remoteId));
        }
      }
      execution.testsComplete = sawTestCommand && completeTests && execution.tests.length > 0;
      if (sawTestCommand && !execution.testsComplete) gaps.add('A native test command has no fully parsed, untruncated test plan; all-tests-passed cannot be asserted.');
      const uniquePaths = [...new Set(execution.diffPaths)];
      if (uniquePaths.length > 1000) gaps.add('Native diff paths exceeded 1000 records; path coverage is partial.');
      execution.diffPaths = uniquePaths.slice(0, 1000);
      bytes += Buffer.byteLength(JSON.stringify(execution)); evidence.executions.push(execution);
    }
    if (messageBytes >= 100000) gaps.add('Session message evidence reached its 100 KiB budget; later text was not collected.');
    const uniqueMessages = [...new Map(messages.map(message => [message.id, message])).values()];
    if (uniqueMessages.length > 200) gaps.add('Session messages were bounded at 200 accepted messages.');
    const session = { id: thread.remoteId, sourceRefId: sessionSource.refId, taskIds: [...taskIds], status: thread.status === 'archived' ? 'archived' as const : generations.some(g => g.status === 'running' || g.status === 'queued') ? 'active' as const : 'idle' as const, title: thread.title ?? thread.remoteId, topics: Array.isArray(thread.custom?.pmTopics) ? thread.custom.pmTopics.filter((topic): topic is string => typeof topic === 'string' && topic.length > 0 && topic.length <= 300).slice(0, 100) : [], createdAt: thread.createdAt, updatedAt: sessionSource.updatedAt!, messages: uniqueMessages.slice(-200) };
    bytes += Buffer.byteLength(JSON.stringify(session)); evidence.sessions.push(session); evidence.sources.push(...refs);
  }
  evidence.sources = [...new Map(evidence.sources.map(ref => [ref.refId, ref])).values()];
  const reason = gaps.size ? [...gaps].join(' ') : null;
  evidence.coverage = [{ source: 'sessions', status: reason ? 'partial' : 'complete', observedRecords: evidence.sessions.length, totalRecords: reason ? null : observedSessions, reason }, { source: 'executions', status: reason ? 'partial' : 'complete', observedRecords: evidence.executions.length, totalRecords: reason ? null : observedExecutions, reason }];
  return pmAutomationAgentEvidenceSchema.parse(evidence);
}
