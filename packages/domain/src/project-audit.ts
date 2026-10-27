import { z } from 'zod';

export type ProjectAuditValue = string | number | boolean | null;
export type ProjectAuditChange = { field: string; before: ProjectAuditValue; after: ProjectAuditValue };
export type ProjectAuditEntry = {
  id: string;
  projectId: string;
  source: 'command' | 'core_http';
  commandId: string;
  action: string;
  actorId: string;
  occurredAt: string;
  targetId: string;
  targetKind: string;
  beforeVersion: string | null;
  afterVersion: string | null;
  changes: ProjectAuditChange[];
  private: boolean;
};
export type ProjectAuditOptions = { cursor?: string; limit?: number };
export type ProjectAuditPage = { projectId: string; entries: ProjectAuditEntry[]; nextCursor: string | null };

/** Excludes body text, notes, messages, custom fields, source, paths and bytes. */
export const PROJECT_AUDIT_FIELDS = [
  'name', 'title', 'status', 'priority', 'archived', 'archivedAt', 'ownerId', 'assigneeId',
  'startDate', 'dueDate', 'targetDate', 'due', 'start', 'end', 'owner', 'assignee', 'x-pm-start',
  'favorite', 'artifactVersionId', 'mediaType', 'currency', 'budgetMinor', 'amountMinor',
  'remainingEstimateMinor', 'actualMinor', 'forecastMinor', 'asOfDate', 'spentOn', 'confidence',
  'completed', 'itemCount', 'completedCount', 'memberCount', 'teamCount', 'hiddenAt', 'hiddenBy',
] as const;

const auditValueSchema = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);
export const projectAuditChangeSchema = z.object({ field: z.enum(PROJECT_AUDIT_FIELDS), before: auditValueSchema, after: auditValueSchema }).strict();
export const projectAuditEntrySchema = z.object({
  id: z.string().regex(/^[1-9]\d*$/), projectId: z.string().min(1).max(80),
  source: z.enum(['command', 'core_http']), commandId: z.string().min(1).max(128), action: z.string().min(1).max(100),
  actorId: z.uuid(), occurredAt: z.iso.datetime({ offset: true }), targetId: z.string().min(1).max(80), targetKind: z.string().min(1).max(80),
  beforeVersion: z.string().min(1).max(128).nullable(), afterVersion: z.string().min(1).max(128).nullable(),
  changes: z.array(projectAuditChangeSchema).max(40), private: z.boolean(),
}).strict();
export const projectAuditPageSchema = z.object({ projectId: z.string().min(1).max(80), entries: z.array(projectAuditEntrySchema), nextCursor: z.string().max(2048).nullable() }).strict();

/** Only scalar values of explicitly allowed fields survive the audit boundary. */
export function projectAuditChanges(before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): ProjectAuditChange[] {
  const changes: ProjectAuditChange[] = [];
  const value = (input: unknown): ProjectAuditValue => {
    if (typeof input === 'string') return input.length <= 500 ? input : null;
    if (typeof input === 'boolean' || typeof input === 'number' && Number.isFinite(input)) return input;
    return null;
  };
  for (const field of PROJECT_AUDIT_FIELDS) {
    const previous = value(before[field]), next = value(after[field]);
    if (previous !== next) changes.push({ field, before: previous, after: next });
  }
  return changes;
}
