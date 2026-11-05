import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { defaultAgentDirectory, type AgentDirectoryConfiguration } from '../packages/application/src/agent-storage.ts';
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

it('preflights default creation without writes and rejects missing parents, symlinks and traversal', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pm-chat-root-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const config: AgentDirectoryConfiguration = { enabled: false, dataRoot: root, defaultParent: null, allowedRoots: [], backupRoot: root, coreRoot: root, chatSpaceRoot: path.join(root, '.pmv4') };
  const scope = { workspaceId: randomUUID(), projectId: null, actorId: randomUUID() };
  const expected = path.join(config.chatSpaceRoot, 'workspaces', scope.workspaceId, 'workspace');
  assert.equal(defaultAgentDirectory(config, config.chatSpaceRoot, scope), expected);
  assert.throws(() => lstatSync(config.chatSpaceRoot), { code: 'ENOENT' });
  assert.equal(defaultAgentDirectory(config, config.chatSpaceRoot, scope, true), expected);
  assert.ok(lstatSync(expected).isDirectory());
  assert.throws(() => defaultAgentDirectory(config, config.chatSpaceRoot, { ...scope, projectId: '../escape' }, true));
  assert.throws(() => defaultAgentDirectory(config, config.chatSpaceRoot, { ...scope, workspaceId: '../escape' }, true));
  const absent = { ...config, chatSpaceRoot: path.join(root, 'missing-mount', '.pmv4') };
  assert.throws(() => defaultAgentDirectory(absent, absent.chatSpaceRoot, scope, true), { code: 'ENOENT' });
  assert.throws(() => lstatSync(path.join(root, 'missing-mount')), { code: 'ENOENT' });
  const target = path.join(root, 'target'); mkdirSync(target);
  const link = path.join(root, 'linked'); symlinkSync(target, link, 'dir');
  const unsafe = { ...config, chatSpaceRoot: path.join(link, '.pmv4') };
  assert.throws(() => defaultAgentDirectory(unsafe, unsafe.chatSpaceRoot, scope, true));
  assert.throws(() => lstatSync(path.join(target, '.pmv4')), { code: 'ENOENT' });
  assert.throws(() => defaultAgentDirectory({ ...config, chatSpaceRoot: '/etc/chat-space' }, '/etc/chat-space', scope, true));
});

it('defaults Chat Space to the API user home without changing local project defaults', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pm-chat-config-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { LOCAL_PROJECT_CONFIG: path.join(root, 'absent.json') };
  const defaults = runtimeConfig(env);
  assert.equal(defaults.chatSpaceRoot, path.join(homedir(), '.pmv4'));
  assert.equal(defaults.localProjects.defaultParent, null);
  assert.equal(runtimeConfig({ ...env, PM_CHAT_SPACE_ROOT: path.join(root, 'chat') }).chatSpaceRoot, path.join(root, 'chat'));
});
