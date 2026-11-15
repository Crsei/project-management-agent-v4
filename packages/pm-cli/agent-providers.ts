import path from 'node:path';
import { z } from 'zod';
import { connectAgent, type AgentConnection } from './agent-connection.ts';
import { CliRequestError, nonempty, objectInput, parseOptions, type CliFamily, type CliRuntime } from './runtime.ts';
import { readPrivateFile, writePrivateFile } from './private-files.ts';
import type { ProviderAuthState, ProviderDriverDefinition, ProviderInstance, ProvidersResponse } from '../agent-contracts/src/provider.ts';
import { chatDefaultsUpdateSchema } from '../agent-contracts/src/settings.ts';
import { providerConsumeResetCreditInputSchema, usageLimitSourceInputSchema, usageSettingsUpdateSchema, usageSummaryInputSchema } from '../agent-contracts/src/usage.ts';

const HELP = `Agent Provider commands (local unprotected access or configured Agent login):
  agent provider list|drivers --consent native-probe
  agent provider get|home|env|health ID --consent native-probe
  agent provider create --file PRIVATE.json --consent native-probe
  agent provider update|setup ID --file PRIVATE.json --consent native-probe
  agent provider enable|disable ID --revision N --consent native-probe
  agent provider reset ID --revision N --confirm reset --consent native-probe
  agent provider delete ID --confirm delete
  agent provider health-settings get
  agent provider health-settings set --file PRIVATE.json [--consent native-probe]
  agent provider login ID [--method METHOD] [--values-file PRIVATE.json] --consent authenticate [--interaction-file PRIVATE.json]
  agent provider logout ID --consent logout
  agent provider auth status ID --consent native-probe [--interaction-file PRIVATE.json]
  agent provider auth watch ID --flow FLOW --consent native-probe [--seconds 300] [--interaction-file PRIVATE.json]
  agent provider auth input ID --flow FLOW --input-file PRIVATE.txt [--interaction-file PRIVATE.json]
  agent provider auth cancel ID --flow FLOW [--interaction-file PRIVATE.json]
  agent provider maintenance get|cancel ID
  agent provider maintenance install|update|remove ID --revision N --consent install|update|remove
  agent provider profiles list ID
  agent provider profiles select|delete ID --profile PROFILE --revision N [--confirm delete]
  agent provider registry search --query TEXT [--limit 30]
  agent provider registry prepare ID --agent-id AGENT --consent prepare
  agent models list ID --consent native-probe
  agent models options ID --model MODEL --consent native-probe
  agent models set ID --file PRIVATE.json --consent native-probe
  agent settings chat-defaults get --consent native-probe
  agent settings chat-defaults set --file PRIVATE.json [--consent native-probe]
  agent usage summary|refresh --file PRIVATE.json
  agent usage settings|prices get
  agent usage settings|prices set --file PRIVATE.json
  agent usage limits get
  agent usage limits refresh [--file PRIVATE.json]
  agent usage limits reset --file PRIVATE.json --consent redeem-reset-credit
  agent usage sources list
  agent usage sources create --file PRIVATE.json
  agent usage sources update ID --file PRIVATE.json
  agent usage sources delete ID --revision N --confirm delete
  agent usage thread ID
  agent diagnostics get|storage
  agent diagnostics report [--output-file PRIVATE.json]
  agent quota recovery list
  agent quota recovery enable ID --consent quota-recovery
  agent quota recovery disable ID
  agent quota dispatches [--run ID]
Files are explicit absolute owned regular 0600 files in private directories; input is JSON except auth input text.
Catalog reads and configuration writes returning a catalog execute native status probes; ACP npx/uvx probes may prepare/download packages. --consent native-probe acknowledges this effect, not an authorization grant.
Login/maintenance use only existing driver capabilities; unsupported stays unsupported. No automatic browser opening, download approval, service restart, write retry, account import or model invocation.
Auth URLs/codes/terminal output are withheld from stdout; --interaction-file explicitly saves the native flow to a private file. Provider expiresAt is flow expiry, NOT Agent cookie expiry.
Usage unknown/missing fields remain absent; costs are not subscription bills. Quota recovery is Agent Chat only, NOT PM Automation Studio; enable can resume the original generation after its reset time.`;

