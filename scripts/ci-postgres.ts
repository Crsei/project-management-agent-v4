import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const ciPostgresLabel = 'org.dovspace.ci.owner';

export function processBirth(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return ['Z', 'X'].includes(fields[0] ?? '') ? undefined : fields[19];
  } catch { return undefined; }
}

type Container = {
  Id?: string;
  State?: { Running?: boolean };
  Config?: { Labels?: Record<string, string>; Env?: string[] };
  NetworkSettings?: { Ports?: Record<string, { HostIp: string; HostPort: string }[] | null> };
};

/** Match the actual Docker allocation, not a CI flag or an arbitrary loopback URL. */
export function matchesCiPostgres(source: string, inspected: unknown, id: string, owner: string): boolean {
  try {
    const url = new URL(source);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || !/^[1-9]\d{0,4}$/.test(url.port) || Number(url.port) > 65535) return false;
    // pg parses query keys as connection overrides; only the schema fixture's
    // server-side options may accompany the verified authority.
    if (url.hash || url.searchParams.size > 1 || (url.searchParams.size === 1 && !url.searchParams.has('options'))) return false;
    if (!/^[a-f0-9]{64}$/.test(id) || !/^\d+:\d+:[a-f0-9-]{36}$/.test(owner)) return false;
    const container = inspected as Container;
    if (container?.Id !== id || container.State?.Running !== true || container.Config?.Labels?.[ciPostgresLabel] !== owner) return false;
    const bindings = container.NetworkSettings?.Ports?.['5432/tcp'];
    if (bindings?.length !== 1 || bindings[0]?.HostIp !== '127.0.0.1' || bindings[0].HostPort !== url.port) return false;
    const values = container.Config?.Env;
    if (!Array.isArray(values)) return false;
    const runId = owner.split(':')[2]!.replaceAll('-', '');
    const database = `pm_ci_${runId}`;
    const password = decodeURIComponent(url.password);
    return url.pathname === `/${database}` && decodeURIComponent(url.username) === 'pm_ci' && /^[a-f0-9]{64}$/.test(password)
      && values.includes(`POSTGRES_DB=${database}`) && values.includes('POSTGRES_USER=pm_ci') && values.includes(`POSTGRES_PASSWORD=${password}`);
  } catch { return false; }
}

/** Only the still-live owner may opt a random port into the existing test guard. */
export function isOwnedCiPostgres(source: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const id = env.PM_CI_POSTGRES_CONTAINER, owner = env.PM_CI_POSTGRES_OWNER;
  if (!id || !owner || !/^[a-f0-9]{64}$/.test(id)) return false;
  const [pidText, birth] = owner.split(':');
  if (!birth || processBirth(Number(pidText)) !== birth) return false;
  const inspected = spawnSync('docker', ['--host', 'unix:///var/run/docker.sock', 'inspect', id], {
    env: { ...(env.PATH ? { PATH: env.PATH } : {}), ...(env.HOME ? { HOME: env.HOME } : {}) },
    encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (inspected.error || inspected.status !== 0) return false;
  try {
    const containers: unknown = JSON.parse(inspected.stdout);
    return Array.isArray(containers) && containers.length === 1 && matchesCiPostgres(source, containers[0], id, owner);
  } catch { return false; }
}
