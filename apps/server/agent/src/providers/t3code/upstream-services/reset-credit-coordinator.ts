import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import type { ProviderRuntimeHostService } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ResetCreditCoordinator from "../../../../../../../vendor/t3code/apps/server/src/provider/resetCreditCoordinator.ts";

// Retained native contexts rebuild their layers on revision changes. The source
// coordinator must outlive those contexts, but never a separate application host.
const coordinators = new WeakMap<ProviderRuntimeHostService, ResetCreditCoordinator.ResetCreditCoordinator["Service"]>();

export function makePmResetCreditCoordinatorLayer(
  runtimeHost: ProviderRuntimeHostService,
): Layer.Layer<ResetCreditCoordinator.ResetCreditCoordinator> {
  let coordinator = coordinators.get(runtimeHost);
  if (!coordinator) {
    coordinator = Effect.runSync(ResetCreditCoordinator.make.pipe(Effect.provide(NodeCrypto.layer)));
    coordinators.set(runtimeHost, coordinator);
  }
  return Layer.succeed(ResetCreditCoordinator.ResetCreditCoordinator, coordinator);
}