const RESOURCES: Record<string, true> = { provider: true, models: true, settings: true, usage: true, diagnostics: true, quota: true };
const INSTANCE_FIELDS = ['label', 'enabled', 'accentColor', 'registryIconUrl', 'config', 'environment', 'customModels', 'modelPreferences'] as const;
type Plan = {
  route: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  project?: (value: unknown) => unknown;
  privateOutput?: string;
  watch?: { flowId: string; seconds: number };
  timeoutMs?: number;
};

function invalid(message: string): never { throw new CliRequestError('AGENT_PROVIDER_INPUT', message); }
function usage(resource: string): never { return invalid(`Unknown agent ${resource} command.\n${HELP}`); }
function segment(value: string | undefined, label = 'ID'): string {
  const id = nonempty(value, label);
  if (id.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id) || id === '.' || id === '..') invalid(`Invalid ${label}.`);
  return encodeURIComponent(id);
}
function revision(value: string | undefined, minimum = 1): number {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) invalid('--revision requires an integer.');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) invalid(`--revision must be at least ${minimum}.`);
  return number;
}
function consent(options: Record<string, string>, effect: string): void {
  if (options.consent !== effect) invalid(`This operation requires explicit --consent ${effect}. No request was sent.`);
}
function confirm(options: Record<string, string>, action: string): void {
  if (options.confirm !== action) invalid(`This operation requires --confirm ${action}. No request was sent.`);
}
function onlyFields(value: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  if (Object.keys(value).some(key => !fields.includes(key))) invalid('Input contains unsupported fields. Use the exact native resource schema.');
  return value;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) invalid('Input does not match the native resource schema; values were not logged and no request was sent.');
  return result.data;
}
function outputPath(value: string | undefined, option: string): string {
  const filename = nonempty(value, option);
  if (!path.isAbsolute(filename)) invalid(`${option} requires an explicit absolute private path.`);
  return filename;
}
async function privateText(value: string | undefined, option = '--file'): Promise<string> {
  const filename = outputPath(value, option);
  let text: string | undefined;
  try { text = await readPrivateFile(filename); }
  catch { return invalid(`${option} must identify an available owned regular 0600 file in private directories.`); }
  if (text === undefined) invalid(`${option} does not exist.`);
  if (text.includes('\uFFFD')) invalid(`${option} must contain valid UTF-8.`);
  return text;
}
async function privateObject(value: string | undefined, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const text = await privateText(value);
  if (Buffer.byteLength(text) > maxBytes) invalid('Input exceeds the native request size limit.');
  try { return objectInput(JSON.parse(text)); }
  catch { return invalid('Private input must contain a valid JSON object; its contents were not logged.'); }
}
function validRevisionBody(body: Record<string, unknown>, minimum = 1): void {
  if (!Number.isSafeInteger(body.revision) || Number(body.revision) < minimum) invalid(`Input requires the original resource revision (at least ${minimum}).`);
}
async function instanceBody(filename: string | undefined, fields: readonly string[], update: boolean): Promise<Record<string, unknown>> {
  const body = onlyFields(await privateObject(filename, 16 * 1024), fields);
  if (update) validRevisionBody(body);
  return body;
}
function bodyPlan(route: string, method: NonNullable<Plan['method']>, body: unknown): Plan { return { route, method, body }; }
function providerRoute(id: string | undefined): string { return `/api/providers/${segment(id, 'provider ID')}`; }
function object(value: unknown): Record<string, unknown> { return objectInput(value); }
function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}

