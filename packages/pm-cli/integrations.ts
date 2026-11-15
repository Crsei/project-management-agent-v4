import { z } from 'zod';
import { parseDocument } from 'yaml';
import { lstat } from 'node:fs/promises';
import { automationIntegrationConfigSchema, automationIntegrationSaveSchema, automationIntegrationMutationSchema, automationEventConfigSchema, automationEventSaveSchema, type AutomationIntegrationOperation } from '../contracts/src/automation-integrations.ts';
import { createWebhookEndpointSchema, setWebhookEndpointStateSchema, setWebhookEndpointSigningKeySchema, resumeWebhookDeliverySchema, webhookPageQuerySchema } from '../contracts/src/webhook-schemas.ts';
import { imLinkCodeSchema } from '../contracts/src/im-gateway.ts';
import { integrationConnectionMetadataSchema, integrationEventEndpointMetadataSchema } from '../agent-contracts/src/pm-tool-integrations.ts';
import { createPrivateFile, privateDirectory, readPrivateFile } from './private-files.ts';
import path from 'node:path';
import { inputFile, nonempty, objectInput, parseOptions, type CliFamily, type CliRuntime } from './runtime.ts';

const uuid = z.uuid().toLowerCase();
const project = z.string().regex(/^PRJ-\d+$/);
const revision = z.coerce.number().int().nonnegative();
const positive = z.coerce.number().int().positive();
const privateHeaders = automationIntegrationSaveSchema.pick({ nativePrivateHeaders: true });
const privateEvent = automationEventSaveSchema.pick({ secret: true });
function parsed<Schema extends z.ZodType>(schema: Schema, value: unknown, label: string): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`Invalid ${label}; use the strict documented schema. Input values were not printed.`);
  return result.data as z.output<Schema>;
}
function id(value: string | undefined): string { return parsed(uuid, nonempty(value, 'UUID'), 'UUID'); }
function number(value: string | undefined, name: string, allowZero = false): number { return parsed(allowZero ? revision : positive, nonempty(value, name), name); }
function boolean(value: string | undefined): boolean {
  if (value !== 'true' && value !== 'false') throw new Error('--enabled must be true or false');
  return value === 'true';
}
function query(values: Record<string, string | number | undefined>): string {
  const entries = Object.entries(values).filter((entry): entry is [string, string | number] => entry[1] !== undefined);
  return entries.length ? `?${new URLSearchParams(entries.map(([key, value]): [string, string] => [key, String(value)]))}` : '';
}
async function privateInput(filename: string | undefined): Promise<Record<string, unknown>> {
  if (!filename) return {};
  let text: string;
  if (filename === '-') {
    if (process.stdin.isTTY) throw new Error('Pipe private input on stdin; never put secret values in argv.');
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > 65536) throw new Error('Private input exceeds 64 KiB');
      chunks.push(bytes);
    }
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { throw new Error('Private input must be UTF-8'); }
  } else {
    text = await readPrivateFile(path.resolve(filename)) ?? '';
    if (!text) throw new Error('Private input file is missing or empty');
  }
  try {
    const document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length) throw new Error();
    return objectInput(document.toJS({ maxAliasCount: 0 }));
  } catch { throw new Error('Private input must be a strict JSON/YAML object; values were not printed.'); }
}
async function privateOutput(filename: string, value: unknown): Promise<void> {
  const target = path.resolve(filename);
  if (!await createPrivateFile(target, `${JSON.stringify(value)}\n`)) throw new Error('Private output already exists; it was not overwritten.');
}
const base = '/automations';
async function mutation(runtime: CliRuntime, endpoint: string, options: Record<string, string>): Promise<unknown> {
  const input = parsed(automationIntegrationMutationSchema, { requestId: id(options['request-id']), expectedRevision: number(options.revision, '--revision', true) }, 'mutation');
  return runtime.json('workspace', endpoint, { method: 'POST', body: input });
}
async function webhookCommand(runtime: CliRuntime, commandType: string, options: Record<string, string>, payload: Record<string, unknown>, target?: string): Promise<unknown> {
  const commandId = id(options['request-id']);
  const command = { commandId, commandType, payload, ...(target ? { targetId: target, expectedVersions: { [target]: number(options.version, '--version') } } : {}) };
  return runtime.json('workspace', '/commands', { method: 'POST', body: command });
}
const help = `Integration management (current PM actor; saved / verified / sent are distinct):
  integration list [--project PRJ-N] | definitions --project PRJ-N
  integration save --id UUID --file CONFIG.json --request-id UUID --revision N [--private-file PRIVATE.json|-]
  integration verify|revoke --id UUID --request-id UUID --revision N
  integration receipt UUID | operation UUID [--result-file PRIVATE-NEW.json]
  event-endpoint list [--project PRJ-N]
  event-endpoint save --id UUID --file CONFIG.json --request-id UUID --revision N [--private-file PRIVATE.json|-]
  event-endpoint revoke --id UUID --request-id UUID --revision N
  event-endpoint events UUID [--cursor UUID] | receipt UUID
  webhook status | deliveries UUID [--cursor CURSOR] [--limit 1..100] | delivery UUID
  webhook create --file PAYLOAD.json --request-id UUID
  webhook state --id UUID --state enabled|paused|retired --version N --request-id UUID
  webhook reauthorize|reconcile --id UUID --version N --request-id UUID
  webhook signing-key --id UUID --key-id KEY --version N --request-id UUID
  webhook resume --id UUID --receipt-id UUID --version N --request-id UUID
  webhook receipt UUID
  im status | link-code --out-file PRIVATE-NEW.json
  im notifications --id UUID --enabled true|false | revoke --id UUID
Private files must be owned regular 0600 files under protected directories; private stdin is bounded.
Integration CONFIG is the native config only; private input is {nativePrivateHeaders:{...}}.
Event CONFIG is the native event config only; private input is {secret:"..."}. Omit private input to retain.
Link codes and raw original provider results are written only to explicit new protected files, never stdout.
After a lost response inspect the SAME receipt/operation/delivery; no automatic resend or fresh identity.
IM platform /use remains the legal default-project flow. SMTP account/invitation commands and delivery-admin scripts remain separate.`;

