import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { HIDDEN_MARKER } from './corpus.ts';
import type { PmServiceObservation } from './grade.ts';
import { runPmServiceStudy } from './service-study.ts';

test('targeted service corpus exercises authorization, exact source identities, complete stable pages and visible revision changes, not consumer mixed-page refusal', { timeout: 900_000 }, async () => {
  const result = await runPmServiceStudy({ repetitions: 3 });
  assert.equal(result.passed, true, JSON.stringify(result.checks.filter(check => !check.passed)));
  for (const id of ['PMT01:complete-body-final-negative', 'PMT02:full-inventory-not-first-twenty', 'PMT03:structural-not-lexical-headings', 'PMT04:no-unauthorized-matches', 'PMT04:same-name-explicit-project-scope', 'PMT05:current-and-superseded-remain-unverified', 'PMT06:old-revision-rejected-new-read-current', 'PMT06:unpinned-reader-revision-change-visible', 'PMT10:both-negations-and-version-preserved']) {
    assert.equal(result.checks.find(check => check.id === id)?.passed, true, id);
  }
  assert.equal(result.inferencePerformed, false);
  assert.equal(result.providerRequestBytes, null); assert.equal(result.tokens, null); assert.equal(result.modelQuality, null);
  assert.equal(result.avoidableRepeatReads, null);
  assert.deepEqual(result.protocolObservations, { freshProductSessionReread: null, compactionRetainedRequirements: null, lostReceiptRecovery: null });
  assert.deepEqual(result.consumerObservations, { mixedRevisionPageRefusal: null });
  assert.equal(result.scenarios.find(scenario => scenario.id === 'PMT06')?.observation, 'authenticated-pm-service-only-consumer-unobserved');
  assert.ok(result.measurements.every(measurement => measurement.boundary === 'pm-service-result' && measurement.modelRequestUtf8Bytes === null));
  assert.ok(result.measurements.some(measurement => measurement.exactVisibleStatementCopyUtf8Bytes > 0));
  assert.ok(result.microbenchmark.every(measurement => measurement.n === 3 && measurement.p95Ms === null && measurement.cacheState === 'uncontrolled' && measurement.samples.every(sample => sample.status === 'succeeded')));
  const calls: PmServiceObservation[] = JSON.parse(await readFile(result.artifacts.calls, 'utf8'));
  assert.ok(calls.filter(call => call.id.startsWith('restricted-')).every(call => !JSON.stringify(call.record).includes(HIDDEN_MARKER)));
  assert.ok(calls.every(call => call.boundary === 'authenticated-pm-http' && call.responseUtf8Bytes > 0 && call.elapsedMs >= 0));
  assert.ok(calls.every(call => call.request.threadId === '' && call.request.generationId === '' && call.request.executionRoot === 'external'), 'External service probes are never mislabeled as real Chat Sessions');
});
