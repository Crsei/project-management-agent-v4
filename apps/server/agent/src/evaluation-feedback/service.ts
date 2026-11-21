import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  evaluationPolicyInputSchema, evaluationPolicyActionSchema, evaluationDeleteSchema,
  evaluationReleaseIdentitySchema, evaluationDriverSchema, evaluationErrorClassSchema, evaluationMetadataExportSchema,
  evaluationWindowInputSchema, evaluationDecisionInputSchema, evaluationWindowSummarySchema,
  type EvaluationObservation, type EvaluationDenominator, type EvaluationFence, type EvaluationReleaseIdentity,
} from "@agent-workspace/contracts/evaluation-feedback";
import type { ChatGeneration } from "../durable/chat-runtime.ts";
import { getDatabase, readRecord, writeRecord, listRecords, deleteRecord, transaction } from "../durable/store.ts";
import { getStoreIdentity } from "../durable/persistence-schema.ts";
import { getThread, assertThreadWritable } from "../durable/threads.ts";
import { resolveChatExecutionScope } from "../task-delivery/binding.ts";
import { createPmVisibilityProjector } from "../pm-visibility.ts";
import type { ProviderDriver } from "@agent-workspace/contracts/provider";
import { DurableError } from "../durable/errors.ts";
import { EVALUATION_NAMESPACES as N, type PolicyRow, type AdmissionRow, type RemovalRow, type DecisionRow, windowRowSchema, decisionRowSchema, evaluationDenominatorKey, removeEvaluationRows } from "./persistence.ts";

