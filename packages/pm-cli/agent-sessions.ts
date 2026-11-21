import { z } from 'zod';
import {
  chatBodySchema, chatGenerationLifecycleSchema, chatQueueActionSchema, createThreadSchema, savedChatDraftSchema,
  storedMessageSchema, threadDeleteSchema, threadPatchSchema, threadSidebarActionSchema,
  type ChatGenerationLifecycle,
} from '../agent-contracts/src/chat.ts';
import { agentOutputFrameSchema, commandOutputFrameSchema, nativeInteractionResponseSchema } from '../agent-contracts/src/output.ts';
import { pmReferenceResolveRequestSchema, pmReferenceResolveResponseSchema } from '../agent-contracts/src/pm-references.ts';
import { connectAgent, AgentConnectionError, type AgentConnection, type AgentPmContext } from './agent-connection.ts';
import { inputFile, nonempty, parseOptions, type CliFamily, type CliRuntime } from './runtime.ts';

const resources: Readonly<Record<string, true>> = { folder: true, session: true, message: true, generation: true, approval: true };
const revisionSchema = z.number().int().nonnegative();
const identitySchema = z.string().min(1).max(256).refine(value => !/[\p{Cc}/\\%?#]/u.test(value) && value !== '.' && value !== '..', 'Use one original server identity, not a path.');
const operationIdentitySchema = z.strictObject({ idempotencyKey: z.string().min(1).max(200) });
const rewindSchema = z.strictObject({ messageId: identitySchema, expectedHeadId: z.string().nullable(), revision: revisionSchema, confirmed: z.literal(true), idempotencyKey: z.string().min(1).max(200) });
const steerSchema = z.strictObject({ generationId: identitySchema, idempotencyKey: z.string().min(1).max(200), text: z.string().trim().min(1).max(32000), confirmToolInterruption: z.boolean().optional() });
// Reuse the native admission schema, but never silently strip authority-shaped fields.
const sendSchema = chatBodySchema.strict().extend({
  idempotencyKey: z.string().min(1).max(256),
  config: chatBodySchema.shape.config.unwrap().strict().extend({ threadSettingsRevision: revisionSchema }),
});
const MAX_FRAME_CHARACTERS = 16 * 1024 * 1024;
const help = `  agent folder list | directories [--path SERVER_ABSOLUTE_PATH]
  agent folder register --path SERVER_ABSOLUTE_PATH [--name NAME]
  agent folder rename ID --revision N --name NAME
  agent folder close|reopen ID --revision N
  agent session list [--status regular|archived|all] | read|execution|actions ID
  agent session create --file CREATE.json
  agent session update ID --file PATCH.json
  agent session rename ID --revision N --title TITLE
  agent session archive|restore ID --lifecycle-revision N
  agent session delete ID --operation ORIGINAL_KEY --lifecycle-revision N --confirm true --generation ID|none --stop-active true|false
  agent session lifecycle-result ID ORIGINAL_KEY
  agent session pin|unpin|settle|unsettle|wake|mark-unread|visit ID --revision SIDEBAR_REVISION
  agent session snooze ID --revision SIDEBAR_REVISION --until ISO_TIMESTAMP
  agent session auto-settle ID --revision SIDEBAR_REVISION --enabled true|false
  agent session regenerate-title ID --revision N | restart-native ID
  agent session history ID [--limit N] [--before ORIGINAL_PAGE_CURSOR] [--format FORMAT]
  agent message list SESSION_ID [--limit N] [--before ORIGINAL_PAGE_CURSOR] [--format FORMAT]
  agent message save SESSION_ID --file STORED_MESSAGE.json
  agent message context SESSION_ID MESSAGE_ID
  agent message resolve-references --file REFERENCES.json
  agent message send SESSION_ID --file CHAT.json [--follow true|false] [--timeout-ms N] [--max-events N]
  agent message submission SESSION_ID ORIGINAL_KEY
  agent message queue|stash SESSION_ID
  agent message enqueue|stash-save SESSION_ID --file SAVED_DRAFT.json
  agent message queue-edit|queue-move|queue-remove|queue-send|queue-reconcile SESSION_ID DRAFT_ID --file ACTION.json
  agent message saved SESSION_ID queue|stash DRAFT_ID | stash-delete SESSION_ID DRAFT_ID
  agent message fork GENERATION_ID --file FORK.json | native-fork GENERATION_ID --file OPERATION.json
  agent message rewind SESSION_ID --file REWIND.json
  agent generation list|status SESSION_ID [--generation GENERATION_ID]
  agent generation lifecycle SESSION_ID --generation GENERATION_ID
  agent generation output GENERATION_ID [--follow true|false] [--after SEQUENCE] [--timeout-ms N] [--max-events N]
  agent generation command-output GENERATION_ID ITEM_ID [--follow true|false] [--timeout-ms N] [--max-events N]
  agent generation stream GENERATION_ID [--timeout-ms N] [--max-events N]
  agent generation stop SESSION_ID --generation GENERATION_ID [--message MESSAGE_ID]
  agent generation continue GENERATION_ID --confirm-side-effects true|false
  agent generation steer SESSION_ID --file STEER.json
  agent generation respond GENERATION_ID REQUEST_ID --file RESPONSE.json
  agent approval list|changes SESSION_ID | read|reconcile|approve|reject OPERATION_ID
  agent approval respond GENERATION_ID REQUEST_ID --file RESPONSE.json
  All commands accept --origin AGENT_SERVICE_URL. Unconfigured loopback needs no Agent login; configured access remains independent from PM login.
  Chat/history/output/approval commands accept --pm-context true to explicitly attach current native PM identity.
  Lifecycle reads and stop checks expose only original identities/status/timestamps, never content or PM authority.
  Pure Agent-only commands never require or automatically read PM credentials.
  JSON/YAML files use the existing native service schemas; no actor/grant/HTTP-path overrides.
  Send requires original id, message IDs, idempotencyKey and saved config.threadSettingsRevision.
  Output defaults to one snapshot; send/stream follow for at most 300000ms by default.
  Disconnect/SIGINT only detach streams, never stop execution or roll back committed PM writes.
  Unknown writes are not replayed; inspect their original identity before any further action.`;

type StreamKind = 'chat' | 'native' | 'command';
type StreamOptions = { kind: StreamKind; follow: boolean; timeoutMs: number; maxEvents?: number; generationId?: string };
type Operation = {
  route: string; method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown;
  headers?: Record<string, string>;
  stream?: StreamOptions; stop?: { threadId: string; generationId: string; messageId?: string };
  status?: string; generationId?: string;
  lifecycle?: { threadId: string; generationId: string };
};

function usage(resource: string): never { throw new Error(`Unknown or incomplete pm agent ${resource} command.\n${help}`); }
function id(value: string | undefined): string { return identitySchema.parse(nonempty(value, 'server ID')); }
function segment(value: string | undefined): string { return encodeURIComponent(id(value)); }
function integer(value: string | undefined, name: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${name} requires an integer from ${minimum} to ${maximum}`);
  return Number(value);
}
function boolean(value: string | undefined, name: string): boolean {
  if (value !== 'true' && value !== 'false') throw new Error(`${name} requires true or false`);
  return value === 'true';
}
function options(args: string[], allowed: readonly string[]): Record<string, string> {
  const parsed = parseOptions(args, ['origin', 'pm-context', ...allowed]);
  if (parsed['pm-context'] !== undefined) boolean(parsed['pm-context'], '--pm-context');
  return parsed;
}
async function file<T>(schema: z.ZodType<T>, value: string | undefined): Promise<T> { return schema.parse(await inputFile(value)); }
function threadRoute(value: string | undefined): string { return `/api/chat/threads/${segment(value)}`; }
function generationRoute(value: string | undefined): string { return `/api/chat/generations/${segment(value)}`; }
function lifecycleRoute(threadId: string, generationId: string): string { return `${threadRoute(threadId)}/generations/${segment(generationId)}/lifecycle`; }
async function readLifecycle(connection: AgentConnection, target: { threadId: string; generationId: string }, signal: AbortSignal, pmContext?: AgentPmContext): Promise<ChatGenerationLifecycle> {
  const { generation } = z.strictObject({ generation: chatGenerationLifecycleSchema }).parse(
    await connection.json(lifecycleRoute(target.threadId, target.generationId), { signal }, pmContext),
  );
  if (generation.id !== target.generationId || generation.threadId !== target.threadId)
    throw new AgentConnectionError('AGENT_GENERATION_MISMATCH', 'The lifecycle response does not match the original Session/generation; no replacement can be selected.', 409);
  return generation;
}
function streamOptions(kind: StreamKind, values: Record<string, string>, follow = false): StreamOptions {
  return { kind, follow: values.follow === undefined ? follow : boolean(values.follow, '--follow'),
    timeoutMs: values['timeout-ms'] === undefined ? 300_000 : integer(values['timeout-ms'], '--timeout-ms', 1, 86_400_000),
    ...(values['max-events'] === undefined ? {} : { maxEvents: integer(values['max-events'], '--max-events', 1, 1_000_000) }) };
}
function historyRoute(route: string, values: Record<string, string>): string {
  const query = new URLSearchParams();
  if (values.limit !== undefined) query.set('limit', String(integer(values.limit, '--limit', 1, 200)));
  if (values.before !== undefined) query.set('before', z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).parse(values.before));
  if (values.format !== undefined) query.set('format', nonempty(values.format, '--format'));
  return `${route}/history${query.size ? `?${query}` : ''}`;
}

async function prepare(resource: string, args: string[]): Promise<({ operation: Operation } | { references: z.infer<typeof pmReferenceResolveRequestSchema> }) & { origin?: string; pmContext?: boolean }> {
  const [action, first, second, ...rest] = args;
  let values: Record<string, string>, operation: Operation;
  const result = (value: Operation, parsed: Record<string, string>) => ({ operation: value, ...(parsed.origin === undefined ? {} : { origin: nonempty(parsed.origin, '--origin') }), ...(parsed['pm-context'] === undefined ? {} : { pmContext: boolean(parsed['pm-context'], '--pm-context') }) });
  if (resource === 'folder') {
    if (action === 'list' || action === 'directories' || action === 'register') {
      values = options(args.slice(1), action === 'list' ? [] : action === 'directories' ? ['path'] : ['path', 'name']);
      if (action === 'list') operation = { route: '/api/agent-workspaces' };
      else if (action === 'directories') operation = { route: `/api/agent-workspaces/directories${values.path === undefined ? '' : `?${new URLSearchParams({ path: nonempty(values.path, '--path') })}`}` };
      else operation = { route: '/api/agent-workspaces/open', method: 'POST', body: { path: nonempty(values.path, '--path'), ...(values.name === undefined ? {} : { name: nonempty(values.name, '--name') }) } };
      return result(operation, values);
    }
    if (action === 'rename' || action === 'close' || action === 'reopen') {
      values = options(args.slice(2), action === 'rename' ? ['revision', 'name'] : ['revision']);
      return result({ route: `/api/agent-workspaces/${segment(first)}`, method: 'PATCH', body: { expectedRevision: integer(values.revision, '--revision', 1), ...(action === 'rename' ? { name: nonempty(values.name, '--name') } : { archived: action === 'close' }) } }, values);
    }
    return usage(resource);
  }
  if (resource === 'session') {
    if (action === 'list') {
      values = options(args.slice(1), ['status']);
      const status = values.status === undefined ? 'all' : z.enum(['regular', 'archived', 'all']).parse(values.status);
      return result({ route: '/api/chat/threads', status }, values);
    }
    if (action === 'create') {
      values = options(args.slice(1), ['file']);
      return result({ route: '/api/chat/threads', method: 'POST', body: await file(createThreadSchema, values.file) }, values);
    }
    if (action === 'read' || action === 'execution' || action === 'actions' || action === 'history') {
      values = options(args.slice(2), action === 'history' ? ['limit', 'before', 'format'] : []);
      const route = threadRoute(first);
      return result({ route: action === 'read' ? route : action === 'history' ? historyRoute(route, values) : `${route}/${action}` }, values);
    }
    if (action === 'update') {
      values = options(args.slice(2), ['file']);
      const patch = await file(threadPatchSchema.extend({ settings: threadPatchSchema.shape.settings.unwrap().strict().optional(), revision: revisionSchema }).refine(value => Object.keys(value).some(key => key !== 'revision'), 'Specify a Session change.'), values.file);
      if (patch.status && patch.lifecycleRevision === undefined) throw new Error('Archive/restore requires lifecycleRevision in PATCH.json.');
      return result({ route: threadRoute(first), method: 'PUT', body: patch }, values);
    }
    if (action === 'rename' || action === 'archive' || action === 'restore') {
      values = options(args.slice(2), action === 'rename' ? ['revision', 'title'] : ['lifecycle-revision']);
      return result({ route: threadRoute(first), method: 'PUT', body: action === 'rename'
        ? { revision: integer(values.revision, '--revision'), title: nonempty(values.title, '--title') }
        : { lifecycleRevision: integer(values['lifecycle-revision'], '--lifecycle-revision'), status: action === 'archive' ? 'archived' : 'regular' } }, values);
    }
    if (action === 'delete') {
      values = options(args.slice(2), ['confirm', 'operation', 'lifecycle-revision', 'generation', 'stop-active']);
      if (!boolean(values.confirm, '--confirm')) throw new Error('Visible Session deletion requires --confirm true. Evidence/tombstones and existing backups may remain.');
      const generation = nonempty(values.generation, '--generation (use none when idle)');
      const body = threadDeleteSchema.parse({ lifecycleRevision: integer(values['lifecycle-revision'], '--lifecycle-revision'),
        confirm: true, expectedGenerationId: generation === 'none' ? null : id(generation), stopActive: boolean(values['stop-active'], '--stop-active') });
      return result({ route: threadRoute(first), method: 'DELETE', headers: { 'Idempotency-Key': id(values.operation) }, body }, values);
    }
    if (action === 'lifecycle-result') {
      values = options(rest, []);
      return result({ route: `${threadRoute(first)}/lifecycle-operations/${segment(second)}` }, values);
    }
    if (action === 'restart-native' || action === 'regenerate-title') {
      values = options(args.slice(2), action === 'regenerate-title' ? ['revision'] : []);
      return result({ route: `${threadRoute(first)}/${action === 'restart-native' ? 'native-session/restart' : action}`, method: 'POST', body: action === 'restart-native' ? {} : { revision: integer(values.revision, '--revision') } }, values);
    }
    if (action && ['pin', 'unpin', 'settle', 'unsettle', 'snooze', 'wake', 'auto-settle', 'mark-unread', 'visit'].includes(action)) {
      values = options(args.slice(2), ['revision', ...(action === 'snooze' ? ['until'] : action === 'auto-settle' ? ['enabled'] : [])]);
      const body = threadSidebarActionSchema.parse({ action, revision: integer(values.revision, '--revision'), ...(action === 'snooze' ? { snoozedUntil: nonempty(values.until, '--until') } : action === 'auto-settle' ? { enabled: boolean(values.enabled, '--enabled') } : {}) });
      return result({ route: `${threadRoute(first)}/sidebar`, method: 'POST', body }, values);
    }
    return usage(resource);
  }
  if (resource === 'message') {
    if (action === 'resolve-references') {
      values = options(args.slice(1), ['file']);
      return { references: await file(pmReferenceResolveRequestSchema, values.file), ...(values.origin === undefined ? {} : { origin: nonempty(values.origin, '--origin') }) };
    }
    if (action === 'list') {
      values = options(args.slice(2), ['limit', 'before', 'format']);
      return result({ route: historyRoute(threadRoute(first), values) }, values);
    }
    if (action === 'submission') {
      values = options(rest, []);
      return result({ route: `${threadRoute(first)}/submissions/${segment(second)}` }, values);
    }
    if (action === 'context') {
      values = options(rest, []);
      return result({ route: `${threadRoute(first)}/messages/${segment(second)}/context` }, values);
    }
    if (action === 'save') {
      values = options(args.slice(2), ['file']);
      // turnContext is strictly server-owned and cannot be created by a history write.
      return result({ route: `${threadRoute(first)}/history`, method: 'PUT', body: await file(storedMessageSchema.omit({ turnContext: true }).strict(), values.file) }, values);
    }
    if (action === 'send') {
      values = options(args.slice(2), ['file', 'follow', 'timeout-ms', 'max-events']);
      const body = await file(sendSchema, values.file);
      if (body.id !== id(first)) throw new Error('CHAT.json id must match the explicit Session ID. No replacement Session was selected.');
      return result({ route: '/api/chat', method: 'POST', body, stream: streamOptions('chat', values, true) }, values);
    }
    if (action === 'queue' || action === 'stash') {
      values = options(args.slice(2), []);
      return result({ route: `${threadRoute(first)}/${action}` }, values);
    }
    if (action === 'enqueue' || action === 'stash-save') {
      values = options(args.slice(2), ['file']);
      return result({ route: `${threadRoute(first)}/${action === 'enqueue' ? 'queue' : 'stash'}`, method: 'POST', body: await file(savedChatDraftSchema, values.file) }, values);
    }
    if (action === 'stash-delete') {
      values = options(rest, []);
      return result({ route: `${threadRoute(first)}/stash/${segment(second)}`, method: 'DELETE' }, values);
    }
    if (action === 'saved') {
      const kind = z.enum(['queue', 'stash']).parse(second), draftId = args[3];
      values = options(args.slice(4), []);
      return result({ route: `${threadRoute(first)}/saved-drafts/${kind}/${segment(draftId)}` }, values);
    }
    if (action && ['queue-edit', 'queue-move', 'queue-remove', 'queue-send', 'queue-reconcile'].includes(action)) {
      values = options(rest, ['file']);
      const body = await file(chatQueueActionSchema, values.file);
      if (body.action !== action.slice('queue-'.length)) throw new Error('Queue file action must match the explicit command.');
      return result({ route: `${threadRoute(first)}/queue/${segment(second)}`, method: 'POST', body }, values);
    }
    if (action === 'fork' || action === 'native-fork') {
      values = options(args.slice(2), ['file']);
      const body = await file(action === 'fork' ? operationIdentitySchema.extend({ title: z.string().max(200).optional() }) : operationIdentitySchema, values.file);
      return result({ route: `${generationRoute(first)}/${action}`, method: 'POST', body }, values);
    }
    if (action === 'rewind') {
      values = options(args.slice(2), ['file']);
      return result({ route: `${threadRoute(first)}/rewind`, method: 'POST', body: await file(rewindSchema, values.file) }, values);
    }
    return usage(resource);
  }
  if (resource === 'generation') {
    if (action === 'list' || action === 'status') {
      values = options(args.slice(2), ['generation']);
      return result({ route: `${threadRoute(first)}/generations`, ...(values.generation === undefined ? {} : { generationId: id(values.generation) }) }, values);
    }
    if (action === 'lifecycle') {
      values = options(args.slice(2), ['generation']);
      const target = { threadId: id(first), generationId: id(values.generation) };
      return result({ route: lifecycleRoute(target.threadId, target.generationId), lifecycle: target }, values);
    }
    if (action === 'output' || action === 'command-output' || action === 'stream') {
      values = options(action === 'command-output' ? rest : args.slice(2), ['timeout-ms', 'max-events', ...(action === 'stream' ? [] : ['follow']), ...(action === 'output' ? ['after'] : [])]);
      const route = action === 'stream' ? `/api/chat/streams/${segment(first)}` : `${generationRoute(first)}${action === 'command-output' ? `/items/${segment(second)}` : ''}/output`;
      return result({ route: `${route}${values.after === undefined ? '' : `?after=${integer(values.after, '--after')}`}`, stream: { ...streamOptions(action === 'stream' ? 'chat' : action === 'output' ? 'native' : 'command', values, action === 'stream'), generationId: id(first) } }, values);
    }
    if (action === 'stop') {
      values = options(args.slice(2), ['generation', 'message']);
      const threadId = id(first), generationId = id(values.generation);
      const message = values.message === undefined ? {} : { messageId: id(values.message) };
      return result({ route: `${threadRoute(threadId)}/cancel`, method: 'POST', body: { generationId, ...message }, stop: { threadId, generationId, ...message } }, values);
    }
    if (action === 'continue') {
      values = options(args.slice(2), ['confirm-side-effects']);
      return result({ route: `${generationRoute(first)}/continue`, method: 'POST', body: { confirmSideEffects: boolean(values['confirm-side-effects'], '--confirm-side-effects') } }, values);
    }
    if (action === 'steer') {
      values = options(args.slice(2), ['file']);
      return result({ route: `${threadRoute(first)}/steer`, method: 'POST', body: await file(steerSchema, values.file) }, values);
    }
    if (action !== 'respond') return usage(resource);
  }
  if (resource === 'approval') {
    if (action === 'list' || action === 'changes') {
      values = options(args.slice(2), []);
      return result({ route: `/api/pm-tools/threads/${segment(first)}/${action === 'list' ? 'calls' : 'changes'}` }, values);
    }
    if (action === 'read' || action === 'reconcile' || action === 'approve' || action === 'reject') {
      values = options(args.slice(2), []);
      const operationId = z.uuid().parse(first);
      return result({ route: `/api/pm-tools/calls/${operationId}${action === 'read' ? '' : `/${action}`}`, ...(action === 'read' ? {} : { method: 'POST' as const }) }, values);
    }
    if (action !== 'respond') return usage(resource);
  }
  if (action === 'respond' && (resource === 'generation' || resource === 'approval')) {
    values = options(rest, ['file']);
    return result({ route: `${generationRoute(first)}/requests/${segment(second)}/respond`, method: 'POST', body: await file(nativeInteractionResponseSchema, values.file) }, values);
  }
  return usage(resource);
}

function requestInit(operation: Operation, signal: AbortSignal): RequestInit {
  return { ...(operation.method === undefined ? {} : { method: operation.method }), signal,
    headers: { ...(operation.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...operation.headers },
    ...(operation.body === undefined ? {} : { body: JSON.stringify(operation.body) }) };
}

/** SSE is consumed exactly once. Reattachment is a separate read using the original generation ID. */
async function printStream(response: Response, stream: StreamOptions, runtime: CliRuntime, signal: AbortSignal): Promise<void> {
  if (!response.ok) { await response.body?.cancel(); throw new AgentConnectionError('AGENT_REQUEST_FAILED', `Agent request failed (HTTP ${response.status}); it was not retried.`, response.status); }
  const generationId = stream.generationId ?? response.headers.get('x-resumable-stream-id') ?? undefined;
  if (!generationId || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) {
    await response.body?.cancel();
    throw new AgentConnectionError('AGENT_PROTOCOL_INVALID', 'Agent did not return its original generation identity and SSE stream. An attempted send is unconfirmed; do not resend.');
  }
  runtime.print({ kind: 'stream-open', generationId, ...(response.headers.has('x-accepted-input-message-id') ? { inputMessageId: response.headers.get('x-accepted-input-message-id') } : {}), ...(response.headers.has('x-turn-trace-id') ? { traceId: response.headers.get('x-turn-trace-id') } : {}) });
  if (stream.kind === 'chat' && !stream.follow) {
    await response.body.cancel();
    runtime.print({ kind: 'stream-closed', generationId, reason: 'detached', generationStopped: false });
    return;
  }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', events = 0, detach = false, done = false;
  const emit = (block: string): void => {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    if (data === '[DONE]') { done = true; return; }
    let value: unknown;
    try { value = JSON.parse(data); } catch { throw new AgentConnectionError('AGENT_PROTOCOL_INVALID', 'Agent stream contains an invalid JSON frame. No write was replayed.'); }
    const frame = stream.kind === 'native' ? agentOutputFrameSchema.parse(value) : stream.kind === 'command' ? commandOutputFrameSchema.parse(value) : value;
    if (stream.kind === 'native') {
      const native = frame as z.infer<typeof agentOutputFrameSchema>;
      if ((native.kind === 'snapshot' ? native.snapshot.generationId : native.generationId) !== generationId) throw new AgentConnectionError('AGENT_PROTOCOL_INVALID', 'Output identity changed; the stream was detached.');
    }
    runtime.print({ kind: stream.kind, generationId, event: frame });
    events++;
    if (!stream.follow || stream.maxEvents !== undefined && events >= stream.maxEvents) detach = true;
  };
  try {
    while (!detach && !done) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        if (buffer.trim()) throw new AgentConnectionError('AGENT_STREAM_INTERRUPTED', 'Agent stream ended with an incomplete frame; inspect the original generation, not a new send.');
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      // Normalize CRLF only after a complete line is available (CR/LF can cross network chunks).
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary: number;
      while (!detach && !done && (boundary = buffer.indexOf('\n\n')) !== -1) {
        if (boundary > MAX_FRAME_CHARACTERS) throw new AgentConnectionError('AGENT_STREAM_TOO_LARGE', 'Agent stream frame exceeds the safe output limit; it was detached, not stopped.');
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); emit(block);
      }
      if (buffer.length > MAX_FRAME_CHARACTERS) throw new AgentConnectionError('AGENT_STREAM_TOO_LARGE', 'Agent stream frame exceeds the safe output limit; it was detached, not stopped.');
    }
    runtime.print({ kind: 'stream-closed', generationId, reason: detach ? 'detached' : done ? 'protocol-done' : 'eof', generationStopped: false });
  } catch (error) {
    if (signal.aborted) throw new AgentConnectionError('AGENT_STREAM_DETACHED', `Stream detached from ${generationId}; execution was not stopped. Inspect the original generation before any action.`);
    throw error;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export const agentSessionsFamily: CliFamily = {
  help,
  async dispatch(args, runtime) {
    if (args[0] !== 'agent' || resources[args[1] ?? ''] !== true) return false;
    const prepared = await prepare(args[1]!, args.slice(2));
    const abort = new AbortController();
    const onInterrupt = () => abort.abort();
    process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt);
    let connection: AgentConnection | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      connection = await connectAgent({ ...(prepared.origin === undefined ? {} : { origin: prepared.origin }), signal: abort.signal });
      if ('references' in prepared) {
        const selected = await runtime.connection();
        if (prepared.references.references.some(reference => reference.workspaceId !== selected.workspaceId)) throw new Error('References must match the explicitly selected PM_WORKSPACE_ID. Resolve each workspace separately.');
        runtime.print(pmReferenceResolveResponseSchema.parse(await runtime.json('workspace', '/agent-references/resolve', { method: 'POST', body: prepared.references, signal: abort.signal })));
        return true;
      }
      const operation = prepared.operation;
      let pmContext: AgentPmContext | undefined;
      if (prepared.pmContext) {
        if (args[1] === 'folder') throw new Error('Folder operations use Agent service access only; omit --pm-context.');
        const pm = await runtime.authentication();
        pmContext = { origin: pm.origin, headers: pm.headers };
      }
      if (operation.stream) {
        timer = setTimeout(() => abort.abort(), operation.stream.timeoutMs); timer.unref();
        await printStream(await connection.request(operation.route, requestInit(operation, abort.signal), pmContext), operation.stream, runtime, abort.signal);
      } else {
        if (operation.stop) {
          const target = operation.stop;
          const generation = await readLifecycle(connection, target, abort.signal, pmContext);
          if (!['queued', 'running'].includes(generation.status) ||
              target.messageId !== undefined && generation.inputMessageId !== target.messageId) {
            throw new AgentConnectionError('AGENT_STALE_GENERATION', 'The original generation/input is not currently active in this Session; no stop request was sent.', 409);
          }
          // The native cancel service still checks the exact generation after this read.
        }
        const value: unknown = operation.lifecycle
          ? { generation: await readLifecycle(connection, operation.lifecycle, abort.signal, pmContext) }
          : await connection.json(operation.route, requestInit(operation, abort.signal), pmContext);
        if (operation.stop) {
          const target = operation.stop;
          const generation = await readLifecycle(connection, target, abort.signal, pmContext);
          if (target.messageId !== undefined && generation.inputMessageId !== target.messageId)
            throw new AgentConnectionError('AGENT_STOP_UNCONFIRMED', 'Stop returned but the original input identity changed; do not infer cancellation or repeat it.', 409);
          const status = generation.status === 'cancelled' ? 'cancelled' : ['queued', 'running'].includes(generation.status) ? 'unconfirmed' : 'not_cancelled';
          runtime.print({ stop: { generationId: generation.id, status }, generation, effects: 'Committed PM operations, files and terminal effects are not rolled back.' });
        } else if (operation.generationId) {
          const payload = z.object({ generations: z.array(z.object({ id: z.string() }).loose()) }).parse(value);
          const generation = payload.generations.find(entry => entry.id === operation.generationId);
          if (!generation) throw new AgentConnectionError('AGENT_GENERATION_NOT_FOUND', 'The original generation is not in this Session.', 404);
          runtime.print({ generation });
        } else if (operation.status && operation.status !== 'all') {
          const payload = z.object({ threads: z.array(z.object({ status: z.string() }).loose()) }).parse(value);
          runtime.print({ threads: payload.threads.filter(thread => thread.status === operation.status) });
        } else runtime.print(value);
      }
      return true;
    } finally {
      clearTimeout(timer); connection?.close();
      process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt);
    }
  },
};
