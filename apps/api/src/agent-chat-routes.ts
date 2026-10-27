/// <reference lib="es2024.promise" />
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, type Actor } from '../../../packages/domain/src/core.ts';
import { getMembership } from '../../../packages/application/src/access.ts';
import type { AgentChatAccessService } from '../../../packages/application/src/agent-chat-access.ts';
import type { AgentChatRuntime } from './agent-chat-runtime.ts';
import type { AgentChatConfiguration } from '../../../packages/infrastructure/src/agent-chat-config.ts';
import { agentChatReasoningEffortSchema, type AgentChatMessage, type AgentChatThread, type AgentChatThreadDetail, type AgentChatStatus } from '../../../packages/contracts/src/agent-chat.ts';
import { AgentModelError, assertAgentModelReasoning, getAgentModelReasoning, streamAgentModel, type AgentModelMessage } from './agent-chat-model.ts';

type ThreadRow = {
  id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
  last_message_at: Date | null;
  message_count: number;
};
type MessageRow = {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant';
  content: string;
  status: AgentChatMessage['status'];
  error_code: string | null;
  model: string | null;
  created_at: Date;
  updated_at: Date;
  context_sources?: AgentChatMessage['contextSources'];
};
type ActiveStream = {
  messageId: string;
  controller: AbortController;
  cancelled: boolean;
  finished: Promise<AgentChatMessage | null>;
};
type ChatStream = {
  readonly closed: boolean;
  send(event: string, data: unknown): void;
  end(): void;
};

const uuid = z.uuid().toLowerCase();
const threadSelect = `SELECT t.id,t.title,t.created_at,t.updated_at,
  (SELECT max(m.updated_at) FROM agent_chat_messages m WHERE m.thread_id=t.id) AS last_message_at,
  (SELECT count(*)::int FROM agent_chat_messages m WHERE m.thread_id=t.id) AS message_count
  FROM agent_chat_threads t`;

