import { constants } from 'node:fs';
import { mkdir, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareReportDirectory } from '../benchmarks/dovspace/reports/files.ts';
import { readReleaseMaterial } from '../benchmarks/dovspace/evaluation/release-material.ts';

/** Artifact downloads lose permissions. Copy data through anchored directory handles, never chmod or follow their entries. */
export async function stagePrivateEvaluationMaterial({ source, output, materialSha256 }) {
  if (process.platform !== 'linux') throw new Error('Private release-material restaging requires the Linux release host');
  const inputRoot = path.resolve(source), destination = path.resolve(output);
  const overlap = path.relative(inputRoot, destination), reverse = path.relative(destination, inputRoot);
  if (!overlap || !overlap.startsWith('..') || !reverse.startsWith('..')) throw new Error('Private restaging must use an independent new output tree');
  if (await realpath(inputRoot) !== inputRoot) throw new Error('Downloaded material root must not be redirected');
  await prepareReportDirectory(destination, true);
  const input = await open(inputRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const target = await open(destination, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let files = 0, entries = 0, totalBytes = 0;
  async function copyDirectory(from, to, depth = 0) {
    if (depth > 64) throw new Error('Downloaded material exceeds bounded directory depth');
    for await (const entry of await opendir(`/proc/self/fd/${from.fd}`)) {
      if (++entries > 100_000) throw new Error('Downloaded material exceeds bounded entry count');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name) || entry.isSymbolicLink()
        || !entry.isDirectory() && !entry.isFile()) throw new Error('Downloaded material contains an unsafe or non-regular entry');
      if (entry.isDirectory() && entry.name === 'content') throw new Error('Online feedback content must never enter hosted release material');
      const inputPath = `/proc/self/fd/${from.fd}/${entry.name}`, outputPath = `/proc/self/fd/${to.fd}/${entry.name}`;
      const handle = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (entry.isDirectory() ? constants.O_DIRECTORY : 0));
      try {
        const before = await handle.stat();
        if (entry.isDirectory()) {
          if (!before.isDirectory()) throw new Error('Downloaded material directory changed during restaging');
          await mkdir(outputPath, { mode: 0o700 });
          const child = await open(outputPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { await copyDirectory(handle, child, depth + 1); } finally { await child.close(); }
        } else {
          if (!before.isFile() || before.nlink !== 1 || before.size > 64 * 1024 * 1024
            || (totalBytes += before.size) > 16 * 1024 * 1024 * 1024) throw new Error('Downloaded material exceeds regular-file or bounded private staging limits');
          const bytes = await handle.readFile(), after = await handle.stat();
          if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) throw new Error('Downloaded material changed during restaging');
          const file = await open(outputPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { await file.writeFile(bytes); } finally { await file.close(); }
          files++;
        }
      } finally { await handle.close(); }
    }
  }
  try { await copyDirectory(input, target); } finally { await input.close(); await target.close(); }
  await readReleaseMaterial(path.join(destination, 'release-material.json'), materialSha256);
  return { material: path.join(destination, 'release-material.json'), outputRoot: destination, files, bytes: totalBytes, inferencePerformed: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { DESKTOP_EVALUATION_DOWNLOAD: source, DESKTOP_EVALUATION_PRIVATE: output, DESKTOP_EVALUATION_SHA256: materialSha256 } = process.env;
  if (!source || !output || !materialSha256) { console.error('Explicit download, private output and material SHA256 are required'); process.exitCode = 1; }
  else stagePrivateEvaluationMaterial({ source, output, materialSha256 }).then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
