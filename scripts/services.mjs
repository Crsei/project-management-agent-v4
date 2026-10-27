import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, open, readlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recordPath = path.join(root, '.local/services.json');
const specs = { worker: 'dist/apps/worker/src/main.js', api: 'dist/apps/api/src/main.js' };
const action = process.argv[2] ?? 'status';
if (!['start', 'status', 'stop'].includes(action)) throw new Error('Usage: services.mjs start|status|stop');
await mkdir(path.join(root, '.local/logs'), { recursive: true, mode: 0o700 });
let records = {};
try { records = JSON.parse(await readFile(recordPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }

async function identity(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { startTime: fields[19], state: fields[0], cwd: await readlink(`/proc/${pid}/cwd`), command: (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0') };
  } catch { return null; }
}
async function owned(role) {
  const record = records[role];
  if (!record?.pid) return false;
  const actual = await identity(record.pid);
  return Boolean(actual && actual.state !== 'Z' && actual.startTime === record.startTime && actual.cwd === root && actual.command.includes(path.join(root, specs[role])));
}
async function save() { await writeFile(recordPath, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 }); }
async function assertFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(process.env.PORT ?? 4100), process.env.HOST ?? '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

if (action === 'start') {
  if (!process.env.DATABASE_URL) throw new Error('Run with --env-file=.env after setup:local');
  if (!await owned('api')) await assertFreePort();
  const workerConfiguration = parseEnv(await readFile(path.join(root, '.env.worker'), 'utf8'));
  if (!workerConfiguration.DATABASE_URL) throw new Error('Configure DATABASE_URL in the private .env.worker role file');
  const workerEnvironment = {
    ...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TZ', 'LANG', 'LC_ALL', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
      .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    ...workerConfiguration,
  };
  for (const [role, entry] of Object.entries(specs)) {
    if (await owned(role)) { console.log(`${role}: existing owned process ${records[role].pid} preserved`); continue; }
    await readFile(path.join(root, entry)); // require an actual compiled entry before spawning
    const log = await open(path.join(root, '.local/logs', `${role}.log`), 'a', 0o600);
    const environment = role === 'worker' ? workerEnvironment : process.env;
    const child = spawn(process.execPath, [path.join(root, entry)], { cwd: root, env: environment, detached: true, stdio: ['ignore', log.fd, log.fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    await log.close();
    const actual = await identity(child.pid);
    if (!actual) throw new Error(`${role} exited before registration; inspect .local/logs/${role}.log`);
    records[role] = { pid: child.pid, startTime: actual.startTime, entry, startedAt: new Date().toISOString() };
    await save();
  }
  const origin = process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:4100';
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!await owned('api') || !await owned('worker')) break;
    try { ready = (await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* startup retry */ }
    if (ready) break;
    await delay(300);
  }
  if (!ready) throw new Error('Services did not become ready; inspect .local/logs and run services:status');
  console.log(JSON.stringify({ status: 'ready', origin, apiPid: records.api.pid, workerPid: records.worker.pid }));
}
if (action === 'stop') {
  for (const role of ['api', 'worker']) {
    if (!await owned(role)) { console.log(`${role}: no owned live process; no signal sent`); continue; }
    const pid = records[role].pid;
    process.kill(pid, 'SIGTERM');
    for (let attempt = 0; attempt < 80 && await owned(role); attempt++) await delay(100);
    if (await owned(role)) throw new Error(`${role} did not stop gracefully; it was not force-killed`);
    delete records[role];
    await save();
    console.log(`${role}: stopped owned process ${pid}`);
  }
}
if (action === 'status') {
  const status = {};
  for (const role of Object.keys(specs)) status[role] = { pid: records[role]?.pid ?? null, running: await owned(role) };
  try {
    const response = await fetch(`${process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:4100'}/health/ready`, { signal: AbortSignal.timeout(1500) });
    status.readiness = { status: response.status, body: await response.json() };
  } catch { status.readiness = { status: 'unreachable' }; }
  console.log(JSON.stringify(status, null, 2));
}
