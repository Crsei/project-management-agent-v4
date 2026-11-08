import assert from 'node:assert/strict';
import test from 'node:test';
import { novaSampleTemplate } from '../src/nova-sample-template.ts';
import { parseNovaSampleTemplate, remapNovaBody } from '../src/workspace-samples.ts';

test('built-in Nova contains all nine real entity kinds and no original identity or account fields', () => {
  const sample = parseNovaSampleTemplate(novaSampleTemplate);
  assert.equal(sample.items.length, 26);
  assert.deepEqual([...new Set(['project', ...sample.items.map(item => item.entity)])].sort(), ['project', 'work_item', 'document', 'cycle', 'milestone', 'module', 'requirement', 'release', 'goal'].sort());
  const ids = Object.fromEntries(['nova', ...sample.items.map(item => item.key)].map((key, index) => [key, `ENTITY-${index + 101}`]));
  for (const item of [sample.project, ...sample.items]) {
    for (const forbidden of ['owner', 'assignee', 'id', 'schema', 'archived', 'x-pm-created-by']) assert.equal(Object.hasOwn(item.fields ?? {}, forbidden), false);
    const body = remapNovaBody(item.body, ids);
    assert.equal(/\[\[(?:nova|tour|navigation)(?:\]|\|)/.test(body), false);
  }
  const serialized = JSON.stringify(sample);
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(serialized), false);
  assert.equal(/\b(?:PRJ|TASK|DOC|CYC|MS|MOD|REQ|REL|GOAL)-\d+/.test(serialized), false);
});

test('Nova remapping preserves prose, aliases and sections while rebinding view and API examples', () => {
  const body = 'Nova design stays prose. [[nova|Portal]] [[design#Goals|Design]]\n```pm-view\nproject: nova\nlayout: table\n```\n{"project":"nova","id":"design"}';
  assert.equal(remapNovaBody(body, { nova: 'PRJ-007', design: 'DOC-014' }), 'Nova design stays prose. [[PRJ-007|Portal]] [[DOC-014#Goals|Design]]\n```pm-view\nproject: PRJ-007\nlayout: table\n```\n{"project":"PRJ-007","id":"DOC-014"}');
  assert.throws(() => remapNovaBody('[[unknown]]', { nova: 'PRJ-001' }), /unknown document link/);
});

test('template validation rejects duplicate keys, unknown relationships and account/protected metadata', () => {
  for (const field of ['owner', 'assignee', 'x-pm-created-by', 'id', 'schema', 'archived']) {
    assert.throws(() => parseNovaSampleTemplate({ ...novaSampleTemplate, project: { ...novaSampleTemplate.project, fields: { ...novaSampleTemplate.project.fields, [field]: 'foreign' } } }), /Unsupported Nova sample field/);
  }
  assert.throws(() => parseNovaSampleTemplate({ ...novaSampleTemplate, items: [...novaSampleTemplate.items, novaSampleTemplate.items[0]] }), /Duplicate/);
  assert.throws(() => parseNovaSampleTemplate({ ...novaSampleTemplate, project: { ...novaSampleTemplate.project, fields: { related_to: ['outside-sample'] } } }), /Unknown Nova sample relation/);
});
