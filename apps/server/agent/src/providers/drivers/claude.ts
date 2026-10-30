import { withProviderClientMetadata } from "@agent-workspace/client-runtime/providers";
import * as Schema from "effect/Schema";
import { ClaudeSettings } from "@t3tools/contracts";
import type { NativeProviderAdapter } from "../driver-adapter.ts";
import { getPmProviderApplication } from "../t3code/application-access.ts";
import { claudeLaunchFlags } from "../../../../../../vendor/t3code/apps/server/src/provider/Drivers/ClaudeLaunchArgs.ts";

/** Local public DTO boundary. The original driver owns all native execution and metadata. */
export const claudeAdapter: NativeProviderAdapter = {
  definition: withProviderClientMetadata({
    driver: "claude", description: "Native Claude Agent SDK with native Home, Skills, compaction and resumable sessions.",
    docsUrl: "https://code.claude.com/docs/en/overview", source: "t3code/apps/server/src/provider/Drivers/ClaudeDriver.ts (MIT)", supportsCustomModels: true,
    updateAction: { label: "Update Claude", description: "Update the detected native or npm Claude installation." },
  }),
  validateConfig(config) {
    const keys = ["binaryPath", "homePath", "launchArgs", "autoCompactWindow", "idleCompaction"];
    for (const [key, value] of Object.entries(config)) {
      if (!keys.includes(key)) throw new Error(`Unknown Claude setting: ${key}.`);
      if (typeof value !== "string" || value.includes("\0")) throw new Error(`Claude ${key} must be a string without NUL characters.`);
    }
    const decoded = Schema.decodeUnknownSync(ClaudeSettings)({ ...config, binaryPath: config.binaryPath || "claude" });
    claudeLaunchFlags(decoded.launchArgs);
    return { binaryPath: decoded.binaryPath, homePath: decoded.homePath, launchArgs: decoded.launchArgs,
      autoCompactWindow: decoded.autoCompactWindow, idleCompaction: decoded.idleCompaction };
  },
  check: (context, signal) => getPmProviderApplication().management.check(context, signal),
  authenticate: (context, options) => getPmProviderApplication().management.authenticate(context, options),
  logout: (context, signal) => getPmProviderApplication().management.logout(context, signal),
  update: (context, signal, onProgress) => getPmProviderApplication().management.update!(context, signal, onProgress),
  run: (context, options) => getPmProviderApplication().execution.run(context, options),
};
