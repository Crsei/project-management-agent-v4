import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { it } from 'node:test';
import type { AgentChatToolName } from '../packages/application/src/agent-chat-tools.ts';
import type { PmToolCallRecord } from '../packages/agent-contracts/src/pm-tools.ts';
import { DocumentsFilesToolResultSchema } from '../packages/agent-contracts/src/pm-tool-documents-files.ts';
import type { ChangeHistoryPage } from '../packages/contracts/src/change-history.ts';
import { createLocalProjectFixture, localProjectCaseTimeout } from './local-project-fixture.ts';
import { configureDocumentSource, configureDocumentSources, createDocumentProject, mutateDocumentSource, readSourceContent } from './document-sources-fixture.ts';

it('intersects delegated A-only scope with an A+B human for nested source list/read/write/history, while preserving explicit same-root sharing', { timeout: localProjectCaseTimeout }, async t => {
  const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
  const a = await createDocumentProject(f, 'Delegated readable project', 'delegated-a');
  const b = await createDocumentProject(f, 'Human-readable but not delegated', 'delegated-private-b');
  const privateName = basename(b.location.path!);
  const secret = '# DELEGATED_NESTED_B_SECRET\n';
  await writeFile(join(b.location.path!, 'secret.md'), secret);
  await writeFile(join(f.parents[0], 'public.md'), '# Shared parent body\n');
  const broad = await configureDocumentSource(f, a.record.id, f.parents[0], 0);
  await configureDocumentSource(f, b.record.id, b.location.path!, 0);
  // The unrestricted human really can read/write B through the existing broad
  // parent. Delegation, rather than native human membership, is the missing gate.
  const privatePath = `${privateName}/secret.md`;
  const before = await readSourceContent(f, broad.sourceId, privatePath);
  assert.equal(before.content, secret);
  const originalId = randomUUID();
  await mutateDocumentSource(f, broad.sourceId, { operationId: originalId, sourceRevision: broad.revision, action: 'create', path: `${privateName}/history.md`, content: secret });
  const historyTarget = { kind: 'external', sourceId: broad.sourceId, path: `${privateName}/history.md` } as const;
  const nativeHistory = await f.request<ChangeHistoryPage>(`/api/v1/workspaces/${f.workspaceId}/change-history/query`, { method: 'POST', body: { target: historyTarget, includeRelated: false, limit: 100 } });
  assert.equal(nativeHistory.status, 200); assert.ok(nativeHistory.body.items.length > 0);

  const base = `/api/v1/workspaces/${f.workspaceId}/agent-tools/call`;
  const identity = { target: { workspaceId: f.workspaceId, projectId: a.record.id }, threadId: randomUUID(), messageId: randomUUID(), generationId: randomUUID() };
  const call = (name: AgentChatToolName, args: unknown) => f.request<PmToolCallRecord>(base, { method: 'POST', body: { ...identity, operationId: randomUUID(), name, arguments: args } });
  const denied = async (name: AgentChatToolName, args: unknown) => {
    const response = await call(name, args);
    assert.ok(response.status !== 200 || response.body.status !== 'succeeded', `${name} must not cross the delegated descendant boundary`);
    assert.doesNotMatch(JSON.stringify(response.body), /DELEGATED_NESTED_B_SECRET/);
  };
  const listed = await call('pm_list_external_files', { sourceId: broad.sourceId, cursor: null, limit: 100 });
  assert.equal(listed.status, 200); assert.equal(listed.body.status, 'succeeded');
  const page = DocumentsFilesToolResultSchema.parse(listed.body.result);
  if (page.kind !== 'external-files') assert.fail('Expected a real external file page');
  assert.deepEqual(page.items.map(item => item.path), ['public.md']);
  assert.equal(page.scanComplete, false);
  assert.equal(JSON.stringify(page).includes(privateName), false, 'Neither entries nor scan issues disclose the excluded subtree name');
  await denied('pm_read_external_file', { sourceId: broad.sourceId, path: privatePath, expectedRevision: null, contentOffset: 0, contentLimit: 12000 });
  await denied('pm_create_external_file', { sourceId: broad.sourceId, sourceRevision: broad.revision, path: `${privateName}/forbidden.md`, content: '# Must never be written\n' });
  await assert.rejects(lstat(join(b.location.path!, 'forbidden.md')), { code: 'ENOENT' });
  await denied('pm_save_external_file', { sourceId: broad.sourceId, sourceRevision: broad.revision, path: privatePath, expectedRevision: before.revision, content: '# Must never replace B\n' });
  await denied('pm_delete_external_file', { sourceId: broad.sourceId, sourceRevision: broad.revision, path: privatePath, expectedRevision: before.revision });
  const publicFile = await readSourceContent(f, broad.sourceId, 'public.md');
  await denied('pm_move_external_file', { sourceId: broad.sourceId, sourceRevision: broad.revision, path: 'public.md', expectedRevision: publicFile.revision, targetSourceId: broad.sourceId, targetSourceRevision: broad.revision, targetPath: `${privateName}/moved.md` });
  assert.equal(await readFile(join(f.parents[0], 'public.md'), 'utf8'), '# Shared parent body\n');
  assert.equal(await readFile(join(b.location.path!, 'secret.md'), 'utf8'), secret);
  await assert.rejects(lstat(join(b.location.path!, 'moved.md')), { code: 'ENOENT' });
  await denied('pm_external_file_result', { sourceId: broad.sourceId, operationId: originalId });
  await denied('pm_read_change_history', { target: historyTarget, includeRelated: false, cursor: null, head: null, limit: 100 });
  await denied('pm_read_change_detail', { changeId: nativeHistory.body.items[0]!.changeId, offset: 0, limit: 12000 });

  // Sharing B's exact safe root explicitly with A is intentional native policy:
  // the exclusion applies only to descendants, not to a selected equal root.
  const explicit = await configureDocumentSources(f, a.record.id, [b.location.path!], 1);
  const shared = explicit.sources[0]!;
  const readable = await call('pm_read_external_file', { sourceId: shared.sourceId, path: 'secret.md', expectedRevision: null, contentOffset: 0, contentLimit: 12000 });
  assert.equal(readable.status, 200); assert.equal(readable.body.status, 'succeeded');
  const content = DocumentsFilesToolResultSchema.parse(readable.body.result);
  if (content.kind !== 'external-file') assert.fail('Expected explicitly shared source content');
  assert.equal(content.items[0]!.content, secret);
});
