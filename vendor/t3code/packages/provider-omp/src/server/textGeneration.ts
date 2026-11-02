import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import type { OmpSettings } from "../settings.ts";
import { buildOmpRpcLaunch, resolveOmpLaunchArgs } from "./launch.ts";
import { makeOmpRpcConnection, ompRecordField, ompRecordString, parseOmpModelSlug } from "./rpc.ts";
import { parseOmpThinkingLevels } from "./status.ts";

const GENERATION_TIMEOUT_MS = 180_000;
const isTextGenerationError = Schema.is(TextGenerationError);

/** Independent ephemeral process, no native tools, ambient extensions, host PM bridge or session persistence. */
export const makeOmpTextGeneration = Effect.fn("makeOmpTextGeneration")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const run: TextGenerationOperations.Runner = Effect.fn("OmpTextGeneration.run")(
    function* (request) {
      const { operation, modelSelection } = request;
      if (!settings.enabled) return yield* new TextGenerationError({ operation, detail: "OMP is disabled." });
      const resolved = resolveOmpLaunchArgs(settings.launchArgs);
      if (!resolved.ok) return yield* new TextGenerationError({ operation, detail: resolved.message });
      const model = parseOmpModelSlug(modelSelection.model);
      if (model === null) return yield* new TextGenerationError({ operation, detail: "OMP requires an explicit provider/model selection." });
      const launch = yield* Effect.try({
        try: () => buildOmpRpcLaunch({ launchArgs: resolved.args, environment, cwd: request.cwd, ephemeral: true, disableTools: true, disableExtensions: true }),
        catch: (cause) => new TextGenerationError({ operation, detail: cause instanceof Error ? cause.message : "Invalid OMP launch configuration.", cause }),
      });
      const connection = yield* makeOmpRpcConnection({ command: settings.binaryPath || "omp", args: launch.args, cwd: request.cwd, env: launch.env }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const selected = yield* connection.request({ type: "set_model", provider: model.provider, modelId: model.modelId });
      if (ompRecordString(selected, "provider") !== model.provider || ompRecordString(selected, "id") !== model.modelId) {
        return yield* new TextGenerationError({ operation, detail: "OMP did not select the requested model." });
      }
      const thinking = modelSelection.options?.find((option) => option.id === "thinking")?.value;
      if (thinking !== undefined) {
        const data = yield* connection.request({ type: "get_available_thinking_levels" });
        const levels = yield* Effect.try({ try: () => parseOmpThinkingLevels(data), catch: (cause) => new TextGenerationError({ operation, detail: "OMP thinking discovery failed.", cause }) });
        if (typeof thinking !== "string" || !levels.includes(thinking)) {
          return yield* new TextGenerationError({ operation, detail: "OMP does not support the requested thinking effort for this model." });
        }
        yield* connection.request({ type: "set_thinking_level", level: thinking });
        const state = yield* connection.request({ type: "get_state" });
        if (ompRecordString(state, "thinkingLevel") !== thinking) {
          return yield* new TextGenerationError({ operation, detail: "OMP did not retain the requested thinking effort; refusing to downgrade." });
        }
      }
      const promptId = `omp-text-${crypto.randomUUID()}`;
      const admitted = yield* connection.request({ id: promptId, type: "prompt", message: request.prompt });
      if (ompRecordField(admitted, "agentInvoked") === false) {
        return yield* new TextGenerationError({ operation, detail: "OMP completed the auxiliary prompt locally without invoking the model." });
      }
      let completed = false;
      let assistantFailure = false;
      while (true) {
        const event = yield* Queue.take(connection.events);
        if (event.type === "extension_ui_request" || event.type === "host_tool_call") {
          return yield* new TextGenerationError({ operation, detail: "Tool-free OMP generation unexpectedly requested host interaction." });
        }
        if (event.type === "message_end") {
          const message = ompRecordField(event, "message");
          const reason = ompRecordString(message, "stopReason");
          if (ompRecordString(message, "role") === "assistant" && (reason === "error" || reason === "aborted")) assistantFailure = true;
        }
        if (event.type === "response" && event.id === promptId && event.success === false) {
          return yield* new TextGenerationError({ operation, detail: "OMP rejected the admitted auxiliary generation." });
        }
        if (event.type === "prompt_result" && event.id === promptId) {
          if (event.status !== "completed" || event.agentInvoked !== true || assistantFailure) {
            return yield* new TextGenerationError({ operation, detail: ompRecordString(event.error, "message") ?? "OMP auxiliary generation did not complete successfully." });
          }
          completed = true;
          if (event.sessionSettled === true) break;
          if (event.sessionSettled !== false) return yield* new TextGenerationError({ operation, detail: "OMP returned an invalid prompt settlement state." });
        }
        if (event.type === "session_settled" && completed) break;
      }
      if (assistantFailure) return yield* new TextGenerationError({ operation, detail: "OMP assistant generation failed." });
      const output = yield* connection.request({ type: "get_last_assistant_text" });
      const text = ompRecordString(output, "text")?.trim();
      if (!text) return yield* new TextGenerationError({ operation, detail: "OMP returned empty auxiliary output." });
      return yield* TextGenerationOperations.decodeJsonReply(request, "OMP", text);
    },
    (effect, request) => effect.pipe(
      Effect.timeoutOrElse({ duration: GENERATION_TIMEOUT_MS, orElse: () => Effect.fail(new TextGenerationError({ operation: request.operation, detail: "OMP text generation timed out." })) }),
      Effect.mapError((cause) => isTextGenerationError(cause) ? cause : new TextGenerationError({
        operation: request.operation,
        detail: cause instanceof Error ? `OMP text generation failed: ${cause.message}` : "OMP text generation failed.",
        cause,
      })),
      Effect.scoped,
    ),
  );
  return TextGenerationOperations.fromRunner("OmpTextGeneration", TextGenerationOperations.withoutInvestigation("OMP", run));
});
