import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { executionSelectionSchema, type ExecutionEnvironment } from '@agent-workspace/contracts/chat';
import { dataDirectory } from './paths.ts';
import { git } from './task-delivery/git.ts';
import { resolveAgentExecution, sameExecutionIdentity, type AgentExecutionSnapshot } from './durable/agent-execution.ts';
import { DurableError } from './durable/errors.ts';
import { deleteRecord, listRecords, readRecord, transaction, writeRecord } from './durable/store.ts';
import { assertThreadWritable, getThread, ThreadConflictError, type ThreadMetadata } from './durable/threads.ts';
import { listRuns, withThreadExecution } from './durable/engine.ts';
import { assertSessionTerminalsIdle } from './inspector/terminal.ts';

const namespace = 'chat-worktrees-v1';
const recordSchema = z.strictObject({
  threadId: z.string(), agentWorkspaceId: z.string(), agentWorkspaceRevision: z.number().int().positive(),
  root: z.string(), directory: z.string(), branch: z.string(), baseSha: z.string().regex(/^[a-f0-9]{40,64}$/),
  identity: z.string(), createdAt: z.string(), state: z.enum(['active', 'transitioning']),
});
export type ChatWorktree = z.infer<typeof recordSchema>;
export type ChatWorktreeState = { worktree: (ChatWorktree & { headSha: string; clean: boolean }) | null; revision: number; lifecycleRevision: number };
export type ChatWorktreeMutation = { revision?: number; lifecycleRevision?: number };
const transitionKey = Symbol.for('agent-workspace.chat-worktree-transitions');
const globals = globalThis as typeof globalThis & { [transitionKey]?: Set<string> };
const transitions = globals[transitionKey] ??= new Set<string>();
const changed = () => new DurableError(409, 'worktree_changed', 'Chat 工作树目录、分支或 HEAD 身份已变化；拒绝回退到主工作树，请核对原工作树。');
const branchFor = (id: string) => `chat/${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
function directoryFor(id: string): string {
  // Thread IDs are opaque and may contain slashes; never interpret one as a filesystem path.
  if (!id || id === '.' || id === '..' || path.basename(id) !== id || id.includes('\\') || /[\x00-\x1f]/.test(id))
    throw new DurableError(400, 'invalid_worktree_thread_id', '该会话 ID 不能安全用作工作树目录名；请创建新 Session。');
  return path.join(dataDirectory(), 'chat-worktrees', id);
}
export function readChatWorktree(threadId: string): ChatWorktree | null {
  const value = readRecord<unknown>(namespace, threadId);
  if (value === null) return null;
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success || parsed.data.threadId !== threadId || parsed.data.directory !== directoryFor(threadId) || parsed.data.branch !== branchFor(threadId)) throw changed();
  return parsed.data;
}
export function assertChatWorktreeStable(threadId: string): void {
  if (transitions.has(threadId) || readChatWorktree(threadId)?.state === 'transitioning')
    throw new DurableError(409, 'worktree_busy', '工作树切换尚未结束，请等待原请求结果。');
}
/** Lifecycle operations must not strand a server-owned Git directory or its commits. */
export function assertNoChatWorktree(threadId: string): void {
  if (transitions.has(threadId) || readRecord<unknown>(namespace, threadId) !== null)
    throw new ThreadConflictError('请先通过工作树入口结束 Chat worktree，再归档或删除 Session；不会自动删除工作树。', 'worktree_active');
}
function assertUnmanaged(threadId: string): void {
  if (listRecords<{ threadId?: string }>('task-code-delivery-v1').some(value => value.threadId === threadId))
    throw new DurableError(409, 'delivery_worktree_conflict', '任务交付已绑定此 Session，不能再创建 Chat 工作树。');
  if (['collaboration:runs:v1', 'pm-automation:native-thread-bindings', 'pm-automation:native-repositories'].some(name =>
    listRecords<{ threadId?: string }>(name).some(value => value.threadId === threadId)))
    throw new DurableError(409, 'managed_session', '受管协作或自动化 Session 不能切换 Chat 工作树。');
}
function assertIdle(threadId: string, directory?: string): void {
  if (listRecords<{ threadId: string; status: string }>('chat:generations').some(value => value.threadId === threadId && ['queued', 'running'].includes(value.status)) ||
      listRuns(threadId).some(value => ['queued', 'running'].includes(value.status)) ||
      listRecords<{ threadId: string; status: string }>('chat:message-queue').some(value => value.threadId === threadId && !['removed', 'sent'].includes(value.status)))
    throw new DurableError(409, 'chat_busy', 'Session 有运行中或排队的执行；请先显式结束或移除，工作树切换不会自动取消。');
  if (getThread(threadId)?.pendingFork) throw new DurableError(409, 'pending_native_fork', '请先处理待执行的原生 fork，再切换工作树。');
  assertSessionTerminalsIdle(threadId, directory);
}
function assertCurrent(original: ThreadMetadata, expected: ChatWorktreeMutation = {}, directory?: string): ThreadMetadata {
  const current = assertThreadWritable(original.remoteId);
  if (current.revision !== original.revision || (current.lifecycleRevision ?? 0) !== (original.lifecycleRevision ?? 0) ||
      expected.revision !== undefined && current.revision !== expected.revision ||
      expected.lifecycleRevision !== undefined && (current.lifecycleRevision ?? 0) !== expected.lifecycleRevision ||
      JSON.stringify(current.executionSelection) !== JSON.stringify(original.executionSelection) ||
      !sameExecutionIdentity(current.executionEnvironment, original.executionEnvironment) ||
      JSON.stringify(current.nativeSession) !== JSON.stringify(original.nativeSession))
    throw new ThreadConflictError('Session 已变化；重新载入后再切换工作树。', 'worktree_conflict');
  assertUnmanaged(current.remoteId);
  assertIdle(current.remoteId, directory);
  return current;
}
async function source(thread: ThreadMetadata): Promise<AgentExecutionSnapshot> {
  const selection = executionSelectionSchema.safeParse(thread.executionSelection);
  if (!selection.success) throw new DurableError(409, 'session_cutover_required', '旧会话不能创建工作树；请创建新版 Session。');
  if (selection.data.agentWorkspaceId === null) throw new DurableError(409, 'worktree_workspace_required', 'Chat-only Session 没有 Git 项目；请先选择 Agent workspace。');
  const original = await resolveAgentExecution(selection.data, thread.remoteId);
  original.environment.frozen = thread.executionEnvironment?.frozen ?? false;
  const persisted = thread.executionEnvironment;
  if (persisted && (persisted.agentWorkspaceId !== original.environment.agentWorkspaceId || persisted.agentWorkspaceRevision !== original.environment.agentWorkspaceRevision || persisted.sourcePath !== original.environment.sourcePath)) throw changed();
  try {
    if (await realpath(original.path) !== original.path || (await git(original.path, 'rev-parse', '--show-toplevel')).trim() !== original.path)
      throw new Error('Not repository root');
  } catch { throw new DurableError(409, 'repository_root_required', 'Agent workspace 必须是已有提交的 Git 仓库根目录，不能是子目录或普通文件夹。'); }
  return original;
}
async function verifyDirectory(value: ChatWorktree): Promise<void> {
  const parent = path.dirname(value.directory);
  const [info, parentInfo] = await Promise.all([lstat(value.directory), lstat(parent)]);
  if (!info.isDirectory() || info.isSymbolicLink() || !parentInfo.isDirectory() || parentInfo.isSymbolicLink() ||
      await realpath(parent) !== parent || await realpath(value.directory) !== value.directory ||
      `${info.dev}:${info.ino}` !== value.identity || (info.mode & 0o077) !== 0 || (parentInfo.mode & 0o077) !== 0) throw changed();
}
/** Agent commits are valid only on the original branch and descended from its recorded base. */
export async function verifyChatWorktree(value: ChatWorktree, original: AgentExecutionSnapshot): Promise<string> {
  try {
    if (value.root !== original.path || value.agentWorkspaceId !== original.environment.agentWorkspaceId || value.agentWorkspaceRevision !== original.environment.agentWorkspaceRevision ||
        value.directory !== directoryFor(value.threadId) || value.branch !== branchFor(value.threadId)) throw changed();
    await verifyDirectory(value);
    const [root, branch, head, common, sourceCommon] = await Promise.all([
      git(value.directory, 'rev-parse', '--show-toplevel'), git(value.directory, 'symbolic-ref', 'HEAD'),
      git(value.directory, 'rev-parse', '--verify', 'HEAD^{commit}'),
      git(value.directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
      git(value.root, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
    ]);
    if (root.trim() !== value.directory || branch.trim() !== `refs/heads/${value.branch}` || common.trim() !== sourceCommon.trim()) throw changed();
    const headSha = head.trim();
    if (headSha !== value.baseSha) {
      await git(value.directory, 'merge-base', '--is-ancestor', value.baseSha, headSha);
    }
    await verifyDirectory(value);
    return headSha;
  } catch { throw changed(); }
}
async function clean(value: ChatWorktree): Promise<boolean> {
  // Ignored files also contain user bytes; Git's ordinary clean check would otherwise discard them.
  return (await git(value.directory, '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '--untracked-files=all', '--ignored')).trim() === '';
}
async function registeredWorktree(value: ChatWorktree): Promise<boolean> {
  const entries = (await git(value.root, 'worktree', 'list', '--porcelain', '-z')).split('\0');
  return entries.includes(`worktree ${value.directory}`);
}
export async function getChatWorktreeState(thread: ThreadMetadata): Promise<ChatWorktreeState> {
  assertChatWorktreeStable(thread.remoteId);
  const value = readChatWorktree(thread.remoteId);
  if (!value && thread.executionEnvironment?.worktree?.deliveryId === null) throw changed();
  assertUnmanaged(thread.remoteId);
  const original = await source(thread);
  const worktree = value ? { ...value, headSha: await verifyChatWorktree(value, original), clean: await clean(value) } : null;
  return { worktree, revision: thread.revision, lifecycleRevision: thread.lifecycleRevision ?? 0 };
}
function saveTransition(thread: ThreadMetadata, environment: ExecutionEnvironment): ThreadMetadata {
  const next: ThreadMetadata = { ...thread, revision: thread.revision + 1, updatedAt: new Date().toISOString(), executionPath: environment.executionPath ?? undefined,
    executionEnvironment: environment, nativeSession: undefined, nativeMessageId: undefined, nativeSystemPrompt: undefined, nativeEnvironment: undefined,
    pendingFork: undefined, pendingForkEnvironment: undefined };
  writeRecord('chat:threads', thread.remoteId, next);
  return next;
}
async function mutate<T>(thread: ThreadMetadata, expected: ChatWorktreeMutation, directory: string | undefined, operation: (reserved: ThreadMetadata) => Promise<T>): Promise<T> {
  assertChatWorktreeStable(thread.remoteId);
  transitions.add(thread.remoteId);
  try {
    const receipt = readChatWorktree(thread.remoteId);
    if (receipt) writeRecord(namespace, thread.remoteId, { ...receipt, state: 'transitioning' });
    assertCurrent(thread, expected, directory);
    return await withThreadExecution(thread.remoteId, async () => {
      // Invalidate admissions that resolved the old directory before this asynchronous operation.
      const reserved = transaction(() => {
        const current = assertCurrent(thread, expected, directory);
        const next = { ...current, revision: current.revision + 1 };
        writeRecord('chat:threads', thread.remoteId, next);
        return next;
      });
      return operation(reserved);
    });
  } finally {
    const receipt = readChatWorktree(thread.remoteId);
    if (receipt?.state === 'transitioning') writeRecord(namespace, thread.remoteId, { ...receipt, state: 'active' });
    transitions.delete(thread.remoteId);
  }
}
export async function createChatWorktree(thread: ThreadMetadata, expected: ChatWorktreeMutation = {}): Promise<ChatWorktreeState> {
  const directory = directoryFor(thread.remoteId);
  if (readChatWorktree(thread.remoteId)) throw new DurableError(409, 'worktree_exists', '此 Session 已有工作树；请读取原状态，不会重新创建。');
  if (thread.executionEnvironment?.worktree) throw changed();
  return mutate(thread, expected, undefined, async reserved => {
    const original = await source(reserved);
    const branch = branchFor(thread.remoteId), parent = path.dirname(directory);
    let baseSha: string;
    try { baseSha = (await git(original.path, 'rev-parse', '--verify', 'HEAD^{commit}')).trim(); }
    catch { throw new DurableError(409, 'repository_head_required', 'Git 仓库需要已有 HEAD 提交；不会初始化或修改主工作树。'); }
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentInfo = await lstat(parent);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory() || await realpath(parent) !== parent || (parentInfo.mode & 0o077) !== 0)
      throw new DurableError(409, 'unsafe_worktree_directory', '工作树父目录必须是无符号链接的私有目录（0700）。');
    let branchExists = false;
    try { await git(original.path, 'show-ref', '--verify', `refs/heads/${branch}`); branchExists = true; } catch { /* Missing branch is expected for a new Session. */ }
    if (branchExists) throw new DurableError(409, 'worktree_branch_exists', '原 Chat 分支仍被保留；请先核对并在仓库中安全处理该分支，不能覆盖已有提交。');
    assertCurrent(reserved);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch { throw new DurableError(409, 'worktree_create_failed', '工作树目录已存在或不可用；不会覆盖已有目录。'); }
    const info = await lstat(directory);
    const value: ChatWorktree = { threadId: reserved.remoteId, agentWorkspaceId: original.environment.agentWorkspaceId!, agentWorkspaceRevision: original.environment.agentWorkspaceRevision!,
      root: original.path, directory, branch, baseSha, identity: `${info.dev}:${info.ino}`, createdAt: new Date().toISOString(), state: 'transitioning' };
    // Record the private directory before Git checkout so ownership survives a failed transition.
    writeRecord(namespace, reserved.remoteId, value);
    assertCurrent(reserved);
    try { await git(original.path, 'worktree', 'add', '-b', branch, '--', directory, baseSha); }
    catch {
      let released = false;
      try {
        if (!await registeredWorktree(value)) {
          await verifyDirectory(value);
          if ((await readdir(directory)).length === 0) {
            await rmdir(directory);
            deleteRecord(namespace, reserved.remoteId);
            released = true;
          }
        }
      } catch { /* Uncertain or nonempty allocations retain their ownership receipt for explicit cleanup. */ }
      throw new DurableError(409, 'worktree_create_failed', released
        ? 'Git 未确认工作树创建；未登记的空目录和记录已清理，已有分支不会删除。'
        : 'Git 未确认工作树创建；目录记录和分支保留，请核对仓库状态。');
    }
    await verifyChatWorktree(value, original);
    const current = transaction(() => {
      const latest = assertCurrent(reserved);
      writeRecord(namespace, reserved.remoteId, { ...value, state: 'active' });
      return saveTransition(latest, { ...original.environment, executionPath: directory, worktree: { deliveryId: null, branch } });
    });
    return { worktree: { ...value, state: 'active', headSha: baseSha, clean: true }, revision: current.revision, lifecycleRevision: current.lifecycleRevision ?? 0 };
  });
}
export async function removeChatWorktree(thread: ThreadMetadata, expected: ChatWorktreeMutation = {}): Promise<ChatWorktreeState & { retainedBranch: string }> {
  const value = readChatWorktree(thread.remoteId);
  if (!value) throw new DurableError(409, 'worktree_missing', '没有可结束的 Chat 工作树；不会猜测或删除目录。');
  return mutate(thread, expected, value.directory, async reserved => {
    const original = await source(reserved);
    let missing = false;
    try { await lstat(value.directory); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') missing = true;
      else throw changed();
    }
    if (missing) {
      if (value.root !== original.path || value.agentWorkspaceId !== original.environment.agentWorkspaceId ||
          value.agentWorkspaceRevision !== original.environment.agentWorkspaceRevision) throw changed();
      try { if (await registeredWorktree(value)) throw changed(); }
      catch { throw changed(); }
      // A previous explicit Git removal may have succeeded before the SQLite receipt was cleared.
    } else {
      await verifyChatWorktree(value, original);
      if (!await clean(value)) throw new DurableError(409, 'worktree_dirty', '工作树有未提交、未跟踪或忽略文件；请先提交或安全移走，服务端不会强制删除。');
      assertCurrent(reserved, {}, value.directory);
      try { await git(value.root, 'worktree', 'remove', '--', value.directory); }
      catch { throw new DurableError(409, 'worktree_remove_failed', 'Git 未确认安全移除工作树；记录和分支均保留，请核对后重试。'); }
    }
    const current = transaction(() => {
      const latest = assertCurrent(reserved, {}, value.directory);
      const saved = saveTransition(latest, { ...original.environment, executionPath: original.path, worktree: null });
      deleteRecord(namespace, reserved.remoteId);
      return saved;
    });
    // Never delete the branch: later commits remain reachable even if they were not merged or pushed.
    return { worktree: null, retainedBranch: value.branch, revision: current.revision, lifecycleRevision: current.lifecycleRevision ?? 0 };
  });
}
