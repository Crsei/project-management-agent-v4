import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBundledPmResources } from './catalog.ts';

/** Stage only reviewed runtime inputs; development skills/evaluations never enter the payload. */
export async function stageBundledPmResources(root, output) {
  const resources = await readBundledPmResources(root);
  await mkdir(output);
  for (const [sourcePath, content] of resources) {
    const target = path.join(output, sourcePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { flag: 'wx', mode: 0o644 });
  }
  await readBundledPmResources(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4 || !process.argv.slice(2).every(value => path.isAbsolute(value))) {
    throw new Error('Usage: node packages/skill-resources/stage.mjs ABSOLUTE_APP_ROOT NEW_ABSOLUTE_OUTPUT');
  }
  await stageBundledPmResources(process.argv[2], process.argv[3]);
}
