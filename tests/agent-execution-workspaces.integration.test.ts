import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { AgentCatalog, AuthorizedAgentContext } from '../packages/contracts/src/agent-file-areas.ts';
import { createLocalProjectFixture, localProjectCaseTimeout } from './local-project-fixture.ts';

describe('retired PM code registration and directory resolver', { concurrency: 1 }, () => {
  it('exposes PM business authorization without registering code or allocating scratch', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const scope = { workspaceId: f.workspaceId, projectId: null };
    const source = join(f.parents[0], 'existing-source'); await mkdir(source);
    await writeFile(join(source, 'keep.ts'), 'export const original = true;\n');
    for (const [method, endpoint, body] of [
      ['GET', `/api/v1/agent-code-workspaces?workspaceId=${f.workspaceId}`, undefined],
      ['PUT', '/api/v1/agent-code-workspaces/retired', { scope, name: 'Retired', expectedRevision: 0, roots: [{ id: 'root', name: 'Root', directory: { mode: 'existing', path: source } }], primaryRootId: 'root' }],
      ['POST', '/api/v1/agent-contexts/resolve', scope],
    ] as const) assert.equal((await f.request(endpoint, { method, ...(body === undefined ? {} : { body }) })).status, 404);
    const catalog = await f.request<AgentCatalog>('/api/v1/agent-contexts');
    assert.equal(catalog.status, 200); assert.equal('codeWorkspaces' in catalog.body.workspaces[0]!, false);
    const authorized = await f.request<AuthorizedAgentContext>('/api/v1/agent-contexts/authorize', { method: 'POST', body: scope });
    assert.equal(authorized.status, 200); assert.deepEqual(authorized.body.scope, scope);
    assert.equal(authorized.body.actorId, f.owner.id); assert.equal('path' in authorized.body, false); assert.equal('environment' in authorized.body, false);
    assert.equal(await readFile(join(source, 'keep.ts'), 'utf8'), 'export const original = true;\n');
    await assert.rejects(lstat(join(f.root, '.pmv4')), { code: 'ENOENT' });
    const retired = (await f.pool.query("SELECT to_regclass('agent_code_workspaces') AS code, to_regclass('agent_chat_scratch') AS scratch")).rows[0];
    assert.deepEqual(retired, { code: null, scratch: null });
  });

  it('retires registration metadata without altering historical automation definitions, outcomes or receipts', { timeout: localProjectCaseTimeout }, async t => {
    const f = await createLocalProjectFixture({ signal: t.signal }); t.after(() => f.close());
    const definitionId = randomUUID(), executionId = randomUUID(), requestId = randomUUID();
    const config = { projectId: 'PRJ-001', action: { executionSelection: { version: 1, codeWorkspaceId: 'old-registration', codeWorkspaceRevision: 1, rootIds: ['root'], primaryRootId: 'root' } } };
    const receipt = { id: executionId, status: 'completed', evidence: 'Original business outcome' };
    const migration = await readFile(new URL('../packages/infrastructure/migrations/0051_retire_pm_agent_code_workspaces.sql', import.meta.url), 'utf8');
    const sql = await f.pool.connect();
    try {
      await sql.query('BEGIN');
      await sql.query('CREATE TEMP TABLE agent_code_workspaces (id text); CREATE TEMP TABLE agent_chat_scratch (path text)');
      await sql.query("INSERT INTO agent_code_workspaces VALUES ('old-registration'); INSERT INTO agent_chat_scratch VALUES ('/untouched/directory')");
      await sql.query('INSERT INTO automation_studio_definitions(id,workspace_id,actor_id,project_id,config) VALUES($1,$2,$3,$4,$5::jsonb)', [definitionId, f.workspaceId, f.owner.id, 'PRJ-001', JSON.stringify(config)]);
      await sql.query("INSERT INTO automation_studio_executions(id,workspace_id,actor_id,definition_id,project_id,definition_revision,config_snapshot,request_id,trigger,status,finished_at,summary) VALUES($1,$2,$3,$4,$5,1,$6::jsonb,$7,'manual','completed',clock_timestamp(),'Original business outcome')", [executionId, f.workspaceId, f.owner.id, definitionId, 'PRJ-001', JSON.stringify(config), requestId]);
      await sql.query('INSERT INTO automation_studio_receipts(workspace_id,actor_id,request_id,request_hash,project_ids,http_status,result) VALUES($1,$2,$3,$4,$5,200,$6::jsonb)', [f.workspaceId, f.owner.id, requestId, 'original-hash', ['PRJ-001'], JSON.stringify(receipt)]);
      await sql.query(migration);
      assert.deepEqual((await sql.query('SELECT config FROM automation_studio_definitions WHERE id=$1', [definitionId])).rows[0].config, config);
      assert.deepEqual((await sql.query('SELECT config_snapshot FROM automation_studio_executions WHERE id=$1', [executionId])).rows[0].config_snapshot, config);
      assert.deepEqual((await sql.query('SELECT result FROM automation_studio_receipts WHERE request_id=$1', [requestId])).rows[0].result, receipt);
      assert.deepEqual((await sql.query("SELECT to_regclass('agent_code_workspaces') AS code, to_regclass('agent_chat_scratch') AS scratch")).rows[0], { code: null, scratch: null });
    } finally { await sql.query('ROLLBACK'); sql.release(); }
  });
});
