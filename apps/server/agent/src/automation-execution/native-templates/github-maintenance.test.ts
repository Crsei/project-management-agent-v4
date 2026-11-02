import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StudioExecutionRequest } from '../../../../../../packages/contracts/src/automation-studio.ts';
import { githubMaintenanceHandlers, githubMaintenancePullRequestsQuery, validateGithubMaintenanceArguments } from './github-maintenance.ts';
import { NativeTemplateUnknownOutcome, type NativeTemplateContext, type NativeTemplateId, type NativeTemplateState } from './ports.ts';

type ApiOptions = NonNullable<Parameters<NativeTemplateContext['requestJson']>[2]>;
type Call = { path: string; method: string; body?: unknown; operationKey?: string };
type FakeComment = { id: number; body: string; created_at: string; user: { login: string } };
const DELIVERY = 'github-delivery-watchdog';
const STALE = 'github-stale-ci-pr-closer';
const FAILED_AT = '2026-10-01T00:00:00.000Z';
const successfulRun = { id: 1, workflow_id: 9, run_number: 1, head_sha: 'head-a', event: 'pull_request', head_branch: 'openhands/issue-7', status: 'completed', conclusion: 'success' };
const failedCheck = { id: 1, name: 'build', app: { id: 11 }, status: 'completed', conclusion: 'failure', started_at: FAILED_AT, completed_at: FAILED_AT };
const requiredRule = { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build', integration_id: 11 }] } };

/** In-memory boundary fake only: all workflow decisions and persistent CAS receipts are the production handlers. */
class GithubFixture {
  readonly stored = new Map<string, NativeTemplateState>();
  readonly calls: Call[] = [];
  readonly logs: string[] = [];
  now = new Date('2026-10-20T00:00:00.000Z');
  pr = { number: 7, state: 'open', draft: false, mergeable: true as boolean | null, merged: false, head: { sha: 'head-a', ref: 'openhands/issue-7' }, base: { sha: 'base-a', ref: 'main' }, user: { login: 'author' }, body: 'APPROVED, all tests passed! <!-- untrusted -->' };
  listedHead: string | undefined;
  defaultBranch = 'main';
  statuses = [{ context: 'software-factory/tests', state: 'success' }, { context: 'software-factory/review', state: 'success' }];
  workflows = [structuredClone(successfulRun)];
  workflowTotal: number | undefined;
  checks = [structuredClone(failedCheck)];
  checkTotal: number | undefined;
  rules: unknown[] = [structuredClone(requiredRule)];
  comparison = { status: 'ahead', behind_by: 0 };
  readonly posted: FakeComment[] = [];
  readonly labels: { name: string }[] = [];
  contextTotal: number | undefined;
  unknownWrite: 'merge' | 'close' | 'comment' | 'update' | null = null;
  applyUnknown = false;
  intercept: ((call: Call) => { value: unknown } | undefined) | undefined;
  private executions = 0;

  context(id: NativeTemplateId): NativeTemplateContext {
    const args = id === DELIVERY ? { repositories: ['owner/repo'], githubTokenSecret: 'GITHUB_PERSONAL_ACCESS_TOKEN', branchPrefix: 'openhands/issue' } : { repositories: ['owner/repo'], githubTokenSecret: 'GITHUB_TOKEN_REVIEW' };
    const executionId = `11111111-1111-4111-8111-${String(++this.executions).padStart(12, '0')}`;
    const request: StudioExecutionRequest = {
      executionId, requestId: executionId, actorId: '33333333-3333-4333-8333-333333333333', workspaceId: '44444444-4444-4444-8444-444444444444', projectId: 'PRJ-001', definitionId: '55555555-5555-4555-8555-555555555555', definitionRevision: 1,
      config: { name: 'Maintenance fixture', description: '', projectId: 'PRJ-001', tags: [], templateId: id, action: { kind: 'template', templateId: id, arguments: args, repositories: [], plugins: [], timeoutSeconds: 300, providerInstanceId: null, model: null, options: {} }, trigger: { kind: 'manual' }, dailyLimit: 10, cooldownMinutes: 0 }, trigger: 'test', payload: null, issuedAt: this.now.toISOString(),
    };
    return {
      request, arguments: args, now: new Date(this.now), signal: new AbortController().signal,
      log: message => this.logs.push(message),
      state: {
        read: async key => structuredClone(this.stored.get(key) ?? null),
        compareAndSet: async (key, expected, value) => {
          const current = this.stored.get(key);
          assert.equal(current?.revision ?? null, expected, 'persistent CAS must not overwrite a competing revision');
          const next = { revision: (current?.revision ?? 0) + 1, value: structuredClone(value) };
          this.stored.set(key, next); return structuredClone(next);
        },
        claim: async (key, value) => {
          if (this.stored.has(key)) return false;
          this.stored.set(key, { revision: 1, value: structuredClone(value) }); return true;
        },
      },
      requestJson: async <T>(_provider: 'github' | 'gitlab', path: string, options?: ApiOptions): Promise<T> => {
        assert.equal(_provider, 'github');
        const call = { path, method: options?.method ?? 'GET', body: options?.body, operationKey: options?.operationKey };
        this.calls.push(structuredClone(call));
        const intercepted = this.intercept?.(call);
        // The generic cast is the fake's DI boundary; production parses every authorization-relevant response.
        return structuredClone(intercepted ? intercepted.value : this.respond(call)) as T;
      },
      fetchPublic: async () => { throw new Error('Maintenance must not fetch public URLs'); },
      runAgent: async () => { throw new Error('Deterministic maintenance must not create a model conversation'); },
    };
  }

  graphNode(number = this.pr.number) {
    const nodes = this.checks.slice(0, 100).map(run => ({ __typename: 'CheckRun', databaseId: run.id, name: run.name, status: run.status.toUpperCase(), conclusion: run.conclusion.toUpperCase(), startedAt: run.started_at, completedAt: run.completed_at, checkSuite: { app: { databaseId: run.app.id } } }));
    return { number, isDraft: this.pr.draft, baseRefName: this.pr.base.ref, headRefOid: this.pr.head.sha, author: { login: this.pr.user.login }, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { totalCount: this.contextTotal ?? this.checks.length, nodes } } } }] } };
  }
  graph(nodes = this.pr.state === 'open' ? [this.graphNode()] : [], pageInfo = { hasNextPage: false, endCursor: null as string | null }) {
    return { data: { repository: { pullRequests: { nodes, pageInfo } } } };
  }
  private respond(call: Call): unknown {
    const url = new URL(call.path, 'https://fixture.invalid');
    const path = url.pathname;
    const page = Number(url.searchParams.get('page') ?? 1);
    if (path === '/graphql') {
      assert.equal(call.method, 'POST');
      assert.deepEqual(call.body, { query: githubMaintenancePullRequestsQuery, variables: { owner: 'owner', name: 'repo', cursor: null } });
      assert.equal(call.operationKey, undefined, 'GraphQL query is read-only');
      return this.graph();
    }
    assert.match(path, /^\/repos\/owner\/repo(?:\/|$)/, 'no repository scope escape');
    if (call.method === 'GET') {
      if (path === '/repos/owner/repo') return { default_branch: this.defaultBranch };
      if (path === '/repos/owner/repo/pulls') return this.pr.state === 'open' && page === 1 ? [{ ...this.pr, head: { ...this.pr.head, sha: this.listedHead ?? this.pr.head.sha } }] : [];
      if (path === '/repos/owner/repo/pulls/7') return this.pr;
      if (path.includes('/statuses')) return page === 1 ? this.statuses : [];
      if (path.endsWith('/actions/runs')) return { total_count: this.workflowTotal ?? this.workflows.length, workflow_runs: this.workflows.slice((page - 1) * 100, page * 100) };
      if (path.includes('/compare/')) return this.comparison;
      if (path.includes('/rules/branches/')) return this.rules;
      if (path.endsWith('/check-runs')) return { total_count: this.checkTotal ?? this.checks.length, check_runs: this.checks.slice((page - 1) * 100, page * 100) };
      if (path.endsWith('/comments')) return this.posted.slice((page - 1) * 100, page * 100);
      if (path.endsWith('/labels')) return this.labels;
    }
    assert.ok(call.operationKey, 'every mutation must have a durable operation key');
    let kind: GithubFixture['unknownWrite'] = null;
    if (path.endsWith('/merge')) kind = 'merge';
    else if (call.method === 'PATCH') kind = 'close';
    else if (path.endsWith('/comments')) kind = 'comment';
    else if (path.endsWith('/update-branch')) kind = 'update';
    if (kind !== null && kind === this.unknownWrite && !this.applyUnknown) throw new NativeTemplateUnknownOutcome('Fixture lost response');
    let result: unknown;
    if (kind === 'merge') { this.pr.state = 'closed'; this.pr.merged = true; result = { merged: true }; }
    else if (kind === 'close') { this.pr.state = 'closed'; result = this.pr; }
    else if (kind === 'comment') {
      assert.ok(call.body && typeof call.body === 'object' && 'body' in call.body && typeof call.body.body === 'string');
      const comment = { id: this.posted.length + 1, body: call.body.body, created_at: this.now.toISOString(), user: { login: 'maintenance-bot' } };
      this.posted.push(comment); result = comment;
    } else if (kind === 'update') result = { message: 'Updating pull request branch.' };
    else if (path.endsWith('/labels')) { this.labels.push({ name: 'openhands-review' }); result = this.labels; }
    else throw new Error(`Unexpected fixture request: ${call.method} ${call.path}`);
    if (kind !== null && kind === this.unknownWrite) throw new NativeTemplateUnknownOutcome('Fixture lost response after upstream applied mutation');
    return result;
  }
  mutations() { return this.calls.filter(call => call.method !== 'GET' && call.path !== '/graphql'); }
  async run(id: NativeTemplateId) {
    const handler = githubMaintenanceHandlers[id];
    assert.ok(handler, `Missing handler ${id}`);
    return handler(this.context(id));
  }
}

