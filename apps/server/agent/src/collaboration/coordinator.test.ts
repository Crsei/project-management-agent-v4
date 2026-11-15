import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CollaborationCoordinator } from './coordinator.ts';

test('real directory aliases share one writer and releasing a parent allows its queued child', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collaboration-writer-'));
  const alias = `${directory}-alias`;
  try {
    await symlink(directory, alias, 'dir');
    const coordinator = new CollaborationCoordinator();
    const releaseParent = await coordinator.acquire('parent', await realpath(directory), 'root', 2, new AbortController().signal);
    let childStarted = false;
    const child = coordinator.acquire('child', await realpath(alias), 'root', 2, new AbortController().signal).then(release => { childStarted = true; return release; });
    await Promise.resolve();
    assert.equal(childStarted, false);
    releaseParent();
    const releaseChild = await child;
    assert.equal(childStarted, true);
    releaseChild(); releaseChild();
  } finally { await rm(alias, { force: true }); await rm(directory, { recursive: true, force: true }); }
});

test('the root active budget does not reset for another directory and queued abort never launches', async () => {
  const coordinator = new CollaborationCoordinator();
  const release = await coordinator.acquire('first', '/one', 'root', 1, new AbortController().signal);
  const abort = new AbortController();
  const queued = coordinator.acquire('second', '/two', 'root', 1, abort.signal);
  const rejected = assert.rejects(queued, /cancelled/);
  abort.abort(new Error('cancelled while waiting'));
  await rejected;
  release();
  const subsequent = await coordinator.acquire('third', '/two', 'root', 1, new AbortController().signal);
  subsequent();
});

test('Agent concurrency applies across independent root trees without blocking another Agent', async () => {
  const coordinator = new CollaborationCoordinator();
  const release = await coordinator.acquire('one', '/one', 'root-one', 3, new AbortController().signal, { id: 'developer', maxActiveRuns: 1 });
  let secondStarted = false;
  const second = coordinator.acquire('two', '/two', 'root-two', 3, new AbortController().signal, { id: 'developer', maxActiveRuns: 1 }).then(unlock => { secondStarted = true; return unlock; });
  const reviewer = await coordinator.acquire('reviewer', '/three', 'root-three', 3, new AbortController().signal, { id: 'reviewer', maxActiveRuns: 1 });
  assert.equal(secondStarted, false);
  reviewer(); release();
  (await second)();
});
