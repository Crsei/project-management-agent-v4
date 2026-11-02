import { createHash } from 'node:crypto';
import { pmAutomationArgumentsSchema, type PmAutomationAgentEvidence, type PmAutomationSourceRef } from '../../../../../../packages/contracts/src/automation-pm.ts';
import type { NativeTemplateContext } from './ports.ts';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pathAllowed = (value: string) => value.length > 0 && value.length <= 1000 && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && !value.split('/').includes('..');
/** Only an explicit source-authored acceptance table maps criteria; paths are never coverage. */
export function parsePmPullRequestCoverage(body: string, sourceRefId: string): PmAutomationAgentEvidence['pullRequests'][number]['coverage'] {
  const lines = body.split('\n');
  const result: PmAutomationAgentEvidence['pullRequests'][number]['coverage'] = [];
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(value => value.trim());
  for (let index = 0; index + 1 < lines.length; index++) {
    const header = cells(lines[index]!);
    const criterionIndex = header.findIndex(value => /^(?:acceptance criterion|criterion|验收标准)$/i.test(value));
    const coveredIndex = header.findIndex(value => /^(?:covered|coverage|覆盖)$/i.test(value));
    const evidenceIndex = header.findIndex(value => /^(?:evidence|source|证据|依据)$/i.test(value));
    if (criterionIndex < 0 || coveredIndex < 0 || evidenceIndex < 0 || !/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[index + 1]!)) continue;
    for (let row = index + 2; row < lines.length && lines[row]!.includes('|'); row++) {
      const values = cells(lines[row]!);
      const criterion = values[criterionIndex], assertion = values[coveredIndex], cited = values[evidenceIndex];
      if (!criterion || criterion.length > 10000 || !assertion) continue;
      const covered = cited && /^(?:yes|true|covered|是|已覆盖|\[x\])$/i.test(assertion) ? true : /^(?:no|false|missing|否|未覆盖|\[ \])$/i.test(assertion) ? false : null;
      result.push({ criterion, covered, evidence: lines[row]!.slice(0, 12000), sourceRefId });
      if (result.length === 200) return result;
    }
  }
  return result;
}

