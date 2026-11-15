import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { lstat, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { documentsFilesFamily } from '../packages/pm-cli/documents-files.ts';
import type { CliRuntime, PmRequestOptions, PmScope } from '../packages/pm-cli/runtime.ts';
import type { CommandReceipt } from '../packages/domain/src/core.ts';
import type { DocumentSourceConfigurationResponse, DocumentSourceMutationReceipt } from '../packages/contracts/src/document-sources.ts';
import { DocumentsFilesToolResultSchema } from '../packages/agent-contracts/src/pm-tool-documents-files.ts';
import type { PmToolCallRecord } from '../packages/agent-contracts/src/pm-tools.ts';
import { coreVersion } from '../apps/server/pm/src/core-adapter.ts';
import { createLocalProjectFixture, localProjectCaseTimeout, type LocalProjectFixture } from './local-project-fixture.ts';
import { configureDocumentSource, configureDocumentSources, createDocumentProject, readSourceContent } from './document-sources-fixture.ts';

const nativeEntity = z.object({ id: z.string(), version: z.number().int().positive(), data: z.object({ sha256: z.string().optional(), size: z.number().int().optional(), objectKey: z.string().optional() }).passthrough() }).passthrough();
const uploadCommandResult = z.object({ upload: nativeEntity });
const artifactCommandResult = z.object({ artifact: nativeEntity });
const publicationCommandResult = z.object({ artifact: nativeEntity, artifactVersion: nativeEntity });

function cli(f: LocalProjectFixture) {
  let printed: unknown;
  async function response(scope: PmScope, endpoint: string, options: PmRequestOptions = {}): Promise<Response> {
    const base = scope === 'service' ? '/api/v1' : `/api/v1/workspaces/${f.workspaceId}${scope === 'core' ? '/core' : ''}`;
    const result = await fetch(`${f.origin}${base}${endpoint}`, { method: options.method ?? 'GET', headers: { cookie: f.ownerCookie, ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), signal: f.signal });
    if (!result.ok) { const body = await result.json(); throw new Error(`HTTP ${result.status}: ${JSON.stringify(body)}`); }
    return result;
  }
  const runtime: CliRuntime = { authentication: async () => ({ origin: f.origin, headers: { cookie: f.ownerCookie } }), connection: async () => ({ origin: f.origin, workspaceId: f.workspaceId, headers: { cookie: f.ownerCookie } }), response, json: async <T>(scope: PmScope, endpoint: string, options?: PmRequestOptions) => await (await response(scope, endpoint, options)).json() as T, print(value) { printed = value; } };
  return async <T>(...args: string[]): Promise<T> => { printed = undefined; assert.equal(await documentsFilesFamily.dispatch(args, runtime), true); return printed as T; };
}

// Requires a disposable real TEST_DATABASE_URL through the established fixture. Never skips.
// CLI dispatch, real HTTP, application services, PostgreSQL, core and blob bytes are all exercised.
describe('native documents/files CLI and registered PM tools', { concurrency: 1 }, () => {
  it('keeps association/source/file revisions distinct and performs real create/save/rename/move/delete plus original-result recovery', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const run = cli(f), project = await createDocumentProject(f, 'CLI document source', 'cli-doc-project');
    const sourceRoot = join(f.parents[1], 'source'), targetRoot = join(f.parents[1], 'target');
    await mkdir(sourceRoot); await mkdir(targetRoot);
    await writeFile(join(sourceRoot, 'same.md'), 'source same name\n'); await writeFile(join(targetRoot, 'same.md'), 'target same name\n');
    const config = join(f.root, 'source.json');
    await writeFile(config, JSON.stringify({ projectId: project.record.id, expectedRevision: 0, paths: [sourceRoot, targetRoot] }));
    const configured = await run<DocumentSourceConfigurationResponse>('sources', 'configure', '--file', config);
    assert.equal(configured.scope.revision, 1); assert.equal(configured.sources.length, 2);
    const source = configured.sources.find(item => item.path === sourceRoot)!, target = configured.sources.find(item => item.path === targetRoot)!;
    const input = join(f.root, 'body.md'), text = '# Plain external UTF-8 文档\r\nNo PM entity metadata.\r\n'; await writeFile(input, text);
    const originalId = randomUUID();
    const created = await run<DocumentSourceMutationReceipt>('external-file', 'create', source.sourceId, '--path', 'new/文档.md', '--source-revision', String(source.revision), '--operation-id', originalId, '--file', input);
    assert.equal(created.status, 'succeeded'); assert.equal(await readFile(join(sourceRoot, 'new/文档.md'), 'utf8'), text);
    const original = await run<DocumentSourceMutationReceipt>('external-file', 'result', source.sourceId, '--operation-id', originalId);
    assert.deepEqual(original, created);
    await writeFile(input, '# Saved content\n');
    const saved = await run<DocumentSourceMutationReceipt>('external-file', 'save', source.sourceId, '--path', 'new/文档.md', '--source-revision', String(source.revision), '--revision', created.content!.revision, '--operation-id', randomUUID(), '--file', input);
    await assert.rejects(run('external-file', 'save', source.sourceId, '--path', 'new/文档.md', '--source-revision', String(source.revision), '--revision', created.content!.revision, '--operation-id', randomUUID(), '--file', input), /revision_conflict/);
    assert.equal(await readFile(join(sourceRoot, 'new/文档.md'), 'utf8'), '# Saved content\n');
    const renamed = await run<DocumentSourceMutationReceipt>('external-file', 'rename', source.sourceId, '--path', 'new/文档.md', '--target-path', 'renamed.md', '--source-revision', String(source.revision), '--revision', saved.content!.revision, '--operation-id', randomUUID());
    const moved = await run<DocumentSourceMutationReceipt>('external-file', 'move', source.sourceId, '--path', 'renamed.md', '--target-source', target.sourceId, '--target-source-revision', String(target.revision), '--target-path', 'moved.md', '--source-revision', String(source.revision), '--revision', renamed.content!.revision, '--operation-id', randomUUID());
    await assert.rejects(lstat(join(sourceRoot, 'renamed.md')), { code: 'ENOENT' });
    assert.equal(await readFile(join(targetRoot, 'moved.md'), 'utf8'), '# Saved content\n');
    const deleted = await run<DocumentSourceMutationReceipt>('external-file', 'delete', target.sourceId, '--path', 'moved.md', '--source-revision', String(target.revision), '--revision', moved.content!.revision, '--operation-id', randomUUID());
    assert.equal(deleted.status, 'succeeded'); await assert.rejects(lstat(join(targetRoot, 'moved.md')), { code: 'ENOENT' });
    const catalog = await run<{ sources: { sourceId: string; revision: number }[]; scopes: { revision: number }[] }>('sources', 'list');
    assert.equal(catalog.sources.find(item => item.sourceId === source.sourceId)!.revision, source.revision);
    await writeFile(config, JSON.stringify({ projectId: project.record.id, expectedRevision: 1, paths: [] }));
    await run('sources', 'configure', '--file', config);
    assert.equal(await readFile(join(sourceRoot, 'same.md'), 'utf8'), 'source same name\n');
    assert.equal(await readFile(join(targetRoot, 'same.md'), 'utf8'), 'target same name\n');
  });

  it('transfers real upload/version bytes, preserves immutable metadata through lifecycle/copy and rejects interrupted HTTP uploads', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const run = cli(f), project = await createDocumentProject(f, 'CLI bytes', 'cli-bytes'), destination = await createDocumentProject(f, 'CLI copy', 'cli-copy');
    const bytes = Buffer.from([0, 255, 42, 13, 10, 1]), input = join(f.root, 'input.bin'); await writeFile(input, bytes);
    const stageId = randomUUID();
    const stage = await run<CommandReceipt>('upload', 'stage', '--project', project.record.id, '--file', input, '--media-type', 'application/octet-stream', '--request-id', stageId);
    const upload = uploadCommandResult.parse(stage.result).upload;
    assert.equal(upload.data.sha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(upload.data.size, bytes.length);
    assert.deepEqual(await run('upload', 'result', '--request-id', stageId), stage);
    const registered = await run<CommandReceipt>('artifact', 'register', '--project', project.record.id, '--upload', upload.id, '--upload-version', String(upload.version), '--title', 'Display name', '--kind', 'document', '--request-id', randomUUID());
    const initial = publicationCommandResult.parse(registered.result);
    const output = join(f.root, 'download.bin'); await run('artifact', 'download', initial.artifactVersion.id, '--output', output);
    assert.deepEqual(await readFile(output), bytes);
    await assert.rejects(run('artifact', 'download', initial.artifactVersion.id, '--output', output), /EEXIST/);
    let artifact = initial.artifact;
    for (const action of ['rename', 'hide', 'restore'] as const) {
      const receipt = await run<CommandReceipt>('artifact', action, artifact.id, '--project', project.record.id, '--version', String(artifact.version), '--request-id', randomUUID(), ...(action === 'rename' ? ['--title', 'New display title'] : []));
      artifact = artifactCommandResult.parse(receipt.result).artifact;
    }
    assert.deepEqual(await run('artifact', 'version', initial.artifactVersion.id), initial.artifactVersion);
    await writeFile(input, Buffer.from('newer bytes'));
    const nextStage = await run<CommandReceipt>('upload', 'stage', '--project', project.record.id, '--file', input, '--media-type', 'text/plain', '--request-id', randomUUID());
    const nextUpload = uploadCommandResult.parse(nextStage.result).upload;
    const added = await run<CommandReceipt>('artifact', 'add-version', artifact.id, '--project', project.record.id, '--version', String(artifact.version), '--upload', nextUpload.id, '--upload-version', String(nextUpload.version), '--request-id', randomUUID());
    artifact = artifactCommandResult.parse(added.result).artifact;
    const copied = await run<CommandReceipt>('artifact', 'copy', initial.artifactVersion.id, '--project', destination.record.id, '--project-version', String(coreVersion(destination.record.revision)), '--source-artifact', artifact.id, '--source-artifact-version', String(artifact.version), '--source-version', String(initial.artifactVersion.version), '--title', 'Independent old version', '--kind', 'document', '--request-id', randomUUID());
    const copy = publicationCommandResult.parse(copied.result);
    assert.notEqual(copy.artifactVersion.data.objectKey, initial.artifactVersion.data.objectKey);
    const copiedOutput = join(f.root, 'copied.bin'); await run('artifact', 'download', copy.artifactVersion.id, '--output', copiedOutput);
    assert.deepEqual(await readFile(copiedOutput), bytes);
    const interruptedId = randomUUID(), url = new URL(f.origin);
    const partialBody = JSON.stringify({ commandId: interruptedId, commandType: 'StageUpload', projectId: project.record.id, payload: { contentBase64: Buffer.alloc(1024, 3).toString('base64'), fileName: 'interrupted.bin', mediaType: 'application/octet-stream' } });
    const closed = Promise.withResolvers<void>();
    const socket = connect(Number(url.port), url.hostname);
    // Real socket inactivity is bounded, not an artificial wait for application effects.
    socket.setTimeout(5000, () => socket.destroy(new Error('Interrupted-upload socket did not close')));
    socket.once('error', closed.reject); socket.on('data', () => undefined); socket.once('close', () => closed.resolve());
    socket.once('connect', () => socket.end(`POST /api/v1/workspaces/${f.workspaceId}/commands HTTP/1.1\r\nHost: ${url.host}\r\nCookie: ${f.ownerCookie}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(partialBody) + 100}\r\nConnection: close\r\n\r\n${partialBody.slice(0, 100)}`));
    try { await closed.promise; } finally { socket.destroy(); }
    assert.equal((await f.pool.query('SELECT count(*)::int AS count FROM command_receipts WHERE command_id=$1', [interruptedId])).rows[0].count, 0);
    assert.equal((await f.pool.query("SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1 AND kind='upload' AND data->>'fileName'='interrupted.bin'", [f.workspaceId])).rows[0].count, 0);
    const forbidden = await f.member('No artifact access');
    const denied = await fetch(`${f.origin}/api/v1/workspaces/${f.workspaceId}/artifact-versions/${initial.artifactVersion.id}/content`, { headers: { cookie: forbidden.cookie }, signal: f.signal });
    try { assert.ok([403, 404].includes(denied.status)); } finally { await denied.body?.cancel(); }
  });

  it('runs registered direct PM file services, withholds historical bodies after unlink/root replacement, and returns artifact references without storage paths or bytes', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const project = await createDocumentProject(f, 'Model file references', 'model-files');
    const root = join(f.parents[1], 'model-source'); await mkdir(root);
    const source = await configureDocumentSource(f, project.record.id, root, 0);
    const base = `/api/v1/workspaces/${f.workspaceId}/agent-tools`;
    const identity = { target: { workspaceId: f.workspaceId, projectId: project.record.id }, threadId: randomUUID(), messageId: randomUUID(), generationId: randomUUID() };
    const request = { ...identity, operationId: randomUUID(), name: 'pm_create_external_file', arguments: { sourceId: source.sourceId, sourceRevision: source.revision, path: 'model.md', content: '# Model-authored external bytes\n' } };
    const response = await f.request<PmToolCallRecord>(`${base}/call`, { method: 'POST', body: request });
    assert.equal(response.status, 200, JSON.stringify(response.body)); assert.equal(response.body.status, 'succeeded');
    const result = DocumentsFilesToolResultSchema.parse(response.body.result);
    assert.equal(result.kind, 'external-file-operation'); assert.equal(await readFile(join(root, 'model.md'), 'utf8'), request.arguments.content);
    const before = (await readSourceContent(f, source.sourceId, 'model.md')).revision;
    const recovered = await f.request<PmToolCallRecord>(`${base}/result`, { method: 'POST', body: request });
    assert.equal(recovered.body.status, 'succeeded'); assert.equal((await readSourceContent(f, source.sourceId, 'model.md')).revision, before);
    const native = cli(f), input = join(f.root, 'tool-upload.bin'); await writeFile(input, Buffer.from('tool artifact bytes'));
    const stage = await native<CommandReceipt>('upload', 'stage', '--project', project.record.id, '--file', input, '--media-type', 'application/octet-stream', '--request-id', randomUUID());
    const upload = uploadCommandResult.parse(stage.result).upload;
    const publish = await f.request<PmToolCallRecord>(`${base}/call`, { method: 'POST', body: { ...identity, operationId: randomUUID(), name: 'pm_register_artifact', arguments: { projectId: project.record.id, uploadId: upload.id, uploadVersion: upload.version, title: 'Model reference', artifactKind: 'document' } } });
    assert.equal(publish.body.status, 'succeeded', JSON.stringify(publish.body));
    const metadata = DocumentsFilesToolResultSchema.parse(publish.body.result);
    assert.equal(metadata.kind, 'artifact-mutation'); assert.doesNotMatch(JSON.stringify(metadata), /objectKey|storageId|contentBase64|tool artifact bytes/);
    if (metadata.kind !== 'artifact-mutation') assert.fail('Expected real immutable publication');
    assert.equal(metadata.versions[0]!.sha256, createHash('sha256').update('tool artifact bytes').digest('hex'));
    await configureDocumentSources(f, project.record.id, [], 1);
    const withheld = await f.request<PmToolCallRecord>(`${base}/result`, { method: 'POST', body: request });
    assert.equal(JSON.stringify(withheld.body).includes('Model-authored external bytes'), false);
    assert.equal(await readFile(join(root, 'model.md'), 'utf8'), request.arguments.content);
    const fresh = await configureDocumentSource(f, project.record.id, root, 2);
    await rename(root, `${root}-old`); await mkdir(root); await writeFile(join(root, 'model.md'), 'replacement root bytes');
    const unsafeRead = await f.request(`${base}/call`, { method: 'POST', body: { ...identity, operationId: randomUUID(), name: 'pm_read_external_file', arguments: { sourceId: fresh.sourceId, path: 'model.md', expectedRevision: null, contentOffset: 0, contentLimit: 12000 } } });
    assert.equal(JSON.stringify(unsafeRead.body).includes('replacement root bytes'), false);
    await symlink(join(root, 'model.md'), join(root, 'linked.md'));
    const unsafePath = await f.request(`${base}/call`, { method: 'POST', body: { ...identity, operationId: randomUUID(), name: 'pm_read_external_file', arguments: { sourceId: fresh.sourceId, path: '../model.md', expectedRevision: null, contentOffset: 0, contentLimit: 12000 } } });
    assert.equal(JSON.stringify(unsafePath.body).includes('replacement root bytes'), false);
  });
});
