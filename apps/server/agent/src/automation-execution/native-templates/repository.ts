import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import type { StudioExecutionRequest } from '../../../../../../packages/contracts/src/automation-studio.ts';
import { sameExecutionIdentity, type AgentExecutionSnapshot } from '../../durable/agent-execution.ts';
import type { ChatGeneration } from '../../durable/chat-runtime.ts';
import { listRecords, readRecord, transaction, writeRecord } from '../../durable/store.ts';
import { automationRequestFingerprint } from '../context.ts';
import type { NativeRepository, NativeRepositoryChange, NativeTemplateContext } from './ports.ts';
import { nativeHash } from './state.ts';
import { DurableError } from '../../durable/errors.ts';
import { chatOnlyExecutionSelection, executionSelectionSchema, type ExecutionEnvironment } from '@agent-workspace/contracts/chat';

const namespace = 'pm-automation:native-repositories';
export type NativeRepositoryBinding = {
  threadId: string; idempotencyKey: string; request: StudioExecutionRequest; fingerprint: string;
  executionVersion: 2; authorizationEnvironment: ExecutionEnvironment;
  authorizationPath: string; executionPath: string; repository: NativeRepository | null;
  executionDirectoryIdentity?: string;
  commit: string | null; phase: 'preparing' | 'ready'; files: number; bytes: number;
};
type BaseFile = { sha256: string; executable: boolean; ignoreRules?: string };
const bindingKey = (threadId: string, idempotencyKey: string) => JSON.stringify([threadId, idempotencyKey]);
export function nativeTemplateRepositoryBinding(generation: ChatGeneration): NativeRepositoryBinding | null {
  const key = generation.request.idempotencyKey;
  return key ? readRecord<NativeRepositoryBinding>(namespace, bindingKey(generation.threadId, key)) : null;
}
export function validateNativeRepositoryPath(value: string): string[] {
  const parts = value.split('/');
  if (value.length > 1000 || parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[\u0000-\u001f\\:]/.test(part))) throw new Error('Remote repository contains an unsafe file path.');
  return parts;
}
async function privateDirectory(root: string, components: string[]): Promise<string> {
  let directory = root;
  for (const part of components) {
    directory = path.join(directory, part);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error; }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Native repository directory is not a canonical non-symlink directory.');
    await chmod(directory, 0o700);
  }
  return directory;
}
function originalRuntime(binding: NativeRepositoryBinding, inspect = false): void {
  const execution = readRecord<{ request: StudioExecutionRequest; fingerprint: string; phase: string }>('pm-automation:executions', binding.request.executionId);
  const registration = readRecord<{ executionId: string; fingerprint: string }>('pm-automation:native-thread-bindings', bindingKey(binding.threadId, binding.idempotencyKey));
  if (!execution || !inspect && execution.phase === 'finished' || execution.fingerprint !== binding.fingerprint || automationRequestFingerprint(execution.request) !== binding.fingerprint || automationRequestFingerprint(binding.request) !== binding.fingerprint || registration?.executionId !== binding.request.executionId || registration.fingerprint !== binding.fingerprint) throw new Error('Native repository binding is not owned by its original automation execution.');
}
async function validateBinding(binding: NativeRepositoryBinding, authorized: AgentExecutionSnapshot, inspect = false): Promise<void> {
  originalRuntime(binding, inspect);
  const selection = executionSelectionSchema.safeParse(binding.request.config.action.executionSelection ?? chatOnlyExecutionSelection());
  const relative = path.relative(authorized.path, binding.executionPath);
  if (binding.executionVersion !== 2 || !selection.success || selection.data.agentWorkspaceId !== authorized.environment.agentWorkspaceId ||
      selection.data.agentWorkspaceRevision !== authorized.environment.agentWorkspaceRevision || !sameExecutionIdentity(binding.authorizationEnvironment, authorized.environment) ||
      binding.phase !== 'ready' || authorized.path !== binding.authorizationPath || !relative || relative.startsWith('..') || path.isAbsolute(relative) ||
      relative !== path.join('.pm-automations', 'native-repositories', nativeHash([binding.threadId, binding.idempotencyKey])))
    throw new Error('Native repository no longer belongs to its explicitly selected Agent directory.');
  let current = authorized.path;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o7077 || await realpath(current) !== current) throw new Error('Native repository private path was replaced, exposed or escaped its authorized project.');
  }
  const info = await lstat(binding.executionPath, { bigint: true });
  if (binding.executionDirectoryIdentity !== `${info.dev}:${info.ino}`) throw new Error('Native repository directory identity changed; no replacement is accepted.');
}
export async function resolveSessionNativeTemplateSnapshot(threadId: string, authorized: AgentExecutionSnapshot, purpose: 'execute' | 'inspect'): Promise<AgentExecutionSnapshot> {
  const bindings = listRecords<NativeRepositoryBinding>(namespace).filter(value => value.threadId === threadId);
  if (!bindings.length) return authorized;
  if (bindings.length !== 1) throw new DurableError(409, 'native_repository_binding_changed', 'Session has ambiguous native repository ownership.');
  const binding = bindings[0]!;
  await validateBinding(binding, authorized, purpose === 'inspect');
  const environment = authorized.environment;
  if (!environment) throw new DurableError(412, 'execution_environment_required', 'Native repository requires a versioned environment.');
  return { ...authorized, path: binding.executionPath, environment: { ...environment,
    executionPath: environment.agentWorkspaceId ? binding.executionPath : null, worktree: null } };
}
/** Both ordinary and native Chat retain their exact independent execution identity. */
export async function assertNativeTemplateChatSnapshot(generation: ChatGeneration, authorized: AgentExecutionSnapshot): Promise<void> {
  const snapshot = generation.executionSnapshot;
  if (!snapshot || snapshot.environment.version !== 2 || snapshot.path !== authorized.path || !sameExecutionIdentity(snapshot.environment, authorized.environment))
    throw new DurableError(409, 'execution_environment_changed', 'Native Chat actual execution filesystem changed.');
}

