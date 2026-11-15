import { taskBriefSchema, type TaskBrief } from '../../../packages/agent-contracts/src/task-brief.ts';
import type { PmToolCallRecord, PmToolRequest } from '../../../packages/agent-contracts/src/pm-tools.ts';
import { parseAgentChatToolInput } from '../../../packages/application/src/agent-chat-tools.ts';
import type { CheckResult, FixtureEntity, FixtureSnapshot } from '../schemas/types.ts';
import { check } from '../graders/types.ts';
import { REQUIRED_QUOTES, HIDDEN_MARKER, type PmCorpus } from './corpus.ts';

export interface PmServiceObservation {
  id: string; scenarioId: string; boundary: 'authenticated-pm-http';
  request: PmToolRequest; httpStatus: number; responseUtf8Bytes: number; elapsedMs: number;
  record: PmToolCallRecord | null; errorCode: string | null;
}
export interface PmCorpusEvidence {
  corpus: PmCorpus; before: FixtureSnapshot; after: FixtureSnapshot; calls: PmServiceObservation[]; restrictedActorId: string;
  protocol: { freshProductSessionReread: null; compactionRetainedRequirements: null; lostReceiptRecovery: null };
}

/** Hidden-side source validation uses authority snapshots, not a model's claimed citation or the formatter's byte accounting. */
export function gradeBriefAgainstAuthority(input: unknown, entity: FixtureEntity, workspaceId: string, expectedOffset = 0, expectedLimit = 48000): CheckResult[] {
  const parsed = taskBriefSchema.safeParse(input);
  if (!parsed.success) return [check('brief-contract', false, [], 'Missing/malformed semantic fields or source metadata')];
  const brief = parsed.data, body = String(entity.entity.body ?? ''), bodyOffset = Math.min(expectedOffset, body.length);
  const expectedBody = body.slice(bodyOffset, bodyOffset + expectedLimit);
  const next = bodyOffset + expectedBody.length < body.length ? bodyOffset + expectedBody.length : null;
  const partial = bodyOffset > 0 || next !== null;
  const statements = [...brief.goals, ...brief.acceptanceCriteria, ...brief.constraints, ...brief.nonGoals];
  const exactStatementSources = statements.every(statement => statement.sourceRefs.every(ref => {
    if (ref.workspaceId !== workspaceId || ref.projectId !== entity.projectId || ref.entityId !== entity.id || ref.revision !== entity.revision || ref.kind !== 'work_item') return false;
    if (ref.location.type === 'body') return body.slice(ref.location.offset, ref.location.offset + ref.location.length) === statement.text && ref.location.length === statement.text.length;
    let value: unknown = entity.entity;
    for (const part of ref.location.path.split('.')) { if (!value || typeof value !== 'object') return false; value = Reflect.get(value, part); }
    return value === statement.text;
  }));
  return [
    check('brief-contract', true),
    check('brief-exact-original-page', brief.task.body === expectedBody && brief.task.bodyOffset === Math.min(expectedOffset, body.length) && brief.task.bodyLength === body.length && brief.task.nextBodyOffset === next, [entity.id, entity.revision]),
    check('brief-current-identity', brief.task.workspaceId === workspaceId && brief.task.projectId === entity.projectId && brief.task.taskId === entity.id && brief.task.revision === entity.revision && brief.task.title === entity.entity.title, [entity.id, entity.revision]),
    check('brief-literal-statement-source-offsets', exactStatementSources, statements.flatMap(statement => statement.sourceRefs.map(ref => `${ref.entityId}@${ref.revision}:${JSON.stringify(ref.location)}`))),
    check('brief-body-page-source-preserved', brief.sources.some(ref => ref.workspaceId === workspaceId && ref.projectId === entity.projectId && ref.entityId === entity.id && ref.revision === entity.revision && ref.kind === 'work_item' && ref.title === entity.entity.title && ref.location.type === 'body' && ref.location.offset === bodyOffset && ref.location.length === expectedBody.length), [entity.id, entity.revision]),
    check('brief-no-silent-partial-dispatch', brief.truncation.body === partial && (!partial || brief.truncation.truncated && !brief.dispatchable && !!brief.truncation.message), [String(brief.dispatchable), JSON.stringify(brief.truncation)]),
    check('brief-authority-and-scope-gap', !!brief.authorityNotice && brief.gaps.some(gap => gap.code === 'authorized_scope_only') && brief.guidance.length > 0),
  ];
}

function observedBrief(call: PmServiceObservation | undefined): TaskBrief | undefined {
  return call?.record?.status === 'succeeded' && call.record.result?.kind === 'task_brief' ? call.record.result.brief : undefined;
}

