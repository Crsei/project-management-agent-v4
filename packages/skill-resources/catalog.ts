import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

/** Canonical authoring files, also preserved at these paths in installed resources. */
export const BUNDLED_PM_SKILLS = Object.freeze([
  { id: 'pm-requirement-review', sourcePath: '.agents/skills/pm-requirement-review/SKILL.md' },
  { id: 'pm-plan-draft', sourcePath: '.agents/skills/pm-plan-draft/SKILL.md' },
  { id: 'pm-evidence-review', sourcePath: '.agents/skills/pm-evidence-review/SKILL.md' },
  { id: 'pm-project-digest', sourcePath: '.agents/skills/pm-project-digest/SKILL.md' },
  { id: 'pm-collaboration-review', sourcePath: '.agents/skills/pm-collaboration-review/SKILL.md' },
  { id: 'pm-automation-candidate-review', sourcePath: '.agents/skills/pm-automation-candidate-review/SKILL.md' },
  { id: 'project-management', sourcePath: 'plugins/dovspace-pm/skills/project-management/SKILL.md' },
  { id: 'issue-management', sourcePath: 'plugins/dovspace-pm/skills/issue-management/SKILL.md' },
  { id: 'task-planning', sourcePath: 'plugins/dovspace-pm/skills/task-planning/SKILL.md' },
].map(skill => Object.freeze(skill)));

export const BUNDLED_PM_DISTRIBUTION_INPUTS = Object.freeze([
  'plugins/dovspace-pm/plugin.json',
  'plugins/dovspace-pm/LICENSE',
  'plugins/dovspace-pm/README.md',
]);

const resourcePaths = new Set([...BUNDLED_PM_SKILLS.map(skill => skill.sourcePath), ...BUNDLED_PM_DISTRIBUTION_INPUTS]);

/** Only reviewed resources: no directory traversal, links, devices or unbounded reads. */
export async function readBundledPmResource(root: string, sourcePath: string): Promise<string> {
  if (!path.isAbsolute(root) || !resourcePaths.has(sourcePath)) throw new Error('Invalid bundled PM resource path.');
  let current = path.resolve(root);
  for (const part of ['', ...sourcePath.split('/').slice(0, -1)]) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe bundled PM resource directory: ${sourcePath}`);
  }
  const canonicalRoot = await realpath(root);
  const filename = path.join(root, sourcePath);
  const canonicalFile = await realpath(filename);
  if (!canonicalFile.startsWith(canonicalRoot + path.sep)) throw new Error(`Escaping bundled PM resource: ${sourcePath}`);
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`Unsafe bundled PM resource file: ${sourcePath}`);
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > 8 * 1024 * 1024 || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new Error(`Not a bounded regular bundled PM resource: ${sourcePath}`);
    }
    const bytes = await handle.readFile();
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!Buffer.from(content).equals(bytes)) throw new Error(`Noncanonical UTF-8 bundled PM resource: ${sourcePath}`);
    return content;
  } finally { await handle.close(); }
}

export async function readBundledPmSkills(root: string) {
  return Promise.all(BUNDLED_PM_SKILLS.map(async descriptor => {
    const content = await readBundledPmResource(root, descriptor.sourcePath);
    const metadata = /^---\r?\nname: ([a-z0-9]+(?:-[a-z0-9]+)*)\r?\ndescription: ([^\r\n]{1,1024})\r?\n(?:(?:license|compatibility): [^\r\n]+\r?\n)*---\r?\n/.exec(content);
    if (!metadata || metadata[1] !== descriptor.id || !metadata[2]?.trim()) throw new Error(`Invalid bundled PM Skill metadata: ${descriptor.sourcePath}`);
    return { ...descriptor, name: descriptor.id, description: metadata[2], content, sha256: createHash('sha256').update(content).digest('hex') };
  }));
}

/** Packaging and installed-resource checks share the exact, narrow runtime closure. */
export async function readBundledPmResources(root: string): Promise<Map<string, string>> {
  const files = new Map((await readBundledPmSkills(root)).map(skill => [skill.sourcePath, skill.content]));
  for (const sourcePath of BUNDLED_PM_DISTRIBUTION_INPUTS) files.set(sourcePath, await readBundledPmResource(root, sourcePath));
  return files;
}
