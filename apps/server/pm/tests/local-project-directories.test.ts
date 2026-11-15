import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { allowedDirectory, listLocalDirectories, previewLocalProject, probeLocalProject, resolveLocalDirectory, toLocalDirectory, type LocalProjectConfiguration } from '../../../../packages/application/src/local-projects.ts';
import { DomainError } from '../../../../packages/domain/src/core.ts';
import { runtimeConfig } from '../../../../packages/infrastructure/src/runtime-config.ts';
import { buildApp } from '../src/app.ts';
import { agentAllowedDirectory, resolveAgentDirectory } from '../../../../packages/application/src/agent-storage.ts';
import { makePrivatePath } from '../../../../packages/pm-core/private-path.ts';
import { samePath } from '../../../../packages/pm-core/platform.ts';

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pm-local-directories-')));
  makePrivatePath(root);
  const allowed = path.join(root, 'projects'); mkdirSync(allowed);
  const config: LocalProjectConfiguration = { enabled: true, dataRoot: root, coreRoot: path.join(root, 'core'), allowedRoots: [allowed], defaultParent: allowed, backupRoot: path.join(root, 'backup') };
  return { root, allowed, config };
}
const marker = { version: 1, workspaceId: '11111111-1111-4111-8111-111111111111', projectId: 'PRJ-001', storageId: '22222222-2222-4222-8222-222222222222', core: '.pm/core', attachments: '.pm/attachments' };

