import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectArtifacts, repositoryDiff } from './artifacts.ts';
import { TraceRedactor } from './telemetry.ts';
import type { FixtureSnapshot } from '../schemas/types.ts';

test('artifact export refuses symlinks/hardlinks and redacts nested JSON secrets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dovspace-artifacts-'));
  try {
    const publicRoot = path.join(root, 'public'), output = path.join(root, 'export');
    await mkdir(path.join(publicRoot, 'artifacts'), { recursive: true });
    await mkdir(output);
    await writeFile(path.join(root, 'outside.txt'), 'private authority stays outside');
    await symlink(path.join(root, 'outside.txt'), path.join(publicRoot, 'artifacts', 'linked.txt'));
    await link(path.join(root, 'outside.txt'), path.join(publicRoot, 'artifacts', 'hardlinked.txt'));
    await writeFile(path.join(publicRoot, 'artifacts', 'answer.json'), JSON.stringify({ nested: { cookie: 'unknown-cookie-value', apiKey: 'unknown-key-value' }, summary: 'fictional result' }));
    const result = await collectArtifacts(publicRoot, output, new TraceRedactor());
    assert.equal(result.violations.length, 2);
    assert.deepEqual(Object.keys(result.files), ['agent/answer.json']);
    const safe = await readFile(result.files['agent/answer.json']!, 'utf8');
    assert.ok(!safe.includes('unknown-cookie-value'));
    assert.ok(!safe.includes('unknown-key-value'));
    assert.equal(await readFile(path.join(root, 'outside.txt'), 'utf8'), 'private authority stays outside');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('trusted tree patch includes untracked code without executing Git configuration', () => {
  const before: FixtureSnapshot = { fixtureId: 'f', fixtureVersion: 'v', capturedAt: '', semanticHash: 'before', entities: [], receipts: [], tables: {}, files: {}, publicFiles: { 'repo/src/retry.ts': Buffer.from('old\n').toString('base64') } };
  const after = structuredClone(before);
  after.publicFiles['repo/src/retry.ts'] = Buffer.from('new\n').toString('base64');
  after.publicFiles['repo/test/new.test.ts'] = Buffer.from('test\n').toString('base64');
  const patch = repositoryDiff(before, after);
  assert.ok(patch.includes('-old\n+new'));
  assert.ok(patch.includes('+++ b/repo/test/new.test.ts'));
  assert.ok(patch.includes('+test'));
});
