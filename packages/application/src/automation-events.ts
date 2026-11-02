import { createHash, randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { z } from 'zod';
import type { Actor } from '../../domain/src/core.ts';
import { DomainError } from '../../domain/src/core.ts';
import type { StudioConfig } from '../../contracts/src/automation-studio.ts';
import type { AutomationEventConfig, AutomationEventEndpoint, AutomationEventReceipt, automationEventSaveSchema } from '../../contracts/src/automation-integrations.ts';
import { createAutomationPrivateStore, type AutomationPrivateStore } from '../../infrastructure/src/automation-integrations.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import { enqueueAutomationStudioEvent } from './automation-studio.ts';
import { authorizeAutomationIntegration, mutateAutomationIntegration, readAutomationIntegration, type AutomationIntegrationContext } from './automation-integrations-store.ts';
import { automationEventPointer, matchesAutomationEventFilter } from './automation-events-filter.ts';
import { verifyAutomationEventSignature } from './automation-events-signature.ts';
import type { SqlExecutor } from './ports.ts';

type EndpointRow = { id: string; workspace_id: string; actor_id: string; project_id: string; definition_id: string; revision: number; config: AutomationEventConfig; private_secret: string; status: 'active' | 'revoked'; created_at: Date; updated_at: Date };
type DefinitionRow = { id: string; config: StudioConfig; revision: number; status: string };
export type AutomationEventsOptions = AutomationIntegrationContext & { privateStore?: AutomationPrivateStore; publicOrigin?: string };
export function createAutomationEventsService(options: AutomationEventsOptions) {
  const store = options.privateStore ?? createAutomationPrivateStore();
  const dto = (row: EndpointRow): AutomationEventEndpoint => ({ ...row.config, id: row.id, revision: row.revision, status: row.status, hasSecret: Boolean(row.private_secret), url: `${(options.publicOrigin ?? '').replace(/\/$/, '')}/api/v1/automation-webhooks/${row.id}`, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
  async function endpoint(sql: SqlExecutor, actor: Actor, workspaceId: string, id: string): Promise<EndpointRow> {
    const row = (await sql.query<EndpointRow>('SELECT * FROM automation_event_endpoints WHERE id=$1 AND workspace_id=$2 AND actor_id=$3', [id, workspaceId, actor.id])).rows[0];
    if (!row) throw new DomainError('not_found_or_forbidden', 'Event endpoint is not accessible', 404);
    await authorizeAutomationIntegration(sql, options, actor, workspaceId, row.project_id); return row;
  }
  return {
    list: (actor: Actor, workspaceId: string, projectId?: string) => readAutomationIntegration(options, actor, workspaceId, async sql => {
      if (projectId) await authorizeAutomationIntegration(sql, options, actor, workspaceId, projectId);
      const rows = await sql.query<EndpointRow>('SELECT * FROM automation_event_endpoints WHERE workspace_id=$1 AND actor_id=$2 AND ($3::text IS NULL OR project_id=$3) ORDER BY created_at,id', [workspaceId, actor.id, projectId ?? null]);
      const items: AutomationEventEndpoint[] = [];
      for (const row of rows.rows) { try { await authorizeAutomationIntegration(sql, options, actor, workspaceId, row.project_id); items.push(dto(row)); } catch (error) { if (!(error instanceof DomainError) || ![403, 404].includes(error.status)) throw error; } }
      return { items };
    }),
    save: (actor: Actor, workspaceId: string, id: string, input: z.infer<typeof automationEventSaveSchema>): Promise<AutomationEventEndpoint> => mutateAutomationIntegration(options, actor, workspaceId, { ...input, id, kind: 'event-save' }, [input.config.projectId], async sql => {
      await authorizeAutomationIntegration(sql, options, actor, workspaceId, input.config.projectId, true);
      const definition = (await sql.query<DefinitionRow>('SELECT * FROM automation_studio_definitions WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND deleted_at IS NULL', [input.config.definitionId, workspaceId, actor.id])).rows[0];
      if (!definition || definition.config.projectId !== input.config.projectId) throw new DomainError('not_found_or_forbidden', 'Event definition is not accessible in this project', 404);
      if (definition.config.trigger.kind !== 'event' || definition.config.trigger.source !== input.config.source || definition.config.trigger.key !== input.config.key) throw new DomainError('event_trigger_mismatch', 'Endpoint source and key must match the saved event definition');
      const existing = (await sql.query<EndpointRow>('SELECT * FROM automation_event_endpoints WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 FOR UPDATE', [id, workspaceId, actor.id])).rows[0];
      if ((existing?.revision ?? 0) !== input.expectedRevision) throw new DomainError('version_conflict', 'Event endpoint changed; reload before saving', 409);
      if (existing && (existing.project_id !== input.config.projectId || existing.definition_id !== input.config.definitionId)) throw new DomainError('scope_mismatch', 'An event endpoint cannot move between definitions or projects');
      const identity = `${workspaceId}:${actor.id}:${id}:event`;
      const secret = input.secret ?? (existing?.private_secret ? store.open<string>(existing.private_secret, identity) : null);
      if (!secret) throw new DomainError('event_secret_required', 'Supply a private signing secret or webhook key');
      if (input.config.verification === 'standard_webhooks' && (!/^(?:whsec_)?[A-Za-z0-9+/]+={0,2}$/.test(secret) || Buffer.from(secret.replace(/^whsec_/, ''), 'base64').length < 16)) throw new DomainError('validation_failed', 'Standard Webhooks requires base64 signing material (optionally prefixed whsec_)');
      const row = (await sql.query<EndpointRow>(`INSERT INTO automation_event_endpoints(id,workspace_id,actor_id,project_id,definition_id,config,private_secret) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
        ON CONFLICT(id) DO UPDATE SET config=excluded.config,private_secret=excluded.private_secret,status='active',revision=automation_event_endpoints.revision+1,updated_at=clock_timestamp()
        WHERE automation_event_endpoints.workspace_id=$2 AND automation_event_endpoints.actor_id=$3 AND automation_event_endpoints.revision=$8 RETURNING *`, [id, workspaceId, actor.id, input.config.projectId, input.config.definitionId, JSON.stringify(input.config), store.seal(secret, identity), input.expectedRevision])).rows[0];
      if (!row) throw new DomainError('version_conflict', 'Endpoint identity is not available', 409);
      return dto(row);
    }),
    revoke: (actor: Actor, workspaceId: string, id: string, input: { requestId: string; expectedRevision: number }): Promise<AutomationEventEndpoint> => {
      const projects: string[] = [];
      return mutateAutomationIntegration(options, actor, workspaceId, { ...input, id, kind: 'event-revoke' }, projects, async sql => {
        const row = await endpoint(sql, actor, workspaceId, id); projects.push(row.project_id);
        await authorizeAutomationIntegration(sql, options, actor, workspaceId, row.project_id, true, false);
        if (row.revision !== input.expectedRevision) throw new DomainError('version_conflict', 'Event endpoint changed; reload before revoking', 409);
        const updated = (await sql.query<EndpointRow>("UPDATE automation_event_endpoints SET status='revoked',private_secret='',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *", [id])).rows[0]!;
        return dto(updated);
      });
    },
    events: (actor: Actor, workspaceId: string, id: string, cursor?: string) => readAutomationIntegration(options, actor, workspaceId, async sql => {
      await endpoint(sql, actor, workspaceId, id);
      const rows = await sql.query<{ id: string; receipt: AutomationEventReceipt }>('SELECT id,receipt FROM automation_event_inbox e WHERE endpoint_id=$1 AND ($2::uuid IS NULL OR (e.received_at,e.id)<(SELECT c.received_at,c.id FROM automation_event_inbox c WHERE c.id=$2 AND c.endpoint_id=$1)) ORDER BY received_at DESC,id DESC LIMIT 51', [id, cursor ?? null]);
      return { items: rows.rows.slice(0, 50).map(row => row.receipt), nextCursor: rows.rows.length > 50 ? rows.rows[49]!.id : null };
    }),
    async receive(id: string, raw: Buffer, headers: IncomingHttpHeaders): Promise<AutomationEventReceipt | { challenge: string }> {
      if (raw.length > 1048576) throw new DomainError('event_payload_too_large', 'Webhook payload exceeds one MiB', 413);
      const sql = await options.database().connect();
      try {
        await sql.query('BEGIN');
        const located = (await sql.query<{ workspace_id: string }>("SELECT workspace_id FROM automation_event_endpoints WHERE id=$1 AND status='active'", [id])).rows[0];
        if (!located) throw new DomainError('not_found_or_forbidden', 'Event endpoint is not accessible', 404);
        await lockWorkspace(sql, located.workspace_id);
        const row = (await sql.query<EndpointRow>("SELECT * FROM automation_event_endpoints WHERE id=$1 AND status='active' FOR UPDATE", [id])).rows[0];
        if (!row) throw new DomainError('not_found_or_forbidden', 'Event endpoint is not accessible', 404);
        const now = (await sql.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
        const authenticated = verifyAutomationEventSignature(row.config.verification, store.open<string>(row.private_secret, `${row.workspace_id}:${row.actor_id}:${id}:event`), raw, headers, now.getTime());
        const bodyReplay = row.config.verification === 'key' || row.config.verification === 'hmac_sha256_hex';
        const prior = (await sql.query('SELECT id FROM automation_event_inbox WHERE endpoint_id=$1 AND (external_event_id=$2 OR ($4 AND body_sha256=$3))', [id, authenticated.externalEventId, authenticated.bodySha256, bodyReplay])).rowCount;
        if (prior) throw new DomainError('event_replay_rejected', 'This authenticated event was already recorded; no second run was enqueued', 409);
        const actor: Actor = { id: row.actor_id, email: '', name: '' };
        await authorizeAutomationIntegration(sql, options, actor, row.workspace_id, row.project_id, true);
        const eventId = randomUUID(); const receipt: AutomationEventReceipt = { eventId, status: 'rejected', executionId: null, reason: null, receivedAt: now.toISOString() }; let challenge: string | null = null;
        await sql.query('SAVEPOINT event_enqueue');
        try {
          let parsed: unknown;
          try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new DomainError('event_payload_invalid', 'Event payload must be a JSON object'); }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new DomainError('event_payload_invalid', 'Event payload must be a JSON object');
          const definition = (await sql.query<DefinitionRow>('SELECT id,config,revision,status FROM automation_studio_definitions WHERE id=$1 AND workspace_id=$2 AND actor_id=$3 AND deleted_at IS NULL', [row.definition_id, row.workspace_id, row.actor_id])).rows[0];
          if (!definition || definition.config.projectId !== row.project_id || definition.config.trigger.kind !== 'event' || definition.config.trigger.source !== row.config.source || definition.config.trigger.key !== row.config.key) throw new DomainError('event_trigger_mismatch', 'Current definition no longer matches this event endpoint', 409);
          if (row.config.verification === 'slack_v0' && 'type' in parsed && parsed.type === 'url_verification' && 'challenge' in parsed && typeof parsed.challenge === 'string') {
            challenge = parsed.challenge; receipt.status = 'filtered'; receipt.reason = 'slack_url_verification';
          } else {
            const payload = automationEventPointer(parsed, row.config.payloadPointer);
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new DomainError('event_payload_invalid', 'Selected event payload must be a JSON object');
            if (!await matchesAutomationEventFilter(payload as Record<string, unknown>, definition.config.trigger.filter)) { receipt.status = 'filtered'; receipt.reason = 'event_filter_not_matched'; }
            else {
              // Rotated/multiple registered URLs must not create another run for the same authenticated source event.
              const sourceEventId = createHash('sha256').update(JSON.stringify([row.config.source, row.config.key, bodyReplay ? authenticated.bodySha256 : authenticated.externalEventId])).digest('hex');
              const execution = await enqueueAutomationStudioEvent(sql, options.core, { workspaceId: row.workspace_id, actorId: row.actor_id, definitionId: row.definition_id, eventId: sourceEventId, payload: payload as Record<string, unknown>, source: row.config.source, key: row.config.key });
              receipt.status = 'accepted'; receipt.executionId = execution.id; receipt.reason = execution.status === 'skipped' ? execution.error : null;
            }
          }
        } catch (error) { if (!(error instanceof DomainError)) throw error; await sql.query('ROLLBACK TO SAVEPOINT event_enqueue'); receipt.status = 'rejected'; receipt.executionId = null; receipt.reason = error.code; }
        await sql.query('RELEASE SAVEPOINT event_enqueue');
        await sql.query('INSERT INTO automation_event_inbox(id,endpoint_id,endpoint_revision,external_event_id,body_sha256,body_replay,receipt,received_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)', [eventId, id, row.revision, authenticated.externalEventId, authenticated.bodySha256, bodyReplay, JSON.stringify(receipt), now]);
        await sql.query('COMMIT'); return challenge === null ? receipt : { challenge };
      } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
    },
  };
}
