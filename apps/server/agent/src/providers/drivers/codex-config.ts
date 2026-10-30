// Local public-config and PM safety boundary. Original modules own native Home and argument execution.
import os from "node:os";
import path from "node:path";
import type { ProviderConfig } from "@agent-workspace/contracts/provider";
import { CodexSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

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
  return value === "~" ? os.homedir() : value.startsWith("~/") || value.startsWith("~\\") ? path.join(os.homedir(), value.slice(2)) : value;
}

export function validateCodexConfig(input: ProviderConfig): ProviderConfig {
  const config = nativeStringConfig(input, { setupMode: "existing", binaryPath: "codex", homePath: "", shadowHomePath: "", launchArgs: "" });
  if (config.setupMode !== "existing" && config.setupMode !== "managed") throw new Error("Codex setupMode must be existing or managed.");
  if (!config.binaryPath) config.binaryPath = "codex";
  validateCodexLaunchArgs(tokenizeNativeArgs(config.launchArgs!));
  const decoded = Schema.decodeUnknownSync(CodexSettings)(config);
  return { setupMode: config.setupMode, binaryPath: decoded.binaryPath, homePath: decoded.homePath,
    shadowHomePath: decoded.shadowHomePath, launchArgs: decoded.launchArgs };
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
