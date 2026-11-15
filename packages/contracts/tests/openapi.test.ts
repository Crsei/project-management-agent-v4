import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { buildApp } from '../../../apps/server/pm/src/app.ts';
import { createRegistry } from '../../application/src/registry.ts';
import { LocalBlobStore } from '../../infrastructure/src/blobs.ts';
import { buildOpenApi, type JsonSchema, type OpenApiDocument } from '../src/openapi.ts';
import { generateContracts, schemaType } from '../../../scripts/generate-contracts.ts';
import { agentCatalogSchema } from '../src/agent-file-areas.ts';

const root = new URL('../../../', import.meta.url);
const registry = createRegistry(new LocalBlobStore('/unused-contract-test-store'));
const contract = buildOpenApi(registry);

function resolveLocalRef(document: OpenApiDocument, reference: string): JsonSchema {
  assert.ok(reference === '#' || reference.startsWith('#/'), `Not a local JSON pointer: ${reference}`);
  let target: unknown = document;
  const segments = reference === '#' ? [] : reference.slice(2).split('/');
  for (const segment of segments.map(value => value.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    assert.ok(target !== null && typeof target === 'object' && Object.hasOwn(target, segment), `Missing ${reference}`);
    target = (target as Record<string, unknown>)[segment];
  }
  assert.ok(target !== null && typeof target === 'object', `Not a schema: ${reference}`);
  return target as JsonSchema;
}

test('the live OpenAPI response and published YAML match the current contract', async t => {
  const app = buildApp();
  t.after(async () => app.close());
  const live = await app.inject({ method: 'GET', url: '/openapi.json' });
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.json(), contract);
  const yaml = parse(await readFile(new URL('docs/contracts/openapi.yaml', root), 'utf8'));
  assert.deepEqual(yaml, contract);
});

test('command oneOf branches expose strict input payloads and stable discriminators', () => {
  const schemas = contract.components.schemas;
  const names = Object.keys(registry).sort();
  assert.deepEqual(Object.keys(schemas.Command!.discriminator.mapping), names);
  assert.equal(schemas.Command!.oneOf.length, names.length);
  for (const name of names) {
    assert.equal(schemas[`${name}Payload`]!.type, 'object', name);
    assert.equal(schemas[`${name}Payload`]!.additionalProperties, false, name);
    assert.equal(schemas[`${name}Command`]!.properties.commandType.const, name);
    assert.deepEqual(schemas[`${name}Command`]!.required, ['commandId', 'commandType', 'payload']);
    assert.equal(schemas.Command!.discriminator.mapping[name], `#/components/schemas/${name}Command`);
  }
  // Input defaults stay optional; clients do not need to supply Zod output fields.
  assert.ok(!schemas.CreateWorkItemPayload!.required.includes('assigneeId'));
  assert.equal(schemas.StageUploadPayload!.properties.contentBase64.maxLength, 11184812);
  assert.throws(() => buildOpenApi({ Loose: { payload: z.object({}), handler: async () => null } }), /strict object/);
});

test('all local schema refs resolve and transport capabilities are described', () => {
  const refs = JSON.stringify(contract).matchAll(/"\$ref":"(#[^"]*)"/g);
  for (const match of refs) resolveLocalRef(contract, match[1]!);
  const stream = contract.paths['/api/v1/workspaces/{workspaceId}/events']!.get;
  assert.ok(stream.parameters.some((parameter: { name: string; in: string }) => parameter.name === 'Last-Event-ID' && parameter.in === 'header'));
  assert.ok(stream.responses[410]);
  assert.ok(contract.paths['/health/ready']!.get.responses[503].content['application/json'].schema.$ref.endsWith('/Readiness'));
  assert.deepEqual(contract.components.securitySchemes.sessionCookie, { type: 'apiKey', in: 'cookie', name: 'pm_v4_session' });
  const entity = contract.components.schemas.Entity!;
  for (const field of ['createdAt', 'updatedAt']) {
    assert.ok(entity.required.includes(field));
    assert.deepEqual(entity.properties[field].anyOf, [{ type: 'string', format: 'date-time' }, { type: 'null' }]);
  }
});

test('registration contract exposes strict public request and cookie session response', () => {
  const operation = contract.paths['/api/v1/auth/register']!.post;
  assert.deepEqual(operation.security, []);
  assert.equal(operation.requestBody.content['application/json'].schema.$ref, '#/components/schemas/RegisterRequest');
  assert.equal(operation.responses[200].content['application/json'].schema.$ref, '#/components/schemas/RegisterResponse');
  assert.ok(operation.responses[200].headers['Set-Cookie']);
  assert.ok(operation.responses[403]); assert.ok(operation.responses[409]); assert.ok(operation.responses[429]);
  const request = contract.components.schemas.RegisterRequest!;
  assert.equal(request.additionalProperties, false);
  assert.deepEqual([...request.required].sort(), ['email', 'name', 'password']);
  assert.equal(request.properties.password.writeOnly, true);
});

