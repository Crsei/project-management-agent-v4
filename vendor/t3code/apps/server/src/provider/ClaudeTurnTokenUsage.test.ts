import { describe, it, expect } from "vite-plus/test";
import { normalizeClaudeTurnTokenUsage } from "./ClaudeTurnTokenUsage.ts";

describe("Claude native usage certainty", () => {
  it("does not invent missing cache counters or a complete input total", () => {
    const usage = normalizeClaudeTurnTokenUsage({ subtype: "success", usage: { input_tokens: 11, output_tokens: 3 } }, false, "completed");
    expect(usage.usageStatus).toBe("partial");
    expect(usage.inputTokens).toBeUndefined();
    expect(usage.cachedInputTokens).toBeUndefined();
    expect(usage.cacheCreationTokens).toBeUndefined();
    expect(usage.reasoningTokens).toBeUndefined();
    expect(usage.outputTokens).toBe(3);
  });

  it("retains native explicit zero and known cached classifications", () => {
    const usage = normalizeClaudeTurnTokenUsage({ subtype: "success", usage: {
      input_tokens: 11, cache_read_input_tokens: 7, cache_creation_input_tokens: 0, output_tokens: 3,
    } }, true, "completed");
    expect(usage.usageStatus).toBe("complete");
    expect(usage.inputTokens).toBe(18);
    expect(usage.cachedInputTokens).toBe(7);
    expect(usage.cacheCreationTokens).toBe(0);
    expect(usage.hasSubagents).toBe(true);
  });

  it("does not turn an unknown interrupted segment into zero billed tokens", () => {
    const usage = normalizeClaudeTurnTokenUsage({ subtype: "success", usage: {
      input_tokens: 11, cache_read_input_tokens: 7, cache_creation_input_tokens: 0, output_tokens: 3,
    } }, false, "completed", [{ output_tokens: 2 }]);
    expect(usage.usageStatus).toBe("partial");
    expect(usage.inputTokens).toBeUndefined();
    expect(usage.outputTokens).toBe(5);
  });

  it("keeps absent telemetry unavailable and failed positive telemetry partial", () => {
    expect(normalizeClaudeTurnTokenUsage(undefined, false, "failed").usageStatus).toBe("unavailable");
    const partial = normalizeClaudeTurnTokenUsage({ subtype: "error_during_execution", usage: { output_tokens: 2 } }, false, "failed");
    expect(partial.usageStatus).toBe("partial");
    expect(partial.outputTokens).toBe(2);
    expect(partial.inputTokens).toBeUndefined();
  });
});
