import { z } from "zod";
import { fileURLToPath } from "node:url";
import type { NativeSessionRef } from "@agent-workspace/contracts/provider";
import type { StoredProviderInstance } from "./instances.ts";
import { providerContext, providerEnvironment } from "./instances.ts";
import { runProviderCommand } from "./process.ts";
import { sanitizeErrorText } from "./verify.ts";
import { CodexRpc } from "./drivers/codex-rpc.ts";

const ThreadSchema = z.object({
  id: z.string(),
  turns: z.array(z.object({ id: z.string(), status: z.string() })).optional(),
});
const ForkResultSchema = z.object({ sessionId: z.string().min(1) });
function nativeError(
  message: string,
  code = "unsupported_fork",
  instance?: StoredProviderInstance,
): Error {
  for (const [key, value] of Object.entries(instance?.env ?? {})) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL)/i.test(key) && value.length >= 4)
      message = message.split(value).join("[redacted]");
  }
  return Object.assign(new Error(sanitizeErrorText(message)), {
    code,
    errorClass: code === "aborted" ? "cancelled" : "unsupported",
  });
}
/** Metadata-only JSON-RPC. Never starts a turn or sends a prompt. */
export async function codexMetadata(
  instance: StoredProviderInstance,
  method: "thread/fork" | "thread/read",
  params: Record<string, unknown>,
  signal?: AbortSignal,
  cwd?: string,
): Promise<Record<string, unknown>> {
  const context = providerContext(instance, cwd);
  const client = await CodexRpc.open(context, signal);
  try {
    return await client.request(method, params);
  } catch (error) {
    throw nativeError(error instanceof Error ? error.message : "Codex native metadata failed.", signal?.aborted ? "aborted" : "unsupported_fork", instance);
  } finally {
    client.close();
  }
}
export async function forkNativeSession(
  instance: StoredProviderInstance,
  source: NativeSessionRef,
  boundary: { turnId?: string; messageId?: string } | undefined,
  cwd: string,
  signal?: AbortSignal,
): Promise<NativeSessionRef> {
  if (signal?.aborted) throw nativeError("Request cancelled.", "aborted");
  if (source.driver !== instance.driver || source.providerInstanceId !== instance.instanceId ||
      (source.instanceRevision !== undefined && source.instanceRevision !== instance.revision) ||
      (source.cwd !== undefined && source.cwd !== cwd))
    throw nativeError("Native source belongs to another instance, revision or working directory.", "session_mismatch");
  let sessionId: unknown;
  if (instance.driver === "codex") {
    if (boundary && !boundary.turnId)
      throw nativeError("Codex exact fork requires a native completed turn ID.");
    const result = await codexMetadata(
      instance,
      "thread/fork",
      {
        threadId: source.sessionId,
        ...(boundary?.turnId ? { lastTurnId: boundary.turnId } : {}),
        cwd,
        ephemeral: false,
        deferGoalContinuation: true,
      },
      signal,
      cwd,
    );
    const thread = ThreadSchema.safeParse(result.thread);
    sessionId = thread.success ? thread.data.id : undefined;
  } else if (instance.driver === "claude") {
    if (boundary && !boundary.messageId)
      throw nativeError("Claude exact fork requires a native assistant message UUID.");
    const result = await runProviderCommand(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            import.meta.url.endsWith(".ts")
              ? "../agents/claude-history-worker.ts"
              : "./agents/claude-history-worker.mjs",
            import.meta.url,
          ),
        ),
        source.sessionId,
        cwd,
        ...(boundary?.messageId ? [boundary.messageId] : []),
      ],
      { env: providerEnvironment(instance), cwd, signal, timeoutMs: 30_000 },
    );
    if (signal?.aborted) throw nativeError("Request cancelled.", "aborted");
    if (result.code !== 0)
      throw nativeError(
        result.stderr ||
          "Claude native fork failed; verify the SDK, session and message boundary for this instance.",
        "unsupported_fork",
        instance,
      );
    try {
      sessionId = ForkResultSchema.parse(JSON.parse(result.stdout)).sessionId;
    } catch {
      throw nativeError("Claude native fork returned invalid metadata.");
    }
  } else throw nativeError("This provider has no native sessions.");
  if (typeof sessionId !== "string" || !sessionId || sessionId === source.sessionId)
    throw nativeError("Provider did not confirm a distinct forked session.");
  return { providerInstanceId: instance.instanceId, driver: source.driver, sessionId, cwd, instanceRevision: instance.revision, ...(source.modelId ? { modelId: source.modelId } : {}) };
}
