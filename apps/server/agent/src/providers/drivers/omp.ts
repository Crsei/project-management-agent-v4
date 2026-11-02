import { withProviderClientMetadata } from "@agent-workspace/client-runtime/providers";
import * as Schema from "effect/Schema";
import { OmpSettings } from "@t3tools/provider-omp/settings";
import { resolveOmpLaunchArgs } from "@t3tools/provider-omp/server/launch";
import type { NativeProviderAdapter } from "../driver-adapter.ts";
import { getPmProviderApplication } from "../t3code/application-access.ts";

export const ompAdapter: NativeProviderAdapter = {
  definition: withProviderClientMetadata({
    driver: "omp",
    description: "Oh My Pi using its native RPC runtime, Home and externally managed CLI authentication.",
    source: "local-addition @t3tools/provider-omp (MIT)",
    docsUrl: "https://github.com/can1357/oh-my-pi",
    supportsCustomModels: true,
  }),
  validateConfig(config) {
    for (const [key, value] of Object.entries(config)) {
      if (!["binaryPath", "launchArgs"].includes(key)) throw new Error(`Unknown OMP setting: ${key}.`);
      if (typeof value !== "string" || value.includes("\0")) throw new Error(`OMP ${key} must be a string without NUL characters.`);
    }
    const decoded = Schema.decodeUnknownSync(OmpSettings)(config);
    const launch = resolveOmpLaunchArgs(decoded.launchArgs);
    if (!launch.ok) throw new Error(launch.message);
    return { binaryPath: decoded.binaryPath, launchArgs: decoded.launchArgs };
  },
  check: (context, signal) => getPmProviderApplication().management.check(context, signal),
  authenticate: (context, options) => getPmProviderApplication().management.authenticate(context, options),
  logout: (context, signal) => getPmProviderApplication().management.logout(context, signal),
  run: (context, options) => getPmProviderApplication().execution.run(context, options),
};
