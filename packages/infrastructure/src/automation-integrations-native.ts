import * as https from 'node:https';
import type { AutomationIntegrationConfig, AutomationProviderRequest, AutomationProviderResult } from '../../contracts/src/automation-integrations.ts';
import { DomainError } from '../../domain/src/core.ts';
import { validateAutomationMcpEndpoint } from './automation-integrations.ts';
import { resolveWebhookAddresses } from './webhook-transport.ts';

// Pinned production GraphQL shapes only; arbitrary queries, aliases, extra repository selections and mutations are rejected.
const staleCiQuery = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 40, after: $cursor, states: OPEN) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number isDraft baseRefName headRefOid author { login }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
          totalCount nodes {
            __typename
            ... on CheckRun { databaseId name status conclusion startedAt completedAt checkSuite { app { databaseId } } }
            ... on StatusContext { context state createdAt }
          }
        } } } } }
      }
    }
  }
}`.replace(/\s+/g, '');
// github-pr-reviewer/github_client.py:252-275 (MIT, pinned vendor provenance).
const requiredChecksQuery = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){pullRequest(number:$number){
    commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){
      pageInfo{hasNextPage}
      nodes{__typename ... on CheckRun{name isRequired(pullRequestNumber:$number)}
        ... on StatusContext{context isRequired(pullRequestNumber:$number)}}
    }}}}}
  }}
}`.replace(/\s+/g, '');
export function automationNativeRequestIsWrite(input: AutomationProviderRequest): boolean {
  return input.method !== 'GET' && !(input.provider === 'github' && input.method === 'POST' && input.path === '/graphql');
}
export function validateAutomationNativeApi(config: AutomationIntegrationConfig): void {
  if (!config.nativeApi) return;
  if (config.nativeApi.repositories.length < 1 || config.nativeApi.repositories.length > 100) throw new DomainError('validation_failed', 'Native API verification requires one to one hundred explicit repository/project targets');
  if (!['github', 'gitlab'].includes(config.provider)) throw new DomainError('validation_failed', 'Native REST configuration is supported only for GitHub and GitLab');
  const base = new URL(validateAutomationMcpEndpoint(config.nativeApi.baseUrl));
  if (base.pathname !== '/' || config.provider === 'github' && base.origin !== 'https://api.github.com') throw new DomainError('validation_failed', 'Native API requires a clean explicitly approved HTTPS origin; GitHub uses only https://api.github.com');
  if (new Set(config.nativeApi.repositories.map(value => value.toLowerCase())).size !== config.nativeApi.repositories.length || config.nativeApi.repositories.some(value => !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(value) || value.split('/').some(part => part === '.' || part === '..'))) throw new DomainError('validation_failed', 'Native API repositories must be unique repository/project identifiers, not URLs or paths');
  if (config.provider === 'github' && config.nativeApi.repositories.some(value => value.split('/').length !== 2)) throw new DomainError('validation_failed', 'GitHub targets must use owner/repository identifiers');
}
export function automationNativeRequestUrl(config: AutomationIntegrationConfig, input: AutomationProviderRequest): URL {
  validateAutomationNativeApi(config);
  if (!config.nativeApi || config.provider !== input.provider) throw new DomainError('integration_native_api_unconfigured', 'Configure a native API origin, explicit repository/project targets and write policy on the selected connection', 409);
  const path = input.provider === 'gitlab' && !input.path.startsWith('/api/v4/') ? '/api/v4' + input.path : input.path;
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u0020\u007f#]/.test(path) || /%(?:2e|25|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(path) || /(?:^|\/)\.{1,2}(?:\/|[?]|$)/.test(path)) throw new DomainError('validation_failed', 'Provider API paths must be bounded relative paths without traversal or alternate origins');
  const url = new URL(path, config.nativeApi.baseUrl);
  if (url.origin !== new URL(config.nativeApi.baseUrl).origin || url.pathname.split('/').some(part => part === '.' || part === '..')) throw new DomainError('validation_failed', 'Provider API path escapes its fixed origin');
  const configured = config.nativeApi.repositories.map(value => value.toLowerCase());
  if (input.provider === 'github' && url.pathname === '/user') {
    if (input.method !== 'GET' || url.search || input.body !== undefined) throw new DomainError('integration_identity_query_forbidden', 'Only the exact read-only authenticated GitHub identity lookup is allowed', 403);
    return url;
  }
  if (input.provider === 'github' && url.pathname === '/search/issues') {
    const query = url.searchParams.get('q') ?? '';
    const match = /^is:pr\s+is:open\s+(?:org|user):([a-zA-Z0-9][a-zA-Z0-9-]{0,38})\s+review-requested:([a-zA-Z0-9][a-zA-Z0-9-]{0,38})$/.exec(query);
    const parameters = [...url.searchParams.keys()];
    if (input.method !== 'GET' || config.nativeApi.allowOwnerLoadSearch !== true || !match || !configured.some(repository => repository.split('/')[0] === match[1]!.toLowerCase()) || new Set(parameters).size !== parameters.length || url.searchParams.get('per_page') !== '1' || url.searchParams.has('page') && url.searchParams.get('page') !== '1' || parameters.some(key => !['q', 'per_page', 'page'].includes(key))) throw new DomainError('integration_owner_load_search_forbidden', 'Owner-wide maintainer load counts require explicit nativeApi.allowOwnerLoadSearch and the exact approved owner-scoped read-only query', 403);
    return url;
  }
  if (input.provider === 'github' && input.path === '/graphql') {
    const variables = input.body?.variables;
    const query = typeof input.body?.query === 'string' ? input.body.query.replace(/\s+/g, '') : '';
    if (input.method !== 'POST' || ![staleCiQuery, requiredChecksQuery].includes(query) || !variables || typeof variables !== 'object' || Array.isArray(variables)) throw new DomainError('integration_graphql_forbidden', 'Only pinned read-only stale-CI and required-check GraphQL queries are authorized', 403);
    const values = variables as Record<string, unknown>;
    const allowedKeys = query === staleCiQuery ? ['owner', 'name', 'cursor'] : ['owner', 'name', 'number'];
    if (typeof values.owner !== 'string' || typeof values.name !== 'string' || !configured.includes(`${values.owner}/${values.name}`.toLowerCase()) || Object.keys(values).some(key => !allowedKeys.includes(key)) || Object.keys(input.body!).some(key => !['query', 'variables'].includes(key))) throw new DomainError('integration_repository_forbidden', 'GraphQL variables must identify exactly one approved repository', 403);
    if (query === staleCiQuery ? values.cursor !== null && (typeof values.cursor !== 'string' || values.cursor.length > 1024) : typeof values.number !== 'number' || !Number.isSafeInteger(values.number) || values.number < 1) throw new DomainError('integration_graphql_forbidden', 'GraphQL pagination/PR variables do not match the pinned query', 403);
  } else if (input.provider === 'github') {
    const match = /^\/repos\/([^/]+)\/([^/]+)(?:\/(?:pulls|issues|actions|commits|compare|branches|git|contents|collaborators|check-runs|releases|rules|labels)(?:\/.*)?)?$/.exec(url.pathname);
    if (!match || !configured.includes(`${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`.toLowerCase())) throw new DomainError('integration_repository_forbidden', 'GitHub API path must remain inside an explicitly approved repository and workflow resource', 403);
    if (/^\/repos\/[^/]+\/[^/]+\/rules(?:\/|$)/.test(url.pathname) && (input.method !== 'GET' || !/^\/repos\/[^/]+\/[^/]+\/rules\/branches\/.+$/.test(url.pathname))) throw new DomainError('integration_repository_forbidden', 'Only read-only branch rule metadata is allowed for this resource', 403);
    if (/^\/repos\/[^/]+\/[^/]+\/labels(?:\/|$)/.test(url.pathname) && (!['GET', 'POST'].includes(input.method) || !/^\/repos\/[^/]+\/[^/]+\/labels$/.test(url.pathname))) throw new DomainError('integration_repository_forbidden', 'Native workflows may list or create repository labels, not rewrite or delete their definitions', 403);
  } else {
    const match = /^\/api\/v4\/projects\/([^/]+)(?:\/(?:issues|merge_requests|pipelines|jobs|repository|labels|milestones|hooks)(?:\/.*)?)?$/.exec(url.pathname);
    if (!match || !configured.includes(decodeURIComponent(match[1]!).toLowerCase())) throw new DomainError('integration_repository_forbidden', 'GitLab API path must remain inside an explicitly approved project and workflow resource', 403);
  }
  if (automationNativeRequestIsWrite(input) && !config.nativeApi.allowWrites) throw new DomainError('integration_external_write_forbidden', 'This private connection does not explicitly authorize native API writes', 403);
  return url;
}
export type AutomationNativeProviderAdapter = (config: AutomationIntegrationConfig, privateHeaders: Record<string, string>, input: AutomationProviderRequest) => Promise<AutomationProviderResult>;
/** One bounded authenticated call to a fixed approved origin. No redirect, proxy, retry, token response or ambient credentials. */
export const automationNativeProviderAdapter: AutomationNativeProviderAdapter = async (config, privateHeaders, input) => {
  const url = automationNativeRequestUrl(config, input); const pinned = (await resolveWebhookAddresses(url.hostname))[0]!;
  const authorization = privateHeaders.authorization; const privateToken = privateHeaders['private-token'];
  if (input.provider === 'github' ? !authorization : !authorization && !privateToken) throw new DomainError('integration_authentication_required', 'The selected private connection needs Authorization for GitHub, or Authorization/PRIVATE-TOKEN for GitLab', 409);
  const body = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body));
  if (body && body.length > 1048576) throw new DomainError('integration_input_too_large', 'Provider API request exceeds one MiB');
  const { promise, resolve, reject } = Promise.withResolvers<AutomationProviderResult>();
  const fail = () => reject(new DomainError('integration_outcome_unknown', 'Provider API transport did not confirm the original operation; do not redispatch the original write', 502));
  const request = https.request(url, { method: input.method, agent: false, family: pinned.family, maxHeaderSize: 16384, lookup: (_host, _options, done) => done(null, pinned.address, pinned.family), servername: url.hostname, timeout: 15000,
    headers: { ...(authorization ? { authorization } : {}), ...(input.provider === 'gitlab' && privateToken ? { 'private-token': privateToken } : {}), 'user-agent': 'pm-automation-native/1', accept: 'application/json', 'accept-encoding': 'identity', ...(input.provider === 'github' ? { 'x-github-api-version': '2022-11-28' } : {}), ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}) } }, response => {
    if (!response.statusCode || response.statusCode >= 300 && response.statusCode < 400 || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); fail(); return; }
    const chunks: Buffer[] = []; let size = 0;
    response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4194304) { response.destroy(); fail(); } else chunks.push(chunk); });
    response.once('error', fail); response.once('aborted', fail);
    response.once('end', () => {
      try {
        const text = Buffer.concat(chunks, size).toString('utf8');
        const headers: AutomationProviderResult['headers'] = {};
        if (typeof response.headers.link === 'string') headers.link = response.headers.link;
        let value: unknown = response.statusCode! >= 400 ? { error: 'provider_request_rejected' } : text ? JSON.parse(text) as unknown : null;
        if (response.statusCode! < 400 && input.provider === 'github' && url.pathname === '/search/issues') {
          if (!value || typeof value !== 'object' || !('total_count' in value) || typeof value.total_count !== 'number' || !Number.isSafeInteger(value.total_count) || value.total_count < 0) { fail(); return; }
          value = { total_count: value.total_count, incomplete_results: 'incomplete_results' in value && value.incomplete_results === true };
        }
        if (response.statusCode! < 400 && input.provider === 'github' && url.pathname === '/user') {
          if (!value || typeof value !== 'object' || !('login' in value) || typeof value.login !== 'string' || !value.login || value.login.length > 100) { fail(); return; }
          value = { login: value.login, ...('type' in value && typeof value.type === 'string' ? { type: value.type.slice(0, 50) } : {}) };
        }
        if (typeof response.headers['x-next-page'] === 'string') headers['x-next-page'] = response.headers['x-next-page'];
        // Do not echo a rejected provider response: it may contain authentication material.
        resolve({ status: response.statusCode!, body: value, headers });
      } catch { fail(); }
    });
  });
  request.once('timeout', () => request.destroy()); request.once('error', fail); request.end(body);
  const timer = setTimeout(() => { request.destroy(); fail(); }, 20000); request.once('close', () => clearTimeout(timer));
  return promise;
};

