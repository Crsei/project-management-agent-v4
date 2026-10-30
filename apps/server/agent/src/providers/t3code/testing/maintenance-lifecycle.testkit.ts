import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import { closeStore } from "../../../durable/store.ts";
import type { ProviderDriverContext } from "../../driver-adapter.ts";
import { createProviderInstance, getStoredInstance, providerContext } from "../../instances.ts";
import { stopPmProviderApplication, type PmProviderApplicationOptions } from "../application.ts";
import { codexDriver, makeCodexDriverLayer } from "../families/codex.ts";
import type { PmProviderInstallationMethods } from "../management.ts";
import { makePmProviderFamily } from "../registration.ts";

export interface ControlledInstallation {
  readonly prepare: NonNullable<PmProviderInstallationMethods["prepare"]>;
  readonly entered: PromiseWithResolvers<void>;
  readonly cancelled: PromiseWithResolvers<void>;
  readonly download: PromiseWithResolvers<void>;
  readonly cleanupEntered: PromiseWithResolvers<void>;
  readonly cleanupRelease: PromiseWithResolvers<void>;
  readonly cleanupFinished: PromiseWithResolvers<void>;
  readonly signal: () => AbortSignal | undefined;
  readonly calls: () => number;
}

export function controlledInstallation(): ControlledInstallation {
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const download = Promise.withResolvers<void>();
  const cleanupEntered = Promise.withResolvers<void>();
  const cleanupRelease = Promise.withResolvers<void>();
  const cleanupFinished = Promise.withResolvers<void>();
  let receivedSignal: AbortSignal | undefined;
  let calls = 0;
  const prepare: NonNullable<PmProviderInstallationMethods["prepare"]> = async (_context, signal) => {
    calls++;
    receivedSignal = signal;
    const aborted = Promise.withResolvers<never>();
    const abort = () => { cancelled.resolve(); aborted.reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
    entered.resolve();
    try {
      if (signal?.aborted) abort();
      await Promise.race([download.promise, aborted.promise]);
      return { message: "Controlled installation completed." };
    } finally {
      signal?.removeEventListener("abort", abort);
      cleanupEntered.resolve();
      await cleanupRelease.promise;
      cleanupFinished.resolve();
    }
  };
  return { prepare, entered, cancelled, download, cleanupEntered, cleanupRelease, cleanupFinished,
    signal: () => receivedSignal, calls: () => calls };
}

/** Production application/host/lease paths, with only the installer download and cleanup controlled. */
export async function maintenanceLifecycleFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-maintenance-lifecycle-"));
  const previous = process.env.AGENT_WORKSPACE_DATA_DIR;
  process.env.AGENT_WORKSPACE_DATA_DIR = root;
  const installations = new Map<string, ControlledInstallation>();
  const closed: string[] = [];
  const driver: typeof codexDriver = { ...codexDriver, create: (...args) => Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => { closed.push(String(args[0].instanceId)); }));
    return yield* codexDriver.create(...args);
  }) };
  const options: PmProviderApplicationOptions = {
    families: new Map([[driver.driverKind, makePmProviderFamily(driver, makeCodexDriverLayer)]]),
    protocols: new Map(),
    installations: new Map([["codex", {
      prepare: (context, signal, progress, lease) => {
        const installation = installations.get(context.instanceId);
        assert.ok(installation, "The test must explicitly admit each controlled installation.");
        return installation.prepare(context, signal, progress, lease);
      },
    }]]),
  };
  const account = (id: string) => {
    const instance = createProviderInstance({ instanceId: id, driver: "codex", config: { setupMode: "managed", binaryPath: path.join(root, id, "controlled-codex") },
      environment: [{ name: "HOME", value: path.join(root, id, "native-home"), sensitive: false },
        { name: "PATH", value: "", sensitive: false }] });
    const installation = controlledInstallation();
    installations.set(id, installation);
    return { instance, installation,
      context: () => providerContext(getStoredInstance(id)!, root) };
  };
  const provisional = (id: string): ProviderDriverContext => ({ instanceId: id, driver: "codex", revision: 1,
    config: { setupMode: "managed" }, cwd: root, env: { HOME: path.join(root, id, "native-home"), PATH: "" },
    homeDirectory: path.join(root, id, "native-home", ".codex"), stateDirectory: path.join(root, id) });
  return { root, options, account, provisional, installations, closed,
    close: async () => {
      for (const installation of installations.values()) {
        installation.download.resolve();
        installation.cleanupRelease.resolve();
      }
      await stopPmProviderApplication();
      closeStore();
      if (previous === undefined) delete process.env.AGENT_WORKSPACE_DATA_DIR; else process.env.AGENT_WORKSPACE_DATA_DIR = previous;
      await rm(root, { recursive: true, force: true });
    },
  };
}
