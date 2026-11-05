#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateHandoff as trustedValidateHandoff } from './upstream-sync/core.mjs';
import { containsControl } from './upstream-sync/io.mjs';

const SHA = /^[a-f0-9]{40}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ACTIONS = new Set(['commit', 'push', 'pr', 'status']);
const BOOLEAN_FLAGS = new Set(['authorize-commit', 'authorize-push', 'authorize-pr', 'query-remote', 'retry-confirmed-absent', 'help']);
const VALUE_FLAGS = new Set(['handoff', 'state', 'repo', 'remote', 'base', 'branch', 'author-name', 'author-email']);
// Fixed trusted publisher policy, never read from a candidate or handoff.
const REQUIRED_CI = Object.freeze({ file: 'ci.yml', path: '.github/workflows/ci.yml', name: 'Repository checks', job: 'PM / Web / Agent / Rust / contracts / sources' });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const isWithin = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);

export function parseArgs(argv) {
  const args = [...argv];
  const action = args[0]?.startsWith('--') || !args.length ? 'status' : args.shift();
  if (!ACTIONS.has(action)) fail('INVALID_COMMAND', 'Use status, commit, push, or pr.');
  const options = {};
  while (args.length) {
    const flag = args.shift();
    if (!flag.startsWith('--')) fail('INVALID_ARGUMENT', 'All arguments must be named options.');
    const name = flag.slice(2);
    if (Object.hasOwn(options, name)) fail('INVALID_ARGUMENT', `Duplicate option --${name}.`);
    if (BOOLEAN_FLAGS.has(name)) options[name] = true;
    else if (VALUE_FLAGS.has(name)) {
      const value = args.shift();
      if (!value || value.startsWith('--') || /[\0\r\n]/.test(value)) fail('INVALID_ARGUMENT', `Missing or unsafe --${name}.`);
      options[name] = value;
    } else fail('INVALID_ARGUMENT', `Unknown option --${name}.`);
  }
  return { action, options };
}

