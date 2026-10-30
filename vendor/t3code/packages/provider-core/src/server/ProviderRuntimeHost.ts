import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/** Host-owned tools and policy, independent of the application's orchestration engine. */
export interface ProviderRuntimeHostBinding {
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly executionId: string;
  readonly cwd: string;
  readonly mcpServers: ReadonlyArray<{
    readonly name: string;
    readonly transport: "stdio";
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  }>;
  readonly nativePermissions: "deny-ungranted";
  readonly instructionText: string;
}

export interface ProviderRuntimeHostService {
  /** Authorization is ephemeral and belongs to this exact scoped execution binding. */
  readonly bind: (
    binding: ProviderRuntimeHostBinding,
    authorization?: (action: "compaction" | "tool") => Effect.Effect<void, Error>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly read: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
  }) => Effect.Effect<ProviderRuntimeHostBinding | undefined>;
  /** Callers must capture executionId when admitted, never substitute a later live binding. */
  readonly authorize: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly executionId: string;
    readonly action: "compaction" | "tool";
  }) => Effect.Effect<void, Error>;
}

export class ProviderRuntimeHost extends Context.Service<
  ProviderRuntimeHost,
  ProviderRuntimeHostService
>()("@t3tools/provider-core/server/ProviderRuntimeHost") {}