export async function prepareNativeRepository(input: {
  request: StudioExecutionRequest; threadId: string; idempotencyKey: string;
  authorized: AgentExecutionSnapshot; repository?: NativeRepository;
  requestJson: NativeTemplateContext['requestJson']; signal: AbortSignal;
}): Promise<NativeRepositoryBinding> {
  const { request, threadId, idempotencyKey, authorized, repository, requestJson, signal } = input;
  if (repository && !authorized.environment.agentWorkspaceId)
    throw new DurableError(412, 'agent_workspace_required', 'A repository automation requires an explicitly selected Agent Workspace; chat-only scratch is not a code directory.');
  const key = bindingKey(threadId, idempotencyKey), fingerprint = automationRequestFingerprint(request);
  const previous = readRecord<NativeRepositoryBinding>(namespace, key);
  if (previous) {
    if (previous.fingerprint !== fingerprint || nativeHash(previous.repository) !== nativeHash(repository ?? null)) throw new Error('Native repository identity already belongs to another immutable request.');
    if (previous.phase !== 'ready') throw new Error('Native repository preparation was interrupted; it is never silently replayed.');
    await validateBinding(previous, authorized);
    return previous;
  }
  for (const reference of request.config.action.repositories) {
    if (reference.id !== `project:${request.projectId}` || reference.ref !== null) throw new Error('Native templates accept only the immutable PM project reference. Local execution is selected separately by Agent Workspace; remote repository picker values are separate identifiers.');
  }
  if (repository && (repository.provider !== 'github' && repository.provider !== 'gitlab' || !repository.repository || repository.repository.length > 500 || repository.repository.split('/').some(part => !part || part === '.' || part === '..') || /[\u0000-\u0020\\?#]/.test(repository.repository))) throw new Error('Invalid scoped remote repository identity.');
  if (repository) {
    const action = request.config.action;
    if (action.kind !== 'template') throw new Error('Only native template actions may materialize scoped remote repositories.');
    const selected = action.arguments[repository.provider === 'github' ? 'repositories' : 'projects'];
    if (!Array.isArray(selected) || !selected.some(value => typeof value === 'string' && (repository.provider === 'github' ? value.toLowerCase() === repository.repository.toLowerCase() : value === repository.repository))) throw new Error('The native repository was not selected in this immutable source-form configuration.');
  }
  const directory = await privateDirectory(authorized.path, ['.pm-automations', 'native-repositories', nativeHash([threadId, idempotencyKey])]);
  const binding: NativeRepositoryBinding = { threadId, idempotencyKey, request, fingerprint, executionVersion: 2, authorizationEnvironment: authorized.environment, authorizationPath: authorized.path, executionPath: directory, repository: repository ?? null, commit: null, phase: 'preparing', files: 0, bytes: 0 };
  const directoryInfo = await lstat(directory, { bigint: true });
  binding.executionDirectoryIdentity = `${directoryInfo.dev}:${directoryInfo.ino}`;
  transaction(() => {
    if (readRecord(namespace, key)) throw new Error('Native repository preparation was concurrently admitted.');
    writeRecord(namespace, key, binding);
  });
  const baseFiles: Record<string, BaseFile> = Object.create(null) as Record<string, BaseFile>;
  const saveFile = async (filename: string, bytes: Buffer, executable: boolean) => {
    signal.throwIfAborted();
    const components = validateNativeRepositoryPath(filename);
    binding.files += 1; binding.bytes += bytes.length;
    if (binding.files > 5000 || bytes.length > 2 * 1024 * 1024 || binding.bytes > 64 * 1024 * 1024) throw new Error('Native repository snapshot exceeds 5,000 files, 2 MiB per file or 64 MiB total; no partial repository is sent to the model.');
    const parent = await privateDirectory(directory, components.slice(0, -1));
    const target = path.join(parent, components.at(-1)!);
    await writeFile(target, bytes, { flag: 'wx', mode: executable ? 0o700 : 0o600 });
    baseFiles[filename] = { sha256: createHash('sha256').update(bytes).digest('hex'), executable };
    if (components.at(-1) === '.gitignore') baseFiles[filename]!.ignoreRules = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!repository?.write) await chmod(target, executable ? 0o500 : 0o400);
  };
  if (repository?.provider === 'github') {
    const base = `/repos/${repository.repository.split('/').map(encodeURIComponent).join('/')}`;
    const commit = await requestJson<{ sha: string; commit: { tree: { sha: string } } }>('github', `${base}/commits/${encodeURIComponent(repository.ref ?? 'HEAD')}`);
    if (!/^[a-f0-9]{40}$/i.test(commit.sha) || !/^[a-f0-9]{40}$/i.test(commit.commit?.tree?.sha ?? '')) throw new Error('GitHub returned an invalid pinned commit.');
    if (repository.ref && /^[a-f0-9]{40}$/i.test(repository.ref) && commit.sha.toLowerCase() !== repository.ref.toLowerCase()) throw new Error('GitHub returned a different commit than the requested immutable source head.');
    binding.commit = commit.sha;
    const tree = await requestJson<{ truncated: boolean; tree: Array<{ path: string; type: string; mode: string; sha: string; size?: number }> }>('github', `${base}/git/trees/${commit.commit.tree.sha}?recursive=1`);
    if (tree.truncated || !Array.isArray(tree.tree) || tree.tree.length > 10000) throw new Error('GitHub repository tree was truncated or exceeds the bounded snapshot.');
    for (const entry of tree.tree) {
      signal.throwIfAborted();
      validateNativeRepositoryPath(entry.path);
      if (entry.type === 'tree') continue;
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || !/^[a-f0-9]{40}$/i.test(entry.sha) || (entry.size ?? 0) > 2 * 1024 * 1024) throw new Error('Repository contains an unsupported symlink, submodule or oversized blob; it was not partially exposed.');
      const blob = await requestJson<{ content: string; encoding: string; size: number }>('github', `${base}/git/blobs/${entry.sha}`);
      if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error('GitHub blob encoding is invalid.');
      const bytes = Buffer.from(blob.content.replace(/\s/g, ''), 'base64');
      if (bytes.length !== blob.size || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.sha) throw new Error('GitHub repository blob did not match its pinned object identity.');
      await saveFile(entry.path, bytes, entry.mode === '100755');
    }
  } else if (repository?.provider === 'gitlab') {
    const base = `/projects/${encodeURIComponent(repository.repository)}`;
    const commit = await requestJson<{ id: string }>('gitlab', `${base}/repository/commits/${encodeURIComponent(repository.ref ?? 'HEAD')}`);
    if (!/^[a-f0-9]{40,64}$/i.test(commit.id)) throw new Error('GitLab returned an invalid pinned commit.');
    if (repository.ref && /^[a-f0-9]{40,64}$/i.test(repository.ref) && commit.id.toLowerCase() !== repository.ref.toLowerCase()) throw new Error('GitLab returned a different commit than the requested immutable source head.');
    binding.commit = commit.id;
    for (let page = 1; page <= 51; page += 1) {
      const entries = await requestJson<Array<{ path: string; type: string; mode: string; id: string }>>('gitlab', `${base}/repository/tree?ref=${commit.id}&recursive=true&per_page=100&page=${page}`);
      if (!Array.isArray(entries) || page === 51 && entries.length) throw new Error('GitLab repository tree exceeds the bounded snapshot.');
      for (const entry of entries) {
        validateNativeRepositoryPath(entry.path);
        if (entry.type === 'tree') continue;
        if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error('Repository symlinks and submodules cannot escape the dedicated native snapshot.');
        const blob = await requestJson<{ content: string; encoding: string; size: number; blob_id: string }>('gitlab', `${base}/repository/files/${encodeURIComponent(entry.path)}?ref=${commit.id}`);
        if (blob.encoding !== 'base64' || typeof blob.content !== 'string' || blob.blob_id !== entry.id) throw new Error('GitLab file did not match its pinned tree identity.');
        const bytes = Buffer.from(blob.content.replace(/\s/g, ''), 'base64');
        if (bytes.length !== blob.size || !/^[a-f0-9]{40,64}$/i.test(entry.id) || createHash(entry.id.length === 40 ? 'sha1' : 'sha256').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== entry.id.toLowerCase()) throw new Error('GitLab repository file did not match its pinned Git blob identity.');
        await saveFile(entry.path, bytes, entry.mode === '100755');
      }
      if (entries.length < 100) break;
    }
  }
  signal.throwIfAborted();
  writeRecord(`${namespace}:base-files`, key, baseFiles);
  binding.phase = 'ready'; writeRecord(namespace, key, binding);
  return binding;
}

/** Real filesystem delta, never a model's assertion that it edited/tested a file. */
export async function readNativeRepositoryChanges(threadId: string, idempotencyKey: string, authorized: AgentExecutionSnapshot): Promise<NativeRepositoryChange[]> {
  const key = bindingKey(threadId, idempotencyKey);
  const binding = readRecord<NativeRepositoryBinding>(namespace, key);
  if (!binding) throw new Error('Native child has no persistent repository binding.');
  await validateBinding(binding, authorized);
  const base = readRecord<Record<string, BaseFile>>(`${namespace}:base-files`, key);
  if (!base) throw new Error('Native repository has no immutable base file manifest.');
  const trackedDirectories = new Set<string>();
  for (const filename of Object.keys(base)) {
    const components = filename.split('/');
    for (let index = 1; index < components.length; index += 1) trackedDirectories.add(components.slice(0, index).join('/'));
  }
  const ignoreFiles = Object.entries(base).filter(([, file]) => file.ignoreRules !== undefined).map(([filename, file]) => ({ directory: filename.includes('/') ? filename.slice(0, filename.lastIndexOf('/') + 1) : '', matcher: ignore().add(file.ignoreRules!) })).sort((a, b) => a.directory.length - b.directory.length);
  const ignored = (filename: string, directory: boolean): boolean => {
    let excluded = false;
    for (const rules of ignoreFiles) {
      if (!filename.startsWith(rules.directory)) continue;
      const relative = filename.slice(rules.directory.length);
      if (!relative) continue;
      const result = rules.matcher.test(`${relative}${directory ? '/' : ''}`);
      if (result.ignored) excluded = true;
      else if (result.unignored) excluded = false;
    }
    return excluded;
  };
  const remaining = new Set(Object.keys(base)), changes: NativeRepositoryChange[] = [];
  let visited = 0, totalBytes = 0, changedBytes = 0;
  const visit = async (directory: string, relative: string, parentExcluded = false): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = relative ? `${relative}/${entry.name}` : entry.name;
      validateNativeRepositoryPath(filename);
      const excluded = parentExcluded || ignored(filename, entry.isDirectory());
      if (!Object.hasOwn(base, filename) && !trackedDirectories.has(filename) && excluded) continue;
      const target = path.join(directory, entry.name), info = await lstat(target);
      if (++visited > 10000 || info.isSymbolicLink() || await realpath(target) !== target) throw new Error('Native repository artifacts contain unsafe links or exceed the bounded snapshot.');
      if (info.isDirectory()) { await visit(target, filename, excluded); continue; }
      if (!info.isFile() || info.nlink !== 1 || info.mode & 0o7002 || info.size > 2 * 1024 * 1024) throw new Error('Native repository artifact is not a bounded independent regular file with safe permissions.');
      totalBytes += info.size;
      if (totalBytes > 64 * 1024 * 1024) throw new Error('Native repository artifacts exceed 64 MiB.');
      const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const opened = await file.stat();
        if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size) throw new Error('Native repository artifact changed while being read.');
        bytes = await file.readFile();
      } finally { await file.close(); }
      const old = Object.hasOwn(base, filename) ? base[filename] : undefined;
      remaining.delete(filename);
      const executable = Boolean(info.mode & 0o111);
      if (old?.sha256 === createHash('sha256').update(bytes).digest('hex') && old.executable === executable) continue;
      let change: NativeRepositoryChange;
      try { change = { path: filename, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }; }
      catch { change = { path: filename, content: bytes.toString('base64'), encoding: 'base64' }; }
      if (old ? old.executable !== executable : executable) change.mode = executable ? '100755' : '100644';
      changedBytes += bytes.length;
      changes.push(change);
      if (changes.length > 100 || changedBytes > 1024 * 1024) throw new Error('Native repository changes exceed 100 files or 1 MiB.');
    }
  };
  await visit(binding.executionPath, '');
  for (const filename of remaining) {
    changes.push({ path: filename, content: null });
    if (changes.length > 100) throw new Error('Native repository changes exceed 100 files.');
  }
  await validateBinding(binding, authorized);
  if (!binding.repository?.write && changes.length) throw new Error('A read-only native repository stage changed its pinned snapshot; its analysis cannot authorize delivery.');
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}
