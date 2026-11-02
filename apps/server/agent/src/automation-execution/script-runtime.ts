import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { StudioConfig } from '../../../../../packages/contracts/src/automation-studio.ts';
import { dataDirectory } from '../paths.ts';

type ScriptAction = Extract<StudioConfig['action'], { kind: 'script' }>;
export type IsolationSnapshot = { executable: string; image: string; directory: string; container: string; fingerprint: string };
export type ContainerObservation = { state: 'created' | 'running' | 'exited' | 'missing' | 'unknown'; exitCode: number | null; startedAt: string | null; finishedAt: string | null; logs: { id: string; at: string; message: string; stream: 'stdout' | 'stderr' }[]; error: string | null; outputGuardFailed?: boolean };
const maxSourceBytes = 2 * 1024 * 1024;
export function safeScriptPath(value: string): boolean {
  return value.length > 0 && value.length <= 500 && !value.includes('\\') && !/[\x00-\x1f\x7f]/.test(value) && !path.posix.isAbsolute(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..') && !/^[a-z]:/i.test(value);
}
export function validateScriptAction(action: ScriptAction): void {
  if (!safeScriptPath(action.entrypoint) || !action.entrypoint.endsWith('.py')) throw new Error('Script entrypoint must be a relative .py file without traversal.');
  const paths = new Set<string>();
  let size = Buffer.byteLength(action.content) + Buffer.byteLength(action.setup);
  if (action.files.length > 200) throw new Error('Script bundle exceeds 200 files.');
  for (const file of action.files) {
    if (!safeScriptPath(file.path) || paths.has(file.path)) throw new Error('Script bundle contains an unsafe or duplicate file path.');
    paths.add(file.path); size += Buffer.byteLength(file.content);
  }
  for (const file of paths) for (const other of paths) if (other.startsWith(`${file}/`)) throw new Error('A script bundle file cannot also be a directory.');
  if (size > maxSourceBytes) throw new Error('Script bundle exceeds the 2 MiB expanded source limit.');
  if (action.content && paths.has(action.entrypoint)) throw new Error('Script content and bundle entrypoint cannot both define the same file.');
  if (!action.content && !paths.has(action.entrypoint)) throw new Error('Frozen script files do not contain the entrypoint; bundleRef is provenance, never a host path.');
}
export async function isolationAvailability(): Promise<{ available: boolean; reason: string | null }> {
  try { await inspectIsolation(); return { available: true, reason: null }; }
  catch (error) { return { available: false, reason: error instanceof Error ? error.message : 'Isolated runtime is not configured.' }; }
}
async function configuredIsolation(): Promise<{ executable: string; image: string }> {
  const executable = process.env.PM_AUTOMATION_CONTAINER_RUNTIME?.trim();
  const image = process.env.PM_AUTOMATION_PYTHON_IMAGE?.trim();
  if (!executable || !path.isAbsolute(executable)) throw new Error('Set PM_AUTOMATION_CONTAINER_RUNTIME to an absolute Docker/Podman executable; host Python/shell fallback is forbidden.');
  const resolved = await realpath(executable), info = await stat(resolved);
  if (!info.isFile() || !['docker', 'podman'].includes(path.basename(resolved))) throw new Error('The isolated runtime must be a Docker or Podman executable.');
  await access(resolved, constants.X_OK);
  if (!image || !/^(?:[a-zA-Z0-9._/:+-]+@)?sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Set PM_AUTOMATION_PYTHON_IMAGE to a preloaded immutable image ID or image@sha256 digest containing Python 3 and /bin/sh. Images are never pulled automatically.');
  return { executable: resolved, image };
}
async function inspectIsolation(): Promise<{ executable: string; image: string }> {
  const configured = await configuredIsolation();
  const directory = path.join(dataDirectory(), 'automation-container-client');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const snapshot = { ...configured, directory };
  const engine = await command(snapshot, ['info', '--format={{json .ServerVersion}}'], 16 * 1024);
  if (engine.code !== 0 || !engine.stdout.trim()) throw new Error('The configured container engine is not reachable; isolated Python is unavailable.');
  const image = await command(snapshot, ['image', 'inspect', '--format={{json .}}', configured.image], 128 * 1024);
  if (image.code !== 0) throw new Error('The pinned Python image is not preloaded in the configured container engine; no pull was attempted.');
  const metadata = JSON.parse(image.stdout) as { Id?: string; RepoDigests?: string[]; Config?: { Cmd?: string[]; Entrypoint?: string[]; Labels?: Record<string, string> } };
  const exact = configured.image.startsWith('sha256:') ? metadata.Id === configured.image : metadata.RepoDigests?.includes(configured.image);
  if (!exact) throw new Error('The local container image does not match the configured immutable digest.');
  const advertised = [...(metadata.Config?.Cmd ?? []), ...(metadata.Config?.Entrypoint ?? [])].some(value => /^python3(?:\.\d+)?$/.test(path.posix.basename(value)));
  if (!advertised && metadata.Config?.Labels?.['pm.automation.python'] !== '3') throw new Error('The image metadata does not advertise Python 3. Configure a reviewed Python image or label pm.automation.python=3; execution still verifies the actual interpreter.');
  return configured;
}
/** No parent environment, registry credentials, shell interpolation, or user-selected runtime flags. */
async function command(snapshot: Pick<IsolationSnapshot, 'executable' | 'directory'>, args: string[], limit = 2 * 1024 * 1024): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(snapshot.executable, args, { env: { PATH: '/usr/bin:/bin', HOME: snapshot.directory, LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  const stdout: Buffer[] = [], stderr: Buffer[] = []; let size = 0, failure: Error | undefined;
  const timeout = setTimeout(() => { failure = new Error('Isolated runtime command timed out; container outcome must be queried.'); child.kill('SIGKILL'); }, 15_000);
  const collect = (target: Buffer[]) => (chunk: Buffer) => { size += chunk.length; if (size > limit) { failure = new Error('Isolated runtime output exceeds its guard.'); child.kill('SIGKILL'); } else target.push(chunk); };
  child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
  const result = Promise.withResolvers<{ code: number | null; stdout: string; stderr: string }>();
  child.once('error', error => { clearTimeout(timeout); result.reject(error); });
  child.once('close', code => { clearTimeout(timeout); if (failure) result.reject(failure); else result.resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }); });
  return result.promise;
}
// Executed only INSIDE the configured unprivileged, networkless, read-only OCI container.
// A package is already expanded into bounded UTF-8 regular files by the transfer boundary.
const supervisor = String.raw`import base64, datetime, json, os, pathlib, selectors, signal, subprocess, sys, time
spec = json.load(open('/source/input.json', encoding='utf-8'))
root = pathlib.Path('/work/run'); root.mkdir(mode=0o700)
for item in spec['files']:
    p = pathlib.PurePosixPath(item['path'])
    if p.is_absolute() or '..' in p.parts or '\\' in str(p): raise ValueError('unsafe frozen script path')
    target = root.joinpath(*p.parts); target.parent.mkdir(parents=True, exist_ok=True); target.write_text(item['content'], encoding='utf-8')
payload = pathlib.Path('/work/payload.json'); payload.write_text(json.dumps(spec['payload']), encoding='utf-8')
env = {'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/work','LANG':'C.UTF-8','PYTHONUNBUFFERED':'1','AUTOMATION_PAYLOAD_FILE':str(payload),'AUTOMATION_REPOSITORY':'/repository'}
deadline = time.monotonic() + spec['timeoutSeconds']; written = 0; sequence = 0
pending = {1:bytearray(), 2:bytearray()}
def emit(stream, data):
    global sequence
    if not data: return
    sequence += 1
    frame = {'sequence':sequence,'stream':'stdout' if stream == 1 else 'stderr','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'data':base64.b64encode(data).decode('ascii')}
    os.write(1, (json.dumps(frame, separators=(',',':'))+'\n').encode('ascii'))
def flush():
    for stream in (1,2):
        emit(stream, pending[stream]); pending[stream].clear()
def run(argv):
    global written
    proc = subprocess.Popen(argv, cwd=str(root), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    selector = selectors.DefaultSelector(); selector.register(proc.stdout, selectors.EVENT_READ, 1); selector.register(proc.stderr, selectors.EVENT_READ, 2)
    try:
        while selector.get_map():
            if time.monotonic() >= deadline: raise TimeoutError('automation timeout exceeded')
            for key, _ in selector.select(min(0.2, max(0, deadline-time.monotonic()))):
                data = os.read(key.fileobj.fileno(), 8192)
                if not data: selector.unregister(key.fileobj); continue
                written += len(data)
                if written > 1048576: raise OverflowError('automation output exceeds 1 MiB')
                pending[key.data].extend(data)
                while len(pending[key.data]) >= 4096:
                    emit(key.data, pending[key.data][:4096]); del pending[key.data][:4096]
        return proc.wait(timeout=max(0.01, deadline-time.monotonic()))
    finally:
        selector.close(); flush()
        try: os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        proc.wait()
code = 1
try:
    if spec['setup']:
        setup = pathlib.Path('/work/setup.sh'); setup.write_text(spec['setup'], encoding='utf-8')
        code = run(['/bin/sh', str(setup)])
        if code: sys.exit(code)
    code = run([sys.executable, str(root / spec['entrypoint'])])
except (TimeoutError, subprocess.TimeoutExpired):
    emit(2, b'automation timeout exceeded\n'); code = 124
except OverflowError:
    emit(2, b'automation output exceeds 1 MiB\n'); code = 125
except Exception as error:
    emit(2, (type(error).__name__ + ': isolated script supervisor failed\n').encode('utf-8')); code = 126
finally:
    flush()
sys.exit(code)
`;
export async function prepareIsolatedScript(executionId: string, fingerprint: string, action: ScriptAction, payload: Record<string, unknown> | null): Promise<IsolationSnapshot> {
  validateScriptAction(action);
  const configured = await inspectIsolation();
  const directory = path.join(dataDirectory(), 'automation-executions', executionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = [...action.files, ...(action.content ? [{ path: action.entrypoint, content: action.content }] : [])];
  const input = JSON.stringify({ files, setup: action.setup, entrypoint: action.entrypoint, timeoutSeconds: action.timeoutSeconds, payload });
  const source = path.join(directory, 'source');
  await mkdir(source, { mode: 0o755 });
  await writeFile(path.join(source, 'input.json'), input, { mode: 0o644, flag: 'wx' });
  await writeFile(path.join(source, 'supervisor.py'), supervisor, { mode: 0o644, flag: 'wx' });
  // Runtime config HOME remains private; only source is exposed read-only to uid 65534.
  await chmod(directory, 0o700);
  return { ...configured, directory, container: `pm-automation-${createHash('sha256').update(executionId).digest('hex').slice(0, 40)}`, fingerprint };
}
export async function createIsolatedScript(snapshot: IsolationSnapshot, cwd: string): Promise<void> {
  const result = await command(snapshot, ['create', '--pull=never', '--name', snapshot.container, '--label', `pm.automation.fingerprint=${snapshot.fingerprint}`, '--network=none', '--read-only', '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=256m', '--memory-swap=256m', '--cpus=1', '--ulimit=nofile=128:128', '--log-driver=json-file', '--log-opt=max-size=2m', '--log-opt=max-file=1', '--mount', `type=bind,source=${path.join(snapshot.directory, 'source')},target=/source,readonly`, '--mount', `type=bind,source=${cwd},target=/repository,readonly`, '--tmpfs', '/work:rw,nosuid,nodev,noexec,size=64m,mode=0700,uid=65534,gid=65534', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777', '--workdir=/work', '--entrypoint=python3', snapshot.image, '-I', '-u', '/source/supervisor.py']);
  if (result.code !== 0) throw new Error('Isolated container could not be created; query its original identity before retrying.');
}
export async function startIsolatedScript(snapshot: IsolationSnapshot): Promise<void> {
  const result = await command(snapshot, ['start', snapshot.container]);
  if (result.code !== 0) throw new Error('Isolated container start was not confirmed; query the original container identity.');
}
export async function stopIsolatedScript(snapshot: IsolationSnapshot): Promise<void> {
  const result = await command(snapshot, ['kill', '--signal=KILL', snapshot.container]);
  if (result.code !== 0) throw new Error('Isolated container stop was not confirmed; query the original container identity.');
}
export async function observeIsolatedScript(snapshot: IsolationSnapshot): Promise<ContainerObservation> {
  try {
    const result = await command(snapshot, ['inspect', '--format={{json .}}', snapshot.container], 128 * 1024);
    if (result.code !== 0) return { state: 'unknown', exitCode: null, startedAt: null, finishedAt: null, logs: [], error: 'The original container cannot currently be inspected; absence is not proof it never ran.' };
    const container = JSON.parse(result.stdout) as { Config?: { Labels?: Record<string, string> }; State?: { Status?: string; ExitCode?: number; StartedAt?: string; FinishedAt?: string } };
    if (container.Config?.Labels?.['pm.automation.fingerprint'] !== snapshot.fingerprint) throw new Error('Container identity fingerprint mismatch.');
    const state = container.State;
    const status = state?.Status === 'running' ? 'running' : state?.Status === 'exited' ? 'exited' : state?.Status === 'created' ? 'created' : 'unknown';
    const output: ContainerObservation['logs'] = [];
    let guardError: string | null = null;
    try {
      const logs = status === 'created' ? null : await command(snapshot, ['logs', snapshot.container]);
      if (logs && logs.code !== 0) throw new Error('Container output cannot currently be read.');
      if (logs?.stderr) throw new Error('The isolated Python supervisor wrote unexpected unframed output; its actual container exit remains authoritative.');
      const lines = (logs?.stdout ?? '').split('\n');
      const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
      let expectedSequence = 1, bytes = 0, lastAt: string | null = null;
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        if (!line) continue;
        if (index === lines.length - 1 && status !== 'exited') break;
        const frame = JSON.parse(line) as { sequence?: number; stream?: string; at?: string; data?: string };
        if (frame.sequence !== expectedSequence++ || !['stdout', 'stderr'].includes(frame.stream ?? '') || !frame.at || !Number.isFinite(Date.parse(frame.at)) || typeof frame.data !== 'string' || frame.data.length > 8192 || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)) throw new Error('Isolated output framing was truncated, altered or exceeded its guard.');
        const stream = frame.stream as 'stdout' | 'stderr', data = Buffer.from(frame.data, 'base64');
        bytes += data.length;
        if (bytes > 1024 * 1024 + 256) throw new Error('Isolated output exceeded its 1 MiB guard.');
        const at = new Date(frame.at).toISOString(); lastAt = at;
        output.push({ id: `container:${frame.sequence}`, at, stream, message: decoders[stream].decode(data, { stream: true }) });
      }
      if (status === 'exited' && lastAt) for (const stream of ['stdout', 'stderr'] as const) {
        const tail = decoders[stream].decode();
        if (tail) output.push({ id: `container:decode-tail:${stream}`, at: lastAt, stream, message: tail });
      }
    } catch (error) { guardError = error instanceof Error ? error.message : 'Isolated output guard could not be verified.'; }
    return { state: status, exitCode: Number.isInteger(state?.ExitCode) ? state!.ExitCode! : null, startedAt: state?.StartedAt && !state.StartedAt.startsWith('0001-') ? state.StartedAt : null, finishedAt: state?.FinishedAt && !state.FinishedAt.startsWith('0001-') ? state.FinishedAt : null, logs: output, error: guardError ?? (status === 'unknown' ? 'Container lifecycle is not terminal or running.' : null), outputGuardFailed: guardError !== null && /exceed|framing|unframed/.test(guardError) };
  } catch (error) { return { state: 'unknown', exitCode: null, startedAt: null, finishedAt: null, logs: [], error: error instanceof Error ? error.message : 'Container query failed.' }; }
}
