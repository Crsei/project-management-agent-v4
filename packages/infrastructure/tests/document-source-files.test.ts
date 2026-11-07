import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DomainError } from '../../domain/src/core.ts';
import { assertDocumentRelativePath, DocumentSourceDirectory, DocumentSourceOperationJournal } from '../src/document-source-files.ts';

const code = (expected: string) => (error: unknown): boolean => error instanceof DomainError && error.code === expected;
const temporaryRoot = realpathSync(tmpdir());

test('directory source reads arbitrary Markdown recursively without changing source bytes', () => {
  const root = mkdtempSync(path.join(temporaryRoot, 'pm-document-files-'));
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
  const root = mkdtempSync(path.join(temporaryRoot, 'pm-document-links-'));
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
  const parent = mkdtempSync(path.join(temporaryRoot, 'pm-document-identity-'));
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

test('external Markdown mutations create parents, CAS-save, rename, cross-root move and delete real bytes', () => {
  const parent = mkdtempSync(path.join(temporaryRoot, 'pm-document-mutations-'));
  const a = path.join(parent, 'a'), b = path.join(parent, 'b');
  mkdirSync(a); mkdirSync(b);
  const source = new DocumentSourceDirectory(a), destination = new DocumentSourceDirectory(b);
  try {
    const created = source.write('中文/new/note.MD', '# Plain Markdown\n', 3);
    assert.equal(created.canWrite, true);
    assert.ok(created.revision);
    assert.equal(created.sourceRevision, 3);
    assert.equal(readFileSync(path.join(a, created.path), 'utf8'), '# Plain Markdown\n');
    const saved = source.write(created.path, '# Edited\n', 3, created.revision);
    assert.notEqual(saved.revision, created.revision);
    assert.equal(saved.content, '# Edited\n');
    assert.throws(() => source.write(saved.path, 'stale overwrite', 3, created.revision), code('document_source_file_revision_conflict'));
    assert.equal(readFileSync(path.join(a, saved.path), 'utf8'), '# Edited\n');
    const renamed = source.move(saved.path, saved.revision, 3, source, 'renamed.md', 3);
    assert.equal(existsSync(path.join(a, saved.path)), false);
    assert.equal(renamed.content, '# Edited\n');
    assert.throws(() => source.move(renamed.path, renamed.revision, 3, source, renamed.path, 3), code('document_source_same_path'));
    const moved = source.move(renamed.path, renamed.revision, 3, destination, 'another/deep/moved.md', 9);
    assert.equal(moved.sourceRevision, 9);
    assert.equal(existsSync(path.join(a, renamed.path)), false);
    assert.equal(readFileSync(path.join(b, moved.path), 'utf8'), '# Edited\n');
    destination.remove(moved.path, moved.revision, 9);
    assert.equal(existsSync(path.join(b, moved.path)), false);
  } finally { destination.close(); source.close(); rmSync(parent, { recursive: true, force: true }); }
});

test('exclusive destination publication protects existing files and directories without deleting a move source', () => {
  const root = mkdtempSync(path.join(temporaryRoot, 'pm-document-collision-'));
  const directory = new DocumentSourceDirectory(root);
  try {
    const source = directory.write('source.md', 'source bytes', 1);
    directory.write('existing.md', 'destination bytes', 1);
    mkdirSync(path.join(root, 'directory.md'));
    for (const destination of ['existing.md', 'directory.md']) {
      assert.throws(() => directory.write(destination, 'must not overwrite', 1), code('document_source_collision'));
      assert.throws(() => directory.move(source.path, source.revision, 1, directory, destination, 1), code('document_source_collision'));
    }
    assert.equal(readFileSync(path.join(root, 'source.md'), 'utf8'), 'source bytes');
    assert.equal(readFileSync(path.join(root, 'existing.md'), 'utf8'), 'destination bytes');
    const originalRevision = source.revision;
    renameSync(path.join(root, 'source.md'), path.join(root, 'old.md'));
    writeFileSync(path.join(root, 'source.md'), 'source bytes');
    assert.throws(() => directory.remove('source.md', originalRevision, 1), code('document_source_file_revision_conflict'));
    assert.equal(readFileSync(path.join(root, 'source.md'), 'utf8'), 'source bytes');
  } finally { directory.close(); rmSync(root, { recursive: true, force: true }); }
});

test('write traversal rejects links, private components, nonwritable parents and replaced or missing roots', () => {
  const parent = mkdtempSync(path.join(temporaryRoot, 'pm-document-write-safety-'));
  const root = path.join(parent, 'source'), outside = path.join(parent, 'outside');
  mkdirSync(root); mkdirSync(outside); mkdirSync(path.join(root, 'locked'));
  writeFileSync(path.join(outside, 'secret.md'), 'outside');
  symlinkSync(outside, path.join(root, 'linked'));
  symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'leaf.md'));
  linkSync(path.join(outside, 'secret.md'), path.join(root, 'hard.md'));
  const directory = new DocumentSourceDirectory(root);
  try {
    for (const relative of ['linked/secret.md', 'leaf.md', 'hard.md', '.pm/new.md', '../outside/new.md'])
      assert.throws(() => directory.write(relative, 'forbidden', 1));
    chmodSync(path.join(root, 'locked'), 0o555);
    assert.throws(() => directory.write('locked/new.md', 'no write', 1), code('document_source_path_forbidden'));
    assert.equal(existsSync(path.join(root, 'locked', 'new.md')), false);
    assert.equal(readFileSync(path.join(outside, 'secret.md'), 'utf8'), 'outside');
    renameSync(root, path.join(parent, 'old-source'));
    assert.throws(() => directory.write('new/never.md', 'no root recreation', 1));
    assert.equal(existsSync(root), false);
    mkdirSync(root);
    assert.throws(() => directory.write('new/never.md', 'no replacement write', 1), code('document_source_unavailable'));
    assert.equal(existsSync(path.join(root, 'new')), false);
  } finally {
    directory.close(); chmodSync(path.join(parent, 'old-source', 'locked'), 0o755);
    rmSync(parent, { recursive: true, force: true });
  }
});

