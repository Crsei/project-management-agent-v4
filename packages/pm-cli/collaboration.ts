import type { ReadableStreamReadResult } from 'node:stream/web';
import { z } from 'zod';
import { parseOptions, nonempty, identifier, inputFile, textFile, CliRequestError, type CliFamily, type CliRuntime } from './runtime.ts';
import { changeHistoryTargetSchema, changeHistoryQuerySchema, changeCompareInputSchema, changeAcknowledgeInputSchema, taskAttentionQuerySchema, changeSequenceSchema } from '../contracts/src/change-history.ts';
import { taskCommentContentSchema } from '../domain/src/task-comments.ts';
import { collaborationChangesPageSchema } from '../agent-contracts/src/pm-tool-collaboration.ts';

const uuid = z.uuid().toLowerCase();
const integer = (value: string | undefined, fallback: number, max: number, min = 1): number => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error('Expected a nonnegative integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`Expected an integer from ${min} to ${max}`);
  return parsed;
};
function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value !== 'true' && value !== 'false') throw new Error('Expected true or false');
  return value === 'true';
}
function target(options: Record<string, string>) {
  if (options.id !== undefined) {
    if (options.source !== undefined || options.path !== undefined) throw new Error('Use --id or --source with --path, never both');
    return changeHistoryTargetSchema.parse({ kind: 'core', entityId: identifier(options.id) });
  }
  return changeHistoryTargetSchema.parse({ kind: 'external', sourceId: nonempty(options.source, '--source'), path: nonempty(options.path, '--path') });
}
function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) if (value !== undefined) params.set(name, String(value));
  return params.size ? `?${params}` : '';
}
const refOptions = ['project', 'after', 'limit'] as const;
const targetOptions = ['id', 'source', 'path'] as const;
async function content(options: Record<string, string>): Promise<string> {
  if ((options.content === undefined) === (options.file === undefined)) throw new Error('Provide exactly one of --content or --file');
  return taskCommentContentSchema.parse(options.content ?? await textFile(options.file, 64000));
}

