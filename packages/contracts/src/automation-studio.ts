import { z } from 'zod';
import { isPmAutomationTemplateId, pmAutomationArgumentsSchema, pmAutomationTemplateIds, pmAutomationTemplateVersion } from './automation-pm.ts';
import { pmAutomationTemplateCapabilities, pmAutomationTemplateRequiresProvider } from './automation-pm.ts';
import { executionSelectionSchema, type ExecutionEnvironment, type ExecutionSelection } from '../../agent-contracts/src/execution.ts';

const uuid = z.uuid().toLowerCase();
const timestamp = z.iso.datetime();
export const studioTimezoneSchema = z.string().min(1).max(100).refine(value => {
  if (/^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, 'Expected an IANA time zone');
export const studioTriggerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual') }),
  z.strictObject({ kind: z.literal('once'), at: timestamp, timezone: studioTimezoneSchema }),
  z.strictObject({ kind: z.literal('cron'), expression: z.string().trim().min(9).max(200), timezone: studioTimezoneSchema }),
  z.strictObject({ kind: z.literal('event'), source: z.string().min(1).max(100), key: z.string().min(1).max(200), filter: z.record(z.string(), z.unknown()) }),
]);
export const studioRepositorySchema = z.strictObject({ id: z.string().min(1).max(300), ref: z.string().max(300).nullable() });
export const studioPluginSchema = z.strictObject({ id: z.string().min(1).max(300), version: z.string().max(100).nullable() });
const actionCommon = {
  repositories: z.array(studioRepositorySchema).max(20), plugins: z.array(studioPluginSchema).max(30),
  timeoutSeconds: z.number().int().min(1).max(86400),
  executionSelection: executionSelectionSchema.optional(),
};
/** Native model-option selections only; Provider credentials are resolved privately by the Agent. */
const studioOptionId = z.string().min(1).max(200).refine(value => !/^(?:api.?key|access.?token|refresh.?token|auth(?:orization)?|cookie|password|secret|credentials?|headers?)$/i.test(value), 'Credential fields are not model options');
export const studioProviderOptionsSchema = z.record(studioOptionId, z.union([z.string().max(4000), z.boolean()]));
const modelSelection = { providerInstanceId: z.string().min(1).max(200), model: z.string().min(1).max(200), options: studioProviderOptionsSchema };
export const studioActionKindSchema = z.enum(['prompt', 'script', 'template']);
export type StudioActionKind = z.infer<typeof studioActionKindSchema>;
export const studioNativeTemplateIdSchema = z.enum(['github-pr-reviewer', 'github-issue-to-pr', 'gitlab-issue-to-mr', 'github-agents-md-maintainer', 'github-delivery-watchdog', 'github-issue-triage', 'news-digest', 'github-stale-ci-pr-closer', ...pmAutomationTemplateIds]);
export type StudioNativeTemplateId = z.infer<typeof studioNativeTemplateIdSchema>;
/** Deterministic PM rules and source maintenance never invoke a model; semantic analysis requires an explicit no-tools Provider. */
export function studioNativeTemplateRequiresProvider(id: StudioNativeTemplateId): boolean {
  if (isPmAutomationTemplateId(id)) return pmAutomationTemplateRequiresProvider(id);
  return id !== 'github-delivery-watchdog' && id !== 'github-stale-ci-pr-closer';
}
/** Provider workspace-tool transport is required for these five; OCI command support is a separate runtime prerequisite. */
export function studioNativeTemplateRequiresWorkspace(id: StudioNativeTemplateId): boolean {
  if (isPmAutomationTemplateId(id)) return pmAutomationTemplateCapabilities[id].requiresWorkspace;
  switch (id) {
    case 'github-pr-reviewer':
    case 'github-issue-to-pr':
    case 'github-issue-triage':
    case 'github-agents-md-maintainer':
    case 'gitlab-issue-to-mr': return true;
    default: return false;
  }
}
export const studioActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('prompt'), ...actionCommon, ...modelSelection, prompt: z.string().trim().min(1).max(200000) }),
  z.strictObject({ kind: z.literal('script'), ...actionCommon, entrypoint: z.string().min(1).max(500), setup: z.string().max(50000), content: z.string().max(1000000), bundleRef: z.string().max(500).nullable(), files: z.array(z.strictObject({ path: z.string().min(1).max(500), content: z.string().max(1000000) })).max(200) }),
  z.strictObject({ kind: z.literal('template'), ...actionCommon, ...modelSelection, providerInstanceId: modelSelection.providerInstanceId.nullable(), model: modelSelection.model.nullable(), templateId: studioNativeTemplateIdSchema, arguments: z.record(z.string(), z.unknown()) }).superRefine((action, context) => {
    if (isPmAutomationTemplateId(action.templateId)) {
      const parsed = pmAutomationArgumentsSchema.safeParse(action.arguments);
      if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ code: 'custom', path: ['arguments', ...issue.path], message: issue.message });
      if (action.repositories.length) context.addIssue({ code: 'custom', path: ['repositories'], message: 'PM analysis does not accept workspace repositories' });
      if (action.templateId === 'pm-pr-acceptance-coverage') {
        if (action.plugins.length > 1 || action.plugins.some(plugin => !plugin.id.startsWith('integration:') || !plugin.version)) context.addIssue({ code: 'custom', path: ['plugins'], message: 'PR analysis accepts at most one explicitly revisioned native API connection; PM revalidates read-only GitHub/GitLab capability' });
      } else if (action.plugins.length) context.addIssue({ code: 'custom', path: ['plugins'], message: 'PM analysis does not accept external plugins' });
    }
    if (!studioNativeTemplateRequiresProvider(action.templateId)) return;
    if (action.providerInstanceId === null) context.addIssue({ code: 'custom', path: ['providerInstanceId'], message: 'This native template requires an explicit Provider instance' });
    if (action.model === null) context.addIssue({ code: 'custom', path: ['model'], message: 'This native template requires an explicit model' });
  }).meta({
    description: 'Provider/model may be explicitly null only for deterministic native templates. Semantic PM analysis requires an explicit generation-scoped no-tools Provider. No implicit Provider defaults.',
    allOf: [{
      if: { properties: { templateId: { enum: studioNativeTemplateIdSchema.options.filter(studioNativeTemplateRequiresProvider) } }, required: ['templateId'] },
      then: { properties: { providerInstanceId: { type: 'string', minLength: 1, maxLength: 200 }, model: { type: 'string', minLength: 1, maxLength: 200 } } },
    }],
  }),
]);
export const studioConfigSchema = z.strictObject({
  name: z.string().trim().min(1).max(160), description: z.string().max(4000), projectId: z.string().regex(/^PRJ-\d+$/),
  tags: z.array(z.string().trim().min(1).max(100)).max(30), templateId: z.string().max(300).nullable(),
  templateInputs: z.record(z.string(), z.unknown()).optional(), templateVersion: z.string().max(200).nullable().optional(),
  quickAccess: z.boolean().optional().describe('Show this saved definition in the authorized project assistant shortcuts. Omitted means false; it grants no execution authority.'),
  action: studioActionSchema, trigger: studioTriggerSchema,
  dailyLimit: z.number().int().min(1).max(100), cooldownMinutes: z.number().int().min(0).max(10080),
}).superRefine((config, context) => {
  if (config.action.kind !== 'template' || !isPmAutomationTemplateId(config.action.templateId)) {
    if (config.templateId && isPmAutomationTemplateId(config.templateId)) context.addIssue({ code: 'custom', path: ['action'], message: 'PM catalogue entries must use their registered native template action' });
    return;
  }
  if (config.templateId !== config.action.templateId) context.addIssue({ code: 'custom', path: ['templateId'], message: 'PM template provenance must match the native action' });
  if (config.templateVersion !== pmAutomationTemplateVersion) context.addIssue({ code: 'custom', path: ['templateVersion'], message: 'Freeze the current PM template version explicitly' });
  const inputs = pmAutomationArgumentsSchema.safeParse(config.templateInputs);
  const args = pmAutomationArgumentsSchema.safeParse(config.action.arguments);
  if (!inputs.success || !args.success || JSON.stringify(inputs.data) !== JSON.stringify(args.data)) context.addIssue({ code: 'custom', path: ['templateInputs'], message: 'Freeze the same validated arguments in templateInputs and action.arguments' });
});
export type StudioConfig = z.infer<typeof studioConfigSchema>;
/** Repository-materializing templates and scripts cannot execute in chat-only scratch. */
export function studioActionRequiresAgentWorkspace(action: StudioConfig['action']): boolean {
  return action.kind === 'script' || action.kind === 'template' && studioNativeTemplateRequiresWorkspace(action.templateId);
}
/**
 * UI confirmation policy only: registered PM handlers persist analysis/candidates, never apply them.
 * Their model phase has no tools; the PR host can only read its frozen scope. Runtime support,
 * current authorization, revision and dispatch budgets remain server-owned checks.
 */
