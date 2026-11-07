/** Human approvals are the default; auto-approve exists only as an explicit deployment switch. */
export type ApprovalMode = "ask" | "auto-approve";

const ENV = "AGENT_APPROVAL_MODE";

export function approvalMode(): ApprovalMode {
  const value = process.env[ENV]?.trim();
  if (!value || value === "ask") return "ask";
  if (value === "auto-approve") return "auto-approve";
  throw new Error(`${ENV} must be "ask" or "auto-approve".`);
}

/** Fail fast at startup rather than silently treating a typo as human approval. */
export function assertApprovalMode(): ApprovalMode {
  return approvalMode();
}

export function autoApproveApprovals(): boolean {
  return approvalMode() === "auto-approve";
}