test('project paths are canonical and marker-aware without an allowlist', t => {
  const { root, allowed, config } = fixture(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const code = path.join(allowed, 'existing-code'); mkdirSync(code); writeFileSync(path.join(code, 'README.md'), 'Original code\n');
  mkdirSync(path.join(allowed, '.private')); symlinkSync(root, path.join(allowed, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const listing = listLocalDirectories(config, allowed);
  assert.deepEqual(listing.directories.map(item => item.name), ['existing-code']);
  assert.equal(allowedDirectory(config, root), root, 'project storage is no longer constrained to configured roots');
  assert.equal(previewLocalProject(config, { mode: 'existing', path: code }).path, code);
  assert.equal(readFileSync(path.join(code, 'README.md'), 'utf8'), 'Original code\n');
  assert.equal(existsSync(path.join(code, '.pm')), false);
  assert.equal(existsSync(path.join(code, '.dovspace')), false);
  assert.deepEqual(previewLocalProject(config, { mode: 'existing', path: code }).creates, ['.dovspace/.pm/project.json', '.dovspace/.pm/core/projects/PRJ-<id>.md', '.dovspace/.pm/core/work-items/', '.dovspace/.pm/core/docs/', '.dovspace/.pm/attachments/']);
  assert.throws(() => allowedDirectory(config, path.join(allowed, 'escape')), (error: unknown) => error instanceof DomainError && error.code === 'local_directory_forbidden');
  assert.throws(() => resolveLocalDirectory(config, { mode: 'new', parentPath: allowed, folderName: '../escape' }));
  const plain = probeLocalProject(config, code);
  assert.equal(plain.marker, null); assert.equal(plain.markerProblem, null); assert.deepEqual(plain.directory, { mode: 'existing', path: code });
  const created = probeLocalProject(config, path.join(allowed, 'new-project'));
  assert.equal(created.exists, false); assert.deepEqual(created.directory, { mode: 'new', parentPath: allowed, folderName: 'new-project' });
  assert.equal(resolveLocalDirectory(config, { mode: 'auto', path: code }).mode, 'existing');
  assert.equal(resolveLocalDirectory(config, { mode: 'auto', path: path.join(allowed, 'auto-new') }).mode, 'new');
  assert.deepEqual(toLocalDirectory({ root: code, mode: 'existing' }), { mode: 'existing', path: code });
  assert.deepEqual(toLocalDirectory({ root: path.join(allowed, 'created'), mode: 'new' }), { mode: 'new', parentPath: allowed, folderName: 'created' });

  mkdirSync(path.join(code, '.dovspace/.pm'), { recursive: true });
  writeFileSync(path.join(code, '.dovspace/.pm/project.json'), JSON.stringify(marker));
  const detected = probeLocalProject(config, code);
  assert.deepEqual(detected.marker, { version: 1, layout: 'dovspace-v1', workspaceId: marker.workspaceId, projectId: marker.projectId, storageId: marker.storageId });
  assert.equal(detected.markerProblem, null);
  assert.throws(() => previewLocalProject(config, { mode: 'existing', path: code }), (error: unknown) => error instanceof DomainError && error.code === 'local_directory_marked');
  writeFileSync(path.join(code, '.dovspace/.pm/project.json'), '{"version":1}');
  assert.equal(probeLocalProject(config, code).markerProblem, 'invalid_marker');
  rmSync(path.join(code, '.dovspace'), { recursive: true });
  mkdirSync(path.join(code, '.dovspace'));
  assert.equal(probeLocalProject(config, code).markerProblem, 'missing_marker');
  rmSync(path.join(code, '.dovspace'), { recursive: true });
  mkdirSync(path.join(code, '.pm'));
  assert.throws(() => previewLocalProject(config, { mode: 'existing', path: code }), (error: unknown) => error instanceof DomainError && error.code === 'local_directory_marked');
});

test('missing parents and disabled deployments cannot silently create a replacement root', t => {
  const { root, allowed, config } = fixture(); t.after(() => rmSync(root, { recursive: true, force: true }));
  rmSync(allowed, { recursive: true });
  assert.throws(() => resolveLocalDirectory(config, { mode: 'new', parentPath: allowed, folderName: 'project' }), (error: unknown) => error instanceof DomainError && error.code === 'local_directory_unavailable');
  assert.throws(() => resolveLocalDirectory(config, { mode: 'auto', path: path.join(allowed, 'project') }), (error: unknown) => error instanceof DomainError && error.code === 'local_directory_unavailable');
  assert.equal(existsSync(allowed), false);
  assert.throws(() => listLocalDirectories({ ...config, enabled: false }), (error: unknown) => error instanceof DomainError && error.code === 'local_projects_disabled');
});

test('runtime configuration no longer requires a trusted root to enable storage', t => {
  const { root } = fixture(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const configFile = path.join(root, 'local-projects.json'), projects = path.join(root, 'projects');
  writeFileSync(configFile, JSON.stringify({ enabled: true, dataRoot: root, allowedRoots: [projects], defaultParent: projects, backupRoot: path.join(root, 'backup') }), { mode: 0o600 });
  const configured = runtimeConfig({ LOCAL_PROJECT_CONFIG: configFile });
  assert.equal(configured.localProjects.enabled, true);
  assert.equal(configured.coreWorkspaceRoot, path.join(root, 'pm-workspaces'));
  assert.deepEqual(configured.localProjects.allowedRoots, [projects]);
  assert.equal(runtimeConfig({ LOCAL_PROJECT_CONFIG: path.join(root, 'missing.json') }).localProjects.enabled, false);
  const unrestricted = runtimeConfig({ LOCAL_PROJECT_CONFIG: path.join(root, 'missing.json'), LOCAL_PROJECTS_ENABLED: 'true' });
  assert.equal(unrestricted.localProjects.enabled, true);
  assert.deepEqual(unrestricted.localProjects.allowedRoots, []);
});

test('anonymous capability discovery never discloses host paths and retains Origin security', async t => {
  const { root, config } = fixture(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = buildApp({ localProjects: config }); t.after(() => app.close());
  const discovery = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
  assert.equal(discovery.statusCode, 200); assert.deepEqual(discovery.json().localProjects, { enabled: false });
  assert.equal(discovery.body.includes(root), false);
  const foreign = await app.inject({ method: 'GET', url: '/api/v1/capabilities', headers: { origin: 'https://untrusted.invalid' } });
  assert.equal(foreign.statusCode, 403);
});

test('PM document storage and local directory policies preserve ordinary folder names', t => {
  const { root, allowed, config } = fixture(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const chatSpaceRoot = path.join(root, 'chat'); mkdirSync(chatSpaceRoot);
  const agentConfig = { ...config, chatSpaceRoot };
  const sibling = `${allowed}-other`; mkdirSync(sibling);
  assert.equal(allowedDirectory(config, sibling), sibling);
  const scoped = path.join(chatSpaceRoot, 'documents'); mkdirSync(scoped);
  assert.equal(agentAllowedDirectory(agentConfig, scoped), scoped);
  const proposed = resolveAgentDirectory(agentConfig, { mode: 'new', parentPath: scoped, folderName: '中文 project' });
  assert.equal(proposed.root, path.join(scoped, '中文 project'));
  assert.equal(existsSync(proposed.root), false);
  if (process.platform === 'win32') {
    assert.equal(samePath(allowedDirectory(config, allowed.toUpperCase()), allowed), true);
    for (const folderName of ['CON', 'NUL.md', 'folder.', 'folder ', 'note:stream']) {
      assert.throws(() => resolveLocalDirectory(config, { mode: 'new', parentPath: allowed, folderName }));
      assert.throws(() => resolveAgentDirectory(agentConfig, { mode: 'new', parentPath: scoped, folderName }));
    }
  }
});
