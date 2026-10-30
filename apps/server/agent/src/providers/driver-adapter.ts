import type {
  NativeSessionRef, ProviderAuthInteraction, ProviderAuthMethod, ProviderAuthPhase,
  ProviderCapabilities, ProviderConfig, ProviderDriver, ProviderDriverDefinition,
  ProviderInstallation, ProviderModel, ProviderOptionSelection, ProviderMaintenanceProgress, ProviderCustomModel,
} from "@agent-workspace/contracts/provider";
import type { CliChatResult } from "../agents/cli-chat.ts";
import type { NativeOutputEvent, NativeInteractionRequest, NativeInteractionResponse } from "@agent-workspace/contracts/output";
import type { NativeUsageUpdate } from "@agent-workspace/contracts/usage";
import type { PmExecutionIdentity } from "./t3code/contract.ts";

export type ProviderDriverContext = {
  instanceId: string;
  driver: ProviderDriver;
  config: ProviderConfig;
  homeDirectory: string;
  /** Application-owned artifacts; never an external native configuration root. */
  stateDirectory: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  instanceEnvironment?: Record<string, string>;
  revision: number;
  customModels?: ProviderCustomModel[];
  pmToolBridge?: { command: string; args: string[] };
  execution?: PmExecutionIdentity;
  /** Request-local PM recheck; never persisted, passed in argv/env, or treated as native permission. */
  authorizeExecution?: (action: "compaction" | "tool") => Promise<void>;
};

export type ProviderDriverStatus = {
  installation: ProviderInstallation;
  authentication: "authenticated" | "unauthenticated" | "unknown";
  /** Explicit native readiness; authentication identity remains independently reported. */
  nativeSessionReady?: boolean;
  requiresOpenaiAuth?: boolean;
  authLabel?: string;
  email?: string;
  message?: string;
  models: ProviderModel[];
  updateRequiredModels?: { id: string; label: string; minVersion: string }[];
  methods: ProviderAuthMethod[];
  canLogout: boolean;
  capabilities?: ProviderCapabilities;
};

export type ProviderDriverAuthOptions = {
  methodId?: string;
  values?: Record<string, string>;
  signal: AbortSignal;
  onUpdate: (update: {
    phase?: ProviderAuthPhase;
    interaction?: ProviderAuthInteraction | null;
    message?: string;
    output?: string;
  }) => void;
  readInput: () => Promise<string>;
  saveEnvironment?: (credentials: Record<string, string>) => Promise<void>;
};

export type ProviderDriverRunOptions = {
  model: string;
  modelOptions?: ProviderOptionSelection[];
  interactionMode?: "default" | "plan";
  prompt: string;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onEvent?: (event: NativeOutputEvent) => void;
  onRequest?: (request: NativeInteractionRequest) => Promise<NativeInteractionResponse>;
  onUsage?: (update: NativeUsageUpdate) => void;
  resume?: NativeSessionRef;
  onSession?: (ref: NativeSessionRef) => void;
};

export interface NativeProviderAdapter {
  definition: ProviderDriverDefinition;
  validateConfig: (config: ProviderConfig) => ProviderConfig;
  check: (context: ProviderDriverContext, signal?: AbortSignal) => Promise<ProviderDriverStatus>;
  authenticate: (context: ProviderDriverContext, options: ProviderDriverAuthOptions) => Promise<void>;
  logout: (context: ProviderDriverContext, signal?: AbortSignal) => Promise<void>;
  run: (context: ProviderDriverContext, options: ProviderDriverRunOptions) => Promise<CliChatResult>;
  prepare?: (context: ProviderDriverContext, signal?: AbortSignal, onProgress?: (progress: ProviderMaintenanceProgress) => void) => Promise<{ message: string }>;
  update?: (context: ProviderDriverContext, signal?: AbortSignal, onProgress?: (progress: ProviderMaintenanceProgress) => void) => Promise<{ message: string }>;
  removeInstallation?: (context: ProviderDriverContext, signal?: AbortSignal, onProgress?: (progress: ProviderMaintenanceProgress) => void) => Promise<{ message: string }>;
}
