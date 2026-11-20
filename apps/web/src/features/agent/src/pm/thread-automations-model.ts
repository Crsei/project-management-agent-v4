/**
 * Thread-level automation projection.
 *
 * Automations own their Chat threads (`custom.automationExecutionId` plus
 * `automationDefinitionId`). A Session that has no such binding and no execution
 * pointing at it shows nothing; this module never guesses a definition.
 */

export type AutomationExecutionLike = {
  id: string;
  definitionId: string;
  status: string;
  threadId: string | null;
};

export type AutomationBinding = {
  executionId?: string;
  definitionId?: string;
};

export type AutomationLink = {
  workspaceId: string;
  projectId?: string;
  definitionId?: string;
  executionId?: string;
  returnTo?: string;
};

export type AutomationTone = "error" | "active" | "muted" | "default";

export function automationBinding(custom: Record<string, unknown> | undefined): AutomationBinding {
  const executionId = typeof custom?.automationExecutionId === "string" && custom.automationExecutionId.trim()
    ? custom.automationExecutionId
    : undefined;
  const definitionId = typeof custom?.automationDefinitionId === "string" && custom.automationDefinitionId.trim()
    ? custom.automationDefinitionId
    : undefined;
  return { ...(executionId ? { executionId } : {}), ...(definitionId ? { definitionId } : {}) };
}

/** Keep server order, drop duplicates, and never include another thread's run. */
export function executionsForThread<T extends AutomationExecutionLike>(
  executions: ReadonlyArray<T>,
  threadId: string,
): T[] {
  if (!threadId) return [];
  const seen = new Set<string>();
  const result: T[] = [];
  for (const execution of executions) {
    if (execution.threadId !== threadId || seen.has(execution.id)) continue;
    seen.add(execution.id);
    result.push(execution);
  }
  return result;
}

export function automationPageHref(link: AutomationLink): string {
  // The automation page already has a run history and a definition detail route;
  // link into those instead of inventing a dashboard-only target.
  const path = link.executionId
    ? "/agent/automations/history"
    : link.definitionId
      ? `/agent/automations/detail/${encodeURIComponent(link.definitionId)}`
      : "/agent/automations";
  const params = new URLSearchParams({ workspace: link.workspaceId });
  if (link.projectId) params.set("project", link.projectId);
  if (link.executionId) params.set("run", link.executionId);
  if (link.returnTo) params.set("returnTo", link.returnTo);
  return `${path}?${params.toString()}`;
}

export function automationStatusTone(status: string): AutomationTone {
  if (status === "failed" || status === "outcome_unknown") return "error";
  if (status === "queued" || status === "running" || status === "cancel_requested") return "active";
  if (status === "skipped" || status === "cancelled") return "muted";
  return "default";
}