/** Verifies actual authenticated repository/project metadata, without requiring or contacting an MCP server. */
export async function probeAutomationNativeApi(config: AutomationIntegrationConfig, headers: Record<string, string>, adapter: AutomationNativeProviderAdapter = automationNativeProviderAdapter): Promise<void> {
  validateAutomationNativeApi(config);
  if (!config.nativeApi || (config.provider !== 'github' && config.provider !== 'gitlab')) throw new DomainError('integration_native_api_unconfigured', 'Native API verification requires a configured GitHub/GitLab connection', 409);
  if (config.provider === 'github' ? !headers.authorization : !headers.authorization && !headers['private-token']) throw new DomainError('integration_authentication_required', 'Supply the explicit private provider authentication header before verification', 409);
  const provider = config.provider;
  const repositories = config.nativeApi.repositories;
  let next = 0; let stopped = false; const deadline = Date.now() + 60000;
  const results = await Promise.allSettled(Array.from({ length: Math.min(4, repositories.length) }, async () => {
    while (!stopped && next < repositories.length) {
      try {
        if (Date.now() > deadline) throw new DomainError('integration_verification_timeout', 'Native API metadata verification exceeded its deadline', 502);
        const repository = repositories[next++]!;
        const path = provider === 'github' ? '/repos/' + repository.split('/').map(encodeURIComponent).join('/') : '/projects/' + encodeURIComponent(repository);
        const response = await adapter(config, headers, { provider, operationId: '00000000-0000-4000-8000-000000000000', method: 'GET', path });
        if (response.status < 200 || response.status >= 300) throw new DomainError(response.status === 401 || response.status === 403 ? 'integration_authentication_failed' : 'integration_repository_unavailable', 'Native API credentials or an explicitly approved repository/project could not be verified', 409);
        const body = response.body;
        const matches = body && typeof body === 'object' && (provider === 'github' ? 'full_name' in body && typeof body.full_name === 'string' && body.full_name.toLowerCase() === repository.toLowerCase() : 'path_with_namespace' in body && typeof body.path_with_namespace === 'string' && body.path_with_namespace.toLowerCase() === repository.toLowerCase() || 'id' in body && String(body.id) === repository);
        if (!matches) throw new DomainError('integration_repository_identity_mismatch', 'Provider metadata did not identify the explicitly approved repository/project', 409);
      } catch (error) { stopped = true; throw error; }
    }
  }));
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}
