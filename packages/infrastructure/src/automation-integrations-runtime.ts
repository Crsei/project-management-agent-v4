import { chmod, mkdir, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { AutomationProviderResult } from '../../contracts/src/automation-integrations.ts';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { StudioExecutionRequest } from '../../contracts/src/automation-studio.ts';
import { createAutomationServiceBearer } from './automation-execution-client.ts';

export type AutomationIntegrationBridgeDescriptor = { name: string; transport: 'stdio'; command: string; args: readonly string[] };
export type AutomationIntegrationBridgeGrant = { schemaVersion: 1; url: string; token: string; executionId: string; generationId: string; expiresAt: number };
export type AutomationIntegrationDescriptors = { mcpServers: AutomationIntegrationBridgeDescriptor[]; close: () => Promise<void> };
function brokerUrl(workspaceId: string): string {
  const base = new URL(process.env.PM_API_URL ?? 'http://127.0.0.1:4194');
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' || !['http:', 'https:'].includes(base.protocol) || base.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('PM_API_URL must be a clean HTTPS origin, or HTTP loopback, for the scoped automation broker.');
  return new URL(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/automations/integrations/runtime`, base).href;
}
async function grantRequest(grant: AutomationIntegrationBridgeGrant, method: 'grant/open' | 'grant/close'): Promise<{ mcpAvailable?: boolean }> {
  const response = await fetch(grant.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${grant.token}` }, body: JSON.stringify({ executionId: grant.executionId, generationId: grant.generationId, method }), redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok && !(method === 'grant/close' && Date.now() >= grant.expiresAt)) throw new Error(`Scoped integration grant ${method} was not confirmed (HTTP ${response.status}).`);
  if (!response.ok) return {};
  const value = await response.json() as { mcpAvailable?: unknown };
  return typeof value.mcpAvailable === 'boolean' ? { mcpAvailable: value.mcpAvailable } : {};
}
/** Called during startup recovery before removing a stale generation-private grant file. */
export async function recoverAutomationIntegrationGrantFile(filename: string): Promise<void> {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 16384) throw new Error('Unsafe automation integration grant file.');
  let grant: AutomationIntegrationBridgeGrant;
  try { grant = JSON.parse(await readFile(filename, 'utf8')) as AutomationIntegrationBridgeGrant; }
  catch { throw new Error('Invalid private automation integration grant data; repair the retained recovery record without echoing its contents.'); }
  let valid = false;
  try { valid = grant.schemaVersion === 1 && Boolean(grant.executionId) && Boolean(grant.generationId) && typeof grant.token === 'string' && Number.isFinite(grant.expiresAt) && grant.url === brokerUrl(new URL(grant.url).pathname.split('/')[4]!); } catch { valid = false; }
  if (!valid) throw new Error('Invalid automation integration grant file.');
  if (Date.now() < grant.expiresAt) await grantRequest(grant, 'grant/close');
  await rm(filename, { force: true });
}
/** Startup recovery visits only this feature's UUID generation directories and known grant filenames. */
export async function recoverAutomationIntegrationGrants(grantRoot: string, isLiveGeneration?: (generationId: string) => boolean): Promise<void> {
  let entries;
  try { entries = await readdir(grantRoot, { withFileTypes: true }); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return; throw error; }
  const failures: unknown[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/i.test(entry.name)) continue;
    if (isLiveGeneration?.(entry.name)) continue;
    const directory = path.join(grantRoot, entry.name);
    for (const file of await readdir(directory, { withFileTypes: true })) {
      if (!file.isFile() || !/^integrations-[a-f0-9-]{36}\.json$/i.test(file.name)) continue;
      try { await recoverAutomationIntegrationGrantFile(path.join(directory, file.name)); }
      catch (error) { failures.push(error); }
    }
    if (!(await readdir(directory)).length) await rm(directory, { recursive: true });
  }
  if (failures.length) throw new AggregateError(failures, 'Some previous native integration grants could not be revoked; their private recovery records were retained.');
}
/** Grant contains only a narrow audience/execution/generation bearer; never the shared PM secret. */
export async function resolveAutomationIntegrationDescriptors(input: { request: StudioExecutionRequest; headers: Headers; generationId: string; grantDirectory: string }): Promise<AutomationIntegrationDescriptors> {
  if (!input.request.config.action.plugins.some(plugin => plugin.id.startsWith('integration:'))) return { mcpServers: [], close: async () => {} };
  const grant: AutomationIntegrationBridgeGrant = { schemaVersion: 1, url: brokerUrl(input.request.workspaceId), token: createAutomationServiceBearer(input.request, 'automation-integrations', input.generationId), executionId: input.request.executionId, generationId: input.generationId, expiresAt: Date.now() + (input.request.config.action.timeoutSeconds + 300) * 1000 };
  await mkdir(input.grantDirectory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(input.grantDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Automation native grant directory is not a private directory.');
  await chmod(input.grantDirectory, 0o700);
  const filename = path.join(input.grantDirectory, `integrations-${input.generationId}.json`);
  await writeFile(filename, JSON.stringify(grant), { flag: 'wx', mode: 0o600 });
  // A possibly accepted grant/open must always have a durable private recovery identity first.
  const granted = await grantRequest(grant, 'grant/open');
  if (granted.mcpAvailable === false) {
    await grantRequest(grant, 'grant/close'); await rm(filename, { force: true });
    return { mcpServers: [], close: async () => {} };
  }
  let closed = false;
  const packagedExecutable = fileURLToPath(new URL('./pm-cli/automation-tools.mjs', import.meta.url));
  const executable = existsSync(packagedExecutable) ? packagedExecutable : fileURLToPath(new URL('../../pm-cli/automation-tools.mjs', import.meta.url));
  return {
    mcpServers: [{ name: 'automation_integrations', transport: 'stdio', command: process.execPath, args: [executable, '--grant-file', filename] }],
    close: async () => { if (closed) return; await grantRequest(grant, 'grant/close'); await rm(filename, { force: true }); closed = true; },
  };
}

export class AutomationProviderApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly operationId: string | undefined;
  constructor(status: number, code: string, message: string, operationId?: string) { super(message); this.name = 'AutomationProviderApiError'; this.status = status; this.code = code; this.operationId = operationId; }
}
export type AutomationProviderJsonOptions = { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: Record<string, unknown>; operationKey: string };
export interface AutomationProviderJsonClient {
  requestJson(provider: 'github' | 'gitlab', relativeApiPath: string, options: AutomationProviderJsonOptions): Promise<unknown>;
  assertProviderOrigin(provider: 'github' | 'gitlab', sourceUrl: string): Promise<void>;
  close(): Promise<void>;
}
/** Server-only native-template API client. The opaque bearer never enters a Provider prompt or caller-visible result. */
export function createAutomationProviderJsonClient(request: StudioExecutionRequest): AutomationProviderJsonClient {
  const generationId = randomUUID();
  const grant: AutomationIntegrationBridgeGrant = { schemaVersion: 1, url: brokerUrl(request.workspaceId), token: createAutomationServiceBearer(request, 'automation-integrations', generationId), executionId: request.executionId, generationId, expiresAt: Date.now() + (request.config.action.timeoutSeconds + 300) * 1000 };
  let openAttempted = false; let opened = false; let closed = false;
  async function send(method: 'provider/request' | 'provider/origin', params: Record<string, unknown>): Promise<unknown> {
    if (closed) throw new AutomationProviderApiError(409, 'integration_grant_revoked', 'Native provider client was already closed.');
    if (!opened) { openAttempted = true; await grantRequest(grant, 'grant/open'); opened = true; }
    try {
      const response = await fetch(grant.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${grant.token}` }, body: JSON.stringify({ executionId: request.executionId, generationId, method, params }), redirect: 'error', signal: AbortSignal.timeout(30000) });
      const text = await response.text();
      if (Buffer.byteLength(text) > 5 * 1024 * 1024) throw new Error('Response exceeds bound');
      const result = JSON.parse(text) as unknown;
      if (!response.ok) {
        const failure = result && typeof result === 'object' && 'error' in result && result.error && typeof result.error === 'object' ? result.error : null;
        throw new AutomationProviderApiError(response.status, failure && 'code' in failure ? String(failure.code) : 'integration_request_rejected', failure && 'message' in failure ? String(failure.message) : 'Scoped provider request was rejected.');
      }
      return result;
    } catch (error) {
      if (error instanceof AutomationProviderApiError) throw error;
      throw new AutomationProviderApiError(502, 'integration_outcome_unknown', 'The original scoped provider request was not confirmed; do not repeat an external mutation with a new operation key.');
    }
  }
  return {
    async requestJson(provider, relativeApiPath, options) {
      if (!options.operationKey || options.operationKey.length > 1000) throw new AutomationProviderApiError(400, 'validation_failed', 'A stable bounded provider operation key is required.');
      const digest = createHash('sha256').update(`${request.executionId}\n${options.operationKey}`).digest();
      digest[6] = (digest[6]! & 0x0f) | 0x50; digest[8] = (digest[8]! & 0x3f) | 0x80;
      const hex = digest.toString('hex').slice(0, 32); const operationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      try {
        const result = await send('provider/request', { provider, operationId, method: options.method ?? 'GET', path: relativeApiPath, ...(options.body === undefined ? {} : { body: options.body }) }) as AutomationProviderResult;
        if (result.status < 200 || result.status >= 300) throw new AutomationProviderApiError(result.status, 'provider_request_rejected', `Provider rejected the confirmed original request (HTTP ${result.status}).`);
        return result.body;
      } catch (error) {
        if (error instanceof AutomationProviderApiError) throw new AutomationProviderApiError(error.status, error.code, `${error.message} Original operation: ${operationId}.`, operationId);
        throw error;
      }
    },
    async assertProviderOrigin(provider, sourceUrl) {
      const source = new URL(sourceUrl);
      if (source.username || source.password || source.search || source.hash || !['/', '/api/v4', '/api/v4/'].includes(source.pathname)) throw new AutomationProviderApiError(400, 'integration_origin_mismatch', 'Source provider API URL is not a clean provider origin.');
      const result = await send('provider/origin', { provider }) as { origin: string };
      if (result.origin !== source.origin) throw new AutomationProviderApiError(403, 'integration_origin_mismatch', 'Source template API origin does not match the explicitly configured private connection.');
    },
    async close() { if (closed) return; try { if (openAttempted) await grantRequest(grant, 'grant/close'); closed = true; } catch { throw new AutomationProviderApiError(502, 'integration_outcome_unknown', 'Native generation integration grant revocation was not confirmed; its authority expires at the signed deadline.'); } },
  };
}
