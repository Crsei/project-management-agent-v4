import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';
import { automationFamily } from '../automation.ts';
import type { CliRuntime, PmRequestOptions } from '../runtime.ts';

const id = '11111111-1111-4111-a111-111111111111', requestId = '22222222-2222-4222-a222-222222222222';
function fixture() {
  const requests: { scope: string; path: string; options: PmRequestOptions | undefined }[] = [], output: unknown[] = [];
  const runtime: CliRuntime = {
    authentication: async () => { throw new Error('Unexpected authentication'); }, connection: async () => { throw new Error('Unexpected connection'); },
    json: async <T>(scope: string, path: string, options?: PmRequestOptions) => { requests.push({ scope, path, options }); return { accepted: true } as T; },
    response: async () => { throw new Error('Unexpected raw request'); }, print: value => { output.push(value); },
  };
  return { runtime, requests, output };
}
describe('closed automation native CLI', () => {
  it('does not claim other families and rejects unknown/extra command inputs before transport', async () => {
    const f = fixture(); assert.equal(await automationFamily.dispatch(['integration', 'list'], f.runtime), false);
    for (const args of [['automation', 'arbitrary', '/commands'], ['automation', 'definition', id, '--path', '/commands'], ['automation', 'git', 'delete'], ['automation', 'definitions', '--quick-access', '1'], ['automation', 'logs', id, '--cursor', '-1']]) await assert.rejects(automationFamily.dispatch(args, f.runtime));
    assert.deepEqual(f.requests, []);
  });
  it('filters quick access on the native server and preserves opaque pagination rather than draining it', async () => {
    const f = fixture(); await automationFamily.dispatch(['automation', 'definitions', '--project', 'PRJ-001', '--quick-access', 'true', '--cursor', id], f.runtime);
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0]?.scope, 'workspace');
    const url = new URL(f.requests[0]!.path, 'http://local.invalid');
    assert.equal(url.pathname, '/automations/definitions'); assert.equal(url.searchParams.get('quickAccess'), 'true'); assert.equal(url.searchParams.get('cursor'), id);
  });
  it('does not retry test writes or replace original identities after a lost transport response', async t => {
    const root = await mkdtemp(join(tmpdir(), 'automation-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
    const filename = join(root, 'test.json'); await writeFile(filename, JSON.stringify({ requestId, expectedRevision: 3 }));
    const f = fixture(); f.runtime.json = async <T>(scope: string, path: string, options?: PmRequestOptions): Promise<T> => { f.requests.push({ scope, path, options }); throw new Error('Lost response after commit'); };
    await assert.rejects(automationFamily.dispatch(['automation', 'test', id, '--file', filename], f.runtime), /Lost response/);
    assert.equal(f.requests.length, 1); assert.deepEqual(f.requests[0]?.options, { method: 'POST', body: { requestId, expectedRevision: 3 } });
    assert.equal(f.requests[0]?.path, `/automations/definitions/${id}/test`);
    const lookup = fixture(); await automationFamily.dispatch(['automation', 'receipt', requestId], lookup.runtime);
    assert.equal(lookup.requests[0]?.path, `/automations/studio-receipts/${requestId}`); assert.equal(lookup.requests[0]?.options?.method, undefined);
  });
  it('protects Git credential files and sanitizes malformed YAML and schema failures before transport', async t => {
    const root = await mkdtemp(join(tmpdir(), 'automation-cli-private-')); t.after(() => rm(root, { recursive: true, force: true }));
    const config = { projectId: 'PRJ-001', enabled: false, repository: 'https://example.invalid/automation.git', branch: 'main', path: 'automations', authorName: 'Private file fixture', authorEmail: 'fixture@example.test', intervalSeconds: 0, encryptionEnabled: false };
    const secret = 'AUTOMATION_PRIVATE_TOKEN_DO_NOT_ECHO', key = 'AUTOMATION_PRIVATE_ENCRYPTION_KEY_DO_NOT_ECHO';
    const malformed = [
      `config: {}\ntoken: ${secret}\ntoken: ${key}\n`,
      `config: {}\ntoken: [${secret}\nencryptionKey: ${key}\n`,
      JSON.stringify({ config: { ...config, repository: `https://${secret}@example.invalid/private.git` }, token: secret, encryptionKey: key, requestId, expectedRevision: 0 }),
      JSON.stringify({ config, token: secret, encryptionKey: key, unexpected: secret }),
    ];
    const f = fixture();
    for (const operation of ['save', 'check']) for (const [index, content] of malformed.entries()) {
      const filename = join(root, `${operation}-${index}.yaml`); await writeFile(filename, content, { mode: 0o600 });
      await assert.rejects(automationFamily.dispatch(['automation', 'git', operation, '--file', filename], f.runtime), error => {
        assert.ok(error instanceof Error); assert.match(error.message, /input values were not printed/);
        assert.ok(!inspect(error).includes(secret)); assert.ok(!inspect(error).includes(key)); return true;
      });
    }
    assert.equal(f.requests.length, 0); assert.deepEqual(f.output, []);
    const filename = join(root, 'valid.json'), body = { requestId, expectedRevision: 0, config, token: secret, encryptionKey: key };
    await writeFile(filename, JSON.stringify(body), { mode: 0o600 });
    await automationFamily.dispatch(['automation', 'git', 'save', '--file', filename], f.runtime);
    const check = { config, token: null, encryptionKey: null }; await writeFile(filename, JSON.stringify(check), { mode: 0o600 });
    await automationFamily.dispatch(['automation', 'git', 'check', '--file', filename], f.runtime);
    await chmod(filename, 0o644); await assert.rejects(automationFamily.dispatch(['automation', 'git', 'check', '--file', filename], f.runtime), /0600/);
    await chmod(filename, 0o600); const linked = join(root, 'linked.json'); await symlink(filename, linked);
    await assert.rejects(automationFamily.dispatch(['automation', 'git', 'check', '--file', linked], f.runtime), /0600/);
    await assert.rejects(automationFamily.dispatch(['automation', 'git', 'check', '--file', filename, '--token', secret], f.runtime));
    assert.equal(f.requests.length, 2);
  });
});
