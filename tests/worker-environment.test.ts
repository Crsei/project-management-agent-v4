import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it } from 'node:test';
import { readAccountRecoveryMailConfig } from '../packages/infrastructure/src/account-recovery-mail.ts';
import { readInvitationMailConfig } from '../packages/infrastructure/src/invitation-mail.ts';
import { runtimeConfig } from '../packages/infrastructure/src/runtime-config.ts';
import { readWebhookConfig } from '../packages/infrastructure/src/webhook-config.ts';
import { assertV4WorkerTestDatabase, outboxWorkerEnvironment } from './worker-environment.ts';
import { ciPostgresLabel, matchesCiPostgres } from '../scripts/ci-postgres.ts';

it('Worker and automation fixtures keep the v4 loopback database boundary', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) assert.doesNotThrow(() => assertV4WorkerTestDatabase(`postgres://fixture@${host}:55444/fixture`));
  for (const source of [
    'postgres://fixture@127.0.0.1:55442/fixture', 'postgres://fixture@127.0.0.1:55443/fixture', 'postgres://fixture@127.0.0.1:5432/fixture',
    'postgres://fixture@example.test:55444/fixture', 'https://localhost:55444/fixture',
  ]) assert.throws(() => assertV4WorkerTestDatabase(source), /isolated local PostgreSQL port 55444/);
  assert.throws(() => assertV4WorkerTestDatabase('private-database-url-not-for-logs'), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /isolated local PostgreSQL port 55444/);
    assert.equal(error.message.includes('private-database-url-not-for-logs'), false);
    return true;
  });
});

it('random CI ports require the exact running owned container, allocation and synthetic database identity', () => {
  const id = 'a'.repeat(64), owner = '123:456:00000000-0000-4000-8000-000000000001', password = 'b'.repeat(64);
  const database = 'pm_ci_00000000000040008000000000000001';
  const source = `postgresql://pm_ci:${password}@127.0.0.1:49152/${database}`;
  const container = {
    Id: id, State: { Running: true },
    Config: { Labels: { [ciPostgresLabel]: owner }, Env: ['POSTGRES_USER=pm_ci', `POSTGRES_DB=${database}`, `POSTGRES_PASSWORD=${password}`] },
    NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }] } },
  };
  assert.equal(matchesCiPostgres(source, container, id, owner), true);
  assert.equal(matchesCiPostgres(`${source}?options=-c%20search_path%3Dtest_owned`, container, id, owner), true);
  for (const foreign of [
    source.replace(':49152/', ':55443/'), source.replace('127.0.0.1', 'example.test'),
    source.replace(database, 'project_management'), source.replace(password, 'c'.repeat(64)),
    source.replace('pm_ci:', 'postgres:'), source.replace('postgresql:', 'https:'),
    `${source}?host=example.test`, `${source}?port=55443`, `${source}?database=project_management`,
    `${source}?user=postgres`, `${source}?password=foreign`, `${source}?hostaddr=127.0.0.1`,
    `${source}?options=-c%20search_path%3Dtest_first&options=-c%20search_path%3Dtest_second`,
    `${source}#unverified-fragment`,
  ]) assert.equal(matchesCiPostgres(foreign, container, id, owner), false);
  for (const change of [
    { Id: 'c'.repeat(64) }, { State: { Running: false } },
    { Config: { ...container.Config, Labels: { [ciPostgresLabel]: 'foreign-owner' } } },
    { NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '49152' }] } } },
    { NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5432' }] } } },
  ]) assert.equal(matchesCiPostgres(source, { ...container, ...change }, id, owner), false);
  assert.equal(matchesCiPostgres(source, null, id, owner), false);
  assert.equal(matchesCiPostgres(source, container, id, 'not-an-owner'), false);
});

it('outbox Workers receive only their real database and isolated read-only core configuration', () => {
  const databaseUrl = 'postgres://fixture@127.0.0.1:55444/fixture?options=-c%20search_path%3Dtest_owned';
  const coreRoot = join(tmpdir(), 'pm-outbox-environment', 'core');
  const env = outboxWorkerEnvironment(databaseUrl, coreRoot);
  const allowed: Record<string, true> = {
    PATH: true, LANG: true, LC_ALL: true, TZ: true, TMPDIR: true, SYSTEMROOT: true, CHOKIDAR_USEPOLLING: true,
    DATABASE_URL: true, CORE_WORKSPACE_ROOT: true, LOCAL_PROJECT_CONFIG: true, LOCAL_PROJECTS_ENABLED: true,
    LOCAL_PROJECT_ALLOWED_ROOTS: true, LOCAL_DATA_ROOT: true, WORKER_INTERVAL_MS: true, EVENT_RETENTION_DAYS: true,
  };
  for (const key of Object.keys(env)) assert.ok(Object.hasOwn(allowed, key), `Unexpected child environment key: ${key}`);
  assert.equal(env.DATABASE_URL, databaseUrl);
  assert.equal(env.CORE_WORKSPACE_ROOT, coreRoot);
  assert.equal(env.LOCAL_PROJECT_CONFIG, join(coreRoot, 'missing-test-config.json'));
  assert.equal(env.LOCAL_PROJECTS_ENABLED, 'false');
  assert.equal(env.LOCAL_PROJECT_ALLOWED_ROOTS, '[]');
  assert.equal(readInvitationMailConfig(env), undefined);
  assert.equal(readAccountRecoveryMailConfig(env), undefined);
  assert.equal(readWebhookConfig(env).status, 'disabled');
  const config = runtimeConfig(env);
  assert.equal(config.coreWorkspaceRoot, coreRoot);
  assert.equal(config.localProjects.enabled, false);
  assert.equal(config.workerIntervalMs, 25);
  assert.equal(config.eventRetentionDays, 3650);
});
