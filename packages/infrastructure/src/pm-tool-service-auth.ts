import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pmToolLinkageSchema, pmToolReconcileRequestSchema, pmToolRequestSchema, type PmToolLinkage } from '../../agent-contracts/src/pm-tools.ts';
import { requestHash } from '../../application/src/kernel.ts';
import { mcpEqual, mcpMac } from './mcp-service-auth.ts';

export const PM_TOOL_RECONCILE_PATH = '/api/v1/internal/agent-tools/reconcile';
const audience = 'pm-tool-reconcile-v1';
const reconcileSchema = z.strictObject({
  audience: z.literal(audience), purpose: z.literal('original-operation-status'),
  method: z.literal('POST'), path: z.literal(PM_TOOL_RECONCILE_PATH),
  proof: pmToolReconcileRequestSchema, nonce: z.uuid(), issuedAt: z.number().int(), expiresAt: z.number().int(),
});
const linkageSchema = z.strictObject({
  actorId: z.uuid(), requestHash: z.string().regex(/^[a-f0-9]{64}$/), linkage: pmToolLinkageSchema,
  issuedAt: z.number().int(), expiresAt: z.number().int(),
});
function sign(domain: string, value: unknown): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${domain}.${payload}.${mcpMac(domain, payload)}`;
}
function verify(token: string, domain: string): unknown {
  if (token.length > 8192 || !token.startsWith(`${domain}.`)) return null;
  const [payload, signature, extra] = token.slice(domain.length + 1).split('.');
  if (!payload || !signature || extra !== undefined || !mcpEqual(signature, mcpMac(domain, payload))) return null;
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
}
function current(value: { issuedAt: number; expiresAt: number }): boolean {
  const now = Date.now();
  return value.issuedAt <= now + 5_000 && value.expiresAt - value.issuedAt === 60_000 && value.expiresAt > now;
}
/** Exact PM canonical request identity, including original linkage, never a public argument digest. */
export function pmToolRequestHash(request: unknown, actorId: string): string {
  const input = pmToolRequestSchema.parse(request);
  return requestHash({ ...input, workspaceId: input.target.workspaceId, actorId });
}
export function createPmToolReconcileBearer(proof: z.infer<typeof pmToolReconcileRequestSchema>): string {
  const issuedAt = Date.now();
  return sign(audience, { audience, purpose: 'original-operation-status', method: 'POST', path: PM_TOOL_RECONCILE_PATH,
    proof: pmToolReconcileRequestSchema.parse(proof), nonce: randomUUID(), issuedAt, expiresAt: issuedAt + 60_000 });
}
/** The caller must durably consume nonce before querying; user cookies and MCP bearers never qualify. */
export function verifyPmToolReconcileBearer(token: string, method: string, path: string, proof: unknown): z.infer<typeof reconcileSchema> | null {
  try {
    const parsed = reconcileSchema.parse(verify(token, audience));
    return current(parsed) && parsed.method === method && parsed.path === path
      && requestHash(parsed.proof) === requestHash(pmToolReconcileRequestSchema.parse(proof)) ? parsed : null;
  } catch { return null; }
}
export function createPmToolLinkageBearer(actorId: string, hash: string, linkage: PmToolLinkage): string {
  const issuedAt = Date.now();
  return sign('pm-tool-linkage-v1', linkageSchema.parse({ actorId, requestHash: hash, linkage, issuedAt, expiresAt: issuedAt + 60_000 }));
}
export function verifyPmToolLinkageBearer(token: string, actorId: string, hash: string, linkage: PmToolLinkage): boolean {
  try {
    const value = linkageSchema.parse(verify(token, 'pm-tool-linkage-v1'));
    return current(value) && value.actorId === actorId && value.requestHash === hash && requestHash(value.linkage) === requestHash(linkage);
  } catch { return false; }
}
