// Native adaptation of the MIT-licensed pinned OpenHands extensions GitHub workers.
// Source: vendor/openhands-automations/bundles/*/github_client.py and agent_conversation.py.
import { createHash } from 'node:crypto';
import { NativeTemplateUnknownOutcome, type NativeAgentResult, type NativeTemplateContext, type NativeTemplateOutcome } from './ports.ts';

export type RecordValue = Record<string, unknown>;
export type GithubUser = { login?: string; type?: string };
export type GithubComment = { id: number; body?: string | null; user?: GithubUser; created_at?: string; updated_at?: string };
export type GithubIssue = { number: number; title: string; body?: string | null; state: string; state_reason?: string; updated_at?: string; created_at?: string; labels?: { name: string }[]; pull_request?: unknown; user?: GithubUser };
export type GithubPr = GithubIssue & { draft?: boolean; head: { sha: string; ref: string; repo?: { full_name?: string } | null }; base: { ref: string; sha?: string; repo?: { full_name?: string; owner?: { type?: string } } }; requested_reviewers?: GithubUser[]; changed_files?: number };
export type GithubReview = { id: number; commit_id: string; state: string; body?: string; user?: GithubUser; submitted_at?: string };
export type GithubEvent = { id: number; event: string; created_at?: string; label?: { name?: string }; actor?: GithubUser; requested_reviewer?: GithubUser };
export type GithubArguments = { repositories: string[]; githubTokenSecret: string; triggerLabel: string; branchPrefix: string; pullRequestMode: 'draft' | 'ready'; triggerReviewer: string; maxNewPerRun: number; reviewTone: 'concise' | 'thorough' | 'friendly'; maintainers: string[] };
export const digest = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex');
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function object(value: unknown, label = 'value'): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as RecordValue;
}
export function text(value: unknown, label: string, maximum = 20000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`Invalid ${label}`);
  return value;
}
export function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`Invalid ${label}`);
  return Number(value);
}
export function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/.test(value)) throw new Error('Invalid GitHub commit SHA');
  return value;
}
export const labels = (issue: GithubIssue): Set<string> => new Set((issue.labels ?? []).map(label => label.name));
export const login = (user: GithubUser | undefined): string => (user?.login ?? '').toLowerCase();
export const encode = (value: string): string => encodeURIComponent(value);
export function exactFields(value: RecordValue, keys: readonly string[]): void {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) throw new Error(`Expected exactly: ${keys.join(', ')}`);
}
export function parseArguments(id: string, input: Readonly<RecordValue>): GithubArguments {
  const fields = id === 'github-issue-to-pr' ? ['repositories', 'githubTokenSecret', 'triggerLabel', 'branchPrefix', 'pullRequestMode'] : id === 'github-pr-reviewer' ? ['repositories', 'githubTokenSecret', 'triggerLabel', 'triggerReviewer', 'maxNewPerRun', 'reviewTone', 'maintainers'] : id === 'github-issue-triage' ? ['repositories', 'githubTokenSecret'] : [];
  if (!fields.length) throw new Error('Not a GitHub agent template');
  for (const key of Object.keys(input)) if (!fields.includes(key)) throw new Error(`Unknown ${id} source-form argument: ${key}`);
  if (!Array.isArray(input.repositories) || !input.repositories.length || input.repositories.length > 20 || input.repositories.some(value => typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) || value.split('/').some(part => part === '.' || part === '..'))) throw new Error('repositories must contain 1–20 GitHub owner/repo names');
  const repositories = input.repositories as string[];
  if (new Set(repositories.map(value => value.toLowerCase())).size !== repositories.length) throw new Error('Duplicate GitHub repositories');
  const secret = input.githubTokenSecret ?? 'GITHUB_PERSONAL_ACCESS_TOKEN';
  if (typeof secret !== 'string' || !/^[A-Z_][A-Z0-9_]{0,199}$/.test(secret)) throw new Error('githubTokenSecret must be a secret NAME, not a credential');
  const triggerLabel = text(input.triggerLabel ?? (id === 'github-pr-reviewer' ? 'openhands-review' : 'openhands'), 'triggerLabel', 50);
  const branchPrefix = text(input.branchPrefix ?? 'openhands/issue', 'branchPrefix', 50);
  if (/\s|[~^:?*\[\\\x00-\x1f\x7f]|\.\.|@\{|\/\/|^\/|\/$|\.$|\.lock(?:\/|$)/.test(branchPrefix)) throw new Error('branchPrefix must form a safe Git branch');
  const pullRequestMode = input.pullRequestMode ?? 'draft';
  if (pullRequestMode !== 'draft' && pullRequestMode !== 'ready') throw new Error('Invalid pullRequestMode');
  const triggerReviewer = text(input.triggerReviewer ?? 'all-hands-bot', 'triggerReviewer', 39);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(triggerReviewer)) throw new Error('Invalid triggerReviewer login');
  const maxNewPerRun = input.maxNewPerRun ?? 2;
  if (!Number.isSafeInteger(maxNewPerRun) || Number(maxNewPerRun) < 1) throw new Error('maxNewPerRun must be a positive safe integer');
  const reviewTone = input.reviewTone ?? 'concise';
  if (reviewTone !== 'concise' && reviewTone !== 'thorough' && reviewTone !== 'friendly') throw new Error('Invalid reviewTone');
  const roster = input.maintainers ?? '';
  if (typeof roster !== 'string' || roster.length > 4000) throw new Error('maintainers must be comma-separated GitHub logins');
  const maintainers = [...new Map(roster.split(',').map(item => item.trim()).filter(Boolean).map(item => [item.toLowerCase(), item])).values()];
  if (maintainers.some(item => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(item))) throw new Error('Invalid maintainer login');
  // The original secret-name field is provenance only. Authentication always stays in the scoped Integration connector.
  return { repositories, githubTokenSecret: secret, triggerLabel, branchPrefix, pullRequestMode, triggerReviewer, maxNewPerRun: Number(maxNewPerRun), reviewTone, maintainers };
}

