import { withProviderClientMetadata } from "@agent-workspace/client-runtime/providers";
import * as Schema from "effect/Schema";
import { AntigravitySettings } from "@t3tools/contracts";
import type { NativeProviderAdapter } from "../driver-adapter.ts";
import { getPmProviderApplication } from "../t3code/application-access.ts";

/** Public DTO/config boundary only; the original driver owns every native operation. */
export const antigravityAdapter: NativeProviderAdapter = {
  definition: withProviderClientMetadata({
    driver: "antigravity", description: "Google Antigravity's native ACP agent with isolated Google, Gemini API key, or Vertex AI authentication.", supportsCustomModels: false,
    source: "t3code/apps/server/src/provider/Drivers/AntigravityDriver.ts", docsUrl: "https://antigravity.google/",
    installationAction: { label: "Install Antigravity runtime", description: "Explicitly download and verify Google's pinned native ACP executable and harness for this supported host. Required disk space is checked before downloading." },
    updateAction: { label: "Update Antigravity runtime", description: "Install and validate the pinned Google runtime without changing account data." },
    removalAction: { label: "Remove Antigravity runtime", description: "Remove only this instance's managed runtime, retaining account data and external installations." },
  }),
  validateConfig(config) {
    for (const [key, value] of Object.entries(config)) {
      if (!["authMethod", "apiKey", "gcpProject", "gcpLocation", "binaryPath"].includes(key)) throw new Error(`Unknown Antigravity setting '${key}'.`);
      if (typeof value !== "string" || value.includes("\0")) throw new Error(`Antigravity ${key} must be a string without NUL characters.`);
    }
    const decoded = Schema.decodeUnknownSync(AntigravitySettings)(config);
    return { authMethod: decoded.authMethod, apiKey: decoded.apiKey, gcpProject: decoded.gcpProject,
      gcpLocation: decoded.gcpLocation, binaryPath: decoded.binaryPath };
  },
  check: (context, signal) => getPmProviderApplication().management.check(context, signal),
  authenticate: (context, options) => getPmProviderApplication().management.authenticate(context, options),
  logout: (context, signal) => getPmProviderApplication().management.logout(context, signal),
  prepare: (context, signal, progress) => getPmProviderApplication().management.prepare!(context, signal, progress),
  // This source family updates its pinned managed release through its installer, not a shell command.
  update: (context, signal, progress) => getPmProviderApplication().management.prepare!(context, signal, progress),
  removeInstallation: (context, signal, progress) => getPmProviderApplication().management.removeInstallation!(context, signal, progress),
  run: (context, options) => getPmProviderApplication().execution.run(context, options),
};
