import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { mcpEqual, mcpMac } from '../../../../../packages/infrastructure/src/mcp-service-auth.ts';
import { deleteRecord, readRecord, transaction } from '../durable/store.ts';
import { listThreads } from '../durable/threads.ts';
import { assertMcpThreadEligible, boundedRecord, currentGrant, digest, grantIdentity, MCP_CODES, MCP_CONSENTS, MCP_GRANTS, MCP_TOKENS, McpAuthError, opaque, putGrant, type Grant } from './grants.ts';
import { mcpPublicOrigin, pmBrowser, pmRequest, type McpCatalog } from './identity.ts';

// Derived from pinned apps/server/src/auth/McpOAuth.ts: redirect matching, stateless
// signed registration, authorization validation, session CSRF, one-use S256 code exchange.
// PM adaptation: fixed issuer, real PM session, explicit scope/threads, durable hashed records.
export const MCP_SCOPES = ['orchestration:read', 'orchestration:operate'] as const;
const loopback: Record<string, true> = { localhost: true, '127.0.0.1': true, '[::1]': true };
const clientSchema = z.strictObject({ v: z.literal(1), n: z.string().min(1).max(100), r: z.array(z.string().max(512)).min(1).max(5), exp: z.number().int() });
export const authorizationSchema = z.strictObject({ client_id: z.string().min(1).max(5000), redirect_uri: z.string().max(512), response_type: z.literal('code'), code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256'), state: z.string().min(1).max(1024), resource: z.string().max(2048).optional(), scope: z.string().max(128).optional() });
export type Authorization = z.infer<typeof authorizationSchema>;
const selectionSchema = z.strictObject({ workspaceId: z.uuid(), projectId: z.string().regex(/^PRJ-\d+$/).nullable() });
const decisionSchema = z.discriminatedUnion('_tag', [z.strictObject({ _tag: z.literal('deny'), csrfToken: z.string().max(128) }), z.strictObject({ _tag: z.literal('approve'), csrfToken: z.string().max(128), scope: selectionSchema, threadIds: z.array(z.string().min(1).max(256)).max(1000), access: z.enum(['read-only', 'full']).default('read-only') })]);
export function parseRedirect(value: string): URL | undefined {
  if (value.length > 512 || value.includes('#')) return undefined;
  try { const url = new URL(value); return (url.protocol === 'https:' || url.protocol === 'http:' && Object.hasOwn(loopback, url.hostname)) && !url.username && !url.password ? url : undefined; } catch { return undefined; }
}
export function redirectMatches(registered: string, presented: string): boolean {
  const left = parseRedirect(registered), right = parseRedirect(presented);
  if (!left || !right) return false;
  if (left.protocol === 'https:' || right.protocol === 'https:') return left.href === right.href;
  return left.hostname === right.hostname && left.pathname === right.pathname && left.search === right.search;
}
function client(clientId: string) {
  const [payload, signature, extra] = clientId.split('.');
  if (!payload || !signature || extra !== undefined || !mcpEqual(signature, mcpMac('client-id', payload))) throw new McpAuthError('invalid_client', 'Unknown registered client.');
  let parsed: z.infer<typeof clientSchema>;
  try { parsed = clientSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))); } catch { throw new McpAuthError('invalid_client', 'Invalid registered client.'); }
  if (parsed.exp <= Date.now() || !parsed.r.every(uri => parseRedirect(uri))) throw new McpAuthError('invalid_client', 'Client registration expired. Register again.');
  return parsed;
}
export function registerClient(input: unknown) {
  const metadata = z.object({ client_name: z.string().max(1000).optional(), redirect_uris: z.array(z.string().max(512)).min(1).max(5) }).parse(input);
  if (!metadata.redirect_uris.every(uri => parseRedirect(uri))) throw new McpAuthError('invalid_redirect_uri', 'Redirects require HTTPS or loopback HTTP, without fragments or user info.');
  const name = (metadata.client_name?.trim() || 'MCP client').slice(0, 100);
  const payload = Buffer.from(JSON.stringify({ v: 1, n: name, r: metadata.redirect_uris, exp: Date.now() + 30 * 86400_000 })).toString('base64url');
  return { client_id: `${payload}.${mcpMac('client-id', payload)}`, client_name: name, redirect_uris: metadata.redirect_uris, grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: MCP_SCOPES.join(' ') };
}
export function validateAuthorization(input: unknown): Authorization {
  const authorization = authorizationSchema.parse(input), registered = client(authorization.client_id);
  if (!registered.r.some(uri => redirectMatches(uri, authorization.redirect_uri))) throw new McpAuthError('invalid_request', 'Redirect URI was not registered.');
  if (authorization.resource !== undefined && authorization.resource !== `${mcpPublicOrigin()}/mcp`) throw new McpAuthError('invalid_target', 'Resource audience does not match this MCP server.');
  if (authorization.scope !== undefined && authorization.scope.split(' ').some(scope => !MCP_SCOPES.includes(scope as typeof MCP_SCOPES[number]))) throw new McpAuthError('invalid_scope', 'Unsupported OAuth scope.');
  return authorization;
}
/** Native page-error/redirect-error split: never redirect an unregistered client or URI. */
export function authorizationFailureRedirect(input: Record<string, string>, error: unknown): string | null {
  if (!(error instanceof McpAuthError) && !(error instanceof z.ZodError)) return null;
  if (!input.client_id || input.client_id.length > 5000 || !input.redirect_uri || (input.state?.length ?? 0) > 1024) return null;
  let registered: z.infer<typeof clientSchema>;
  try { registered = client(input.client_id); } catch { return null; }
  if (!registered.r.some(uri => redirectMatches(uri, input.redirect_uri!))) return null;
  const url = new URL(input.redirect_uri);
  url.searchParams.set('error', input.response_type !== 'code' ? 'unsupported_response_type' : error instanceof McpAuthError ? error.code : 'invalid_request');
  url.searchParams.set('error_description', error instanceof McpAuthError ? error.message : 'Malformed authorization request.');
  if (input.state !== undefined) url.searchParams.set('state', input.state);
  url.searchParams.set('iss', mcpPublicOrigin());
  return url.href;
}
export function requireBrowserOrigin(request: Request): void {
  if (request.headers.get('origin') !== mcpPublicOrigin() || request.headers.get('sec-fetch-site') === 'cross-site') throw new McpAuthError('access_denied', 'Same-origin browser request required.', 403);
}
export function managementCsrf(actorId: string, sessionHash: string): string { return mcpMac('manage-csrf', JSON.stringify([actorId, sessionHash, mcpPublicOrigin()])); }
function authorizationHash(authorization: Authorization): string { return digest(JSON.stringify(authorization)); }
type Consent = { key: string; expiresAt: number; actorId: string; sessionHash: string; authorizationHash: string };
type PendingCode = { key: string; expiresAt: number; clientHash: string; redirectUri: string; challenge: string; resource: string; grantId: string };
export async function approval(request: Request, input: unknown) {
  requireBrowserOrigin(request);
  const authorization = validateAuthorization(input), browser = await pmBrowser(request);
  const catalog = await pmRequest('/api/v1/agent-contexts', browser.headers) as McpCatalog;
  const csrfToken = opaque();
  transaction(() => boundedRecord<Consent>(MCP_CONSENTS, { key: digest(csrfToken), expiresAt: Date.now() + 600_000, actorId: browser.actorId, sessionHash: browser.sessionHash, authorizationHash: authorizationHash(authorization) }));
  const threads = listThreads().filter(thread => !thread.deleted && thread.executionSelection?.agentWorkspaceId === null &&
    thread.executionSelection.agentWorkspaceRevision === null).slice(0, 1000).map(thread => ({ id: thread.remoteId, title: thread.title ?? '' }));
  const allowedAccess = authorization.scope === undefined || authorization.scope.split(' ').includes('orchestration:operate') ? ['read-only', 'full'] : ['read-only'];
  return { clientName: client(authorization.client_id).n, redirectHost: new URL(authorization.redirect_uri).host, csrfToken, authorization, defaultAccess: 'read-only', allowedAccess, catalog: { workspaces: catalog.workspaces.map(workspace => ({ id: workspace.id, name: workspace.name, workspaceAllowed: workspace.workspaceAllowed === true, projects: workspace.projects.map(project => ({ id: project.id, name: project.name })) })) }, threads };
}
function redirect(authorization: Authorization, values: Record<string, string>): string {
  const url = new URL(authorization.redirect_uri);
  for (const [key, value] of Object.entries({ ...values, state: authorization.state, iss: mcpPublicOrigin() })) url.searchParams.set(key, value);
  return url.href;
}
export async function decide(request: Request, input: unknown): Promise<{ redirectTo: string }> {
  requireBrowserOrigin(request);
  const parsed = z.strictObject({ authorization: authorizationSchema, decision: decisionSchema }).parse(input);
  const authorization = validateAuthorization(parsed.authorization), decision = parsed.decision, browser = await pmBrowser(request);
  const consent = readRecord<Consent>(MCP_CONSENTS, digest(decision.csrfToken));
  const validConsent = () => {
    const current = readRecord<Consent>(MCP_CONSENTS, digest(decision.csrfToken));
    if (!consent || !current || current.expiresAt <= Date.now() || current.actorId !== browser.actorId || current.sessionHash !== browser.sessionHash || current.authorizationHash !== authorizationHash(authorization)) throw new McpAuthError('access_denied', 'Consent session or CSRF token is invalid or expired.', 403);
  };
  validConsent();
  if (decision._tag === 'deny') { transaction(() => { validConsent(); deleteRecord(MCP_CONSENTS, digest(decision.csrfToken)); }); return { redirectTo: redirect(authorization, { error: 'access_denied' }) }; }
  if (decision.access === 'full' && authorization.scope !== undefined && !authorization.scope.split(' ').includes('orchestration:operate')) throw new McpAuthError('invalid_scope', 'Requested OAuth scope does not permit full access.');
  const catalog = await pmRequest('/api/v1/agent-contexts', browser.headers) as McpCatalog;
  const workspace = catalog.workspaces.find(item => item.id === decision.scope.workspaceId);
  if (!workspace || (decision.scope.projectId === null ? workspace.workspaceAllowed !== true : !workspace.projects.some(item => item.id === decision.scope.projectId))) throw new McpAuthError('access_denied', 'Select a currently authorized PM scope.', 403);
  const now = Date.now(), code = opaque();
  transaction(() => {
    validConsent();
    const threadIds = [...new Set(decision.threadIds)];
    for (const id of threadIds) assertMcpThreadEligible({ scope: decision.scope, actorId: browser.actorId }, id);
    const grant: Grant = { grantId: randomUUID(), actorId: browser.actorId, scope: decision.scope, access: decision.access, threadIds, version: 1, clientHash: digest(authorization.client_id), clientName: client(authorization.client_id).n, audience: `${mcpPublicOrigin()}/mcp`, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 24 * 3600_000).toISOString(), revokedAt: null };
    putGrant(grant);
    boundedRecord<PendingCode>(MCP_CODES, { key: digest(code), expiresAt: now + 60_000, clientHash: grant.clientHash, redirectUri: authorization.redirect_uri, challenge: authorization.code_challenge, resource: grant.audience, grantId: grant.grantId });
    deleteRecord(MCP_CONSENTS, digest(decision.csrfToken));
  });
  return { redirectTo: redirect(authorization, { code }) };
}
export function exchangeCode(input: Record<string, string>) {
  if (input.grant_type !== 'authorization_code') throw new McpAuthError('unsupported_grant_type', 'Only authorization_code is supported; no refresh grant.');
  if (!input.code || !input.client_id || !input.redirect_uri || !input.code_verifier) throw new McpAuthError('invalid_request', 'Code, client_id, redirect_uri and code_verifier are required.');
  // Spend before *all* verifier/client/resource checks, including failed exchanges.
  const pending = transaction(() => { const found = readRecord<PendingCode>(MCP_CODES, digest(input.code!)); deleteRecord(MCP_CODES, digest(input.code!)); return found; });
  client(input.client_id);
  if (!pending || pending.expiresAt <= Date.now() || pending.clientHash !== digest(input.client_id) || pending.redirectUri !== input.redirect_uri || pending.resource !== `${mcpPublicOrigin()}/mcp` || input.resource !== undefined && input.resource !== pending.resource || !/^[A-Za-z0-9\-._~]{43,128}$/.test(input.code_verifier) || !mcpEqual(Buffer.from(digest(input.code_verifier), 'hex').toString('base64url'), pending.challenge)) throw new McpAuthError('invalid_grant', 'Authorization code is invalid or expired.');
  const stored = readRecord<Grant>(MCP_GRANTS, pending.grantId);
  if (!stored) throw new McpAuthError('invalid_grant', 'Grant is unavailable.');
  let grant: Grant;
  try { grant = currentGrant(stored); }
  catch (error) { if (error instanceof McpAuthError) throw new McpAuthError('invalid_grant', 'The authorization grant is revoked or expired.'); throw error; }
  const token = `pm-mcp-access-v1.${opaque()}`;
  transaction(() => boundedRecord(MCP_TOKENS, { key: digest(token), expiresAt: Date.parse(grant.expiresAt), grantId: grant.grantId, audience: grant.audience }, 4096));
  return { access_token: token, token_type: 'Bearer', expires_in: Math.max(0, Math.floor((Date.parse(grant.expiresAt) - Date.now()) / 1000)), scope: grantIdentity(grant).access === 'full' ? MCP_SCOPES.join(' ') : MCP_SCOPES[0] };
}
export function authorizationMetadata() { const issuer = mcpPublicOrigin(); return { issuer, authorization_endpoint: `${issuer}/oauth/mcp/authorize`, token_endpoint: `${issuer}/oauth/mcp/token`, registration_endpoint: `${issuer}/oauth/mcp/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: MCP_SCOPES, authorization_response_iss_parameter_supported: true }; }
export function protectedResourceMetadata() { const issuer = mcpPublicOrigin(); return { resource: `${issuer}/mcp`, authorization_servers: [issuer], scopes_supported: MCP_SCOPES, bearer_methods_supported: ['header'], resource_name: 'PM Agent' }; }
