import { mkdir, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, '.local'), { recursive: true, mode: 0o700 });
// This is a trusted service-side allowlist, not a path supplied by the browser.
const projects = path.join(root, '.local', 'projects');
await mkdir(projects, { recursive: true, mode: 0o700 });
await mkdir(path.join(root, '.local', 'backups'), { recursive: true, mode: 0o700 });
await mkdir(path.join(root, '.local', 'agent-data'), { recursive: true, mode: 0o700 });
try {
  await writeFile(path.join(root, '.local', 'local-projects.json'), JSON.stringify({
    enabled: true, dataRoot: path.join(root, '.local'), allowedRoots: [projects],
    defaultParent: projects, backupRoot: path.join(root, '.local', 'backups'),
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Created trusted local-project configuration. Only .local/projects is selectable until a local administrator changes this allowlist; existing project/business files were not moved.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Existing trusted local-project configuration preserved.');
}
try {
  await writeFile(path.join(root, '.local', 'blob-target.json'), JSON.stringify({
    BLOB_PROVIDER: 'local', BLOB_ROOT: path.join(root, '.local', 'blobs'),
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
try {
  await access(path.join(root, '.env'));
  console.log('Existing .env preserved. Review .env.example and provide the separate private .env.worker role configuration.');
} catch {
  const password = randomBytes(32).toString('hex');
  const image = process.env.POSTGRES_IMAGE || 'postgres:16-alpine';
  const databaseUrl = `postgresql://project_management:${password}@127.0.0.1:55444/project_management`;
  await writeFile(path.join(root, '.env'), [
    'HOST=127.0.0.1', 'PORT=4194', 'PUBLIC_ORIGIN=http://127.0.0.1:3224',
    'PM_API_URL=http://127.0.0.1:4194', 'PM_WEB_PORT=3224',
    'POSTGRES_PORT=55444', `POSTGRES_IMAGE=${image}`, `POSTGRES_PASSWORD=${password}`,
    `DATABASE_URL=${databaseUrl}`,
    'BLOB_PROVIDER=local', 'BLOB_ROOT=.local/blobs', 'CORE_WORKSPACE_ROOT=.local/pm-workspaces',
    'COOKIE_SECURE=false', 'WORKER_INTERVAL_MS=500',
    'EVENT_RETENTION_DAYS=7', '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  console.log('Created private .env; generated database credential was not printed.');
  try {
    await writeFile(path.join(root, '.env.worker'), [
      `DATABASE_URL=${databaseUrl}`, 'CORE_WORKSPACE_ROOT=.local/pm-workspaces',
      'WORKER_INTERVAL_MS=500', 'EVENT_RETENTION_DAYS=7', '',
    ].join('\n'), { flag: 'wx', mode: 0o600 });
    console.log('Created private .env.worker without API storage credentials.');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.log('Existing .env.worker preserved; verify its database and core root match this installation.');
  }
}
try {
  await writeFile(path.join(root, '.env.agent'), [
    'HOST=127.0.0.1', 'AGENT_WORKSPACE_API_PORT=4325', 'AGENT_WEB_PORT=4326',
    'PM_API_URL=http://127.0.0.1:4194', 'AGENT_WORKSPACE_API_ONLY=1',
    `AGENT_WORKSPACE_DATA_DIR=${path.join(root, '.local', 'agent-data')}`,
    'VITE_ENABLE_UI_LAB=0', '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  console.log('Created private .env.agent with isolated v4 data; no Provider credentials or global CLI homes were imported.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Existing .env.agent preserved.');
}
