import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const member = z.string().min(1).refine(value => value.split('/').every(part => part && part !== '.' && part !== '..' && !/[\\\x00-\x1f<>:"|?*]/.test(part) && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)));
export const treeManifestSchema = z.strictObject({
  directories: z.array(member),
  files: z.array(z.strictObject({ path: member, size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
});
export type TreeManifest = z.infer<typeof treeManifestSchema>;

export async function assertMaintenanceDirectory(value: string): Promise<void> {
  const info = await lstat(value);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(value) !== resolve(value)) throw new Error('Unsafe maintenance directory.');
}
export async function hashFile(filename: string): Promise<{ size: number; sha256: string }> {
  const before = await lstat(filename, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new Error('Unsafe maintenance file.');
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const actual = await file.stat({ bigint: true });
    if (actual.dev !== before.dev || actual.ino !== before.ino || actual.size !== before.size || actual.nlink !== 1n) throw new Error('Maintenance file identity changed.');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) { size += chunk.length; hash.update(chunk); }
    const after = await file.stat({ bigint: true });
    if (BigInt(size) !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new Error('Maintenance file changed.');
    return { size, sha256: hash.digest('hex') };
  } finally { await file.close(); }
}
export async function snapshotTree(root: string): Promise<TreeManifest> {
  await assertMaintenanceDirectory(root);
  const result: TreeManifest = { directories: [], files: [] };
  async function walk(relative: string): Promise<void> {
    const current = relative ? join(root, ...relative.split('/')) : root;
    await assertMaintenanceDirectory(current);
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = member.parse(relative ? `${relative}/${entry.name}` : entry.name);
      const location = join(root, ...name.split('/'));
      if (entry.isSymbolicLink()) throw new Error('Backup refuses filesystem links.');
      if (entry.isDirectory()) { result.directories.push(name); await walk(name); }
      else if (entry.isFile()) result.files.push({ path: name, ...await hashFile(location) });
      else throw new Error('Backup refuses nonregular files.');
    }
  }
  await walk('');
  return result;
}
/** Validate the complete tree, including empty directories and unclassified extra files. */
export async function verifyTree(root: string, expected: TreeManifest): Promise<void> {
  const manifest = treeManifestSchema.parse(expected);
  const names = [...manifest.directories, ...manifest.files.map(file => file.path)];
  const keys = names.map(name => name.normalize('NFD').toLowerCase());
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate or case-colliding backup member.');
  const directories = new Set(manifest.directories);
  for (const name of names) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) {
      if (!directories.has(parts.join('/'))) throw new Error('Backup member has no parent directory.');
      parts.pop();
    }
  }
  const normalized = (tree: TreeManifest) => ({
    directories: [...tree.directories].sort(),
    files: [...tree.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  });
  if (JSON.stringify(normalized(await snapshotTree(root))) !== JSON.stringify(normalized(manifest))) throw new Error('Backup file manifest differs from its contents.');
}
