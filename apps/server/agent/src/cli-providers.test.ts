import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { agentProvidersFamily } from '../../../../packages/pm-cli/agent-providers.ts';
import { agentLogin, agentLogout } from '../../../../packages/pm-cli/agent-connection.ts';
import type { CliRuntime } from '../../../../packages/pm-cli/runtime.ts';
import { accessGuard, accessRoutes } from './access.ts';
import { providerRoutes } from './providers/routes.ts';
import { settingsRoutes } from './settings/routes.ts';
import { diagnosticsRoutes } from './settings/diagnostics.ts';
import { usageRoutes } from './usage/routes.ts';
import { automationRoutes, stopAutomation } from './automation/index.ts';
import { closeStore } from './durable/store.ts';
import { ensureThread } from './durable/threads.ts';
import { chatOnlyExecutionSelection } from '@agent-workspace/contracts/chat';
import { chatOnlyEnvironment } from './durable/execution.testkit.ts';
import { recordNativeUsage } from './usage/ledger.ts';
import { getNativeProviderAdapter } from './providers/driver-registry.ts';
import { beginProviderExecution, cancelProviderAuth, getAuthState, resetAuthState } from './providers/auth.ts';
import { getStoredInstance, getProviderSettings, updateProviderSettings } from './providers/instances.ts';
import { stopProviderMaintenanceRuntime } from './providers/maintenance.ts';

// Exercise the actual HTTP adapter, native routes and stores. Native driver I/O
// remains controlled: no accounts, model calls, installer downloads or PM data.
async function fixture(run: (f: {
  root: string;
  calls: { route: string; method: string }[];
  file(value: unknown, name?: string): Promise<string>;
  cli(args: string[]): Promise<unknown>;
}) => Promise<void>): Promise<void> {
  const previousEnvironment = { ...process.env };
  const previousFetch = globalThis.fetch;
  const root = await mkdtemp('/tmp/pm-agent-providers-');
  const token = 'isolated-provider-test-operator-token-not-a-real-secret';
  process.env.AGENT_WORKSPACE_DATA_DIR = path.join(root, 'agent-data');
  process.env.AGENT_WORKSPACE_ACCESS_TOKEN = token;
  process.env.PM_AGENT_SESSION_DIR = path.join(root, 'operator');
  process.env.HOME = path.join(root, 'unrelated-native-home');
  process.env.USERPROFILE = process.env.HOME;
  process.env.XDG_CONFIG_HOME = path.join(process.env.HOME, '.config');
  process.env.CODEX_HOME = path.join(root, 'unrelated-codex-home');
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'unrelated-claude-home');
  await mkdir(process.env.HOME, { recursive: true, mode: 0o700 });
  const calls: { route: string; method: string }[] = [];
  const app = new Hono().route('/api', accessRoutes).use('/api/*', accessGuard)
    .route('/api', providerRoutes).route('/api', settingsRoutes).route('/api', diagnosticsRoutes)
    .route('/api', usageRoutes).route('/api', automationRoutes);
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  process.env.PM_AGENT_URL = origin;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, origin, 'No native network request, PM identity, or installer download is allowed in this fixture');
    const headers = new Headers(init?.headers);
    headers.set('Host', url.host);
    assert.equal(headers.has('authorization'), false, 'Independent Agent cookie is used, never PM bearer');
    calls.push({ route: `${url.pathname}${url.search}`, method: init?.method ?? 'GET' });
    return previousFetch(url, { ...init, headers });
  };
  const runtime: CliRuntime = {
    authentication: async () => assert.fail('Provider family must not request PM authentication'),
    connection: async () => assert.fail('Provider family must not request a PM connection'),
    json: async () => assert.fail('Provider family must not use PM transport'),
    response: async () => assert.fail('Provider family must not use PM transport'),
    print() { assert.fail('Each invocation installs its own output collector'); },
  };
  let sequence = 0;
  try {
    await agentLogin({ token });
    const settings = getProviderSettings();
    updateProviderSettings(settings.revision, 0);
    await run({
      root, calls,
      async file(value, name = `input-${sequence++}.json`) {
        const filename = path.join(root, name);
        await writeFile(filename, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
        return filename;
      },
      async cli(args) {
        const output: unknown[] = [];
        assert.equal(await agentProvidersFamily.dispatch(['agent', ...args], { ...runtime, print: value => output.push(value) }), true);
        assert.ok(output.length > 0);
        return output.at(-1);
      },
    });
  } finally {
    for (const id of ['codex', 'cli-account']) {
      try { const state = await getAuthState(id); if (state.flowId && ['starting', 'waiting', 'verifying'].includes(state.phase)) await cancelProviderAuth(id, state.flowId); } catch { /* nonexistent/disabled fixture */ }
      resetAuthState(id);
    }
    await stopAutomation();
    await stopProviderMaintenanceRuntime();
    await agentLogout().catch(() => undefined);
    closeStore();
    globalThis.fetch = previousFetch;
    const closed = Promise.withResolvers<void>();
    server.close((error?: Error) => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(previousEnvironment, key)) delete process.env[key];
    Object.assign(process.env, previousEnvironment);
    await rm(root, { recursive: true, force: true });
  }
}