export type CollaborationWatchOptions = { after: string; projectId?: string; durationMs: number; maxEvents: number; reconnects: number };
/** Finite GET-only subscription. The last checkpoint is resumable; no write is ever retried. */
export async function watchCollaborationEvents(runtime: CliRuntime, options: CollaborationWatchOptions, signal?: AbortSignal): Promise<void> {
  changeSequenceSchema.parse(options.after);
  if (options.projectId !== undefined) identifier(options.projectId);
  const bounds: readonly (readonly [number, number, number])[] = [[options.durationMs, 1, 300000], [options.maxEvents, 1, 10000], [options.reconnects, 0, 10]];
  for (const [value, min, max] of bounds) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid finite watch bounds');
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const timer = setTimeout(abort, options.durationMs);
  if (signal?.aborted) controller.abort();
  let cursor = options.after, count = 0, connections = 0;
  let reason: 'disconnected' | 'aborted' | 'limit' = 'disconnected';
  try {
    for (let attempt = 0; attempt <= options.reconnects && !controller.signal.aborted; attempt++) {
      let response: Response;
      try {
        response = await runtime.response('workspace', `/events${query({ after: cursor, projectId: options.projectId })}`, { headers: { Accept: 'text/event-stream', 'Last-Event-ID': cursor }, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) { reason = 'aborted'; break; }
        if (error instanceof CliRequestError && error.code === 'CLI_CONNECTION_FAILED' && attempt < options.reconnects) continue;
        throw error;
      }
      connections++;
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) {
        await response.body?.cancel();
        throw new Error('Expected a native SSE response');
      }
      const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
      let pending = '', eventName = '', eventId: string | undefined, data: string[] = [], frameLength = 0;
      const emit = () => {
        if (!data.length) { eventName = ''; eventId = undefined; frameLength = 0; return; }
        const name = eventName || 'message';
        let payload: unknown;
        try { payload = JSON.parse(data.join('\n')); } catch { throw new Error('Invalid SSE JSON payload'); }
        if (name === 'stream_error') {
          const error = z.strictObject({ code: z.string() }).parse(payload);
          throw new Error(`PM event stream stopped: ${error.code}. Reload authorized state before reconnecting; no write was replayed.`);
        }
        if (name !== 'change' && name !== 'checkpoint') throw new Error(`Unsupported native SSE event: ${name}`);
        if (eventId === undefined) throw new Error('Native SSE event is missing its resumable ID');
        const next = changeSequenceSchema.parse(eventId);
        if (BigInt(next) < BigInt(cursor)) throw new Error('Native SSE cursor moved backwards');
        if (name === 'change') {
          payload = collaborationChangesPageSchema.shape.events.element.shape.event.parse(payload);
          if (BigInt(next) === BigInt(cursor)) throw new Error('Native SSE repeated an already delivered stream position');
          count++;
        } else if (z.strictObject({ cursor: changeSequenceSchema }).parse(payload).cursor !== next) throw new Error('Native SSE checkpoint does not match its ID');
        cursor = next;
        runtime.print({ event: name, id: cursor, data: payload });
        eventName = ''; eventId = undefined; data = []; frameLength = 0;
      };
      try {
        while (!controller.signal.aborted && count < options.maxEvents) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try { chunk = await reader.read(); }
          catch (error) {
            if (controller.signal.aborted) { reason = 'aborted'; break; }
            if (error instanceof TypeError) break;
            throw error;
          }
          if (chunk.done) { if (decoder.decode()) throw new Error('Incomplete SSE UTF-8'); break; }
          pending += decoder.decode(chunk.value, { stream: true });
          if (pending.length > 1024 * 1024) throw new Error('Native SSE frame exceeds 1 MiB');
          let newline: number;
          while ((newline = pending.indexOf('\n')) !== -1 && count < options.maxEvents) {
            const line = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1);
            frameLength += line.length;
            if (frameLength > 1024 * 1024) throw new Error('Native SSE frame exceeds 1 MiB');
            if (!line) { emit(); continue; }
            if (line.startsWith(':')) continue;
            const separator = line.indexOf(':'), field = separator === -1 ? line : line.slice(0, separator);
            const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
            if (field === 'event') eventName = value;
            else if (field === 'id') eventId = value;
            else if (field === 'data') data.push(value);
            else if (field !== 'retry') throw new Error('Unsupported native SSE field');
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        await reader.cancel().catch(() => undefined); reader.releaseLock();
      }
      if (count >= options.maxEvents) { reason = 'limit'; break; }
      if (controller.signal.aborted) { reason = 'aborted'; break; }
    }
    if (controller.signal.aborted) reason = 'aborted';
    runtime.print({ cursor, events: count, connections, reason, writeReplay: false });
  } finally {
    clearTimeout(timer); controller.abort();
    signal?.removeEventListener('abort', abort);
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}

export const collaborationFamily: CliFamily = {
  help: `  comment list TASK --project PROJECT [--after UUID] [--limit 1..100]
  comment create TASK --project PROJECT (--content TEXT|--file UTF8) --request-id UUID
  comment edit TASK COMMENT --project PROJECT --version N (--content TEXT|--file UTF8) --request-id UUID
  comment delete|restore TASK COMMENT --project PROJECT --version N --request-id UUID
  comment history TASK COMMENT --project PROJECT [--after VERSION] [--limit 1..100]
  comment receipt --request-id UUID
  changes list [--after CURSOR] [--project PROJECT]
  changes history (--id ENTITY|--source SOURCE --path PATH) [--related true|false] [--head SEQUENCE] [--cursor SEQUENCE] [--limit 1..100]
  changes get CHANGE_UUID
  changes diff (--id ENTITY|--source SOURCE --path PATH) [--from UUID|baseline] [--to UUID] [--through SEQUENCE]
  changes review-state --file JSON_OR_YAML
  changes ack (--id ENTITY|--source SOURCE --path PATH) --through SEQUENCE --observation-token UUID
  notifications inbox [--origin routed|legacy_activity] [--after CURSOR] [--through HEAD]
  notifications ack EVENT_UUID --version N --read true|false --request-id UUID
  notifications archive EVENT_UUID --version N --archived true|false --request-id UUID
  notifications receipt --request-id UUID
  audit list PROJECT [--cursor CURSOR] [--limit 1..100] [--command-id ID] [--operation-id UUID]
  events watch [--after CURSOR] [--project PROJECT] [--duration-ms 1..300000] [--max-events 1..10000] [--reconnects 0..10]
  History/inbox reads never acknowledge. Preserve exact heads/tokens. Receipt queries never replay writes.`,
  async dispatch(args, runtime) {
    const [family, action, ...rest] = args;
    if (!['comment', 'changes', 'notifications', 'audit', 'events'].includes(family ?? '')) return false;
    if (family === 'comment') {
      if (action === 'receipt') {
        const options = parseOptions(rest, ['request-id']);
        runtime.print(await runtime.json('workspace', `/commands/${uuid.parse(nonempty(options['request-id'], '--request-id'))}`)); return true;
      }
      if (action === 'list') {
        const taskId = identifier(rest[0]), options = parseOptions(rest.slice(1), refOptions);
        runtime.print(await runtime.json('workspace', `/tasks/${taskId}/comments${query({ projectId: identifier(options.project), after: options.after === undefined ? undefined : uuid.parse(options.after), limit: integer(options.limit, 30, 100) })}`)); return true;
      }
      if (action === 'history') {
        const taskId = identifier(rest[0]), commentId = uuid.parse(rest[1]), options = parseOptions(rest.slice(2), refOptions);
        runtime.print(await runtime.json('workspace', `/tasks/${taskId}/comments/${commentId}/history${query({ projectId: identifier(options.project), after: options.after === undefined ? undefined : integer(options.after, 1, Number.MAX_SAFE_INTEGER), limit: integer(options.limit, 30, 100) })}`)); return true;
      }
      if (action === 'create' || action === 'edit' || action === 'delete' || action === 'restore') {
        const taskId = identifier(rest[0]), commentId = action === 'create' ? undefined : uuid.parse(rest[1]);
        const options = parseOptions(rest.slice(action === 'create' ? 1 : 2), action === 'create' ? ['project', 'content', 'file', 'request-id'] : action === 'edit' ? ['project', 'version', 'content', 'file', 'request-id'] : ['project', 'version', 'request-id']);
        const command = { commandId: uuid.parse(nonempty(options['request-id'], '--request-id')), commandType: action === 'create' ? 'CreateTaskComment' : action === 'edit' ? 'UpdateTaskComment' : action === 'delete' ? 'DeleteTaskComment' : 'RestoreTaskComment',
          projectId: identifier(options.project), targetId: taskId,
          ...(commentId ? { expectedVersions: { [commentId]: integer(nonempty(options.version, '--version'), 1, Number.MAX_SAFE_INTEGER) } } : {}),
          payload: { ...(commentId ? { commentId } : {}), ...(action === 'create' || action === 'edit' ? { content: await content(options) } : {}) } };
        runtime.print(await runtime.json('workspace', '/commands', { method: 'POST', body: command })); return true;
      }
    }
    if (family === 'changes') {
      if (action === 'list') {
        const options = parseOptions(rest, ['after', 'project']);
        runtime.print(await runtime.json('workspace', `/changes${query({ after: changeSequenceSchema.parse(options.after ?? '0'), projectId: options.project === undefined ? undefined : identifier(options.project) })}`)); return true;
      }
      if (action === 'get') {
        if (rest.length !== 1) throw new Error('Usage: pm changes get CHANGE_UUID');
        runtime.print(await runtime.json('workspace', `/change-history/${uuid.parse(rest[0])}`)); return true;
      }
      if (action === 'history') {
        const options = parseOptions(rest, [...targetOptions, 'related', 'head', 'cursor', 'limit']);
        const body = changeHistoryQuerySchema.parse({ target: target(options), includeRelated: boolean(options.related, true), limit: integer(options.limit, 50, 100), ...(options.head === undefined ? {} : { head: options.head }), ...(options.cursor === undefined ? {} : { cursor: options.cursor }) });
        runtime.print(await runtime.json('workspace', '/change-history/query', { method: 'POST', body })); return true;
      }
      if (action === 'diff') {
        const options = parseOptions(rest, [...targetOptions, 'from', 'to', 'through']);
        const body = changeCompareInputSchema.parse({ target: target(options), ...(options.from === undefined ? {} : { fromChangeId: options.from === 'baseline' ? null : options.from }), ...(options.to === undefined ? {} : { toChangeId: options.to }), ...(options.through === undefined ? {} : { through: options.through }) });
        runtime.print(await runtime.json('workspace', '/change-history/compare', { method: 'POST', body })); return true;
      }
      if (action === 'review-state') {
        const options = parseOptions(rest, ['file']);
        runtime.print(await runtime.json('workspace', '/change-history/attention', { method: 'POST', body: taskAttentionQuerySchema.parse(await inputFile(options.file)) })); return true;
      }
      if (action === 'ack') {
        const options = parseOptions(rest, [...targetOptions, 'through', 'observation-token']);
        const body = changeAcknowledgeInputSchema.parse({ target: target(options), through: nonempty(options.through, '--through'), observationToken: nonempty(options['observation-token'], '--observation-token') });
        runtime.print(await runtime.json('workspace', '/change-history/acknowledge', { method: 'POST', body })); return true;
      }
    }
    if (family === 'notifications') {
      if (action === 'inbox') {
        const options = parseOptions(rest, ['origin', 'after', 'through']);
        runtime.print(await runtime.json('workspace', `/notification-inbox${query({ origin: z.enum(['routed', 'legacy_activity']).parse(options.origin ?? 'routed'), after: options.after === undefined ? undefined : changeSequenceSchema.parse(options.after), through: options.through === undefined ? undefined : changeSequenceSchema.parse(options.through) })}`)); return true;
      }
      if (action === 'receipt') {
        const options = parseOptions(rest, ['request-id']);
        runtime.print(await runtime.json('workspace', `/commands/${uuid.parse(nonempty(options['request-id'], '--request-id'))}`)); return true;
      }
      if (action === 'ack' || action === 'archive') {
        const eventId = uuid.parse(rest[0]), flag = action === 'ack' ? 'read' : 'archived';
        const options = parseOptions(rest.slice(1), ['version', flag, 'request-id']);
        const body = { commandId: uuid.parse(nonempty(options['request-id'], '--request-id')), commandType: action === 'ack' ? 'SetNotificationRead' : 'SetNotificationArchived', targetId: eventId,
          expectedVersions: { [eventId]: integer(nonempty(options.version, '--version'), 1, Number.MAX_SAFE_INTEGER) }, payload: { [flag]: boolean(nonempty(options[flag], `--${flag}`), true) } };
        runtime.print(await runtime.json('workspace', '/commands', { method: 'POST', body })); return true;
      }
    }
    if (family === 'audit' && action === 'list') {
      const projectId = identifier(rest[0]), options = parseOptions(rest.slice(1), ['cursor', 'limit', 'command-id', 'operation-id']);
      runtime.print(await runtime.json('workspace', `/projects/${projectId}/audit${query({ cursor: options.cursor, limit: integer(options.limit, 30, 100), commandId: options['command-id'], operationId: options['operation-id'] === undefined ? undefined : uuid.parse(options['operation-id']) })}`)); return true;
    }
    if (family === 'events' && action === 'watch') {
      const options = parseOptions(rest, ['after', 'project', 'duration-ms', 'max-events', 'reconnects']);
      await watchCollaborationEvents(runtime, { after: changeSequenceSchema.parse(options.after ?? '0'), ...(options.project === undefined ? {} : { projectId: identifier(options.project) }), durationMs: integer(options['duration-ms'], 15000, 300000), maxEvents: integer(options['max-events'], 200, 10000), reconnects: integer(options.reconnects, 0, 10, 0) }); return true;
    }
    throw new Error(`Unsupported ${family} action.\n${collaborationFamily.help}`);
  },
};
