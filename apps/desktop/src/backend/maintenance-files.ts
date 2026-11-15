import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertMaintenanceDirectory, snapshotTree, treeManifestSchema, verifyTree, type TreeManifest } from '../../../../packages/infrastructure/src/maintenance-tree.ts';
import { ensurePrivateDirectory, securePrivateFile } from '../private-state.mjs';


export async function copyTree(source: string, target: string, expected: TreeManifest): Promise<void> {
  const manifest = treeManifestSchema.parse(expected);
  await verifyTree(source, manifest);
  await assertMaintenanceDirectory(dirname(target));
  await mkdir(target, { mode: 0o700 });
  await ensurePrivateDirectory(target, { newlyCreated: true });
  for (const relative of manifest.directories) {
    const destination = join(target, ...relative.split('/'));
    await assertMaintenanceDirectory(dirname(destination));
    await mkdir(destination, { mode: 0o700 });
    await ensurePrivateDirectory(destination, { newlyCreated: true });
  }
  for (const entry of manifest.files) {
    const filename = join(source, ...entry.path.split('/'));
    const destination = join(target, ...entry.path.split('/'));
    await assertMaintenanceDirectory(dirname(filename));
    await assertMaintenanceDirectory(dirname(destination));
    const input = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const output = await open(destination, 'wx', 0o600);
    try {
      await securePrivateFile(destination, { newlyCreated: true });
      const info = await input.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size !== entry.size) throw new Error('Backup source changed.');
      const hash = createHash('sha256');
      let size = 0;
      for await (const bytes of input.createReadStream({ autoClose: false })) { hash.update(bytes); size += bytes.length; await output.writeFile(bytes); }
      if (size !== entry.size || hash.digest('hex') !== entry.sha256) throw new Error('Backup checksum mismatch.');
      await output.sync();
    } finally { await input.close(); await output.close(); }
  }
  if (JSON.stringify(await snapshotTree(target)) !== JSON.stringify(manifest)) throw new Error('Copied backup checksum mismatch.');
}
