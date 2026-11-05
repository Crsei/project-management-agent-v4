import { PreviewChannel, previewRelay } from './preview-channel.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppPreviewState } from '../../../../../packages/contracts/src/task-app-preview.ts';
import type { TaskCodeDelivery } from '../../../../../packages/contracts/src/task-code-delivery.ts';
import { DeliveryError } from '../../../../../packages/application/src/task-code-delivery.ts';
import { git, readTree, verifyWorktree } from './git.ts';
import { dataDirectory } from '../paths.ts';

const ttl = 30 * 60_000;
function limited(message: string): never { throw new DeliveryError('preview_unavailable', message); }
export function previewFiles(tree: string): { file: string; object: string }[] {
  const files = tree.split('\0').filter(Boolean).map(line => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(app\/[A-Za-z0-9_./-]+)$/.exec(line);
    if (!match || match[3]!.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) return limited('预览只接受 app/ 内的普通源码文件，不接受链接、隐藏文件或子模块。');
    return { file: match[3]!.slice(4), object: match[2]! };
  });
  if (!files.some(f => f.file === 'server.mjs') || files.length > 100) limited('需要 app/server.mjs 入口，最多 100 个应用文件。');
  return files;
}
export function previewEligible(v: TaskCodeDelivery): boolean {
  return !!v.git && !!v.head && !!v.pr && v.step === 'pr' && !v.pending && v.test?.passed === true;
}
export function sandboxArguments(code: string, data: string, runtime: string): string[] {
  return ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--ro-bind', '/lib', '/lib',
    ...(existsSync('/lib64') ? ['--ro-bind', '/lib64', '/lib64'] : []), '--ro-bind', process.execPath, '/node',
    // No host /proc, /etc, home, Git metadata, PM data, or credentials are mounted.
    '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', code, '/app', '--bind', data, '/data', '--tmpfs', '/runtime', '--ro-bind', path.join(runtime, 'relay.mjs'), '/relay.mjs',
    '--chdir', '/app', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'HOME', '/tmp',
    '--setenv', 'DATA_DIR', '/data', '--setenv', 'PREVIEW_SOCKET', '/runtime/app.sock',
    '/node', '--max-old-space-size=128', '/relay.mjs'];
}
export function allowedPreviewRequest(req: Pick<IncomingMessage, 'headers' | 'method' | 'url'>, host: string): boolean {
  return req.headers.host === host && (!req.headers.origin || req.headers.origin === `http://${host}`) && (req.headers['sec-fetch-site'] !== 'cross-site' || req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document')
    && ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '') && !!req.url?.startsWith('/') && !req.url.startsWith('//');
}
type Entry = { head: string; status: AppPreviewState['status']; dir: string; channel?: PreviewChannel; child?: ChildProcess; timer?: NodeJS.Timeout; expiresAt: string; message: string };
export class AppPreviewManager {
  private entries = new Map<string, Entry>();
  private busy = new Set<string>();
  private server = createServer((req, res) => { void this.proxy(req, res); });
  private listening: Promise<void> | undefined;
  private port = 0;
  private requestedPort: number;
  constructor(requestedPort = 4330) { this.requestedPort = requestedPort; this.server.requestTimeout = 10_000; this.server.headersTimeout = 10_000; this.server.maxConnections = 32; }
  private async listen() {
    this.listening ??= new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { this.listening = undefined; reject(error); };
      this.server.once('error', fail);
      this.server.listen(this.requestedPort, '127.0.0.1', () => { this.server.off('error', fail); const addr = this.server.address(); this.port = typeof addr === 'object' && addr ? addr.port : 0; resolve(); });
    });
    await this.listening;
  }
  private host(id: string) { return `${id}.preview.localhost:${this.port}`; }
  state(id: string, available: boolean): AppPreviewState {
    const e = this.entries.get(id);
    return { status: e?.status ?? 'stopped', available, head: e?.head ?? null, url: e?.status === 'running' ? `http://${this.host(id)}` : null,
      expiresAt: e?.status === 'running' ? e.expiresAt : null,
      message: e?.message ?? (available ? '可预览已提交版本；启动后 30 分钟自动停止，演示数据保留。' : '需要通过测试的 Draft PR，以及 app/server.mjs 预览入口。') };
  }
  async inspect(id: string, available: boolean): Promise<AppPreviewState> {
    const entry = this.entries.get(id);
    if (entry?.status === 'running' && (await entry.channel!.call('GET', '/health')).status !== 200 && entry.status === 'running') {
      entry.status = 'failed'; entry.message = '预览健康检查失败，进程已停止；请检查 App 后显式重启。'; clearTimeout(entry.timer); entry.child?.kill('SIGKILL');
    }
    return this.state(id, available);
  }
  async supported(v: TaskCodeDelivery): Promise<boolean> {
    if (!previewEligible(v) || process.platform !== 'linux') return false;
    try { await access('/usr/bin/bwrap'); await access('/usr/bin/prlimit'); await access(process.execPath); previewFiles(await git(v.git!.directory, 'ls-tree', '-rz', v.head!, '--', 'app/')); return true; } catch { return false; }
  }
  async start(v: TaskCodeDelivery, head: string): Promise<AppPreviewState> {
    if (this.busy.has(v.id)) limited('预览操作正在处理中，请刷新核对。');
    if (head !== v.head || !previewEligible(v)) limited('需要已测试的 Draft PR 当前提交。');
    const old = this.entries.get(v.id);
    if (old?.status === 'running' && old.head === head) return this.state(v.id, true);
    if ([...this.entries.values()].filter(e => ['running', 'starting'].includes(e.status)).length >= 3) limited('同时最多运行三个 App 预览，请先停止其他预览。');
    this.busy.add(v.id);
    let entry: Entry | undefined;
    try {
      if (!await this.supported(v)) limited('隔离预览未就绪：需要 Linux、Bubblewrap、prlimit、Node 24 和 app/server.mjs；不会回退到无隔离执行。');
      await verifyWorktree(v);
      const tree = await readTree(v);
      if (tree.head !== head || tree.files.length) limited('工作目录不干净或提交已变化，不能将旧测试绑定新内容。');
      const dir = await mkdtemp(path.join(tmpdir(), 'pm-preview-'));
      entry = { head, status: 'starting', dir, expiresAt: new Date(Date.now() + ttl).toISOString(), message: '正在启动隔离预览并检查 /health。' };
      this.entries.set(v.id, entry);
      const code = path.join(dir, 'code'), runtime = path.join(dir, 'runtime');
      const data = path.join(dataDirectory(), 'task-preview-data', v.id);
      for (const folder of [code, runtime, data]) { await mkdir(folder, { recursive: true, mode: 0o700 }); if (await realpath(folder) !== folder || !(await lstat(folder)).isDirectory()) limited('预览存储路径必须是独立普通目录。'); }
      await writeFile(path.join(runtime, 'relay.mjs'), previewRelay, { mode: 0o400 });
      let bytes = 0;
      for (const file of previewFiles(await git(v.git!.directory, 'ls-tree', '-rz', head, '--', 'app/'))) {
        const content = await git(v.git!.directory, 'cat-file', 'blob', file.object); bytes += Buffer.byteLength(content);
        if (content.includes('\uFFFD')) limited('预设预览只支持 UTF-8 文本源码，不支持二进制资源。');
        if (bytes > 4 * 1024 * 1024) limited('预览源码超过 4 MiB 限制。');
        const dest = path.join(code, file.file); await mkdir(path.dirname(dest), { recursive: true }); await writeFile(dest, content, { flag: 'wx', mode: 0o400 });
      }
      await this.listen();
      // Resource limits supplement namespaces; this is a bounded local demo, not a production Runner.
      // Start with no inherited environment; this also works on Bubblewrap versions without --clearenv.
      const child = spawn('/usr/bin/prlimit', ['--cpu=600', '--nofile=128', '--fsize=16777216', '--', '/usr/bin/bwrap', ...sandboxArguments(code, data, runtime)], { env: {}, stdio: ['pipe', 'pipe', 'ignore'] });
      entry.child = child; entry.channel = new PreviewChannel(child);
      const current = entry;
      child.once('error', () => { current.status = 'failed'; current.message = '隔离进程启动失败；未执行无隔离回退。'; });
      child.once('exit', () => { if (current.status !== 'stopped') { current.status = 'failed'; current.message = 'App 进程已退出；请检查入口、数据或资源限制。'; } clearTimeout(current.timer); void rm(dir, { recursive: true, force: true }); });
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (entry.status === 'failed') break;
        if ((await entry.channel.call('GET', '/health')).status === 200) { entry.status = 'running'; entry.message = '隔离预览运行中；仅本机演示，不代表验收通过或公网部署。'; entry.timer = setTimeout(() => { void this.stop(v.id); }, ttl); entry.timer.unref(); return this.state(v.id, true); }
        await delay(200);
      }
      limited('App 未通过 /health 检查，预览已停止；不会显示可用链接。');
    } catch (error) {
      if (entry) { entry.status = 'failed'; entry.message = error instanceof DeliveryError ? error.message : '隔离预览启动失败。'; entry.child?.kill('SIGKILL'); if (!entry.child) await rm(entry.dir, { recursive: true, force: true }); }
      throw error;
    } finally { this.busy.delete(v.id); }
  }
  async stop(id: string): Promise<void> {
    if (this.busy.has(id)) limited('预览操作尚在处理中，请稍后刷新并停止。');
    this.busy.add(id);
    try {
      const entry = this.entries.get(id); if (!entry) return;
      entry.status = 'stopped'; entry.message = '预览已停止；演示数据保留，下次启动读取相同数据。'; clearTimeout(entry.timer);
      if (entry.child?.pid && entry.child.exitCode === null && entry.child.signalCode === null) {
        const child = entry.child;
        await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); }, 1000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM'); });
      }
      await rm(entry.dir, { recursive: true, force: true });
    } finally { this.busy.delete(id); }
  }
  async close() { await Promise.all([...this.entries.keys()].map(id => this.stop(id))); this.server.closeAllConnections(); if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve())); this.listening = undefined; }
  private async proxy(req: IncomingMessage, res: ServerResponse) {
    const id = /^([a-f0-9-]{36})\.preview\.localhost:\d+$/.exec(req.headers.host ?? '')?.[1];
    const e = id ? this.entries.get(id) : undefined;
    if (!id || !e || e.status !== 'running' || !allowedPreviewRequest(req, this.host(id))) { res.writeHead(403).end('Preview unavailable'); return; }
    const chunks: Buffer[] = []; let size = 0;
    try {
      for await (const chunk of req) { size += chunk.length; if (size > 65536) { res.writeHead(413).end(); return; } chunks.push(Buffer.from(chunk)); }
      // Explicit allowlist: never forward PM cookies, Authorization, proxy headers, or Set-Cookie.
      const headers: Record<string, string> = { host: 'preview', 'content-length': String(size) };
      if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
      const response = await e.channel!.call(req.method!, req.url!, headers, Buffer.concat(chunks));
      if (response.status >= 300 && response.status < 400) { res.writeHead(502).end('Redirects disabled'); return; }
      res.writeHead(response.status, { 'content-type': response.headers['content-type'] ?? 'text/plain', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin' });
      res.end(Buffer.from(response.body, 'base64'));
    } catch { if (!res.headersSent) res.writeHead(400).end(); else res.destroy(); }
  }
}
export const appPreviews = new AppPreviewManager();
