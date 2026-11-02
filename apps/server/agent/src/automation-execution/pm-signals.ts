import { createHash } from 'node:crypto';
import type { PmAutomationEvent } from '../../../../../packages/contracts/src/automation-pm.ts';
import { automationServiceHeaders } from '../../../../../packages/infrastructure/src/automation-execution-client.ts';
import type { ChatGeneration } from '../durable/chat-runtime.ts';
import { listChatGenerations } from '../durable/chat-runtime.ts';
import { getThread, listThreads } from '../durable/threads.ts';
import { deleteRecord, listRecords, readRecord, transaction, writeRecord } from '../durable/store.ts';
import { isAutomationOriginGeneration } from './context.ts';

const namespace = 'pm-automation:agent-signal-outbox';
const cursors = 'pm-automation:agent-signal-cursors';
type Pending = { event: PmAutomationEvent; attempts: number; nextAttemptAt: number };
type Cursor = { terminal: string; idle: string | null };
let timer: NodeJS.Timeout | undefined, cycle: Promise<void> | undefined, controller: AbortController | undefined;
const watermark = (generation: ChatGeneration) => `${generation.endedAt ?? generation.createdAt}:${generation.id}`;
function sourceEvent(generation: ChatGeneration, key: 'agent.run.terminal' | 'agent.session.idle', at: string): PmAutomationEvent | null {
  const snapshot = generation.executionSnapshot, thread = getThread(generation.threadId);
  if (!snapshot?.actorId || !snapshot.scope.projectId || thread?.scope?.workspaceId !== snapshot.scope.workspaceId || thread.scope.projectId !== snapshot.scope.projectId || thread.custom?.automationExecutionId || isAutomationOriginGeneration(generation) || generation.idleCompaction || ['running', 'queued'].includes(generation.status)) return null;
  const revision = createHash('sha256').update(JSON.stringify([generation.id, generation.status, generation.seq, generation.endedAt, ...(key === 'agent.session.idle' ? [at] : [])])).digest('hex');
  const id = key === 'agent.run.terminal' ? generation.id : generation.threadId;
  return { eventId: `agent:${key}:${generation.id}:${revision.slice(0, 20)}`, source: 'pm', key, actorId: snapshot.actorId, workspaceId: snapshot.scope.workspaceId, projectId: snapshot.scope.projectId, at, sourceRef: { refId: `agent:${key}:${revision}`, kind: key === 'agent.run.terminal' ? 'execution' : 'session', id, revision, actorId: snapshot.actorId, workspaceId: snapshot.scope.workspaceId, projectId: snapshot.scope.projectId, label: key === 'agent.run.terminal' ? `Agent generation ${generation.status}` : 'Agent session idle for at least 60 seconds', url: `/agent/workspace?workspace=${encodeURIComponent(snapshot.scope.workspaceId)}&project=${encodeURIComponent(snapshot.scope.projectId)}&threadId=${encodeURIComponent(generation.threadId)}`, updatedAt: generation.endedAt ?? generation.createdAt }, originExecutionId: null, before: null, after: null, lastVisitAt: null, visitedAt: null };
}
export function queuePmAgentTerminal(generation: ChatGeneration): void {
  if (!generation.endedAt) return;
  const event = sourceEvent(generation, 'agent.run.terminal', generation.endedAt);
  if (!event) return;
  const cursor = readRecord<Cursor>(cursors, generation.threadId);
  if (cursor && cursor.terminal >= watermark(generation)) return;
  if (!readRecord(namespace, event.eventId)) writeRecord<Pending>(namespace, event.eventId, { event, attempts: 0, nextAttemptAt: 0 });
}
async function sweep(signal: AbortSignal): Promise<void> {
  const threads = listThreads().sort((left, right) => left.remoteId.localeCompare(right.remoteId));
  const last = readRecord<{ lastThreadId: string }>(cursors, 'scan')?.lastThreadId ?? '';
  const after = threads.filter(thread => thread.remoteId > last);
  const batch = (after.length ? after : threads).slice(0, 50);
  let recovered = 0, pendingCount = listRecords<Pending>(namespace).length;
  for (const thread of batch) {
    if (!thread.scope?.projectId || thread.custom?.automationExecutionId) continue;
    const generations = listChatGenerations(thread.remoteId).filter(generation => !generation.idleCompaction && !isAutomationOriginGeneration(generation));
    const terminalCursor = readRecord<Cursor>(cursors, thread.remoteId)?.terminal ?? '';
    const recovery = generations.filter(generation => generation.executionSnapshot?.actorId && generation.endedAt && watermark(generation) > terminalCursor).sort((left, right) => watermark(left).localeCompare(watermark(right))).slice(0, 25);
    for (const generation of recovery) {
      if (recovered >= 50 || pendingCount >= 500) break;
      queuePmAgentTerminal(generation); recovered++; pendingCount++;
    }
    const latest = generations[0];
    if (!latest?.endedAt || generations.some(generation => generation.status === 'running' || generation.status === 'queued')) continue;
    const eligibleAt = Math.max(Date.parse(latest.endedAt), Date.parse(thread.updatedAt)) + 60000;
    if (Date.now() < eligibleAt) continue;
    const event = sourceEvent(latest, 'agent.session.idle', new Date(eligibleAt).toISOString());
    if (pendingCount < 500 && event && readRecord<Cursor>(cursors, thread.remoteId)?.idle !== event.eventId && !readRecord(namespace, event.eventId)) { writeRecord<Pending>(namespace, event.eventId, { event, attempts: 0, nextAttemptAt: 0 }); pendingCount++; }
  }
  if (batch.length) writeRecord(cursors, 'scan', { lastThreadId: batch.at(-1)!.remoteId });
  if (Buffer.byteLength(process.env.PM_AUTOMATION_SERVICE_SECRET ?? '') < 32) return;
  const base = new URL(process.env.PM_API_URL ?? 'http://127.0.0.1:4194');
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' || !['https:', 'http:'].includes(base.protocol) || base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('Agent signal delivery requires a clean trusted PM origin.');
  const pending = listRecords<Pending>(namespace).filter(record => record.nextAttemptAt <= Date.now()).sort((a, b) => a.event.at.localeCompare(b.event.at)).slice(0, 50);
  for (const record of pending) {
    signal.throwIfAborted();
    if (record.event.key === 'agent.session.idle') {
      const latest = listChatGenerations(record.event.sourceRef.id).find(generation => !generation.idleCompaction);
      const active = listChatGenerations(record.event.sourceRef.id).some(generation => generation.status === 'queued' || generation.status === 'running');
      const lastActivity = latest?.endedAt ? Math.max(Date.parse(latest.endedAt), Date.parse(getThread(record.event.sourceRef.id)?.updatedAt ?? latest.endedAt)) : null;
      const current = latest?.endedAt && lastActivity !== null ? sourceEvent(latest, 'agent.session.idle', new Date(lastActivity + 60000).toISOString()) : null;
      if (active || current?.eventId !== record.event.eventId) { deleteRecord(namespace, record.event.eventId); continue; }
    }
    const endpoint = new URL(`/api/v1/workspaces/${encodeURIComponent(record.event.workspaceId)}/automations/pm/signals`, base);
    const body = JSON.stringify(record.event);
    try {
      const response = await fetch(endpoint, { method: 'POST', body, headers: automationServiceHeaders('POST', endpoint.pathname, body), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`PM signal delivery rejected (HTTP ${response.status}).`);
      transaction(() => {
        const threadId = record.event.key === 'agent.session.idle' ? record.event.sourceRef.id : getThreadForGeneration(record.event.sourceRef.id);
        if (!threadId) throw new Error('Original Agent signal association no longer exists.');
        const cursor = readRecord<Cursor>(cursors, threadId) ?? { terminal: '', idle: null };
        if (record.event.key === 'agent.session.idle') cursor.idle = record.event.eventId;
        else {
          const generation = listChatGenerations(threadId).find(value => value.id === record.event.sourceRef.id);
          if (generation && cursor.terminal < watermark(generation)) cursor.terminal = watermark(generation);
        }
        writeRecord(cursors, threadId, cursor); deleteRecord(namespace, record.event.eventId);
      });
    } catch {
      signal.throwIfAborted();
      record.attempts++; record.nextAttemptAt = Date.now() + Math.min(300000, 1000 * 2 ** Math.min(record.attempts, 8)); writeRecord(namespace, record.event.eventId, record);
    }
  }
}
function getThreadForGeneration(id: string): string | null {
  const generation = readRecord<ChatGeneration>('chat:generations', id);
  return generation?.threadId ?? null;
}
export function startPmAgentSignals(): void {
  if (timer) return;
  controller = new AbortController();
  const tick = () => { if (cycle || controller!.signal.aborted) return; cycle = sweep(controller!.signal).catch(() => undefined).finally(() => { cycle = undefined; }); };
  timer = setInterval(tick, 5000); timer.unref(); tick();
}
export async function stopPmAgentSignals(): Promise<void> {
  clearInterval(timer); timer = undefined; controller?.abort(); await cycle; controller = undefined;
}
