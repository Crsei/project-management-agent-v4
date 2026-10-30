import * as CodexInstallation from "./CodexInstallation.ts";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  type ClaudeSettings,
  type CodexSettings,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../../../../../../apps/server/agent/src/providers/t3code/upstream-services/server-config.ts";
import { ClaudeDriver, type ClaudeDriverEnv } from "./Drivers/ClaudeDriver.ts";
import { CodexDriver, type CodexDriverEnv } from "./Drivers/CodexDriver.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as PmNativeTestHost from "../../../../../../apps/server/agent/src/providers/t3code/testing/native-test-host.testkit.ts";
import * as AgentLifecycle from "../../../../../../apps/server/agent/src/providers/t3code/upstream-services/port-discovery.ts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as Stream from "effect/Stream";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const layerTestHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

// The mock CLIs from makeTildeProviderFixtures are scripts Windows cannot execute.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";


const makeCodexConfig = (overrides: Partial<CodexSettings>): CodexSettings => ({
  enabled: false,
  binaryPath: "codex",
  homePath: "",
  shadowHomePath: "",
  launchArgs: "",
  customModels: [],
  ...overrides,
});

const makeClaudeConfig = (overrides: Partial<ClaudeSettings>): ClaudeSettings => ({
  enabled: false,
  binaryPath: "claude",
  homePath: "",
  customModels: [],
  launchArgs: "",
  autoCompactWindow: "",
  idleCompaction: "default",
  ...overrides,
});

const makeTildeProviderFixtures = Effect.fn(
  "ProviderInstanceRegistry.test.makeTildeProviderFixtures",
)(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homePath = yield* HostProcess.HomeDirectory;
  const fixtureDir = yield* fileSystem.makeTempDirectoryScoped({
    directory: homePath,
    prefix: ".t3-provider-path-test-",
  });
  const codexPath = path.join(fixtureDir, "codex");
  const claudePath = path.join(fixtureDir, "claude");
  const claudeHomePath = path.join(fixtureDir, "claude-home");
  const codexScriptPath = path.join(fixtureDir, "codex-script.json");
  const codexFixtureDir = path.join(import.meta.dirname, "testFixtures");

  yield* fileSystem.copyFile(path.join(codexFixtureDir, "codexCollabMockPeer.sh"), codexPath);
  yield* fileSystem.copyFile(
    path.join(codexFixtureDir, "codexCollabMockPeer.mjs"),
    path.join(fixtureDir, "codexCollabMockPeer.mjs"),
  );
  yield* fileSystem.copyFile(
    path.join(codexFixtureDir, "codexMultiAgentWire.json"),
    path.join(fixtureDir, "codexMultiAgentWire.json"),
  );
  yield* fileSystem.writeFileString(
    codexScriptPath,
    JSON.stringify({ rootThreadId: "probe-thread", notifications: [] }),
  );
  yield* fileSystem.chmod(codexPath, 0o755);

  yield* fileSystem.copyFile(
    yield* path.fromFileUrl(
      new URL("./testing/ProviderInstanceRegistryLive.fixture.mjs", import.meta.url),
    ),
    claudePath,
  );
  yield* fileSystem.chmod(claudePath, 0o755);
  yield* fileSystem.makeDirectory(claudeHomePath);

  const asTildePath = (filePath: string) => `~/${path.relative(homePath, filePath)}`;
  return {
    codexBinaryPath: asTildePath(codexPath),
    codexExecutablePath: codexPath,
    claudeBinaryPath: asTildePath(claudePath),
    claudeHomePath,
    codexScriptPath,
  };
});

