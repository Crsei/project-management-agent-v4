import { z } from 'zod';
import type { FileRecord } from '../pm-schema/index.ts';
import { FileRepository, maxRepositoryFileBytes, revisionOf } from './repository.ts';

const snapshotSchema = z.strictObject({ revision: z.string().regex(/^[a-f0-9]{64}$/), body: z.string().nullable(), raw: z.string(), metadata: z.record(z.string(), z.unknown()).nullable() });
export type CoreChangeSnapshot = z.infer<typeof snapshotSchema>;
const manifestSchema = z.strictObject({ key: z.string().regex(/^[a-f0-9]{64}$/), checksum: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().min(1).max(64 * 1024 * 1024), parts: z.number().int().min(1).max(256) });
const directory = '.pm/state/change-snapshots';
const chunkCharacters = 256 * 1024;

/** Exact observed bytes; stale projections cannot describe the retained endpoint. */
export function coreChangeSnapshot(file: FileRecord): CoreChangeSnapshot {
  if (file.stale || file.error) return { revision: file.revision, body: null, raw: file.raw, metadata: null };
  const { body, links: _links, checklist: _checklist, views: _views, ...metadata } = file.entity;
  return { revision: file.revision, body, raw: file.raw, metadata };
}

/** Publish immutable chunks before the observation/journal may reference their manifest. */
export function retainCoreSnapshot(repository: FileRepository, file: FileRecord): string {
  const snapshot = coreChangeSnapshot(file), key = revisionOf(JSON.stringify([file.revision, snapshot.metadata])), manifestPath = `${directory}/${key}.json`;
  try {
    const manifest = manifestSchema.parse(JSON.parse(repository.read(manifestPath)));
    if (manifest.key !== key) throw new Error('Snapshot manifest identity mismatch');
    return key;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  repository.mkdir(directory);
  const serialized = JSON.stringify(snapshot);
  let parts = 0;
  for (let offset = 0; offset < serialized.length;) {
    let end = Math.min(serialized.length, offset + chunkCharacters);
    const last = serialized.charCodeAt(end - 1);
    if (end < serialized.length && last >= 0xd800 && last <= 0xdbff) end--;
    const chunk = serialized.slice(offset, end), path = `${directory}/${key}-${parts}.txt`;
    try { if (repository.read(path) !== chunk) throw new Error('Immutable snapshot chunk conflicts with retained bytes'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; repository.write(path, chunk); }
    offset = end; parts++;
  }
  const manifest = manifestSchema.parse({ key, checksum: revisionOf(serialized), bytes: Buffer.byteLength(serialized, 'utf8'), parts });
  repository.write(manifestPath, JSON.stringify(manifest));
  return key;
}

/** Hydrate only selected endpoints. Missing/corrupt history is never rebuilt from the current file. */
export function readCoreSnapshot(root: string, key: string): CoreChangeSnapshot {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid snapshot reference');
  const repository = new FileRepository(root), manifest = manifestSchema.parse(JSON.parse(repository.read(`${directory}/${key}.json`)));
  if (manifest.key !== key) throw new Error('Snapshot manifest identity mismatch');
  const chunks: string[] = [];
  let bytes = 0;
  for (let index = 0; index < manifest.parts; index++) {
    const chunk = repository.read(`${directory}/${key}-${index}.txt`);
    bytes += Buffer.byteLength(chunk, 'utf8');
    if (chunk.length > chunkCharacters || bytes > manifest.bytes) throw new Error('Invalid snapshot chunk size');
    chunks.push(chunk);
  }
  const serialized = chunks.join('');
  if (bytes !== manifest.bytes || revisionOf(serialized) !== manifest.checksum) throw new Error('Snapshot checksum mismatch');
  const snapshot = snapshotSchema.parse(JSON.parse(serialized));
  if (Buffer.byteLength(snapshot.raw, 'utf8') > maxRepositoryFileBytes || snapshot.body !== null && Buffer.byteLength(snapshot.body, 'utf8') > maxRepositoryFileBytes || revisionOf(snapshot.raw) !== snapshot.revision || revisionOf(JSON.stringify([snapshot.revision, snapshot.metadata])) !== key) throw new Error('Invalid snapshot endpoint identity');
  return snapshot;
}
