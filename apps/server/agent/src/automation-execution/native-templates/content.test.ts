import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StudioExecutionRequest } from '../../../../../../packages/contracts/src/automation-studio.ts';
import { canonicalFeedLink, feedEntryKeys, parseFeed, selectFeedEntries, type FeedEntry } from './content-feeds.ts';
import { isoWeek, normalizeContentRepository, paginateJson } from './content-shared.ts';
import { contentHandlers, latestGitlabLabelEvent, parseGitlabProposal, validateContentArguments, validateGitlabArtifacts } from './content.ts';
import { NativeTemplateUnknownOutcome, type NativeAgentResult, type NativeTemplateContext, type NativeTemplateId, type NativeTemplateState } from './ports.ts';

const baseSha = 'a'.repeat(40), newSha = 'b'.repeat(40), fileSha = 'c'.repeat(40);
const at = new Date('2026-11-01T10:00:00.000Z');
function fixture(id: NativeTemplateId, args: Record<string, unknown>) {
  const request: StudioExecutionRequest = {
    executionId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222', actorId: '33333333-3333-4333-8333-333333333333', workspaceId: '44444444-4444-4444-8444-444444444444', projectId: 'PRJ-001', definitionId: '55555555-5555-4555-8555-555555555555', definitionRevision: 1,
    config: { name: 'Fixture', description: '', projectId: 'PRJ-001', tags: [], templateId: id, action: { kind: 'template', templateId: id, arguments: args, providerInstanceId: 'fixture-provider', model: 'fixture-model', options: {}, repositories: [], plugins: [], timeoutSeconds: 900 }, trigger: { kind: 'manual' }, dailyLimit: 1, cooldownMinutes: 0 }, trigger: 'test', payload: null, issuedAt: at.toISOString(),
  };
  const store = new Map<string, NativeTemplateState>(), logs: string[] = [], calls: Array<{ provider: string; path: string; options: unknown }> = [], models: Array<Parameters<NativeTemplateContext['runAgent']>[0]> = [];
  let model: (input: Parameters<NativeTemplateContext['runAgent']>[0]) => Promise<NativeAgentResult> = async () => ({ status: 'completed', threadId: 'native-thread', text: 'Supported digest.' });
  let api: (provider: string, path: string, options: Parameters<NativeTemplateContext['requestJson']>[2]) => Promise<unknown> = async () => { throw new Error('Unexpected API call'); };
  let feed: (url: string) => Promise<{ text: string; contentType: string }> = async () => ({ text: '<rss><channel><title>Empty</title></channel></rss>', contentType: 'application/rss+xml' });
  const context: NativeTemplateContext = {
    request, arguments: args, now: new Date(at), signal: new AbortController().signal, log: message => logs.push(message),
    state: {
      read: async key => structuredClone(store.get(key) ?? null),
      compareAndSet: async (key, revision, value) => {
        const old = store.get(key);
        if ((old?.revision ?? null) !== revision) throw Object.assign(new Error('State changed'), { code: 'revision_conflict' });
        const record = { revision: (old?.revision ?? 0) + 1, value: structuredClone(value) }; store.set(key, record); return structuredClone(record);
      },
      claim: async (key, value) => { if (store.has(key)) return false; store.set(key, { revision: 1, value: structuredClone(value) }); return true; },
    },
    requestJson: async <T>(provider: 'github' | 'gitlab', path: string, options?: Parameters<NativeTemplateContext['requestJson']>[2]): Promise<T> => { calls.push({ provider, path, options }); return await api(provider, path, options) as T; },
    fetchPublic: url => feed(url),
    runAgent: input => { models.push(input); return model(input); },
  };
  return { context, store, logs, calls, models, setApi: (implementation: typeof api) => { api = implementation; }, setFeed: (implementation: typeof feed) => { feed = implementation; }, setModel: (implementation: typeof model) => { model = implementation; }, run: () => contentHandlers[id]!(context) };
}
function rss(id = 'story', date = 'Sun, 01 Nov 2026 09:00:00 GMT'): string {
  return `<rss><channel><title>Publisher</title><item><guid>${id}</guid><title>New model weights</title><link>https://publisher.example/story/</link><pubDate>${date}</pubDate><description><![CDATA[<p>A company released model weights, with a documented license and reproducible evaluation.</p>]]></description></item></channel></rss>`;
}
function missing(): never { throw Object.assign(new Error('Missing'), { status: 404 }); }

