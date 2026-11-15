import { constants } from 'node:fs';
import { open, lstat, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { documentSourceConfigurationInputSchema, documentSourceMutationSchema, documentSourceIdSchema } from '../contracts/src/document-sources.ts';
import type { DocumentSourceMutation } from '../contracts/src/document-sources.ts';
import type { Command, CommandReceipt, Entity } from '../domain/src/core.ts';
import { inputFile, nonempty, parseOptions, textFile, type CliFamily, type CliRuntime } from './runtime.ts';

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const uuid = (value: string | undefined, name: string): string => z.uuid().toLowerCase().parse(nonempty(value, name));
const project = (value: string | undefined): string => z.string().regex(/^PRJ-\d+$/).parse(nonempty(value, '--project'));
const positive = (value: string | undefined, name: string): number => {
  const text = nonempty(value, name);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error(`${name} requires a positive integer`);
  return Number(text);
};
const source = (value: string | undefined): string => documentSourceIdSchema.parse(nonempty(value, 'source ID'));
const query = (values: Record<string, string | undefined>): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, value);
  return params.size ? `?${params}` : '';
};

/** Bound actual reads as well as stat: a growing or special input cannot allocate without limit. */
export async function readUploadBytes(filename: string): Promise<Buffer> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1) throw new Error('Upload input must be a regular local file without hard links');
    if (before.size > MAX_UPLOAD_BYTES) throw new Error('Upload exceeds 8 MiB');
    const bytes = Buffer.alloc(Math.min(before.size + 1, MAX_UPLOAD_BYTES + 1));
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat();
    if (length > MAX_UPLOAD_BYTES || before.size !== length || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Upload input changed during the bounded read');
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

/** Explicit destination only. Never derive a host path from server filenames or overwrite a file/link. */
export async function saveArtifactDownload(response: Response, filename: string, expected: { sha256: string; size: number }): Promise<{ path: string; size: number; sha256: string }> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let file: FileHandle | undefined;
  let identity: { dev: number; ino: number } | undefined;
  let complete = false;
  const destination = resolve(filename);
  try {
    if (!Number.isSafeInteger(expected.size) || expected.size < 0 || expected.size > MAX_UPLOAD_BYTES || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw new Error('Invalid immutable artifact metadata');
    const parent = dirname(destination);
    if (await realpath(parent) !== parent) throw new Error('Download destination ancestors must not be symbolic links');
    file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const stat = await file.stat(); identity = { dev: stat.dev, ino: stat.ino };
    if (!response.body) throw new Error('Download response has no byte stream');
    reader = response.body.getReader();
    let size = 0;
    const hash = createHash('sha256');
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > expected.size || size > MAX_UPLOAD_BYTES) throw new Error('Download exceeds the immutable version size');
      hash.update(chunk.value);
      let offset = 0;
      while (offset < chunk.value.byteLength) {
        const result = await file.write(chunk.value, offset, chunk.value.byteLength - offset, null);
        if (!result.bytesWritten) throw new Error('Download output stopped accepting bytes');
        offset += result.bytesWritten;
      }
    }
    const sha256 = hash.digest('hex');
    if (size !== expected.size || sha256 !== expected.sha256) throw new Error('Downloaded bytes do not match the immutable version hash and size');
    await file.sync();
    const current = await lstat(destination);
    if (current.dev !== identity.dev || current.ino !== identity.ino || !current.isFile() || current.nlink !== 1) throw new Error('Download output was replaced while writing');
    complete = true;
    return { path: destination, size, sha256 };
  } finally {
    if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    else await response.body?.cancel().catch(() => undefined);
    await file?.close();
    if (!complete && identity) {
      const current = await lstat(destination).catch(() => null);
      if (current?.dev === identity.dev && current.ino === identity.ino) await unlink(destination);
    }
  }
}

async function command(runtime: CliRuntime, request: Command): Promise<void> {
  // An explicit original ID is printed by the caller's request, never generated again after ambiguity.
  const result = await runtime.json<CommandReceipt>('workspace', '/commands', { method: 'POST', body: request });
  runtime.print(result);
}
const help = `  sources list
  sources directories [--project PRJ-N] [--path SERVER_DIRECTORY]
  sources configure --file JSON_OR_YAML  (projectId, expectedRevision, paths; [] unlinks only)
  external-file list SOURCE [--cursor CURSOR] [--limit 1..1000]
  external-file read SOURCE --path RELATIVE_MD [--output NEW_LOCAL_FILE]
  external-file create|save SOURCE --path RELATIVE_MD --source-revision N --operation-id UUID --file UTF8_MD [--revision FILE_REVISION for save]
  external-file rename SOURCE --path RELATIVE_MD --target-path RELATIVE_MD --source-revision N --revision FILE_REVISION --operation-id UUID
  external-file move SOURCE --path RELATIVE_MD --target-source SOURCE --target-source-revision N --target-path RELATIVE_MD --source-revision N --revision FILE_REVISION --operation-id UUID
  external-file delete SOURCE --path RELATIVE_MD --source-revision N --revision FILE_REVISION --operation-id UUID
  external-file result SOURCE --operation-id ORIGINAL_UUID
  upload stage --project PRJ-N --file LOCAL_FILE --media-type TYPE --request-id UUID [--name DISPLAY_FILENAME]
  upload list --project PRJ-N [--after CURSOR] [--limit 1..100]
  upload read UUID | upload result --request-id ORIGINAL_UUID
  artifact list|versions --project PRJ-N [--visibility visible|hidden|all] [--after CURSOR] [--limit 1..100]
  artifact read|version|copy-origin UUID
  artifact download VERSION_UUID --output NEW_LOCAL_FILE
  artifact register --project PRJ-N --upload UUID --upload-version N --title TEXT --kind KIND --request-id UUID
  artifact add-version UUID --project PRJ-N --version N --upload UUID --upload-version N --request-id UUID
  artifact rename|hide|restore UUID --project PRJ-N --version N --request-id UUID [--title TEXT for rename]
  artifact copy VERSION_UUID --project DEST_PRJ --project-version N --source-artifact UUID --source-artifact-version N --source-version N --title TEXT --kind KIND --request-id UUID
  artifact result --request-id ORIGINAL_UUID`;

