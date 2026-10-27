import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { AgentModelError, assertAgentModelReasoning, getAgentModelReasoning, streamAgentModel, type AgentModelEvent, type AgentModelMessage } from '../src/agent-chat-model.ts';
import { readAgentChatConfig } from '../../../packages/infrastructure/src/agent-chat-config.ts';
import { DomainError } from '../../../packages/domain/src/core.ts';
import type { AgentChatReasoningEffort } from '../../../packages/contracts/src/agent-chat.ts';

test('agent chat configuration is disabled when unset and fails closed when partial', () => {
  assert.equal(readAgentChatConfig({}), null);
  assert.throws(() => readAgentChatConfig({ AGENT_CHAT_BASE_URL: 'https://example.test/v1' }), /configured together/);
  const config = readAgentChatConfig({ AGENT_CHAT_BASE_URL: 'https://example.test/v1/', AGENT_CHAT_API_KEY: 'secret', AGENT_CHAT_MODEL: 'model' });
  assert.equal(config?.baseUrl, 'https://example.test/v1');
});

test('OpenAI-compatible streams preserve deltas, usage and terminal state', async (t) => {
  const requests: { url: string | undefined; authorization: string | undefined; body: Record<string, unknown> }[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) as Record<string, unknown> });
      if (request.url === '/v1/bad/chat/completions') {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'invalid key' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`);
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  const { promise: listening, resolve } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', resolve);
  await listening;
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const config = { baseUrl, apiKey: 'secret', model: 'test-model', systemPrompt: 'system', historyLimit: 40 };

  const events = [];
  for await (const event of streamAgentModel(config, [{ role: 'system', content: 'system' }, { role: 'user', content: 'hi' }], new AbortController().signal)) events.push(event);
  assert.deepEqual(events.filter(event => event.delta).map(event => event.delta), ['Hello ', 'world']);
  assert.deepEqual(events.find(event => event.usage)?.usage, { promptTokens: 3, completionTokens: 2 });
  assert.equal(requests[0]?.url, '/v1/chat/completions');
  assert.equal(requests[0]?.authorization, 'Bearer secret');

  await assert.rejects(async () => {
    for await (const _event of streamAgentModel({ ...config, baseUrl: `${baseUrl}/bad` }, [{ role: 'user', content: 'hi' }], new AbortController().signal)) { /* provider error */ }
  }, (error: unknown) => error instanceof AgentModelError && error.code === 'model_auth_failed');
});

test('fragmented tool-only completions execute only after complete argument and terminal frames', async t => {
  const server = http.createServer((request, response) => {
    const incomplete = request.url?.startsWith('/incomplete');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_read', type: 'function', function: { name: 'pm_read', arguments: '{"id":' } }] } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"TASK-1"}' } }] }, finish_reason: incomplete ? 'length' : 'tool_calls' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config = { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: '', model: 'tools', systemPrompt: '', historyLimit: 10 };
  const tools = [{ type: 'function' as const, function: { name: 'pm_read', description: 'Read', parameters: { type: 'object' } } }];
  const events = [];
  for await (const event of streamAgentModel(config, [{ role: 'user', content: 'Read my task' }], new AbortController().signal, tools)) events.push(event);
  assert.deepEqual(events, [{ toolCalls: [{ id: 'call_read', type: 'function', function: { name: 'pm_read', arguments: '{"id":"TASK-1"}' } }] }]);
  const unsafe: AgentModelEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of streamAgentModel({ ...config, baseUrl: `${config.baseUrl}/incomplete` }, [{ role: 'user', content: 'Read my task' }], new AbortController().signal, tools)) unsafe.push(event);
  }, error => error instanceof AgentModelError && error.code === 'model_tool_calls_incomplete');
  assert.equal(unsafe.some(event => event.toolCalls), false);
});

test('a JSON tool-only completion is accepted but malformed arguments never become tools', async t => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
      { id: 'call_json', type: 'function', function: { name: 'pm_read', arguments: request.url?.startsWith('/invalid') ? '{"id":' : '{"id":"TASK-1"}' } },
    ] } }] }));
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config = { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: '', model: 'tools', systemPrompt: '', historyLimit: 10 };
  const tools = [{ type: 'function' as const, function: { name: 'pm_read', description: 'Read', parameters: { type: 'object' } } }];
  const events = [];
  for await (const event of streamAgentModel(config, [{ role: 'user', content: 'Read' }], new AbortController().signal, tools)) events.push(event);
  assert.equal(events[0]?.toolCalls?.[0]?.function.name, 'pm_read');
  await assert.rejects(async () => {
    for await (const _event of streamAgentModel({ ...config, baseUrl: `${config.baseUrl}/invalid` }, [{ role: 'user', content: 'Read' }], new AbortController().signal, tools)) { /* Reject the partial call. */ }
  }, error => error instanceof AgentModelError && error.code === 'model_tool_calls_incomplete');
});

test('reasoning capabilities are bounded by documented provider origin, model and effective levels', () => {
  const config = { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-flash', systemPrompt: '', historyLimit: 10 };
  for (const model of ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    assert.deepEqual(getAgentModelReasoning({ ...config, model }), { supported: true, efforts: ['auto', 'none', 'low', 'high', 'max'], defaultEffort: 'auto' });
  }
  for (const model of ['deepseek-chat', 'deepseek-reasoner', 'deepseek-r1', 'future-model']) {
    assert.deepEqual(getAgentModelReasoning({ ...config, model }), { supported: false, efforts: ['auto'], defaultEffort: 'auto' });
  }
  for (const baseUrl of ['https://proxy.example/v1', 'https://api.deepseek.com.evil.test', 'http://api.deepseek.com', 'https://api.deepseek.com/custom-proxy']) {
    assert.equal(getAgentModelReasoning({ ...config, baseUrl }).supported, false);
  }
  const openai = { ...config, baseUrl: 'https://api.openai.com/v1' };
  const cases: [string, AgentChatReasoningEffort[]][] = [
    ['o3-mini', ['auto', 'low', 'medium', 'high']],
    ['o4-mini-2025-04-16', ['auto', 'low', 'medium', 'high']],
    ['gpt-5-mini', ['auto', 'minimal', 'low', 'medium', 'high']],
    ['gpt-5.1', ['auto', 'none', 'low', 'medium', 'high']],
    ['gpt-5.2-2025-12-11', ['auto', 'none', 'low', 'medium', 'high', 'xhigh']],
    ['gpt-5.4', ['auto', 'none', 'low', 'medium', 'high', 'xhigh']],
  ];
  for (const [model, efforts] of cases) assert.deepEqual(getAgentModelReasoning({ ...openai, model }).efforts, efforts);
  for (const model of ['gpt-4o', 'gpt-5-chat-latest', 'gpt-5.2-pro', 'gpt-5.99', 'o1-mini', 'o1-preview']) {
    assert.equal(getAgentModelReasoning({ ...openai, model }).supported, false);
  }
  assert.deepEqual(getAgentModelReasoning(null), { supported: false, efforts: ['auto'], defaultEffort: 'auto' });
  assert.throws(() => assertAgentModelReasoning(config, 'medium'), error => error instanceof DomainError && error.code === 'agent_reasoning_unsupported' && error.status === 400);
});

test('selected DeepSeek and OpenAI effort changes actual request fields; auto sends no override', async t => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Visible answer', reasoning_content: 'Never display this' } }] }), { headers: { 'content-type': 'application/json' } });
  });
  const config = { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-flash', systemPrompt: '', historyLimit: 10 };
  const cases: [typeof config, AgentChatReasoningEffort, Record<string, unknown>][] = [
    [config, 'auto', {}], [config, 'none', { thinking: { type: 'disabled' } }],
    [config, 'low', { thinking: { type: 'enabled' }, reasoning_effort: 'low' }],
    [config, 'max', { thinking: { type: 'enabled' }, reasoning_effort: 'max' }],
    [{ ...config, baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.2' }, 'xhigh', { reasoning_effort: 'xhigh' }],
    [{ ...config, baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.1' }, 'none', { reasoning_effort: 'none' }],
  ];
  for (const [configured, effort, parameters] of cases) {
    const events = [];
    for await (const event of streamAgentModel(configured, [{ role: 'user', content: 'Hello' }], new AbortController().signal, [], effort)) events.push(event);
    assert.deepEqual(events, [{ delta: 'Visible answer' }], 'Private reasoning is never returned as text');
    const { model, messages, stream, ...actual } = bodies.at(-1)!;
    assert.equal(model, configured.model); assert.deepEqual(messages, [{ role: 'user', content: 'Hello' }]); assert.equal(stream, true);
    assert.deepEqual(actual, parameters);
  }
  const count = bodies.length;
  await assert.rejects(async () => {
    for await (const _event of streamAgentModel({ ...config, baseUrl: 'https://unknown.example/v1' }, [{ role: 'user', content: 'Hello' }], new AbortController().signal, [], 'high')) { /* No request is allowed. */ }
  }, error => error instanceof AgentModelError && error.code === 'model_request_rejected');
  assert.equal(bodies.length, count);
});

test('SSE and JSON reasoning survives tool continuation without manufacturing missing historical thoughts', async t => {
  const bodies: { messages: AgentModelMessage[]; thinking?: unknown; reasoning_effort?: string }[] = [];
  let round = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as typeof bodies[number]);
    round++;
    const call = { id: `read_${round}`, type: 'function', function: { name: 'pm_read', arguments: '{}' } };
    if (round === 1) return new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Private ' } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'first round', content: 'Checking.' } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: 'tool_calls' }] })}`,
      'data: [DONE]',
    ].join('\n\n') + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
    return new Response(JSON.stringify({ choices: [{ finish_reason: round === 2 ? 'tool_calls' : 'stop', message: round === 2
      ? { content: null, reasoning_content: 'Private second round', tool_calls: [call] }
      : { content: 'Done.', reasoning_content: 'Private final answer' } }] }), { headers: { 'content-type': 'application/json' } });
  });
  const config = { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-flash', systemPrompt: '', historyLimit: 10 };
  const messages: AgentModelMessage[] = [
    { role: 'system', content: 'Trusted server policy' }, { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'Persisted visible answer, no retained thought' }, { role: 'user', content: 'Read the task now' },
  ];
  const tools = [{ type: 'function' as const, function: { name: 'pm_read', description: 'Read', parameters: { type: 'object' } } }];
  const visible: string[] = [];
  for (let index = 0; index < 3; index++) {
    let calls: NonNullable<AgentModelEvent['toolCalls']> = [], reasoning: string | undefined, content = '';
    for await (const event of streamAgentModel(config, messages, new AbortController().signal, tools, 'high')) {
      if (event.delta) { visible.push(event.delta); content += event.delta; }
      if (event.toolCalls) calls = event.toolCalls;
      if (event.reasoningContent) reasoning = event.reasoningContent;
    }
    if (calls.length) {
      messages.push({ role: 'assistant', content: content || null, tool_calls: calls, ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}) });
      messages.push({ role: 'tool', content: '{"result":"real fixture read"}', tool_call_id: calls[0]!.id });
    }
  }
  assert.deepEqual(visible, ['Checking.', 'Done.']);
  assert.deepEqual(bodies[0]?.messages.filter(message => message.role === 'assistant'), []);
  assert.ok(bodies[0]?.messages.some(message => message.content?.includes('Persisted visible answer')));
  const continued = bodies[2]!.messages.filter(message => message.role === 'assistant');
  assert.deepEqual(continued.map(message => message.reasoning_content), ['Private first round', 'Private second round']);
  assert.ok(bodies.every(body => body.reasoning_effort === 'high' && JSON.stringify(body.thinking) === '{"type":"enabled"}'));
  assert.equal(messages.some(message => message.role === 'assistant' && message.reasoning_content === ''), false);
});

