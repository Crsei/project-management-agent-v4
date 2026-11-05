import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer, request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AppPreviewManager, allowedPreviewRequest, previewEligible, previewFiles } from './app-preview.ts';
import { appPreviewActionSchema } from '../../../../../packages/contracts/src/task-app-preview.ts';
import type { TaskCodeDelivery } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import { git } from './git.ts';

test('preview accepts explicit confirmed action, never client paths, commands or URL', () => {
  const good = { action: 'start', head: 'a'.repeat(40), confirm: true };
  assert.ok(appPreviewActionSchema.safeParse(good).success);
  for (const extra of [{ ...good, command: 'id' }, { ...good, cwd: '/root' }, { ...good, confirm: false }, { ...good, url: 'http://other' }]) assert.equal(appPreviewActionSchema.safeParse(extra).success, false);
  assert.equal(previewEligible({ step: 'pr', test: { passed: false } } as TaskCodeDelivery), false);
});
test('immutable app snapshot rejects symlinks, hidden files, traversal, submodules and absent entry', () => {
  const row = (mode: string, file: string) => `${mode} blob ${'a'.repeat(40)}\t${file}\0`;
  assert.equal(previewFiles(row('100644', 'app/server.mjs')).length, 1);
  for (const input of ['', row('120000', 'app/server.mjs'), row('100644', 'app/../server.mjs'), row('100644', 'app/.env'), row('160000', 'app/server.mjs'), row('100644', 'app/a.js')]) assert.throws(() => previewFiles(input));
});
test('preview proxy rejects cross-origin writes and rebinding', () => {
  const host = 'example.preview.localhost:4330';
  const req = { headers: { host }, method: 'GET', url: '/' };
  assert.equal(allowedPreviewRequest(req, host), true);
  assert.equal(allowedPreviewRequest({ ...req, headers: { host: '127.0.0.1:4330' } }, host), false);
  assert.equal(allowedPreviewRequest({ ...req, method: 'POST', headers: { host, origin: 'http://127.0.0.1:3224' } }, host), false);
  assert.equal(allowedPreviewRequest({ ...req, headers: { host, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } }, host), true);
});

