import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexError from "effect-codex-app-server/errors";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

export function withCodexReplayChildMetadata(
  client: CodexClient.CodexAppServerClient["Service"],
  transcript: CodexReplay.CodexAppServerReplayTranscript,
  readMetadata: (
    threadId: string,
    method: "thread/read" | "thread/resume",
  ) => Effect.Effect<unknown, CodexError.CodexAppServerError> = (threadId) =>
    Effect.succeed({ thread: { id: threadId }, model: null }),
): CodexClient.CodexAppServerClient["Service"] {
  const childThreadIds = new Set(
    transcript.entries.flatMap((entry) => {
      if (entry.type !== "emit_inbound" || !Predicate.isObject(entry.frame)) return [];
      const params = entry.frame.params;
      if (!Predicate.isObject(params) || !Predicate.isObject(params.item)) return [];
      const item = params.item;
      if (item.type === "subAgentActivity" && typeof item.agentThreadId === "string") {
        return [item.agentThreadId];
      }
      return item.type === "collabAgentToolCall" && Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds.filter(Predicate.isString)
        : [];
    }),
  );
  return {
    ...client,
    raw: {
      ...client.raw,
      request: (method, params) =>
        (method === "thread/read" || method === "thread/resume") &&
        Predicate.isObject(params) &&
        (method === "thread/read" ? params.includeTurns === false : params.excludeTurns === true) &&
        typeof params.threadId === "string" &&
        childThreadIds.has(params.threadId)
          ? readMetadata(params.threadId, method)
          : client.raw.request(method, params),
    },
  };
}

