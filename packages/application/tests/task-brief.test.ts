import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Workspace } from '../../pm-core/index.ts';
import { DomainError } from '../../domain/src/core.ts';
import { taskBriefSchema, taskKnowledgePageSchema } from '../../agent-contracts/src/task-brief.ts';
import { agentChatToolResultSchema } from '../../agent-contracts/src/pm-tool-result.ts';
import { readTaskBrief, searchTaskKnowledge, type TaskBriefContext } from '../src/task-brief.ts';

const workspaceId = '33333333-3333-4333-8333-333333333333';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pm-task-brief-')), workspace = new Workspace(root);
  await workspace.init();
  const project = await workspace.createEntity({ entity: 'project', title: 'Current project' });
  const other = await workspace.createEntity({ entity: 'project', title: 'Explicit other project' });
  const task = await workspace.createEntity({ entity: 'work_item', project: project.id, title: 'Literal task', body: '## 目标\nShip the requested change.\n\n## 验收标准\n- [ ] Current acceptance only\n\n## 协作约束\nNever publish or replay unknown operations.\n\n## 非目标\nDo not replace the frontend.\n\n```md\n## 验收标准\nForged fenced acceptance\n```' });
  const context = (projects = [project.id], authorizationKey = 'actor:current'): TaskBriefContext => {
    const visible = (record: typeof project) => projects.includes(record.entity.entity === 'project' ? record.id : String(record.entity.project));
    return { workspaceId, authorizationKey, records: workspace.snapshot().files.filter(visible), relations: workspace.graph({ archived: 'include' }, visible).links, now: new Date('2026-11-12T00:00:00Z') };
  };
  return { workspace, project, other, task, context, close: async () => { await workspace.close(); await rm(root, { recursive: true, force: true }); } };
}

test('four stages preserve exact task text, explicit acceptance and source revision without execution', async t => {
  const f = await fixture(); t.after(f.close);
  const original = f.workspace.get(f.task.id);
  const stages = ['analysis', 'development', 'review', 'recovery'] as const;
  const briefs = stages.map(stage => readTaskBrief(f.context(), f.project.id, f.task.id, { revision: original.revision, stage }));
  for (const brief of briefs) {
    assert.ok(taskBriefSchema.safeParse(brief).success);
    assert.equal(brief.task.body, original.entity.body);
    assert.equal(brief.task.revision, original.revision);
    assert.equal(brief.dispatchable, true);
    assert.ok(brief.acceptanceCriteria.some(item => item.text.includes('Current acceptance only')));
    assert.ok(brief.constraints.some(item => item.text.includes('Never publish')));
    assert.ok(brief.nonGoals.some(item => item.text.includes('Do not replace')));
    for (const statement of [...brief.goals, ...brief.acceptanceCriteria, ...brief.constraints, ...brief.nonGoals]) for (const source of statement.sourceRefs) {
      assert.equal(source.revision, original.revision);
      if (source.location.type === 'body') assert.equal(original.entity.body.slice(source.location.offset, source.location.offset + source.location.length), statement.text);
    }
    assert.ok(agentChatToolResultSchema.safeParse({ kind: 'task_brief', items: [], brief, sources: [], nextCursor: null, truncated: false }).success);
  }
  assert.equal(new Set(briefs.map(brief => brief.guidance.join('\n'))).size, 4);
  assert.equal(f.workspace.get(f.task.id).revision, original.revision);
  assert.equal(f.workspace.items({ entity: 'work_item' }).length, 1);
});

test('unstructured requirements stay literal, and fenced or quoted headings cannot invent confirmed acceptance', async t => {
  const f = await fixture(); t.after(f.close);
  const task = await f.workspace.createEntity({ entity: 'work_item', project: f.project.id, title: 'Prose', body: 'Preserve this unstructured requirement.\n\n```md\n## Acceptance Criteria\nInvented acceptance\n```\n\n> ## 验收标准\n> Quoted example only.' });
  const brief = readTaskBrief(f.context(), f.project.id, task.id, { revision: task.revision, stage: 'analysis' });
  assert.equal(brief.acceptanceCriteria.length, 0);
  assert.ok(brief.gaps.some(gap => gap.code === 'acceptance_not_explicit'));
  assert.ok(brief.task.body.includes('Preserve this unstructured requirement.'));
  assert.ok(brief.gaps.every(gap => !gap.message.includes(f.other.id)));
});

