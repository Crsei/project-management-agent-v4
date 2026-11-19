import { z } from 'zod';
import type { Pool } from 'pg';
import { DomainError, type Actor } from '../../../../packages/domain/src/core.ts';
import type { NotificationCorePort } from '../../../../packages/pm-core/readonly.ts';
import type { SqlExecutor } from '../../../../packages/application/src/ports.ts';
import { requireCapability } from '../../../../packages/application/src/access.ts';
import { assertAgentToolNotAborted, assertAgentToolProject, type AgentChatToolContext } from '../../../../packages/application/src/agent-chat-tools.ts';
import { AutomationToolInputSchemas as schemas, type AutomationToolName } from '../../../../packages/application/src/agent-tool-automation.ts';
import { AutomationToolResultSchema } from '../../../../packages/agent-contracts/src/pm-tool-automation.ts';
import { createAutomationStudioService } from '../../../../packages/application/src/automation-studio.ts';
import { createPmAutomationService, type PmAutomationMutationPort } from '../../../../packages/application/src/automation-pm.ts';
import { createAutomationTransferService, deterministicAutomationId } from '../../../../packages/application/src/automation-transfer.ts';
import { createAutomationGitSyncService } from '../../../../packages/application/src/automation-git-sync.ts';
import { automationSnapshot, authorizeAutomationProject } from '../../../../packages/application/src/automation-report.ts';
import { requestHash } from '../../../../packages/application/src/kernel.ts';
import { pmSourceHash } from '../../../../packages/application/src/automation-pm-sources.ts';
import type { AutomationDefinitionResolver } from '../../../../packages/application/src/automation-integrations-definitions.ts';
import type { StudioExecutionPort, StudioWorkspaceExecutionPort } from '../../../../packages/contracts/src/automation-studio.ts';
import type { AutomationGitPort } from '../../../../packages/infrastructure/src/automation-git.ts';
import { automationCatalog, automationTemplateSource, automationTemplateMaturity, automationTemplateRecommended, automationTemplateTriggers, automationTemplateLaunchPrompt } from '../../../../packages/automation-resources/catalog.ts';
import type { AgentChatToolFamily, AgentToolRecoveryIdentity, AgentToolOutcomeProof } from './agent-chat-tools.ts';

const automationActions = ['create', 'update', 'status', 'remove', 'run', 'test', 'cancel', 'edit', 'preview', 'apply', 'ignore', 'import', 'bundle', 'git-save', 'git-sync', 'git-reconcile'] as const;
const automationProtocolActions: Record<'studio' | 'review' | 'import' | 'bundle' | 'git', readonly string[]> = { studio: ['create', 'update', 'status', 'remove', 'run', 'test', 'cancel'], review: ['edit', 'preview', 'apply', 'ignore'], import: ['import'], bundle: ['bundle'], git: ['git-save', 'git-sync', 'git-reconcile'] };
export const automationToolRecoveryIdentitySchema = z.strictObject({ kind: z.literal('automation'), protocol: z.enum(['studio', 'review', 'import', 'bundle', 'git']), commandId: z.uuid().toLowerCase(), hash: z.string().regex(/^[a-f0-9]{64}$/), action: z.enum(automationActions) }).superRefine((identity, context) => {
  if (!automationProtocolActions[identity.protocol].includes(identity.action)) context.addIssue({ code: 'custom', path: ['action'], message: 'Action does not belong to the original native automation protocol' });
});
type Identity = z.infer<typeof automationToolRecoveryIdentitySchema>;
export type AutomationToolDependencies = { database: () => Pool; core: NotificationCorePort; runtime: StudioExecutionPort; definitionResolver?: AutomationDefinitionResolver; workspaceExecution?: StudioWorkspaceExecutionPort; mutations?: PmAutomationMutationPort; git?: AutomationGitPort };
const requestIdFor = (context: AgentChatToolContext) => deterministicAutomationId(`automation-tool:${context.workspaceId}:${context.actor.id}:${context.operationId}`);
const unresolved: AgentToolOutcomeProof = { status: 'unknown', evidence: 'unresolved' };
const projectEnvelope = z.object({ projectId: z.string().regex(/^PRJ-\d+$/) });

