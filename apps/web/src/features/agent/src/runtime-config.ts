/** Server-owned runtime switches mirrored by the access gate before any chat surface mounts. */
export type ApprovalMode = "ask" | "auto-approve";

let approvalMode: ApprovalMode = "ask";

export function setApprovalMode(value: unknown): void {
  approvalMode = value === "auto-approve" ? "auto-approve" : "ask";
}

export function autoApprovalsEnabled(): boolean {
  return approvalMode === "auto-approve";
}
