import { z } from 'zod';
import { agentChatToolResultFields } from './pm-tool-shared.ts';
import {
  automationWireCapabilitiesSchema, automationWireConfigSchema, automationWireDefinitionSchema,
  automationWireExecutionSchema, automationWireExecutionEventSchema, automationWireValidationSchema,
  automationWireSnapshotSchema, automationWireAnalysisResultSchema, automationWireCandidatePreviewSchema,
  automationWireReviewReceiptSchema, automationWireTransferLimits, automationWireBundleSchema,
  automationWireSourceDocumentSchema, automationWireGitConfigSchema,
} from './pm-tool-automation-wire.ts';

const uuid = z.uuid().toLowerCase(), timestamp = z.iso.datetime(), text = z.string().max(2000000);
const error = z.strictObject({ code: z.string().max(300), message: text });
export const automationStudioReceiptSchema = z.strictObject({ requestId: uuid, httpStatus: z.number().int().min(100).max(599), result: z.union([automationWireDefinitionSchema, automationWireExecutionSchema, z.strictObject({ deleted: z.literal(true) }), z.strictObject({ error, httpStatus: z.number().int().min(400).max(599) })]) });
export const automationImportReceiptSchema = z.strictObject({ requestId: uuid, status: z.enum(['pending', 'completed', 'rejected']), definition: automationWireDefinitionSchema.nullable(), error: error.nullable() });
export const automationBundleResultSchema = z.strictObject({ bundleId: uuid, sha256: z.string().regex(/^[a-f0-9]{64}$/), files: z.array(z.strictObject({ path: z.string().max(500), content: text })).max(automationWireTransferLimits.files) });
export const automationGitOperationSchema = z.strictObject({ id: uuid, status: z.enum(['pending', 'running', 'completed', 'failed', 'outcome_unknown']), commit: text.nullable(), startedAt: timestamp.nullable(), finishedAt: timestamp.nullable(), error: text.nullable() });
export const automationGitStatusSchema = z.strictObject({ revision: z.number().int().nonnegative(), config: automationWireGitConfigSchema.nullable(), tokenSet: z.boolean(), encryptionKeySet: z.boolean(), capability: z.strictObject({ available: z.boolean(), reason: text.nullable(), secretsAvailable: z.boolean() }), lastCommit: text.nullable(), lastSyncedAt: timestamp.nullable(), dirtyCount: z.number().int().nonnegative(), operation: automationGitOperationSchema.nullable() });
export const automationGitReceiptSchema = z.strictObject({ requestId: uuid, status: z.enum(['completed', 'rejected']), result: z.union([automationGitStatusSchema, automationGitOperationSchema, z.strictObject({ savedRevision: z.number().int().positive() })]).nullable(), error: error.nullable() });
const template = z.strictObject({ id: z.string().max(300), name: z.string().max(1000), category: z.string().max(300), description: z.string().max(20000), version: text.nullable(), source: z.enum(['pm', 'openhands']), maturity: z.enum(['stable', 'beta']), recommended: z.boolean(), triggers: z.array(z.string().max(100)).max(10), configurationGuide: z.string().max(300000) });
const fields = agentChatToolResultFields;
export const AutomationToolResultSchema = z.union([
  z.strictObject({ kind: z.literal('automation_capabilities'), capabilities: automationWireCapabilitiesSchema, ...fields }),
  z.strictObject({ kind: z.literal('automation_templates'), templates: z.array(template).max(100), ...fields }),
  z.strictObject({ kind: z.literal('automation_timezones'), timezones: z.array(z.string().max(100)).max(100), ...fields }),
  z.strictObject({ kind: z.literal('automation_validation'), validation: automationWireValidationSchema, ...fields }),
  z.strictObject({ kind: z.literal('automation_definitions'), definitions: z.array(automationWireDefinitionSchema).max(50), ...fields }),
  z.strictObject({ kind: z.literal('automation_definition'), definition: automationWireDefinitionSchema, ...fields }),
  z.strictObject({ kind: z.literal('automation_deleted'), deleted: z.literal(true), ...fields }),
  z.strictObject({ kind: z.literal('automation_executions'), executions: z.array(automationWireExecutionSchema).max(50), ...fields }),
  z.strictObject({ kind: z.literal('automation_execution'), execution: automationWireExecutionSchema, ...fields }),
  z.strictObject({ kind: z.literal('automation_logs'), logs: z.array(automationWireExecutionEventSchema).max(200), ...fields }),
  z.strictObject({ kind: z.literal('automation_studio_receipt'), original: automationStudioReceiptSchema, ...fields }),
  z.strictObject({ kind: z.literal('automation_snapshot'), snapshot: automationWireSnapshotSchema, ...fields }),
  z.strictObject({ kind: z.literal('automation_result'), result: automationWireAnalysisResultSchema, ...fields }),
  z.strictObject({ kind: z.literal('automation_preview'), preview: automationWireCandidatePreviewSchema, ...fields }),
  z.strictObject({ kind: z.literal('automation_review_receipt'), original: automationWireReviewReceiptSchema, ...fields }),
  z.strictObject({ kind: z.literal('automation_transfer_preview'), preview: z.strictObject({ format: z.enum(['source', 'bundle']), config: automationWireConfigSchema, warnings: z.array(z.string().max(10000)).max(100), validation: automationWireValidationSchema }), ...fields }),
  z.strictObject({ kind: z.literal('automation_import_receipt'), original: automationImportReceiptSchema, ...fields }),
  z.strictObject({ kind: z.literal('automation_export'), exported: z.strictObject({ filename: z.string().max(500), document: z.union([automationWireBundleSchema, automationWireSourceDocumentSchema]), limits: z.strictObject({ jsonBytes: z.literal(automationWireTransferLimits.jsonBytes), archiveBytes: z.literal(automationWireTransferLimits.archiveBytes), expandedBytes: z.literal(automationWireTransferLimits.expandedBytes), files: z.literal(automationWireTransferLimits.files) }) }), ...fields }),
  z.strictObject({ kind: z.literal('automation_bundle'), bundle: automationBundleResultSchema, ...fields }),
  z.strictObject({ kind: z.literal('automation_git_status'), status: automationGitStatusSchema, ...fields }),
  z.strictObject({ kind: z.literal('automation_git_operation'), operation: automationGitOperationSchema, ...fields }),
  z.strictObject({ kind: z.literal('automation_git_receipt'), original: automationGitReceiptSchema, ...fields }),
  z.strictObject({ kind: z.literal('automation_git_check'), check: z.strictObject({ readable: z.boolean(), remoteCommit: text.nullable(), pushPermissionVerified: z.literal(false), encryptionKeyVerified: z.literal(false) }), ...fields }),
]);
export type AutomationToolResult = z.infer<typeof AutomationToolResultSchema>;
