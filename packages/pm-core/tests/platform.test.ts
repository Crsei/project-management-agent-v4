import assert from 'node:assert/strict';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FileRepository, RepositoryConflict, revisionOf } from '../repository.ts';
import { directoryIdentity, pathContains, safePathComponent, safeRelativePath, samePath } from '../platform.ts';
import { assertPrivatePath, makePrivatePath } from '../private-path.ts';
import { assertNoWindowsReparsePath, cacheWindowsPathAttributes } from '../windows-reparse.ts';

test('native protection boundaries handle volume roots, case and separator aliases', () => {
  assert.equal(pathContains('C:\\', 'c:/Users/owner/projects', 'win32'), true);
  assert.equal(pathContains('C:\\Projects', 'c:/projects/child', 'win32'), true);
  assert.equal(pathContains('C:\\Projects', 'C:\\Projects-other', 'win32'), false);
  assert.equal(pathContains('C:\\Projects', 'D:\\Projects', 'win32'), false);
  assert.equal(samePath('/Users/Owner/Café', '/users/owner/Cafe\u0301', 'darwin'), true);
  assert.equal(samePath('/Workspace', '/workspace', 'linux'), false);
  assert.equal(pathContains('/', '/home/project', 'linux'), true);
});

test('Win32 relative paths refuse devices, alternate streams and normalized aliases', () => {
  for (const component of ['CON', 'con.md', 'AUX.md', 'NUL', 'COM1.txt', 'LPT9.md', 'COM¹.md', 'name.', 'name ', 'file:stream', 'a<b', 'a\u0001'])
    assert.equal(safePathComponent(component, 'win32'), false, component);
  for (const relative of ['C:note.md', 'C:/note.md', 'C:\\note.md', '/note.md', '../note.md', 'nested//note.md', 'nested\\note.md', 'nested/CON.md'])
    assert.equal(safeRelativePath(relative, 'win32'), false, relative);
  assert.equal(safeRelativePath('中文 space/Note.MD', 'win32'), true);
  assert.equal(safeRelativePath('file:stream.md', 'linux'), true);
});

test('repository performs native exclusive creation, revision replacement and deletion', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pm-native-repository-')));
  try {
    const repository = new FileRepository(root, false); repository.init(); repository.mkdir('nested/deep');
    repository.write('nested/deep/note.md', 'first');
    assert.throws(() => repository.write('nested/deep/note.md', 'collision'), RepositoryConflict);
    repository.write('nested/deep/note.md', 'second', revisionOf('first'));
    assert.equal(repository.read('nested/deep/note.md'), 'second');
    assert.throws(() => repository.remove('nested/deep/note.md', revisionOf('first')), RepositoryConflict);
    repository.remove('nested/deep/note.md', revisionOf('second'));
    assert.throws(() => repository.read('nested/deep/note.md'), { code: 'ENOENT' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native guards reject replaced roots, directory junctions and hardlinked files', () => {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), 'pm-native-identity-')));
  try {
    const root = path.join(parent, 'root'), outside = path.join(parent, 'outside'); mkdirSync(root); mkdirSync(outside);
    writeFileSync(path.join(outside, 'external.md'), 'outside');
    symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const repository = new FileRepository(root, false);
    assert.throws(() => repository.read('linked/external.md'));
    assert.throws(() => directoryIdentity(path.join(root, 'linked')));
    linkSync(path.join(outside, 'external.md'), path.join(root, 'hard.md'));
    assert.throws(() => repository.read('hard.md'));
    renameSync(root, path.join(parent, 'old')); mkdirSync(root);
    assert.throws(() => repository.mkdir('must-not-create'), /replaced/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('private application paths enforce native permissions before accepting state', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pm-native-private-')));
  try {
    makePrivatePath(root); assertPrivatePath(root);
    const filename = path.join(root, 'state.json'); writeFileSync(filename, '{}', { mode: 0o600 });
    makePrivatePath(filename); assertPrivatePath(filename);
    const duplicate = path.join(root, 'duplicate.json'); linkSync(filename, duplicate);
    assert.throws(() => assertPrivatePath(filename), /Unsafe/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Register this native-only case on Windows; the backend runner rejects skipped cases.
if (process.platform === 'win32') test('Windows native attribute batches refuse reparse points and invalidate replaced path identities', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pm-native-reparse-')));
  try {
    const directory = path.join(root, 'directory'), linked = path.join(root, 'linked');
    mkdirSync(directory); symlinkSync(directory, linked, 'junction');
    cacheWindowsPathAttributes([directory, linked]);
    assertNoWindowsReparsePath(directory, lstatSync(directory, { bigint: true }));
    assert.throws(() => assertNoWindowsReparsePath(linked, lstatSync(linked, { bigint: true })), /reparse/);
    const old = path.join(root, 'old'); renameSync(directory, old); symlinkSync(old, directory, 'junction');
    assert.throws(() => assertNoWindowsReparsePath(directory, lstatSync(directory, { bigint: true })), /reparse/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

if (process.platform === 'win32') test('Windows directory membership changes preserve identity, but replacement and changed file snapshots fail', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pm-native-directory-change-')));
  try {
    const directory = path.join(root, 'directory'); mkdirSync(directory);
    const before = lstatSync(directory, { bigint: true });
    const child = path.join(directory, 'child.md'); writeFileSync(child, 'original');
    assertNoWindowsReparsePath(directory, before);
    const fileBefore = lstatSync(child, { bigint: true });
    writeFileSync(child, 'changed content');
    assert.throws(() => assertNoWindowsReparsePath(child, fileBefore), /changed/);
    renameSync(directory, path.join(root, 'old')); mkdirSync(directory);
    assert.throws(() => assertNoWindowsReparsePath(directory, before), /changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
