import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configForCommand, HELP, main, parseCliArgs } from '../cli.ts';
import { publicExperimentConfiguration } from './index.ts';

const modelArguments = ['--model', 'explicit-versioned-model', '--max-cost-usd', '2'];

test('CLI exposes exactly the six smoke tasks and canonical arms', () => {
  const smoke = parseCliArgs(['smoke', '--repeat', '3', ...modelArguments]);
  assert.deepEqual(smoke.taskIds, ['K02', 'K03', 'D01', 'D02', 'L02', 'L04']);
  assert.deepEqual(smoke.arms, ['dovspace']);
  assert.equal(smoke.repetitions, 3);
  const compare = parseCliArgs(['compare', '--tasks', 'smoke', '--arms', 'raw,knowledge,dovspace', ...modelArguments]);
  assert.equal(compare.taskIds.length, 6);
  assert.equal(compare.arms.length, 3);
  assert.equal(parseCliArgs(['run', 'K02', ...modelArguments]).taskIds[0], 'K02');
});

test('guidance scenarios are executable independently of the unchanged smoke selection', () => {
  for (const taskId of ['K04', 'D04', 'L03']) {
    assert.deepEqual(parseCliArgs(['run', '--task', taskId, ...modelArguments]).taskIds, [taskId]);
  }
  assert.deepEqual(parseCliArgs(['compare', '--tasks', 'K04,D04,L03', '--arms', 'raw,knowledge,dovspace', ...modelArguments]).taskIds, ['K04', 'D04', 'L03']);
});

test('invalid tasks arms duplicate options and budgets fail before runtime mutation', () => {
  for (const argv of [
    ['run', '--task', 'K99'], ['run', '--task', 'K02', '--arm', 'fake'],
    ['run', '--task', 'D03'], ['compare', '--tasks', 'all'],
    ['compare', '--arms', 'raw,raw'], ['compare', '--arms', 'raw'],
    ['smoke', '--repeat', '0'], ['smoke', '--repeat', '1.5'],
    ['run', '--task', 'K02', '--max-tool-calls', '-1'], ['run', '--task', 'K02', '--max-cost-usd', 'NaN'],
    ['run', '--task', 'K02', '--model', 'one', '--model', 'two'],
    ['run', '--task', 'K02', '--run-id', '../escape'], ['fixtures', 'destroy'],
    ['calibrate', '--task', 'K02'], ['run', 'K02', '--task', 'K03'],
  ]) assert.throws(() => parseCliArgs(argv), Error, argv.join(' '));
});

test('real inference never silently chooses the config default model or an unlimited cost', async () => {
  await assert.rejects(configForCommand(parseCliArgs(['run', 'K02', '--max-cost-usd', '2']), {}), /explicit --model/);
  await assert.rejects(configForCommand(parseCliArgs(['run', 'K02', '--model', 'explicit-versioned-model']), {}), /positive --max-cost-usd/);
  const config = await configForCommand(parseCliArgs(['run', 'K02', ...modelArguments]), {});
  assert.equal(config.model, 'explicit-versioned-model');
  assert.equal(config.budget.maxCostUsd, 2);
  assert.equal(config.providerEndpoint, undefined);
  assert.equal(config.providerApiKey, undefined);
  assert.equal(config.controlTransport, 'http');
});

