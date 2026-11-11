import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configForCommand, parseCliArgs } from '../cli.ts';

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
});

test('only the explicitly named credential variable is accepted; model settings remain fixed', async () => {
  const environment = { OPENAI_API_KEY: 'do-not-inherit', EXPLICIT_BENCH_KEY: 'unit-test-only-key' };
  const without = await configForCommand(parseCliArgs(['run', 'K02', ...modelArguments]), environment);
  assert.equal(without.providerApiKey, undefined);
  const withKey = await configForCommand(parseCliArgs(['compare', '--tasks', 'K02', ...modelArguments,
    '--api-key-env', 'EXPLICIT_BENCH_KEY', '--provider-endpoint', 'https://example.test/v1/responses',
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
