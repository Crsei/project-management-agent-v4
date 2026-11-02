import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ideaBoardScenario, scenarioFitsDraft } from '../apps/web/src/features/pm/markdown/app-scenarios.ts';
test('scene is requirements, includes executable acceptance and bounded preview contract', () => {
  for (const term of ['PREVIEW_SOCKET', 'DATA_DIR', 'app/server.mjs', 'npm test', '重启', 'CI test', '不得读取凭据']) assert.ok(ideaBoardScenario.body.includes(term));
  assert.ok(!ideaBoardScenario.body.includes('<script>'));
});
test('scene only fills untouched task content; never replaces authored or frozen drafts', () => {
  const blank = { kind: 'work_item', values: { project: 'PRJ-001', status: 'todo' }, body: '' };
  assert.equal(scenarioFitsDraft(blank), true);
  for (const draft of [{ ...blank, kind: 'project' }, { ...blank, body: 'my draft' }, { ...blank, values: { title: 'mine' } }, { ...blank, attempt: { phase: 'unknown' } }]) assert.equal(scenarioFitsDraft(draft), false);
});