// Native services already redact their write-only values. This projection also
// protects against accidental future additions to provider/auth HTTP responses.
function sensitiveKey(key: string): boolean {
  return !['secretConfigKeys', 'credentialSource', 'credentialOwner', 'managementKeyConfigured'].includes(key)
    && /(?:api.?key|password|secret|authorization|cookie|managementKey|credentialFingerprint)|^(?:(?:access|refresh|auth|id|session|bearer)[_-]?)?token$/i.test(key);
}
function safeOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeOutput);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sensitiveKey(key) && typeof entry !== 'boolean' ? '[redacted]' : safeOutput(entry)]));
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
    catch { return '[invalid URL withheld]'; }
  }
  return value;
}
function providerProjection(value: unknown): Record<string, unknown> {
  const provider = object(value);
  const projected = pick(provider, [
    'instanceId', 'driver', 'label', 'enabled', 'accentColor', 'registryIconUrl', 'revision', 'authMode', 'authStatus',
    'nativeSessionReady', 'requiresOpenaiAuth', 'authLabel', 'email', 'configured', 'credentialSource', 'models', 'modelsSource',
    'customModels', 'modelPreferences', 'lastConnectionTest', 'installation', 'updateRequiredModels', 'authCheckedAt', 'message',
    'canLogin', 'canLogout', 'loginMethod', 'docsUrl', 'capabilities', 'authMethods', 'secretConfigKeys',
  ]);
  const secretKeys = new Set(Array.isArray(provider.secretConfigKeys) ? provider.secretConfigKeys.filter((key): key is string => typeof key === 'string') : []);
  projected.config = Object.fromEntries(Object.entries(object(provider.config ?? {})).map(([key, entry]) => [key, key === 'launchArgs' || key === 'commandArgs' || secretKeys.has(key) || sensitiveKey(key) ? '[redacted]' : entry]));
  projected.environment = Array.isArray(provider.environment) ? provider.environment.map(entry => {
    const env = object(entry);
    return { name: env.name, sensitive: env.sensitive, value: '[redacted]', valueRedacted: true };
  }) : [];
  return safeOutput(projected) as Record<string, unknown>;
}
function driversProjection(value: unknown): unknown {
  return (value as ProviderDriverDefinition[]).map(driver => ({
    ...driver,
    fields: driver.fields.map(field => ({ ...field, ...(field.secret || field.type === 'password' ? { defaultValue: '[redacted]' } : {}) })),
  }));
}
function catalogProvider(value: unknown, id: string): ProviderInstance {
  const catalog = value as ProvidersResponse;
  if (!Array.isArray(catalog.providers) || !Array.isArray(catalog.drivers)) throw new CliRequestError('AGENT_PROVIDER_PROTOCOL', 'Agent did not return its Provider catalog.');
  const provider = catalog.providers.find(entry => entry.instanceId === id);
  if (!provider) throw new CliRequestError('AGENT_PROVIDER_NOT_FOUND', 'The exact Provider instance was not present; no replacement was selected.', [], 404);
  return provider;
}
function authProjection(value: unknown): unknown {
  const state = value as ProviderAuthState;
  const interaction = state.interaction;
  return {
    ...pick(object(value), ['instanceId', 'phase', 'flowId', 'expiresAt', 'credentialOwner', 'methods']),
    expiryKind: 'provider-auth-flow',
    interaction: !interaction ? null : {
      type: interaction.type, id: interaction.id,
      ...(interaction.type === 'credentials' ? { fields: interaction.fields } : {}),
      ...(interaction.type === 'browser' || interaction.type === 'device-code' ? { requiresConsent: interaction.requiresConsent, acceptsCallback: interaction.acceptsCallback } : {}),
    },
    privateInteractionAvailable: Boolean(interaction || state.authorizationUrl || state.userCode || state.output),
    messageAvailable: Boolean(state.message),
    interactionDelivery: 'explicit-private-file-only',
  };
}
function authFile(options: Record<string, string>): Pick<Plan, 'privateOutput'> {
  return options['interaction-file'] === undefined ? {} : { privateOutput: outputPath(options['interaction-file'], '--interaction-file') };
}

