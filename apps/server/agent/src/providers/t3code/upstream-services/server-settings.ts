import type { ServerSettingsError, ServerSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";

export class ServerSettingsService extends Context.Service<ServerSettingsService, {
  readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly withSettingsSnapshot: ProviderHost["Service"]["settings"]["withSnapshot"];
  readonly streamChanges: Stream.Stream<ServerSettings>;
  readonly subscribeChanges: Effect.Effect<Stream.Stream<ServerSettings>, never, Scope.Scope>;
}>()("t3/serverSettings/ServerSettingsService") {}