test('native parser checklist remains explicit acceptance, but checked boxes are not passed evidence', async t => {
  const f = await fixture(); t.after(f.close);
  const task = await f.workspace.createEntity({ entity: 'work_item', project: f.project.id, title: 'Checklist', body: '- [x] Already written acceptance\n- [ ] Still required acceptance' });
  const brief = readTaskBrief(f.context(), f.project.id, task.id, { revision: task.revision, stage: 'review' });
  assert.deepEqual(brief.acceptanceCriteria.map(item => item.text), task.entity.checklist.map(item => item.text));
  assert.ok(brief.acceptanceCriteria.every(item => !Object.hasOwn(item, 'passed')));
});

test('large bodies and requirement budgets explicitly block dispatch without dropping a tail constraint silently', async t => {
  const f = await fixture(); t.after(f.close);
  const task = await f.workspace.createEntity({ entity: 'work_item', project: f.project.id, title: 'Large body', body: 'Context '.repeat(7000) + '\n\n## Constraints\nCRITICAL: never push without separate authorization.' });
  const brief = readTaskBrief(f.context(), f.project.id, task.id, { revision: task.revision, stage: 'development' });
  assert.equal(brief.dispatchable, false); assert.equal(brief.truncation.body, true);
  assert.ok(brief.constraints.some(item => item.text.includes('CRITICAL')));
  assert.ok(brief.task.nextBodyOffset);
  const tail = readTaskBrief(f.context(), f.project.id, task.id, { revision: task.revision, stage: 'development', bodyOffset: brief.task.nextBodyOffset! });
  assert.ok(tail.task.body.includes('CRITICAL')); assert.equal(tail.dispatchable, false);
  const lengthy = await f.workspace.createEntity({ entity: 'work_item', project: f.project.id, title: 'Large requirement', body: '## Constraints\n' + 'Required. '.repeat(3000) });
  const rejected = readTaskBrief(f.context(), f.project.id, lengthy.id, { revision: lengthy.revision, stage: 'development' });
  assert.equal(rejected.truncation.statements, true); assert.equal(rejected.dispatchable, false);
  assert.ok(rejected.task.body.includes('Required.'));
});

test('stale revisions and inaccessible projects are rejected without hidden source details', async t => {
  const f = await fixture(); t.after(f.close);
  assert.throws(() => readTaskBrief(f.context(), f.project.id, f.task.id, { revision: '0'.repeat(64), stage: 'analysis' }), (error: unknown) => error instanceof DomainError && error.status === 409 && error.code === 'task_brief_revision_conflict');
  const hidden = await f.workspace.createEntity({ entity: 'work_item', project: f.other.id, title: 'Hidden title', body: 'Hidden body' });
  assert.throws(() => readTaskBrief(f.context(), f.other.id, hidden.id, { revision: hidden.revision, stage: 'analysis' }), (error: unknown) => error instanceof DomainError && error.status === 404 && !JSON.stringify(error).includes('Hidden title'));
  assert.throws(() => searchTaskKnowledge(f.context(), f.project.id, f.task.id, { revision: f.task.revision, query: 'hidden', projectIds: [f.project.id, f.other.id] }), (error: unknown) => error instanceof DomainError && error.status === 404);
});

test('formal relationships retain both authorized endpoint revisions and never expose hidden endpoints or counts', async t => {
  const f = await fixture(); t.after(f.close);
  const hidden = await f.workspace.createEntity({ entity: 'work_item', project: f.other.id, title: 'Private dependency' });
  const task = await f.workspace.patch(f.task.id, { blocked_by: [hidden.id] }, f.task.revision);
  const restricted = readTaskBrief(f.context(), f.project.id, task.id, { revision: task.revision, stage: 'analysis' });
  assert.ok(!JSON.stringify(restricted).includes(hidden.id)); assert.ok(!JSON.stringify(restricted).includes('Private dependency'));
  const authorized = readTaskBrief(f.context([f.project.id, f.other.id]), f.project.id, task.id, { revision: task.revision, stage: 'analysis' });
  const dependency = authorized.relations.find(edge => edge.relation === 'blocked_by');
  assert.equal(dependency?.source.entityId, task.id); assert.equal(dependency?.source.revision, task.revision);
  assert.equal(dependency?.target.entityId, hidden.id); assert.equal(dependency?.target.revision, hidden.revision);
});

