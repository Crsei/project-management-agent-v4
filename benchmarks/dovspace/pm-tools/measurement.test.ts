import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Workspace } from '../../../packages/pm-core/index.ts';
import { readTaskBrief } from '../../../packages/application/src/task-brief.ts';
import type { FileRecord } from '../../../packages/pm-schema/index.ts';
import { pmToolCallRecordSchema } from '../../../packages/agent-contracts/src/pm-tools.ts';
import type { FixtureEntity } from '../schemas/types.ts';
import { HEADING_BODY, REQUIRED_QUOTES, STANDARD_BODY } from './corpus.ts';
import { gradeBriefAgainstAuthority, gradeInventoryAgainstAuthority, type PmServiceObservation } from './grade.ts';
import { measureBriefBytes } from './measurement.ts';

const workspaceId = '33333333-3333-4333-8333-333333333333';
async function fixture(body: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'pm-tool-preservation-'));
  const workspace = new Workspace(root);
  await workspace.init();
  const project = await workspace.createEntity({ entity: 'project', title: 'Migration control' });
  const task = await workspace.createEntity({ entity: 'work_item', project: project.id, title: 'Migration control', body });
  const context = { workspaceId, authorizationKey: 'current-synthetic-actor', records: workspace.snapshot().files, relations: workspace.graph({ archived: 'include' }).links };
  function authority(record: FileRecord): FixtureEntity {
    return { key: 'authority', id: record.id, projectId: String(record.entity.project), kind: record.entity.entity, revision: record.revision, path: record.path, entity: { ...record.entity }, raw: record.raw };
  }
  return { task, project, workspace, context, authority: authority(task), close: async () => { await workspace.close(); await rm(root, { recursive: true, force: true }); } };
}

test('exact current service input reproduces body/section/source duplication without claiming envelope or model gains', async t => {
  const f = await fixture(STANDARD_BODY); t.after(f.close);
  const brief = readTaskBrief(f.context, f.project.id, f.task.id, { revision: f.task.revision, stage: 'development' });
  const measured = measureBriefBytes(brief);
  assert.equal(measured.bodyUtf8Bytes, Buffer.byteLength(f.task.entity.body, 'utf8'));
  assert.equal(measured.serializedUtf8Bytes, Buffer.byteLength(JSON.stringify(brief), 'utf8'));
  assert.ok(measured.exactVisibleStatementCopyUtf8Bytes > 0);
  assert.ok(measured.sourceRefs.repeatedOccurrences > 0);
  assert.equal(measured.modelRequestUtf8Bytes, null); assert.equal(measured.tokens, null); assert.equal(measured.modelQuality, null);
  assert.ok(gradeBriefAgainstAuthority(brief, f.authority, workspaceId).every(check => check.passed));
  assert.ok(brief.task.body.includes(REQUIRED_QUOTES.prose));
  assert.ok(brief.task.body.includes(REQUIRED_QUOTES.negative));
  assert.ok(brief.task.body.includes(REQUIRED_QUOTES.nearNegative));
  assert.ok(brief.task.body.includes(REQUIRED_QUOTES.version));
  assert.ok(brief.task.body.includes(REQUIRED_QUOTES.unicode));
});

test('independent source grader rejects silently lost negation, version, prose or original source offsets', async t => {
  const f = await fixture(STANDARD_BODY); t.after(f.close);
  const brief = readTaskBrief(f.context, f.project.id, f.task.id, { revision: f.task.revision, stage: 'development' });
  for (const quote of [REQUIRED_QUOTES.prose, REQUIRED_QUOTES.negative, REQUIRED_QUOTES.nearNegative, REQUIRED_QUOTES.version, REQUIRED_QUOTES.nonGoal]) {
    const changed = structuredClone(brief); changed.task.body = changed.task.body.replace(quote, '');
    assert.equal(gradeBriefAgainstAuthority(changed, f.authority, workspaceId).find(check => check.id === 'brief-exact-original-page')?.passed, false);
  }
  const wrongOffset = structuredClone(brief);
  const source = wrongOffset.constraints[0]!.sourceRefs[0]!;
  assert.equal(source.location.type, 'body');
  if (source.location.type === 'body') source.location.offset++;
  assert.equal(gradeBriefAgainstAuthority(wrongOffset, f.authority, workspaceId).find(check => check.id === 'brief-literal-statement-source-offsets')?.passed, false);
  assert.equal(measureBriefBytes(wrongOffset).statements.find(statement => statement.section === 'constraints')?.exactVisibleBodyCopy, false);
  const missingMetadata = { ...brief, dispatchable: undefined };
  assert.equal(gradeBriefAgainstAuthority(missingMetadata, f.authority, workspaceId)[0]?.passed, false);
  const missingBodySource = { ...brief, sources: [] };
  assert.equal(gradeBriefAgainstAuthority(missingBodySource, f.authority, workspaceId).find(check => check.id === 'brief-body-page-source-preserved')?.passed, false);
});

test('off-page negative extraction is necessary content, not a visible-body duplicate', async t => {
  const body = `${'Original source context.\n'.repeat(2200)}\n## Constraints\n${REQUIRED_QUOTES.tail}\n`;
  const f = await fixture(body); t.after(f.close);
  const brief = readTaskBrief(f.context, f.project.id, f.task.id, { revision: f.task.revision, stage: 'development' });
  const measured = measureBriefBytes(brief);
  assert.equal(brief.task.body.includes(REQUIRED_QUOTES.tail), false);
  assert.ok(brief.constraints.some(statement => statement.text.includes(REQUIRED_QUOTES.tail)));
  assert.equal(measured.exactVisibleStatementCopyUtf8Bytes, 0);
  assert.ok(measured.outsideVisibleBodyStatementUtf8Bytes >= Buffer.byteLength(REQUIRED_QUOTES.tail));
  assert.equal(brief.dispatchable, false); assert.equal(brief.truncation.body, true);
  assert.ok(gradeBriefAgainstAuthority(brief, f.authority, workspaceId).every(check => check.passed));
  const offset = brief.task.nextBodyOffset!;
  const tail = readTaskBrief(f.context, f.project.id, f.task.id, { revision: f.task.revision, stage: 'development', bodyOffset: offset });
  assert.ok(tail.task.body.includes(REQUIRED_QUOTES.tail));
  assert.ok(gradeBriefAgainstAuthority(tail, f.authority, workspaceId, offset).every(check => check.passed));
});

