import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBodyChanges, bodyEditorText, bodyOffsetFromEditor, editorOffsetFromBody, patchDocumentDraftRaw, splitDocumentBody } from '../apps/web/src/features/pm/markdown/document-body.ts';
import { parseMarkdown } from '../packages/pm-markdown/index.ts';
import { defaultConfiguration, type FileRecord } from '../packages/pm-schema/index.ts';

const prefix = '\uFEFF--- \r\nschema: pm/v1\r\nid: DOC-1\r\nentity: document\r\nx-unknown: &value { quoted: "keep" } # exact bytes\r\nx-copy: *value\r\n---\t\r\n';

test('body editing preserves BOM, YAML comments, aliases, delimiter spacing and authoritative H1', () => {
  const body = '\r\n# Authoritative title\r\n\r\nBody text.\r\n';
  const split = splitDocumentBody(prefix + body)!;
  assert.equal(split.prefix, prefix);
  assert.equal(split.body, body);
  const editor = bodyEditorText(body);
  const from = editor.indexOf('Body text.');
  const edited = applyBodyChanges(split.body, [{ from, to: from + 10, insert: '**New body**\nNext line.' }]);
  assert.equal(split.prefix + edited, prefix + '\r\n# Authoritative title\r\n\r\n**New body**\r\nNext line.\r\n');
});

test('multiple editor changes retain untouched mixed line endings and UTF-16 positions', () => {
  const body = '# 标题\r\n\nA😀B\r\nTail\n';
  const editor = bodyEditorText(body);
  const from = editor.indexOf('😀');
  const tail = editor.indexOf('Tail');
  const edited = applyBodyChanges(body, [{ from, to: from + 2, insert: '中文' }, { from: tail, to: tail + 4, insert: 'End' }]);
  assert.equal(edited, '# 标题\r\n\nA中文B\r\nEnd\n');
  for (let position = 0; position <= editor.length; position++) {
    assert.equal(editorOffsetFromBody(body, bodyOffsetFromEditor(body, position)), position);
  }
});

test('invalid YAML remains recoverable without parsing it; missing delimiters are never mistaken for a body', () => {
  assert.deepEqual(splitDocumentBody('---\ninvalid: [\n---\n# Repair me\n'), { prefix: '---\ninvalid: [\n---\n', body: '# Repair me\n' });
  assert.equal(splitDocumentBody('# Missing YAML\n'), null);
  assert.equal(splitDocumentBody('---\nid: DOC-1\n# Unclosed YAML\n'), null);
  assert.deepEqual(splitDocumentBody('---\nid: DOC-1\n---'), { prefix: '---\nid: DOC-1\n---', body: '' });
});

test('document properties and relations patch the latest body draft without replacing it with saved source', () => {
  const saved = prefix + '# Saved title\r\n\r\nSaved body.\r\n';
  const original: FileRecord = { id: 'DOC-1', path: 'docs/DOC-1.md', raw: saved, revision: 'saved-revision', entity: parseMarkdown(saved) };
  const latest = saved.replace('Saved title', 'Latest draft title').replace('Saved body.', 'Unsaved **body**, [[DOC-2]] and a checklist:\r\n- [ ] Keep me');
  const patched = patchDocumentDraftRaw(original, latest, { labels: ['shared-draft'], related_to: ['DOC-2'] }, defaultConfiguration);
  const entity = parseMarkdown(patched);
  assert.equal(entity.title, 'Latest draft title');
  assert.equal(entity.body, parseMarkdown(latest).body);
  assert.deepEqual(entity.labels, ['shared-draft']);
  assert.deepEqual(entity.related_to, ['DOC-2']);
  assert.ok(patched.includes('# exact bytes'));
  assert.ok(patched.includes('*value'));
  assert.deepEqual(entity['x-unknown'], original.entity['x-unknown']);
  assert.equal(original.raw, saved);
  assert.equal(original.revision, 'saved-revision');
});

test('document property title edits keep raw YAML exact and change the current authoritative H1 only', () => {
  const source = prefix + '> # Quoted example\r\n\r\n# Current title\r\n\r\nUnsaved content.\r\n';
  const original: FileRecord = { id: 'DOC-1', path: 'docs/DOC-1.md', raw: source, revision: 'saved-revision', entity: parseMarkdown(source) };
  const patched = patchDocumentDraftRaw(original, source, { title: 'Property title' }, defaultConfiguration);
  assert.equal(patched, source.replace('# Current title', '# Property title'));
  assert.equal(splitDocumentBody(patched)!.prefix, prefix);
});

test('property staging rejects invalid sources, identity edits, archived documents and lifecycle changes', () => {
  const source = prefix + '# Current title\r\n';
  const original: FileRecord = { id: 'DOC-1', path: 'docs/DOC-1.md', raw: source, revision: 'saved-revision', entity: parseMarkdown(source) };
  assert.throws(() => patchDocumentDraftRaw(original, source.replace('DOC-1', 'DOC-2'), { labels: ['no'] }, defaultConfiguration), /id/);
  assert.throws(() => patchDocumentDraftRaw(original, '---\ninvalid: [\n---\n# Repair me\n', { labels: ['no'] }, defaultConfiguration), /YAML/);
  assert.throws(() => patchDocumentDraftRaw(original, source, { id: 'DOC-2' }, defaultConfiguration), /identity/);
  assert.throws(() => patchDocumentDraftRaw(original, source, { title: '' }, defaultConfiguration), /title/);
  assert.throws(() => patchDocumentDraftRaw({ ...original, entity: { ...original.entity, archived: true } }, source, { labels: ['no'] }, defaultConfiguration), /Archived/);
  assert.throws(() => patchDocumentDraftRaw(original, source, { archived: true }, defaultConfiguration), /lifecycle/);
  assert.equal(original.raw, source);
});