test('Provider family leaves unowned agent prefixes untouched and rejects unknown owned commands before identity or I/O', async () => {
  const runtime = { print() { assert.fail(); } } as unknown as CliRuntime;
  for (const args of [['protocol'], ['agent', 'session', 'list'], ['agent', 'login'], ['agent', 'extensions']]) assert.equal(await agentProvidersFamily.dispatch(args, runtime), false);
  await assert.rejects(agentProvidersFamily.dispatch(['agent', 'provider', 'proxy', '/api/access'], runtime), /Unknown agent provider/);
  await assert.rejects(agentProvidersFamily.dispatch(['agent', 'provider', 'list'], runtime), /--consent native-probe/);
  await assert.rejects(agentProvidersFamily.dispatch(['agent', 'provider', 'login', 'codex', '--token', 'must-not-enter-argv'], runtime), /unsupported option/);
});

test('real Provider CRUD preserves exact revision, disabled behavior, Home, model options and private env projections', async () => {
  await fixture(async f => {
    const home = path.join(f.root, 'explicit-provider-home');
    await mkdir(home, { mode: 0o700 });
    const secret = 'test-only-provider-env-not-public';
    const createFile = await f.file({ instanceId: 'cli-account', driver: 'codex', enabled: false,
      config: { homePath: home }, environment: [{ name: 'EXAMPLE_TOKEN', value: secret, sensitive: true }],
      customModels: [{ id: 'custom-model', label: 'Custom' }],
      modelPreferences: { hidden: [], order: ['custom-model'], favorites: ['custom-model'], options: {} } });
    const created = await f.cli(['provider', 'create', '--file', createFile, '--consent', 'native-probe']) as { instanceId: string; revision: number; enabled: boolean; environment: { value: string }[] };
    assert.equal(created.instanceId, 'cli-account'); assert.equal(created.enabled, false);
    assert.equal(JSON.stringify(created).includes(secret), false);
    assert.ok(created.environment.every(entry => entry.value === '[redacted]'));
    assert.equal(getStoredInstance('cli-account')!.env.EXAMPLE_TOKEN, secret, 'Real instance store receives the protected input');
    const before = f.calls.length;
    await assert.rejects(f.cli(['provider', 'health', 'cli-account', '--consent', 'native-probe']), { code: 'AGENT_PROVIDER_DISABLED', status: 409 });
    assert.equal(f.calls.slice(before).filter(call => call.route.endsWith('/test')).length, 1, 'No failed write/probe replay');
    const updateFile = await f.file({ revision: created.revision, label: 'Renamed without selecting a model' });
    const updated = await f.cli(['provider', 'update', 'cli-account', '--file', updateFile, '--consent', 'native-probe']) as { revision: number; label: string };
    assert.ok(updated.revision > created.revision); assert.equal(updated.label, 'Renamed without selecting a model');
    await assert.rejects(f.cli(['provider', 'update', 'cli-account', '--file', updateFile, '--consent', 'native-probe']), { code: 'AGENT_RESOURCE_CONFLICT', status: 409 });
    const options = await f.cli(['models', 'options', 'cli-account', '--model', 'custom-model', '--consent', 'native-probe']) as { optionDescriptors: unknown[]; enabled: boolean };
    assert.equal(options.enabled, false); assert.deepEqual(options.optionDescriptors, [], 'No invented generic reasoning options');
    const projectedHome = await f.cli(['provider', 'home', 'cli-account', '--consent', 'native-probe']) as { config: { homePath: string }; effectiveHome: null };
    assert.equal(projectedHome.config.homePath, home); assert.equal(projectedHome.effectiveHome, null, 'CLI does not resolve server native Home using its own environment');
    const defaults = getStoredInstance('codex')!;
    const reset = await f.cli(['provider', 'reset', 'codex', '--revision', String(defaults.revision), '--confirm', 'reset', '--consent', 'native-probe']) as { enabled: boolean; revision: number };
    assert.equal(reset.enabled, false); assert.ok(reset.revision > defaults.revision);
    await f.cli(['provider', 'delete', 'cli-account', '--confirm', 'delete']);
    assert.equal(getStoredInstance('cli-account'), null);
    await assert.rejects(f.cli(['provider', 'get', 'cli-account', '--consent', 'native-probe']), { code: 'AGENT_PROVIDER_NOT_FOUND' });
  });
});