export class GithubRepository {
  readonly path: string;
  readonly context: NativeTemplateContext;
  readonly name: string;
  constructor(context: NativeTemplateContext, name: string) {
    this.context = context;
    this.name = name;
    this.path = `/repos/${name}`;
  }
  get<T>(path: string): Promise<T> { return this.context.requestJson<T>('github', this.path + path); }
  async pages<T>(path: string, field?: string): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const value = await this.get<unknown>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const container = field ? object(value, 'GitHub page') : null;
      const batch = field ? container![field] : value;
      if (!Array.isArray(batch)) throw new Error('Expected a paginated GitHub list');
      result.push(...batch as T[]);
      const total = container?.total_count;
      if (batch.length < 100 || (typeof total === 'number' && result.length >= total)) return result;
    }
    throw new Error('GitHub pagination exceeded 100 pages; refusing a truncated decision');
  }
  async issues(): Promise<GithubIssue[]> { return (await this.pages<GithubIssue>('/issues?state=open')).filter(issue => !('pull_request' in issue)); }
  async dependenciesComplete(issue: GithubIssue): Promise<boolean> {
    for (const line of (issue.body ?? '').matchAll(/^Depends on:\s*(.+)$/gim)) {
      for (const match of line[1]!.matchAll(/#(\d+)/g)) {
        let dependency: GithubIssue;
        try { dependency = await this.get<GithubIssue>(`/issues/${positive(Number(match[1]), 'dependency')}`); }
        catch (error) { if (isNotFound(error)) return false; throw error; }
        if (dependency.state !== 'closed' || dependency.state_reason !== 'completed') return false;
      }
    }
    return true;
  }
  async statuses(head: string): Promise<Map<string, string>> {
    const values = new Map<string, string>();
    for (const status of await this.pages<{ context: string; state: string }>(`/commits/${sha(head)}/statuses`)) if (!values.has(status.context)) values.set(status.context, status.state);
    return values;
  }
  async currentPr(number: number, head: string): Promise<GithubPr | null> {
    const current = await this.get<GithubPr>(`/pulls/${positive(number, 'pull request')}`);
    return current.state === 'open' && current.head.sha === head ? current : null;
  }
  async mutate<T>(key: string, method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown, reconcile?: () => Promise<T | undefined>): Promise<T> {
    const operation = `github-operation:${digest([this.name.toLowerCase(), key])}`;
    const fingerprint = digest([method, this.path + path, body ?? null]);
    const claimed = await this.context.state.claim(operation, { status: 'posting', fingerprint });
    if (!claimed) {
      const previous = await this.context.state.read(operation);
      const record = object(previous?.value, 'stored GitHub operation');
      if (record.fingerprint !== fingerprint) throw new Error('GitHub operation identity conflict');
      if (record.status === 'completed') return record.result as T;
      let found: T | undefined;
      try { found = await reconcile?.(); }
      catch { throw new NativeTemplateUnknownOutcome('A GitHub write remains uncertain because its authoritative reconciliation read failed.'); }
      if (found !== undefined) {
        await this.context.state.compareAndSet(operation, previous!.revision, { status: 'completed', fingerprint, result: found });
        return found;
      }
      throw new NativeTemplateUnknownOutcome('A GitHub write has an unresolved durable intent; no duplicate request was sent.');
    }
    let result: T;
    try { result = await this.context.requestJson<T>('github', this.path + path, { method, body, operationKey: operation }); }
    catch {
      // Even a missing response may have committed. The intent is never erased or blindly retried.
      let found: T | undefined;
      try { found = await reconcile?.(); }
      catch { throw new NativeTemplateUnknownOutcome('GitHub write and its reconciliation read are unconfirmed; retained the original intent.'); }
      if (found === undefined) throw new NativeTemplateUnknownOutcome('GitHub did not confirm a write; retained its durable intent for reconciliation.');
      result = found;
    }
    const current = await this.context.state.read(operation);
    await this.context.state.compareAndSet(operation, current!.revision, { status: 'completed', fingerprint, result: result ?? null });
    return result;
  }
}
export function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  return value.status === 404 || value.statusCode === 404 || value.code === 'not_found';
}

