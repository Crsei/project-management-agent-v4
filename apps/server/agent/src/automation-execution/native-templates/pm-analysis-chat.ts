import { chmod, lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AgentScope } from '@agent-workspace/contracts/chat';
import type { AgentExecutionSnapshot } from '../../durable/agent-scope.ts';
import { dataDirectory } from '../../paths.ts';
import { pmAnalysisRequestForNativeThread } from '../context.ts';
import { nativeHash } from './state.ts';
import { readAuthorizedPmAutomationSnapshot } from './pm-bridge.ts';

/** No project mapping, project files or ambient cwd is needed to reason over frozen evidence. */
export async function resolvePmAnalysisChatSnapshot(threadId: string, idempotencyKey: string | undefined, scope: AgentScope | undefined, signal?: AbortSignal): Promise<AgentExecutionSnapshot | null> {
  const request = pmAnalysisRequestForNativeThread(threadId, idempotencyKey);
  if (!request) return null;
  if (!scope || scope.workspaceId !== request.workspaceId || scope.projectId !== request.projectId) throw new Error('PM analysis Chat scope differs from its original server-issued binding.');
  const snapshot = await readAuthorizedPmAutomationSnapshot(request, signal ?? AbortSignal.timeout(30000));
  const root = await realpath(dataDirectory());
  let directory = root;
  for (const component of ['pm-analysis', request.executionId, nativeHash([threadId, idempotencyKey])]) {
    directory = path.join(directory, component);
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error; });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory || process.getuid && info.uid !== process.getuid()) throw new Error('PM analysis scratch directory was replaced or escaped its private Agent data boundary.');
    await chmod(directory, 0o700);
  }
  return { actorId: request.actorId, scope: { workspaceId: request.workspaceId, projectId: request.projectId }, workspaceName: request.workspaceId, projectName: snapshot.project.title, path: directory };
}
