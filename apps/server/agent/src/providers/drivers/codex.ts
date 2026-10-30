import { withProviderClientMetadata } from "@agent-workspace/client-runtime/providers";
import type { NativeProviderAdapter } from "../driver-adapter.ts";
import { getPmProviderApplication } from "../t3code/application-access.ts";
import { validateCodexConfig } from "./codex-config.ts";

/** DTO boundary only: original Codex modules own account, Home, protocol and lifecycle. */
export const codexAdapter: NativeProviderAdapter = {
  definition: withProviderClientMetadata({
    driver: "codex", description: "Native Codex app-server with native configuration, optional auth overlays and resumable sessions.",
    docsUrl: "https://developers.openai.com/codex/cli/", source: "t3code/apps/server/src/provider/Drivers/CodexDriver.ts (MIT)",
    supportsCustomModels: true,
    installationAction: { label: "Install Codex", description: "Prepare a compatible local runtime or install the pinned managed release." },
    removalAction: { label: "Remove managed Codex", description: "Remove the managed runtime without deleting accounts." },
  }),
  validateConfig: validateCodexConfig,
  check: (context, signal) => getPmProviderApplication().management.check(context, signal),
  authenticate: (context, options) => getPmProviderApplication().management.authenticate(context, options),
  logout: (context, signal) => getPmProviderApplication().management.logout(context, signal),
  prepare: (context, signal, progress) => getPmProviderApplication().management.prepare!(context, signal, progress),
  update: (context, signal, progress) => getPmProviderApplication().management.update!(context, signal, progress),
  removeInstallation: (context, signal, progress) => getPmProviderApplication().management.removeInstallation!(context, signal, progress),
  run: (context, options) => getPmProviderApplication().execution.run(context, options),
};
