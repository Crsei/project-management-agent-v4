import { withProviderClientMetadata } from "@agent-workspace/client-runtime/providers";
import * as Schema from "effect/Schema";
import { GrokSettings } from "@t3tools/provider-grok/settings";
import type { NativeProviderAdapter } from "../driver-adapter.ts";
import { getPmProviderApplication } from "../t3code/application-access.ts";

/** Public configuration boundary; the original driver owns all native behavior. */
export const grokAdapter: NativeProviderAdapter = {
  definition: withProviderClientMetadata({
    driver: "grok", description: "Native Grok CLI Agent using the server's native configuration, login and XAI_API_KEY environment.",
    source: "t3code/packages/provider-grok",
    updateAction: { label: "Update Grok", description: "Update the resolved Grok installation using its native updater or the owning Homebrew cask." },
  }),
  validateConfig(config) {
    for (const [key, value] of Object.entries(config)) {
      if (key !== "binaryPath") throw new Error(`Unknown Grok setting: ${key}.`);
      if (typeof value !== "string" || value.includes("\0")) throw new Error("Grok binaryPath must be a string without NUL characters.");
    }
    const decoded = Schema.decodeUnknownSync(GrokSettings)(config);
    return { binaryPath: decoded.binaryPath };
  },
  check: (context, signal) => getPmProviderApplication().management.check(context, signal),
  authenticate: (context, options) => getPmProviderApplication().management.authenticate(context, options),
  logout: (context, signal) => getPmProviderApplication().management.logout(context, signal),
  update: (context, signal, onProgress) => getPmProviderApplication().management.update!(context, signal, onProgress),
  run: (context, options) => getPmProviderApplication().execution.run(context, options),
};
