import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildApp } from '../apps/api/src/app.ts';
import { LocalBlobStore } from '../packages/infrastructure/src/blobs.ts';

// This entry point is only launched by the acceptance fixture with an allowlisted
// environment. Neither the API nor the browser dev server reads a dotenv file.
const role = process.argv[2];
let close: (() => Promise<void>) | undefined;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await close?.(); }
  catch { process.exitCode = 1; }
  finally { process.disconnect?.(); }
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
process.once('disconnect', () => { void stop(); });

try {
  if (role === 'api') {
    const root = process.env.BLOB_ROOT!;
    const app = buildApp({
      databaseUrl: process.env.DATABASE_URL!,
      blobStore: new LocalBlobStore(root),
      blobStorageLocator: { provider: 'local', root },
      coreWorkspaceRoot: process.env.CORE_WORKSPACE_ROOT!,
      publicOrigin: 'http://127.0.0.1:4100',
      cookieSecure: false,
      localProjects: {
        enabled: process.env.LOCAL_PROJECTS_ENABLED === 'true',
        dataRoot: process.env.LOCAL_PROJECT_FIXTURE_ROOT!,
        defaultParent: process.env.LOCAL_PROJECT_DEFAULT_PARENT!,
        allowedRoots: JSON.parse(process.env.LOCAL_PROJECT_ALLOWED_ROOTS!),
        backupRoot: process.env.LOCAL_PROJECT_FIXTURE_ROOT! + '/backups',
      },
    });
    close = () => app.close();
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    process.send?.({ event: 'ready', origin });
  } else if (role === 'web') {
    const require = createRequire(new URL('../apps/web/vite.config.ts', import.meta.url));
    // Vite is an optional web-workspace dependency, resolved at runtime so the
    // backend-only acceptance runner does not acquire a production Vite import.
    const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
    const server = await createServer({
      root: fileURLToPath(new URL('../apps/web/', import.meta.url)),
      configFile: fileURLToPath(new URL('../apps/web/vite.config.ts', import.meta.url)),
      envDir: process.env.LOCAL_PROJECT_FIXTURE_ROOT!,
      server: { host: '127.0.0.1', port: 0, strictPort: true },
      logLevel: 'silent',
    });
    close = () => server.close();
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Browser fixture did not bind a loopback port');
    process.send?.({ event: 'ready', origin: `http://127.0.0.1:${address.port}` });
  } else {
    throw new Error('Expected an isolated api or web fixture role');
  }
} catch {
  // Never forward raw configuration/connection errors, which can contain secrets.
  process.send?.({ event: 'startup_failed' });
  process.exitCode = 1;
  await stop();
}
