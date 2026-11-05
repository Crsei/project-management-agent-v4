import { withProviderClientMetadata } from "@agent-workspace/client-runtime/providers";
import { validatePiConfig } from "../t3code/config-mapping.ts";
import type { NativeProviderAdapter } from "../driver-adapter.ts";
import { getPmProviderApplication } from "../t3code/application-access.ts";

export const piAdapter: NativeProviderAdapter = {
  definition: withProviderClientMetadata({
    driver: "pi",
    description: "Pi coding agent using its original RPC runtime and native provider credentials.",
    source: "t3code/packages/provider-pi (MIT)", docsUrl: "https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent",
  }),
  validateConfig: validatePiConfig,
  check: (context, signal) => getPmProviderApplication().management.check(context, signal),
  authenticate: (context, options) => getPmProviderApplication().management.authenticate(context, options),
  logout: (context, signal) => getPmProviderApplication().management.logout(context, signal),
  update: (context, signal, onProgress) => getPmProviderApplication().management.update!(context, signal, onProgress),
  run: (context, options) => getPmProviderApplication().execution.run(context, options),
};
