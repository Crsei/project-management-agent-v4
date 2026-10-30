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
import { buildOpenApi } from '../src/openapi.ts';
import { generateContracts, schemaType } from '../../../scripts/generate-contracts.ts';

const root = new URL('../../../', import.meta.url);
const registry = createRegistry(new LocalBlobStore('/unused-contract-test-store'));
const contract = buildOpenApi(registry);

test('the live OpenAPI response and published YAML match the current contract', async t => {
  const app = buildApp();
  t.after(async () => app.close());
  const live = await app.inject({ method: 'GET', url: '/openapi.json' });
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.json(), contract);
  const yaml = parse(await readFile(new URL('docs/contracts/openapi.yaml', root), 'utf8'));
  assert.deepEqual(yaml, contract);
});

test('command oneOf branches use exact strict Zod input payloads and stable discriminators', () => {
  const schemas = contract.components.schemas;
  const names = Object.keys(registry).sort();
  assert.deepEqual(Object.keys(schemas.Command!.discriminator.mapping), names);
  assert.equal(schemas.Command!.oneOf.length, names.length);
  for (const name of names) {
    const expected = z.toJSONSchema(registry[name]!.payload, { io: 'input', target: 'draft-2020-12' });
    delete expected.$schema;
    assert.deepEqual(schemas[`${name}Payload`], expected, name);
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
  const refs = JSON.stringify(contract).matchAll(/"\$ref":"#\/([^"]+)"/g);
  for (const match of refs) {
    let target: unknown = contract;
    for (const segment of match[1]!.split('/').map(value => value.replaceAll('~1', '/').replaceAll('~0', '~'))) {
      assert.ok(target !== null && typeof target === 'object' && Object.hasOwn(target, segment), `Missing #/${match[1]}`);
      target = (target as Record<string, unknown>)[segment];
    }
  }
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
