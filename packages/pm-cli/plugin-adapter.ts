import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { authenticate, serviceOrigin } from './auth.ts';
import { createPrivateFile, readPrivateFile } from './private-files.ts';
import { pmToolInvocationSchema, pmToolCallProjectionSchema } from '../agent-contracts/src/pm-tools.ts';
import { PLUGIN_OPERATION_POLICY } from './plugin-capabilities.ts';

export type PluginAdapterOptions = {
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
};

/** Uses ordinary origin-bound PM login only. It never reads native-client OAuth caches. */
export async function pluginRead(kind: 'tools' | 'workspaces', options: PluginAdapterOptions = {}): Promise<unknown> {
  const environment = options.environment ?? process.env;
  const origin = serviceOrigin(environment.PM_API_URL);
  const authentication = await authenticate(origin, environment);
  const response = await (options.fetch ?? fetch)(`${origin}/api/v1/${kind === 'tools' ? 'agent-tools' : 'agent-contexts'}`, {
    headers: authentication.headers, redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`PM ${kind} unavailable (HTTP ${response.status}); no business request was dispatched.`);
  try { return await response.json(); } catch { throw new Error(`PM ${kind} response is malformed; no business request was dispatched.`); }
}

/** The file remains the caller's private original request; only its non-sensitive identity is journaled. */
export async function pluginOperation(mode: 'call' | 'result', value: unknown, options: PluginAdapterOptions = {}): Promise<unknown> {
  const environment = options.environment ?? process.env;
  const origin = serviceOrigin(environment.PM_API_URL);
  const parsed = pmToolInvocationSchema.parse(value);
  const input = { ...parsed, operationId: parsed.operationId.toLowerCase() };
  if (!input.target) throw new Error('A PM CLI business operation requires an explicit workspace/project target; use plugin workspaces for discovery.');
  const request = { ...input, executionRoot: 'external' as const };
  const authentication = await authenticate(origin, environment);
  const directory = environment.PM_CLI_OPERATION_DIR ?? path.join(environment.PM_CLI_SESSION_DIR ?? path.join(environment.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'dovspace', 'pm-cli'), 'operations');
  if (!path.isAbsolute(directory)) throw new Error('PM_CLI_OPERATION_DIR must be an absolute private directory.');
  const filename = path.join(directory, `${createHash('sha256').update(origin).digest('hex')}-${input.operationId}.json`);
  // Atomic create-before-send is a one-way dispatch boundary. A crash, concurrent caller,
  // prior attempt or even local uncertainty can only select /result, never /call again.
  const reserved = await createPrivateFile(filename, `${JSON.stringify({ version: 1, origin, operationId: input.operationId, policy: PLUGIN_OPERATION_POLICY })}\n`);
  const first = mode === 'call' && reserved;
  if (!reserved) {
    const prior = await readPrivateFile(filename);
    let journal: unknown;
    try { journal = prior === undefined ? undefined : JSON.parse(prior); } catch { journal = undefined; }
    if (!z.object({ version: z.literal(1), origin: z.literal(origin), operationId: z.literal(input.operationId), policy: z.object({ access: z.literal('full'), enforcement: z.literal('audit-only'), interactiveOperationPermission: z.literal(false) }).strict() }).strict().safeParse(journal).success) throw new Error('Original operation identity journal is unavailable; this attempt was not sent. The original outcome remains unknown; do not redispatch.');
  }
  const action = first ? 'call' : 'result';
  const unconfirmed = (message: string, visibility: 'redacted' | 'unavailable' = 'unavailable', httpStatus?: number) => ({
    operationId: input.operationId,
    // A failed read must not replace an already-confirmed business outcome. A denied
    // projection never discloses a business status, even when dispatch was attempted.
    ...(first && visibility !== 'redacted' ? { status: 'unknown' as const } : {}),
    visibility, certainty: { dispatch: 'possibly_sent', evidence: 'unresolved' },
    recovery: 'query-original-operation', ...(httpStatus === undefined ? {} : { httpStatus }), message,
  });
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${origin}/api/v1/workspaces/${encodeURIComponent(input.target.workspaceId)}/agent-tools/${action}`, {
      method: 'POST', headers: { ...authentication.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(request), redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return unconfirmed('The original operation could not be confirmed. Use pm plugin result with the unchanged request file; do not redispatch.');
  }
  if (!response.ok) {
    // Never echo response text: authorization failures can contain otherwise inaccessible data.
    return unconfirmed('The original result is not accessible or confirmed; no automatic redispatch occurred.', response.status === 401 || response.status === 403 || response.status === 404 ? 'redacted' : 'unavailable', response.status);
  }
  let result: unknown;
  try { result = await response.json(); } catch {
    return unconfirmed('The response was not valid JSON; query the original operation without redispatch.');
  }
  const projection = pmToolCallProjectionSchema.safeParse(result);
  if (!projection.success || projection.data.operationId !== input.operationId
    || projection.data.threadId !== '' || projection.data.messageId !== '' || projection.data.generationId !== '') {
    return unconfirmed('The response did not match the original external operation; query it without redispatch.');
  }
  const projected = projection.data;
  if (projected.visibility !== 'visible') return projected;
  if (projected.name !== input.name || projected.workspaceId !== input.target.workspaceId
    || !projected.target || projected.target.workspaceId !== input.target.workspaceId || projected.target.projectId !== input.target.projectId
    || projected.linkage?.executionRoot !== 'external'
    || (projected.result?.receipt && projected.result.receipt.operationId !== input.operationId)) {
    return unconfirmed('The response target, correlation or receipt did not match the original operation; query it without redispatch.');
  }
  // Return only the validated public projection: contract trace/native command IDs,
  // receipt, five-state outcome and visibility survive; hidden payloads and unknown fields do not.
  return projected;
}
