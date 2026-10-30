import { withProviderClientMetadata } from "@agent-workspace/client-runtime/providers";
import * as Schema from "effect/Schema";
import { OpenCodeSettings } from "@t3tools/provider-opencode/settings";
import type { NativeProviderAdapter } from "../driver-adapter.ts";
import { getPmProviderApplication } from "../t3code/application-access.ts";

/** Local DTO boundary only. Protocol, auth, inventory and maintenance belong to the original driver. */
export const opencodeAdapter: NativeProviderAdapter = {
  definition: withProviderClientMetadata({
    driver: "opencode", description: "OpenCode native agent with externally managed provider authentication, model catalog and resumable sessions.",
    docsUrl: "https://opencode.ai/docs/", source: "t3code/packages/provider-opencode (MIT)",
    supportsCustomModels: true,
  }),
  validateConfig(config) {
    for (const [key, value] of Object.entries(config)) {
      if (!["binaryPath", "serverUrl", "serverPassword"].includes(key)) throw new Error(`Unknown OpenCode setting: ${key}.`);
      if (typeof value !== "string" || value.includes("\0")) throw new Error(`OpenCode ${key} must be a string without NUL characters.`);
    }
    const decoded = Schema.decodeUnknownSync(OpenCodeSettings)(config);
    if (decoded.serverUrl) {
      const url = URL.parse(decoded.serverUrl);
      if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error("OpenCode server URL must use HTTP(S), with no embedded credentials, query or fragment. Use Server password instead.");
      }
    }
    return { binaryPath: decoded.binaryPath, serverUrl: decoded.serverUrl, serverPassword: decoded.serverPassword };
  },
  check: (context, signal) => getPmProviderApplication().management.check(context, signal),
  authenticate: (context, options) => getPmProviderApplication().management.authenticate(context, options),
  logout: (context, signal) => getPmProviderApplication().management.logout(context, signal),
  update: (context, signal, onProgress) => getPmProviderApplication().management.update!(context, signal, onProgress),
  run: (context, options) => getPmProviderApplication().execution.run(context, options),
};
