import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { integrationsFamily } from '../integrations.ts';
import type { CliRuntime, PmRequestOptions } from '../runtime.ts';

const id = '11111111-1111-4111-a111-111111111111';
const requestId = '22222222-2222-4222-a222-222222222222';
const config = { projectId: 'PRJ-001', provider: 'github', label: 'Native connection', readTools: [], writeTools: [], nativeApi: { baseUrl: 'https://api.github.com', repositories: ['owner/repo'], allowWrites: false } };
function runtime(result: unknown = {}) {
  const calls: { endpoint: string; options?: PmRequestOptions }[] = [], outputs: unknown[] = [];
  const value: CliRuntime = {
    authentication: async () => { throw new Error('The family must use the shared authenticated request seam'); },
    connection: async () => { throw new Error('The family must use the shared authenticated request seam'); },
    response: async () => { throw new Error('Unexpected raw response'); },
    json: async <T>(_scope: unknown, endpoint: string, options?: PmRequestOptions) => { calls.push({ endpoint, ...(options ? { options } : {}) }); return result as T; },
    print: output => outputs.push(output),
  };
  return { value, calls, outputs };
}

test('unowned commands are side-effect-free and owned command/options are closed', async () => {
  const f = runtime();
  assert.equal(await integrationsFamily.dispatch(['task', 'list'], f.value), false);
  assert.deepEqual(f.calls, []);
  await assert.rejects(integrationsFamily.dispatch(['integration', 'request', '--path', '/admin'], f.value), /Unknown integration/);
  await assert.rejects(integrationsFamily.dispatch(['im', 'notifications', '--id', id, '--enabled', 'true', '--actor-id', id], f.value), /Unknown or unsupported option/);
  assert.deepEqual(f.calls, []);
});

test('native secret input requires protected files, stays in request body and is never printed', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pm-integration-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  const configFile = path.join(root, 'config.json'), privateFile = path.join(root, 'private.json');
  const secret = 'synthetic-test-only-not-a-credential';
  await writeFile(configFile, JSON.stringify(config));
  await writeFile(privateFile, JSON.stringify({ nativePrivateHeaders: { Authorization: `Bearer ${secret}` } }), { mode: 0o600 });
  const f = runtime({ id, status: 'configured', verification: { mcp: false, nativeApi: false }, hasCredentials: true });
  await integrationsFamily.dispatch(['integration', 'save', '--id', id, '--file', configFile, '--private-file', privateFile, '--request-id', requestId, '--revision', '0'], f.value);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.endpoint, `/automations/integrations/${id}`);
  assert.deepEqual(f.calls[0]!.options, { method: 'PUT', body: { requestId, expectedRevision: 0, config, nativePrivateHeaders: { Authorization: `Bearer ${secret}` } } });
  assert.ok(!JSON.stringify(f.outputs).includes(secret));
  assert.equal(z.object({ status: z.string() }).parse(f.outputs[0]).status, 'configured');
  await chmod(privateFile, 0o644);
  await assert.rejects(integrationsFamily.dispatch(['integration', 'save', '--id', id, '--file', configFile, '--private-file', privateFile, '--request-id', requestId, '--revision', '0'], f.value), /0600/);
  assert.equal(f.calls.length, 1, 'unsafe secret file is rejected before any native mutation');
});

test('secret parse failures never echo secret bytes and ordinary config cannot smuggle private fields', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pm-integration-invalid-')); t.after(() => rm(root, { recursive: true, force: true }));
  const configFile = path.join(root, 'config.json'), privateFile = path.join(root, 'private.json');
  const secret = 'synthetic-sensitive-parse-sentinel';
  await writeFile(configFile, JSON.stringify(config));
  await writeFile(privateFile, `{secret: [${secret}`, { mode: 0o600 });
  const f = runtime();
  await assert.rejects(integrationsFamily.dispatch(['integration', 'save', '--id', id, '--file', configFile, '--private-file', privateFile, '--request-id', requestId, '--revision', '0'], f.value), error => error instanceof Error && !error.message.includes(secret));
  await writeFile(configFile, JSON.stringify({ ...config, nativePrivateHeaders: { Authorization: secret } }));
  await assert.rejects(integrationsFamily.dispatch(['integration', 'save', '--id', id, '--file', configFile, '--request-id', requestId, '--revision', '0'], f.value), /Invalid resource config/);
  assert.equal(f.calls.length, 0);
});

test('lost explicit verification is not retried and original receipt reads cannot redispatch', async () => {
  const f = runtime(); let attempts = 0;
  f.value.json = async () => { attempts++; throw new Error('Response lost after dispatch'); };
  await assert.rejects(integrationsFamily.dispatch(['integration', 'verify', '--id', id, '--request-id', requestId, '--revision', '4'], f.value), /Response lost/);
  assert.equal(attempts, 1);
  const receipt = runtime({ requestId, httpStatus: 409, result: { error: { code: 'version_conflict', message: 'Safe native rejection' } } });
  await integrationsFamily.dispatch(['integration', 'receipt', requestId], receipt.value);
  assert.deepEqual(receipt.outputs[0], { requestId, httpStatus: 409, result: { error: { code: 'version_conflict' } } });
});

test('original provider result is exported only to a new protected file; stdout has original metadata only', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pm-integration-result-')); t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'result.json'), sentinel = 'private-provider-result-content';
  const f = runtime({ id, executionId: requestId, connectionId: id, connectionRevision: 3, status: 'completed', result: { body: { content: sentinel } }, createdAt: '2026-11-13T00:00:00Z', finishedAt: '2026-11-13T00:01:00Z' });
  await integrationsFamily.dispatch(['integration', 'operation', id, '--result-file', filename], f.value);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), { body: { content: sentinel } });
  assert.ok(!JSON.stringify(f.outputs).includes(sentinel));
  assert.equal(z.object({ status: z.string() }).parse(f.outputs[0]).status, 'completed');
  assert.equal(f.calls[0]!.options, undefined);
});

test('IM link code is private output and does not imply platform delivery', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pm-im-code-')); t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'link.json'), code = '1234-1234-1234-1234-1234-1234-1234-1234';
  const f = runtime({ code, expiresAt: '2026-11-13T00:05:00Z' });
  await integrationsFamily.dispatch(['im', 'link-code', '--out-file', filename], f.value);
  assert.deepEqual(f.calls, [{ endpoint: '/im/link-codes', options: { method: 'POST', body: {} } }]);
  assert.ok(!JSON.stringify(f.outputs).includes(code));
  assert.equal(z.object({ deliveryVerified: z.boolean() }).parse(f.outputs[0]).deliveryVerified, false);
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).code, code);
  await assert.rejects(integrationsFamily.dispatch(['im', 'link-code', '--out-file', filename], f.value), /no link code was requested/);
  assert.equal(f.calls.length, 1, 'an existing private output must fail before requesting another secret');
});

test('outbound resume preserves the original delivery/version and authenticated barrier receipt', async () => {
  const f = runtime();
  await integrationsFamily.dispatch(['webhook', 'resume', '--id', id, '--version', '7', '--request-id', requestId, '--receipt-id', id], f.value);
  assert.deepEqual(f.calls, [{ endpoint: '/commands', options: { method: 'POST', body: { commandId: requestId, commandType: 'ResumeWebhookDelivery', payload: { receiptId: id }, targetId: id, expectedVersions: { [id]: 7 } } } }]);
  await assert.rejects(integrationsFamily.dispatch(['webhook', 'retry', '--id', id], f.value), /Unknown webhook/);
});
