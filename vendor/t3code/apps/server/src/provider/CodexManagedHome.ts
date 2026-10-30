import type { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Context from "effect/Context";
import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";

/** PM supplies its already-owned managed native Home; unbound upstream use keeps native layout. */
export const CodexManagedHomePath = Context.Reference<string | undefined>(
  "t3/provider/CodexManagedHomePath", { defaultValue: () => undefined },
);

export const resolveManagedCodexHomeLayout = Effect.fn("resolveManagedCodexHomeLayout")(function* (
  stateDir: string,
  instanceId: ProviderInstanceId,
  config: CodexSettings,
) {
  const path = yield* Path.Path;
  const managedHome = yield* CodexManagedHomePath;
  if (managedHome) return yield* resolveCodexHomeLayout({ ...config, homePath: managedHome, shadowHomePath: "" });
  return yield* resolveCodexHomeLayout({
    ...config,
    shadowHomePath:
      config.shadowHomePath.trim() ||
      (instanceId === "codex"
        ? ""
        : path.join(stateDir, "providers", "codex", instanceId, "shadow")),
  });
});