test('PM tool query expressions retain scoped recursive references and strict bounds', () => {
  const findViews = (schema: JsonSchema): JsonSchema | undefined => {
    if (schema.properties?.kind?.const === 'views') return schema;
    for (const branch of schema.anyOf ?? schema.oneOf ?? []) {
      const found = findViews(branch);
      if (found) return found;
    }
    return undefined;
  };
  const views = findViews(contract.components.schemas.AgentChatToolResult!);
  assert.ok(views);
  const where = views.properties.items.items.properties.where;
  assert.ok(where.$ref.startsWith('#/components/schemas/AgentChatToolResult/'));
  const expression = resolveLocalRef(contract, where.$ref);
  const all = expression.anyOf.find((branch: JsonSchema) => branch.properties?.all);
  assert.ok(all);
  assert.equal(all.additionalProperties, false);
  assert.deepEqual(all.required, ['all']);
  assert.equal(all.properties.all.maxItems, 256);
  assert.equal(resolveLocalRef(contract, all.properties.all.items.$ref), expression);
  const not = expression.anyOf.find((branch: JsonSchema) => branch.properties?.not);
  assert.ok(not);
  assert.equal(not.additionalProperties, false);
  assert.equal(resolveLocalRef(contract, not.properties.not.$ref), expression);
  const leaf = expression.anyOf.find((branch: JsonSchema) => branch.properties?.field);
  assert.ok(leaf);
  assert.equal(leaf.additionalProperties, false);
  assert.equal(leaf.properties.field.minLength, 1);
  assert.equal(leaf.properties.field.maxLength, 128);
});

test('reused recursive command schemas keep their own definitions and strict input boundaries', () => {
  type Node = { label: string; children?: Node[] | undefined };
  const node: z.ZodType<Node> = z.lazy(() => z.strictObject({
    label: z.string().min(1).max(12), children: z.array(node).max(3).optional(),
  }));
  const literal = { $ref: '#/literal-data', nested: { $ref: '#' } };
  const payload = z.strictObject({
    primary: node, secondary: node.optional(), metadata: z.unknown().default(literal),
  });
  const document = buildOpenApi({
    First: { payload, handler: async () => null },
    Second: { payload, handler: async () => null },
    Root: { payload: node, handler: async () => null },
  });
  const nodes: JsonSchema[] = [];
  for (const name of ['First', 'Second']) {
    const input = document.components.schemas[`${name}Payload`]!;
    assert.equal(input.additionalProperties, false);
    assert.deepEqual(input.required, ['primary']);
    assert.deepEqual(input.properties.metadata.default, literal);
    const reference = input.properties.primary.$ref;
    assert.ok(reference.startsWith(`#/components/schemas/${name}Payload/`));
    const definition = resolveLocalRef(document, reference);
    assert.equal(resolveLocalRef(document, input.properties.secondary.$ref), definition);
    assert.equal(definition.additionalProperties, false);
    assert.deepEqual(definition.required, ['label']);
    assert.equal(definition.properties.label.minLength, 1);
    assert.equal(definition.properties.label.maxLength, 12);
    assert.equal(definition.properties.children.maxItems, 3);
    assert.equal(resolveLocalRef(document, definition.properties.children.items.$ref), definition);
    nodes.push(definition);
  }
  assert.notEqual(nodes[0], nodes[1]);
  const root = document.components.schemas.RootPayload!;
  assert.equal(root.additionalProperties, false);
  assert.deepEqual(root.required, ['label']);
  assert.equal(resolveLocalRef(document, root.properties.children.items.$ref), root);
});

test('dashboard readers expose named DTOs without client-selected actors or loose response objects', () => {
  for (const [module, name] of Object.entries({ personal: 'PersonalDashboard', time: 'TimeDashboard', sprints: 'SprintsDashboard', portfolio: 'PortfolioDashboard', planning: 'PlanningDashboard' })) {
    const route = contract.paths[`/api/v1/workspaces/{workspaceId}/dashboard/${module}`]!.get;
    assert.equal(route.responses[200].content['application/json'].schema.$ref, `#/components/schemas/${name}`);
    assert.equal(contract.components.schemas[name]!.additionalProperties, false);
    assert.deepEqual(route.parameters.map((parameter: { name: string }) => parameter.name), ['workspaceId']);
  }
  assert.equal(contract.components.schemas.TimeWorklog!.properties.durationMs.maximum, Number.MAX_SAFE_INTEGER);
  assert.equal(contract.components.schemas.PortfolioBudgetView!.properties.data.$ref, '#/components/schemas/ProjectBudget');
  assert.equal(contract.components.schemas.ProjectBudget!.properties.budgetMinor.type, 'integer');
  assert.deepEqual(contract.components.schemas.SprintsDashboard!.properties.history.properties.semantics, { const: 'observed_snapshots' });
});

