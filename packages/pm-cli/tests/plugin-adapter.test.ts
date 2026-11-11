import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { PmToolInvocation } from '../../agent-contracts/src/pm-tools.ts';
import { pluginOperation, pluginRead } from '../plugin-adapter.ts';
import { PLUGIN_OPERATION_POLICY } from '../plugin-capabilities.ts';

const workspaceId = '55555555-5555-4555-8555-555555555555';
const fixtureToken = 'only-a-synthetic-disposable-session-token-123456789';
const origin = 'http://127.0.0.1:1'; // Never contacted: every adapter request has an injected transport.

async function fixture() {
  const parent = await realpath(process.platform === 'win32' ? tmpdir() : '/tmp');
  const root = await mkdtemp(path.join(parent, 'dovspace-plugin-adapter-'));
  const environment = { PM_API_URL: origin, PM_SESSION_TOKEN: fixtureToken, PM_CLI_OPERATION_DIR: path.join(root, 'operations'), PM_CLI_SESSION_DIR: path.join(root, 'sessions') };
  return { root, environment };
}

function request() {
  return { operationId: randomUUID(), name: 'pm_update_task', target: { workspaceId, projectId: 'PRJ-001' }, arguments: { id: 'TASK-001', revision: 'a'.repeat(64), title: 'private-business-title', description: null, assigneeId: null, priority: null, startDate: null, dueDate: null, labels: null } };
}

function record(input: PmToolInvocation, status = 'succeeded') {
  return {
    operationId: input.operationId, name: input.name, status,
    result: { kind: 'task', items: [], nextCursor: null, truncated: false, sources: [], receipt: { kind: 'core', operationId: input.operationId, commandId: 'b'.repeat(64), action: 'update', targetId: 'TASK-001', revision: 'c'.repeat(64) } },
    error: null, threadId: '', messageId: '', generationId: '', workspaceId, target: input.target,
    createdAt: '2026-11-10T00:00:00Z', finishedAt: status === 'succeeded' || status === 'failed' ? '2026-11-10T00:00:01Z' : null,
    visibility: 'visible', certainty: { dispatch: 'possibly_sent', evidence: 'pm_result' },
    commandIds: ['b'.repeat(64), randomUUID()],
    linkage: { traceId: randomUUID(), invocationId: randomUUID(), executionRoot: 'external', clientKind: 'api', policy: 'full', enforcement: 'audit-only' },
  };
}