test('RSS2 CDATA, RSS1 namespaces and Atom mixed XHTML use local names and actual feed titles', () => {
  const [rssEntry] = parseFeed(rss(), 'https://publisher.example/feed');
  assert.equal(rssEntry!.source, 'Publisher');
  assert.match(rssEntry!.summary, /^A company released/);
  assert.equal(rssEntry!.published, Date.parse('2026-11-01T09:00:00Z'));
  const [rdf] = parseFeed('<rdf:RDF xmlns:rdf="urn:rdf" xmlns:dc="urn:dc"><channel><title>RDF source</title></channel><item><title>Entry</title><link>https://source.example/article</link><dc:date>2026-11-01T07:30:00Z</dc:date><description>Comments</description></item></rdf:RDF>', 'https://source.example/feed');
  assert.equal(rdf!.source, 'RDF source'); assert.equal(rdf!.summary, ''); assert.equal(rdf!.published, Date.parse('2026-11-01T07:30:00Z'));
  const [atom] = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom source</title><entry><id>urn:story:1</id><title>A &amp; B</title><link rel="self" href="https://source.example/api"/><link rel="alternate" href="https://source.example/article?a=1&amp;b=2"/><updated>2026-11-01T08:30:00</updated><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">A factual <b>mixed-content</b> summary long enough for the digest.</div></content></entry></feed>', 'https://source.example/atom');
  assert.equal(atom!.link, 'https://source.example/article?a=1&b=2'); assert.equal(atom!.title, 'A & B'); assert.match(atom!.summary, /factual mixed-content summary/); assert.equal(atom!.published, Date.parse('2026-11-01T08:30:00Z'));
});
test('invalid XML, non-feeds, DTD/entities, depth and feed-byte expansion are rejected', () => {
  for (const input of ['<rss><channel></rss>', '<html><title>Login</title></html>', '<!DOCTYPE rss [<!ENTITY bomb "expanded">]><rss>&bomb;</rss>', '<rss>' + '<x>'.repeat(110) + '</x>'.repeat(110) + '</rss>', '<rss>' + 'a'.repeat(4 * 1024 * 1024) + '</rss>']) assert.throws(() => parseFeed(input, 'https://source.example/feed'));
});
test('freshness, dual-key seen, syndication dedupe and newest-50 preserve source gates without topic filtering', () => {
  const item: FeedEntry = { id: 'one', link: 'https://EXAMPLE.com/story/?utm_source=a#part', title: 'Not the literal configured topic', summary: '', source: 'source', feed: 'https://example.com/feed', published: at.getTime() };
  assert.equal(canonicalFeedLink(item.link), 'https://example.com/story');
  const duplicate = { ...item, id: 'syndicated', link: 'https://example.com/story?utm_medium=b' };
  const old = { ...item, id: 'old', link: 'https://example.com/old', published: at.getTime() - 48 * 3600000 - 1 };
  const undated = { ...item, id: 'undated', link: '', published: null };
  const result = selectFeedEntries([item, duplicate, old, undated], new Set(), at.getTime());
  assert.equal(result.items.length, 2); assert.equal(result.funnel.fetched, 4); assert.equal(result.funnel.fresh, 2);
  assert.equal(selectFeedEntries([duplicate], new Set(feedEntryKeys(item)), at.getTime()).items.length, 0);
  assert.equal(selectFeedEntries(Array.from({ length: 60 }, (_, index) => ({ ...item, id: String(index), link: `https://example.com/${index}`, published: at.getTime() - index })), new Set(), at.getTime()).items.length, 50);
});
test('no-new polling leaves UTC day unclaimed and never starts a model', async () => {
  const f = fixture('news-digest', { feeds: 'https://example.com/feed', topics: '' });
  assert.match((await f.run()).summary, /day remains open/); assert.equal(f.models.length, 0); assert.equal(f.store.has('content:news:2026-11-01'), false);
  f.setFeed(async () => ({ text: rss(), contentType: 'text/xml' }));
  assert.equal((await f.run()).summary, 'Supported digest.'); assert.equal(f.models.length, 1);
  f.setFeed(async () => { throw new Error('Must not fetch a claimed day'); });
  assert.match((await f.run()).summary, /already handled/); assert.equal(f.models.length, 1);
  const history = f.store.get('content:news:history')!.value as { seen: string[]; lastDigest: { text: string } };
  assert.ok(history.seen.length >= 1); assert.equal(history.lastDigest.text, 'Supported digest.'); assert.ok(f.logs.some(line => line.includes('Supported digest.')));
});
test('partial feed failure still produces digest; every-feed failure is a real failure', async () => {
  const f = fixture('news-digest', { feeds: ['https://good.example/feed', 'https://bad.example/feed'], topics: 'open source' });
  f.setFeed(async url => { if (url.includes('bad')) throw new Error('Unavailable'); return { text: rss(), contentType: 'text/xml' }; });
  const result = await f.run(); assert.equal(f.models.length, 1); assert.equal((result.details!.feedErrors as string[]).length, 1); assert.match(f.models[0]!.prompt, /New model weights/);
  const failed = fixture('news-digest', { feeds: ['https://bad.example/feed'] }); failed.setFeed(async () => { throw new Error('Unavailable'); });
  await assert.rejects(failed.run(), /Every feed failed/); assert.equal(failed.models.length, 0); assert.equal(failed.store.size, 0);
});
test('simultaneous UTC-day contenders start only one model and failed/unknown digests never mark stories seen', async () => {
  const f = fixture('news-digest', { feeds: 'https://example.com/feed' }); f.setFeed(async () => ({ text: rss(), contentType: 'text/xml' }));
  await Promise.all([f.run(), f.run()]); assert.equal(f.models.length, 1);
  for (const status of ['failed', 'outcome_unknown'] as const) {
    const failed = fixture('news-digest', { feeds: 'https://example.com/feed' }); failed.setFeed(async () => ({ text: rss(), contentType: 'text/xml' })); failed.setModel(async () => ({ status, threadId: 'original-thread', text: '' }));
    await assert.rejects(failed.run()); assert.equal(failed.store.has('content:news:history'), false);
    if (status === 'outcome_unknown') await assert.rejects(failed.run(), NativeTemplateUnknownOutcome);
    else assert.match((await failed.run()).summary, /already handled/);
    assert.equal(failed.models.length, 1);
  }
});
test('source form arguments, repository normalization and UTC ISO week boundaries are deterministic', () => {
  assert.equal(normalizeContentRepository('git@gitlab.example:group/team/project.git', 'gitlab'), 'group/team/project');
  assert.equal(normalizeContentRepository('https://gitlab.example/group/team/project/-/issues/42', 'gitlab'), 'group/team/project');
  assert.equal(isoWeek(new Date('2027-01-01T01:00:00Z')), '2026-W53');
  assert.throws(() => validateContentArguments('github-agents-md-maintainer', { repositories: ['owner/repo'], branchPrefix: '../evil' }), /action.arguments.branchPrefix/);
  assert.throws(() => validateContentArguments('gitlab-issue-to-mr', { projects: [], triggerLabel: 'run' }), /action.arguments.projects/);
  assert.throws(() => validateContentArguments('news-digest', { feeds: 'file:///etc/passwd' }), /action.arguments.feeds/);
  assert.throws(() => validateContentArguments('gitlab-issue-to-mr', { projects: ['group/project'], mergeRequestMode: 'auto' }), /action.arguments.mergeRequestMode/);
});

