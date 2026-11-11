import { constants } from 'node:fs';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

async function parentDirectory(root: string, relative: string, create: boolean): Promise<{ directory: FileHandle; name: string }> {
  if (path.isAbsolute(relative) || relative.includes('\\')) throw new Error('Public file capability requires a relative POSIX path');
  const components = relative.split('/');
  if (components.some(value => !value || value === '.' || value === '..')) throw new Error('Public file capability rejects traversal');
  const name = components.pop()!;
  let directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const component of components) {
      const childPath = `/proc/self/fd/${directory.fd}/${component}`;
      if (create) try { await mkdir(childPath, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const child = await open(childPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await directory.close(); directory = child;
    }
    return { directory, name };
  } catch (error) { await directory.close(); throw error; }
}
export async function readRootedFile(root: string, relative: string, maxBytes = 8 * 1024 * 1024): Promise<string> {
  const { directory, name } = await parentDirectory(root, relative, false);
  try {
    const file = await open(`/proc/self/fd/${directory.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error('Public file capability rejects links, special files or oversized input');
      const bytes = Buffer.allocUnsafe(Math.min(maxBytes + 1, Math.max(1, stat.size + 1)));
      let size = 0;
      while (size < bytes.length) { const read = await file.read(bytes, size, bytes.length - size); if (!read.bytesRead) break; size += read.bytesRead; }
      if (size > stat.size || size > maxBytes) throw new Error('Public file changed during bounded read');
      return bytes.subarray(0, size).toString('utf8');
    } finally { await file.close(); }
  } finally { await directory.close(); }
}
/** Caller must quiesce untrusted writers for read/modify/write transactions. No ancestor or leaf is followed. */
export async function writeRootedFile(root: string, relative: string, content: string, options: { exclusive?: boolean; createParents?: boolean } = {}): Promise<void> {
  const { directory, name } = await parentDirectory(root, relative, options.createParents ?? false);
  try {
    const file = await open(`/proc/self/fd/${directory.fd}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | (options.exclusive ? constants.O_EXCL : 0), 0o600);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Public file capability rejects links and special files');
      await file.truncate(0); await file.writeFile(content); await file.sync();
    } finally { await file.close(); }
  } finally { await directory.close(); }
}

export interface SocketDirectory { socketPath(name: string): string; close(): Promise<void> }
/** Retain a private directory fd so Linux AF_UNIX bind/connect never receives a long checkout pathname. */
export async function openSocketDirectory(directory: string): Promise<SocketDirectory> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let closed = false;
  return {
    socketPath(name) {
      if (closed || !/^[a-z][a-z0-9-]*\.sock$/.test(name)) throw new Error('Invalid private socket capability');
      return `/proc/self/fd/${handle.fd}/${name}`;
    },
    async close() { if (!closed) { await handle.close(); closed = true; } },
  };
}
