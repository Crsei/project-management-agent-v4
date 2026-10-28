// Ported from t3code packages/shared/src/cliArgs.ts and
// apps/server/src/provider/Drivers/CodexHomeLayout.ts (MIT).
import { lstat, mkdir, readdir, readlink, symlink, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderConfig } from "@agent-workspace/contracts/provider";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { CliChatError, sanitizeErrorMessage } from "../../agents/cli-chat.ts";
import { projectDirectory } from "../../paths.ts";

export function tokenizeNativeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let quoted = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (quote) {
      if (char === quote) { quote = undefined; quoted = true; }
      else if (char === "\\" && quote === '"' && ['"', "\\", "$", "`"].includes(input[index + 1] ?? "")) current += input[++index];
      else current += char;
    } else if (char === "'" || char === '"') { quote = char; quoted = true; }
    else if (/\s/.test(char)) { if (current || quoted) { tokens.push(current); current = ""; quoted = false; } }
    else if (char === "\\" && /[\s'"]/.test(input[index + 1] ?? "")) current += input[++index];
    else current += char;
  }
  if (quote) throw new Error("Launch arguments contain an unterminated quote.");
  if (current || quoted) tokens.push(current);
  return tokens;
}

export function nativeStringConfig(config: ProviderConfig, defaults: Record<string, string>): Record<string, string> {
  const result = { ...defaults };
  for (const [key, value] of Object.entries(config)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown native provider configuration field: ${key}`);
    if (typeof value !== "string" || value.includes("\0") || value.length > 16_384) throw new Error(`Invalid ${key}: expected a string without NUL characters (maximum 16384 characters).`);
    result[key] = value.trim();
  }
  return result;
}

export function expandNativePath(value: string): string {
  return value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

export function nativeFailure(context: ProviderDriverContext, error: unknown, aborted = false): CliChatError {
  let message = sanitizeErrorMessage(error, "Native provider request failed.");
  for (const [key, value] of Object.entries(context.env)) {
    if (value && value.length >= 4 && /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i.test(key)) message = message.split(value).join("[redacted]");
  }
  return new CliChatError(aborted ? "aborted" : "provider_error", message, aborted ? { code: "aborted" } : error, context.instanceId);
}

const sharedDirectories = ["sessions", "archived_sessions", "sqlite", "shell_snapshots", "worktrees", "skills", "plugins", "cache", "logs", "mcp-oauth-locks"];
const privateEntries: Record<string, true> = { "auth.json": true, "models_cache.json": true };
const localEntries: Record<string, true> = { log: true, memories: true, tmp: true, ".DS_Store": true };
export async function codexEnvironment(context: ProviderDriverContext): Promise<NodeJS.ProcessEnv> {
  const effective = context.homeDirectory;
  await mkdir(effective, { recursive: true, mode: 0o700 });
  if (context.config.shadowHomePath) {
    const shared = path.resolve(projectDirectory(), expandNativePath(String(context.config.homePath)));
    if (shared === effective || effective.startsWith(shared + path.sep) || shared.startsWith(effective + path.sep)) throw new Error("Codex shared and shadow homes must not overlap.");
    await mkdir(shared, { recursive: true, mode: 0o700 });
    await Promise.all(sharedDirectories.map((entry) => mkdir(path.join(shared, entry), { recursive: true, mode: 0o700 })));
    for (const entry of Object.keys(privateEntries)) {
      const destination = path.join(effective, entry);
      const stat = await lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (stat?.isSymbolicLink()) {
        if (entry === "auth.json") throw new Error("Codex shadow auth.json must be a private file, not a symlink.");
        await unlink(destination);
      }
    }
    const entries = new Set([...sharedDirectories, ...(await readdir(shared)).filter((entry) => !Object.hasOwn(privateEntries, entry) && !Object.hasOwn(localEntries, entry))]);
    for (const entry of entries) {
      const destination = path.join(effective, entry);
      const target = path.join(shared, entry);
      const stat = await lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (stat) {
        if (!stat.isSymbolicLink()) throw new Error(`Codex shadow entry ${entry} exists and is not a symlink.`);
        if (path.resolve(path.dirname(destination), await readlink(destination)) === target) continue;
        await unlink(destination);
      }
      await symlink(target, destination);
    }
  }
  return { ...context.env, CODEX_HOME: effective };
}

export function codexLaunchArgs(context: ProviderDriverContext): string[] {
  return tokenizeNativeArgs(context.env.T3CODE_CODEX_LAUNCH_ARGS?.trim() || String(context.config.launchArgs ?? ""));
}

export function validateCodexConfig(input: ProviderConfig): ProviderConfig {
  const config = nativeStringConfig(input, { binaryPath: "codex", homePath: "", shadowHomePath: "", launchArgs: "" });
  if (!config.binaryPath) config.binaryPath = "codex";
  if (config.shadowHomePath && !config.homePath) throw new Error("Codex shadowHomePath requires an explicit instance-owned homePath; global homes are never imported.");
  validateCodexLaunchArgs(tokenizeNativeArgs(config.launchArgs!));
  return config;
}

export function validateCodexLaunchArgs(args: string[]): void {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    // Source launch arguments are app-server arguments, not shell commands. Keep
    // the RPC stdio transport and PM sandbox authoritative even with config overrides.
    if (/^(?:--listen|--analytics-default-enabled|--enable-log-messages)(?:=|$)/.test(argument)) throw new Error(`Unsupported app-server transport argument: ${argument}`);
    if (/^(?:--dangerously-bypass-approvals-and-sandbox|--yolo|--full-auto|--sandbox|--ask-for-approval|--cd|--add-dir)(?:=|$)/.test(argument)) throw new Error(`Launch argument cannot override PM safety: ${argument}`);
    if (argument === "--config" || argument === "-c" || argument.startsWith("--config=") || argument.startsWith("-c=")) {
      const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : args[++index];
      if (!value || /(?:sandbox|approval|permissions|additional_write|writable_roots|cwd|codex_home)/i.test(value.split("=")[0]!)) throw new Error("Launch configuration cannot override native sandbox, approvals or homes.");
    } else if (!argument.startsWith("-") && (index === 0 || !args[index - 1]!.startsWith("-"))) throw new Error("Launch arguments must be native app-server flags.");
  }
}