/** Same original native fingerprint as each existing application service; never a fresh recovery key. */
function identityFor(name: string, input: unknown, context: AgentChatToolContext): Identity | null {
  const requestId = requestIdFor(context);
  const make = (protocol: Identity['protocol'], action: Identity['action'], native: Record<string, unknown>, review = false): Identity => ({ kind: 'automation', protocol, action, commandId: requestId, hash: review ? pmSourceHash(native) : requestHash(native) });
  switch (name) {
    case 'pm_automation_create': { const p = schemas.pm_automation_create.parse(input); return make('studio', 'create', { requestId, config: p.config, kind: 'create' }); }
    case 'pm_automation_update': { const p = schemas.pm_automation_update.parse(input); return make('studio', 'update', { requestId, config: p.config, expectedRevision: p.expectedRevision, kind: 'update', id: p.definitionId }); }
    case 'pm_automation_status': { const p = schemas.pm_automation_status.parse(input); return make('studio', 'status', { requestId, expectedRevision: p.expectedRevision, status: p.status, kind: 'status', id: p.definitionId }); }
    case 'pm_automation_remove': { const p = schemas.pm_automation_remove.parse(input); return make('studio', 'remove', { requestId, expectedRevision: p.expectedRevision, kind: 'remove', id: p.definitionId }); }
    case 'pm_automation_run': case 'pm_automation_test': { const p = schemas.pm_automation_run.parse(input), action = name === 'pm_automation_run' ? 'run' : 'test'; return make('studio', action, { requestId, expectedRevision: p.expectedRevision, ...(p.payload === undefined ? {} : { payload: p.payload }), kind: action, id: p.definitionId }); }
    case 'pm_automation_cancel': { const p = schemas.pm_automation_cancel.parse(input); return make('studio', 'cancel', { requestId, kind: 'cancel', id: p.executionId }); }
    case 'pm_automation_candidate_edit': { const p = schemas.pm_automation_candidate_edit.parse(input); return make('review', 'edit', { executionId: p.executionId, candidateId: p.candidateId, operation: 'edit', input: { requestId, expectedRevision: p.expectedRevision, candidate: p.candidate } }, true); }
    case 'pm_automation_candidate_preview': case 'pm_automation_candidate_apply': case 'pm_automation_candidate_ignore': {
      const p = name === 'pm_automation_candidate_apply' ? schemas.pm_automation_candidate_apply.parse(input) : name === 'pm_automation_candidate_preview' ? schemas.pm_automation_candidate_preview.parse(input) : schemas.pm_automation_candidate_ignore.parse(input);
      const action = name === 'pm_automation_candidate_apply' ? 'apply' : name === 'pm_automation_candidate_preview' ? 'preview' : 'ignore';
      return make('review', action, { executionId: p.executionId, candidateId: p.candidateId, operation: action, input: { requestId, expectedRevision: p.expectedRevision, ...('selectedItemIds' in p && p.selectedItemIds !== undefined ? { selectedItemIds: p.selectedItemIds } : {}), ...('previewToken' in p ? { previewToken: p.previewToken } : {}) } }, true);
    }
    case 'pm_automation_import': { const p = schemas.pm_automation_import.parse(input); return make('import', 'import', { ...p, requestId }); }
    case 'pm_automation_bundle_upload': { const p = schemas.pm_automation_bundle_upload.parse(input); return make('bundle', 'bundle', { ...p, requestId }); }
    case 'pm_automation_git_save': { const p = schemas.pm_automation_git_save.parse(input); return make('git', 'git-save', { requestId, expectedRevision: p.expectedRevision, config: p.config }); }
    case 'pm_automation_git_sync': case 'pm_automation_git_reconcile': { const p = schemas.pm_automation_git_sync.parse(input); return make('git', name === 'pm_automation_git_sync' ? 'git-sync' : 'git-reconcile', { ...p, requestId, reconcileOnly: name === 'pm_automation_git_reconcile' }); }
    default: return null;
  }
}