test('ACP launch arguments remain private through mutation and catalog output', async () => {
  await fixture(async f => {
    const secret = 'fixture-private-acp-launch-value';
    const config = { source: 'local', commandPath: path.join(f.root, 'never-executed'), commandArgs: ['--api-key', secret] };
    const createFile = await f.file({ instanceId: 'cli-account', driver: 'acpRegistry', enabled: false, config });
    const created = await f.cli(['provider', 'create', '--file', createFile, '--consent', 'native-probe']) as { revision: number };
    assert.deepEqual(getStoredInstance('cli-account')!.config.commandArgs, config.commandArgs);
    assert.equal(JSON.stringify(created).includes(secret), false, 'Private launch arguments must not enter mutation output');
    const updatedSecret = 'fixture-private-updated-acp-launch-value';
    const updateFile = await f.file({ revision: created.revision, config: { ...config, commandArgs: ['--api-key', updatedSecret] } });
    const updated = await f.cli(['provider', 'update', 'cli-account', '--file', updateFile, '--consent', 'native-probe']);
    assert.deepEqual(getStoredInstance('cli-account')!.config.commandArgs, ['--api-key', updatedSecret]);
    const listed = await f.cli(['provider', 'list', '--consent', 'native-probe']);
    const fetched = await f.cli(['provider', 'get', 'cli-account', '--consent', 'native-probe']);
    for (const output of [updated, listed, fetched]) assert.equal(JSON.stringify(output).includes(updatedSecret), false);
  });
});

test('private JSON rejects unsafe inputs before sending and never logs malformed content', async () => {
  await fixture(async f => {
    const unsafe = await f.file({ driver: 'codex', enabled: false }); await chmod(unsafe, 0o644);
    const linked = path.join(f.root, 'linked.json'); await symlink(unsafe, linked);
    const malformed = await f.file('{"token":"private-malformed-content",');
    for (const filename of [unsafe, linked, malformed, 'relative.json']) {
      const before = f.calls.length;
      await assert.rejects(f.cli(['provider', 'create', '--file', filename, '--consent', 'native-probe']), error => {
        assert.equal(String(error).includes('private-malformed-content'), false); return true;
      });
      assert.equal(f.calls.length, before);
    }
    const smuggled = await f.file({ driver: 'codex', enabled: false, route: '/api/access' });
    await assert.rejects(f.cli(['provider', 'create', '--file', smuggled, '--consent', 'native-probe']), /unsupported fields/);
  });
});

