import { withProviderClientMetadata } from "@agent-workspace/client-runtime/providers";
import * as Schema from "effect/Schema";
import { CursorSettings } from "@t3tools/provider-cursor/settings";
import type { NativeProviderAdapter } from "../driver-adapter.ts";
import { getPmProviderApplication } from "../t3code/application-access.ts";

/** DTO boundary only. The original Cursor driver owns SDK, login/key isolation, catalog and usage. */
export const cursorAdapter: NativeProviderAdapter = {
  definition: withProviderClientMetadata({
    driver: "cursor",
    description: "Native Cursor Agent SDK with isolated browser sign-in or an explicit instance API key.",
    docsUrl: "https://cursor.com/docs/agents/sdk", source: "t3code/packages/provider-cursor (MIT)",
  }),
  validateConfig(config) {
    const legacy: Record<string, string> = {};
    for (const [key, value] of Object.entries(config)) {
      // Retain the two inactive historical settings without giving them execution meaning.
      if (!["binaryPath", "apiEndpoint"].includes(key)) throw new Error(`Unsupported Cursor setting: ${key}.`);
      if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`Cursor ${key} must be a nonempty string.`);
      legacy[key] = value.trim();
    }
    Schema.decodeUnknownSync(CursorSettings)({});
    return legacy;
  },
  check: (context, signal) => getPmProviderApplication().management.check(context, signal),
  authenticate: (context, options) => getPmProviderApplication().management.authenticate(context, options),
  logout: (context, signal) => getPmProviderApplication().management.logout(context, signal),
  run: (context, options) => getPmProviderApplication().execution.run(context, options),
};
