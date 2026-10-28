export type ProviderDriver =
  | "codex" | "claude" | "cursor" | "grok" | "opencode"
  | "antigravity" | "muse" | "pi" | "acpRegistry";

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
};
export type ProviderDriverDefinition = {
  driver: ProviderDriver;
  label: string;
  description: string;
  defaultInstance: boolean;
  fields: ProviderConfigField[];
  docsUrl?: string;
  source: string;
  models?: ProviderModel[];
  installationAction?: { label: string; description: string };
};

export type ProviderAuthMode = "agent";

export type ProviderAuthStatus = "authenticated" | "unauthenticated" | "unknown" | "not-installed";

export type ProviderModelSource = "builtin" | "discovered" | "custom";
export type ProviderCustomModel = { id: string; label: string };

export type ProviderModel = {
  id: string;
  label: string;
  source?: ProviderModelSource;
  temperature: boolean;
  reasoning?: boolean;
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
  label: string;
  enabled?: boolean;
  accentColor?: string;
  config?: ProviderConfigInput;
  env?: Record<string, string | null>;
  customModels?: ProviderCustomModel[];
};

export type ProviderInstanceUpdate = Partial<Omit<ProviderInstanceInput, "instanceId" | "driver">>;

export type ProviderInstance = {
  instanceId: string;
  driver: ProviderDriver;
  label: string;
  enabled: boolean;
  accentColor?: string;
  config: ProviderConfig;
  secretConfigKeys: string[];
  authMethods?: ProviderAuthMethod[];
  authMode: ProviderAuthMode;
  authStatus: ProviderAuthStatus;
  authLabel?: string;
  email?: string;
  configured: boolean;
  credentialSource: "provider" | null;
  models: ProviderModel[];
  modelsSource: "builtin" | "discovered" | "mixed";
  customModels?: ProviderCustomModel[];
  lastConnectionTest?: ProviderTestResult;
  installation?: ProviderInstallation;
  authCheckedAt?: string;
  message?: string;
  canLogin: boolean;
  canLogout: boolean;
  loginMethod?: ProviderLoginMethod;
  docsUrl?: string;
  capabilities?: ProviderCapabilities;
  envKeys?: string[];
  revision?: number;
};

export type ProvidersResponse = { providers: ProviderInstance[]; drivers: ProviderDriverDefinition[] };

export type ProviderTestResult = {
  ok: boolean;
  latencyMs: number;
  error?: string;
  models?: ProviderModel[];
  checkedAt?: string;
  instanceRevision?: number;
  kind?: "agent-status";
  authentication?: "authenticated" | "unauthenticated" | "unknown";
};

export type ProviderInstallation = {
  status: "installed" | "not-installed" | "unknown" | "not-applicable";
  checkedAt?: string;
  version?: string;
  executablePath?: string;
  error?: string;
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
