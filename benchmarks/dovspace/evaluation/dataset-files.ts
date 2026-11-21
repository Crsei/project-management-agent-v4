import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { repositoryRoot } from '../benchmark.config.ts';
import { prepareReportDirectory, readReportJson } from '../reports/files.ts';
import { z } from 'zod';

export const Id = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export function identifier(value: string): string {
  if (!Id.test(value) || value === '.' || value === '..') throw new Error('Expected a safe registry identifier');
  return value;
}
export function digest(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item !== null && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function reservedOutput(value: string): string {
  const base = path.resolve(repositoryRoot, 'benchmarks/dovspace');
  const absolute = path.resolve(base, value);
  const relative = path.relative(path.join(base, 'outputs'), absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Evaluation paths must be descendants of benchmarks/dovspace/outputs');
  return absolute;
}
/** Relative reproduction archives are portable descendants of the registry; traversal is never normalized away. */
export function resolveDatasetArchiveRoot(registryRoot: string, archiveRoot: string): string {
  for (let index = 0; index < archiveRoot.length; index++) if (archiveRoot.charCodeAt(index) < 32 || archiveRoot.charCodeAt(index) === 127) throw new Error('Unsafe reproduction archive path');
  if (archiveRoot.includes('\\')) throw new Error('Unsafe reproduction archive path');
  if (path.isAbsolute(archiveRoot)) return path.resolve(archiveRoot);
  if (!archiveRoot || archiveRoot.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Relative reproduction archives must be safe registry descendants');
  return path.resolve(registryRoot, archiveRoot);
}
export async function privateDirectory(directory: string): Promise<void> {
  await prepareReportDirectory(directory);
  const info = await lstat(directory);
  if ((info.mode & 0o077) !== 0) throw new Error('Evaluation registry/output directory must be private (0700)');
}
export async function exclusiveJson(file: string, value: unknown): Promise<void> {
  await privateDirectory(path.dirname(file));
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
export async function privateJson(file: string): Promise<unknown> {
  const info = await lstat(file);
  if ((info.mode & 0o077) !== 0 || info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Error('Registry input must be a private single-link regular file');
  return readReportJson(file);
}
const RegistryEventSchema = z.object({ sequence: z.number().int().positive(), previousDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(), eventId: z.uuid(), at: z.iso.datetime(), kind: z.string().min(1), data: z.unknown(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type RegistryEvent = z.infer<typeof RegistryEventSchema>;
export async function readEvents(root: string): Promise<RegistryEvent[]> {
  await privateDirectory(root);
  const directory = path.join(root, 'events');
  await privateDirectory(directory);
  const names = (await readdir(directory)).sort();
  const result: RegistryEvent[] = [];
  for (const name of names) {
    if (!/^\d{10}\.json$/.test(name)) throw new Error('Unexpected registry event filename');
    const entry = RegistryEventSchema.parse(await privateJson(path.join(directory, name)));
    const { digest: actual, ...body } = entry;
    if (entry.sequence !== result.length + 1 || entry.previousDigest !== (result.at(-1)?.digest ?? null) || actual !== digest(body) || !Id.test(entry.eventId) || !Number.isFinite(Date.parse(entry.at))) throw new Error('Registry event chain is incomplete or modified');
    result.push(entry);
  }
  return result;
}
/** A lock is deliberately not auto-recovered: an uncertain writer must be reconciled, not replayed. */
export async function mutateRegistry<T>(root: string, operation: (events: RegistryEvent[], append: (kind: string, data: unknown) => Promise<void>) => Promise<T>): Promise<T> {
  await privateDirectory(root);
  const lock = path.join(root, '.writer');
  await mkdir(lock, { mode: 0o700 });
  try {
    const events = await readEvents(root);
    const append = async (kind: string, data: unknown) => {
      const body = { sequence: events.length + 1, previousDigest: events.at(-1)?.digest ?? null, eventId: randomUUID(), at: new Date().toISOString(), kind, data };
      const event = { ...body, digest: digest(body) };
      await exclusiveJson(path.join(root, 'events', `${String(event.sequence).padStart(10, '0')}.json`), event);
      events.push(event);
    };
    return await operation(events, append);
  } finally { await rm(lock, { recursive: true }); }
}
export async function erasePrivateContent(root: string, sourceId: string): Promise<void> {
  identifier(sourceId);
  const directory = path.join(root, 'content', sourceId);
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== path.resolve(directory)) throw new Error('Unsafe feedback content directory');
  for (const name of await readdir(directory)) {
    identifier(name);
    const target = path.join(directory, name);
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await file.stat(); if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe feedback content file'); } finally { await file.close(); }
    await rm(target);
  }
  await rmdir(directory);
}
