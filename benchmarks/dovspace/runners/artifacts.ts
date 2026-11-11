import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FixtureSnapshot } from '../schemas/types.ts';
import { TraceRedactor } from './telemetry.ts';

export type ArtifactCollection = { files: Record<string, string>; violations: string[] };

/** Never follows symlinks or exports multiply linked files from an untrusted mount. */
export async function collectArtifacts(publicRoot: string, outputDirectory: string, redactor: TraceRedactor): Promise<ArtifactCollection> {
  const files: Record<string, string> = {}, violations: string[] = [];
  const source = path.join(publicRoot, 'artifacts');
  const sourceInfo = await lstat(source).catch(() => null);
  if (!sourceInfo) return { files, violations };
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) return { files, violations: ['Artifact root is not a regular directory.'] };
  const canonicalRoot = await realpath(source);
  if (canonicalRoot !== path.resolve(source)) return { files, violations: ['Artifact root has a redirected ancestor.'] };
  let totalBytes = 0, entries = 0;
  async function visit(directory: string, relative: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 2000) throw new Error('Artifact entry count exceeds 2000.');
      const from = path.join(directory, entry.name), name = path.posix.join(relative, entry.name);
      let unsafeName = false;
      for (let index = 0; index < name.length; index++) if (name.charCodeAt(index) < 32) { unsafeName = true; break; }
      if (redactor.text(name) !== name || unsafeName) { violations.push('Refused an artifact with a sensitive or unsafe filename.'); continue; }
      const info = await lstat(from);
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile() || info.isFile() && info.nlink !== 1) { violations.push(`Refused unsafe artifact: ${name}`); continue; }
      if (info.isDirectory()) { await visit(from, name); continue; }
      if (info.size > 8 * 1024 * 1024 || totalBytes + info.size > 32 * 1024 * 1024) { violations.push(`Refused oversized artifact: ${name}`); continue; }
      const file = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: Buffer;
      try {
        const opened = await file.stat();
        if (opened.dev !== info.dev || opened.ino !== info.ino || opened.nlink !== 1) { violations.push(`Artifact identity changed before collection: ${name}`); continue; }
        content = await file.readFile();
        const after = await file.stat();
        if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || after.nlink !== 1) { violations.push(`Artifact identity changed during collection: ${name}`); continue; }
      } finally { await file.close(); }
      if (content.includes(0)) { violations.push(`Refused binary artifact: ${name}`); continue; }
      totalBytes += content.length;
      const target = path.join(outputDirectory, name);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      let safe = redactor.text(content.toString('utf8'));
      try { safe = JSON.stringify(redactor.value(JSON.parse(safe)), null, 2) + '\n'; } catch { /* Non-JSON artifacts retain redacted original text. */ }
      await writeFile(target, safe, { mode: 0o600, flag: 'wx' });
      files[`agent/${name}`] = target;
    }
  }
  await visit(source, '');
  return { files, violations };
}

/** Retains reviewable fictional evidence, never account/session tables or runtime credentials. */
export async function writeAuthorityArtifacts(before: FixtureSnapshot, after: FixtureSnapshot, directory: string, redactor: TraceRedactor): Promise<Record<string, string>> {
  const sourceSnapshot = path.join(directory, 'public-source-snapshot.json');
  const pmAuthoritySnapshot = path.join(directory, 'pm-authority-snapshot.json');
  const decode = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([name, value]) => [name, redactor.text(Buffer.from(value, 'base64').toString('utf8'))]));
  await writeFile(sourceSnapshot, JSON.stringify(redactor.value({ encoding: 'utf8-redacted', before: { fixtureId: before.fixtureId, semanticHash: before.semanticHash, files: decode(before.publicFiles) }, after: { fixtureId: after.fixtureId, semanticHash: after.semanticHash, files: decode(after.publicFiles) } }), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await writeFile(pmAuthoritySnapshot, JSON.stringify(redactor.value({ before: { entities: before.entities, receipts: before.receipts }, after: { entities: after.entities, receipts: after.receipts } }), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { sourceSnapshot, pmAuthoritySnapshot };
}

/** A reproducible patch from trusted captured bytes, without invoking untrusted Git config. */
export function repositoryDiff(before: FixtureSnapshot, after: FixtureSnapshot): string {
  const names = [...new Set([...Object.keys(before.publicFiles), ...Object.keys(after.publicFiles)])].filter(name => name.startsWith('repo/') && !name.includes('/.git/')).sort();
  const patches: string[] = [];
  for (const name of names) {
    const previous = before.publicFiles[name], next = after.publicFiles[name];
    if (previous === next) continue;
    const oldLines = previous === undefined ? [] : Buffer.from(previous, 'base64').toString('utf8').replace(/\n$/, '').split('\n');
    const newLines = next === undefined ? [] : Buffer.from(next, 'base64').toString('utf8').replace(/\n$/, '').split('\n');
    patches.push(`diff --git a/${name} b/${name}\n--- ${previous === undefined ? '/dev/null' : `a/${name}`}\n+++ ${next === undefined ? '/dev/null' : `b/${name}`}\n@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@\n${oldLines.map(line => `-${line}\n`).join('')}${newLines.map(line => `+${line}\n`).join('')}`);
  }
  return patches.join('');
}