function httpError(status: number) { return Object.assign(new Error('Fixture HTTP rejection'), { status }); }

test('delivery performs only a SHA-pinned squash merge after exact independent status, Actions, branch and base gates', async () => {
  const fixture = new GithubFixture();
  const outcome = await fixture.run(DELIVERY);
  assert.match(outcome.summary, /1 merged/); assert.deepEqual(outcome.threadIds, []);
  assert.deepEqual(fixture.mutations().map(call => [call.method, call.path, call.body]), [['PUT', '/repos/owner/repo/pulls/7/merge', { sha: 'head-a', merge_method: 'squash' }]]);
  assert.match(fixture.mutations()[0].operationKey!, /head-a/);
});

for (const [label, change] of Object.entries({
  'wrong branch': (f: GithubFixture) => { f.pr.head.ref = 'feature/7'; },
  'branch suffix is not an issue number': (f: GithubFixture) => { f.pr.head.ref = 'openhands/issue-7-extra'; },
  'wrong base': (f: GithubFixture) => { f.pr.base.ref = 'release'; },
  'draft': (f: GithubFixture) => { f.pr.draft = true; },
  'unknown mergeability': (f: GithubFixture) => { f.pr.mergeable = null; },
  'conflicted': (f: GithubFixture) => { f.pr.mergeable = false; },
  'stale listed head': (f: GithubFixture) => { f.listedHead = 'old-head'; },
})) test(`delivery never mutates on ${label}`, async () => {
  const fixture = new GithubFixture(); change(fixture);
  const result = await fixture.run(DELIVERY);
  assert.match(result.summary, /0 merged/); assert.deepEqual(fixture.mutations(), []);
});

