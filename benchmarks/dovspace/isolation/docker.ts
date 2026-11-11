import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';

export const OWNER_LABEL = 'org.dovspace.bench.owner';
export const DOCKER_HOST = 'unix:///var/run/docker.sock';
const processSecrets = new Set<string>();
export function registerProcessSecrets(values: (string | undefined)[]): void { for (const value of values) if (value) processSecrets.add(value); }
export function safeProcessDiagnostic(value: string, extraSecrets: string[] = []): string {
  let text = '';
  for (const character of stripVTControlCharacters(value)) {
    const code = character.charCodeAt(0);
    if ((code >= 32 && code !== 127) || code === 9 || code === 10 || code === 13) text += character;
  }
  for (const secret of [...processSecrets, ...extraSecrets].sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(secret, '[REDACTED]');
    for (let length = Math.min(secret.length - 1, text.length); length >= 8; length--) if (text.endsWith(secret.slice(0, length))) { text = text.slice(0, -length) + '[REDACTED]'; break; }
  }
  text = text.replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]').replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@');
  text = text.replace(/\b(?:args|argv|environment|env)\s*[:=]\s*(?:\[[^\]]*\]|\{[^}]*\}|[^\n]+)/gi, '[REDACTED_PROCESS_CONFIGURATION]');
  text = text.replace(/((?:cookie|authorization|api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]');
  return text.slice(0, 16_384).trim();
}
export function cleanEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', ...extra };
}
export async function ownerIdentity(): Promise<string> {
  const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  const birth = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  if (!birth) throw new Error('Linux process ownership unavailable');
  return `${process.pid}:${birth}:${randomUUID()}`;
}
export function docker(args: string[], environment: NodeJS.ProcessEnv = {}, timeoutMs = 60_000): Promise<string> {
  registerProcessSecrets(Object.entries(environment).filter(([key]) => /password|secret|token|cookie|api.?key/i.test(key)).map(([, value]) => value));
  const completion = Promise.withResolvers<string>();
  const child = spawn('docker', ['--host', DOCKER_HOST, ...args], { env: cleanEnvironment(environment), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', diagnostic = '', bytes = 0;
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  child.stdout.on('data', (data: Buffer) => { bytes += data.length; if (bytes <= 16 * 1024 * 1024) output += data.toString(); else child.kill('SIGKILL'); });
  child.stderr.on('data', (data: Buffer) => { if (diagnostic.length < 65_536) diagnostic += data.toString(); });
  child.once('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); completion.reject(new Error(`Docker prerequisite unavailable (${error.code ?? 'spawn_error'})`)); });
  child.once('close', code => {
    clearTimeout(timer);
    if (code === 0) completion.resolve(args[0] === 'logs' ? safeProcessDiagnostic(`${output}\n${diagnostic}`) : output.trim());
    else completion.reject(new Error(`Owned Docker command failed (${args[0] ?? 'unknown'}; exit=${code ?? 'signal'}): ${safeProcessDiagnostic(diagnostic) || 'no stderr reported'}`));
  });
  return completion.promise;
}
export type DockerInspection = { Id: string; Image: string; Name: string; AppArmorProfile: string; State: { Running: boolean; ExitCode?: number; Error?: string }; Config: { Labels: Record<string, string>; Env: string[]; User: string }; HostConfig: { NetworkMode: string; ReadonlyRootfs: boolean; Privileged: boolean; CapDrop: string[]; SecurityOpt: string[]; PidMode: string; MaskedPaths?: string[]; ReadonlyPaths?: string[]; Binds: string[] | null }; Mounts: { Source: string; Destination: string; RW: boolean }[]; NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | null> } };
export async function inspectOwned(id: string, owner: string): Promise<DockerInspection> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Container identity is not a full Docker ID');
  const values = JSON.parse(await docker(['inspect', id])) as DockerInspection[];
  const value = values[0];
  if (values.length !== 1 || value?.Id !== id || value.Config.Labels[OWNER_LABEL] !== owner) throw new Error('Container ownership changed; operation refused');
  return value;
}
export async function removeOwned(id: string, owner: string): Promise<void> {
  await inspectOwned(id, owner);
  await docker(['rm', '--force', '--volumes', id]);
}
export async function ownedContainerDiagnostic(id: string, owner: string): Promise<string> {
  const inspected = await inspectOwned(id, owner);
  const logs = await docker(['logs', '--tail', '60', id]).catch(error => safeProcessDiagnostic(error instanceof Error ? error.message : 'Container logs unavailable'));
  return safeProcessDiagnostic(`state=${inspected.State.Running ? 'running' : 'stopped'}; exit=${inspected.State.ExitCode ?? 'unknown'}; OCI=${inspected.State.Error ?? 'none'}; logs=${logs}`);
}
export async function removeOwnedName(name: string, owner: string): Promise<void> {
  if (!/^dovspace-bench-[a-z-]+-[a-f0-9]{32}$/.test(name)) throw new Error('Invalid benchmark container name');
  const ids = await docker(['container', 'ls', '--all', '--no-trunc', '--filter', `name=^/${name}$`, '--filter', `label=${OWNER_LABEL}=${owner}`, '--format', '{{.ID}}']);
  if (!ids) return;
  const value = await inspectOwned(ids, owner);
  if (value.Name !== `/${name}`) throw new Error('Cleanup name changed; no resource was removed');
  await removeOwned(value.Id, owner);
}
