import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { studioConfigSchema, studioNativeTemplateRequiresProvider, studioRequiredProviderToolFeature, type StudioActionKind, type StudioCapabilities, type StudioConfig, type StudioDefinition, type StudioExecution, type StudioExecutionEvent, type StudioExecutionPort, type StudioPage, type StudioReceipt, type StudioValidation } from '../../contracts/src/automation-studio.ts';
import { validateNativeTemplateArguments } from '../../contracts/src/automation-native-template-arguments.ts';
import { isPmAutomationTemplateId, pmAutomationArgumentsSchema } from '../../contracts/src/automation-pm.ts';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import type { NotificationCorePort } from '../../pm-core/readonly.ts';
import { getMembership } from './access.ts';
import { requestHash } from './kernel.ts';
import { nextStudioDue } from './automation-studio-schedule.ts';
import { appendStudioEvent, assertStudioConfig, enqueueStudioExecution, studioAuthorize, studioClock, studioDefinitionDto, studioExecutionDto, studioIntegrationSupportsAction, type StudioDefinitionRow, type StudioExecutionRow } from './automation-studio-store.ts';
import { reconcileStudioExecution } from './automation-studio-worker.ts';
import { createAutomationIntegrationsService } from './automation-integrations.ts';
import { validatePmAutomationScope } from './automation-pm.ts';
export { enqueueAutomationStudioEvent } from './automation-studio-store.ts';

