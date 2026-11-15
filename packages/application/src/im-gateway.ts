import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import type { ImBinding } from '../../contracts/src/im-gateway.ts';
import { requireCapability } from './access.ts';
import type { SqlExecutor } from './ports.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';

const LINK_CODE = /^[0-9A-F]{32}$/;
const LINK_FAILURE_WINDOW = "15 minutes";
const LINK_FAILURE_LIMIT = 10;

export type ImIdentity = {
  gatewayId: string;
  platform: string;
  botSelfId: string;
  platformUserId: string;
  platformUserName: string | null;
  replyChannelId: string;
};

export type ImBindingRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  gateway_id: string;
  platform: string;
  bot_self_id: string;
  platform_user_id: string;
  platform_user_name: string | null;
  reply_channel_id: string;
  default_project_id: string | null;
  notify_enabled: boolean;
  notification_cursor: string;
  revision: number;
  verified_at: Date | string;
  last_seen_at: Date | string;
  revoked_at: Date | string | null;
};

export type ResolvedImBinding = { binding: ImBindingRow; actor: Actor; capabilities: readonly string[]; projectIds: readonly string[] | null };

function timestamp(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** 16 random bytes = 128 bits, rendered as eight uppercase hexadecimal groups. */
function encodeLinkCode(): string {
  return randomBytes(16).toString('hex').toUpperCase().match(/.{4}/g)!.join('-');
}

function normalizeLinkCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[^0-9A-F]/g, '');
  if (!LINK_CODE.test(normalized)) throw new DomainError('im_link_invalid', 'The link code is invalid or expired', 400);
  return normalized;
}

function hashLinkCode(value: string): string {
  return createHash('sha256').update(normalizeLinkCode(value)).digest('hex');
}

export function deterministicImId(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function truncateImText(value: string, maximum = 4_000): string {
  const normalized = value.replace(/\u0000/g, '').replace(/\r\n/g, '\n').trim() || '（空消息）';
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function bindingDto(row: ImBindingRow): ImBinding {
  const name = row.platform_user_name?.trim().slice(0, 100);
  return {
    id: row.id,
    platform: row.platform,
    accountLabel: name ? `${row.platform} · ${name}` : `${row.platform} · …${row.platform_user_id.slice(-4)}`,
    notifyEnabled: row.notify_enabled,
    defaultProjectId: row.default_project_id,
    verifiedAt: timestamp(row.verified_at),
    lastSeenAt: timestamp(row.last_seen_at),
    revokedAt: row.revoked_at === null ? null : timestamp(row.revoked_at),
    revision: row.revision,
  };
}

function isRateLimitedAttempt(row: { count?: string } | undefined): boolean {
  return Number(row?.count ?? 0) >= LINK_FAILURE_LIMIT;
}

async function recordLinkAttempt(pool: Pool, identity: ImIdentity, ok: boolean): Promise<void> {
  await pool.query(
    'INSERT INTO im_link_attempts(platform,bot_self_id,platform_user_id,ok) VALUES($1,$2,$3,$4)',
    [identity.platform, identity.botSelfId, identity.platformUserId, ok],
  ).catch(() => undefined);
}

export async function createImLinkCode(pool: Pool, actor: Actor, workspaceId: string, ttlSeconds: number): Promise<{ code: string; expiresAt: string }> {
  await requireCapability(pool, actor, workspaceId, 'domain.read');
  const recent = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM im_link_codes WHERE workspace_id=$1 AND user_id=$2 AND created_at>clock_timestamp()-interval '1 hour'",
    [workspaceId, actor.id],
  );
  if (Number(recent.rows[0]?.count ?? 0) >= 5) throw new DomainError('im_link_rate_limited', 'Too many link codes; try again later', 429);
  const code = encodeLinkCode();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1_000).toISOString();
  const sql = await pool.connect();
  try {
    await sql.query('BEGIN');
    await lockWorkspace(sql, workspaceId);
    await sql.query('UPDATE im_link_codes SET consumed_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2 AND consumed_at IS NULL', [workspaceId, actor.id]);
    await sql.query('INSERT INTO im_link_codes(code_hash,workspace_id,user_id,expires_at) VALUES($1,$2,$3,$4)', [hashLinkCode(code), workspaceId, actor.id, expiresAt]);
    await sql.query('COMMIT');
    return { code, expiresAt };
  } catch (error) {
    await sql.query('ROLLBACK');
    throw error;
  } finally { sql.release(); }
}

