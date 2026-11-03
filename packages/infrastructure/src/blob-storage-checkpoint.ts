import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import { SafeDirectory, assertStorageRelativePath } from './portable-directory.ts';

export const coreCheckpointSchema = z.array(z.strictObject({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative() }));
export type CoreCheckpoint = z.infer<typeof coreCheckpointSchema>;

async function hashDirectoryFile(directory: SafeDirectory, name: string): Promise<{ sha256: string; size: number }> {
  const file = await directory.openFile(name);
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw new DomainError('blob_checkpoint_unsafe');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      hash.update(chunk); size += chunk.length;
      if (BigInt(size) > stat.size) throw new DomainError('blob_checkpoint_changed');
    }
    const after = await file.stat({ bigint: true });
    if (BigInt(size) !== stat.size || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) throw new DomainError('blob_checkpoint_changed');
    await directory.assertFile(name, file);
    return { sha256: hash.digest('hex'), size };
  } finally { await file.close(); }
}
export async function hashCheckpointFile(path: string): Promise<{ sha256: string; size: number }> {
  const directory = await SafeDirectory.open(dirname(resolve(path)));
  try { return await hashDirectoryFile(directory, basename(path)); }
  finally { await directory.close(); }
}
/** Includes authoritative .pm/state/config/views; cache only is reconstructible. */
export async function captureCoreCheckpoint(root: string): Promise<CoreCheckpoint> {
  const entries: CoreCheckpoint = [];
  async function walk(directory: SafeDirectory, relative: string): Promise<void> {
    for (const entry of await directory.entries()) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new DomainError('blob_checkpoint_unsafe');
      if (entry.isDirectory()) {
        if (path.endsWith('/.pm/cache')) continue;
        const child = await directory.child(entry.name);
        try {
          if (!relative) {
            if (!z.uuid().safeParse(entry.name).success) throw new DomainError('blob_checkpoint_unknown_workspace');
            let metadata: SafeDirectory | undefined, state: SafeDirectory | undefined;
            try {
              metadata = await child.child('.pm'); state = await metadata.child('state');
              const config = (await metadata.entries()).find(entry => entry.name === 'config.yaml');
              if (config && (!config.isFile() || config.isSymbolicLink())) throw new DomainError('blob_checkpoint_missing_state');
            }
            catch { throw new DomainError('blob_checkpoint_missing_state'); }
            finally { await state?.close(); await metadata?.close(); }
            // An absent config file is the valid Workspace default. The recursive
            // walk still rejects unsafe config links, hardlinks and special files.
          }
          await walk(child, path);
        } finally { await child.close(); }
      } else if (entry.isFile()) entries.push({ path, ...await hashDirectoryFile(directory, entry.name) });
      else throw new DomainError('blob_checkpoint_unsafe');
    }
    await directory.assertIdentity();
  }
  const directory = await SafeDirectory.open(root);
  try { await walk(directory, ''); } finally { await directory.close(); }
  return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
export async function verifyCoreCheckpoint(root: string, input: CoreCheckpoint): Promise<string> {
  const expected = coreCheckpointSchema.parse(input).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const seen = new Set<string>();
  for (const item of expected) {
    assertStorageRelativePath(item.path);
    const key = process.platform === 'linux' ? item.path : item.path.normalize('NFD').toLowerCase();
    if (seen.has(key)) throw new DomainError('blob_checkpoint_unsafe');
    seen.add(key);
  }
  const actual = await captureCoreCheckpoint(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new DomainError('blob_checkpoint_mismatch');
  return createHash('sha256').update(JSON.stringify(expected)).digest('hex');
}