type ReceiptRow = { request_hash: string; project_ids: string[]; http_status: number; result: unknown };
type Revision = { requestId: string; expectedRevision: number };
type Mutation = { requestId: string } & ({ kind: 'create'; config: StudioConfig } | { kind: 'update'; id: string; expectedRevision: number; config: StudioConfig } | { kind: 'status'; id: string; expectedRevision: number; status: 'enabled' | 'paused' } | { kind: 'remove' | 'run' | 'test'; id: string; expectedRevision: number; payload?: Record<string, unknown> } | { kind: 'cancel'; id: string });
export interface AutomationStudioService {
  capabilities(actor: Actor, workspaceId: string, projectId: string, actionKind?: StudioActionKind): Promise<StudioCapabilities>;
  validate(actor: Actor, workspaceId: string, config: StudioConfig): Promise<StudioValidation>;
  definitions(actor: Actor, workspaceId: string, cursor?: string): Promise<StudioPage<StudioDefinition>>;
  definition(actor: Actor, workspaceId: string, id: string): Promise<StudioDefinition>;
  get(actor: Actor, workspaceId: string, id: string): Promise<StudioDefinition>;
  create(actor: Actor, workspaceId: string, input: { requestId: string; config: StudioConfig }): Promise<StudioDefinition>;
  update(actor: Actor, workspaceId: string, id: string, input: Revision & { config: StudioConfig }): Promise<StudioDefinition>;
  setStatus(actor: Actor, workspaceId: string, id: string, input: Revision & { status: 'enabled' | 'paused' }): Promise<StudioDefinition>;
  remove(actor: Actor, workspaceId: string, id: string, input: Revision): Promise<{ deleted: true }>;
  run(actor: Actor, workspaceId: string, id: string, input: Revision & { payload?: Record<string, unknown> }): Promise<StudioExecution>;
  dispatchTest(actor: Actor, workspaceId: string, id: string, input: Revision & { payload?: Record<string, unknown> }): Promise<StudioExecution>;
  executions(actor: Actor, workspaceId: string, definitionId?: string, cursor?: string): Promise<StudioPage<StudioExecution>>;
  execution(actor: Actor, workspaceId: string, id: string): Promise<StudioExecution>;
  logs(actor: Actor, workspaceId: string, id: string, cursor?: string): Promise<StudioPage<StudioExecutionEvent>>;
  query(actor: Actor, workspaceId: string, id: string): Promise<StudioExecution>;
  cancel(actor: Actor, workspaceId: string, id: string, input: { requestId: string }): Promise<StudioExecution>;
  receipt(actor: Actor, workspaceId: string, requestId: string): Promise<StudioReceipt>;
}
export function createAutomationStudioService(options: { database: () => Pool; core: NotificationCorePort; runtime: StudioExecutionPort }): AutomationStudioService {
  const integrations = createAutomationIntegrationsService(options);
  async function scoped<T>(actor: Actor, workspaceId: string, operation: (sql: PoolClient) => Promise<T>): Promise<T> {
    const sql = await options.database().connect();
    try {
      await sql.query('BEGIN'); await lockWorkspace(sql, workspaceId);
      const member = await getMembership(sql, actor, workspaceId);
      if (!member.capabilities.includes('domain.read')) throw new DomainError('permission_denied', 'Capability domain.read is required', 403);
      const result = await operation(sql); await sql.query('COMMIT'); return result;
    } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
  }
  async function receiptReadable(sql: PoolClient, actor: Actor, workspaceId: string, row: ReceiptRow): Promise<void> { for (const projectId of row.project_ids) await studioAuthorize(sql, options.core, actor, workspaceId, projectId); }
  async function definitionRow(sql: PoolClient, actor: Actor, workspaceId: string, id: string): Promise<StudioDefinitionRow> {
    const row = (await sql.query<StudioDefinitionRow>('SELECT * FROM automation_studio_definitions WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND deleted_at IS NULL FOR UPDATE', [id, workspaceId, actor.id])).rows[0];
    if (!row) throw new DomainError('not_found_or_forbidden', 'Automation definition is not accessible', 404);
    await studioAuthorize(sql, options.core, actor, workspaceId, row.project_id); return row;
  }
  async function executionRow(sql: PoolClient, actor: Actor, workspaceId: string, id: string): Promise<StudioExecutionRow> {
    const row = (await sql.query<StudioExecutionRow>('SELECT * FROM automation_studio_executions WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 FOR UPDATE', [id, workspaceId, actor.id])).rows[0];
    if (!row) throw new DomainError('not_found_or_forbidden', 'Automation execution is not accessible', 404);
    await studioAuthorize(sql, options.core, actor, workspaceId, row.project_id); return row;
  }
  async function mutate(actor: Actor, workspaceId: string, input: Mutation): Promise<unknown> {
    let preflightError: DomainError | null = null;
    if (input.kind === 'update' || input.kind === 'status' && input.status === 'enabled' || input.kind === 'run' || input.kind === 'test') {
      try {
        const current = await scoped(actor, workspaceId, async sql => {
          const prior = (await sql.query<ReceiptRow>('SELECT * FROM automation_studio_receipts WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3', [workspaceId, actor.id, input.requestId])).rows[0];
          if (prior) return null; // Original receipts do not depend on today's runtime availability.
          return definitionRow(sql, actor, workspaceId, input.id);
        });
        const dispatch = input.kind === 'run' || input.kind === 'test';
        if (current && (dispatch ? studioRequiredProviderToolFeature(current.config) !== null : input.kind === 'status' || current.status === 'enabled')) {
          const validation = await service.validate(actor, workspaceId, input.kind === 'update' ? input.config : current.config);
          const issues = dispatch ? validation.issues.filter(issue => issue.code === 'provider_tool_protocol_unavailable') : validation.issues;
          if (issues.length) preflightError = new DomainError('automation_configuration_unavailable', issues.map(issue => `${issue.path}: ${issue.message}`).join('; '), 409);
        }
      } catch (error) { if (!(error instanceof DomainError)) throw error; preflightError = error; }
    }
    const outcome = await scoped(actor, workspaceId, async sql => {
      const hash = requestHash(input);
      const prior = (await sql.query<ReceiptRow>('SELECT * FROM automation_studio_receipts WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3', [workspaceId, actor.id, input.requestId])).rows[0];
      if (prior) { await receiptReadable(sql, actor, workspaceId, prior); if (prior.request_hash !== hash) throw new DomainError('idempotency_conflict', 'Request ID already represents another Studio mutation', 409); return { result: prior.result, status: prior.http_status }; }
      let result: unknown, status = 200; const projects = new Set<string>();
      if ('config' in input) projects.add(input.config.projectId);
      await sql.query('SAVEPOINT studio_mutation');
      try {
        const now = await studioClock(sql);
        if (input.kind === 'create') {
          const config = studioConfigSchema.parse(input.config); assertStudioConfig(config, now);
          await studioAuthorize(sql, options.core, actor, workspaceId, config.projectId, true);
          if (config.action.kind === 'template' && isPmAutomationTemplateId(config.action.templateId)) await validatePmAutomationScope(sql, options.core, actor, workspaceId, config.projectId, pmAutomationArgumentsSchema.parse(config.action.arguments));
          result = studioDefinitionDto((await sql.query<StudioDefinitionRow>('INSERT INTO automation_studio_definitions(id,workspace_id,actor_id,project_id,config) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING *', [randomUUID(), workspaceId, actor.id, config.projectId, JSON.stringify(config)])).rows[0]!);
        } else if (input.kind === 'cancel') {
          const row = await executionRow(sql, actor, workspaceId, input.id); projects.add(row.project_id);
          await studioAuthorize(sql, options.core, actor, workspaceId, row.project_id, true, false);
          if (!row.finished_at) {
            const status = row.dispatched_at ? 'cancel_requested' : 'cancelled';
            await appendStudioEvent(sql, row.id, 'cancel', status === 'cancelled' ? 'Cancelled before dispatch' : 'Cancellation requested; runtime outcome is not yet confirmed');
            const updated = (await sql.query<StudioExecutionRow>('UPDATE automation_studio_executions SET status=$2,finished_at=CASE WHEN $2=\'cancelled\' THEN clock_timestamp() ELSE NULL END,next_query_at=clock_timestamp() WHERE id=$1 RETURNING *', [row.id, status])).rows[0]!;
            result = studioExecutionDto(updated);
          } else result = studioExecutionDto(row);
        } else {
          const row = await definitionRow(sql, actor, workspaceId, input.id); projects.add(row.project_id);
          await studioAuthorize(sql, options.core, actor, workspaceId, row.project_id, true, input.kind !== 'remove' && !(input.kind === 'status' && input.status === 'paused'));
          if (row.revision !== input.expectedRevision) throw new DomainError('version_conflict', 'Automation changed; reload before deciding again', 409);
          if (preflightError) throw preflightError;
          const scopedConfig = input.kind === 'update' ? input.config : row.config;
          if (input.kind !== 'remove' && !(input.kind === 'status' && input.status === 'paused') && scopedConfig.action.kind === 'template' && isPmAutomationTemplateId(scopedConfig.action.templateId)) await validatePmAutomationScope(sql, options.core, actor, workspaceId, scopedConfig.projectId, pmAutomationArgumentsSchema.parse(scopedConfig.action.arguments));
          if (input.kind === 'remove') {
            await sql.query('UPDATE automation_studio_definitions SET deleted_at=$2,next_due_at=NULL,revision=revision+1,updated_at=$2 WHERE id=$1 AND revision=$3', [row.id, now, input.expectedRevision]); result = { deleted: true };
          } else if (input.kind === 'run' || input.kind === 'test') {
            if (input.kind === 'run' && row.status === 'draft') throw new DomainError('automation_draft_requires_test', 'A draft must be explicitly tested or enabled before a normal run', 409);
            assertStudioConfig(row.config, now);
            result = await enqueueStudioExecution(sql, row, { requestId: input.requestId, trigger: input.kind === 'test' ? 'test' : 'manual', ...(input.payload === undefined ? {} : { payload: input.payload }) });
          } else {
            const config = input.kind === 'update' ? studioConfigSchema.parse(input.config) : row.config;
            assertStudioConfig(config, now); await studioAuthorize(sql, options.core, actor, workspaceId, config.projectId, true, !(input.kind === 'status' && input.status === 'paused'));
            const status = input.kind === 'status' ? input.status : row.status;
            result = studioDefinitionDto((await sql.query<StudioDefinitionRow>('UPDATE automation_studio_definitions SET project_id=$2,config=$3::jsonb,status=$4,next_due_at=$5,revision=revision+1,updated_at=$6 WHERE id=$1 AND revision=$7 RETURNING *', [row.id, config.projectId, JSON.stringify(config), status, status === 'enabled' ? nextStudioDue(config, now) : null, now, input.expectedRevision])).rows[0]!);
          }
        }
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        await sql.query('ROLLBACK TO SAVEPOINT studio_mutation'); status = error.status; result = { error: { code: error.code, message: error.message }, httpStatus: status };
      }
      await sql.query('RELEASE SAVEPOINT studio_mutation');
      await sql.query('INSERT INTO automation_studio_receipts(workspace_id,actor_id,request_id,request_hash,project_ids,http_status,result) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)', [workspaceId, actor.id, input.requestId, hash, [...projects], status, JSON.stringify(result)]);
      return { result, status };
    });
    if (outcome.status !== 200) { const value = outcome.result as { error: { code: string; message: string } }; throw new DomainError(value.error.code, value.error.message, outcome.status); }
    return outcome.result;
  }
  const service = {
    async capabilities(actor: Actor, workspaceId: string, projectId: string, actionKind?: StudioActionKind): Promise<StudioCapabilities> {
      const local = await scoped(actor, workspaceId, async sql => { await studioAuthorize(sql, options.core, actor, workspaceId, projectId); const member = await getMembership(sql, actor, workspaceId); const ready = (await sql.query<{ ready: boolean }>("SELECT EXISTS(SELECT 1 FROM automation_studio_heartbeats WHERE heartbeat_at>clock_timestamp()-interval '20 seconds') AS ready")).rows[0]!.ready; return { canWrite: member.capabilities.includes('planning.edit'), scheduler: { authority: 'worker' as const, ready, reason: ready ? null : 'automation_execution_worker_not_observed' } }; });
      let remote: Omit<StudioCapabilities, 'canWrite' | 'scheduler'>;
      try { remote = await options.runtime.capabilities({ actorId: actor.id, workspaceId, projectId }); }
      catch { remote = { actions: [{ id: 'prompt', available: false, reason: 'automation_runtime_transport_unavailable' }, { id: 'script', available: false, reason: 'automation_runtime_transport_unavailable' }, { id: 'template', available: false, reason: 'automation_runtime_transport_unavailable' }], providers: [], repositories: [], plugins: [] }; }
      const connections = (await integrations.list(actor, workspaceId, projectId)).connections;
      const plugins = new Map(remote.plugins.filter(plugin => !plugin.id.startsWith('integration:')).map(plugin => [plugin.id, plugin]));
      for (const connection of connections) if (connection.status === 'verified' && studioIntegrationSupportsAction(connection, connection.verification, actionKind)) plugins.set(`integration:${connection.id}`, { id: `integration:${connection.id}`, name: connection.label, version: String(connection.revision) });
      await scoped(actor, workspaceId, sql => studioAuthorize(sql, options.core, actor, workspaceId, projectId)); return { ...remote, ...local, plugins: [...plugins.values()] };
    },
    async validate(actor: Actor, workspaceId: string, config: StudioConfig): Promise<StudioValidation> {
      await scoped(actor, workspaceId, sql => studioAuthorize(sql, options.core, actor, workspaceId, config.projectId));
      const issues: StudioValidation['issues'] = []; let nextDueAt: string | null = null;
      if (config.action.kind === 'template' && isPmAutomationTemplateId(config.action.templateId)) {
        try { await scoped(actor, workspaceId, sql => validatePmAutomationScope(sql, options.core, actor, workspaceId, config.projectId, pmAutomationArgumentsSchema.parse(config.action.kind === 'template' ? config.action.arguments : {}))); }
        catch (error) { if (!(error instanceof DomainError)) throw error; issues.push({ path: 'action.arguments', code: error.code, message: error.message }); }
      }
      try { assertStudioConfig(config, new Date()); nextDueAt = nextStudioDue(config, new Date())?.toISOString() ?? null; } catch (error) { if (!(error instanceof DomainError)) throw error; issues.push({ path: /script/.test(error.code) ? 'action' : 'trigger', code: error.code, message: error.message }); }
      const capabilities = await service.capabilities(actor, workspaceId, config.projectId, config.action.kind);
      const action = capabilities.actions.find(item => item.id === config.action.kind);
      if (!action?.available) issues.push({ path: 'action', code: 'runtime_unavailable', message: action?.reason ?? 'Runtime action is not available' });
      const actionConfig = config.action;
      if (actionConfig.kind === 'template') issues.push(...validateNativeTemplateArguments(actionConfig.templateId, actionConfig.arguments));
      if (actionConfig.kind === 'prompt' || actionConfig.kind === 'template' && studioNativeTemplateRequiresProvider(actionConfig.templateId)) { const provider = capabilities.providers.find(item => item.id === actionConfig.providerInstanceId); if (!provider || actionConfig.model === null || !provider.models.includes(actionConfig.model)) issues.push({ path: 'action.providerInstanceId', code: 'provider_unavailable', message: 'Select a currently available provider and model' }); }
      const providerFeature = studioRequiredProviderToolFeature(config);
      if (providerFeature) {
        const support = capabilities.features?.find(feature => feature.id === providerFeature);
        if (!support?.available) issues.push({ path: 'action.providerInstanceId', code: 'provider_tool_protocol_unavailable', message: support?.reason ?? 'The selected Provider does not advertise the native tool transport required by this action' });
      }
      for (const repository of config.action.repositories) if (!capabilities.repositories.some(item => item.id === repository.id)) issues.push({ path: 'action.repositories', code: 'repository_unavailable', message: 'Repository is not currently authorized' });
      for (const plugin of config.action.plugins) if (plugin.version === null || !capabilities.plugins.some(item => item.id === plugin.id && item.version === plugin.version)) issues.push({ path: 'action.plugins', code: 'plugin_unavailable', message: 'Select an exact currently available plugin revision' });
      return { valid: issues.length === 0, issues, nextDueAt };
    },
    definitions: (actor: Actor, workspaceId: string, cursor?: string): Promise<StudioPage<StudioDefinition>> => scoped(actor, workspaceId, async sql => {
      const rows = (await sql.query<StudioDefinitionRow>('SELECT * FROM automation_studio_definitions d WHERE workspace_id=$1 AND actor_id=$2 AND deleted_at IS NULL AND ($3::uuid IS NULL OR (d.created_at,d.id)<(SELECT c.created_at,c.id FROM automation_studio_definitions c WHERE c.id=$3 AND c.workspace_id=$1 AND c.actor_id=$2)) ORDER BY created_at DESC,id DESC LIMIT 51', [workspaceId, actor.id, cursor ?? null])).rows;
      const items: StudioDefinition[] = []; for (const row of rows.slice(0, 50)) { try { await studioAuthorize(sql, options.core, actor, workspaceId, row.project_id); items.push(studioDefinitionDto(row)); } catch (error) { if (!(error instanceof DomainError) || ![403,404].includes(error.status)) throw error; } }
      return { items, nextCursor: rows.length > 50 ? rows[49]!.id : null };
    }),
    definition: (actor: Actor, workspaceId: string, id: string): Promise<StudioDefinition> => scoped(actor, workspaceId, async sql => studioDefinitionDto(await definitionRow(sql, actor, workspaceId, id))),
    create: (actor: Actor, workspaceId: string, input: { requestId: string; config: StudioConfig }) => mutate(actor, workspaceId, { ...input, kind: 'create' }) as Promise<StudioDefinition>,
    update: (actor: Actor, workspaceId: string, id: string, input: Revision & { config: StudioConfig }) => mutate(actor, workspaceId, { ...input, kind: 'update', id }) as Promise<StudioDefinition>,
    setStatus: (actor: Actor, workspaceId: string, id: string, input: Revision & { status: 'enabled' | 'paused' }) => mutate(actor, workspaceId, { ...input, kind: 'status', id }) as Promise<StudioDefinition>,
    remove: (actor: Actor, workspaceId: string, id: string, input: Revision) => mutate(actor, workspaceId, { ...input, kind: 'remove', id }) as Promise<{ deleted: true }>,
    run: (actor: Actor, workspaceId: string, id: string, input: Revision & { payload?: Record<string, unknown> }) => mutate(actor, workspaceId, { ...input, kind: 'run', id }) as Promise<StudioExecution>,
    dispatchTest: (actor: Actor, workspaceId: string, id: string, input: Revision & { payload?: Record<string, unknown> }) => mutate(actor, workspaceId, { ...input, kind: 'test', id }) as Promise<StudioExecution>,
    executions: (actor: Actor, workspaceId: string, definitionId?: string, cursor?: string): Promise<StudioPage<StudioExecution>> => scoped(actor, workspaceId, async sql => {
      const rows = (await sql.query<StudioExecutionRow>('SELECT * FROM automation_studio_executions e WHERE workspace_id=$1 AND actor_id=$2 AND ($3::uuid IS NULL OR definition_id=$3) AND ($4::uuid IS NULL OR (e.created_at,e.id)<(SELECT c.created_at,c.id FROM automation_studio_executions c WHERE c.id=$4 AND c.workspace_id=$1 AND c.actor_id=$2)) ORDER BY created_at DESC,id DESC LIMIT 51', [workspaceId, actor.id, definitionId ?? null, cursor ?? null])).rows;
      const items: StudioExecution[] = []; for (const row of rows.slice(0,50)) { try { await studioAuthorize(sql, options.core, actor, workspaceId, row.project_id); items.push(studioExecutionDto(row)); } catch (error) { if (!(error instanceof DomainError) || ![403,404].includes(error.status)) throw error; } }
      return { items, nextCursor: rows.length > 50 ? rows[49]!.id : null };
    }),
    execution: (actor: Actor, workspaceId: string, id: string): Promise<StudioExecution> => scoped(actor, workspaceId, async sql => studioExecutionDto(await executionRow(sql, actor, workspaceId, id))),
    logs: (actor: Actor, workspaceId: string, id: string, cursor?: string): Promise<StudioPage<StudioExecutionEvent>> => scoped(actor, workspaceId, async sql => {
      await executionRow(sql, actor, workspaceId, id);
      const rows = (await sql.query<{ sequence: string; at: Date; kind: StudioExecutionEvent['kind']; message: string; stream: StudioExecutionEvent['stream'] }>('SELECT sequence,at,kind,message,stream FROM automation_studio_execution_events WHERE execution_id=$1 AND sequence>$2::bigint ORDER BY sequence LIMIT 201', [id, cursor ?? '0'])).rows;
      return { items: rows.slice(0,200).map(row => ({ ...row, sequence: Number(row.sequence), at: row.at.toISOString() })), nextCursor: rows.length > 200 ? rows[199]!.sequence : null };
    }),
    async query(actor: Actor, workspaceId: string, id: string): Promise<StudioExecution> { await scoped(actor, workspaceId, async sql => { const row = await executionRow(sql, actor, workspaceId, id); await studioAuthorize(sql, options.core, actor, workspaceId, row.project_id, true, false); }); await reconcileStudioExecution(options.database(), options.core, options.runtime, id); return service.execution(actor, workspaceId, id); },
    cancel: (actor: Actor, workspaceId: string, id: string, input: { requestId: string }) => mutate(actor, workspaceId, { ...input, kind: 'cancel', id }) as Promise<StudioExecution>,
    receipt: (actor: Actor, workspaceId: string, requestId: string): Promise<StudioReceipt> => scoped(actor, workspaceId, async sql => { const row = (await sql.query<ReceiptRow>('SELECT * FROM automation_studio_receipts WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3', [workspaceId, actor.id, requestId])).rows[0]; if (!row) throw new DomainError('not_found_or_forbidden', 'Studio receipt is not accessible', 404); await receiptReadable(sql, actor, workspaceId, row); return { requestId, result: row.result, httpStatus: row.http_status }; }),
  };
  return { ...service, get: service.definition };
}
