import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildApp } from '../apps/server/pm/src/app.ts';
import { LocalBlobStore } from '../packages/infrastructure/src/blobs.ts';
import { closeMailApp, MailFixtureScope } from './mail-fixture-lifecycle.ts';

// This entry point is only launched by the acceptance fixture with an allowlisted
// environment. Neither the API nor the browser dev server reads a dotenv file.
const role = process.argv[2];
const scope = new MailFixtureScope(undefined, 125_000);
let stopping: Promise<void> | undefined;
function emit(message: object): void {
  if (process.connected) process.send?.(message, () => undefined);
}
function stop(): Promise<void> {
  return stopping ??= scope.close().catch(error => { process.exitCode = 1; throw error; }).finally(() => {
    if (process.connected) process.disconnect();
  });
}
for (const event of ['SIGINT', 'SIGTERM', 'disconnect'] as const) process.once(event, () => { void stop().catch(() => undefined); });

function failureCodes(error: unknown): string[] {
  const codes: string[] = [];
  const pending = [error];
  for (let visited = 0; pending.length && visited < 6; visited++) {
    const current = pending.shift();
    if (!current || typeof current !== 'object') continue;
    const failure = current as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (typeof failure.code === 'string' &&
        /^(?:[0-9A-Z]{5}|FST_ERR_[A-Z_]{1,64}|AVV_ERR_[A-Z_]{1,64}|ERR_[A-Z_]{1,64}|EACCES|EPERM|ENOENT|ENOSPC|ENOSYS|EMFILE|ENFILE|ENOMEM|ECONNREFUSED|ECONNRESET|ETIMEDOUT)$/.test(failure.code)) codes.push(failure.code);
    if (typeof failure.message === 'string') {
      for (const hook of ['onReady', 'onClose']) if (failure.message.includes(hook)) codes.push(hook);
    }
    if (failure.cause) pending.push(failure.cause);
    if (Array.isArray(failure.errors)) pending.push(...failure.errors.slice(0, 3));
  }
  return [...new Set(codes)].slice(0, 4);
}

async function initialize(): Promise<void> {
  if (role === 'api') {
    emit({ event: 'phase', phase: 'api_build' });
    const root = process.env.BLOB_ROOT!;
    const app = scope.own(buildApp({
      databaseUrl: process.env.DATABASE_URL!,
      blobStore: new LocalBlobStore(root),
      blobStorageLocator: { provider: 'local', root },
      coreWorkspaceRoot: process.env.CORE_WORKSPACE_ROOT!,
      chatSpaceRoot: process.env.PM_CHAT_SPACE_ROOT!,
      publicOrigin: process.env.LOCAL_PROJECT_PUBLIC_ORIGIN ?? 'http://127.0.0.1:4100',
      cookieSecure: false,
      signal: scope.signal,
      localProjects: {
        enabled: process.env.LOCAL_PROJECTS_ENABLED === 'true',
        dataRoot: process.env.LOCAL_PROJECT_FIXTURE_ROOT!,
        defaultParent: process.env.LOCAL_PROJECT_DEFAULT_PARENT!,
        allowedRoots: JSON.parse(process.env.LOCAL_PROJECT_ALLOWED_ROOTS!),
        backupRoot: process.env.LOCAL_PROJECT_FIXTURE_ROOT! + '/backups',
      },
    }), closeMailApp);
    emit({ event: 'phase', phase: 'api_listen' });
    const origin = await scope.step(() => app.listen({ host: '127.0.0.1', port: 0 }));
    emit({ event: 'ready', origin });
  } else if (role === 'web') {
    emit({ event: 'phase', phase: 'web_create' });
    const require = createRequire(new URL('../apps/web/vite.config.ts', import.meta.url));
    // Vite is an optional web-workspace dependency, resolved at runtime so the
    // backend-only acceptance runner does not acquire a production Vite import.
    const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
    const server = await scope.acquire(() => createServer({
      root: fileURLToPath(new URL('../apps/web/', import.meta.url)),
      configFile: fileURLToPath(new URL('../apps/web/vite.config.ts', import.meta.url)),
      envDir: process.env.LOCAL_PROJECT_FIXTURE_ROOT!,
      server: { host: '127.0.0.1', port: 0, strictPort: true },
      logLevel: 'silent',
    }), owned => owned.close());
    emit({ event: 'phase', phase: 'web_listen' });
    await scope.step(() => server.listen());
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Browser fixture did not bind a loopback port');
    emit({ event: 'ready', origin: `http://127.0.0.1:${address.port}` });
  } else {
    throw new Error('Expected an isolated api or web fixture role');
  }
}

try {
  await scope.initialize(initialize);
} catch (error) {
  // Only bounded machine codes and fixed hook names cross IPC, never messages,
  // stacks, configuration, paths, URLs or generated credentials.
  if (!stopping) {
    const codes = failureCodes(error);
    emit({ event: 'startup_failed', codes: codes.length ? codes : ['unknown_error'] });
    process.exitCode = 1;
  }
  await stop().catch(() => undefined);
}
