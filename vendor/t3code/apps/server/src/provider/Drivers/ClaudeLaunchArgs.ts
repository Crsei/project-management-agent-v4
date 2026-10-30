import { parseCliArgs, tokenizeCliArgs } from "@t3tools/shared/cliArgs";

/** Launch flags cannot replace the host's session, transport or permission boundary. */
export function claudeLaunchFlags(input: string): Record<string, string | null> {
  const tokens = tokenizeCliArgs(input);
  if (tokens.some((token) => token.startsWith("-") && !/^--[a-zA-Z][\w-]*(?:=.*)?$/.test(token))) {
    throw new Error("Claude launch arguments must use long native CLI flags.");
  }
  const { flags, positionals } = parseCliArgs(tokens);
  if (positionals.length) throw new Error("Claude launch arguments cannot contain positional prompts.");
  for (const key of Object.keys(flags)) {
    if (/^(?:dangerously-skip-permissions|allow-dangerously-skip-permissions|permission-mode|allowedTools|allowed-tools|disallowedTools|disallowed-tools|add-dir|settings|setting-sources|mcp-config|strict-mcp-config|tools|resume|resume-session-at|continue|fork-session|session-id|model|output-format|input-format|print|p|dangerously-load-development-channels|sdk-url|remote-control|bare|sandbox|agents|agent|plugin-dir|system-prompt|system-prompt-file)$/.test(key)) {
      throw new Error(`Claude launch argument cannot override PM session, authorization or transport: --${key}`);
    }
  }
  return flags;
}
