import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { benchmarkConfig } from '../benchmark.config.ts';
import { prepareReportDirectory } from '../reports/files.ts';
import { applyOnlineFence, assertLineageActive, createContentPreview, expireFeedbackSources, exportFeedbackMetadata, feedbackState, grantContentPermission, importFeedbackMetadata, importOnlineFeedback, intakeFeedback, readContentPreview, reviewContentPreview, triageFeedback, validateFeedbackExport, withdrawFeedbackSource } from './feedback.ts';
import { privateJson, readEvents, reservedOutput, resolveDatasetArchiveRoot } from './dataset-files.ts';
import { runDatasetCommand } from './commands-dataset.ts';

const future = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
function intake(sourceId = 'source-a', occurrenceId = 'occurrence-a') {
  return { caseId: 'case-a', familyId: 'family-a', signatureCode: 'permission-denied', source: { sourceId, sourceVersion: 'v1', kind: 'manual-feedback' as const, provenanceId: 'operator-report-v1', retentionUntil: future(), importedClaim: false, observation: null }, occurrenceId, expectedCode: 'authorized-write', actualCode: 'permission-denied', severity: 'high' as const, reportedRoot: 'model' as const, releaseId: 'release-a' };
}

test('duplicate feedback preserves every occurrence and reported roots without confirming user claims', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evaluation-feedback-'));
  try {
    const first = intake();
    await intakeFeedback(root, first);
    await intakeFeedback(root, first);
    const merged = await intakeFeedback(root, { ...intake('source-b', 'occurrence-b'), caseId: 'would-be-duplicate', reportedRoot: 'permission', releaseId: 'release-b' });
    assert.equal(merged.caseId, 'case-a');
    assert.equal(merged.occurrences.length, 2);
    assert.deepEqual(merged.occurrences.map(item => item.reportedRoot), ['model', 'permission']);
    assert.deepEqual(merged.occurrences.map(item => item.releaseId), ['release-a', 'release-b']);
    assert.equal(merged.triage, null);
    await assert.rejects(intakeFeedback(root, { ...first, severity: 'low' }), /Occurrence identity conflicts/);
    await assert.rejects(triageFeedback(root, { caseId: 'case-a', status: 'accepted', reviewerId: 'reviewer', rootCategory: 'model', rootCertainty: 'confirmed', reasonCode: 'user-said-so', reproductionId: null }), /independently reviewed reproduction/);
    await triageFeedback(root, { caseId: 'case-a', status: 'insufficient', reviewerId: 'reviewer', rootCategory: 'permission', rootCertainty: 'inferred', reasonCode: 'authorization-may-be-correct', reproductionId: null });
    const state = feedbackState(await readEvents(root));
    assert.equal(state.cases.get('case-a')?.reportedRoot, 'model');
    assert.equal(state.cases.get('case-a')?.triage?.rootCertainty, 'inferred');
    const bundle = await exportFeedbackMetadata(root, 'export-a');
    const restored = path.join(root, 'restored');
    await importFeedbackMetadata(restored, bundle);
    const imported = feedbackState(await readEvents(restored)).cases.get('case-a');
    assert.equal(imported?.occurrences.length, 2);
    assert.equal(imported?.triage, null);
    assert.ok(imported?.occurrences.every(item => item.importedClaim));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('content permission is separate, previews bounded and sanitized, withdrawal fences restoration without touching PM facts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evaluation-content-'));
  try {
    const input = intake();
    await intakeFeedback(root, input);
    const preview = { previewId: 'preview-a', sourceId: 'source-a', permissionId: 'permission-a', transformVersion: 'bounded-redaction-v1', text: 'Contact person@example.test https://private.test/path /home/private/file Bearer private-token' };
    await assert.rejects(createContentPreview(root, preview), /Explicit current content permission/);
    await assert.rejects(createContentPreview(root, { ...preview, text: 'x'.repeat(16385) }));
    await grantContentPermission(root, { permissionId: 'permission-a', sourceId: 'source-a', sourceVersion: 'v1', grantedBy: 'grant-owner', purpose: 'local-evaluation', audience: 'local-reviewers', allowDataset: false, allowExport: false, allowTraining: false, allowPublic: false, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
    await createContentPreview(root, preview);
    const reviewInput = { previewId: 'preview-a', reviewerId: 'independent-content-reviewer', disposition: 'approved', secretsChecked: true, piiChecked: true, reasonCode: 'synthetic-identifiers-only' };
    await assert.rejects(reviewContentPreview(root, { ...reviewInput, reviewerId: 'grant-owner' }), /independent/);
    await reviewContentPreview(root, reviewInput);
    const shown = JSON.stringify(await readContentPreview(root, 'preview-a'));
    assert.ok(shown.includes('[redacted-email]'));
    assert.ok(!shown.includes('person@example.test') && !shown.includes('private-token') && !shown.includes('/home/private'));
    const eventBytes = (await readEvents(root)).map(event => JSON.stringify(event)).join('\n');
    assert.ok(!eventBytes.includes('redacted-email') && !eventBytes.includes('person@example.test'));
    const bundle = await exportFeedbackMetadata(root, 'before-withdrawal');
    assert.ok(!JSON.stringify(bundle).includes('text'));
    await validateFeedbackExport(root, bundle);
    await writeFile(path.join(root, 'pm-authority-sentinel'), 'original-operation-receipt', { mode: 0o600 });
    await withdrawFeedbackSource(root, { sourceId: 'source-a', reason: 'permission-revoked', actorId: 'grant-owner' });
    assert.equal(await readFile(path.join(root, 'pm-authority-sentinel'), 'utf8'), 'original-operation-receipt');
    await assert.rejects(lstat(path.join(root, 'content', 'source-a')), { code: 'ENOENT' });
    await assert.rejects(readContentPreview(root, 'preview-a'), /withdrawn/);
    await assert.rejects(validateFeedbackExport(root, bundle), /withdrawn/);
    await assert.rejects(importFeedbackMetadata(root, bundle), /resurrect/);
    const fencedBackup = await exportFeedbackMetadata(root, 'after-withdrawal');
    const restored = path.join(root, 'restored');
    await importFeedbackMetadata(restored, fencedBackup);
    await assert.rejects(importFeedbackMetadata(restored, bundle), /resurrect/);
    await assert.rejects(intakeFeedback(restored, { ...input, source: { ...input.source, retentionUntil: future() } }), /resurrect/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function onlineEnvelope() {
  const storeId = randomUUID(), observationId = randomUUID(), clusterId = randomUUID(), policyId = randomUUID();
  return { format: 'agent-evaluation-metadata-v1' as const, schemaVersion: 1 as const, exportId: randomUUID(), storeId, restoreEpoch: 3, exportedAt: new Date().toISOString(), identityTrust: 'operator-configured' as const, contentIncluded: false as const,
    observations: [{ observationId, clusterId, policyId, policyRevision: 1, release: { artifactSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64) }, unit: 'generation' as const, kind: 'chat' as const, driver: 'omp' as const, configurationId: 'c'.repeat(64), configurationIdentity: 'pending' as const, samplingDesignSha256: 'd'.repeat(64), acceptedAt: new Date().toISOString(), terminalAt: null, expiresAt: future(), status: 'pending' as const, errorClass: 'none' as const, random: { candidate: true, probability: 0.2, selected: true }, failure: { candidate: false, probability: 0.5, selected: false }, unknown: { candidate: false, probability: 0.5, selected: false }, inclusionProbability: 0.2, probabilityFinal: false, usage: { source: 'unavailable' as const, completeness: 'unknown' as const, inputTokens: null, outputTokens: null, costUsd: null, currency: 'USD' as const, priceIdentity: null } }],
    denominators: [], fences: [], coverage: { status: 'complete' as const, observerErrors: 0, rejectedBeforeAcceptance: 0, rejectedCoverage: 'scoped-admission-rejections-only' as const } };
}

test('sanitized online imports remain claims, bound original expiry, and epoch/observation fences block later imports', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evaluation-online-import-'));
  try {
    const metadata = onlineEnvelope(), observation = metadata.observations[0]!;
    const request = { metadata, observationIds: [observation.observationId], retentionUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(), provenanceId: 'local-operator-export', expectedCode: 'review-required', actualCode: 'user-reported-failure', severity: 'medium' };
    await assert.rejects(importOnlineFeedback(root, { ...request, retentionUntil: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString() }), /original approved observation expiry/);
    await importOnlineFeedback(root, request);
    const state = feedbackState(await readEvents(root)), feedback = [...state.cases.values()][0]!;
    assert.equal(feedback.triage, null);
    assert.equal(feedback.occurrences[0]?.importedClaim, true);
    assert.equal(feedback.reportedRoot, 'unknown');
    const sourceId = feedback.occurrences[0]!.sourceId;
    await assertLineageActive(root, [sourceId]);
    const fence = { fenceId: randomUUID(), storeId: metadata.storeId, restoreEpoch: metadata.restoreEpoch, scope: 'observations', observationIds: [observation.observationId], reason: 'revoked', createdAt: new Date().toISOString() };
    await applyOnlineFence(root, fence);
    await assert.rejects(assertLineageActive(root, [sourceId]), /fence/);
    await assert.rejects(importOnlineFeedback(root, request), /fence/);
    const nextObservation = { ...observation, observationId: randomUUID() };
    await applyOnlineFence(root, { ...fence, fenceId: randomUUID(), scope: 'store-epoch', observationIds: [], reason: 'restored' });
    await assert.rejects(importOnlineFeedback(root, { ...request, metadata: { ...metadata, observations: [nextObservation] }, observationIds: [nextObservation.observationId] }), /fence/);
    const backup = await exportFeedbackMetadata(root, 'online-fenced-backup');
    const restored = path.join(root, 'restored');
    await importFeedbackMetadata(restored, backup);
    await assert.rejects(importOnlineFeedback(restored, request), /fence/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('registry and CLI refuse path traversal, redirected roots, links and overwritten operation outputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evaluation-safe-paths-'));
  await prepareReportDirectory(benchmarkConfig.outputsRoot);
  const cliRoot = await mkdtemp(path.join(benchmarkConfig.outputsRoot, 'evaluation-cli-feedback-'));
  try {
    assert.throws(() => reservedOutput('../outside'));
    assert.throws(() => resolveDatasetArchiveRoot(root, '../outside'));
    assert.throws(() => resolveDatasetArchiveRoot(root, 'nested/../../outside'));
    await mkdir(path.join(root, 'real'), { mode: 0o700 });
    await symlink(path.join(root, 'real'), path.join(root, 'redirected'));
    await assert.rejects(intakeFeedback(path.join(root, 'redirected'), intake()), /symlink|redirected/);
    const inputFile = path.join(root, 'intake.json');
    await writeFile(inputFile, JSON.stringify(intake()), { mode: 0o600 });
    await link(inputFile, path.join(root, 'hardlink.json'));
    await assert.rejects(privateJson(inputFile), /single-link/);
    await rm(path.join(root, 'hardlink.json'));
    const flags = { input: inputFile, registry: path.join(cliRoot, 'registry'), 'output-root': path.join(cliRoot, 'operation-a') };
    const result = await runDatasetCommand('feedback-intake', flags);
    assert.equal(result?.exitCode, 0);
    await assert.rejects(runDatasetCommand('feedback-intake', flags), /already exists/);
    await assert.rejects(runDatasetCommand('feedback-intake', { ...flags, 'output-root': path.join(cliRoot, 'registry', 'overlap') }), /nonoverlapping/);
    await assert.rejects(runDatasetCommand('feedback-intake', { ...flags, unknown: 'x' }), /Unsupported/);
    await assert.rejects(intakeFeedback(root, { ...intake(), caseId: '../escape' }));
    assert.equal((await lstat(path.join(cliRoot, 'operation-a', 'result.json'))).mode & 0o077, 0);
    await chmod(inputFile, 0o644);
    await assert.rejects(privateJson(inputFile), /private/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(cliRoot, { recursive: true, force: true }); }
});

test('permission and source retention erase only collected content and leave irreversible metadata tombstones', async context => {
  const now = Date.now();
  context.mock.timers.enable({ apis: ['Date'], now });
  const root = await mkdtemp(path.join(os.tmpdir(), 'evaluation-retention-'));
  try {
    const input = intake();
    input.source.retentionUntil = new Date(now + 60_000).toISOString();
    await intakeFeedback(root, input);
    await grantContentPermission(root, { permissionId: 'short-permission', sourceId: 'source-a', sourceVersion: 'v1', grantedBy: 'source-owner', purpose: 'local-evaluation', audience: 'local-reviewers', allowDataset: false, allowExport: false, allowTraining: false, allowPublic: false, expiresAt: new Date(now + 30_000).toISOString() });
    await createContentPreview(root, { previewId: 'short-preview', sourceId: 'source-a', permissionId: 'short-permission', transformVersion: 'redaction-v1', text: 'Synthetic bounded review fragment.' });
    context.mock.timers.setTime(now + 30_001);
    await assert.rejects(readContentPreview(root, 'short-preview'), /Explicit current content permission/);
    await expireFeedbackSources(root, 'retention-operator');
    await assert.rejects(lstat(path.join(root, 'content', 'source-a')), { code: 'ENOENT' });
    await assertLineageActive(root, ['source-a']);
    context.mock.timers.setTime(now + 60_001);
    await expireFeedbackSources(root, 'retention-operator');
    await assert.rejects(assertLineageActive(root, ['source-a']), /withdrawn/);
    await assert.rejects(intakeFeedback(root, { ...input, source: { ...input.source, retentionUntil: future() } }), /resurrect/);
    const tombstoneBackup = await exportFeedbackMetadata(root, 'expired-backup');
    const restored = path.join(root, 'restored');
    await importFeedbackMetadata(restored, tombstoneBackup);
    await assert.rejects(intakeFeedback(restored, { ...input, source: { ...input.source, retentionUntil: future() } }), /resurrect/);
  } finally { context.mock.timers.reset(); await rm(root, { recursive: true, force: true }); }
});
