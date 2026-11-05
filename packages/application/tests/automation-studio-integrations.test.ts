import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AutomationIntegrationConfig } from '../../contracts/src/automation-integrations.ts';
import { studioIntegrationSupportsAction } from '../src/automation-studio-store.ts';

const apiOnly: AutomationIntegrationConfig = { projectId: 'PRJ-001', provider: 'github', label: 'GitHub API only', readTools: [], writeTools: [], nativeApi: { baseUrl: 'https://api.github.com', repositories: ['org/repository'], allowWrites: false } };
describe('Studio connector action suitability', () => {
  it('does not pretend API-only verification yields MCP tools for prompt or scripts', () => {
    const verified = { mcp: false, nativeApi: true };
    assert.equal(studioIntegrationSupportsAction(apiOnly, verified), true);
    assert.equal(studioIntegrationSupportsAction(apiOnly, verified, 'template'), true);
    assert.equal(studioIntegrationSupportsAction(apiOnly, verified, 'prompt'), false);
    assert.equal(studioIntegrationSupportsAction(apiOnly, verified, 'script'), false);
    assert.equal(studioIntegrationSupportsAction(apiOnly, { mcp: true, nativeApi: false }), false, 'Verification cannot invent an unconfigured mechanism');
  });
  it('checks both independent mechanisms when a GitHub connection configures both', () => {
    const both = { ...apiOnly, mcpDefinition: { contextId: 'private-project', serverId: 'github' }, readTools: ['read_repository'] };
    assert.equal(studioIntegrationSupportsAction(both, { mcp: false, nativeApi: true }, 'prompt'), false);
    assert.equal(studioIntegrationSupportsAction(both, { mcp: false, nativeApi: true }, 'template'), true);
    assert.equal(studioIntegrationSupportsAction(both, { mcp: true, nativeApi: false }, 'prompt'), true);
    assert.equal(studioIntegrationSupportsAction(both, { mcp: true, nativeApi: false }, 'template'), false);
    assert.equal(studioIntegrationSupportsAction(both, { mcp: false, nativeApi: false }), false);
  });
  it('does not impose GitHub/GitLab native API requirements on non-Git MCP dependencies', () => {
    const slack: AutomationIntegrationConfig = { projectId: 'PRJ-001', provider: 'slack', label: 'Scoped Slack', mcpDefinition: { contextId: 'private-project', serverId: 'slack' }, readTools: ['read_channel'], writeTools: [] };
    assert.equal(studioIntegrationSupportsAction(slack, { mcp: true, nativeApi: false }, 'template'), true);
    assert.equal(studioIntegrationSupportsAction(slack, { mcp: false, nativeApi: true }, 'template'), false);
  });
});