const probe = (url: string, headers: Record<string, string> = {}) => new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((resolve, reject) => {
  const target = new URL(url); const req = request({ hostname: '127.0.0.1', port: target.port, path: target.pathname, headers: { host: target.host, ...headers }, timeout: 3000 }, res => { let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text })); });
  req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end();
});
// This opt-in actually exercises Linux namespaces; ordinary unit runs do not claim sandbox proof.
test('real Linux sandbox, credential stripping, immutable code and persisted restart', { skip: process.env.PM_PREVIEW_SANDBOX_TEST !== '1' }, async t => {
  const previousSecret = process.env.PM_PREVIEW_SMOKE_SECRET;
  process.env.PM_PREVIEW_SMOKE_SECRET = 'synthetic-host-only-value';
  t.after(() => { if (previousSecret === undefined) delete process.env.PM_PREVIEW_SMOKE_SECRET; else process.env.PM_PREVIEW_SMOKE_SECRET = previousSecret; });
  const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pm-preview-test-')));
  const previous = process.env.AGENT_WORKSPACE_DATA_DIR; process.env.AGENT_WORKSPACE_DATA_DIR = path.join(temp, 'private-agent');
  const manager = new AppPreviewManager(0);
  const sentinel = createServer((_req, res) => res.end('HOST_ONLY_SENTINEL'));
  const hostSocket = path.join(temp, 'host.sock');
  await new Promise<void>(resolve => sentinel.listen(hostSocket, resolve));
  try {
    const root = path.join(temp, 'repo'), directory = path.join(temp, 'worktree'); await mkdir(root);
    await git(root, 'init', '-b', 'main'); await git(root, 'config', 'user.name', 'Preview fixture'); await git(root, 'config', 'user.email', 'preview@example.invalid');
    await mkdir(path.join(root, 'app'));
    await writeFile(path.join(root, 'app/server.mjs'), `import http from 'node:http'; import fs from 'node:fs';
let count = Number(fs.existsSync('/data/count') ? fs.readFileSync('/data/count','utf8') : 0);
http.createServer(async (req,res)=>{if(req.url==='/health'){res.end('ok');return;} if(req.url==='/attack'){fs.unlinkSync('/runtime/app.sock');fs.symlinkSync(${JSON.stringify(hostSocket)},'/runtime/app.sock');res.end('replaced');return;} const network=await fetch('http://127.0.0.1:4325',{signal:AbortSignal.timeout(200)}).then(()=>true,()=>false); count++; fs.writeFileSync('/data/count',String(count)); let codeWritable=true; try{fs.writeFileSync('/app/escape','bad')}catch{codeWritable=false} res.setHeader('set-cookie','should-not-leave=1'); res.setHeader('content-type','application/json');res.end(JSON.stringify({network,count,cookie:req.headers.cookie??null,auth:req.headers.authorization??null,home:fs.existsSync('/root'),codeWritable,env:Object.keys(process.env)}))}).listen(process.env.PREVIEW_SOCKET);`);
    await git(root, 'add', 'app'); await git(root, 'commit', '-m', 'preview fixture'); await git(root, 'remote', 'add', 'origin', 'https://github.com/example/preview-test.git');
    const head = (await git(root, 'rev-parse', 'HEAD')).trim(); await git(root, 'worktree', 'add', '-b', 'codex/preview-test', directory, head); const stat = await lstat(directory);
    const value: TaskCodeDelivery = { id: randomUUID(), workspaceId: randomUUID(), projectId: 'PRJ-001', taskId: 'TASK-001', baseBranch: 'main', taskRevision: 'r', title: 'test', description: '', createdAt: '', updatedAt: '', version: 1, step: 'pr', threadId: 'test', head, pr: { number: 1, url: 'https://github.com/example/preview-test/pull/1' }, test: { passed: true, command: 'fixture', fingerprint: 'f', exitCode: 0, outputDigest: 'd', at: '' }, git: { root, directory, directoryIdentity: `${stat.dev}:${stat.ino}`, commonDirectory: path.join(root, '.git'), remote: 'https://github.com/example/preview-test.git', owner: 'example', repo: 'preview-test', baseBranch: 'main', baseSha: head, branch: 'codex/preview-test' } };
    await assert.rejects(manager.start(value, 'b'.repeat(40)));
    const started = await manager.start(value, head); assert.equal(started.status, 'running'); assert.ok(started.url);
    assert.equal((await manager.start(value, head)).url, started.url, 'duplicate start reuses existing process');
    const first = await probe(started.url, { cookie: 'pm_v4_session=synthetic', authorization: 'Bearer synthetic' });
    assert.equal(first.status, 200); assert.equal(first.headers['set-cookie'], undefined); assert.match(String(first.headers['content-security-policy']), /connect-src 'self'/);
    const body = JSON.parse(first.text); assert.equal(body.count, 1); assert.equal(body.network, false); assert.equal(body.cookie, null); assert.equal(body.auth, null); assert.equal(body.home, false); assert.equal(body.codeWritable, false); assert.ok(!body.env.includes('PM_API_URL'));
    assert.ok(!body.env.includes('PM_PREVIEW_SMOKE_SECRET'), 'an actual inherited host secret must not enter the sandbox');
    assert.equal((await probe(started.url, { origin: 'https://other.invalid' })).status, 403);
    await manager.stop(value.id); assert.equal(manager.state(value.id, true).status, 'stopped'); assert.equal((await probe(started.url)).status, 403);
    const restarted = await manager.start(value, head); assert.equal(JSON.parse((await probe(restarted.url!)).text).count, 2);
    assert.equal(await readFile(path.join(temp, 'private-agent/task-preview-data', value.id, 'count'), 'utf8'), '2');
    assert.equal((await probe(restarted.url! + '/attack')).status, 200);
    assert.equal((await probe(restarted.url!)).status, 502, 'app-created socket symlink cannot reach a host socket');
    assert.equal((await manager.inspect(value.id, true)).status, 'failed');
    await manager.stop(value.id); await writeFile(path.join(directory, 'changed.txt'), 'dirty'); await assert.rejects(manager.start(value, head), /不干净/);
  } finally { await manager.close(); await new Promise<void>(resolve => sentinel.close(() => resolve())); if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previous; await rm(temp, { recursive: true, force: true }); }
});
