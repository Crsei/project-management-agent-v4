import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { localProjectChildEnvironment } from './local-project-fixture.ts';

/** Refuse source-copy databases even when an ambient URL was explicitly loaded. */
export function assertV4WorkerTestDatabase(source: string): void {
  const message = 'Worker and automation tests may only use the isolated local PostgreSQL port 55444';
  let url: URL;
  try { url = new URL(source); }
  catch { throw new Error(message); }
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol)
    && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.port === '55444', message);
}

export function outboxWorkerEnvironment(databaseUrl: string, coreRoot: string): NodeJS.ProcessEnv {
  assertV4WorkerTestDatabase(databaseUrl);
  return localProjectChildEnvironment({
    DATABASE_URL: databaseUrl, CORE_WORKSPACE_ROOT: coreRoot,
    LOCAL_PROJECT_CONFIG: join(coreRoot, 'missing-test-config.json'), LOCAL_PROJECTS_ENABLED: 'false',
    LOCAL_PROJECT_ALLOWED_ROOTS: '[]', LOCAL_DATA_ROOT: dirname(coreRoot),
    WORKER_INTERVAL_MS: '25', EVENT_RETENTION_DAYS: '3650',
  });
}
