import path from 'node:path';
import { homedir } from 'node:os';
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import type { LocalProjectConfiguration } from '../../application/src/local-projects.ts';

function localProjectConfiguration(env: NodeJS.ProcessEnv): LocalProjectConfiguration {
  let trusted: Record<string, unknown> = {};
  const file = path.resolve(env.LOCAL_PROJECT_CONFIG ?? '.local/local-projects.json');
  try {
    const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65_536 || (stat.mode & 0o022) !== 0) throw new Error('Invalid local project configuration');
      trusted = JSON.parse(readFileSync(descriptor, 'utf8')) as Record<string, unknown>;
    } finally { closeSync(descriptor); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const enabled = env.LOCAL_PROJECTS_ENABLED === undefined ? trusted.enabled === true : env.LOCAL_PROJECTS_ENABLED === 'true';
  const dataRoot = path.resolve(env.LOCAL_DATA_ROOT ?? (typeof trusted.dataRoot === 'string' ? trusted.dataRoot : '.local'));
  const roots: unknown = env.LOCAL_PROJECT_ALLOWED_ROOTS === undefined ? trusted.allowedRoots ?? [] : JSON.parse(env.LOCAL_PROJECT_ALLOWED_ROOTS);
  if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) throw new Error('LOCAL_PROJECT_ALLOWED_ROOTS must be a JSON array of absolute paths');
  const allowedRoots = roots.map(root => path.resolve(root as string));
  if (enabled && !allowedRoots.length) throw new Error('Local projects require at least one trusted allowed root');
  const defaultParent = env.LOCAL_PROJECT_DEFAULT_PARENT ?? (typeof trusted.defaultParent === 'string' ? trusted.defaultParent : null);
  return { enabled, dataRoot, allowedRoots, defaultParent: defaultParent ? path.resolve(defaultParent) : null,
    coreRoot: path.resolve(env.CORE_WORKSPACE_ROOT ?? path.join(dataRoot, 'pm-workspaces')),
    backupRoot: path.resolve(env.LOCAL_BACKUP_ROOT ?? (typeof trusted.backupRoot === 'string' ? trusted.backupRoot : path.join(dataRoot, 'backups'))) };
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number, name: string) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`Invalid ${name}`);
  return parsed;
}
export function runtimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const localProjects = localProjectConfiguration(env);
  return {
    databaseUrl: env.DATABASE_URL,
    coreWorkspaceRoot: localProjects.coreRoot,
    chatSpaceRoot: env.PM_CHAT_SPACE_ROOT ?? path.join(homedir(), '.pmv3'),
    localProjects,
    publicOrigin: env.PUBLIC_ORIGIN ?? `http://${env.HOST ?? '127.0.0.1'}:${env.PORT ?? '4100'}`,
    cookieSecure: env.COOKIE_SECURE === 'true',
    workerIntervalMs: positiveInteger(env.WORKER_INTERVAL_MS, 500, 60_000, 'WORKER_INTERVAL_MS'),
    eventRetentionDays: positiveInteger(env.EVENT_RETENTION_DAYS, 7, 3650, 'EVENT_RETENTION_DAYS'),
  };
}
