import { z } from 'zod';
import type { Capability } from '../../domain/src/core.ts';
import { studioActionKindSchema, studioConfigSchema, studioCreateSchema, studioUpdateSchema, studioRevisionSchema, studioStatusSchema, studioDispatchSchema } from '../../contracts/src/automation-studio.ts';
import { pmAutomationCandidateEditSchema, pmAutomationPreviewRequestSchema, pmAutomationApplyRequestSchema, pmAutomationReviewRequestSchema } from '../../contracts/src/automation-pm.ts';
import { automationBundleSchema, sourceAutomationSchema, automationBundleUploadSchema } from '../../contracts/src/automation-transfer.ts';
import { automationGitConfigSchema, automationGitRunSchema } from '../../contracts/src/automation-git-sync.ts';

const uuid = z.uuid().toLowerCase(), projectId = z.string().regex(/^PRJ-\d+$/);
const project = { projectId }, definition = { ...project, definitionId: uuid }, execution = { ...project, executionId: uuid };
const candidate = { ...execution, candidateId: z.string().min(1).max(300) };
const receipt = z.strictObject({ ...project, requestId: uuid });
const transfer = { ...project, document: z.union([automationBundleSchema, sourceAutomationSchema]), providerInstanceId: z.string().min(1).max(200).optional(), model: z.string().min(1).max(200).optional() };
export const AutomationToolInputSchemas = {
  pm_automation_capabilities: z.strictObject({ ...project, actionKind: studioActionKindSchema.optional() }),
  pm_automation_templates: z.strictObject({ ...project, templateId: z.string().min(1).max(300).optional(), source: z.enum(['pm', 'openhands']).optional() }),
  pm_automation_timezones: z.strictObject({ ...project, search: z.string().max(100).optional(), after: z.string().max(100).optional() }),
  pm_automation_definitions: z.strictObject({ ...project, cursor: uuid.optional(), quickAccess: z.boolean().optional() }),
  pm_automation_definition: z.strictObject(definition),
  pm_automation_validate: z.strictObject({ ...project, config: studioConfigSchema }),
  pm_automation_create: studioCreateSchema.omit({ requestId: true }).extend(project),
  pm_automation_update: studioUpdateSchema.omit({ requestId: true }).extend(definition),
  pm_automation_status: studioStatusSchema.omit({ requestId: true }).extend(definition),
  pm_automation_remove: studioRevisionSchema.omit({ requestId: true }).extend(definition),
  pm_automation_run: studioDispatchSchema.omit({ requestId: true }).extend(definition),
  pm_automation_test: studioDispatchSchema.omit({ requestId: true }).extend(definition),
  pm_automation_executions: z.strictObject({ ...project, definitionId: uuid.optional(), cursor: uuid.optional() }),
  pm_automation_execution: z.strictObject(execution),
  pm_automation_logs: z.strictObject({ ...execution, cursor: z.string().regex(/^\d{1,16}$/).optional() }),
  pm_automation_query: z.strictObject(execution),
  pm_automation_cancel: z.strictObject(execution),
  pm_automation_receipt: receipt,
  pm_automation_snapshot: z.strictObject(execution),
  pm_automation_result: z.strictObject(execution),
  pm_automation_candidate_edit: pmAutomationCandidateEditSchema.omit({ requestId: true }).extend(candidate),
  pm_automation_candidate_preview: pmAutomationPreviewRequestSchema.omit({ requestId: true }).extend(candidate),
  pm_automation_candidate_apply: pmAutomationApplyRequestSchema.omit({ requestId: true }).extend(candidate),
  pm_automation_candidate_ignore: pmAutomationReviewRequestSchema.omit({ requestId: true }).extend(candidate),
  pm_automation_review_receipt: receipt,
  pm_automation_import_preview: z.strictObject(transfer),
  pm_automation_import: z.strictObject(transfer),
  pm_automation_import_receipt: receipt,
  pm_automation_export: z.strictObject({ ...definition, format: z.enum(['source', 'bundle']) }),
  pm_automation_bundle_upload: automationBundleUploadSchema.omit({ requestId: true }),
  pm_automation_bundle_receipt: receipt,
  pm_automation_git_status: z.strictObject(project),
  // Operator-only secret entry stays in the native CLI. These preserve configured secrets.
  pm_automation_git_save: z.strictObject({ ...project, expectedRevision: z.number().int().nonnegative(), config: automationGitConfigSchema }),
  pm_automation_git_check: z.strictObject({ ...project, config: automationGitConfigSchema }),
  pm_automation_git_sync: automationGitRunSchema.omit({ requestId: true }),
  pm_automation_git_reconcile: automationGitRunSchema.omit({ requestId: true }),
  pm_automation_git_receipt: receipt,
} as const;
export type AutomationToolName = keyof typeof AutomationToolInputSchemas;
const writes: Partial<Record<AutomationToolName, true>> = { pm_automation_create: true, pm_automation_update: true, pm_automation_status: true, pm_automation_remove: true, pm_automation_run: true, pm_automation_test: true, pm_automation_query: true, pm_automation_cancel: true, pm_automation_candidate_edit: true, pm_automation_candidate_apply: true, pm_automation_candidate_ignore: true, pm_automation_import: true, pm_automation_bundle_upload: true, pm_automation_git_save: true, pm_automation_git_sync: true, pm_automation_git_reconcile: true };
const descriptions: Record<AutomationToolName, string> = {
  pm_automation_capabilities: 'Read actual automation runtime, Provider and worker availability; unavailable is not success.',
  pm_automation_templates: 'Read the pinned template catalog and complete setup guide; catalog presence does not prove runtime readiness.',
  pm_automation_timezones: 'Page supported IANA time zones. Cron uses the current native scheduler and DST semantics.',
  pm_automation_definitions: 'Page own authorized project definitions, optionally filtering quick-access before pagination.',
  pm_automation_definition: 'Read the saved automation configuration and revision.',
  pm_automation_validate: 'Validate a configuration without saving or executing; return native next due time and explicit blocking reasons.',
  pm_automation_create: 'Save an automation draft only; never enables or executes it.',
  pm_automation_update: 'CAS-update the saved definition including trigger, timezone and quickAccess; does not execute.',
  pm_automation_status: 'CAS-enable or pause scheduling. Enabling does not run now; pausing does not cancel a running execution.',
  pm_automation_remove: 'CAS-delete the definition while preserving original execution and receipt evidence.',
  pm_automation_run: 'Explicitly queue a real execution of the exact saved revision; queued/completed is not PM task completion.',
  pm_automation_test: 'Really execute an immutable saved snapshot as a test; this is NOT a read-only preview and may have external side effects.',
  pm_automation_executions: 'Page actual project executions and their immutable saved configurations.',
  pm_automation_execution: 'Read the original execution and its known outcome without redispatching.',
  pm_automation_logs: 'Read the next complete native log page using its sequence cursor.',
  pm_automation_query: 'Reconcile only the original execution with its runtime identity; never redispatch unknown work.',
  pm_automation_cancel: 'Request cancellation of the original execution; cancel_requested is not confirmed cancellation.',
  pm_automation_receipt: 'Read an original Studio management/run/test/cancel request receipt under current project authorization.',
  pm_automation_snapshot: 'Read the immutable authorized PM source snapshot; cannot freeze or replace service-owned sources.',
  pm_automation_result: 'Read published PM findings and current typed candidate review states.',
  pm_automation_candidate_edit: 'CAS-edit a proposal with explicit current review sources; immutable original evidence and identity cannot change.',
  pm_automation_candidate_preview: 'Preview with source revision protection and exact selected plan prerequisite closure; records the original preview receipt but never mutates business objects or dispatches.',
  pm_automation_candidate_apply: 'Explicitly apply the reviewed preview token and selected closure using existing PM services and original per-step receipts. Never completes/cancels tasks.',
  pm_automation_candidate_ignore: 'CAS-ignore this specific proposal without applying any business mutation.',
  pm_automation_review_receipt: 'Reconcile only the original review/apply request and original idMap; never start missing steps or create another request.',
  pm_automation_import_preview: 'Read-only lossless source/bundle import preview; imported definitions default to drafts.',
  pm_automation_import: 'Import the explicit document as a draft using one durable original import identity.',
  pm_automation_import_receipt: 'Read/reconcile the original import receipt without reimporting.',
  pm_automation_export: 'Export an authorized definition as a PM bundle or losslessly representable source document.',
  pm_automation_bundle_upload: 'Validate and retain the explicit bounded text tarball; never execute uploaded scripts.',
  pm_automation_bundle_receipt: 'Read the original uploaded bundle and hash without uploading again.',
  pm_automation_git_status: 'Read Git Sync configuration, capability, drift and original operation state without network writes.',
  pm_automation_git_save: 'CAS-save Git Sync configuration while retaining existing secrets. No sync or automatic candidate approval.',
  pm_automation_git_check: 'Explicitly check the configured remote readability; does not prove push permission or decryptability.',
  pm_automation_git_sync: 'Explicitly enqueue existing Git Sync with its native remote/local CAS and drift protection.',
  pm_automation_git_reconcile: 'Select only the existing unknown Git operation for native reconciliation, never create a replacement sync.',
  pm_automation_git_receipt: 'Read the original Git Sync management receipt and current original operation, never resubmit.',
};
export const AutomationToolMetadata = Object.fromEntries((Object.keys(AutomationToolInputSchemas) as AutomationToolName[]).map(name => [name, {
  description: descriptions[name], write: writes[name] === true, capabilities: ((writes[name] && !name.startsWith('pm_automation_candidate_')) || name === 'pm_automation_git_check' ? ['domain.read', 'planning.edit'] : ['domain.read']) as Capability[], scope: 'project' as const,
}])) as Record<AutomationToolName, { description: string; write: boolean; capabilities: Capability[]; scope: 'project' }>;
