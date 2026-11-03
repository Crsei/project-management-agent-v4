import assert from 'node:assert/strict';
import test from 'node:test';
import { adoptDocumentSave, completeDocumentSave, documentSaveRecovery, hasUncertainDocumentSave, observeDocumentSave, preserveDocumentSaveRecovery, type DocumentDraftValue } from '../apps/web/src/features/pm/markdown/document-save-model.ts';
import { hasUncertainProjectTaskDraft } from '../apps/web/src/features/pm/service/project-task-editing-model.ts';

const uncertain = (raw = 'A typed body'): DocumentDraftValue => ({ raw, revision: 'A-base', documentSave: { phase: 'unknown', message: 'Read the authoritative source before another write.' } });

test('identity-bound A completion leaves active B and its revision untouched', async () => {
  const { promise, resolve } = Promise.withResolvers<string>();
  const drafts: Record<string, DocumentDraftValue> = { A: uncertain(), B: { raw: 'B typed body', revision: 'B-base' } };
  const dispatchedId = 'A';
  assert.ok(drafts[dispatchedId]);
  const dispatchedRaw = drafts[dispatchedId].raw;
  let active = 'A';
  const completion = promise.then(revision => {
    const retained = completeDocumentSave(drafts[dispatchedId], dispatchedRaw, revision);
    if (retained) drafts[dispatchedId] = retained; else delete drafts[dispatchedId];
  });
  active = 'B';
  resolve('A-saved');
  await completion;
  assert.equal(active, 'B');
  assert.equal(drafts.A, undefined);
  assert.deepEqual(drafts.B, { raw: 'B typed body', revision: 'B-base' });
});

test('typing during A save retains journal metadata and advances only newer A draft CAS baseline on success', () => {
  const original = uncertain();
  const edited = preserveDocumentSaveRecovery({ A: original }, { A: { raw: 'A newer edit while saving', revision: 'accidental-new-baseline' } });
  assert.ok(edited.A);
  assert.equal(edited.A.raw, 'A newer edit while saving');
  assert.equal(edited.A.revision, 'A-base');
  assert.deepEqual(edited.A.documentSave, original.documentSave);
  assert.deepEqual(completeDocumentSave(edited.A, original.raw, 'A-saved'), { raw: 'A newer edit while saving', revision: 'A-saved' });
});

test('ordinary discard cannot remove unresolved metadata and unknown document writes lock other native surfaces', () => {
  const original = uncertain();
  const next = preserveDocumentSaveRecovery({ A: original }, {});
  assert.equal(next.A, original);
  assert.equal(hasUncertainDocumentSave(next), true);
  assert.equal(hasUncertainProjectTaskDraft(next), true);
  assert.equal(hasUncertainProjectTaskDraft(next, 'A'), false, 'only the active in-flight editor may continue typing its own draft');
  assert.equal(hasUncertainProjectTaskDraft({ ...next, B: uncertain('B') }, 'A'), true);
});

test('refresh preserves unknown recovery but never restores a fictitious saving spinner', () => {
  const restored = JSON.parse(JSON.stringify({ A: uncertain() })) as Record<string, DocumentDraftValue>;
  assert.equal(documentSaveRecovery(restored.A)?.phase, 'unknown');
  assert.equal(hasUncertainDocumentSave(restored), true);
  const original = restored.A;
  assert.ok(original);
  assert.throws(() => adoptDocumentSave(original, { raw: original.raw, revision: 'A-current' }), /Read the authoritative source/);
});

test('read-after-lost-response is only an observation; explicit matching adoption clears the draft', () => {
  const original = uncertain();
  const file = { raw: original.raw, revision: 'A-observed' };
  const observed = observeDocumentSave(original, file);
  assert.equal(observed.documentSave?.phase, 'observed');
  assert.match(observed.documentSave!.message, /not a write receipt/);
  assert.equal(hasUncertainProjectTaskDraft({ A: observed }), true);
  assert.equal(adoptDocumentSave(observed, file), undefined);
});

test('different observed source keeps local edits and refuses a later unobserved revision', () => {
  const original = uncertain('local edit newer than dispatched save');
  const observedSource = { raw: 'authoritative A body', revision: 'A-observed' };
  const observed = observeDocumentSave(original, observedSource);
  assert.match(observed.documentSave!.message, /Nothing was retried/);
  assert.throws(() => adoptDocumentSave(observed, { ...observedSource, revision: 'A-changed-again' }), /Read the authoritative source again/);
  assert.deepEqual(adoptDocumentSave(observed, observedSource), { raw: original.raw, revision: 'A-observed' });
  const refreshedSource = { raw: 'new authoritative A body', revision: 'A-changed-again' };
  const reread = observeDocumentSave(observed, refreshedSource);
  assert.deepEqual(adoptDocumentSave(reread, refreshedSource), { raw: original.raw, revision: 'A-changed-again' });
});