test('native authentication uses original flow and private interaction output; cancellation and logout are real service actions', async () => {
  const adapter = getNativeProviderAdapter('codex')!;
  const original = { check: adapter.check, authenticate: adapter.authenticate, logout: adapter.logout };
  let authenticated = false;
  let logoutCalls = 0;
  let nativeHome: string | undefined;
  const ready = Promise.withResolvers<void>();
  const secret = 'fixture-only-provider-login-value';
  adapter.check = async () => ({ installation: { status: 'installed' }, authentication: authenticated ? 'authenticated' : 'unauthenticated', nativeSessionReady: authenticated,
    models: [], canLogout: authenticated, methods: [{ id: 'controlled-login', name: 'Controlled native login', type: 'browser' }] });
  adapter.authenticate = async (context, options) => {
    nativeHome = context.homeDirectory;
    options.onUpdate({ phase: 'waiting', interaction: { type: 'browser', id: 'controlled-login', url: 'https://accounts.example.invalid/login?state=private-challenge', userCode: 'PRIVATE-CODE', acceptsCallback: true } });
    const input = options.readInput(); ready.resolve();
    const value = await input; assert.equal(value, secret);
    options.onUpdate({ output: `native output ${value}` }); authenticated = true;
  };
  adapter.logout = async () => { logoutCalls++; authenticated = false; };
  try {
    await fixture(async f => {
      const home = path.join(f.root, 'explicit-auth-home'); await mkdir(home, { mode: 0o700 });
      const createFile = await f.file({ instanceId: 'cli-account', driver: 'codex', enabled: true, config: { homePath: home } });
      await f.cli(['provider', 'create', '--file', createFile, '--consent', 'native-probe']);
      const interactionFile = path.join(f.root, 'private-flow.json');
      const login = await f.cli(['provider', 'login', 'cli-account', '--method', 'controlled-login', '--consent', 'authenticate', '--interaction-file', interactionFile]) as { flowId: string };
      await ready.promise;
      const status = await f.cli(['provider', 'auth', 'status', 'cli-account', '--consent', 'native-probe', '--interaction-file', interactionFile]);
      assert.equal(nativeHome, home);
      assert.equal(JSON.stringify(status).includes('PRIVATE-CODE'), false);
      assert.equal(JSON.stringify(status).includes('private-challenge'), false);
      assert.match(await readFile(interactionFile, 'utf8'), /PRIVATE-CODE/);
      assert.equal((await stat(interactionFile)).mode & 0o777, 0o600);
      const input = await f.file(secret, 'private-auth-input.txt');
      const response = await f.cli(['provider', 'auth', 'input', 'cli-account', '--flow', login.flowId, '--input-file', input]);
      assert.equal(JSON.stringify(response).includes(secret), false);
      const final = await f.cli(['provider', 'auth', 'watch', 'cli-account', '--flow', login.flowId, '--consent', 'native-probe', '--seconds', '2']) as { phase: string };
      assert.equal(final.phase, 'succeeded');
      await assert.rejects(f.cli(['provider', 'auth', 'input', 'cli-account', '--flow', 'stale-flow', '--input-file', input]), { status: 404 });
      await f.cli(['provider', 'logout', 'cli-account', '--consent', 'logout']); assert.equal(logoutCalls, 1);
      const cancelledLogin = await f.cli(['provider', 'login', 'cli-account', '--method', 'controlled-login', '--consent', 'authenticate']) as { flowId: string };
      const cancelled = await f.cli(['provider', 'auth', 'cancel', 'cli-account', '--flow', cancelledLogin.flowId]) as { phase: string };
      assert.equal(cancelled.phase, 'cancelled');
      const disabled = await f.cli(['provider', 'disable', 'cli-account', '--revision', String(getStoredInstance('cli-account')!.revision), '--consent', 'native-probe']) as { enabled: boolean; revision: number };
      assert.equal(disabled.enabled, false);
      await f.cli(['provider', 'enable', 'cli-account', '--revision', String(disabled.revision), '--consent', 'native-probe']);
      const modelFile = await f.file({ revision: getStoredInstance('cli-account')!.revision,
        customModels: [{ id: 'controlled-model', label: 'Controlled model', capabilities: { optionDescriptors: [
          { id: 'effort', label: 'Effort', type: 'select', options: [{ id: 'high', label: 'High' }] },
        ] } }],
        modelPreferences: { hidden: [], order: ['controlled-model'], favorites: [], options: { 'controlled-model': [{ id: 'effort', value: 'high' }] } } });
      await f.cli(['models', 'set', 'cli-account', '--file', modelFile, '--consent', 'native-probe']);
      const model = await f.cli(['models', 'options', 'cli-account', '--model', 'controlled-model', '--consent', 'native-probe']) as { optionDescriptors: { id: string }[]; defaultSelections: unknown[] };
      assert.equal(model.optionDescriptors[0]!.id, 'effort');
      assert.deepEqual(model.defaultSelections, [{ id: 'effort', value: 'high' }]);
      const defaultFile = await f.file({ revision: 0, selection: { providerInstanceId: 'cli-account', model: 'controlled-model', modelOptions: [{ id: 'effort', value: 'high' }], interactionMode: 'plan' } });
      const defaults = await f.cli(['settings', 'chat-defaults', 'set', '--file', defaultFile, '--consent', 'native-probe']) as { defaults: { revision: number; selection: { model: string } } };
      assert.equal(defaults.defaults.selection.model, 'controlled-model');
      const invalidOption = await f.file({ revision: defaults.defaults.revision, selection: { providerInstanceId: 'cli-account', model: 'controlled-model', modelOptions: [{ id: 'effort', value: 'invented-value' }] } });
      await assert.rejects(f.cli(['settings', 'chat-defaults', 'set', '--file', invalidOption, '--consent', 'native-probe']), { status: 400 });
    });
  } finally { Object.assign(adapter, original); }
});

