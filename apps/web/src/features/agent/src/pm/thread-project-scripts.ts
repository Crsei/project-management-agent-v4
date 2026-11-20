/**
 * Project scripts shown in the Session details panel.
 *
 * The inspector file API is the only reader: scripts come from the Session's
 * server-resolved execution directory (`package.json`), never from a cached copy
 * or from a guessed workspace path.
 */

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type ProjectScript = {
  /** Name as written in `package.json`; this is what the user sees. */
  name: string;
  /** Exact command sent to the terminal, quoted for POSIX shells. */
  command: string;
};

export type ProjectScripts =
  | { status: "ready"; manager: PackageManager; scripts: ProjectScript[] }
  | { status: "no_scripts"; manager: PackageManager }
  | { status: "invalid"; reason: "invalid_json" | "invalid_package" };

const managers: ReadonlyArray<PackageManager> = ["npm", "pnpm", "yarn", "bun"];
const safeShellWord = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Quote one word for a POSIX shell; script names are untrusted package data. */
export function shellQuote(value: string): string {
  if (value === "") return "''";
  if (safeShellWord.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function packageManagerFromPackageJson(value: unknown): PackageManager {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "npm";
  const field = "packageManager" in value ? value.packageManager : undefined;
  if (typeof field !== "string") return "npm";
  const name = field.split("@")[0]?.toLowerCase();
  return managers.find(manager => manager === name) ?? "npm";
}

export function packageScriptCommand(manager: PackageManager, name: string): string {
  return `${manager} run ${shellQuote(name)}`;
}

/**
 * Parse the raw file payload. A package without a `scripts` object is a normal
 * empty state, not an error; malformed JSON is reported so the UI can explain
 * why nothing can run.
 */
export function readProjectScripts(content: string): ProjectScripts {
  let value: unknown;
  try {
    // Editors on Windows may save a UTF-8 BOM; JSON.parse rejects it.
    value = JSON.parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content);
  } catch {
    return { status: "invalid", reason: "invalid_json" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "invalid", reason: "invalid_package" };
  const manager = packageManagerFromPackageJson(value);
  const raw = "scripts" in value ? value.scripts : undefined;
  if (raw === undefined || raw === null) return { status: "no_scripts", manager };
  if (typeof raw !== "object" || Array.isArray(raw)) return { status: "invalid", reason: "invalid_package" };
  const scripts = Object.entries(raw)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name]) => ({ name, command: packageScriptCommand(manager, name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return scripts.length ? { status: "ready", manager, scripts } : { status: "no_scripts", manager };
}
