import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { verifyAutomationEventSignature } from '../packages/application/src/automation-events-signature.ts';
import { automationEventPointer, matchesAutomationEventFilter } from '../packages/application/src/automation-events-filter.ts';
import { createAutomationPrivateStore, validateAutomationPrivateHeaders } from '../packages/infrastructure/src/automation-integrations.ts';
import { automationNativeRequestUrl, probeAutomationNativeApi } from '../packages/infrastructure/src/automation-integrations-native.ts';
import { DomainError } from '../packages/domain/src/core.ts';
import { automationIntegrationConfigSchema, automationIntegrationSupportsMcp, automationIntegrationSupportsNativeApi, type AutomationIntegrationConfig } from '../packages/contracts/src/automation-integrations.ts';
import { automationCatalogById } from '../packages/automation-resources/catalog.ts'

const rejected = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
describe('automation event authentication, isolation and source filters', () => {
  it('authenticates exact raw bytes for key and hexadecimal HMAC, never a reserialized body', () => {
    const secret = 'private-event-key-32-bytes-or-more'; const raw = Buffer.from('{ "hello": "world" }');
    const id = randomUUID();
    assert.equal(verifyAutomationEventSignature('key', secret, raw, { 'x-automation-key': secret, 'x-webhook-id': id }).externalEventId, id);
    const signature = createHmac('sha256', secret).update(raw).digest('hex');
    assert.equal(verifyAutomationEventSignature('hmac_sha256_hex', secret, raw, { 'x-hub-signature-256': 'sha256=' + signature, 'x-github-delivery': id }).externalEventId, id);
    assert.throws(() => verifyAutomationEventSignature('hmac_sha256_hex', secret, Buffer.from('{"hello":"world"}'), { 'x-webhook-signature': signature, 'x-webhook-id': id }), rejected('event_signature_invalid'));
    assert.throws(() => verifyAutomationEventSignature('key', secret, raw, { 'x-automation-key': 'wrong', 'x-webhook-id': id }), rejected('event_signature_invalid'));
  });
  it('verifies Standard Webhooks multiple signature versions and signed timestamp freshness', () => {
    const key = Buffer.alloc(32, 7); const secret = 'whsec_' + key.toString('base64'); const raw = Buffer.from('{"value":1}'); const id = randomUUID(); const timestamp = '1800000000';
    const signature = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(raw).digest('base64');
    const headers = { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v2,ignored v1,${signature}` };
    assert.equal(verifyAutomationEventSignature('standard_webhooks', secret, raw, headers, 1800000000000).externalEventId, id);
    assert.throws(() => verifyAutomationEventSignature('standard_webhooks', secret, raw, headers, 1800000301000), rejected('event_replay_rejected'));
    assert.throws(() => verifyAutomationEventSignature('standard_webhooks', secret, raw, { ...headers, 'webhook-id': randomUUID() }, 1800000000000), rejected('event_signature_invalid'));
  });
  it('verifies Slack v0 before trusting body.event_id and rejects expired delivery', () => {
    const secret = 'slack-private-signing-secret'; const timestamp = '1800000000'; const raw = Buffer.from('{"event_id":"Ev123","event":{"text":"test"}}');
    const signature = 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:`).update(raw).digest('hex');
    const headers = { 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature };
    assert.equal(verifyAutomationEventSignature('slack_v0', secret, raw, headers, 1800000000000).externalEventId, 'Ev123');
    assert.throws(() => verifyAutomationEventSignature('slack_v0', secret, raw, headers, 1800000301000), rejected('event_replay_rejected'));
  });
  it('applies pinned JMESPath contains/keys/glob/icontains without executing caller JavaScript', async () => {
    const payload = { repository: { full_name: 'OpenHands/project' }, pull_request: { draft: false, body: 'Please review this change' }, action: 'opened', nested: { 'slash/key': { value: 3 } } };
    assert.equal(await matchesAutomationEventFilter(payload, { expression: "!(pull_request.draft) && !icontains(pull_request.body, 'QA Agent') && glob(repository.full_name, 'OpenHands/*') && contains(keys(@), 'pull_request')" }), true);
    assert.equal(await matchesAutomationEventFilter(payload, { expression: "icontains(pull_request.body, 'QA Agent')" }), false);
    assert.equal(await matchesAutomationEventFilter(payload, { 'repository.full_name': 'OpenHands/project', action: 'opened' }), true);
    assert.deepEqual(automationEventPointer(payload, '/nested/slash~1key'), { value: 3 });
    assert.equal(automationEventPointer(payload, '/__proto__/polluted'), undefined);
    assert.equal(await matchesAutomationEventFilter(payload, { expression: 'process.version' }), false);
    assert.equal(await matchesAutomationEventFilter({ process: { version: 'payload-only' } }, { expression: "process.version == 'payload-only'" }), true);
    await assert.rejects(matchesAutomationEventFilter(payload, { expression: 'exit()' }), rejected('event_filter_invalid'));
  });
  it('QA template admits an eligible PR but rejects draft, already-processed and other-repository events', async () => {
    const expression = automationCatalogById.get('qa-changes')!.setup!.filter!.replace('{{form.repository}}', 'OpenHands/project');
    const payload = { repository: { full_name: 'OpenHands/project' }, pull_request: { draft: false, body: 'Please review this change' } };
    assert.equal(await matchesAutomationEventFilter(payload, { expression }), true);
    assert.equal(await matchesAutomationEventFilter({ ...payload, pull_request: { ...payload.pull_request, draft: true } }, { expression }), false);
    assert.equal(await matchesAutomationEventFilter({ ...payload, pull_request: { ...payload.pull_request, body: 'QA AGENT already reviewed' } }, { expression }), false);
    assert.equal(await matchesAutomationEventFilter({ ...payload, repository: { full_name: 'Other/project' } }, { expression }), false);
  });
  it('encrypts private inputs with actor/workspace/resource-bound authenticated data', () => {
    const store = createAutomationPrivateStore(Buffer.alloc(32, 13).toString('base64')); const headers = { authorization: 'Bearer never-echo-me' };
    const sealed = store.seal(headers, 'workspace:actor:connection');
    assert.equal(sealed.includes('never-echo-me'), false); assert.deepEqual(store.open(sealed, 'workspace:actor:connection'), headers);
    assert.throws(() => store.open(sealed, 'workspace:other:connection'), rejected('automation_private_storage_unavailable'));
    assert.throws(() => createAutomationPrivateStore('').seal(headers, 'scope'), rejected('automation_private_storage_unavailable'));
    assert.throws(() => validateAutomationPrivateHeaders({ host: 'internal' }), rejected('validation_failed'));
    assert.throws(() => validateAutomationPrivateHeaders({ Authorization: 'Bearer x\r\nInjected: yes' }), rejected('validation_failed'));
  });
  it('accepts only real GitHub/GitLab API-only configs and probes credentials without MCP discovery', async () => {
    const config = automationIntegrationConfigSchema.parse({ projectId: 'PRJ-001', provider: 'github', label: 'Native only', readTools: [], writeTools: [], nativeApi: { baseUrl: 'https://api.github.com', repositories: ['owner/approved'], allowWrites: false } });
    assert.equal(automationIntegrationSupportsMcp(config), false); assert.equal(automationIntegrationSupportsNativeApi(config), true);
    let probes = 0;
    await probeAutomationNativeApi(config, { authorization: 'Bearer controlled-test-token' }, async (_config, _headers, request) => { probes++; assert.equal(request.path, '/repos/owner/approved'); assert.equal(request.method, 'GET'); return { status: 200, body: { full_name: 'owner/approved' }, headers: {} }; });
    assert.equal(probes, 1);
    const gitlab = { ...config, provider: 'gitlab' as const, nativeApi: { baseUrl: 'https://gitlab.com', repositories: ['group/project'], allowWrites: false } };
    await probeAutomationNativeApi(gitlab, { 'private-token': 'controlled-test-token' }, async (_config, _headers, request) => { assert.equal(request.path, '/projects/group%2Fproject'); return { status: 200, body: { id: 42, path_with_namespace: 'group/project' }, headers: {} }; });
    await assert.rejects(probeAutomationNativeApi(config, { authorization: 'Bearer controlled-expired-token' }, async () => ({ status: 401, body: { error: 'rejected' }, headers: {} })), rejected('integration_authentication_failed'));
    assert.equal(automationIntegrationConfigSchema.safeParse({ ...config, provider: 'slack' }).success, false);
    assert.equal(automationIntegrationConfigSchema.safeParse({ ...config, nativeApi: undefined }).success, false);
  });
  it('binds native provider paths and writes to explicit repositories and fixed hosts', () => {
    const config: AutomationIntegrationConfig = { projectId: 'PRJ-001', provider: 'github', label: 'GitHub private', mcpDefinition: { contextId: 'private-project', serverId: 'github' }, readTools: ['get_issue'], writeTools: [], nativeApi: { baseUrl: 'https://api.github.com', repositories: ['owner/approved'], allowWrites: false } };
    const call = { provider: 'github' as const, operationId: randomUUID(), method: 'GET' as const, path: '/repos/owner/approved/issues?per_page=100' };
    assert.equal(automationNativeRequestUrl(config, call).origin, 'https://api.github.com');
    assert.throws(() => automationNativeRequestUrl(config, { ...call, path: '/repos/owner/other/issues' }), rejected('integration_repository_forbidden'));
    assert.throws(() => automationNativeRequestUrl(config, { ...call, path: '//evil.example.org/repos/owner/approved/issues' }), rejected('validation_failed'));
    assert.throws(() => automationNativeRequestUrl(config, { ...call, path: '/repos/owner/approved/issues/../pulls' }), rejected('validation_failed'));
    assert.throws(() => automationNativeRequestUrl(config, { ...call, method: 'POST' }), rejected('integration_external_write_forbidden'));
    assert.throws(() => automationNativeRequestUrl(config, { ...call, method: 'POST', path: '/graphql', body: { query: 'mutation { deleteRepository { clientMutationId } }', variables: {} } }), rejected('integration_graphql_forbidden'));
    const loadPath = '/search/issues?' + new URLSearchParams({ q: 'is:pr is:open org:owner review-requested:maintainer', per_page: '1' }).toString();
    assert.throws(() => automationNativeRequestUrl(config, { ...call, path: loadPath }), rejected('integration_owner_load_search_forbidden'));
    const ownerAuthorized = { ...config, nativeApi: { ...config.nativeApi!, allowOwnerLoadSearch: true } };
    assert.equal(automationNativeRequestUrl(ownerAuthorized, { ...call, path: loadPath }).pathname, '/search/issues');
    assert.throws(() => automationNativeRequestUrl(ownerAuthorized, { ...call, path: loadPath.replace('org%3Aowner', 'org%3Aother') }), rejected('integration_owner_load_search_forbidden'));
    assert.equal(automationNativeRequestUrl(config, { ...call, path: '/user' }).pathname, '/user');
    assert.throws(() => automationNativeRequestUrl(config, { ...call, path: '/user', method: 'POST' }), rejected('integration_identity_query_forbidden'));
    assert.equal(automationNativeRequestUrl(config, { ...call, path: '/repos/owner/approved/rules/branches/main' }).pathname, '/repos/owner/approved/rules/branches/main');
    assert.throws(() => automationNativeRequestUrl({ ...config, nativeApi: { ...config.nativeApi!, allowWrites: true } }, { ...call, path: '/repos/owner/approved/rules/branches/main', method: 'POST' }), rejected('integration_repository_forbidden'));
  });
  it('permits native label creation without granting label-definition deletion or cross-repository writes', () => {
    const config = automationIntegrationConfigSchema.parse({ projectId: 'PRJ-001', provider: 'github', label: 'Native labels', readTools: [], writeTools: [], nativeApi: { baseUrl: 'https://api.github.com', repositories: ['owner/approved'], allowWrites: false } });
    const call = { provider: 'github' as const, operationId: randomUUID(), method: 'GET' as const, path: '/repos/owner/approved/labels?per_page=100' };
    assert.equal(automationNativeRequestUrl(config, call).pathname, '/repos/owner/approved/labels');
    assert.throws(() => automationNativeRequestUrl(config, { ...call, method: 'POST' }), rejected('integration_external_write_forbidden'));
    const writable = { ...config, nativeApi: { ...config.nativeApi!, allowWrites: true } };
    assert.equal(automationNativeRequestUrl(writable, { ...call, method: 'POST', body: { name: 'ready-for-dev' } }).pathname, '/repos/owner/approved/labels');
    assert.throws(() => automationNativeRequestUrl(writable, { ...call, method: 'POST', path: '/repos/owner/other/labels' }), rejected('integration_repository_forbidden'));
    assert.throws(() => automationNativeRequestUrl(writable, { ...call, method: 'DELETE', path: '/repos/owner/approved/labels/ready-for-dev' }), rejected('integration_repository_forbidden'));
  });
});
