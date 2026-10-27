import type { AutomationConfig, AutomationPreview } from '../../contracts/src/automation.ts';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import { statusCategory } from '../../pm-schema/index.ts';
import type { NotificationCorePort, ReadonlyCoreSnapshot } from '../../pm-core/readonly.ts';
import { getMembership, requireCapability } from './access.ts';
import { automationLocalDate } from './automation-schedule.ts';
import type { SqlExecutor } from './ports.ts';

export async function automationSnapshot(core: NotificationCorePort, workspaceId: string): Promise<ReadonlyCoreSnapshot> {
  try {
    const snapshot = await core.read(workspaceId);
    if (!snapshot.configuration) throw new Error('Missing authoritative workflow');
    return snapshot;
  } catch { throw new DomainError('automation_source_unavailable', 'Current authoritative Markdown inputs are unavailable; no task was changed', 503); }
}
export async function authorizeAutomationProject(sql: SqlExecutor, actor: Actor, workspaceId: string, projectId: string, snapshot: ReadonlyCoreSnapshot, write = false, requireActive = write): Promise<void> {
  await requireCapability(sql, actor, workspaceId, 'domain.read', projectId);
  if (write) await requireCapability(sql, actor, workspaceId, 'planning.edit', projectId);
  const project = snapshot.files.find(record => record.id === projectId);
  if (!project || project.entity.entity !== 'project' || requireActive && project.entity.archived) throw new DomainError('not_found_or_forbidden', 'Project is not accessible or unavailable for automation', 404);
}
/** Pure observation over a validated snapshot. No model, tool, task mutation, journal or cache initialization. */
export async function observeAutomation(sql: SqlExecutor, core: NotificationCorePort, actor: Actor, workspaceId: string, config: AutomationConfig, now: Date, current?: ReadonlyCoreSnapshot): Promise<AutomationPreview> {
  const member = await getMembership(sql, actor, workspaceId);
  const snapshot = current ?? await automationSnapshot(core, workspaceId);
  await authorizeAutomationProject(sql, actor, workspaceId, config.projectId, snapshot);
  const configuration = snapshot.configuration;
  if (!configuration) throw new DomainError('automation_source_unavailable', 'Authoritative task workflow is unavailable', 503);
  const byId = new Map(snapshot.files.map(record => [record.id, record]));
  const today = automationLocalDate(now, config.trigger.timezone);
  const evidence: AutomationPreview['evidence'] = [];
  for (const record of snapshot.files) {
    const task = record.entity;
    if (task.entity !== 'work_item' || task.project !== config.projectId || task.archived) continue;
    const category = statusCategory(task, configuration);
    if (!category) throw new DomainError('automation_source_unavailable', 'Task workflow is unavailable', 503);
    if (category === 'completed' || category === 'canceled') continue;
    if (config.condition === 'overdue' && (!task.due || task.due >= today)) continue;
    if (config.condition === 'blocked') {
      let blocked = false;
      for (const id of task.blocked_by) {
        const blocker = byId.get(id);
        if (!blocker || blocker.entity.entity !== 'work_item' || member.projectIds !== null && !member.projectIds.includes(blocker.entity.project ?? '')) throw new DomainError('automation_source_unavailable', 'Blocker status cannot be evaluated within current project permissions', 409);
        const blockerCategory = statusCategory(blocker.entity, configuration);
        if (!blockerCategory) throw new DomainError('automation_source_unavailable', 'Blocker workflow is unavailable', 503);
        if (blockerCategory !== 'completed' && blockerCategory !== 'canceled') blocked = true;
      }
      if (!blocked) continue;
    }
    evidence.push({ id: record.id, projectId: config.projectId, title: task.title, status: task.status!, revision: record.revision, due: task.due ?? null });
  }
  evidence.sort((a, b) => a.id.localeCompare(b.id));
  const label = { all_open: 'open', overdue: 'overdue', blocked: 'blocked' }[config.condition];
  return { observedAt: now.toISOString(), summary: `${evidence.length} ${label} task(s) observed in ${config.projectId}. Read-only report; no task state was changed.`, evidence };
}
