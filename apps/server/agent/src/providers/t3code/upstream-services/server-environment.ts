import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Stable application identity only, never a PM principal or a t3 login/environment descriptor. */
export class ServerEnvironmentIdentity extends Context.Service<ServerEnvironmentIdentity, {
  readonly getEnvironmentId: Effect.Effect<EnvironmentId>;
}>()("t3/environment/ServerEnvironment/ServerEnvironmentIdentity") {}