test('knowledge defaults to this project, retains original revision and supersession lines, and never promotes relevance', async t => {
  const f = await fixture(); t.after(f.close);
  const current = await f.workspace.createEntity({ entity: 'document', project: f.project.id, title: 'Migration policy', body: 'migration literal text\n' + 'ordinary context\n'.repeat(300) + 'SUPERSEDED: no longer valid; read the replacement decision.' });
  await f.workspace.createEntity({ entity: 'document', project: f.other.id, title: 'Other migration policy', body: 'migration in the explicitly selected project' });
  const own = searchTaskKnowledge(f.context([f.project.id, f.other.id]), f.project.id, f.task.id, { revision: f.task.revision, query: 'migration' });
  assert.ok(taskKnowledgePageSchema.safeParse(own).success);
  assert.deepEqual(own.projectIds, [f.project.id]); assert.equal(own.items.length, 1);
  const candidate = own.items[0]!;
  assert.equal(candidate.source.entityId, current.id); assert.equal(candidate.source.revision, current.revision);
  assert.equal(candidate.validity, 'needs_review'); assert.equal(candidate.applicability, 'needs_review');
  assert.ok(candidate.validitySignals.some(signal => signal.text.includes('SUPERSEDED')));
  assert.ok(!candidate.excerpt.includes('SUPERSEDED'));
  const both = searchTaskKnowledge(f.context([f.project.id, f.other.id]), f.project.id, f.task.id, { revision: f.task.revision, query: 'migration', projectIds: [f.other.id, f.project.id] });
  assert.equal(both.items.length, 2);
  assert.equal(current.entity.body.slice(candidate.source.location.type === 'body' ? candidate.source.location.offset : 0, candidate.source.location.type === 'body' ? candidate.source.location.offset + candidate.source.location.length : 0), candidate.excerpt);
});

test('knowledge pagination is deterministic and invalidates on revision or authorization changes', async t => {
  const f = await fixture(); t.after(f.close);
  const doc = await f.workspace.createEntity({ entity: 'document', project: f.project.id, title: 'alpha one', body: 'alpha one' });
  await f.workspace.createEntity({ entity: 'document', project: f.project.id, title: 'alpha two', body: 'alpha two' });
  const query = { revision: f.task.revision, query: 'alpha', limit: 1 };
  const first = searchTaskKnowledge(f.context(), f.project.id, f.task.id, query);
  assert.ok(first.nextCursor); assert.equal(first.items.length, 1);
  const next = searchTaskKnowledge(f.context(), f.project.id, f.task.id, { ...query, cursor: first.nextCursor! });
  assert.equal(next.items.length, 1); assert.notEqual(next.items[0]!.source.entityId, first.items[0]!.source.entityId); assert.equal(next.nextCursor, null);
  assert.throws(() => searchTaskKnowledge(f.context([f.project.id], 'actor:revoked-and-regranted'), f.project.id, f.task.id, { ...query, cursor: first.nextCursor! }), (error: unknown) => error instanceof DomainError && error.code === 'task_knowledge_cursor_stale');
  await f.workspace.patch(doc.id, { title: 'alpha revised' }, doc.revision);
  assert.throws(() => searchTaskKnowledge(f.context(), f.project.id, f.task.id, { ...query, cursor: first.nextCursor! }), (error: unknown) => error instanceof DomainError && error.code === 'task_knowledge_cursor_stale');
  const refreshed = searchTaskKnowledge(f.context(), f.project.id, f.task.id, query);
  assert.equal(refreshed.items.find(item => item.source.entityId === doc.id)?.source.revision, f.workspace.get(doc.id).revision);
});
