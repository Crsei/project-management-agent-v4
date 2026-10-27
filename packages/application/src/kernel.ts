import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError } from '../../domain/src/core.ts';
import type { Actor, Command, CommandReceipt, Entity, EntityKind } from '../../domain/src/core.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import { assertProjectScope, getMembership, requireCapability } from './access.ts';
import type { CommandContext, CommandRegistry, CoreAccess, SqlExecutor } from './ports.ts';
import { requireDashboardReadSelf } from './dashboard-read.ts';
import { assertWebhookReceiptReadable } from './webhooks.ts';
import { assertNotificationReceiptReadable } from './notifications.ts';
import type { NotificationCorePort } from '../../pm-core/readonly.ts';

const webhookReceiptCommands: Readonly<Record<string, true>> = { CreateWebhookEndpoint: true, SetWebhookEndpointState: true, ReauthorizeWebhookEndpoint: true, SetWebhookEndpointSigningKey: true, ReconcileWebhookDelivery: true, ResumeWebhookDelivery: true };

const kinds = ['project','work_item','milestone','conversation','intent','decision','upload','artifact','artifact_version','evidence','submission','review'] as const;
const envelope = z.object({ commandId: z.uuid().toLowerCase(), commandType: z.string().min(1).max(100), targetId: z.string().min(1).max(80).optional(), projectId: z.string().min(1).max(80).optional(), expectedVersions: z.record(z.string().min(1).max(80), z.number().int().positive()).optional(), payload: z.record(z.string(), z.unknown()) }).strict();
export type EntityRow = { id: string; workspace_id: string; project_id: string | null; kind: EntityKind; version: number; data: Record<string, any>; created_at: Date; updated_at: Date; created_by: string };
export function entityFromRow(row: EntityRow): Entity {
  const data = row.kind === 'work_item' ? { ...row.data, startDate: row.data.startDate ?? null, dueDate: row.data.dueDate ?? null } : row.data;
  return { id: row.id, workspaceId: row.workspace_id, projectId: row.project_id, kind: row.kind, version: row.version, data, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), createdBy: row.created_by };
}
export function entityProject(entity: Entity): string | null { return entity.kind === 'project' ? entity.id : entity.projectId; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
/** Command envelope request semantics: key ordering is irrelevant, array ordering and null are significant. */
export function requestHash(input: Record<string, unknown>): string {
  return createHash('sha256').update(canonical(input)).digest('hex');
}
function dbError(error: unknown): DomainError | null {
  if (error instanceof DomainError) return error;
  const pg = error as { code?: string; constraint?: string };
  if (pg.code === '23505') {
    if (pg.constraint === 'review_submission_unique') return new DomainError('review_already_recorded', 'This submission already has a review', 409);
    if (pg.constraint === 'work_item_intent_conversion_unique') return new DomainError('intent_already_converted', 'This accepted intent revision has already been converted', 409);
    return new DomainError('uniqueness_conflict', 'A business uniqueness constraint conflicts', 409);
  }
  if (pg.code === '23514' || pg.code === '23503' || pg.code === '22P02' || pg.code === '22023') return new DomainError('validation_failed', 'An aggregate reference, scope or data constraint failed', 400);
  return null;
}
export type StoredReceipt = { receipt: CommandReceipt; request_hash: string; command_type: string; project_id: string | null; scope_project_ids: string[]; workspace_scope: number; actor_scope: number };
export async function assertReceiptReadable(sql: SqlExecutor, actor: Actor, workspaceId: string, row: Pick<StoredReceipt, 'command_type' | 'scope_project_ids' | 'workspace_scope' | 'actor_scope'> & Partial<Pick<StoredReceipt, 'receipt'>>, notificationCore?: NotificationCorePort): Promise<void> {
  if (Object.hasOwn(webhookReceiptCommands, row.command_type)) {
    await assertWebhookReceiptReadable(sql, actor, workspaceId, row.scope_project_ids);
    return;
  }
  const capability = ['UpdateWorkspaceIdentity', 'SetWorkspaceMember', 'RevokeWorkspaceMember', 'SetMemberRole', 'CreateMemberInvitation', 'RevokeMemberInvitation', 'ResendMemberInvitation', 'CreateProjectTeam', 'RenameProjectTeam', 'UpdateProjectTeamDetails', 'SetProjectTeamMembers', 'SetProjectTeamMaintainers', 'ArchiveProjectTeam', 'SetProjectTeams', 'SetMemberCapacity'].includes(row.command_type) ? 'access.manage' : 'domain.read';
  if (row.actor_scope) await requireDashboardReadSelf({ sql, actor, workspaceId });
  if (row.workspace_scope || !row.actor_scope && row.scope_project_ids.length === 0) await requireCapability(sql, actor, workspaceId, capability);
  for (const projectId of row.scope_project_ids) await requireCapability(sql, actor, workspaceId, capability, projectId);
  if ((row.command_type === 'SetNotificationRead' || row.command_type === 'SetNotificationArchived') && row.receipt?.status === 'committed') {
    const result = row.receipt.result;
    if (!notificationCore || !result || typeof result !== 'object' || !('eventId' in result) || typeof result.eventId !== 'string') throw new DomainError('notification_receipt_unavailable', 'Current notification authorization is unavailable', 503);
    await assertNotificationReceiptReadable(sql, actor, workspaceId, result.eventId, notificationCore);
  }
}

export async function getCommandReceipt(pool: Pool, actor: Actor, workspaceId: string, commandId: string, notificationCore?: NotificationCorePort): Promise<CommandReceipt> {
  if (!z.uuid().toLowerCase().safeParse(workspaceId).success || !z.uuid().toLowerCase().safeParse(commandId).success) throw new DomainError('validation_failed', 'Invalid identifier');
  workspaceId = workspaceId.toLowerCase();
  commandId = commandId.toLowerCase();
  await getMembership(pool, actor, workspaceId);
  const result = await pool.query<StoredReceipt>('SELECT * FROM command_receipts WHERE workspace_id=$1 AND actor_id=$2 AND command_id=$3', [workspaceId, actor.id, commandId]);
  const row = result.rows[0];
  if (!row) throw new DomainError('not_found_or_forbidden', 'Command receipt is not accessible', 404);
  await assertReceiptReadable(pool, actor, workspaceId, row, notificationCore);
  return row.receipt;
}

export async function runCommand(pool: Pool, actor: Actor, workspaceId: string, incoming: Command, registry: CommandRegistry, core?: CoreAccess, notificationCore?: NotificationCorePort, beforeExecute?: (sql: SqlExecutor) => Promise<void>): Promise<CommandReceipt> {
  if (!z.uuid().toLowerCase().safeParse(workspaceId).success || !z.uuid().toLowerCase().safeParse(incoming?.commandId).success) throw new DomainError('validation_failed', 'Workspace and command IDs must be UUIDs');
  workspaceId = workspaceId.toLowerCase();
  // Canonical typed UUIDs/defaults before hashing and persistence; never rewrite arbitrary prose.
  const canonicalEnvelope = envelope.safeParse(incoming);
  if (canonicalEnvelope.success) {
    incoming = canonicalEnvelope.data as Command;
    const definition = Object.hasOwn(registry, incoming.commandType) ? registry[incoming.commandType] : undefined;
    const canonicalPayload = definition?.payload.safeParse(incoming.payload);
    if (canonicalPayload?.success) incoming = { ...incoming, payload: canonicalPayload.data as Record<string, unknown> };
  }
  const hash = requestHash(incoming as unknown as Record<string, unknown>);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockWorkspace(client, workspaceId);
    const membership = await getMembership(client, actor, workspaceId);
    const prior = await client.query<StoredReceipt>('SELECT * FROM command_receipts WHERE workspace_id=$1 AND actor_id=$2 AND command_id=$3', [workspaceId, actor.id, incoming.commandId]);
    if (prior.rows[0]) {
      await assertReceiptReadable(client, actor, workspaceId, prior.rows[0], notificationCore);
      if (prior.rows[0].request_hash !== hash) throw new DomainError('idempotency_conflict', 'Command ID already represents a different request', 409);
      await client.query('COMMIT');
      return prior.rows[0].receipt;
    }
    const touchedProjects = new Set<string>();
    let workspaceScope = false;
    let actorScope = false;
    const markScope = (projectId?: string | null) => { if (projectId) touchedProjects.add(projectId); else workspaceScope = true; };
    if (incoming.projectId) touchedProjects.add(incoming.projectId);
    // Preserve the target scope even when a stale version or other business guard rejects the command.
    if (incoming.targetId && z.uuid().toLowerCase().safeParse(incoming.targetId).success) {
      const scope = await client.query<{ id: string; kind: string; project_id: string | null }>('SELECT id,kind,project_id FROM entities WHERE workspace_id=$1 AND id=$2', [workspaceId, incoming.targetId]);
      const target = scope.rows[0];
      if (target) markScope(target.kind === 'project' ? target.id : target.project_id);
    }
    // Transaction-local identity lets row triggers capture only committed controlled
    // writes, including dashboard records written directly by their owning module.
    await client.query(`SELECT set_config('pm.audit_actor',$1,true),set_config('pm.audit_workspace',$2,true),
      set_config('pm.audit_command',$3,true),set_config('pm.audit_action',$4,true),set_config('pm.audit_private','false',true)`,
    [actor.id, workspaceId, incoming.commandId, incoming.commandType]);
    await client.query('SAVEPOINT business_command');
    let receipt: CommandReceipt;
    let receiptPersisted = false;
    const persistReceipt = () => client.query('INSERT INTO command_receipts(workspace_id,actor_id,command_id,command_type,request_hash,project_id,scope_project_ids,workspace_scope,actor_scope,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)', [workspaceId, actor.id, incoming.commandId, incoming.commandType ?? 'invalid', hash, incoming.projectId ?? null, [...touchedProjects], workspaceScope ? 1 : 0, actorScope ? 1 : 0, JSON.stringify(receipt)]);
    try {
      await beforeExecute?.(client);
      const parsed = envelope.safeParse(incoming);
      if (!parsed.success) throw new DomainError('validation_failed', 'Invalid command envelope', 400, parsed.error.flatten());
      const command = parsed.data as Command;
      if (command.projectId) assertProjectScope(membership, command.projectId);
      const definition = Object.hasOwn(registry, command.commandType) ? registry[command.commandType] : undefined;
      if (!definition) {
        if (/^(CreateSession|CloseSession|CreateRun|RetryRun|StartRun|RequestApproval|GrantApproval|DenyApproval|Dispatch|RecordRun|RecordOperation|RequestRun|Reconcile|ResolveApproval)/.test(command.commandType)) throw new DomainError('capability_not_enabled', 'Agent execution is not enabled', 409);
        throw new DomainError('unknown_command', 'Unknown command type', 400);
      }
      const payload = definition.payload.safeParse(command.payload);
      if (!payload.success) throw new DomainError('validation_failed', 'Invalid command payload', 400, payload.error.flatten());
      command.payload = payload.data as Record<string, unknown>;
      const created = new Set<string>();
      const versions = new Map<string, { initial: number; current: number }>();
      const validateVersion = (entity: Entity) => {
        if (entity.workspaceId !== workspaceId) throw new DomainError('scope_mismatch', 'Entity belongs to another workspace');
        if (created.has(entity.id)) return;
        const state = versions.get(entity.id);
        const initial = state?.initial ?? entity.version;
        if (command.expectedVersions?.[entity.id] !== initial || state && state.current !== entity.version) throw new DomainError('version_conflict', 'Aggregate version changed or expected version is missing', 409, { id: entity.id, currentVersion: state?.current ?? entity.version });
        if (!state) versions.set(entity.id, { initial, current: entity.version });
      };
      const context: CommandContext = {
        sql: client, actor, workspaceId, command,
        ...(core ? { core: {
          ...core,
          async get(id: string, kind?: EntityKind) {
            const entity = await core.get(id, kind);
            markScope(entityProject(entity));
            await requireCapability(client, actor, workspaceId, 'domain.read', entityProject(entity));
            return entity;
          },
          async list(kind: EntityKind) {
            const entities = (await core.list(kind)).filter(entity => membership.projectIds === null || membership.projectIds.includes(entityProject(entity) ?? ''));
            for (const entity of entities) { markScope(entityProject(entity)); await requireCapability(client, actor, workspaceId, 'domain.read', entityProject(entity)); }
            return entities;
          },
          async records() {
            await requireDashboardReadSelf({ sql: client, actor, workspaceId });
            return (await core.records()).filter(record => membership.projectIds === null || membership.projectIds.includes(record.entity.entity === 'project' ? record.id : String(record.entity.project ?? '')));
          },
        } } : {}),
        async requireSelf() { actorScope = true; await requireDashboardReadSelf({ sql: client, actor, workspaceId }); },
        async require(capability, projectId) { markScope(projectId); await requireCapability(client, actor, workspaceId, capability, projectId); },
        async get(id, kind) {
          if (core?.handles(id, kind)) {
            const entity = await core.get(id, kind);
            markScope(entityProject(entity));
            await requireCapability(client, actor, workspaceId, 'domain.read', entityProject(entity));
            return entity;
          }
          if (!z.uuid().toLowerCase().safeParse(id).success) throw new DomainError('validation_failed', 'Invalid entity ID');
          const result = await client.query<EntityRow>('SELECT * FROM entities WHERE workspace_id=$1 AND id=$2', [workspaceId, id]);
          const row = result.rows[0];
          if (!row || kind && row.kind !== kind) throw new DomainError('not_found_or_forbidden', 'Entity is not accessible', 404);
          const entity = entityFromRow(row);
          markScope(entityProject(entity));
          await requireCapability(client, actor, workspaceId, 'domain.read', entityProject(entity));
          return entity;
        },
        async list(kind, projectId) {
          if (kind === 'project' || kind === 'work_item' || kind === 'milestone') throw new DomainError('core_entity_requires_core_command', 'Markdown-core entities must be read through core routes', 409);
          markScope(projectId);
          await requireCapability(client, actor, workspaceId, 'domain.read', projectId);
          const result = projectId === undefined ? await client.query<EntityRow>('SELECT * FROM entities WHERE workspace_id=$1 AND kind=$2 ORDER BY id', [workspaceId, kind]) : await client.query<EntityRow>('SELECT * FROM entities WHERE workspace_id=$1 AND kind=$2 AND (project_id IS NOT DISTINCT FROM $3::text OR (kind=\'project\' AND id::text=$3)) ORDER BY id', [workspaceId, kind, projectId]);
          return result.rows.map(entityFromRow);
        },
        async insert(kind, data, projectId = null, id = randomUUID()) {
          if (kind === 'project' || kind === 'work_item' || kind === 'milestone') throw new DomainError('core_entity_requires_core_command', 'Markdown-core entities must be created through core commands', 409);
          if (!z.enum(kinds).safeParse(kind).success || !z.uuid().toLowerCase().safeParse(id).success || projectId !== null && (typeof projectId !== 'string' || !projectId.trim()) || !data || Array.isArray(data) || typeof data !== 'object') throw new DomainError('validation_failed', 'Invalid aggregate');
          // A restricted member may never create a new workspace-level project or discussion.
          assertProjectScope(membership, projectId);
          markScope(projectId);
          const result = await client.query<EntityRow>('INSERT INTO entities(id,workspace_id,project_id,kind,data,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING *', [id, workspaceId, projectId, kind, JSON.stringify(data), actor.id]);
          created.add(id);
          return entityFromRow(result.rows[0]!);
        },
        async update(entity, data) {
          if (entity.kind === 'project' || entity.kind === 'work_item' || entity.kind === 'milestone') throw new DomainError('core_entity_requires_core_command', 'Markdown-core entities must be changed through core commands', 409);
          validateVersion(entity);
          assertProjectScope(membership, entityProject(entity));
          markScope(entityProject(entity));
          const result = await client.query<EntityRow>('UPDATE entities SET data=$1::jsonb,version=version+1,updated_at=now() WHERE workspace_id=$2 AND id=$3 AND version=$4 RETURNING *', [JSON.stringify(data), workspaceId, entity.id, entity.version]);
          if (!result.rows[0]) throw new DomainError('version_conflict', 'Aggregate version changed', 409, { id: entity.id });
          const updated = entityFromRow(result.rows[0]);
          if (!created.has(entity.id)) versions.get(entity.id)!.current = updated.version;
          return updated;
        },
        checkVersion(entity) {
          if (entity.kind === 'project' || entity.kind === 'work_item' || entity.kind === 'milestone') {
            const expected = command.expectedVersions?.[entity.id];
            if (expected === undefined || expected !== entity.version) throw new DomainError('version_conflict', 'Aggregate version changed or expected version is missing', 409, { id: entity.id, currentVersion: entity.version });
            return;
          }
          validateVersion(entity);
        },
        async emit(eventType, entity, payload = {}) {
          if (entity.workspaceId !== workspaceId || !/^[A-Za-z][A-Za-z0-9.]{0,127}$/.test(eventType)) throw new DomainError('validation_failed', 'Invalid event');
          markScope(entityProject(entity));
          await client.query(`INSERT INTO outbox(event_id,workspace_id,project_id,aggregate_id,aggregate_kind,aggregate_version,aggregate_sequence,event_type,payload,actor_id,command_id)
            SELECT $1,$2,$3,$4,$5,$6,coalesce(max(aggregate_sequence),0)+1,$7,$8::jsonb,$9,$10 FROM outbox WHERE workspace_id=$2 AND aggregate_id=$4`,
          [randomUUID(), workspaceId, entityProject(entity), entity.id, entity.kind, entity.version, eventType, JSON.stringify(payload), actor.id, command.commandId]);
        },
      };
      const result = await definition.handler(context);
      receipt = { commandId: command.commandId, status: 'committed', httpStatus: 200, result: result ?? null };
      // Deferred provenance references must see the receipt, while constraint
      // failures still roll back both the business writes and this success result.
      await persistReceipt();
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      receiptPersisted = true;
    } catch (error) {
      const rejection = dbError(error);
      if (!rejection) throw error;
      await client.query('ROLLBACK TO SAVEPOINT business_command');
      receipt = { commandId: incoming.commandId, status: 'rejected', httpStatus: rejection.status, error: { code: rejection.code, message: rejection.message, ...(rejection.details === undefined ? {} : { details: rejection.details }) } };
    }
    await client.query('RELEASE SAVEPOINT business_command');
    if (!receiptPersisted) await persistReceipt();
    await client.query('COMMIT');
    return receipt;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
