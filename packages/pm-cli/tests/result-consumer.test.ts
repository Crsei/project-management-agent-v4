import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const entrypoint = fileURLToPath(new URL('../index.ts', import.meta.url));

test('local plugin check continues only for schema-valid visible business success, never transport exit alone', async () => {
  const root = await mkdtemp(path.join(await realpath('/tmp'), 'pm-cli-consumer-'));
  const operationId = randomUUID();
  const record = {
    operationId, name: 'pm_query', status: 'succeeded', visibility: 'visible',
    result: { kind: 'query', items: [], nextCursor: null, truncated: false, sources: [] }, error: null,
    threadId: '', messageId: '', generationId: '', workspaceId: randomUUID(),
    createdAt: '2026-11-13T00:00:00Z', finishedAt: '2026-11-13T00:00:01Z',
  };
  // An unreachable PM origin proves this is a local assertion, not a redispatch.
  const environment = { PATH: process.env.PATH ?? '', HOME: root, PM_API_URL: 'http://127.0.0.1:1' };
  const filename = path.join(root, 'result.json');
  try {
    await writeFile(filename, JSON.stringify(record), { mode: 0o600 });
    const accepted = await execute(process.execPath, [entrypoint, 'plugin', 'check', '--file', filename], { env: environment });
    assert.deepEqual(JSON.parse(accepted.stdout), record);
    assert.equal(accepted.stderr, '');
    for (const result of [
      ...['pending_approval', 'running', 'failed', 'unknown'].map(status => ({ ...record, status })),
      { operationId, threadId: '', messageId: '', generationId: '', visibility: 'redacted' },
      { operationId, threadId: '', messageId: '', generationId: '', visibility: 'unavailable' },
      { operationId, status: 'unknown', visibility: 'unavailable', certainty: { dispatch: 'possibly_sent', evidence: 'unresolved' }, recovery: 'query-original-operation' },
      { ...record, result: null },
      { ...record, error: { code: 'authoritative_rejection', message: 'not successful' } },
      { status: 'succeeded', visibility: 'visible', result: { arbitrary: 'unchecked blob' } },
    ]) {
      await writeFile(filename, JSON.stringify(result));
      await assert.rejects(execute(process.execPath, [entrypoint, 'plugin', 'check', '--file', filename], { env: environment }), (error: unknown) => {
        const failure = error as { code: number; stdout: string; stderr: string };
        assert.equal(failure.code, 1);
        assert.equal(failure.stdout, '');
        assert.match(failure.stderr, /CLI_PLUGIN_NOT_SUCCEEDED/);
        return true;
      });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
