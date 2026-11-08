import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { ManagedPostgres } from './managed-postgres.mjs';
import { prepareServicePorts, bindServicePorts } from './local-server.mjs';
import { ensurePrivateDirectory } from './private-state.mjs';
import { assertBackupCompatibility, decryptBackupDirectory, encryptBackupDirectory, encryptedBackupFilename, requireTrustedBackupSource, validateBackupPassword, withPrivateMaintenanceDirectory } from './maintenance-archive.mjs';

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
async function backupMetadata(directory) {
  const filename = join(directory, 'desktop-backup.json');
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64 * 1024 * 1024) throw new Error('Choose a completed desktop backup.');
  return JSON.parse(await readFile(filename, 'utf8'));
}

async function applicationVersion(serverRoot) {
  const metadata = JSON.parse(await readFile(join(serverRoot, 'apps/desktop/package.json'), 'utf8'));
  if (typeof metadata.version !== 'string' || !metadata.version) throw new Error('Desktop application version is unavailable.');
  return metadata.version;
}

async function emptyTarget(target) {
  try { if ((await readdir(target)).length) throw new Error('Restore requires a new empty instance directory. Existing data was not changed.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
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
    if (code !== 0 || failed) { reject(new Error('Desktop maintenance did not complete. Review the trusted backup, runtime version and available disk space before retrying. New-target cleanup cannot undo external side effects of supplied SQL.')); return; }
    try { resolve(JSON.parse(output)); }
    catch { reject(new Error('The maintenance runtime returned an invalid result.')); }
  });
  onProgress?.('Processing private database, project files and Agent data. Do not quit the application.');
  child.stdin.end(JSON.stringify(input));
  return promise;
}

export async function backupDesktop({ serverRoot, runtimeRoot, dataDir, destination, password, onProgress = undefined }) {
  validateBackupPassword(password, true);
  const source = await safePath(dataDir, true);
  const target = await safePath(destination);
  independent(source, target);
  try { await lstat(target); throw new Error('Backup destination already exists. Choose a new directory.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const marker = await lstat(join(source, 'bootstrap.json'));
  if (!marker.isFile() || marker.isSymbolicLink()) throw new Error('Only an initialized desktop instance can be backed up.');
  const postgres = new ManagedPostgres({ dataDir: source, binariesDir: join(runtimeRoot, 'postgres'), onProgress });
  let targetCreated = false;
  try {
    // Plaintext snapshots exist only in a private temporary directory, never the selected backup folder.
    return await withPrivateMaintenanceDirectory(async temporary => {
      const plaintext = join(temporary, 'snapshot');
      const started = await postgres.start();
      await executeMaintenance({ serverRoot, runtimeRoot, onProgress, input: {
        operation: 'backup', databaseUrl: started.databaseUrl, dataDir: source, destination: plaintext,
        postgresRoot: join(runtimeRoot, 'postgres'), serverRoot,
      } });
      await mkdir(target, { mode: 0o700 }); targetCreated = true;
      await ensurePrivateDirectory(target, { newlyCreated: true });
      onProgress?.('Encrypting the private backup. Keep your password separately; it cannot be recovered.');
      await encryptBackupDirectory(plaintext, join(target, encryptedBackupFilename), password);
      return { directory: target, encrypted: true };
    });
  } catch (error) {
    if (targetCreated) await rm(target, { recursive: true, force: true });
    throw error;
  } finally { password = ''; await postgres.stop(); }
}

export async function restoreDesktop({ serverRoot, runtimeRoot, source, dataDir, password = '', allowLegacyUnencrypted = false, trustedSourceAcknowledged = false, onProgress = undefined }) {
  requireTrustedBackupSource(trustedSourceAcknowledged);
  const backup = await safePath(source, true);
  const target = await safePath(dataDir);
  independent(backup, target);
  await emptyTarget(target);
  return withPrivateMaintenanceDirectory(async temporary => {
    const plaintext = join(temporary, 'snapshot');
    const entries = await readdir(backup);
    if (entries.includes(encryptedBackupFilename)) {
      if (entries.length !== 1) throw new Error('Encrypted backup folder contains unexpected files. Choose the original complete backup.');
      try { await decryptBackupDirectory(join(backup, encryptedBackupFilename), plaintext, password); }
      finally { password = ''; }
    } else {
      if (allowLegacyUnencrypted !== true) throw new Error('Legacy unencrypted backups are disabled. Explicitly acknowledge the privacy and unauthenticated-integrity risk to import a trusted legacy backup.');
      if ((await backupMetadata(backup)).version !== 1) throw new Error('Only the original version-1 unencrypted backup format can use legacy import. New backups require the encrypted container.');
      // Freeze a legacy source into private staging before validating or touching the target.
      await executeMaintenance({ serverRoot, runtimeRoot, onProgress, input: {
        operation: 'validate', databaseUrl: '', dataDir: target, source: backup, destination: plaintext,
        postgresRoot: join(runtimeRoot, 'postgres'), serverRoot,
      } });
    }
    const metadata = await backupMetadata(plaintext);
    if (entries.includes(encryptedBackupFilename) && metadata.version === 1) throw new Error('Encrypted backups require version-2 application metadata. Legacy version-1 import is a separate explicit policy.');
    assertBackupCompatibility(metadata, await applicationVersion(serverRoot));
    // Full filesystem/dump preflight happens before service-port or database initialization.
    await executeMaintenance({ serverRoot, runtimeRoot, onProgress, input: {
      operation: 'validate', databaseUrl: '', dataDir: target, source: plaintext,
      postgresRoot: join(runtimeRoot, 'postgres'), serverRoot,
    } });
    await emptyTarget(target);
    let created = false;
    try { await mkdir(target, { mode: 0o700 }); created = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await ensurePrivateDirectory(target, { newlyCreated: created });
    const identity = await lstat(target, { bigint: true });
    const postgres = new ManagedPostgres({ dataDir: target, binariesDir: join(runtimeRoot, 'postgres'), onProgress });
    let completed = false;
    try {
      await prepareServicePorts(target);
      const started = await postgres.start();
      await bindServicePorts(target, started.instanceId);
      await executeMaintenance({ serverRoot, runtimeRoot, onProgress, input: {
        operation: 'restore', databaseUrl: started.databaseUrl, dataDir: target, source: plaintext,
        trustedSourceAcknowledged: true,
        postgresRoot: join(runtimeRoot, 'postgres'), serverRoot,
      } });
      completed = true;
      return { dataDir: target, projectRoot: join(target, 'projects') };
    } finally {
      // Never remove a directory while its owned PostgreSQL is still running.
      await postgres.stop();
      if (!completed) {
        const actual = await lstat(target, { bigint: true });
        if (actual.dev !== identity.dev || actual.ino !== identity.ino || actual.isSymbolicLink()) throw new Error('Restore target identity changed; automatic cleanup refused.');
        if (created) await rm(target, { recursive: true, force: true });
        else for (const name of await readdir(target)) await rm(join(target, name), { recursive: true, force: true });
      }
    }
  });
}