test('documentation stays quiet behind an open automation PR, including page two', async () => {
  const f = fixture('github-agents-md-maintainer', { repositories: ['owner/repo'] });
  f.setApi(async (_provider, path) => {
    if (path === '/repos/owner/repo') return { default_branch: 'main' };
    const page = new URL(path, 'https://api.github.com').searchParams.get('page');
    if (path.includes('/pulls?') && page === '1') return Array.from({ length: 100 }, (_, index) => ({ number: index + 1, html_url: `https://github.com/owner/repo/pull/${index + 1}`, head: { ref: `unrelated-${index}` } }));
    if (path.includes('/pulls?') && page === '2') return [{ number: 101, html_url: 'https://github.com/owner/repo/pull/101', head: { ref: 'openhands/agents-md-2026-W43' } }];
    throw new Error(`Unexpected ${path}`);
  });
  assert.match((await f.run()).summary, /still open/); assert.equal(f.models.length, 0); assert.equal(f.store.size, 0);
});
function docsFixture(content: string | null, mode: 'draft' | 'ready' = 'ready') {
  const f = fixture('github-agents-md-maintainer', { repositories: ['owner/repo'], pullRequestMode: mode });
  f.setModel(async () => ({ status: 'completed', threadId: 'docs-thread', text: JSON.stringify({ summary: 'Verified commands and corrected stale layout.', content }) }));
  let changed = false;
  f.setApi(async (_provider, path, options) => {
    if (path === '/repos/owner/repo') return { default_branch: 'main', permissions: { push: true } };
    if (path.includes('/pulls?')) return [];
    if (path === '/repos/owner/repo/git/ref/heads/main') return { object: { sha: changed ? newSha : baseSha } };
    if (path.includes('/contents/AGENTS.md?')) return { type: 'file', sha: fileSha, content: Buffer.from('Existing accurate content').toString('base64'), encoding: 'base64' };
    if (path.includes('/git/ref/heads/openhands')) return missing();
    if (path.endsWith(`/git/commits/${baseSha}`)) return { tree: { sha: fileSha } };
    if (path.endsWith(`/git/trees/${fileSha}`)) return { truncated: false, tree: [{ path: 'AGENTS.md', mode: '100755', type: 'blob', sha: fileSha }] };
    if (path.endsWith('/git/blobs') || path.endsWith('/git/trees') || path.endsWith('/git/commits')) return { sha: newSha };
    if (path.endsWith('/git/refs')) return {};
    if (path.endsWith('/pulls') && options?.method === 'POST') return { number: 1, html_url: 'https://github.com/owner/repo/pull/1', head: { ref: 'openhands/agents-md-2026-W44', sha: newSha }, base: { ref: 'main' } };
    throw new Error(`Unexpected ${path}`);
  });
  return { ...f, changeHead: () => { changed = true; } };
}
test('documentation no-change and current-head drift produce no remote mutations', async () => {
  const noChange = docsFixture(null); assert.match((await noChange.run()).summary, /already accurate/); assert.equal(noChange.calls.some(call => call.options), false);
  const stale = docsFixture('New verified content'); stale.setModel(async () => { stale.changeHead(); return { status: 'completed', threadId: 'docs-thread', text: JSON.stringify({ summary: 'Proposal', content: 'Changed' }) }; });
  assert.match((await stale.run()).summary, /default branch changed/); assert.equal(stale.calls.some(call => call.options), false);
});
test('documentation preserves executable files and the requested draft or ready delivery mode without duplicate writes', async () => {
  for (const mode of ['draft', 'ready'] as const) {
    const f = docsFixture('Verified current repository guidance', mode);
    // Distinguish the new branch from the base: free before delivery, pinned after.
    const original = f.context.requestJson.bind(f.context); let delivered = false;
    f.context.requestJson = async <T>(provider: 'github' | 'gitlab', path: string, options?: Parameters<NativeTemplateContext['requestJson']>[2]) => {
      if (path.includes('/git/ref/heads/openhands') && delivered) return { object: { sha: newSha } } as T;
      const result = await original<T>(provider, path, options); if (path.endsWith('/git/refs')) delivered = true; return result;
    };
    assert.match((await f.run()).summary, /opened https:/);
    const writes = f.calls.filter(call => call.options).map(call => ({ path: call.path, ...call.options as { operationKey: string; body: Record<string, unknown> } }));
    assert.equal(new Set(writes.map(call => call.operationKey)).size, writes.length);
    assert.deepEqual(writes.find(call => call.path.endsWith('/git/trees'))!.body.tree, [{ path: 'AGENTS.md', mode: '100755', type: 'blob', sha: newSha }]);
    assert.equal(writes.find(call => call.path.endsWith('/pulls'))!.body.draft, mode === 'draft');
    await f.run(); assert.equal(f.models.length, 1);
    assert.equal(f.calls.filter(call => call.options).length, writes.length);
  }
});

