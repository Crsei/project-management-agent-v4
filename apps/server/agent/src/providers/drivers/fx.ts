import { withProviderClientMetadata } from "@agent-workspace/client-runtime/providers";
import * as Schema from "effect/Schema";
import { FxSettings } from "@t3tools/provider-fx/settings";
import type { NativeProviderAdapter } from "../driver-adapter.ts";
import { getPmProviderApplication } from "../t3code/application-access.ts";

/** Public configuration boundary; fx status, model selection and ACP stay source-owned. */
export const fxAdapter: NativeProviderAdapter = {
  definition: withProviderClientMetadata({
    driver: "fx", description: "Native fx CLI using the server host's native configuration and environment.",
    source: "t3code/packages/provider-fx",
  }),
  validateConfig(config) {
    for (const [key, value] of Object.entries(config)) {
      if (key !== "binaryPath") throw new Error(`Unknown fx setting: ${key}.`);
      if (typeof value !== "string" || value.includes("\0")) throw new Error("fx binaryPath must be a string without NUL characters.");
    }
    const decoded = Schema.decodeUnknownSync(FxSettings)(config);
    return { binaryPath: decoded.binaryPath };
  },
  check: (context, signal) => getPmProviderApplication().management.check(context, signal),
  authenticate: (context, options) => getPmProviderApplication().management.authenticate(context, options),
  logout: (context, signal) => getPmProviderApplication().management.logout(context, signal),
  run: (context, options) => getPmProviderApplication().execution.run(context, options),
};
