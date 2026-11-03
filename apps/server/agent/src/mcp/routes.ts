import { Hono } from 'hono';
import { z } from 'zod';
import { McpBodyLimitError, mcpEqual, readBoundedMcpBody, verifyMcpServiceRequest } from '../../../../../packages/infrastructure/src/mcp-service-auth.ts';
import { listRecords, readRecord, transaction, writeRecord } from '../durable/store.ts';
import { currentGrant, grantIdentity, MCP_GRANTS, McpAuthError, type Grant } from './grants.ts';
import { pmBrowser } from './identity.ts';
import { approval, authorizationFailureRedirect, authorizationMetadata, decide, exchangeCode, managementCsrf, protectedResourceMetadata, registerClient, requireBrowserOrigin, validateAuthorization } from './oauth.ts';
import { invalidateMcpAppGrant } from '../mcp-apps/live.ts';

/** Root-mounted before Agent's shared access guard; every browser mutation checks PM identity + Origin + CSRF. */
type ManagementBrowser = { actorId: string; headers: Headers; sessionHash: string };
type ManagementBudget = { startedAt: number; requests: number; active: number };
export const mcpOAuthRoutes = new Hono<{ Variables: { mcpBrowser: ManagementBrowser } }>();
let activeRequests = 0;
let windowStart = 0, windowRequests = 0;
let activeManagementRequests = 0;
// Only authenticated actors can allocate entries or consume the reserved management capacity.
const managementBudgets = new Map<string, ManagementBudget>();
mcpOAuthRoutes.use('*', async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  if (!pathname.startsWith('/oauth/mcp/') && !pathname.startsWith('/api/mcp/clients') && !pathname.startsWith('/.well-known/oauth-')) { await next(); return; }
  const publicEndpoint = pathname.startsWith('/.well-known/oauth-') || pathname === '/oauth/mcp/register' || pathname === '/oauth/mcp/token';
  if (publicEndpoint) {
    c.header('Access-Control-Allow-Origin', '*');
    if (c.req.method === 'OPTIONS') { c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); c.header('Access-Control-Allow-Headers', 'Content-Type'); return c.body(null, 204); }
  }
  c.header('Cache-Control', 'no-store'); c.header('Pragma', 'no-cache'); c.header('X-Content-Type-Options', 'nosniff');
  if (Number(c.req.header('content-length') ?? '0') > 65_536 || c.req.url.length > 12_000) return c.json({ error: 'invalid_request' }, 413);
  const management = pathname === '/api/mcp/clients' || /^\/api\/mcp\/clients\/[^/]+\/revoke$/.test(pathname);
  if (management) {
    if (c.req.method !== 'GET') requireBrowserOrigin(c.req.raw);
    const browser = await pmBrowser(c.req.raw);
    const now = Date.now();
    for (const [actorId, budget] of managementBudgets) {
      if (budget.active === 0 && (now < budget.startedAt || now - budget.startedAt >= 60_000)) managementBudgets.delete(actorId);
    }
    let budget = managementBudgets.get(browser.actorId);
    if (!budget) {
      if (managementBudgets.size >= 1024) return c.json({ error: 'temporarily_unavailable' }, 429);
      budget = { startedAt: now, requests: 0, active: 0 };
      managementBudgets.set(browser.actorId, budget);
    }
    if (now < budget.startedAt || now - budget.startedAt >= 60_000) { budget.startedAt = now; budget.requests = 0; }
    if (activeManagementRequests >= 16 || budget.active >= 4 || budget.requests >= 60) return c.json({ error: 'temporarily_unavailable' }, 429);
    budget.requests++; budget.active++; activeManagementRequests++;
    c.set('mcpBrowser', browser);
    try { await next(); } finally { budget.active--; activeManagementRequests--; }
    return;
  }
  const now = Date.now(); if (now < windowStart || now - windowStart >= 60_000) { windowStart = now; windowRequests = 0; }
  if (activeRequests >= 32 || ++windowRequests > 600) return c.json({ error: 'temporarily_unavailable' }, 429);
  activeRequests++;
  try { await next(); } finally { activeRequests--; }
});
mcpOAuthRoutes.onError((error, c) => {
  if (error instanceof McpAuthError) return new Response(JSON.stringify({ error: error.code, error_description: error.message }), { status: error.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  if (error instanceof McpBodyLimitError) return c.json({ error: 'invalid_request', error_description: 'OAuth request exceeds its size limit.' }, 413);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: 'invalid_request', error_description: 'Malformed OAuth request.' }, 400);
  return c.json({ error: 'temporarily_unavailable', error_description: 'OAuth authority is unavailable.' }, 503);
});
async function json(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new McpAuthError('invalid_request', 'JSON content type required.');
  return JSON.parse(await readBoundedMcpBody(request));
}
function parameters(value: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, item] of value) { if (Object.hasOwn(result, key)) throw new McpAuthError('invalid_request', 'Duplicate OAuth parameters are forbidden.'); result[key] = item; }
  return result;
}
mcpOAuthRoutes.get('/.well-known/oauth-authorization-server', c => c.json(authorizationMetadata()));
mcpOAuthRoutes.get('/.well-known/oauth-protected-resource', c => c.json(protectedResourceMetadata()));
mcpOAuthRoutes.get('/.well-known/oauth-protected-resource/mcp', c => c.json(protectedResourceMetadata()));
mcpOAuthRoutes.post('/oauth/mcp/register', async c => c.json(registerClient(await json(c.req.raw)), 201));
mcpOAuthRoutes.get('/oauth/mcp/authorize', c => {
  const input = parameters(new URL(c.req.url).searchParams);
  try { validateAuthorization(input); }
  catch (error) { const redirect = authorizationFailureRedirect(input, error); if (redirect) return c.redirect(redirect, 302); throw error; }
  return c.redirect(`/connect-agent?${new URLSearchParams(input)}`, 302);
});
mcpOAuthRoutes.post('/oauth/mcp/approval', async c => c.json(await approval(c.req.raw, await json(c.req.raw))));
mcpOAuthRoutes.post('/oauth/mcp/decision', async c => c.json(await decide(c.req.raw, await json(c.req.raw))));
mcpOAuthRoutes.post('/oauth/mcp/token', async c => {
  if (c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded') throw new McpAuthError('invalid_request', 'Form content type required.');
  return c.json(exchangeCode(parameters(new URLSearchParams(await readBoundedMcpBody(c.req.raw)))));
});
mcpOAuthRoutes.get('/api/mcp/clients', async c => {
  const browser = c.get('mcpBrowser');
  return c.json({ csrfToken: managementCsrf(browser.actorId, browser.sessionHash), items: listRecords<Grant>(MCP_GRANTS).filter(grant => grant.actorId === browser.actorId).map(grant => ({ id: grant.grantId, clientName: grant.clientName, scope: grant.scope, access: grant.access, threadIds: grant.threadIds, createdAt: grant.createdAt, expiresAt: grant.expiresAt, revokedAt: grant.revokedAt })) });
});
mcpOAuthRoutes.post('/api/mcp/clients/:id/revoke', async c => {
  requireBrowserOrigin(c.req.raw);
  const browser = c.get('mcpBrowser'), input = z.strictObject({ csrfToken: z.string().max(128) }).parse(await json(c.req.raw));
  if (!mcpEqual(input.csrfToken, managementCsrf(browser.actorId, browser.sessionHash))) throw new McpAuthError('access_denied', 'Invalid CSRF token.', 403);
  transaction(() => { const grant = readRecord<Grant>(MCP_GRANTS, c.req.param('id')); if (!grant || grant.actorId !== browser.actorId) throw new McpAuthError('access_denied', 'Client is unavailable.', 404); if (!grant.revokedAt) writeRecord(MCP_GRANTS, grant.grantId, { ...grant, revokedAt: new Date().toISOString(), version: grant.version + 1 }); });
  // Authority is already revoked; asynchronous native cleanup must never hold the SQLite transaction.
  await invalidateMcpAppGrant(c.req.param('id'));
  return c.json({ revoked: true });
});
/** Dedicated internal mount only, never proxied by the public gateway. Storage-only, no PM calls. */
let activeIntrospections = 0;
export const mcpIntrospectionRoutes = new Hono().post('/internal/mcp/introspect', async c => {
  if (activeIntrospections >= 32) return c.json({ error: 'temporarily_unavailable' }, 503);
  activeIntrospections++;
  try {
    c.header('Cache-Control', 'no-store');
    const body = await readBoundedMcpBody(c.req.raw);
    if (!verifyMcpServiceRequest('POST', '/internal/mcp/introspect', body, c.req.raw.headers)) return c.json({ error: 'unauthorized' }, 401);
    const data = JSON.parse(body) as Record<string, unknown>;
    // Validate the transport's exact signed identity shape, without trusting caller-provided threadIds.
    const signed = z.strictObject({ grantId: z.uuid(), actorId: z.uuid(), scope: z.strictObject({ workspaceId: z.uuid(), projectId: z.string().nullable() }), access: z.enum(['read-only', 'full']), version: z.number().int().positive(), audience: z.literal('pm-mcp-service-v1'), issuedAt: z.number().int(), expiresAt: z.number().int() }).parse(data);
    if (signed.expiresAt <= Date.now() || signed.issuedAt > Date.now() + 5000 || signed.expiresAt - signed.issuedAt !== 60_000) return c.json({ error: 'invalid_token' }, 401);
    return c.json(grantIdentity(currentGrant(signed)));
  } catch { return c.json({ error: 'invalid_token' }, 401); }
  finally { activeIntrospections--; }
});