export async function linkedIssueContext(repo: GithubRepository, contents: (string | null | undefined)[], exceptNumber: number): Promise<RecordValue[]> {
  const numbers = new Set<number>();
  for (const value of contents) {
    for (const match of (value ?? '').matchAll(/(?<![A-Za-z0-9_/.~-])#(\d+)\b/g)) numbers.add(positive(Number(match[1]), 'linked issue'));
    for (const match of (value ?? '').matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d+)\b/gi)) if (match[1]!.toLowerCase() === repo.name.toLowerCase()) numbers.add(positive(Number(match[2]), 'linked issue'));
  }
  numbers.delete(exceptNumber);
  if (numbers.size > 100) throw new Error('Linked-issue context exceeds the native 100-reference limit; no partial recommendation is published');
  const result: RecordValue[] = [];
  for (const number of numbers) {
    let issue: GithubIssue;
    try { issue = await repo.get<GithubIssue>(`/issues/${number}`); }
    catch (error) { if (isNotFound(error)) { result.push({ number, unavailable: 'not_found' }); continue; } throw error; }
    const { title, body, state, labels: issueLabels } = issue;
    const context: RecordValue = { issue: { number, title, body, state, labels: issueLabels }, discussion: await repo.pages(`/issues/${number}/comments`) };
    if ('pull_request' in issue) {
      context.pull_request = await repo.get(`/pulls/${number}`);
      context.reviews = await repo.pages(`/pulls/${number}/reviews`);
      context.inline_comments = await repo.pages(`/pulls/${number}/comments`);
    }
    result.push(context);
  }
  return result;
}
export async function stage(context: NativeTemplateContext, key: string, prompt: string, repository: string, ref: string, write = false): Promise<NativeAgentResult> {
  context.signal.throwIfAborted();
  const result = await context.runAgent({ key, prompt, repository: { provider: 'github', repository, ref: sha(ref), write } });
  if (result.status === 'outcome_unknown') throw new NativeTemplateUnknownOutcome(`Native Chat ${result.threadId} has an unknown result; it must be reconciled, not restarted.`);
  if (result.status !== 'completed') throw new Error(`Native Chat ${result.threadId} failed`);
  return result;
}
export async function save(context: NativeTemplateContext, key: string, value: unknown): Promise<void> {
  const current = await context.state.read(key);
  await context.state.compareAndSet(key, current?.revision ?? null, value);
}
export async function delivery(context: NativeTemplateContext, key: string, run: () => Promise<NativeTemplateOutcome>): Promise<NativeTemplateOutcome> {
  const stateKey = `github-delivery:${digest(key)}`;
  if (!await context.state.claim(stateKey, { status: 'active', executionId: context.request.executionId })) {
    const previous = object((await context.state.read(stateKey))?.value, 'stored delivery');
    if (previous.status === 'completed') return previous.outcome as NativeTemplateOutcome;
    // Stable Chat stage keys and operation intents reconcile this delivery without dispatching another turn.
  }
  const outcome = await run();
  await save(context, stateKey, { status: 'completed', outcome });
  return outcome;
}
export function payload(context: NativeTemplateContext): RecordValue | null {
  if (context.request.payload === null) return null;
  const outer = object(context.request.payload, 'event payload');
  const event = outer.event;
  const raw = event === undefined ? outer : object(event, 'event').payload;
  const parsed = object(raw, 'event payload');
  if (Buffer.byteLength(JSON.stringify(parsed)) > 256000) throw new Error('Event payload exceeds the native GitHub limit');
  return parsed;
}
export function provenance(context: NativeTemplateContext, threadId: string): string {
  const action = context.request.config.action;
  if (action.kind !== 'template' || !action.providerInstanceId || !action.model) throw new Error('Native GitHub agent template requires the frozen Provider/model selection');
  const clean = (value: string) => value.replace(/[\r\n`]/g, '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `Native Chat: ${clean(threadId)} · Provider: ${clean(action.providerInstanceId)} · Model: ${clean(action.model)}`;
}
export const disclosure = '_Generated by an AI agent on behalf of the PM automation owner._';
export function jsonResult(raw: string): RecordValue {
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('Agent artifact exceeds native publication limit');
  return object(JSON.parse(raw), 'agent artifact');
}
export function outcome(summary: string, threadIds: string[], details?: RecordValue): NativeTemplateOutcome { return { summary, threadIds, ...(details ? { details } : {}) }; }
