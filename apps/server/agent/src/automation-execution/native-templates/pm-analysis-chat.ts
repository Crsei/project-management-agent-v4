import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionEnvironment } from '@agent-workspace/contracts/chat';
import type { AgentExecutionSnapshot } from '../../durable/agent-execution.ts';
import { dataDirectory } from '../../paths.ts';
import { pmAnalysisRequestForNativeThread } from '../context.ts';
import { nativeHash } from './state.ts';
import { readAuthorizedPmAutomationSnapshot } from './pm-bridge.ts';
import { readRecord, writeRecord } from '../../durable/store.ts';

/** No project mapping, project files or ambient cwd is needed to reason over frozen evidence. */
export async function resolvePmAnalysisChatSnapshot(threadId: string, idempotencyKey: string | undefined, signal?: AbortSignal): Promise<AgentExecutionSnapshot | null> {
  const request = pmAnalysisRequestForNativeThread(threadId, idempotencyKey);
  if (!request) return null;
  await readAuthorizedPmAutomationSnapshot(request, signal ?? AbortSignal.timeout(30000));
  const environment: ExecutionEnvironment = { version: 2, hostId: 'local', agentWorkspaceId: null, agentWorkspaceName: null, agentWorkspaceRevision: null, sourcePath: null, executionPath: null, worktree: null, frozen: false };
  const key = nativeHash([threadId, idempotencyKey]);
  const saved = readRecord<{ path: string; device: string; inode: string }>('pm-analysis:scratch-v1', key);
  if (saved) {
    const info = await lstat(saved.path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(saved.path) !== saved.path || String(info.dev) !== saved.device || String(info.ino) !== saved.inode) throw new Error('PM analysis scratch directory identity changed; no recreation or rebind is allowed.');
    return { path: saved.path, environment };
  }
  const root = await realpath(dataDirectory());
  let directory = root;
  for (const component of ['pm-analysis', request.executionId, nativeHash([threadId, idempotencyKey])]) {
    directory = path.join(directory, component);
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error; });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory || process.getuid && info.uid !== process.getuid()) throw new Error('PM analysis scratch directory was replaced or escaped its private Agent data boundary.');
    await chmod(directory, 0o700);
  }
  const info = await lstat(directory, { bigint: true });
  writeRecord('pm-analysis:scratch-v1', key, { path: directory, device: String(info.dev), inode: String(info.ino) });
  return { path: directory, environment };
}