async function providerPlan(args: string[]): Promise<Plan> {
  const [action, id, ...rest] = args;
  if (action === 'list' || action === 'drivers') {
    const options = parseOptions(args.slice(1), ['consent']); consent(options, 'native-probe');
    return { route: '/api/providers', project: value => action === 'drivers'
      ? { drivers: driversProjection((value as ProvidersResponse).drivers) }
      : { providers: (value as ProvidersResponse).providers.map(providerProjection), drivers: driversProjection((value as ProvidersResponse).drivers) } };
  }
  if (['get', 'home', 'env'].includes(action ?? '')) {
    const options = parseOptions(rest, ['consent']); consent(options, 'native-probe'); segment(id, 'provider ID');
    return { route: '/api/providers', project: value => {
      const provider = catalogProvider(value, id!);
      const projected = providerProjection(provider);
      if (action === 'env') return pick(projected, ['instanceId', 'revision', 'environment']);
      if (action === 'home') return {
        instanceId: provider.instanceId, revision: provider.revision,
        config: pick(object(projected.config), ['setupMode', 'homePath', 'shadowHomePath']),
        environment: (projected.environment as Record<string, unknown>[]).filter(entry => typeof entry.name === 'string' && /HOME|PROFILE|CONFIG|DIR/i.test(entry.name)),
        effectiveHome: null, resolution: 'Agent-server-native-rules',
        note: 'Only explicit configuration is exposed by this API; inherited server Home is not inferred from the CLI machine. No Home files are exported.',
      };
      return projected;
    } };
  }
  if (action === 'create') {
    const options = parseOptions(args.slice(1), ['file', 'consent']); consent(options, 'native-probe');
    const body = await instanceBody(options.file, ['instanceId', 'driver', ...INSTANCE_FIELDS], false);
    if (typeof body.driver !== 'string' || !body.driver) invalid('Provider creation requires an existing native driver.');
    return { ...bodyPlan('/api/providers', 'POST', body), project: providerProjection };
  }
  if (action === 'update' || action === 'setup') {
    const options = parseOptions(rest, ['file', 'consent']); consent(options, 'native-probe');
    const body = await instanceBody(options.file, action === 'setup' ? ['revision', 'config', 'environment'] : ['revision', ...INSTANCE_FIELDS], true);
    return { ...bodyPlan(providerRoute(id), 'PUT', body), project: providerProjection };
  }
  if (action === 'enable' || action === 'disable') {
    const options = parseOptions(rest, ['revision', 'consent']); consent(options, 'native-probe');
    return { ...bodyPlan(providerRoute(id), 'PUT', { revision: revision(options.revision), enabled: action === 'enable' }), project: providerProjection };
  }
  if (action === 'reset') {
    const options = parseOptions(rest, ['revision', 'confirm', 'consent']); consent(options, 'native-probe'); confirm(options, 'reset');
    return { ...bodyPlan(`${providerRoute(id)}/reset`, 'POST', { revision: revision(options.revision) }), project: value => value === null ? null : providerProjection(value) };
  }
  if (action === 'delete') {
    const options = parseOptions(rest, ['confirm']); confirm(options, 'delete');
    return bodyPlan(providerRoute(id), 'DELETE', {});
  }
  if (action === 'health') {
    const options = parseOptions(rest, ['consent']); consent(options, 'native-probe');
    return bodyPlan(`${providerRoute(id)}/test`, 'POST', {});
  }
  if (action === 'health-settings') {
    if (id === 'get') { parseOptions(rest, []); return { route: '/api/providers/settings' }; }
    if (id === 'set') {
      const options = parseOptions(rest, ['file', 'consent']);
      const body = parse(z.strictObject({ revision: z.number().int().positive().safe(), healthRefreshIntervalSeconds: z.number().finite() }), await privateObject(options.file));
      if (body.healthRefreshIntervalSeconds > 0) consent(options, 'native-probe');
      return bodyPlan('/api/providers/settings', 'PATCH', body);
    }
    return usage('provider health-settings');
  }
  if (action === 'login') {
    const options = parseOptions(rest, ['method', 'values-file', 'consent', 'interaction-file']); consent(options, 'authenticate');
    const values = options['values-file'] === undefined ? undefined : parse(z.record(z.string().max(100), z.string().max(8192)), await privateObject(options['values-file'], 16 * 1024));
    const body = { ...(options.method === undefined ? {} : { methodId: nonempty(options.method, '--method') }), ...(values === undefined ? {} : { values }) };
    if (Buffer.byteLength(JSON.stringify(body)) > 16 * 1024) invalid('Authentication values exceed the native request size limit.');
    if (options['values-file'] && options['values-file'] === options['interaction-file']) invalid('Authentication input and output files must differ.');
    return { ...bodyPlan(`${providerRoute(id)}/auth/start`, 'POST', body), project: authProjection, ...authFile(options) };
  }
  if (action === 'logout') {
    const options = parseOptions(rest, ['consent']); consent(options, 'logout');
    return bodyPlan(`${providerRoute(id)}/logout`, 'POST', {});
  }
  if (action === 'auth') return authPlan(args.slice(1));
  if (action === 'maintenance') return maintenancePlan(args.slice(1));
  if (action === 'profiles') {
    const [operation, instanceId, ...optionsArgs] = args.slice(1);
    const route = `${providerRoute(instanceId)}/codex/profiles`;
    if (operation === 'list') { parseOptions(optionsArgs, []); return { route }; }
    if (operation === 'select' || operation === 'delete') {
      const options = parseOptions(optionsArgs, ['profile', 'revision', ...(operation === 'delete' ? ['confirm'] : [])]);
      if (!/^oaiapp_[A-Za-z0-9_-]+$/.test(options.profile ?? '')) invalid('--profile requires the exact managed ChatGPT profile ID.');
      if (operation === 'delete') confirm(options, 'delete');
      return bodyPlan(`${route}/${segment(options.profile, 'profile ID')}${operation === 'select' ? '/select' : ''}`, operation === 'select' ? 'POST' : 'DELETE', { revision: revision(options.revision) });
    }
    return usage('provider profiles');
  }
  if (action === 'registry') {
    if (id === 'search') {
      const options = parseOptions(rest, ['query', 'limit']);
      const query = nonempty(options.query, '--query'); if (query.length > 200) invalid('--query exceeds 200 characters.');
      const limit = options.limit === undefined ? 30 : revision(options.limit); if (limit > 100) invalid('--limit must be at most 100.');
      return { route: `/api/providers/acp-registry/search?${new URLSearchParams({ q: query, limit: String(limit) })}` };
    }
    if (id === 'prepare') {
      const [instanceId, ...optionArgs] = rest;
      const options = parseOptions(optionArgs, ['agent-id', 'consent']); consent(options, 'prepare'); segment(instanceId, 'provider ID');
      return { ...bodyPlan('/api/providers/acp-registry/prepare', 'POST', { instanceId, agentId: nonempty(options['agent-id'], '--agent-id') }), timeoutMs: 15 * 60_000 };
    }
    return usage('provider registry');
  }
  return usage('provider');
}

