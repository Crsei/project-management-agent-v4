import type { ProviderDriver } from "./provider.ts";

export type DiagnosticStatus = "ok" | "unavailable" | "unknown";

export type AgentDiagnostics = {
  schemaVersion: 1;
  generatedAt: string;
  service: {
    http: "responding";
    durableStore: DiagnosticStatus;
    ownsStore: boolean;
    integrity: "ok" | "failed" | "not-checked";
    threads: number | null;
    histories: number | null;
    messages: number | null;
  };
  runtime: {
    applicationVersion: string | null;
    versionSource: "package.json" | "unknown";
    nodeVersion: string;
    platform: string;
    architecture: string;
  };
  providers: {
    configuration: DiagnosticStatus;
    total: number;
    native: number;
    /** Historical unsupported rows are retained, never probed or treated as ready. */
    inactive: number;
    /** A persisted observation only, never an implicit network or login probe. */
    observations: Array<{
      index: number;
      driver: ProviderDriver;
      enabled: boolean;
      authentication: "authenticated" | "unauthenticated" | "unknown" | "not-installed";
      connection: "ok" | "failed" | "unknown";
      checkedAt: string | null;
    }>;
  };
  recentFailures: {
    available: boolean;
    items: Array<{
      source: "chat" | "execution";
      status: "failed" | "interrupted";
      errorClass: "usage_limit" | "authentication" | "cancelled" | "unsupported" | "provider_error" | "interrupted" | "unknown";
      endedAt: string | null;
    }>;
  };
  privacy: {
    reportContains: "allowlisted-status-only";
    excludes: string[];
    providerExecutionVerified: false;
  };
};

export type AgentStorage = {
  dataDirectory: string;
  entries: Array<{
    kind: "database" | "provider-config" | "provider-credentials" | "provider-homes" | "maintenance-lock";
    path: string;
    owner: "Agent service" | "Provider CLI";
    status: "present" | "missing" | "unavailable";
    bytes: number | null;
    sensitive: boolean;
    backupPolicy: string;
  }>;
  exclusions: string[];
  maintenance: {
    offlineOnly: true;
    httpBackupAvailable: false;
    restoreRequiresEmptyTarget: true;
    commands: string[];
  };
};