test('delivery rechecks the current head and base SHA after status, Actions and compare reads', async () => {
  for (const target of ['head', 'base'] as const) {
    const fixture = new GithubFixture(); let reads = 0;
    fixture.intercept = call => {
      if (call.method === 'GET' && call.path === '/repos/owner/repo/pulls/7' && ++reads === 2) fixture.pr[target].sha = 'changed';
      return undefined;
    };
    const result = await fixture.run(DELIVERY);
    assert.match(result.summary, /0 merged/); assert.deepEqual(fixture.mutations(), []);
  }
});

test('delivery ignores untrusted approval prose and requires both independent statuses and every latest status successful', async () => {
  for (const statuses of [[], [{ context: 'software-factory/tests', state: 'success' }], [{ context: 'software-factory/tests', state: 'success' }, { context: 'software-factory/review', state: 'failure' }], [{ context: 'software-factory/tests', state: 'success' }, { context: 'software-factory/review', state: 'success' }, { context: 'optional', state: 'pending' }]]) {
    const fixture = new GithubFixture(); fixture.statuses = statuses;
    await fixture.run(DELIVERY); assert.deepEqual(fixture.mutations(), []);
  }
});

for (const [label, change] of Object.entries({
  'failing': (f: GithubFixture) => { f.workflows[0].conclusion = 'failure'; },
  'pending': (f: GithubFixture) => { f.workflows[0].status = 'in_progress'; },
  'wrong SHA': (f: GithubFixture) => { f.workflows[0].head_sha = 'old-head'; },
  'truncated total': (f: GithubFixture) => { f.workflowTotal = 2; },
})) test(`delivery Actions gate blocks ${label} CI`, async () => {
  const fixture = new GithubFixture(); change(fixture); await fixture.run(DELIVERY); assert.deepEqual(fixture.mutations(), []);
});

