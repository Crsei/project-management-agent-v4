import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { FixtureHandle } from '../schemas/types.ts';
import { materializeKnowledge } from './context.ts';

test('knowledge/full index every original source passage; raw receives no generated structure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dovspace-context-'));
  const fixture = { publicRoot: root } as FixtureHandle;
  try {
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'docs', 'old.md'), '# Proposal\n\nOld fact is 90.\n');
    await writeFile(path.join(root, 'docs', 'new.md'), '# Decision\n\nCurrent fact is 30.\n');
    assert.deepEqual(await materializeKnowledge(fixture, 'r', 'raw'), []);
    const events = await materializeKnowledge(fixture, 'r', 'knowledge');
    const content = await readFile(path.join(root, '.dovspace', 'knowledge-index.json'), 'utf8');
    const index = JSON.parse(content) as { passages: { path: string; text: string }[] };
    assert.ok(index.passages.some(passage => passage.path === 'docs/old.md' && passage.text.includes('90')));
    assert.ok(index.passages.some(passage => passage.path === 'docs/new.md' && passage.text.includes('30')));
    assert.equal(events.find(event => event.data.path === '.dovspace/knowledge-index.json')?.data.sha256, createHash('sha256').update(content).digest('hex'));
    assert.equal((await materializeKnowledge(fixture, 'r', 'dovspace'))[0]?.data.sha256, events[0]?.data.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('generated context never truncates an outside file through a malicious directory symlink', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dovspace-context-link-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'dovspace-outside-'));
  try {
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'docs', 'source.md'), '# Source\n\nFictional text.\n');
    const protectedFile = path.join(outside, 'knowledge-index.json');
    await writeFile(protectedFile, 'keep this authority');
    await symlink(outside, path.join(root, '.dovspace'));
    await assert.rejects(materializeKnowledge({ publicRoot: root } as FixtureHandle, 'r', 'knowledge'));
    assert.equal(await readFile(protectedFile, 'utf8'), 'keep this authority');
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
