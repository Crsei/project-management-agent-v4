import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { allowedDirectory, listLocalDirectories, previewLocalProject, resolveLocalDirectory, type LocalProjectConfiguration } from '../../../../packages/application/src/local-projects.ts';
import { DomainError } from '../../../../packages/domain/src/core.ts';
import { runtimeConfig } from '../../../../packages/infrastructure/src/runtime-config.ts';
import { buildApp } from '../src/app.ts';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'pm-local-directories-'));
  const allowed = path.join(root, 'projects'); mkdirSync(allowed);
  const config: LocalProjectConfiguration = { enabled: true, dataRoot: root, coreRoot: path.join(root, 'core'), allowedRoots: [allowed], defaultParent: allowed, backupRoot: path.join(root, 'backup') };
  return { root, allowed, config };
}

test('trusted local roots constrain real directory browsing and preview never changes existing code', t => {
  const { root, allowed, config } = fixture(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const code = path.join(allowed, 'existing-code'); mkdirSync(code); writeFileSync(path.join(code, 'README.md'), 'Original code\n');
  mkdirSync(path.join(allowed, '.private')); symlinkSync(root, path.join(allowed, 'escape'));
  const listing = listLocalDirectories(config, allowed);
  assert.deepEqual(listing.directories.map(item => item.name), ['existing-code']);
  assert.equal(previewLocalProject(config, { mode: 'existing', path: code }).path, code);
  assert.equal(readFileSync(path.join(code, 'README.md'), 'utf8'), 'Original code\n');
  assert.equal(existsSync(path.join(code, '.pm')), false);
  assert.throws(() => allowedDirectory(config, root), (error: unknown) => error instanceof DomainError && error.code === 'local_directory_forbidden');
  assert.throws(() => allowedDirectory(config, path.join(allowed, 'escape')), (error: unknown) => error instanceof DomainError && error.code === 'local_directory_forbidden');
  assert.throws(() => resolveLocalDirectory(config, { mode: 'new', parentPath: allowed, folderName: '../escape' }));
  mkdirSync(path.join(code, '.pm'));
  assert.throws(() => previewLocalProject(config, { mode: 'existing', path: code }), (error: unknown) => error instanceof DomainError && error.code === 'local_directory_marked');
});

test('missing trusted disks and disabled deployments cannot silently create a replacement root', t => {
  const { root, allowed, config } = fixture(); t.after(() => rmSync(root, { recursive: true, force: true }));
  rmSync(allowed, { recursive: true });
  assert.throws(() => resolveLocalDirectory(config, { mode: 'new', parentPath: allowed, folderName: 'project' }), (error: unknown) => error instanceof DomainError && error.code === 'local_directory_unavailable');
  assert.equal(existsSync(allowed), false);
  assert.throws(() => listLocalDirectories({ ...config, enabled: false }), (error: unknown) => error instanceof DomainError && error.code === 'local_projects_disabled');
});

test('trusted runtime configuration is explicit and data root controls the real default core path', t => {
  const { root } = fixture(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const configFile = path.join(root, 'local-projects.json'), projects = path.join(root, 'projects');
  writeFileSync(configFile, JSON.stringify({ enabled: true, dataRoot: root, allowedRoots: [projects], defaultParent: projects, backupRoot: path.join(root, 'backup') }), { mode: 0o600 });
  const configured = runtimeConfig({ LOCAL_PROJECT_CONFIG: configFile });
  assert.equal(configured.localProjects.enabled, true);
  assert.equal(configured.coreWorkspaceRoot, path.join(root, 'pm-workspaces'));
  assert.deepEqual(configured.localProjects.allowedRoots, [projects]);
  assert.equal(runtimeConfig({ LOCAL_PROJECT_CONFIG: path.join(root, 'missing.json') }).localProjects.enabled, false);
  assert.throws(() => runtimeConfig({ LOCAL_PROJECT_CONFIG: path.join(root, 'missing.json'), LOCAL_PROJECTS_ENABLED: 'true' }));
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
