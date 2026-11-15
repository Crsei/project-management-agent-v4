import path from 'node:path';
import { createRetiredImportResolver } from '../../vendor/t3code/scripts/mcp-skills-adaptations.mjs';
import { file, walk } from './supplemental-fs.mjs';

// Retirement resolution must not re-open a candidate tsconfig/package.json via
// ts.sys after descriptor authentication. All compiler host probes are served
// from this finite, no-follow snapshot; no parent or node_modules fallback reads.
export async function snapshotRetiredResolver(root, retirements, ts) {
  if (!retirements.length) return () => null;
  if (typeof ts.matchFiles !== 'function') throw new Error('SUPPLEMENTAL_PARSER_PREREQUISITE: trusted TypeScript file matcher required');
  root = path.resolve(root);
  const names = await walk(root, '', { omit: ['.git', '.upstream-sync', '.local', 'node_modules'] });
  const files = new Set(names.map(name => path.join(root, name))), contents = new Map(), directories = new Set([root]);
  for (const name of names) {
    const absolute = path.join(root, name);
    if (/\.jsonc?$/i.test(name)) contents.set(absolute, (await file(root, name)).bytes.toString('utf8'));
    for (let parent = path.dirname(absolute); parent === root || parent.startsWith(root + path.sep); parent = path.dirname(parent)) {
      directories.add(parent);
      if (parent === root) break;
    }
  }
  const entries = new Map([...directories].map(directory => [directory, { files: [], directories: [] }]));
  for (const name of files) entries.get(path.dirname(name)).files.push(path.basename(name));
  for (const name of directories) if (name !== root) entries.get(path.dirname(name)).directories.push(path.basename(name));
  const empty = { files: [], directories: [] };
  const children = directory => entries.get(directory) ?? empty;
  const sys = {
    ...ts.sys,
    getCurrentDirectory: () => root,
    fileExists: name => files.has(path.resolve(name)),
    directoryExists: name => directories.has(path.resolve(name)),
    readFile: name => contents.get(path.resolve(name)),
    realpath: name => path.resolve(name),
    getDirectories: name => children(path.resolve(name)).directories.map(child => path.join(name, child)),
    readDirectory: (directory, extensions, exclude, include, depth) => ts.matchFiles(path.resolve(directory), extensions, exclude, include, true, root, depth, name => children(path.resolve(name)), name => path.resolve(name)),
  };
  const snapshotTs = Object.create(ts);
  Object.defineProperty(snapshotTs, 'sys', { value: sys });
  return createRetiredImportResolver(root, retirements, snapshotTs);
}
