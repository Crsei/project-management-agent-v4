import { z } from "zod";
import { mcpAppMetadataSchema, mcpAppToolResultSchema } from "./mcp-apps.ts";

/** Adapted from T3 Code's ProviderAdapterV2/OrchestrationV2TurnItem design.
 * Copyright (c) 2026 T3 Tools Inc. MIT; see LICENSE.t3code. */
const id = z.string().min(1).max(512);
export const outputStatusSchema = z.enum([
  "pending", "running", "waiting", "completed", "failed", "cancelled", "interrupted", "unknown",
]);
export type OutputStatus = z.infer<typeof outputStatusSchema>;
export const responseStreamingModeSchema = z.enum(["paragraph", "turn"]);
export type ResponseStreamingMode = z.infer<typeof responseStreamingModeSchema>;

export const nativeQuestionSchema = z.object({
  id,
  title: z.string().optional(),
  prompt: z.string(),
  options: z.array(z.object({ id, label: z.string(), description: z.string().optional() })).optional(),
  multiple: z.boolean().optional(),
  allowText: z.boolean().optional(),
  secret: z.boolean().optional(),
});
export const nativeInteractionRequestSchema = z.object({
  id,
  itemId: id,
  kind: z.enum(["approval", "user_input"]),
  title: z.string(),
  detail: z.string().optional(),
  /** Only choices actually offered and allowed by the existing provider policy. */
  options: z.array(z.object({ id, label: z.string(), description: z.string().optional() })).optional(),
  questions: z.array(nativeQuestionSchema).optional(),
  respondable: z.boolean(),
  unavailableReason: z.string().optional(),
});
export type NativeInteractionRequest = z.infer<typeof nativeInteractionRequestSchema>;
export const nativeInteractionResponseSchema = z.object({
  optionId: id.optional(),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  cancelled: z.boolean().optional(),
}).strict();
export type NativeInteractionResponse = z.infer<typeof nativeInteractionResponseSchema>;

export const nativeOutputItemSchema = z.object({
  /** Provider-local stable ID, scoped by generation at the persistence boundary. */
  id,
  type: z.enum([
    "assistant_message", "reasoning", "command_execution", "file_change", "file_search",
    "web_search", "dynamic_tool", "todo_list", "proposed_plan", "subagent",
    "approval_request", "user_input_request", "notification", "error", "compaction",
  ]),
  status: outputStatusSchema,
  /** Current-reader projection only; hidden items contain no provider/business payload. */
  visibility: z.enum(["visible", "redacted", "unavailable"]).optional(),
  title: z.string().optional(),
  parentItemId: id.optional(),
  nativeItemId: z.string().optional(),
  /** Ordinals are comparable only within this native thread/run/turn scope. */
  order: z.object({ scope: z.string().min(1), ordinal: z.number().int().nonnegative() }).optional(),
  /** Missing means unknown, not a final answer. Never inferred from text or position. */
  phase: z.enum(["commentary", "final_answer"]).optional(),
  reasoningPart: z.object({ kind: z.enum(["summary", "text"]), index: z.number().int().nonnegative() }).optional(),
  /** Both timestamps must be provider-backed to advertise a provider duration. */
  timing: z.object({ source: z.enum(["provider", "observed"]) }).optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  /** Full accumulated text; never an append delta. */
  text: z.string().optional(),
  streaming: z.boolean().optional(),
  toolName: z.string().optional(),
  input: z.unknown().optional(),
  output: z.string().optional(),
  /** Server-bound native App metadata; historical serialized output remains readable. */
  mcpApp: mcpAppMetadataSchema.optional(),
  mcpToolResult: mcpAppToolResultSchema.optional(),
  outputTruncated: z.boolean().optional(),
  exitCode: z.number().int().optional(),
  fileName: z.string().optional(),
  diff: z.string().optional(),
  oldText: z.string().optional(),
  newText: z.string().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  changes: z.array(z.object({ path: z.string(), operation: z.string(), oldPath: z.string().optional(), diff: z.string().optional() })).optional(),
  results: z.array(z.object({ title: z.string().optional(), path: z.string().optional(), url: z.string().optional(), text: z.string().optional(), line: z.number().int().optional() })).optional(),
  steps: z.array(z.object({ id, text: z.string(), status: z.enum(["pending", "running", "completed", "cancelled"]) })).optional(),
  childSessionId: z.string().optional(),
  model: z.string().optional(),
  request: nativeInteractionRequestSchema.optional(),
  error: z.string().optional(),
});
export type NativeOutputItem = z.infer<typeof nativeOutputItemSchema>;
export type NativeOutputEvent =
  | { type: "item.upsert"; item: NativeOutputItem }
  | { type: "command.output"; itemId: string; chunk: string };

export const generationOutputStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled", "interrupted"]);
export type GenerationOutputStatus = z.infer<typeof generationOutputStatusSchema>;
export const agentOutputSnapshotSchema = z.object({
  generationId: id,
  threadId: id,
  sequence: z.number().int().nonnegative(),
  status: generationOutputStatusSchema,
  items: z.array(nativeOutputItemSchema),
});
export type AgentOutputSnapshot = z.infer<typeof agentOutputSnapshotSchema>;
export const agentOutputFrameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), snapshot: agentOutputSnapshotSchema }),
  z.object({ kind: z.literal("item"), generationId: id, sequence: z.number().int().nonnegative(), item: nativeOutputItemSchema }),
  z.object({ kind: z.literal("status"), generationId: id, sequence: z.number().int().nonnegative(), status: generationOutputStatusSchema }),
]);
export type AgentOutputFrame = z.infer<typeof agentOutputFrameSchema>;
export const commandOutputFrameSchema = z.object({
  kind: z.enum(["replace", "append"]),
  text: z.string(),
  truncated: z.boolean(),
  running: z.boolean(),
});
export type CommandOutputFrame = z.infer<typeof commandOutputFrameSchema>;

export function isOutputActive(status: OutputStatus): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

/** Apply cumulative revisions without globally comparing unrelated native ordinals.
 * Legacy rows keep their arrival order; an existing scope owns only its own slots. */
export function upsertNativeOutputItem(items: NativeOutputItem[], item: NativeOutputItem): void {
  const index = items.findIndex((entry) => entry.id === item.id);
  // A confirmed PM business outcome outlives its provider generation and stale frames.
  const previousPm = items[index];
  if (previousPm?.id.startsWith("pm-tool:") && previousPm.status === "completed" && item.visibility !== "redacted" && item.visibility !== "unavailable" && item.status !== "completed") return;
  if (index >= 0) {
    const previous = items[index]!;
    items[index] = item;
    if (!item.order || (previous.order?.scope === item.order.scope && previous.order.ordinal === item.order.ordinal)) return;
    const slots: number[] = [];
    const scoped: NativeOutputItem[] = [];
    for (let position = 0; position < items.length; position++) {
      const candidate = items[position]!;
      if (candidate.order?.scope !== item.order.scope) continue;
      slots.push(position);
      scoped.push(candidate);
    }
    scoped.sort((a, b) => a.order!.ordinal - b.order!.ordinal);
    for (let position = 0; position < slots.length; position++) items[slots[position]!] = scoped[position]!;
    return;
  }
  if (item.order) {
    let last = -1;
    for (let position = 0; position < items.length; position++) {
      const order = items[position]!.order;
      if (order?.scope !== item.order.scope) continue;
      if (order.ordinal > item.order.ordinal) { items.splice(position, 0, item); return; }
      last = position;
    }
    if (last >= 0) { items.splice(last + 1, 0, item); return; }
  }
  items.push(item);
}
