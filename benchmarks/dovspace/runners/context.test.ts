import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FixtureHandle } from '../schemas/types.ts';
import { materializeKnowledge, materializeResumeContext, materializeStageBrief } from './context.ts';
import { referenceCase, materializeReference } from '../calibration/reference.ts';
import { resolveTaskDefinition } from '../tasks/index.ts';

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

test('retrieval carries current source hashes and marks a changed indexed source stale rather than valid', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dovspace-source-version-'));
  try {
    await mkdir(path.join(root, 'docs'));
    await writeFile(path.join(root, 'docs/source.md'), '# Policy\n\nAccepted retention policy.\n');
    await materializeKnowledge({ publicRoot: root } as FixtureHandle, 'run', 'knowledge');
    await writeFile(path.join(root, 'docs/source.md'), '# Policy\n\nThe policy was superseded.\n');
    const response = await promisify(execFile)(process.execPath, [path.join(root, '.dovspace/search.mjs'), 'retention'], { cwd: root });
    const search = JSON.parse(response.stdout) as { version: number; results: { validity: string; currentHash: string; contentHash: string }[] };
    assert.equal(search.version, 2);
    assert.ok(search.results.length > 0);
    assert.ok(search.results.every(result => result.validity === 'stale' && result.currentHash !== result.contentHash));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dovspace source-stage and recovery context contain own provenance and unknown operations, not copied chat or fabricated product responses', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dovspace-stage-context-'));
  try {
    const input = referenceCase('D04', root);
    const task = resolveTaskDefinition('D04', input.fixture);
    await materializeReference(input);
    for (const arm of ['raw', 'knowledge'] as const) {
      assert.deepEqual(await materializeStageBrief(input.fixture, 'run', arm, task, 'analysis', input.before), []);
      assert.deepEqual(await materializeResumeContext(input.fixture, 'run', arm, 'old-session', {}, input.after), []);
    }
    await materializeStageBrief(input.fixture, 'run', 'dovspace', task, 'recovery', input.after);
    const stage = JSON.parse(await readFile(path.join(input.fixture.publicRoot, '.dovspace/stage-brief.json'), 'utf8')) as { schemaVersion: number; kind: string; stage: string; acceptanceCriteria: string[]; sources: { path: string; validity: string }[] };
    assert.equal(stage.schemaVersion, 2);
    assert.equal(stage.kind, 'bench-source-stage-brief');
    assert.equal(stage.stage, 'recovery');
    assert.deepEqual(stage.acceptanceCriteria, input.task.acceptanceCriteria);
    assert.ok(stage.sources.every(source => source.path.startsWith('docs/') && source.validity === 'needs_review'));
    await materializeResumeContext(input.fixture, 'run', 'dovspace', 'old-session', { operationId: 'reference-partial-write', targetId: input.fixture.targets['atlas-code']!.entityId }, input.after);
    const recovery = JSON.parse(await readFile(path.join(input.fixture.publicRoot, '.dovspace/resume-context.json'), 'utf8')) as { version: number; operations: { identity: string; state: string }[]; evidence: { status: string }; conversation?: unknown };
    assert.equal(recovery.version, 2);
    assert.deepEqual(recovery.operations.map(operation => [operation.identity, operation.state]), [['reference-partial-write', 'unknown']]);
    assert.equal(recovery.evidence.status, 'unknown');
    assert.equal(recovery.conversation, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
