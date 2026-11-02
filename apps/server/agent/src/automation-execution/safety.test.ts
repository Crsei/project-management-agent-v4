import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { StudioExecutionRequest } from '../../../../../packages/contracts/src/automation-studio.ts';
import { automationServiceHeaders, createAutomationExecutionClient, createAutomationServiceBearer, verifyAutomationServiceBearer, verifyAutomationServiceRequest } from '../../../../../packages/infrastructure/src/automation-execution-client.ts';
import { closeStore, listRecords } from '../durable/store.ts';
import { cancelAutomationExecution, dispatchAutomationExecution, queryAutomationExecution } from './service.ts';
import { isolationAvailability, safeScriptPath, validateScriptAction } from './script-runtime.ts';

const secret = 'fixture-only-automation-service-secret-32-bytes';
function request(): StudioExecutionRequest {
  return { executionId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222', actorId: '33333333-3333-4333-8333-333333333333', workspaceId: '44444444-4444-4444-8444-444444444444', projectId: 'PRJ-001', definitionId: '55555555-5555-4555-8555-555555555555', definitionRevision: 1, config: { name: 'Fixture', description: '', projectId: 'PRJ-001', tags: [], templateId: null, action: { kind: 'script', repositories: [], plugins: [], timeoutSeconds: 10, entrypoint: 'main.py', setup: '', content: 'print("fixture")', bundleRef: null, files: [] }, trigger: { kind: 'manual' }, dailyLimit: 1, cooldownMinutes: 0 }, trigger: 'test', payload: null, issuedAt: '2026-10-31T00:00:00.000Z' };
}
let directory: string;
const originalData = process.env.AGENT_WORKSPACE_DATA_DIR;
const originalRuntime = process.env.PM_AUTOMATION_CONTAINER_RUNTIME;
const originalImage = process.env.PM_AUTOMATION_PYTHON_IMAGE;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'pm-automation-runtime-')); process.env.AGENT_WORKSPACE_DATA_DIR = directory; });
afterEach(async () => { closeStore(); if (originalData === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = originalData; if (originalRuntime === undefined) delete process.env.PM_AUTOMATION_CONTAINER_RUNTIME; else process.env.PM_AUTOMATION_CONTAINER_RUNTIME = originalRuntime; if (originalImage === undefined) delete process.env.PM_AUTOMATION_PYTHON_IMAGE; else process.env.PM_AUTOMATION_PYTHON_IMAGE = originalImage; await rm(directory, { recursive: true, force: true }); });

test('service authentication binds exact method, path, body and timestamp', () => {
  const pathname = '/internal/automation-executions/query', body = JSON.stringify(request());
  const headers = automationServiceHeaders('POST', pathname, body, secret);
  assert.equal(verifyAutomationServiceRequest('POST', pathname, body, headers, secret), true);
  assert.equal(verifyAutomationServiceRequest('POST', pathname.replace('query', 'dispatch'), body, headers, secret), false);
  assert.equal(verifyAutomationServiceRequest('POST', pathname, `${body} `, headers, secret), false);
  assert.equal(verifyAutomationServiceRequest('GET', pathname, body, headers, secret), false);
  headers.set('x-pm-automation-timestamp', String(Date.now() - 61_000));
  assert.equal(verifyAutomationServiceRequest('POST', pathname, body, headers, secret), false);
});
test('native and connector grants are audience scoped, generation bound, expiring, and contain no prompt or payload', () => {
  const native = createAutomationServiceBearer(request(), 'native-pm', undefined, secret);
  assert.equal(verifyAutomationServiceBearer(native, 'native-pm', secret)?.executionId, request().executionId);
  assert.equal(verifyAutomationServiceBearer(native, 'automation-integrations', secret), null);
  assert.throws(() => createAutomationServiceBearer(request(), 'automation-integrations', undefined, secret), /generation/);
  const generation = '66666666-6666-4666-8666-666666666666';
  const token = createAutomationServiceBearer(request(), 'automation-integrations', generation, secret);
  const identity = verifyAutomationServiceBearer(token, 'automation-integrations', secret)!;
  assert.equal(identity.generationId, generation);
  assert.equal(Object.hasOwn(identity, 'config'), false); assert.equal(Object.hasOwn(identity, 'payload'), false);
  const expired = { ...identity, issuedAt: Date.now() - 120_000, expiresAt: Date.now() - 60_000 };
  const payload = Buffer.from(JSON.stringify(expired)).toString('base64url');
  const signed = `pm-automation-v1.${payload}`;
  assert.equal(verifyAutomationServiceBearer(`${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`, 'automation-integrations', secret), null);
});
test('query and cancel of a missing identity remain unknown without any dispatch or thread creation', async () => {
  const query = await queryAutomationExecution(request());
  const cancel = await cancelAutomationExecution(request());
  assert.equal(query.status, 'outcome_unknown'); assert.equal(cancel.status, 'outcome_unknown');
  assert.deepEqual(listRecords('pm-automation:executions'), []); assert.deepEqual(listRecords('chat:threads'), []);
});
test('rejected unsafe bundle admission is persistent and identity conflicts cannot replace it', async () => {
  const input = request(); if (input.config.action.kind !== 'script') throw new Error('fixture'); input.config.action.entrypoint = '../main.py';
  const admitted = await dispatchAutomationExecution(input);
  assert.equal(admitted.status, 'failed'); assert.match(admitted.error!, /relative/);
  assert.deepEqual(await queryAutomationExecution(input), admitted);
  const changed = structuredClone(input); changed.config.description = 'different frozen request';
  await assert.rejects(queryAutomationExecution(changed), /different immutable request/);
  assert.equal(listRecords('pm-automation:executions').length, 1); assert.deepEqual(listRecords('chat:threads'), []);
});
test('frozen script packages reject links-by-path, traversal, duplicate definitions and expanded byte overflow', () => {
  for (const value of ['../main.py', '/main.py', 'a/../main.py', 'a\\main.py', 'C:/main.py', 'a//main.py', 'a/./main.py']) assert.equal(safeScriptPath(value), false, value);
  const action = request().config.action; if (action.kind !== 'script') throw new Error('fixture');
  assert.throws(() => validateScriptAction({ ...action, files: [{ path: 'main.py', content: 'duplicate' }] }), /both define/);
  assert.throws(() => validateScriptAction({ ...action, files: [{ path: 'folder', content: '' }, { path: 'folder/data', content: '' }] }), /also be a directory/);
  assert.throws(() => validateScriptAction({ ...action, files: [{ path: 'large.txt', content: 'a'.repeat(2 * 1024 * 1024) }] }), /expanded source limit/);
});
test('missing isolation fails closed instead of executing host Python or shell', async () => {
  delete process.env.PM_AUTOMATION_CONTAINER_RUNTIME; delete process.env.PM_AUTOMATION_PYTHON_IMAGE;
  const capability = await isolationAvailability();
  assert.equal(capability.available, false); assert.match(capability.reason!, /fallback is forbidden/);
});
test('client query reconciles only the original identity and never substitutes a dispatch', async () => {
  const paths: string[] = [];
  const client = createAutomationExecutionClient({ baseUrl: 'http://127.0.0.1:4195', secret, fetch: async (input, init) => {
    const url = new URL(String(input)); paths.push(url.pathname);
    assert.equal(verifyAutomationServiceRequest('POST', url.pathname, String(init?.body), new Headers(init?.headers), secret), true);
    return Response.json({ status: 'outcome_unknown', externalExecutionId: null, threadId: null, summary: '', error: 'unconfirmed', logs: [] });
  } });
  assert.equal((await client.query(request())).status, 'outcome_unknown');
  assert.deepEqual(paths, ['/internal/automation-executions/query']);
});

for (const held of ['prepare', 'create', 'authorization']) {
  test(`query and cancellation during ${held} preserve the original pending admission without starting code`, () => {
    const script = `
      import assert from 'node:assert/strict';
      import { mock } from 'node:test';
      import { setImmediate } from 'node:timers/promises';
      const root = ${JSON.stringify(new URL('./', import.meta.url).href)};
      const held = ${JSON.stringify(held)}, request = ${JSON.stringify(request())};
      const entered = Promise.withResolvers(), release = Promise.withResolvers();
      const actual = await import(new URL('script-runtime.ts', root).href);
      let starts = 0, inspections = 0, authorizations = 0;
      mock.module(new URL('script-runtime.ts', root).href, { namedExports: {
        ...actual,
        prepareIsolatedScript: async () => {
          if (held === 'prepare') { entered.resolve(); await release.promise; }
          return { executable: '/fixture-only', image: 'fixture', directory: process.env.AGENT_WORKSPACE_DATA_DIR, container: 'fixture', fingerprint: 'fixture' };
        },
        createIsolatedScript: async () => { if (held === 'create') { entered.resolve(); await release.promise; } },
        startIsolatedScript: async () => { starts++; },
        stopIsolatedScript: async () => {},
        observeIsolatedScript: async () => { inspections++; return { state: held === 'create' ? 'missing' : 'created', exitCode: null, startedAt: null, finishedAt: null, logs: [], error: null }; },
      } });
      globalThis.fetch = async () => {
        if (++authorizations === 2 && held === 'authorization') { entered.resolve(); await release.promise; }
        return Response.json({ scope: { workspaceId: request.workspaceId, projectId: request.projectId }, workspaceName: 'Fixture', projectName: 'Fixture', path: process.env.AGENT_WORKSPACE_DATA_DIR });
      };
      const runtime = await import(new URL('service.ts', root).href);
      const { closeStore } = await import(new URL('../durable/store.ts', root).href);
      try {
        await runtime.dispatchAutomationExecution(request);
        await entered.promise;
        assert.equal((await runtime.queryAutomationExecution(request)).status, 'running');
        assert.equal(inspections, 0, 'An owned in-flight admission is not a missing external outcome');
        await runtime.cancelAutomationExecution(request);
        release.resolve();
        await setImmediate();
        assert.equal((await runtime.queryAutomationExecution(request)).status, 'cancelled');
        assert.equal(starts, 0, 'Cancellation before start must survive the asynchronous authorization boundary');
      } finally { release.resolve(); await runtime.stopAutomationExecutionRuntime(); closeStore(); }
    `;
    execFileSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '--eval', script], {
      env: { PATH: process.env.PATH, HOME: directory, TMPDIR: tmpdir(), AGENT_WORKSPACE_DATA_DIR: directory, PM_AUTOMATION_SERVICE_SECRET: secret, PM_API_URL: 'http://127.0.0.1:4394' },
      timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  });
}