test('delivery uses latest run per workflow/event/branch, so passing push cannot hide failing pull_request', async () => {
  const fixture = new GithubFixture();
  fixture.workflows = [{ ...successfulRun, id: 1, run_number: 1, conclusion: 'failure' }, { ...successfulRun, id: 2, run_number: 2 }];
  assert.match((await fixture.run(DELIVERY)).summary, /1 merged/);
  const blocked = new GithubFixture();
  blocked.workflows = [{ ...successfulRun, conclusion: 'failure' }, { ...successfulRun, id: 2, run_number: 2, event: 'push' }];
  await blocked.run(DELIVERY); assert.deepEqual(blocked.mutations(), []);
});

test('delivery preserves pinned empty-Actions behavior without inventing source-form required workflow IDs', async () => {
  const fixture = new GithubFixture(); fixture.workflows = [];
  assert.match((await fixture.run(DELIVERY)).summary, /1 merged/);
});

test('delivery reads every Actions page and refuses the ten-full-page truncation boundary', async () => {
  const fixture = new GithubFixture();
  fixture.workflows = Array.from({ length: 101 }, (_, i) => ({ ...successfulRun, id: i + 1, run_number: i + 1 }));
  assert.match((await fixture.run(DELIVERY)).summary, /1 merged/);
  assert.ok(fixture.calls.some(call => call.path.endsWith('/actions/runs?head_sha=head-a&per_page=100&page=2')));
  const truncated = new GithubFixture();
  truncated.workflows = Array.from({ length: 1000 }, (_, i) => ({ ...successfulRun, id: i + 1, run_number: i + 1 }));
  await truncated.run(DELIVERY); assert.deepEqual(truncated.mutations(), []);
});

test('delivery requests review and an expected-head branch update when behind instead of merging', async () => {
  const fixture = new GithubFixture(); fixture.comparison = { status: 'diverged', behind_by: 2 };
  const result = await fixture.run(DELIVERY);
  assert.match(result.summary, /1 branch updates requested/);
  assert.deepEqual(fixture.mutations().map(call => [call.method, call.body]), [['POST', { labels: ['openhands-review'] }], ['PUT', { expected_head_sha: 'head-a' }]]);
});

test('unknown merge survives a new execution and is never resent when upstream has not confirmed it', async () => {
  const fixture = new GithubFixture(); fixture.unknownWrite = 'merge';
  await assert.rejects(fixture.run(DELIVERY), NativeTemplateUnknownOutcome);
  await assert.rejects(fixture.run(DELIVERY), NativeTemplateUnknownOutcome);
  assert.equal(fixture.mutations().length, 1);
});

test('unknown merge is reconciled by matching merged head even after it disappeared from the open-PR list', async () => {
  const fixture = new GithubFixture(); fixture.unknownWrite = 'merge'; fixture.applyUnknown = true;
  await assert.rejects(fixture.run(DELIVERY), NativeTemplateUnknownOutcome);
  const result = await fixture.run(DELIVERY);
  assert.deepEqual(result.details?.pullRequests, [{ repository: 'owner/repo', pr: 7, outcome: 'merge-reconciled' }]);
  assert.equal(fixture.mutations().length, 1);
});

test('definite merge rejection is reported failed and a later execution may retry with a distinct stable attempt key', async () => {
  const fixture = new GithubFixture(); let rejected = false;
  fixture.intercept = call => { if (call.path.endsWith('/merge') && !rejected) { rejected = true; throw httpError(403); } return undefined; };
  assert.match((await fixture.run(DELIVERY)).summary, /1 failed operations/);
  assert.match((await fixture.run(DELIVERY)).summary, /1 merged/);
  assert.notEqual(fixture.mutations()[0].operationKey, fixture.mutations()[1].operationKey);
});

test('stale CI warns from the newest required failure, persists a real warning, and closes only seven days later', async () => {
  const fixture = new GithubFixture();
  const warned = await fixture.run(STALE); assert.match(warned.summary, /1 warned, 0 closed/);
  assert.equal(fixture.posted.length, 1); assert.match(fixture.posted[0].body, /openhands-stale-ci-warning head=head-a/);
  fixture.now = new Date('2026-10-26T23:59:59.000Z');
  assert.match((await fixture.run(STALE)).summary, /0 warned, 0 closed/);
  fixture.now = new Date('2026-10-27T00:00:00.000Z');
  assert.match((await fixture.run(STALE)).summary, /0 warned, 1 closed/);
  assert.equal(fixture.pr.state, 'closed');
  assert.equal(fixture.mutations().filter(call => call.method === 'PATCH').length, 1);
});

test('stale CI does not warn before seven days, with missing required CI, or with passing/non-required failures', async () => {
  for (const change of [
    (f: GithubFixture) => { f.checks[0].completed_at = '2026-10-19T00:00:00.000Z'; },
    (f: GithubFixture) => { f.checks = []; },
    (f: GithubFixture) => { f.checks[0].app.id = 99; },
    (f: GithubFixture) => { f.checks[0].conclusion = 'success'; },
    (f: GithubFixture) => { f.checks[0].conclusion = 'neutral'; },
    (f: GithubFixture) => { f.checks[0].conclusion = 'skipped'; },
    (f: GithubFixture) => { f.rules = []; },
    (f: GithubFixture) => { f.pr.draft = true; },
  ]) {
    const fixture = new GithubFixture(); change(fixture);
    assert.match((await fixture.run(STALE)).summary, /0 warned, 0 closed/); assert.deepEqual(fixture.mutations(), []);
  }
});

test('stale CI pending required check overrides a different failing required check', async () => {
  const fixture = new GithubFixture();
  fixture.rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build', integration_id: 11 }, { context: 'missing', integration_id: 11 }] } }];
  await fixture.run(STALE); assert.deepEqual(fixture.mutations(), []);
});

