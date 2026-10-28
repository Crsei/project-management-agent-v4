// Ported from t3code packages/provider-pi/src/server/mcpInjection.ts and shared/src/cliArgs.ts (MIT).
import path from "node:path";
import type { ProviderConfig } from "@agent-workspace/contracts/provider";
import type { ProviderDriverContext } from "../driver-adapter.ts";

const reserved: Record<string, true> = { "--continue": true, "-c": true, "--export": true, "--fork": true, "--help": true, "-h": true, "--list-models": true, "--mode": true, "--no-session": true, "--print": true, "-p": true, "--resume": true, "-r": true, "--session": true, "--session-id": true, "--version": true, "-v": true };
const withValues: Record<string, true> = { "--api-key": true, "--append-system-prompt": true, "--exclude-tools": true, "-xt": true, "--extension": true, "-e": true, "--model": true, "--models": true, "--name": true, "-n": true, "--prompt-template": true, "--provider": true, "--session-dir": true, "--skill": true, "--system-prompt": true, "--theme": true, "--thinking": true, "--tools": true, "-t": true, "--tui-mode": true, "--use-theme": true };
const withoutValues: Record<string, true> = { "--approve": true, "-a": true, "--no-approve": true, "-na": true, "--no-builtin-tools": true, "-nbt": true, "--no-context-files": true, "-nc": true, "--no-extensions": true, "-ne": true, "--no-prompt-templates": true, "-np": true, "--no-skills": true, "-ns": true, "--no-themes": true, "--no-tools": true, "-nt": true, "--offline": true, "--verbose": true };

export function tokenizePiArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let quoted = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (quote) {
      if (char === quote) { quote = undefined; quoted = true; }
      else if (char === "\\" && quote === '"') {
        const next = input[index + 1];
        if (next !== undefined && ['"', "\\", "$", "`"].includes(next)) { current += next; index++; }
        else current += char;
      } else current += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; quoted = true; }
    else if (/\s/.test(char)) {
      if (current || quoted) { tokens.push(current); current = ""; quoted = false; }
    } else if (char === "\\") {
      const next = input[index + 1];
      if (next !== undefined && /[\s'"]/.test(next)) { current += next; index++; }
      else current += char;
    } else current += char;
  }
  if (current || quoted) tokens.push(current);
  return tokens;
}

export function resolvePiLaunchArgs(input: string): string[] {
  const args = tokenizePiArgs(input).flatMap((arg) => {
    const equals = arg.indexOf("=");
    return equals > 0 && Object.hasOwn(withValues, arg.slice(0, equals)) ? [arg.slice(0, equals), arg.slice(equals + 1)] : [arg];
  });
  let provider = false;
  let model = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (Object.hasOwn(reserved, arg) || (arg.startsWith("--") && Object.hasOwn(reserved, arg.split("=")[0]!)))
      throw new Error(`Pi launch argument '${arg.split("=")[0]}' is controlled by Agent and cannot be overridden.`);
    if (arg === "--") throw new Error("Pi launch arguments cannot include positional prompts.");
    if (Object.hasOwn(withValues, arg)) {
      if (args[index + 1] === undefined) throw new Error(`Pi launch argument '${arg}' requires a value.`);
      if (arg === "--provider") provider = true;
      if (arg === "--model") model = true;
      index++;
    } else if (Object.hasOwn(withoutValues, arg) || (arg.startsWith("--") && arg.includes("="))) continue;
    else if (arg.startsWith("--")) {
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) index++;
    } else throw new Error("Pi launch arguments contain an unsupported flag or positional prompt.");
  }
  if (provider && !model) throw new Error("Pi launch argument '--provider' requires '--model'.");
  return args;
}

export function validatePiConfig(config: ProviderConfig): ProviderConfig {
  for (const key of Object.keys(config)) if (key !== "binaryPath" && key !== "launchArgs") throw new Error(`Unknown Pi setting: ${key}`);
  for (const key of ["binaryPath", "launchArgs"]) if (config[key] !== undefined && typeof config[key] !== "string") throw new Error(`Pi ${key} must be a string.`);
  const binaryPath = typeof config.binaryPath === "string" ? config.binaryPath.trim() || "pi" : "pi";
  const launchArgs = typeof config.launchArgs === "string" ? config.launchArgs.trim() : "";
  if (binaryPath.includes("\0") || launchArgs.includes("\0")) throw new Error("Pi configuration cannot contain NUL bytes.");
  resolvePiLaunchArgs(launchArgs);
  return { binaryPath, launchArgs };
}

export function piEnvironment(context: ProviderDriverContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...context.env, HOME: context.homeDirectory, USERPROFILE: context.homeDirectory, PI_CODING_AGENT_DIR: path.join(context.homeDirectory, ".pi", "agent") };
  delete env.T3_MCP_URL;
  delete env.T3_MCP_BEARER_TOKEN;
  delete env.T3_PI_MCP_EXTENSION_PATH;
  return env;
}

export function piBinary(context: ProviderDriverContext): string {
  const value = String(validatePiConfig(context.config).binaryPath);
  return value.startsWith("~/") ? path.join(context.homeDirectory, value.slice(2)) : value;
}
