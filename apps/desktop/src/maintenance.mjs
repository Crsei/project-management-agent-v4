import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { ManagedPostgres } from './managed-postgres.mjs';
import { prepareServicePorts, bindServicePorts } from './local-server.mjs';
import { ensurePrivateDirectory } from './private-state.mjs';

async function safePath(value, existing = false) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw new Error('Choose an absolute maintenance path.');
  const result = resolve(value);
  if (result === parse(result).root) throw new Error('A filesystem root cannot be a maintenance directory.');
  let current = parse(result).root;
  for (const part of result.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Maintenance directories cannot contain links or non-directory components.');
    } catch (error) {
      if (error.code !== 'ENOENT' || existing || current !== result) throw error;
    }
  }
  if (existing && await realpath(result) !== result) throw new Error('Choose the canonical maintenance directory.');
  return result;
}

function independent(left, right) {
  for (const [base, child] of [[left, right], [right, left]]) {
    const part = relative(base, child);
    if (!part || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part))) throw new Error('Backup and instance directories must be separate, not nested.');
  }
}

async function executeMaintenance({ serverRoot, runtimeRoot, input, onProgress }) {
  const executable = join(runtimeRoot, 'node', ...(process.platform === 'win32' ? ['node.exe'] : ['bin', 'node']));
  const entry = join(serverRoot, 'apps/desktop/src/backend/maintenance.ts');
  for (const file of [executable, entry]) if (!(await lstat(file)).isFile()) throw new Error('The complete desktop maintenance runtime is required.');
  const environment = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  environment.PM_DESKTOP_MANAGED = '1';
  const { promise, resolve, reject } = Promise.withResolvers();
  const child = spawn(executable, ['--conditions=development', entry], { cwd: serverRoot, env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  let failed = false;
  child.stdout.on('data', chunk => {
    output += chunk.toString();
    if (output.length > 128 * 1024) { failed = true; child.kill(); }
  });
  // Never forward PostgreSQL, filesystem or Provider diagnostics containing private data.
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.once('error', () => reject(new Error('Could not start the bundled maintenance runtime.')));
  child.once('close', code => {
    if (code !== 0 || failed) { reject(new Error('Desktop maintenance did not complete. Original data was not overwritten; keep any incomplete destination for inspection.')); return; }
    try { resolve(JSON.parse(output)); }
    catch { reject(new Error('The maintenance runtime returned an invalid result.')); }
  });
  onProgress?.('Processing private database, project files and Agent data. Do not quit the application.');
  child.stdin.end(JSON.stringify(input));
  return promise;
}

export async function backupDesktop({ serverRoot, runtimeRoot, dataDir, destination, onProgress }) {
  const source = await safePath(dataDir, true);
  const target = await safePath(destination);
  independent(source, target);
  try { await lstat(target); throw new Error('Backup destination already exists. Choose a new directory.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const marker = await lstat(join(source, 'bootstrap.json'));
  if (!marker.isFile() || marker.isSymbolicLink()) throw new Error('Only an initialized desktop instance can be backed up.');
  const postgres = new ManagedPostgres({ dataDir: source, binariesDir: join(runtimeRoot, 'postgres'), onProgress });
  try {
    // The owned database lock rejects a running desktop or foreign database owner.
    const started = await postgres.start();
    await executeMaintenance({ serverRoot, runtimeRoot, onProgress, input: {
      operation: 'backup', databaseUrl: started.databaseUrl, dataDir: source, destination: target,
      postgresRoot: join(runtimeRoot, 'postgres'), serverRoot,
    } });
    return { directory: target };
  } finally { await postgres.stop(); }
}

export async function restoreDesktop({ serverRoot, runtimeRoot, source, dataDir, onProgress }) {
  const backup = await safePath(source, true);
  const target = await safePath(dataDir);
  independent(backup, target);
  try {
    if ((await readdir(target)).length) throw new Error('Restore requires a new empty instance directory. Existing data was not changed.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(target, { mode: 0o700 });
    await ensurePrivateDirectory(target, { newlyCreated: true });
  }
  const manifest = await lstat(join(backup, 'desktop-backup.json'));
  if (!manifest.isFile() || manifest.isSymbolicLink()) throw new Error('Choose a completed desktop backup.');
  await prepareServicePorts(target);
  // No replacement of an existing instance. An interrupted target is retained and
  // cannot accidentally be selected as a fresh restore destination on retry.
  const postgres = new ManagedPostgres({ dataDir: target, binariesDir: join(runtimeRoot, 'postgres'), onProgress });
  try {
    const started = await postgres.start();
    await bindServicePorts(target, started.instanceId);
    await executeMaintenance({ serverRoot, runtimeRoot, onProgress, input: {
      operation: 'restore', databaseUrl: started.databaseUrl, dataDir: target, source: backup,
      postgresRoot: join(runtimeRoot, 'postgres'), serverRoot,
    } });
    return { dataDir: target, projectRoot: join(target, 'projects') };
  } finally { await postgres.stop(); }
}
