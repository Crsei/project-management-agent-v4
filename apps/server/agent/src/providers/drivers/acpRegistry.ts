import { withProviderClientMetadata } from "@agent-workspace/client-runtime/providers";
import * as Schema from "effect/Schema";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import type { NativeProviderAdapter } from "../driver-adapter.ts";
import { getPmProviderApplication } from "../t3code/application-access.ts";

/** Original catalog preparation, auth controller and ACP adapter are the only implementation. */
export const acpRegistryAdapter: NativeProviderAdapter = {
  definition: withProviderClientMetadata({
    driver: "acpRegistry", description: "Agents from the official Agent Client Protocol Registry, or a local ACP command.",
    source: "t3code/packages/provider-acp-registry", docsUrl: "https://agentclientprotocol.com/registry",
    installationAction: { label: "Prepare agent", description: "Explicitly download or install the selected official registry distribution using its original preparation logic." },
  }),
  validateConfig(config) {
    const keys = ["source", "agentId", "commandPath", "commandArgs", "authMethodId", "distribution"];
    for (const [key, value] of Object.entries(config)) {
      if (!keys.includes(key)) throw new Error(`Unknown ACP Registry setting: ${key}.`);
      const values = Array.isArray(value) ? value : [value];
      if (values.some(entry => typeof entry !== "string" || entry.includes("\0")))
        throw new Error(`ACP Registry ${key} must contain strings without NUL characters.`);
    }
    const { source, agentId, commandPath, commandArgs, authMethodId, distribution } = Schema.decodeUnknownSync(AcpRegistrySettings)(config);
    return { source, agentId, commandPath, commandArgs: [...commandArgs], authMethodId, distribution };
  },
  prepare: (context, signal, onProgress) => getPmProviderApplication().management.prepare!(context, signal, onProgress),
  check: (context, signal) => getPmProviderApplication().management.check(context, signal),
  authenticate: (context, options) => getPmProviderApplication().management.authenticate(context, options),
  logout: (context, signal) => getPmProviderApplication().management.logout(context, signal),
  run: (context, options) => getPmProviderApplication().execution.run(context, options),
};