export function studioCanRunWithoutConfirmation(config: StudioConfig): boolean {
  if (config.action.kind !== 'template' || !isPmAutomationTemplateId(config.action.templateId)) return false;
  return studioConfigSchema.safeParse(config).success;
}
export type StudioDefinitionFilters = { projectId?: string; quickAccess?: boolean };
/** Feature identity advertised by the selected Provider's actual native tool adapter, not by its model name. */
export function studioRequiredProviderToolFeature(config: StudioConfig): string | null {
  const action = config.action;
  if (action.kind === 'prompt' && action.plugins.length > 0) return `provider:${action.providerInstanceId}:promptConnectors`;
  if (action.kind === 'template' && isPmAutomationTemplateId(action.templateId) && studioNativeTemplateRequiresProvider(action.templateId)) return `provider:${action.providerInstanceId ?? ''}:pmAnalysis`;
  if (action.kind === 'template' && studioNativeTemplateRequiresWorkspace(action.templateId)) return `provider:${action.providerInstanceId ?? ''}:templateWorkspace`;
  return null;
}
/** Historical selections are forensic data only, never valid input to an execution. */
const historicalExecutionFields = {
  historicalExecutionSelection: z.unknown().optional(),
  executionUnavailableReason: z.literal('agent_workspace_selection_required').optional(),
};
export const studioDefinitionSchema = z.strictObject({
  id: uuid, revision: z.number().int().positive(), config: studioConfigSchema, status: z.enum(['draft', 'enabled', 'paused']), ...historicalExecutionFields,
  createdAt: timestamp, updatedAt: timestamp, lastRunAt: timestamp.nullable(), nextDueAt: timestamp.nullable(),
});
export type StudioDefinition = z.infer<typeof studioDefinitionSchema>;
export const studioExecutionStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'skipped', 'cancel_requested', 'cancelled', 'outcome_unknown']);
export const studioExecutionEventSchema = z.strictObject({ sequence: z.number().int().positive(), at: timestamp, kind: z.enum(['queued', 'dispatch', 'status', 'log', 'cancel', 'error']), message: z.string(), stream: z.enum(['stdout', 'stderr', 'system']).nullable() });
export type StudioExecutionEvent = z.infer<typeof studioExecutionEventSchema>;
export const studioExecutionSchema = z.strictObject({
  id: uuid, definitionId: uuid, definitionRevision: z.number().int().positive(), configSnapshot: studioConfigSchema, ...historicalExecutionFields,
  trigger: z.enum(['manual', 'scheduled', 'event', 'test']), requestId: uuid, status: studioExecutionStatusSchema,
  createdAt: timestamp, startedAt: timestamp.nullable(), finishedAt: timestamp.nullable(), threadId: z.string().nullable(),
  externalExecutionId: z.string().nullable(), error: z.string().nullable(), summary: z.string(),
});
export type StudioExecution = z.infer<typeof studioExecutionSchema>;
export const studioRuntimeCapabilitiesSchema = z.strictObject({
  actions: z.array(z.strictObject({ id: studioActionKindSchema, available: z.boolean(), reason: z.string().nullable() })),
  providers: z.array(z.strictObject({ id: z.string(), name: z.string(), models: z.array(z.string()) })),
  repositories: z.array(z.strictObject({ id: z.string(), name: z.string() })),
  plugins: z.array(z.strictObject({ id: z.string(), name: z.string(), version: z.string().nullable() })),
  features: z.array(z.strictObject({ id: z.string(), available: z.boolean(), reason: z.string().nullable() })).optional().describe('Actual runtime prerequisites. Provider-specific native tool gates use provider:<instanceId>:promptConnectors and provider:<instanceId>:templateWorkspace; missing required features fail closed. Template workspace-tool transport is distinct from OCI command support.'),
});
export type StudioRuntimeCapabilities = z.infer<typeof studioRuntimeCapabilitiesSchema>;
export const studioCapabilitiesSchema = studioRuntimeCapabilitiesSchema.extend({ canWrite: z.boolean(), scheduler: z.strictObject({ authority: z.literal('worker'), ready: z.boolean(), reason: z.string().nullable() }) });
export type StudioCapabilities = z.infer<typeof studioCapabilitiesSchema>;
export const studioValidationSchema = z.strictObject({ valid: z.boolean(), issues: z.array(z.strictObject({ path: z.string(), code: z.string(), message: z.string() })), nextDueAt: timestamp.nullable() });
export type StudioValidation = z.infer<typeof studioValidationSchema>;
export const studioCreateSchema = z.strictObject({ requestId: uuid, config: studioConfigSchema });
export const studioRevisionSchema = z.strictObject({ requestId: uuid, expectedRevision: z.number().int().positive() });
export const studioUpdateSchema = studioRevisionSchema.extend({ config: studioConfigSchema });
export const studioStatusSchema = studioRevisionSchema.extend({ status: z.enum(['enabled', 'paused']) });
export const studioDispatchSchema = studioRevisionSchema.extend({ payload: z.record(z.string(), z.unknown()).optional() });
export const studioCancelSchema = z.strictObject({ requestId: uuid });
export type StudioPage<T> = { items: T[]; nextCursor: string | null };
export const studioPageSchema = <T extends z.ZodType>(item: T) => z.strictObject({ items: z.array(item), nextCursor: z.string().nullable() });
export type StudioReceipt = { requestId: string; result: unknown; httpStatus: number };

