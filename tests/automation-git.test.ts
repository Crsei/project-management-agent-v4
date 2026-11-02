import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { it } from 'node:test';
import { automationGitConfigSchema } from '../packages/contracts/src/automation-git-sync.ts';
import { createConfiguredAutomationGitPort } from '../packages/infrastructure/src/automation-git.ts';

const execute = promisify(execFile);
it('performs real dedicated-checkout local Git sync and reconciles an accepted commit without a second push', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pm-automation-git-test-'));
  try {
    const remote = join(root, 'remote.git'), dedicated = join(root, 'dedicated');
    await execute('git', ['init', '--bare', '--initial-branch=main', remote], { env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    const port = createConfiguredAutomationGitPort({ PATH: process.env.PATH, PM_AUTOMATION_GIT_ROOT: dedicated, PM_AUTOMATION_GIT_LOCAL_REMOTE_ROOT: root });
    const config = automationGitConfigSchema.parse({ projectId: 'PRJ-001', enabled: false, repository: pathToFileURL(remote).href, branch: 'main', path: 'automations', authorName: 'Isolated fixture', authorEmail: 'fixture@example.test', intervalSeconds: 0, encryptionEnabled: false });
    const context = { id: randomUUID(), config, token: null };
    assert.equal((await port.check(context)).remoteCommit, null);
    const files = { 'automations/fixture.automation-bundle.json': '{"real":"fixture-definition"}' };
    const initial = await port.read(context), commit = await port.prepare(context, initial.remoteCommit, files, randomUUID());
    await port.push(context, initial.remoteCommit, commit);
    assert.equal(await port.reconcile(context, commit), true);
    const synchronized = await port.read(context);
    assert.equal(synchronized.remoteCommit, commit); assert.deepEqual(synchronized.files, files);
    const second = await port.prepare(context, commit, { ...files, 'automations/second.automation-bundle.json': '{"second":true}' }, randomUUID());
    await port.push(context, commit, second);
    assert.equal(await port.reconcile(context, commit), true, 'accepted ancestor remains reconciled after remote advances');
    assert.match(await readFile(join(dedicated, context.id, '.pm-automation-git'), 'utf8'), new RegExp(context.id));
    const conflicting = await port.prepare(context, commit, { ...files, 'automations/conflict.automation-bundle.json': '{"conflict":true}' }, randomUUID());
    await assert.rejects(port.push(context, commit, conflicting), /rejected|failed/, 'stale compare-and-swap never overwrites another head');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('refuses adopting any nonempty preexisting checkout directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pm-automation-git-safety-'));
  try {
    const dedicated = join(root, 'dedicated'), id = randomUUID(); await mkdir(join(dedicated, id), { recursive: true }); await writeFile(join(dedicated, id, 'business-file'), 'must remain unchanged');
    const port = createConfiguredAutomationGitPort({ PM_AUTOMATION_GIT_ROOT: dedicated, PM_AUTOMATION_GIT_LOCAL_REMOTE_ROOT: root });
    const config = automationGitConfigSchema.parse({ projectId: 'PRJ-001', enabled: false, repository: pathToFileURL(join(root, 'remote.git')).href, branch: 'main', path: 'automations', authorName: 'Fixture', authorEmail: 'fixture@example.test', intervalSeconds: 0, encryptionEnabled: false });
    await assert.rejects(port.check({ id, config, token: null }), /nonempty/);
    assert.equal(await readFile(join(dedicated, id, 'business-file'), 'utf8'), 'must remain unchanged');
    assert.equal(automationGitConfigSchema.safeParse({ ...config, repository: 'https://user:private@example.test/repo' }).success, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
