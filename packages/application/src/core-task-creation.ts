import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { DomainError, type Capability } from '../../domain/src/core.ts';
import { statusCategory, type Entity, type FileRecord, type ProtocolConfiguration } from '../../pm-schema/index.ts';
import { referenceEntries } from '../../pm-schema/relations.ts';
import type { SqlExecutor } from './ports.ts';

const uuid = z.uuid();

/** Native Markdown owns tasks, but workspace identity/project eligibility remains SQL authority. */
export async function requireTaskAssignee(sql: SqlExecutor, workspaceId: string, projectId: string, assigneeId: unknown): Promise<void> {
  if (assigneeId === undefined || assigneeId === null || assigneeId === '') return;
  const identity = uuid.safeParse(assigneeId);
  if (!identity.success) throw new DomainError('workspace_member_required', 'Assignee must be an active workspace member with project access', 409);
  const member = await sql.query(`SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.revoked_at IS NULL AND u.disabled_at IS NULL
      AND 'domain.read'=ANY(m.capabilities) AND (m.project_ids IS NULL OR $3=ANY(m.project_ids))
    FOR SHARE OF m,u`, [workspaceId, identity.data.toLowerCase(), projectId]);
  if (!member.rows[0]) throw new DomainError('workspace_member_required', 'Assignee must be an active workspace member with project access', 409);
}

/** Configured categories, not legacy PM state names, define a terminal project. */
export function assertTaskCreationProject(project: FileRecord, configuration: ProtocolConfiguration): void {
  if (project.entity.entity !== 'project') throw new DomainError('project_required', 'A project is required', 409);
  if (project.stale || project.diagnostics?.some(diagnostic => diagnostic.severity === 'error')) throw new DomainError('project_inputs_unavailable', 'Project source is stale or invalid', 409);
  if (project.entity.archived === true) throw new DomainError('object_archived', 'Archived projects cannot receive tasks', 409);
  const category = statusCategory(project.entity, configuration);
  if (!category) throw new DomainError('project_inputs_unavailable', 'Project workflow evidence is unavailable', 409);
  if (category === 'completed' || category === 'canceled') throw new DomainError('invalid_state', 'Terminal projects cannot receive tasks', 409);
}

/** Call inside the file mutation's serialized authority boundary and the SQL workspace lock. */
export type CoreTaskPolicyPorts = {
  get(id: string): FileRecord;
  configuration: ProtocolConfiguration;
  requireCapability(capability: Capability): void;
  allowsProject(projectId: unknown): boolean;
  requireAssignee(projectId: string, assigneeId: unknown): Promise<void>;
};

const protectedMetadata = ['x-pm-created-by', 'x-pm-created-at', 'x-pm-updated-at', 'x-pm-command-id', 'x-pm-intent-ref', 'x-pm-archived-at'] as const;

/** Native clients may retain server facts, never forge, replace or remove them. */
export function assertCoreProtectedMetadata(after: Entity, before?: Entity): void {
  for (const field of protectedMetadata) {
    if (!isDeepStrictEqual(after[field], before?.[field]))
      throw new DomainError('protected_metadata', `Server metadata ${field} cannot be changed`, 400, { field });
  }
}

/** Transport-independent task rules; Markdown core still owns schema, workflow and relation integrity. */
export async function assertCoreTaskMutation(ports: CoreTaskPolicyPorts, after: Entity, before?: Entity): Promise<void> {
  if (after.entity !== 'work_item') return;
  ports.requireCapability('domain.read');
  // Existing projectless files remain valid history; creation or removing a project does not.
  if (!after.project && (!before || before.project)) throw new DomainError('project_required', 'A project is required', 409);
  if (!ports.allowsProject(after.project) || before?.project && !ports.allowsProject(before.project))
    throw new DomainError('not_found_or_forbidden', 'Project is not accessible', 404);
  if (after.project) assertTaskCreationProject(ports.get(after.project), ports.configuration);

  const changed = (field: string) => !isDeepStrictEqual(after[field], before?.[field]);
  const lifecycleOnly = before !== undefined && Object.keys({ ...before, ...after }).every(field =>
    ['status', 'archived', 'x-pm-archived-at', 'checklist'].includes(field) || !changed(field));
  if (!lifecycleOnly) ports.requireCapability('planning.edit');
  if (changed('archived') && (before !== undefined || after.archived === true)) ports.requireCapability('planning.lifecycle');
  if (!before || changed('status')) {
    const previous = before && statusCategory(before, ports.configuration);
    const next = statusCategory(after, ports.configuration);
    if (next === 'completed') ports.requireCapability('workitem.complete');
    else if (next === 'canceled' || previous === 'completed' || previous === 'canceled') ports.requireCapability('workitem.cancel_reopen');
    else ports.requireCapability('planning.edit');
  }

  // An unchanged historical assignee is a readable fact, not a fresh assignment.
  if (!before || changed('project') || changed('assignee')) {
    if (!after.project) throw new DomainError('project_required', 'A project is required for a new assignment', 409);
    await ports.requireAssignee(after.project, after.assignee);
  }
  const previousReferences = new Set(before ? referenceEntries(before, ports.configuration).map(({ field, targetId }) => `${field}:${targetId}`) : []);
  for (const reference of referenceEntries(after, ports.configuration)) {
    if (before && !changed('project') && previousReferences.has(`${reference.field}:${reference.targetId}`)) continue;
    const target = ports.get(reference.targetId);
    const projectId = target.entity.entity === 'project' ? target.id : target.entity.project;
    if (!ports.allowsProject(projectId)) throw new DomainError('not_found_or_forbidden', 'Related entity is not accessible', 404);
    if (target.stale || target.diagnostics?.some(diagnostic => diagnostic.severity === 'error'))
      throw new DomainError('task_inputs_unavailable', 'Related source is stale or invalid', 409);
    if (reference.field === 'parent' && (target.entity.entity !== 'work_item' || target.entity.project !== after.project))
      throw new DomainError('project_mismatch', 'Parent must be a work item in the same project', 409);
  }
}