test('only the explicitly named credential variable is accepted; model settings remain fixed', async () => {
  const environment = { OPENAI_API_KEY: 'do-not-inherit', EXPLICIT_BENCH_KEY: 'unit-test-only-key' };
  const without = await configForCommand(parseCliArgs(['run', 'K02', ...modelArguments]), environment);
  assert.equal(without.providerApiKey, undefined);
  const withKey = await configForCommand(parseCliArgs(['compare', '--tasks', 'K02', ...modelArguments,
    '--api-key-env', 'EXPLICIT_BENCH_KEY', '--provider-endpoint', 'https://example.test/v1',
    '--model-options', '{"reasoningEffort":"xhigh"}', '--max-tool-calls', '12', '--max-model-calls', '4',
    '--price-input-per-million', '1.25', '--price-output-per-million', '10', '--max-output-tokens', '1024']), environment);
  assert.equal(withKey.providerApiKey, 'unit-test-only-key');
  assert.deepEqual(withKey.modelOptions, { reasoningEffort: 'xhigh' });
  assert.equal(withKey.budget.maxToolCalls, 12);
  assert.equal(withKey.budget.maxModelCalls, 4);
  assert.deepEqual(withKey.prices, { inputPerMillion: 1.25, outputPerMillion: 10, maxOutputTokens: 1024 });
  await assert.rejects(configForCommand(parseCliArgs(['run', 'K02', ...modelArguments, '--output-root', '../../apps/server']), {}), /descendants/);
});

test('calibration is a separate command, not an arm or implicit run fallback', () => {
  assert.equal(parseCliArgs(['calibrate']).command, 'calibrate');
  assert.throws(() => parseCliArgs(['compare', '--arms', 'raw,calibration']));
  assert.throws(() => parseCliArgs(['run', 'K02', '--calibrate']));
});

test('study commands are independent from original arms and do not admit calibration aliases', () => {
  assert.equal(parseCliArgs(['tools-study-validate', '--manifest', 'explicit.json']).command, 'tools-study-validate');
  assert.equal(parseCliArgs(['tools-study-report', '--study-results', 'outputs/study/study-results.json']).command, 'tools-study-report');
  assert.equal(parseCliArgs(['tools-study-fixture']).command, 'tools-study-fixture');
  assert.deepEqual(parseCliArgs(['tools-study', '--manifest', 'explicit.json']).arms, []);
  assert.throws(() => parseCliArgs(['run', 'K02', '--arm', 'baseline']));
  assert.throws(() => parseCliArgs(['tools-study', '--task', 'K02']));
});

test('OMP config preserves explicit API/model metadata and refuses unsupported implicit options', async () => {
  const config = await configForCommand(parseCliArgs(['run', 'K02', ...modelArguments, '--provider', 'omp', '--provider-api', 'openai-responses', '--omp-model', '{"contextWindow":100000,"maxTokens":4096,"reasoning":true}', '--model-options', '{"thinking":"high"}', '--price-input-per-million', '1', '--price-output-per-million', '2', '--max-output-tokens', '100', '--price-cache-read-per-million', '0.2', '--price-version', 'explicit-schedule']), {});
  assert.equal(config.providerBinary, '/usr/local/bin/omp');
  assert.equal(config.providerApi, 'openai-responses');
  assert.deepEqual(config.ompModel, { contextWindow: 100000, maxTokens: 4096, reasoning: true });
  assert.equal(config.prices?.cacheReadPerMillion, 0.2);
  assert.equal(config.prices?.version, 'explicit-schedule');
  assert.equal(config.providerApiKey, undefined);
});