function threadFromRow(row: ThreadRow): AgentChatThread {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastMessageAt: row.last_message_at?.toISOString() ?? null,
    messageCount: row.message_count,
  };
}
function messageFromRow(row: MessageRow): AgentChatMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    status: row.status,
    errorCode: row.error_code,
    model: row.model,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    contextSources: row.context_sources ?? [],
  };
}
function messageConfigError(code: string): string {
  if (code === 'model_auth_failed') return 'The configured model API rejected its credentials.';
  if (code === 'model_rate_limited') return 'The model API is rate limited. Try again later.';
  if (code === 'model_timeout') return 'The model API did not respond before the idle deadline.';
  if (code === 'model_unreachable') return 'The configured model API could not be reached.';
  if (code === 'model_stream_incomplete') return 'The model stream ended before a complete response.';
  if (code === 'model_request_rejected') return 'The model API rejected the request.';
  return 'The model API could not complete this reply.';
}
function clientErrorMessage(error: unknown): string {
  if (error instanceof AgentModelError) return messageConfigError(error.code);
  if (error instanceof DomainError) return error.message;
  return 'The model API could not complete this reply.';
}
function sse(reply: FastifyReply): ChatStream {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.flushHeaders();
  let closed = false;
  reply.raw.on('close', () => { closed = true; });
  return {
    get closed() { return closed; },
    send(event: string, data: unknown) {
      if (closed) return;
      try { reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
      catch { closed = true; }
    },
    end() { if (!closed) reply.raw.end(); },
  };
}

export function registerAgentChatRoutes(app: FastifyInstance, options: {
  database: () => Pool;
  actor: (request: FastifyRequest) => Promise<Actor>;
  config: AgentChatConfiguration | null;
  access?: AgentChatAccessService;
  runtime?: AgentChatRuntime;
}): void {
  const activeStreams = new Map<string, ActiveStream>();
  app.addHook('onClose', async () => {
    const entries = [...activeStreams.values()];
    for (const entry of entries) { entry.cancelled = true; entry.controller.abort(); }
    await Promise.all(entries.map(entry => entry.finished));
  });
  app.addHook('onReady', async () => {
    try {
      // A new API process cannot own a stream started by the previous process.
      // Keep partial text and require an explicit resend instead of pretending
      // the interrupted reply completed.
      await options.database().query("UPDATE agent_chat_messages SET status='interrupted',error_code='interrupted',updated_at=clock_timestamp() WHERE status='streaming'");
      await options.database().query("UPDATE agent_chat_tool_calls SET call=jsonb_set(call,'{status}',to_jsonb('unknown'::text)),updated_at=clock_timestamp() WHERE call->>'status'='running'");
    } catch {
      app.log.error({ code: 'agent_chat_recovery_unavailable' }, 'Agent chat recovery could not run');
    }
  });

  async function scope(request: FastifyRequest): Promise<{ workspaceId: string; actor: Actor }> {
    const { workspaceId } = z.strictObject({ workspaceId: uuid, threadId: uuid.optional() }).parse(request.params);
    const actor = await options.actor(request);
    const member = await getMembership(options.database(), actor, workspaceId);
    if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
    return { workspaceId, actor };
  }
  async function thread(request: FastifyRequest, workspaceId: string, actor: Actor, pool: Pool) {
    const { threadId } = z.strictObject({ workspaceId: uuid, threadId: uuid }).parse(request.params);
    const found = await pool.query<ThreadRow>(`${threadSelect} WHERE t.id=$1 AND t.workspace_id=$2 AND t.actor_id=$3`, [threadId, workspaceId, actor.id]);
    if (!found.rows[0]) throw new DomainError('not_found_or_forbidden', 'Conversation is not accessible', 404);
    return { threadId, thread: threadFromRow(found.rows[0]) };
  }

  app.get<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId/agent/status', async (request, reply) => {
    await scope(request);
    reply.header('Cache-Control', 'no-store');
    return { enabled: options.config !== null, provider: 'openai-compatible', model: options.config?.model ?? null, reasoning: getAgentModelReasoning(options.config) } satisfies AgentChatStatus;
  });

  app.get('/api/v1/workspaces/:workspaceId/agent/threads/:threadId/access', async (request, reply) => {
    const { workspaceId, actor } = await scope(request);
    const current = await thread(request, workspaceId, actor, options.database());
    if (!options.access) throw new DomainError('agent_tools_unavailable', 'Workspace tools are unavailable', 503);
    reply.header('Cache-Control', 'no-store');
    return options.access.read(actor, workspaceId, current.threadId);
  });
  app.put('/api/v1/workspaces/:workspaceId/agent/threads/:threadId/access', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const { workspaceId, actor } = await scope(request);
    const current = await thread(request, workspaceId, actor, options.database());
    if (!options.access) throw new DomainError('agent_tools_unavailable', 'Workspace tools are unavailable', 503);
    const access = await options.access.set(actor, workspaceId, current.threadId, request.body);
    const entry = activeStreams.get(current.threadId);
    if (entry) { entry.cancelled = true; entry.controller.abort(); }
    reply.header('Cache-Control', 'no-store');
    return access;
  });

  app.get<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId/agent/threads', async (request, reply) => {
    const { workspaceId, actor } = await scope(request);
    reply.header('Cache-Control', 'no-store');
    const result = await options.database().query<ThreadRow>(`${threadSelect} WHERE t.workspace_id=$1 AND t.actor_id=$2 ORDER BY t.updated_at DESC,t.id DESC LIMIT 100`, [workspaceId, actor.id]);
    return { items: result.rows.map(threadFromRow) };
  });

  app.post<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId/agent/threads', { bodyLimit: 4096 }, async (request, reply) => {
    const { workspaceId, actor } = await scope(request);
    const body = z.strictObject({ id: uuid, title: z.string().trim().min(1).max(200).optional() }).parse(request.body);
    const pool = options.database();
    await pool.query(`INSERT INTO agent_chat_threads(id,workspace_id,actor_id,title) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`, [body.id, workspaceId, actor.id, body.title ?? 'New chat']);
    const found = await pool.query<ThreadRow>(`${threadSelect} WHERE t.id=$1 AND t.workspace_id=$2 AND t.actor_id=$3`, [body.id, workspaceId, actor.id]);
    if (!found.rows[0]) throw new DomainError('thread_id_conflict', 'Conversation ID belongs to another request', 409);
    reply.header('Cache-Control', 'no-store').code(200);
    return { thread: threadFromRow(found.rows[0]) };
  });

  app.get<{ Params: { workspaceId: string; threadId: string } }>('/api/v1/workspaces/:workspaceId/agent/threads/:threadId', async (request, reply) => {
    const { workspaceId, actor } = await scope(request);
    const pool = options.database();
    const current = await thread(request, workspaceId, actor, pool);
    if (!activeStreams.has(current.threadId)) {
      await pool.query("UPDATE agent_chat_messages m SET status='interrupted',error_code='interrupted',updated_at=clock_timestamp() FROM agent_chat_threads t WHERE m.thread_id=t.id AND t.id=$1 AND t.workspace_id=$2 AND t.actor_id=$3 AND m.status='streaming' AND m.updated_at < clock_timestamp()-interval '2 minutes'", [current.threadId, workspaceId, actor.id]);
    }
    const messages = await pool.query<MessageRow>('SELECT id,thread_id,role,content,status,error_code,model,created_at,updated_at,context_sources FROM agent_chat_messages WHERE thread_id=$1 ORDER BY seq', [current.threadId]);
    reply.header('Cache-Control', 'no-store');
    const hydrated = options.runtime ? await options.runtime.hydrate({ actor, workspaceId, threadId: current.threadId }, messages.rows.map(messageFromRow), !activeStreams.has(current.threadId)) : messages.rows.map(messageFromRow);
    return { thread: current.thread, messages: hydrated } satisfies AgentChatThreadDetail;
  });

  app.delete<{ Params: { workspaceId: string; threadId: string } }>('/api/v1/workspaces/:workspaceId/agent/threads/:threadId', async (request) => {
    const { workspaceId, actor } = await scope(request);
    const pool = options.database();
    const current = await thread(request, workspaceId, actor, pool);
    const entry = activeStreams.get(current.threadId);
    if (entry) {
      entry.cancelled = true;
      entry.controller.abort();
      await entry.finished;
    }
    await pool.query('DELETE FROM agent_chat_threads WHERE id=$1 AND workspace_id=$2 AND actor_id=$3', [current.threadId, workspaceId, actor.id]);
    return { deleted: true as const };
  });

  app.post<{ Params: { workspaceId: string; threadId: string } }>('/api/v1/workspaces/:workspaceId/agent/threads/:threadId/cancel', { bodyLimit: 2048 }, async (request) => {
    const { workspaceId, actor } = await scope(request);
    const body = z.strictObject({ messageId: uuid.optional() }).parse(request.body ?? {});
    const pool = options.database();
    const current = await thread(request, workspaceId, actor, pool);
    const entry = activeStreams.get(current.threadId);
    if (!entry || (body.messageId && entry.messageId !== body.messageId)) return { cancelled: false };
    entry.cancelled = true;
    entry.controller.abort();
    const final = await entry.finished;
    if (!final) throw new DomainError('agent_chat_persistence_failed', 'The reply could not be saved. Reload the conversation to check its status.', 503);
    return { cancelled: final.status === 'cancelled' };
  });

  app.post<{ Params: { workspaceId: string; threadId: string } }>('/api/v1/workspaces/:workspaceId/agent/threads/:threadId/messages', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const { workspaceId, actor } = await scope(request);
    const config = options.config;
    if (!config) throw new DomainError('agent_model_not_configured', 'Agent chat model is not configured', 503);
    const chatConfig = config;
    const body = z.strictObject({ messageId: uuid, content: z.string().max(16000).refine(value => value.trim().length > 0, 'Message must not be empty'), reasoningEffort: agentChatReasoningEffortSchema.default('auto') }).parse(request.body);
    assertAgentModelReasoning(config, body.reasoningEffort);
    const pool = options.database();
    const current = await thread(request, workspaceId, actor, pool);
    if (activeStreams.has(current.threadId)) throw new DomainError('chat_busy', 'A reply is already being generated for this conversation', 409);
    if (options.runtime && options.access && (await options.access.read(actor, workspaceId, current.threadId)).enabled) {
      await options.runtime.hydrate({ actor, workspaceId, threadId: current.threadId }, [], true);
      await options.runtime.assertSettled(current.threadId);
    }

    async function prepare() {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query<{ id: string }>('SELECT id FROM agent_chat_threads WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 FOR UPDATE', [current.threadId, workspaceId, actor.id]);
        if (!locked.rows[0]) throw new DomainError('not_found_or_forbidden', 'Conversation is not accessible', 404);
        const count = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM agent_chat_messages WHERE thread_id=$1', [current.threadId]);
        const assistantId = randomUUID();
        const insertedUser = await client.query<MessageRow>('INSERT INTO agent_chat_messages(id,thread_id,role,content,status) VALUES($1,$2,\'user\',$3,\'complete\') RETURNING id,thread_id,role,content,status,error_code,model,created_at,updated_at', [body.messageId, current.threadId, body.content.trim()]);
        const userMessage = messageFromRow(insertedUser.rows[0]!);
        if ((count.rows[0]?.count ?? 0) === 0) {
          const title = body.content.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat';
          await client.query('UPDATE agent_chat_threads SET title=$2,updated_at=clock_timestamp() WHERE id=$1', [current.threadId, title]);
        }
        const insertedAssistant = await client.query<MessageRow>('INSERT INTO agent_chat_messages(id,thread_id,role,content,status,model) VALUES($1,$2,\'assistant\',\'\',\'streaming\',$3) RETURNING id,thread_id,role,content,status,error_code,model,created_at,updated_at', [assistantId, current.threadId, chatConfig.model]);
        const assistantMessage = messageFromRow(insertedAssistant.rows[0]!);
        await client.query('UPDATE agent_chat_threads SET updated_at=clock_timestamp() WHERE id=$1', [current.threadId]);
        const prior = await client.query<MessageRow>(`SELECT id,thread_id,role,content,status,error_code,model,created_at,updated_at,context_sources FROM agent_chat_messages
          WHERE thread_id=$1 AND seq < (SELECT seq FROM agent_chat_messages WHERE id=$2)
            AND (role='user' OR status='complete')
          ORDER BY seq DESC LIMIT $3`, [current.threadId, assistantId, chatConfig.historyLimit]);
        const history = prior.rows.reverse().map(messageFromRow);
        await client.query('COMMIT');
        return { assistantId, userMessage, assistantMessage, history };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        const constraint = typeof error === 'object' && error !== null && 'constraint' in error && typeof error.constraint === 'string' ? error.constraint : undefined;
        if (constraint === 'agent_chat_messages_pkey') throw new DomainError('message_already_exists', 'This message ID was already submitted', 409);
        if (constraint === 'agent_chat_messages_one_streaming_idx') throw new DomainError('chat_busy', 'A reply is already being generated for this conversation', 409);
        throw error;
      } finally {
        client.release();
      }
    }
    const { assistantId, userMessage, assistantMessage, history } = await prepare();

    // Resolve, never reject: streams without a cancel waiter must not create
    // unhandled rejections, and every exit must release any waiting cancel.
    const { promise: finished, resolve: finish } = Promise.withResolvers<AgentChatMessage | null>();
    const entry: ActiveStream = { messageId: assistantId, controller: new AbortController(), cancelled: false, finished };
    activeStreams.set(current.threadId, entry);
    let stream: ChatStream | undefined;
    let keepalive: NodeJS.Timeout | undefined;
    let finalMessage: AgentChatMessage | null = null;
    let content = '';
    let persistedLength = 0;
    let persistedAt = 0;
    try {
      stream = sse(reply);
      keepalive = setInterval(() => {
        if (stream?.closed) return;
        try { reply.raw.write(': keepalive\n\n'); } catch { /* Generation still persists its result. */ }
      }, 15_000);
      stream.send('user', { message: userMessage });
      stream.send('assistant', { message: assistantMessage });
      let generationError: unknown;
      let status: AgentChatMessage['status'] = 'complete';
      let code: string | null = null;
      try {
        const delta = async (text: string) => {
          if (content.length + text.length > 200000) throw new DomainError('agent_response_too_large', 'The reply reached its size limit', 409);
          content += text;
          stream!.send('delta', { messageId: assistantId, delta: text });
          if (content.length - persistedLength >= 2048 || Date.now() - persistedAt >= 750) {
            await pool.query("UPDATE agent_chat_messages SET content=$2,updated_at=clock_timestamp() WHERE id=$1 AND status='streaming'", [assistantId, content]);
            persistedLength = content.length;
            persistedAt = Date.now();
          }
        };
        if (options.runtime) {
          const principal = { actor, workspaceId, threadId: current.threadId };
          await options.runtime.run({ ...principal, messageId: assistantId, config, reasoningEffort: body.reasoningEffort, history: await options.runtime.hydrate(principal, history, false), signal: entry.controller.signal, emit: (event, value) => stream!.send(event, value), delta });
        } else {
          const messages: AgentModelMessage[] = [{ role: 'system', content: config.systemPrompt }, ...history.map(message => ({ role: message.role, content: message.content }))];
          for await (const event of streamAgentModel(config, messages, entry.controller.signal, [], body.reasoningEffort)) if (event.delta) await delta(event.delta);
        }
        if (entry.cancelled) status = 'cancelled';
      } catch (error) {
        generationError = error;
        status = entry.cancelled ? 'cancelled' : 'error';
        code = entry.cancelled ? null : error instanceof AgentModelError || error instanceof DomainError ? error.code : 'model_unavailable';
      }
      // This handler alone writes the terminal content/status. Once this write
      // starts, a racing cancel reports its actual outcome rather than rewriting it.
      const final = await pool.query<MessageRow>("UPDATE agent_chat_messages SET content=$2,status=$3,error_code=$4,updated_at=clock_timestamp() WHERE id=$1 AND status='streaming' RETURNING id,thread_id,role,content,status,error_code,model,created_at,updated_at,context_sources", [assistantId, content, status, code]);
      if (!final.rows[0]) throw new Error('Reply finalization did not update a message');
      finalMessage = messageFromRow(final.rows[0]);
      if (options.runtime) finalMessage = (await options.runtime.hydrate({ actor, workspaceId, threadId: current.threadId }, [finalMessage], false))[0]!;
      await pool.query('UPDATE agent_chat_threads SET updated_at=clock_timestamp() WHERE id=$1', [current.threadId]).catch(() => undefined);
      if (finalMessage.status === 'complete') stream.send('done', { message: finalMessage });
      else if (finalMessage.status === 'cancelled') stream.send('cancelled', { message: finalMessage });
      else stream.send('error', { messageId: assistantId, code: code ?? 'model_unavailable', message: clientErrorMessage(generationError) });
    } catch {
      stream?.send('error', { messageId: assistantId, code: 'agent_chat_persistence_failed', message: 'The reply could not be saved. Reload the conversation to check its status.' });
    } finally {
      clearInterval(keepalive);
      if (activeStreams.get(current.threadId) === entry) activeStreams.delete(current.threadId);
      finish(finalMessage);
      stream?.end();
    }
  });
}
