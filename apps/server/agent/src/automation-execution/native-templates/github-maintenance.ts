// Adapted from the pinned OpenHands maintenance workers, Copyright (c) 2025 OpenHands.
// MIT license: vendor/openhands-automations/LICENSE.extensions.
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { validateNativeTemplateArguments } from '../../../../../../packages/automation-resources/native-template-arguments.ts'
import { NativeTemplateUnknownOutcome, type NativeTemplateContext, type NativeTemplateHandler, type NativeTemplateId, type NativeTemplateState } from './ports.ts';

const WATCHDOG = 'github-delivery-watchdog';
const STALE = 'github-stale-ci-pr-closer';
const WEEK = 7 * 24 * 60 * 60 * 1000;
const WARNING_MARKER = '<!-- openhands-stale-ci-warning -->';
const CLOSE_MARKER = '<!-- openhands-stale-ci-close -->';
const PASSING_CONCLUSIONS: Record<string, true> = { success: true, neutral: true, skipped: true };

/** Pinned worker.py PULL_REQUESTS_QUERY; the connector allowlists this read-only operation. */
export const githubMaintenancePullRequestsQuery = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 40, after: $cursor, states: OPEN) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number isDraft baseRefName headRefOid
        author { login }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  totalCount
                  nodes {
                    __typename
                    ... on CheckRun {
                      databaseId name status conclusion startedAt completedAt
                      checkSuite { app { databaseId } }
                    }
                    ... on StatusContext { context state createdAt }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

type MaintenanceId = typeof WATCHDOG | typeof STALE;
type Arguments = { repositories: string[]; githubTokenSecret: string; branchPrefix?: string };
const pullRequestSchema = z.object({
  number: z.number().int().positive(), state: z.enum(['open', 'closed']), draft: z.boolean(),
  mergeable: z.boolean().nullable().optional(), merged: z.boolean().optional(),
  head: z.object({ sha: z.string().min(1), ref: z.string().min(1) }),
  base: z.object({ sha: z.string().min(1), ref: z.string().min(1) }),
  user: z.object({ login: z.string() }).nullable().optional(),
});
const statusSchema = z.object({ context: z.string().min(1), state: z.string().min(1), updated_at: z.string().optional(), created_at: z.string().optional() });
const checkRunSchema = z.object({
  id: z.number().int(), name: z.string().min(1), app: z.object({ id: z.number().int().nullable().optional() }).nullable().optional(),
  status: z.string().min(1), conclusion: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(), started_at: z.string().nullable().optional(),
});
const requiredCheckSchema = z.object({ context: z.string().min(1), integration_id: z.number().int().nullable().optional() });
const commentSchema = z.object({ id: z.number().int(), body: z.string().nullable().optional(), created_at: z.string(), user: z.object({ login: z.string() }).nullable().optional() });
const warningSchema = z.object({ at: z.number().finite(), head: z.string().min(1), commentId: z.number().int(), operationKey: z.string().min(1) });
const staleStateSchema = z.object({
  version: z.literal(1),
  prs: z.record(z.string(), z.object({ head: z.string().min(1), firstFailedAt: z.number().finite(), resetAt: z.number().finite().optional(), warning: warningSchema.optional() })),
});
const workflowRunSchema = z.object({
  id: z.number().int(), head_sha: z.string().min(1), run_number: z.number().int(), workflow_id: z.number().int(),
  event: z.string(), head_branch: z.string().nullable(), status: z.string(), conclusion: z.string().nullable(),
});
const graphqlContextSchema = z.discriminatedUnion('__typename', [
  z.object({
    __typename: z.literal('CheckRun'), databaseId: z.number().int(), name: z.string().min(1),
    status: z.string(), conclusion: z.string().nullable(), startedAt: z.string().nullable(), completedAt: z.string().nullable(),
    checkSuite: z.object({ app: z.object({ databaseId: z.number().int() }).nullable() }).nullable(),
  }),
  z.object({ __typename: z.literal('StatusContext'), context: z.string().min(1), state: z.string(), createdAt: z.string() }),
]);
const graphqlConnectionSchema = z.object({
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  nodes: z.array(z.object({
    number: z.number().int().positive(), isDraft: z.boolean(), baseRefName: z.string().min(1), headRefOid: z.string().min(1),
    author: z.object({ login: z.string() }).nullable(),
    commits: z.object({ nodes: z.array(z.object({ commit: z.object({
      statusCheckRollup: z.object({ contexts: z.object({ totalCount: z.number().int().nonnegative(), nodes: z.array(graphqlContextSchema) }) }).nullable(),
    }) })) }),
  })),
});
const operationSchema = z.object({ status: z.enum(['pending', 'completed', 'failed', 'unknown']), executionId: z.string(), result: z.unknown().optional() });
const mutationSchema = z.object({ number: z.number().int().positive(), head: z.string().min(1), kind: z.enum(['merge', 'close', 'label', 'update', 'comment']) });
const pendingSchema = z.record(z.string(), mutationSchema);
type PullRequest = z.infer<typeof pullRequestSchema>;
type CommitStatus = z.infer<typeof statusSchema>;
type CheckRun = z.infer<typeof checkRunSchema>;
type RequiredCheck = z.infer<typeof requiredCheckSchema>;
type Comment = z.infer<typeof commentSchema>;
type CIResult = { state: 'unconfigured' | 'pending' | 'passing' | 'failing'; failedAt: number | null };
type StalePR = { number: number; draft: boolean; head: string; base: string; author: string; ci: CIResult };
type StaleRecord = z.infer<typeof staleStateSchema>['prs'][string];
type StaleState = z.infer<typeof staleStateSchema>;
type Operation = z.infer<typeof operationSchema>;
type Mutation = z.infer<typeof mutationSchema>;
type Evidence = { repository: string; pr: number; outcome: string; reason?: string };

export function validateGithubMaintenanceArguments(id: NativeTemplateId, args: Readonly<Record<string, unknown>>): void {
  if (id !== WATCHDOG && id !== STALE) throw new Error('Not a GitHub maintenance template');
  const issues = validateNativeTemplateArguments(id, args);
  // Source secret-name syntax and all required persisted defaults are validated centrally.
  if (issues.length) throw new Error(issues.map(issue => `${issue.path}: ${issue.message}`).join('; '));
}

function argumentsFor(context: NativeTemplateContext, id: MaintenanceId): Arguments {
  // Required form defaults are persisted by setup, not inferred from an omitted frozen input.
  validateGithubMaintenanceArguments(id, context.arguments);
  return z.object({ repositories: z.array(z.string()), githubTokenSecret: z.string(), branchPrefix: z.string().optional() }).parse(context.arguments);
}
function record(value: unknown, label: string): Record<string, unknown> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success) throw new Error(`Invalid GitHub ${label}`);
  return parsed.data;
}
function timestamp(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error('Invalid GitHub timestamp');
  return result;
}
function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = 'status' in error ? error.status : undefined;
  return typeof status === 'number' ? status : undefined;
}
function unknownOutcome(error: unknown): boolean {
  return error instanceof NativeTemplateUnknownOutcome || (!!error && typeof error === 'object' && 'code' in error && error.code === 'outcome_unknown');
}
function failureReason(error: unknown): string {
  const status = statusCode(error);
  return status === undefined ? 'GitHub request or response failed' : `GitHub HTTP ${status}`;
}
function root(repository: string): string { return `/repos/${repository}`; }
function stableKey(...parts: (string | number)[]): string { return `github-maintenance:${JSON.stringify(parts)}`; }
function checkSignal(context: NativeTemplateContext): void { context.signal.throwIfAborted(); }
async function gh<T>(context: NativeTemplateContext, repository: string, path: string): Promise<T> {
  checkSignal(context);
  return context.requestJson<T>('github', `${root(repository)}${path}`);
}
async function pages(context: NativeTemplateContext, repository: string, path: string): Promise<unknown[]> {
  const values: unknown[] = [];
  for (let page = 1; page <= 100; page++) {
    const batch = z.array(z.unknown()).parse(await gh(context, repository, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`));
    values.push(...batch);
    if (batch.length < 100) return values;
  }
  throw new Error('GitHub pagination exceeded limit');
}
function validHead(pr: PullRequest, sha: string): boolean {
  return pr.state === 'open' && pr.head?.sha === sha && pr.draft === false;
}
async function currentPR(context: NativeTemplateContext, repository: string, number: number): Promise<PullRequest> {
  const pr = pullRequestSchema.parse(await gh(context, repository, `/pulls/${number}`));
  if (pr.number !== number) throw new Error('Invalid GitHub pull request number');
  return pr;
}

async function pendingMutation(context: NativeTemplateContext, repository: string, key: string, mutation: Mutation | null): Promise<void> {
  const stateKey = `pending:${repository.toLowerCase()}`;
  const stored = await context.state.read(stateKey);
  const pending = stored ? pendingSchema.parse(stored.value) : {};
  if (mutation) pending[key] = mutation;
  else if (Object.hasOwn(pending, key)) delete pending[key];
  else return;
  await context.state.compareAndSet(stateKey, stored?.revision ?? null, pending);
}

/** Cross-execution receipt: an interrupted or unknown mutation is reconciled by reads, never resent. */
async function writeOnce<T>(context: NativeTemplateContext, key: string, repository: string, path: string, method: 'POST' | 'PUT' | 'PATCH', body: unknown, response: z.ZodType<T>, mutation: Mutation, reconcile?: () => Promise<T | undefined>): Promise<T> {
  const stateKey = `operation:${key}`;
  let stored = await context.state.read(stateKey);
  let operation = stored ? operationSchema.parse(stored.value) : null;
  // A definite rejection may be attempted again by a later scheduled execution, never the same one.
  let owns = false;
  if (stored && operation?.status === 'failed' && operation.executionId !== context.request.executionId) {
    await pendingMutation(context, repository, key, mutation);
    stored = await context.state.compareAndSet(stateKey, stored.revision, { status: 'pending', executionId: context.request.executionId } satisfies Operation);
    operation = operationSchema.parse(stored.value);
    owns = true;
  } else if (!stored) {
    await pendingMutation(context, repository, key, mutation);
    owns = await context.state.claim(stateKey, { status: 'pending', executionId: context.request.executionId } satisfies Operation);
    stored = await context.state.read(stateKey);
  }
  if (!stored) throw new NativeTemplateUnknownOutcome('Maintenance operation is already owned');
  operation = operationSchema.parse(stored.value);
  if (owns) {
    try {
      checkSignal(context);
      // The semantic claim is definition-scoped; only definite failures get a new execution attempt key.
      const result = response.parse(await context.requestJson('github', `${root(repository)}${path}`, { method, body, operationKey: `${key}:attempt:${operation.executionId}` }));
      await context.state.compareAndSet(stateKey, stored.revision, { ...operation, status: 'completed', result });
      await pendingMutation(context, repository, key, null);
      return result;
    } catch (error) {
      const status = statusCode(error);
      const rejected = !unknownOutcome(error) && status !== undefined && status >= 400 && status < 500;
      const latest = await context.state.read(stateKey);
      if (latest) {
        const current = operationSchema.parse(latest.value);
        if (current.status !== 'completed') await context.state.compareAndSet(stateKey, latest.revision, { ...current, status: rejected ? 'failed' : 'unknown' });
      }
      if (!rejected) throw new NativeTemplateUnknownOutcome('GitHub maintenance write outcome is unknown; it will not be retried');
      await pendingMutation(context, repository, key, null);
      throw error;
    }
  }
  if (operation.status === 'completed') return response.parse(operation.result);
  if (operation.status === 'failed') throw new Error('This execution already received a definite GitHub maintenance rejection');
  const confirmed = await reconcile?.();
  if (confirmed !== undefined) {
    await context.state.compareAndSet(stateKey, stored.revision, { ...operation, status: 'completed', result: confirmed });
    await pendingMutation(context, repository, key, null);
    return confirmed;
  }
  throw new NativeTemplateUnknownOutcome('GitHub maintenance write remains unconfirmed; it will not be retried');
}

async function reconcilePending(context: NativeTemplateContext, repository: string, evidence: Evidence[]): Promise<Set<number>> {
  const stored = await context.state.read(`pending:${repository.toLowerCase()}`);
  const pending = stored ? pendingSchema.parse(stored.value) : {};
  const blocked = new Set<number>();
  for (const [key, mutation] of Object.entries(pending)) {
    const receipt = await context.state.read(`operation:${key}`);
    if (!receipt) { blocked.add(mutation.number); context.log(JSON.stringify({ repository, pr: mutation.number, outcome: 'outcome_unknown', operation: mutation.kind })); continue; }
    const operation = operationSchema.parse(receipt.value);
    if (operation.status === 'completed' || operation.status === 'failed') { await pendingMutation(context, repository, key, null); continue; }
    let result: unknown;
    if (mutation.kind === 'merge' || mutation.kind === 'close') {
      const pr = await currentPR(context, repository, mutation.number);
      if (pr.head.sha === mutation.head && (mutation.kind === 'merge' ? pr.merged === true : pr.state === 'closed' && pr.merged === false)) result = mutation.kind === 'merge' ? { merged: true } : pr;
    } else if (mutation.kind === 'label') {
      const labels = z.array(z.object({ name: z.string() })).parse(await pages(context, repository, `/issues/${mutation.number}/labels`));
      if (labels.some(label => label.name === 'openhands-review')) result = labels;
    }
    if (result !== undefined) {
      await context.state.compareAndSet(`operation:${key}`, receipt.revision, { ...operation, status: 'completed', result });
      await pendingMutation(context, repository, key, null);
      const item = { repository, pr: mutation.number, outcome: `${mutation.kind}-reconciled` };
      evidence.push(item); context.log(JSON.stringify(item));
    } else {
      // No authenticated comment receipt or SHA-conditional update receipt can be inferred from marker/head text.
      blocked.add(mutation.number);
      context.log(JSON.stringify({ repository, pr: mutation.number, outcome: 'outcome_unknown', operation: mutation.kind }));
    }
  }
  return blocked;
}

async function statuses(context: NativeTemplateContext, repository: string, sha: string): Promise<Map<string, string>> {
  const latest = new Map<string, string>();
  for (const item of z.array(statusSchema).parse(await pages(context, repository, `/commits/${encodeURIComponent(sha)}/statuses`))) {
    if (!latest.has(item.context)) latest.set(item.context, item.state);
  }
  return latest;
}
async function actionsPassed(context: NativeTemplateContext, repository: string, sha: string): Promise<boolean> {
  const runs = new Map<number, z.infer<typeof workflowRunSchema>>();
  for (let page = 1; page <= 10; page++) {
    const result = z.object({ total_count: z.number().int().nonnegative(), workflow_runs: z.array(workflowRunSchema) }).parse(await gh(context, repository, `/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100&page=${page}`));
    const batch = result.workflow_runs;
    for (const run of batch) {
      if (run.head_sha !== sha) return false;
      runs.set(run.id, run);
    }
    if (batch.length < 100) {
      if (!Number.isSafeInteger(result.total_count) || result.total_count !== runs.size) return false;
      const latest = new Map<string, z.infer<typeof workflowRunSchema>>();
      for (const run of [...runs.values()].sort((a, b) => b.run_number - a.run_number)) {
        const key = JSON.stringify([run.workflow_id, run.event, run.head_branch]);
        if (!latest.has(key)) latest.set(key, run);
      }
      // The source form declares no required_workflow_ids; an empty Actions set alone is not a rejection.
      return [...latest.values()].every(run => run.status === 'completed' && run.conclusion === 'success');
    }
  }
  return false;
}
async function watchdogGates(context: NativeTemplateContext, repository: string, number: number, sha: string, base: string, branch: RegExp): Promise<{ pr?: PullRequest; reason?: string }> {
  const pr = await currentPR(context, repository, number);
  if (!validHead(pr, sha)) return { reason: 'not-current-open-nondraft-head' };
  if (pr.base.ref !== base || !branch.test(pr.head.ref) || pr.mergeable !== true) return { reason: 'branch-base-or-mergeability' };
  const result = await statuses(context, repository, sha);
  if (result.get('software-factory/tests') !== 'success' || result.get('software-factory/review') !== 'success') return { reason: 'independent-tests-or-review-missing' };
  if ([...result.values()].some(value => value !== 'success')) return { reason: 'commit-status-not-successful' };
  if (!await actionsPassed(context, repository, sha)) return { reason: 'actions-not-successful-or-incomplete' };
  return { pr };
}
async function watchdogPR(context: NativeTemplateContext, repository: string, number: number, sha: string, base: string, branch: RegExp): Promise<Omit<Evidence, 'repository' | 'pr'>> {
  const gated = await watchdogGates(context, repository, number, sha, base, branch);
  if (!gated.pr) return { outcome: 'blocked', reason: gated.reason };
  const comparison = z.object({ status: z.string(), behind_by: z.number().int().optional() }).parse(await gh(context, repository, `/compare/${encodeURIComponent(gated.pr.base.sha)}...${encodeURIComponent(sha)}`));
  if ((comparison.status === 'behind' || comparison.status === 'diverged') && comparison.behind_by) {
    // GitHub branch update is SHA conditional; labels themselves are never review approval.
    const current = await currentPR(context, repository, number);
    if (!validHead(current, sha) || current.base.ref !== base || !branch.test(current.head.ref) || current.mergeable !== true) return { outcome: 'blocked', reason: 'head-or-base-changed-before-update' };
    await writeOnce(context, stableKey(WATCHDOG, repository.toLowerCase(), number, sha, 'review-label'), repository, `/issues/${number}/labels`, 'POST', { labels: ['openhands-review'] }, z.array(z.object({ name: z.string() })), { number, head: sha, kind: 'label' }, async () => {
      const labels = z.array(z.object({ name: z.string() })).parse(await pages(context, repository, `/issues/${number}/labels`));
      return labels.some(label => label.name === 'openhands-review') ? labels : undefined;
    });
    const result = await writeOnce(context, stableKey(WATCHDOG, repository.toLowerCase(), number, sha, 'update-branch'), repository, `/pulls/${number}/update-branch`, 'PUT', { expected_head_sha: sha }, z.object({ message: z.string().optional() }), { number, head: sha, kind: 'update' });
    return { outcome: 'branch-update-requested', ...(result.message ? { reason: 'GitHub accepted SHA-pinned branch update; merge deferred' } : {}) };
  }
  if (comparison.status !== 'ahead' && comparison.status !== 'identical') return { outcome: 'blocked', reason: 'base-comparison-not-current' };
  const current = await currentPR(context, repository, number);
  if (!validHead(current, sha) || current.base.ref !== base || current.base.sha !== gated.pr.base.sha || !branch.test(current.head.ref) || current.mergeable !== true) return { outcome: 'blocked', reason: 'head-or-base-changed-before-merge' };
  const merged = await writeOnce(context, stableKey(WATCHDOG, repository.toLowerCase(), number, sha, 'merge'), repository, `/pulls/${number}/merge`, 'PUT', { sha, merge_method: 'squash' }, z.object({ merged: z.boolean() }), { number, head: sha, kind: 'merge' }, async () => {
    const pr = await currentPR(context, repository, number);
    return pr.merged === true && pr.head.sha === sha ? { merged: true } : undefined;
  });
  if (merged.merged === true) return { outcome: 'merged' };
  if (merged.merged === false) return { outcome: 'merge-rejected' };
  throw new NativeTemplateUnknownOutcome('GitHub did not confirm whether the SHA-pinned merge completed');
}

const deliveryWatchdog: NativeTemplateHandler = async context => {
  const args = argumentsFor(context, WATCHDOG);
  const prefix = args.branchPrefix!;
  const branch = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[0-9]+$`);
  const evidence: Evidence[] = [];
  let uncertain = false;
  let repositoryFailures = 0;
  for (const repository of args.repositories) {
    try {
      const blocked = await reconcilePending(context, repository, evidence);
      uncertain ||= blocked.size > 0;
      const info = z.object({ default_branch: z.string().min(1) }).parse(await gh(context, repository, ''));
      const prs = z.array(pullRequestSchema).parse(await pages(context, repository, '/pulls?state=open'));
      for (const pr of prs) {
        if (blocked.has(pr.number)) continue;
        let result: Evidence;
        try { result = { repository, pr: pr.number, ...await watchdogPR(context, repository, pr.number, pr.head.sha, info.default_branch, branch) }; }
        catch (error) { uncertain ||= unknownOutcome(error); result = { repository, pr: pr.number, outcome: unknownOutcome(error) ? 'outcome_unknown' : 'failed', reason: failureReason(error) }; }
        evidence.push(result);
        context.log(JSON.stringify(result));
      }
    } catch (error) {
      uncertain ||= unknownOutcome(error);
      repositoryFailures++;
      context.log(JSON.stringify({ repository, outcome: unknownOutcome(error) ? 'outcome_unknown' : 'failed', reason: failureReason(error) }));
    }
  }
  if (uncertain) throw new NativeTemplateUnknownOutcome('One or more delivery operations remain unconfirmed; no unknown write was retried');
  if (repositoryFailures) throw new Error(`${repositoryFailures} GitHub delivery repository scans failed`);
  const count = (outcome: string) => evidence.filter(item => item.outcome === outcome).length;
  return { summary: `Delivery scan: ${evidence.length} pull requests; ${count('merged')} merged, ${count('branch-update-requested')} branch updates requested, ${count('failed')} failed operations, ${evidence.filter(item => item.outcome.endsWith('-reconciled')).length} prior writes reconciled.`, threadIds: [], details: { pullRequests: evidence } };
};

async function requiredChecks(context: NativeTemplateContext, repository: string, branch: string): Promise<RequiredCheck[]> {
  const ruleSchema = z.object({ type: z.string(), parameters: z.object({ required_status_checks: z.array(requiredCheckSchema).optional() }).optional() });
  let rules: z.infer<typeof ruleSchema>[];
  try { rules = z.array(ruleSchema).parse(await gh(context, repository, `/rules/branches/${encodeURIComponent(branch)}`)); }
  catch (error) { if (statusCode(error) === 404) return []; throw error; }
  const result: RequiredCheck[] = [];
  for (const rule of rules) {
    if (rule.type !== 'required_status_checks') continue;
    result.push(...(rule.parameters?.required_status_checks ?? []));
  }
  return result;
}
function requiredCI(runs: CheckRun[], statuses_: CommitStatus[], required: RequiredCheck[]): CIResult {
  if (!required.length) return { state: 'unconfigured', failedAt: null };
  const latestRuns = new Map<string, CheckRun>();
  for (const run of [...runs].sort((a, b) => b.id - a.id)) {
    // Database ID selects the latest run independently for each app, just as in the source.
    const key = JSON.stringify([run.name, run.app?.id || null]);
    if (!latestRuns.has(key)) latestRuns.set(key, run);
  }
  const latestStatuses = new Map<string, CommitStatus>();
  for (const status of [...statuses_].sort((a, b) => (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || ''))) {
    // Newest status per context wins; non-required contexts cannot authorize or block cleanup.
    if (!latestStatuses.has(status.context)) latestStatuses.set(status.context, status);
  }
  const states: string[] = [];
  const failures: number[] = [];
  for (const item of required) {
    const integration = item.integration_id || null;
    let run = latestRuns.get(JSON.stringify([item.context, integration]));
    if (!run && integration === null) run = [...latestRuns.values()].filter(value => value.name === item.context).sort((a, b) => b.id - a.id)[0];
    if (run) {
      if (run.status !== 'completed' || !run.conclusion) states.push('pending');
      else if (Object.hasOwn(PASSING_CONCLUSIONS, run.conclusion)) states.push('passing');
      else { states.push('failing'); const at = run.completed_at || run.started_at; if (at) failures.push(timestamp(at)); }
    } else {
      const status = integration === null ? latestStatuses.get(item.context) : undefined;
      if (!status || status.state === 'pending' || status.state === 'expected') states.push('pending');
      else if (status.state === 'success') states.push('passing');
      else { states.push('failing'); const at = status.updated_at || status.created_at; if (at) failures.push(timestamp(at)); }
    }
  }
  if (states.includes('pending')) return { state: 'pending', failedAt: null };
  if (states.includes('failing')) return { state: 'failing', failedAt: failures.length ? Math.max(...failures) : null };
  return { state: 'passing', failedAt: null };
}
async function restCI(context: NativeTemplateContext, repository: string, sha: string, required: RequiredCheck[]): Promise<CIResult> {
  if (!required.length) return { state: 'unconfigured', failedAt: null };
  const runs: CheckRun[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= 10; page++) {
    const result = z.object({ total_count: z.number().int().nonnegative(), check_runs: z.array(checkRunSchema) }).parse(await gh(context, repository, `/commits/${encodeURIComponent(sha)}/check-runs?per_page=100&page=${page}`));
    const batch = result.check_runs;
    for (const run of batch) {
      if (seen.has(run.id)) throw new Error('GitHub check-run pagination repeated a run');
      seen.add(run.id); runs.push(run);
    }
    if (batch.length < 100) {
      if (!Number.isSafeInteger(result.total_count) || result.total_count !== runs.length) throw new Error('GitHub check-run pagination is incomplete');
      return requiredCI(runs, z.array(statusSchema).parse(await pages(context, repository, `/commits/${encodeURIComponent(sha)}/statuses`)), required);
    }
  }
  throw new Error('More than 1,000 GitHub check runs found');
}
function graphqlCI(contexts: z.infer<typeof graphqlContextSchema>[], required: RequiredCheck[]): CIResult {
  const runs: CheckRun[] = [];
  const statuses_: CommitStatus[] = [];
  for (const item of contexts) {
    if (item.__typename === 'CheckRun') {
      runs.push({ id: item.databaseId, name: item.name, app: { id: item.checkSuite?.app?.databaseId }, status: item.status.toLowerCase(), conclusion: item.conclusion?.toLowerCase() || null, started_at: item.startedAt, completed_at: item.completedAt });
    } else statuses_.push({ context: item.context, state: item.state.toLowerCase(), created_at: item.createdAt });
  }
  return requiredCI(runs, statuses_, required);
}
async function openStalePRs(context: NativeTemplateContext, repository: string): Promise<StalePR[]> {
  const [owner, name] = repository.split('/');
  const prs: StalePR[] = [];
  const cursors = new Set<string>();
  const numbers = new Set<number>();
  const rules = new Map<string, RequiredCheck[]>();
  let cursor: string | null = null;
  for (;;) {
    checkSignal(context);
    let result: Record<string, unknown> | undefined;
    // The pinned scanner retries only read-only GraphQL 5xx responses, at most four attempts.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        result = record(await context.requestJson('github', '/graphql', { method: 'POST', body: { query: githubMaintenancePullRequestsQuery, variables: { owner, name, cursor } } }), 'GraphQL result');
        break;
      } catch (error) {
        const status = statusCode(error);
        if (status === undefined || status < 500 || attempt === 3) throw error;
        await delay(2 ** attempt * 1000, undefined, { signal: context.signal });
      }
    }
    if (!result) throw new Error('GitHub GraphQL pull request query failed');
    if (result.errors && (!Array.isArray(result.errors) || result.errors.length)) throw new Error('GitHub GraphQL pull request query failed');
    const data = record(result.data, 'GraphQL data');
    const repo = record(data.repository, 'GraphQL repository');
    const connection = graphqlConnectionSchema.parse(repo.pullRequests);
    for (const node of connection.nodes) {
      if (numbers.has(node.number)) throw new Error('GitHub repeated a pull request across pages');
      numbers.add(node.number);
      if (!rules.has(node.baseRefName)) rules.set(node.baseRefName, await requiredChecks(context, repository, node.baseRefName));
      const required = rules.get(node.baseRefName)!;
      const nodes = node.commits.nodes;
      const contexts = nodes[nodes.length - 1]?.commit.statusCheckRollup?.contexts ?? { nodes: [], totalCount: 0 };
      if (contexts.totalCount < contexts.nodes.length) throw new Error('Invalid GitHub check-rollup count');
      const ci = contexts.totalCount > contexts.nodes.length ? await restCI(context, repository, node.headRefOid, required) : graphqlCI(contexts.nodes, required);
      prs.push({ number: node.number, draft: node.isDraft, head: node.headRefOid, base: node.baseRefName, author: node.author?.login ?? '', ci });
    }
    const page = connection.pageInfo;
    if (page.hasNextPage === false) return prs;
    if (page.hasNextPage !== true || typeof page.endCursor !== 'string' || !page.endCursor || cursors.has(page.endCursor)) throw new Error('GitHub returned an invalid pull request cursor');
    cursor = page.endCursor; cursors.add(cursor);
  }
}
async function comments(context: NativeTemplateContext, repository: string, number: number): Promise<Comment[]> {
  return z.array(commentSchema).parse(await pages(context, repository, `/issues/${number}/comments`));
}
function followedUp(pr: StalePR, values: Comment[], after: number): boolean {
  return values.some(comment => (comment.user?.login ?? '').toLowerCase() === pr.author.toLowerCase() && timestamp(comment.created_at) > after);
}
function warningKey(repository: string, number: number, value: StaleRecord): string {
  return stableKey(STALE, repository.toLowerCase(), number, value.head, value.firstFailedAt, 'warning');
}
async function commentOnce(context: NativeTemplateContext, repository: string, number: number, head: string, key: string, body: string): Promise<Comment> {
  // Only an owned receipt can restore a warning. A PR author's copied marker is never authorization.
  return writeOnce(context, key, repository, `/issues/${number}/comments`, 'POST', { body }, commentSchema.refine(comment => comment.body === body && Number.isFinite(Date.parse(comment.created_at)), 'GitHub did not confirm the exact maintenance comment'), { number, head, kind: 'comment' });
}
async function recheckStale(context: NativeTemplateContext, repository: string, pr: StalePR): Promise<{ pr: StalePR; comments: Comment[] } | { outcome: string }> {
  const current = await currentPR(context, repository, pr.number);
  if (!validHead(current, pr.head) || current.base.ref !== pr.base) return { outcome: 'head-or-base-changed' };
  const required = await requiredChecks(context, repository, current.base.ref);
  const ci = await restCI(context, repository, pr.head, required);
  if (ci.state !== 'failing') return { outcome: ci.state };
  return { pr: { ...pr, author: current.user?.login ?? '', ci }, comments: await comments(context, repository, pr.number) };
}
async function reconcileStale(context: NativeTemplateContext, repository: string, pr: StalePR, state: StaleState, save: () => Promise<void>): Promise<string> {
  const key = String(pr.number);
  const now = context.now.getTime();
  if (pr.draft || pr.ci.state !== 'failing') { delete state.prs[key]; await save(); return pr.draft ? 'draft' : pr.ci.state; }
  let value = state.prs[key];
  if (!value || value.head !== pr.head) { value = { head: pr.head, firstFailedAt: pr.ci.failedAt ?? now }; state.prs[key] = value; await save(); }
  if (!value.warning && !value.resetAt && pr.ci.failedAt !== null) {
    if (followedUp(pr, await comments(context, repository, pr.number), pr.ci.failedAt)) value.resetAt = value.firstFailedAt;
    else value.firstFailedAt = Math.min(value.firstFailedAt, pr.ci.failedAt);
    await save();
  }
  if (!value.warning) {
    if (now - value.firstFailedAt < WEEK) return 'observing';
    const checked = await recheckStale(context, repository, pr);
    if ('outcome' in checked) return checked.outcome;
    const op = warningKey(repository, pr.number, value);
    const comment = await commentOnce(context, repository, pr.number, pr.head, op, `${WARNING_MARKER}\n<!-- openhands-stale-ci-warning head=${pr.head} -->\nRequired CI has remained failing for seven days. Please repair it or comment with an update. If the author does not push or comment and required CI remains failing for another seven days, this pull request will be closed automatically.`);
    value.warning = { at: timestamp(comment.created_at), head: pr.head, commentId: comment.id, operationKey: op };
    await save();
    return 'warned';
  }
  const warning = value.warning;
  const owned = await context.state.read(`operation:${warning.operationKey}`);
  const receipt = owned ? operationSchema.parse(owned.value) : undefined;
  const returned = receipt?.status === 'completed' ? commentSchema.parse(receipt.result) : undefined;
  if (warning.head !== pr.head || receipt?.status !== 'completed' || returned?.id !== warning.commentId || timestamp(returned.created_at) !== warning.at || warning.operationKey !== warningKey(repository, pr.number, value)) throw new Error('Stale-CI warning has no matching owned operation receipt');
  const values = await comments(context, repository, pr.number);
  if (followedUp(pr, values, warning.at)) { state.prs[key] = { head: pr.head, firstFailedAt: now, resetAt: now }; await save(); return 'followed-up'; }
  if (now - warning.at < WEEK) return 'waiting';
  const checked = await recheckStale(context, repository, pr);
  if ('outcome' in checked) { if (checked.outcome !== 'head-or-base-changed') { delete state.prs[key]; await save(); } return checked.outcome; }
  if (followedUp(checked.pr, checked.comments, warning.at)) { state.prs[key] = { head: pr.head, firstFailedAt: now, resetAt: now }; await save(); return 'followed-up'; }
  if (!checked.comments.some(comment => (comment.body ?? '').includes(CLOSE_MARKER))) {
    await commentOnce(context, repository, pr.number, pr.head, stableKey(STALE, repository.toLowerCase(), pr.number, pr.head, warning.at, 'close-comment'), `${CLOSE_MARKER}\nClosing because required CI is still failing seven days after the automated warning and the author has not pushed or commented. The pull request can be reopened when work resumes.`);
  }
  // GitHub PATCH lacks an expected_head_sha parameter: re-read immediately before the destructive call.
  const final = await recheckStale(context, repository, pr);
  if ('outcome' in final) return final.outcome;
  if (followedUp(final.pr, final.comments, warning.at)) { state.prs[key] = { head: pr.head, firstFailedAt: now, resetAt: now }; await save(); return 'followed-up'; }
  await writeOnce(context, stableKey(STALE, repository.toLowerCase(), pr.number, pr.head, warning.at, 'close'), repository, `/pulls/${pr.number}`, 'PATCH', { state: 'closed' }, pullRequestSchema.refine(result => result.state === 'closed' && result.head.sha === pr.head && result.merged === false, 'GitHub did not confirm closing the expected head'), { number: pr.number, head: pr.head, kind: 'close' }, async () => {
    const current = await currentPR(context, repository, pr.number);
    return current.state === 'closed' && current.merged === false && current.head.sha === pr.head ? current : undefined;
  });
  delete state.prs[key]; await save();
  return 'closed';
}
const staleCIPRCloser: NativeTemplateHandler = async context => {
  const args = argumentsFor(context, STALE);
  const evidence: Evidence[] = [];
  let uncertain = false;
  let failures = 0;
  for (const repository of args.repositories) {
    try {
      const blocked = await reconcilePending(context, repository, evidence);
      uncertain ||= blocked.size > 0;
      const stateKey = stableKey(STALE, repository.toLowerCase(), 'state');
      let persisted: NativeTemplateState | null = await context.state.read(stateKey);
      const state: StaleState = persisted ? staleStateSchema.parse(persisted.value) : { version: 1, prs: {} };
      const save = async () => { persisted = await context.state.compareAndSet(stateKey, persisted?.revision ?? null, state); };
      // Read every page before pruning state or warning/closing anything.
      const prs = await openStalePRs(context, repository);
      const open = new Set(prs.map(pr => String(pr.number)));
      for (const number of Object.keys(state.prs)) if (!open.has(number)) delete state.prs[number];
      await save();
      const candidates = prs.filter(pr => Object.hasOwn(state.prs, String(pr.number)) || (!pr.draft && pr.ci.state === 'failing' && pr.ci.failedAt !== null && context.now.getTime() - pr.ci.failedAt >= WEEK)).sort((a, b) => b.number - a.number);
      for (const pr of candidates) {
        if (blocked.has(pr.number)) continue;
        const outcome = await reconcileStale(context, repository, pr, state, save);
        const item = { repository, pr: pr.number, outcome };
        evidence.push(item); context.log(JSON.stringify(item));
      }
    } catch (error) {
      uncertain ||= unknownOutcome(error); failures++;
      context.log(JSON.stringify({ repository, outcome: unknownOutcome(error) ? 'outcome_unknown' : 'failed', reason: failureReason(error) }));
    }
  }
  if (uncertain) throw new NativeTemplateUnknownOutcome('One or more stale-CI writes remain unconfirmed; no unknown write was retried');
  if (failures) throw new Error(`${failures} GitHub stale-CI repository scans failed`);
  const reconciled = evidence.filter(item => item.outcome.endsWith('-reconciled')).length;
  return { summary: `Stale CI scan: ${evidence.filter(item => item.outcome === 'warned').length} warned, ${evidence.filter(item => item.outcome === 'closed').length} closed, ${reconciled} prior writes reconciled, ${evidence.filter(item => item.outcome !== 'warned' && item.outcome !== 'closed' && !item.outcome.endsWith('-reconciled')).length} unchanged.`, threadIds: [], details: { pullRequests: evidence } };
};

export const githubMaintenanceHandlers: Partial<Record<NativeTemplateId, NativeTemplateHandler>> = {
  [WATCHDOG]: deliveryWatchdog,
  [STALE]: staleCIPRCloser,
};
