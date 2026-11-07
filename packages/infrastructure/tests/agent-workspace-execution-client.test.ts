import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chatOnlyExecutionSelection, type ExecutionEnvironment, type ExecutionSelection } from '../../agent-contracts/src/execution.ts';
import { DomainError } from '../../domain/src/core.ts';
import { createAgentWorkspaceExecutionClient, verifyAutomationServiceRequest } from '../src/automation-execution-client.ts';

const secret = 'isolated-agent-folder-preflight-secret-at-least-32-bytes';
const selection: ExecutionSelection = { version: 2, agentWorkspaceId: 'selected-folder', agentWorkspaceRevision: 1 };
const environment: ExecutionEnvironment = { version: 2, hostId: 'local', agentWorkspaceId: selection.agentWorkspaceId, agentWorkspaceName: 'Selected folder', agentWorkspaceRevision: 1, sourcePath: '/trusted/source', executionPath: '/trusted/source', worktree: null, frozen: false };

describe('authenticated PM-to-Agent folder preflight', () => {
  it('signs exact service-only request bytes without forwarding browser credentials or PM scope', async () => {
    let calls = 0;
    const client = createAgentWorkspaceExecutionClient({ baseUrl: 'http://127.0.0.1:4325', secret, fetch: async (input, options) => {
      calls++;
      const endpoint = new URL(String(input)), headers = new Headers(options?.headers), body = String(options?.body);
      assert.equal(endpoint.pathname, '/internal/agent-workspaces/resolve'); assert.equal(endpoint.search, '');
      assert.equal(options?.method, 'POST'); assert.equal(options?.redirect, 'error'); assert.ok(options?.signal);
      assert.deepEqual(JSON.parse(body), { executionSelection: selection });
      assert.equal(verifyAutomationServiceRequest('POST', endpoint.pathname, body, headers, secret), true);
      assert.equal(verifyAutomationServiceRequest('POST', endpoint.pathname, body + ' ', headers, secret), false);
      assert.equal(verifyAutomationServiceRequest('POST', '/internal/automation-executions/dispatch', body, headers, secret), false);
      for (const name of ['cookie', 'authorization', 'origin', 'sec-fetch-site']) assert.equal(headers.has(name), false);
      return Response.json({ path: '/trusted/source', environment });
    } });
    assert.deepEqual(await client.resolve(selection), { path: '/trusted/source', environment }); assert.equal(calls, 1);
  });
  it('rejects chat-only, obsolete selection shapes, insecure remote origins and missing service secret before transport', async () => {
    let calls = 0;
    const transport: typeof fetch = async () => { calls++; throw new Error('Transport must not be called'); };
    const client = createAgentWorkspaceExecutionClient({ baseUrl: 'http://127.0.0.1:4325', secret, fetch: transport });
    await assert.rejects(client.resolve(chatOnlyExecutionSelection()), error => error instanceof DomainError && error.code === 'agent_workspace_selection_required');
    await assert.rejects(client.resolve({ version: 1, codeWorkspaceId: 'retired', codeWorkspaceRevision: 1, rootIds: ['root'], primaryRootId: 'root' } as unknown as ExecutionSelection));
    await assert.rejects(createAgentWorkspaceExecutionClient({ baseUrl: 'http://remote.invalid', secret, fetch: transport }).resolve(selection));
    await assert.rejects(createAgentWorkspaceExecutionClient({ baseUrl: 'http://127.0.0.1:4325', secret: '', fetch: transport }).resolve(selection));
    assert.equal(calls, 0);
  });
  it('fails closed on unavailable directories, swapped execution identity and oversized responses', async () => {
    const rejected = (error: unknown) => error instanceof DomainError && error.code === 'agent_workspace_unavailable';
    const client = (response: () => Response) => createAgentWorkspaceExecutionClient({ baseUrl: 'http://127.0.0.1:4325', secret, fetch: async () => response() });
    await assert.rejects(client(() => Response.json({ code: 'directory_identity_changed' }, { status: 409 })).resolve(selection), rejected);
    for (const replacement of [
      { ...environment, agentWorkspaceId: 'other-folder' },
      { ...environment, agentWorkspaceRevision: 2 },
      { ...environment, executionPath: '/other/source' },
      { ...environment, sourcePath: '/other/source' },
      { ...environment, worktree: { deliveryId: 'unbound-delivery', branch: 'unbound-branch' } },
    ]) await assert.rejects(client(() => Response.json({ path: '/trusted/source', environment: replacement })).resolve(selection), rejected);
    await assert.rejects(client(() => new Response(' '.repeat(65537))).resolve(selection), rejected);
  });
});
