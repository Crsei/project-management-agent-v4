import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateNativeTemplateArguments } from '../../automation-resources/native-template-arguments.ts'

const issue = { repositories: ['owner/repository'], triggerLabel: 'ready', branchPrefix: 'automation/issue', pullRequestMode: 'draft', githubTokenSecret: 'GITHUB_TOKEN' };
test('native template arguments reject source-server or unrecognized authority fields', () => {
  assert.deepEqual(validateNativeTemplateArguments('github-issue-to-pr', issue), []);
  const issues = validateNativeTemplateArguments('github-issue-to-pr', { ...issue, token: 'must-not-be-a-snapshot', openhands_url: 'http://localhost:8000' });
  assert.deepEqual(issues.map(issue => issue.path), ['action.arguments.token', 'action.arguments.openhands_url']);
});
test('required configured defaults are frozen instead of silently filled at execution time', () => {
  const { triggerLabel: _, ...missing } = issue;
  assert.ok(validateNativeTemplateArguments('github-issue-to-pr', missing).some(issue => issue.path === 'action.arguments.triggerLabel'));
});
test('repository selection rejects traversal and case-folded GitHub duplicates', () => {
  assert.ok(validateNativeTemplateArguments('github-issue-to-pr', { ...issue, repositories: ['owner/../other'] }).some(issue => issue.path === 'action.arguments.repositories'));
  assert.ok(validateNativeTemplateArguments('github-issue-to-pr', { ...issue, repositories: ['owner/repo', 'OWNER/REPO'] }).some(issue => issue.message.includes('twice')));
});
test('branch prefixes cannot smuggle ref syntax or command-like flags', () => {
  for (const branchPrefix of ['--upload-pack=bad', 'work/../main', 'topic@{1}', 'branch.lock']) {
    assert.ok(validateNativeTemplateArguments('github-issue-to-pr', { ...issue, branchPrefix }).some(issue => issue.path === 'action.arguments.branchPrefix'));
  }
});
test('public feed arguments reject credentials, local-file schemes and oversized feed sets', () => {
  assert.deepEqual(validateNativeTemplateArguments('news-digest', { feeds: 'https://example.org/feed.xml', topics: '' }), []);
  for (const feeds of ['file:///etc/passwd', 'https://user:secret@example.org/feed.xml', Array.from({ length: 51 }, (_, i) => `https://example.org/${i}`).join('\n')]) {
    assert.ok(validateNativeTemplateArguments('news-digest', { feeds, topics: '' }).some(issue => issue.path === 'action.arguments.feeds'));
  }
});
test('GitLab API argument is only an approved-root candidate, not an arbitrary proxy target', () => {
  const args = { projects: ['group/subgroup/project'], triggerLabel: 'ready', branchPrefix: 'automation/issue', mergeRequestMode: 'draft', gitlabApiUrl: 'https://gitlab.example.org/api/v4' };
  assert.deepEqual(validateNativeTemplateArguments('gitlab-issue-to-mr', args), []);
  assert.ok(validateNativeTemplateArguments('gitlab-issue-to-mr', { ...args, gitlabApiUrl: 'https://gitlab.example.org/api/v4?target=other' }).some(issue => issue.path === 'action.arguments.gitlabApiUrl'));
});
