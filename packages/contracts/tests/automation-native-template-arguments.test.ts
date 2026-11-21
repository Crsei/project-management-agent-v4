import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateNativeTemplateArguments } from '../../automation-resources/native-template-arguments.ts'

test('PM native template arguments reject unknown fields instead of treating them as authority', () => {
  assert.deepEqual(validateNativeTemplateArguments('pm-requirement-review', { taskIds: ['TASK-001'], instructions: 'Review scope' }), []);
  const issues = validateNativeTemplateArguments('pm-requirement-review', { token: 'must-not-be-a-snapshot', command: 'write' });
  assert.deepEqual(issues.map(issue => issue.path), ['action.arguments']);
});
test('PM selectors reject empty lists and unknown template ids', () => {
  assert.ok(validateNativeTemplateArguments('pm-stalled-tasks', { taskIds: [] }).some(issue => issue.path === 'action.arguments.taskIds'));
  assert.deepEqual(validateNativeTemplateArguments('unknown-template', {}).map(issue => issue.path), ['action.arguments']);
});
test('PM lookback and staleness bounds are enforced', () => {
  assert.ok(validateNativeTemplateArguments('pm-project-digest', { lookbackDays: 0 }).some(issue => issue.path === 'action.arguments.lookbackDays'));
  assert.ok(validateNativeTemplateArguments('pm-stalled-tasks', { staleDays: 366 }).some(issue => issue.path === 'action.arguments.staleDays'));
});
test('PR coverage requires a complete explicit repository scope when selected', () => {
  assert.deepEqual(validateNativeTemplateArguments('pm-pr-acceptance-coverage', { repository: { provider: 'github', repository: 'owner/repository', ref: null, pullRequestNumber: 7 } }), []);
  assert.ok(validateNativeTemplateArguments('pm-pr-acceptance-coverage', { repository: { provider: 'github', repository: '', ref: null, pullRequestNumber: 7 } }).some(issue => issue.path.includes('repository')));
});
