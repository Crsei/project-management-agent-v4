import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, open, readlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recordPath = path.join(root, '.local/services.json');
const action = process.argv[2] ?? 'status';
const development = action === 'dev';
if (!['start', 'dev', 'status', 'stop'].includes(action)) throw new Error('Usage: services.mjs start|dev|status|stop');
await mkdir(path.join(root, '.local/logs'), { recursive: true, mode: 0o700 });
let records = {};
try { records = JSON.parse(await readFile(recordPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const common = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TZ', 'LANG', 'LC_ALL', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CHOKIDAR_USEPOLLING']
  .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
async function configuration(file, required = false) {
  try { return parseEnv(await readFile(path.join(root, file), 'utf8')); }
  catch (error) { if (!required && error.code === 'ENOENT') return {}; throw error; }
}
const apiConfig = await configuration('.env');
const agentConfig = await configuration('.env.agent');
const apiPort = Number(apiConfig.PORT ?? 4194);
const agentPort = Number(agentConfig.AGENT_WORKSPACE_API_PORT ?? 4325);
const webPort = Number(apiConfig.PM_WEB_PORT ?? 3224);
const devWebPort = Number(agentConfig.AGENT_WEB_PORT ?? 4326);
const apiUrl = `http://127.0.0.1:${apiPort}`;
const agentUrl = `http://127.0.0.1:${agentPort}`;
const publicOrigin = apiConfig.PUBLIC_ORIGIN ?? `http://127.0.0.1:${webPort}`;
const definitions = {
  worker: { cwd: root, entries: ['apps/server/worker/src/main.ts', 'dist/apps/server/worker/src/main.js'] },
  api: { cwd: root, entries: ['apps/server/pm/src/main.ts', 'dist/apps/server/pm/src/main.js'], port: apiPort },
  agent: { cwd: root, entries: ['apps/server/agent/src/index.ts', 'apps/server/agent/dist/index.mjs'], port: agentPort },
  web: { cwd: path.join(root, 'apps/web'), entries: ['apps/web/node_modules/vite/bin/vite.js'], port: devWebPort },
  gateway: { cwd: root, entries: ['apps/server/gateway.ts'], port: webPort },
};
const activeRoles = Object.keys(definitions).filter(role => development || role !== 'web');
async function identity(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { startTime: fields[19], state: fields[0], cwd: await readlink(`/proc/${pid}/cwd`), command: (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0') };
  } catch { return null; }
}
async function owned(role) {
  const record = records[role];
  const definition = definitions[role];
  if (!record?.pid || !definition?.entries.includes(record.entry)) return false;
  const actual = await identity(record.pid);
  return Boolean(actual && actual.state !== 'Z' && actual.startTime === record.startTime && actual.cwd === definition.cwd && actual.command.includes(path.join(root, record.entry)));
}
async function save() { await writeFile(recordPath, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 }); }
async function assertFreePort(port) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function stop(roles) {
  for (const role of roles) {
    if (!await owned(role)) { console.log(`${role}: no owned live process; no signal sent`); continue; }
    const pid = records[role].pid;
    process.kill(pid, 'SIGTERM');
    for (let attempt = 0; attempt < 200 && await owned(role); attempt++) await delay(100);
    if (await owned(role)) throw new Error(`${role} did not stop gracefully; it was not force-killed`);
    delete records[role];
    await save();
    console.log(`${role}: stopped owned process ${pid}`);
  }
}
async function probe(url) {
  try { const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(1500) }); return { status: response.status, ok: response.ok }; }
  catch { return { status: 'unreachable', ok: false }; }
}
if (action === 'start' || development) {
  if (!apiConfig.DATABASE_URL) throw new Error('Run setup:local and configure the private v4 .env first');
  const workerConfig = await configuration('.env.worker', true);
  if (!workerConfig.DATABASE_URL) throw new Error('Configure DATABASE_URL in the private .env.worker role file');
  for (const role of activeRoles) {
    const definition = definitions[role];
    if (await owned(role)) {
      if (records[role].development !== development) throw new Error(`Owned ${role} uses another mode; stop this v4 installation before switching modes`);
    } else if (definition.port) await assertFreePort(definition.port);
    const entry = definition.entries[definition.entries.length === 1 || development ? 0 : 1];
    await readFile(path.join(root, entry));
    if (!development && role === 'gateway') await readFile(path.join(root, 'apps/web/dist/index.html'));
  }
  const pmEnvironment = { ...common, ...apiConfig, ...(process.env.PM_CHAT_SPACE_ROOT === undefined ? {} : { PM_CHAT_SPACE_ROOT: process.env.PM_CHAT_SPACE_ROOT }), HOST: '127.0.0.1', PORT: String(apiPort), PUBLIC_ORIGIN: publicOrigin };
  const agentEnvironment = { ...process.env, ...agentConfig, HOST: '127.0.0.1', PORT: String(agentPort), PM_API_URL: apiUrl,
    AGENT_WORKSPACE_DATA_DIR: agentConfig.AGENT_WORKSPACE_DATA_DIR ?? path.join(root, '.local/agent-data'), AGENT_WORKSPACE_API_ONLY: '1' };
  const environments = {
    worker: { ...common, ...workerConfig }, api: pmEnvironment, agent: agentEnvironment,
    web: { ...common, PM_API_URL: apiUrl, PM_WEB_PORT: String(devWebPort), PM_API_ORIGIN: publicOrigin, AGENT_WORKSPACE_API_URL: agentUrl, VITE_HMR_CLIENT_PORT: String(webPort) },
    gateway: { ...common, PUBLIC_HOST: '127.0.0.1', PUBLIC_PORT: String(webPort), PM_URL: apiUrl, AGENT_URL: agentUrl,
      ...(development ? { WEB_DEV_URL: `http://127.0.0.1:${devWebPort}` } : {}) },
  };
  const started = [];
  let interrupted = false;
  const markInterrupted = () => { interrupted = true; };
  process.on('SIGINT', markInterrupted);
  process.on('SIGTERM', markInterrupted);
  try {
    for (const role of activeRoles) {
      const definition = definitions[role];
      if (interrupted) throw new Error('v4 startup interrupted');
      if (await owned(role)) { console.log(`${role}: existing owned process ${records[role].pid} preserved`); continue; }
      const entry = definition.entries[definition.entries.length === 1 || development ? 0 : 1];
      const args = role === 'agent' && development ? ['--conditions=development'] : [];
      args.push(path.join(root, entry));
      if (role === 'web') args.push('--configLoader', 'runner');
      const log = await open(path.join(root, '.local/logs', `${role}.log`), 'a', 0o600);
      const child = spawn(process.execPath, args, { cwd: definition.cwd, env: environments[role], detached: true, stdio: ['ignore', log.fd, log.fd] });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      await log.close();
      const actual = await identity(child.pid);
      if (!actual) throw new Error(`${role} exited before registration; inspect .local/logs/${role}.log`);
      records[role] = { pid: child.pid, startTime: actual.startTime, entry, development, startedAt: new Date().toISOString() };
      started.push(role);
      await save();
    }
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (interrupted) break;
      if (!(await Promise.all(activeRoles.map(owned))).every(Boolean)) break;
      const probes = await Promise.all([`${apiUrl}/health/ready`, `${agentUrl}/api/access`, `${publicOrigin}/pm`, `${publicOrigin}/agent/workspace`].map(probe));
      if (probes.every(result => result.ok)) { ready = true; break; }
      await delay(500);
    }
    if (!ready) throw new Error('v4 processes did not become ready; inspect .local/logs and run services:status');
    console.log(JSON.stringify({ status: 'http-ready', origin: publicOrigin, providerExecution: 'not-verified', mode: development ? 'development' : 'built' }));
    if (development) {
      console.log('Web HMR is enabled. Restart dev:v4 after backend source changes. Ctrl-C stops only processes started by this invocation.');
      await new Promise(resolve => {
        if (interrupted) { resolve(); return; }
        const monitor = setInterval(async () => {
          if (!(await Promise.all(activeRoles.map(owned))).every(Boolean)) { process.exitCode = 1; finish(); }
        }, 1000);
        function finish() { clearInterval(monitor); process.off('SIGINT', finish); process.off('SIGTERM', finish); resolve(); }
        process.on('SIGINT', finish); process.on('SIGTERM', finish);
      });
      await stop(started.reverse());
    }
  } catch (error) { await stop(started.reverse()); throw error; }
  finally { process.off('SIGINT', markInterrupted); process.off('SIGTERM', markInterrupted); }
}
if (action === 'stop') await stop(Object.keys(definitions).reverse());
if (action === 'status') {
  const status = {};
  for (const role of Object.keys(definitions)) status[role] = { pid: records[role]?.pid ?? null, running: await owned(role), development: records[role]?.development ?? null };
  status.pmReadiness = await probe(`${apiUrl}/health/ready`);
  status.agentHttp = await probe(`${agentUrl}/api/access`);
  status.publicWeb = await probe(`${publicOrigin}/pm`);
  status.agentWebHttp = await probe(`${publicOrigin}/agent/workspace`);
  status.providerExecution = 'not-verified';
  console.log(JSON.stringify(status, null, 2));
}