test('maintenance requires explicit action consent, respects active execution lock, supports cancellation, and reports unsupported', async () => {
  const adapter = getNativeProviderAdapter('codex')!;
  const omp = getNativeProviderAdapter('omp')!;
  const originalCheck = adapter.check, originalPrepare = adapter.prepare, originalOmpCheck = omp.check;
  const entered = Promise.withResolvers<void>();
  let installations = 0;
  adapter.check = async () => ({ installation: { status: 'not-installed' }, authentication: 'unknown', models: [], methods: [], canLogout: false });
  omp.check = adapter.check;
  adapter.prepare = async (_context, signal, progress) => {
    installations++; progress?.({ bytesDownloaded: 7, bytesTotal: 10 }); entered.resolve();
    const aborted = Promise.withResolvers<void>();
    if (signal?.aborted) aborted.resolve(); else signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
    await aborted.promise;
    signal?.throwIfAborted(); return { message: 'controlled install' };
  };
  try {
    await fixture(async f => {
      const create = await f.file({ instanceId: 'cli-account', driver: 'codex', enabled: true });
      await f.cli(['provider', 'create', '--file', create, '--consent', 'native-probe']);
      const current = getStoredInstance('cli-account')!;
      const before = f.calls.length;
      await assert.rejects(f.cli(['provider', 'maintenance', 'install', 'cli-account', '--revision', String(current.revision)]), /--consent install/);
      assert.equal(f.calls.length, before);
      const release = beginProviderExecution('cli-account');
      try { await assert.rejects(f.cli(['provider', 'maintenance', 'install', 'cli-account', '--revision', String(current.revision), '--consent', 'install']), { status: 409 }); }
      finally { release(); }
      const result = await f.cli(['provider', 'maintenance', 'install', 'cli-account', '--revision', String(current.revision), '--consent', 'install']) as { status: string };
      assert.equal(result.status, 'running'); await entered.promise;
      const running = await f.cli(['provider', 'maintenance', 'get', 'cli-account']) as { bytesDownloaded: number };
      assert.equal(running.bytesDownloaded, 7);
      const cancelled = await f.cli(['provider', 'maintenance', 'cancel', 'cli-account']) as { status: string };
      assert.equal(cancelled.status, 'cancelled'); assert.equal(installations, 1);
      const ompFile = await f.file({ instanceId: 'unsupported-omp', driver: 'omp', enabled: true });
      await f.cli(['provider', 'create', '--file', ompFile, '--consent', 'native-probe']);
      await assert.rejects(f.cli(['provider', 'maintenance', 'install', 'unsupported-omp', '--revision', String(getStoredInstance('unsupported-omp')!.revision), '--consent', 'install']), { code: 'AGENT_PROVIDER_UNSUPPORTED', status: 400 });
    });
  } finally {
    adapter.check = originalCheck; omp.check = originalOmpCheck;
    if (originalPrepare === undefined) delete adapter.prepare; else adapter.prepare = originalPrepare;
  }
});