export async function runProcess({ command, args, cwd, env, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let exceeded = false;
    const collect = (list) => (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) { exceeded = true; child.kill('SIGTERM'); }
      else list.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', () => reject(Object.assign(new Error(`Unable to start trusted ${command} executable.`), { code: 'PROCESS_START_FAILED' })));
    child.on('close', (code) => exceeded
      ? reject(Object.assign(new Error('Command output exceeded its safety limit.'), { code: 'OUTPUT_LIMIT' }))
      : resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function cleanEnv(source) {
  const env = { PATH: source.PATH || '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' };
  if (source.SYSTEMROOT) env.SYSTEMROOT = source.SYSTEMROOT;
  return env;
}

async function noSymlinkAncestors(target) {
  let current = path.resolve(target);
  for (;;) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) fail('UNSAFE_PATH', 'Publication paths must not contain symlinks.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function safeBranch(branch) {
  if (typeof branch !== 'string' || !branch || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.') || branch.includes('..') || branch.includes('@{') || containsControl(branch, 32) || /[~^:?*[\\]/.test(branch) || branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock')) || branch === '@') fail('UNSAFE_BRANCH', 'Use an explicit valid Git branch name.');
  return branch;
}

export function normalizeGithubRemote(url) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
  if (!match || !REPO.test(match[1])) fail('UNSAFE_REMOTE', 'Remote must be a credential-free github.com HTTPS or Git SSH repository URL.');
  return match[1].toLowerCase();
}

function publicationIdentity(validated, handoffHash) {
  return sha256(JSON.stringify({ handoffHash, project: validated.project, baseCommit: validated.baseCommit, targetCommit: validated.targetCommit, candidateFingerprint: validated.candidateFingerprint }));
}

function validateFileList(validated) {
  if (!['t3code', 'cc-switch'].includes(validated.project) || !SHA.test(validated.baseCommit) || !SHA.test(validated.targetCommit) || !validated.candidateFingerprint) fail('INVALID_HANDOFF', 'Missing handoff source identity.');
  if (!Array.isArray(validated.files) || !validated.files.length) fail('NO_CHANGE', 'No changed files; no commit, push, or PR is needed.');
  const names = new Set();
  const tools = new Set((validated.toolFingerprints || []).map((entry) => entry.path));
  for (const file of validated.files) {
    const name = file.path;
    if (typeof name !== 'string' || name.startsWith('/') || name.startsWith('-') || name.includes('\\') || containsControl(name) || name.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) fail('UNSAFE_PATH', 'Handoff contains an unsafe file path.');
    if (names.has(name)) fail('INVALID_HANDOFF', 'Handoff contains duplicate paths.');
    names.add(name);
    // The update must never approve replacements of its own trust or execution rules.
    if (/^(?:\.github\/|\.agents\/|scripts\/|AGENTS\.md$)/i.test(name) || tools.has(name)) fail('PROTECTED_PUBLICATION_PATH', `Publication requires independent review of ${name}.`);
    if (!file.deleted && file.status !== 'deleted' && (!/^[a-f0-9]{64}$/.test(file.sha256) || ![0o644, 0o755].includes(file.mode))) fail('INVALID_HANDOFF', `Missing exact content identity for ${name}.`);
  }
  if (!Array.isArray(validated.changedPaths) || validated.changedPaths.length !== names.size || validated.changedPaths.some((name) => !names.has(name))) fail('INVALID_HANDOFF', 'Changed paths differ from the exact file manifest.');
}

export function createPublisher({ validateHandoff = trustedValidateHandoff, run = runProcess, env = process.env } = {}) {
  const localEnv = cleanEnv(env);
  const git = async (candidate, args, extra = {}) => {
    const result = await run({ command: 'git', args: ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args], cwd: candidate, env: { ...localEnv, ...extra.env }, input: extra.input });
    if (result.code !== 0 && !extra.allowFailure) fail('GIT_FAILED', `Trusted Git operation failed (${args[0]}); no automatic retry. Raw command output is withheld to avoid leaking credentials.`);
    return result;
  };

  async function readState(statePath) {
    try {
      const stat = await fs.lstat(statePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) fail('UNSAFE_STATE', 'Publication journal must be a bounded regular file.');
      const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      if (state.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(state.identity) || (state.head && !SHA.test(state.head))) fail('UNSAFE_STATE', 'Invalid publication journal identity.');
      return state;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async function saveState(statePath, state, first = false) {
    const data = `${JSON.stringify(state, null, 2)}\n`;
    if (first) await fs.writeFile(statePath, data, { flag: 'wx', mode: 0o600 });
    else {
      const temporary = `${statePath}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, statePath);
      } finally { await fs.rm(temporary, { force: true }); }
    }
  }

  async function validateCurrent(handoff, state) {
    let validated;
    if (state?.head) {
      try { validated = await validateHandoff({ handoff, expectedHead: state.head, allowCommitted: true }); }
      catch (error) {
        if (state.phase !== 'commit-pending') throw error;
        validated = await validateHandoff({ handoff });
      }
    } else validated = await validateHandoff({ handoff });
    validateFileList(validated);
    if (validated.verification?.scope !== 'full' || !['passed', 'pass'].includes(validated.verification?.status)) fail('VERIFICATION_REQUIRED', 'Publication requires full passed verification, not provenance-only or diagnostic evidence.');
    return validated;
  }

  function configFor(options, validated, state) {
    const repo = options.repo || state?.repo;
    if (!REPO.test(repo || '')) fail('REPOSITORY_REQUIRED', 'Specify the authorized --repo OWNER/REPO; no repository is guessed.');
    const base = safeBranch(options.base || state?.base);
    const branch = safeBranch(options.branch || state?.branch || `upstream/${validated.project}/${validated.targetCommit.slice(0, 12)}`);
    const remote = options.remote || state?.remote || 'origin';
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(remote)) fail('UNSAFE_REMOTE', 'Use a named existing remote.');
    if (base === branch) fail('UNSAFE_BRANCH', 'The update branch must differ from the base branch.');
    const config = { repo, base, branch, remote };
    if (state && Object.entries(config).some(([key, value]) => value !== state[key])) fail('STALE_PUBLICATION', 'Publication repository, base, branch, or remote changed. Use the original reviewed identity.');
    return config;
  }

  async function checkOrigin(candidate, config) {
    const urls = await git(candidate, ['config', '--local', '--no-includes', '--get-all', `remote.${config.remote}.url`], { allowFailure: true });
    const pushUrls = await git(candidate, ['config', '--local', '--no-includes', '--get-all', `remote.${config.remote}.pushurl`], { allowFailure: true });
    const values = urls.stdout.trim().split('\n').filter(Boolean);
    const pushes = pushUrls.stdout.trim().split('\n').filter(Boolean);
    if (urls.code !== 0 || values.length !== 1 || pushes.length > 1 || [...values, ...pushes].some((url) => normalizeGithubRemote(url) !== config.repo.toLowerCase())) fail('REMOTE_IDENTITY_MISMATCH', 'The existing remote does not identify exactly the authorized GitHub repository.');
  }

  async function network(validated, config, callback) {
    const token = env.GH_TOKEN || env.GITHUB_TOKEN;
    if (!token) fail('PUBLICATION_CREDENTIAL_REQUIRED', 'A short-lived GH_TOKEN or GITHUB_TOKEN is required only in this separate publisher environment.');
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'upstream-publish-network-'));
    try {
      const networkEnv = { ...localEnv, HOME: temporary, XDG_CONFIG_HOME: temporary, GH_CONFIG_DIR: path.join(temporary, 'gh'), GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_TOKEN: token };
      const api = async (method, endpoint, body, allow404 = false) => {
        const args = ['api', '--hostname', 'github.com', '--include', '--method', method, endpoint];
        if (body !== undefined) args.push('--input', '-');
        const result = await run({ command: 'gh', args, cwd: temporary, env: networkEnv, input: body === undefined ? undefined : JSON.stringify(body) });
        const match = /^HTTP\/[\d.]+\s+(\d+)[^\r\n]*\r?\n[\s\S]*?\r?\n\r?\n([\s\S]*)$/.exec(result.stdout);
        if (!match) fail('REMOTE_QUERY_FAILED', 'GitHub response identity is unavailable; do not retry a possible side effect.');
        const status = Number(match[1]);
        if (status === 404 && allow404) return null;
        if (result.code !== 0 || status < 200 || status >= 300) fail('GITHUB_FAILED', `GitHub ${method} returned HTTP ${status}; raw output withheld.`);
        try { return JSON.parse(match[2]); } catch { fail('REMOTE_QUERY_FAILED', 'GitHub returned invalid JSON; do not retry a possible side effect.'); }
      };
      const endpoint = `repos/${config.repo}`;
      const ref = async (branch) => {
        const value = await api('GET', `${endpoint}/git/ref/heads/${encodeURIComponent(branch)}`, undefined, true);
        if (value === null) return null;
        if (value.ref !== `refs/heads/${branch}` || value.object?.type !== 'commit' || !SHA.test(value.object?.sha)) fail('REMOTE_IDENTITY_MISMATCH', 'GitHub branch identity is not the requested commit ref.');
        return value.object.sha;
      };
      const pulls = async () => {
        const list = await api('GET', `${endpoint}/pulls?state=all&head=${encodeURIComponent(`${config.repo.split('/')[0]}:${config.branch}`)}&per_page=100`);
        if (!Array.isArray(list) || list.length >= 100) fail('AMBIGUOUS_PR', 'Cannot establish an unambiguous existing PR identity.');
        return list;
      };
      const push = async (head) => {
        // Create immutable objects, then atomically CREATE the ref. Never update an
        // existing ref: a preflight check followed by ordinary git push has a race.
        const raw = (await git(validated.candidate, ['cat-file', 'commit', head])).stdout;
        const split = raw.indexOf('\n\n');
        if (split < 0) fail('INVALID_COMMIT', 'Publication commit has no exact message boundary.');
        const headers = raw.slice(0, split).split('\n');
        const tree = headers.find((line) => line.startsWith('tree '))?.slice(5);
        const parents = headers.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7));
        const person = (kind) => {
          const line = headers.find((item) => item.startsWith(`${kind} `));
          const match = new RegExp(`^${kind} (.+) <([^<>]+)> (\\d+) \\+0000$`).exec(line || '');
          if (!match) fail('INVALID_COMMIT', 'Publication commit must have exact UTC author/committer metadata.');
          return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
        };
        if (!SHA.test(tree || '') || parents.length !== 1 || parents[0] !== validated.baseCommit || headers.length !== 4) fail('INVALID_COMMIT', 'Publication must contain exactly one verified-base parent and no extra commit headers.');
        const base = await api('GET', `${endpoint}/git/commits/${validated.baseCommit}`);
        if (base.sha !== validated.baseCommit || !SHA.test(base.tree?.sha)) fail('REMOTE_IDENTITY_MISMATCH', 'Remote base commit/tree does not match the handoff.');
        const entries = [];
        for (const file of validated.files) {
          const mode = file.mode === 0o755 ? '100755' : '100644';
          if (file.deleted || file.status === 'deleted') {
            entries.push({ path: file.path, mode, type: 'blob', sha: null });
            continue;
          }
          const bytes = await fs.readFile(path.join(validated.candidate, file.path));
          if (sha256(bytes) !== file.sha256) fail('STALE_CANDIDATE', 'Candidate changed before uploading an immutable blob.');
          const blob = await api('POST', `${endpoint}/git/blobs`, { content: bytes.toString('base64'), encoding: 'base64' });
          const expected = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
          if (blob.sha !== expected) fail('REMOTE_IDENTITY_MISMATCH', 'Uploaded blob differs from the validated bytes.');
          entries.push({ path: file.path, mode, type: 'blob', sha: blob.sha });
        }
        const uploadedTree = await api('POST', `${endpoint}/git/trees`, { base_tree: base.tree.sha, tree: entries });
        if (uploadedTree.sha !== tree) fail('REMOTE_IDENTITY_MISMATCH', 'Uploaded tree differs from the exact local commit tree.');
        const uploadedCommit = await api('POST', `${endpoint}/git/commits`, { message: raw.slice(split + 2), tree, parents, author: person('author'), committer: person('committer') });
        if (uploadedCommit.sha !== head) fail('REMOTE_IDENTITY_MISMATCH', 'Remote commit metadata differs from the verified local head; no branch was created.');
        if (await ref(config.base) !== validated.baseCommit) fail('STALE_REMOTE_BASE', 'Remote base changed during object transfer; no branch was created.');
        if (await ref(config.branch)) fail('REMOTE_HEAD_CHANGED', 'Update branch appeared during transfer; it is not overwritten.');
        await api('POST', `${endpoint}/git/refs`, { ref: `refs/heads/${config.branch}`, sha: head });
        return { code: 0 };
      };
      return await callback({ api, ref, pulls, push, endpoint });
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }

  function ownedPR(list, state, validated) {
    if (!list.length) return null;
    if (list.length !== 1) fail('AMBIGUOUS_PR', 'Multiple PRs already use this head branch across bases; no PR is created or changed.');
    const pr = list[0];
    if (pr.head?.repo?.full_name?.toLowerCase() !== state.repo.toLowerCase() || pr.head?.ref !== state.branch || pr.head?.sha !== state.head || pr.base?.repo?.full_name?.toLowerCase() !== state.repo.toLowerCase() || pr.base?.ref !== state.base || !pr.body?.includes(`<!-- upstream-source-update:${state.identity} -->`) || !pr.draft || pr.state !== 'open' || !Number.isSafeInteger(pr.number)) fail('EXISTING_PR_MISMATCH', 'Existing PR is human-modified, closed, non-Draft, or belongs to a different candidate/head/base. Do not overwrite or duplicate it.');
    if (validated.baseCommit !== state.baseCommit) fail('STALE_PUBLICATION', 'PR base no longer matches the handoff.');
    return { number: pr.number, url: pr.html_url, head: pr.head.sha, draft: true };
  }

  async function requiredRepositoryCI(client, state) {
    const result = { status: 'missing', coverage: 'required-repository-workflow', workflow: { path: REQUIRED_CI.path, name: REQUIRED_CI.name, requiredJob: REQUIRED_CI.job }, run: null, job: null };
    const workflow = await client.api('GET', `${client.endpoint}/actions/workflows/${REQUIRED_CI.file}`, undefined, true);
    if (!workflow) return result;
    if (!Number.isSafeInteger(workflow.id) || workflow.id <= 0 || workflow.path !== REQUIRED_CI.path || workflow.name !== REQUIRED_CI.name) fail('STALE_CI', 'Required Actions workflow identity does not match the trusted publisher policy.');
    result.workflow.id = workflow.id;
    if (workflow.state !== 'active') return result;
    const runs = await client.api('GET', `${client.endpoint}/actions/workflows/${workflow.id}/runs?head_sha=${state.head}&branch=${encodeURIComponent(state.branch)}&per_page=100`);
    if (!Array.isArray(runs.workflow_runs) || !Number.isSafeInteger(runs.total_count) || runs.total_count !== runs.workflow_runs.length || runs.total_count > 100) fail('STALE_CI', 'Required workflow runs are incomplete; no current-head CI acceptance is possible.');
    const sameRepository = (repo) => repo?.full_name?.toLowerCase() === state.repo.toLowerCase();
    for (const run of runs.workflow_runs) {
      if (!Number.isSafeInteger(run.id) || run.id <= 0 || run.workflow_id !== workflow.id || run.path !== REQUIRED_CI.path || run.name !== REQUIRED_CI.name || run.head_sha !== state.head || run.head_branch !== state.branch || !sameRepository(run.repository) || !sameRepository(run.head_repository) || !['push', 'pull_request', 'workflow_dispatch'].includes(run.event)) fail('STALE_CI', 'Actions run is not the required workflow on this repository, branch and exact published head.');
    }
    // Newer pending/failed runs must not be hidden by an older green run.
    const run = runs.workflow_runs.reduce((latest, item) => !latest || item.id > latest.id ? item : latest, null);
    if (!run) return result;
    result.run = { id: run.id, head: run.head_sha, status: run.status, conclusion: run.conclusion, url: run.html_url };
    if (run.status !== 'completed' || run.conclusion === 'action_required') {
      result.status = 'pending';
      return result;
    }
    const jobs = await client.api('GET', `${client.endpoint}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
    if (!Array.isArray(jobs.jobs) || !Number.isSafeInteger(jobs.total_count) || jobs.total_count !== jobs.jobs.length || jobs.total_count > 100 || jobs.jobs.some((job) => !Number.isSafeInteger(job.id) || job.id <= 0 || job.run_id !== run.id || job.head_sha !== state.head || job.workflow_name !== REQUIRED_CI.name)) fail('STALE_CI', 'Required workflow jobs are incomplete or belong to another run/head.');
    const matching = jobs.jobs.filter((job) => job.name === REQUIRED_CI.job);
    if (matching.length > 1) fail('STALE_CI', 'Required aggregate job identity is ambiguous.');
    const job = matching[0];
    if (job) result.job = { id: job.id, name: job.name, head: job.head_sha, status: job.status, conclusion: job.conclusion };
    const failed = (conclusion) => ['failure', 'error', 'cancelled', 'timed_out', 'startup_failure', 'stale'].includes(conclusion);
    if (failed(run.conclusion) || failed(job?.conclusion)) result.status = 'failed';
    else if (!job) result.status = 'missing';
    else if (job.status !== 'completed' || job.conclusion === 'action_required') result.status = 'pending';
    else result.status = run.conclusion === 'success' && job.conclusion === 'success' ? 'passed' : 'unverified';
    return result;
  }

  async function remoteSnapshot(client, state, validated, withCI = false) {
    const baseHead = await client.ref(state.base);
    const remoteHead = await client.ref(state.branch);
    const pr = ownedPR(await client.pulls(), state, validated);
    let ci = { head: state.head || null, status: 'unverified', checks: [] };
    if (withCI && state.head && remoteHead === state.head) {
      const checks = await client.api('GET', `${client.endpoint}/commits/${state.head}/check-runs?per_page=100`);
      const statuses = await client.api('GET', `${client.endpoint}/commits/${state.head}/status?per_page=100`);
      if (!Array.isArray(checks.check_runs) || !Number.isSafeInteger(checks.total_count) || checks.total_count !== checks.check_runs.length || checks.total_count > 100 || statuses.sha !== state.head || !Array.isArray(statuses.statuses) || !Number.isSafeInteger(statuses.total_count) || statuses.total_count !== statuses.statuses.length || statuses.total_count > 100 || checks.check_runs.some((check) => check.head_sha !== state.head)) fail('STALE_CI', 'CI is incomplete or is not bound to the exact published head.');
      const items = [...checks.check_runs.map((check) => ({ name: check.name, status: check.status, conclusion: check.conclusion })), ...statuses.statuses.map((status) => ({ name: status.context, status: status.state === 'pending' ? 'in_progress' : 'completed', conclusion: status.state }))];
      const required = await requiredRepositoryCI(client, state);
      const failed = items.some((item) => ['failure', 'error', 'cancelled', 'timed_out', 'startup_failure', 'stale'].includes(item.conclusion));
      const pending = items.some((item) => item.status !== 'completed' || item.conclusion === 'action_required');
      ci = { head: state.head, ...required, status: required.status === 'passed' && failed ? 'failed' : required.status === 'passed' && pending ? 'pending' : required.status, checks: items };
    }
    return { baseHead, remoteHead, pr, ci, baseMatches: baseHead === validated.baseCommit, headMatches: !!state.head && remoteHead === state.head };
  }

  async function commit(validated, state, statePath, options, handoff) {
    const branchRef = `refs/heads/${state.branch}`;
    const existing = await git(validated.candidate, ['show-ref', '--verify', '--hash', branchRef], { allowFailure: true });
    const existingHead = existing.code === 0 ? existing.stdout.trim() : null;
    if (existingHead && existingHead !== state.head) fail('EXISTING_BRANCH', 'The local update branch already exists with a different or unowned head; it is not overwritten.');
    if (state.phase !== 'commit-pending' && state.head) return { action: 'commit', status: 'already-committed', head: state.head, branch: state.branch };
    if (state.phase === 'commit-pending' && !existingHead && !options['retry-confirmed-absent']) fail('UNKNOWN_COMMIT_OUTCOME', 'A prior commit attempt is pending. Query status, then explicitly authorize a retry only after confirming the branch is absent.');
    if (!state.head) {
      const name = options['author-name'];
      const email = options['author-email'];
      if (!name || !email || /[\0\r\n<>]/.test(name) || /[\0\r\n<>\s]/.test(email)) fail('AUTHOR_REQUIRED', 'Specify reviewed --author-name and --author-email; publisher does not read operator identity or credentials.');
      state.phase = 'commit-preparing';
      await saveState(statePath, state);
      const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'upstream-publish-index-'));
      try {
        const indexEnv = { GIT_INDEX_FILE: path.join(temporary, 'index') };
        await git(validated.candidate, ['read-tree', validated.baseCommit], { env: indexEnv });
        const entries = [];
        for (const file of validated.files) {
          if (file.deleted || file.status === 'deleted') { entries.push(`0 ${'0'.repeat(40)}\t${file.path}\0`); continue; }
          const bytes = await fs.readFile(path.join(validated.candidate, file.path));
          if (sha256(bytes) !== file.sha256) fail('STALE_CANDIDATE', 'Candidate changed while creating the exact index.');
          const blob = (await git(validated.candidate, ['hash-object', '-w', '--stdin', '--no-filters'], { input: bytes })).stdout.trim();
          if (!SHA.test(blob)) fail('GIT_FAILED', 'Git did not return an exact blob identity.');
          entries.push(`${file.mode === 0o755 ? '100755' : '100644'} ${blob}\t${file.path}\0`);
        }
        await git(validated.candidate, ['update-index', '-z', '--index-info'], { env: indexEnv, input: entries.join('') });
        const tree = (await git(validated.candidate, ['write-tree'], { env: indexEnv })).stdout.trim();
        if (!SHA.test(tree)) fail('GIT_FAILED', 'Git did not return a commit tree identity.');
        const title = `chore(upstream): update ${validated.project} to ${validated.targetCommit.slice(0, 12)}`;
        const message = `${title}\n\nUpstream-Handoff: ${state.identity}\nUpstream-Target: ${validated.targetCommit}\n`;
        await validateHandoff({ handoff });
        const date = new Date().toISOString();
        const identityEnv = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
        state.head = (await git(validated.candidate, ['commit-tree', tree, '-p', validated.baseCommit], { env: identityEnv, input: message })).stdout.trim();
        if (!SHA.test(state.head)) fail('GIT_FAILED', 'Git did not return a commit identity.');
        state.tree = tree;
      } finally { await fs.rm(temporary, { recursive: true, force: true }); }
      state.phase = 'commit-pending';
      await saveState(statePath, state);
    }
    if (!existingHead) await git(validated.candidate, ['update-ref', branchRef, state.head, '0'.repeat(40)]);
    // This only changes this isolated candidate's index/HEAD, never its file contents.
    await git(validated.candidate, ['read-tree', state.head]);
    await git(validated.candidate, ['symbolic-ref', 'HEAD', branchRef]);
    await validateHandoff({ handoff, expectedHead: state.head, allowCommitted: true });
    state.phase = 'committed';
    await saveState(statePath, state);
    return { action: 'commit', status: 'committed', head: state.head, branch: state.branch, state: statePath };
  }

  async function publishAction(action, options = {}) {
    if (!ACTIONS.has(action)) fail('INVALID_COMMAND', 'Use status, commit, push, or pr.');
    if (action !== 'status' && !options[`authorize-${action}`]) fail('AUTHORIZATION_REQUIRED', `The ${action} action requires its separate explicit --authorize-${action}; no side effect was attempted.`);
    const extraneous = ['commit', 'push', 'pr'].filter((item) => options[`authorize-${item}`] && item !== action);
    if (extraneous.length) fail('INVALID_AUTHORIZATION', 'Authorize only the current staged action, not later actions.');
    if (!options.handoff) fail('HANDOFF_REQUIRED', 'Specify the exact reviewed --handoff artifact directory.');
    const given = path.resolve(options.handoff);
    const handoff = path.basename(given) === 'handoff.json' ? path.dirname(given) : given;
    const statePath = path.resolve(options.state || `${handoff}.publication.json`);
    await noSymlinkAncestors(statePath);
    let lock = false;
    try {
      if (action !== 'status') {
        try { await fs.mkdir(`${statePath}.lock`, { mode: 0o700 }); lock = true; }
        catch (error) { if (error.code === 'EEXIST') fail('PUBLICATION_LOCKED', 'Publication is already running or interrupted. Inspect its journal before manually removing a stale empty lock.'); throw error; }
      }
      let state = await readState(statePath);
      const validated = await validateCurrent(handoff, state);
      if (isWithin(path.resolve(validated.candidate), statePath)) fail('UNSAFE_STATE', 'Keep the publication journal outside the candidate tree.');
      const handoffHash = sha256(await fs.readFile(path.join(handoff, 'handoff.json')));
      const identity = publicationIdentity(validated, handoffHash);
      if (state && (state.identity !== identity || state.handoff !== handoff || state.candidate !== validated.candidate || state.baseCommit !== validated.baseCommit || state.targetCommit !== validated.targetCommit)) fail('STALE_PUBLICATION', 'The journal does not belong to this exact reviewed handoff/candidate/base/target.');
      const config = action === 'status' && !state && !options['query-remote'] ? null : configFor(options, validated, state);
      if (config) await checkOrigin(validated.candidate, config);
      if (action === 'status') {
        const result = { action, status: 'validated', identity, project: validated.project, candidate: validated.candidate, baseCommit: validated.baseCommit, targetCommit: validated.targetCommit, candidateFingerprint: validated.candidateFingerprint, changedPaths: validated.changedPaths, verification: validated.verification, publication: state ? { phase: state.phase, head: state.head || null, branch: state.branch, repo: state.repo, pr: state.pr || null } : null, remote: { status: 'not-queried' } };
        if (options['query-remote']) {
          const preview = state || { ...config, identity, baseCommit: validated.baseCommit };
          result.remote = await network(validated, config, (client) => remoteSnapshot(client, preview, validated, true));
        }
        return result;
      }
      if (!state) {
        if (action !== 'commit') fail('COMMIT_REQUIRED', 'Create and validate the authorized exact commit before push or PR.');
        state = { schemaVersion: 1, identity, handoff, candidate: validated.candidate, baseCommit: validated.baseCommit, targetCommit: validated.targetCommit, ...config, phase: 'prepared' };
        await saveState(statePath, state, true);
      }
      if (action === 'commit') return await commit(validated, state, statePath, options, handoff);
      if (!state.head || ['prepared', 'commit-preparing', 'commit-pending'].includes(state.phase)) fail('COMMIT_REQUIRED', 'The exact candidate commit has not completed.');
      return await network(validated, config, async (client) => {
        const before = await remoteSnapshot(client, state, validated);
        if (!before.baseMatches) fail('STALE_REMOTE_BASE', 'The actual remote base branch differs from the verified host base. Re-inspect and reverify; do not publish stale evidence.');
        if (before.remoteHead && !before.headMatches) fail('REMOTE_HEAD_CHANGED', 'Existing remote branch contains another head. No force push, overwrite, or automatic retry is allowed.');
        if (action === 'push') {
          if (before.headMatches) {
            if (before.pr) { state.phase = 'pr-created'; state.pr = before.pr; }
            else if (!['pr-pending', 'pr-created'].includes(state.phase)) state.phase = 'pushed';
            await saveState(statePath, state);
            return { action, status: 'already-pushed', head: state.head, branch: state.branch };
          }
          if (state.phase === 'push-pending' && !options['retry-confirmed-absent']) fail('UNKNOWN_PUSH_OUTCOME', 'Remote branch is currently absent after a pending attempt. Review status and explicitly confirm absence before any retry.');
          if (['pushed', 'pr-created', 'pr-pending'].includes(state.phase)) fail('REMOTE_HEAD_CHANGED', 'A previously published branch is now missing; it is not recreated automatically.');
          await validateHandoff({ handoff, expectedHead: state.head, allowCommitted: true });
          state.phase = 'push-pending';
          await saveState(statePath, state);
          let result;
          let transferError;
          try { result = await client.push(state.head); }
          catch (error) { transferError = error; /* Reconcile once; never repeat the write. */ }
          let after;
          try { after = await client.ref(state.branch); }
          catch { fail('UNKNOWN_PUSH_OUTCOME', 'Push outcome is unknown. Run status --query-remote; do not automatically retry.'); }
          if (after !== state.head) {
            if (after) fail('REMOTE_HEAD_CHANGED', 'Remote branch now has a different head; never overwrite it.');
            if (transferError && ['REMOTE_IDENTITY_MISMATCH', 'STALE_REMOTE_BASE', 'STALE_CANDIDATE', 'INVALID_COMMIT'].includes(transferError.code)) throw transferError;
            fail('PUSH_NOT_CONFIRMED', result?.code === 0 ? 'Push did not produce the expected remote head; stop and reconcile.' : 'Push was not confirmed. Inspect status before any separately authorized retry.');
          }
          if (await client.ref(state.base) !== validated.baseCommit) fail('STALE_REMOTE_BASE', 'Remote base changed during publication; the branch exists but its evidence must be renewed.');
          state.phase = 'pushed';
          await saveState(statePath, state);
          return { action, status: 'pushed', head: state.head, branch: state.branch };
        }
        if (!before.headMatches) fail('PUSH_REQUIRED', 'Draft PR requires the exact validated remote commit head.');
        if (before.pr) {
          state.phase = 'pr-created'; state.pr = before.pr;
          await saveState(statePath, state);
          return { action, status: 'already-created', ...before.pr };
        }
        if (state.phase === 'pr-created') fail('EXISTING_PR_MISMATCH', 'Previously recorded PR is no longer present; do not create a replacement automatically.');
        if (state.phase === 'pr-pending' && !options['retry-confirmed-absent']) fail('UNKNOWN_PR_OUTCOME', 'A prior PR request is pending. Review status and explicitly confirm absence before a retry.');
        await validateHandoff({ handoff, expectedHead: state.head, allowCommitted: true });
        state.phase = 'pr-pending';
        await saveState(statePath, state);
        const body = `${validated.body}\n\n<!-- upstream-source-update:${state.identity} -->\n\nPublished candidate HEAD: \`${state.head}\`. CI must be checked for this exact SHA; no automatic merge, deployment, or PM task completion.\n`;
        try { await client.api('POST', `${client.endpoint}/pulls`, { title: validated.title || `chore(upstream): update ${validated.project} to ${validated.targetCommit.slice(0, 12)}`, head: state.branch, base: state.base, draft: true, body, maintainer_can_modify: false }); }
        catch { /* A timeout/error is not proof that GitHub rejected the request. */ }
        let after;
        try {
          const remoteHead = await client.ref(state.branch);
          if (remoteHead !== state.head) fail('REMOTE_HEAD_CHANGED', 'Remote head changed while creating the PR.');
          if (await client.ref(state.base) !== validated.baseCommit) fail('STALE_REMOTE_BASE', 'Remote base changed during PR creation; renew the candidate evidence.');
          after = ownedPR(await client.pulls(), state, validated);
        } catch (error) {
          if (['REMOTE_HEAD_CHANGED', 'EXISTING_PR_MISMATCH', 'STALE_REMOTE_BASE'].includes(error.code)) throw error;
          fail('UNKNOWN_PR_OUTCOME', 'PR outcome is unknown. Query status before any separately authorized retry.');
        }
        if (!after) fail('PR_NOT_CONFIRMED', 'PR request is not confirmed; query status, do not automatically retry.');
        state.phase = 'pr-created'; state.pr = after;
        await saveState(statePath, state);
        return { action, status: 'created', ...after };
      });
    } finally { if (lock) await fs.rmdir(`${statePath}.lock`); }
  }
  return { publishAction };
}

export const HELP = `Usage: node scripts/upstream-publish.mjs [status|commit|push|pr] --handoff DIR [options]\n\nDefault status validates locally only; --query-remote explicitly reads GitHub refs/PR/current-head CI.\ncommit: --authorize-commit --repo OWNER/REPO --base BRANCH --author-name NAME --author-email EMAIL\npush:   --authorize-push\npr:     --authorize-pr (always Draft)\nShared: --state FILE --remote origin --branch upstream/PROJECT/TARGET\nInterrupted writes: status first; --retry-confirmed-absent permits only a separately authorized, confirmed-absent retry.\nNo broad staging, force, candidate execution, merge, deployment, or automatic retries.\n`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { action, options } = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(HELP);
    else process.stdout.write(`${JSON.stringify(await createPublisher().publishAction(action, options), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'blocked', code: error.code || 'PUBLISH_FAILED', message: error.message })}\n`);
    process.exitCode = 1;
  }
}
