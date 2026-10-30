import type { PmContext } from "@agent-workspace/contracts/chat";
import type { PmReferenceInput } from "@agent-workspace/contracts/pm-references";

/**
 * Module-level hand-off between the PM context layer and the chat network
 * adapters. It keeps only the latest values of the mounted chat surface: no
 * persistence, no bodies, no credentials — just IDs the caller already owns.
 */
export type PmChatContextInput = {
  taskId?: string | null;
  entityId?: string | null;
};

let context: PmContext | null = null;
let references: readonly PmReferenceInput[] = [];

function normalizeId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Both-null/absent clears the binding; a partial binding is valid. */
export function setPmChatContext(next?: PmChatContextInput | null): void {
  const taskId = normalizeId(next?.taskId);
  const entityId = normalizeId(next?.entityId);
  context = taskId || entityId ? { taskId, entityId } : null;
}

export function getPmChatContext(): PmContext | null {
  return context;
}

export function setPmReferences(next: readonly PmReferenceInput[]): void {
  references = next.slice(0, 50);
}

export function getPmReferences(): readonly PmReferenceInput[] {
  return references;
}
