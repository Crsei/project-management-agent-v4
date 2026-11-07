/** Translated constants from vendor/cc-switch/src-tauri/src/services/skill.rs. */

export const HOST_SCHEMA_VERSION = 2;
export const BACKUP_RETAIN_COUNT = 20;
export const MAX_ARCHIVE_ENTRIES = 30_000;
export const MAX_ARCHIVE_TOTAL_BYTES = 512 * 1024 * 1024;
export const MAX_SYMLINK_TARGET_BYTES = 4 * 1024;
export const DIRECTORY_BUDGET_COST = 4096;
export const FILE_ENTRY_BUDGET_COST = 4096;
export const MAX_ARCHIVE_DOWNLOAD_BYTES = MAX_ARCHIVE_TOTAL_BYTES;
export const SKILL_DOWNLOAD_TIMEOUT_MS = 60_000;
export const SKILLS_SH_TIMEOUT_MS = 10_000;
export const DISCOVERY_CACHE_TTL_MS = 10 * 60_000;
export const MCP_CHECK_TIMEOUT_MS = 30_000;
export const MAX_CONCURRENT_MCP_CHECKS = 3;
export const DEFAULT_SKILL_REPOS = [
  { owner: "anthropics", name: "skills", branch: "main", enabled: true },
  { owner: "ComposioHQ", name: "awesome-claude-skills", branch: "master", enabled: true },
  { owner: "cexll", name: "myclaude", branch: "master", enabled: true },
  { owner: "JimLiu", name: "baoyu-skills", branch: "main", enabled: true },
] as const;