/** No browser cookie or credentials cross this boundary. Core reauthorizes before each call. */
export type StudioExecutionScope = { actorId: string; workspaceId: string; projectId: string };
export const studioExecutionRequestSchema = z.strictObject({
  executionId: uuid, requestId: uuid, actorId: uuid, workspaceId: uuid, projectId: z.string().regex(/^PRJ-\d+$/),
  definitionId: uuid, definitionRevision: z.number().int().positive(), config: studioConfigSchema,
  trigger: z.enum(['manual', 'scheduled', 'event', 'test']), payload: z.record(z.string(), z.unknown()).nullable(), issuedAt: timestamp,
});
export type StudioExecutionRequest = z.infer<typeof studioExecutionRequestSchema>;
export const studioExecutionResultSchema = z.strictObject({
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'outcome_unknown']), externalExecutionId: z.string().nullable(),
  threadId: z.string().nullable(), summary: z.string(), error: z.string().nullable(),
  logs: z.array(z.strictObject({ id: z.string(), at: timestamp, message: z.string(), stream: z.enum(['stdout', 'stderr', 'system']) })),
});
export type StudioExecutionResult = z.infer<typeof studioExecutionResultSchema>;
export interface StudioExecutionPort {
  capabilities(scope: StudioExecutionScope): Promise<StudioRuntimeCapabilities>;
  dispatch(request: StudioExecutionRequest): Promise<StudioExecutionResult>;
  query(request: StudioExecutionRequest): Promise<StudioExecutionResult>;
  cancel(request: StudioExecutionRequest): Promise<StudioExecutionResult>;
}

/** Dedicated PM-to-Agent authenticated preflight; no PM directory or scratch fallback. */
export interface StudioWorkspaceExecutionPort {
  resolve(selection: ExecutionSelection): Promise<{ path: string; environment: ExecutionEnvironment }>;
}
