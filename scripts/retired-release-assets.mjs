import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';

const records = JSON.parse(await readFile(new URL('./retired-release-assets.json', import.meta.url)));
const sizes = new Set(records.map(item => item.bytes));
const hashes = new Set(records.map(item => item.sha256));
// Includes renamed and Vite-hashed files; only matching lengths need to be read.
export async function checkRetiredAssets(root) {
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (!entry.isFile()) throw new Error('Unexpected non-regular entry in public assets: ' + file);
      else if (sizes.has((await lstat(file)).size) && hashes.has(createHash('sha256').update(await readFile(file)).digest('hex'))) throw new Error('Retired release asset still present: ' + file);
    }
  }
  await visit(root);
}