test('operator transport is explicit across run smoke compare and config overrides', async () => {
  assert.match(HELP, /--control-transport http\|cli/);
  for (const command of [['run', 'K02'], ['smoke'], ['compare', '--tasks', 'K02']]) {
    const config = await configForCommand(parseCliArgs([...command, ...modelArguments, '--control-transport', 'cli']), {});
    assert.equal(config.controlTransport, 'cli');
  }
  assert.throws(() => parseCliArgs(['run', 'K02', ...modelArguments, '--control-transport', 'automatic']));
  assert.throws(() => parseCliArgs(['run', 'K02', ...modelArguments, '--control-transport', 'cli', '--control-transport', 'http']));
  const directory = await mkdtemp(join(tmpdir(), 'bench-control-config-'));
  try {
    const file = join(directory, 'config.json');
    await writeFile(file, JSON.stringify({ controlTransport: 'cli', model: 'explicit-config-model', budget: { maxCostUsd: 2 } }), { mode: 0o600 });
    assert.equal((await configForCommand(parseCliArgs(['run', 'K02', '--config', file]), {})).controlTransport, 'cli');
    assert.equal((await configForCommand(parseCliArgs(['run', 'K02', '--config', file, '--control-transport', 'http']), {})).controlTransport, 'http');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('study execution refuses command-line transport overrides before touching source or provider', async (context) => {
  const errors = context.mock.method(console, 'error', () => undefined);
  assert.equal(await main(['tools-study', '--manifest', 'not-read.json', '--control-transport', 'cli']), 2);
  assert.match(String(errors.mock.calls[0]?.arguments[0]), /cannot override preregistered controls/);
});

test('native account CLI keeps explicit selection and host-only SDK paths separate, without inheriting ordinary credentials', async () => {
  const boundary = { kind: 'omp-native-account', provider: 'openai-codex', accountRowId: 17, accountFingerprint: 'a'.repeat(64), sdkVersion: '18.15.0', sdkLockSha256: 'b'.repeat(64), catalogSha256: 'c'.repeat(64) };
  const native = ['run', 'K02', '--control-transport', 'cli', '--provider', 'omp', '--provider-api', 'openai-codex-responses',
    '--model', 'gpt-6.1-sol', '--model-options', '{"thinking":"xhigh"}', '--provider-endpoint', 'https://chatgpt.com/backend-api', '--max-cost-usd', '10',
    '--omp-model', '{"contextWindow":500000,"maxTokens":128000,"reasoning":true,"thinking":{"efforts":["low","medium","high","xhigh","max"],"mode":"effort"},"omitMaxOutputTokens":true}',
    '--price-input-per-million', '2', '--price-output-per-million', '10', '--price-cache-read-per-million', '0.1', '--price-cache-write-per-million', '0',
    '--max-output-tokens', '128000', '--price-version', 'exact-test-catalog', '--price-basis', 'catalog-estimate', '--host-auth-boundary', JSON.stringify(boundary)];
  const access = ['--omp-sdk-root', '/trusted/sdk', '--omp-bun', '/trusted/bun', '--omp-auth-store', '/trusted/existing/agent.db'];
  const config = await configForCommand(parseCliArgs([...native, ...access]), { OPENAI_API_KEY: 'never-inherit', OPENAI_CODEX_OAUTH_TOKEN: 'never-inherit-oauth' });
  assert.equal(config.providerApiKey, undefined); assert.equal(config.providerApi, 'openai-codex-responses');
  assert.deepEqual(config.hostAuthBoundary, boundary);
  assert.deepEqual(config.hostAuthAccess, { sdkRoot: '/trusted/sdk', bunBinary: '/trusted/bun', authStorePath: '/trusted/existing/agent.db' });
  const exported = publicExperimentConfiguration(config);
  assert.deepEqual(exported.hostAuthBoundary, boundary);
  assert.doesNotMatch(JSON.stringify(exported), /hostAuthAccess|trusted|never-inherit/);
  await assert.rejects(configForCommand(parseCliArgs([...native, ...access, '--api-key-env', 'UNSET_KEY']), {}), /cannot be combined/);
  await assert.rejects(configForCommand(parseCliArgs([...native, '--omp-sdk-root', '/trusted/sdk']), {}), /Explicit absolute/);
  assert.equal(parseCliArgs(['native-account-catalog', '--omp-sdk-root', '/trusted/sdk', '--omp-bun', '/trusted/bun']).command, 'native-account-catalog');
});

test('host SDK access paths cannot be smuggled into exported run/study config JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bench-native-config-'));
  try {
    const file = join(directory, 'config.json');
    await writeFile(file, JSON.stringify({ model: 'explicit', budget: { maxCostUsd: 10 }, hostAuthAccess: { sdkRoot: '/host', bunBinary: '/host/bun', authStorePath: '/host/agent.db' } }), { mode: 0o600 });
    await assert.rejects(configForCommand(parseCliArgs(['run', 'K02', '--config', file]), {}), /CLI-only/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
