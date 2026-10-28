import type {
  NativeSessionRef, ProviderAuthInteraction, ProviderAuthMethod, ProviderAuthPhase,
  ProviderCapabilities, ProviderConfig, ProviderDriver, ProviderDriverDefinition,
  ProviderInstallation, ProviderModel,
} from "@agent-workspace/contracts/provider";
import type { CliChatResult } from "../agents/cli-chat.ts";
import type { NativeOutputEvent, NativeInteractionRequest, NativeInteractionResponse } from "@agent-workspace/contracts/output";
import type { NativeUsageUpdate } from "@agent-workspace/contracts/usage";

export type ProviderDriverContext = {
  instanceId: string;
  driver: ProviderDriver;
  config: ProviderConfig;
  homeDirectory: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  revision: number;
};

export type ProviderDriverStatus = {
  installation: ProviderInstallation;
  authentication: "authenticated" | "unauthenticated" | "unknown";
  authLabel?: string;
  email?: string;
  message?: string;
  models: ProviderModel[];
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
};

export type ProviderDriverRunOptions = {
  model: string;
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
  prepare?: (context: ProviderDriverContext, signal?: AbortSignal) => Promise<{ message: string }>;
}
