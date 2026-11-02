import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { Pool } from 'pg';
import { AUTOMATION_TRANSFER_LIMITS, automationBundleSchema, sourceAutomationSchema, type AutomationBundleFile, type AutomationBundleUpload, type AutomationTransferExport, type AutomationTransferInput, type AutomationTransferPreview, type AutomationTransferReceipt } from '../../contracts/src/automation-transfer.ts';
import { studioConfigSchema, type StudioConfig, type StudioDefinition, type StudioReceipt, type StudioValidation } from '../../contracts/src/automation-studio.ts';
import { DomainError, type Actor } from '../../domain/src/core.ts';
import type { NotificationCorePort } from '../../pm-core/readonly.ts';
import { lockWorkspace } from '../../infrastructure/src/database.ts';
import { authorizeAutomationProject, automationSnapshot } from './automation-report.ts';
import { requestHash } from './kernel.ts';

export interface AutomationTransferStudio {
  create(actor: Actor, workspaceId: string, input: { requestId: string; config: StudioConfig }): Promise<StudioDefinition>;
  update(actor: Actor, workspaceId: string, id: string, input: { requestId: string; expectedRevision: number; config: StudioConfig }): Promise<StudioDefinition>;
  definition(actor: Actor, workspaceId: string, id: string): Promise<StudioDefinition>;
  definitions(actor: Actor, workspaceId: string, cursor?: string): Promise<{ items: StudioDefinition[]; nextCursor: string | null }>;
  validate(actor: Actor, workspaceId: string, config: StudioConfig): Promise<StudioValidation>;
  receipt(actor: Actor, workspaceId: string, requestId: string): Promise<StudioReceipt>;
}
export function deterministicAutomationId(value: string): string { const hex = createHash('sha256').update(value).digest('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`; }
export function automationConfigHash(config: StudioConfig): string { return requestHash(config); }
function invalid(message: string): never { throw new DomainError('automation_transfer_invalid', message, 400); }
export function parseAutomationTransfer(input: AutomationTransferInput): { config: StudioConfig; format: 'source' | 'bundle'; warnings: string[] } {
  const serialized = JSON.stringify(input.document);
  if (typeof serialized !== 'string') invalid('Expected a JSON definition object');
  if (Buffer.byteLength(serialized) > AUTOMATION_TRANSFER_LIMITS.jsonBytes) invalid('Definition exceeds the 3 MiB JSON limit');
  const object = input.document as { kind?: unknown } | null;
  if (object?.kind === 'pm-automation-bundle') {
    const parsed = automationBundleSchema.safeParse(input.document);
    if (!parsed.success) invalid(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    if (parsed.data.spec.projectId !== input.projectId) invalid('Bundle projectId differs from the selected project; explicitly edit the bundle before importing');
    validateScriptFiles(parsed.data.spec);
    return { config: parsed.data.spec, format: 'bundle', warnings: ['Imported as a saved draft. Credentials and activation are never imported.'] };
  }
  const parsed = sourceAutomationSchema.safeParse(input.document);
  if (!parsed.success) invalid(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  const spec = parsed.data.spec;
  if (spec.notification) invalid('Source notification delivery is not portable; remove notification explicitly before importing');
  if (!input.providerInstanceId || !(input.model ?? spec.model)) invalid('Source files do not identify a local Provider. Select a Provider and model explicitly');
  if (spec.timezone && spec.trigger.timezone && spec.timezone !== spec.trigger.timezone) invalid('Conflicting source timezone values');
  let trigger: StudioConfig['trigger'];
  if (spec.trigger.type === 'event') {
    const eventKey = Array.isArray(spec.trigger.on) && spec.trigger.on.length === 1 ? spec.trigger.on[0] : spec.trigger.on;
    if (!spec.trigger.source || typeof eventKey !== 'string' || !eventKey) invalid('Source event imports require exactly one event key');
    if (spec.trigger.filter) invalid('Source JMESPath filters are not PM JSON filters; explicit conversion is required');
    if (spec.trigger.schedule || spec.trigger.timezone || spec.timezone) invalid('Schedule fields on event imports are not supported');
    trigger = { kind: 'event', source: spec.trigger.source, key: eventKey, filter: {} };
  } else {
    if (!spec.trigger.schedule || spec.trigger.source || spec.trigger.on || spec.trigger.filter) invalid('Scheduled import requires schedule only, without event fields');
    trigger = { kind: 'cron', expression: spec.trigger.schedule, timezone: spec.timezone ?? spec.trigger.timezone ?? 'UTC' };
  }
  const config = studioConfigSchema.parse({ name: spec.name, description: '', projectId: input.projectId, tags: [], templateId: null, action: { kind: 'prompt', prompt: spec.prompt, providerInstanceId: input.providerInstanceId, model: input.model ?? spec.model, options: {}, repositories: spec.repository ? [{ id: spec.repository, ref: spec.branch ?? null }] : [], plugins: (spec.plugins ?? []).map(id => ({ id, version: null })), timeoutSeconds: spec.timeout ?? 600 }, trigger, dailyLimit: 10, cooldownMinutes: 0 });
  return { config, format: 'source', warnings: ['Imported disabled as a draft regardless of source enabled.', 'Source JSON has no PM Provider identity, project, tags, description or budget. Explicit local Provider/project and default dailyLimit=10/cooldownMinutes=0 are used.', 'Source cron remains recurring; it is never inferred to mean one-time.', ...(spec.trigger.schedule_human ? ['schedule_human is a display-only source label, not part of the supported round-trip definition fields; its schedule expression/timezone are preserved.'] : [])] };
}
export function validateScriptFiles(config: StudioConfig): void {
  if (config.action.kind !== 'script') return;
  const files = config.action.files;
  if (config.action.bundleRef && files.length === 0) invalid('Opaque bundle references without frozen files cannot be imported');
  let bytes = 0; const seen = new Set<string>();
  for (const file of files) {
    validateBundlePath(file.path);
    if (seen.has(file.path)) invalid(`Duplicate bundle path: ${file.path}`);
    seen.add(file.path); bytes += Buffer.byteLength(file.content);
  }
  if (files.length > AUTOMATION_TRANSFER_LIMITS.files || bytes > AUTOMATION_TRANSFER_LIMITS.expandedBytes) invalid('Script files exceed 200 files or 2 MiB expanded');
}
function validateBundlePath(path: string): void {
  if (!path || path.length > 240 || path.startsWith('/') || path.includes('\\') || /[\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) invalid(`Unsafe bundle path: ${path}`);
}
export function decodeAutomationTar(archiveBase64: string): AutomationBundleFile[] {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(archiveBase64)) invalid('Invalid archive base64');
  const compressed = Buffer.from(archiveBase64, 'base64');
  if (compressed.length > AUTOMATION_TRANSFER_LIMITS.archiveBytes) invalid('Compressed bundle exceeds 2 MiB');
  let tar: Buffer;
  try { tar = gunzipSync(compressed, { maxOutputLength: AUTOMATION_TRANSFER_LIMITS.expandedBytes + 512 * (AUTOMATION_TRANSFER_LIMITS.files + 4) }); } catch { invalid('Invalid gzip bundle or expanded size exceeds limit'); }
  const files: AutomationBundleFile[] = [], seen = new Set<string>(); let total = 0, offset = 0, ended = false;
  const text = (buffer: Buffer) => { const value = new TextDecoder('utf-8', { fatal: true }).decode(buffer); if (value.includes('\0')) invalid('Binary files are not supported by the UTF-8 script bundle format'); return value; };
  for (; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(value => value === 0)) { if (offset + 512 > tar.length || tar.subarray(offset, offset + 512).some(value => value !== 0)) invalid('Tar end marker is truncated'); ended = true; break; }
    const field = (start: number, length: number) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '').trimEnd();
    const checksumText = field(148, 8).trim();
    if (!/^[0-7]+$/.test(checksumText)) invalid('Invalid tar checksum');
    const checksum = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
    if (checksum !== parseInt(checksumText, 8)) invalid('Tar checksum mismatch');
    const rawSize = field(124, 12).trim();
    if (!/^[0-7]+$/.test(rawSize)) invalid('Invalid tar entry size');
    const size = parseInt(rawSize, 8), type = field(156, 1), prefix = field(345, 155);
    let path = `${prefix ? prefix + '/' : ''}${field(0, 100)}`;
    while (path.startsWith('./')) path = path.slice(2);
    if (type === '5') { if (size !== 0) invalid('Nonempty tar directory'); validateBundlePath(path.replace(/\/$/, '')); continue; }
    if (type !== '' && type !== '0') invalid('Only regular files/directories are allowed; links, devices and tar extensions are rejected');
    validateBundlePath(path);
    if (seen.has(path)) invalid(`Duplicate bundle path: ${path}`);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > tar.length) invalid('Truncated tar entry');
    total += size; if (total > AUTOMATION_TRANSFER_LIMITS.expandedBytes || files.length >= AUTOMATION_TRANSFER_LIMITS.files) invalid('Bundle exceeds 200 files or 2 MiB expanded');
    let content: string; try { content = text(tar.subarray(offset, offset + size)); } catch { invalid('Bundle files must be valid UTF-8 text'); }
    files.push({ path, content }); seen.add(path); offset += Math.ceil(size / 512) * 512;
  }
  if (!ended || files.length === 0 || tar.subarray(offset).some(value => value !== 0)) invalid('Empty, truncated or trailing-content tar bundle');
  return files;
}
export function exportAutomationDefinition(definition: StudioDefinition, format: 'source' | 'bundle'): AutomationTransferExport {
  const config = studioConfigSchema.parse(definition.config); validateScriptFiles(config);
  let document: unknown;
  if (format === 'bundle') document = { version: 1, kind: 'pm-automation-bundle', spec: config };
  else {
    const action = config.action;
    if (action.kind !== 'prompt' || config.tags.length || config.description || config.templateId || config.templateInputs !== undefined || config.templateVersion !== undefined || config.dailyLimit !== 10 || config.cooldownMinutes !== 0 || Object.keys(action.options).length || action.repositories.length > 1 || action.plugins.some(plugin => plugin.version !== null) || !['cron', 'event'].includes(config.trigger.kind)) invalid('Source JSON cannot represent this definition losslessly. Use the complete PM bundle (native templates, scripts, tags, metadata, budgets, multiple repositories, options, once/manual require it)');
    const trigger = config.trigger;
    if (trigger.kind === 'event' && Object.keys(trigger.filter).length) invalid('PM event filters have no lossless source JSON representation');
    document = { version: 1, kind: 'automation', spec: { name: config.name, prompt: action.prompt, enabled: definition.status === 'enabled', model: action.model, timeout: action.timeoutSeconds, plugins: action.plugins.map(plugin => plugin.id), ...(action.repositories[0] ? { repository: action.repositories[0].id, ...(action.repositories[0].ref !== null ? { branch: action.repositories[0].ref } : {}) } : {}), trigger: trigger.kind === 'cron' ? { type: 'cron', schedule: trigger.expression, timezone: trigger.timezone } : trigger.kind === 'event' ? { type: 'event', source: trigger.source, on: trigger.key } : invalid('Unsupported source trigger') } };
  }
  if (Buffer.byteLength(JSON.stringify(document, null, 2)) > AUTOMATION_TRANSFER_LIMITS.jsonBytes) invalid('Export exceeds the 3 MiB JSON interchange limit; no incomplete file was produced');
  return { filename: `${config.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || definition.id}.${format === 'source' ? 'automation' : 'automation-bundle'}.json`, document, limits: AUTOMATION_TRANSFER_LIMITS };
}
export function createAutomationTransferService(options: { database: () => Pool; core: NotificationCorePort; studio: AutomationTransferStudio }) {
  async function authorize(actor: Actor, workspaceId: string, projectId: string, write: boolean) { await authorizeAutomationProject(options.database(), actor, workspaceId, projectId, await automationSnapshot(options.core, workspaceId), write); }
  async function receipt(actor: Actor, workspaceId: string, requestId: string): Promise<AutomationTransferReceipt> {
    const row = (await options.database().query<{ project_id: string; status: AutomationTransferReceipt['status']; result: AutomationTransferReceipt | null }>('SELECT project_id,status,result FROM automation_transfer_imports WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3', [workspaceId, actor.id, requestId])).rows[0];
    if (!row) throw new DomainError('not_found_or_forbidden', 'Import receipt is not accessible', 404);
    await authorize(actor, workspaceId, row.project_id, false);
    if (row.result) return row.result;
    try {
      const original = await options.studio.receipt(actor, workspaceId, deterministicAutomationId(`transfer:${workspaceId}:${actor.id}:${requestId}`));
      const value = original.result as StudioDefinition | { error?: { code: string; message: string } };
      const result: AutomationTransferReceipt = original.httpStatus < 400 && value && 'config' in value
        ? { requestId, status: 'completed', definition: value, error: null }
        : { requestId, status: 'rejected', definition: null, error: value && 'error' in value && value.error ? value.error : { code: 'automation_import_rejected', message: 'Definition creation was rejected' } };
      await options.database().query("UPDATE automation_transfer_imports SET status=$4,result=$5::jsonb WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3 AND status='pending'", [workspaceId, actor.id, requestId, result.status, JSON.stringify(result)]);
      return result;
    } catch (error) {
      if (!(error instanceof DomainError) || error.status !== 404) throw error;
      return { requestId, status: 'pending', definition: null, error: null };
    }
  }
  return {
    async preview(actor: Actor, workspaceId: string, input: AutomationTransferInput): Promise<AutomationTransferPreview> {
      await authorize(actor, workspaceId, input.projectId, false); const parsed = parseAutomationTransfer(input);
      return { ...parsed, validation: await options.studio.validate(actor, workspaceId, parsed.config) };
    },
    async import(actor: Actor, workspaceId: string, input: AutomationTransferInput & { requestId: string }): Promise<AutomationTransferReceipt> {
      await authorize(actor, workspaceId, input.projectId, true); const parsed = parseAutomationTransfer(input), hash = requestHash(input);
      const sql = await options.database().connect();
      try { await sql.query('BEGIN'); await lockWorkspace(sql, workspaceId); await authorizeAutomationProject(sql, actor, workspaceId, input.projectId, await automationSnapshot(options.core, workspaceId), true);
        const existing = (await sql.query<{ request_hash: string; result: AutomationTransferReceipt | null }>('SELECT request_hash,result FROM automation_transfer_imports WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3', [workspaceId, actor.id, input.requestId])).rows[0];
        if (existing && existing.request_hash !== hash) throw new DomainError('idempotency_conflict', 'Import request ID already represents different content', 409);
        if (!existing) await sql.query('INSERT INTO automation_transfer_imports(workspace_id,actor_id,request_id,project_id,request_hash,config) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [workspaceId, actor.id, input.requestId, input.projectId, hash, JSON.stringify(parsed.config)]);
        await sql.query('COMMIT'); if (existing?.result) return existing.result;
      } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
      let result: AutomationTransferReceipt;
      try { const definition = await options.studio.create(actor, workspaceId, { requestId: deterministicAutomationId(`transfer:${workspaceId}:${actor.id}:${input.requestId}`), config: parsed.config }); result = { requestId: input.requestId, status: 'completed', definition, error: null }; }
      catch (error) { if (!(error instanceof DomainError) || error.status >= 500) throw error; result = { requestId: input.requestId, status: 'rejected', definition: null, error: { code: error.code, message: error.message } }; }
      await options.database().query("UPDATE automation_transfer_imports SET status=$4,result=$5::jsonb WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3 AND status='pending'", [workspaceId, actor.id, input.requestId, result.status, JSON.stringify(result)]);
      return receipt(actor, workspaceId, input.requestId);
    },
    receipt,
    async export(actor: Actor, workspaceId: string, definitionId: string, format: 'source' | 'bundle') { return exportAutomationDefinition(await options.studio.definition(actor, workspaceId, definitionId), format); },
    async uploadBundleReceipt(actor: Actor, workspaceId: string, requestId: string): Promise<AutomationBundleUpload> {
      const row = (await options.database().query<{ id: string; project_id: string; sha256: string; files: AutomationBundleFile[] }>('SELECT id,project_id,sha256,files FROM automation_transfer_bundles WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3', [workspaceId, actor.id, requestId])).rows[0];
      if (!row) throw new DomainError('not_found_or_forbidden', 'Bundle upload receipt is not accessible', 404);
      await authorize(actor, workspaceId, row.project_id, false);
      return { bundleId: row.id, sha256: row.sha256, files: row.files };
    },
    async uploadBundle(actor: Actor, workspaceId: string, input: { requestId: string; projectId: string; filename: string; archiveBase64: string }): Promise<AutomationBundleUpload> {
      await authorize(actor, workspaceId, input.projectId, true);
      if (!/\.(tar\.gz|tgz)$/i.test(input.filename)) invalid('Expected a .tar.gz or .tgz file');
      const files = decodeAutomationTar(input.archiveBase64), hash = requestHash(input), sha256 = createHash('sha256').update(Buffer.from(input.archiveBase64, 'base64')).digest('hex');
      const sql = await options.database().connect();
      try { await sql.query('BEGIN'); await lockWorkspace(sql, workspaceId); await authorizeAutomationProject(sql, actor, workspaceId, input.projectId, await automationSnapshot(options.core, workspaceId), true);
        const prior = (await sql.query<{ id: string; request_hash: string; sha256: string; files: AutomationBundleFile[] }>('SELECT * FROM automation_transfer_bundles WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3', [workspaceId, actor.id, input.requestId])).rows[0];
        if (prior && prior.request_hash !== hash) throw new DomainError('idempotency_conflict', 'Upload request ID already represents different content', 409);
        const id = prior?.id ?? randomUUID();
        if (!prior) await sql.query('INSERT INTO automation_transfer_bundles(id,workspace_id,actor_id,project_id,request_id,request_hash,sha256,files) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [id, workspaceId, actor.id, input.projectId, input.requestId, hash, sha256, JSON.stringify(files)]);
        await sql.query('COMMIT'); return { bundleId: id, sha256: prior?.sha256 ?? sha256, files: prior?.files ?? files };
      } catch (error) { await sql.query('ROLLBACK'); throw error; } finally { sql.release(); }
    },
  };
}

/** Recover accepted import intents after a PM process dies between its two durable writes. */
export async function runAutomationTransferCycle(options: { database: () => Pool; core: NotificationCorePort; studio: AutomationTransferStudio }): Promise<void> {
  const rows = (await options.database().query<{ workspace_id: string; actor_id: string; request_id: string; project_id: string; config: StudioConfig }>("SELECT workspace_id,actor_id,request_id,project_id,config FROM automation_transfer_imports WHERE status='pending' ORDER BY created_at LIMIT 10")).rows;
  for (const row of rows) {
    const actor: Actor = { id: row.actor_id, name: '', email: '' };
    let result: AutomationTransferReceipt;
    try {
      await authorizeAutomationProject(options.database(), actor, row.workspace_id, row.project_id, await automationSnapshot(options.core, row.workspace_id), true);
      const definition = await options.studio.create(actor, row.workspace_id, { requestId: deterministicAutomationId(`transfer:${row.workspace_id}:${row.actor_id}:${row.request_id}`), config: studioConfigSchema.parse(row.config) });
      result = { requestId: row.request_id, status: 'completed', definition, error: null };
    } catch (error) {
      if (!(error instanceof DomainError) || error.status >= 500) continue;
      result = { requestId: row.request_id, status: 'rejected', definition: null, error: { code: error.code, message: error.message } };
    }
    await options.database().query("UPDATE automation_transfer_imports SET status=$4,result=$5::jsonb WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3 AND status='pending'", [row.workspace_id, row.actor_id, row.request_id, result.status, JSON.stringify(result)]);
  }
}
