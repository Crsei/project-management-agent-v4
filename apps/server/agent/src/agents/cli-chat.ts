import type { NativeSessionRef } from "@agent-workspace/contracts/provider";
import type { NativeUsageUpdate } from "@agent-workspace/contracts/usage";
export type CliTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

export type CliChatResult = {
  text: string;
  usage?: CliTokenUsage;
  nativeUsage?: NativeUsageUpdate;
  nativeSession?: NativeSessionRef;
};

const MAX_ERROR_CHARS = 1000;

/** Removes credentials and caps an error so it is safe to return/log. */
export function sanitizeErrorMessage(error: unknown, fallback = "命令行模型执行失败。"): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof error === "object" && error !== null && "message" in error
          ? String(error.message ?? "")
          : "";
  return sanitizeText(raw, fallback);
}

function sanitizeText(raw: string, fallback: string): string {
  let text = raw.trim();
  if (!text) return fallback;
  text = text
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-***")
    .replace(
      /((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|token)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;"']+)/gi,
      "$1***",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=:-]+/gi, "Bearer ***");
  if (text.length > MAX_ERROR_CHARS) text = `${text.slice(0, MAX_ERROR_CHARS)}…`;
  return text || fallback;
}