const actor = "agent-access-operator" as const;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sameRelease = (a: EvaluationReleaseIdentity, b: EvaluationReleaseIdentity) => a.artifactSha256 === b.artifactSha256 && a.sourceSha256 === b.sourceSha256;
function inObservationInterval(acceptedAt: string, range: { startsAt: string; endsAt: string }): boolean {
  const instant = Date.parse(acceptedAt);
  return instant >= Date.parse(range.startsAt) && instant < Date.parse(range.endsAt);
}
let volatileObserverErrors = 0;
/** Only deployment-owned process configuration can provide release identity. Never read it from Chat/model input. */
export function configuredEvaluationRelease(): EvaluationReleaseIdentity | null {
  const parsed = evaluationReleaseIdentitySchema.safeParse({ artifactSha256: process.env.AGENT_EVALUATION_ARTIFACT_SHA256, sourceSha256: process.env.AGENT_EVALUATION_SOURCE_SHA256 });
  return parsed.success ? parsed.data : null;
}
function currentPolicies(now = Date.now()): PolicyRow[] {
  const identity = getStoreIdentity(getDatabase()), release = configuredEvaluationRelease();
  if (!release) return [];
  return listRecords<PolicyRow>(N.policies).filter(policy => policy.enabled && policy.storeId === identity.storeId && policy.restoreEpoch === identity.restoreEpoch &&
    sameRelease(policy.release, release) && Date.parse(policy.input.startsAt) <= now && Date.parse(policy.input.endsAt) > now);
}
async function authorizeThreads(ids: readonly string[], headers: Headers, enable = false): Promise<void> {
  for (const id of ids) {
    const thread = getThread(id);
    if (!thread) throw new DurableError(404, "evaluation_source_unavailable", "Sampling source Session is unavailable.");
    if (enable) assertThreadWritable(id);
    try {
      await resolveChatExecutionScope(thread, headers, "inspect");
      const projector = await createPmVisibilityProjector(id, headers);
      if (projector.nativeContextContaminated) throw new Error("source unavailable");
    } catch {
      throw new DurableError(403, "evaluation_source_unavailable", "Current source authorization is required; unavailable data is not an empty cohort.");
    }
  }
}
function audit(action: "configured" | "paused" | "revoked" | "exported", policyId: string | null, exportId: string | null = null, observationIds: string[] = []): void {
  const auditId = randomUUID();
  writeRecord(N.audit, auditId, { version: 1, auditId, at: new Date().toISOString(), action, policyId, exportId, actor, observationIds });
}
function publicPolicy(policy: PolicyRow) {
  return { policyId: policy.input.policyId, revision: policy.revision, enabled: policy.enabled, purpose: policy.input.purpose,
    scopedSessions: policy.input.threadIds.length, startsAt: policy.input.startsAt, endsAt: policy.input.endsAt, retentionDays: policy.input.retentionDays,
    randomProbability: policy.input.randomProbability, failureProbability: policy.input.failureProbability, unknownProbability: policy.input.unknownProbability,
    release: policy.release, disabledReason: policy.disabledReason, actor: policy.actor, updatedAt: policy.updatedAt };
}
export async function evaluationStatus(headers: Headers) {
  const policies = listRecords<PolicyRow>(N.policies);
  const visible = [];
  let unavailable = false;
  for (const policy of policies) {
    try { await authorizeThreads(policy.input.threadIds, headers); visible.push(publicPolicy(policy)); }
    catch { unavailable = true; }
  }
  const identity = getStoreIdentity(getDatabase());
  const activeIds = new Set(currentPolicies().map(policy => policy.input.policyId));
  return { schemaVersion: 1, defaultEnabled: false, collector: "metadata-only", release: configuredEvaluationRelease(),
    policies: visible, accessFiltered: unavailable, activePolicies: visible.filter(policy => activeIds.has(policy.policyId)).length,
    store: { storeId: identity.storeId, restoreEpoch: identity.restoreEpoch }, migration: "No automatic migration. Legacy Stores require the existing reviewed stopped-copy bootstrap; this owner adds only registered v1 records on explicit enable.",
    observerErrors: volatileObserverErrors, externalContentCollected: false, deploymentPerformed: false };
}
export async function configureEvaluationPolicy(input: unknown, headers: Headers) {
  const value = evaluationPolicyInputSchema.parse(input), release = configuredEvaluationRelease();
  if (!release) throw new DurableError(409, "evaluation_release_unconfigured", "Set deployment-owned AGENT_EVALUATION_ARTIFACT_SHA256 and AGENT_EVALUATION_SOURCE_SHA256 before explicitly enabling sampling.");
  if (Date.parse(value.endsAt) <= Date.now() || Date.parse(value.endsAt) - Date.parse(value.startsAt) > 90 * 86_400_000)
    throw new DurableError(400, "evaluation_invalid_interval", "Sampling requires a future end and an interval no longer than 90 days.");
  await authorizeThreads(value.threadIds, headers, true);
  return transaction(() => {
    const previous = readRecord<PolicyRow>(N.policies, value.policyId), identity = getStoreIdentity(getDatabase());
    if ((previous?.revision ?? 0) !== value.expectedRevision) throw new DurableError(409, "evaluation_revision_conflict", "Read the original policy revision before changing it.");
    if (previous && (previous.storeId !== identity.storeId || previous.restoreEpoch !== identity.restoreEpoch))
      throw new DurableError(409, "evaluation_restored_policy", "Restored policies cannot be re-enabled. Create a new explicit policy for the new Store/epoch.");
    if (previous && JSON.stringify(previous.input.threadIds) !== JSON.stringify(value.threadIds))
      throw new DurableError(409, "evaluation_scope_changed", "Use a new policy identity for a different scope; do not silently reset its denominator.");
    if (listRecords<PolicyRow>(N.policies).some(policy => policy.enabled && policy.input.policyId !== value.policyId && policy.input.threadIds.some(id => value.threadIds.includes(id)) &&
      Date.parse(policy.input.startsAt) < Date.parse(value.endsAt) && Date.parse(value.startsAt) < Date.parse(policy.input.endsAt)))
      throw new DurableError(409, "evaluation_scope_overlap", "Overlapping scoped sampling policies are not permitted.");
    const at = new Date().toISOString();
    const row: PolicyRow = { version: 1, input: value, revision: (previous?.revision ?? 0) + 1, enabled: true,
      storeId: identity.storeId, restoreEpoch: identity.restoreEpoch, release, seed: previous?.seed ?? randomBytes(32).toString("hex"),
      clusterIds: previous?.clusterIds ?? Object.fromEntries(value.threadIds.map(id => [id, randomUUID()])), createdAt: previous?.createdAt ?? at,
      updatedAt: at, actor, disabledReason: null, rejectedBeforeAcceptance: previous?.rejectedBeforeAcceptance ?? 0, observerErrors: previous?.observerErrors ?? 0 };
    writeRecord(N.policies, value.policyId, row); audit("configured", value.policyId); return publicPolicy(row);
  });
}
export function pauseEvaluationPolicy(input: unknown, revoke = false) {
  const value = evaluationPolicyActionSchema.parse(input);
  return transaction(() => {
    const previous = readRecord<PolicyRow>(N.policies, value.policyId);
    if (!previous) throw new DurableError(404, "evaluation_policy_not_found", "Original sampling policy is unavailable.");
    if (previous.revision !== value.expectedRevision) throw new DurableError(409, "evaluation_revision_conflict", "Sampling policy revision changed.");
    const row: PolicyRow = { ...previous, revision: previous.revision + 1, enabled: false, disabledReason: revoke ? "revoked" : "paused", updatedAt: new Date().toISOString() };
    writeRecord(N.policies, value.policyId, row);
    if (revoke) removeEvaluationRows(getDatabase(), listRecords<AdmissionRow>(N.admissions).filter(admission => admission.observation.policyId === value.policyId), "revoked");
    audit(revoke ? "revoked" : "paused", value.policyId); return publicPolicy(row);
  });
}
/** Independent deterministic channel draws; a private random seed prevents user-selected generation IDs controlling inclusion. */
export function evaluationDraw(seed: string, generationId: string, channel: "random" | "failure" | "unknown"): number {
  return Number.parseInt(createHmac("sha256", Buffer.from(seed, "hex")).update(JSON.stringify([generationId, channel])).digest("hex").slice(0, 13), 16) / 0x10000000000000;
}
function instructionConfigurationId(seed: string, baseId: string, system: string | undefined): string {
  return createHmac("sha256", Buffer.from(seed, "hex")).update(JSON.stringify({ domain: "effective-instruction-configuration-v1", baseId, system: system ?? null })).digest("hex");
}
const selected = (row: EvaluationObservation): boolean => row.random.selected || row.failure.selected || row.unknown.selected;
function emptyDenominator(row: EvaluationObservation): EvaluationDenominator {
  return { policyId: row.policyId, policyRevision: row.policyRevision, release: row.release, kind: row.kind, driver: row.driver,
    configurationId: row.configurationId, samplingDesignSha256: row.samplingDesignSha256,
    eligible: 0, pending: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0, observationLost: 0,
    randomCandidates: 0, randomSelected: 0, failureCandidates: 0, failureSelected: 0, unknownCandidates: 0, unknownSelected: 0,
    retained: 0, removed: 0, selectedRetained: 0, labeled: 0 };
}
function adjustDenominator(row: EvaluationObservation, delta: 1 | -1, admission: boolean): void {
  const key = evaluationDenominatorKey(row), value = readRecord<EvaluationDenominator>(N.denominators, key) ?? emptyDenominator(row);
  if (admission) { value.eligible += delta; value.retained += delta; }
  const status = row.status === "observation-lost" ? "observationLost" : row.status;
  value[status] += delta;
  for (const channel of ["random", "failure", "unknown"] as const) {
    if (row[channel].candidate) value[`${channel}Candidates`] += delta;
    if (row[channel].selected) value[`${channel}Selected`] += delta;
  }
  if (selected(row)) value.selectedRetained += delta;
  if (value.eligible === 0 && value.retained === 0 && value.removed === 0) deleteRecord(N.denominators, key);
  else writeRecord(N.denominators, key, value);
}
function observeSafely(work: () => void): void {
  try { transaction(work); }
  catch {
    volatileObserverErrors++;
    // No exception, retry, business result mutation or model input is permitted here.
    try { for (const policy of currentPolicies()) writeRecord(N.policies, policy.input.policyId, { ...policy, observerErrors: policy.observerErrors + 1 }); } catch { /* Store unavailable: volatile coverage remains explicit. */ }
  }
}
export function observeEvaluationAcceptance(generation: ChatGeneration, resolvedDriver: ProviderDriver): void {
  observeSafely(() => {
    if (readRecord(N.admissions, generation.id)) return;
    const policy = currentPolicies(Date.parse(generation.createdAt)).find(value => value.input.threadIds.includes(generation.threadId));
    if (!policy) return;
    const driver = evaluationDriverSchema.safeParse(resolvedDriver);
    const random = { candidate: true, probability: policy.input.randomProbability, selected: evaluationDraw(policy.seed, generation.id, "random") < policy.input.randomProbability };
    const configurationBaseId = createHmac("sha256", Buffer.from(policy.seed, "hex")).update(JSON.stringify({
      provider: generation.providerInstanceId, revision: generation.providerInstanceRevision, model: generation.modelId,
      temperature: generation.temperature, options: generation.modelOptions ?? [], mode: generation.interactionMode,
      environment: generation.executionSnapshot?.environment ?? null,
      authorities: (generation.pmOperations ?? []).map(operation => [operation.actorId, operation.target]),
    })).digest("hex");
    const configurationId = instructionConfigurationId(policy.seed, configurationBaseId, generation.request.system);
    const observation: EvaluationObservation = { observationId: randomUUID(), clusterId: policy.clusterIds[generation.threadId]!,
      policyId: policy.input.policyId, policyRevision: policy.revision, release: policy.release, unit: "generation",
      kind: generation.idleCompaction ? "compaction" : generation.continuationOf ? "continuation" : "chat", driver: driver.success ? driver.data : "other",
      configurationId, configurationIdentity: "pending", samplingDesignSha256: hash({ collector: 1, configuration: 2, random: policy.input.randomProbability, failure: policy.input.failureProbability, unknown: policy.input.unknownProbability }),
      acceptedAt: generation.createdAt, expiresAt: new Date(Date.parse(generation.createdAt) + policy.input.retentionDays * 86_400_000).toISOString(),
      terminalAt: null, status: "pending", errorClass: "none", random,
      failure: { candidate: false, probability: 0, selected: false }, unknown: { candidate: false, probability: 0, selected: false },
      inclusionProbability: random.probability, probabilityFinal: false,
      usage: { source: "unavailable", completeness: "unknown", inputTokens: null, outputTokens: null, costUsd: null, currency: "USD", priceIdentity: null } };
    const row: AdmissionRow = { version: 1, generationId: generation.id, threadId: generation.threadId, storeId: policy.storeId, restoreEpoch: policy.restoreEpoch,
      expiresAt: observation.expiresAt, seed: policy.seed, configurationBaseId,
      failureProbability: policy.input.failureProbability, unknownProbability: policy.input.unknownProbability, observation };
    writeRecord(N.admissions, generation.id, row); adjustDenominator(observation, 1, true);
  });
}
/** Bind only the host-selected effective system configuration at the actual pre-dispatch boundary; raw instructions are never stored here or exported. */
export function observeEvaluationConfiguration(generationId: string, effectiveSystem: string | undefined): void {
  observeSafely(() => {
    const row = readRecord<AdmissionRow>(N.admissions, generationId);
    if (!row || row.observation.probabilityFinal) return;
    const observation: EvaluationObservation = { ...row.observation,
      configurationIdentity: row.configurationBaseId ? "bound" : "unavailable",
      configurationId: row.configurationBaseId ? instructionConfigurationId(row.seed, row.configurationBaseId, effectiveSystem) : row.observation.configurationId };
    if (observation.configurationId !== row.observation.configurationId) {
      adjustDenominator(row.observation, -1, true); adjustDenominator(observation, 1, true);
    }
    writeRecord(N.admissions, generationId, { ...row, observation });
  });
}
function terminal(row: AdmissionRow, generation: ChatGeneration | null): void {
  if (row.observation.probabilityFinal) return;
  const status: EvaluationObservation["status"] = generation && ["completed", "failed", "cancelled", "interrupted"].includes(generation.status) ? generation.status as EvaluationObservation["status"] : "observation-lost";
  const failureCandidate = status === "failed", unknownCandidate = status === "interrupted" || status === "observation-lost";
  const failure = { candidate: failureCandidate, probability: failureCandidate ? row.failureProbability : 0,
    selected: failureCandidate && evaluationDraw(row.seed, row.generationId, "failure") < row.failureProbability };
  const unknown = { candidate: unknownCandidate, probability: unknownCandidate ? row.unknownProbability : 0,
    selected: unknownCandidate && evaluationDraw(row.seed, row.generationId, "unknown") < row.unknownProbability };
  const error = evaluationErrorClassSchema.safeParse(generation?.errorClass);
  const totals = generation?.usage?.totals, reported = generation?.usage?.reportedTurn;
  const observation: EvaluationObservation = { ...row.observation, status,
    configurationIdentity: row.observation.configurationIdentity === "pending" ? "unavailable" : row.observation.configurationIdentity,
    terminalAt: generation?.endedAt ?? new Date().toISOString(), probabilityFinal: true, failure, unknown,
    errorClass: error.success ? error.data : status === "completed" || status === "cancelled" ? "none" : "unknown",
    inclusionProbability: 1 - (1 - row.observation.random.probability) * (1 - failure.probability) * (1 - unknown.probability),
    usage: { source: totals ? "canonical-turn" : reported ? "reported-turn" : "unavailable", completeness: totals ? "canonical" : reported ? "partial" : "unknown",
      inputTokens: totals ? totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens : reported?.inputTokens ?? null,
      outputTokens: totals?.outputTokens ?? reported?.outputTokens ?? null,
      // A saved dollar subtotal has no frozen pricing/source identity; never export it as complete cost.
      costUsd: null, currency: "USD", priceIdentity: null } };
  adjustDenominator(row.observation, -1, false); adjustDenominator(observation, 1, false);
  writeRecord(N.admissions, row.generationId, { ...row, observation });
}
export function observeEvaluationTerminal(generation: ChatGeneration): void {
  observeSafely(() => { const row = readRecord<AdmissionRow>(N.admissions, generation.id); if (row) terminal(row, generation); });
}
export function observeEvaluationRejection(threadId: string): void {
  observeSafely(() => { for (const policy of currentPolicies().filter(value => value.input.threadIds.includes(threadId)))
    writeRecord(N.policies, policy.input.policyId, { ...policy, rejectedBeforeAcceptance: policy.rejectedBeforeAcceptance + 1 }); });
}
/** Called after Chat startup has persisted interruptions. No backfill guesses and no Provider launch. */
export function recoverEvaluationObservations(): void {
  observeSafely(() => {
    for (const row of listRecords<AdmissionRow>(N.admissions)) {
      if (row.observation.probabilityFinal) continue;
      const generation = readRecord<ChatGeneration>("chat:generations", row.generationId);
      terminal(row, generation && !["queued", "running"].includes(generation.status) ? generation : null);
    }
  });
}
export function expireEvaluationObservations(now = Date.now()) {
  return transaction(() => ({ fences: removeEvaluationRows(getDatabase(), listRecords<AdmissionRow>(N.admissions).filter(row => Date.parse(row.expiresAt) <= now), "retention") }));
}
export function deleteEvaluationObservations(input: unknown) {
  const value = evaluationDeleteSchema.parse(input), ids = new Set(value.observationIds);
  return transaction(() => ({ fences: removeEvaluationRows(getDatabase(), listRecords<AdmissionRow>(N.admissions).filter(row => ids.has(row.observation.observationId)), value.reason) }));
}
export async function exportEvaluationMetadata(headers: Headers) {
  expireEvaluationObservations();
  // One synchronous Store snapshot, never a collection of post-await reads from different population states.
  const snapshot = transaction(() => {
    const database = getDatabase();
    return { database, identity: getStoreIdentity(database), policies: listRecords<PolicyRow>(N.policies),
      admissions: listRecords<AdmissionRow>(N.admissions), denominators: listRecords<EvaluationDenominator>(N.denominators),
      fences: listRecords<EvaluationFence>(N.fences), observerErrors: volatileObserverErrors,
      changes: database.prepare("SELECT total_changes() AS changes").get()!.changes };
  });
  const allowed = new Set<string>();
  let filtered = false;
  for (const policy of snapshot.policies) {
    try { await authorizeThreads(policy.input.threadIds, headers); allowed.add(policy.input.policyId); }
    catch { filtered = true; }
  }
  const rows: AdmissionRow[] = [];
  for (const row of snapshot.admissions) {
    if (!allowed.has(row.observation.policyId)) continue;
    const projector = await createPmVisibilityProjector(row.threadId, headers);
    const projected = projector.generation<{ id: string; pmVisibility?: string }>({ id: row.generationId });
    if (projected.pmVisibility) { filtered = true; allowed.delete(row.observation.policyId); continue; }
    rows.push(row);
  }
  return transaction(() => {
    const database = getDatabase(), identity = getStoreIdentity(database);
    // This is a single-process Store. Every local write, including rollback/revocation/terminal callbacks during authorization, changes its connection-local counter.
    if (database !== snapshot.database || database.prepare("SELECT total_changes() AS changes").get()!.changes !== snapshot.changes ||
        identity.storeId !== snapshot.identity.storeId || identity.restoreEpoch !== snapshot.identity.restoreEpoch || volatileObserverErrors !== snapshot.observerErrors)
      throw new DurableError(409, "evaluation_snapshot_changed", "Observation state changed during source authorization; request a fresh export. No mixed-state export was created.");
    const policies = snapshot.policies, exportId = randomUUID();
    const result = evaluationMetadataExportSchema.parse({ format: "agent-evaluation-metadata-v1", schemaVersion: 1, exportId,
      storeId: identity.storeId, restoreEpoch: identity.restoreEpoch, exportedAt: new Date().toISOString(), identityTrust: "operator-configured", contentIncluded: false,
      observations: rows.filter(row => allowed.has(row.observation.policyId) && selected(row.observation)).map(row => row.observation),
      denominators: snapshot.denominators.filter(row => allowed.has(row.policyId)), fences: snapshot.fences,
      coverage: { status: filtered || snapshot.observerErrors || policies.some(policy => policy.observerErrors) ? "incomplete" : "complete",
        observerErrors: Math.max(snapshot.observerErrors, policies.reduce((sum, policy) => sum + policy.observerErrors, 0)),
        rejectedBeforeAcceptance: policies.filter(policy => allowed.has(policy.input.policyId)).reduce((sum, policy) => sum + policy.rejectedBeforeAcceptance, 0),
        rejectedCoverage: "scoped-admission-rejections-only" } });
    audit("exported", null, exportId, result.observations.map(row => row.observationId));
    return result;
  });
}
export async function createEvaluationWindow(input: unknown, headers: Headers) {
  const value = evaluationWindowInputSchema.parse(input), policy = readRecord<PolicyRow>(N.policies, value.policyId);
  if (!policy) throw new DurableError(404, "evaluation_policy_not_found", "Register an explicit source scope before creating its release observation window.");
  if (policy.input.purpose !== "release-observation") throw new DurableError(400, "evaluation_purpose_mismatch", "A release observation window requires its explicit release-observation purpose.");
  await authorizeThreads(policy.input.threadIds, headers);
  if (Date.parse(value.candidate.startsAt) <= Date.now() || Date.parse(value.expiresAt) <= Date.parse(value.candidate.endsAt))
    throw new DurableError(400, "evaluation_preregistration_required", "Register candidate cohorts/thresholds before its window starts; expiry must follow its end.");
  return transaction(() => {
    if (readRecord(N.windows, value.windowId)) throw new DurableError(409, "evaluation_window_exists", "Observation windows are immutable; reuse is forbidden.");
    const identity = getStoreIdentity(getDatabase());
    const removed = listRecords<RemovalRow>(N.removals).find(row => row.policyId === value.policyId &&
      (sameRelease(row.release, value.baselineRelease) && inObservationInterval(row.acceptedAt, value.baseline) ||
       sameRelease(row.release, value.candidateRelease) && inObservationInterval(row.acceptedAt, value.candidate)));
    const row = windowRowSchema.parse({ version: 1, input: value, storeId: identity.storeId, restoreEpoch: identity.restoreEpoch,
      createdAt: new Date().toISOString(), actor, invalidatedAt: removed?.removedAt ?? null });
    writeRecord(N.windows, value.windowId, row); return row;
  });
}
export async function summarizeEvaluationWindow(windowId: string, headers: Headers) {
  expireEvaluationObservations();
  const window = windowRowSchema.parse(readRecord(N.windows, windowId));
  const policy = readRecord<PolicyRow>(N.policies, window.input.policyId);
  if (!policy) throw new DurableError(404, "evaluation_policy_not_found", "Original sampling policy is unavailable.");
  await authorizeThreads(policy.input.threadIds, headers);
  const identity = getStoreIdentity(getDatabase()), input = window.input;
  const rows = listRecords<AdmissionRow>(N.admissions).filter(row => row.observation.policyId === input.policyId);
  const removals = listRecords<RemovalRow>(N.removals).filter(row => row.policyId === input.policyId);
  const select = (release: EvaluationReleaseIdentity, range: { startsAt: string; endsAt: string }) => rows.filter(row => sameRelease(row.observation.release, release) &&
    inObservationInterval(row.observation.acceptedAt, range));
  const baseline = select(input.baselineRelease, input.baseline), candidate = select(input.candidateRelease, input.candidate);
  const selectRemoved = (release: EvaluationReleaseIdentity, range: { startsAt: string; endsAt: string }) =>
    removals.filter(row => sameRelease(row.release, release) && inObservationInterval(row.acceptedAt, range));
  const baselineRemoved = selectRemoved(input.baselineRelease, input.baseline), candidateRemoved = selectRemoved(input.candidateRelease, input.candidate);
  const reasons: string[] = [];
  if (window.invalidatedAt || window.storeId !== identity.storeId || window.restoreEpoch !== identity.restoreEpoch) reasons.push("deleted-revoked-or-restored-evidence");
  if (baselineRemoved.length || candidateRemoved.length) reasons.push("removed-observation-coverage");
  if (Date.now() >= Date.parse(input.expiresAt)) reasons.push("expired-window");
  if (Date.now() < Date.parse(input.candidate.endsAt) || Date.now() < Date.parse(input.baseline.endsAt)) reasons.push("window-not-closed");
  if (volatileObserverErrors || policy.observerErrors) reasons.push("collector-coverage-incomplete");
  const cohorts = [];
  for (const kind of input.kinds) for (const driver of input.drivers) {
    const a = baseline.filter(row => row.observation.kind === kind && row.observation.driver === driver);
    const b = candidate.filter(row => row.observation.kind === kind && row.observation.driver === driver);
    const removedA = baselineRemoved.filter(row => row.kind === kind && row.driver === driver);
    const removedB = candidateRemoved.filter(row => row.kind === kind && row.driver === driver);
    const signatures = (values: AdmissionRow[]) => [...new Set(values.map(row => `${row.observation.configurationId}:${row.observation.samplingDesignSha256}`))].sort();
    const baselineSignatures = signatures(a), candidateSignatures = signatures(b);
    const cohortReasons: string[] = [];
    if (a.length + removedA.length < input.minimumEligiblePerCohort || b.length + removedB.length < input.minimumEligiblePerCohort) cohortReasons.push("insufficient-eligible-denominator");
    if (JSON.stringify(baselineSignatures) !== JSON.stringify(candidateSignatures) || baselineSignatures.length !== 1) cohortReasons.push("configuration-or-sampling-incomparable");
    if (a.some(row => row.observation.configurationIdentity !== "bound") || b.some(row => row.observation.configurationIdentity !== "bound")) cohortReasons.push("effective-configuration-unavailable");
    if (removedA.length || removedB.length) cohortReasons.push("removed-observation-coverage");
    if (a.some(row => row.observation.status === "pending") || b.some(row => row.observation.status === "pending")) cohortReasons.push("pending-terminal-observation");
    const counts = (values: AdmissionRow[], removed: RemovalRow[]) => ({ eligible: values.length + removed.length, removed: removed.length, failures: values.filter(row => row.observation.status === "failed").length,
      pending: values.filter(row => row.observation.status === "pending").length, completed: values.filter(row => row.observation.status === "completed").length,
      cancelled: values.filter(row => row.observation.status === "cancelled").length, interrupted: values.filter(row => row.observation.status === "interrupted").length,
      observationLost: values.filter(row => row.observation.status === "observation-lost").length,
      unknown: values.filter(row => ["interrupted", "observation-lost"].includes(row.observation.status)).length,
      randomSelected: values.filter(row => row.observation.random.selected).length,
      clusters: new Set(values.map(row => row.observation.clusterId)).size });
    const ac = counts(a, removedA), bc = counts(b, removedB);
    const complete = removedA.length === 0 && removedB.length === 0;
    const failureRateDifference = complete && ac.eligible && bc.eligible ? bc.failures / bc.eligible - ac.failures / ac.eligible : null;
    const unknownRateDifference = complete && ac.eligible && bc.eligible ? bc.unknown / bc.eligible - ac.unknown / ac.eligible : null;
    const recurrence = [...new Set(a.filter(row => row.observation.status === "failed").map(row => row.observation.errorClass))].map(errorClass => ({ errorClass,
      baselineOccurrences: a.filter(row => row.observation.status === "failed" && row.observation.errorClass === errorClass).length,
      candidateOccurrences: b.filter(row => row.observation.status === "failed" && row.observation.errorClass === errorClass).length,
      rootCauseConfirmed: false }));
    cohorts.push({ kind, driver, baseline: ac, candidate: bc, comparable: cohortReasons.length === 0, reasons: cohortReasons,
      failureRateDifference, unknownRateDifference, recurrence,
      drift: cohortReasons.length ? "unknown" : failureRateDifference! > input.maximumFailureRateIncrease || unknownRateDifference! > input.maximumUnknownRateIncrease ? "observed" : "not-observed" });
  }
  if (cohorts.some(cohort => !cohort.comparable)) reasons.push("required-cohort-incomplete-or-incomparable");
  const combined = [...baseline, ...candidate];
  const baselinePopulation = [...baseline.map(row => row.observation), ...baselineRemoved], candidatePopulation = [...candidate.map(row => row.observation), ...candidateRemoved];
  const population = [...baselinePopulation, ...candidatePopulation], total = population.length;
  const declared = population.filter(row => input.kinds.includes(row.kind) && input.drivers.includes(row.driver)).length;
  if (declared !== total) reasons.push("traffic-outside-preregistered-cohorts");
  const compositionChanged = input.kinds.some(kind => input.drivers.some(driver => baselinePopulation.length > 0 && candidatePopulation.length > 0 &&
    Math.abs(baselinePopulation.filter(row => row.kind === kind && row.driver === driver).length / baselinePopulation.length -
      candidatePopulation.filter(row => row.kind === kind && row.driver === driver).length / candidatePopulation.length) > input.maximumTrafficShareChange));
  const driftReasons: ("behavior-drift" | "traffic-composition-drift")[] = [];
  if (cohorts.some(cohort => cohort.drift === "observed")) driftReasons.push("behavior-drift");
  if (compositionChanged) driftReasons.push("traffic-composition-drift");
  const summary = evaluationWindowSummarySchema.parse({ format: "agent-release-observation-v1", schemaVersion: 1, windowId, storeId: window.storeId, restoreEpoch: window.restoreEpoch,
    releaseDecisionSha256: input.releaseDecisionSha256, preregistrationSha256: hash(input), baselineRelease: input.baselineRelease, candidateRelease: input.candidateRelease,
    baselineWindow: input.baseline, candidateWindow: input.candidate, createdAt: window.createdAt, expiresAt: input.expiresAt,
    lineage: { observationIds: population.map(row => row.observationId),
      earliestSourceExpiry: combined.reduce<string | null>((earliest, row) => earliest === null || Date.parse(row.expiresAt) < Date.parse(earliest) ? row.expiresAt : earliest, null) },
    thresholds: { minimumEligiblePerCohort: input.minimumEligiblePerCohort, maximumFailureRateIncrease: input.maximumFailureRateIncrease,
      maximumUnknownRateIncrease: input.maximumUnknownRateIncrease, maximumTrafficShareChange: input.maximumTrafficShareChange },
    status: reasons.length ? "unknown" : driftReasons.length ? "drift-observed" : "no-drift-observed",
    reasons, driftReasons, cohorts, traffic: { baselineEligible: baselinePopulation.length, candidateEligible: candidatePopulation.length, outsideDeclaredCohorts: total - declared, compositionChanged },
    interpretation: "Descriptive complete-denominator metadata only; no model-quality, causal root-cause, case-fixed, statistical significance or release-authorization claim. Session clustering is reported, not treated as independent tasks.",
    deploymentPerformed: false });
  return { summary, summarySha256: hash(summary) };
}
export async function recordEvaluationDecision(input: unknown, headers: Headers) {
  const value = evaluationDecisionInputSchema.parse(input), result = await summarizeEvaluationWindow(value.windowId, headers);
  if (value.evidenceSha256 !== result.summarySha256) throw new DurableError(409, "evaluation_evidence_changed", "Read and bind the exact current observation summary before recording a decision.");
  if (Date.parse(value.expiresAt) <= Date.now()) throw new DurableError(400, "evaluation_decision_expired", "Decision expiry must be in the future.");
  return transaction(() => {
    if (readRecord(N.decisions, value.decisionId)) throw new DurableError(409, "evaluation_decision_exists", "Audited decisions are immutable.");
    const window = windowRowSchema.parse(readRecord(N.windows, value.windowId));
    if (Date.parse(value.expiresAt) > Date.parse(window.input.expiresAt)) throw new DurableError(400, "evaluation_decision_expired", "An observation decision cannot outlive its bound window evidence.");
    if (value.action === "continue-observation" && (window.invalidatedAt || Date.parse(window.input.expiresAt) <= Date.now()))
      throw new DurableError(409, "evaluation_evidence_invalid", "Deleted/revoked/restored/expired evidence cannot authorize continuing observation.");
    const row = decisionRowSchema.parse({ version: 1, input: value, createdAt: new Date().toISOString(), actor, summarySha256: result.summarySha256, deploymentPerformed: false });
    writeRecord(N.decisions, value.decisionId, row);
    if (value.action === "pause-sampling") {
      const policy = readRecord<PolicyRow>(N.policies, window.input.policyId)!;
      pauseEvaluationPolicy({ policyId: policy.input.policyId, expectedRevision: policy.revision });
    }
    return row;
  });
}
export async function evaluationDecisions(headers: Headers) {
  expireEvaluationObservations();
  const decisions = [];
  for (const row of listRecords<DecisionRow>(N.decisions)) {
    const window = windowRowSchema.parse(readRecord(N.windows, row.input.windowId));
    const policy = readRecord<PolicyRow>(N.policies, window.input.policyId);
    if (!policy) continue;
    try { await authorizeThreads(policy.input.threadIds, headers); decisions.push({ ...row, expired: Date.parse(row.input.expiresAt) <= Date.now(), evidenceInvalidated: window.invalidatedAt !== null }); } catch { /* No restricted metadata projection. */ }
  }
  return { decisions, deploymentPerformed: false };
}

let retentionTimer: NodeJS.Timeout | undefined;
export function startEvaluationMaintenance(): void {
  if (retentionTimer) return;
  observeSafely(() => { expireEvaluationObservations(); });
  retentionTimer = setInterval(() => observeSafely(() => { expireEvaluationObservations(); }), 60_000);
  retentionTimer.unref();
}
export function stopEvaluationMaintenance(): void {
  clearInterval(retentionTimer);
  retentionTimer = undefined;
}
