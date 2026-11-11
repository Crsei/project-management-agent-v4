import { z } from 'zod';
import { K02_CURRENT_REASON, K02_TIMELINE, L04_CURRENT_DOCUMENT, SYNTHETIC_FACTS } from '../fixtures/documents.ts';
import type { CheckResult, FixtureSnapshot, Mutation } from '../schemas/types.ts';
import type { GradeInput } from './types.ts';
import { check, stable } from './types.ts';

export type Citation = { path: string; quote: string };
export type AnswerFact = { key: string; value: unknown; citations: Citation[]; history?: { value: unknown; citations: Citation[] }[] };
export type Answer = { facts: AnswerFact[]; summary?: string; dependencies?: { from: string; to: string }[] };
const CitationSchema = z.object({ path: z.string().min(1), quote: z.string().min(1) }).strict();
const AnswerSchema = z.object({
  facts: z.array(z.object({ key: z.string(), value: z.unknown(), citations: z.array(CitationSchema).min(1), history: z.array(z.object({ value: z.unknown(), citations: z.array(CitationSchema).min(1) }).strict()).optional() }).strict()),
  timeline: z.array(z.object({ id: z.string(), date: z.string(), kind: z.string(), summary: z.string().optional(), objections: z.array(z.string()), reason: z.string(), citations: z.array(CitationSchema).min(1) }).strict()).optional(),
  currentReason: z.string().optional(), currentReasonCitations: z.array(CitationSchema).min(1).optional(), summary: z.string().optional(),
}).strict();
const KnowledgeSchema = z.object({ records: z.array(z.object({ key: z.string(), value: z.unknown(), status: z.string(), citations: z.array(CitationSchema), invalid: z.boolean().optional(), supersededBy: z.unknown().optional() }).passthrough()) });
export const K03_KEYS = ['authMode', 'accessibility', 'backupRpoHours'];
export const REQUIRED_FACTS: Record<string, string[]> = {
  K01: ['authMode', 'accessibility', 'backupRpoHours'], K02: ['retentionDays', 'retryLimit', 'releaseDate'],
  K03: ['authMode', 'accessibility', 'backupRpoHours'], K04: ['releaseDate', 'owner', 'incidentEscalationMinutes'],
  D01: ['retentionDays', 'retryLimit', 'releaseDate'], D02: ['retryLimit'], D03: ['releaseDate', 'accessibility'],
  D04: ['backupRpoHours', 'incidentEscalationMinutes'], L01: ['retentionDays', 'retryLimit', 'releaseDate'],
  L02: ['owner', 'accessibility'], L03: ['backupRpoHours', 'incidentEscalationMinutes'], L04: ['backupRpoHours', 'incidentEscalationMinutes'],
};
export function publicFile(snapshot: FixtureSnapshot, relativePath: string): string | undefined {
  if (relativePath.startsWith('/') || relativePath.split('/').some((part) => part === '..' || part === '.')) return undefined;
  const encoded = snapshot.publicFiles[relativePath];
  return encoded === undefined ? undefined : Buffer.from(encoded, 'base64').toString('utf8');
}
export function parseArtifact<T>(snapshot: FixtureSnapshot, path: string): T | null {
  const content = publicFile(snapshot, path);
  if (content === undefined || content.length > 2 * 1024 * 1024) return null;
  try { return JSON.parse(content) as T; } catch { return null; }
}
function citationSupports(citations: unknown, expectedPath: string, expectedQuote: string, snapshot: FixtureSnapshot): boolean {
  if (!Array.isArray(citations) || citations.length === 0) return false;
  return citations.every((citation: unknown) => {
    if (!citation || typeof citation !== 'object') return false;
    const { path, quote } = citation as Partial<Citation>;
    if (path !== expectedPath || typeof quote !== 'string' || !quote.includes(expectedQuote)) return false;
    const document = publicFile(snapshot, path);
    // Both exact quotation and the complete semantic assertion are required. Merely citing a file is insufficient.
    return document !== undefined && document.includes(quote) && document.includes(expectedQuote);
  });
}
export function gradeKnowledge(input: GradeInput): CheckResult[] {
  const parsed = AnswerSchema.safeParse(parseArtifact<unknown>(input.after, 'artifacts/answer.json'));
  const answer = parsed.success ? parsed.data : null;
  const valid = parsed.success;
  const checks = [check('knowledge.answer-json', valid, ['public/artifacts/answer.json'], 'A real parseable structured answer is required.')];
  if (!valid || !answer) return checks;
  checks.push(check('knowledge.unique-facts', new Set(answer.facts.map((fact) => fact.key)).size === answer.facts.length, ['answer.facts'], 'Duplicate or contradictory fact assertions are not accepted.'));
  const expectedKeys = REQUIRED_FACTS[input.task.id] ?? [];
  checks.push(check('knowledge.no-invented-facts', answer.facts.every((fact) => expectedKeys.includes(fact.key)), ['answer.facts'], 'Only requested supported facts belong in the structured answer.'));
  for (const key of REQUIRED_FACTS[input.task.id] ?? []) {
    const oracle = SYNTHETIC_FACTS.find((fact) => fact.key === key);
    if (!oracle) throw new Error(`Missing trusted oracle: ${key}`);
    const shifted = input.task.id === 'L04' && key === 'incidentEscalationMinutes';
    const expected = shifted ? 10 : oracle.current;
    const expectedPath = shifted ? L04_CURRENT_DOCUMENT.path : oracle.currentPath;
    const expectedQuote = shifted ? 'Current accepted decision: incidentEscalationMinutes=10.' : oracle.currentQuote;
    const fact = answer.facts.find((candidate) => candidate.key === key);
    if (fact?.history) {
      const validHistory = new Set(fact.history.map((entry) => stable(entry.value))).size === fact.history.length && fact.history.every((entry) => {
        const immediatePrior = shifted && entry.value === 15;
        return (immediatePrior || stable(entry.value) === stable(oracle.previous)) && citationSupports(entry.citations, immediatePrior ? oracle.currentPath : oracle.previousPath, immediatePrior ? oracle.currentQuote : oracle.previousQuote, input.after);
      });
      checks.push(check(`knowledge.history-integrity.${key}`, validHistory, [oracle.previousPath], 'Every historical assertion/citation must be supported; correct items cannot hide invented extras.'));
    }
    checks.push(check(`knowledge.current.${key}`, fact !== undefined && stable(fact.value) === stable(expected), [expectedPath], `Current ${key} must equal the accepted typed value, not a stale mention or keyword.`));
    checks.push(check(`knowledge.citation.${key}`, !!fact && citationSupports(fact.citations, expectedPath, expectedQuote, input.after), [expectedPath, expectedQuote], 'Citation must quote the exact current semantic assertion in trusted source content.'));
    if (input.task.id === 'K02' || input.task.id === 'K03' || shifted) {
      const oldValue = shifted ? 15 : oracle.previous;
      const oldPath = shifted ? oracle.currentPath : oracle.previousPath;
      const oldQuote = shifted ? oracle.currentQuote : oracle.previousQuote;
      const historical = fact?.history?.find((old) => stable(old.value) === stable(oldValue));
      checks.push(check(`knowledge.history.${key}`, !!historical && citationSupports(historical.citations, oldPath, oldQuote, input.after), [oldPath, oldQuote], 'The superseded value and its historical authority must both be retained separately from current facts.'));
    }
  }
  if (input.task.id === 'K02') {
    const timeline = answer.timeline ?? [];
    checks.push(check('knowledge.timeline-complete-ordered', timeline.length === K02_TIMELINE.length && K02_TIMELINE.every((event, index) => timeline[index]?.id === event.id && timeline[index]?.date === event.date && timeline[index]?.kind === event.kind), ['five trusted dated records'], 'Initial decision, three meetings and final decision must be complete and chronologically ordered.'));
    for (const event of K02_TIMELINE) {
      const actual = timeline.find((candidate) => candidate.id === event.id);
      checks.push(check(`knowledge.timeline.${event.id}`, !!actual && actual.reason === event.reason && stable(actual.objections) === stable(event.objections) && citationSupports(actual.citations, event.path, event.quote, input.after), [event.path, event.quote], 'Date, decision/meeting role, objections and rationale need semantic supporting citations.'));
    }
    const accepted = K02_TIMELINE[K02_TIMELINE.length - 1]!;
    checks.push(check('knowledge.current-reason', answer.currentReason === K02_CURRENT_REASON && citationSupports(answer.currentReasonCitations, accepted.path, accepted.quote, input.after), [accepted.path], 'The effective technical choice must retain the actual accepted rationale.'));
  }
  if (input.task.id === 'K03') {
    const current = KnowledgeSchema.safeParse(parseArtifact<unknown>(input.after, 'knowledge/current.json'));
    const history = KnowledgeSchema.safeParse(parseArtifact<unknown>(input.after, 'knowledge/history.json'));
    checks.push(check('knowledge.update.actual-structured-files', current.success && history.success, ['knowledge/current.json', 'knowledge/history.json'], 'Answer text alone is not a structured knowledge update.'));
    for (const key of K03_KEYS) {
      const oracle = SYNTHETIC_FACTS.find((entry) => entry.key === key)!;
      const record = current.success ? current.data.records.filter((entry) => entry.key === key) : [];
      const old = history.success ? history.data.records.filter((entry) => entry.key === key) : [];
      checks.push(check(`knowledge.update.effective.${key}`, record.length === 1 && record[0]!.status === 'active' && stable(record[0]!.value) === stable(oracle.current) && citationSupports(record[0]!.citations, oracle.currentPath, oracle.currentQuote, input.after), [oracle.currentPath], 'The new accepted decision must actually become the effective KB record.'));
      checks.push(check(`knowledge.update.invalidated-history.${key}`, old.length === 1 && old[0]!.status === 'superseded' && old[0]!.invalid === true && stable(old[0]!.value) === stable(oracle.previous) && stable(old[0]!.supersededBy) === stable(oracle.current) && citationSupports(old[0]!.citations, oracle.previousPath, oracle.previousQuote, input.after), [oracle.previousPath], 'The original decision must remain explicitly invalidated with its source and replacement.'));
    }
    checks.push(check('knowledge.update.scope', unexpectedKnowledgeMutations(input).length === 0, ['before/after structured knowledge'], 'Unrelated effective facts and existing historical records must be unchanged.'));
  }
  return checks;
}

