import { readFileSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const settings = JSON.parse(readFileSync('/boot/native-launch.json', 'utf8'));
const forwarded = process.argv.slice(2), bindings = [];
for (let index = 0; index < forwarded.length; index++) {
  if (forwarded[index] !== '--trusted-extension') continue;
  const extension = forwarded[++index];
  if (settings.provider !== 'omp' || !extension || !/^\/tmp\/pm-omp-boundary-[A-Za-z0-9_-]+\/boundary\.mjs$/.test(extension)) throw new Error('Unexpected native permission extension');
  const directory = path.dirname(extension), stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || realpathSync(directory) !== directory) throw new Error('Untrusted native permission directory');
  if (readdirSync(directory).sort().join(',') !== 'boundary.mjs,context.json') throw new Error('Unexpected permission boundary files');
  for (const file of ['boundary.mjs', 'context.json']) {
    const entry = lstatSync(path.join(directory, file));
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.uid !== process.getuid() || (entry.mode & 0o077)) throw new Error('Untrusted permission boundary file');
  }
  // Read-only live context and the exact host-created hook only; never bind /tmp or Agent data.
  bindings.push('--ro-bind', directory, directory);
}
const child = spawn('/usr/bin/bwrap', [...settings.args, ...bindings, '--', ...settings.command, ...forwarded], { env: {}, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.once('error', () => process.exit(127));
child.once('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });
