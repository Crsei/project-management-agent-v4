import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StudioExecutionRequest } from '../../../../../../packages/contracts/src/automation-studio.ts';
import { githubAgentHandlers, validateGithubAgentArguments } from './github-agent.ts';
import { GithubRepository, digest, object, type GithubComment, type GithubEvent, type GithubIssue, type GithubPr, type GithubReview } from './github-agent-common.ts';
import { parseImplementation, validateImplementationEvidence } from './github-agent-implementation.ts';
import { applyReviewEvidenceGate, classifyReporters, latestReporters, parseAssessment } from './github-agent-review.ts';
import { parseTriageRecommendation, renderTriage, splitTriageBody, triageEnd, triageStart } from './github-agent-triage.ts';
import { NativeTemplateUnknownOutcome, type NativeAgentResult, type NativeTemplateContext, type NativeTemplateId, type NativeTemplateState } from './ports.ts';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
function execution(templateId: NativeTemplateId, arguments_: Record<string, unknown>): StudioExecutionRequest {
  return { executionId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222', actorId: '33333333-3333-4333-8333-333333333333', workspaceId: '44444444-4444-4444-8444-444444444444', projectId: 'PRJ-001', definitionId: '55555555-5555-4555-8555-555555555555', definitionRevision: 1, config: { name: 'Boundary fixture', description: '', projectId: 'PRJ-001', tags: [], templateId, action: { kind: 'template', templateId, arguments: arguments_, repositories: [{ id: 'github:org/repo', ref: null }], plugins: [{ id: 'integration:fixture', version: '1' }], timeoutSeconds: 300, providerInstanceId: 'provider-fixture', model: 'model-fixture', options: {} }, trigger: { kind: 'manual' }, dailyLimit: 10, cooldownMinutes: 0 }, trigger: 'manual', payload: null, issuedAt: '2026-11-01T00:00:00.000Z' };
}
function context(templateId: NativeTemplateId, args: Record<string, unknown>, router: (path: string, options?: Parameters<NativeTemplateContext['requestJson']>[2]) => Promise<unknown> | unknown): { context: NativeTemplateContext; records: Map<string, NativeTemplateState> } {
  const records = new Map<string, NativeTemplateState>();
  const ctx: NativeTemplateContext = {
    request: execution(templateId, args), arguments: args, signal: new AbortController().signal, now: new Date('2026-11-01T00:00:00.000Z'), log() {},
    state: {
      async read(key) { return structuredClone(records.get(key) ?? null); },
      async claim(key, value) { if (records.has(key)) return false; records.set(key, { revision: 1, value: structuredClone(value) }); return true; },
      async compareAndSet(key, expected, value) { assert.equal(records.get(key)?.revision ?? null, expected, 'CAS may not overwrite a different revision'); const row = { revision: (expected ?? 0) + 1, value: structuredClone(value) }; records.set(key, row); return structuredClone(row); },
    },
    async requestJson<T>(provider: 'github' | 'gitlab', path: string, options?: Parameters<NativeTemplateContext['requestJson']>[2]): Promise<T> { assert.equal(provider, 'github'); assert.ok(path.startsWith('/') && !path.startsWith('//'), 'fixed-origin path only'); return structuredClone(await router(path, options)) as T; },
    async fetchPublic() { throw new Error('GitHub workflows must use the scoped connector'); },
    async runAgent() { throw new Error('Unexpected model call'); },
  };
  return { context: ctx, records };
}
function pr(number: number, overrides: Partial<GithubPr> = {}): GithubPr {
  return { number, title: `PR ${number}`, body: '', state: 'open', created_at: `2026-10-${String(number).padStart(2, '0')}T00:00:00Z`, labels: [], draft: false, user: { login: 'author' }, head: { sha: number.toString(16).padStart(40, '0'), ref: `work-${number}`, repo: { full_name: 'org/repo' } }, base: { ref: 'main', sha: base, repo: { full_name: 'org/repo', owner: { type: 'Organization' } } }, requested_reviewers: [], changed_files: 0, ...overrides };
}
type RepositoryFixture = { prs: GithubPr[]; issues: GithubIssue[]; comments: Map<number, GithubComment[]>; reviews: Map<number, GithubReview[]>; events: Map<number, GithubEvent[]>; checks: Map<string, { name: string; head_sha: string; id: number; status: string; conclusion: string }[]>; labelDefinitions: { name: string }[] };
function reviewerFixture(repositories: Record<string, GithubPr[]>, arguments_: Record<string, unknown> = {}) {
  const args = { repositories: Object.keys(repositories), ...arguments_ };
  const repos = new Map<string, RepositoryFixture>(Object.entries(repositories).map(([name, prs]) => [name, { prs: structuredClone(prs), issues: [], comments: new Map(), reviews: new Map(), events: new Map(), checks: new Map(prs.map(pr => [pr.head.sha, [{ name: 'required', head_sha: pr.head.sha, id: 1, status: 'completed', conclusion: 'success' }]])), labelDefinitions: [] }]));
  const writes: { repository: string; path: string; method: string; body: unknown }[] = [], reads: string[] = [], stages: { key: string; prompt: string; repository?: { repository: string; ref?: string; write: boolean } }[] = [];
  let onStage: ((input: Parameters<NativeTemplateContext['runAgent']>[0]) => void) | undefined;
  let scopeDecision = 'in_scope';
  const memory = context('github-pr-reviewer', args, async (path, options) => {
    const method = options?.method ?? 'GET'; reads.push(path);
    if (path === '/user') return { login: 'all-hands-bot' };
    if (path === '/graphql') return { data: { repository: { pullRequest: { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: 'CheckRun', name: 'required', isRequired: true }] } } } }] } } } } };
    const url = new URL(`https://api.github.com${path}`), match = /^\/repos\/([^/]+\/[^/]+)(.*)$/.exec(url.pathname);
    assert.ok(match, `Unexpected API path ${path}`);
    const name = match[1]!, suffix = match[2]!, repo = repos.get(name)!;
    assert.ok(repo, `Unscoped repository ${name}`);
    if (method !== 'GET') {
      assert.ok(options?.operationKey, 'Every upstream write needs a stable operation key');
      writes.push({ repository: name, path: suffix, method, body: options?.body });
      const review = /^\/pulls\/(\d+)\/reviews$/.exec(suffix);
      if (review && method === 'POST') {
        const number = Number(review[1]), body = object(options?.body), item: GithubReview = { id: writes.length, commit_id: String(body.commit_id), state: body.event === 'APPROVE' ? 'APPROVED' : 'COMMENTED', body: String(body.body), user: { login: 'all-hands-bot' }, submitted_at: '2026-11-01T00:00:00Z' };
        repo.reviews.set(number, [...repo.reviews.get(number) ?? [], item]); return item;
      }
      const comment = /^\/issues\/(\d+)\/comments$/.exec(suffix);
      if (comment && method === 'POST') { const number = Number(comment[1]), item = { id: 100 + writes.length, body: String(object(options?.body).body), user: { login: 'all-hands-bot' } }; repo.comments.set(number, [...repo.comments.get(number) ?? [], item]); return item; }
      const label = /^\/issues\/(\d+)\/labels\/(.+)$/.exec(suffix);
      if (label && method === 'DELETE') { const item = repo.prs.find(pr => pr.number === Number(label[1])) ?? repo.issues.find(issue => issue.number === Number(label[1])); if (item) item.labels = item.labels?.filter(value => value.name !== decodeURIComponent(label[2]!)); return {}; }
      const issue = /^\/issues\/(\d+)$/.exec(suffix);
      if (issue && method === 'PATCH') { const item = repo.issues.find(value => value.number === Number(issue[1]))!; item.body = String(object(options?.body).body); return item; }
      const addLabels = /^\/issues\/(\d+)\/labels$/.exec(suffix);
      if (addLabels && method === 'POST') { const item = repo.issues.find(value => value.number === Number(addLabels[1]))!; const names = object(options?.body).labels as string[]; item.labels = [...new Set([...(item.labels ?? []).map(value => value.name), ...names])].map(name => ({ name })); return item.labels; }
      if (suffix === '/labels' && method === 'POST') { repo.labelDefinitions.push({ name: String(object(options?.body).name) }); return object(options?.body); }
      const editComment = /^\/issues\/comments\/(\d+)$/.exec(suffix);
      if (editComment) { for (const [number, items] of repo.comments) { const item = items.find(value => value.id === Number(editComment[1])); if (item && method === 'PATCH') { item.body = String(object(options?.body).body); return item; } if (item && method === 'DELETE') { repo.comments.set(number, items.filter(value => value !== item)); return {}; } } }
      throw new Error(`Unexpected fixture write ${method} ${suffix}`);
    }
    if (!suffix) return { id: [...repos.keys()].indexOf(name) + 1, default_branch: 'main' };
    if (suffix === '/pulls') return repo.prs.filter(pr => pr.state === 'open');
    if (suffix === '/issues') return repo.issues.filter(issue => issue.state === 'open');
    if (suffix === '/labels') return repo.labelDefinitions;
    if (suffix === '/git/ref/heads/main') return { object: { sha: base } };
    const pull = /^\/pulls\/(\d+)$/.exec(suffix);
    if (pull) return repo.prs.find(pr => pr.number === Number(pull[1]));
    const issue = /^\/issues\/(\d+)$/.exec(suffix);
    if (issue) { const item = repo.issues.find(value => value.number === Number(issue[1])) ?? repo.prs.find(value => value.number === Number(issue[1])); if (!item) throw Object.assign(new Error('Not found'), { status: 404 }); return item; }
    const collection = /^\/(pulls|issues)\/(\d+)\/(reviews|comments|events|timeline|files)$/.exec(suffix);
    if (collection) {
      const number = Number(collection[2]);
      if (collection[3] === 'reviews') return repo.reviews.get(number) ?? [];
      if (collection[3] === 'comments') return collection[1] === 'pulls' ? [] : repo.comments.get(number) ?? [];
      if (collection[3] === 'events') return repo.events.get(number) ?? [];
      return [];
    }
    const checks = /^\/commits\/([^/]+)\/check-runs$/.exec(suffix);
    if (checks) { const runs = repo.checks.get(checks[1]!) ?? []; return { total_count: runs.length, check_runs: runs }; }
    if (/^\/commits\/[^/]+\/statuses$/.test(suffix)) return [];
    if (suffix === '/actions/runs') return { total_count: 0, workflow_runs: [] };
    throw new Error(`Unexpected fixture read ${suffix}`);
  });
  memory.context.runAgent = async input => {
    stages.push(input); onStage?.(input);
    const scope = input.key.endsWith(':scope');
    return { threadId: `thread-${stages.length}`, status: 'completed', repositoryChanges: [], commandEvidence: scope ? [] : [{ itemId: `workspace-command:${stages.length}`, title: 'pnpm test -- --runInBand', status: 'completed', exitCode: 0, output: '1 test passed' }], text: JSON.stringify(scope ? { decision: scopeDecision, summary: scopeDecision === 'in_scope' ? 'The change belongs to this repository' : 'Product architecture decision required', evidence: ['AGENTS.md scope ownership'] } : { head_sha: input.repository!.ref, code_assessment: 'clean', merge_readiness: 'ready', summary: 'No material defects', findings: [], evidence: ['Focused command output is recorded in native Chat'] }) };
  };
  return { ...memory, repos, writes, reads, stages, setStageHook(fn: typeof onStage) { onStage = fn; }, setScopeDecision(value: string) { scopeDecision = value; } };
}

test('source-form validators reject unsupported fields, credential values, ambiguous repos and invalid quotas', () => {
  assert.doesNotThrow(() => validateGithubAgentArguments('github-issue-to-pr', { repositories: ['org/repo'] }));
  for (const args of [{ repositories: ['org/repo'], trigger_label: 'wrong-name' }, { repositories: ['org/repo', 'ORG/REPO'] }, { repositories: ['https://github.com/org/repo'] }, { repositories: ['org/repo'], githubTokenSecret: 'ghp_private-value' }, { repositories: ['org/repo'], branchPrefix: '../escape' }]) assert.throws(() => validateGithubAgentArguments('github-issue-to-pr', args));
  assert.throws(() => validateGithubAgentArguments('github-pr-reviewer', { repositories: ['org/repo'], maxNewPerRun: 1.5 }));
  assert.throws(() => validateGithubAgentArguments('github-issue-triage', { repositories: ['org/repo'], triggerLabel: 'unsupported' }));
});
test('Depends on only unlocks issues closed as completed, not not-planned, missing or merely closed', async () => {
  let reason = 'not_planned';
  const fixture = context('github-issue-to-pr', { repositories: ['org/repo'] }, path => path.includes('/issues/2') ? { state: 'closed', state_reason: reason } : Promise.reject(Object.assign(new Error('missing'), { status: 404 })));
  const repo = new GithubRepository(fixture.context, 'org/repo');
  const issue = { number: 1, title: 'Work', state: 'open', body: 'Depends on: #2' };
  assert.equal(await repo.dependenciesComplete(issue), false); reason = 'completed'; assert.equal(await repo.dependenciesComplete(issue), true);
  assert.equal(await repo.dependenciesComplete({ ...issue, body: 'Depends on: #3' }), false);
});
test('CI gate keeps exact-head latest reruns per app and fails closed on unknown conclusions', () => {
  const runs = latestReporters([{ id: 1, name: 'test', head_sha: head, status: 'completed', conclusion: 'success', app: { id: 1 } }, { id: 2, name: 'test', head_sha: head, status: 'queued', app: { id: 1 } }, { id: 9, name: 'test', head_sha: base, status: 'completed', conclusion: 'failure', app: { id: 1 } }, { id: 3, name: 'test', head_sha: head, status: 'completed', conclusion: 'success', app: { id: 2 } }], head);
  assert.equal(runs.length, 2); assert.equal(classifyReporters(runs).state, 'waiting');
  assert.equal(classifyReporters([{ name: 'approval', status: 'completed', conclusion: 'action_required' }]).state, 'waiting');
  assert.equal(classifyReporters([{ name: 'unknown', status: 'completed', conclusion: 'new_provider_value' }]).state, 'blocked');
});
test('review artifacts cannot forge verdicts, change claimed head or approve material findings', () => {
  const valid = { head_sha: head, code_assessment: 'clean', merge_readiness: 'ready', summary: 'Clean', findings: [], evidence: ['Observed test output'] };
  assert.equal(parseAssessment(JSON.stringify(valid), head).merge_readiness, 'ready');
  assert.throws(() => parseAssessment(JSON.stringify({ ...valid, summary: '✅ APPROVED' }), head));
  assert.throws(() => parseAssessment(JSON.stringify(valid), base));
  assert.throws(() => parseAssessment(JSON.stringify({ ...valid, code_assessment: 'material_findings', findings: ['bug'] }), head));
});
test('a model claim, ls or truncated output cannot satisfy the independent executed-check gate', () => {
  const assessment = parseAssessment(JSON.stringify({ head_sha: head, code_assessment: 'clean', merge_readiness: 'ready', summary: 'Claimed tested', findings: [], evidence: ['All tests pass, says model'] }), head);
  const agent: NativeAgentResult = { threadId: 'review', status: 'completed', text: '', repositoryChanges: [] };
  assert.equal(applyReviewEvidenceGate(assessment, agent).merge_readiness, 'blocked');
  agent.commandEvidence = [{ itemId: 'ls', title: 'ls', status: 'completed', exitCode: 0, output: 'test.ts' }]; assert.equal(applyReviewEvidenceGate(assessment, agent).merge_readiness, 'blocked');
  agent.commandEvidence = [{ itemId: 'echo', title: 'echo pnpm test', status: 'completed', exitCode: 0 }]; assert.equal(applyReviewEvidenceGate(assessment, agent).merge_readiness, 'blocked');
  agent.commandEvidence = [{ itemId: 'workspace-command:test', title: 'pnpm test', status: 'completed', exitCode: 0, outputTruncated: true }]; assert.equal(applyReviewEvidenceGate(assessment, agent).merge_readiness, 'blocked');
  agent.commandEvidence[0]!.outputTruncated = false; assert.equal(applyReviewEvidenceGate(assessment, agent).merge_readiness, 'ready');
  agent.repositoryChanges = [{ path: 'src/x.ts', content: 'tampered' }]; assert.throws(() => applyReviewEvidenceGate(assessment, agent), /unchanged/);
});
test('publication proposals must match host-observed edited files, never a self-reported tested patch', () => {
  const implementation = parseImplementation(JSON.stringify({ disposition: 'changed', summary: 'Fix', changes: [{ path: 'src/x.ts', content: 'actual' }], tests: ['fabricated pass'] }));
  const agent: NativeAgentResult = { threadId: 'implementation', status: 'completed', text: '', repositoryChanges: [{ path: 'src/x.ts', content: 'different' }] };
  assert.throws(() => validateImplementationEvidence(implementation, agent), /actual native repository delta/);
  agent.repositoryChanges = [{ path: 'src/x.ts', content: 'actual' }]; assert.deepEqual(validateImplementationEvidence(implementation, agent), []);
  assert.throws(() => parseImplementation(JSON.stringify({ disposition: 'changed', summary: 'Escape', changes: [{ path: '../secret', content: 'x' }], tests: [] })), /Unsafe/);
});
test('triage preserves outside bytes, rejects malformed markers and separates readiness from unanswered decisions', () => {
  const recommendation = parseTriageRecommendation(JSON.stringify({ decision: 'ready', priority: 'low', scope: 'One behavior', non_goals: 'No rewrite', criteria: ['Observable case'], questions: [] }));
  const rendered = renderTriage(`before\n${triageStart}\nold\n${triageEnd}\nafter  `, recommendation, digest('source'));
  assert.ok(rendered.body.startsWith('before\n')); assert.ok(rendered.body.endsWith('\nafter  '));
  assert.throws(() => splitTriageBody(`${triageEnd}${triageStart}`), /Reversed/);
  assert.throws(() => splitTriageBody(`${triageStart}${triageStart}${triageEnd}`), /Ambiguous/);
  assert.throws(() => parseTriageRecommendation(JSON.stringify({ ...recommendation, questions: ['Still unresolved'] })), /Ready requires/);
});
test('uncertain upstream POST is journaled once, and only authoritative matching reads complete it', async () => {
  let posts = 0, observed: { id: number } | undefined;
  const fixture = context('github-pr-reviewer', { repositories: ['org/repo'] }, () => { posts++; throw new Error('response lost'); });
  const repo = new GithubRepository(fixture.context, 'org/repo');
  await assert.rejects(repo.mutate('review-work', 'POST', '/pulls/1/reviews', { body: 'review' }, async () => observed), NativeTemplateUnknownOutcome);
  await assert.rejects(repo.mutate('review-work', 'POST', '/pulls/1/reviews', { body: 'review' }, async () => observed), NativeTemplateUnknownOutcome);
  assert.equal(posts, 1); observed = { id: 42 };
  assert.deepEqual(await repo.mutate('review-work', 'POST', '/pulls/1/reviews', { body: 'review' }, async () => observed), { id: 42 }); assert.equal(posts, 1);
});
test('reviewer classifies full backlog, launches explicit before oldest across repositories and applies one global quota', async () => {
  const first = pr(1), pending = pr(2), explicit = pr(9, { labels: [{ name: 'openhands-review' }] }), olderOther = pr(3, { created_at: '2026-09-01T00:00:00Z' });
  const fixture = reviewerFixture({ 'org/repo': [first, pending, pr(4, { draft: true }), explicit], 'org/other': [olderOther] }, { maxNewPerRun: 2 });
  fixture.repos.get('org/repo')!.checks.get(pending.head.sha)![0]!.status = 'queued';
  fixture.repos.get('org/repo')!.events.set(9, [{ id: 90, event: 'labeled', label: { name: 'openhands-review' }, created_at: '2026-10-09T00:00:00Z' }]);
  await githubAgentHandlers['github-pr-reviewer']!(fixture.context);
  const posts = fixture.writes.filter(write => write.path.endsWith('/reviews'));
  assert.deepEqual(posts.map(write => `${write.repository}${write.path}`), ['org/repo/pulls/9/reviews', 'org/other/pulls/3/reviews']);
  assert.ok(fixture.reads.some(path => path.includes(`/commits/${first.head.sha}/check-runs`)), 'unlaunched eligible backlog was still classified');
  assert.ok(!fixture.writes.some(write => write.path === '/issues/2/comments'), 'unrequested pending head gets no comment storm');
  assert.equal(fixture.stages.length, 4, 'scope and technical reviews are separate durable stages per selected head');
  assert.ok(fixture.stages.every(stage => stage.repository?.write === false));
});
test('explicit reviewer event bypasses intake checks but cannot approve red current-head checks', async () => {
  const item = pr(1), fixture = reviewerFixture({ 'org/repo': [item] });
  fixture.repos.get('org/repo')!.checks.get(item.head.sha)![0]!.conclusion = 'failure';
  fixture.repos.get('org/repo')!.events.set(1, [{ id: 1, event: 'review_requested', requested_reviewer: { login: 'all-hands-bot' } }]);
  fixture.context.request.payload = { repository: { full_name: 'org/repo' }, action: 'review_requested', pull_request: { number: 1 }, requested_reviewer: { login: 'all-hands-bot' } };
  fixture.context.request.trigger = 'event';
  await githubAgentHandlers['github-pr-reviewer']!(fixture.context);
  const publication = fixture.writes.find(write => write.path.endsWith('/reviews'))!;
  assert.equal(object(publication.body).event, 'COMMENT'); assert.ok(!String(object(publication.body).body).endsWith('✅ APPROVED'));
});
test('scope stop runs no technical stage and head movement suppresses all stale publication', async () => {
  const stop = reviewerFixture({ 'org/repo': [pr(1)] }); stop.setScopeDecision('maintainer_decision');
  await githubAgentHandlers['github-pr-reviewer']!(stop.context);
  assert.equal(stop.stages.length, 1); assert.ok(String(object(stop.writes[0]!.body).body).endsWith('🛑 MAINTAINER DECISION REQUIRED'));
  const moved = reviewerFixture({ 'org/repo': [pr(1)] });
  moved.setStageHook(input => { if (input.key.endsWith(':technical')) moved.repos.get('org/repo')!.prs[0]!.head.sha = head; });
  await githubAgentHandlers['github-pr-reviewer']!(moved.context);
  assert.equal(moved.writes.length, 0);
});
test('reapplied label does not review the same head twice, but a dismissed review permits a new generation', async () => {
  const item = pr(1, { labels: [{ name: 'openhands-review' }] }), fixture = reviewerFixture({ 'org/repo': [item] });
  fixture.repos.get('org/repo')!.events.set(1, [{ id: 1, event: 'labeled', label: { name: 'openhands-review' } }]);
  await githubAgentHandlers['github-pr-reviewer']!(fixture.context);
  fixture.repos.get('org/repo')!.prs[0]!.labels = [{ name: 'openhands-review' }];
  fixture.repos.get('org/repo')!.events.get(1)!.push({ id: 2, event: 'labeled', label: { name: 'openhands-review' } });
  await githubAgentHandlers['github-pr-reviewer']!(fixture.context); assert.equal(fixture.stages.length, 2);
  fixture.repos.get('org/repo')!.reviews.get(1)![0]!.state = 'DISMISSED'; fixture.repos.get('org/repo')!.prs[0]!.labels = [{ name: 'openhands-review' }];
  fixture.repos.get('org/repo')!.events.get(1)!.push({ id: 3, event: 'labeled', label: { name: 'openhands-review' } });
  await githubAgentHandlers['github-pr-reviewer']!(fixture.context); assert.equal(fixture.stages.length, 4);
});
test('submitted callback never starts a new review, even when its exact-head review is missing', async () => {
  const fixture = reviewerFixture({ 'org/repo': [pr(1)] });
  fixture.context.request.payload = { repository: { full_name: 'org/repo' }, action: 'submitted', pull_request: { number: 1 }, review: { id: 123, user: { login: 'all-hands-bot' } } };
  await githubAgentHandlers['github-pr-reviewer']!(fixture.context); assert.equal(fixture.stages.length, 0); assert.equal(fixture.writes.length, 0);
});
test('triage makes real persistent body/priority writes, preserves human marker comments and withholds unknown-policy readiness', async () => {
  const fixture = reviewerFixture({ 'org/repo': [] });
  const issue: GithubIssue = { number: 1, title: 'A scoped issue', body: 'Author bytes\n', state: 'open', labels: [{ name: 'unrelated' }] };
  fixture.repos.get('org/repo')!.issues = [issue];
  fixture.repos.get('org/repo')!.comments.set(1, [{ id: 10, user: { login: 'human' }, body: `human text <!-- triage-source:${'f'.repeat(64)} -->` }]);
  fixture.context.request.config.action = { ...fixture.context.request.config.action, kind: 'template', templateId: 'github-issue-triage', arguments: { repositories: ['org/repo'] } } as StudioExecutionRequest['config']['action'];
  fixture.context.runAgent = async () => ({ threadId: 'triage', status: 'completed', text: JSON.stringify({ decision: 'ready', priority: 'low', scope: 'One issue', non_goals: 'No broader work', criteria: ['Observable behavior'], questions: [] }), repositoryChanges: [] });
  const savedPolicy = process.env.PM_AUTOMATION_TRIAGE_READINESS_POLICIES; delete process.env.PM_AUTOMATION_TRIAGE_READINESS_POLICIES;
  try {
    await githubAgentHandlers['github-issue-triage']!(fixture.context);
    assert.ok(issue.body!.startsWith('Author bytes\n')); assert.ok(issue.body!.includes('<!-- triage-complete:'));
    assert.deepEqual(issue.labels!.map(label => label.name).sort(), ['priority:low', 'unrelated']);
    assert.equal(fixture.repos.get('org/repo')!.comments.get(1)![0]!.user?.login, 'human');
    const count = fixture.writes.length; await githubAgentHandlers['github-issue-triage']!(fixture.context); assert.equal(fixture.writes.length, count, 'completed source fingerprint is not published twice');
  } finally { if (savedPolicy === undefined) delete process.env.PM_AUTOMATION_TRIAGE_READINESS_POLICIES; else process.env.PM_AUTOMATION_TRIAGE_READINESS_POLICIES = savedPolicy; }
});

test('issue scanner revises failed exact heads first, then high-priority ready issues and never incomplete dependencies', async () => {
  const revision = pr(7, { head: { sha: head, ref: 'openhands/issue-7', repo: { full_name: 'org/repo' } } });
  const fixture = reviewerFixture({ 'org/repo': [revision] });
  fixture.repos.get('org/repo')!.issues = [
    { number: 1, title: 'Normal', state: 'open', body: '', labels: [{ name: 'openhands' }] },
    { number: 2, title: 'Blocked dependency', state: 'open', body: 'Depends on: #99', labels: [{ name: 'openhands' }] },
    { number: 5, title: 'High priority', state: 'open', body: '', labels: [{ name: 'openhands' }, { name: 'priority:high' }] },
    { number: 7, title: 'Review feedback', state: 'open', body: '', labels: [] },
  ];
  const upstream = fixture.context.requestJson.bind(fixture.context);
  fixture.context.requestJson = async <T>(provider: 'github' | 'gitlab', path: string, options?: Parameters<NativeTemplateContext['requestJson']>[2]): Promise<T> => path.includes(`/commits/${head}/statuses`) ? [{ context: 'software-factory/review', state: 'failure' }] as T : upstream<T>(provider, path, options);
  const selected: number[] = [], keys: string[] = [];
  fixture.context.runAgent = async input => {
    selected.push(Number(/issue #(\d+)/.exec(input.prompt)![1])); keys.push(input.key);
    return { threadId: `implement-${selected.length}`, status: 'completed', repositoryChanges: [], commandEvidence: [], text: JSON.stringify({ disposition: 'blocked', summary: 'A specific decision is missing; no code changed', changes: [], tests: [] }) };
  };
  await githubAgentHandlers['github-issue-to-pr']!(fixture.context);
  assert.deepEqual(selected, [7, 5, 1]);
  const count = fixture.writes.length;
  await githubAgentHandlers['github-issue-to-pr']!(fixture.context);
  assert.deepEqual(selected, [7, 5, 1]); assert.equal(fixture.writes.length, count);
  assert.equal(new Set(keys).size, 3, 'each source subject has a distinct durable Chat delivery');
});
test('implementation publishes actual files through fixed-origin Git Data API and reconciles a lost PR receipt once', async () => {
  const issue: GithubIssue = { number: 1, title: 'Fix one file', state: 'open', body: 'Acceptance: fixed output', updated_at: '2026-11-01T00:00:00Z', labels: [{ name: 'openhands' }] };
  const treeSha = 'c'.repeat(40), commitSha = 'd'.repeat(40);
  let opened: GithubPr | undefined, branchSha: string | undefined, prPosts = 0;
  const operations: { path: string; method: string; body: unknown }[] = [];
  const repositoryLabels: { name: string }[] = [];
  const fixture = context('github-issue-to-pr', { repositories: ['org/repo'] }, (path, options) => {
    const method = options?.method ?? 'GET', url = new URL(`https://api.github.com${path}`), suffix = url.pathname.replace('/repos/org/repo', '');
    if (path === '/user') return { login: 'all-hands-bot' };
    if (method !== 'GET') {
      assert.ok(options?.operationKey); operations.push({ path: suffix, method, body: options?.body });
      if (suffix === '/git/trees') { assert.deepEqual(object(options?.body).tree, [{ path: 'src/fix.ts', mode: '100644', type: 'blob', content: 'fixed\n' }]); return { sha: treeSha }; }
      if (suffix === '/git/commits') return { sha: commitSha };
      if (suffix === '/git/refs') { branchSha = String(object(options?.body).sha); return { object: { sha: branchSha } }; }
      if (suffix === '/pulls') {
        prPosts++; opened = pr(10, { body: String(object(options?.body).body), draft: Boolean(object(options?.body).draft), head: { sha: commitSha, ref: 'openhands/issue-1', repo: { full_name: 'org/repo' } } });
        throw new Error('POST committed, response lost');
      }
      if (suffix === '/issues/10/labels') { opened!.labels = [{ name: 'openhands-review' }]; return opened!.labels; }
      if (suffix === '/labels') { const definition = { name: String(object(options?.body).name) }; repositoryLabels.push(definition); return definition; }
      throw new Error(`Unexpected write ${suffix}`);
    }
    if (!suffix) return { id: 1, default_branch: 'main' };
    if (suffix === '/issues') return [issue];
    if (suffix === '/labels') return repositoryLabels;
    if (suffix === '/issues/1') return issue;
    if (suffix === '/issues/1/comments') return [];
    if (suffix === '/pulls') return opened ? [opened] : [];
    if (suffix === '/pulls/10') return opened;
    if (suffix === '/git/ref/heads/main') return { object: { sha: base } };
    if (suffix === '/git/ref/heads/openhands/issue-1') { if (!branchSha) throw Object.assign(new Error('No ref'), { status: 404 }); return { object: { sha: branchSha } }; }
    if (suffix === `/git/commits/${base}`) return { tree: { sha: 'e'.repeat(40) } };
    if (suffix === `/git/trees/${'e'.repeat(40)}`) return { truncated: false, tree: [{ path: 'src/fix.ts', mode: '100644', type: 'blob', sha: 'f'.repeat(40) }] };
    throw new Error(`Unexpected read ${suffix}`);
  });
  fixture.context.runAgent = async () => ({ threadId: 'actual-native-thread', status: 'completed', repositoryChanges: [{ path: 'src/fix.ts', content: 'fixed\n', encoding: 'text' }], commandEvidence: [{ itemId: 'workspace-command:observed-test', title: 'pnpm test', status: 'completed', exitCode: 0, output: 'Focused behavior passed' }], text: JSON.stringify({ disposition: 'changed', summary: 'Corrected one behavior', changes: [{ path: 'src/fix.ts', content: 'fixed\n' }], tests: ['This claim is not trusted evidence'] }) });
  const result = await githubAgentHandlers['github-issue-to-pr']!(fixture.context);
  assert.equal(prPosts, 1); assert.equal(branchSha, commitSha); assert.equal(opened?.draft, true);
  assert.deepEqual(opened?.labels, [{ name: 'openhands-review' }]); assert.deepEqual(result.threadIds, ['actual-native-thread']);
  assert.ok(opened?.body?.includes('Focused behavior passed')); assert.ok(!opened?.body?.includes('This claim is not trusted evidence'));
  assert.ok(operations.every(operation => !operation.path.startsWith('http')));
});
test('a second definition cannot launch another independent review while the exact head claim is active', async () => {
  const fixture = reviewerFixture({ 'org/repo': [pr(1)] });
  const key = `shared:review:github:org/repo:1:${pr(1).head.sha}`;
  fixture.records.set(key, { revision: 1, value: { work: 'f'.repeat(64), generation: 'claimed-original-generation', definitionId: '66666666-6666-4666-8666-666666666666', status: 'active' } });
  await assert.rejects(githubAgentHandlers['github-pr-reviewer']!(fixture.context), NativeTemplateUnknownOutcome);
  assert.equal(fixture.stages.length, 0); assert.equal(fixture.writes.length, 0);
});
test('triage refuses stale human discussion before any publication write', async () => {
  const fixture = reviewerFixture({ 'org/repo': [] });
  fixture.repos.get('org/repo')!.issues = [{ number: 1, title: 'Scope', state: 'open', body: 'Original request', labels: [] }];
  fixture.context.runAgent = async () => {
    fixture.repos.get('org/repo')!.comments.set(1, [{ id: 1, user: { login: 'human' }, body: 'Changed scope while the model worked' }]);
    return { threadId: 'triage', status: 'completed', repositoryChanges: [], text: JSON.stringify({ decision: 'ready', priority: 'low', scope: 'Old scope', non_goals: 'No rewrite', criteria: ['Old case'], questions: [] }) };
  };
  await assert.rejects(githubAgentHandlers['github-issue-triage']!(fixture.context), /changed/);
  assert.equal(fixture.writes.length, 0);
});

test('binary/mode proposals are bound to the actual delta and disallow unsupported link modes', () => {
  const result = parseImplementation(JSON.stringify({ disposition: 'changed', summary: 'Add an executable asset', changes: [{ path: 'bin/tool', content: 'AAEC', encoding: 'base64', mode: '100755' }], tests: [] }));
  const agent: NativeAgentResult = { threadId: 'binary', status: 'completed', text: '', repositoryChanges: [{ path: 'bin/tool', content: 'AAEC', encoding: 'base64', mode: '100755' }] };
  assert.deepEqual(validateImplementationEvidence(result, agent), []);
  agent.repositoryChanges![0]!.mode = '100644'; assert.throws(() => validateImplementationEvidence(result, agent), /actual native repository delta/);
  assert.throws(() => parseImplementation(JSON.stringify({ disposition: 'changed', summary: 'Unsafe mode', changes: [{ path: 'link', content: 'target', mode: '120000' }], tests: [] })), /regular-file mode/);
});
test('an uncertain review retains its launch slot but does not prevent an independent queued subject from draining', async () => {
  const fixture = reviewerFixture({ 'org/repo': [pr(1), pr(2)] }, { maxNewPerRun: 2 });
  const upstream = fixture.context.requestJson.bind(fixture.context);
  let uncertainPosts = 0;
  fixture.context.requestJson = async <T>(provider: 'github' | 'gitlab', path: string, options?: Parameters<NativeTemplateContext['requestJson']>[2]): Promise<T> => {
    if (path.endsWith('/pulls/1/reviews') && options?.method === 'POST') { uncertainPosts++; throw new Error('Unknown provider response'); }
    return upstream<T>(provider, path, options);
  };
  await assert.rejects(githubAgentHandlers['github-pr-reviewer']!(fixture.context), NativeTemplateUnknownOutcome);
  assert.equal(uncertainPosts, 1);
  assert.ok(fixture.writes.some(write => write.path === '/pulls/2/reviews'), 'other selected subjects still deliver');
  assert.equal(fixture.stages.length, 4);
});

test('a pending native GitHub draft review never consumes a trigger or starts another reviewer', async () => {
  const fixture = reviewerFixture({ 'org/repo': [pr(1, { labels: [{ name: 'openhands-review' }] })] });
  fixture.repos.get('org/repo')!.events.set(1, [{ id: 1, event: 'labeled', label: { name: 'openhands-review' } }]);
  fixture.repos.get('org/repo')!.reviews.set(1, [{ id: 9, commit_id: pr(1).head.sha, state: 'PENDING', user: { login: 'all-hands-bot' } }]);
  await githubAgentHandlers['github-pr-reviewer']!(fixture.context);
  assert.equal(fixture.stages.length, 0); assert.equal(fixture.writes.length, 0);
});
test('an unresolved review POST remains unknown when CI or discussion changes; it cannot be retired as stale success', async () => {
  const fixture = reviewerFixture({ 'org/repo': [pr(1)] });
  const upstream = fixture.context.requestJson.bind(fixture.context);
  let posts = 0;
  fixture.context.requestJson = async <T>(provider: 'github' | 'gitlab', path: string, options?: Parameters<NativeTemplateContext['requestJson']>[2]): Promise<T> => {
    if (path.endsWith('/pulls/1/reviews') && options?.method === 'POST') { posts++; throw new Error('Lost POST response'); }
    return upstream<T>(provider, path, options);
  };
  await assert.rejects(githubAgentHandlers['github-pr-reviewer']!(fixture.context), NativeTemplateUnknownOutcome);
  fixture.repos.get('org/repo')!.checks.get(pr(1).head.sha)![0]!.conclusion = 'failure';
  fixture.repos.get('org/repo')!.comments.set(1, [{ id: 7, body: 'New discussion', user: { login: 'human' } }]);
  await assert.rejects(githubAgentHandlers['github-pr-reviewer']!(fixture.context), NativeTemplateUnknownOutcome);
  assert.equal(posts, 1); assert.equal(fixture.stages.length, 2, 'reconciliation does not create another scope/test review');
});
