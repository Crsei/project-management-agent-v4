import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { studioActionSchema, studioNativeTemplateIdSchema, studioNativeTemplateRequiresProvider, studioNativeTemplateRequiresWorkspace, studioProviderOptionsSchema, studioRequiredProviderToolFeature, type StudioConfig } from '../src/automation-studio.ts';
import { isPmAutomationTemplateId } from '../src/automation-pm.ts';

const semanticPm: Record<string, true> = { 'pm-duplicate-tasks': true, 'pm-requirement-review': true, 'pm-session-followups': true, 'pm-decision-record': true, 'pm-session-knowledge': true, 'pm-next-phase-plan': true, 'pm-goal-drift': true, 'pm-next-actions': true };

describe('Studio native template and private-provider contracts', () => {
  it('covers all native migrations with strict provider/model and source-form argument snapshots', () => {
    assert.equal(studioNativeTemplateIdSchema.options.length, 32);
    for (const templateId of studioNativeTemplateIdSchema.options) {
      const action = { kind: 'template', templateId, arguments: isPmAutomationTemplateId(templateId) ? {} : { repositories: ['org/repository'], label: 'ready' }, providerInstanceId: 'native-provider', model: 'native-model', options: { reasoning: 'high' }, repositories: [], plugins: [], timeoutSeconds: 600 };
      assert.deepEqual(studioActionSchema.parse(action), action);
      assert.equal(studioActionSchema.safeParse({ ...action, content: 'Source Python must not be an implicit fallback' }).success, false);
    }
  });
  it('does not accept a source template id outside the explicit native migration or omit its model', () => {
    const action = { kind: 'template', templateId: 'github-pr-reviewer', arguments: {}, providerInstanceId: 'native-provider', model: 'native-model', options: {}, repositories: [], plugins: [], timeoutSeconds: 60 };
    assert.equal(studioActionSchema.safeParse({ ...action, templateId: 'unknown-template' }).success, false);
    assert.equal(studioActionSchema.safeParse({ ...action, model: undefined }).success, false);
  });
  it('allows explicit null Provider/model for deterministic workflows only', () => {
    const deterministic = ['github-delivery-watchdog', 'github-stale-ci-pr-closer'];
    for (const templateId of studioNativeTemplateIdSchema.options) {
      const action = { kind: 'template', templateId, arguments: {}, providerInstanceId: null, model: null, options: {}, repositories: [], plugins: [], timeoutSeconds: 60 };
      const requiresProvider = isPmAutomationTemplateId(templateId) ? semanticPm[templateId] === true : !deterministic.includes(templateId);
      assert.equal(studioNativeTemplateRequiresProvider(templateId), requiresProvider);
      assert.equal(studioActionSchema.safeParse(action).success, !requiresProvider);
      assert.equal(studioActionSchema.safeParse({ ...action, providerInstanceId: undefined }).success, false, 'None is explicit, not an implicit Provider fallback');
    }
  });
  it('stores model-option selections rather than private Provider credentials', () => {
    assert.deepEqual(studioProviderOptionsSchema.parse({ reasoning: 'high', toolsEnabled: true }), { reasoning: 'high', toolsEnabled: true });
    for (const key of ['apiKey','api_key','authorization','accessToken','refresh_token','password','secret','headers']) assert.equal(studioProviderOptionsSchema.safeParse({ [key]: 'must-not-persist' }).success, false);
    assert.equal(studioProviderOptionsSchema.safeParse({ reasoning: { secret: 'nested credentials' } }).success, false);
  });
  it('requires selected-Provider tool support for exactly the five repository templates, not news or deterministic maintenance', () => {
    const repositoryTemplates: Record<string, true> = { 'github-pr-reviewer': true, 'github-issue-to-pr': true, 'github-issue-triage': true, 'github-agents-md-maintainer': true, 'gitlab-issue-to-mr': true };
    const config: StudioConfig = { name: 'Protocol gate', description: '', projectId: 'PRJ-001', tags: [], templateId: null, trigger: { kind: 'manual' }, dailyLimit: 10, cooldownMinutes: 0, action: { kind: 'prompt', providerInstanceId: 'selected-provider', model: 'shared-model-name', options: {}, prompt: 'Observe', repositories: [], plugins: [], timeoutSeconds: 60 } };
    assert.equal(studioRequiredProviderToolFeature(config), null);
    assert.equal(studioRequiredProviderToolFeature({ ...config, action: { ...config.action, plugins: [{ id: 'integration:connection', version: '1' }] } }), 'provider:selected-provider:promptConnectors');
    for (const templateId of studioNativeTemplateIdSchema.options) {
      const needsWorkspace = repositoryTemplates[templateId] === true;
      assert.equal(studioNativeTemplateRequiresWorkspace(templateId), needsWorkspace);
      const native: StudioConfig = { ...config, action: { kind: 'template', templateId, arguments: {}, providerInstanceId: 'selected-provider', model: 'shared-model-name', options: {}, repositories: [], plugins: [], timeoutSeconds: 60 } };
      assert.equal(studioRequiredProviderToolFeature(native), needsWorkspace ? 'provider:selected-provider:templateWorkspace' : semanticPm[templateId] ? 'provider:selected-provider:pmAnalysis' : null);
    }
  });
});
