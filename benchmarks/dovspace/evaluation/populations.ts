import { z } from 'zod';
import type { GradeInput } from '../graders/types.ts';
import { trustedEvents } from '../graders/types.ts';
import { evidenceHash } from './evaluator.ts';
import { FrozenGradeInputSchema, type FrozenGradeInput } from '../schemas/evaluation.ts';

const population = z.object({ count: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), retained: z.boolean() }).strict();
const snapshot = z.object({ entities: population, receipts: population, publicFiles: population, authorityFiles: population, authorityTables: population, authorityRows: z.number().int().nonnegative() }).strict();
export const GradingPopulationProofSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('original-grading-populations'), taskId: z.string(), taskVersion: z.string(),
  before: snapshot, after: snapshot, events: population, trustedEvents: population, allowedTargets: population, isolation: population,
  limitations: z.array(z.literal('authority-table-and-file-bytes-not-retained-no-independent-full-authority-replay')),
}).strict();
export type GradingPopulationProof = z.infer<typeof GradingPopulationProofSchema>;
/** Counts and whole-population commitments describe what the original trusted grader actually inspected; no account/credential row or authority file is exported. */
export function captureGradingPopulations(input: GradeInput): GradingPopulationProof {
  const capture = (value: unknown, count: number, retained: boolean) => ({ count, sha256: evidenceHash(value), retained });
  const take = (value: GradeInput['before']) => ({
    entities: capture(value.entities, value.entities.length, true), receipts: capture(value.receipts, value.receipts.length, true),
    publicFiles: capture(value.publicFiles, Object.keys(value.publicFiles).length, true), authorityFiles: capture(value.files, Object.keys(value.files).length, false),
    authorityTables: capture(value.tables, Object.keys(value.tables).length, false), authorityRows: Object.values(value.tables).reduce((sum, rows) => sum + rows.length, 0),
  });
  const trusted = trustedEvents(input);
  const allowedTargets = input.task.allowedTargets.map(target => typeof target === 'string' ? input.fixture.targets[target] : target);
  const isolation = input.fixture.isolation ? { verified: input.fixture.isolation.verified, proofDigest: input.fixture.isolation.proofDigest, checks: input.fixture.isolation.checks } : null;
  return GradingPopulationProofSchema.parse({ schemaVersion: 1, kind: 'original-grading-populations', taskId: input.task.id, taskVersion: input.task.taskVersion, before: take(input.before), after: take(input.after), events: capture(input.events, input.events.length, true), trustedEvents: capture(trusted, trusted.length, true), allowedTargets: capture(allowedTargets, allowedTargets.length, true), isolation: capture(isolation, isolation?.checks.length ?? 0, true), limitations: ['authority-table-and-file-bytes-not-retained-no-independent-full-authority-replay'] });
}
/** Checks every retained population against exact frozen inputs; withheld authority commitments remain authenticated original facts, not replayable data. */
export function verifyRetainedGradingPopulations(value: unknown, frozen: FrozenGradeInput): GradingPopulationProof {
  const proof = GradingPopulationProofSchema.parse(value), inputs = FrozenGradeInputSchema.parse(frozen);
  if (proof.taskId !== inputs.taskId || proof.taskVersion !== inputs.taskVersion) throw new Error('Grading population proof task identity mismatch');
  const verify = (claim: z.infer<typeof population>, data: unknown, count: number) => {
    if (!claim.retained || claim.count !== count || claim.sha256 !== evidenceHash(data)) throw new Error('Retained grading population is incomplete or inconsistent with frozen inputs');
  };
  for (const phase of ['before', 'after'] as const) {
    verify(proof[phase].entities, inputs[phase].entities, inputs[phase].entities.length);
    verify(proof[phase].receipts, inputs[phase].receipts, inputs[phase].receipts.length);
    verify(proof[phase].publicFiles, inputs[phase].publicFiles, Object.keys(inputs[phase].publicFiles).length);
    if (proof[phase].authorityFiles.retained || proof[phase].authorityTables.retained) throw new Error('Withheld authority populations cannot claim independent replay coverage');
  }
  const trusted = trustedEvents(inputs);
  verify(proof.events, inputs.events, inputs.events.length);
  verify(proof.trustedEvents, trusted, trusted.length);
  verify(proof.allowedTargets, inputs.allowedTargets, inputs.allowedTargets.length);
  verify(proof.isolation, inputs.fixture.isolation, inputs.fixture.isolation?.checks.length ?? 0);
  return proof;
}
export function originalSafetyPopulationReferences(criterionId: string): string[] {
  if (criterionId === 'safety.no-unrelated-mutations') return ['grading-populations.json#/before', 'grading-populations.json#/after'];
  if (criterionId === 'safety.no-unsafe-completion') return ['grading-populations.json#/before/entities', 'grading-populations.json#/after/entities'];
  if (criterionId === 'safety.no-forbidden-actions') return ['grading-populations.json#/trustedEvents'];
  if (criterionId === 'safety.receipt-target-scope' || criterionId === 'safety.no-unresolved-destructive-identity') return ['grading-populations.json#/before/receipts', 'grading-populations.json#/after/receipts', 'grading-populations.json#/allowedTargets'];
  return [];
}
