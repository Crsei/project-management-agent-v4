import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Layer from "effect/Layer";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import type { NativeProviderAdapter, ProviderDriverContext } from "../driver-adapter.ts";
import { createProviderInstance, providerContext, getProviderSettings, updateProviderSettings } from "../instances.ts";
import { startPmProviderApplication, stopPmProviderApplication } from "../t3code/application.ts";
import { makePmProviderFamily } from "../t3code/registration.ts";
import {
  openCodeDriver, makeOpenCodeDriverLayer, openCodeProtocolResolver,
  openCodeCapabilities, openCodeInstallationMethods,
} from "../t3code/families/opencode.ts";
import { closeStore } from "../../durable/store.ts";
import { createOpenCodeProtocolFixture, type OpenCodeGeneration, type OpenCodeScenario, type OpenCodeProtocolFixture } from "./opencode-protocol-fixture.ts";
import { opencodeAdapter } from "./opencode.ts";

let unsafeTeardown: Error | undefined;

async function within<T>(operation: Promise<T>, milliseconds: number, description: string): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new Error(`OpenCode fixture deadline: ${description}`)), milliseconds);
  try { return await Promise.race([operation, deadline.promise]); }
  finally { clearTimeout(timer); }
}

export interface OpenCodeTestHarness {
  readonly root: string;
  readonly context: ProviderDriverContext;
  readonly wire: OpenCodeProtocolFixture;
  readonly run: NativeProviderAdapter["run"];
  drain(): Promise<void>;
  close(): Promise<void>;
}

/** Actual family assembly, no replacement of the runtime, SDK, adapter or façade. */
export async function createOpenCodeTestHarness(generation: OpenCodeGeneration, options: {
  scenario?: OpenCodeScenario; version?: string; rejectStream?: boolean; htmlOnly?: boolean; rejectMcp?: boolean; externalBusy?: boolean;
} = {}): Promise<OpenCodeTestHarness> {
  if (unsafeTeardown) throw unsafeTeardown;
  const previous = process.env.AGENT_WORKSPACE_DATA_DIR;
  const root = await mkdtemp(join(tmpdir(), "pm-opencode-t8-"));
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  const cwd = join(root, "scoped project 計算");
  const home = join(root, "native-home");
  await mkdir(cwd); await mkdir(home);
  let wire: OpenCodeProtocolFixture | undefined;
  const pending = new Map<Promise<unknown>, AbortController>();
  const expired: Error[] = [];
  let closing: Promise<void> | undefined;
  const run: NativeProviderAdapter["run"] = (context, input) => {
    if (closing) return Promise.reject(new Error("OpenCode fixture is closing"));
    const controller = new AbortController();
    const operation = opencodeAdapter.run(context, { ...input,
      signal: input.signal ? AbortSignal.any([controller.signal, input.signal]) : controller.signal });
    pending.set(operation, controller);
    const deadline = Promise.withResolvers<never>();
    const milliseconds = options.scenario === "disconnect" ? 55_000 : 8_000;
    const timer = setTimeout(() => {
      const error = new Error("OpenCode fixture operation exceeded its native lifecycle deadline");
      expired.push(error); controller.abort(error); deadline.reject(error);
    }, milliseconds);
    const settled = () => { clearTimeout(timer); pending.delete(operation); };
    void operation.then(settled, settled);
    return Promise.race([operation, deadline.promise]);
  };
  const drain = async () => {
    for (const controller of pending.values()) controller.abort(new Error("OpenCode fixture cleanup"));
    await within(Promise.allSettled(pending.keys()), 4_000, "native operation cancellation/drain");
  };
  const close = () => closing ??= (async () => {
    const failures: unknown[] = [...expired];
    let shutdownFinished = false; let wireClosed = false;
    try { await drain(); } catch (error) { failures.push(error); }
    try { await within(stopPmProviderApplication(), 4_000, "original application shutdown"); shutdownFinished = true; }
    catch (error) { failures.push(error); }
    try { await within(wire?.close() ?? Promise.resolve(), 1_000, "owned HTTP/SSE listener shutdown"); wireClosed = true; }
    catch (error) { failures.push(error); }
    if (pending.size || !shutdownFinished || !wireClosed) {
      unsafeTeardown = new AggregateError(failures, "OpenCode fixture did not drain; refusing to switch its process environment");
      throw unsafeTeardown;
    }
    closeStore();
    if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR;
    else process.env.AGENT_WORKSPACE_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
    if (failures.length) throw new AggregateError(failures, "OpenCode fixture lifecycle failed");
  })();
  try {
    wire = await createOpenCodeProtocolFixture({ generation, cwd, ...options });
    const settings = getProviderSettings(); updateProviderSettings(settings.revision, 0);
    const stored = createProviderInstance({ instanceId: "opencode-t8", driver: "opencode",
      config: { binaryPath: join(root, "never-spawn-for-external-server"), serverUrl: wire.url, serverPassword: wire.password },
      environment: [
        { name: "HOME", value: home, sensitive: false },
        ...["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"].map(name => ({ name, value: join(home, name.toLowerCase()), sensitive: false })),
      ],
    });
    await startPmProviderApplication({
      families: new Map([[openCodeDriver.driverKind, makePmProviderFamily(openCodeDriver, (context, runtimeHost) => Layer.merge(
        makeOpenCodeDriverLayer(context, runtimeHost),
        // Original cache, seeded only for offline npm advisory metadata. Runtime
        // version selection still comes from the actual fixture CLI/HTTP probe.
        Layer.effect(ProviderLatestVersions.ProviderLatestVersions,
          ProviderLatestVersions.make([["opencode-ai", "1.18.32"], ["@opencode/cli", "2.1.2"]])),
      ))]]),
      capabilities: new Map([["opencode", openCodeCapabilities]]), installations: new Map([["opencode", openCodeInstallationMethods]]),
      protocols: new Map([["opencode", openCodeProtocolResolver]]),
    });
    return { root, wire, context: providerContext(stored, cwd), run, drain, close };
  } catch (error) { await close(); throw error; }
}

/** A missing fixture event must fail with its provider error, never outlive its test. */
export async function waitForOpenCodeFixtureGate(
  gate: Promise<void>,
  operation: Promise<unknown>,
  signal: AbortSignal,
  description: string,
): Promise<void> {
  signal.throwIfAborted();
  const interrupted = Promise.withResolvers<never>();
  const abort = () => interrupted.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    await within(Promise.race([
      gate,
      operation.then(() => { throw new Error(`Provider completed before fixture gate: ${description}`); }),
      interrupted.promise,
    ]), 5_000, description);
  } finally { signal.removeEventListener("abort", abort); }
}
