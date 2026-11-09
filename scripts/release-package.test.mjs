import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { assertReleaseIdentity, formatChecksums, parseReleaseTag, prepareRelease, verifyDirectory } from './release-package.mjs';

function git(repo, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Release fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

async function fixture(t) {
  const base = await mkdtemp('/var/tmp/dovspace-release-package-');
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  await mkdir(repo);
  const put = async (file, content = 'fixture\n') => {
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await writeFile(path.join(repo, file), content);
  };
  await put('package.json', '{"name":"release-fixture","version":"0.1.0"}\n');
  await put('pnpm-lock.yaml');
  await put('pnpm-workspace.yaml');
  await put('LICENSE');
  await put('LICENSE.t3code');
  await put('THIRD_PARTY_NOTICES.md');
  await put('deploy/Dockerfile');
  await put('dist/apps/server/main.js', 'console.log("server");\n');
  await put('dist/packages/domain/index.js', 'export {};\n');
  await put('apps/web/dist/index.html', '<!doctype html>\n');
  await put('apps/server/agent/dist/index.mjs', 'export {};\n');
  await put('apps/server/agent/package.json', '{"name":"agent-fixture"}\n');
  for (const legal of [
    'vendor/t3code/LICENSE', 'vendor/cc-switch/LICENSE', 'vendor/cc-switch/LICENSING.md',
    'vendor/openhands-extensions/LICENSE', 'vendor/openhands-extensions/LICENSING.md',
    'vendor/openhands-extensions/extensions/LICENSE',
    'vendor/openhands-automations/LICENSE.agent-canvas', 'vendor/openhands-automations/LICENSE.extensions',
  ]) await put(legal);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'release fixture']);
  git(repo, ['tag', 'v0.1.0']);
  return { base, repo, commit: git(repo, ['rev-parse', 'HEAD']), put };
}

test('release tags are exact v-prefixed semantic versions', () => {
  assert.equal(parseReleaseTag('v1.2.3'), '1.2.3');
  assert.equal(parseReleaseTag('v0.1.0-rc.1'), '0.1.0-rc.1');
  for (const invalid of ['1.2.3', 'v1.2', 'v01.2.3', 'v1.2.3-', 'v1.2.3/../x', 'release-v1.2.3', 'v1.2.3.4']) {
    assert.throws(() => parseReleaseTag(invalid), /v-prefixed semantic versions/);
  }
});

test('release identity rejects a version mismatch and malformed commit', () => {
  assert.deepEqual(assertReleaseIdentity({ tag: 'v0.1.0', version: '0.1.0', commit: 'a'.repeat(40) }), { tag: 'v0.1.0', version: '0.1.0', commit: 'a'.repeat(40) });
  assert.throws(() => assertReleaseIdentity({ tag: 'v0.1.0', version: '0.1.1', commit: 'a'.repeat(40) }), /does not match version/);
  assert.throws(() => assertReleaseIdentity({ tag: 'v0.1.0', version: '0.1.0', commit: 'A'.repeat(40) }), /full lowercase/);
});

test('checksum manifests sort deterministically', () => {
  assert.equal(
    formatChecksums([
      { name: 'b.tgz', sha256: 'b'.repeat(64) },
      { name: 'a.tgz', sha256: 'a'.repeat(64) },
    ]),
    `${'a'.repeat(64)}  a.tgz\n${'b'.repeat(64)}  b.tgz\n`,
  );
});

test('prepare creates verifiable archives and rejects a dirty checkout', async t => {
  const { base, repo, commit, put } = await fixture(t);
  const output = path.join(base, 'out');
  const manifest = await prepareRelease({ tag: 'v0.1.0', commit, output, cwd: repo });
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.tag, 'v0.1.0');
  assert.equal(manifest.commit, commit);
  const verified = await verifyDirectory(output);
  assert.deepEqual(verified.artifacts.map(artifact => artifact.name).sort(), [
    'project-management-agent-v4-0.1.0-build-evidence.tar.gz',
    'project-management-agent-v4-0.1.0-source.tar.gz',
  ]);
  assert.match(await readFile(path.join(output, 'SHA256SUMS'), 'utf8'), /^[0-9a-f]{64} {2}project-management-agent-v4-0\.1\.0-/);
  const buildEntries = execFileSync('tar', ['-tzf', path.join(output, 'project-management-agent-v4-0.1.0-build-evidence.tar.gz')], { encoding: 'utf8' }).split('\n');
  assert.ok(buildEntries.includes('project-management-agent-v4-0.1.0/dist/apps/server/main.js'));
  assert.ok(buildEntries.includes('project-management-agent-v4-0.1.0/deploy/Dockerfile'));
  const sourceEntries = execFileSync('tar', ['-tzf', path.join(output, 'project-management-agent-v4-0.1.0-source.tar.gz')], { encoding: 'utf8' }).split('\n');
  assert.ok(sourceEntries.includes('project-management-agent-v4-0.1.0/package.json'));
  await put('apps/web/dist/index.html', '<!doctype html><p>dirty</p>\n');
  await assert.rejects(prepareRelease({ tag: 'v0.1.0', commit, output: path.join(base, 'dirty-out'), cwd: repo }), /clean tracked checkout/);
});

test('verification detects tampering, missing artifacts and checksum drift', async t => {
  const { base, repo, commit } = await fixture(t);
  const output = path.join(base, 'out');
  const manifest = await prepareRelease({ tag: 'v0.1.0', commit, output, cwd: repo });
  const artifact = manifest.artifacts.find(entry => entry.name.endsWith('build-evidence.tar.gz'));
  await appendFile(path.join(output, artifact.name), 'tamper');
  await assert.rejects(verifyDirectory(output), /does not match its manifest/);
});

test('verification rejects an unreferenced file and altered SHA256SUMS', async t => {
  const { base, repo, commit } = await fixture(t);
  const first = path.join(base, 'first');
  const firstManifest = await prepareRelease({ tag: 'v0.1.0', commit, output: first, cwd: repo });
  await writeFile(path.join(first, 'notes.txt'), 'unexpected\n');
  await assert.rejects(verifyDirectory(first), /Unexpected file/);
  const second = path.join(base, 'second');
  const secondManifest = await prepareRelease({ tag: 'v0.1.0', commit, output: second, cwd: repo });
  assert.deepEqual(secondManifest.artifacts, firstManifest.artifacts);
  await appendFile(path.join(second, 'SHA256SUMS'), `${'0'.repeat(64)}  extra.tgz\n`);
  await assert.rejects(verifyDirectory(second), /SHA256SUMS does not match/);
});

test('prepare refuses an output directory inside the checkout', async t => {
  const { repo, commit } = await fixture(t);
  await assert.rejects(
    prepareRelease({ tag: 'v0.1.0', commit, output: path.join(repo, 'out'), cwd: repo }),
    /outside the checkout/,
  );
});