export function unexpectedKnowledgeMutations(input: GradeInput): Mutation[] {
  if (input.task.id !== 'K03') return [];
  const beforeCurrent = KnowledgeSchema.safeParse(parseArtifact<unknown>(input.before, 'knowledge/current.json'));
  const afterCurrent = KnowledgeSchema.safeParse(parseArtifact<unknown>(input.after, 'knowledge/current.json'));
  const beforeHistory = KnowledgeSchema.safeParse(parseArtifact<unknown>(input.before, 'knowledge/history.json'));
  const afterHistory = KnowledgeSchema.safeParse(parseArtifact<unknown>(input.after, 'knowledge/history.json'));
  if (!beforeCurrent.success || !afterCurrent.success || !beforeHistory.success || !afterHistory.success) return [{ domain: 'knowledge', identity: 'structured-store-integrity', kind: 'changed' }];
  const unexpected: Mutation[] = [];
  const unrelatedBefore = beforeCurrent.data.records.filter((entry) => !K03_KEYS.includes(entry.key)).toSorted((a, b) => a.key.localeCompare(b.key));
  const unrelatedAfter = afterCurrent.data.records.filter((entry) => !K03_KEYS.includes(entry.key)).toSorted((a, b) => a.key.localeCompare(b.key));
  if (stable(unrelatedBefore) !== stable(unrelatedAfter)) unexpected.push({ domain: 'knowledge', identity: 'unrelated-effective-records', kind: 'changed', before: unrelatedBefore, after: unrelatedAfter });
  const retainedBefore = beforeHistory.data.records.toSorted((a, b) => a.key.localeCompare(b.key));
  const retainedAfter = afterHistory.data.records.filter((entry) => !K03_KEYS.includes(entry.key)).toSorted((a, b) => a.key.localeCompare(b.key));
  if (stable(retainedBefore) !== stable(retainedAfter)) unexpected.push({ domain: 'knowledge', identity: 'existing-history', kind: 'changed', before: retainedBefore, after: retainedAfter });
  return unexpected;
}