test('real defaults, Usage prices/sources, diagnostics and missing ledger retain revision and unknown semantics', async () => {
  await fixture(async f => {
    const defaults = await f.cli(['settings', 'chat-defaults', 'get', '--consent', 'native-probe']) as { defaults: { revision: number } };
    const defaultFile = await f.file({ revision: defaults.defaults.revision, selection: null });
    const saved = await f.cli(['settings', 'chat-defaults', 'set', '--file', defaultFile]) as { defaults: { revision: number } };
    assert.ok(saved.defaults.revision > defaults.defaults.revision);
    await assert.rejects(f.cli(['settings', 'chat-defaults', 'set', '--file', defaultFile]), { status: 409 });
    const health = await f.cli(['provider', 'health-settings', 'get']) as { revision: number };
    const healthFile = await f.file({ revision: health.revision, healthRefreshIntervalSeconds: 0 });
    await f.cli(['provider', 'health-settings', 'set', '--file', healthFile]);
    await assert.rejects(f.cli(['provider', 'health-settings', 'set', '--file', healthFile]), { status: 409 });
    const usage = await f.cli(['usage', 'settings', 'get']) as { revision: number };
    const prices = await f.file({ revision: usage.revision, usagePriceOverrides: { 'unbilled-model': { inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 2 } } });
    const priceResult = await f.cli(['usage', 'prices', 'set', '--file', prices]) as { usagePriceOverrides: Record<string, unknown> };
    assert.ok(priceResult.usagePriceOverrides['unbilled-model']);
    await assert.rejects(f.cli(['usage', 'prices', 'set', '--file', prices]), { status: 409 });
    const key = 'private-usage-management-key';
    const sourceFile = await f.file({ kind: 'cliproxy', label: 'Private source', url: 'https://hub.example.invalid', enabled: false, managementKey: key });
    const sourceResult = await f.cli(['usage', 'sources', 'create', '--file', sourceFile]) as { source: { id: string; revision: number; managementKeyConfigured: boolean } };
    assert.equal(sourceResult.source.managementKeyConfigured, true); assert.equal(JSON.stringify(sourceResult).includes(key), false);
    const sourceList = await f.cli(['usage', 'sources', 'list']); assert.equal(JSON.stringify(sourceList).includes(key), false);
    await assert.rejects(f.cli(['usage', 'sources', 'delete', sourceResult.source.id, '--revision', '0', '--confirm', 'delete']), { status: 409 });
    await f.cli(['usage', 'sources', 'delete', sourceResult.source.id, '--revision', String(sourceResult.source.revision), '--confirm', 'delete']);
    ensureThread('usage-empty', undefined, chatOnlyExecutionSelection(), chatOnlyEnvironment());
    const missing = await f.cli(['usage', 'thread', 'usage-empty']) as Record<string, unknown>;
    assert.equal(Object.hasOwn(missing, 'totals'), false); assert.equal(Object.hasOwn(missing, 'costUsd'), false);
    recordNativeUsage({ generationId: 'usage-generation', threadId: 'usage-empty', instanceId: 'instance', provider: 'codex', model: 'model',
      update: { turn: { totals: { uncachedInputTokens: 7, cachedInputTokens: 3, cacheCreationTokens: 0, outputTokens: 4, reasoningTokens: 1 } } } });
    const measured = await f.cli(['usage', 'thread', 'usage-empty']) as { totals: { uncachedInputTokens: number; outputTokens: number } };
    assert.equal(measured.totals.uncachedInputTokens, 7); assert.equal(measured.totals.outputTokens, 4, 'Token counts must never be mistaken for secret tokens');
    const diagnostics = await f.cli(['diagnostics', 'get']);
    const report = JSON.stringify(diagnostics);
    assert.equal(report.includes(key), false); assert.equal(report.includes(f.root), false);
    const file = path.join(f.root, 'diagnostics.json'); await f.cli(['diagnostics', 'report', '--output-file', file]);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await f.cli(['quota', 'recovery', 'list']), { recoveries: [] });
    await assert.rejects(f.cli(['quota', 'recovery', 'enable', 'unknown-generation', '--consent', 'quota-recovery']), { status: 404 });
    assert.deepEqual(await f.cli(['quota', 'dispatches', '--run', 'unknown-generation']), { dispatches: [] });
    assert.equal(f.calls.some(call => /\/api\/chat(?:\/|$)|\/api\/v1\//.test(call.route)), false, 'Quota management never submits a new generation or PM Studio request');
  });
});