test('thinking tool calls without actual reasoning fail before any call is exposed, for JSON and SSE', async t => {
  const config = { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-flash', systemPrompt: '', historyLimit: 10 };
  const tools = [{ type: 'function' as const, function: { name: 'pm_read', description: 'Read', parameters: { type: 'object' } } }];
  for (const format of ['json', 'sse']) {
    const call = { id: 'read', type: 'function', function: { name: 'pm_read', arguments: '{}' } };
    t.mock.method(globalThis, 'fetch', async () => format === 'json'
      ? new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [call] } }] }), { headers: { 'content-type': 'application/json' } })
      : new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
    const events: AgentModelEvent[] = [];
    await assert.rejects(async () => {
      for await (const event of streamAgentModel(config, [{ role: 'user', content: 'Read' }], new AbortController().signal, tools)) events.push(event);
    }, error => error instanceof AgentModelError && error.code === 'model_reasoning_missing');
    assert.equal(events.some(event => event.toolCalls), false);
    const disabled: AgentModelEvent[] = [];
    for await (const event of streamAgentModel(config, [{ role: 'user', content: 'Read' }], new AbortController().signal, tools, 'none')) disabled.push(event);
    assert.deepEqual(disabled, [{ toolCalls: [call] }], 'Non-thinking tools must not require manufactured reasoning');
    t.mock.restoreAll();
  }
});

test('cancelling during hidden thinking aborts the stream without exposing thoughts or tool calls', async t => {
  const received = Promise.withResolvers<void>();
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Private unfinished thought' } }] })}\n\n`));
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
        received.resolve();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const config = { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-flash', systemPrompt: '', historyLimit: 10 };
  const controller = new AbortController(), events: AgentModelEvent[] = [];
  const collecting = (async () => {
    for await (const event of streamAgentModel(config, [{ role: 'user', content: 'Think' }], controller.signal, [], 'high')) events.push(event);
  })();
  const rejected = assert.rejects(collecting, error => error instanceof Error && error.name === 'AbortError');
  await received.promise;
  controller.abort();
  await rejected;
  assert.deepEqual(events, []);
});
