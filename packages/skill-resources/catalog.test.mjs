import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BUNDLED_PM_SKILLS, BUNDLED_PM_DISTRIBUTION_INPUTS, readBundledPmResource, readBundledPmResources, readBundledPmSkills } from './catalog.ts';
import { stageBundledPmResources } from './stage.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pm-skill-resources-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'installed');
  await stageBundledPmResources(repository, output);
  return { root, output };
}
async function files(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(root, relative));
    else result.push(relative);
  }
  return result.sort();
}

test('installed closure contains exactly six analysis/review and three workflow sources plus generation inputs', async t => {
  const { output } = await fixture(t);
  const expected = [...BUNDLED_PM_SKILLS.map(skill => skill.sourcePath), ...BUNDLED_PM_DISTRIBUTION_INPUTS].sort();
  assert.equal(expected.filter(name => name.startsWith('.agents/')).length, 6);
  assert.equal(expected.filter(name => name.startsWith('plugins/') && name.endsWith('/SKILL.md')).length, 3);
  assert.deepEqual(await files(output), expected);
  assert.deepEqual([...await readBundledPmResources(output)], [...await readBundledPmResources(repository)]);
  for (const skill of await readBundledPmSkills(output)) {
    const bytes = await readFile(path.join(output, skill.sourcePath));
    assert.equal(skill.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(skill.name, skill.id);
    assert.ok(skill.description);
  }
  for (const sourcePath of expected) {
    const filename = path.join(output, sourcePath), bytes = await readFile(filename);
    await rm(filename);
    await assert.rejects(readBundledPmResources(output), { code: 'ENOENT' });
    await writeFile(filename, bytes);
  }
});

test('catalog refuses wrong metadata, invalid UTF-8, hardlinks and undeclared resource paths', async t => {
  const { root, output } = await fixture(t);
  const { sourcePath } = BUNDLED_PM_SKILLS[0];
  const filename = path.join(output, sourcePath), bytes = await readFile(filename);
  await writeFile(filename, bytes.toString().replace('name: pm-requirement-review', 'name: unexpected'));
  await assert.rejects(readBundledPmSkills(output), /metadata/);
  await writeFile(filename, Buffer.from([0xff, 0xfe]));
  await assert.rejects(readBundledPmSkills(output));
  await writeFile(filename, bytes);
  await link(filename, path.join(root, 'hardlink'));
  await assert.rejects(readBundledPmSkills(output), /resource file/);
  await rm(path.join(root, 'hardlink'));
  for (const invalid of ['../secret', '.agents/skills/upstream-source-update/SKILL.md', '.agents/skills/pm-collaboration-review/evals.json']) {
    await assert.rejects(readBundledPmResource(output, invalid), /resource path/);
  }
});

test('catalog refuses symlinked skill files and source directories', async t => {
  const { root, output } = await fixture(t);
  const { sourcePath } = BUNDLED_PM_SKILLS[0];
  const filename = path.join(output, sourcePath), moved = path.join(root, 'source.md');
  await rename(filename, moved);
  await symlink(moved, filename);
  await assert.rejects(readBundledPmSkills(output), /bundled PM resource/);
  await rm(filename);
  await rename(moved, filename);
  const directory = path.dirname(filename), outside = path.join(root, 'source-directory');
  await rename(directory, outside);
  await symlink(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readBundledPmSkills(output), /resource directory/);
});
