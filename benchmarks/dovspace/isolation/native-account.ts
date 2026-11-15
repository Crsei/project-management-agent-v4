import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchmarkConfig } from '../benchmark.config.ts';
import { cleanEnvironment } from './docker.ts';

export type NativeAccountRelay = { socketPath: string; capability: string; evidence: Record<string, unknown>; close(): Promise<void> };
export type NativeAccountCatalog = {
  sdkVersion: string; sdkLockSha256: string; catalogSha256: string; bunVersion: string;
  model: { id: string; provider: string; api: string; baseUrl: string };
  ompModel: NonNullable<BenchmarkConfig['ompModel']>; prices: NonNullable<BenchmarkConfig['prices']>;
  accounts?: { accountRowId: number; accountFingerprint: string }[];
  [key: string]: unknown;
};
type HostSdkAccess = Pick<NonNullable<BenchmarkConfig['hostAuthAccess']>, 'sdkRoot' | 'bunBinary'> & { authStorePath?: string };

/** Explicit trusted-host SDK only. Neither inherited HOME nor provider environment is passed. */
async function launch(mode: 'catalog' | 'accounts' | 'serve', access: HostSdkAccess, input: Record<string, unknown>, timeoutMs: number): Promise<{ metadata: NativeAccountCatalog; socketPath: string; close(): Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), 'dovspace-native-account-'));
  const socketPath = path.join(root, 'relay.sock');
  const child = spawn(access.bunBinary, [fileURLToPath(new URL('./native-account-relay.mjs', import.meta.url))], { cwd: root, env: cleanEnvironment({ HOME: root, PI_CODING_AGENT_DIR: root }), stdio: ['pipe', 'pipe', 'ignore'] });
  const ready = Promise.withResolvers<NativeAccountCatalog>();
  const exited = Promise.withResolvers<void>();
  let output = '', settled = false, closed = false;
  const timer = setTimeout(() => { ready.reject(new Error('Native OMP SDK startup deadline; no fallback was attempted')); child.kill('SIGKILL'); }, timeoutMs);
  child.stdout.on('data', (chunk: Buffer) => {
    if (settled) return;
    output += chunk.toString('utf8');
    if (output.length > 65536) { ready.reject(new Error('Native SDK returned invalid nonsecret metadata')); child.kill('SIGKILL'); return; }
    const end = output.indexOf('\n');
    if (end < 0) return;
    try {
      const metadata = JSON.parse(output.slice(0, end)) as NativeAccountCatalog;
      if (metadata.sdkVersion !== '18.15.0' || metadata.model?.id !== 'gpt-6.1-sol' || metadata.model.provider !== 'openai-codex' || metadata.model.api !== 'openai-codex-responses' || !/^[a-f0-9]{64}$/.test(metadata.catalogSha256) || !/^[a-f0-9]{64}$/.test(metadata.sdkLockSha256)) throw new Error();
      settled = true; clearTimeout(timer); ready.resolve(metadata);
    } catch { ready.reject(new Error('Native SDK returned invalid nonsecret metadata')); child.kill('SIGKILL'); }
  });
  child.once('error', () => ready.reject(new Error('Explicit trusted-host Bun/OMP SDK prerequisite unavailable')));
  child.once('close', () => { clearTimeout(timer); exited.resolve(); if (!settled) ready.reject(new Error('Native SDK prerequisite unavailable: require official18.15.0 SDK/catalog, Bun>=1.4.4 and explicit owned account selection; diagnostics withheld')); });
  child.stdin.on('error', () => { /* Process exit is the authoritative prerequisite failure. */ });
  child.stdin.end(JSON.stringify({ mode, access, socketPath, ...input }));
  async function close(): Promise<void> {
    if (closed) return;
    closed = true; clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    // SDK18.15 allows60s for an exchanged refresh token plus60s to persist it.
    // Cutting this short can strand the selected existing account.
    let forced = false;
    const kill = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, mode === 'serve' ? 130_000 : 2000);
    try { await exited.promise; } finally { clearTimeout(kill); await rm(root, { recursive: true, force: true }); }
    if (forced) throw new Error('Native SDK shutdown exceeded its refresh-persistence drain; selected account state is unknown');
  }
  try {
    const metadata = await ready.promise;
    if (mode !== 'serve') await close();
    return { metadata, socketPath, close };
  } catch (error) { await close(); throw error; }
}

export async function readNativeAccountCatalog(access: HostSdkAccess, accounts = false): Promise<NativeAccountCatalog> {
  if (accounts && !access.authStorePath) throw new Error('Account metadata requires the explicitly selected host SDK credential store');
  return (await launch(accounts ? 'accounts' : 'catalog', access, {}, 30_000)).metadata;
}
export async function startNativeAccountRelay(config: BenchmarkConfig, deadline: number): Promise<NativeAccountRelay> {
  if (!config.hostAuthBoundary || !config.hostAuthAccess) throw new Error('Native account transport requires explicit hostAuthBoundary and host-only --omp-sdk-root/--omp-bun/--omp-auth-store; no host account is inherited');
  const capability = randomBytes(32).toString('base64url');
  const launched = await launch('serve', config.hostAuthAccess, { boundary: config.hostAuthBoundary, ompModel: config.ompModel, prices: config.prices, capability, deadline }, config.startupTimeoutMs);
  if (launched.metadata.accountMetadataMatched !== true) { await launched.close(); throw new Error('Native SDK did not attest the explicitly selected existing account metadata'); }
  return { socketPath: launched.socketPath, capability, evidence: { selection: config.hostAuthBoundary, ...launched.metadata, authentication: 'explicit-host-sdk-oauth-account', credentialLocation: 'trusted-host-only', accountFallback: false, redirects: false }, close: launched.close };
}