test('ordinary PM login and native external-root endpoint preserve exact requests, trace, hash command IDs and all five states', async () => {
  const f = await fixture();
  try {
    for (const status of ['pending_approval', 'running', 'succeeded', 'failed', 'unknown']) {
      const input = request(), output = record(input, status);
      const transport: typeof fetch = async (url, init) => {
        assert.equal(String(url), `${origin}/api/v1/workspaces/${workspaceId}/agent-tools/call`);
        assert.equal(init!.redirect, 'error');
        assert.equal(new Headers(init!.headers).get('Authorization'), `Bearer ${fixtureToken}`);
        assert.ok(typeof init?.body === 'string');
        assert.deepEqual(JSON.parse(init.body), { ...input, executionRoot: 'external' });
        assert.ok(!('threadId' in JSON.parse(init.body)));
        return Response.json(output);
      };
      assert.deepEqual(await pluginOperation('call', input, { environment: f.environment, fetch: transport }), output);
    }
    const names = await readdir(f.environment.PM_CLI_OPERATION_DIR);
    assert.equal(names.length, 5);
    for (const name of names) {
      const raw = await readFile(path.join(f.environment.PM_CLI_OPERATION_DIR, name), 'utf8');
      const journal = JSON.parse(raw);
      assert.deepEqual(Object.keys(journal).sort(), ['operationId', 'origin', 'policy', 'version']);
      assert.deepEqual(journal.policy, PLUGIN_OPERATION_POLICY);
      assert.equal(journal.origin, origin);
      assert.doesNotMatch(raw, /private-business-title|TASK-001|PRJ-001|Authorization|Bearer/);
      assert.ok(!raw.includes(fixtureToken));
      assert.equal((await stat(path.join(f.environment.PM_CLI_OPERATION_DIR, name))).mode & 0o777, 0o600);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('response loss, process-style restart and repeated call only query the original operation without redispatch', async () => {
  const f = await fixture();
  try {
    const input = request(), output = record(input), calls: string[] = [];
    const dropped: typeof fetch = async url => { calls.push(String(url)); throw new Error('synthetic response loss'); };
    const unknown = await pluginOperation('call', input, { environment: f.environment, fetch: dropped });
    assert.equal(z.object({ status: z.literal('unknown') }).parse(unknown).status, 'unknown');
    const recovered: typeof fetch = async (url, init) => {
      calls.push(String(url));
      assert.ok(typeof init?.body === 'string');
      assert.deepEqual(JSON.parse(init.body), { ...input, executionRoot: 'external' });
      return Response.json(output);
    };
    // A fresh options object has no in-memory state; original identity is durable on disk.
    assert.deepEqual(await pluginOperation('call', input, { environment: { ...f.environment }, fetch: recovered }), output);
    assert.deepEqual(await pluginOperation('result', input, { environment: f.environment, fetch: recovered }), output);
    assert.equal(calls.filter(url => url.endsWith('/call')).length, 1);
    assert.equal(calls.filter(url => url.endsWith('/result')).length, 2);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a query-first unknown operation cannot be converted into a new dispatch by later call', async () => {
  const f = await fixture();
  try {
    const input = request(), calls: string[] = [];
    const transport: typeof fetch = async url => { calls.push(String(url)); return new Response('not authoritative non-execution proof', { status: 404 }); };
    const missing = await pluginOperation('result', input, { environment: f.environment, fetch: transport });
    assert.equal(z.object({ visibility: z.literal('redacted') }).parse(missing).visibility, 'redacted');
    assert.ok(missing && typeof missing === 'object' && !('status' in missing));
    await pluginOperation('call', input, { environment: f.environment, fetch: transport });
    assert.equal(calls.length, 2);
    assert.ok(calls.every(url => url.endsWith('/result')));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('post-send 4xx/5xx, malformed and mismatched results stay unknown without leaking response bodies or retrying', async () => {
  const f = await fixture();
  try {
    for (const status of [401, 403, 404, 409, 429, 500]) {
      let calls = 0;
      const transport: typeof fetch = async () => { calls++; return new Response('secret-business-response-body', { status }); };
      const output = await pluginOperation('call', request(), { environment: f.environment, fetch: transport });
      const projection = z.object({ status: z.literal('unknown').optional(), visibility: z.string() }).parse(output);
      assert.equal(projection.status, [401, 403, 404].includes(status) ? undefined : 'unknown');
      assert.equal(projection.visibility, [401, 403, 404].includes(status) ? 'redacted' : 'unavailable');
      assert.ok(!JSON.stringify(output).includes('secret-business-response-body'));
      assert.equal(calls, 1);
    }
    for (const response of [new Response('invalid JSON'), Response.json(record(request()))]) {
      let calls = 0;
      const output = await pluginOperation('call', request(), { environment: f.environment, fetch: async () => { calls++; return response; } });
      assert.equal(z.object({ status: z.literal('unknown') }).parse(output).status, 'unknown');
      assert.equal(calls, 1);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('authorized denied projections remain minimal and do not grow a fabricated business outcome', async () => {
  const f = await fixture();
  try {
    const input = request();
    for (const visibility of ['redacted', 'unavailable']) {
      const placeholder = { operationId: input.operationId, threadId: '', messageId: '', generationId: '', visibility };
      const output = await pluginOperation('result', input, { environment: f.environment, fetch: async () => Response.json(placeholder) });
      assert.deepEqual(output, placeholder);
      assert.ok(output && typeof output === 'object' && !('status' in output) && !('result' in output));
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a result-read outage does not downgrade a previously confirmed business outcome', async () => {
  const f = await fixture();
  try {
    const input = request(), succeeded = record(input);
    const original = await pluginOperation('call', input, { environment: f.environment, fetch: async () => Response.json(succeeded) });
    const unavailable = await pluginOperation('result', input, { environment: f.environment, fetch: async () => { throw new Error('synthetic read outage'); } });
    assert.deepEqual(original, succeeded);
    assert.equal(z.object({ visibility: z.literal('unavailable') }).parse(unavailable).visibility, 'unavailable');
    assert.ok(unavailable && typeof unavailable === 'object' && !('status' in unavailable));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('existing service authentication, explicit target and private journal trust are enforced before dispatch', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const transport: typeof fetch = async () => { calls++; return Response.json({}); };
    const input = request();
    await assert.rejects(pluginOperation('call', { ...input, target: undefined }, { environment: f.environment, fetch: transport }));
    await assert.rejects(pluginOperation('call', { ...input, actorId: randomUUID() }, { environment: f.environment, fetch: transport }));
    await assert.rejects(pluginOperation('call', { ...input, traceId: randomUUID() }, { environment: f.environment, fetch: transport }));
    await assert.rejects(pluginOperation('call', input, { environment: { ...f.environment, PM_SESSION_TOKEN: '' }, fetch: transport }));
    await assert.rejects(pluginOperation('call', input, { environment: { ...f.environment, PM_API_URL: 'http://remote.invalid' }, fetch: transport }));
    const outside = path.join(f.root, 'outside');
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, f.environment.PM_CLI_OPERATION_DIR);
    await assert.rejects(pluginOperation('call', input, { environment: f.environment, fetch: transport }), /Private credential storage/);
    assert.equal(calls, 0);
    assert.deepEqual(await readdir(outside), []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('catalog and authorized-target discovery use ordinary PM auth and do not substitute OAuth tokens or create operations', async () => {
  const f = await fixture();
  try {
    const paths: string[] = [];
    const transport: typeof fetch = async (url, init) => {
      paths.push(String(url));
      assert.equal(init!.method, undefined);
      assert.equal(new Headers(init!.headers).get('Authorization'), `Bearer ${fixtureToken}`);
      assert.equal(init!.redirect, 'error');
      return Response.json({ observed: true });
    };
    assert.deepEqual(await pluginRead('tools', { environment: f.environment, fetch: transport }), { observed: true });
    assert.deepEqual(await pluginRead('workspaces', { environment: f.environment, fetch: transport }), { observed: true });
    assert.deepEqual(paths, [`${origin}/api/v1/agent-tools`, `${origin}/api/v1/agent-contexts`]);
    assert.deepEqual(await readdir(f.root), []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('canonical operation identity and changed arguments never reopen the dispatch boundary', async () => {
  const f = await fixture();
  try {
    const input = request(), succeeded = record(input), paths: string[] = [];
    const transport: typeof fetch = async (url, init) => {
      paths.push(String(url));
      assert.ok(typeof init?.body === 'string');
      const body = JSON.parse(init.body);
      assert.equal(body.operationId, input.operationId);
      if (body.arguments.title !== input.arguments.title) return new Response('different original request', { status: 409 });
      return Response.json(succeeded);
    };
    await pluginOperation('call', input, { environment: f.environment, fetch: transport });
    assert.deepEqual(await pluginOperation('call', { ...input, operationId: input.operationId.toUpperCase() }, { environment: f.environment, fetch: transport }), succeeded);
    const conflict = await pluginOperation('call', { ...input, arguments: { ...input.arguments, title: 'changed after acceptance' } }, { environment: f.environment, fetch: transport });
    assert.equal(z.object({ visibility: z.literal('unavailable') }).parse(conflict).visibility, 'unavailable');
    assert.ok(conflict && typeof conflict === 'object' && !('status' in conflict));
    assert.equal(paths.filter(url => url.endsWith('/call')).length, 1);
    assert.equal(paths.filter(url => url.endsWith('/result')).length, 2);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('malformed catalog and local identity data never echo private source text or trigger redispatch', async () => {
  const f = await fixture();
  try {
    const privateText = 'synthetic-private-source-must-not-be-echoed';
    await assert.rejects(pluginRead('tools', { environment: f.environment, fetch: async () => new Response(privateText) }), error => error instanceof Error && /malformed/.test(error.message) && !error.message.includes(privateText));
    const input = request();
    let calls = 0;
    const transport: typeof fetch = async () => { calls++; return Response.json(record(input)); };
    await pluginOperation('call', input, { environment: f.environment, fetch: transport });
    const journals = await readdir(f.environment.PM_CLI_OPERATION_DIR);
    assert.equal(journals.length, 1);
    await writeFile(path.join(f.environment.PM_CLI_OPERATION_DIR, journals[0]!), privateText);
    await assert.rejects(pluginOperation('call', input, { environment: f.environment, fetch: transport }), error => error instanceof Error && /identity journal/.test(error.message) && !error.message.includes(privateText));
    assert.equal(calls, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('public result projection rejects wrong targets, fake Chat links, receipt mismatches and hidden payload extras', async () => {
  const f = await fixture();
  try {
    const input = request(), good = record(input);
    const malformed = [
      { ...good, workspaceId: randomUUID() },
      { ...good, target: { ...input.target, workspaceId: randomUUID() } },
      { ...good, target: { ...input.target, projectId: 'PRJ-999' } },
      { ...good, target: undefined },
      { ...good, threadId: 'fake-chat' },
      { ...good, messageId: 'fake-message' },
      { ...good, generationId: 'fake-generation' },
      { ...good, linkage: { ...good.linkage, executionRoot: 'generation' } },
      { ...good, linkage: undefined },
      { ...good, result: { ...good.result, receipt: { ...good.result.receipt, operationId: randomUUID() } } },
      { ...good, visibility: 'redacted' },
      { ...good, visibility: 'unavailable' },
      { operationId: input.operationId, threadId: '', messageId: '', generationId: '', visibility: 'redacted', body: 'private-cross-target-body' },
    ];
    for (const value of malformed) {
      const output = await pluginOperation('result', input, { environment: f.environment, fetch: async () => Response.json(value) });
      assert.equal(z.object({ visibility: z.literal('unavailable') }).parse(output).visibility, 'unavailable');
      assert.ok(output && typeof output === 'object' && !('status' in output) && !('result' in output));
      assert.ok(!JSON.stringify(output).includes('TASK-001') && !JSON.stringify(output).includes('private-cross-target-body'));
    }
    const output = await pluginOperation('result', input, { environment: f.environment, fetch: async () => Response.json({ ...good, unrecognizedBodyCopy: 'private-cross-target-body' }) });
    assert.deepEqual(output, good);
    assert.ok(!JSON.stringify(output).includes('private-cross-target-body'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