export const integrationsFamily: CliFamily = {
  help,
  async dispatch(args, runtime) {
    const [resource, action, ...rest] = args;
    if (!['integration', 'event-endpoint', 'webhook', 'im'].includes(resource ?? '')) return false;
    const usage = (): never => { throw new Error(`Unknown ${resource} action or arguments.\n${help}`); };
    if (resource === 'integration' || resource === 'event-endpoint') {
      const connection = resource === 'integration';
      const collection = `${base}/${connection ? 'integrations' : 'event-endpoints'}`;
      if (action === 'list' || connection && action === 'definitions') {
        const opts = parseOptions(rest, ['project']);
        const projectId = opts.project === undefined && action === 'list' ? undefined : parsed(project, nonempty(opts.project, '--project'), 'project');
        runtime.print(await runtime.json('workspace', `${collection}${action === 'definitions' ? '/definitions' : ''}${query({ projectId })}`)); return true;
      }
      if (action === 'save') {
        const opts = parseOptions(rest, ['id', 'file', 'request-id', 'revision', 'private-file']);
        const config = parsed(connection ? automationIntegrationConfigSchema : automationEventConfigSchema, await inputFile(opts.file), 'resource config');
        const secret = await privateInput(opts['private-file']);
        const privateFields = connection ? parsed(privateHeaders, secret, 'private native headers') : parsed(privateEvent, secret, 'private event signing secret');
        const body = { requestId: id(opts['request-id']), expectedRevision: number(opts.revision, '--revision', true), config, ...privateFields };
        // Do not pass a parser exception containing credentials to the ordinary CLI error renderer.
        parsed(connection ? automationIntegrationSaveSchema : automationEventSaveSchema, body, 'resource save');
        runtime.print(await runtime.json('workspace', `${collection}/${id(opts.id)}`, { method: 'PUT', body })); return true;
      }
      if (action === 'revoke' || connection && action === 'verify') {
        const opts = parseOptions(rest, ['id', 'request-id', 'revision']);
        runtime.print(await mutation(runtime, `${collection}/${id(opts.id)}/${action}`, opts)); return true;
      }
      if (action === 'receipt') {
        if (rest.length !== 1) return usage();
        const receipt = await runtime.json<{ requestId: string; result: unknown; httpStatus: number }>('workspace', `${base}/integration-receipts/${id(rest[0])}`);
        // Native receipt results are finite connection/endpoint DTOs or a safe application rejection.
        const result = integrationConnectionMetadataSchema.strip().safeParse(receipt.result);
        const endpoint = integrationEventEndpointMetadataSchema.safeParse(receipt.result);
        const rejected = z.strictObject({ error: z.strictObject({ code: z.string().max(500), message: z.string().max(1000) }) }).safeParse(receipt.result);
        if (!result.success && !endpoint.success && !rejected.success) throw new Error('Original receipt has an unsupported result shape; no raw private payload was printed.');
        runtime.print({ requestId: receipt.requestId, httpStatus: receipt.httpStatus, result: result.success ? result.data : endpoint.success ? endpoint.data : rejected.success ? { error: { code: rejected.data.error.code } } : null }); return true;
      }
      if (connection && action === 'operation') {
        const operationId = id(rest[0]); const opts = parseOptions(rest.slice(1), ['result-file']);
        const operation = await runtime.json<AutomationIntegrationOperation>('workspace', `${base}/integrations/operations/${operationId}`);
        if (opts['result-file']) await privateOutput(opts['result-file'], operation.result);
        const { result, ...metadata } = operation;
        runtime.print({ ...metadata, resultAvailable: result !== null && result !== undefined, resultWritten: !!opts['result-file'] }); return true;
      }
      if (!connection && action === 'events') {
        const endpointId = id(rest[0]); const opts = parseOptions(rest.slice(1), ['cursor']);
        runtime.print(await runtime.json('workspace', `${collection}/${endpointId}/events${query({ cursor: opts.cursor === undefined ? undefined : id(opts.cursor) })}`)); return true;
      }
      return usage();
    }
    if (resource === 'webhook') {
      if (action === 'status') { parseOptions(rest, []); runtime.print(await runtime.json('workspace', '/webhooks')); return true; }
      if (action === 'deliveries') {
        const endpointId = id(rest[0]); const opts = parseOptions(rest.slice(1), ['cursor', 'limit']);
        const page = parsed(webhookPageQuerySchema, opts, 'delivery page');
        runtime.print(await runtime.json('workspace', `/webhooks/${endpointId}/deliveries${query({ cursor: page.cursor, limit: page.limit })}`)); return true;
      }
      if (action === 'delivery' || action === 'receipt') {
        if (rest.length !== 1) return usage();
        runtime.print(await runtime.json('workspace', action === 'delivery' ? `/webhook-deliveries/${id(rest[0])}` : `/commands/${id(rest[0])}`)); return true;
      }
      if (action === 'create') {
        const opts = parseOptions(rest, ['file', 'request-id']);
        runtime.print(await webhookCommand(runtime, 'CreateWebhookEndpoint', opts, parsed(createWebhookEndpointSchema, await inputFile(opts.file), 'approved webhook target'))); return true;
      }
      const actions = { state: 'SetWebhookEndpointState', reauthorize: 'ReauthorizeWebhookEndpoint', 'signing-key': 'SetWebhookEndpointSigningKey', reconcile: 'ReconcileWebhookDelivery', resume: 'ResumeWebhookDelivery' } as const;
      if (!action || !Object.hasOwn(actions, action)) return usage();
      const key = action as keyof typeof actions;
      const extra = key === 'state' ? ['state'] : key === 'signing-key' ? ['key-id'] : key === 'resume' ? ['receipt-id'] : [];
      const opts = parseOptions(rest, ['id', 'request-id', 'version', ...extra]);
      const payload = key === 'state' ? parsed(setWebhookEndpointStateSchema, { state: opts.state }, 'endpoint state') : key === 'signing-key' ? parsed(setWebhookEndpointSigningKeySchema, { keyId: opts['key-id'] }, 'approved signing key') : key === 'resume' ? parsed(resumeWebhookDeliverySchema, { receiptId: opts['receipt-id'] }, 'receiver barrier receipt') : {};
      runtime.print(await webhookCommand(runtime, actions[key], opts, payload, id(opts.id))); return true;
    }
    if (action === 'status') { parseOptions(rest, []); runtime.print(await runtime.json('workspace', '/im')); return true; }
    if (action === 'link-code') {
      const opts = parseOptions(rest, ['out-file']); const filename = nonempty(opts['out-file'], '--out-file');
      await privateDirectory(path.dirname(path.resolve(filename)), true);
      try {
        await lstat(path.resolve(filename));
        throw new Error('Private output already exists; no link code was requested.');
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
      const link = parsed(imLinkCodeSchema, await runtime.json('workspace', '/im/link-codes', { method: 'POST', body: {} }), 'private IM link response');
      await privateOutput(filename, link);
      runtime.print({ expiresAt: link.expiresAt, codeWritten: true, deliveryVerified: false }); return true;
    }
    if (action === 'notifications') {
      const opts = parseOptions(rest, ['id', 'enabled']);
      runtime.print(await runtime.json('workspace', `/im/bindings/${id(opts.id)}`, { method: 'PATCH', body: { notifyEnabled: boolean(opts.enabled) } })); return true;
    }
    if (action === 'revoke') {
      const opts = parseOptions(rest, ['id']);
      runtime.print(await runtime.json('workspace', `/im/bindings/${id(opts.id)}/revoke`, { method: 'POST', body: {} })); return true;
    }
    return usage();
  },
};