test('stale CI ages from the newest failure, not the oldest failing job or PR update', async () => {
  const fixture = new GithubFixture();
  fixture.rules = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'build', integration_id: 11 }, { context: 'test', integration_id: 11 }] } }];
  fixture.checks.push({ ...failedCheck, id: 2, name: 'test', completed_at: '2026-10-19T00:00:00.000Z' });
  await fixture.run(STALE); assert.deepEqual(fixture.mutations(), []);
});

test('stale CI latest app-bound run wins and unrelated failures do not block required CI passing', async () => {
  const fixture = new GithubFixture();
  fixture.checks = [structuredClone(failedCheck), { ...failedCheck, id: 2, conclusion: 'success' }, { ...failedCheck, id: 3, name: 'optional' }];
  await fixture.run(STALE); assert.deepEqual(fixture.mutations(), []);
});

test('stale CI truncated rollup falls back to complete REST pages; incomplete REST total fails without warning', async () => {
  const fixture = new GithubFixture(); fixture.contextTotal = 101;
  await fixture.run(STALE);
  assert.ok(fixture.calls.some(call => call.path.includes('/check-runs?per_page=100&page=1'))); assert.equal(fixture.posted.length, 1);
  const truncated = new GithubFixture(); truncated.contextTotal = 101; truncated.checkTotal = 2;
  await assert.rejects(truncated.run(STALE), /repository scans failed/); assert.deepEqual(truncated.mutations(), []);
});

test('stale CI REST fallback retrieves a second check-run page and fails closed at ten full pages', async () => {
  const fixture = new GithubFixture(); fixture.contextTotal = 102;
  fixture.checks = Array.from({ length: 101 }, (_, i) => ({ ...failedCheck, id: i + 1, name: i ? `optional-${i}` : 'build' }));
  await fixture.run(STALE);
  assert.ok(fixture.calls.some(call => call.path.includes('/check-runs?per_page=100&page=2'))); assert.equal(fixture.posted.length, 1);
  const truncated = new GithubFixture(); truncated.contextTotal = 1001;
  truncated.checks = Array.from({ length: 1000 }, (_, i) => ({ ...failedCheck, id: i + 1 }));
  await assert.rejects(truncated.run(STALE), /repository scans failed/); assert.deepEqual(truncated.mutations(), []);
});

test('stale CI consumes all PR cursor pages before writes and rejects repeated cursors', async () => {
  const fixture = new GithubFixture(); const cursors: unknown[] = [];
  fixture.intercept = call => {
    if (call.path !== '/graphql') return undefined;
    assert.ok(call.body && typeof call.body === 'object' && 'variables' in call.body);
    const variables = call.body.variables;
    assert.ok(variables && typeof variables === 'object' && 'cursor' in variables);
    cursors.push(variables.cursor);
    return { value: variables.cursor === null ? fixture.graph([fixture.graphNode()], { hasNextPage: true, endCursor: 'second-page' }) : fixture.graph([], { hasNextPage: false, endCursor: null }) };
  };
  await fixture.run(STALE); assert.deepEqual(cursors, [null, 'second-page']); assert.equal(fixture.posted.length, 1);
  const bad = new GithubFixture();
  bad.intercept = call => call.path === '/graphql' ? { value: bad.graph([], { hasNextPage: true, endCursor: 'repeat' }) } : undefined;
  await assert.rejects(bad.run(STALE), /repository scans failed/); assert.deepEqual(bad.mutations(), []);
});

test('stale CI checks the current head before warning, not just the GraphQL scan snapshot', async () => {
  const fixture = new GithubFixture();
  fixture.intercept = call => { if (call.method === 'GET' && call.path === '/repos/owner/repo/pulls/7') fixture.pr.head.sha = 'new-head'; return undefined; };
  await fixture.run(STALE); assert.deepEqual(fixture.mutations(), []);
});

