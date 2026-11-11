import { createHash, randomBytes } from 'node:crypto';
import { cp, chmod, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { repositoryRoot, type BenchmarkConfig } from '../benchmark.config.ts';
import type { FixtureHandle } from '../schemas/types.ts';
import type { RuntimeStartOptions } from '../fixtures/manager.ts';
import { digest } from '../fixtures/snapshot.ts';
import { docker, inspectOwned, ownedContainerDiagnostic, OWNER_LABEL, registerProcessSecrets, removeOwnedName, safeProcessDiagnostic } from './docker.ts';
import { startBroker, type Broker } from './broker.ts';
import { openSocketDirectory, type SocketDirectory } from './filesystem.ts';

export interface OwnedRuntime { readonly paused: boolean; pause(): Promise<void>; resume(): Promise<void>; close(): Promise<void>; armResponseLoss(targetId: string): void }
const excluded: Record<string, true> = { '.git': true, '.local': true, '.runtime': true, benchmarks: true, outputs: true, node_modules: true, '.cache': true, '.codex': true, '.claude': true, '.ssh': true, '.npmrc': true, '.pnpmrc': true };
async function stageSource(destination: string): Promise<string[]> {
  await mkdir(destination, { mode: 0o700 });
  const dependencyRoots: string[] = [];
  async function scan(directory: string): Promise<void> {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.name === 'node_modules' && item.isDirectory()) { dependencyRoots.push(path.join(directory, item.name)); continue; }
      if (item.isDirectory() && !excluded[item.name] && !item.name.startsWith('.')) await scan(path.join(directory, item.name));
    }
  }
  for (const folder of ['apps/server/agent', 'packages', 'vendor']) {
    const source = path.join(repositoryRoot, folder);
    await scan(source);
    await cp(source, path.join(destination, folder), { recursive: true, dereference: false, filter: async current => {
      const name = path.basename(current);
      if (excluded[name] || name.startsWith('.env') || /(?:\.sqlite(?:-[a-z]+)?|\.db|\.pem|\.key)$/.test(name)) return false;
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) return false;
      return stat.isDirectory() || stat.isFile() && stat.nlink === 1;
    } });
  }
  for (const name of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json']) {
    try { await cp(path.join(repositoryRoot, name), path.join(destination, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  dependencyRoots.push(path.join(repositoryRoot, 'node_modules'));
  for (const directory of dependencyRoots) await mkdir(path.join(destination, path.relative(repositoryRoot, directory)), { recursive: true, mode: 0o700 });
  return dependencyRoots;
}
async function sourceEvidence(root: string): Promise<{ sourceHash: string; sourceFileCount: number; lockfileHash: string }> {
  const entries: { path: string; sha256: string }[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) entries.push({ path: path.relative(root, absolute), sha256: createHash('sha256').update(await readFile(absolute)).digest('hex') });
      else throw new Error('Staged product source contains an unsupported file type');
    }
  }
  await visit(root); entries.sort((a, b) => a.path.localeCompare(b.path));
  const lockfileHash = entries.find(entry => entry.path === 'pnpm-lock.yaml')?.sha256;
  if (!lockfileHash) throw new Error('Staged product lockfile is missing');
  return { sourceHash: digest(entries), sourceFileCount: entries.length, lockfileHash };
}
export function startIsolatedRuntime(config: BenchmarkConfig, handle: FixtureHandle, owner: string, options: RuntimeStartOptions, pmServiceSecret: string): Promise<OwnedRuntime> { return allocateRuntime(config, handle, owner, options, pmServiceSecret); }
export function startProtocolIsolatedRuntime(config: BenchmarkConfig, handle: FixtureHandle, owner: string, options: RuntimeStartOptions, pmServiceSecret: string, controlledProviderScript: string): Promise<OwnedRuntime> { return allocateRuntime(config, handle, owner, options, pmServiceSecret, { kind: 'protocol-calibration', controlledProviderScript }); }
function listen(server: Server): Promise<number> {
  const result = Promise.withResolvers<number>();
  server.once('error', () => result.reject(new Error('Private control endpoint failed')));
  server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') result.reject(new Error('Invalid private endpoint')); else result.resolve(address.port); });
  return result.promise;
}
async function stopServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  const done = Promise.withResolvers<void>(); server.close(() => done.resolve()); server.closeAllConnections(); await done.promise;
}
async function allocateRuntime(config: BenchmarkConfig, handle: FixtureHandle, owner: string, options: RuntimeStartOptions, pmServiceSecret: string, protocol?: { kind: 'protocol-calibration'; controlledProviderScript: string }): Promise<OwnedRuntime> {
  if (!protocol && (!config.providerEndpoint || !config.providerApiKey || !config.model)) throw new Error('Provider prerequisite missing: explicit model, HTTPS endpoint and API key are required; harness credentials are never inherited');
  if (!protocol && options.budget.maxCostUsd !== null && !config.prices) throw new Error('Cost budget requires explicit conservative token prices and output cap');
  const uid = process.getuid?.(), gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid === 0) throw new Error('Benchmark Agent requires a non-root Linux owner');
  const name = `dovspace-bench-agent-${handle.fixtureId.replaceAll('-', '')}`;
  const source = path.join(handle.root, 'runtime-source'), boot = path.join(handle.root, 'bootstrap'), sockets = path.join(handle.root, 'sockets'), home = path.join(handle.root, 'provider-home');
  for (const directory of [boot, sockets, home]) await mkdir(directory, { mode: 0o700 });
  const dependencies = await stageSource(source);
  const sourceIdentity = await sourceEvidence(source);
  const agentAccessToken = randomBytes(32).toString('base64url'), providerToken = randomBytes(32).toString('base64url');
  registerProcessSecrets([config.providerApiKey, agentAccessToken, pmServiceSecret, providerToken, handle.pm.token]);
  let broker: Broker | undefined, control: Server | undefined, id = '', closed = false, paused = false;
  let socketDirectory: SocketDirectory | undefined;
  async function close(): Promise<void> {
    if (closed) return;
    const errors: unknown[] = [];
    for (const action of [async () => removeOwnedName(name, owner), async () => broker?.close(), async () => stopServer(control)]) try { await action(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Isolated Agent cleanup failed');
    await socketDirectory?.close();
    closed = true;
  }
  try {
    socketDirectory = await openSocketDirectory(sockets);
    broker = await startBroker(protocol ? { ...config, providerEndpoint: undefined, providerApiKey: undefined } : config, handle, { ...options, providerToken, socketPath: socketDirectory.socketPath('host.sock'), agentSocketPath: socketDirectory.socketPath('agent.sock'), agentAccessToken, pmServiceSecret });
    await chmod(path.join(sockets, 'host.sock'), 0o600);
    await cp(new URL('./container-bridge.mjs', import.meta.url), path.join(boot, 'bridge.mjs'));
    await cp(path.join(repositoryRoot, 'packages/pm-cli/agent-tools.mjs'), path.join(boot, 'agent-tools.mjs'));
    if (protocol) await writeFile(path.join(boot, 'protocol-provider.mjs'), protocol.controlledProviderScript.startsWith('#!') ? protocol.controlledProviderScript : `#!/usr/bin/env node\n${protocol.controlledProviderScript}`, { mode: 0o700, flag: 'wx' });
    // Native commands get neither the Agent server mount nor its PID namespace.
    const nativeArgs = ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/etc', '--ro-bind', '/etc/ssl', '/etc/ssl', '--ro-bind', '/boot/agent-tools.mjs', '/source/packages/pm-cli/agent-tools.mjs', '--bind', '/workspace', '/workspace', '--bind', '/provider-home', '/provider-home', '--chdir', '/workspace', '--clearenv', '--setenv', 'HOME', '/provider-home', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'DOVSPACE_BENCH_PROVIDER_KEY', providerToken];
    nativeArgs.push('--setenv', 'CODEX_HOME', '/provider-home');
    if (protocol) nativeArgs.push('--ro-bind', '/boot/protocol-provider.mjs', '/opt/bench-protocol-provider.mjs');
    const providerCommand = protocol ? ['/usr/local/bin/node', '/opt/bench-protocol-provider.mjs'] : [config.providerBinary];
    // Sanitize before exec: bwrap's PID-1 supervisor must not retain the Agent's original environment.
    const wrapper = `#!/bin/sh\nexec /usr/bin/env -i /usr/bin/bwrap ${nativeArgs.map(value => `'${value}'`).join(' ')} -- ${providerCommand.map(value => `'${value}'`).join(' ')} "$@"\n`;
    if (!/^\/[A-Za-z0-9_./-]+$/.test(config.providerBinary)) throw new Error('Provider binary path contains unsafe characters');
    await writeFile(path.join(boot, 'provider-wrapper.sh'), wrapper, { mode: 0o700, flag: 'wx' });
    const mounts = [
      `type=bind,src=${source},dst=/source,readonly`, `type=bind,src=${boot},dst=/boot,readonly`, `type=bind,src=${handle.publicRoot},dst=/workspace`,
      `type=bind,src=${handle.agentDataRoot},dst=/agent-data`, `type=bind,src=${home},dst=/provider-home`, `type=bind,src=${sockets},dst=/broker`,
      ...dependencies.map(directory => `type=bind,src=${directory},dst=/source/${path.relative(repositoryRoot, directory)},readonly`),
    ];
    id = await docker(['create', '--pull', 'never', '--name', name, '--label', `${OWNER_LABEL}=${owner}`, '--network', 'none', '--read-only', '--user', `${uid}:${gid}`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--security-opt', 'seccomp=unconfined', '--security-opt', 'apparmor=unconfined', '--security-opt', 'systempaths=unconfined', '--pids-limit', '256', '--memory', '2g', '--cpus', '2', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', ...mounts.flatMap(mount => ['--mount', mount]),
      '--env', 'HOME=/provider-home', '--env', 'PM_DESKTOP_MANAGED=1', '--env', 'HOST=127.0.0.1', '--env', 'PORT=3900', '--env', 'AGENT_WORKSPACE_API_ONLY=1', '--env', 'AGENT_WORKSPACE_DATA_DIR=/agent-data', '--env', 'AGENT_WORKSPACE_ALLOWED_ROOTS=["/workspace"]', '--env', 'AGENT_APPROVAL_MODE=auto-approve', '--env', 'PM_API_URL=http://127.0.0.1:3901', '--env', 'AGENT_WORKSPACE_ACCESS_TOKEN', '--env', 'PM_AUTOMATION_SERVICE_SECRET', '--workdir', '/source', '--entrypoint', '/usr/local/bin/node', config.agentImage, '/boot/bridge.mjs'], { AGENT_WORKSPACE_ACCESS_TOKEN: agentAccessToken, PM_AUTOMATION_SERVICE_SECRET: pmServiceSecret });
    await docker(['start', id]);
    const inspection = await inspectOwned(id, owner);
    const expectedMounts = mounts.map(mount => mount.split(',').find(part => part.startsWith('dst='))!.slice(4)).sort();
    if (!inspection.State.Running || inspection.HostConfig.NetworkMode !== 'none' || !inspection.HostConfig.ReadonlyRootfs || inspection.HostConfig.Privileged || inspection.Config.User !== `${uid}:${gid}` || !inspection.HostConfig.CapDrop.includes('ALL') || inspection.Mounts.map(mount => mount.Destination).sort().join('\n') !== expectedMounts.join('\n')) throw new Error('Container isolation inspection failed');
    // Docker consumes systempaths=unconfined into the empty masked/readonly path arrays below.
    const requiredSecurityOptions = ['no-new-privileges:true', 'seccomp=unconfined', 'apparmor=unconfined'];
    if (inspection.HostConfig.PidMode || requiredSecurityOptions.some(option => !inspection.HostConfig.SecurityOpt.includes(option)) || inspection.HostConfig.MaskedPaths?.length || inspection.HostConfig.ReadonlyPaths?.length || inspection.AppArmorProfile !== 'unconfined') throw new Error('Effective outer isolation policy differs from the explicit nested-sandbox prerequisite');
    const isolationPolicy = { networkMode: inspection.HostConfig.NetworkMode, readOnlyRoot: inspection.HostConfig.ReadonlyRootfs, user: inspection.Config.User, capDrop: inspection.HostConfig.CapDrop, securityOpt: inspection.HostConfig.SecurityOpt, pidMode: inspection.HostConfig.PidMode, privileged: inspection.HostConfig.Privileged, maskedPaths: inspection.HostConfig.MaskedPaths ?? [], readOnlyPaths: inspection.HostConfig.ReadonlyPaths ?? [], appArmorProfile: inspection.AppArmorProfile, nativeBoundary: 'Bubblewrap private user/PID/mount namespaces and private proc; no Agent/source/broker/authority mounts; outer network-none' };
    const probe = `const f=require('node:fs');for(const p of ${JSON.stringify([handle.authorityRoot, repositoryRoot + '/benchmarks/dovspace/graders', '/source/benchmarks', '/var/run/docker.sock', '/root/.env', '/source/.env'])}){if(f.existsSync(p))process.exit(41)};try{f.writeFileSync('/authority-probe','x');process.exit(42)}catch{};process.stdout.write('outer-denied')`;
    const outer = await docker(['exec', id, 'node', '-e', probe]);
    if (outer !== 'outer-denied') throw new Error('Agent authority denial probe failed');
    const nestedProbe = `const f=require('node:fs');for(const p of ['/source/apps','/source/benchmarks','/source/packages/domain','/agent-data','/broker','/boot','/proc/1/root/source/apps','/var/run/docker.sock']){if(f.existsSync(p))process.exit(43)};if(f.existsSync('/proc/1/environ')){const e=f.readFileSync('/proc/1/environ','utf8');if(e.includes('AGENT_WORKSPACE_ACCESS_TOKEN')||e.includes('PM_AUTOMATION_SERVICE_SECRET'))process.exit(44)}if(!f.existsSync('/source/packages/pm-cli/agent-tools.mjs'))process.exit(45);process.stdout.write('nested-denied')`;
    const nested = await docker(['exec', id, '/usr/bin/env', '-i', '/usr/bin/bwrap', ...nativeArgs, '--', '/usr/local/bin/node', '-e', nestedProbe]);
    if (nested !== 'nested-denied') throw new Error('Native provider isolation probe failed');
    control = createServer((incoming, outgoing) => {
      const upstream = request({ socketPath: socketDirectory!.socketPath('agent.sock'), path: incoming.url, method: incoming.method, headers: incoming.headers }, response => { outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing); });
      upstream.once('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); }); incoming.pipe(upstream);
    });
    const port = await listen(control);
    if ([3224, 4194, 4325, 55444].includes(port)) throw new Error('Agent control port collides with protected service ports');
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + config.startupTimeoutMs;
    while (true) {
      try { const response = await fetch(origin + '/api/providers', { headers: { authorization: `Bearer ${agentAccessToken}` }, signal: AbortSignal.timeout(1000) }); await response.body?.cancel(); if (response.ok) break; } catch { /* Service may still be opening its private SQLite. */ }
      if (Date.now() >= deadline) throw new Error('Isolated real Agent server did not become ready');
      await delay(100);
    }
    const checks = ['container-network-none', 'nonroot-readonly-capdrop', 'authority-and-grader-unreadable', 'native-private-pid-and-mounts'].map(check => ({ id: check, passed: true, required: true, score: 1, evidence: [check.startsWith('native') ? nested : check.includes('unreadable') ? outer : digest(inspection.HostConfig)] }));
    handle.imageIds = { ...handle.imageIds, agent: inspection.Image };
    const nodeVersion = await docker(['exec', id, '/usr/local/bin/node', '-p', 'process.version']);
    if (nodeVersion !== 'v24.21.0') throw new Error('Agent image must use prescribed Node v24.21.0');
    try { const image = JSON.parse(await docker(['image', 'inspect', config.codeImage])) as { Id?: string }[]; if (image[0]?.Id) handle.imageIds.code = image[0].Id; } catch { /* Code grading separately fails its explicit image prerequisite if needed. */ }
    const environmentEvidence = { ...sourceIdentity, imageIds: handle.imageIds, nodeVersion, isolationPolicy, runtimeKind: protocol?.kind ?? 'live', protocolScriptHash: protocol ? createHash('sha256').update(protocol.controlledProviderScript).digest('hex') : null };
    const environmentHash = digest(environmentEvidence);
    handle.isolation = { backend: 'docker', verified: true, containerId: id, networkId: 'none', checks, imageIds: handle.imageIds, effectivePolicy: isolationPolicy, proofDigest: digest({ checks, mounts: expectedMounts, imageId: inspection.Image, isolationPolicy }) };
    handle.runtime = { agentBaseUrl: origin, agentAccessToken, pmCookie: handle.pm.token, workingDirectory: '/workspace', environment: { DOVSPACE_BENCH_RUNTIME_KIND: protocol?.kind ?? 'live' }, environmentHash, environmentEvidence, containerId: id, isolationVerified: true, auditEvents: broker.events,
      providerConfig: { instanceId: 'codex', driver: 'codex', config: { setupMode: 'existing', binaryPath: '/boot/provider-wrapper.sh', homePath: '/provider-home', shadowHomePath: '', launchArgs: '-c model_provider="bench" -c model_providers.bench.name="Benchmark" -c model_providers.bench.base_url="http://127.0.0.1:3901/provider/v1" -c model_providers.bench.wire_api="responses" -c model_providers.bench.env_key="DOVSPACE_BENCH_PROVIDER_KEY"' }, environment: [{ name: 'DOVSPACE_BENCH_PROVIDER_KEY', value: providerToken, sensitive: true }] } };
    return {
      close, get paused() { return paused; },
      async pause() { if (closed) throw new Error('Runtime is closed'); if (!paused) { await inspectOwned(id, owner); await docker(['pause', id]); paused = true; } },
      async resume() { if (closed) throw new Error('Runtime is closed'); if (paused) { await inspectOwned(id, owner); await docker(['unpause', id]); paused = false; } },
      armResponseLoss(targetId) { broker!.armResponseLoss(targetId); },
    };
  } catch (error) {
    let failure = error;
    if (id) {
      const diagnostic = await ownedContainerDiagnostic(id, owner).catch(problem => safeProcessDiagnostic(problem instanceof Error ? problem.message : 'Container diagnostics unavailable'));
      failure = new Error(`${safeProcessDiagnostic(error instanceof Error ? error.message : 'Agent isolation setup failed')}; ${diagnostic}`);
    }
    try { await close(); } catch (cleanup) { throw new AggregateError([failure, cleanup], 'Agent isolation setup and cleanup failed'); }
    throw failure;
  }
}