export function createAutomationToolFamily(options: AutomationToolDependencies): AgentChatToolFamily {
  function services(checkAuthorization?: (sql: SqlExecutor) => Promise<void>, checkSourceProject?: (projectId: string) => void) {
    const guarded = { ...options, ...(checkAuthorization ? { checkAuthorization } : {}), ...(checkSourceProject ? { checkSourceProject } : {}) };
    const studio = createAutomationStudioService(guarded), pm = createPmAutomationService(guarded);
    return { studio, pm, transfer: createAutomationTransferService({ ...guarded, studio }), git: createAutomationGitSyncService({ ...guarded, studio }) };
  }
  function scopedServices(context: AgentChatToolContext, projectId: string) {
    assertAgentToolProject(context.scope, projectId);
    return services(async sql => {
      await context.checkAuthorization?.(sql);
      assertAgentToolProject(context.scope, projectId);
      await requireCapability(sql, context.actor, context.workspaceId, 'domain.read', projectId);
      await authorizeAutomationProject(sql, context.actor, context.workspaceId, projectId, await automationSnapshot(options.core, context.workspaceId));
    }, currentProjectId => assertAgentToolProject(context.scope, currentProjectId));
  }
  async function inspect(identity: Identity, actor: Actor, workspaceId: string, selected = services()) {
    switch (identity.protocol) {
      case 'studio': return selected.studio.inspectReceipt(actor, workspaceId, identity.commandId);
      case 'review': return selected.pm.inspectReceipt(actor, workspaceId, identity.commandId);
      case 'import': case 'bundle': return selected.transfer.inspectReceipt(actor, workspaceId, identity.commandId, identity.protocol);
      case 'git': return selected.git.inspectReceipt(actor, workspaceId, identity.commandId);
    }
  }
  async function original(identity: Identity, context: AgentChatToolContext, projectId: string) {
    const s = scopedServices(context, projectId), proof = await inspect(identity, context.actor, context.workspaceId, s);
    if (proof.hash !== identity.hash || !proof.projectIds.includes(projectId)) return null;
    if (proof.projectIds.some(id => !context.scope.projectIds.includes(id))) throw new DomainError('not_found_or_forbidden', 'Original automation request is outside the current tool scope', 404);
    if (proof.status === 'failed') throw new DomainError('agent_tool_recovered_rejection', 'The original automation request was durably rejected; inspect its original receipt before another decision', 409);
    // Pending native recovery remains unknown here. Explicit original-receipt tools own any
    // native evidence repair; automatic /result recovery never repairs or starts a step.
    if (proof.status === 'unknown') return null;
    const common = { nextCursor: null, truncated: false, sources: [] };
    const receipt = { kind: 'application' as const, operationId: context.operationId, commandId: identity.commandId, action: `automation.${identity.action}`, targetId: null, revision: null, ...(context.linkage ? { linkage: context.linkage } : {}) };
    switch (identity.protocol) {
      case 'studio': return AutomationToolResultSchema.parse({ kind: 'automation_studio_receipt', original: await s.studio.receipt(context.actor, context.workspaceId, identity.commandId), ...common, receipt });
      case 'review': return AutomationToolResultSchema.parse({ kind: 'automation_review_receipt', original: await s.pm.receipt(context.actor, context.workspaceId, identity.commandId), ...common, receipt });
      case 'import': return AutomationToolResultSchema.parse({ kind: 'automation_import_receipt', original: await s.transfer.receipt(context.actor, context.workspaceId, identity.commandId), ...common, receipt });
      case 'bundle': return AutomationToolResultSchema.parse({ kind: 'automation_bundle', bundle: await s.transfer.uploadBundleReceipt(context.actor, context.workspaceId, identity.commandId), ...common, receipt });
      case 'git': return AutomationToolResultSchema.parse({ kind: 'automation_git_receipt', original: await s.git.receipt(context.actor, context.workspaceId, identity.commandId), ...common, receipt });
    }
  }
  return {
    names: Object.keys(schemas) as AutomationToolName[],
    recoveryIdentity: (name, input, context) => identityFor(name, input, context),
    async authorizeResult(name, input, result, context) {
      const { projectId } = projectEnvelope.parse(input), s = scopedServices(context, projectId);
      const saved = AutomationToolResultSchema.parse(result);
      // Recheck native project access for stored reads and successful historical writes.
      await s.studio.definitions(context.actor, context.workspaceId, undefined, { projectId });
      // Current source placement/authorization applies to frozen quotes, including successful write results.
      // Delivery must not preview, reconcile, replay or require historical/live revision equality.
      if (saved.kind === 'automation_snapshot') await s.pm.authorizeRead(context.actor, context.workspaceId, saved.snapshot.executionId, { kind: 'snapshot', value: saved.snapshot });
      else if (saved.kind === 'automation_result') await s.pm.authorizeRead(context.actor, context.workspaceId, saved.result.executionId, { kind: 'result', value: saved.result });
      else if (saved.kind === 'automation_review_receipt') await s.pm.authorizeRead(context.actor, context.workspaceId, null, { kind: 'review', value: saved.original });
      else if (saved.kind === 'automation_preview') {
        const p = z.object({ executionId: z.uuid() }).parse(input);
        await s.pm.authorizeRead(context.actor, context.workspaceId, p.executionId, { kind: 'preview', value: saved.preview });
      }
      const identity = identityFor(name, input, context);
      if (identity) {
        const proof = await inspect(identity, context.actor, context.workspaceId, s);
        if (proof.hash !== identity.hash || !proof.projectIds.includes(projectId) || proof.projectIds.some(id => !context.scope.projectIds.includes(id))) throw new DomainError('not_found_or_forbidden', 'Original automation result is outside the current scope', 404);
        return;
      }
      if (saved.kind === 'automation_studio_receipt' || saved.kind === 'automation_review_receipt' || saved.kind === 'automation_import_receipt' || saved.kind === 'automation_git_receipt') {
        const protocol = saved.kind === 'automation_studio_receipt' ? 'studio' : saved.kind === 'automation_review_receipt' ? 'review' : saved.kind === 'automation_import_receipt' ? 'import' : 'git';
        const proof = await inspect({ kind: 'automation', protocol, commandId: saved.original.requestId, action: 'create', hash: '' }, context.actor, context.workspaceId, s);
        if (!proof.projectIds.includes(projectId) || proof.projectIds.some(id => !context.scope.projectIds.includes(id))) throw new DomainError('not_found_or_forbidden', 'Original receipt is outside the current scope', 404);
      } else if (saved.kind === 'automation_bundle') {
        const p = schemas.pm_automation_bundle_receipt.parse(input);
        await s.transfer.uploadBundleReceipt(context.actor, context.workspaceId, p.requestId);
      } else if (saved.kind === 'automation_snapshot' || saved.kind === 'automation_result' || saved.kind === 'automation_logs' || saved.kind === 'automation_execution') {
        const p = z.object({ executionId: z.uuid() }).parse(input);
        const current = await s.studio.execution(context.actor, context.workspaceId, p.executionId);
        if (current.configSnapshot.projectId !== projectId) throw new DomainError('not_found_or_forbidden', 'Original execution is outside the current scope', 404);
      } else if (saved.kind === 'automation_definition' || saved.kind === 'automation_export') {
        const p = z.object({ definitionId: z.uuid() }).parse(input);
        const current = await s.studio.definition(context.actor, context.workspaceId, p.definitionId);
        if (current.config.projectId !== projectId) throw new DomainError('not_found_or_forbidden', 'Original definition is outside the current scope', 404);
      }
    },
    async inspectOutcome(value: AgentToolRecoveryIdentity, actorId, workspaceId) {
      const parsed = automationToolRecoveryIdentitySchema.safeParse(value);
      if (!parsed.success) return unresolved;
      // Status inspection receives the trusted original principal ID; actor labels are never used.
      try { const proof = await inspect(parsed.data, { id: actorId, email: '', name: '' }, workspaceId); return proof.hash === parsed.data.hash ? { status: proof.status, evidence: proof.status === 'unknown' ? 'unresolved' : 'application_receipt' } : unresolved; }
      catch { return unresolved; }
    },
    async recover(name, input, context) {
      const identity = identityFor(name, input, context);
      if (!identity) return null;
      const { projectId } = projectEnvelope.parse(input);
      try { return await original(identity, context, projectId); }
      catch (error) { if (error instanceof DomainError && error.code === 'not_found_or_forbidden') return null; throw error; }
    },
    async execute(name, input, context) {
      assertAgentToolNotAborted(context);
      if (!Object.hasOwn(schemas, name)) throw new DomainError('agent_tool_not_available', 'Unknown automation tool', 403);
      const { projectId } = projectEnvelope.parse(input), s = scopedServices(context, projectId), a = context.actor, w = context.workspaceId, requestId = requestIdFor(context);
      const common = { nextCursor: null as string | null, truncated: false, sources: [] };
      const identity = identityFor(name, input, context);
      const finish = (value: object, nextCursor: string | null = null) => AutomationToolResultSchema.parse({ ...value, ...common, nextCursor, truncated: nextCursor !== null, ...(identity ? { receipt: { kind: 'application', operationId: context.operationId, commandId: identity.commandId, action: `automation.${identity.action}`, targetId: null, revision: null, ...(context.linkage ? { linkage: context.linkage } : {}) } } : {}) });
      const definition = async (id: string) => { const row = await s.studio.definition(a, w, id); if (row.config.projectId !== projectId) throw new DomainError('not_found_or_forbidden', 'Automation is outside this project', 404); return row; };
      const execution = async (id: string) => { const row = await s.studio.execution(a, w, id); if (row.configSnapshot.projectId !== projectId) throw new DomainError('not_found_or_forbidden', 'Execution is outside this project', 404); return row; };
      const originalRead = async (protocol: Identity['protocol'], id: string) => { const marker = { kind: 'automation' as const, protocol, commandId: id, hash: '', action: 'create' as const }; const proof = await inspect(marker, a, w, s); if (!proof.projectIds.includes(projectId) || proof.projectIds.some(id => !context.scope.projectIds.includes(id))) throw new DomainError('not_found_or_forbidden', 'Receipt is outside this project scope', 404); };
      switch (name) {
        case 'pm_automation_capabilities': { const p = schemas.pm_automation_capabilities.parse(input); return finish({ kind: 'automation_capabilities', capabilities: await s.studio.capabilities(a, w, projectId, p.actionKind) }); }
        case 'pm_automation_templates': { const p = schemas.pm_automation_templates.parse(input); await s.studio.definitions(a, w, undefined, { projectId }); const templates = automationCatalog.filter(t => (!p.templateId || t.id === p.templateId) && (!p.source || automationTemplateSource(t) === p.source)).map(t => ({ id: t.id, name: t.name, category: t.category, description: t.description, version: t.version ?? null, source: automationTemplateSource(t), maturity: automationTemplateMaturity(t), recommended: automationTemplateRecommended(t), triggers: automationTemplateTriggers(t), configurationGuide: automationTemplateLaunchPrompt(t) })); if (p.templateId && !templates.length) throw new DomainError('automation_template_not_found', 'Template is not in the pinned catalog', 404); return finish({ kind: 'automation_templates', templates }); }
        case 'pm_automation_timezones': { const p = schemas.pm_automation_timezones.parse(input); await s.studio.definitions(a, w, undefined, { projectId }); const values = ['UTC', ...Intl.supportedValuesOf('timeZone')].sort().filter(t => (!p.search || t.toLowerCase().includes(p.search.toLowerCase())) && (!p.after || t > p.after)); return finish({ kind: 'automation_timezones', timezones: values.slice(0, 100) }, values.length > 100 ? values[99]! : null); }
        case 'pm_automation_definitions': { const p = schemas.pm_automation_definitions.parse(input), page = await s.studio.definitions(a, w, p.cursor, { projectId, ...(p.quickAccess === undefined ? {} : { quickAccess: p.quickAccess }) }); return finish({ kind: 'automation_definitions', definitions: page.items }, page.nextCursor); }
        case 'pm_automation_definition': { const p = schemas.pm_automation_definition.parse(input); return finish({ kind: 'automation_definition', definition: await definition(p.definitionId) }); }
        case 'pm_automation_validate': { const p = schemas.pm_automation_validate.parse(input); if (p.config.projectId !== projectId) throw new DomainError('not_found_or_forbidden', 'Config project must match the explicit target', 404); return finish({ kind: 'automation_validation', validation: await s.studio.validate(a, w, p.config) }); }
        case 'pm_automation_create': { const p = schemas.pm_automation_create.parse(input); if (p.config.projectId !== projectId) throw new DomainError('not_found_or_forbidden', 'Config project must match the explicit target', 404); return finish({ kind: 'automation_definition', definition: await s.studio.create(a, w, { requestId, config: p.config }) }); }
        case 'pm_automation_update': { const p = schemas.pm_automation_update.parse(input); await definition(p.definitionId); assertAgentToolProject(context.scope, p.config.projectId); return finish({ kind: 'automation_definition', definition: await s.studio.update(a, w, p.definitionId, { requestId, expectedRevision: p.expectedRevision, config: p.config }) }); }
        case 'pm_automation_status': { const p = schemas.pm_automation_status.parse(input); await definition(p.definitionId); return finish({ kind: 'automation_definition', definition: await s.studio.setStatus(a, w, p.definitionId, { requestId, expectedRevision: p.expectedRevision, status: p.status }) }); }
        case 'pm_automation_remove': { const p = schemas.pm_automation_remove.parse(input); await definition(p.definitionId); return finish({ kind: 'automation_deleted', ...await s.studio.remove(a, w, p.definitionId, { requestId, expectedRevision: p.expectedRevision }) }); }
        case 'pm_automation_run': case 'pm_automation_test': { const p = schemas.pm_automation_run.parse(input); await definition(p.definitionId); const method = name === 'pm_automation_run' ? s.studio.run : s.studio.dispatchTest; return finish({ kind: 'automation_execution', execution: await method(a, w, p.definitionId, { requestId, expectedRevision: p.expectedRevision, ...(p.payload === undefined ? {} : { payload: p.payload }) }) }); }
        case 'pm_automation_executions': { const p = schemas.pm_automation_executions.parse(input); if (p.definitionId) await definition(p.definitionId); const page = await s.studio.executions(a, w, p.definitionId, p.cursor, projectId); return finish({ kind: 'automation_executions', executions: page.items }, page.nextCursor); }
        case 'pm_automation_execution': { const p = schemas.pm_automation_execution.parse(input); return finish({ kind: 'automation_execution', execution: await execution(p.executionId) }); }
        case 'pm_automation_logs': { const p = schemas.pm_automation_logs.parse(input); await execution(p.executionId); const page = await s.studio.logs(a, w, p.executionId, p.cursor); return finish({ kind: 'automation_logs', logs: page.items }, page.nextCursor); }
        case 'pm_automation_query': { const p = schemas.pm_automation_query.parse(input); await execution(p.executionId); return finish({ kind: 'automation_execution', execution: await s.studio.query(a, w, p.executionId) }); }
        case 'pm_automation_cancel': { const p = schemas.pm_automation_cancel.parse(input); await execution(p.executionId); return finish({ kind: 'automation_execution', execution: await s.studio.cancel(a, w, p.executionId, { requestId }) }); }
        case 'pm_automation_receipt': { const p = schemas.pm_automation_receipt.parse(input); await originalRead('studio', p.requestId); return finish({ kind: 'automation_studio_receipt', original: await s.studio.receipt(a, w, p.requestId) }); }
        case 'pm_automation_snapshot': { const p = schemas.pm_automation_snapshot.parse(input); await execution(p.executionId); return finish({ kind: 'automation_snapshot', snapshot: await s.pm.snapshot(a, w, p.executionId) }); }
        case 'pm_automation_result': { const p = schemas.pm_automation_result.parse(input); await execution(p.executionId); return finish({ kind: 'automation_result', result: await s.pm.result(a, w, p.executionId) }); }
        case 'pm_automation_candidate_edit': { const p = schemas.pm_automation_candidate_edit.parse(input); await execution(p.executionId); await s.pm.edit(a, w, p.executionId, p.candidateId, { requestId, expectedRevision: p.expectedRevision, candidate: p.candidate }); return finish({ kind: 'automation_review_receipt', original: await s.pm.receipt(a, w, requestId) }); }
        case 'pm_automation_candidate_preview': { const p = schemas.pm_automation_candidate_preview.parse(input); await execution(p.executionId); return finish({ kind: 'automation_preview', preview: await s.pm.preview(a, w, p.executionId, p.candidateId, { requestId, expectedRevision: p.expectedRevision, ...(p.selectedItemIds === undefined ? {} : { selectedItemIds: p.selectedItemIds }) }) }); }
        case 'pm_automation_candidate_apply': { const p = schemas.pm_automation_candidate_apply.parse(input); await execution(p.executionId); await s.pm.apply(a, w, p.executionId, p.candidateId, { requestId, expectedRevision: p.expectedRevision, previewToken: p.previewToken, ...(p.selectedItemIds === undefined ? {} : { selectedItemIds: p.selectedItemIds }) }); return finish({ kind: 'automation_review_receipt', original: await s.pm.receipt(a, w, requestId) }); }
        case 'pm_automation_candidate_ignore': { const p = schemas.pm_automation_candidate_ignore.parse(input); await execution(p.executionId); await s.pm.ignore(a, w, p.executionId, p.candidateId, { requestId, expectedRevision: p.expectedRevision }); return finish({ kind: 'automation_review_receipt', original: await s.pm.receipt(a, w, requestId) }); }
        case 'pm_automation_review_receipt': { const p = schemas.pm_automation_review_receipt.parse(input); await originalRead('review', p.requestId); return finish({ kind: 'automation_review_receipt', original: await s.pm.receipt(a, w, p.requestId) }); }
        case 'pm_automation_import_preview': { const p = schemas.pm_automation_import_preview.parse(input); return finish({ kind: 'automation_transfer_preview', preview: await s.transfer.preview(a, w, p) }); }
        case 'pm_automation_import': { const p = schemas.pm_automation_import.parse(input); return finish({ kind: 'automation_import_receipt', original: await s.transfer.import(a, w, { ...p, requestId }) }); }
        case 'pm_automation_import_receipt': { const p = schemas.pm_automation_import_receipt.parse(input); await originalRead('import', p.requestId); return finish({ kind: 'automation_import_receipt', original: await s.transfer.receipt(a, w, p.requestId) }); }
        case 'pm_automation_export': { const p = schemas.pm_automation_export.parse(input); await definition(p.definitionId); return finish({ kind: 'automation_export', exported: await s.transfer.export(a, w, p.definitionId, p.format) }); }
        case 'pm_automation_bundle_upload': { const p = schemas.pm_automation_bundle_upload.parse(input); return finish({ kind: 'automation_bundle', bundle: await s.transfer.uploadBundle(a, w, { ...p, requestId }) }); }
        case 'pm_automation_bundle_receipt': { const p = schemas.pm_automation_bundle_receipt.parse(input); await originalRead('bundle', p.requestId); return finish({ kind: 'automation_bundle', bundle: await s.transfer.uploadBundleReceipt(a, w, p.requestId) }); }
        case 'pm_automation_git_status': { schemas.pm_automation_git_status.parse(input); return finish({ kind: 'automation_git_status', status: await s.git.status(a, w, projectId) }); }
        case 'pm_automation_git_save': { const p = schemas.pm_automation_git_save.parse(input); if (p.config.projectId !== projectId) throw new DomainError('not_found_or_forbidden', 'Git config project must match the explicit target', 404); return finish({ kind: 'automation_git_status', status: await s.git.save(a, w, { requestId, expectedRevision: p.expectedRevision, config: p.config }) }); }
        case 'pm_automation_git_check': { const p = schemas.pm_automation_git_check.parse(input); if (p.config.projectId !== projectId) throw new DomainError('not_found_or_forbidden', 'Git config project must match the explicit target', 404); return finish({ kind: 'automation_git_check', check: await s.git.check(a, w, { config: p.config }) }); }
        case 'pm_automation_git_sync': case 'pm_automation_git_reconcile': { const p = schemas.pm_automation_git_sync.parse(input); return finish({ kind: 'automation_git_operation', operation: await (name === 'pm_automation_git_sync' ? s.git.sync : s.git.reconcile)(a, w, { ...p, requestId }) }); }
        case 'pm_automation_git_receipt': { const p = schemas.pm_automation_git_receipt.parse(input); await originalRead('git', p.requestId); return finish({ kind: 'automation_git_receipt', original: await s.git.receipt(a, w, p.requestId) }); }
        default: throw new DomainError('agent_tool_not_available', 'Unknown automation tool', 403);
      }
    },
  };
}