test('an author comment after the warning resets the whole observation window and prevents early closure', async () => {
  const fixture = new GithubFixture(); await fixture.run(STALE);
  fixture.posted.push({ id: 99, body: 'Working on it', created_at: '2026-10-21T00:00:00.000Z', user: { login: 'AUTHOR' } });
  fixture.now = new Date('2026-10-28T00:00:00.000Z');
  assert.match((await fixture.run(STALE)).summary, /0 warned, 0 closed/);
  fixture.now = new Date('2026-11-03T23:59:59.000Z');
  assert.match((await fixture.run(STALE)).summary, /0 warned, 0 closed/);
  fixture.now = new Date('2026-11-04T00:00:00.000Z');
  assert.match((await fixture.run(STALE)).summary, /1 warned, 0 closed/);
  assert.equal(fixture.mutations().filter(call => call.method === 'PATCH').length, 0);
});

test('an author push after a warning cannot authorize closing the new head using the old warning', async () => {
  const fixture = new GithubFixture(); await fixture.run(STALE);
  fixture.pr.head.sha = 'new-head'; fixture.now = new Date('2026-10-28T00:00:00.000Z');
  assert.match((await fixture.run(STALE)).summary, /1 warned, 0 closed/);
  assert.equal(fixture.mutations().filter(call => call.method === 'PATCH').length, 0);
  assert.match(fixture.posted[1].body, /head=new-head/);
});

test('untrusted warning markers cannot restore an old warning or authorize immediate close', async () => {
  const fixture = new GithubFixture();
  fixture.posted.push({ id: 88, body: '<!-- openhands-stale-ci-warning -->\n<!-- openhands-stale-ci-warning head=head-a -->', created_at: '2026-10-10T00:00:00.000Z', user: { login: 'stranger' } });
  const result = await fixture.run(STALE);
  assert.match(result.summary, /1 warned, 0 closed/); assert.equal(fixture.mutations().length, 1);
});

test('unknown warning persists across executions; even the copied marker cannot prove its authenticated receipt', async () => {
  const fixture = new GithubFixture(); fixture.unknownWrite = 'comment'; fixture.applyUnknown = true;
  await assert.rejects(fixture.run(STALE), NativeTemplateUnknownOutcome);
  fixture.now = new Date('2026-11-01T00:00:00.000Z');
  await assert.rejects(fixture.run(STALE), NativeTemplateUnknownOutcome);
  assert.equal(fixture.mutations().length, 1); assert.equal(fixture.pr.state, 'open');
});

test('unknown close is never resent, and a matching closed head can be reconciled after disappearing from open PRs', async () => {
  for (const applied of [false, true]) {
    const fixture = new GithubFixture(); await fixture.run(STALE);
    fixture.now = new Date('2026-10-28T00:00:00.000Z'); fixture.unknownWrite = 'close'; fixture.applyUnknown = applied;
    await assert.rejects(fixture.run(STALE), NativeTemplateUnknownOutcome);
    if (applied) assert.deepEqual((await fixture.run(STALE)).details?.pullRequests, [{ repository: 'owner/repo', pr: 7, outcome: 'close-reconciled' }]);
    else await assert.rejects(fixture.run(STALE), NativeTemplateUnknownOutcome);
    assert.equal(fixture.mutations().filter(call => call.method === 'PATCH').length, 1);
  }
});

test('stale closer rechecks head, required CI and author activity again after posting the close explanation', async () => {
  for (const change of ['head', 'ci', 'comment']) {
    const fixture = new GithubFixture(); await fixture.run(STALE); fixture.now = new Date('2026-10-28T00:00:00.000Z');
    fixture.intercept = call => {
      if (call.method === 'GET' && call.path === '/repos/owner/repo/pulls/7' && fixture.posted.some(comment => comment.body.includes('openhands-stale-ci-close'))) {
        if (change === 'head') fixture.pr.head.sha = 'pushed-head';
        if (change === 'ci') fixture.checks[0].conclusion = 'success';
        if (change === 'comment' && !fixture.posted.some(comment => comment.id === 99)) fixture.posted.push({ id: 99, body: 'I am back', created_at: fixture.now.toISOString(), user: { login: 'author' } });
      }
      return undefined;
    };
    assert.match((await fixture.run(STALE)).summary, /0 closed/);
    assert.equal(fixture.mutations().filter(call => call.method === 'PATCH').length, 0);
  }
});

