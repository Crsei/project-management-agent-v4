import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import type { NativeProviderAdapter } from "../driver-adapter.ts";
import { startPmProviderApplication, stopPmProviderApplication } from "../t3code/application.ts";
import { makePmProviderFamily } from "../t3code/registration.ts";
import { makeAcpRegistryDriverLayer, acpRegistryDriver, acpRegistryCapabilities, acpRegistryProtocolResolver, acpRegistryInstallationMethods } from "../t3code/families/acp-registry.ts";
import { makePmNativeTestHost } from "../t3code/testing/native-test-host.testkit.ts";
import { grokDriver, makeGrokDriverLayer, grokProtocolResolver, grokCapabilities } from "../t3code/families/grok.ts";
import { fxDriver, makeFxDriverLayer, fxProtocolResolver, fxCapabilities } from "../t3code/families/fx.ts";
import { closeStore } from "../../durable/store.ts";
import { grokAdapter } from "./grok.ts";
import { fxAdapter } from "./fx.ts";
import { acpRegistryAdapter } from "./acpRegistry.ts";

type Family = "grok" | "fx" | "acpRegistry";
export interface AcpNativeRecord {
  method?: string; sessionId?: string; cwd?: string; home?: string; agentName?: string; text?: string; args?: string[];
  type?: string; configId?: string; value?: string; enforcedMode?: string; model?: string; effort?: string;
}

/** Real source drivers and execution service, with the shared isolated PM host and no ambient account import. */
export async function createAcpTestHarness(family: Family) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-original-acp-process-"));
  const cwd = path.join(root, "scoped-project");
  const scope = await Effect.runPromise(Scope.make());
  const adapter = { grok: grokAdapter, fx: fxAdapter, acpRegistry: acpRegistryAdapter }[family];
  const pending = new Map<Promise<unknown>, AbortController>();
  let closing = false;
  const run: NativeProviderAdapter["run"] = (context, input) => {
    if (closing) return Promise.reject(new Error("ACP fixture is closing."));
    const abort = new AbortController();
    const operation = adapter.run(context, { ...input,
      signal: input.signal ? AbortSignal.any([input.signal, abort.signal]) : abort.signal });
    pending.set(operation, abort);
    void operation.finally(() => pending.delete(operation)).catch(() => {});
    return operation;
  };
  const close = async () => {
    closing = true;
    for (const abort of pending.values()) abort.abort();
    await Promise.allSettled(pending.keys());
    try { await stopPmProviderApplication(); }
    finally {
      closeStore();
      try { await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  };
  try {
    await mkdir(cwd);
    await writeFile(path.join(root, "native-sessions.json"), "{}");
    await writeFile(path.join(root, "native.ndjson"), "");
    const peer = pathToFileURL(fileURLToPath(new URL("./acp-native-peer.ts", import.meta.url))).href;
    const binary = path.join(root, `${family}-fixture.mjs`);
    // Intentional module boundary: native CLI probes exit before the typed ACP peer opens stdio.
    await writeFile(binary, `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(path.join(root, "native.ndjson"))}, JSON.stringify({
  method: "cli", args, home: process.env.HOME, cwd: process.cwd(),
}) + "\\n");
if (args[0] === "--version") {
  console.log(${JSON.stringify(family === "grok" ? "grok 1.0.99" : "fx 0.0.14")});
  process.exit(0);
}
if (args.join(" ") === "status --json") {
  console.log(JSON.stringify({ auth: "fx login", model: "native/default" }));
  process.exit(0);
}
if (args[0] === "models") {
  console.log(args.includes("--json")
    ? JSON.stringify({ ids: ["native/default", "native/other"] })
    : "You are not authenticated.\\n* native/default (default)\\n- native/other");
  process.exit(0);
}
if (args[0] === "update") {
  console.log("Fixture native updater");
  process.exit(0);
}
await import(${JSON.stringify(peer)});
`, { mode: 0o700 });
    const fixture = await Effect.runPromise(makePmNativeTestHost({ driver: family,
      instanceId: `acp-${family}-native`, prefix: "pm-original-acp-host", cwd,
      config: family === "acpRegistry" ? { source: "local", commandPath: binary, commandArgs: [] } : { binaryPath: binary },
      environment: { PM_ACP_FIXTURE_ROOT: root, PM_ACP_FIXTURE_FAMILY: family, XAI_API_KEY: "" },
    }).pipe(Effect.provideService(Scope.Scope, scope)));
    const latestVersions = Layer.effect(ProviderLatestVersions.ProviderLatestVersions,
      ProviderLatestVersions.make([["@xai-official/grok", "1.0.99"]]));
    await startPmProviderApplication({
      families: new Map([
        makePmProviderFamily(grokDriver, (context, runtimeHost) => Layer.merge(makeGrokDriverLayer(context, runtimeHost), latestVersions)),
        makePmProviderFamily(fxDriver, (context, runtimeHost) => Layer.merge(makeFxDriverLayer(context, runtimeHost), latestVersions)),
        makePmProviderFamily(acpRegistryDriver, (context, runtimeHost) => Layer.merge(makeAcpRegistryDriverLayer(context, runtimeHost), latestVersions)),
      ].map(registration => [registration.driverKind, registration] as const)),
      protocols: new Map([["grok", grokProtocolResolver], ["fx", fxProtocolResolver], ["acpRegistry", acpRegistryProtocolResolver]]),
      capabilities: new Map([["grok", grokCapabilities], ["fx", fxCapabilities], ["acpRegistry", acpRegistryCapabilities]]),
      installations: new Map([["acpRegistry", acpRegistryInstallationMethods]]),
    });
    return { root, context: fixture.context, adapter, run, close,
      records: async (): Promise<AcpNativeRecord[]> => (await readFile(path.join(root, "native.ndjson"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
  } catch (error) { await close(); throw error; }
}
