import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createLocalProjectFixture, localProjectChildEnvironment, type LocalProjectFixture } from '../tests/local-project-fixture.ts';
import type { LocalProjectSettings } from '../packages/contracts/src/local-projects.ts';

const { values } = parseArgs({ strict: true, options: { browser: { type: 'boolean' }, verify: { type: 'boolean' } } });
if (Boolean(values.browser) === Boolean(values.verify)) {
  throw new Error('Choose --verify for the complete real integration matrix, or --browser for an isolated live API + Worker + web fixture');
}
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL or explicitly env-loaded DATABASE_URL is required; this script never reads .env or existing account credentials');

if (values.verify) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./backend-tests.mjs', import.meta.url)), 'files', '--', 'tests/local-project.integration.test.ts', 'tests/local-project-backup.integration.test.ts', 'tests/local-project-fact-race.integration.test.ts'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: localProjectChildEnvironment({ TEST_DATABASE_URL: databaseUrl, CHOKIDAR_USEPOLLING: 'true', ...(process.env.PM_TEST_PG_DUMP ? { PM_TEST_PG_DUMP: process.env.PM_TEST_PG_DUMP } : {}), ...(process.env.PM_TEST_PG_RESTORE ? { PM_TEST_PG_RESTORE: process.env.PM_TEST_PG_RESTORE } : {}) }),
    stdio: 'inherit',
  });
  const result = Promise.withResolvers<number>();
  child.once('error', () => result.resolve(1));
  child.once('close', code => result.resolve(code ?? 1));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { child.kill(signal); });
  process.exitCode = await result.promise;
} else {
  const controller = new AbortController();
  const stopped = Promise.withResolvers<void>();
  const onSignal = () => { controller.abort(new Error('Local-project browser acceptance stopped')); stopped.resolve(); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  let fixture: LocalProjectFixture | undefined;
  try {
    fixture = await createLocalProjectFixture({ databaseUrl, signal: controller.signal });
    const existingCode = join(fixture.parents[0], 'browser-existing-code');
    await mkdir(join(existingCode, 'src'), { recursive: true });
    await writeFile(join(existingCode, 'README.md'), '# User-owned browser acceptance source\r\nPreserve these exact bytes.\r\n');
    await writeFile(join(existingCode, 'src/original.bin'), Buffer.from([0, 255, 42, 13, 10, 0]));
    await fixture.startWorker();
    const settings = await fixture.request<LocalProjectSettings>(`/api/v1/workspaces/${fixture.workspaceId}/local-projects/settings`);
    assert.equal(settings.status, 200); assert.equal(settings.body.enabled, true); assert.equal(settings.body.canManage, true);
    const { origin, metadataPath } = await fixture.startBrowser();
    // This record is safe to retain in a transcript: generated login/password and
    // session cookies exist only in the fixture's protected metadata file.
    console.log(JSON.stringify({ event: 'local_project_browser_ready', origin, metadataPath, workspaceId: fixture.workspaceId, existingCode, projectParents: fixture.parents, shutdown: 'SIGINT or SIGTERM this controller; it removes only its own PIDs, random schema and temporary root' }));
    await stopped.promise;
  } finally {
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    await fixture?.close();
    console.log(JSON.stringify({ event: 'local_project_browser_stopped', ownedResourcesCleaned: true }));
  }
}
