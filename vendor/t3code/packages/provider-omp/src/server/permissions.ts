import { randomUUID } from "node:crypto";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { OmpRpcRecord } from "./rpc.ts";

/** Public blocking hooks in OMP v18.13.2, e996e1c7ac476f60e02b8ed9764cf30fa8c00a8e.
 * See extensions/{types,runner,wrapper}.ts and docs/approval-mode.md. This is
 * deliberately independent of tools.approvalMode and tools.approval.* grants.
 * It is a client execution boundary, NOT an OS/process/filesystem sandbox.
 */
export const OMP_GATE_VERSION = 1;
export interface OmpGateCall {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: unknown;
  readonly sessionFile: string;
  readonly sessionId: string;
}

export function parseOmpGateCall(record: OmpRpcRecord, title: string): OmpGateCall | undefined {
  if (record.method !== "confirm" || record.title !== title || typeof record.message !== "string") return undefined;
  try {
    const call: unknown = JSON.parse(record.message);
    if (typeof call !== "object" || call === null || Array.isArray(call)) return undefined;
    const value = call as Record<string, unknown>;
    if (typeof value.toolName !== "string" || !value.toolName || typeof value.toolCallId !== "string" || !value.toolCallId ||
      typeof value.sessionFile !== "string" || !value.sessionFile || typeof value.sessionId !== "string" || !value.sessionId ||
      value.agentKind !== "main") return undefined;
    return { toolName: value.toolName, toolCallId: value.toolCallId, input: value.input,
      sessionFile: value.sessionFile, sessionId: value.sessionId };
  } catch { return undefined; }
}

export function ompPermissionKind(tool: string): "file-read" | "file-change" | "command" | "permission" {
  if (["read", "grep", "glob", "find", "ls", "ast_grep"].includes(tool)) return "file-read";
  if (["edit", "write", "delete", "move", "apply_patch"].includes(tool)) return "file-change";
  return tool === "bash" || tool === "eval" || tool === "python" ? "command" : "permission";
}

export function makeOmpPermissionExtension(input: { readonly title: string; readonly ready: string; readonly contextPath: string }): string {
  return `import * as fs from "node:fs/promises";
import * as os from "node:os";
const title = ${JSON.stringify(input.title)};
const ready = ${JSON.stringify(input.ready)};
const nativeApproval = title + ":native-approval:";
const contextPath = ${JSON.stringify(input.contextPath)};
export default function ompPmBoundary(pi) {
  // Subagents run headless/yolo upstream, so deny every spawn path.
  const denyDirect = () => {
    const output = "Denied: direct execution is unsupported; use a host-approved native tool call.";
    return {result:{output, exitCode:1, cancelled:false, truncated:false, totalLines:1,
      totalBytes:Buffer.byteLength(output), outputLines:1, outputBytes:Buffer.byteLength(output),
      displayOutputs:[], stdinRequested:false}};
  };
  pi.on("user_bash", denyDirect);
  pi.on("user_python", denyDirect);
  pi.on("before_subagent_spawn", () => ({block:true, reason:"OMP subagents are unsupported by the PM host execution boundary."}));
  pi.on("tool_call", async (event, ctx) => {
    if (ctx.agent?.kind !== "main" || !ctx.hasUI) return {block:true, reason:"No live PM permission boundary."};
    if (["task", "subagent", "goal", "advisor"].includes(event.toolName))
      return {block:true, reason:"This OMP autonomous capability is unsupported by the PM host."};
    const context = JSON.parse(await fs.readFile(contextPath, "utf8"));
    if (!context.active) return {block:true, reason:"No active PM generation."};
    // Host tools still enter this hook: no tool-name-based exemption, including
    // read-only-looking tools or pm_* names, can bypass host admission.
    const confirmed = await ctx.ui.confirm(title, JSON.stringify({
      toolName:event.toolName, toolCallId:event.toolCallId, input:event.input,
      agentKind:ctx.agent.kind, sessionFile:ctx.sessionManager.getSessionFile(), sessionId:ctx.sessionManager.getSessionId()
    }), {signal:ctx.signal});
    return confirmed ? undefined : {block:true, reason:"Tool execution was not granted by the PM host."};
  });
  // The stock wrapper asks again after tool_call even for RPC host tools.
  // Give the embedding host the native call identity before that stock select.
  // Only a matching generation-owned PM admission may answer it automatically.
  pi.on("tool_approval_requested", (event, ctx) => {
    if (ctx.agent?.kind !== "main") return;
    ctx.ui.notify(nativeApproval + JSON.stringify({
      agentKind:ctx.agent.kind, toolName:event.toolName, toolCallId:event.toolCallId,
      sessionId:event.sessionId, sessionFile:ctx.sessionManager.getSessionFile(),
      approvalMode:event.approvalMode, reason:event.reason
    }), "info");
  });
  pi.on("before_agent_start", async (event) => {
    const context = JSON.parse(await fs.readFile(contextPath, "utf8"));
    if (!context.active) throw new Error("OMP agent work outside an active PM generation");
    const additions = [context.instructionText, ...(context.appContext ?? []).map(item => item.text)].filter(Boolean);
    return additions.length ? {systemPrompt:[...(event.systemPrompt ?? []), ...additions]} : undefined;
  });
  pi.on("session_start", (_event, ctx) => ctx.ui.notify(ready + JSON.stringify({
    version:${OMP_GATE_VERSION}, homeDirectory:os.homedir(), cwd:ctx.cwd,
    sessionDirectory:ctx.sessionManager.getSessionDir(), sessionId:ctx.sessionManager.getSessionId(),
    sessionFile:ctx.sessionManager.getSessionFile(), profile:process.env.OMP_PROFILE ?? process.env.PI_PROFILE ?? ""
  }), "info"));
}
`;
}

export const materializeOmpPermissionGate = Effect.fn("materializeOmpPermissionGate")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pm-omp-boundary-" });
  yield* fs.chmod(directory, 0o700);
  const nonce = randomUUID();
  const title = `pm-omp-tool:${nonce}`;
  const ready = `pm-omp-boundary-ready:${nonce}:`;
  const contextPath = NodePath.join(directory, "context.json");
  const extensionPath = NodePath.join(directory, "boundary.mjs");
  yield* fs.writeFileString(contextPath, JSON.stringify({ active: false }));
  yield* fs.chmod(contextPath, 0o600);
  yield* fs.writeFileString(extensionPath, makeOmpPermissionExtension({ title, ready, contextPath }));
  yield* fs.chmod(extensionPath, 0o600);
  return { title, ready, nativeApproval: title + ":native-approval:", contextPath, extensionPath,
    update: (context: { readonly active: boolean; readonly instructionText?: string; readonly appContext?: ReadonlyArray<{ readonly key: string; readonly text: string }> }) =>
      fs.writeFileString(contextPath, JSON.stringify(context)) };
});
