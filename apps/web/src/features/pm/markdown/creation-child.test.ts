import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultConfiguration } from '../../../../../../packages/pm-schema/index.ts';
import { creationChildHasContent, creationDraftIsPristine, newCreationDraft, prepareCreationAttempt, type CreationChild } from './creation-model.ts';

const child = (values: Record<string, unknown>, body = ''): CreationChild => ({ draftId: 'child-one', values, body });

test('blank subtask placeholders are ignored while any typed content or frozen attempt is kept', () => {
  assert.equal(creationChildHasContent(child({ title: '', assignee: null }, '')), false);
  assert.equal(creationChildHasContent(child({ title: '   ', assignee: null }, '  ')), false);
  assert.equal(creationChildHasContent(child({ title: '设计登录页面' })), true);
  assert.equal(creationChildHasContent(child({ title: '' }, '补充说明')), true);
  assert.equal(creationChildHasContent(child({ title: '', assignee: 'user-1' })), true);
  const attempted: CreationChild = { ...child({ title: '' }), attempt: { ...prepareCreationAttempt({ entity: 'work_item', title: 'Frozen title' }, 'key-one'), phase: 'unknown' } };
  assert.equal(creationChildHasContent(attempted), true);
});

test('only untouched drafts may adopt a new entry status', () => {
  const base = newCreationDraft('draft-one', defaultConfiguration, { entity: 'work_item', project: 'PRJ-001' });
  assert.equal(creationDraftIsPristine(base, defaultConfiguration), true);
  assert.equal(creationDraftIsPristine({ ...base, values: { ...base.values, status: 'review' } }, defaultConfiguration), false);
  assert.equal(creationDraftIsPristine({ ...base, values: { ...base.values, title: 'Work' } }, defaultConfiguration), false);
  assert.equal(creationDraftIsPristine({ ...base, body: 'Details' }, defaultConfiguration), false);
  assert.equal(creationDraftIsPristine({ ...base, watch: true }, defaultConfiguration), false);
  assert.equal(creationDraftIsPristine({ ...base, children: [child({ title: '' })] }, defaultConfiguration), false);
  const fromReviewEntry = newCreationDraft('draft-two', defaultConfiguration, { entity: 'work_item', project: 'PRJ-001', status: 'review' });
  assert.equal(creationDraftIsPristine(fromReviewEntry, defaultConfiguration), true);
});