async function authPlan(args: string[]): Promise<Plan> {
  const [action, id, ...rest] = args;
  const route = `${providerRoute(id)}/auth`;
  if (action === 'status' || action === 'watch') {
    const options = parseOptions(rest, ['consent', 'interaction-file', ...(action === 'watch' ? ['flow', 'seconds'] : [])]); consent(options, 'native-probe');
    if (action === 'status') return { route, project: authProjection, ...authFile(options) };
    const flowId = nonempty(options.flow, '--flow'); segment(flowId, 'flow ID');
    const seconds = options.seconds === undefined ? 300 : revision(options.seconds); if (seconds > 900) invalid('--seconds must be at most 900.');
    return { route: `${route}/stream`, watch: { flowId, seconds }, ...authFile(options) };
  }
  if (action === 'input' || action === 'cancel') {
    const options = parseOptions(rest, ['flow', 'interaction-file', ...(action === 'input' ? ['input-file'] : [])]);
    const flowId = nonempty(options.flow, '--flow'); segment(flowId, 'flow ID');
    const input = action === 'input' ? await privateText(options['input-file'], '--input-file') : undefined;
    if (input !== undefined && input.length > 4096) invalid('Authentication input exceeds 4096 characters.');
    if (options['input-file'] && options['input-file'] === options['interaction-file']) invalid('Authentication input and output files must differ.');
    return { ...bodyPlan(`${route}/${action}`, 'POST', { flowId, ...(input === undefined ? {} : { input }) }), project: authProjection, ...authFile(options) };
  }
  return usage('provider auth');
}
function maintenancePlan(args: string[]): Plan {
  const [action, id, ...rest] = args;
  const route = `${providerRoute(id)}/maintenance`;
  if (action === 'get' || action === 'cancel') {
    parseOptions(rest, []); return action === 'get' ? { route } : bodyPlan(route, 'DELETE', {});
  }
  if (action === 'install' || action === 'update' || action === 'remove') {
    const options = parseOptions(rest, ['revision', 'consent']); consent(options, action);
    return bodyPlan(route, 'POST', { action, revision: revision(options.revision) });
  }
  return usage('provider maintenance');
}
async function modelsPlan(args: string[]): Promise<Plan> {
  const [action, id, ...rest] = args;
  if (action === 'set') {
    const options = parseOptions(rest, ['file', 'consent']); consent(options, 'native-probe');
    const body = await instanceBody(options.file, ['revision', 'customModels', 'modelPreferences'], true);
    return { ...bodyPlan(providerRoute(id), 'PUT', body), project: providerProjection };
  }
  if (action === 'list' || action === 'options') {
    const options = parseOptions(rest, ['consent', ...(action === 'options' ? ['model'] : [])]); consent(options, 'native-probe'); segment(id, 'provider ID');
    const modelId = action === 'options' ? nonempty(options.model, '--model') : undefined;
    return { route: '/api/providers', project: value => {
      const provider = catalogProvider(value, id!);
      if (action === 'list') return pick(providerProjection(provider), ['instanceId', 'revision', 'enabled', 'models', 'modelsSource', 'modelPreferences', 'updateRequiredModels']);
      const model = provider.models.find(entry => entry.id === modelId || entry.aliases?.includes(modelId!));
      if (!model) throw new CliRequestError('AGENT_MODEL_NOT_FOUND', 'The exact model is not in this instance catalog; no fallback was selected.', [], 404);
      return { instanceId: provider.instanceId, revision: provider.revision, enabled: provider.enabled, model: model.id,
        ...(model.disabledReason ? { disabledReason: model.disabledReason } : {}),
        optionDescriptors: model.capabilities?.optionDescriptors ?? [],
        defaultSelections: provider.modelPreferences?.options[model.id] ?? [],
        note: 'Only native declared options are supported; an empty descriptor list does not imply generic reasoning support.' };
    } };
  }
  return usage('models');
}
async function settingsPlan(args: string[]): Promise<Plan> {
  const [resource, action, ...rest] = args;
  if (resource !== 'chat-defaults') return usage('settings');
  if (action === 'get') {
    const options = parseOptions(rest, ['consent']); consent(options, 'native-probe');
    return { route: '/api/settings/chat-defaults' };
  }
  if (action === 'set') {
    const options = parseOptions(rest, ['file', 'consent']);
    const body = parse(chatDefaultsUpdateSchema, await privateObject(options.file));
    if (body.selection !== null) consent(options, 'native-probe');
    return bodyPlan('/api/settings/chat-defaults', 'PUT', body);
  }
  return usage('settings chat-defaults');
}
async function usagePlan(args: string[]): Promise<Plan> {
  const [resource, action, ...rest] = args;
  if (resource === 'summary' || resource === 'refresh') {
    const options = parseOptions(args.slice(1), ['file']);
    return { ...bodyPlan(`/api/usage/${resource}`, 'POST', parse(usageSummaryInputSchema, await privateObject(options.file))), timeoutMs: 120_000 };
  }
  if (resource === 'settings' || resource === 'prices') {
    if (action === 'get') {
      parseOptions(rest, []);
      return { route: '/api/usage/settings', ...(resource === 'prices' ? { project: (value: unknown) => pick(object(value), ['revision', 'usagePriceOverrides', 'usageModelAliases']) } : {}) };
    }
    if (action === 'set') {
      const options = parseOptions(rest, ['file']);
      const input = await privateObject(options.file);
      if (resource === 'prices') onlyFields(input, ['revision', 'usagePriceOverrides', 'usageModelAliases']);
      return bodyPlan('/api/usage/settings', 'PATCH', parse(usageSettingsUpdateSchema, input));
    }
    return usage(`usage ${resource}`);
  }
  if (resource === 'limits') {
    if (action === 'get') { parseOptions(rest, []); return { route: '/api/usage/limits' }; }
    if (action === 'refresh') {
      const options = parseOptions(rest, ['file']);
      const input = options.file === undefined ? {} : await privateObject(options.file);
      const body = parse(z.strictObject({ instanceIds: z.array(z.string().trim().min(1).max(512)).max(100).optional() }), input);
      return bodyPlan('/api/usage/limits/refresh', 'POST', body);
    }
    if (action === 'reset') {
      const options = parseOptions(rest, ['file', 'consent']); consent(options, 'redeem-reset-credit');
      return bodyPlan('/api/usage/limits/reset', 'POST', parse(providerConsumeResetCreditInputSchema, await privateObject(options.file)));
    }
    return usage('usage limits');
  }
  if (resource === 'sources') {
    if (action === 'list') { parseOptions(rest, []); return { route: '/api/usage/sources' }; }
    if (action === 'create') {
      const options = parseOptions(rest, ['file']);
      const input = parse(usageLimitSourceInputSchema, await privateObject(options.file));
      return bodyPlan('/api/usage/sources', 'POST', input);
    }
    const [id, ...optionsArgs] = rest;
    if (action === 'update') {
      const options = parseOptions(optionsArgs, ['file']);
      const input = parse(usageLimitSourceInputSchema.extend({ revision: z.number().int().nonnegative().safe() }), await privateObject(options.file));
      return bodyPlan(`/api/usage/sources/${segment(id, 'source ID')}`, 'PUT', input);
    }
    if (action === 'delete') {
      const options = parseOptions(optionsArgs, ['revision', 'confirm']); confirm(options, 'delete');
      return { route: `/api/usage/sources/${segment(id, 'source ID')}?revision=${revision(options.revision, 0)}`, method: 'DELETE' };
    }
    return usage('usage sources');
  }
  if (resource === 'thread') { parseOptions(rest, []); return { route: `/api/usage/threads/${segment(action, 'Session ID')}` }; }
  return usage('usage');
}
function diagnosticsPlan(args: string[]): Plan {
  const [action, ...rest] = args;
  if (action === 'get' || action === 'storage') { parseOptions(rest, []); return { route: `/api/settings/${action === 'get' ? 'diagnostics' : 'storage'}` }; }
  if (action === 'report') {
    const options = parseOptions(rest, ['output-file']);
    return { route: '/api/settings/diagnostics/report', ...(options['output-file'] === undefined ? {} : { privateOutput: outputPath(options['output-file'], '--output-file') }) };
  }
  return usage('diagnostics');
}
function quotaPlan(args: string[]): Plan {
  const [resource, action, id, ...rest] = args;
  if (resource === 'recovery') {
    if (action === 'list') { parseOptions(args.slice(2), []); return { route: '/api/automation/recovery' }; }
    if (action === 'enable' || action === 'disable') {
      const options = parseOptions(rest, action === 'enable' ? ['consent'] : []);
      if (action === 'enable') consent(options, 'quota-recovery');
      return bodyPlan(`/api/automation/recovery/${segment(id, 'original generation ID')}`, 'PUT', { enabled: action === 'enable' });
    }
    return usage('quota recovery');
  }
  if (resource === 'dispatches') {
    const options = parseOptions(args.slice(1), ['run']);
    if (options.run !== undefined) segment(options.run, 'original generation ID');
    return { route: `/api/automation/dispatches${options.run === undefined ? '' : `?${new URLSearchParams({ sourceId: options.run })}`}` };
  }
  return usage('quota');
}

