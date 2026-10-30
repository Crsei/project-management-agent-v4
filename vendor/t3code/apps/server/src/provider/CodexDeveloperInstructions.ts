import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";

/** Native additionalContext values are limited to 1,000 tokens, measured as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/** Native harness identity only; PM supplies its own instructions and tool authority. */
export function buildCodexAdditionalContext(runtime: CodexRuntimeInfo): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const model = (runtime.modelName || runtime.model).replaceAll(/\s+/g, " ").trim();
  const effort = runtime.reasoningEffort?.replaceAll(/\s+/g, " ").trim();
  return { runtime_info: { kind: "application", value: `<runtime_info>You are using the Codex harness${model ? ` as ${model}` : ""}${effort ? ` with ${effort} reasoning effort` : ""}.</runtime_info>` } };
}
