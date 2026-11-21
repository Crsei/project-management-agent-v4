import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  evaluationPolicyInputSchema, evaluationReleaseIdentitySchema, evaluationObservationSchema,
  evaluationDenominatorSchema, evaluationFenceSchema, evaluationWindowInputSchema, evaluationDecisionInputSchema,
  type EvaluationObservation, type EvaluationDenominator, type EvaluationFence,
} from "@agent-workspace/contracts/evaluation-feedback";

export const EVALUATION_NAMESPACES = {
  policies: "evaluation:policies:v1", admissions: "evaluation:admissions:v1", denominators: "evaluation:denominators:v1",
  removals: "evaluation:removals:v1",
  fences: "evaluation:fences:v1", windows: "evaluation:windows:v1", decisions: "evaluation:decisions:v1", audit: "evaluation:audit:v1",
} as const;
const count = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const policyRowSchema = z.strictObject({
  version: z.literal(1), input: evaluationPolicyInputSchema, revision: count.positive(), enabled: z.boolean(),
  storeId: z.uuid(), restoreEpoch: count, release: evaluationReleaseIdentitySchema, seed: digest,
  clusterIds: z.record(z.string(), z.uuid()), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  actor: z.literal("agent-access-operator"), disabledReason: z.enum(["paused", "revoked", "restored"]).nullable(),
  rejectedBeforeAcceptance: count, observerErrors: count,
});
export type PolicyRow = z.infer<typeof policyRowSchema>;
export const admissionRowSchema = z.strictObject({ version: z.literal(1), generationId: z.string().min(1), threadId: z.string().min(1),
  storeId: z.uuid(), restoreEpoch: count, expiresAt: z.iso.datetime(), seed: digest, configurationBaseId: digest.optional(),
  failureProbability: z.number().min(0).max(1), unknownProbability: z.number().min(0).max(1), observation: evaluationObservationSchema });
export type AdmissionRow = z.infer<typeof admissionRowSchema>;
export const removalRowSchema = z.strictObject({ version: z.literal(1), observationId: z.uuid(), policyId: z.uuid(), storeId: z.uuid(), restoreEpoch: count,
  release: evaluationReleaseIdentitySchema, acceptedAt: z.iso.datetime(), kind: evaluationObservationSchema.shape.kind, driver: evaluationObservationSchema.shape.driver,
  removedAt: z.iso.datetime(), reason: evaluationFenceSchema.shape.reason });
export type RemovalRow = z.infer<typeof removalRowSchema>;
export const windowRowSchema = z.strictObject({ version: z.literal(1), input: evaluationWindowInputSchema, storeId: z.uuid(), restoreEpoch: count,
  createdAt: z.iso.datetime(), actor: z.literal("agent-access-operator"), invalidatedAt: z.iso.datetime().nullable() });
export type WindowRow = z.infer<typeof windowRowSchema>;
export const decisionRowSchema = z.strictObject({ version: z.literal(1), input: evaluationDecisionInputSchema, createdAt: z.iso.datetime(),
  actor: z.literal("agent-access-operator"), summarySha256: digest, deploymentPerformed: z.literal(false) });
export type DecisionRow = z.infer<typeof decisionRowSchema>;
export const auditRowSchema = z.strictObject({ version: z.literal(1), auditId: z.uuid(), at: z.iso.datetime(),
  action: z.enum(["configured", "paused", "revoked", "exported", "restored"]), policyId: z.uuid().nullable(),
  exportId: z.uuid().nullable(), actor: z.literal("agent-access-operator"), observationIds: z.array(z.uuid()) });
const schemas: Record<string, z.ZodType> = {
  [EVALUATION_NAMESPACES.policies]: policyRowSchema, [EVALUATION_NAMESPACES.admissions]: admissionRowSchema,
  [EVALUATION_NAMESPACES.denominators]: evaluationDenominatorSchema, [EVALUATION_NAMESPACES.fences]: evaluationFenceSchema,
  [EVALUATION_NAMESPACES.removals]: removalRowSchema,
  [EVALUATION_NAMESPACES.windows]: windowRowSchema, [EVALUATION_NAMESPACES.decisions]: decisionRowSchema,
  [EVALUATION_NAMESPACES.audit]: auditRowSchema,
};
/** Preflight only; adding an owner never rewrites existing Store records. */
export function validateEvaluationRecord(namespace: string, value: unknown): void {
  try { schemas[namespace]?.parse(value); }
  catch { throw new Error("Unsupported Agent evaluation record structure; explicit stopped-copy inspection is required."); }
}

