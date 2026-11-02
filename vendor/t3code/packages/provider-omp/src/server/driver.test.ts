import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderRuntimeHost } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { OmpSettings } from "../settings.ts";
import { ompClient } from "../client.ts";
import { OmpDriver } from "./driver.ts";

const layer = Layer.mergeAll(
  TestProviderHost.layer({ settings: { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false }, runBackgroundWork: false }),
  IdAllocator.layer,
  Layer.succeed(ProviderRuntimeHost, {
    bind: () => Effect.void,
    read: () => Effect.succeed(undefined),
    authorize: () => Effect.fail(new Error("No test execution is authorized")),
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

it("decodes an independently disabled browser-safe provider, without inherited Pi identity", () => {
  const settings = Schema.decodeSync(OmpSettings)({});
  assert.isFalse(settings.enabled);
  assert.equal(settings.binaryPath, "omp");
  assert.equal(settings.launchArgs, "");
  assert.deepEqual(settings.customModels, []);
  assert.equal(ompClient.driverKind, "omp");
  assert.equal(OmpDriver.driverKind, "omp");
});

it.layer(layer)("OMP driver lifecycle boundary", (it) => {
  it.effect("does not spawn disabled instances and exposes no automatic install, update or login actions", () => Effect.gen(function* () {
    const instance = yield* OmpDriver.create({
      instanceId: ProviderInstanceId.make("omp-independent"),
      displayName: "My OMP", accentColor: "#abcdef", environment: [], enabled: false,
      config: OmpDriver.defaultConfig(),
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(() => Effect.die("Disabled OMP must not spawn"))));
    const snapshot = yield* instance.snapshot.getSnapshot;
    const workspace = yield* instance.snapshotForCwd!("/unused-workspace");
    assert.equal(snapshot.driver, "omp");
    assert.equal(snapshot.instanceId, "omp-independent");
    assert.equal(snapshot.displayName, "My OMP");
    assert.equal(snapshot.accentColor, "#abcdef");
    assert.isFalse(workspace.enabled);
    assert.deepEqual(workspace.models, []);
    assert.equal(instance.continuationIdentity.continuationKey, "omp:instance:omp-independent");
    assert.isNull((yield* instance.snapshot.resolveMaintenance()).update);
    assert.isUndefined(instance.auth);
    assert.isUndefined(OmpDriver.usage);
  }).pipe(Effect.scoped));
});
