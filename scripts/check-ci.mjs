import { randomBytes, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ciPostgresLabel, isOwnedCiPostgres, processBirth } from './ci-postgres.ts';
import { createCiCommandRunner, createCiRecorder } from './check-ci-process.mjs';
import { createTurboDispatcher } from './check-turbo.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dockerHost = ['--host', 'unix:///var/run/docker.sock'];
// Public PostgreSQL manifest and source-built MinIO fixture; never developer volumes.
const postgresImage = 'postgres:16.15-alpine@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab';
let commandRunner;
let interrupted;

function stop(signal) {
  if (interrupted) return;
  interrupted = signal;
  commandRunner?.stop(signal);
}
const sigint = () => stop('SIGINT'), sigterm = () => stop('SIGTERM');

async function main(recorder) {
  const usage = 'Usage: node scripts/check-ci.mjs [--stage all|static|build|backend|agent|host] [--baseline | --cache-name NAME]';
  const requested = process.argv.slice(2), stages = ['all', 'static', 'build', 'backend', 'agent', 'host'];
  let stage = 'all', baseline = false, cacheName = 'default', selectedStage = false, selectedCache = false;
  for (let index = 0; index < requested.length; index++) {
    const argument = requested[index];
    if (argument === '--stage' && !selectedStage) {
      stage = requested[++index];
      if (!stages.includes(stage)) throw new Error(usage);
      selectedStage = true;
    } else if (argument === '--baseline' && !baseline && !selectedCache) {
      baseline = true;
    } else if (argument === '--cache-name' && !selectedCache && !baseline) {
      cacheName = requested[++index];
      if (typeof cacheName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(cacheName)) throw new Error(usage);
      selectedCache = true;
    } else throw new Error(usage);
  }
  recorder.record('run', 'Repository checks', 'scope', { stage, mode: baseline ? 'baseline' : 'turbo', ...(baseline ? {} : { cacheName }) });
  const selected = name => stage === name || stage === 'all';
  if (process.platform !== 'linux') throw new Error('CI isolation requires Linux procfs, util-linux flock, Bubblewrap and local Docker');
  const birth = processBirth(process.pid);
  if (!birth) throw new Error('Cannot establish CI owner process birth identity');
  const temporary = await mkdtemp(path.join(tmpdir(), 'dovspace-ci-'));
  const runId = randomUUID(), owner = `${process.pid}:${birth}:${runId}`;
  const containers = [];
  const minioImage = `dovspace-ci-minio:${runId}`;
  let minioBuildStarted = false;
  // No ambient application/Provider/GitHub/cloud credentials, Node injection,
  // Docker contexts or private .env files enter a check subprocess.
  const env = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: path.join(temporary, 'home'), TMPDIR: path.join(temporary, 'tmp'),
    XDG_CONFIG_HOME: path.join(temporary, 'config'), XDG_DATA_HOME: path.join(temporary, 'data'), XDG_CACHE_HOME: path.join(temporary, 'cache'),
    CI: 'true', DOVSPACE_ISOLATED_CHECKS: '1', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
    NODE_OPTIONS: '--max-old-space-size=4096', CHOKIDAR_USEPOLLING: 'true',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Dovspace CI', GIT_AUTHOR_EMAIL: 'ci@example.invalid', GIT_COMMITTER_NAME: 'Dovspace CI', GIT_COMMITTER_EMAIL: 'ci@example.invalid',
    AWS_EC2_METADATA_DISABLED: 'true', PM_REQUIRE_S3_TESTS: 'true', PM_PREVIEW_SANDBOX_TEST: '1',
    AGENT_WORKSPACE_DATA_DIR: path.join(temporary, 'agent'), PM_CHAT_SPACE_ROOT: path.join(temporary, 'chat-space'),
  };
  commandRunner = createCiCommandRunner({ cwd: root, recorder, interrupted: () => interrupted });
  const { run } = commandRunner;
  const measure = (label, operation) => recorder.measure('stage', label, operation, () => interrupted);
  const node = (label, args, options) => run(label, process.execPath, args, env, options);
  const docker = (label, args, options = {}) => run(label, 'docker', [...dockerHost, ...args], env, options);
  process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
  let failure;
  try {
    await measure('preflight', async () => {
      for (const directory of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) await mkdir(env[directory], { mode: 0o700 });
      if (selected('backend') || selected('agent')) await access('/usr/bin/flock');
      if (selected('agent')) {
        await access('/usr/bin/bwrap'); await access('/usr/bin/prlimit');
        // Preview binds this process's doctor-checked executable read-only into its namespace.
        const source = process.env.PM_OPENHANDS_AUTHORING_SOURCE;
        if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('Agent checks require an explicit authenticated pinned public PM_OPENHANDS_AUTHORING_SOURCE checkout');
        const canonical = await realpath(source), sourceEntry = await lstat(source), host = await realpath(root);
        if (!sourceEntry.isDirectory() || sourceEntry.isSymbolicLink() || canonical !== path.resolve(source) || canonical === host || canonical.startsWith(`${host}${path.sep}`) || host.startsWith(`${canonical}${path.sep}`)) throw new Error('OpenHands authoring source must be a separate canonical public checkout, not private state or host outputs');
        env.PM_OPENHANDS_AUTHORING_SOURCE = canonical;
        // Authenticate real pinned Git objects, selected worktree bytes, npm archive
        // and legal identity under the same private environment as the actual test.
        await node('Authenticating pinned public OpenHands authoring source', [
          '--input-type=module', '--eval',
          "import { readFile } from 'node:fs/promises'; import { inputs, originalsFrom } from './vendor/openhands-extensions/scripts/provenance.mjs'; const loaded = await inputs(); await originalsFrom(process.env.PM_OPENHANDS_AUTHORING_SOURCE, await readFile('vendor/openhands-extensions/source-inputs/extensions-0.36.0.tgz'), loaded);",
        ]);
      }
      await node('Toolchain preflight', ['scripts/doctor.mjs']);
    });
    const turbo = createTurboDispatcher({ root, runner: commandRunner, env, cacheName });
    const prepareFixtures = async () => measure('fixtures', async () => {
    await docker('Checking local Docker daemon', ['info', '--format', '{{.ServerVersion}}'], { capture: true });
    const create = async (kind, args, image, command, extraEnv = {}) => {
      const name = `dovspace-ci-${kind}-${runId}`;
      // Enroll the random name before creation, so interrupted creation is also
      // cleaned only if Docker confirms this invocation's owner label.
      containers.push(name);
      const id = await run(`Creating owned ${kind}`, 'docker', [...dockerHost, 'create', '--name', name, '--label', `${ciPostgresLabel}=${owner}`, ...args, image, ...command], { ...env, ...extraEnv }, { capture: true });
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Docker did not return one full owned container identity');
      await docker(`Starting owned ${kind}`, ['start', id], { capture: true });
      const inspected = JSON.parse(await docker(`Reading owned ${kind} allocation`, ['inspect', id], { capture: true }));
      const container = inspected[0];
      if (inspected.length !== 1 || container?.Id !== id || container.Config?.Labels?.[ciPostgresLabel] !== owner || !container.State?.Running) throw new Error('Owned fixture identity changed');
      return container;
    };
    const minioContext = path.join(temporary, 'minio-context');
    await mkdir(minioContext, { mode: 0o700 });
    minioBuildStarted = true;
    await docker('Building pinned official MinIO source (public network required)', [
      'build', '--force-rm', '--label', `${ciPostgresLabel}=${owner}`, '--tag', minioImage,
      '--file', path.join(root, 'scripts/ci-minio.Dockerfile'), minioContext,
    ]);
    const password = randomBytes(32).toString('hex'), database = `pm_ci_${runId.replaceAll('-', '')}`;
    const postgres = await create('postgres', ['--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw,mode=0700', '--mount', `type=bind,src=${env.TMPDIR},dst=${env.TMPDIR}`, '--env', 'POSTGRES_USER', '--env', 'POSTGRES_DB', '--env', 'POSTGRES_PASSWORD'], postgresImage, [], { POSTGRES_USER: 'pm_ci', POSTGRES_DB: database, POSTGRES_PASSWORD: password });
    const binding = postgres.NetworkSettings?.Ports?.['5432/tcp'];
    if (binding?.length !== 1 || binding[0].HostIp !== '127.0.0.1' || !/^\d+$/.test(binding[0].HostPort)) throw new Error('PostgreSQL must have one newly allocated loopback binding');
    env.TEST_DATABASE_URL = `postgresql://pm_ci:${password}@127.0.0.1:${binding[0].HostPort}/${database}`;
    env.DATABASE_URL = env.TEST_DATABASE_URL;
    env.PM_CI_POSTGRES_CONTAINER = postgres.Id; env.PM_CI_POSTGRES_OWNER = owner;
    if (!isOwnedCiPostgres(env.TEST_DATABASE_URL, env)) throw new Error('New PostgreSQL allocation failed the same ownership guard used by Worker regressions');
    // Use the pinned server's matching clients, not an absent/older host install.
    // Only this run's private fixture files are mounted; the fixed container ID
    // and internal loopback address cannot target an existing database service.
    const clientDirectory = path.join(temporary, 'postgres-clients');
    await mkdir(clientDirectory, { mode: 0o700 });
    for (const binary of ['pg_dump', 'pg_restore']) {
      const client = path.join(clientDirectory, `${binary}.mjs`);
      const args = [...dockerHost, 'exec', '--user', `${process.getuid()}:${process.getgid()}`,
        ...['PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGOPTIONS', 'PGSSLMODE'].flatMap(name => ['--env', name]),
        '--env', 'PGHOST=127.0.0.1', '--env', 'PGPORT=5432', postgres.Id, `/usr/local/bin/${binary}`];
      await writeFile(client, `#!${process.execPath}
import { spawnSync } from 'node:child_process';
const result = spawnSync('docker', ${JSON.stringify(args)}.concat(process.argv.slice(2)), { stdio: 'inherit', env: { ...process.env, HOME: ${JSON.stringify(env.HOME)} } });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
`, { mode: 0o700, flag: 'wx' });
      env[`PM_TEST_${binary.toUpperCase()}`] = client;
      await run(`Pinned ${binary} client`, client, ['--version'], env);
    }
    const { Client } = await import('pg');
    let databaseReady = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (interrupted) throw new Error('CI interrupted during PostgreSQL startup');
      const client = new Client({ connectionString: env.TEST_DATABASE_URL, connectionTimeoutMillis: 1000 });
      try {
        await client.connect();
        const { rows } = await client.query('SELECT current_database() AS database, current_user AS username');
        if (rows[0]?.database !== database || rows[0]?.username !== 'pm_ci') throw new Error('New PostgreSQL authentication identity mismatch');
        databaseReady = true;
      } catch (error) {
        if (!['ECONNREFUSED', 'ECONNRESET', '57P03'].includes(error.code) && error.message !== 'Connection terminated unexpectedly') throw new Error('Owned PostgreSQL initialization failed');
      } finally { await client.end(); }
      if (databaseReady) break;
      await delay(200);
    }
    if (!databaseReady) throw new Error('Owned PostgreSQL never became ready');
    const accessKey = `pm${randomBytes(12).toString('hex')}`, secretKey = randomBytes(32).toString('hex');
    const minio = await create('minio', ['--publish', '127.0.0.1::9000', '--tmpfs', '/tmp:rw,mode=1777', '--tmpfs', '/data:rw,uid=1000,gid=1000,mode=0700', '--env', 'MINIO_ROOT_USER', '--env', 'MINIO_ROOT_PASSWORD'], minioImage, ['server', '/data', '--address', ':9000', '--console-address', ':9001'], { MINIO_ROOT_USER: accessKey, MINIO_ROOT_PASSWORD: secretKey });
    const s3Binding = minio.NetworkSettings?.Ports?.['9000/tcp'];
    if (s3Binding?.length !== 1 || s3Binding[0].HostIp !== '127.0.0.1' || !/^\d+$/.test(s3Binding[0].HostPort)) throw new Error('MinIO must have one newly allocated loopback binding');
    env.TEST_S3_ENDPOINT = `http://127.0.0.1:${s3Binding[0].HostPort}`;
    env.TEST_S3_ACCESS_KEY_ID = accessKey; env.TEST_S3_SECRET_ACCESS_KEY = secretKey; env.TEST_S3_REGION = 'us-east-1';
    const { S3Client, HeadBucketCommand, S3ServiceException } = await import('@aws-sdk/client-s3');
    const admin = new S3Client({ endpoint: env.TEST_S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: accessKey, secretAccessKey: secretKey }, maxAttempts: 1 });
    let objectLayerReady = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (interrupted) throw new Error('CI interrupted during MinIO startup');
        try { await admin.send(new HeadBucketCommand({ Bucket: `pm-ci-probe-${runId}` }), { abortSignal: AbortSignal.timeout(1000) }); }
        catch (error) {
          const status = error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;
          if (status === 404) { objectLayerReady = true; break; }
          if (status !== 503 && !['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'AbortError', 'TimeoutError'].includes(error.code ?? error.name)) throw new Error('Owned MinIO authenticated initialization failed');
        }
        await delay(200);
      }
    } finally { admin.destroy(); }
    if (!objectLayerReady) throw new Error('Owned MinIO object layer never became ready');
    });

    if (selected('static')) await measure('static', async () => {
      await node('Public documentation', ['scripts/check-docs.mjs']);
      await node('PM contract drift', ['scripts/generate-contracts.ts', '--check']);
      await node('Import boundaries', ['scripts/check-import-boundaries.mjs']);
      await node('Third-party notice and asset integrity (not release approval)', ['scripts/check-third-party-notices.mjs', '--integrity']);
      await node('Pinned source and resource provenance', ['scripts/check-sources.mjs']);
      await turbo.runStage('lint', { baseline });
    });
    if (selected('build')) await measure('build', async () => {
      // Package exports name emitted declarations. Fresh checkouts must produce
      // them before PM/Agent/Web type graphs can resolve workspace consumers.
      await turbo.runStage('build', { baseline });
      await node('Post-build source provenance', ['scripts/check-sources.mjs']);
    });
    if (selected('host')) await measure('host', async () => {
      await turbo.runStage('host-build', { baseline });
      await node('TypeScript host protocol tests', ['--test', 'apps/server/cc-switch-host/tests/host-protocol.test.ts']);
      await node('Agent extension integration tests against TypeScript host', ['--test', 'apps/server/agent/src/extensions/service.integration.test.ts']);
    });
    if (selected('backend') || selected('agent')) await measure('regression build prerequisites', async () => {
      for (const generated of ['packages/agent-contracts/dist/pm-tools.d.ts', 'packages/agent-client-runtime/dist/index.d.ts', 'dist/apps/server/pm/src/main.js', 'apps/server/agent/dist/index.mjs']) {
        try { await access(path.join(root, generated)); }
        catch { throw new Error(`Missing ${generated}; run --stage build on this checkout before a standalone regression stage`); }
      }
    });
    if (selected('backend')) await measure('backend', async () => {
      await prepareFixtures();
      await node('Complete real PostgreSQL/HTTP/Worker/PM regressions', ['scripts/backend-tests.mjs', 'backend'], { supervised: true });
    });
    if (selected('agent')) await measure('agent', async () => {
      const buildRoot = path.join(root, 'apps/server/agent/dist');
      const { verifyHost } = await import('../apps/server/agent/scripts/cc-switch.mjs');
      await verifyHost(buildRoot);
      env.CC_SWITCH_HOST_ENTRY = path.join(buildRoot, 'cc-switch', 'host', 'main.mjs');
      await node('Agent, client runtime, gateway, Web models, doctor and provenance regressions', [
        'scripts/backend-tests.mjs', 'files', '--',
        'apps/server/gateway.test.ts', 'packages/agent-client-runtime/src/**/*.test.ts',
        'apps/server/agent/src/**/*.test.ts', 'apps/web/src/**/*.test.ts', 'scripts/*.test.mjs',
        'vendor/openhands-extensions/scripts/provenance.test.mjs',
      ], { supervised: true });
    });
  } catch (error) { failure = error; }
  const cleanupErrors = [];
  try {
    await recorder.measure('stage', 'cleanup', async () => {
      for (const name of containers.reverse()) {
        try {
          const result = await docker('Locating only this invocation\'s fixture', ['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--filter', `label=${ciPostgresLabel}=${owner}`, '--format', '{{.ID}}'], { capture: true, cleanup: true });
          if (!result) continue;
          if (!/^[a-f0-9]{12,64}$/.test(result)) throw new Error('Ambiguous owned fixture cleanup identity');
          const inspected = JSON.parse(await docker('Confirming fixture cleanup ownership', ['inspect', result], { capture: true, cleanup: true }));
          if (inspected.length !== 1 || inspected[0]?.Name !== `/${name}` || inspected[0]?.Config?.Labels?.[ciPostgresLabel] !== owner) throw new Error('Fixture ownership changed; no unknown container was removed');
          await docker('Stopping and removing owned fixture and disposable storage', ['rm', '--force', '--volumes', inspected[0].Id], { capture: true, cleanup: true });
        } catch (error) { cleanupErrors.push(error); }
      }
      if (minioBuildStarted) {
        try {
          const ownImage = await docker('Locating this invocation\'s MinIO fixture image', ['image', 'ls', '--filter', `reference=${minioImage}`, '--filter', `label=${ciPostgresLabel}=${owner}`, '--format', '{{.ID}}'], { capture: true, cleanup: true });
          if (ownImage) {
            const image = JSON.parse(await docker('Confirming MinIO image cleanup ownership', ['image', 'inspect', minioImage], { capture: true, cleanup: true }));
            if (image.length !== 1 || image[0]?.Config?.Labels?.[ciPostgresLabel] !== owner || !image[0]?.RepoTags?.includes(minioImage)) throw new Error('Fixture image ownership changed; no unknown image was removed');
            await docker('Removing only this invocation\'s MinIO fixture image tag', ['image', 'rm', minioImage], { capture: true, cleanup: true });
          }
        } catch (error) { cleanupErrors.push(error); }
      }
      try { await rm(temporary, { recursive: true, force: true }); }
      catch (error) { cleanupErrors.push(error); }
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Owned CI resource cleanup failed');
    });
  } catch (error) { failure = failure ? new AggregateError([failure, error], 'CI and owned resource cleanup failed') : error; }
  finally {
    process.off('SIGINT', sigint); process.off('SIGTERM', sigterm);
    commandRunner = undefined;
  }
  if (failure) throw failure;
  if (recorder.failed) throw new Error('Safe CI timing artifact is incomplete');
  if (interrupted) throw new Error(`CI interrupted by ${interrupted}`);
  console.error(`[ci] ${stage} scope completed; no skipped/todo/incomplete Node results count as success. Native desktop, real Provider accounts and external Skill smoke are separate acceptance gates.`);
}

let recorder;
try {
  recorder = createCiRecorder(root);
  console.error(`[ci] Safe timing artifact: ${path.relative(root, recorder.file)}`);
  await recorder.measure('run', 'Repository checks', () => main(recorder), () => interrupted);
}
catch (error) {
  // Underlying check output is already visible; never print generated fixture
  // connection URLs, container environments or Provider/application secrets.
  console.error(`[ci] ${error instanceof Error ? error.message : 'Failed'}`);
  process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1;
}
finally {
  try { recorder?.close(); }
  catch { console.error('[ci] Closing the timing artifact failed'); process.exitCode ||= 1; }
}