/** Runs only on an owned backup/restore copy, under its existing stopped-copy transaction. */
export function fenceEvaluationCopy(db: DatabaseSync, source: { storeId: string; restoreEpoch: number }): void {
  const at = new Date().toISOString(), ns = EVALUATION_NAMESPACES;
  const hasData = db.prepare("SELECT 1 FROM records WHERE namespace IN (?, ?, ?, ?) LIMIT 1").get(ns.policies, ns.admissions, ns.windows, ns.decisions);
  if (!hasData) return;
  const alreadyFenced = db.prepare("SELECT value FROM records WHERE namespace=?").all(ns.fences).some(row => {
    const fence = evaluationFenceSchema.parse(JSON.parse(String(row.value)));
    return fence.scope === "store-epoch" && fence.storeId === source.storeId && fence.restoreEpoch === source.restoreEpoch;
  });
  if (alreadyFenced && !db.prepare("SELECT 1 FROM records WHERE namespace IN (?, ?) LIMIT 1").get(ns.admissions, ns.denominators) &&
      db.prepare("SELECT value FROM records WHERE namespace=?").all(ns.policies).every(row => {
        const policy = policyRowSchema.parse(JSON.parse(String(row.value))); return !policy.enabled && policy.disabledReason === "restored";
      }) && db.prepare("SELECT value FROM records WHERE namespace=?").all(ns.windows).every(row => windowRowSchema.parse(JSON.parse(String(row.value))).invalidatedAt !== null)) return;
  const put = db.prepare("INSERT INTO records(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value");
  const fence = evaluationFenceSchema.parse({ fenceId: randomUUID(), storeId: source.storeId, restoreEpoch: source.restoreEpoch,
    scope: "store-epoch", observationIds: [], reason: "restored", createdAt: at });
  put.run(ns.fences, fence.fenceId, JSON.stringify(fence));
  db.prepare("DELETE FROM records WHERE namespace IN (?, ?)").run(ns.admissions, ns.denominators);
  for (const row of db.prepare("SELECT key,value FROM records WHERE namespace=?").all(ns.policies)) {
    const policy = policyRowSchema.parse(JSON.parse(String(row.value)));
    put.run(ns.policies, String(row.key), JSON.stringify({ ...policy, enabled: false, disabledReason: "restored", updatedAt: at }));
  }
  for (const row of db.prepare("SELECT key,value FROM records WHERE namespace=?").all(ns.windows)) {
    const window = windowRowSchema.parse(JSON.parse(String(row.value)));
    put.run(ns.windows, String(row.key), JSON.stringify({ ...window, invalidatedAt: at }));
  }
  const audit = auditRowSchema.parse({ version: 1, auditId: randomUUID(), at, action: "restored", policyId: null, exportId: null,
    actor: "agent-access-operator", observationIds: [] });
  put.run(ns.audit, audit.auditId, JSON.stringify(audit));
}

export function evaluationDenominatorKey(row: EvaluationObservation): string {
  return createHash("sha256").update(JSON.stringify([row.policyId, row.policyRevision, row.release, row.kind, row.driver, row.configurationId, row.samplingDesignSha256])).digest("hex");
}
/** Caller owns the existing Store or stopped-copy transaction; only this owner's records are mutation targets. */
export function removeEvaluationRows(db: DatabaseSync, rows: AdmissionRow[], reason: EvaluationFence["reason"]): EvaluationFence[] {
  if (!rows.length) return [];
  const ns = EVALUATION_NAMESPACES, at = new Date().toISOString();
  const groups = new Map<string, AdmissionRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.storeId, row.restoreEpoch]), group = groups.get(key);
    if (group) group.push(row); else groups.set(key, [row]);
  }
  const put = db.prepare("INSERT INTO records(namespace,key,value) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value");
  const fences: EvaluationFence[] = [];
  for (const grouped of groups.values()) {
    const first = grouped[0]!;
    const fence: EvaluationFence = { fenceId: randomUUID(), storeId: first.storeId, restoreEpoch: first.restoreEpoch, scope: "observations",
      observationIds: grouped.map(row => row.observation.observationId), reason, createdAt: at };
    put.run(ns.fences, fence.fenceId, JSON.stringify(fence)); fences.push(fence);
  }
  const affectedPolicies = new Set(rows.map(row => row.observation.policyId));
  for (const row of rows) {
    put.run(ns.removals, row.observation.observationId, JSON.stringify(removalRowSchema.parse({
      version: 1, observationId: row.observation.observationId, policyId: row.observation.policyId, storeId: row.storeId, restoreEpoch: row.restoreEpoch,
      release: row.observation.release, acceptedAt: row.observation.acceptedAt, kind: row.observation.kind, driver: row.observation.driver, removedAt: at, reason,
    })));
    const key = evaluationDenominatorKey(row.observation);
    const saved = db.prepare("SELECT value FROM records WHERE namespace=? AND key=?").get(ns.denominators, key);
    if (saved) {
      const denominator = evaluationDenominatorSchema.parse(JSON.parse(String(saved.value)));
      const selected = row.observation.random.selected || row.observation.failure.selected || row.observation.unknown.selected;
      const next: EvaluationDenominator = { ...denominator, retained: denominator.retained - 1, removed: denominator.removed + 1,
        selectedRetained: denominator.selectedRetained - Number(selected) };
      put.run(ns.denominators, key, JSON.stringify(evaluationDenominatorSchema.parse(next)));
    }
    db.prepare("DELETE FROM records WHERE namespace=? AND key=?").run(ns.admissions, row.generationId);
  }
  for (const row of db.prepare("SELECT key,value FROM records WHERE namespace=?").all(ns.windows)) {
    const window = windowRowSchema.parse(JSON.parse(String(row.value)));
    if (affectedPolicies.has(window.input.policyId)) put.run(ns.windows, String(row.key), JSON.stringify({ ...window, invalidatedAt: at }));
  }
  return fences;
}
/** Visible source deletion propagates only to derived evaluation metadata, never to PM evidence. */
export function deleteEvaluationThread(db: DatabaseSync, threadId: string): void {
  const ns = EVALUATION_NAMESPACES;
  const rows = db.prepare("SELECT value FROM records WHERE namespace=?").all(ns.admissions)
    .map(row => admissionRowSchema.parse(JSON.parse(String(row.value)))).filter(row => row.threadId === threadId);
  removeEvaluationRows(db, rows, "deleted");
  for (const row of db.prepare("SELECT key,value FROM records WHERE namespace=?").all(ns.policies)) {
    const policy = policyRowSchema.parse(JSON.parse(String(row.value)));
    if (policy.input.threadIds.includes(threadId) && policy.enabled)
      db.prepare("UPDATE records SET value=? WHERE namespace=? AND key=?").run(JSON.stringify({ ...policy, enabled: false, disabledReason: "revoked", updatedAt: new Date().toISOString() }), ns.policies, String(row.key));
  }
}