export async function consumeImLinkCode(pool: Pool, identity: ImIdentity, code: string): Promise<ImBindingRow> {
  let codeHash: string;
  try { codeHash = hashLinkCode(code); }
  catch (error) {
    await recordLinkAttempt(pool, identity, false);
    throw error;
  }
  const sql = await pool.connect();
  let committed = false, rateLimited = false;
  try {
    await sql.query('BEGIN');
    const failures = await sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM im_link_attempts
       WHERE platform=$1 AND bot_self_id=$2 AND platform_user_id=$3 AND NOT ok AND attempted_at>clock_timestamp()-interval '${LINK_FAILURE_WINDOW}'`,
      [identity.platform, identity.botSelfId, identity.platformUserId],
    );
    if (isRateLimitedAttempt(failures.rows[0])) {
      rateLimited = true;
      throw new DomainError('im_link_rate_limited', 'Too many link attempts; try again later', 429);
    }
    const found = await sql.query<{ workspace_id: string; user_id: string; expires_at: Date; consumed_at: Date | null }>(
      'SELECT workspace_id,user_id,expires_at,consumed_at FROM im_link_codes WHERE code_hash=$1 FOR UPDATE',
      [codeHash],
    );
    const link = found.rows[0];
    if (!link || link.consumed_at !== null || link.expires_at.getTime() <= Date.now()) throw new DomainError('im_link_invalid', 'The link code is invalid or expired', 400);
    const member = await sql.query<{ user_id: string }>(
      `SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id
       WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.revoked_at IS NULL AND u.disabled_at IS NULL AND 'domain.read'=ANY(m.capabilities)`,
      [link.workspace_id, link.user_id],
    );
    if (!member.rows[0]) throw new DomainError('im_membership_inactive', 'The member is not active in this workspace', 403);
    const existing = await sql.query<ImBindingRow>(
      'SELECT * FROM im_identities WHERE gateway_id=$1 AND platform=$2 AND bot_self_id=$3 AND platform_user_id=$4 FOR UPDATE',
      [identity.gatewayId, identity.platform, identity.botSelfId, identity.platformUserId],
    );
    const current = existing.rows[0];
    let binding: ImBindingRow;
    if (current && current.revoked_at === null && (current.workspace_id !== link.workspace_id || current.user_id !== link.user_id))
      throw new DomainError('im_already_linked', 'This platform account is already linked to another workspace', 409);
    if (current) {
      if (current.workspace_id !== link.workspace_id || current.user_id !== link.user_id || current.revoked_at !== null) {
        await sql.query("UPDATE im_delivery_jobs SET state='suppressed',last_error_code='binding_rebound',lease_id=NULL,lease_until=NULL WHERE binding_id=$1 AND state IN ('pending','sending')", [current.id]);
      }
      const updated = await sql.query<ImBindingRow>(
        `UPDATE im_identities SET workspace_id=$2,user_id=$3,platform_user_name=$4,reply_channel_id=$5,
         notify_enabled=CASE WHEN workspace_id=$2 AND user_id=$3 THEN notify_enabled ELSE false END,
         notification_cursor=CASE WHEN workspace_id=$2 AND user_id=$3 THEN notification_cursor ELSE 0 END,
         revision=revision+1,verified_at=clock_timestamp(),last_seen_at=clock_timestamp(),revoked_at=NULL
         WHERE id=$1 RETURNING *`,
        [current.id, link.workspace_id, link.user_id, identity.platformUserName, identity.replyChannelId],
      );
      binding = updated.rows[0]!;
    } else {
      const inserted = await sql.query<ImBindingRow>(
        `INSERT INTO im_identities(id,workspace_id,user_id,gateway_id,platform,bot_self_id,platform_user_id,platform_user_name,reply_channel_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [randomUUID(), link.workspace_id, link.user_id, identity.gatewayId, identity.platform, identity.botSelfId, identity.platformUserId, identity.platformUserName, identity.replyChannelId],
      );
      binding = inserted.rows[0]!;
    }
    await sql.query('UPDATE im_link_codes SET consumed_at=clock_timestamp() WHERE code_hash=$1 AND consumed_at IS NULL', [codeHash]);
    await sql.query('INSERT INTO im_link_attempts(platform,bot_self_id,platform_user_id,ok) VALUES($1,$2,$3,true)', [identity.platform, identity.botSelfId, identity.platformUserId]);
    await sql.query('COMMIT');
    committed = true;
    return binding;
  } catch (error) {
    await sql.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    sql.release();
    if (!committed && !rateLimited) await recordLinkAttempt(pool, identity, false);
  }
}

