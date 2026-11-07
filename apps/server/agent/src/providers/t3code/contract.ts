import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { ExecutionEnvironment } from "@agent-workspace/contracts/chat";
import type { NativeSessionRef, ProviderDriver } from "@agent-workspace/contracts/provider";
import type {
  ProviderInstance,
  ProviderContinuationIdentity,
} from "@t3tools/provider-core/server/driver";
import type { CliChatResult } from "../../agents/cli-chat.ts";
import type { ProviderDriverContext, ProviderDriverRunOptions } from "../driver-adapter.ts";
import type { PmNativeUsageReader } from "./native-usage.ts";

export type PmProviderPurpose = "status" | "execution" | "auth" | "maintenance" | "usage";
export type PmExecutionIdentity = {
  readonly threadId: string;
  readonly generationId: string;
  readonly messageId: string;
  readonly environment: ExecutionEnvironment;
};
export type PmProviderBoundaryError = Error & {
  readonly status: number;
  readonly code: string;
  readonly errorClass?: "usage_limit" | "authentication" | "cancelled" | "unsupported" | "provider_error";
  readonly resetAt?: string;
  readonly terminalStatus?: "failed" | "cancelled" | "interrupted";
};
export interface PmProviderUsageLease {
  readonly localDriver: ProviderDriver;
  readonly instanceId: string;
  readonly revision: number;
  readonly cwd: string;
  readonly nativeHome: string;
  readonly usage?: PmNativeUsageReader;
  readonly assertCurrent: Effect.Effect<void, PmProviderBoundaryError>;
}
export interface PmProviderLease extends PmProviderUsageLease {
  readonly continuationIdentity: ProviderContinuationIdentity;
  readonly instance: ProviderInstance;
}
export interface PmProviderHostService {
  readonly acquire: {
    (context: ProviderDriverContext, purpose: "usage"): Effect.Effect<PmProviderUsageLease, PmProviderBoundaryError, Scope.Scope>;
    (context: ProviderDriverContext, purpose: Exclude<PmProviderPurpose, "usage">): Effect.Effect<PmProviderLease, PmProviderBoundaryError, Scope.Scope>;
  };
  readonly invalidate: (instanceId: string) => Effect.Effect<void, PmProviderBoundaryError>;
  readonly shutdown: Effect.Effect<void, PmProviderBoundaryError>;
}
export interface PmProviderExecutionService {
  readonly run: (context: ProviderDriverContext, options: ProviderDriverRunOptions) => Promise<CliChatResult>;
  readonly fork: (
    context: ProviderDriverContext,
    source: NativeSessionRef,
    boundary: { readonly turnId?: string; readonly messageId?: string } | undefined,
    signal?: AbortSignal,
  ) => Promise<NativeSessionRef>;
}