test('missing branch rules (404) are unconfigured, whereas forbidden rules (403) fail rather than authorizing cleanup', async () => {
  const absent = new GithubFixture(); absent.intercept = call => { if (call.path.includes('/rules/branches/')) throw httpError(404); return undefined; };
  assert.match((await absent.run(STALE)).summary, /0 warned, 0 closed/); assert.deepEqual(absent.mutations(), []);
  const forbidden = new GithubFixture(); forbidden.intercept = call => { if (call.path.includes('/rules/branches/')) throw httpError(403); return undefined; };
  await assert.rejects(forbidden.run(STALE), /repository scans failed/); assert.deepEqual(forbidden.mutations(), []);
});

test('source argument validation rejects missing persisted defaults, extra hidden gates, and credential values before API access', async () => {
  assert.throws(() => validateGithubMaintenanceArguments(DELIVERY, { repositories: ['owner/repo'], githubTokenSecret: 'GITHUB_PERSONAL_ACCESS_TOKEN' }), /branchPrefix/);
  assert.throws(() => validateGithubMaintenanceArguments(STALE, { repositories: ['owner/repo'], githubTokenSecret: 'ghp_fake_credential_value' }), /githubTokenSecret/);
  assert.throws(() => validateGithubMaintenanceArguments(DELIVERY, { repositories: ['owner/repo'], githubTokenSecret: 'GITHUB_PERSONAL_ACCESS_TOKEN', branchPrefix: 'openhands/issue', required_workflow_ids: [1] }), /required_workflow_ids/);
  const fixture = new GithubFixture(); const context = fixture.context(DELIVERY);
  const invalid = { ...context, arguments: { ...context.arguments, repositories: ['owner/repo/escape'] } };
  await assert.rejects(githubMaintenanceHandlers[DELIVERY]!(invalid), /repositories/); assert.deepEqual(fixture.calls, []);
});

test('delivery paginates commit statuses instead of treating the first page as complete approval evidence', async () => {
  const fixture = new GithubFixture();
  fixture.intercept = call => {
    if (!call.path.includes('/statuses')) return undefined;
    return { value: call.path.endsWith('page=1') ? Array.from({ length: 100 }, (_, index) => ({ context: `optional-${index}`, state: 'success' })) : fixture.statuses };
  };
  assert.match((await fixture.run(DELIVERY)).summary, /1 merged/);
  assert.ok(fixture.calls.some(call => call.path.includes('/statuses?per_page=100&page=2')));
});

test('missing required CI after a real warning clears the observation rather than closing on stale failure evidence', async () => {
  const fixture = new GithubFixture(); await fixture.run(STALE);
  fixture.now = new Date('2026-10-28T00:00:00.000Z'); fixture.checks = [];
  assert.match((await fixture.run(STALE)).summary, /0 closed/);
  assert.equal(fixture.mutations().filter(call => call.method === 'PATCH').length, 0);
  assert.ok(fixture.logs.some(line => line.includes('"outcome":"pending"')));
});

test('ambiguous 5xx writes never become retryable definite rejections', async () => {
  const fixture = new GithubFixture();
  fixture.intercept = call => { if (call.path.endsWith('/merge')) throw httpError(502); return undefined; };
  await assert.rejects(fixture.run(DELIVERY), NativeTemplateUnknownOutcome);
  await assert.rejects(fixture.run(DELIVERY), NativeTemplateUnknownOutcome);
  assert.equal(fixture.mutations().length, 1);
});
