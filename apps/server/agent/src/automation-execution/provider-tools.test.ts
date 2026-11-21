import assert from 'node:assert/strict';
import { test } from 'node:test';
import { studioNativeTemplateRequiresWorkspace, studioRequiredProviderToolFeature, type StudioConfig } from '../../../../../packages/contracts/src/automation-studio.ts';
import { assertAutomationProviderToolSupport, getAutomationProviderToolSupport } from './provider-tools.ts';

function config(action: StudioConfig['action']): StudioConfig { return { name: 'Provider shape fixture', description: '', projectId: 'PRJ-001', tags: [], templateId: null, action, trigger: { kind: 'manual' }, dailyLimit: 1, cooldownMinutes: 0 }; }
const common = { repositories: [], plugins: [], timeoutSeconds: 30 };
test('legacy-only drivers explicitly reject automation connector descriptors', () => {
  for (const driver of ['omp', 'pi']) {
    const support = getAutomationProviderToolSupport(driver);
    assert.equal(support.promptConnectors.available, false, driver);
    assert.match(support.promptConnectors.reason!, /pm_tools|pm_\*/);
  }
});
test('OpenCode cannot combine its single host transport with an extra integration descriptor', () => {
  const support = getAutomationProviderToolSupport('opencode');
  assert.equal(support.promptConnectors.available, false);
  assert.match(support.promptConnectors.reason!, /one generation-scoped host transport/);
});
test('bound MCP descriptors are admitted while unknown mappings fail closed', () => {
  for (const driver of ['claude', 'muse', 'cursor', 'codex', 'antigravity', 'grok', 'fx', 'acpRegistry']) assert.deepEqual(getAutomationProviderToolSupport(driver), { promptConnectors: { available: true, reason: null } });
  const unknown = getAutomationProviderToolSupport('future-unmapped-driver');
  assert.equal(unknown.promptConnectors.available, false);
  assert.match(unknown.promptConnectors.reason!, /no verified/);
});
test('ordinary prompts without connectors and deterministic PM templates need no provider tool adapter', () => {
  const prompt = config({ kind: 'prompt', ...common, providerInstanceId: 'fixture-not-looked-up', model: 'fixture', options: {}, prompt: 'model only' });
  const maintenance = config({ kind: 'template', ...common, templateId: 'pm-stalled-tasks', arguments: {}, providerInstanceId: null, model: null, options: {} });
  for (const input of [prompt, maintenance]) { assert.equal(studioRequiredProviderToolFeature(input), null); assert.doesNotThrow(() => assertAutomationProviderToolSupport(input)); }
});
test('semantic PM templates request the no-tools analysis provider feature', () => {
  assert.equal(studioNativeTemplateRequiresWorkspace('pm-requirement-review'), false);
  const input = config({ kind: 'template', ...common, templateId: 'pm-requirement-review', arguments: {}, providerInstanceId: 'selected-provider', model: 'selected-model', options: {} });
  assert.equal(studioRequiredProviderToolFeature(input), 'provider:selected-provider:pmAnalysis');
});
