import type { PmReferenceInput } from "@agent-workspace/contracts/pm-references";

// Only explicit per-message PM references cross into transport. Sessions own no PM target.
let referenceOwner: string | null = null;
let references: readonly PmReferenceInput[] = [];
export function setPmReferences(localThreadId: string, next: readonly PmReferenceInput[]): void {
  referenceOwner = localThreadId;
  references = next.slice(0, 50);
}
export function clearPmReferences(localThreadId: string): void {
  if (referenceOwner !== localThreadId) return;
  referenceOwner = null;
  references = [];
}
export function getPmReferences(localThreadId: string): readonly PmReferenceInput[] {
  return referenceOwner === localThreadId ? references : [];
}
