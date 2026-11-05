import { ProviderDriverKind, ProviderInstanceConfig, ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import path from "node:path";
import type { ProviderConfig, ProviderDriver } from "@agent-workspace/contracts/provider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";
import type { StoredProviderInstance } from "../instances.ts";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import type { PmProviderBoundaryError } from "./contract.ts";
import { ClaudeSettings } from "@t3tools/contracts";
import { claudeLaunchFlags } from "../../../../../../vendor/t3code/apps/server/src/provider/Drivers/ClaudeLaunchArgs.ts";
import { BUNDLED_CLAUDE_MODEL_CATALOG, resolveClaudeModelSlug } from "../../../../../../vendor/t3code/apps/server/src/provider/ClaudeModelCatalog.ts";
import { PiSettings } from "@t3tools/provider-pi/settings";
import { resolvePiLaunchArgs } from "../../../../../../vendor/t3code/packages/provider-pi/src/server/mcpInjection.ts";

export function validatePiConfig(config: ProviderConfig): ProviderConfig {
  for (const [key, value] of Object.entries(config)) {
    if (!["binaryPath", "launchArgs"].includes(key)) throw new Error(`Unknown Pi setting: ${key}.`);
    if (typeof value !== "string" || value.includes("\0")) throw new Error(`Pi ${key} must be a string without NUL characters.`);
  }
  const decoded = Schema.decodeUnknownSync(PiSettings)(config);
  const launch = resolvePiLaunchArgs(decoded.launchArgs);
  if (!launch.ok) throw new Error(launch.message);
  return { binaryPath: decoded.binaryPath, launchArgs: decoded.launchArgs };
}

/** Native aliases are resolved at the same host boundary as native configuration. */
export function canonicalProviderModelId(driver: ProviderDriver, modelId: string): string {
  return driver === "claude" ? resolveClaudeModelSlug(BUNDLED_CLAUDE_MODEL_CATALOG, modelId) : modelId;
}

export function validateClaudeConfig(config: ProviderConfig): ProviderConfig {
  const keys = ["binaryPath", "homePath", "launchArgs", "autoCompactWindow", "idleCompaction"];
  for (const [key, value] of Object.entries(config)) {
    if (!keys.includes(key)) throw new Error(`Unknown Claude setting: ${key}.`);
    if (typeof value !== "string" || value.includes("\0")) throw new Error(`Claude ${key} must be a string without NUL characters.`);
  }
  const decoded = Schema.decodeUnknownSync(ClaudeSettings)({ ...config, binaryPath: config.binaryPath || "claude" });
  claudeLaunchFlags(decoded.launchArgs);
  return { binaryPath: decoded.binaryPath, homePath: decoded.homePath, launchArgs: decoded.launchArgs,
    autoCompactWindow: decoded.autoCompactWindow, idleCompaction: decoded.idleCompaction };
}

export function providerBoundaryError(message: string, code = "session_mismatch", status = 409): PmProviderBoundaryError {
  return Object.assign(new Error(message), { code, status });
}
export function toT3DriverKind(driver: ProviderDriver): ProviderDriverKind {
  return ProviderDriverKind.make(driver === "claude" ? "claudeAgent" : driver);
}
export function fromT3DriverKind(driver: ProviderDriverKind): ProviderDriver | undefined {
  switch (driver) {
    case "claudeAgent": return "claude";
    case "codex": return "codex";
    case "cursor": return "cursor";
    case "grok": return "grok";
    case "opencode": return "opencode";
    case "antigravity": return "antigravity";
    case "muse": return "muse";
    case "pi": return "pi";
    case "omp": return "omp";
    case "acpRegistry": return "acpRegistry";
    case "fx": return "fx";
    default: return undefined;
  }
}
export function projectProviderInstance(instance: StoredProviderInstance, context?: ProviderDriverContext): ProviderInstanceConfig {
  // Decode IDs rather than make unchecked brands: historical rows remain untouched on disk.
  Schema.decodeUnknownSync(ProviderInstanceId)(instance.instanceId);
  const env = context?.instanceEnvironment ?? instance.env;
  const config = { ...(context?.config ?? instance.config) };
  if (instance.driver === "codex" && config.setupMode === "managed") {
    // The original managed Home override and the PM lease describe the same existing private Home.
    config.homePath = context?.homeDirectory ?? instance.homeDirectory;
    config.shadowHomePath = "";
  } else if (instance.driver === "claude" && typeof config.homePath === "string" && config.homePath.trim()) {
    // Resolve explicit ~ with the bound native user Home, never the server user's global Home.
    config.homePath = context?.homeDirectory ?? instance.homeDirectory;
  }
  if (context && typeof config.binaryPath === "string" && config.binaryPath.includes(path.sep)
    && !path.isAbsolute(config.binaryPath) && !config.binaryPath.startsWith("~/"))
    config.binaryPath = path.resolve(context.cwd, config.binaryPath);
  return Schema.decodeUnknownSync(ProviderInstanceConfig)({
    driver: toT3DriverKind(instance.driver), displayName: instance.label || undefined,
    accentColor: instance.accentColor, enabled: instance.enabled && instance.config.enabled !== false,
    environment: Object.entries(env).map(([name, value]) => ({ name, value, sensitive: instance.envSensitivity?.[name] ?? true })),
    config: { ...config, enabled: instance.enabled && instance.config.enabled !== false,
      customModels: (context?.customModels ?? instance.customModels ?? []).map(model => ({ slug: model.id, name: model.label, capabilities: model.capabilities })) },
  });
}
export function decodeProviderConfig<R>(driver: AnyProviderDriver<R>, entry: ProviderInstanceConfig) {
  return Schema.decodeUnknownEffect(driver.configSchema)(entry.config).pipe(
    Effect.mapError(() => providerBoundaryError("Provider configuration is incompatible with its source schema.", "invalid_config", 409)),
  );
}
export function projectProviderSettings(storedInstances: readonly StoredProviderInstance[], healthRefreshIntervalSeconds: number, cursorKeychainUsageEnabled: boolean): ServerSettings {
  // Local historical IDs remain readable; an unrepresentable ID fails explicitly when selected for acquire.
  const instances = storedInstances.filter(instance => Schema.is(ProviderInstanceId)(instance.instanceId));
  return Schema.decodeUnknownSync(ServerSettings)({
    providerInstances: Object.fromEntries(instances.map(instance => [instance.instanceId, projectProviderInstance(instance)])),
    favorites: instances.flatMap(instance => (instance.modelPreferences?.favorites ?? []).map(model => ({ provider: instance.instanceId, model }))),
    providerModelPreferences: Object.fromEntries(instances.map(instance => [instance.instanceId, {
      hiddenModels: instance.modelPreferences?.hidden ?? [], modelOrder: instance.modelPreferences?.order ?? [],
    }])),
    providerHealthRefreshInterval: healthRefreshIntervalSeconds * 1000,
    cursorKeychainUsageEnabled,
    enableProviderUpdateChecks: true,
    continueThreadsAfterServerUpdate: false,
    enableAgentBrowserAccess: false,
    automaticGitFetchInterval: 0,
    compactIdleThreads: false,
  });
}
