import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { access, chmod, chown, lstat, mkdir, open, readdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ProviderRuntimeHostBinding } from '@t3tools/provider-core/server/ProviderRuntimeHost';
import { getChatGeneration, type ChatGeneration } from '../../durable/chat-runtime.ts';
import { emitNativeOutput } from '../../durable/native-output.ts';
import { listRecords, readRecord, writeRecord } from '../../durable/store.ts';
import { dataDirectory } from '../../paths.ts';
import { resolveAutomationExecutionScope } from '../context.ts';
import { assertNativeTemplateChatSnapshot, nativeTemplateRepositoryBinding, validateNativeRepositoryPath, type NativeRepositoryBinding } from './repository.ts';
import { nativeHash } from './state.ts';
import { assertAutomationProviderToolRequirement } from '../provider-tools.ts';

export type NativeWorkspaceTools = { mcpServers: ProviderRuntimeHostBinding['mcpServers']; close(): Promise<void> };
type WorkspaceRuntime = { executable: string; image: string; clientDirectory: string };
type WorkspaceRun = { operationId: string; generationId: string; fingerprint: string; runtime: WorkspaceRuntime; container: string; phase: 'admitted' | 'created' | 'starting' | 'running' | 'completed' | 'unknown'; command: string; exitCode: number | null; output: string; error: string | null };
type ToolCall = { generationId: string; operationId: string; fingerprint: string; status: 'pending' | 'completed' | 'unknown'; result?: unknown };
const callsNamespace = 'pm-automation:native-workspace-calls';
const runsNamespace = 'pm-automation:native-workspace-runs';
const grantsNamespace = 'pm-automation:native-workspace-grants';
const grantRoot = () => path.join(dataDirectory(), 'automation-workspace-grants');
const toolInput = z.strictObject({ operationId: z.uuid(), name: z.string().max(100), arguments: z.record(z.string(), z.unknown()) });
const readInput = z.strictObject({ path: z.string().min(1).max(1000) });
const writeInput = readInput.extend({ content: z.string().max(3 * 1024 * 1024).nullable(), encoding: z.enum(['text', 'base64']).optional() });
const runInput = z.strictObject({ command: z.string().min(1).max(12000), timeoutSeconds: z.number().int().min(1).max(300).optional() });

