import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGateway } from '../apps/server/gateway.ts';
import type { DocumentSource } from '../packages/contracts/src/document-sources.ts';
import { CAPABILITIES } from '../packages/domain/src/core.ts';
import { createUser, createWorkspace } from '../packages/infrastructure/src/auth.ts';
import { createLocalProjectFixture, type LocalProjectFixture } from './local-project-fixture.ts';
import { configureDocumentSources, createDocumentProject, seedDocumentTree } from './document-sources-fixture.ts';
import { MailFixtureScope } from './mail-fixture-lifecycle.ts';

export type DocumentSourcesBrowserSetup = {
  origin: string; apiOrigin: string; workspaceId: string; otherWorkspaceId: string; schema: string;
  credentials: { email: string; password: string };
  projects: { id: string; title: string }[]; nativeDocumentId: string;
  directories: { bulk: string; shared: string; empty: string; projectA: string; projectB: string };
  sources: { workspaceId: string; source: DocumentSource }[];
};
export type DocumentSourcesBrowserFixture = { setup: DocumentSourcesBrowserSetup; fixture: LocalProjectFixture; close(): Promise<void> };

/** Real disposable PostgreSQL schema, API child, same-origin gateway and disk tree.
 * Credentials are generated in memory and returned only to the caller/IPC. Never
 * call LocalProjectFixture.startBrowser(): its older metadata-file flow is not
 * appropriate for this helper. No user/default service is contacted or restarted.
 */
export async function createDocumentSourcesBrowserFixture(options: { databaseUrl?: string; signal?: AbortSignal; webDist?: string } = {}): Promise<DocumentSourcesBrowserFixture> {
  const scope = new MailFixtureScope(options.signal, 240_000);
  return scope.initialize(async () => {
    const webDist = options.webDist ? resolve(options.webDist) : fileURLToPath(new URL('../apps/web/dist/', import.meta.url));
    if (!(await stat(join(webDist, 'index.html'))).isFile()) throw new Error('Browser fixture requires an existing built web index');
    // Reserve the public origin before creating the API. Browser writes use the
    // same unchanged Origin header that the API's normal origin policy expects.
    const reservation = scope.own(createServer(), async server => {
      if (!server.listening) return;
      server.closeAllConnections();
      const closed = Promise.withResolvers<void>();
      server.close(error => error ? closed.reject(error) : closed.resolve());
      await closed.promise;
    });
    const reserved = Promise.withResolvers<void>();
    reservation.once('error', reserved.reject);
    reservation.listen(0, '127.0.0.1', reserved.resolve);
    await scope.step(() => reserved.promise);
    reservation.off('error', reserved.reject);
    const address = reservation.address();
    assert.ok(address && typeof address !== 'string', 'Browser fixture must own a loopback TCP listener');
    const publicPort = address.port, origin = `http://127.0.0.1:${publicPort}`;
    const fixture = await scope.acquire(() => createLocalProjectFixture({ databaseUrl: options.databaseUrl, signal: scope.signal, publicOrigin: origin }), owned => owned.close());
    const a = await createDocumentProject(fixture, 'Smoke project A', 'smoke-native-a');
    const b = await createDocumentProject(fixture, 'Smoke project B', 'smoke-native-b');
    const c = await createDocumentProject(fixture, 'Smoke empty selectable project', 'smoke-native-c');
    const directories = {
      bulk: join(fixture.parents[1], 'bulk-over-200'), shared: join(fixture.parents[1], 'shared-safe-root'),
      empty: join(fixture.parents[1], 'empty-existing-folder'), projectA: join(fixture.parents[1], 'project-a-extra'), projectB: join(fixture.parents[1], 'project-b-extra'),
    };
    await seedDocumentTree(directories.bulk, 215);
    for (const path of [directories.shared, directories.empty, directories.projectA, directories.projectB]) await mkdir(path);
    await writeFile(join(directories.shared, 'shared.md'), '# Shared physical document\nEditing here affects each explicitly associated scope.\n');
    await writeFile(join(directories.projectA, 'same.md'), '# Separate project A bytes\n');
    await writeFile(join(directories.projectB, 'same.md'), '# Separate project B bytes\n');
    const native = await fixture.request<{ id: string }>(`/api/v1/workspaces/${fixture.workspaceId}/core/entities`, { method: 'POST', headers: { 'Idempotency-Key': randomUUID() }, body: { entity: 'document', project: a.record.id, title: 'Native document must remain first', body: '# Native PM document\nStill editable independently of external associations.\n' } });
    assert.equal(native.status, 200, 'Browser fixture native document creation failed');
    const other = await createWorkspace(fixture.pool, fixture.owner.id, 'Smoke shared-root other workspace');
    const sources: DocumentSourcesBrowserSetup['sources'] = [];
    for (const [workspaceId, projectId, paths] of [
      [fixture.workspaceId, null, [directories.bulk, directories.empty]],
      [fixture.workspaceId, a.record.id, [directories.shared, directories.projectA]],
      [fixture.workspaceId, b.record.id, [directories.shared, directories.projectB]],
      [other.id, null, [directories.shared]],
    ] as const) {
      const configuration = await configureDocumentSources(fixture, projectId, [...paths], 0, { workspaceId });
      sources.push(...configuration.sources.map(source => ({ workspaceId, source })));
    }
    const password = randomBytes(30).toString('base64url');
    const browserUser = await createUser(fixture.pool, { email: `document-browser-${randomUUID()}@example.test`, name: 'Isolated document browser owner', password });
    await fixture.command('SetWorkspaceMember', { userId: browserUser.id, capabilities: [...CAPABILITIES], projectIds: null });
    const foreignMembership = await fixture.request<{ status: string }>(`/api/v1/workspaces/${other.id}/commands`, { method: 'POST', body: { commandId: randomUUID(), commandType: 'SetWorkspaceMember', payload: { userId: browserUser.id, capabilities: [...CAPABILITIES], projectIds: null } } });
    assert.equal(foreignMembership.status, 200, 'Browser fixture other-workspace membership failed');
    assert.equal(foreignMembership.body.status, 'committed');

    const gateway = scope.own(createGateway({ pmUrl: fixture.origin, agentUrl: fixture.origin, webDevUrl: '', webDist }), owned => owned.shutdown());
    const released = Promise.withResolvers<void>();
    reservation.close(error => error ? released.reject(error) : released.resolve());
    await scope.step(() => released.promise);
    const listening = Promise.withResolvers<void>();
    gateway.once('error', listening.reject);
    gateway.listen(publicPort, '127.0.0.1', listening.resolve);
    await scope.step(() => listening.promise);
    gateway.off('error', listening.reject);
    const setup: DocumentSourcesBrowserSetup = {
      origin, apiOrigin: fixture.origin, workspaceId: fixture.workspaceId, otherWorkspaceId: other.id, schema: fixture.schema,
      credentials: { email: browserUser.email, password }, projects: [{ id: a.record.id, title: 'Smoke project A' }, { id: b.record.id, title: 'Smoke project B' }, { id: c.record.id, title: 'Smoke empty selectable project' }],
      nativeDocumentId: native.body.id, directories, sources,
    };
    return { setup, fixture, close: scope.close };
  });
}

