import { agentHandoffReportSchema } from '../../../../../packages/contracts/src/task-context.ts';
import { git } from '../task-delivery/git.ts';

/** Read only a report changed in this delivery and frozen in its verified commit. */
export async function readProductReport(directory: string, head: string, taskId: string, changedFiles: string[]) {
  const path = `docs/agent-handoffs/${taskId}.json`;
  if (!changedFiles.includes(path)) return undefined;
  const raw = await git(directory, 'show', `${head}:${path}`);
  if (raw.length > 16000) throw new Error('产品变化说明过长，请核对。');
  return agentHandoffReportSchema.parse(JSON.parse(raw));
}
