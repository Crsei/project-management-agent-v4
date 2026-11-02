import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, mkdir, rm, symlink, realpath, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { TaskCodeDelivery } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import { commitTree, git, githubRepository, prepareWorktree, readTree, reconcileCommit, testTree, verifyWorktree } from './git.ts';

test('GitHub remotes reject credential-bearing URLs, arbitrary hosts and local paths', () => {
  assert.deepEqual(githubRepository('https://github.com/owner/repo.git'), { owner: 'owner', repo: 'repo' });
  assert.deepEqual(githubRepository('git@github.com:owner/repo.git'), { owner: 'owner', repo: 'repo' });
  for (const remote of ['https://token@github.com/o/r', 'https://github.com.evil/o/r', '/tmp/repo', 'git@other:o/r', 'https://github.com/o/..', 'https://github.com/o/r?token=x']) assert.throws(() => githubRepository(remote));
});

test('real isolated worktree, content-bound tests, exact staged commit, lost-commit recovery and repository identity', async () => {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pm-delivery-git-')));
  const root = path.join(temp, 'repo'), directory = path.join(temp, 'worktree');
  try {
    await mkdir(root); await git(root, 'init', '-b', 'main');
    await git(root, 'config', 'user.name', 'Delivery Test'); await git(root, 'config', 'user.email', 'test@example.invalid');
    await writeFile(path.join(root, 'README.md'), 'base\n'); await git(root, 'add', 'README.md'); await git(root, 'commit', '-m', 'base');
    await git(root, 'remote', 'add', 'origin', 'https://github.com/example/test.git');
    const baseSha = (await git(root, 'rev-parse', 'HEAD')).trim();
    await git(root, 'worktree', 'add', '-b', 'codex/task-001', directory, baseSha);
    await writeFile(path.join(root, 'README.md'), 'user uncommitted content\n');
    const stat = await lstat(directory);
    const v: TaskCodeDelivery = { id: 'test-delivery', workspaceId: 'workspace', projectId: 'PRJ-001', taskId: 'TASK-001', taskRevision: 'rev', title: 'Example', description: '', baseBranch: 'main', createdAt: 'now', updatedAt: 'now', version: 1, step: 'developed', threadId: 'thread', git: { root, directory, directoryIdentity: `${stat.dev}:${stat.ino}`, commonDirectory: path.join(root, '.git'), remote: 'https://github.com/example/test.git', owner: 'example', repo: 'test', baseBranch: 'main', baseSha, branch: 'codex/task-001' } };
    await verifyWorktree(v);
    await writeFile(path.join(directory, 'new file.ts'), 'export const answer = 42;\n');
    await writeFile(path.join(directory, 'README.md'), 'updated\n');
    const before = await readTree(v);
    await git(directory, 'add', '--', 'new file.ts');
    const staged = await readTree(v);
    assert.equal(staged.fingerprint, before.fingerprint, 'staging must not invalidate test evidence');
    const result = await testTree(v, 'test -f "new file.ts"'); assert.equal(result.exitCode, 0);
    assert.equal(result.outputDigest.length, 64);
    v.test = { command: 'test -f "new file.ts"', fingerprint: before.fingerprint, passed: true, ...result, at: 'now' };
    v.pending = { action: 'commit', at: 'now', head: before.head, fingerprint: before.fingerprint };
    const head = await commitTree(v);
    assert.notEqual(head, baseSha); assert.equal((await readTree(v)).files.length, 0);
    assert.equal(await reconcileCommit(v), head);
    assert.equal(await readFile(path.join(root, 'README.md'), 'utf8'), 'user uncommitted content\n');
    assert.equal((await git(root, 'branch', '--show-current')).trim(), 'main');
    await writeFile(path.join(directory, '.env'), 'NOT_A_SECRET_TEST_FIXTURE');
    await assert.rejects(readTree(v), /私有/); await rm(path.join(directory, '.env'));
    await symlink(path.join(root, 'README.md'), path.join(directory, 'escape.txt'));
    await assert.rejects(readTree(v), /普通文件/); await rm(path.join(directory, 'escape.txt'));
    await git(directory, 'checkout', '--detach', 'HEAD');
    await assert.rejects(verifyWorktree(v), /已改变/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});


test('production worktree preparation pins fetched base and leaves dirty source untouched (transport fixture only)', async () => {
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pm-delivery-prepare-')));
  const original = process.env.AGENT_WORKSPACE_DATA_DIR;
  try {
    const root = path.join(temp, 'repo'); await mkdir(root);
    process.env.AGENT_WORKSPACE_DATA_DIR = path.join(temp, 'data');
    await git(root, 'init', '-b', 'main'); await git(root, 'config', 'user.name', 'Test'); await git(root, 'config', 'user.email', 'test@example.invalid');
    await writeFile(path.join(root, 'base.txt'), 'base'); await git(root, 'add', 'base.txt'); await git(root, 'commit', '-m', 'base');
    await git(root, 'remote', 'add', 'origin', 'https://github.com/example/test.git');
    await writeFile(path.join(root, 'base.txt'), 'user dirty');
    const receipt = await prepareWorktree({ id: 'fixture-id', taskId: 'TASK-001' } as TaskCodeDelivery, root, 'main', (cwd, ...args) => args[0] === 'fetch' ? git(cwd, '-c', 'protocol.file.allow=always', 'fetch', '--no-tags', root, 'refs/heads/main') : git(cwd, ...args));
    assert.equal(await readFile(path.join(receipt.directory, 'base.txt'), 'utf8'), 'base');
    assert.equal(await readFile(path.join(root, 'base.txt'), 'utf8'), 'user dirty');
    await verifyWorktree({ git: receipt } as TaskCodeDelivery);
    await assert.rejects(prepareWorktree({ id: 'other', taskId: 'TASK-001' } as TaskCodeDelivery, receipt.directory + '/missing', 'main'));
  } finally { if (original === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = original; await rm(temp, { recursive: true, force: true }); }
});