export async function resolveImBinding(pool: Pool, identity: ImIdentity): Promise<ResolvedImBinding> {
  const found = await pool.query<ImBindingRow>(
    'SELECT * FROM im_identities WHERE gateway_id=$1 AND platform=$2 AND bot_self_id=$3 AND platform_user_id=$4 AND revoked_at IS NULL',
    [identity.gatewayId, identity.platform, identity.botSelfId, identity.platformUserId],
  );
  const binding = found.rows[0];
  if (!binding) throw new DomainError('im_not_linked', 'This platform account is not linked', 403);
  const member = await pool.query<Actor & { capabilities: string[]; project_ids: string[] | null }>(
    `SELECT u.id,u.email,u.name,m.capabilities,m.project_ids FROM memberships m JOIN users u ON u.id=m.user_id
     WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.revoked_at IS NULL AND u.disabled_at IS NULL`,
    [binding.workspace_id, binding.user_id],
  );
  const current = member.rows[0];
  if (!current) throw new DomainError('im_membership_inactive', 'The member is not active in this workspace', 403);
  await pool.query(
    'UPDATE im_identities SET last_seen_at=clock_timestamp(),reply_channel_id=$2,platform_user_name=COALESCE($3,platform_user_name) WHERE id=$1 AND revoked_at IS NULL',
    [binding.id, identity.replyChannelId, identity.platformUserName],
  ).catch(() => undefined);
  binding.reply_channel_id = identity.replyChannelId;
  return { binding, actor: { id: current.id, email: current.email, name: current.name }, capabilities: current.capabilities, projectIds: current.project_ids };
}

export async function listImBindings(pool: Pool, actor: Actor, workspaceId: string): Promise<ImBinding[]> {
  await requireCapability(pool, actor, workspaceId, 'domain.read');
  const result = await pool.query<ImBindingRow>(
    'SELECT * FROM im_identities WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL ORDER BY verified_at DESC, id',
    [workspaceId, actor.id],
  );
  return result.rows.map(bindingDto);
}

