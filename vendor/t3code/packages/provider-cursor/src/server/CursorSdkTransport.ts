import type { AgentMessage, InteractionUpdate, RunResult } from "@cursor/sdk";
import { z } from "zod";
import type { CursorAgentSdkOpenInput, CursorAgentSdkSendInput } from "./CursorAgentSdk.ts";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const id = z.number().int().positive();
// The original SDK still owns validation of its options/messages. These guards protect the
// private transport envelope and reject a malformed frame before it can become an operation.
const open = z.custom<CursorAgentSdkOpenInput>(value => record(value) &&
  (value.operation === "create" || (value.operation === "resume" && typeof value.agentId === "string")) &&
  typeof value.threadId === "string" && typeof value.providerSessionId === "string" && record(value.options) &&
  record(value.options.local) && typeof value.options.local.cwd === "string" &&
  record(value.options.model) && typeof value.options.model.id === "string");
const send = z.custom<Omit<CursorAgentSdkSendInput<never>, "onDelta">>(value => record(value) &&
  (typeof value.message === "string" || (record(value.message) && typeof value.message.text === "string")) &&
  (value.options === undefined || record(value.options)));
export const cursorWorkerRequest = z.union([
  z.object({ type: z.enum(["delta.ack", "authorize.ack"]), sequence: id, ok: z.boolean() }),
  z.object({ id, operation: z.literal("open"), input: open, stateRoot: z.string().min(1) }),
  z.object({ id, operation: z.literal("send"), input: send }),
  z.object({ id, operation: z.literal("metadata"), cwd: z.string().optional() }),
  z.object({ id, operation: z.enum(["wait", "cancel", "messages", "close"]) }),
]);
export const cursorWorkerReply = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delta"), sequence: id,
    update: z.custom<InteractionUpdate>(value => record(value) && typeof value.type === "string") }),
  z.object({ type: z.literal("authorize"), sequence: id, agentId: z.string().min(1) }),
  z.object({ type: z.literal("result"), id, result: z.unknown().optional() }),
  z.object({ type: z.literal("failure"), id, error: z.object({ name: z.string(), code: z.string().optional(), status: z.number().int().optional() }) }),
]);
export const cursorOpened = z.object({ agentId: z.string().min(1) });
export const cursorStarted = z.object({ runId: z.string().min(1), agentId: z.string().min(1) });
export const cursorNativeMetadata = z.object({ agentId: z.string().min(1), runtime: z.literal("local"),
  cwd: z.string().min(1), homeDirectory: z.string().min(1),
  runs: z.array(z.object({ id: z.string().min(1), status: z.string().min(1), model: z.string().optional() })) });
export const cursorMessages = z.array(z.object({ type: z.enum(["user", "assistant"]),
  uuid: z.string(), agent_id: z.string(), message: z.unknown() })) satisfies z.ZodType<AgentMessage[]>;
export const cursorRunResult = z.custom<RunResult>(value => record(value) && typeof value.id === "string" &&
  ["finished", "cancelled", "error"].includes(String(value.status)) &&
  (value.result === undefined || typeof value.result === "string") &&
  (value.error === undefined || (record(value.error) && typeof value.error.message === "string")));
export const cursorVoid = z.undefined();
