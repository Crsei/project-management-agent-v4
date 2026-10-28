import type { ProviderFailure } from "@agent-workspace/contracts/provider";
import { sanitizeErrorText } from "./verify.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function timestamp(value: unknown): string | undefined {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)
        ? Number(value)
        : undefined;
  const milliseconds =
    number === undefined
      ? typeof value === "string"
        ? Date.parse(value)
        : NaN
      : number < 1e12
        ? number * 1000
        : number;
  return Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds < 8.64e15
    ? new Date(milliseconds).toISOString()
    : undefined;
}
/** Only structured provider fields/headers supply reset time. Never parse a guessed locale clock. */
export function classifyProviderError(
  error: unknown,
  providerInstanceId?: string,
): ProviderFailure {
  const root = record(error);
  let data: unknown = root?.data;
  // SDK error schemas can strip provider-specific reset fields from `data`.
  if (typeof root?.responseBody === "string") {
    try {
      data = JSON.parse(root.responseBody);
    } catch {
      /* Non-JSON has no reset evidence. */
    }
  }
  const payload = record(data);
  const nested = record(root?.error) ?? record(payload?.error) ?? payload ?? root;
  const code = String(root?.code ?? nested?.code ?? nested?.type ?? "");
  const message = sanitizeErrorText(
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(root?.message ?? "Provider execution failed."),
  );
  const declared = root?.errorClass;
  const usage =
    declared === "usage_limit" ||
    Number(root?.statusCode ?? root?.status) === 429 ||
    /(?:usage_limit|rate_limit|insufficient_quota|quota_exceeded)/i.test(code) ||
    /(?:usage limit|rate limit|quota exceeded|out of (?:extra )?usage|hit your limit|usage_limit_reached)/i.test(
      message,
    );
  const errorClass: ProviderFailure["errorClass"] = usage
    ? "usage_limit"
    : declared === "authentication" ||
        /(?:unauthenticated|authentication|not_authenticated)/i.test(code) ||
        [401, 403].includes(Number(root?.statusCode))
      ? "authentication"
      : code === "aborted" || (error instanceof Error && error.name === "AbortError")
        ? "cancelled"
        : /^(?:unsupported_|session_mismatch)/.test(code)
          ? "unsupported"
          : "provider_error";
  let resetAt = usage
    ? timestamp(
        root?.resetAt ??
          nested?.resets_at ??
          nested?.resetsAt ??
          nested?.reset_at ??
          nested?.resetAt,
      )
    : undefined;
  if (usage && !resetAt) {
    const headers = root?.responseHeaders;
    const readHeader = (name: string): string | undefined =>
      headers instanceof Headers
        ? (headers.get(name) ?? undefined)
        : typeof record(headers)?.[name] === "string"
          ? (record(headers)![name] as string)
          : undefined;
    const retryAfter = readHeader("retry-after");
    if (retryAfter) {
      const milliseconds = /^\d+(?:\.\d+)?$/.test(retryAfter)
        ? Date.now() + Number(retryAfter) * 1000
        : NaN;
      resetAt =
        Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds < 8.64e15
          ? new Date(milliseconds).toISOString()
          : timestamp(retryAfter);
    }
    resetAt ??= timestamp(
      readHeader("x-ratelimit-reset-requests") ?? readHeader("anthropic-ratelimit-requests-reset"),
    );
  }
  return {
    errorClass,
    message,
    ...(resetAt ? { resetAt } : {}),
    ...(providerInstanceId ? { providerInstanceId } : {}),
  };
}
