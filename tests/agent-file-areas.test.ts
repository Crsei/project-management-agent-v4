import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { agentAllowedDirectory, resolveAgentDirectory, type AgentDirectoryConfiguration } from '../packages/application/src/agent-storage.ts';
import { runtimeConfig } from '../packages/infrastructure/src/runtime-config.ts';
import { agentFileAreaUpdateSchema, agentScopeSchema } from '../packages/contracts/src/agent-file-areas.ts';

it('requires explicit two-level scope, strict LocalDirectory and a nonnegative configuration revision', () => {
  const workspaceId = randomUUID();
  assert.deepEqual(agentScopeSchema.parse({ workspaceId, projectId: null }), { workspaceId, projectId: null });
  assert.equal(agentScopeSchema.safeParse({ workspaceId }).success, false);
  assert.equal(agentScopeSchema.safeParse({ workspaceId, projectId: 'TASK-1' }).success, false);
  assert.equal(agentScopeSchema.safeParse({ workspaceId, projectId: 'PRJ-1', path: '/untrusted-browser-cwd' }).success, false);
  for (const directory of [{ mode: 'existing', path: '/trusted/code' }, { mode: 'new', parentPath: '/trusted', folderName: 'code' }]) {
    assert.equal(agentFileAreaUpdateSchema.safeParse({ directory, expectedRevision: 0 }).success, true);
    assert.equal(agentFileAreaUpdateSchema.safeParse({ directory }).success, false);
    assert.equal(agentFileAreaUpdateSchema.safeParse({ directory, expectedRevision: -1 }).success, false);
    assert.equal(agentFileAreaUpdateSchema.safeParse({ directory, expectedRevision: 0.5 }).success, false);
    assert.equal(agentFileAreaUpdateSchema.safeParse({ directory, expectedRevision: 0, writersStopped: true }).success, false);
  }
  assert.equal(agentFileAreaUpdateSchema.safeParse({ directory: { mode: 'new', parentPath: '/trusted', folderName: '../escape' }, expectedRevision: 0 }).success, false);
});

it('PM storage selection requires existing parents and never allocates an Agent cwd', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pm-storage-root-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const config: AgentDirectoryConfiguration = { enabled: false, dataRoot: root, defaultParent: null, allowedRoots: [], backupRoot: root, coreRoot: root, chatSpaceRoot: path.join(root, '.pmv4') };
  assert.throws(() => agentAllowedDirectory(config, config.chatSpaceRoot), { code: 'ENOENT' });
  assert.throws(() => lstatSync(config.chatSpaceRoot), { code: 'ENOENT' });
  mkdirSync(config.chatSpaceRoot);
  const proposed = resolveAgentDirectory(config, { mode: 'new', parentPath: config.chatSpaceRoot, folderName: 'documents' });
  assert.equal(proposed.root, path.join(config.chatSpaceRoot, 'documents'));
  assert.throws(() => lstatSync(proposed.root), { code: 'ENOENT' });
  assert.throws(() => resolveAgentDirectory(config, { mode: 'new', parentPath: config.chatSpaceRoot, folderName: '../escape' }));
  const target = path.join(root, 'target'); mkdirSync(target);
  const link = path.join(config.chatSpaceRoot, 'linked'); symlinkSync(target, link, 'dir');
  assert.throws(() => agentAllowedDirectory(config, link));
  assert.throws(() => agentAllowedDirectory(config, path.join(config.chatSpaceRoot, 'missing', 'child')), { code: 'ENOENT' });
});

it('defaults Chat Space to the API user home without changing local project defaults', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pm-chat-config-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { LOCAL_PROJECT_CONFIG: path.join(root, 'absent.json') };
  const defaults = runtimeConfig(env);
  assert.equal(defaults.chatSpaceRoot, path.join(homedir(), '.pmv4'));
  assert.equal(defaults.localProjects.defaultParent, null);
  assert.equal(runtimeConfig({ ...env, PM_CHAT_SPACE_ROOT: path.join(root, 'chat') }).chatSpaceRoot, path.join(root, 'chat'));
});
