import { withProviderClientMetadata } from "@agent-workspace/client-runtime/providers";
import type { NativeProviderAdapter } from "../driver-adapter.ts";
import { getPmProviderApplication } from "../t3code/application-access.ts";
import { validateClaudeConfig } from "../t3code/config-mapping.ts";

/** Local public DTO boundary. The original driver owns all native execution and metadata. */
export const claudeAdapter: NativeProviderAdapter = {
  definition: withProviderClientMetadata({
    driver: "claude", description: "Native Claude Agent SDK with native Home, Skills, compaction and resumable sessions.",
    docsUrl: "https://code.claude.com/docs/en/overview", source: "t3code/apps/server/src/provider/Drivers/ClaudeDriver.ts (MIT)", supportsCustomModels: true,
    updateAction: { label: "Update Claude", description: "Update the detected native or npm Claude installation." },
  }),
  validateConfig: validateClaudeConfig,
  check: (context, signal) => getPmProviderApplication().management.check(context, signal),
  authenticate: (context, options) => getPmProviderApplication().management.authenticate(context, options),
  logout: (context, signal) => getPmProviderApplication().management.logout(context, signal),
  update: (context, signal, onProgress) => getPmProviderApplication().management.update!(context, signal, onProgress),
  run: (context, options) => getPmProviderApplication().execution.run(context, options),
};
