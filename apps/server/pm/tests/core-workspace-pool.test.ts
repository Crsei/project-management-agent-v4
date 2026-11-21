import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { Workspace } from '../../../../packages/pm-core/index.ts';
import { CoreWorkspacePool } from '../src/routes/core-routes.ts';

function instrument(workspace: Workspace, gate: Promise<void>): { scans: () => number } {
  let scans = 0;
  const patched: Pick<Workspace, 'rescan'> = workspace;
  const original = workspace.rescan.bind(workspace);
  patched.rescan = async (reason?: string) => {
    scans++;
    // Hold the first scan open until every concurrent acquisition has joined it.
    if (scans === 1) await gate;
    await original(reason);
  };
  return { scans: () => scans };
}

async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index++) await Promise.resolve();
}

test('concurrent workspace acquisitions share one refresh scan', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'pm-core-pool-'));
  const root = path.join(base, 'workspaces');
  const workspaceId = '0196c319-8b1d-7000-8000-000000000001';
  const initial = new Workspace(path.join(root, workspaceId));
  await initial.init();
  await initial.close();
  const pool = new CoreWorkspacePool(root);
  const gate = Promise.withResolvers<void>();
  try {
    const workspace = await pool.get(workspaceId);
    const rescans = instrument(workspace, gate.promise);
    const burst = Promise.all(Array.from({ length: 24 }, () => pool.get(workspaceId)));
    await flushMicrotasks();
    assert.equal(rescans.scans(), 1, 'only one scan starts for the burst');
    gate.resolve();
    await burst;
    assert.equal(rescans.scans(), 1, 'a burst must not queue one full scan per caller');

    mock.timers.enable({ apis: ['Date'], now: Date.now() + 150 });
    await pool.get(workspaceId);
    assert.equal(rescans.scans(), 2, 'a later acquisition still refreshes the projection');
  } finally {
    mock.timers.reset();
    await pool.close();
    await rm(base, { recursive: true, force: true });
  }
});
