import { forkSession, getSessionInfo, getSessionMessages, getSubagentMessages } from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

// Bundled import.meta.main is always true; imports must have no side effects.
const decodeHistoryOptions = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      dir: Schema.optionalKey(Schema.String),
      includeSystemMessages: Schema.optionalKey(Schema.Boolean),
      upToMessageId: Schema.optionalKey(Schema.String),
      agentId: Schema.optionalKey(Schema.String),
    }),
  ),
);

export async function runClaudeHistoryWorker(
  method: string | undefined,
  sessionId: string | undefined,
  rawOptions: string | undefined,
): Promise<void> {
  const options = decodeHistoryOptions(rawOptions ?? "{}");
  if (!sessionId) throw new Error("Claude history session id is required.");
  const result =
    method === "readSession"
      ? await Promise.all([getSessionInfo(sessionId, options), getSessionMessages(sessionId, options)]).then(([info, messages]) => ({
          sessionId: info?.sessionId,
          cwd: info?.cwd,
          // Only native identities and stable completion markers cross this metadata boundary.
          messages: messages.map((entry) => ({
            type: entry.type, uuid: entry.uuid, sessionId: entry.session_id,
            parentToolUseId: entry.parent_tool_use_id,
            synthetic: typeof entry.message === "object" && entry.message !== null
              && Reflect.get(entry.message, "model") === "<synthetic>",
            stopReason: typeof entry.message === "object" && entry.message !== null
              ? Reflect.get(entry.message, "stop_reason") ?? null : null,
          })),
        }))
      : method === "getSessionMessages"
        ? await getSessionMessages(sessionId, options)
      : method === "subagentLaunchToolUseId"
        ? options.agentId === undefined
          ? (() => { throw new Error("Claude subagent id is required."); })()
          : await getSubagentMessages(sessionId, options.agentId, { ...options, limit: 1 })
              .then((messages) => messages[0]?.parent_tool_use_id ?? null)
      : method === "forkSession"
        ? await forkSession(sessionId, options).then(async (forked) => {
            const headMessageId = await getSessionMessages(forked.sessionId, options)
              .then((messages) => messages.at(-1)?.uuid)
              .catch(() => undefined);
            return headMessageId === undefined ? forked : { ...forked, headMessageId };
          })
        : (() => {
            throw new Error("Unknown Claude history operation.");
          })();
  process.stdout.write(JSON.stringify(result));
}
