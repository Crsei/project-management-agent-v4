// Controlled IPC peer for cursor-native.test.ts; never selected by production.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { CursorRequest, CursorWorkerMessage } from "./cursor-sdk.ts";

const send = (message: CursorWorkerMessage) => {
  const pending = Promise.withResolvers<void>();
  process.send!(message, (error: Error | null) => error ? pending.reject(error) : pending.resolve());
  return pending.promise;
};
const scenario = process.env.CURSOR_TEST_SCENARIO;
if (scenario === "descendant-term-leader") process.on("SIGTERM", () => {
  writeFileSync(process.env.CURSOR_TEST_LEADER_EXIT_FILE!, "TERM exited leader");
  process.exit(0);
});
process.on("message", (message: { type: string; request?: CursorRequest }) => {
  if (message.type === "cancel") {
    if (scenario === "descendant-term-leader") return;
    if (scenario === "descendant-exit-leader")
      writeFileSync(process.env.CURSOR_TEST_LEADER_EXIT_FILE!, "cancel exited leader");
    process.exit(0);
    return;
  }
  if (message.type !== "request" || !message.request) return;
  const request = message.request;
  void (async () => {
    if (scenario === "descendant-exit-leader" || scenario === "descendant-term-leader") {
      const descendant = spawn(process.execPath, ["-e", `
        const fs = require("node:fs");
        process.on("SIGTERM", () => fs.appendFileSync(process.env.CURSOR_TEST_TERM_FILE, "TERM ignored\\n"));
        setInterval(() => {}, 1000);
        process.send({ ready: true });
      `], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const ready = Promise.withResolvers<void>();
      descendant.once("message", () => ready.resolve());
      descendant.once("error", ready.reject);
      await ready.promise;
      await writeFile(process.env.CURSOR_TEST_DESCENDANT_FILE!, JSON.stringify({
        pid: descendant.pid, groupId: process.ppid, workerPid: process.pid,
      }));
      await send({ type: "event", event: { type: "text", text: "descendant-ready" } });
      return;
    }
    if (scenario === "premature") {
      await send({ type: "event", event: { type: "text", text: "partial" } });
      process.exit(0);
    }
    if (scenario === "abort") {
      await send({ type: "event", event: { type: "text", text: "started" } });
      return;
    }
    if (scenario === "wrong-operation") {
      await send({ type: "result", result: { operation: "check", models: [] } });
      return;
    }
    if (request.operation === "check") {
      await send({ type: "result", result: {
        operation: "check",
        models: [{ id: "controlled", displayName: "Controlled" }],
        user: {
          apiKeyName: "isolated",
          createdAt: "2026-01-01T00:00:00Z",
          userFirstName: JSON.stringify({
            home: process.env.HOME,
            userProfile: process.env.USERPROFILE,
            xdgConfig: process.env.XDG_CONFIG_HOME,
            secret: process.env.CURSOR_API_KEY,
          }),
        },
      } });
    } else if (request.operation === "run") {
      await send({ type: "event", event: { type: "session", sessionId: "real-controlled-id", turnId: "controlled-turn" } });
      await send({ type: "event", event: { type: "output", event: { type: "item.upsert",
        item: { id: "cursor:message:1", type: "assistant_message", status: "running", text: "answer" } } } });
      await send({ type: "event", event: { type: "output", event: { type: "command.output", itemId: "cursor:tool:1", chunk: "out\n" } } });
      await send({ type: "event", event: { type: "usage", update: { turn: { totals: {
        uncachedInputTokens: 4, cachedInputTokens: 7, cacheCreationTokens: 2, outputTokens: 5, reasoningTokens: 3,
      } } } } });
      await send({ type: "event", event: { type: "text", text: "answer" } });
      await send({ type: "result", result: {
        operation: "run", sessionId: "real-controlled-id", text: "answer",
        result: { id: "controlled-turn", status: "finished", result: "answer" },
      } });
    }
    process.exit(scenario === "nonzero" ? 2 : 0);
  })();
});
