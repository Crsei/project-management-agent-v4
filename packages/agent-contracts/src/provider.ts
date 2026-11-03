import type {
  ModelCapabilities,
  ProviderDriverKind,
  ProviderOptionDescriptor as NativeProviderOptionDescriptor,
  ProviderOptionSelection as NativeProviderOptionSelection,
  ProviderSettingsFormControl,
} from "@t3tools/contracts";
import type { ProviderIcon, ProviderEnvironmentField } from "@t3tools/provider-core/client";
import type { AgentScope } from "./chat.ts";
import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";

/** Provider-native discovery is distinct from saved WorkspaceSkill instructions. */
export type ProviderSkillsRefreshInput = { scope: AgentScope; fresh?: boolean };
export type ProviderSkillsSnapshot = {
  instanceId: string;
  revision: number;
  cwd: string;
  checkedAt: string;
  pending: boolean;
  skills: readonly ServerProviderSkill[];
  commands: readonly ServerProviderSlashCommand[];
  invocation: { skills: boolean; commands: boolean; skillSyntax: "mention" | "leading-mention" | "none"; commandAllowlist?: readonly string[] };
  error?: { code: string; message: string };
};

export type ProviderDriver =
  | "codex" | "claude" | "cursor" | "grok" | "opencode"
  | "antigravity" | "muse" | "pi" | "omp" | "acpRegistry" | "fx";

export type ProviderConfig = Record<string, string | number | boolean | string[]>;
export type ProviderConfigInput = Record<string, string | number | boolean | string[] | null>;
export type ProviderConfigField = {
  key: string;
  label: string;
  description?: string;
  type: "string" | "password" | "number" | "boolean" | "select" | "string-list";
  clearWhenEmpty?: "omit" | "persist";
  defaultValue?: string | number | boolean | string[];
  placeholder?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  required?: boolean;
  /** Original schema control; PM type remains the serialized form compatibility boundary. */
  control?: ProviderSettingsFormControl;
  secret?: boolean;
};
export type ProviderDriverDefinition = {
  driver: ProviderDriver;
  label: string;
  description: string;
  defaultInstance: boolean;
  fields: ProviderConfigField[];
  docsUrl?: string;
  source: string;
  installationAction?: { label: string; description: string };
  updateAction?: { label: string; description: string };
  removalAction?: { label: string; description: string };
  environmentFields?: readonly ProviderEnvironmentField[];
  featured?: boolean;
  supportsCustomModels?: boolean;
  acpRegistryAgentIds?: string[];
  /** Original client metadata; driver keeps PM's existing `claude` identifier. */
  clientDriver: ProviderDriverKind;
  modelFamilies: readonly string[];
  icon?: ProviderIcon;
  badgeLabel?: string;
};

export type ProviderAuthMode = "agent";

export type ProviderAuthStatus = "authenticated" | "unauthenticated" | "unknown" | "not-installed";

export type ProviderModelSource = "builtin" | "discovered" | "custom";
export type ProviderOptionDescriptor = NativeProviderOptionDescriptor;
export type ProviderOptionSelection = NativeProviderOptionSelection;
export type ProviderModelCapabilities = ModelCapabilities;
export type ProviderCustomModel = { id: string; label: string; capabilities?: ProviderModelCapabilities | undefined };
export type ProviderEnvironmentEntry = { name: string; value: string; sensitive: boolean; valueRedacted?: boolean };
export type ProviderModelPreferences = { hidden: string[]; order: string[]; favorites: string[]; options: Record<string, ProviderOptionSelection[]> };
export type ProviderMaintenanceAction = "install" | "update" | "remove";
export type ProviderMaintenanceProgress = { message?: string; bytesDownloaded?: number; bytesTotal?: number };
export type ProviderMaintenanceState = ProviderMaintenanceProgress & { status: "idle" | "running" | "succeeded" | "failed" | "cancelled"; action?: ProviderMaintenanceAction; startedAt?: string; finishedAt?: string };
export type ProviderSettings = { revision: number; healthRefreshIntervalSeconds: number };

export type ProviderModel = {
  id: string;
  label: string;
  shortName?: string | undefined;
  badge?: "new" | undefined;
  subProvider?: string | undefined;
  source?: ProviderModelSource | undefined;
  temperature: boolean;
  reasoning?: boolean | undefined;
  capabilities?: ProviderModelCapabilities | undefined;
  isDefault?: boolean | undefined;
  legacy?: boolean | undefined;
  disabledReason?: string | undefined;
  aliases?: string[] | undefined;
};

export type ProviderCapabilities = {
  nativeResume: boolean;
  nativeFork: boolean;
  boundedFork: boolean;
  modelTransition: "native" | "portable";
  portableHandoff: true;
};

export type NativeSessionRef = {
  providerInstanceId: string;
  driver: ProviderDriver;
  sessionId: string;
  turnId?: string;
  messageId?: string;
  modelId?: string;
  cwd?: string;
  instanceRevision?: number;
};

