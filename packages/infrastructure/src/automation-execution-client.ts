import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { studioExecutionResultSchema, studioRuntimeCapabilitiesSchema, type StudioExecutionPort, type StudioExecutionRequest, type StudioExecutionScope } from '../../contracts/src/automation-studio.ts';
import type { StudioWorkspaceExecutionPort } from '../../contracts/src/automation-studio.ts';
import { executionEnvironmentSchema, executionSelectionSchema } from '../../agent-contracts/src/execution.ts';
import { DomainError } from '../../domain/src/core.ts';

const prefix = 'pm-automation-v1.';
const identitySchema = z.strictObject({ actorId: z.uuid(), workspaceId: z.uuid(), projectId: z.string().regex(/^PRJ-\d+$/), executionId: z.uuid(), requestId: z.uuid(), definitionId: z.uuid(), definitionRevision: z.number().int().positive(), audience: z.enum(['native-pm', 'automation-integrations']), generationId: z.uuid().nullable(), expiresAt: z.number().int(), issuedAt: z.number().int() });
export type AutomationServiceIdentity = z.infer<typeof identitySchema>;
function serviceSecret(explicit?: string): string {
  const value = explicit ?? process.env.PM_AUTOMATION_SERVICE_SECRET ?? '';
  if (Buffer.byteLength(value) < 32) throw new Error('Configure PM_AUTOMATION_SERVICE_SECRET with at least 32 bytes on PM, Worker and Agent.');
  return value;
}
function mac(value: string, secret?: string): string { return createHmac('sha256', serviceSecret(secret)).update(value).digest('base64url'); }
function equal(actual: string, expected: string): boolean { const a = Buffer.from(actual), b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b); }
export function createAutomationServiceBearer(request: StudioExecutionRequest, audience: AutomationServiceIdentity['audience'] = 'native-pm', generationId?: string, secret?: string): string {
  const issuedAt = Date.now();
  if (audience === 'automation-integrations' && !generationId) throw new Error('Integration grants require an exact native generation ID.');
  const data: AutomationServiceIdentity = { actorId: request.actorId, workspaceId: request.workspaceId, projectId: request.projectId, executionId: request.executionId, requestId: request.requestId, definitionId: request.definitionId, definitionRevision: request.definitionRevision, audience, generationId: generationId ?? null, issuedAt, expiresAt: issuedAt + (request.config.action.timeoutSeconds + 300) * 1000 };
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${prefix}${payload}.${mac(`${prefix}${payload}`, secret)}`;
}
/** Authentication only. PM MUST load the immutable execution and recheck current actor/project authority. */
export function verifyAutomationServiceBearer(token: string, audience: AutomationServiceIdentity['audience'] = 'native-pm', secret?: string): AutomationServiceIdentity | null {
  try {
    if (!token.startsWith(prefix) || token.length > 4096) return null;
    const [payload, signature, extra] = token.slice(prefix.length).split('.');
    if (!payload || !signature || extra !== undefined || !equal(signature, mac(`${prefix}${payload}`, secret))) return null;
    const parsed = identitySchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    const now = Date.now();
    return parsed.audience === audience && (audience !== 'automation-integrations' || parsed.generationId !== null) && parsed.expiresAt > now && parsed.expiresAt > parsed.issuedAt && parsed.issuedAt <= now + 30_000 && parsed.expiresAt - parsed.issuedAt <= 86_700_000 ? parsed : null;
  } catch { return null; }
}
export function automationServiceHeaders(method: string, pathname: string, body: string, secret?: string): Headers {
  const timestamp = String(Date.now());
  return new Headers({ 'content-type': 'application/json', 'x-pm-automation-timestamp': timestamp, 'x-pm-automation-signature': mac(`${timestamp}\n${method}\n${pathname}\n${createHash('sha256').update(body).digest('hex')}`, secret) });
}
export function verifyAutomationServiceRequest(method: string, pathname: string, body: string, headers: Headers, secret?: string): boolean {
  try {
    const timestamp = headers.get('x-pm-automation-timestamp') ?? '', signature = headers.get('x-pm-automation-signature') ?? '';
    if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 60_000) return false;
    return equal(signature, mac(`${timestamp}\n${method}\n${pathname}\n${createHash('sha256').update(body).digest('hex')}`, secret));
  } catch { return false; }
}
function origin(value: string | undefined): URL {
  if (!value) throw new Error('Configure PM_AUTOMATION_AGENT_URL for the dedicated Agent service transport.');
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['http:', 'https:'].includes(url.protocol) || (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Automation service transport requires a clean HTTPS origin (HTTP is allowed only on loopback).');
  return url;
}
export function createAutomationExecutionClient(options: { baseUrl?: string; secret?: string; fetch?: typeof fetch } = {}): StudioExecutionPort {
  async function call(operation: string, input: StudioExecutionRequest | StudioExecutionScope): Promise<unknown> {
    const endpoint = new URL(`/internal/automation-executions/${operation}`, origin(options.baseUrl ?? process.env.PM_AUTOMATION_AGENT_URL));
    const body = JSON.stringify(input);
    const response = await (options.fetch ?? fetch)(endpoint, { method: 'POST', headers: automationServiceHeaders('POST', endpoint.pathname, body, options.secret), body, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Automation runtime response has no body.');
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('Automation runtime response exceeds its transport limit.'); }
      chunks.push(part.value);
    }
    const text = Buffer.concat(chunks, size).toString('utf8');
    if (!response.ok) throw new Error(`Automation runtime rejected ${operation} (HTTP ${response.status}); reconcile the original execution ID before any new dispatch.`);
    return JSON.parse(text) as unknown;
  }
  return {
    capabilities: async scope => studioRuntimeCapabilitiesSchema.parse(await call('capabilities', scope)),
    dispatch: async request => studioExecutionResultSchema.parse(await call('dispatch', request)),
    query: async request => studioExecutionResultSchema.parse(await call('query', request)),
    cancel: async request => studioExecutionResultSchema.parse(await call('cancel', request)),
  };
}
export const createConfiguredAutomationExecutionPort = createAutomationExecutionClient;

/** Uses the existing dedicated service secret, never a browser cookie or general PM session. */
export function createAgentWorkspaceExecutionClient(options: { baseUrl?: string; secret?: string; fetch?: typeof fetch } = {}): StudioWorkspaceExecutionPort {
  return {
    async resolve(selection) {
      const parsed = executionSelectionSchema.parse(selection);
      if (parsed.agentWorkspaceId === null) throw new DomainError('agent_workspace_selection_required', 'Select an explicit Agent folder; service preflight does not allocate chat scratch', 412);
      const endpoint = new URL('/internal/agent-workspaces/resolve', origin(options.baseUrl ?? process.env.PM_AUTOMATION_AGENT_URL));
      const body = JSON.stringify({ executionSelection: parsed });
      const response = await (options.fetch ?? fetch)(endpoint, { method: 'POST', headers: automationServiceHeaders('POST', endpoint.pathname, body, options.secret), body, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new DomainError('agent_workspace_unavailable', `The authenticated Agent folder preflight rejected the selected directory (HTTP ${response.status})`, response.status >= 400 && response.status < 500 ? response.status : 503);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new DomainError('agent_workspace_unavailable', 'Agent folder preflight returned no response body', 503);
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length;
        if (size > 64 * 1024) { await reader.cancel(); throw new DomainError('agent_workspace_unavailable', 'Agent folder preflight exceeded its transport limit', 503); }
        chunks.push(part.value);
      }
      const resolved = z.strictObject({ path: z.string().min(1), environment: executionEnvironmentSchema }).parse(JSON.parse(Buffer.concat(chunks, size).toString('utf8')));
      if (resolved.environment.agentWorkspaceId !== parsed.agentWorkspaceId || resolved.environment.agentWorkspaceRevision !== parsed.agentWorkspaceRevision || resolved.environment.executionPath !== resolved.path || resolved.environment.sourcePath !== resolved.path || resolved.environment.worktree !== null)
        throw new DomainError('agent_workspace_unavailable', 'Agent folder preflight returned a different execution identity', 503);
      return resolved;
    },
  };
}
