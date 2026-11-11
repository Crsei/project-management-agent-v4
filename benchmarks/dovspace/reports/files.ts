import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, parse, resolve, sep } from 'node:path';

/** Walk every ancestor explicitly; recursive mkdir and a lexical prefix are not a symlink boundary. */
export async function prepareReportDirectory(directory: string, exclusive = false): Promise<void> {
  const absolute = resolve(directory);
  const parts = absolute.slice(parse(absolute).root.length).split(sep).filter(Boolean);
  let current = parse(absolute).root;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    let existing = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const final = index === parts.length - 1;
    if (existing && final && exclusive) throw new Error('Output directory already exists; refusing to overwrite an experiment');
    if (!existing) {
      await mkdir(current, { mode: 0o700 });
      existing = await lstat(current);
    }
    if (existing.isSymbolicLink() || !existing.isDirectory() || await realpath(current) !== current) throw new Error('Output directory has a symlink or redirected ancestor');
  }
}

/** Publish atomically without following an existing output symlink or modifying a hard-link target. */
export async function writeReportFile(path: string, content: string): Promise<void> {
  await prepareReportDirectory(dirname(path));
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) throw new Error('Report output is not a single-link regular file');
  const temporary = join(dirname(path), `.report-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Read a schema input without following a file symlink or disclosing malformed JSON snippets. */
export async function readReportJson(path: string): Promise<unknown> {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (await realpath(parent) !== parent) throw new Error('Report input has a redirected ancestor');
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024 * 1024) throw new Error('Report input must be a bounded single-link regular file');
    const text = await file.readFile('utf8');
    try { return JSON.parse(text) as unknown; } catch { throw new Error('Report input is not valid JSON (input withheld)'); }
  } finally {
    await file.close();
  }
}