test('similar Markdown/code/Chinese/English headings keep literal body while only structural sections become statements', async t => {
  const f = await fixture(HEADING_BODY); t.after(f.close);
  const brief = readTaskBrief(f.context, f.project.id, f.task.id, { revision: f.task.revision, stage: 'analysis' });
  assert.equal(brief.task.body, f.task.entity.body);
  assert.equal(brief.acceptanceCriteria.length, 1);
  assert.match(brief.acceptanceCriteria[0]!.text, /REAL-CHINESE-ACCEPTANCE/);
  assert.doesNotMatch(brief.acceptanceCriteria[0]!.text, /FENCED-ONLY|QUOTED-ONLY|SIMILAR-ONLY/);
  assert.equal(brief.constraints.length, 2);
  assert.match(brief.constraints[0]!.text, /Never publish/);
  assert.match(brief.constraints[1]!.text, /Do publish/);
  assert.ok(gradeBriefAgainstAuthority(brief, f.authority, workspaceId).every(check => check.passed));
});

test('UTF-16 offsets preserve emoji and never masquerade as UTF-8 byte offsets', async t => {
  const f = await fixture(`🧭中文 before\n\n## Constraints\n${REQUIRED_QUOTES.negative}\n`); t.after(f.close);
  const brief = readTaskBrief(f.context, f.project.id, f.task.id, { revision: f.task.revision, stage: 'review' });
  const ref = brief.constraints[0]!.sourceRefs[0]!;
  assert.equal(ref.location.type, 'body');
  if (ref.location.type !== 'body') assert.fail('Expected real parser body location');
  assert.notEqual(ref.location.offset, Buffer.byteLength(f.task.entity.body.slice(0, ref.location.offset), 'utf8'));
  assert.equal(f.task.entity.body.slice(ref.location.offset, ref.location.offset + ref.location.length), brief.constraints[0]!.text);
  assert.equal(measureBriefBytes(brief).bodyOffsetUnit, 'javascript-utf16-code-units');
});

test('inventory grader requires every authority ID and its exact revision once, not merely 23 distinct IDs', async t => {
  const f = await fixture(STANDARD_BODY); t.after(f.close);
  for (let index = 0; index < 22; index++) await f.workspace.createEntity({ entity: 'work_item', project: f.project.id, title: `Inventory ${index}`, body: 'Original inventory source.' });
  const records = f.workspace.snapshot().files.filter(record => record.entity.entity === 'work_item');
  const authority: FixtureEntity[] = records.map(record => ({ ...f.authority, id: record.id, revision: record.revision, path: record.path, entity: { ...record.entity }, raw: record.raw }));
  const pages: PmServiceObservation[] = [records.slice(0, 20), records.slice(20)].map((items, index): PmServiceObservation => {
    const operationId = randomUUID();
    const request = { operationId, name: 'pm_query', arguments: { entity: 'work_item', projectId: f.project.id, query: null, after: index === 0 ? null : 'page-2', limit: 20 }, target: { workspaceId, projectId: f.project.id }, executionRoot: 'external' as const, threadId: '', messageId: '', generationId: '' };
    // Deliberate grader inputs, not claimed HTTP execution evidence.
    const record = pmToolCallRecordSchema.parse({ operationId, name: request.name, status: 'succeeded', result: { kind: 'query', items: items.map(item => ({ id: item.id, projectId: f.project.id, entity: 'work_item', title: item.entity.title, revision: item.revision, version: 0, status: null })), nextCursor: index === 0 ? 'page-2' : null, truncated: false, sources: [] }, error: null, workspaceId, threadId: '', messageId: '', generationId: '', createdAt: '', finishedAt: '' });
    return { id: `inventory-${index}`, scenarioId: 'PMT02', boundary: 'authenticated-pm-http', request, httpStatus: 200, responseUtf8Bytes: 1, elapsedMs: 0, record, errorCode: null };
  });
  assert.equal(gradeInventoryAgainstAuthority(pages, authority, f.project.id).passed, true);
  const variants = [
    { name: 'wrong revision with every correct ID', mutate(calls: PmServiceObservation[]) { const result = calls[1]!.record!.result; if (result?.kind === 'query') result.items[0]!.revision = 'stale-revision'; } },
    { name: 'duplicate across pages despite all expected IDs', mutate(calls: PmServiceObservation[]) { const first = calls[0]!.record!.result, last = calls[1]!.record!.result; if (first?.kind === 'query' && last?.kind === 'query') last.items.push(structuredClone(first.items[0]!)); } },
    { name: 'omitted last authority item', mutate(calls: PmServiceObservation[]) { const result = calls[1]!.record!.result; if (result?.kind === 'query') result.items.pop(); } },
    { name: 'unconsumed continuation', mutate(calls: PmServiceObservation[]) { const result = calls[1]!.record!.result; if (result?.kind === 'query') result.nextCursor = 'unread-page'; } },
  ];
  for (const variant of variants) {
    const changed = structuredClone(pages); variant.mutate(changed);
    assert.equal(gradeInventoryAgainstAuthority(changed, authority, f.project.id).passed, false, variant.name);
  }
});