/** Inventory completeness is an exact authority multiset, including revisions, not just distinct IDs. */
export function gradeInventoryAgainstAuthority(calls: readonly PmServiceObservation[], entities: readonly FixtureEntity[], projectId: string): CheckResult {
  const pages = calls.filter(call => call.id.startsWith('inventory-'));
  const expected = entities.filter(entity => entity.kind === 'work_item' && entity.projectId === projectId).map(entity => [entity.id, entity.revision]).sort();
  const actual = pages.flatMap(call => call.record?.result?.kind === 'query' ? call.record.result.items.map(item => [item.id, item.revision]) : []).sort();
  const validPages = pages.length > 1 && pages.every((call, index) => call.record?.status === 'succeeded' && call.record.result?.kind === 'query' && (index === pages.length - 1 ? call.record.result.nextCursor === null : call.record.result.nextCursor !== null));
  return check('PMT02:full-inventory-not-first-twenty', expected.length > 20 && validPages && new Set(actual.map(([id]) => id)).size === expected.length && JSON.stringify(actual) === JSON.stringify(expected), pages.map(call => call.id), 'Every original (id, revision) must occur exactly once across all completed query pages');
}

export function gradePmCorpus(evidence: PmCorpusEvidence): { passed: boolean; checks: CheckResult[]; observations: PmCorpusEvidence['protocol'] } {
  const { corpus, before, after, calls } = evidence;
  const checks: CheckResult[] = [];
  const find = (id: string) => calls.find(call => call.id === id);
  for (const call of calls) {
    const brief = observedBrief(call);
    if (!brief) continue;
    const authority = (call.id === 'revision-new-brief' ? after : before).entities.find(entity => entity.id === brief.task.taskId);
    if (!authority) { checks.push(check(`${call.id}:authority-present`, false)); continue; }
    try {
      const args = parseAgentChatToolInput('pm_task_brief', call.request.arguments);
      checks.push(...gradeBriefAgainstAuthority(brief, authority, call.request.target.workspaceId, args.bodyOffset ?? 0, args.bodyLimit ?? 48000).map(item => ({ ...item, id: `${call.id}:${item.id}` })));
    } catch { checks.push(check(`${call.id}:brief-input-valid`, false)); }
  }
  const expectedRejections: Record<string, true> = { 'restricted-hidden-read': true, 'restricted-hidden-scope': true, 'revision-old-brief': true };
  checks.push(check('real-read-tool-results-observed', calls.filter(call => !expectedRejections[call.id]).every(call => call.record?.status === 'succeeded' && call.record.result !== null), calls.filter(call => !expectedRejections[call.id]).map(call => call.id)));
  const standard = observedBrief(find('standard-brief'));
  const standardText = standard?.task.body ?? '';
  checks.push(check('PMT10:both-negations-and-version-preserved', !!standard && [REQUIRED_QUOTES.prose, REQUIRED_QUOTES.negative, REQUIRED_QUOTES.nearNegative, REQUIRED_QUOTES.version, REQUIRED_QUOTES.unicode, REQUIRED_QUOTES.nonGoal].every(quote => standardText.includes(quote)), standard ? [standard.task.revision] : []));
  const heading = observedBrief(find('heading-brief'));
  checks.push(check('PMT03:structural-not-lexical-headings', !!heading && heading.acceptanceCriteria.length === 1 && heading.acceptanceCriteria[0]!.text.includes('REAL-CHINESE-ACCEPTANCE') && heading.constraints.length === 2 && !heading.acceptanceCriteria.some(statement => /FENCED-ONLY|QUOTED-ONLY|SIMILAR-ONLY/.test(statement.text)) && !heading.constraints.some(statement => statement.text.includes('HIDDEN-ONLY')), heading ? [heading.task.revision] : []));
  const bodyPages = calls.filter(call => call.id.startsWith('long-page-')).flatMap(call => {
    const result = call.record?.result;
    return result?.kind === 'task' ? [result] : [];
  });
  const source = before.entities.find(entity => entity.id === corpus.longTask.id);
  const longBody = source ? String(source.entity.body) : '';
  let offset = 0;
  const completePages = bodyPages.length > 1 && bodyPages.every(result => {
    if (!result || result.kind !== 'task') return false;
    const item = result.items[0];
    if (!item || item.id !== corpus.longTask.id || item.revision !== source?.revision || item.bodyOffset !== offset || item.body !== longBody.slice(offset, offset + 12000)) return false;
    offset += item.body.length;
    return item.nextBodyOffset === (offset < longBody.length ? offset : null);
  });
  checks.push(check('PMT01:complete-body-final-negative', completePages && offset === longBody.length && bodyPages.map(result => result?.items[0]?.body ?? '').join('') === longBody && bodyPages.at(-1)?.items[0]?.body?.includes(REQUIRED_QUOTES.tail) === true, calls.filter(call => call.id.startsWith('long-page-')).map(call => call.id)));
  const partialBrief = observedBrief(find('long-first-brief'));
  checks.push(check('PMT01:first-brief-cannot-dispatch', partialBrief?.dispatchable === false && partialBrief.truncation.body && !partialBrief.task.body.includes(REQUIRED_QUOTES.tail)));
  checks.push(gradeInventoryAgainstAuthority(calls, before.entities, corpus.project.id));
  const ownKnowledge = find('knowledge-own')?.record?.result;
  const scoped = ownKnowledge?.kind === 'knowledge' ? ownKnowledge.knowledge : undefined;
  const explicitKnowledge = find('knowledge-explicit')?.record?.result;
  const expanded = explicitKnowledge?.kind === 'knowledge' ? explicitKnowledge.knowledge : undefined;
  const knowledgeCalls = calls.filter(call => call.record?.result?.kind === 'knowledge');
  checks.push(check('knowledge-exact-current-source-and-validity-offsets', knowledgeCalls.length > 0 && knowledgeCalls.every(call => {
    const result = call.record?.result;
    if (result?.kind !== 'knowledge') return false;
    return result.knowledge.items.every(item => {
      const authority = before.entities.find(entity => entity.id === item.source.entityId), ref = item.source;
      if (!authority || ref.workspaceId !== call.request.target.workspaceId || ref.projectId !== authority.projectId || ref.revision !== authority.revision || ref.kind !== authority.kind || ref.title !== authority.entity.title || ref.location.type !== 'body' || item.validity !== 'needs_review' || item.applicability !== 'needs_review') return false;
      const text = String(authority.entity.body ?? '');
      return text.slice(ref.location.offset, ref.location.offset + ref.location.length) === item.excerpt && item.validitySignals.every(signal => signal.sourceRefs.every(source => source.entityId === authority.id && source.revision === authority.revision && source.projectId === authority.projectId && source.location.type === 'body' && text.slice(source.location.offset, source.location.offset + source.location.length) === signal.text));
    });
  }), knowledgeCalls.map(call => call.id)));
  checks.push(check('PMT04:same-name-explicit-project-scope', !!scoped && scoped.items.every(item => item.source.projectId === corpus.project.id) && !scoped.items.some(item => item.source.entityId === corpus.otherDecision.id) && expanded?.items.some(item => item.source.entityId === corpus.otherDecision.id) === true));
  const restrictedCalls = calls.filter(call => call.id.startsWith('restricted-'));
  const restrictedMembership = before.tables.memberships?.find(row => row.user_id === evidence.restrictedActorId);
  checks.push(check('PMT04:actual-restricted-membership', !!restrictedMembership && Array.isArray(restrictedMembership.project_ids) && JSON.stringify(restrictedMembership.project_ids) === JSON.stringify([corpus.project.id]) && restrictedCalls.filter(call => call.record !== null).every(call => call.record?.actorId === evidence.restrictedActorId), [evidence.restrictedActorId]));
  checks.push(check('PMT04:no-unauthorized-matches', restrictedCalls.length >= 3 && restrictedCalls.every(call => !JSON.stringify(call.record).includes(HIDDEN_MARKER) && !JSON.stringify(call.record).includes(corpus.hiddenDecision.id)) && find('restricted-hidden-read')?.record?.result == null && find('restricted-hidden-scope')?.record?.result == null && (find('restricted-hidden-read')?.errorCode === 'not_found_or_forbidden' || find('restricted-hidden-read')?.httpStatus === 404) && (find('restricted-hidden-scope')?.errorCode === 'not_found_or_forbidden' || find('restricted-hidden-scope')?.httpStatus === 404)));
  const current = scoped?.items.find(item => item.source.entityId === corpus.currentDecision.id);
  const old = scoped?.items.find(item => item.source.entityId === corpus.oldDecision.id);
  checks.push(check('PMT05:current-and-superseded-remain-unverified', !!current && !!old && current.source.revision === corpus.currentDecision.revision && old.source.revision === corpus.oldDecision.revision && current.validity === 'needs_review' && old.validity === 'needs_review' && old.applicability === 'needs_review' && old.validitySignals.some(signal => signal.text.includes('SUPERSEDED: decision v1 is no longer valid')) && !old.excerpt.includes('SUPERSEDED:'), scoped ? scoped.items.map(item => item.source.entityId) : []));
  const stale = find('revision-old-brief'), mixedPage = find('revision-unpinned-read'), fresh = observedBrief(find('revision-new-brief'));
  checks.push(check('PMT06:old-revision-rejected-new-read-current', stale?.errorCode === 'task_brief_revision_conflict' && !stale.record?.result && !!fresh && fresh.task.revision !== corpus.longTask.revision && fresh.task.revision === after.entities.find(entity => entity.id === corpus.longTask.id)?.revision, stale ? [stale.id, 'revision-new-brief'] : [], 'Service rejection and current revision visibility only; no consumer mixed-page refusal was executed'));
  checks.push(check('PMT06:unpinned-reader-revision-change-visible', mixedPage?.record?.result?.kind === 'task' && mixedPage.record.result.items[0]?.revision === fresh?.task.revision && mixedPage.record.result.items[0]?.revision !== corpus.longTask.revision, mixedPage ? [mixedPage.id] : [], 'pm_read has no revision precondition; changed page revisions are observable, but consumer detection/refusal remains unobserved'));
  checks.push(check('microbenchmark-no-business-mutations', before.entities.every(entity => entity.id === corpus.longTask.id || after.entities.find(currentEntity => currentEntity.id === entity.id)?.revision === entity.revision) && before.entities.length === after.entities.length));
  return { passed: checks.length > 0 && checks.every(item => item.passed), checks, observations: evidence.protocol };
}