test('bounded UTF-8 mutations reject oversize bytes without changing a current file', () => {
  const root = mkdtempSync(path.join(temporaryRoot, 'pm-document-byte-limit-'));
  const directory = new DocumentSourceDirectory(root);
  try {
    const created = directory.write('limit.md', 'x'.repeat(4 * 1024 * 1024), 1);
    assert.equal(created.size, 4 * 1024 * 1024);
    assert.throws(() => directory.write('too-large.md', '中'.repeat(1_400_000), 1), code('document_source_file_too_large'));
    assert.throws(() => directory.write('limit.md', '中'.repeat(1_400_000), 1, created.revision), code('document_source_file_too_large'));
    assert.equal(existsSync(path.join(root, 'too-large.md')), false);
    assert.equal(directory.content('limit.md', 1).revision, created.revision);
  } finally { directory.close(); rmSync(root, { recursive: true, force: true }); }
});

test('private completion evidence survives reopening and is bound to exact operation identity and request hash', () => {
  const dataRoot = mkdtempSync(path.join(temporaryRoot, 'pm-document-proof-'));
  const workspaceId = randomUUID(), actorId = randomUUID(), operationId = randomUUID(), hash = 'a'.repeat(64);
  const receipt = { operationId, action: 'delete' as const, path: 'plain.md', status: 'succeeded' as const };
  try {
    const original = new DocumentSourceOperationJournal(dataRoot, workspaceId, actorId);
    try {
      assert.equal(original.read(operationId, hash), undefined);
      original.record(operationId, hash, receipt);
    } finally { original.close(); }
    const reopened = new DocumentSourceOperationJournal(dataRoot, workspaceId, actorId);
    try {
      assert.deepEqual(reopened.read(operationId, hash), receipt);
      assert.throws(() => reopened.read(operationId, 'b'.repeat(64)), code('document_source_operation_id_conflict'));
      assert.throws(() => reopened.record(operationId, hash, receipt));
      assert.deepEqual(reopened.read(operationId, hash), receipt);
      const linkedId = randomUUID();
      symlinkSync(path.join(dataRoot, 'document-source-operations', workspaceId, actorId, `${operationId}.json`),
        path.join(dataRoot, 'document-source-operations', workspaceId, actorId, `${linkedId}.json`));
      assert.throws(() => reopened.read(linkedId, hash));
    } finally { reopened.close(); }
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test('moves preserve external UTF-8 BOM and line endings without adding native metadata', () => {
  const root = mkdtempSync(path.join(temporaryRoot, 'pm-document-byte-preservation-'));
  const raw = Buffer.from('\uFEFF# Plain\r\nNo frontmatter\r\n');
  writeFileSync(path.join(root, 'source.md'), raw);
  const directory = new DocumentSourceDirectory(root);
  try {
    const original = directory.content('source.md', 1);
    directory.move(original.path, original.revision, 1, directory, 'nested/renamed.MD', 1);
    assert.deepEqual(readFileSync(path.join(root, 'nested', 'renamed.MD')), raw);
  } finally { directory.close(); rmSync(root, { recursive: true, force: true }); }
});

test('prepared external history retains private immutable before bytes but never substitutes for completion proof', () => {
  const dataRoot = mkdtempSync(path.join(temporaryRoot, 'pm-document-history-proof-'));
  const workspaceId = randomUUID(), actorId = randomUUID(), operationId = randomUUID(), hash = 'a'.repeat(64);
  const capture = {
    workspaceId, actorId, operationId, action: 'delete' as const,
    source: { sourceId: randomUUID(), path: 'nested/note.md', projectId: null, sourceRevision: 2, rootIdentity: '1'.repeat(64), locationKey: '2'.repeat(64) },
    before: { content: '\uFEFF# Exact original\r\nBefore deletion.\r\n', revision: '3'.repeat(64) }, observedAt: new Date().toISOString(),
  };
  try {
    const journal = new DocumentSourceOperationJournal(dataRoot, workspaceId, actorId);
    try {
      journal.prepareHistory(operationId, hash, capture);
      assert.deepEqual(journal.readHistory(operationId, hash), capture);
      assert.equal(journal.read(operationId, hash), undefined, 'Preparation alone cannot prove an applied mutation');
      assert.throws(() => journal.prepareHistory(operationId, hash, { ...capture, before: { ...capture.before, content: 'forged replacement' } }));
      assert.deepEqual(journal.readHistory(operationId, hash), capture);
    } finally { journal.close(); }
    const reopened = new DocumentSourceOperationJournal(dataRoot, workspaceId, actorId);
    try {
      assert.deepEqual(reopened.readHistory(operationId, hash), capture);
      assert.throws(() => reopened.readHistory(operationId, 'b'.repeat(64)), code('document_source_operation_id_conflict'));
      const location = path.join(dataRoot, 'document-source-operations', workspaceId, actorId, `${operationId}.history.json`);
      assert.equal(lstatSync(location).mode & 0o077, 0);
      const receipt = { operationId, action: 'delete' as const, path: capture.source.path, status: 'succeeded' as const };
      reopened.record(operationId, hash, receipt);
      assert.deepEqual(reopened.read(operationId, hash), receipt);
      assert.deepEqual(reopened.readHistory(operationId, hash), capture, 'Completion does not replace original before bytes');
    } finally { reopened.close(); }
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test('retained history path guards allow deleted paths but reject live links, hardlinks, private components and unreadable files', () => {
  const root = mkdtempSync(path.join(temporaryRoot, 'pm-document-history-path-'));
  mkdirSync(path.join(root, 'nested')); writeFileSync(path.join(root, 'nested', 'original.md'), '# Retained snapshot\n');
  symlinkSync('nested', path.join(root, 'linked'));
  const directory = new DocumentSourceDirectory(root);
  try {
    directory.assertHistoryPath('nested/original.md');
    directory.assertHistoryPath('missing/parent/deleted.md');
    rmSync(path.join(root, 'nested', 'original.md'));
    directory.assertHistoryPath('nested/original.md');
    writeFileSync(path.join(root, 'nested', 'original.md'), '# New current file\n');
    assert.throws(() => directory.assertHistoryPath('linked/original.md'));
    assert.throws(() => directory.assertHistoryPath('.pm/retained.md'), code('document_source_path_forbidden'));
    linkSync(path.join(root, 'nested', 'original.md'), path.join(root, 'hard.md'));
    assert.throws(() => directory.assertHistoryPath('hard.md'), code('document_source_path_forbidden'));
    rmSync(path.join(root, 'hard.md')); chmodSync(path.join(root, 'nested', 'original.md'), 0o000);
    assert.throws(() => directory.assertHistoryPath('nested/original.md'), code('document_source_path_forbidden'));
  } finally { directory.close(); rmSync(root, { recursive: true, force: true }); }
});