/** The executable is an OCI client, never a shell; no inherited credentials, Docker context or proxy. */
async function engine(runtime: WorkspaceRuntime, args: string[], timeoutMs = 15000, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  signal?.throwIfAborted();
  const child = spawn(runtime.executable, args, { env: { PATH: '/usr/bin:/bin', HOME: runtime.clientDirectory, LANG: 'C.UTF-8' }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const deferred = Promise.withResolvers<{ code: number | null; stdout: string; stderr: string }>();
  const stdout: Buffer[] = [], stderr: Buffer[] = []; let bytes = 0, failure: Error | null = null;
  const stop = () => { failure = new Error('Isolated workspace command was interrupted; inspect its original container.'); child.kill('SIGKILL'); };
  const timer = setTimeout(stop, timeoutMs);
  signal?.addEventListener('abort', stop, { once: true });
  const collect = (target: Buffer[]) => (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) { failure = new Error('Isolated workspace output exceeds 1 MiB.'); child.kill('SIGKILL'); } else target.push(chunk); };
  child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
  child.once('error', error => { cleanup(); deferred.reject(error); });
  child.once('close', code => { cleanup(); if (failure) deferred.reject(failure); else deferred.resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }); });
  return deferred.promise;
}
async function workspaceRuntime(): Promise<WorkspaceRuntime> {
  const executable = process.env.PM_AUTOMATION_CONTAINER_RUNTIME?.trim(), image = process.env.PM_AUTOMATION_WORKSPACE_IMAGE?.trim();
  if (!executable || !path.isAbsolute(executable)) throw new Error('Configure PM_AUTOMATION_CONTAINER_RUNTIME as an absolute Docker/Podman executable; no host shell fallback exists.');
  const resolved = await realpath(executable), info = await stat(resolved);
  if (!info.isFile() || !['docker', 'podman'].includes(path.basename(resolved))) throw new Error('Native workspace commands require a Docker or Podman executable.');
  await access(resolved, constants.X_OK);
  if (!image || !/^(?:[a-zA-Z0-9._/:+-]+@)?sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Configure PM_AUTOMATION_WORKSPACE_IMAGE as a preloaded reviewed toolchain image pinned by sha256; images are never pulled.');
  const clientDirectory = path.join(dataDirectory(), 'automation-workspace-container-client');
  await mkdir(clientDirectory, { recursive: true, mode: 0o700 }); await chmod(clientDirectory, 0o700);
  const runtime = { executable: resolved, image, clientDirectory };
  const engineInfo = await engine(runtime, ['info', '--format={{json .ServerVersion}}']);
  if (engineInfo.code !== 0 || !engineInfo.stdout.trim()) throw new Error('The configured OCI engine is not reachable for native workspace commands.');
  const inspect = await engine(runtime, ['image', 'inspect', '--format={{json .}}', image]);
  if (inspect.code !== 0) throw new Error('The pinned workspace toolchain image is not preloaded; no pull was attempted.');
  const metadata = JSON.parse(inspect.stdout) as { Id?: string; RepoDigests?: string[] };
  if (image.startsWith('sha256:') ? metadata.Id !== image : !metadata.RepoDigests?.includes(image)) throw new Error('Workspace image metadata does not match the immutable configured digest.');
  return runtime;
}
export async function nativeWorkspaceAvailability(): Promise<{ available: boolean; reason: string | null }> {
  try { await workspaceRuntime(); return { available: true, reason: null }; }
  catch (error) { return { available: false, reason: error instanceof Error ? error.message : 'Native workspace OCI prerequisites are unavailable.' }; }
}
async function inspectRun(run: WorkspaceRun): Promise<{ status: string; exitCode: number | null }> {
  const result = await engine(run.runtime, ['inspect', '--format={{json .}}', run.container]);
  if (result.code !== 0) throw new Error('The original workspace container cannot be inspected; absence is not proof it never ran.');
  const metadata = JSON.parse(result.stdout) as { Config?: { Labels?: Record<string, string> }; State?: { Status?: string; ExitCode?: number } };
  if (metadata.Config?.Labels?.['pm.automation.workspace-fingerprint'] !== run.fingerprint) throw new Error('Workspace container fingerprint changed.');
  return { status: metadata.State?.Status ?? 'unknown', exitCode: Number.isInteger(metadata.State?.ExitCode) ? metadata.State!.ExitCode! : null };
}
async function stopRun(run: WorkspaceRun): Promise<void> {
  let observed = await inspectRun(run);
  if (['running', 'restarting', 'paused'].includes(observed.status)) {
    const stopped = await engine(run.runtime, ['kill', '--signal=KILL', run.container]);
    if (stopped.code !== 0) throw new Error('Workspace container stop was not confirmed.');
    observed = await inspectRun(run);
  }
  if (!['created', 'exited'].includes(observed.status)) throw new Error('Workspace container stop outcome is unknown.');
  run.phase = observed.status === 'created' || observed.exitCode !== null ? 'completed' : 'unknown';
  run.exitCode = observed.status === 'exited' ? observed.exitCode : null;
  if (observed.status === 'created') run.error ??= 'The original container never started; no check was executed.';
  writeRecord(runsNamespace, run.operationId, run);
}
async function checkedPath(root: string, relative: string, createParents = false): Promise<string> {
  const parts = validateNativeRepositoryPath(relative); let current = root;
  for (const component of parts.slice(0, -1)) {
    current = path.join(current, component);
    if (createParents) try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) throw new Error('Workspace path escaped its canonical dedicated directory.');
  }
  const target = path.join(current, parts.at(-1)!);
  try { const info = await lstat(target); if (info.isSymbolicLink() || info.isFile() && info.nlink !== 1 || await realpath(target) !== target) throw new Error('Workspace symlinks and hard links are not tool targets.'); }
  catch (error) { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error; }
  return target;
}
function encodedFile(bytes: Buffer): { content: string; encoding: 'text' | 'base64' } {
  try { return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), encoding: 'text' }; }
  catch { return { content: bytes.toString('base64'), encoding: 'base64' }; }
}
async function runWorkspaceCommand(generation: ChatGeneration, binding: NativeRepositoryBinding, operationId: string, command: string, timeoutSeconds: number, signal: AbortSignal, authorize: () => Promise<void>): Promise<unknown> {
  const previous = readRecord<WorkspaceRun>(runsNamespace, operationId);
  if (previous) {
    if (previous.fingerprint !== nativeHash([generation.id, command, timeoutSeconds, binding.executionPath])) throw new Error('Workspace command operation ID has different input.');
    if (previous.phase !== 'completed') throw new Error(`Workspace command ${operationId} remains uncertain; use workspace_result, never repeat it with a new ID.`);
    return { operationId, exitCode: previous.exitCode, output: previous.output };
  }
  const runtime = await workspaceRuntime();
  if (binding.executionPath.includes(',')) throw new Error('Dedicated workspace mount paths cannot contain OCI delimiters.');
  const fingerprint = nativeHash([generation.id, command, timeoutSeconds, binding.executionPath]);
  const run: WorkspaceRun = { operationId, generationId: generation.id, fingerprint, runtime, container: `pm-native-workspace-${nativeHash(operationId).slice(0, 40)}`, phase: 'admitted', command, exitCode: null, output: '', error: null };
  writeRecord(runsNamespace, operationId, run);
  const itemId = `workspace-command:${operationId}`;
  emitNativeOutput(generation.id, { type: 'item.upsert', item: { id: itemId, type: 'command_execution', status: 'running', title: command, startedAt: new Date().toISOString() } });
  let failure: unknown = null;
  try {
    await authorize(); signal.throwIfAborted();
    const uid = process.getuid?.() || 65534, gid = process.getgid?.() || 65534;
    if (process.getuid?.() === 0) {
      const own = async (directory: string): Promise<void> => { await chown(directory, uid, gid); for (const entry of await readdir(directory, { withFileTypes: true })) { const target = path.join(directory, entry.name); const info = await lstat(target); if (info.isSymbolicLink()) continue; if (!info.isDirectory() && !info.isFile()) throw new Error('Workspace contains an unsafe file before its isolated command.'); if (info.isDirectory()) await own(target); else if (info.nlink === 1) await chown(target, uid, gid); else throw new Error('Workspace contains a hard-linked file.'); } };
      await own(binding.executionPath);
    }
    const created = await engine(runtime, ['create', '--pull=never', '--name', run.container, '--label', `pm.automation.workspace-fingerprint=${fingerprint}`, '--network=none', '--read-only', `--user=${uid}:${gid}`, '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=1024m', '--memory-swap=1024m', '--cpus=2', '--ulimit=nofile=256:256', '--ulimit=fsize=16777216:16777216', '--log-driver=json-file', '--log-opt=max-size=2m', '--log-opt=max-file=1', '--mount', `type=bind,source=${binding.executionPath},target=/workspace${binding.repository?.write ? '' : ',readonly'}`, '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777', '--workdir=/workspace', '--env=HOME=/tmp', '--env=PATH=/usr/local/bin:/usr/bin:/bin', '--env=LANG=C.UTF-8', '--entrypoint=/bin/sh', runtime.image, '-lc', command], 15000, signal);
    if (created.code !== 0) throw new Error('Workspace container creation was not confirmed.');
    run.phase = 'created'; writeRecord(runsNamespace, operationId, run);
    await authorize(); signal.throwIfAborted();
    run.phase = 'starting'; writeRecord(runsNamespace, operationId, run);
    const started = await engine(runtime, ['start', '--attach', run.container], timeoutSeconds * 1000, signal);
    run.output = `${started.stdout}${started.stderr}`;
    const observed = await inspectRun(run);
    if (observed.status !== 'exited' || observed.exitCode === null) throw new Error('Workspace command exit was not authoritatively confirmed.');
    run.phase = 'completed'; run.exitCode = observed.exitCode;
  } catch (error) { failure = error; run.error = error instanceof Error ? error.message : 'Isolated workspace command failed.'; }
  finally {
    if (run.phase !== 'completed') try { await stopRun(run); } catch (error) { run.phase = 'unknown'; run.error = error instanceof Error ? error.message : 'Workspace stop outcome is unknown.'; }
    if (run.phase === 'completed') {
      try {
        const logs = await engine(runtime, ['logs', run.container]);
        if (logs.code === 0) run.output = `${logs.stdout}${logs.stderr}`;
        else run.error = 'Workspace exit is confirmed, but its bounded output could not be read.';
      } catch { run.error = 'Workspace exit is confirmed, but its bounded output could not be read.'; }
    }
    writeRecord(runsNamespace, operationId, run);
    emitNativeOutput(generation.id, { type: 'item.upsert', item: { id: itemId, type: 'command_execution', status: run.phase === 'completed' && run.exitCode === 0 && !run.error ? 'completed' : run.phase === 'unknown' ? 'interrupted' : 'failed', title: command, completedAt: new Date().toISOString(), output: run.output, ...(run.exitCode === null ? {} : { exitCode: run.exitCode }), ...(run.error ? { error: run.error } : {}) } });
  }
  await authorize();
  if (run.phase !== 'completed' || run.error || failure) throw new Error(`Workspace command ${operationId}: ${run.error ?? 'execution interrupted'}; inspect workspace_result, never fabricate a passing check.`);
  return { operationId, exitCode: run.exitCode, output: run.output };
}

