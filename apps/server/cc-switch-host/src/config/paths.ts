/** Translated native path resolution from the cc-switch headless adapters. */
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { appDir, claudeMcpFile, homeDir } from "../host-context.ts";
import { AppError } from "../errors.ts";

export function claudeMcpPath(): string { return claudeMcpFile(); }

export function codexConfigPath(): string {
  return path.join(appDir("codex"), "config.toml");
}

export function grokConfigPath(): string {
  return path.join(appDir("grokbuild"), "config.toml");
}

export function geminiSettingsPath(): string {
  return path.join(appDir("gemini"), "settings.json");
}

export function opencodeConfigPath(): string {
  const directory = appDir("opencode");
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return path.join(directory, "opencode.json");
}

export function hermesConfigPath(): string {
  return path.join(appDir("hermes"), "config.yaml");
}

export function piAgentDir(): string {
  return appDir("pi");
}
export function piMcpPath(): string {
  return path.join(piAgentDir(), "mcp.json");
}

export function ompAgentDir(): string {
  return appDir("omp");
}
export function ompMcpPath(): string {
  return path.join(ompAgentDir(), "mcp.json");
}

export function mcodeDir(): string {
  return appDir("mcode");
}
export function mcodeMcpPath(): string {
  return path.join(mcodeDir(), "mcp.json");
}

export function kimiDir(): string {
  return appDir("kimi");
}
export function kimiMcpPath(): string {
  return path.join(kimiDir(), "mcp.json");
}

export function dshDataDir(): string {
  return appDir("dsh");
}
export const DSH_TARGET_PROFILES = ["web", "desktop", "headless", "acp"] as const;
export function dshProfilePath(name: string): string {
  return path.join(dshDataDir(), "profiles", name, "cordis.patch.yml");
}
export function dshTargetPaths(): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const name of DSH_TARGET_PROFILES) {
    const file = dshProfilePath(name);
    if (name !== "web" && name !== "desktop" && !existsSync(file)) continue;
    const identity = pathIdentity(file);
    if (seen.has(identity)) continue;
    seen.add(identity);
    paths.push(file);
  }
  return paths;
}
export function dshConfigPath(): string {
  for (const name of ["web", "desktop"] as const) {
    const file = dshProfilePath(name);
    if (existsSync(file)) return file;
  }
  return dshTargetPaths().find(existsSync) ?? dshProfilePath("web");
}
export function dshReadPaths(): string[] {
  const authoritative = dshConfigPath();
  const result: string[] = [];
  for (const file of [authoritative, ...dshTargetPaths()]) {
    if ((file === authoritative || existsSync(file)) && !result.includes(file)) result.push(file);
  }
  return result.length ? result : [authoritative];
}
function pathIdentity(file: string): string {
  try {
    return path.join(realpathSync(path.dirname(file)), path.basename(file));
  } catch {
    return file;
  }
}

export function agyDir(): string {
  return appDir("agy");
}
export function agyMcpPath(): string {
  return path.join(agyDir(), "mcp_config.json");
}

export const NATIVE_MCP_PATHS: Record<string, () => string[]> = {
  claude: () => [claudeMcpPath()],
  codex: () => [codexConfigPath()],
  gemini: () => [geminiSettingsPath()],
  grokbuild: () => [grokConfigPath()],
  opencode: () => [opencodeConfigPath()],
  hermes: () => [hermesConfigPath()],
  agy: () => [agyMcpPath()],
  dsh: () => dshTargetPaths(),
  pi: () => [piMcpPath()],
  omp: () => [ompMcpPath()],
  mcode: () => [mcodeMcpPath()],
  kimi: () => [kimiMcpPath()],
};

export function nativeMcpSection(app: string): string {
  if (app === "codex" || app === "grokbuild" || app === "hermes") return "mcp_servers";
  if (app === "opencode") return "mcp";
  return "mcpServers";
}

export function requireAbsolute(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new AppError("INVALID_INPUT", `${label} must be an absolute path`);
  return value;
}

export function homePath(...parts: string[]): string {
  return path.join(homeDir(), ...parts);
}
