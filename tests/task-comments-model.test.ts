import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { Command, CommandReceipt } from '../packages/contracts/src/client.ts';
import { createCommentDraftStore, emptyCommentDraft, settleCommentDraft } from '../apps/web/src/features/pm/service/task-comments-model.ts';

const attempt = (): Command<'UpdateTaskComment'> => ({ commandId: randomUUID(), commandType: 'UpdateTaskComment', targetId: 'TASK-001', projectId: 'PRJ-001', expectedVersions: { '73f1a438-7061-42a0-93eb-19dc58ca3b7c': 1 }, payload: { commentId: '73f1a438-7061-42a0-93eb-19dc58ca3b7c', content: 'Unsaved author draft' } });
describe('task comment original drafts and receipts', () => {
  it('retains author text and original base after a real version rejection instead of silently rebasing', () => {
    const command = attempt();
    const original = { ...emptyCommentDraft(), content: 'Unsaved author draft', original: 'Original server body', baseVersion: 1, attempt: command };
    const rejected: CommandReceipt = { commandId: command.commandId, status: 'rejected', httpStatus: 409, error: { code: 'version_conflict', message: 'Comment version changed' } };
    assert.deepEqual(settleCommentDraft(original, rejected), { ...original, attempt: null, confirmed: false });
    assert.equal(original.attempt, command);
  });
  it('freezes a committed unknown draft under its original command until explicitly cleared, avoiding duplicate publish', () => {
    const command = attempt();
    const original = { ...emptyCommentDraft(), content: 'Unsaved author draft', baseVersion: 1, attempt: command };
    const receipt: CommandReceipt = { commandId: command.commandId, status: 'committed', httpStatus: 200, result: { id: command.payload.commentId, version: 2 } };
    const settled = settleCommentDraft(original, receipt);
    assert.equal(settled.confirmed, true);
    assert.equal(settled.attempt?.commandId, command.commandId);
    assert.equal(settled.content, original.content);
    assert.equal(settleCommentDraft(original, { ...receipt, commandId: randomUUID() }), original);
  });
  it('restores original content, CAS and commandId after refresh with isolated per-tab storage keys', () => {
    const records = new Map<string, string>();
    const storage = { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } };
    const store = createCommentDraftStore('actor/workspace/project/task', storage);
    const draft = { ...emptyCommentDraft(), content: 'First tab draft', baseVersion: 3, attempt: attempt() };
    assert.equal(store.commit(() => ({ new: draft })), true);
    assert.deepEqual(createCommentDraftStore('actor/workspace/project/task', storage).getSnapshot(), { new: draft });
    assert.deepEqual(createCommentDraftStore('different-actor/workspace/project/task', storage).getSnapshot(), {});
  });
  it('keeps typed input in memory on quota failure and requires successful persistence before dispatch', () => {
    let blocked = true;
    let text: string | null = null;
    const store = createCommentDraftStore('isolated', { getItem: () => text, setItem: (_key, value) => { if (blocked) throw new Error('quota'); text = value; } });
    assert.equal(store.commit(() => ({ new: { ...emptyCommentDraft(), content: 'Do not lose this' } })), false);
    assert.equal(store.persistenceError(), true);
    assert.equal(store.getSnapshot().new?.content, 'Do not lose this');
    blocked = false;
    assert.equal(store.flush(), true);
    assert.equal(store.persistenceError(), false);
    assert.equal(JSON.parse(text!).new.content, 'Do not lose this');
  });
  it('does not overwrite unreadable historical recovery storage with an empty fallback', () => {
    let writes = 0;
    const store = createCommentDraftStore('isolated', { getItem: () => '{corrupt', setItem: () => { writes += 1; } });
    assert.equal(store.persistenceError(), true);
    assert.equal(store.commit(() => ({ new: { ...emptyCommentDraft(), content: 'Still in memory' } })), false);
    assert.equal(store.flush(), false);
    assert.equal(writes, 0);
    assert.equal(store.getSnapshot().new?.content, 'Still in memory');
  });
});
