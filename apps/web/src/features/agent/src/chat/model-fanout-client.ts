import { workspaceClient } from "../network";
import type { FanoutModelSelection, FanoutOutcome } from "./model-fanout";
import { fanoutRequestBody } from "./model-fanout";

export type FanoutMessageInput = {
  id: string;
  role: "user";
  parts: Array<Record<string, unknown>>;
};

/** Server-owned fanout receipt; every child is an independent Session. */
export async function submitFanout(input: {
  operationId: string;
  sourceThreadId: string;
  message: FanoutMessageInput;
  selections: readonly FanoutModelSelection[];
}): Promise<FanoutOutcome> {
  const body = fanoutRequestBody(input);
  const value = await workspaceClient.json<unknown>("/api/chat/fanout", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return parseFanoutOutcome(value);
}

export function parseFanoutOutcome(value: unknown): FanoutOutcome {
  if (!value || typeof value !== "object") throw new Error("fanout_invalid_response");
  const record = value as Record<string, unknown>;
  if (typeof record.operationId !== "string" || typeof record.sourceThreadId !== "string" ||
      (record.status !== "created" && record.status !== "partial" && record.status !== "failed") ||
      typeof record.createdAt !== "string" || !Array.isArray(record.children)) {
    throw new Error("fanout_invalid_response");
  }
  const children = record.children.map((child) => {
    if (!child || typeof child !== "object") throw new Error("fanout_invalid_response");
    const row = child as Record<string, unknown>;
    const selection = row.selection;
    if (!selection || typeof selection !== "object") throw new Error("fanout_invalid_response");
    const model = selection as Record<string, unknown>;
    if (typeof model.providerInstanceId !== "string" || typeof model.model !== "string" || typeof row.threadId !== "string") {
      throw new Error("fanout_invalid_response");
    }
    return {
      selection: {
        providerInstanceId: model.providerInstanceId,
        model: model.model,
        ...(Array.isArray(model.modelOptions) ? { modelOptions: model.modelOptions as FanoutModelSelection["modelOptions"] } : {}),
      },
      threadId: row.threadId,
      ...(typeof row.generationId === "string" ? { generationId: row.generationId } : {}),
      ...(typeof row.error === "string" ? { error: row.error } : {}),
    };
  });
  return { operationId: record.operationId, sourceThreadId: record.sourceThreadId, status: record.status, createdAt: record.createdAt, children };
}

/** A retry must reuse the same operation id; the server never re-dispatches a completed receipt. */
export function fanoutOperationKey(threadId: string | undefined): string {
  return `agent-fanout-operation:${threadId ?? "draft"}`;
}

export function readFanoutOperation(threadId: string | undefined): string | undefined {
  try {
    return sessionStorage.getItem(fanoutOperationKey(threadId)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberFanoutOperation(threadId: string | undefined, operationId: string): void {
  try {
    sessionStorage.setItem(fanoutOperationKey(threadId), operationId);
  } catch {
    /* Session storage is optional; the in-memory operation still keeps this tab's retry idempotent. */
  }
}

export function forgetFanoutOperation(threadId: string | undefined): void {
  try {
    sessionStorage.removeItem(fanoutOperationKey(threadId));
  } catch {
    /* Storage may be disabled; nothing else to clear. */
  }
}