// Launch with child_process.fork(..., {stdio:['ignore','ignore','ignore','ipc']}).
// Optional CLI environment DOCUMENT_SOURCES_BROWSER_WEB_DIST selects an existing
// isolated build, e.g. .local/document-multisource-web; otherwise apps/web/dist.
// ready -> {event:'ready',setup}; close by IPC {event:'close'}, SIGTERM or IPC
// disconnect. Cleanup removes only its owned schema, roots and child processes.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.send) throw new Error('Document browser fixture requires a private IPC channel');
  const controller = new AbortController();
  let owned: DocumentSourcesBrowserFixture | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    controller.abort(); await owned?.close();
    if (process.connected) process.disconnect();
  })();
  for (const event of ['SIGINT', 'SIGTERM', 'disconnect'] as const) process.once(event, () => { void stop().catch(() => { process.exitCode = 1; }); });
  process.on('message', message => { if (message && typeof message === 'object' && 'event' in message && message.event === 'close') void stop().catch(() => { process.exitCode = 1; }); });
  try {
    owned = await createDocumentSourcesBrowserFixture({ signal: controller.signal, webDist: process.env.DOCUMENT_SOURCES_BROWSER_WEB_DIST });
    controller.signal.throwIfAborted();
    const sent = Promise.withResolvers<void>();
    process.send!({ event: 'ready', setup: owned.setup }, error => error ? sent.reject(new Error('Browser fixture IPC delivery failed')) : sent.resolve());
    await sent.promise;
  } catch {
    if (process.connected) process.send?.({ event: 'startup_failed' }, () => undefined);
    process.exitCode = 1; await stop().catch(() => undefined);
  }
}