async function requireResponse(response: Response): Promise<Response> {
  if (response.ok) return response;
  // Read only the known domain classification; never emit a native error body,
  // which may contain credentials, runtime arguments, paths, or terminal output.
  const value: unknown = await response.json().catch(() => null);
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const message = typeof record.error === 'string' ? record.error : '';
  if (/not supported|unsupported|no available logout|no available.*operation|supported native authentication method/i.test(message)) {
    throw new CliRequestError('AGENT_PROVIDER_UNSUPPORTED', 'This operation is unsupported by the selected Provider/configuration. No substitute or retry was used.', [], response.status);
  }
  if (/disabled|停用|禁用/.test(message)) throw new CliRequestError('AGENT_PROVIDER_DISABLED', 'The selected Provider is disabled; enable it explicitly at its current revision.', [], response.status);
  throw new CliRequestError(response.status === 409 ? 'AGENT_RESOURCE_CONFLICT' : 'AGENT_RESOURCE_FAILED',
    `Agent resource request failed (HTTP ${response.status}); inspect the exact original resource before another write. No retry was performed.`, [], response.status);
}
async function savePrivateOutput(filename: string, value: unknown): Promise<void> {
  try { await writePrivateFile(filename, `${JSON.stringify(value, null, 2)}\n`); }
  catch { throw new CliRequestError('AGENT_PRIVATE_OUTPUT_FAILED', 'The operation may already have completed, but its explicit private output could not be saved. Inspect the original flow/resource; do not repeat a write.'); }
}
async function publishAuth(runtime: CliRuntime, value: unknown, privateOutput?: string): Promise<void> {
  if (privateOutput !== undefined) await savePrivateOutput(privateOutput, value);
  runtime.print(safeOutput({ ...authProjection(value) as Record<string, unknown>, privateInteractionSaved: privateOutput !== undefined }));
}
async function watchAuth(connection: AgentConnection, runtime: CliRuntime, plan: Plan): Promise<void> {
  const watch = plan.watch!;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), watch.seconds * 1000);
  const interrupt = (): void => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await requireResponse(await connection.request(plan.route, { signal: controller.signal }));
    if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new CliRequestError('AGENT_AUTH_STREAM_INVALID', 'Agent did not return its native authentication event stream.');
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      buffer = (buffer + decoder.decode(part.value, { stream: true })).replace(/\r\n/g, '\n');
      if (buffer.length > 256 * 1024) throw new CliRequestError('AGENT_AUTH_STREAM_LIMIT', 'Authentication stream event exceeded the input limit. The native flow was not restarted.');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        let event: Record<string, unknown>;
        try { event = object(JSON.parse(data)); }
        catch { throw new CliRequestError('AGENT_AUTH_STREAM_INVALID', 'Native authentication stream contained an invalid event.'); }
        if (event.type === 'error') throw new CliRequestError('AGENT_AUTH_STREAM_FAILED', 'Native authentication stream failed; inspect the original flow without restarting it.');
        if (event.type !== 'state') continue; // Raw output is delivered only inside the explicit private state file.
        const state = event.state as ProviderAuthState;
        if (state.flowId !== watch.flowId) throw new CliRequestError('AGENT_AUTH_FLOW_CHANGED', 'The authentication flow changed or expired; this watcher will not follow a replacement flow.');
        await publishAuth(runtime, state, plan.privateOutput);
        if (['succeeded', 'failed', 'cancelled'].includes(state.phase)) return;
      }
    }
    throw new CliRequestError('AGENT_AUTH_STREAM_ENDED', 'Authentication stream ended without a terminal state; inspect the original flow. It was not restarted.');
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    runtime.print({ watching: false, flowId: watch.flowId, reason: 'watch_stopped', nativeFlowCancelled: false, note: 'Use the explicit auth cancel command to cancel the original flow.' });
  } finally {
    clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    await reader?.cancel().catch(() => undefined); reader?.releaseLock();
  }
}

