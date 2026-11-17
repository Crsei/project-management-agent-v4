import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TaskCodeDelivery } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import { git, readTree } from './git.ts';
import { assertLocalVerifier, localTestArguments, runLocalVerification, testCounts } from './local-verification.ts';

const summary = '# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
test('TAP counts require exactly one complete integer summary; sandbox exposes no home/repository or external network', () => {
  assert.deepEqual(testCounts(summary), { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  for (const text of ['', '# tests 2', summary + '# pass 2\n', summary.replace('tests 2', 'tests 1.5')]) assert.equal(testCounts(text), null);
  const args = localTestArguments('/owned-snapshot');
  assert.ok(args.includes('--unshare-all')); assert.ok(args.includes('--clearenv')); assert.ok(!args.includes('--share-net'));
  assert.ok(!args.includes('/home')); assert.ok(!args.includes('/root'));
});

test('unsupported hosts reject local execution instead of running unisolated', { skip: process.platform === 'linux' }, async () => {
  await assert.rejects(assertLocalVerifier(), /Linux/);
});

test('real Linux isolated immutable commit runs HTTP/SQLite without host files, secrets or external network; failures/skips fail closed', { timeout: 120_000, skip: process.platform !== 'linux' && 'requires Linux bubblewrap' }, async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'pm-local-fixture-')));
  const sentinel = `${root}-host-sentinel`;
  try {
    await writeFile(sentinel, 'sentinel');
    await git(root, 'init', '-b', 'codex/local-test');
    await git(root, 'config', 'user.name', 'Test'); await git(root, 'config', 'user.email', 'test@example.invalid');
    await git(root, 'remote', 'add', 'origin', 'https://github.com/example/fixture.git');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test fixture.test.mjs' } }));
    const source = `import { test } from 'node:test'; import assert from 'node:assert/strict'; import { readFile, writeFile } from 'node:fs/promises'; import { createServer } from 'node:http'; import { once } from 'node:events'; import { DatabaseSync } from 'node:sqlite';
    test('isolated', async () => {
      await assert.rejects(readFile(${JSON.stringify(sentinel)})); await assert.rejects(readFile('/app/.git/config'));
      await assert.rejects(readFile('/app/.env')); assert.equal(process.env.PM_LOCAL_FIXTURE_SECRET, undefined);
      const db = new DatabaseSync('/tmp/test.db'); db.exec('CREATE TABLE items (id INTEGER)'); db.close();
      const server = createServer((_req,res) => res.end('ok')); server.listen(0,'127.0.0.1'); await once(server,'listening');
      try { assert.equal(await (await fetch('http://127.0.0.1:'+server.address().port)).text(),'ok'); } finally { server.closeAllConnections(); await new Promise(r=>server.close(r)); }
      await assert.rejects(fetch('http://192.0.2.1:9', { signal: AbortSignal.timeout(250) }));
      await writeFile('/app/fixture.test.mjs','sandbox mutation only');
    });`;
    await writeFile(path.join(root, 'fixture.test.mjs'), source);
    await git(root, 'add', 'package.json', 'fixture.test.mjs'); await git(root, 'commit', '-m', 'fixture');
    const stat = await lstat(root), head = (await git(root, 'rev-parse', 'HEAD')).trim();
    const v = { git: { root, directory: root, directoryIdentity: `${stat.dev}:${stat.ino}`, commonDirectory: path.join(root, '.git'), branch: 'codex/local-test', remote: 'https://github.com/example/fixture.git' } } as TaskCodeDelivery;
    process.env.PM_LOCAL_FIXTURE_SECRET = 'not-a-real-credential';
    await assert.rejects(runLocalVerification({ ...v, step: 'pr', head: 'f'.repeat(40) }), /提交已变化/);
    const before = await readTree(v), result = await runLocalVerification({ ...v, step: 'pr', head });
    assert.equal(result.passed, true, JSON.stringify(result)); assert.equal(result.exitCode, 0); assert.equal(result.counts?.tests, 1);
    assert.equal(result.outputDigest.length, 64); assert.equal((await readTree(v)).fingerprint, before.fingerprint);
    assert.equal(await readFile(path.join(root, 'fixture.test.mjs'), 'utf8'), source);
    assert.equal((await git(root, 'rev-parse', 'HEAD')).trim(), head);
    for (const body of ["test.skip('skipped',()=>{});", "test('fails',()=>assert.fail('expected'));", "console.log('not a test');"]) {
      await writeFile(path.join(root, 'fixture.test.mjs'), `import { test } from 'node:test'; import assert from 'node:assert/strict'; ${body}`);
      const failed = await runLocalVerification(v);
      // A file with no cases is counted as a file test by Node; missing reports are separately rejected by parser tests.
      if (!body.startsWith('console')) assert.equal(failed.passed, false);
    }
    await symlink(sentinel, path.join(root, 'escape.txt')); await assert.rejects(runLocalVerification(v), /普通文件/);
    await rm(path.join(root, 'escape.txt'));
    await assert.rejects(runLocalVerification(v, 'curl example.com'), /仅支持/);
  } finally { delete process.env.PM_LOCAL_FIXTURE_SECRET; await rm(root, { recursive: true, force: true }); await rm(sentinel, { force: true }); }
});
