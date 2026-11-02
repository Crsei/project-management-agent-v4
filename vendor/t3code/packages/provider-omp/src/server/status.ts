import type { ModelCapabilities, ServerProviderAuth, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { OmpSettings } from "../settings.ts";
import { buildOmpRpcLaunch, resolveOmpLaunchArgs } from "./launch.ts";
import { parseOmpDiscoveredCommands } from "./commands.ts";
import {
  makeOmpRpcConnection, OmpRpcError, OmpRpcTimeoutError,
  ompRecordField, ompRecordString,
} from "./rpc.ts";

export const MINIMUM_OMP_VERSION = "18.13.2";
/** Includes version, startup/v2 and subsequent discovery; also used by the PM catalog. */
export const OMP_STATUS_TIMEOUT_MS = 120_000;
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const PRESENTATION = {
  displayName: "Oh My Pi",
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["approval-required"],
  reportsContextWindow: true,
} as const;
const THINKING_LEVELS: Readonly<Record<string, string>> = {
  off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max",
};

export function parseOmpThinkingLevels(data: unknown): ReadonlyArray<string> {
  const levels = ompRecordField(data, "levels");
  if (!Array.isArray(levels) || levels.length === 0 || levels.some((level) => typeof level !== "string" || !Object.hasOwn(THINKING_LEVELS, level))) {
    throw new OmpRpcError({ operation: "get_available_thinking_levels", detail: "Invalid native thinking levels" });
  }
  return [...new Set(levels as string[])];
}

function thinkingCapabilities(levels: ReadonlyArray<string>, defaultLevel: string | undefined): ModelCapabilities {
  if (levels.length === 0 || (levels.length === 1 && levels[0] === "off")) return EMPTY_CAPABILITIES;
  return createModelCapabilities({
    optionDescriptors: [{
      id: "thinking", label: "Thinking", type: "select",
      options: levels.map((id) => ({ id, label: THINKING_LEVELS[id]!, ...(id === defaultLevel ? { isDefault: true } : {}) })),
    }],
  });
}

/** Canonical model.thinking.efforts, not Pi's legacy thinkingLevelMap or a guessed ladder. */
export function parseOmpDiscoveredModels(data: unknown, state: unknown, liveThinking: unknown): ReadonlyArray<ServerProviderModel> {
  const models = ompRecordField(data, "models");
  if (!Array.isArray(models)) throw new OmpRpcError({ operation: "get_available_models", detail: "Invalid model inventory" });
  const liveLevels = parseOmpThinkingLevels(liveThinking);
  const active = ompRecordField(state, "model");
  const seen = new Set<string>();
  const result: ServerProviderModel[] = [];
  for (const model of models) {
    const provider = ompRecordString(model, "provider");
    const id = ompRecordString(model, "id");
    if (!provider?.trim() || !id?.trim() || provider.trim() !== provider || id.trim() !== id) {
      throw new OmpRpcError({ operation: "get_available_models", detail: "Invalid native model identity" });
    }
    const kind = ompRecordString(model, "kind");
    if (kind !== undefined && kind !== "chat" && kind !== "tiny") continue;
    const slug = `${provider}/${id}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const thinking = ompRecordField(model, "thinking");
    const efforts = ompRecordField(thinking, "efforts");
    let levels: ReadonlyArray<string> = [];
    const isActive = ompRecordString(active, "provider") === provider && ompRecordString(active, "id") === id;
    if (isActive) levels = liveLevels;
    else if (Array.isArray(efforts) && efforts.length > 0) {
      if (efforts.some((effort) => typeof effort !== "string" || effort === "off" || !Object.hasOwn(THINKING_LEVELS, effort))) {
        throw new OmpRpcError({ operation: "get_available_models", detail: "Invalid model thinking metadata" });
      }
      levels = ["off", ...new Set(efforts as string[])];
    }
    result.push({
      slug,
      name: ompRecordString(model, "name")?.trim() || slug,
      subProvider: provider,
      isCustom: false,
      capabilities: thinkingCapabilities(levels, isActive
        ? ompRecordString(state, "thinkingLevel")
        : ompRecordString(thinking, "defaultLevel")),
    });
  }
  return result;
}

/** Only explicit native auth evidence counts. A catalog can contain free/local/unauthenticated models. */
export function parseOmpAuthentication(data: unknown, state: unknown): ServerProviderAuth {
  const providers = ompRecordField(data, "providers");
  const provider = ompRecordString(ompRecordField(state, "model"), "provider");
  if (Array.isArray(providers) && provider !== undefined) {
    const matched = providers.find((item) => ompRecordString(item, "id") === provider);
    const authenticated = ompRecordField(matched, "authenticated");
    if (typeof authenticated === "boolean") return {
      status: authenticated ? "authenticated" : "unauthenticated", type: "omp", label: "External OMP CLI",
    };
  }
  return { status: "unknown", type: "omp", label: "External OMP CLI" };
}

const discoveryConnection = Effect.fnUntraced(function* (settings: OmpSettings, environment: NodeJS.ProcessEnv, cwd?: string) {
  const args = resolveOmpLaunchArgs(settings.launchArgs);
  if (!args.ok) return yield* new OmpRpcError({ operation: "launch", detail: args.message });
  const launch = yield* Effect.try({
    try: () => buildOmpRpcLaunch({ launchArgs: args.args, environment, ...(cwd === undefined ? {} : { cwd }), ephemeral: true, disableTools: true, disableExtensions: true }),
    catch: (cause) => new OmpRpcError({ operation: "launch", detail: cause instanceof Error ? cause.message : "OMP startup preflight failed", cause }),
  });
  const connection = yield* makeOmpRpcConnection({ command: settings.binaryPath || "omp", args: launch.args, env: launch.env, cwd });
  yield* Stream.fromQueue(connection.events).pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
  return connection;
});

export const discoverOmpCommandsForCwd = Effect.fn("discoverOmpCommandsForCwd")(
  function* (settings: OmpSettings, environment: NodeJS.ProcessEnv, cwd: string) {
    const connection = yield* discoveryConnection(settings, environment, cwd);
    const data = yield* connection.request({ type: "get_available_commands" });
    return yield* Effect.try({
      try: () => parseOmpDiscoveredCommands(data),
      catch: (cause) => new OmpRpcError({ operation: "get_available_commands", cause }),
    });
  },
  Effect.scoped,
  Effect.timeoutOrElse({ duration: OMP_STATUS_TIMEOUT_MS, orElse: () => Effect.fail(new OmpRpcTimeoutError({ operation: "discovery", timeoutMs: OMP_STATUS_TIMEOUT_MS })) }),
);

const discover = Effect.fn("OmpStatus.discover")(function* (settings: OmpSettings, environment: NodeJS.ProcessEnv, cwd?: string) {
  const connection = yield* discoveryConnection(settings, environment, cwd);
  const models = yield* connection.request({ type: "get_available_models" });
  const state = yield* connection.request({ type: "get_state" });
  const thinking = yield* connection.request({ type: "get_available_thinking_levels" });
  const commands = yield* connection.request({ type: "get_available_commands" });
  const authentication = yield* connection.request({ type: "get_login_providers" });
  return yield* Effect.try({
    try: () => ({ models: parseOmpDiscoveredModels(models, state, thinking), ...parseOmpDiscoveredCommands(commands), auth: parseOmpAuthentication(authentication, state) }),
    catch: (cause) => new OmpRpcError({ operation: "discovery", cause }),
  });
}, Effect.scoped);

export const buildInitialOmpProviderSnapshot = Effect.fn("buildInitialOmpProviderSnapshot")(function* (settings: OmpSettings) {
  return buildServerProvider({
    presentation: PRESENTATION, enabled: settings.enabled,
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    models: providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES),
    probe: {
      installed: settings.enabled, version: null, status: "warning", auth: { status: "unknown", type: "omp" },
      message: settings.enabled ? "Checking external OMP CLI availability..." : "OMP is disabled in provider settings.",
    },
  });
});

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  if (!settings.enabled) return yield* buildInitialOmpProviderSnapshot(settings);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallback = providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES);
  let version: string | null = null;
  const snapshot = (probe: Parameters<typeof buildServerProvider>[0]["probe"]) => buildServerProvider({
    presentation: PRESENTATION, enabled: true, checkedAt, models: fallback, probe,
  });
  const args = resolveOmpLaunchArgs(settings.launchArgs);
  if (!args.ok) return snapshot({ installed: false, version, status: "error", auth: { status: "unknown" }, message: args.message });
  const result = yield* Effect.gen(function* () {
    const launch = yield* Effect.try({
      try: () => buildOmpRpcLaunch({ launchArgs: args.args, environment, ...(cwd === undefined ? {} : { cwd }), ephemeral: true, disableTools: true, disableExtensions: true }),
      catch: (cause) => new OmpRpcError({ operation: "launch", detail: cause instanceof Error ? cause.message : "OMP startup preflight failed", cause }),
    });
    const binary = settings.binaryPath || "omp";
    const spawn = yield* resolveSpawnCommand(binary, ["--version"], { env: launch.env });
    const output = yield* spawnAndCollect(binary, ChildProcess.make(spawn.command, spawn.args, {
      cwd: cwd ?? process.cwd(), env: launch.env, extendEnv: false, shell: spawn.shell,
    })).pipe(
      Effect.timeoutOption(4_000),
    );
    if (Option.isNone(output)) return yield* new OmpRpcError({ operation: "version", detail: "OMP --version timed out" });
    version = parseGenericCliVersion(`${output.value.stdout}\n${output.value.stderr}`);
    if (output.value.code !== 0 || version === null) return yield* new OmpRpcError({ operation: "version", detail: "Could not identify the external OMP CLI version" });
    if (compareSemverVersions(version, MINIMUM_OMP_VERSION) < 0) return yield* new OmpRpcError({ operation: "version", detail: `OMP ${MINIMUM_OMP_VERSION} or newer is required for lossless RPC v2` });
    return yield* discover(settings, environment, cwd);
  }).pipe(
    Effect.timeoutOrElse({ duration: OMP_STATUS_TIMEOUT_MS, orElse: () => Effect.fail(new OmpRpcTimeoutError({ operation: "status", timeoutMs: OMP_STATUS_TIMEOUT_MS })) }),
    Effect.result,
  );
  if (Result.isFailure(result)) {
    const missing = isCommandMissingCause(result.failure);
    return snapshot({
      installed: !missing, version, status: "error", auth: { status: "unknown", type: "omp" },
      message: missing
        ? "OMP is not installed or not on PATH. Install and authenticate the external OMP CLI in a terminal."
        : ("detail" in result.failure && typeof result.failure.detail === "string"
            ? result.failure.detail
            : "OMP CLI version or ready/v2 model and command discovery failed. Check the external CLI and configured launch arguments."),
    });
  }
  return buildServerProvider({
    presentation: PRESENTATION, enabled: true, checkedAt,
    models: providerModelsFromSettings(result.success.models, settings.customModels, EMPTY_CAPABILITIES),
    slashCommands: result.success.slashCommands, skills: result.success.skills,
    probe: {
      installed: true, version, status: "ready", auth: result.success.auth,
      message: "OMP RPC v2 is ready. Authentication is managed by the external CLI; account quota and paid inference were not checked.",
    },
  });
});
