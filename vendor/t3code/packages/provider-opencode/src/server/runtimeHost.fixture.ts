import * as Layer from "effect/Layer";
import { ProviderRuntimeHost } from "@t3tools/provider-core/server/ProviderRuntimeHost";
import { makePmProviderRuntimeHost } from "../../../../../../apps/server/agent/src/providers/t3code/runtime-host.ts";

/** The actual scoped host policy; missing generation authorization remains denied. */
export const openCodeTestRuntimeHostLayer = Layer.sync(ProviderRuntimeHost, makePmProviderRuntimeHost);