test('GitLab selection uses newest matching add event, not notes, removals, deleted labels or issue IID alone', () => {
  const event = latestGitlabLabelEvent([{ id: 1, action: 'add', label: { name: 'Run' }, created_at: '2026-10-30' }, { id: 9, action: 'remove', label: { name: 'run' }, created_at: '2026-11-01' }, { id: 8, action: 'add', label: null, created_at: '2026-11-01' }, { id: 3, action: 'add', label: { name: 'run' }, created_at: '2026-10-31' }, { id: 4, action: 'add', label: { name: 'run' }, created_at: '2026-10-31' }], 'RUN');
  assert.equal(event!.id, 4); assert.equal(latestGitlabLabelEvent([], 'run'), null);
  for (const action of [{ action: 'update', file_path: '../escape', content: 'x' }, { action: 'create', file_path: '.git/config', content: 'x' }, { action: 'update', file_path: 'src/main.ts' }, { action: 'create', file_path: 'image', content: 'invalid!', encoding: 'base64' }]) assert.throws(() => parseGitlabProposal(JSON.stringify({ summary: 'Summary', actions: [action] })));
});
function gitlabFixture() {
  const f = fixture('gitlab-issue-to-mr', { projects: ['group/team/project'], triggerLabel: 'run', branchPrefix: 'native/issue', mergeRequestMode: 'draft', gitlabApiUrl: 'https://gitlab.com/api/v4' });
  let closed = false, latestEvent = 10;
  const branches = new Set<string>();
  f.setModel(async () => ({ status: 'completed', threadId: 'gitlab-thread', repositoryChanges: [{ path: 'src/new.ts', content: 'export const changed = true;\n' }], commandEvidence: [{ itemId: 'actual-command-receipt', title: 'project quick checks', status: 'completed', exitCode: 0 }], text: JSON.stringify({ summary: 'Implemented the requested behavior with tests.', actions: [{ action: 'create', file_path: 'src/new.ts', content: 'export const changed = true;\n', encoding: 'text' }] }) }));
  f.setApi(async (_provider, path, options) => {
    const root = '/projects/group%2Fteam%2Fproject', resource = path.slice(root.length);
    if (resource === '') return { default_branch: 'main', permissions: { project_access: { access_level: 30 } } };
    if (resource.startsWith('/issues?')) return [{ iid: 42, title: 'Requested change', state: 'opened', labels: ['run'] }];
    if (resource === '/issues/42') return { iid: 42, title: 'Requested change', description: 'Actual current requirement', state: closed ? 'closed' : 'opened', labels: ['run'] };
    if (resource.startsWith('/issues/42/resource_label_events')) return [{ id: latestEvent, created_at: '2026-11-01T09:00:00Z', action: 'add', label: { name: 'run' } }];
    if (resource.startsWith('/issues/42/notes?')) return [{ id: 1, body: 'Current discussion and constraints', created_at: '2026-11-01T09:01:00Z' }];
    if (resource === '/issues/42/notes' && options?.method === 'POST') return { id: 123 };
    if (resource === '/issues/42/notes/123' && options?.method === 'PUT') return { id: 123 };
    if (resource === '/repository/branches/main') return { name: 'main', commit: { id: baseSha } };
    if (resource.startsWith('/repository/branches/native%2Fissue-42')) {
      const branch = decodeURIComponent(resource.slice('/repository/branches/'.length));
      return branches.has(branch) ? { name: branch, commit: { id: newSha } } : missing();
    }
    if (resource.startsWith('/repository/files/')) return missing();
    if (resource === '/repository/commits' && options?.method === 'POST') { const body = options.body as { branch: string }; branches.add(body.branch); return { id: newSha, parent_ids: [baseSha] }; }
    if (resource === '/merge_requests' && options?.method === 'POST') { const body = options.body as { source_branch: string }; return { iid: 7, web_url: 'https://gitlab.com/group/team/project/-/merge_requests/7', source_branch: body.source_branch, target_branch: 'main', sha: newSha }; }
    throw new Error(`Unexpected ${resource}`);
  });
  return { ...f, closeIssue: () => { closed = true; }, reapplyLabel: () => { latestEvent++; } };
}
test('GitLab closes/relabels during model work withhold commits and MR while preserving event claims', async () => {
  for (const change of ['close', 'relabel']) {
    const f = gitlabFixture(); f.setModel(async () => { if (change === 'close') f.closeIssue(); else f.reapplyLabel(); return { status: 'completed', threadId: 'original-thread', text: JSON.stringify({ summary: 'Proposed', actions: [{ action: 'create', file_path: 'new.ts', content: 'x' }] }) }; });
    assert.match((await f.run()).summary, /closed or triggering label changed/);
    assert.equal(f.calls.some(call => call.path.endsWith('/repository/commits') || call.path.endsWith('/merge_requests')), false);
  }
});
test('GitLab atomically commits a proposal, verifies heads, opens a draft MR and dedupes the label application', async () => {
  const f = gitlabFixture(); assert.match((await f.run()).summary, /opened https:/);
  assert.match(f.models[0]!.prompt, /Actual current requirement/); assert.match(f.models[0]!.prompt, /Current discussion and constraints/); assert.equal(f.models[0]!.repository!.ref, baseSha); assert.equal(f.models[0]!.repository!.write, true);
  const writes = f.calls.filter(call => call.options).map(call => ({ path: call.path, ...call.options as { operationKey: string; body: Record<string, unknown> } }));
  assert.ok(writes.every(call => call.operationKey.startsWith('content:gitlab:group/team/project:42:label:10:')));
  const commit = writes.find(call => call.path.endsWith('/repository/commits'))!; assert.equal(commit.body.start_sha, baseSha); assert.equal(commit.body.branch, 'native/issue-42');
  const mr = writes.find(call => call.path.endsWith('/merge_requests'))!; assert.equal(mr.body.title, 'Draft: [#42] Requested change'); assert.match(String(mr.body.description), /Closes #42/);
  assert.match(String(mr.body.description), /actual-command-receipt/);
  await f.run(); assert.equal(f.models.length, 1); assert.equal(f.calls.filter(call => call.path.endsWith('/merge_requests') && call.options).length, 1);
});
test('GitLab unknown upstream delivery remains claimed, never posts fabricated completion or retries', async () => {
  const f = gitlabFixture(), original = f.context.requestJson.bind(f.context);
  f.context.requestJson = async <T>(provider: 'github' | 'gitlab', path: string, options?: Parameters<NativeTemplateContext['requestJson']>[2]) => {
    if (path.endsWith('/repository/commits') && options?.method === 'POST') throw new NativeTemplateUnknownOutcome('Commit response lost');
    return original<T>(provider, path, options);
  };
  await assert.rejects(f.run(), NativeTemplateUnknownOutcome); await assert.rejects(f.run(), NativeTemplateUnknownOutcome);
  assert.equal(f.models.length, 1); assert.equal(f.calls.some(call => call.path.endsWith('/merge_requests')), false);
  assert.equal(f.calls.some(call => JSON.stringify(call.options ?? {}).includes('Opened a draft')), false);
});
test('pagination refuses truncated decisions rather than silently accepting the first 100 records', async () => {
  const f = fixture('news-digest', {}); f.setApi(async () => Array.from({ length: 100 }, (_, id) => ({ id })));
  await assert.rejects(paginateJson(f.context, 'gitlab', '/projects/group%2Frepo/issues'), /pagination exceeded/); assert.equal(f.calls.length, 100);
});

test('GitLab refuses model-only or mismatched code and records only actual command receipts', () => {
  const proposal = parseGitlabProposal(JSON.stringify({ summary: 'Agent says tests passed', actions: [{ action: 'create', file_path: 'src/file.ts', content: 'actual file' }] }));
  const base: NativeAgentResult = { threadId: 'thread', status: 'completed', text: '', repositoryChanges: [{ path: 'src/file.ts', content: 'actual file' }], commandEvidence: [] };
  assert.match(validateGitlabArtifacts(proposal, base), /No commands were executed/);
  assert.throws(() => validateGitlabArtifacts(proposal, { ...base, repositoryChanges: undefined }), /model-only/);
  assert.throws(() => validateGitlabArtifacts(proposal, { ...base, repositoryChanges: [{ path: 'src/file.ts', content: 'other bytes' }] }), /differs from actual worktree/);
  assert.throws(() => validateGitlabArtifacts(proposal, { ...base, repositoryChanges: [] }), /does not match/);
  assert.match(validateGitlabArtifacts(proposal, { ...base, commandEvidence: [{ itemId: 'real-failure', title: 'test', status: 'failed', exitCode: 1 }] }), /failed; exit 1; receipt real-failure/);
});
test('reapplying a GitLab trigger label opens a new numbered branch without rewriting the prior attempt', async () => {
  const f = gitlabFixture(); await f.run(); f.reapplyLabel(); await f.run();
  const commits = f.calls.filter(call => call.path.endsWith('/repository/commits') && call.options).map(call => call.options as { operationKey: string; body: { branch: string } });
  assert.equal(commits.length, 2); assert.equal(commits[0]!.body.branch, 'native/issue-42'); assert.equal(commits[1]!.body.branch, 'native/issue-42-2');
  assert.notEqual(commits[0]!.operationKey, commits[1]!.operationKey); assert.equal(f.models.length, 2);
});
test('GitLab reconciles a lost MR response by exact branch/head readback without another POST', async () => {
  const f = gitlabFixture(), original = f.context.requestJson.bind(f.context);
  f.context.requestJson = async <T>(provider: 'github' | 'gitlab', path: string, options?: Parameters<NativeTemplateContext['requestJson']>[2]) => {
    if (path.includes('/merge_requests?state=all')) return [{ iid: 7, web_url: 'https://gitlab.com/group/team/project/-/merge_requests/7', source_branch: 'native/issue-42', target_branch: 'main', sha: newSha }] as T;
    const response = await original<T>(provider, path, options);
    if (path.endsWith('/merge_requests') && options?.method === 'POST') throw new NativeTemplateUnknownOutcome('Response lost after delivery');
    return response;
  };
  assert.match((await f.run()).summary, /opened https:/);
  assert.equal(f.calls.filter(call => call.path.endsWith('/merge_requests') && call.options).length, 1);
  await f.run(); assert.equal(f.models.length, 1);
});

test('successful digest seen fingerprints suppress next-day coverage, while empty output remembers nothing', async () => {
  const f = fixture('news-digest', { feeds: 'https://example.com/feed', topics: [] });
  f.setFeed(async () => ({ text: rss(), contentType: 'text/xml' })); await f.run();
  f.context.now.setUTCDate(2); assert.match((await f.run()).summary, /Nothing new/); assert.equal(f.models.length, 1); assert.equal(f.store.has('content:news:2026-11-02'), false);
  const empty = fixture('news-digest', { feeds: 'https://example.com/feed' }); empty.setFeed(async () => ({ text: rss(), contentType: 'text/xml' })); empty.setModel(async () => ({ threadId: 'empty-thread', status: 'completed', text: '  ' }));
  assert.match((await empty.run()).summary, /without a digest/); assert.equal(empty.store.has('content:news:history'), false);
});
test('news history CAS conflict is merged without re-running the model', async () => {
  const f = fixture('news-digest', { feeds: 'https://example.com/feed' }), original = f.context.state.compareAndSet;
  f.setFeed(async () => ({ text: rss(), contentType: 'text/xml' })); let collided = false;
  f.context.state.compareAndSet = async (key, revision, value) => {
    if (key === 'content:news:history' && !collided) {
      collided = true; f.store.set(key, { revision: 1, value: { seen: ['other-day-story'] } }); throw Object.assign(new Error('Concurrent day completed'), { code: 'revision_conflict' });
    }
    return original(key, revision, value);
  };
  await f.run(); assert.equal(f.models.length, 1);
  const history = f.store.get('content:news:history')!.value as { seen: string[] }; assert.ok(history.seen.includes('other-day-story')); assert.ok(history.seen.length > 1);
});
test('unknown, null and non-source argument spellings are rejected with precise source form paths', () => {
  assert.throws(() => validateContentArguments('news-digest', { feeds: null }), /action.arguments.feeds/);
  assert.throws(() => validateContentArguments('github-agents-md-maintainer', { repositories: ['owner/repo'], branch_prefix: 'wrong-name' }), /action.arguments.branch_prefix/);
  assert.throws(() => validateContentArguments('gitlab-issue-to-mr', { projects: ['group/project'], triggerLabel: null }), /action.arguments.triggerLabel/);
  assert.doesNotThrow(() => validateContentArguments('news-digest', { feeds: ['', ' https://example.com/feed ', ''], topics: ['', ''] }));
});
test('binary GitLab proposals must match actual captured bytes, never UTF-8-replaced text', () => {
  const encoded = Buffer.from([0, 255, 254, 1]).toString('base64');
  const proposal = parseGitlabProposal(JSON.stringify({ summary: 'Binary fixture', actions: [{ action: 'create', file_path: 'fixtures/data.bin', content: encoded, encoding: 'base64' }] }));
  assert.match(validateGitlabArtifacts(proposal, { threadId: 'binary-thread', status: 'completed', text: '', repositoryChanges: [{ path: 'fixtures/data.bin', content: encoded, encoding: 'base64' }], commandEvidence: [] }), /No commands/);
  assert.throws(() => validateGitlabArtifacts(proposal, { threadId: 'binary-thread', status: 'completed', text: '', repositoryChanges: [{ path: 'fixtures/data.bin', content: 'replacement text' }], commandEvidence: [] }), /differs from actual/);
});

test('GitLab default-head drift after implementation withholds every code write', async () => {
  const f = gitlabFixture(), original = f.context.requestJson.bind(f.context); let mainReads = 0;
  f.context.requestJson = async <T>(provider: 'github' | 'gitlab', path: string, options?: Parameters<NativeTemplateContext['requestJson']>[2]) => {
    if (path.endsWith('/repository/branches/main') && ++mainReads > 1) return { name: 'main', commit: { id: newSha } } as T;
    return original<T>(provider, path, options);
  };
  assert.match((await f.run()).summary, /default head changed/);
  assert.equal(f.calls.some(call => call.path.endsWith('/repository/commits') || call.path.endsWith('/merge_requests')), false);
});
test('GitLab cannot publish a text-only model patch when the actual snapshot did not change', async () => {
  const f = gitlabFixture(); f.setModel(async () => ({ status: 'completed', threadId: 'unbacked-thread', repositoryChanges: [], commandEvidence: [], text: JSON.stringify({ summary: 'Claimed implementation', actions: [{ action: 'create', file_path: 'new.ts', content: 'not actually written' }] }) }));
  await assert.rejects(f.run(), /does not match the actual repository/);
  assert.equal(f.calls.some(call => call.path.endsWith('/repository/commits') || call.path.endsWith('/merge_requests')), false);
});

test('GitLab publishes actual new executable modes through atomic create plus chmod actions', async () => {
  const f = gitlabFixture(), content = '#!/bin/sh\\necho hello\\n';
  f.setModel(async () => ({ status: 'completed', threadId: 'executable-thread', repositoryChanges: [{ path: 'tools/run.sh', content, mode: '100755' }], commandEvidence: [], text: JSON.stringify({ summary: 'Added executable entrypoint', actions: [{ action: 'create', file_path: 'tools/run.sh', content, mode: '100755' }] }) }));
  await f.run();
  const write = f.calls.find(call => call.path.endsWith('/repository/commits') && call.options)!;
  const options = write.options as { body: { actions: unknown[] } };
  assert.deepEqual(options.body.actions, [{ action: 'create', file_path: 'tools/run.sh', content }, { action: 'chmod', file_path: 'tools/run.sh', execute_filemode: true }]);
});
test('GitLab mode-only changes survive content no-op elimination and cannot be model-invented', async () => {
  const f = gitlabFixture(), content = '#!/bin/sh\\necho hello\\n', original = f.context.requestJson.bind(f.context);
  const proposal = parseGitlabProposal(JSON.stringify({ summary: 'Made entrypoint executable', actions: [{ action: 'update', file_path: 'tools/run.sh', content, mode: '100755' }] }));
  const actual: NativeAgentResult = { status: 'completed', threadId: 'chmod-thread', repositoryChanges: [{ path: 'tools/run.sh', content, mode: '100755' }], commandEvidence: [], text: JSON.stringify(proposal) };
  assert.throws(() => validateGitlabArtifacts(proposal, { ...actual, repositoryChanges: [{ path: 'tools/run.sh', content }] }), /mode differs from actual/);
  f.setModel(async () => actual);
  f.context.requestJson = async <T>(provider: 'github' | 'gitlab', path: string, options?: Parameters<NativeTemplateContext['requestJson']>[2]) => {
    if (path.includes('/repository/files/')) return { last_commit_id: fileSha, encoding: 'base64', content: Buffer.from(content).toString('base64') } as T;
    return original<T>(provider, path, options);
  };
  await f.run();
  const write = f.calls.find(call => call.path.endsWith('/repository/commits') && call.options)!;
  const options = write.options as { body: { actions: unknown[] } };
  assert.deepEqual(options.body.actions, [{ action: 'chmod', file_path: 'tools/run.sh', execute_filemode: true }]);
});