export const documentsFilesFamily: CliFamily = {
  help,
  async dispatch(args, runtime) {
    const [family, action, id, ...rest] = args;
    if (!['sources', 'external-file', 'artifact', 'upload'].includes(family ?? '')) return false;
    const usage = (): never => { throw new Error(`Unsupported ${family} command.\n${help}`); };
    if (family === 'sources') {
      const opts = parseOptions(args.slice(2), action === 'list' ? [] : action === 'directories' ? ['project', 'path'] : action === 'configure' ? ['file'] : usage());
      if (action === 'list') runtime.print(await runtime.json('workspace', '/document-sources'));
      else if (action === 'directories') runtime.print(await runtime.json('workspace', `/document-sources/directories${query({ projectId: opts.project === undefined ? undefined : project(opts.project), path: opts.path })}`));
      else runtime.print(await runtime.json('workspace', '/document-sources/configuration', { method: 'PUT', body: documentSourceConfigurationInputSchema.parse(await inputFile(opts.file)) }));
      return true;
    }
    if (family === 'external-file') {
      const sourceId = source(id), base = `/document-sources/${encodeURIComponent(sourceId)}`;
      if (action === 'list') {
        const opts = parseOptions(rest, ['cursor', 'limit']);
        if (opts.limit && positive(opts.limit, '--limit') > 1000) throw new Error('--limit must be at most 1000');
        runtime.print(await runtime.json('workspace', `${base}/files${query({ cursor: opts.cursor, limit: opts.limit })}`));
      } else if (action === 'read') {
        const opts = parseOptions(rest, ['path', 'output']);
        const content = await runtime.json<{ content: string; revision: string }>('workspace', `${base}/content${query({ path: nonempty(opts.path, '--path') })}`);
        if (opts.output) {
          const bytes = Buffer.from(content.content, 'utf8');
          const saved = await saveArtifactDownload(new Response(bytes), opts.output, { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
          runtime.print({ ...saved, revision: content.revision });
        } else runtime.print(content);
      } else if (action === 'result') {
        const opts = parseOptions(rest, ['operation-id']);
        runtime.print(await runtime.json('workspace', `${base}/operations/${uuid(opts['operation-id'], '--operation-id')}`));
      } else if (['create', 'save', 'rename', 'move', 'delete'].includes(action ?? '')) {
        const opts = parseOptions(rest, ['path', 'source-revision', 'operation-id', ...(['create', 'save'].includes(action!) ? ['file'] : []), ...(action === 'create' ? [] : ['revision']), ...(['rename', 'move'].includes(action!) ? ['target-path'] : []), ...(action === 'move' ? ['target-source', 'target-source-revision'] : [])]);
        const baseInput = { operationId: uuid(opts['operation-id'], '--operation-id'), sourceRevision: positive(opts['source-revision'], '--source-revision'), path: nonempty(opts.path, '--path') };
        const input: DocumentSourceMutation = documentSourceMutationSchema.parse(action === 'create' || action === 'save'
          ? { ...baseInput, action, ...(action === 'save' ? { expectedRevision: nonempty(opts.revision, '--revision') } : {}), content: await textFile(opts.file, 4 * 1024 * 1024) }
          : action === 'delete' ? { ...baseInput, action, expectedRevision: nonempty(opts.revision, '--revision') }
            : { ...baseInput, action: 'move', expectedRevision: nonempty(opts.revision, '--revision'), targetPath: nonempty(opts['target-path'], '--target-path'), targetSourceId: action === 'rename' ? sourceId : source(opts['target-source']), targetSourceRevision: action === 'rename' ? baseInput.sourceRevision : positive(opts['target-source-revision'], '--target-source-revision') });
        runtime.print(await runtime.json('workspace', `${base}/operations`, { method: 'POST', body: input }));
      } else usage();
      return true;
    }
    if (action === 'result') {
      const opts = parseOptions(args.slice(2), ['request-id']);
      runtime.print(await runtime.json('workspace', `/commands/${uuid(opts['request-id'], '--request-id')}`));
      return true;
    }
    if (action === 'list' || family === 'artifact' && action === 'versions') {
      const opts = parseOptions(args.slice(2), ['project', 'after', 'limit', ...(family === 'artifact' ? ['visibility'] : [])]);
      if (opts.limit && positive(opts.limit, '--limit') > 100) throw new Error('--limit must be at most 100');
      if (opts.visibility) z.enum(['visible', 'hidden', 'all']).parse(opts.visibility);
      runtime.print(await runtime.json('workspace', `/entities${query({ kind: family === 'upload' ? 'upload' : action === 'versions' ? 'artifact_version' : 'artifact', projectId: project(opts.project), after: opts.after, limit: opts.limit, visibility: opts.visibility })}`));
      return true;
    }
    if (action === 'read' || family === 'artifact' && ['version', 'copy-origin', 'download'].includes(action ?? '')) {
      const entityId = uuid(id, 'resource ID'), opts = parseOptions(rest, action === 'download' ? ['output'] : []);
      if (action === 'copy-origin') runtime.print(await runtime.json('workspace', `/artifact-versions/${entityId}/copy-origin`));
      else {
        const item = await runtime.json<Entity>('workspace', `/entities/${entityId}`);
        const expectedKind = family === 'upload' ? 'upload' : action === 'read' ? 'artifact' : 'artifact_version';
        if (item.kind !== expectedKind) throw new Error(`Expected ${expectedKind}`);
        if (action === 'download') {
          const filename = nonempty(opts.output, '--output');
          const response = await runtime.response('workspace', `/artifact-versions/${entityId}/content`);
          runtime.print({ versionId: entityId, ...await saveArtifactDownload(response, filename, { size: item.data.size, sha256: item.data.sha256 }) });
        } else runtime.print(item);
      }
      return true;
    }
    if (family === 'upload' && action === 'stage') {
      const opts = parseOptions(args.slice(2), ['project', 'file', 'media-type', 'request-id', 'name']);
      const requestId = uuid(opts['request-id'], '--request-id'), projectId = project(opts.project), filename = nonempty(opts.file, '--file');
      const fileName = opts.name ?? basename(filename), mediaType = nonempty(opts['media-type'], '--media-type');
      if (!fileName || fileName.length > 255 || fileName !== fileName.trim() || /[\u0000-\u001f\u007f/\\]/u.test(fileName) || ['.', '..'].includes(fileName)) throw new Error('Unsafe upload filename');
      z.string().max(127).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/).parse(mediaType);
      const bytes = await readUploadBytes(filename);
      await command(runtime, { commandId: requestId, commandType: 'StageUpload', projectId, payload: { contentBase64: bytes.toString('base64'), fileName, mediaType } });
      return true;
    }
    if (family !== 'artifact' || !['register', 'add-version', 'rename', 'hide', 'restore', 'copy'].includes(action ?? '')) usage();
    const hasId = action !== 'register';
    const opts = parseOptions(hasId ? rest : args.slice(2), ['project', 'request-id', ...(action === 'register' ? ['upload', 'upload-version', 'title', 'kind'] : action === 'add-version' ? ['version', 'upload', 'upload-version'] : action === 'copy' ? ['project-version', 'source-artifact', 'source-artifact-version', 'source-version', 'title', 'kind'] : ['version', ...(action === 'rename' ? ['title'] : [])])]);
    const targetId = hasId ? uuid(id, 'resource ID') : undefined;
    const request: Command = { commandId: uuid(opts['request-id'], '--request-id'), projectId: project(opts.project), commandType: action === 'register' ? 'RegisterArtifact' : action === 'add-version' ? 'AddArtifactVersion' : action === 'rename' ? 'RenameArtifact' : action === 'hide' ? 'HideArtifact' : action === 'restore' ? 'RestoreArtifact' : 'CopyArtifactVersion', payload: {}, ...(targetId ? { targetId } : {}), expectedVersions: {} };
    if (action === 'register' || action === 'add-version') {
      const uploadId = uuid(opts.upload, '--upload'); request.expectedVersions![uploadId] = positive(opts['upload-version'], '--upload-version'); request.payload.uploadId = uploadId;
      if (action === 'register') { request.payload.title = nonempty(opts.title, '--title'); request.payload.kind = nonempty(opts.kind, '--kind'); }
      else request.expectedVersions![targetId!] = positive(opts.version, '--version');
    } else if (action === 'copy') {
      request.expectedVersions![uuid(opts['source-artifact'], '--source-artifact')] = positive(opts['source-artifact-version'], '--source-artifact-version');
      request.expectedVersions![targetId!] = positive(opts['source-version'], '--source-version');
      request.expectedVersions![request.projectId!] = positive(opts['project-version'], '--project-version');
      request.payload = { targetTitle: nonempty(opts.title, '--title'), targetKind: nonempty(opts.kind, '--kind') };
    } else {
      request.expectedVersions![targetId!] = positive(opts.version, '--version');
      if (action === 'rename') request.payload.title = nonempty(opts.title, '--title');
    }
    await command(runtime, request);
    return true;
  },
};
