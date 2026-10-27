// Not part of the runnable core suite: this test drives the Lab Hono app.
// It moves into the core suite once the PM Fastify transport exposes an equivalent
// request surface. `../apps/server/index.ts` is the Lab server and must be rewritten
// to the PM transport entry point at that time.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../../../pm-core/index.ts';
import { createApp } from '../apps/server/index.ts';

const TASK = `---
schema: pm/v1
id: TASK-102
entity: work_item
kind: task
project: PRJ-001
parent: TASK-100
status: todo # important status comment
priority: high
blocked_by: [TASK-101]
custom: { retained: yes }
---

# Session management

Keep this **body** byte-for-byte.
- [x] Define schema
- [ ] Implement API

See [[ADR-001]].
`;

const DEFAULT_FILES = {
  'work-items/TASK-102.md': TASK,
  'projects/PRJ-001.md': '---\nschema: pm/v1\nid: PRJ-001\nentity: project\n---\n# Project\n',
  'work-items/TASK-100.md': '---\nschema: pm/v1\nid: TASK-100\nentity: work_item\nproject: PRJ-001\n---\n# Parent\n',
  'work-items/TASK-101.md': '---\nschema: pm/v1\nid: TASK-101\nentity: work_item\nproject: PRJ-001\n---\n# Blocker\n',
  'docs/ADR-001.md': '---\nschema: pm/v1\nid: ADR-001\nentity: document\n---\n# Architecture\n',
};

async function fixture(t: TestContext): Promise<{ root: string; workspace: Workspace }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'markdown-pm-core-'));
  for (const [name, raw] of Object.entries(DEFAULT_FILES)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), raw);
  }
  const result = { root, workspace: new Workspace(root) };
  t.after(async () => { await result.workspace.close(); await rm(root, { recursive: true, force: true }); });
  await result.workspace.init();
  return result;
}

test('HTTP writes require safe same-origin requests and expose structured conflicts', async t => {
  const { workspace } = await fixture(t);
  const { app, closeStreams } = createApp(workspace);
  t.after(closeStreams);
  const original = workspace.get('TASK-102');
  const payload = JSON.stringify({ changes: { status: 'done' }, revision: original.revision });
  const blocked = await app.request('http://localhost:4318/api/entities/TASK-102', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' }, body: payload,
  });
  assert.equal(blocked.status, 403);
  const accepted = await app.request('http://localhost:4318/api/entities/TASK-102', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:4318' }, body: payload,
  });
  assert.equal(accepted.status, 200);
  const conflict = await app.request('http://localhost:4318/api/entities/TASK-102', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: payload,
  });
  assert.equal(conflict.status, 409);
  const response = await conflict.json() as { current: { entity: { status: string } } };
  assert.equal(response.current.entity.status, 'done');
});