export async function revokeImBinding(pool: Pool, actor: Actor, workspaceId: string, bindingId: string, checkAuthorization?: (sql: SqlExecutor) => Promise<void>): Promise<{ revoked: true }> {
  const sql = await pool.connect();
  try {
    await sql.query('BEGIN');
    await lockWorkspace(sql, workspaceId);
    await requireCapability(sql, actor, workspaceId, 'domain.read');
    await checkAuthorization?.(sql);
    const found = await sql.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM im_identities WHERE id=$1 AND workspace_id=$2 AND user_id=$3 FOR UPDATE',
      [bindingId, workspaceId, actor.id],
    );
    if (!found.rows[0]) throw new DomainError('im_binding_not_found', 'Binding not found', 404);
    await sql.query('UPDATE im_identities SET revoked_at=COALESCE(revoked_at,clock_timestamp()),revision=revision+1 WHERE id=$1', [bindingId]);
    await sql.query("UPDATE im_delivery_jobs SET state='suppressed',last_error_code='binding_revoked',lease_id=NULL,lease_until=NULL WHERE binding_id=$1 AND state IN ('pending','sending')", [bindingId]);
    await sql.query('COMMIT');
    return { revoked: true };
  } catch (error) {
    await sql.query('ROLLBACK');
    throw error;
  } finally { sql.release(); }
}

export async function setImNotification(pool: Pool, actor: Actor, workspaceId: string, bindingId: string, enabled: boolean, checkAuthorization?: (sql: SqlExecutor) => Promise<void>): Promise<ImBinding> {
  const sql = await pool.connect();
  try {
    await sql.query('BEGIN');
    await lockWorkspace(sql, workspaceId);
    await requireCapability(sql, actor, workspaceId, 'domain.read');
    await checkAuthorization?.(sql);
    const updated = await sql.query<ImBindingRow>(
      `UPDATE im_identities i SET notify_enabled=$4,
       notification_cursor=CASE WHEN $4 THEN w.notification_head ELSE i.notification_cursor END,
       revision=i.revision+1,last_seen_at=clock_timestamp()
       FROM workspaces w WHERE i.id=$1 AND i.workspace_id=$2 AND i.user_id=$3 AND i.revoked_at IS NULL AND w.id=i.workspace_id
       RETURNING i.*`,
      [bindingId, workspaceId, actor.id, enabled],
    );
    if (!updated.rows[0]) throw new DomainError('im_binding_not_found', 'Binding not found', 404);
    await sql.query('COMMIT');
    return bindingDto(updated.rows[0]);
  } catch (error) {
    await sql.query('ROLLBACK');
    throw error;
  } finally { sql.release(); }
}

export async function setImDefaultProject(pool: Pool, binding: ImBindingRow, projectId: string): Promise<void> {
  const updated = await pool.query(
    'UPDATE im_identities SET default_project_id=$2,revision=revision+1,last_seen_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL',
    [binding.id, projectId],
  );
  if (!updated.rowCount) throw new DomainError('im_binding_not_found', 'Binding not found', 404);
}

export async function findImTaskWatch(pool: Pool, actor: Actor, workspaceId: string, taskId: string, projectId: string): Promise<{ id: string; version: number } | null> {
  const result = await pool.query<{ id: string; version: number }>(
    `SELECT id,version FROM dashboard_records
     WHERE workspace_id=$1 AND owner_id=$2 AND project_id=$3 AND kind='task_watch'
       AND data->>'taskId'=$4 AND data->>'watching'='true' ORDER BY version DESC LIMIT 1`,
    [workspaceId, actor.id, projectId, taskId],
  );
  return result.rows[0] ?? null;
}

export async function enqueueImJob(
  sql: SqlExecutor,
  binding: ImBindingRow,
  kind: 'reply' | 'notification',
  sourceId: string,
  payload: string,
  scope: { projectId?: string | null; taskId?: string | null } = {},
): Promise<boolean> {
  const sourceKey = createHash('sha256').update(`${kind}\0${sourceId}`).digest('hex');
  const result = await sql.query(
    `INSERT INTO im_delivery_jobs(id,workspace_id,binding_id,source_kind,source_id,payload,project_id,task_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(binding_id,source_kind,source_id) DO NOTHING`,
    [randomUUID(), binding.workspace_id, binding.id, kind, sourceKey, truncateImText(payload, 8_000), scope.projectId ?? null, scope.taskId ?? null],
  );
  return Boolean(result.rowCount);
}