test('knowledge graph wire contract is strict, authenticated and contains no raw source or hidden counts', () => {
  const route = contract.paths['/api/v1/workspaces/{workspaceId}/core/graph']!.post;
  assert.deepEqual(route.security, [{ sessionCookie: [] }, { bearerAuth: [] }]);
  assert.deepEqual(route.parameters.map((parameter: { name: string }) => parameter.name), ['workspaceId']);
  assert.equal(route.requestBody.content['application/json'].schema.$ref, '#/components/schemas/GraphQuery');
  assert.equal(route.responses[200].content['application/json'].schema.$ref, '#/components/schemas/GraphData');
  for (const status of [400, 401, 403, 404, 422]) assert.ok(route.responses[status]);
  const query = contract.components.schemas.GraphQuery!;
  assert.equal(query.additionalProperties, false);
  assert.deepEqual(Object.keys(query.properties), ['view', 'search', 'archived', 'centerId', 'depth', 'relations']);
  assert.equal(query.properties.depth.type, 'integer');
  assert.equal(query.properties.depth.minimum, 1);
  assert.equal(query.properties.depth.maximum, 3);
  assert.equal(contract.components.schemas.GraphData!.additionalProperties, false);
  assert.deepEqual(contract.components.schemas.GraphData!.required, ['nodes', 'links', 'unresolved', 'availableRelations']);
  assert.deepEqual(Object.keys(contract.components.schemas.GraphNode!.properties), ['id', 'title', 'entity', 'status', 'archived', 'stale']);
});

test('unified PM tool API documents original-operation reconciliation, not legacy chat routes', () => {
  const paths = contract.paths;
  assert.equal(paths['/api/v1/workspaces/{workspaceId}/agent/status'], undefined);
  assert.equal(paths['/api/v1/workspaces/{workspaceId}/agent/threads'], undefined);
  for (const action of ['call', 'result']) {
    const route = paths[`/api/v1/workspaces/{workspaceId}/agent-tools/${action}`]!.post;
    assert.deepEqual(route.security, [{ sessionCookie: [] }, { bearerAuth: [] }]);
    assert.equal(route.requestBody.content['application/json'].schema.$ref, '#/components/schemas/PmToolRequest');
    assert.equal(route.responses[200].content['application/json'].schema.$ref, '#/components/schemas/PmToolCallRecord');
  }
  assert.deepEqual(contract.components.schemas.PmToolRequest!.required, ['operationId', 'name', 'arguments', 'scope', 'threadId', 'messageId', 'generationId']);
  assert.deepEqual(contract.components.schemas.PmToolCallRecord!.properties.status.enum, ['running', 'succeeded', 'failed', 'unknown']);
});

test('generation is deterministic and --check detects YAML and client type drift without writing', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pm-contracts-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  for (const file of ['packages/contracts/src/client.ts', 'docs/contracts/openapi.yaml']) {
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(new URL(file, root)));
  }
  await generateContracts(true, directory);
  const yamlPath = path.join(directory, 'docs/contracts/openapi.yaml');
  const originalYaml = await readFile(yamlPath, 'utf8');
  await writeFile(yamlPath, originalYaml + '# drift\n');
  await assert.rejects(generateContracts(true, directory), /docs\/contracts\/openapi.yaml/);
  assert.equal(await readFile(yamlPath, 'utf8'), originalYaml + '# drift\n');
  await generateContracts(false, directory);
  assert.equal(await readFile(yamlPath, 'utf8'), originalYaml);
  const clientPath = path.join(directory, 'packages/contracts/src/client.ts');
  const originalClient = await readFile(clientPath, 'utf8');
  await writeFile(clientPath, originalClient.replace('  CreateProject:', '  WrongCreateProject:'));
  await assert.rejects(generateContracts(true, directory), /packages\/contracts\/src\/client.ts/);
  await generateContracts(false, directory);
  assert.equal(await readFile(clientPath, 'utf8'), originalClient);
  await generateContracts(true, directory);
  assert.throws(() => schemaType({ type: 'unexpected' }), /Unsupported/);
});

test('Agent catalog accepts optional workspace consent eligibility without loosening its contract', () => {
  const workspace = {
    id: '11111111-1111-4111-8111-111111111111', name: 'Workspace',
    fileArea: { path: null, status: 'unavailable', revision: 0, source: null, canManage: false },
    projects: [],
  };
  for (const value of [undefined, false, true]) {
    const input = { workspaces: [{ ...workspace, ...(value === undefined ? {} : { workspaceAllowed: value }) }] };
    assert.deepEqual(agentCatalogSchema.parse(input), input);
  }
  assert.equal(agentCatalogSchema.safeParse({ workspaces: [{ ...workspace, workspaceAllowed: 'true' }] }).success, false);
  assert.equal(agentCatalogSchema.safeParse({ workspaces: [{ ...workspace, unrelatedAuthority: true }] }).success, false);
  const schema = contract.paths['/api/v1/agent-contexts']!.get.responses[200].content['application/json'].schema.properties.workspaces.items;
  assert.deepEqual(schema.properties.workspaceAllowed, { type: 'boolean' });
  assert.equal(schema.required.includes('workspaceAllowed'), false);
});
