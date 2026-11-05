import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class PrivateFileError extends Error {
  constructor() { super('Private credential storage must use owned, non-symlink directories and regular 0600 files; unsafe paths were not read or changed.'); }
}

function safeFile(stat: Stats): void {
  if (!stat.isFile() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) throw new PrivateFileError();
}

export async function privateDirectory(directory: string, create: boolean): Promise<boolean> {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  const segments = absolute.slice(root.length).split(path.sep).filter(Boolean);
  if (!segments.length) throw new PrivateFileError();
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]!);
    let stat: Stats;
    try { stat = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return false;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
      stat = await lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PrivateFileError();
    const final = index === segments.length - 1;
    // Shared sticky ancestors such as /tmp cannot replace another user's private child.
    const sharedSticky = !final && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (((stat.mode & 0o022) !== 0 && !sharedSticky) || (final && ((typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0))) throw new PrivateFileError();
  }
  return true;
}

export async function readPrivateFile(filename: string): Promise<string | undefined> {
  if (!await privateDirectory(path.dirname(filename), false)) return undefined;
  let handle;
  try { handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (['ELOOP', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new PrivateFileError();
    throw error;
  }
  try {
    safeFile(await handle.stat());
    const bytes = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > 64 * 1024) throw new PrivateFileError();
    return bytes.toString('utf8', 0, length);
  } finally { await handle.close(); }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function createPrivateFile(filename: string, content: string): Promise<boolean> {
  await privateDirectory(path.dirname(filename), true);
  let handle;
  try { handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    safeFile(await handle.stat());
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(path.dirname(filename));
  return true;
}

export async function writePrivateFile(filename: string, content: string): Promise<void> {
  await privateDirectory(path.dirname(filename), true);
  await readPrivateFile(filename); // Refuse unsafe existing files rather than replacing them.
  const temporary = path.join(path.dirname(filename), `.credential-${randomUUID()}`);
  let created = false;
  try {
    created = await createPrivateFile(temporary, content);
    if (!created) throw new PrivateFileError();
    await rename(temporary, filename);
    created = false;
    await syncDirectory(path.dirname(filename));
  } finally {
    if (created) await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
}

export async function removePrivateFile(filename: string): Promise<void> {
  if (await readPrivateFile(filename) === undefined) return;
  await unlink(filename);
  await syncDirectory(path.dirname(filename));
}
