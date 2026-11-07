/** Translated behavior from vendor/cc-switch/src-tauri/src/app_config.rs and mcp/validation.rs. */

export const APP_IDS = [
  "claude", "codex", "gemini", "grokbuild", "opencode", "hermes",
  "pi", "mcode", "kimi", "dsh", "agy", "omp",
] as const;

export type AppId = (typeof APP_IDS)[number];
export type AppFlags = Record<AppId, boolean>;

export function emptyAppFlags(): AppFlags {
  return Object.fromEntries(APP_IDS.map((app) => [app, false])) as AppFlags;
}

export function appFlagsFromEnabled(enabled: Iterable<AppId>): AppFlags {
  const flags = emptyAppFlags();
  for (const app of enabled) flags[app] = true;
  return flags;
}

export function enabledApps(flags: AppFlags): AppId[] {
  return APP_IDS.filter((app) => flags[app]);
}

export function isAppId(value: unknown): value is AppId {
  return typeof value === "string" && (APP_IDS as readonly string[]).includes(value);
}

export interface McpServer {
  id: string;
  name: string;
  server: Record<string, unknown>;
  apps: AppFlags;
  description?: string;
  homepage?: string;
  docs?: string;
  tags: string[];
}

export type SyncMethod = "auto" | "symlink" | "copy";
export type SkillStorageLocation = "cc_switch" | "unified";

export interface SkillRepo {
  owner: string;
  name: string;
  branch: string;
  enabled: boolean;
}

export interface InstalledSkill {
  id: string;
  name: string;
  description?: string;
  directory: string;
  repoOwner?: string;
  repoName?: string;
  repoBranch?: string;
  readmeUrl?: string;
  apps: AppFlags;
  installedAt: number;
  contentHash?: string;
  updatedAt: number;
}

export interface DiscoverableSkill {
  key: string;
  name: string;
  description: string;
  directory: string;
  readmeUrl?: string;
  repoOwner: string;
  repoName: string;
  repoBranch: string;
}

export interface SkillRepoFailure {
  owner: string;
  name: string;
  branch: string;
  error: string;
}

export interface SkillDiscoveryResult {
  skills: DiscoverableSkill[];
  failures: SkillRepoFailure[];
}

export interface SkillUpdateInfo {
  id: string;
  name: string;
  currentHash?: string;
  remoteHash: string;
}

export interface SkillUpdateCheckResult {
  updates: SkillUpdateInfo[];
  failures: SkillRepoFailure[];
}

export interface SkillAppSyncOutcome {
  app: string;
  ok: boolean;
  error?: string;
  failedSkills: Array<{ directory: string; error: string }>;
}

export interface SkillUninstallResult {
  backupPath?: string;
  preservedPiPath?: string;
  piCleanupIncomplete?: boolean;
}

export interface ZipSkippedSkill {
  directory: string;
  existingId: string;
  existingName: string;
}

export interface ZipInstallResult {
  installed: InstalledSkill[];
  skipped: ZipSkippedSkill[];
}

export interface MigrationResult {
  migratedCount: number;
  skippedCount: number;
  errors: string[];
}

export interface SkillBackupEntry {
  backupId: string;
  backupPath: string;
  createdAt: number;
  skill: InstalledSkill;
}

export interface SkillMetadata {
  name?: string;
  description?: string;
}

export interface ImportSkillSelection {
  directory: string;
  apps: AppFlags;
}

export interface SkillsShDiscoverableSkill {
  key: string;
  name: string;
  directory: string;
  repoOwner: string;
  repoName: string;
  repoBranch: string;
  installs: number;
  readmeUrl?: string;
}

export interface SkillsShSearchResult {
  skills: SkillsShDiscoverableSkill[];
  totalCount: number;
  query: string;
}

export interface AppSettings {
  skillSyncMethod: SyncMethod;
  skillStorageLocation: SkillStorageLocation;
  backupRetainCount?: number;
  language?: string;
  visibleApps: Record<string, boolean>;
}

export interface HostInitialization {
  dataDir: string;
  homeDir: string;
  appDirs: Record<string, string>;
  claudeMcpFile?: string;
  secretKey: string;
}
