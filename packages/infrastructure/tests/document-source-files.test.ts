import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DomainError } from '../../domain/src/core.ts';
import { assertDocumentRelativePath, DocumentSourceDirectory } from '../src/document-source-files.ts';

const code = (expected: string) => (error: unknown): boolean => error instanceof DomainError && error.code === expected;

test('directory source reads arbitrary Markdown recursively without changing source bytes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pm-document-files-'));
  try {
    mkdirSync(path.join(root, '中文 space'));
    writeFileSync(path.join(root, 'plain.md'), '# No frontmatter\n');
    writeFileSync(path.join(root, '中文 space', 'plain.MD'), 'nested text\n');
    writeFileSync(path.join(root, 'ignored.txt'), 'not Markdown');
    const directory = new DocumentSourceDirectory(root);
    try {
      const before = directory.scan();
      assert.equal(before.issues.length, 0);
      assert.deepEqual(before.entries.map(entry => entry.path), ['plain.md', '中文 space/plain.MD']);
      assert.equal(directory.content('中文 space/plain.MD', 7).content, 'nested text\n');
      assert.equal(directory.content('plain.md', 7).sourceRevision, 7);
      assert.equal(directory.scan().fingerprint, before.fingerprint);
      writeFileSync(path.join(root, '中文 space', 'plain.MD'), 'changed disk contents\n');
      assert.notEqual(directory.scan().fingerprint, before.fingerprint);
      assert.equal(directory.content('中文 space/plain.MD', 7).content, 'changed disk contents\n');
      assert.equal(readFileSync(path.join(root, 'plain.md'), 'utf8'), '# No frontmatter\n');
    } finally { directory.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('directory source rejects traversal, links, private trees and non-Markdown paths', () => {
  for (const relative of ['../secret.md', '/secret.md', 'C:\\secret.md', 'folder/../secret.md', 'folder//secret.md', '.pm/core/secret.md', '.ssh/secret.md', 'folder\\secret.md', 'note.txt'])
    assert.throws(() => assertDocumentRelativePath(relative), code('document_source_path_forbidden'));
  const root = mkdtempSync(path.join(tmpdir(), 'pm-document-links-'));
  try {
    mkdirSync(path.join(root, 'real'));
    mkdirSync(path.join(root, '.pm'));
    writeFileSync(path.join(root, 'real', 'file.md'), 'private bytes');
    writeFileSync(path.join(root, '.pm', 'hidden.md'), 'application-private bytes');
    symlinkSync('real', path.join(root, 'linked-directory'));
    symlinkSync('real/file.md', path.join(root, 'linked.md'));
    linkSync(path.join(root, 'real', 'file.md'), path.join(root, 'hard.md'));
    const directory = new DocumentSourceDirectory(root);
    try {
      const snapshot = directory.scan();
      assert.deepEqual(snapshot.entries, []);
      assert.ok(snapshot.issues.some(issue => issue.code === 'symlink_forbidden'));
      assert.ok(snapshot.issues.some(issue => issue.code === 'hardlink_forbidden'));
      assert.ok(snapshot.issues.some(issue => issue.code === 'private_path'));
      assert.throws(() => directory.content('hard.md', 1), code('document_source_path_forbidden'));
      assert.throws(() => directory.content('linked.md', 1), code('document_source_path_forbidden'));
      assert.throws(() => directory.content('linked-directory/file.md', 1));
    } finally { directory.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('directory source detects pinned directory replacement and refuses rebinding an identity', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'pm-document-identity-'));
  const root = path.join(parent, 'source');
  try {
    mkdirSync(root);
    const directory = new DocumentSourceDirectory(root), expected = directory.identity;
    try {
      renameSync(root, path.join(parent, 'old-source'));
      mkdirSync(root);
      assert.throws(() => directory.assertCurrent(), code('document_source_unavailable'));
      assert.throws(() => new DocumentSourceDirectory(root, expected), code('document_source_unavailable'));
    } finally { directory.close(); }
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