describe("ProviderInstanceRegistry — multi-instance codex slice", () => {
  const layerBase = ModelManifest.layerTest.pipe(
    Layer.provideMerge(Layer.mergeAll(
      PmNativeTestHost.layer({ driver: "codex", prefix: "pm-provider-instance-registry-source" }),
      AgentLifecycle.layer,
      layerTestHttpClient,
    )),
  );
  const layerTest = Layer.mergeAll(
    CodexAdapterV2.layerAppServerClientFactory,
    ClaudeAdapterV2.layerQueryRunner,
    CodexInstallation.CodexInstallation.layer,
    CodexManagedTokenBroker.layer,
    ProviderLatestVersions.layer,
    ProviderContinuationRequests.layer,
    ResetCreditCoordinator.layer,
  ).pipe(Layer.provideMerge(layerBase));

  it.live.skipIf(windowsHost)(
    "isolates native accounts and replaces only the instance committed by PM settings CAS",
    () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixture = yield* PmNativeTestHost.PmNativeTestHost;
      const executables = yield* makeTildeProviderFixtures();
      const makeAccount = (name: string, email: string) => Effect.gen(function* () {
        const scriptPath = path.join(fixture.root, name + ".json");
        const homePath = path.join(fixture.root, name + "-home");
        yield* fs.makeDirectory(homePath);
        yield* fs.writeFileString(scriptPath, JSON.stringify({
          rootThreadId: name,
          notifications: [],
          account: { type: "chatgpt", email, planType: "pro" },
        }));
        return yield* PmNativeTestHost.makePmNativeTestHost({
          driver: "codex",
          instanceId: name,
          config: { binaryPath: executables.codexExecutablePath, homePath },
          environment: { T3_CODEX_COLLAB_SCRIPT: scriptPath },
        });
      });
      const first = yield* makeAccount("registry-first", "first@example.com");
      const second = yield* makeAccount("registry-second", "second@example.com");
      const firstId = ProviderInstanceId.make(first.context.instanceId);
      const secondId = ProviderInstanceId.make(second.context.instanceId);
      const { settings } = yield* ProviderHost.ProviderHost;
      const live = new Set<ProviderInstanceId>();
      const lifecycle: string[] = [];
      const trackedDriver: typeof CodexDriver = {
        ...CodexDriver,
        create: input => Effect.gen(function* () {
          expect(live.has(input.instanceId)).toBe(false);
          live.add(input.instanceId);
          lifecycle.push("open:" + input.instanceId);
          yield* Effect.addFinalizer(() => Effect.sync(() => {
            live.delete(input.instanceId);
            lifecycle.push("close:" + input.instanceId);
          }));
          return yield* CodexDriver.create(input);
        }),
      };
      const initial = (yield* settings.get).providerInstances;
      const configMap: ProviderInstanceConfigMap = {
        [firstId]: initial[firstId]!, [secondId]: initial[secondId]!,
      };
      const { registry, mutator } = yield* makeProviderInstanceRegistry({
        drivers: [trackedDriver], configMap,
      });
      const originalFirst = (yield* registry.getInstance(firstId))!;
      const originalSecond = (yield* registry.getInstance(secondId))!;
      expect(originalFirst.continuationIdentity).not.toEqual(originalSecond.continuationIdentity);
      const snapshots = yield* Effect.all([
        originalFirst.snapshot.refresh, originalSecond.snapshot.refresh,
      ], { concurrency: "unbounded" });
      expect(snapshots.map(snapshot => snapshot.auth.email)).toEqual([
        "first@example.com", "second@example.com",
      ]);
      expect(snapshots.every(snapshot => snapshot.status === "ready")).toBe(true);
      yield* mutator.reconcile(configMap);
      expect(yield* registry.getInstance(firstId)).toBe(originalFirst);
      expect(yield* registry.getInstance(secondId)).toBe(originalSecond);

      const blocked = yield* settings.withSnapshot(() =>
        first.updateInstance({ label: "must-not-commit" }),
      ).pipe(Effect.result);
      expect(blocked).toMatchObject({ _tag: "Failure", failure: { code: "settings_busy" } });
      const changes = yield* settings.subscribe;
      const updatedScript = path.join(fixture.root, "updated-account.json");
      yield* fs.writeFileString(updatedScript, JSON.stringify({
        rootThreadId: "updated-account", notifications: [],
        account: { type: "chatgpt", email: "updated@example.com", planType: "pro" },
      }));
      const committed = yield* first.updateInstance({
        environment: Object.entries({
          ...first.context.instanceEnvironment,
          T3_CODEX_COLLAB_SCRIPT: updatedScript,
        }).map(([name, value]) => ({ name, value, sensitive: false })),
      });
      expect(committed.revision).toBeGreaterThan(first.context.revision);
      const stale = yield* first.updateInstance({ label: "stale-writer" }).pipe(Effect.result);
      expect(stale).toMatchObject({ _tag: "Failure", failure: { status: 409 } });
      const published = yield* changes.pipe(Stream.take(1), Stream.runCollect);
      expect(published).toHaveLength(1);
      const next = published[0]!.providerInstances;
      yield* mutator.reconcile({ [firstId]: next[firstId]!, [secondId]: next[secondId]! });
      const replacement = (yield* registry.getInstance(firstId))!;
      expect(replacement).not.toBe(originalFirst);
      expect(yield* registry.getInstance(secondId)).toBe(originalSecond);
      expect(lifecycle).toEqual([
        "open:" + firstId, "open:" + secondId, "close:" + firstId, "open:" + firstId,
      ]);
      expect((yield* replacement.snapshot.refresh).auth.email).toBe("updated@example.com");
      expect((yield* originalSecond.snapshot.getSnapshot).auth.email).toBe("second@example.com");
      expect((yield* originalFirst.snapshot.getSnapshot).auth.email).toBe("first@example.com");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live("treats an explicit in-config enabled:false as disabling despite the envelope", () =>
    Effect.gen(function* () {
      const staleId = ProviderInstanceId.make("codex_stale");
      const configMap: ProviderInstanceConfigMap = {
        [staleId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: makeCodexConfig({ enabled: false }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver],
        configMap,
      });

      const instance = yield* registry.getInstance(staleId);
      expect(instance).toBeDefined();
      expect(instance!.enabled).toBe(false);
      const snapshot = yield* instance!.snapshot.getSnapshot;
      expect(snapshot.enabled).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live("runs Codex and Claude readiness probes from configured tilde paths", () =>
    Effect.gen(function* () {
      if (yield* HostProcess.isWindows) return;

      const fixtures = yield* makeTildeProviderFixtures();

      const codexId = ProviderInstanceId.make("codex_tilde");
      const claudeId = ProviderInstanceId.make("claude_tilde");
      const configMap: ProviderInstanceConfigMap = {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          environment: [
            {
              name: "T3_CODEX_COLLAB_SCRIPT",
              value: fixtures.codexScriptPath,
              sensitive: false,
            },
          ],
          config: makeCodexConfig({ enabled: true, binaryPath: fixtures.codexBinaryPath }),
        },
        [claudeId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          config: makeClaudeConfig({
            enabled: true,
            binaryPath: fixtures.claudeBinaryPath,
            homePath: fixtures.claudeHomePath,
          }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry<CodexDriverEnv | ClaudeDriverEnv>({
        drivers: [CodexDriver, ClaudeDriver],
        configMap,
      });
      const codex = yield* registry.getInstance(codexId);
      const claude = yield* registry.getInstance(claudeId);
      expect(codex).toBeDefined();
      expect(claude).toBeDefined();

      const [codexSnapshot, claudeSnapshot] = yield* Effect.all(
        [codex!.snapshot.refresh, claude!.snapshot.refresh],
        { concurrency: "unbounded" },
      );
      expect(codexSnapshot).toMatchObject({ status: "ready", installed: true, version: "0.0.0" });
      expect(claudeSnapshot).toMatchObject({
        status: "ready",
        installed: true,
        version: "2.1.219",
      });
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live("runs Claude instance probes in the server state dir, not the server cwd", () =>
    Effect.gen(function* () {
      if (yield* HostProcess.isWindows) return;

      const fixtures = yield* makeTildeProviderFixtures();
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const claudeId = ProviderInstanceId.make("claude_state_dir");
      const { registry } = yield* makeProviderInstanceRegistry<ClaudeDriverEnv>({
        drivers: [ClaudeDriver],
        configMap: {
          [claudeId]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            // Packaged desktop starts in $HOME, where some claude wrappers refuse to run.
            environment: [{ name: "T3_CLAUDE_REQUIRED_CWD", value: stateDir, sensitive: false }],
            config: makeClaudeConfig({
              enabled: true,
              binaryPath: fixtures.claudeBinaryPath,
              homePath: fixtures.claudeHomePath,
            }),
          },
        },
      });
      const claude = yield* registry.getInstance(claudeId);

      expect(yield* claude!.snapshot.refresh).toMatchObject({
        status: "ready",
        version: "2.1.219",
        auth: { status: "authenticated" },
      });
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("scopes Claude's one-probe fallback to the logged-in organization", () =>
    Effect.gen(function* () {
      if (yield* HostProcess.isWindows) return;

      const fixtures = yield* makeTildeProviderFixtures();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const accountConfigPath = path.join(fixtures.claudeHomePath, ".claude.json");
      yield* fs.writeFileString(
        accountConfigPath,
        JSON.stringify({ oauthAccount: { organizationUuid: "org-a" } }),
      );
      const claudeId = ProviderInstanceId.make("claude_probe_recovery");
      let probeCount = 0;
      let successfulProbeCount = 0;
      let failProbe = false;
      const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(
        () =>
          ({
            initializationResult: () => {
              probeCount++;
              if (failProbe) return Promise.reject(new Error("initialization failed"));
              successfulProbeCount++;
              return Promise.resolve({
                commands: [
                  {
                    name: successfulProbeCount === 1 ? "last-good" : "recovered",
                    description: "",
                    argumentHint: "",
                  },
                ],
                account: {
                  email:
                    successfulProbeCount === 1 ? "account-a@example.com" : "account-b@example.com",
                  subscriptionType: "pro",
                  tokenSource: "oauth",
                },
              });
            },
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
              rate_limits_available: true,
              rate_limits: {
                five_hour: { utilization: 12, resets_at: "2026-07-18T14:39:00Z" },
              },
            }),
          }) as ReturnType<typeof ClaudeSdk.query>,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));

      const { registry } = yield* makeProviderInstanceRegistry<ClaudeDriverEnv>({
        drivers: [ClaudeDriver],
        configMap: {
          [claudeId]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: makeClaudeConfig({
              enabled: true,
              binaryPath: fixtures.claudeBinaryPath,
              homePath: fixtures.claudeHomePath,
            }),
          },
        },
      });
      const claude = yield* registry.getInstance(claudeId);
      expect(claude).toBeDefined();

      const first = yield* claude!.snapshot.refresh;
      expect(first).toMatchObject({
        status: "ready",
        auth: { status: "authenticated", email: "account-a@example.com", workspaceId: "org-a" },
        slashCommands: expect.arrayContaining([expect.objectContaining({ name: "last-good" })]),
      });
      expect(first.usageLimits?.unavailable).toBeUndefined();
      expect(probeCount).toBe(1);

      yield* TestClock.adjust("1 second");
      yield* fs.writeFileString(
        accountConfigPath,
        JSON.stringify({ oauthAccount: { organizationUuid: "org-b" } }),
      );
      yield* claude!.invalidateCaches ?? Effect.void;
      failProbe = true;
      const accountChangedFailure = yield* claude!.snapshot.refresh;

      expect(accountChangedFailure).toMatchObject({
        status: "warning",
        auth: { status: "unknown" },
      });
      expect(accountChangedFailure.checkedAt).not.toBe(first.checkedAt);
      expect(accountChangedFailure.usageLimits).toBeUndefined();
      expect(accountChangedFailure.slashCommands).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "last-good" })]),
      );
      const failedProbeCount = probeCount;
      expect(failedProbeCount).toBeGreaterThan(1);

      failProbe = false;
      const recovered = yield* claude!.snapshot.refresh;
      expect(recovered).toMatchObject({
        status: "ready",
        auth: { status: "authenticated", email: "account-b@example.com", workspaceId: "org-b" },
        slashCommands: expect.arrayContaining([expect.objectContaining({ name: "recovered" })]),
      });
      expect(recovered.usageLimits?.unavailable).toBeUndefined();
      const recoveredProbeCount = probeCount;
      expect(recoveredProbeCount).toBeGreaterThan(failedProbeCount);

      yield* TestClock.adjust("1 second");
      yield* claude!.invalidateCaches ?? Effect.void;
      failProbe = true;
      const sameAccountFailure = yield* claude!.snapshot.refresh;
      expect(sameAccountFailure).toMatchObject({
        status: "ready",
        auth: { status: "authenticated", email: "account-b@example.com", workspaceId: "org-b" },
        slashCommands: expect.arrayContaining([expect.objectContaining({ name: "recovered" })]),
      });
      expect(sameAccountFailure.usageLimits?.checkedAt).toBe(recovered.usageLimits?.checkedAt);
      expect(sameAccountFailure.usageLimits?.windows).toEqual(recovered.usageLimits?.windows);
      const sameAccountFailureProbeCount = probeCount;
      expect(sameAccountFailureProbeCount).toBeGreaterThan(recoveredProbeCount);

      const repeatedFailure = yield* claude!.snapshot.refresh;
      expect(repeatedFailure).toMatchObject({
        status: "warning",
        auth: { status: "unknown" },
      });
      expect(repeatedFailure.slashCommands).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "recovered" })]),
      );
      expect(probeCount).toBeGreaterThan(sameAccountFailureProbeCount);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  const redeemClaudeReset = (claim: { result: string; usageFailsAfterClaim: boolean }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixtures = yield* makeTildeProviderFixtures();
      const marker = path.join(fixtures.claudeHomePath, "redeemed");
      yield* fs.writeFileString(
        path.join(fixtures.claudeHomePath, ".credentials.json"),
        '{"claudeAiOauth":{"accessToken":"fake-token"}}',
      );
      yield* fs.writeFileString(
        path.join(fixtures.claudeHomePath, ".claude.json"),
        '{"oauthAccount":{"organizationUuid":"fake-org"}}',
      );
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          if (request.url.endsWith("/api/oauth/usage")) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                cedar_ember: {
                  eligible: true,
                  next_grant_id: "grant_a",
                  grants: [{ id: "grant_a", resets_left: 1, usable_now: true }],
                },
              }),
            );
          }
          if (request.url.endsWith("/reset_rate_limits")) {
            yield* fs.writeFileString(marker, "redeemed").pipe(Effect.orDie);
            return HttpClientResponse.fromWeb(request, Response.json({ result: claim.result }));
          }
          return HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }));
        }),
      );
      const instanceId = ProviderInstanceId.make("claude_reset");
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [ClaudeDriver],
        configMap: {
          [instanceId]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            environment: [
              { name: "T3_CLAUDE_RESET_MARKER", value: marker, sensitive: false },
              ...(claim.usageFailsAfterClaim
                ? [{ name: "T3_CLAUDE_USAGE_FAILS_AFTER_CLAIM", value: "1", sensitive: false }]
                : []),
            ],
            config: makeClaudeConfig({
              enabled: true,
              binaryPath: fixtures.claudeBinaryPath,
              homePath: fixtures.claudeHomePath,
            }),
          },
        },
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));
      const instance = yield* registry.getInstance(instanceId);
      expect(instance).toBeDefined();
      const before = yield* instance!.snapshot.refresh;
      expect(before.usageLimits?.windows[0]?.usedPercent).toBe(100);
      expect(before.usageLimits?.resetCredits?.nextCreditId).toBe("grant_a");
      const outcome = yield* instance!.consumeResetCredit!().pipe(Effect.result);
      return { outcome, after: yield* instance!.snapshot.getSnapshot };
    }).pipe(
      // macOS logins live in the Keychain, where resets are never read.
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.scoped,
      Effect.provide(layerTest),
    );

  it.live.skipIf(windowsHost)("refreshes Claude usage after redeeming a reset", () =>
    Effect.gen(function* () {
      const { outcome, after } = yield* redeemClaudeReset({
        result: "reset",
        usageFailsAfterClaim: false,
      });
      expect(outcome).toMatchObject({ _tag: "Success", success: "reset" });
      expect(after.usageLimits?.windows[0]?.usedPercent).toBe(0);
    }),
  );

  it.live.skipIf(windowsHost)(
    "reports Claude's answer when a claim changed nothing and the re-probe fails",
    () =>
      Effect.gen(function* () {
        const { outcome } = yield* redeemClaudeReset({
          result: "already_used",
          usageFailsAfterClaim: true,
        });
        expect(outcome).toMatchObject({ _tag: "Success", success: "alreadyRedeemed" });
      }),
  );

  const makeClaudeCacheFixture = Effect.fnUntraced(function* (
    state: "ready" | "signed-out" | "usage-failed",
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixtures = yield* makeTildeProviderFixtures();
    const recovered = path.join(fixtures.claudeHomePath, "recovered");
    const probeLog = path.join(fixtures.claudeHomePath, "probes.log");
    const instanceId = ProviderInstanceId.make("claude_cache");
    const { registry } = yield* makeProviderInstanceRegistry({
      drivers: [ClaudeDriver],
      configMap: {
        [instanceId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          environment: [
            { name: "T3_CLAUDE_PROBE_LOG", value: probeLog, sensitive: false },
            ...(state === "ready"
              ? []
              : [
                  {
                    name:
                      state === "signed-out"
                        ? "T3_CLAUDE_LOGIN_MARKER"
                        : "T3_CLAUDE_USAGE_FAILS_UNTIL",
                    value: recovered,
                    sensitive: false,
                  },
                ]),
          ],
          config: makeClaudeConfig({
            enabled: true,
            binaryPath: fixtures.claudeBinaryPath,
            homePath: fixtures.claudeHomePath,
          }),
        },
      },
    });
    const instance = yield* registry.getInstance(instanceId);
    expect(instance).toBeDefined();
    return {
      refresh: instance!.snapshot.refresh,
      recover: fs.writeFileString(recovered, ""),
      probeLog: fs.readFileString(probeLog),
    };
  });

  for (const state of ["signed-out", "usage-failed"] as const) {
    it.effect.skipIf(windowsHost)(
      state === "signed-out"
        ? "shows Claude usage on the first refresh after signing back in"
        : "retries Claude usage on the first refresh after a failed usage read",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeClaudeCacheFixture(state);
          const before = yield* fixture.refresh;
          if (state === "signed-out") {
            expect(before.auth.status).toBe("unauthenticated");
            expect(before.usageLimits).toBeUndefined();
          } else {
            expect(before.auth.status).toBe("authenticated");
            expect(before.usageLimits?.unavailable?.reason).toBe("probeFailed");
          }

          yield* fixture.recover;
          const after = yield* fixture.refresh;
          expect(after.auth.status).toBe("authenticated");
          expect(after.usageLimits?.unavailable).toBeUndefined();
          expect(after.usageLimits?.windows.map((window) => window.id)).toEqual(["five_hour"]);
        }).pipe(Effect.scoped, Effect.provide(layerTest)),
    );
  }

  it.live("keeps decode and native Home failures unavailable without reporting them as signed out", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fixture = yield* PmNativeTestHost.PmNativeTestHost;
      const healthyId = ProviderInstanceId.make("codex_healthy");
      const invalidId = ProviderInstanceId.make("codex_invalid_config");
      const failedId = ProviderInstanceId.make("codex_home_conflict");
      const conflictingHome = path.join(fixture.root, "conflicting-home");
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver],
        configMap: {
          [healthyId]: {
            driver: CodexDriver.driverKind, enabled: false, config: makeCodexConfig({}),
          },
          [invalidId]: {
            driver: CodexDriver.driverKind, enabled: true, config: { binaryPath: 123 },
          },
          [failedId]: {
            driver: CodexDriver.driverKind, enabled: true,
            config: makeCodexConfig({ homePath: conflictingHome, shadowHomePath: conflictingHome }),
          },
        },
      });
      expect((yield* registry.listInstances).map(instance => instance.instanceId)).toEqual([healthyId]);
      expect(yield* registry.getInstance(invalidId)).toBeUndefined();
      expect(yield* registry.getInstance(failedId)).toBeUndefined();
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable.map(snapshot => snapshot.instanceId)).toEqual([invalidId, failedId]);
      for (const snapshot of unavailable) {
        expect(snapshot).toMatchObject({
          availability: "unavailable", auth: { status: "unknown" }, models: [],
        });
        expect(snapshot.unavailableReason).toBeTruthy();
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.live(
    "shadows instances whose driver is not registered in this build without failing boot",
    () =>
      Effect.gen(function* () {
        const codexId = ProviderInstanceId.make("codex_main");
        const ghostId = ProviderInstanceId.make("ghost_main");

        const configMap: ProviderInstanceConfigMap = {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
            config: makeCodexConfig({}),
          },
          [ghostId]: {
            driver: ProviderDriverKind.make("ghostDriver"),
            displayName: "A fork-only driver we don't ship",
            enabled: false,
            config: { arbitrary: "payload", preserved: true },
          },
        };

        const { registry } = yield* makeProviderInstanceRegistry<CodexDriverEnv>({
          drivers: [CodexDriver],
          configMap,
        });

        const instances = yield* registry.listInstances;
        expect(instances).toHaveLength(1);
        expect(instances[0]!.instanceId).toBe(codexId);

        const unavailable = yield* registry.listUnavailable;
        expect(unavailable).toHaveLength(1);
        const ghost = unavailable[0]!;
        expect(ghost.instanceId).toBe(ghostId);
        expect(ghost.driver).toBe("ghostDriver");
        expect(ghost.availability).toBe("unavailable");
        expect(ghost.unavailableReason).toMatch(/ghostDriver/);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
