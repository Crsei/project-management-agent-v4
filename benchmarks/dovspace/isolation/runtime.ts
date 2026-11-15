import { createHash, randomBytes } from 'node:crypto';
import { cp, chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ompModelSelector, repositoryRoot, type BenchmarkConfig } from '../benchmark.config.ts';
import type { FixtureHandle } from '../schemas/types.ts';
import type { RuntimeStartOptions } from '../fixtures/manager.ts';
import { digest } from '../fixtures/snapshot.ts';
import { docker, inspectOwned, ownedContainerDiagnostic, OWNER_LABEL, registerProcessSecrets, removeOwnedName, safeProcessDiagnostic } from './docker.ts';
import { startBroker, type Broker } from './broker.ts';
import { openSocketDirectory, type SocketDirectory } from './filesystem.ts';
import { collectSourceManifest, type StagedProductSource } from './source.ts';
import { createControlledOmpProvider } from './controlled-provider.ts';
import { startNativeAccountRelay, type NativeAccountRelay } from './native-account.ts';
import { forwardRequest } from './container-bridge.mjs';

export interface OwnedRuntime { readonly paused: boolean; pause(): Promise<void>; resume(): Promise<void>; close(): Promise<void>; armResponseLoss(targetId: string): void }
export function startIsolatedRuntime(config: BenchmarkConfig, handle: FixtureHandle, owner: string, options: RuntimeStartOptions, pmServiceSecret: string, source: StagedProductSource): Promise<OwnedRuntime> { return allocateRuntime(config, handle, owner, options, pmServiceSecret, source); }
export function startProtocolIsolatedRuntime(config: BenchmarkConfig, handle: FixtureHandle, owner: string, options: RuntimeStartOptions, pmServiceSecret: string, controlledProviderScript: string, source: StagedProductSource): Promise<OwnedRuntime> {
  if (config.provider !== 'codex') throw new Error('The existing controlled RPC peer calibrates Codex only; OMP requires its real native HTTP-provider protocol');
  return allocateRuntime(config, handle, owner, options, pmServiceSecret, source, { kind: 'protocol-calibration', controlledProviderScript });
}
export function startOmpControlledRuntime(config: BenchmarkConfig, handle: FixtureHandle, owner: string, options: RuntimeStartOptions, pmServiceSecret: string, source: StagedProductSource): Promise<OwnedRuntime> {
  if (config.provider !== 'omp' || config.providerApi !== 'openai-completions' || config.model !== 'omp-controlled-protocol' || config.providerEndpoint || config.providerApiKey) throw new Error('Native OMP protocol requires explicit controlled model/transport and refuses real credentials/endpoints');
  return allocateRuntime(config, handle, owner, options, pmServiceSecret, source, { kind: 'omp-controlled-http' });
}
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
async function allocateRuntime(config: BenchmarkConfig, handle: FixtureHandle, owner: string, options: RuntimeStartOptions, pmServiceSecret: string, staged: StagedProductSource, protocol?: { kind: 'protocol-calibration'; controlledProviderScript: string } | { kind: 'omp-controlled-http' }): Promise<OwnedRuntime> {
  if (!protocol && (!config.model || (config.hostAuthBoundary ? !config.hostAuthAccess : !config.providerEndpoint || !config.providerApiKey))) throw new Error('Provider prerequisite missing: explicitly select a native host account with SDK access, or model/HTTPS endpoint/API key; no harness credentials are inherited');
  if (config.provider === 'omp' && !config.ompModel) throw new Error('OMP requires explicit native model limits/reasoning metadata; catalog defaults are not measurement evidence');
  if (!protocol && options.budget.maxCostUsd !== null && !config.prices) throw new Error('Cost budget requires explicit conservative token prices and output cap');
  const uid = process.getuid?.(), gid = process.getgid?.();
  if (uid === undefined || gid === undefined || uid === 0) throw new Error('Benchmark Agent requires a non-root Linux owner');
  const name = `dovspace-bench-agent-${handle.fixtureId.replaceAll('-', '')}`;
  const source = staged.root, boot = path.join(handle.root, 'bootstrap'), sockets = path.join(handle.root, 'sockets'), home = path.join(handle.root, 'provider-home');
  for (const directory of [boot, sockets, home]) await mkdir(directory, { mode: 0o700 });
  const dependencies = staged.dependencies, observedSource = await collectSourceManifest(source);
  if (digest(observedSource) !== digest(staged.manifest)) throw new Error('Immutable product source changed after PM startup');
  const sourceIdentity = { sourceHash: staged.manifest.sourceHash, sourceFileCount: staged.manifest.files.length, sourceFiles: staged.manifest.files, lockfileHash: staged.manifest.files.find(entry => entry.path === 'pnpm-lock.yaml')!.sha256, dependencyManifest: staged.dependencyManifest };
  const agentAccessToken = randomBytes(32).toString('base64url'), providerToken = randomBytes(32).toString('base64url');
  registerProcessSecrets([config.providerApiKey, agentAccessToken, pmServiceSecret, providerToken, handle.pm.token]);
  let broker: Broker | undefined, nativeAccountRelay: NativeAccountRelay | undefined, control: Server | undefined, controlled: Server | undefined, id = '', closed = false, paused = false;
  let socketDirectory: SocketDirectory | undefined;
  async function close(): Promise<void> {
    if (closed) return;
    const errors: unknown[] = [];
    for (const action of [async () => removeOwnedName(name, owner), async () => stopServer(controlled), async () => broker?.close(), async () => nativeAccountRelay?.close(), async () => stopServer(control)]) try { await action(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Isolated Agent cleanup failed');
    await socketDirectory?.close();
    closed = true;
  }
  try {
    socketDirectory = await openSocketDirectory(sockets);
    if (protocol?.kind === 'omp-controlled-http') {
      controlled = createControlledOmpProvider(handle);
      const listening = Promise.withResolvers<void>();
      controlled.once('error', listening.reject); controlled.listen(socketDirectory.socketPath('controlled.sock'), listening.resolve);
      await listening.promise;
      await chmod(path.join(sockets, 'controlled.sock'), 0o600);
    }
    if (config.hostAuthBoundary) nativeAccountRelay = await startNativeAccountRelay(config, Date.now() + options.budget.maxDurationMinutes * 60_000);
    broker = await startBroker(config, handle, { ...options, providerToken, socketPath: socketDirectory.socketPath('host.sock'), agentSocketPath: socketDirectory.socketPath('agent.sock'), agentAccessToken, pmServiceSecret, ...(controlled ? { controlledProviderSocketPath: socketDirectory.socketPath('controlled.sock') } : {}), ...(nativeAccountRelay ? { nativeAccountRelay } : {}) });
    await chmod(path.join(sockets, 'host.sock'), 0o600);
    await cp(new URL('./container-bridge.mjs', import.meta.url), path.join(boot, 'bridge.mjs'));
    await cp(path.join(source, 'packages/pm-cli/agent-tools.mjs'), path.join(boot, 'agent-tools.mjs'));
    if (protocol?.kind === 'protocol-calibration') await writeFile(path.join(boot, 'protocol-provider.mjs'), protocol.controlledProviderScript.startsWith('#!') ? protocol.controlledProviderScript : `#!/usr/bin/env node\n${protocol.controlledProviderScript}`, { mode: 0o700, flag: 'wx' });
    // Native commands get neither the Agent server mount nor its PID namespace.
    const nativeArgs = ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/etc', '--ro-bind', '/etc/ssl', '/etc/ssl', '--ro-bind', '/boot/agent-tools.mjs', '/source/packages/pm-cli/agent-tools.mjs', '--bind', '/workspace', '/workspace', '--bind', '/provider-home', '/provider-home', '--chdir', '/workspace', '--clearenv', '--setenv', 'HOME', '/provider-home', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'DOVSPACE_BENCH_PROVIDER_KEY', providerToken];
    if (config.provider === 'codex') nativeArgs.push('--setenv', 'CODEX_HOME', '/provider-home');
    else nativeArgs.push('--setenv', 'PI_CODING_AGENT_DIR', '/provider-home/.omp/agent');
    // Rayon sees host CPUs on some cgroup-v1 hosts; match this runtime's two-CPU quota.
    nativeArgs.push('--setenv', 'RAYON_NUM_THREADS', '2');
    if (config.hostAuthBoundary) nativeArgs.push('--setenv', 'PI_CODEX_WEBSOCKET', '0', '--setenv', 'PI_REQUEST_COMPRESSION', '0');
    if (protocol?.kind === 'protocol-calibration') nativeArgs.push('--ro-bind', '/boot/protocol-provider.mjs', '/opt/bench-protocol-provider.mjs');
    const providerCommand = protocol?.kind === 'protocol-calibration' ? ['/usr/local/bin/node', '/opt/bench-protocol-provider.mjs'] : [config.providerBinary];
    if (!/^\/[A-Za-z0-9_./-]+$/.test(config.providerBinary)) throw new Error('Provider binary path contains unsafe characters');
    await cp(new URL('./native-launcher.mjs', import.meta.url), path.join(boot, 'native-launcher.mjs'));
    await writeFile(path.join(boot, 'native-launch.json'), JSON.stringify({ provider: config.provider, args: nativeArgs, command: providerCommand }), { mode: 0o600, flag: 'wx' });
    await writeFile(path.join(boot, 'provider-wrapper.sh'), '#!/bin/sh\nexec /usr/bin/env -i /usr/local/bin/node /boot/native-launcher.mjs "$@"\n', { mode: 0o700, flag: 'wx' });
    let nativeConfigHash: string | null = null;
    if (config.provider === 'omp') {
      const metadata = config.ompModel!;
      const nativeProvider = config.hostAuthBoundary?.provider ?? 'bench';
      const provider = { api: config.providerApi, baseUrl: 'http://127.0.0.1:3901/provider/v1', apiKey: providerToken, models: [{ id: config.model, name: config.model, input: ['text'], supportsTools: true, ...metadata, ...(config.prices ? { cost: { input: config.prices.inputPerMillion, output: config.prices.outputPerMillion, ...(config.prices.cacheReadPerMillion === undefined ? {} : { cacheRead: config.prices.cacheReadPerMillion }), ...(config.prices.cacheWritePerMillion === undefined ? {} : { cacheWrite: config.prices.cacheWritePerMillion }) } } : {}) }] };
      const catalog = { providers: { [nativeProvider]: provider } };
      await mkdir(path.join(home, '.omp', 'agent'), { recursive: true, mode: 0o700 });
      await writeFile(path.join(home, '.omp', 'agent', 'models.yml'), JSON.stringify(catalog), { mode: 0o600, flag: 'wx' });
      const thinking = typeof config.modelOptions.thinking === 'string' ? config.modelOptions.thinking : metadata.reasoning ? metadata.thinking?.defaultLevel : 'off';
      const selector = `${ompModelSelector(config)}${thinking ? `:${thinking}` : ''}`;
      const nativeSettings = config.hostAuthBoundary ? { modelRoles: Object.fromEntries(['default', 'smol', 'slow', 'plan', 'tiny'].map(role => [role, selector])), retry: { enabled: false, modelFallback: false, usageAwareFallback: false, fallbackChains: {} }, prewalk: { enabled: false }, contextPromotion: { enabled: false }, compaction: { enabled: false } } : { modelRoles: { default: selector } };
      await writeFile(path.join(home, '.omp', 'agent', 'config.yml'), JSON.stringify(nativeSettings), { mode: 0o600, flag: 'wx' });
      nativeConfigHash = digest({ catalog: { providers: { [nativeProvider]: { ...provider, apiKey: '[RUN_SCOPED_BROKER_CAPABILITY]' } } }, settings: nativeSettings, ...(config.hostAuthBoundary ? { transport: { websocket: false, requestCompression: false, compaction: false } } : {}) });
    }
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
    const isolationPolicy = { networkMode: inspection.HostConfig.NetworkMode, readOnlyRoot: inspection.HostConfig.ReadonlyRootfs, user: inspection.Config.User, capDrop: inspection.HostConfig.CapDrop, securityOpt: inspection.HostConfig.SecurityOpt, pidMode: inspection.HostConfig.PidMode, privileged: inspection.HostConfig.Privileged, maskedPaths: inspection.HostConfig.MaskedPaths ?? [], readOnlyPaths: inspection.HostConfig.ReadonlyPaths ?? [], appArmorProfile: inspection.AppArmorProfile, nativeRayonThreads: 2, nativeBoundary: 'Bubblewrap private user/PID/mount namespaces and private proc; no Agent/source/broker/authority mounts; outer network-none' };
    const probe = `const f=require('node:fs');for(const p of ${JSON.stringify([handle.authorityRoot, repositoryRoot + '/benchmarks/dovspace/graders', '/source/benchmarks', '/var/run/docker.sock', '/root/.env', '/source/.env'])}){if(f.existsSync(p))process.exit(41)};try{f.writeFileSync('/authority-probe','x');process.exit(42)}catch{};process.stdout.write('outer-denied')`;
    const outer = await docker(['exec', id, 'node', '-e', probe]);
    if (outer !== 'outer-denied') throw new Error('Agent authority denial probe failed');
    const nestedProbe = `const f=require('node:fs');for(const p of ['/source/apps','/source/benchmarks','/source/packages/domain','/agent-data','/broker','/boot','/proc/1/root/source/apps','/var/run/docker.sock']){if(f.existsSync(p))process.exit(43)};if(f.existsSync('/proc/1/environ')){const e=f.readFileSync('/proc/1/environ','utf8');if(e.includes('AGENT_WORKSPACE_ACCESS_TOKEN')||e.includes('PM_AUTOMATION_SERVICE_SECRET'))process.exit(44)}if(!f.existsSync('/source/packages/pm-cli/agent-tools.mjs'))process.exit(45);process.stdout.write('nested-denied')`;
    const nested = await docker(['exec', id, '/usr/bin/env', '-i', '/usr/bin/bwrap', ...nativeArgs, '--', '/usr/local/bin/node', '-e', nestedProbe]);
    if (nested !== 'nested-denied') throw new Error('Native provider isolation probe failed');
    control = createServer((incoming, outgoing) => forwardRequest({ socketPath: socketDirectory!.socketPath('agent.sock'), path: incoming.url ?? '/' }, incoming, outgoing));
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
    const executable = JSON.parse(await docker(['exec', id, '/usr/local/bin/node', '-e', 'const f=require("node:fs"),c=require("node:crypto");const p=f.realpathSync(process.argv[1]);process.stdout.write(JSON.stringify({path:process.argv[1],resolvedPath:p,sha256:c.createHash("sha256").update(f.readFileSync(p)).digest("hex")}))', config.providerBinary])) as { path: string; resolvedPath: string; sha256: string };
    const nativeVersion = protocol?.kind === 'protocol-calibration' ? 'controlled-codex-rpc-peer' : await docker(['exec', id, '/boot/provider-wrapper.sh', '--version']);
    if (config.provider === 'omp') {
      const version = /(?:^|[\s/])(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(nativeVersion);
      if (!version || Number(version[1]) < 18 || Number(version[1]) === 18 && (Number(version[2]) < 13 || Number(version[2]) === 13 && Number(version[3]) < 2)) throw new Error('OMP 18.13.2 or newer with native RPC v2 is required');
      if (config.hostAuthBoundary && nativeVersion.trim() !== 'omp/18.15.0') throw new Error('Native account study requires the exact existing OMP18.15.0 image executable');
    }
    const observationPolicy = { version: 'broker-wire-v1', requestBoundary: 'exact broker-forwarded OpenAI HTTP JSON; run-scoped capability replaced before export', piReqDebug: false, reason: 'Broker observes the authenticated final transport, cannot be overwritten by native process restarts, avoids untrusted cwd rr-session files and captures terminal usage/missing stream evidence.', ompSkills: 'disabled', hostTools: 'generation-owned pm_* essential; unchanged native permission gate' };
    const environmentEvidence = { ...sourceIdentity, imageIds: handle.imageIds, nodeVersion, isolationPolicy, runtimeKind: protocol?.kind ?? 'live', protocolScriptHash: protocol?.kind === 'protocol-calibration' ? createHash('sha256').update(protocol.controlledProviderScript).digest('hex') : null, provider: { driver: config.provider, model: config.model, api: config.providerApi, executable: { ...executable, version: nativeVersion }, nativeConfigHash, declaredModelMetadata: config.ompModel ?? null, prices: config.prices ?? null, ...(nativeAccountRelay ? { hostAuthBoundary: config.hostAuthBoundary, nativeAccountEvidence: nativeAccountRelay.evidence, nativeModel: ompModelSelector(config) } : {}) }, observationPolicy };
    const environmentHash = digest(environmentEvidence);
    handle.isolation = { backend: 'docker', verified: true, containerId: id, networkId: 'none', checks, imageIds: handle.imageIds, effectivePolicy: isolationPolicy, proofDigest: digest({ checks, mounts: expectedMounts, imageId: inspection.Image, isolationPolicy }) };
    handle.runtime = { agentBaseUrl: origin, agentAccessToken, pmCookie: handle.pm.token, workingDirectory: '/workspace', environment: { DOVSPACE_BENCH_RUNTIME_KIND: protocol?.kind ?? 'live' }, environmentHash, environmentEvidence, containerId: id, isolationVerified: true, auditEvents: broker.events,
      providerConfig: config.provider === 'codex' ? { instanceId: 'codex', driver: 'codex', config: { setupMode: 'existing', binaryPath: '/boot/provider-wrapper.sh', homePath: '/provider-home', shadowHomePath: '', launchArgs: '-c model_provider="bench" -c model_providers.bench.name="Benchmark" -c model_providers.bench.base_url="http://127.0.0.1:3901/provider/v1" -c model_providers.bench.wire_api="responses" -c model_providers.bench.env_key="DOVSPACE_BENCH_PROVIDER_KEY"' }, environment: [{ name: 'DOVSPACE_BENCH_PROVIDER_KEY', value: providerToken, sensitive: true }] } : { instanceId: 'omp', driver: 'omp', config: { binaryPath: '/boot/provider-wrapper.sh', launchArgs: '--no-skills --no-rules --no-context-files --no-lsp --no-pty --no-title' }, environment: [{ name: 'HOME', value: '/provider-home', sensitive: false }, { name: 'PI_CODING_AGENT_DIR', value: '/provider-home/.omp/agent', sensitive: false }] } };
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
