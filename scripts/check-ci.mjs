import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ciPostgresLabel, isOwnedCiPostgres, processBirth } from './ci-postgres.ts';
import { groupMembers, processIdentity, signalOwnedGroup } from './backend-test-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dockerHost = ['--host', 'unix:///var/run/docker.sock'];
// Public PostgreSQL manifest and source-built MinIO fixture; never developer volumes.
const postgresImage = 'postgres:16.15-alpine@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab';
const networkSkillTest = 'services::skill::tests::mcode_copy_updates_and_disables_without_losing_external_changes';
let active;
let interrupted;

function stop(signal) {
  if (interrupted) return;
  interrupted = signal;
  if (!active) return;
  if (active.supervised) active.child.kill(signal);
  else void signalOwnedGroup(active.child.pid, active.known, signal);
}
const sigint = () => stop('SIGINT'), sigterm = () => stop('SIGTERM');

/** Start one command at a time; never turn a failed or interrupted child green. */
async function run(label, command, args, env, { capture = false, supervised = false, cleanup = false } = {}) {
  if (interrupted && !cleanup) throw new Error(`CI interrupted by ${interrupted}`);
  console.error(`[ci] ${label}`);
  const child = spawn(command, args, { cwd: root, env, detached: true, stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
  const known = new Map();
  if (child.pid) {
    const identity = processIdentity(child.pid);
    if (identity) known.set(child.pid, identity);
  }
  active = { child, known, supervised };
  let output = '';
  if (capture) child.stdout.setEncoding('utf8').on('data', chunk => {
    output += chunk;
    if (output.length > 4 * 1024 * 1024) child.kill('SIGTERM');
  });
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (child.pid && (await groupMembers(child.pid)).length) {
      await signalOwnedGroup(child.pid, known, 'SIGTERM');
      const until = Date.now() + 10_000;
      while ((await groupMembers(child.pid)).length && Date.now() < until) await delay(50);
      if ((await groupMembers(child.pid)).length) await signalOwnedGroup(child.pid, known, 'SIGKILL');
      throw new Error(`${label} left live owned descendants`);
    }
    if (result.code !== 0 || result.signal) throw new Error(`${label} failed (${result.signal ?? result.code})`);
    return output.trim();
  } finally { active = undefined; }
}

async function main() {
  const requested = process.argv.slice(2);
  const stage = requested.length === 0 ? 'all' : requested.length === 2 && requested[0] === '--stage' ? requested[1] : '';
  if (!['all', 'static', 'build', 'backend', 'agent', 'rust', 'rust-network'].includes(stage)) throw new Error('Usage: node scripts/check-ci.mjs [--stage all|static|build|backend|agent|rust|rust-network]');
  const selected = name => stage === name || stage === 'all' && name !== 'rust-network';
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
    CARGO_HOME: path.join(temporary, 'cargo'), RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(homedir(), '.rustup'),
    CI: 'true', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
    NODE_OPTIONS: '--max-old-space-size=4096', CHOKIDAR_USEPOLLING: 'true',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Dovspace CI', GIT_AUTHOR_EMAIL: 'ci@example.invalid', GIT_COMMITTER_NAME: 'Dovspace CI', GIT_COMMITTER_EMAIL: 'ci@example.invalid',
    AWS_EC2_METADATA_DISABLED: 'true', PM_REQUIRE_S3_TESTS: 'true', PM_PREVIEW_SANDBOX_TEST: '1',
    AGENT_WORKSPACE_DATA_DIR: path.join(temporary, 'agent'), PM_CHAT_SPACE_ROOT: path.join(temporary, 'chat-space'),
  };
  const node = (label, args, options) => run(label, process.execPath, args, env, options);
  const pnpm = (label, args) => run(label, 'pnpm', args, env);
  const docker = (label, args, options = {}) => run(label, 'docker', [...dockerHost, ...args], env, options);
  process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
  let failure;
  try {
    for (const directory of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'CARGO_HOME']) await mkdir(env[directory], { mode: 0o700 });
    if (selected('backend') || selected('agent')) await access('/usr/bin/flock');
    if (selected('agent')) {
      await access('/usr/bin/bwrap'); await access('/usr/bin/prlimit');
      // Preview binds this process's doctor-checked executable read-only into its namespace.
    }
    await node('Toolchain preflight', ['scripts/doctor.mjs']);
    const prepareFixtures = async () => {
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
    };

    if (selected('static')) {
      await node('Public documentation', ['scripts/check-docs.mjs']);
      await node('PM contract drift', ['scripts/generate-contracts.ts', '--check']);
      await node('Import boundaries', ['scripts/check-import-boundaries.mjs']);
      await node('Third-party notice and asset integrity (not release approval)', ['scripts/check-third-party-notices.mjs', '--integrity']);
      await node('Pinned source and resource provenance', ['scripts/check-sources.mjs']);
      await pnpm('PM lint', ['lint']);
      await pnpm('Gateway lint', ['exec', 'eslint', 'apps/server/gateway.ts', 'apps/server/gateway.test.ts', '--max-warnings=0']);
      await pnpm('Agent and host lint', ['lint:agent']);
      await pnpm('Complete owned Web lint', ['--filter', '@pm/web', 'lint']);
      await pnpm('CI entrypoint lint', ['exec', 'oxlint', '--deny-warnings', 'scripts/check-ci.mjs', 'scripts/check-sources.mjs']);
    }
    if (selected('build')) {
      // Package exports name emitted declarations. Fresh checkouts must produce
      // them before PM/Agent/Web type graphs can resolve workspace consumers.
      await pnpm('Agent contract declarations', ['--filter', '@agent-workspace/contracts', 'build']);
      await pnpm('Agent client runtime declarations', ['--filter', '@agent-workspace/client-runtime', 'build']);
      await pnpm('Complete client runtime types, including tests and provider exports', ['--filter', '@agent-workspace/client-runtime', 'typecheck']);
      await pnpm('PM and gateway typecheck', ['typecheck']);
      await pnpm('PM production build', ['build']);
      await pnpm('Agent complete types and production build', ['--filter', '@agent-workspace/server', 'build']);
      await pnpm('Complete Web types and production build', ['build:web']);
      await pnpm('Marketing types', ['typecheck:marketing']);
      await pnpm('Marketing production build', ['build:marketing']);
      await node('Post-build source provenance', ['scripts/check-sources.mjs']);
    }
    if (selected('rust')) {
      console.error(`[ci] Offline Rust scope excludes external GitHub Skill smoke: ${networkSkillTest}; use --stage rust-network for that separate acceptance`);
      await run('Rust host locked offline-scope tests (all other ignored tests enabled)', 'cargo', [
        'test', '--locked', '--all-targets', '--manifest-path', 'apps/server/cc-switch-host/Cargo.toml',
        '--', '--include-ignored', '--skip', networkSkillTest,
      ], env);
    }
    if (selected('rust-network')) {
      await run('Explicit external GitHub Skill acceptance', 'cargo', [
        'test', '--locked', '--lib', '--manifest-path', 'apps/server/cc-switch-host/Cargo.toml', networkSkillTest, '--', '--ignored', '--exact',
      ], env);
    }
    if (selected('backend') || selected('agent')) {
      for (const generated of ['packages/agent-contracts/dist/pm-tools.d.ts', 'packages/agent-client-runtime/dist/index.d.ts', 'dist/apps/server/pm/src/main.js', 'apps/server/agent/dist/index.mjs']) {
        try { await access(path.join(root, generated)); }
        catch { throw new Error(`Missing ${generated}; run --stage build on this checkout before a standalone regression stage`); }
      }
    }
    if (selected('backend')) {
      await prepareFixtures();
      await node('Complete real PostgreSQL/HTTP/Worker/PM regressions', ['scripts/backend-tests.mjs', 'backend'], { supervised: true });
    }
    if (selected('agent')) {
      const buildRoot = path.join(root, 'apps/server/agent/dist');
      const { verifySidecar } = await import('../apps/server/agent/scripts/cc-switch.mjs');
      const native = await verifySidecar(buildRoot);
      env.CC_SWITCH_HOST_BINARY = path.join(buildRoot, 'cc-switch', native.target, native.executable);
      await node('Agent, client runtime, gateway, Web models, doctor and provenance regressions', [
        'scripts/backend-tests.mjs', 'files', '--',
        'apps/server/gateway.test.ts', 'packages/agent-client-runtime/src/**/*.test.ts',
        'apps/server/agent/src/**/*.test.ts', 'apps/web/src/**/*.test.ts', 'scripts/*.test.mjs',
        'vendor/cc-switch/scripts/provenance.test.mjs', 'vendor/openhands-extensions/scripts/provenance.test.mjs',
      ], { supervised: true });
    }
  } catch (error) { failure = error; }
  for (const name of containers.reverse()) {
    try {
      const result = await docker('Locating only this invocation\'s fixture', ['container', 'ls', '--all', '--filter', `name=^/${name}$`, '--filter', `label=${ciPostgresLabel}=${owner}`, '--format', '{{.ID}}'], { capture: true, cleanup: true });
      if (!result) continue;
      if (!/^[a-f0-9]{12,64}$/.test(result)) throw new Error('Ambiguous owned fixture cleanup identity');
      const inspected = JSON.parse(await docker('Confirming fixture cleanup ownership', ['inspect', result], { capture: true, cleanup: true }));
      if (inspected.length !== 1 || inspected[0]?.Name !== `/${name}` || inspected[0]?.Config?.Labels?.[ciPostgresLabel] !== owner) throw new Error('Fixture ownership changed; no unknown container was removed');
      await docker('Stopping and removing owned fixture and disposable storage', ['rm', '--force', '--volumes', inspected[0].Id], { capture: true, cleanup: true });
    } catch (error) { failure = failure ? new AggregateError([failure, error], 'CI and owned fixture cleanup failed') : error; }
  }
  if (minioBuildStarted) {
    try {
      const ownImage = await docker('Locating this invocation\'s MinIO fixture image', ['image', 'ls', '--filter', `reference=${minioImage}`, '--filter', `label=${ciPostgresLabel}=${owner}`, '--format', '{{.ID}}'], { capture: true, cleanup: true });
      if (ownImage) {
        const image = JSON.parse(await docker('Confirming MinIO image cleanup ownership', ['image', 'inspect', minioImage], { capture: true, cleanup: true }));
        if (image.length !== 1 || image[0]?.Config?.Labels?.[ciPostgresLabel] !== owner || !image[0]?.RepoTags?.includes(minioImage)) throw new Error('Fixture image ownership changed; no unknown image was removed');
        await docker('Removing only this invocation\'s MinIO fixture image tag', ['image', 'rm', minioImage], { capture: true, cleanup: true });
      }
    } catch (error) { failure = failure ? new AggregateError([failure, error], 'CI and fixture image cleanup failed') : error; }
  }
  await rm(temporary, { recursive: true, force: true });
  process.off('SIGINT', sigint); process.off('SIGTERM', sigterm);
  if (failure) throw failure;
  if (interrupted) throw new Error(`CI interrupted by ${interrupted}`);
  console.error(`[ci] ${stage} scope completed; no skipped/todo/incomplete Node results count as success. Native desktop, real Provider accounts and external Skill smoke are separate acceptance gates.`);
}

try { await main(); }
catch (error) {
  // Underlying check output is already visible; never print generated fixture
  // connection URLs, container environments or Provider/application secrets.
  console.error(`[ci] ${error instanceof Error ? error.message : 'Failed'}`);
  process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1;
}
