import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, opendir, open, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';

export const coreCheckpointSchema = z.array(z.strictObject({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative() }));
export type CoreCheckpoint = z.infer<typeof coreCheckpointSchema>;
export async function hashCheckpointFile(path: string): Promise<{ sha256: string; size: number }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new DomainError('blob_checkpoint_unsafe');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) { hash.update(chunk); size += chunk.length; }
    if (size !== stat.size) throw new DomainError('blob_checkpoint_changed');
    return { sha256: hash.digest('hex'), size };
  } finally { await file.close(); }
}
/** Includes authoritative .pm/state/config/views; cache only is reconstructible. */
export async function captureCoreCheckpoint(root: string): Promise<CoreCheckpoint> {
  root = resolve(root);
  if (await realpath(root) !== root) throw new DomainError('blob_checkpoint_unsafe');
  const entries: CoreCheckpoint = [];
  async function walk(relative: string): Promise<void> {
    const directory = await opendir(join(root, relative));
    for await (const entry of directory) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new DomainError('blob_checkpoint_unsafe');
      if (entry.isDirectory()) {
        if (path.endsWith('/.pm/cache')) continue;
        if (!relative) {
          if (!z.uuid().safeParse(entry.name).success) throw new DomainError('blob_checkpoint_unknown_workspace');
          const state = await lstat(join(root, path, '.pm', 'state'));
          if (!state.isDirectory() || state.isSymbolicLink()) throw new DomainError('blob_checkpoint_missing_state');
          // No config file is a valid Workspace default, not missing durable state.
          // Preserve that absence; a later file still changes the checkpoint.
          try {
            const config = await lstat(join(root, path, '.pm', 'config.yaml'));
            if (!config.isFile() || config.isSymbolicLink()) throw new DomainError('blob_checkpoint_missing_state');
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
          }
        }
        await walk(path);
      } else if (entry.isFile()) entries.push({ path, ...await hashCheckpointFile(join(root, ...path.split('/'))) });
      else throw new DomainError('blob_checkpoint_unsafe');
    }
  }
  await walk('');
  return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
export async function verifyCoreCheckpoint(root: string, input: CoreCheckpoint): Promise<string> {
  const expected = coreCheckpointSchema.parse(input).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (new Set(expected.map(item => item.path)).size !== expected.length || expected.some(item => item.path.startsWith('/') || item.path.includes('\\') || item.path.split('/').some(part => !part || part === '.' || part === '..') || resolve(root, item.path).startsWith(`${resolve(root)}${sep}`) === false)) throw new DomainError('blob_checkpoint_unsafe');
  const actual = await captureCoreCheckpoint(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new DomainError('blob_checkpoint_mismatch');
  return createHash('sha256').update(JSON.stringify(expected)).digest('hex');
}
