/** Translated from apps/server/cc-switch-host/src/settings.rs. */
import path from "node:path";
import { writeJsonFile, readTextFile } from "./config/atomic.ts";
import { AppError } from "./errors.ts";
import { appDir, dataDir } from "./host-context.ts";
import type { AppId, AppSettings, SkillStorageLocation, SyncMethod } from "./types.ts";

const DEFAULTS: AppSettings = {
  skillSyncMethod: "auto",
  skillStorageLocation: "cc_switch",
  visibleApps: {},
};

let settings: AppSettings = { ...DEFAULTS, visibleApps: {} };

function settingsPath(): string {
  return path.join(dataDir(), "settings.json");
}

export function reloadSettings(): void {
  const text = readTextFile(settingsPath());
  if (text === undefined) {
    settings = { ...DEFAULTS, visibleApps: {} };
    return;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new AppError("CONFIG", "Invalid settings.json"); }
  settings = parseSettings(value);
}

function parseSettings(value: unknown): AppSettings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AppError("CONFIG", "Settings must be an object");
  const object = value as Record<string, unknown>;
  const allowed: Record<string, true> = { skillSyncMethod: true, skillStorageLocation: true, backupRetainCount: true, language: true, visibleApps: true };
  for (const key of Object.keys(object)) if (!allowed[key]) throw new AppError("CONFIG", "Setting is not host-managed");
  const sync = object.skillSyncMethod ?? "auto";
  if (!["auto", "symlink", "copy"].includes(String(sync))) throw new AppError("CONFIG", "Invalid skill sync method");
  const storage = object.skillStorageLocation ?? "cc_switch";
  if (!["cc_switch", "unified"].includes(String(storage))) throw new AppError("CONFIG", "Invalid skill storage location");
  const backup = object.backupRetainCount;
  if (backup !== undefined && backup !== null && (typeof backup !== "number" || !Number.isInteger(backup) || backup < 0 || backup > 0xffffffff)) throw new AppError("CONFIG", "Invalid backup retain count");
  const language = object.language;
  if (language !== undefined && language !== null && (typeof language !== "string" || language.length > 20)) throw new AppError("CONFIG", "Invalid language");
  const visible = object.visibleApps ?? {};
  if (visible === null || typeof visible !== "object" || Array.isArray(visible)) throw new AppError("CONFIG", "Invalid visibleApps");
  const visibleApps: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(visible)) {
    if (typeof enabled !== "boolean") throw new AppError("CONFIG", "Invalid visibleApps");
    visibleApps[key] = enabled;
  }
  return {
    skillSyncMethod: sync as SyncMethod,
    skillStorageLocation: storage as SkillStorageLocation,
    ...(typeof backup === "number" ? { backupRetainCount: backup } : {}),
    ...(typeof language === "string" ? { language } : {}),
    visibleApps,
  };
}

export function getSettings(): AppSettings {
  return { ...settings, visibleApps: { ...settings.visibleApps } };
}

export function updateSettings(next: AppSettings): void {
  writeJsonFile(settingsPath(), next, true);
  settings = { ...next, visibleApps: { ...next.visibleApps } };
}

export function getSkillSyncMethod(): SyncMethod { return settings.skillSyncMethod; }
export function getSkillStorageLocation(): SkillStorageLocation { return settings.skillStorageLocation; }

export function setSkillStorageLocation(location: SkillStorageLocation): void {
  const previous = settings;
  settings = { ...settings, skillStorageLocation: location };
  try {
    writeJsonFile(settingsPath(), settings, true);
  } catch (error) {
    settings = previous;
    throw error;
  }
}

export function effectiveBackupRetainCount(): number {
  const value = settings.backupRetainCount;
  return value === undefined ? 10 : Math.max(1, value);
}

export function overrideDir(app: AppId): string {
  // Headless contexts always use the explicitly authorized app root.
  return appDir(app);
}
