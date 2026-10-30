import { withProviderClientMetadata } from "@agent-workspace/client-runtime/providers";
import * as Schema from "effect/Schema";
import { PiSettings } from "@t3tools/provider-pi/settings";
import { resolvePiLaunchArgs } from "../../../../../../vendor/t3code/packages/provider-pi/src/server/mcpInjection.ts";
import type { NativeProviderAdapter } from "../driver-adapter.ts";
import { getPmProviderApplication } from "../t3code/application-access.ts";

export const piAdapter: NativeProviderAdapter = {
  definition: withProviderClientMetadata({
    driver: "pi",
    description: "Pi coding agent using its original RPC runtime and native provider credentials.",
    source: "t3code/packages/provider-pi (MIT)", docsUrl: "https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent",
  }),
  validateConfig(config) {
    for (const [key, value] of Object.entries(config)) {
      if (!["binaryPath", "launchArgs"].includes(key)) throw new Error(`Unknown Pi setting: ${key}.`);
      if (typeof value !== "string" || value.includes("\0")) throw new Error(`Pi ${key} must be a string without NUL characters.`);
    }
    const decoded = Schema.decodeUnknownSync(PiSettings)(config);
    const launch = resolvePiLaunchArgs(decoded.launchArgs);
    if (!launch.ok) throw new Error(launch.message);
    return { binaryPath: decoded.binaryPath, launchArgs: decoded.launchArgs };
  },
  check: (context, signal) => getPmProviderApplication().management.check(context, signal),
  authenticate: (context, options) => getPmProviderApplication().management.authenticate(context, options),
  logout: (context, signal) => getPmProviderApplication().management.logout(context, signal),
  update: (context, signal, onProgress) => getPmProviderApplication().management.update!(context, signal, onProgress),
  run: (context, options) => getPmProviderApplication().execution.run(context, options),
};