export type CliSessionOptions = {
  resume?: NativeSessionRef;
  fork?: {
    source: NativeSessionRef;
    /** Inclusive, stable native boundary; never a browser-generated message ID. */
    boundary?: { turnId?: string; messageId?: string };
  };
};

export type ProviderErrorClass =
  | "usage_limit"
  | "authentication"
  | "cancelled"
  | "unsupported"
  | "provider_error";

export type ProviderFailure = {
  errorClass: ProviderErrorClass;
  message: string;
  resetAt?: string;
  providerInstanceId?: string;
};

/** Secret config fields and environment values are write-only. */
export type ProviderInstanceInput = {
  instanceId?: string;
  driver: ProviderDriver;
  label?: string;
  enabled?: boolean;
  accentColor?: string;
  registryIconUrl?: string;
  config?: ProviderConfigInput;
  environment?: ProviderEnvironmentEntry[];
  customModels?: ProviderCustomModel[];
  modelPreferences?: ProviderModelPreferences;
};

export type ProviderInstanceUpdate = Partial<Omit<ProviderInstanceInput, "instanceId" | "driver">>;

export type ProviderInstance = {
  instanceId: string;
  driver: ProviderDriver;
  label: string;
  enabled: boolean;
  accentColor?: string;
  registryIconUrl?: string;
  config: ProviderConfig;
  secretConfigKeys: string[];
  authMethods?: ProviderAuthMethod[];
  authMode: ProviderAuthMode;
  authStatus: ProviderAuthStatus;
  /** Checked original runtime readiness, independent of whether its account identity is known. */
  nativeSessionReady: boolean;
  /** Native Codex requirement, independent of the reported account identity. */
  requiresOpenaiAuth?: boolean;
  authLabel?: string;
  email?: string;
  configured: boolean;
  credentialSource: "provider" | null;
  models: ProviderModel[];
  modelsSource: "builtin" | "discovered" | "mixed";
  customModels?: ProviderCustomModel[];
  modelPreferences?: ProviderModelPreferences;
  lastConnectionTest?: ProviderTestResult;
  installation?: ProviderInstallation;
  updateRequiredModels?: { id: string; label: string; minVersion: string }[];
  authCheckedAt?: string;
  message?: string;
  canLogin: boolean;
  canLogout: boolean;
  loginMethod?: ProviderLoginMethod;
  docsUrl?: string;
  capabilities?: ProviderCapabilities;
  environment?: ProviderEnvironmentEntry[];
  revision?: number;
};

export type ProvidersResponse = { providers: ProviderInstance[]; drivers: ProviderDriverDefinition[] };

export type ProviderTestResult = {
  ok: boolean;
  latencyMs: number;
  error?: string | undefined;
  models?: ProviderModel[] | undefined;
  checkedAt?: string | undefined;
  instanceRevision?: number | undefined;
  kind?: "agent-status" | undefined;
  authentication?: "authenticated" | "unauthenticated" | "unknown" | undefined;
  /** Absent only on historical saved checks; absence is not readiness. */
  nativeSessionReady?: boolean | undefined;
  requiresOpenaiAuth?: boolean | undefined;
};

export type ProviderInstallation = {
  status: "installed" | "not-installed" | "unknown" | "not-applicable";
  checkedAt?: string | undefined;
  version?: string | undefined;
  latestVersion?: string | undefined;
  updateAvailable?: boolean | undefined;
  updateSupported?: boolean | undefined;
  executablePath?: string | undefined;
  error?: string | undefined;
};

export type ProviderLoginMethod = "credentials" | "device-code" | "browser" | "terminal";

export type ProviderAuthMethod = {
  id: string;
  name: string;
  description?: string;
  type: ProviderLoginMethod;
  fields?: { name: string; label: string; secret: boolean }[];
};

export type ProviderAuthInteraction =
  | {
      type: "credentials";
      id: string;
      fields: { name: string; label: string; secret: boolean }[];
    }
  | {
      type: "device-code" | "browser";
      id: string;
      url: string;
      userCode?: string;
      requiresConsent?: boolean;
      acceptsCallback?: boolean;
    }
  | {
      type: "terminal";
      id: string;
      output: string;
    };

export type ProviderAuthPhase =
  | "idle"
  | "starting"
  | "waiting"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ProviderAuthState = {
  instanceId: string;
  phase: ProviderAuthPhase;
  flowId: string | null;
  authorizationUrl: string | null;
  userCode: string | null;
  output: string;
  expiresAt: string | null;
  message: string | null;
  methods: ProviderAuthMethod[];
  interaction: ProviderAuthInteraction | null;
  credentialOwner: "provider";
};

export type ProviderAuthStartInput = {
  methodId?: string;
  values?: Record<string, string>;
};

export type ProviderAuthStartResponse = ProviderAuthState;

export type ProviderAuthStreamEvent =
  | { type: "state"; state: ProviderAuthState }
  | { type: "output"; output: string }
  | { type: "error"; message: string };
