import assert from 'node:assert/strict';
import { test } from 'node:test';
import { studioNativeTemplateRequiresWorkspace, studioRequiredProviderToolFeature, type StudioConfig, type StudioNativeTemplateId } from '../../../../../packages/contracts/src/automation-studio.ts';
import { assertAutomationProviderToolSupport, getAutomationProviderToolSupport } from './provider-tools.ts';

function config(action: StudioConfig['action']): StudioConfig { return { name: 'Provider shape fixture', description: '', projectId: 'PRJ-001', tags: [], templateId: null, action, trigger: { kind: 'manual' }, dailyLimit: 1, cooldownMinutes: 0 }; }
const common = { repositories: [], plugins: [], timeoutSeconds: 30 };
test('legacy-only drivers explicitly reject automation descriptor names instead of pretending generic MCP support', () => {
  for (const driver of ['omp', 'pi', 'cursor']) {
    const support = getAutomationProviderToolSupport(driver);
    assert.equal(support.promptConnectors.available, false, driver);
    assert.equal(support.templateWorkspace.available, false, driver);
    assert.match(support.templateWorkspace.reason!, /pm_tools|pm_\*/);
  }
});
test('OpenCode accepts one scratch descriptor but not the prompt PM-plus-integration pair', () => {
  const support = getAutomationProviderToolSupport('opencode');
  assert.equal(support.templateWorkspace.available, true);
  assert.equal(support.promptConnectors.available, false);
  assert.match(support.promptConnectors.reason!, /one generation-scoped host transport/);
});
test('generic transport projection is not mistaken for unattended approval authority', () => {
  for (const driver of ['claude', 'muse']) {
    const support = getAutomationProviderToolSupport(driver);
    assert.equal(support.promptConnectors.available, false); assert.equal(support.templateWorkspace.available, false);
    assert.match(support.templateWorkspace.reason!, /approval|preauthorized/);
  }
});
test('source-backed generic adapters remain available while unknown mappings fail closed', () => {
  for (const driver of ['codex', 'antigravity', 'grok', 'fx', 'acpRegistry']) assert.deepEqual(getAutomationProviderToolSupport(driver), { promptConnectors: { available: true, reason: null }, templateWorkspace: { available: true, reason: null } });
  const unknown = getAutomationProviderToolSupport('future-unmapped-driver');
  assert.equal(unknown.promptConnectors.available, false); assert.equal(unknown.templateWorkspace.available, false);
  assert.match(unknown.templateWorkspace.reason!, /no verified/);
});
test('ordinary prompts and no-repository model stages do not inherit scratch requirements', () => {
  const prompt = config({ kind: 'prompt', ...common, providerInstanceId: 'fixture-not-looked-up', model: 'fixture', options: {}, prompt: 'model only' });
  const news = config({ kind: 'template', ...common, templateId: 'news-digest', arguments: {}, providerInstanceId: 'fixture-not-looked-up', model: 'fixture', options: {} });
  const maintenance = config({ kind: 'template', ...common, templateId: 'github-delivery-watchdog', arguments: {}, providerInstanceId: null, model: null, options: {} });
  for (const input of [prompt, news, maintenance]) { assert.equal(studioRequiredProviderToolFeature(input), null); assert.doesNotThrow(() => assertAutomationProviderToolSupport(input)); }
});
test('all five repository templates request the selected-provider workspace feature, not just the three OCI-check templates', () => {
  const required: StudioNativeTemplateId[] = ['github-issue-to-pr', 'github-issue-triage', 'github-pr-reviewer', 'github-agents-md-maintainer', 'gitlab-issue-to-mr'];
  for (const templateId of required) {
    assert.equal(studioNativeTemplateRequiresWorkspace(templateId), true);
    const input = config({ kind: 'template', ...common, templateId, arguments: {}, providerInstanceId: 'selected-provider', model: 'selected-model', options: {} });
    assert.equal(studioRequiredProviderToolFeature(input), 'provider:selected-provider:templateWorkspace');
  }
});
