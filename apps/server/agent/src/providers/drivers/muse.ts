import { withProviderClientMetadata } from "@agent-workspace/client-runtime/providers";
import * as Schema from "effect/Schema";
import { MuseSettings } from "@t3tools/provider-muse/settings";
import type { NativeProviderAdapter } from "../driver-adapter.ts";
import { getPmProviderApplication } from "../t3code/application-access.ts";

export const museAdapter: NativeProviderAdapter = {
  definition: withProviderClientMetadata({
    driver: "muse",
    description: "Muse Code with its original MSP SDK, native account and model catalog.",
    source: "t3code/packages/provider-muse (MIT)",
    updateAction: { label: "Update Muse", description: "Update the official Muse launcher using its configured channel. Standalone binaries require manual updates." },
  }),
  validateConfig(config) {
    for (const [key, value] of Object.entries(config)) {
      if (key !== "binaryPath") throw new Error(`Unknown Muse setting: ${key}.`);
      if (typeof value !== "string" || value.includes("\0")) throw new Error("Muse binaryPath must be a string without NUL characters.");
    }
    const decoded = Schema.decodeUnknownSync(MuseSettings)(config);
    return { binaryPath: decoded.binaryPath };
  },
  check: (context, signal) => getPmProviderApplication().management.check(context, signal),
  authenticate: (context, options) => getPmProviderApplication().management.authenticate(context, options),
  logout: (context, signal) => getPmProviderApplication().management.logout(context, signal),
  update: (context, signal, onProgress) => getPmProviderApplication().management.update!(context, signal, onProgress),
  run: (context, options) => getPmProviderApplication().execution.run(context, options),
};
