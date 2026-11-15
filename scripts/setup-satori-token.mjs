import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const target = resolve(process.env.SATORI_TOKEN_FILE ?? '.local/satori-token');
if (existsSync(target)) {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw new Error('Existing Satori token file must be a private regular file');
  process.stdout.write(`${target}\n`);
} else {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const descriptor = openSync(target, 'wx', 0o600);
  try { writeSync(descriptor, randomBytes(32).toString('base64url')); }
  finally { closeSync(descriptor); }
  chmodSync(target, 0o600);
  process.stdout.write(`${target}\n`);
}
