import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BenchEvent, FixtureHandle } from '../schemas/types.ts';
import { collectSourceManifest } from '../isolation/source.ts';
import { hashValue, makeEvent, TraceRedactor } from '../runners/telemetry.ts';
import { AdapterError } from './agent-chat.ts';

type Json = Record<string, unknown>;
export type CliCommandResult = { records: Json[]; exitCode: number | null; outcome: 'completed' | 'failed' | 'unknown'; durationMs: number };
export type CliCommandOptions = { file?: unknown; stdin?: string; timeoutMs?: number; purpose?: 'observation' | 'control'; signal?: AbortSignal };
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** Native PM_SESSION_TOKEN accepts a token, not the fixture's Cookie header. */
export function fixturePmToken(cookie: string): string {
  const match = /^pm_v4_session=([A-Za-z0-9_-]{43,512})$/.exec(cookie);
  if (!match) throw new AdapterError('infrastructure', 'The isolated fixture must provide exactly its native PM session cookie.', 'cli_identity');
  return match[1]!;
}

/** CLI print emits consecutive pretty-printed JSON objects, not NDJSON. */
export function parseCliRecords(text: string): Json[] {
  const records: Json[] = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (start === -1) {
      if (/\s/.test(character)) continue;
      if (character !== '{') throw new AdapterError('infrastructure', 'Product CLI output was not an object projection.', 'cli_protocol');
      start = index; depth = 1; continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{' || character === '[') depth++;
    else if (character === '}' || character === ']') {
      if (--depth === 0) {
        try { records.push(JSON.parse(text.slice(start, index + 1)) as Json); }
        catch { throw new AdapterError('infrastructure', 'Product CLI emitted invalid JSON.', 'cli_protocol'); }
        start = -1;
      }
    }
  }
  if (start !== -1) throw new AdapterError('infrastructure', 'Product CLI output ended mid-projection; original outcome remains unknown.', 'cli_protocol');
  return records;
}

/** Trusted host controller only; native execution isolation remains the existing fixture. */
export class ProductCliProcess {
  readonly productSource: { sourceHash: string; manifestVersion: '1'; cliSha256: string };
  readonly redactor: TraceRedactor;
  private readonly children = new Set<ChildProcess>();
  private readonly pendingRuns = new Set<Promise<void>>();
  private closed = false;
  private closing?: Promise<void>;
  private readonly runId: string;
  private readonly root: string;
  private readonly home: string;
  private readonly node: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly cliFiles: { path: string; sha256: string }[];
  private readonly emit: (event: BenchEvent) => void;
  private constructor(runId: string, root: string, home: string, node: string, environment: NodeJS.ProcessEnv,
    cliFiles: { path: string; sha256: string }[], emit: (event: BenchEvent) => void,
    source: ProductCliProcess['productSource'], redactor: TraceRedactor) {
    this.runId = runId; this.root = root; this.home = home; this.node = node; this.environment = environment;
    this.cliFiles = cliFiles; this.emit = emit; this.productSource = source; this.redactor = redactor;
  }

  static async open(runId: string, fixture: FixtureHandle, emit: (event: BenchEvent) => void): Promise<ProductCliProcess> {
    const source = fixture.productSource, runtime = fixture.runtime;
    if (!source || !runtime) throw new AdapterError('infrastructure', 'CLI control requires the same immutable product source stage used by the fixture.', 'cli_source_stage');
    const observed = await collectSourceManifest(source.root);
    if (hashValue(observed) !== hashValue(source.manifest) || source.manifest.sourceHash !== runtime.environmentEvidence.sourceHash) throw new AdapterError('infrastructure', 'CLI source stage does not match the running PM/Agent source identity.', 'cli_source_stage');
    const cliFiles = source.manifest.files.filter(entry => entry.path.startsWith('packages/pm-cli/'));
    const entry = cliFiles.find(file => file.path === 'packages/pm-cli/index.ts');
    if (!entry) throw new AdapterError('infrastructure', 'The attested product source has no native CLI entry.', 'cli_source_stage');
    const token = fixturePmToken(runtime.pmCookie);
    if (fixturePmToken(fixture.pm.token) !== token) throw new AdapterError('infrastructure', 'PM and Agent context must use the same isolated fixture identity.', 'cli_identity');
    if (!path.isAbsolute(fixture.root) || await realpath(fixture.root) !== fixture.root) throw new AdapterError('infrastructure', 'CLI private root must be canonical.', 'cli_identity');
    const info = await lstat(fixture.root);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0 || typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new AdapterError('infrastructure', 'CLI controller needs an owned private fixture directory.', 'cli_identity');
    // Native CLI credentials reject shared writable ancestors, including ambient TMPDIR.
    // This Linux-only harness uses owned /tmp storage; native checks remain unchanged.
    const home = await mkdtemp('/tmp/dovspace-bench-cli-');
    try {
      for (const directory of ['tmp', 'config', 'pm-sessions', 'agent-sessions']) await mkdir(path.join(home, directory), { mode: 0o700 });
      const node = await realpath(process.execPath);
      const environment: NodeJS.ProcessEnv = {
        HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), TMPDIR: path.join(home, 'tmp'),
        PATH: `${path.dirname(node)}:/usr/bin:/bin`, LANG: 'C.UTF-8', TZ: 'UTC',
        PM_API_URL: fixture.pm.baseUrl, PM_AGENT_URL: runtime.agentBaseUrl, PM_SESSION_TOKEN: token,
        PM_WORKSPACE_ID: fixture.workspaceId, PM_CLI_SESSION_DIR: path.join(home, 'pm-sessions'), PM_AGENT_SESSION_DIR: path.join(home, 'agent-sessions'),
      };
      const redactor = new TraceRedactor([token, runtime.pmCookie, runtime.agentAccessToken,
        ...runtime.providerConfig.environment.map(entry => entry.value),
        ...Object.entries(runtime.providerConfig.config).filter(([key]) => /secret|token|password|api.?key/i.test(key)).map(([, value]) => value)]);
      return new ProductCliProcess(runId, source.root, home, node, environment, cliFiles, emit,
        { sourceHash: source.manifest.sourceHash, manifestVersion: '1', cliSha256: entry.sha256 }, redactor);
    } catch (error) { await rm(home, { recursive: true, force: true }); throw error; }
  }

  async run(args: readonly string[], options: CliCommandOptions = {}): Promise<CliCommandResult> {
    const completion = Promise.withResolvers<void>();
    this.pendingRuns.add(completion.promise);
    try { return await this.execute(args, options); }
    finally { this.pendingRuns.delete(completion.promise); completion.resolve(); }
  }

  private async execute(args: readonly string[], options: CliCommandOptions): Promise<CliCommandResult> {
    if (this.closed) throw new AdapterError('infrastructure', 'CLI controller has been disposed.', 'cli_disposed');
    options.signal?.throwIfAborted();
    // Re-attest the executed CLI family, not a mutable checkout entry or an argv-provided script.
    for (const entry of this.cliFiles) {
      const filename = path.join(this.root, entry.path), info = await lstat(filename);
      if (await realpath(filename) !== filename || !info.isFile() || info.nlink !== 1 || (info.mode & 0o222) !== 0 || createHash('sha256').update(await readFile(filename)).digest('hex') !== entry.sha256) throw new AdapterError('infrastructure', 'Immutable product CLI bytes changed; no subprocess was dispatched.', 'cli_source_stage');
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000) throw new AdapterError('infrastructure', 'CLI subprocess requires a finite timeout.', 'cli_timeout');
    const command = args.slice(0, args[1] === 'login' || args[1] === 'status' || args[1] === 'logout' ? 2 : 3);
    if (command.some(value => !/^[a-z][a-z-]*$/.test(value))) throw new AdapterError('infrastructure', 'CLI timing labels must contain only fixed command names.', 'cli_protocol');
    let filename: string | undefined;
    try {
      if (options.file !== undefined) {
        filename = path.join(this.home, `input-${randomUUID()}.json`);
        await writeFile(filename, JSON.stringify(options.file), { mode: 0o600, flag: 'wx' });
      }
      if (this.closed) throw new AdapterError('infrastructure', 'CLI controller was disposed before dispatch.', 'cli_disposed');
      options.signal?.throwIfAborted();
      const started = performance.now();
      const child = spawn(this.node, ['--conditions=development', path.join(this.root, 'packages/pm-cli/index.ts'), ...args, ...(filename ? ['--file', filename] : [])], {
        cwd: this.home, env: this.environment, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '', bytes = 0, abnormal = false;
      this.children.add(child);
      const kill = (): void => {
        abnormal = true;
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL'); } }
        else child.kill('SIGKILL');
      };
      const timer = setTimeout(kill, timeoutMs);
      const abort = (): void => kill();
      options.signal?.addEventListener('abort', abort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (text: string) => { bytes += Buffer.byteLength(text); if (bytes > MAX_OUTPUT_BYTES) kill(); else output += text; });
      // Consume, but never retain/echo stderr: native errors can contain arbitrary private text.
      child.stderr.on('data', (text: Buffer) => { bytes += text.length; if (bytes > MAX_OUTPUT_BYTES) kill(); });
      child.stdin.on('error', () => { /* Closing a rejected private input is not evidence of acceptance. */ });
      const closed = Promise.withResolvers<{ exitCode: number | null }>();
      child.once('error', () => { abnormal = true; });
      child.once('close', (exitCode: number | null) => closed.resolve({ exitCode }));
      child.stdin.end(options.stdin ?? '');
      const result = await closed.promise.finally(() => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); this.children.delete(child); });
      const durationMs = performance.now() - started;
      let records: Json[] = [];
      try { records = parseCliRecords(output); } catch { abnormal = true; }
      const outcome = abnormal || result.exitCode === null ? 'unknown' : result.exitCode === 0 && records.length > 0 ? 'completed' : 'failed';
      this.emit(makeEvent(this.runId, 'transport', 'cli_command_interval', { command, durationMs, exitCode: result.exitCode, outcome, purpose: options.purpose ?? 'control' }));
      return { records, exitCode: result.exitCode, outcome, durationMs };
    } finally {
      if (filename) await unlink(filename).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    }
  }

  dispose(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true;
      const failures: unknown[] = [];
      for (const child of this.children) {
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failures.push(error); }
        }
      }
      await Promise.all(this.pendingRuns);
      this.environment.PM_SESSION_TOKEN = '';
      try { await rm(this.home, { recursive: true, force: true }); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'Owned CLI subprocess or private storage cleanup failed.');
    })();
  }
}