export const agentProvidersFamily: CliFamily = {
  help: HELP,
  async dispatch(args, runtime) {
    if (args[0] !== 'agent' || !Object.hasOwn(RESOURCES, args[1] ?? '')) return false;
    const resource = args[1]!;
    const command = args.slice(2);
    const plan = resource === 'provider' ? await providerPlan(command)
      : resource === 'models' ? await modelsPlan(command)
        : resource === 'settings' ? await settingsPlan(command)
          : resource === 'usage' ? await usagePlan(command)
            : resource === 'diagnostics' ? diagnosticsPlan(command) : quotaPlan(command);
    if (plan.privateOutput !== undefined) {
      try { await readPrivateFile(plan.privateOutput); }
      catch { invalid('Private output path is unsafe or unavailable; no request was sent.'); }
    }
    const connection = await connectAgent();
    try {
      if (plan.watch) await watchAuth(connection, runtime, plan);
      else {
        const response = await requireResponse(await connection.request(plan.route, {
          method: plan.method ?? 'GET',
          ...(plan.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(plan.body) }),
          signal: AbortSignal.timeout(plan.timeoutMs ?? 120_000),
        }));
        let value: unknown;
        try { value = await response.json(); }
        catch { throw new CliRequestError('AGENT_RESOURCE_RESPONSE_INVALID', 'Agent response was incomplete JSON; inspect the original resource before another write. No retry was performed.'); }
        if (plan.project === authProjection) await publishAuth(runtime, value, plan.privateOutput);
        else {
          const result = safeOutput(plan.project ? plan.project(value) : value);
          if (plan.privateOutput !== undefined) { await savePrivateOutput(plan.privateOutput, result); runtime.print({ saved: true, reportContains: 'allowlisted-status-only' }); }
          else runtime.print(result);
        }
      }
    } finally { connection.close(); }
    return true;
  },
};