export async function openNativeTemplateScratchTools(generation: ChatGeneration, _headers: Headers | undefined, authorizeExecution: (action: 'tool') => Promise<void>): Promise<NativeWorkspaceTools> {
  const binding = nativeTemplateRepositoryBinding(generation);
  if (!binding || binding.request.config.action.kind !== 'template') throw new Error('Native scratch tools require a persisted original template repository binding.');
  if (!binding.repository) return { mcpServers: [], close: async () => {} };
  assertAutomationProviderToolRequirement(generation.providerInstanceId, 'templateWorkspace');
  let closed = false, revoked = false, queue: Promise<unknown> = Promise.resolve();
  const controller = new AbortController(), active = new Set<Promise<unknown>>();
  const authorize = async () => {
    if (closed || controller.signal.aborted) throw new Error('Native scratch grant is revoked.');
    const current = getChatGeneration(generation.id);
    if (!current || current.status !== 'running' || current.threadId !== generation.threadId || current.request.idempotencyKey !== generation.request.idempotencyKey) throw new Error('Native scratch generation is no longer live.');
    await authorizeExecution('tool');
    const authorized = await resolveAutomationExecutionScope(binding.request, controller.signal);
    await assertNativeTemplateChatSnapshot(current, authorized);
    if (closed || controller.signal.aborted) throw new Error('Native scratch grant was revoked during authorization.');
  };
  await authorize();
  const token = randomBytes(32).toString('base64url'), filename = path.join(grantRoot(), `${generation.id}.json`);
  const tools = [
    { name: 'automation_workspace_list', description: 'List files in this exact dedicated repository snapshot; no business-project or upstream access.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Relative directory, or . for snapshot root' } }, required: ['path'], additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: 'automation_workspace_read', description: 'Read one bounded regular file in this dedicated snapshot; returns text or base64.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, annotations: { readOnlyHint: true } },
    ...(binding.repository?.write ? [{ name: 'automation_workspace_write', description: 'Write/delete an actual file ONLY in this dedicated scratch snapshot. No upstream publication. content=null deletes a regular file.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: ['string', 'null'] }, encoding: { enum: ['text', 'base64'] } }, required: ['path', 'content'], additionalProperties: false }, annotations: { readOnlyHint: false } }] : []),
    { name: 'automation_workspace_run', description: 'Run a focused check in the reviewed immutable OCI toolchain; no network, credentials, host shell or mounts beyond this snapshot. Actual exit/output receipts persist. Missing packages cannot be downloaded.', inputSchema: { type: 'object', properties: { command: { type: 'string' }, timeoutSeconds: { type: 'integer', minimum: 1, maximum: 300 } }, required: ['command'], additionalProperties: false }, annotations: { readOnlyHint: !binding.repository?.write } },
    { name: 'automation_workspace_result', description: 'Inspect an original workspace command by operationId without rerunning it.', inputSchema: { type: 'object', properties: { operationId: { type: 'string', format: 'uuid' } }, required: ['operationId'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  ];
  const call = async (input: z.infer<typeof toolInput>): Promise<unknown> => {
    await authorize();
    if (input.name === 'automation_workspace_result') {
      const { operationId } = z.strictObject({ operationId: z.uuid() }).parse(input.arguments), run = readRecord<WorkspaceRun>(runsNamespace, operationId);
      if (!run || run.generationId !== generation.id) throw new Error('Original workspace command not found in this generation.');
      return { operationId, phase: run.phase, exitCode: run.exitCode, output: run.output, error: run.error };
    }
    const fingerprint = nativeHash([generation.id, input.name, input.arguments]), previous = readRecord<ToolCall>(callsNamespace, input.operationId);
    if (previous) {
      if (previous.generationId !== generation.id || previous.fingerprint !== fingerprint) throw new Error('Scratch operation ID belongs to another immutable call.');
      if (previous.status !== 'completed') throw new Error(`Scratch operation ${input.operationId} is uncertain; it is never automatically replayed.`);
      return previous.result;
    }
    const receipt: ToolCall = { generationId: generation.id, operationId: input.operationId, fingerprint, status: 'pending' };
    writeRecord(callsNamespace, input.operationId, receipt);
    try {
      let result: unknown;
      if (input.name === 'automation_workspace_run') {
        const args = runInput.parse(input.arguments);
        result = await runWorkspaceCommand(generation, binding, input.operationId, args.command, args.timeoutSeconds ?? 120, controller.signal, authorize);
      } else if (input.name === 'automation_workspace_list') {
        const args = readInput.parse(input.arguments), directory = args.path === '.' ? binding.executionPath : await checkedPath(binding.executionPath, args.path);
        const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Not a safe snapshot directory.');
        const entries = await readdir(directory, { withFileTypes: true }); if (entries.length > 5000) throw new Error('Snapshot directory has more than 5000 entries.');
        result = entries.map(entry => ({ name: entry.name, directory: entry.isDirectory(), regular: entry.isFile(), symlink: entry.isSymbolicLink() }));
      } else if (input.name === 'automation_workspace_read') {
        const args = readInput.parse(input.arguments), target = await checkedPath(binding.executionPath, args.path), file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { const info = await file.stat(); if (!info.isFile() || info.nlink !== 1 || info.size > 2 * 1024 * 1024) throw new Error('Only bounded regular snapshot files may be read.'); result = { path: args.path, ...encodedFile(await file.readFile()) }; } finally { await file.close(); }
      } else if (input.name === 'automation_workspace_write') {
        if (!binding.repository?.write) throw new Error('This native stage has no scratch-write authority.');
        const args = writeInput.parse(input.arguments), target = await checkedPath(binding.executionPath, args.path, true);
        if (args.content === null) { const info = await lstat(target); if (!info.isFile() || info.nlink !== 1) throw new Error('Only a regular snapshot file may be deleted.'); await unlink(target); result = { path: args.path, deleted: true }; }
        else {
          if (args.encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.content)) throw new Error('Invalid base64 file contents.');
          const bytes = Buffer.from(args.content, args.encoding === 'base64' ? 'base64' : 'utf8'); if (bytes.length > 2 * 1024 * 1024) throw new Error('Scratch file exceeds 2 MiB.');
          const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
          try { const info = await file.stat(); if (!info.isFile() || info.nlink !== 1) throw new Error('Scratch write target is not an independent regular file.'); await file.truncate(0); await file.writeFile(bytes); } finally { await file.close(); }
          result = { path: args.path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        }
      } else throw new Error('Unknown dedicated workspace tool.');
      await authorize(); receipt.status = 'completed'; receipt.result = result; writeRecord(callsNamespace, input.operationId, receipt);
      return result;
    } catch (error) { receipt.status = 'unknown'; writeRecord(callsNamespace, input.operationId, receipt); throw error; }
  };
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    const address = server.address(), host = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : '';
    const authorization = request.headers.authorization?.replace(/^Bearer /, '') ?? '', actual = Buffer.from(authorization), expected = Buffer.from(token);
    if (closed || request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== host || request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected) || request.method !== 'POST' || request.url !== '/mcp' || request.headers['content-type']?.split(';')[0] !== 'application/json') { response.writeHead(403).end(JSON.stringify({ error: 'Native scratch authority required.' })); return; }
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { const buffer = Buffer.from(chunk); bytes += buffer.length; if (bytes > 4 * 1024 * 1024) throw new Error('Scratch request exceeds 4 MiB.'); chunks.push(buffer); }
      const body = z.strictObject({ method: z.enum(['tools/list', 'tools/call']), params: z.unknown().optional() }).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      await authorize();
      if (body.method === 'tools/list') { response.end(JSON.stringify({ tools })); return; }
      const input = toolInput.parse(body.params), job = queue.catch(() => undefined).then(() => call(input)); queue = job; active.add(job);
      try { const result = await job; response.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: false })); }
      finally { active.delete(job); }
    } catch (error) { response.writeHead(400).end(JSON.stringify({ error: error instanceof Error ? error.message : 'Native scratch operation failed.' })); }
  });
  const listening = Promise.withResolvers<void>(); server.once('error', listening.reject); server.listen(0, '127.0.0.1', () => { server.off('error', listening.reject); listening.resolve(); }); await listening.promise;
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native scratch loopback listener unavailable.');
  let createdGrant = false;
  try {
    await mkdir(grantRoot(), { recursive: true, mode: 0o700 }); await chmod(grantRoot(), 0o700);
    await writeFile(filename, JSON.stringify({ schemaVersion: 1, url: `http://127.0.0.1:${address.port}/mcp`, token, generationId: generation.id, expiresAt: Date.now() + binding.request.config.action.timeoutSeconds * 1000 }), { mode: 0o600, flag: 'wx' });
    createdGrant = true;
    writeRecord(grantsNamespace, generation.id, { generationId: generation.id, filename, revoked: false });
  } catch (error) {
    closed = true; controller.abort();
    const stopped = Promise.withResolvers<void>(); server.close(cause => cause ? stopped.reject(cause) : stopped.resolve()); server.closeAllConnections();
    await stopped.promise;
    if (createdGrant) await rm(filename, { force: true });
    throw error;
  }
  let authorizationCheck: Promise<void> | null = null;
  const monitor = setInterval(() => { if (authorizationCheck || closed) return; authorizationCheck = authorize().catch(() => controller.abort()).finally(() => { authorizationCheck = null; }); }, 2000);
  return {
    mcpServers: [{ name: 'automation_workspace', transport: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./workspace-tools.mjs', import.meta.url)), '--grant-file', filename] }],
    async close() {
      if (revoked) return;
      closed = true; clearInterval(monitor); controller.abort();
      await Promise.allSettled([...active, ...(authorizationCheck ? [authorizationCheck] : [])]);
      const failures: unknown[] = [];
      for (const run of listRecords<WorkspaceRun>(runsNamespace).filter(run => run.generationId === generation.id && run.phase !== 'completed')) try { await stopRun(run); } catch (error) { failures.push(error); }
      const stopped = Promise.withResolvers<void>(); server.close(error => error ? stopped.reject(error) : stopped.resolve()); server.closeAllConnections();
      try { await stopped.promise; } catch (error) { failures.push(error); }
      if (failures.length) throw Object.assign(new AggregateError(failures, 'Native scratch stop was not confirmed; its private recovery grant was retained.'), { terminalStatus: 'interrupted' });
      writeRecord(grantsNamespace, generation.id, { generationId: generation.id, filename, revoked: true });
      await rm(filename, { force: true }); revoked = true;
    },
  };
}
/** Called after native Chat restart recovery. It only stops original containers; never replays tools. */
export async function recoverNativeTemplateScratchTools(): Promise<void> {
  const failures: unknown[] = [];
  for (const run of listRecords<WorkspaceRun>(runsNamespace)) {
    const generation = getChatGeneration(run.generationId);
    if (generation && ['queued', 'running'].includes(generation.status) || run.phase === 'completed') continue;
    try { await stopRun(run); } catch (error) { failures.push(error); }
  }
  for (const grant of listRecords<{ generationId: string; filename: string; revoked: boolean }>(grantsNamespace)) {
    const generation = getChatGeneration(grant.generationId);
    if (generation && ['queued', 'running'].includes(generation.status)) continue;
    if (listRecords<WorkspaceRun>(runsNamespace).some(run => run.generationId === grant.generationId && run.phase !== 'completed')) continue;
    if (grant.filename !== path.join(grantRoot(), `${grant.generationId}.json`)) { failures.push(new Error('Invalid native scratch recovery filename.')); continue; }
    try { await rm(grant.filename, { force: true }); writeRecord(grantsNamespace, grant.generationId, { ...grant, revoked: true }); } catch (error) { failures.push(error); }
  }
  let entries: string[];
  try { entries = await readdir(grantRoot()); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') entries = []; else throw error; }
  for (const entry of entries) {
    if (typeof entry !== 'string' || !/^[a-f0-9-]{36}\.json$/i.test(entry)) continue;
    const generationId = entry.slice(0, -5), generation = getChatGeneration(generationId);
    if (generation && ['queued', 'running'].includes(generation.status) || listRecords<WorkspaceRun>(runsNamespace).some(run => run.generationId === generationId && run.phase !== 'completed')) continue;
    try {
      const filename = path.join(grantRoot(), entry), info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077) throw new Error('Unsafe native workspace recovery grant file.');
      await rm(filename, { force: true });
      writeRecord(grantsNamespace, generationId, { generationId, filename, revoked: true });
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Original native workspace containers need authoritative stop reconciliation.');
}
