import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPublisher, normalizeGithubRemote, parseArgs, runProcess } from './upstream-publish.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const blobId = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const author = { GIT_AUTHOR_NAME: 'Fixture Maintainer', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture Maintainer', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
const commandEnv = { PATH: process.env.PATH, LANG: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...author };

async function git(root, args, input, extraEnv = {}) {
  const result = await runProcess({ command: 'git', args, cwd: root, env: { ...commandEnv, ...extraEnv }, input });
  assert.equal(result.code, 0, `Disposable fixture Git operation ${args[0]} failed`);
  return result.stdout.trim();
}

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'upstream-publish-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const candidate = path.join(temporary, 'candidate');
  const handoff = path.join(temporary, 'handoff');
  await fs.mkdir(candidate);
  await fs.mkdir(handoff);
  await git(candidate, ['init', '--template=']);
  await git(candidate, ['remote', 'add', 'origin', 'https://github.com/fixture-owner/fixture-repo.git']);
  await fs.mkdir(path.join(candidate, 'vendor/t3code'), { recursive: true });
  await fs.writeFile(path.join(candidate, 'vendor/t3code/sample.ts'), 'export const oldValue = 1;\n');
  await fs.writeFile(path.join(candidate, 'vendor/t3code/removed.ts'), 'export const removed = true;\n');
  await fs.writeFile(path.join(candidate, 'untouched.txt'), 'do not include unrelated work\n');
  await fs.writeFile(path.join(candidate, '.gitattributes'), 'vendor/t3code/*.ts filter=hostile\n');
  await git(candidate, ['add', '--', 'vendor/t3code/sample.ts', 'vendor/t3code/removed.ts', 'untouched.txt', '.gitattributes']);
  await git(candidate, ['commit', '-m', 'Synthetic baseline only']);
  const baseCommit = await git(candidate, ['rev-parse', 'HEAD']);
  const marker = path.join(temporary, 'candidate-code-executed');
  await fs.mkdir(path.join(candidate, '.git/hooks'), { recursive: true });
  await fs.writeFile(path.join(candidate, '.git/hooks/pre-commit'), `#!/bin/sh\nprintf bad > '${marker}'\nexit 1\n`, { mode: 0o755 });
  await git(candidate, ['config', 'filter.hostile.clean', `sh -c "printf bad > '${marker}'; cat"`]);
  await git(candidate, ['config', 'filter.hostile.required', 'true']);
  await git(candidate, ['config', 'core.sshCommand', 'must-never-be-executed']);
  const bytes = Buffer.from('export const oldValue = 2;\nexport const added = true;\n');
  await fs.writeFile(path.join(candidate, 'vendor/t3code/sample.ts'), bytes);
  await fs.rm(path.join(candidate, 'vendor/t3code/removed.ts'));
  await fs.writeFile(path.join(candidate, 'vendor/t3code/new asset.bin'), Buffer.from([0, 1, 255, 3]));
  await fs.chmod(path.join(candidate, 'vendor/t3code/sample.ts'), 0o755);
  const files = [
    { path: 'vendor/t3code/new asset.bin', status: 'added', deleted: false, mode: 0o644, sha256: digest(Buffer.from([0, 1, 255, 3])), bytes: 4, contentPath: 'files/vendor/t3code/new asset.bin' },
    { path: 'vendor/t3code/removed.ts', status: 'deleted', deleted: true, mode: 0o644, sha256: null, bytes: 0, contentPath: null },
    { path: 'vendor/t3code/sample.ts', status: 'modified', deleted: false, mode: 0o755, sha256: digest(bytes), bytes: bytes.length, contentPath: 'files/vendor/t3code/sample.ts' },
  ];
  const validated = { schemaVersion: 1, project: 't3code', root: path.join(temporary, 'trusted-root'), candidate, baseCommit, targetCommit: 'b'.repeat(40), candidateFingerprint: digest(JSON.stringify(files)), files, changedPaths: files.map((file) => file.path), verification: { scope: 'full', status: 'passed' }, title: 'Update selected t3code source', body: '## Evidence\nSynthetic isolated fixture only.\n', toolFingerprints: [] };
  await fs.writeFile(path.join(handoff, 'handoff.json'), `${JSON.stringify(validated)}\n`);
  // Unit fixture for the publisher: the production core validates the complete
  // source/tool/verification provenance in its own suite. This validator still
  // enforces real worktree bytes, modes, base/parent and exact committed paths.
  const validations = [];
  const validateHandoff = async (options) => {
    validations.push(options);
    assert.equal(path.resolve(options.handoff), handoff);
    for (const file of files) {
      const filename = path.join(candidate, file.path);
      if (file.deleted) await assert.rejects(fs.lstat(filename), { code: 'ENOENT' });
      else {
        const stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || digest(await fs.readFile(filename)) !== file.sha256 || (stat.mode & 0o111 ? 0o755 : 0o644) !== file.mode) throw Object.assign(new Error('STALE_CANDIDATE'), { code: 'STALE_CANDIDATE' });
      }
    }
    assert.equal(await fs.readFile(path.join(candidate, 'untouched.txt'), 'utf8'), 'do not include unrelated work\n');
    const head = await git(candidate, ['rev-parse', 'HEAD']);
    if (options.expectedHead) {
      assert.equal(options.allowCommitted, true);
      assert.equal(head, options.expectedHead);
      assert.equal(await git(candidate, ['rev-parse', `${head}^`]), baseCommit);
      assert.deepEqual((await git(candidate, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', baseCommit, head])).split('\0').filter(Boolean).sort(), files.map((file) => file.path));
      for (const file of files.filter((item) => !item.deleted)) assert.equal(await git(candidate, ['rev-parse', `${head}:${file.path}`]), blobId(await fs.readFile(path.join(candidate, file.path))));
    } else assert.equal(head, baseCommit);
    return validated;
  };
  return { temporary, candidate, handoff, baseCommit, marker, files, validated, validations, validateHandoff, commitOptions: { handoff, repo: 'fixture-owner/fixture-repo', base: 'trunk', 'authorize-commit': true, 'author-name': 'Fixture Publisher', 'author-email': 'publisher@example.invalid' } };
}

function fakeGitHub(f, settings = {}) {
  const refs = new Map([['trunk', f.baseCommit]]);
  const pulls = [];
  const calls = [];
  const localCalls = [];
  const uploadedBlobs = new Set();
  let checkHead;
  const response = (body, status = 200) => ({ code: status >= 400 ? 1 : 0, stdout: `HTTP/2.0 ${status} Test\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(body)}\n`, stderr: '' });
  const run = async (request) => {
    if (request.command !== 'gh') {
      localCalls.push(request);
      assert.equal(request.env.GH_TOKEN, undefined);
      assert.equal(request.env.PROVIDER_SECRET, undefined);
      assert.equal(request.env.GIT_CONFIG_COUNT, undefined);
      assert.ok(!request.args.includes('push') && !request.args.includes('fetch'));
      return runProcess(request);
    }
    assert.equal(request.env.GH_TOKEN, 'synthetic-publisher-token');
    assert.equal(request.env.PROVIDER_SECRET, undefined);
    const method = request.args[request.args.indexOf('--method') + 1];
    const endpoint = request.args[request.args.indexOf('--method') + 2];
    const body = request.input === undefined ? undefined : JSON.parse(request.input);
    calls.push({ method, endpoint, body });
    const prefix = 'repos/fixture-owner/fixture-repo';
    if (method === 'GET' && endpoint.startsWith(`${prefix}/git/ref/heads/`)) {
      if (settings.queryFails) return { code: 1, stdout: '', stderr: 'redacted network failure' };
      const branch = decodeURIComponent(endpoint.slice(`${prefix}/git/ref/heads/`.length));
      return refs.has(branch) ? response({ ref: `refs/heads/${branch}`, object: { type: 'commit', sha: refs.get(branch) } }) : response({ message: 'Not Found' }, 404);
    }
    if (method === 'GET' && endpoint.startsWith(`${prefix}/pulls?`)) {
      // Model GitHub filters: a base-filtered query must not accidentally reveal
      // the human-retargeted PR that the production query currently hides.
      const query = new URL(`https://api.github.invalid/${endpoint}`).searchParams;
      const selected = pulls.filter((pr) => {
        const owner = pr.head.repo.full_name.split('/')[0];
        return (!query.has('head') || query.get('head') === `${owner}:${pr.head.ref}`)
          && (!query.has('base') || query.get('base') === pr.base.ref)
          && (!query.has('state') || query.get('state') === 'all' || query.get('state') === pr.state);
      });
      return response(selected);
    }
    if (method === 'GET' && endpoint === `${prefix}/git/commits/${f.baseCommit}`) return response({ sha: f.baseCommit, tree: { sha: await git(f.candidate, ['rev-parse', `${f.baseCommit}^{tree}`]) } });
    if (method === 'POST' && endpoint === `${prefix}/git/blobs`) {
      assert.equal(body.encoding, 'base64');
      const bytes = Buffer.from(body.content, 'base64');
      const sha = await git(f.candidate, ['hash-object', '-w', '--stdin', '--no-filters'], bytes);
      assert.equal(sha, blobId(bytes));
      uploadedBlobs.add(sha);
      return response({ sha }, 201);
    }
    if (method === 'POST' && endpoint === `${prefix}/git/trees`) {
      assert.equal(body.base_tree, await git(f.candidate, ['rev-parse', `${f.baseCommit}^{tree}`]));
      const indexEnv = { GIT_INDEX_FILE: path.join(f.temporary, 'simulated-remote-index') };
      await git(f.candidate, ['read-tree', body.base_tree], undefined, indexEnv);
      const entries = body.tree.map((entry) => {
        assert.equal(entry.type, 'blob');
        assert.ok(['100644', '100755'].includes(entry.mode));
        if (entry.sha === null) return `0 ${'0'.repeat(40)}\t${entry.path}\0`;
        assert.ok(uploadedBlobs.has(entry.sha), 'Tree must reference uploaded validated bytes');
        return `${entry.mode} ${entry.sha}\t${entry.path}\0`;
      });
      await git(f.candidate, ['update-index', '-z', '--index-info'], entries.join(''), indexEnv);
      return response({ sha: await git(f.candidate, ['write-tree'], undefined, indexEnv) }, 201);
    }
    if (method === 'POST' && endpoint === `${prefix}/git/commits`) {
      // Model GitHub's Git commit object, rather than just echoing the expected SHA.
      const head = await git(f.candidate, ['commit-tree', body.tree, '-p', body.parents[0]], body.message, { GIT_AUTHOR_NAME: body.author.name, GIT_AUTHOR_EMAIL: body.author.email, GIT_AUTHOR_DATE: body.author.date, GIT_COMMITTER_NAME: body.committer.name, GIT_COMMITTER_EMAIL: body.committer.email, GIT_COMMITTER_DATE: body.committer.date });
      if (settings.refRace) refs.set(settings.branch, 'd'.repeat(40));
      return response({ sha: settings.wrongCommit ? 'e'.repeat(40) : head }, 201);
    }
    if (method === 'POST' && endpoint === `${prefix}/git/refs`) {
      const branch = body.ref.slice('refs/heads/'.length);
      if (refs.has(branch)) return response({ message: 'Reference already exists' }, 422);
      if (!settings.noRefCreated) refs.set(branch, body.sha);
      if (settings.queryFailsAfterRef) settings.queryFails = true;
      if (settings.refTimeout) return { code: 1, stdout: '', stderr: 'unknown after write' };
      return response({ ref: body.ref, object: { type: 'commit', sha: body.sha } }, 201);
    }
    if (method === 'POST' && endpoint === `${prefix}/pulls`) {
      if (!settings.noPRCreated) pulls.push({ number: 17, html_url: 'https://github.com/fixture-owner/fixture-repo/pull/17', state: 'open', draft: body.draft, body: body.body, head: { ref: body.head, sha: refs.get(body.head), repo: { full_name: 'fixture-owner/fixture-repo' } }, base: { ref: settings.retargetOnCreate || body.base, sha: f.baseCommit, repo: { full_name: 'fixture-owner/fixture-repo' } } });
      if (settings.prTimeout) return { code: 1, stdout: '', stderr: 'unknown after write' };
      return response(pulls[0], 201);
    }
    if (method === 'GET' && endpoint.includes('/check-runs?')) return response({ total_count: settings.noCI ? 0 : 1, check_runs: settings.noCI ? [] : [{ name: settings.checkName || 'Repository checks', head_sha: checkHead || refs.get(settings.branch), status: 'completed', conclusion: settings.checkConclusion || 'success' }] });
    if (method === 'GET' && endpoint === `${prefix}/actions/workflows/ci.yml`) return response({ id: 431, name: 'Repository checks', path: '.github/workflows/ci.yml', state: 'active' });
    if (method === 'GET' && endpoint.startsWith(`${prefix}/actions/workflows/431/runs?`)) {
      const query = new URL(`https://api.github.invalid/${endpoint}`).searchParams;
      const head = refs.get(settings.branch);
      const runs = settings.noCI || settings.noRequiredWorkflow ? [] : [{ id: 812, workflow_id: 431, name: 'Repository checks', path: '.github/workflows/ci.yml', head_sha: head, head_branch: settings.branch, event: 'pull_request', status: settings.workflowStatus || 'completed', conclusion: settings.workflowStatus === 'waiting' ? null : settings.workflowConclusion || 'success', repository: { full_name: 'fixture-owner/fixture-repo' }, head_repository: { full_name: 'fixture-owner/fixture-repo' } }];
      const selected = runs.filter((run) => !query.has('head_sha') || query.get('head_sha') === run.head_sha);
      return response({ total_count: selected.length, workflow_runs: selected });
    }
    if (method === 'GET' && endpoint.startsWith(`${prefix}/actions/runs/812/jobs?`)) {
      const jobs = settings.workflowStatus === 'waiting' || settings.noRequiredJob ? [] : [{ id: 991, run_id: 812, head_sha: refs.get(settings.branch), name: 'PM / Web / Agent / Rust / contracts / sources', workflow_name: 'Repository checks', status: 'completed', conclusion: settings.jobConclusion || 'success' }];
      return response({ total_count: jobs.length, jobs });
    }
    if (method === 'GET' && endpoint.includes('/status?')) return response({ sha: refs.get(settings.branch), total_count: 0, statuses: [] });
    assert.fail(`Unexpected fake GitHub endpoint ${method} ${endpoint}`);
  };
  return { run, refs, pulls, calls, localCalls, setCheckHead: (head) => { checkHead = head; } };
}

function publisher(f, remote, extra = {}) {
  return createPublisher({ validateHandoff: f.validateHandoff, run: remote?.run || runProcess, env: { PATH: process.env.PATH, GH_TOKEN: 'synthetic-publisher-token', PROVIDER_SECRET: 'must-not-reach-child', GIT_CONFIG_COUNT: '999' }, ...extra });
}

const assertCode = (promise, code) => assert.rejects(promise, (error) => error.code === code);

test('CLI defaults to local status and rejects injected/unknown/duplicate options', () => {
  assert.deepEqual(parseArgs(['--handoff', '/tmp/exact']), { action: 'status', options: { handoff: '/tmp/exact' } });
  assert.throws(() => parseArgs(['commit', '--handoff', 'x\n--authorize-push']), /unsafe/);
  assert.throws(() => parseArgs(['push', '--authorize-push', '--authorize-push']), /Duplicate/);
  assert.throws(() => parseArgs(['pr', '--force']), /Unknown/);
  assert.equal(normalizeGithubRemote('git@github.com:Fixture-Owner/fixture-repo.git'), 'fixture-owner/fixture-repo');
  assert.throws(() => normalizeGithubRemote('https://token@github.com/owner/repo.git'), /credential-free/);
  assert.throws(() => normalizeGithubRemote('ext::sh -c bad'), /credential-free/);
});

test('each action has a separate authorization gate before reading or executing anything', async () => {
  const run = async () => assert.fail('No command should run without this action authorization');
  const validateHandoff = async () => assert.fail('No handoff should be read without mutation authorization');
  const p = createPublisher({ run, validateHandoff });
  for (const action of ['commit', 'push', 'pr']) await assertCode(p.publishAction(action, { handoff: '/not-read', 'authorize-commit': action !== 'commit' }), 'AUTHORIZATION_REQUIRED');
  await assertCode(p.publishAction('commit', { 'authorize-commit': true, 'authorize-push': true }), 'INVALID_AUTHORIZATION');
});

test('local preview has no GitHub credential access or side effect', async (t) => {
  const f = await fixture(t);
  const remote = fakeGitHub(f);
  const result = await publisher(f, remote).publishAction('status', { handoff: f.handoff });
  assert.equal(result.status, 'validated');
  assert.equal(result.remote.status, 'not-queried');
  assert.equal(result.publication, null);
  assert.equal(remote.calls.length, 0);
  await assert.rejects(fs.lstat(`${f.handoff}.publication.json`), { code: 'ENOENT' });
});

test('commit stages only exact literal paths, bytes, deletion and executable mode without hooks/filters', async (t) => {
  const f = await fixture(t);
  const p = publisher(f);
  const result = await p.publishAction('commit', f.commitOptions);
  assert.equal(result.status, 'committed');
  assert.equal(await git(f.candidate, ['rev-parse', `${result.head}^`]), f.baseCommit);
  assert.equal(await git(f.candidate, ['show', `${result.head}:vendor/t3code/sample.ts`]), 'export const oldValue = 2;\nexport const added = true;');
  assert.match(await git(f.candidate, ['ls-tree', result.head, '--', 'vendor/t3code/sample.ts']), /^100755 blob/);
  assert.equal(await git(f.candidate, ['show', `${result.head}:untouched.txt`]), 'do not include unrelated work');
  assert.equal(await git(f.candidate, ['diff-index', '--cached', '--name-only', result.head]), '');
  await assert.rejects(fs.lstat(f.marker), { code: 'ENOENT' });
  assert.ok(f.validations.some((call) => call.expectedHead === result.head && call.allowCommitted));
  const repeated = await p.publishAction('commit', f.commitOptions);
  assert.equal(repeated.head, result.head);
  assert.equal(repeated.status, 'already-committed');
});

test('unsafe/protected handoff paths and provenance-only evidence never reach publication', async (t) => {
  const f = await fixture(t);
  for (const filename of ['../escape', '/absolute', 'vendor/../escape', 'vendor\\escape', '.git/config', '.github/workflows/release.yml', 'scripts/upstream-publish.mjs', '.agents/skills/injected/SKILL.md']) {
    const entry = { ...f.files[2], path: filename };
    const p = publisher(f, null, { validateHandoff: async () => ({ ...f.validated, files: [entry], changedPaths: [filename] }) });
    await assert.rejects(p.publishAction('status', { handoff: f.handoff }), (error) => ['UNSAFE_PATH', 'PROTECTED_PUBLICATION_PATH'].includes(error.code));
  }
  const provenance = publisher(f, null, { validateHandoff: async () => ({ ...f.validated, verification: { scope: 'provenance', status: 'passed' } }) });
  await assertCode(provenance.publishAction('status', { handoff: f.handoff }), 'VERIFICATION_REQUIRED');
  const failed = publisher(f, null, { validateHandoff: async () => ({ ...f.validated, verification: { scope: 'full', status: 'failed' } }) });
  await assertCode(failed.publishAction('status', { handoff: f.handoff }), 'VERIFICATION_REQUIRED');
});

test('candidate rewriting and journal identity drift invalidate publication', async (t) => {
  const f = await fixture(t);
  const p = publisher(f);
  await p.publishAction('commit', f.commitOptions);
  await fs.appendFile(path.join(f.candidate, 'vendor/t3code/sample.ts'), '// tampered\n');
  await assertCode(p.publishAction('push', { handoff: f.handoff, 'authorize-push': true }), 'STALE_CANDIDATE');
  await fs.writeFile(path.join(f.candidate, 'vendor/t3code/sample.ts'), 'export const oldValue = 2;\nexport const added = true;\n');
  await fs.appendFile(path.join(f.handoff, 'handoff.json'), ' ');
  await assertCode(p.publishAction('status', { handoff: f.handoff }), 'STALE_PUBLICATION');
});

test('an existing local branch or mismatched origin is not overwritten', async (t) => {
  const f = await fixture(t);
  const branch = `upstream/t3code/${f.validated.targetCommit.slice(0, 12)}`;
  await git(f.candidate, ['update-ref', `refs/heads/${branch}`, f.baseCommit]);
  await assertCode(publisher(f).publishAction('commit', f.commitOptions), 'EXISTING_BRANCH');
  await git(f.candidate, ['remote', 'set-url', 'origin', 'https://github.com/unrelated/other.git']);
  await assertCode(publisher(f).publishAction('commit', f.commitOptions), 'REMOTE_IDENTITY_MISMATCH');
  assert.equal(await git(f.candidate, ['rev-parse', `refs/heads/${branch}`]), f.baseCommit);
});

test('push publishes exact Git objects via create-only ref and Draft PR is idempotent', async (t) => {
  const f = await fixture(t);
  const settings = { branch: `upstream/t3code/${f.validated.targetCommit.slice(0, 12)}` };
  const remote = fakeGitHub(f, settings);
  const p = publisher(f, remote);
  const commit = await p.publishAction('commit', f.commitOptions);
  const pushed = await p.publishAction('push', { handoff: f.handoff, 'authorize-push': true });
  assert.equal(pushed.head, commit.head);
  assert.equal(remote.refs.get(settings.branch), commit.head);
  assert.equal(remote.calls.filter((call) => call.method === 'POST' && call.endpoint.endsWith('/git/refs')).length, 1);
  assert.ok(remote.calls.every((call) => call.method !== 'PATCH'));
  assert.equal((await p.publishAction('push', { handoff: f.handoff, 'authorize-push': true })).status, 'already-pushed');
  const pr = await p.publishAction('pr', { handoff: f.handoff, 'authorize-pr': true });
  assert.equal(pr.draft, true);
  assert.equal(pr.head, commit.head);
  assert.equal((await p.publishAction('pr', { handoff: f.handoff, 'authorize-pr': true })).status, 'already-created');
  assert.equal(remote.calls.filter((call) => call.method === 'POST' && call.endpoint.endsWith('/pulls')).length, 1);
  const status = await p.publishAction('status', { handoff: f.handoff, 'query-remote': true });
  assert.equal(status.remote.ci.head, commit.head);
  assert.equal(status.remote.ci.status, 'passed');
  await assert.rejects(fs.lstat(f.marker), { code: 'ENOENT' });
});

test('remote commit SHA mismatch never creates a branch', async (t) => {
  const f = await fixture(t);
  const settings = { branch: `upstream/t3code/${f.validated.targetCommit.slice(0, 12)}`, wrongCommit: true };
  const remote = fakeGitHub(f, settings);
  const p = publisher(f, remote);
  await p.publishAction('commit', f.commitOptions);
  await assert.rejects(p.publishAction('push', { handoff: f.handoff, 'authorize-push': true }));
  assert.equal(remote.refs.has(settings.branch), false);
  assert.equal(remote.calls.filter((call) => call.method === 'POST' && call.endpoint.endsWith('/git/refs')).length, 0);
});

test('a racing remote branch and stale base are not overwritten', async (t) => {
  const f = await fixture(t);
  const settings = { branch: `upstream/t3code/${f.validated.targetCommit.slice(0, 12)}`, refRace: true };
  const remote = fakeGitHub(f, settings);
  const p = publisher(f, remote);
  await p.publishAction('commit', f.commitOptions);
  await assertCode(p.publishAction('push', { handoff: f.handoff, 'authorize-push': true }), 'REMOTE_HEAD_CHANGED');
  assert.equal(remote.refs.get(settings.branch), 'd'.repeat(40));
  assert.equal(remote.calls.filter((call) => call.method === 'POST' && call.endpoint.endsWith('/git/refs')).length, 0);
  remote.refs.set('trunk', 'c'.repeat(40));
  await assertCode(p.publishAction('push', { handoff: f.handoff, 'authorize-push': true }), 'STALE_REMOTE_BASE');
});

test('lost push/PR responses are reconciled by identity without repeating writes', async (t) => {
  const f = await fixture(t);
  const settings = { branch: `upstream/t3code/${f.validated.targetCommit.slice(0, 12)}`, refTimeout: true, prTimeout: true };
  const remote = fakeGitHub(f, settings);
  const p = publisher(f, remote);
  await p.publishAction('commit', f.commitOptions);
  assert.equal((await p.publishAction('push', { handoff: f.handoff, 'authorize-push': true })).status, 'pushed');
  assert.equal((await p.publishAction('pr', { handoff: f.handoff, 'authorize-pr': true })).status, 'created');
  assert.equal(remote.calls.filter((call) => call.method === 'POST' && call.endpoint.endsWith('/git/refs')).length, 1);
  assert.equal(remote.calls.filter((call) => call.method === 'POST' && call.endpoint.endsWith('/pulls')).length, 1);
});

test('confirmed-absent retries require a new explicit flag and never retry automatically', async (t) => {
  const f = await fixture(t);
  const settings = { branch: `upstream/t3code/${f.validated.targetCommit.slice(0, 12)}`, noRefCreated: true, refTimeout: true };
  const remote = fakeGitHub(f, settings);
  const p = publisher(f, remote);
  await p.publishAction('commit', f.commitOptions);
  await assertCode(p.publishAction('push', { handoff: f.handoff, 'authorize-push': true }), 'PUSH_NOT_CONFIRMED');
  const before = remote.calls.filter((call) => call.method === 'POST').length;
  await assertCode(p.publishAction('push', { handoff: f.handoff, 'authorize-push': true }), 'UNKNOWN_PUSH_OUTCOME');
  assert.equal(remote.calls.filter((call) => call.method === 'POST').length, before);
  settings.noRefCreated = false;
  assert.equal((await p.publishAction('push', { handoff: f.handoff, 'authorize-push': true, 'retry-confirmed-absent': true })).status, 'pushed');
});

test('human-updated PR/head, stale CI and missing CI are not reported passed', async (t) => {
  const f = await fixture(t);
  const settings = { branch: `upstream/t3code/${f.validated.targetCommit.slice(0, 12)}` };
  const remote = fakeGitHub(f, settings);
  const p = publisher(f, remote);
  await p.publishAction('commit', f.commitOptions);
  await p.publishAction('push', { handoff: f.handoff, 'authorize-push': true });
  await p.publishAction('pr', { handoff: f.handoff, 'authorize-pr': true });
  remote.setCheckHead('f'.repeat(40));
  await assertCode(p.publishAction('status', { handoff: f.handoff, 'query-remote': true }), 'STALE_CI');
  settings.noCI = true;
  assert.equal((await p.publishAction('status', { handoff: f.handoff, 'query-remote': true })).remote.ci.status, 'missing');
  remote.pulls[0].head.sha = 'd'.repeat(40);
  await assertCode(p.publishAction('pr', { handoff: f.handoff, 'authorize-pr': true }), 'EXISTING_PR_MISMATCH');
});

test('a symlink publication journal and unsupported branch/ref input are refused', async (t) => {
  const f = await fixture(t);
  const state = path.join(f.temporary, 'state-link');
  await fs.symlink(path.join(f.temporary, 'unrelated'), state);
  await assertCode(publisher(f).publishAction('status', { handoff: f.handoff, state }), 'UNSAFE_PATH');
  for (const branch of ['--upload-pack=bad', 'refs/../other', 'a@{b', 'feature\\bad', 'a.lock']) await assertCode(publisher(f).publishAction('commit', { ...f.commitOptions, branch }), 'UNSAFE_BRANCH');
});

test('no-change refuses empty publication without producing a journal or commit', async (t) => {
  const f = await fixture(t);
  const remote = fakeGitHub(f);
  const p = publisher(f, remote, { validateHandoff: async () => ({ ...f.validated, files: [], changedPaths: [] }) });
  await assertCode(p.publishAction('commit', f.commitOptions), 'NO_CHANGE');
  assert.equal(remote.calls.length, 0);
  assert.equal(await git(f.candidate, ['rev-parse', 'HEAD']), f.baseCommit);
  await assert.rejects(fs.lstat(`${f.handoff}.publication.json`), { code: 'ENOENT' });
});

test('interrupted local binding reconciles the exact planned commit without creating another', async (t) => {
  const f = await fixture(t);
  const p = publisher(f);
  const first = await p.publishAction('commit', f.commitOptions);
  const statePath = `${f.handoff}.publication.json`;
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.phase = 'commit-pending';
  await fs.writeFile(statePath, JSON.stringify(state));
  // Synthetic interruption after ref creation/index update but before HEAD bind.
  await fs.writeFile(path.join(f.candidate, '.git/HEAD'), `${f.baseCommit}\n`);
  const recovered = await p.publishAction('commit', f.commitOptions);
  assert.equal(recovered.head, first.head);
  assert.equal(await git(f.candidate, ['rev-list', '--count', `${f.baseCommit}..${first.head}`]), '1');
});

test('missing publication credentials never reach GitHub and are not obtained from candidate config', async (t) => {
  const f = await fixture(t);
  const remote = fakeGitHub(f);
  const p = publisher(f, remote, { env: { PATH: process.env.PATH } });
  await p.publishAction('commit', f.commitOptions);
  await assertCode(p.publishAction('push', { handoff: f.handoff, 'authorize-push': true }), 'PUBLICATION_CREDENTIAL_REQUIRED');
  assert.equal(remote.calls.length, 0);
});

test('an unknown post-write query failure blocks retry until identity is recovered', async (t) => {
  const f = await fixture(t);
  const settings = { branch: `upstream/t3code/${f.validated.targetCommit.slice(0, 12)}`, queryFailsAfterRef: true };
  const remote = fakeGitHub(f, settings);
  const p = publisher(f, remote);
  await p.publishAction('commit', f.commitOptions);
  await assertCode(p.publishAction('push', { handoff: f.handoff, 'authorize-push': true }), 'UNKNOWN_PUSH_OUTCOME');
  const writes = remote.calls.filter((call) => call.method === 'POST').length;
  await assertCode(p.publishAction('push', { handoff: f.handoff, 'authorize-push': true }), 'REMOTE_QUERY_FAILED');
  assert.equal(remote.calls.filter((call) => call.method === 'POST').length, writes);
  settings.queryFails = false;
  assert.equal((await p.publishAction('status', { handoff: f.handoff, 'query-remote': true })).remote.headMatches, true);
  assert.equal((await p.publishAction('push', { handoff: f.handoff, 'authorize-push': true })).status, 'already-pushed');
  assert.equal(remote.calls.filter((call) => call.method === 'POST').length, writes);
});

test('PR absence after a request is not permission to repeat it', async (t) => {
  const f = await fixture(t);
  const settings = { branch: `upstream/t3code/${f.validated.targetCommit.slice(0, 12)}`, noPRCreated: true, prTimeout: true };
  const remote = fakeGitHub(f, settings);
  const p = publisher(f, remote);
  await p.publishAction('commit', f.commitOptions);
  await p.publishAction('push', { handoff: f.handoff, 'authorize-push': true });
  await assertCode(p.publishAction('pr', { handoff: f.handoff, 'authorize-pr': true }), 'PR_NOT_CONFIRMED');
  await assertCode(p.publishAction('pr', { handoff: f.handoff, 'authorize-pr': true }), 'UNKNOWN_PR_OUTCOME');
  assert.equal(remote.calls.filter((call) => call.method === 'POST' && call.endpoint.endsWith('/pulls')).length, 1);
  settings.noPRCreated = false;
  assert.equal((await p.publishAction('pr', { handoff: f.handoff, 'authorize-pr': true, 'retry-confirmed-absent': true })).status, 'created');
  assert.equal(remote.calls.filter((call) => call.method === 'POST' && call.endpoint.endsWith('/pulls')).length, 2);
});

test('unrelated green or neutral checks cannot stand in for the required Repository checks workflow', async (t) => {
  for (const conclusion of ['success', 'neutral']) await t.test(conclusion, async (t) => {
    const f = await fixture(t);
    const settings = { branch: `upstream/t3code/${f.validated.targetCommit.slice(0, 12)}`, noRequiredWorkflow: true, checkName: 'Unrelated documentation bot', checkConclusion: conclusion };
    const remote = fakeGitHub(f, settings);
    const p = publisher(f, remote);
    await p.publishAction('commit', f.commitOptions);
    await p.publishAction('push', { handoff: f.handoff, 'authorize-push': true });
    const status = await p.publishAction('status', { handoff: f.handoff, 'query-remote': true });
    assert.equal(status.remote.ci.status, 'missing');
    assert.ok(remote.calls.some((call) => call.endpoint === 'repos/fixture-owner/fixture-repo/actions/workflows/ci.yml'));
    assert.ok(remote.calls.some((call) => call.endpoint.includes('/actions/workflows/431/runs?')));
  });
});

test('approval-required Repository checks cannot be masked by another successful check', async (t) => {
  const f = await fixture(t);
  const settings = { branch: `upstream/t3code/${f.validated.targetCommit.slice(0, 12)}`, workflowStatus: 'waiting', checkName: 'Unrelated successful check' };
  const remote = fakeGitHub(f, settings);
  const p = publisher(f, remote);
  await p.publishAction('commit', f.commitOptions);
  await p.publishAction('push', { handoff: f.handoff, 'authorize-push': true });
  assert.equal((await p.publishAction('status', { handoff: f.handoff, 'query-remote': true })).remote.ci.status, 'pending');
});

test('a successful workflow without its required aggregate job is not accepted as complete CI', async (t) => {
  const f = await fixture(t);
  const settings = { branch: `upstream/t3code/${f.validated.targetCommit.slice(0, 12)}`, noRequiredJob: true };
  const remote = fakeGitHub(f, settings);
  const p = publisher(f, remote);
  await p.publishAction('commit', f.commitOptions);
  await p.publishAction('push', { handoff: f.handoff, 'authorize-push': true });
  assert.notEqual((await p.publishAction('status', { handoff: f.handoff, 'query-remote': true })).remote.ci.status, 'passed');
});

test('an idempotent push cannot erase unknown PR authorization history', async (t) => {
  const f = await fixture(t);
  const settings = { branch: `upstream/t3code/${f.validated.targetCommit.slice(0, 12)}`, noPRCreated: true, prTimeout: true };
  const remote = fakeGitHub(f, settings);
  const p = publisher(f, remote);
  await p.publishAction('commit', f.commitOptions);
  await p.publishAction('push', { handoff: f.handoff, 'authorize-push': true });
  await assertCode(p.publishAction('pr', { handoff: f.handoff, 'authorize-pr': true }), 'PR_NOT_CONFIRMED');
  assert.equal((await p.publishAction('push', { handoff: f.handoff, 'authorize-push': true })).status, 'already-pushed');
  assert.equal(JSON.parse(await fs.readFile(`${f.handoff}.publication.json`, 'utf8')).phase, 'pr-pending');
  await assertCode(p.publishAction('pr', { handoff: f.handoff, 'authorize-pr': true }), 'UNKNOWN_PR_OUTCOME');
  assert.equal(remote.calls.filter((call) => call.method === 'POST' && call.endpoint.endsWith('/pulls')).length, 1);
});

test('an existing same-head PR retargeted to another base is never hidden or duplicated', async (t) => {
  const f = await fixture(t);
  const settings = { branch: `upstream/t3code/${f.validated.targetCommit.slice(0, 12)}` };
  const remote = fakeGitHub(f, settings);
  const p = publisher(f, remote);
  await p.publishAction('commit', f.commitOptions);
  await p.publishAction('push', { handoff: f.handoff, 'authorize-push': true });
  await p.publishAction('pr', { handoff: f.handoff, 'authorize-pr': true });
  remote.pulls[0].base.ref = 'release/human-selected';
  await assertCode(p.publishAction('pr', { handoff: f.handoff, 'authorize-pr': true }), 'EXISTING_PR_MISMATCH');
  assert.equal(remote.calls.filter((call) => call.method === 'POST' && call.endpoint.endsWith('/pulls')).length, 1);
});

test('unknown-outcome same-head PR retargeted before reconciliation stops without a duplicate', async (t) => {
  const f = await fixture(t);
  const settings = { branch: `upstream/t3code/${f.validated.targetCommit.slice(0, 12)}`, retargetOnCreate: 'release/human-selected', prTimeout: true };
  const remote = fakeGitHub(f, settings);
  const p = publisher(f, remote);
  await p.publishAction('commit', f.commitOptions);
  await p.publishAction('push', { handoff: f.handoff, 'authorize-push': true });
  await assertCode(p.publishAction('pr', { handoff: f.handoff, 'authorize-pr': true }), 'EXISTING_PR_MISMATCH');
  // Even explicitly confirmed-absent retry must discover the same-head PR on
  // another base rather than treating the old base-filtered list as absence.
  await assertCode(p.publishAction('pr', { handoff: f.handoff, 'authorize-pr': true, 'retry-confirmed-absent': true }), 'EXISTING_PR_MISMATCH');
  assert.equal(remote.calls.filter((call) => call.method === 'POST' && call.endpoint.endsWith('/pulls')).length, 1);
});