/** Existing authenticated connector broker owns credentials, origin, revision and exact repository authorization. */
export async function collectPmPullRequestEvidence(context: NativeTemplateContext, evidence: PmAutomationAgentEvidence): Promise<void> {
  const args = pmAutomationArgumentsSchema.parse(context.arguments);
  if (!args.repository || !args.repository.pullRequestNumber) {
    evidence.coverage.push({ source: 'pull-requests', status: 'unavailable', observedRecords: 0, totalRecords: null, reason: 'No explicit authenticated repository and pull-request scope was selected.' }); return;
  }
  if (args.taskIds?.length !== 1) throw new Error('PR analysis requires exactly one explicit task ID; no task association can be guessed from branch names or titles.');
  const selected = args.repository, number = selected.pullRequestNumber!;
  if (!selected.repository || selected.repository.split('/').some(part => !part || part === '.' || part === '..') || /[\\?#\s]/.test(selected.repository)) throw new Error('Invalid explicit repository scope.');
  let headSha: string, url: string, updatedAt: string | null, title: string, body: string, paths: string[] = [], partial = false;
  try {
    if (selected.provider === 'github') {
      if (selected.repository.split('/').length !== 2) throw new Error('GitHub scope requires owner/repository.');
      const base = `/repos/${selected.repository.split('/').map(encodeURIComponent).join('/')}/pulls/${number}`;
      type Pr = { number: number; html_url: string; title: string; body: string | null; updated_at: string; head: { sha: string; ref?: string }; changed_files: number };
      const pr = await context.requestJson<Pr>('github', base);
      if (pr.number !== number || !/^[a-f0-9]{40,64}$/i.test(pr.head?.sha ?? '')) throw new Error('PR metadata did not match the selected immutable identity.');
      if (selected.ref !== null && selected.ref !== pr.head.sha && selected.ref !== pr.head.ref) throw new Error('Selected repository ref does not match the actual PR head SHA or source branch.');
      headSha = pr.head.sha; url = pr.html_url; updatedAt = pr.updated_at; title = pr.title; body = pr.body ?? '';
      for (let page = 1; page <= 10; page++) {
        const files = await context.requestJson<Array<{ filename: string }>>('github', `${base}/files?per_page=100&page=${page}`);
        if (!Array.isArray(files)) throw new Error('PR files response was invalid.');
        paths.push(...files.map(file => file.filename));
        if (files.length < 100) break;
        if (page === 10) partial = true;
      }
      if (pr.changed_files !== paths.length) partial = true;
      const current = await context.requestJson<Pr>('github', base);
      if (current.head?.sha !== headSha || current.updated_at !== pr.updated_at) throw new Error('PR changed while its file evidence was being captured; no mixed-head snapshot was accepted.');
    } else {
      const base = `/projects/${encodeURIComponent(selected.repository)}/merge_requests/${number}`;
      type Mr = { iid: number; web_url: string; title: string; description: string | null; updated_at: string; source_branch?: string; sha: string; diff_refs?: { head_sha: string } };
      const mr = await context.requestJson<Mr>('gitlab', base);
      if (mr.iid !== number || !/^[a-f0-9]{40,64}$/i.test(mr.diff_refs?.head_sha ?? mr.sha ?? '')) throw new Error('MR metadata did not match selected identity.');
      if (selected.ref !== null && selected.ref !== (mr.diff_refs?.head_sha ?? mr.sha) && selected.ref !== mr.source_branch) throw new Error('Selected repository ref does not match the actual MR head SHA or source branch.');
      headSha = mr.diff_refs?.head_sha ?? mr.sha; url = mr.web_url; updatedAt = mr.updated_at; title = mr.title; body = mr.description ?? '';
      const changes = await context.requestJson<{ changes: Array<{ new_path: string }>; overflow?: boolean; diff_refs?: { head_sha: string } }>('gitlab', `${base}/changes`);
      if (!Array.isArray(changes.changes) || changes.diff_refs?.head_sha && changes.diff_refs.head_sha !== headSha) throw new Error('MR changes did not match selected head.');
      paths = changes.changes.map(change => change.new_path); partial = Boolean(changes.overflow || paths.length > 1000); paths = paths.slice(0, 1000);
      const current = await context.requestJson<Mr>('gitlab', base);
      if ((current.diff_refs?.head_sha ?? current.sha) !== headSha || current.updated_at !== mr.updated_at) throw new Error('MR changed during evidence capture.');
    }
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) throw new Error('PR source did not provide a safe source URL.');
    if (paths.some(path => typeof path !== 'string' || !pathAllowed(path))) throw new Error('PR returned unsafe project-relative file paths.');
    const request = context.request, observedAt = new Date().toISOString();
    const source: PmAutomationSourceRef = { refId: `external:pr:${hash([selected, headSha, updatedAt, body, paths]).slice(0, 40)}`, kind: 'pull-request', id: `${selected.provider}:${selected.repository}!${number}`, revision: headSha, actorId: request.actorId, workspaceId: request.workspaceId, projectId: request.projectId, label: title.slice(0, 1000), url, updatedAt: updatedAt && Number.isFinite(Date.parse(updatedAt)) ? updatedAt : null };
    evidence.sources.push(source);
    const coverage = parsePmPullRequestCoverage(body, source.refId);
    evidence.pullRequests.push({ id: source.id, sourceRefId: source.refId, taskId: args.taskIds[0]!, taskRevision: 'bound-by-pm-at-freeze', headSha, url, diffPaths: [...new Set(paths)], coverage, observedAt });
    evidence.coverage.push({ source: 'pull-requests', status: 'partial', observedRecords: 1, totalRecords: 1, reason: `${partial ? 'PR file coverage is partial. ' : ''}${coverage.length ? 'Explicit current-head PR acceptance table captured as source-authored claims, not independently verified test outcomes.' : 'Authenticated current-head metadata/files captured; no explicit acceptance-criterion table exists. Paths alone never prove coverage.'}` });
  } catch (error) {
    context.signal.throwIfAborted();
    evidence.coverage.push({ source: 'pull-requests', status: 'unavailable', observedRecords: 0, totalRecords: null, reason: error instanceof Error ? `Authenticated PR source unavailable: ${error.message}`.slice(0, 4000) : 'Authenticated PR source unavailable.' });
  }
}
