import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ompUsageFormat, ompUsageReader } from "./usage.ts";

const state = () => ({ sessionId: "" });

function collect(lines: unknown[]) {
  const scanState = state();
  return lines.flatMap(line => ompUsageFormat.parseLine(JSON.stringify(line), scanState));
}

describe("OMP native usage history", () => {
  it("attributes assistant and auxiliary model calls without counting content", () => {
    const records = collect([
      { type: "title", v: 1, title: "ignored" },
      { type: "session", version: 3, id: "native-session", timestamp: "2026-11-18T08:22:16.810Z", cwd: "/workspace" },
      {
        type: "message",
        id: "assistant-1",
        timestamp: "2026-11-18T08:23:44.370Z",
        message: {
          role: "assistant",
          provider: "opencode-go",
          model: "deepseek-v4.1-flash",
          timestamp: 1794990213399,
          completedAt: 1794990224368,
          content: [{ type: "text", text: "not retained" }],
          usage: {
            input: 100, output: 20, cacheRead: 30, cacheWrite: 5, reasoningTokens: 10,
            cost: { total: 0.25 },
          },
        },
      },
      {
        type: "model_usage",
        id: "title-1",
        timestamp: "2026-11-18T08:23:48.434Z",
        purpose: "title",
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      },
    ]);
    assert.equal(records.length, 2);
    const [assistant, title] = records;
    assert.deepEqual(assistant?.totals, {
      uncachedInputTokens: 100, cachedInputTokens: 30, cacheCreationTokens: 5, outputTokens: 20, reasoningTokens: 10,
    });
    assert.equal(assistant?.model, "opencode-go/deepseek-v4.1-flash");
    assert.equal(assistant?.rateModel, "deepseek-v4.1-flash");
    assert.equal(assistant?.sessionId, "native-session");
    assert.equal(assistant?.reportedCostUsd, 0.25);
    assert.notEqual(assistant?.dedupeKey, title?.dedupeKey);
    assert.deepEqual(title?.totals, {
      uncachedInputTokens: 10, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 2, reasoningTokens: 0,
    });
    assert.equal(title?.reportedCostUsd, null);
    assert.equal(title?.sessionId, "native-session");
  });

  it("keeps the same native call identity across forked session files", () => {
    const line = {
      type: "message",
      id: "assistant-1",
      timestamp: "2026-11-18T08:23:44.370Z",
      message: {
        role: "assistant", provider: "opencode-go", model: "deepseek-v4.1-flash",
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
      },
    };
    const first = collect([{ type: "session", id: "a" }, line]);
    const fork = collect([{ type: "session", id: "b" }, line]);
    assert.equal(first[0]?.dedupeKey, fork[0]?.dedupeKey);
  });

  it("falls back to the assistant completion time when the entry timestamp is absent", () => {
    const records = collect([{
      type: "message",
      id: "assistant-2",
      message: {
        role: "assistant", provider: "openai-codex", model: "gpt-6-astra",
        completedAt: 1794990224368,
        usage: { input: 1, output: 1, cost: { total: 0 } },
      },
    }]);
    assert.equal(records[0]?.timestampMs, 1794990224368);
  });

  it("resolves the native profile session directory", async () => {
    const home = "/tmp/omp-usage-home";
    const directories = await Effect.runPromise(ompUsageReader.kind === "transcripts"
      ? ompUsageReader.directories({
        instanceId: ProviderInstanceId.make("omp-test"), config: undefined, configured: true,
        environment: { HOME: home, OMP_PROFILE: "work" },
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, home), Effect.provideService(HostProcess.WorkingDirectory, home))
      : Effect.die("OMP usage reader is expected to read transcripts"));
    assert.deepEqual(directories, [{ dir: "/tmp/omp-usage-home/.omp/profiles/work/agent/sessions" }]);
  });
});
