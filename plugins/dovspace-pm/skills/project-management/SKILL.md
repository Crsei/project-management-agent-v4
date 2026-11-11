---
name: project-management
description: Discover authorized Dovspace workspaces and projects, read versioned PM records, and carry out requested project or document changes through the PM gateway.
license: AGPL-3.0-only
compatibility: Requires the authenticated dovspace-pm MCP connection or the Dovspace PM CLI.
---

# Project management

1. Discover the currently advertised PM tools. Use `pm_list_workspaces` to discover authorized business targets; never invent workspace/project IDs. A Session or code directory does not belong to a PM project and grants no PM authority.
2. For every business call other than discovery, pass an explicit `target` with `workspaceId` and `projectId` (null only for an authorized workspace-scoped action), plus the registered `arguments`. Read with `pm_query` / `pm_read`; follow pagination and distinguish summaries from full bodies.
3. Keep the exact returned revision with the record. Read the required body pages before proposing a change. If a requested historical revision cannot be read, report that limitation; do not label the current body as an old snapshot.
4. Perform the user's requested changes using only tools actually advertised by the server. New plugin operation policy is full access / audit-only: do not invent a second allow/deny prompt, ACL, or approval wait. Existing OAuth identity/consent, PM membership/project permissions, revocation, exact revisions and explicitly configured deployment approvals still apply. Never bypass them.
5. Before dispatch, choose one UUID `operationId` for the logical operation and retain it. Keep its exact tool name, target and arguments unchanged for original-result recovery. Server-issued `traceId`, invocation/command IDs and receipts are evidence, not credentials; preserve them verbatim, including non-UUID command IDs.
6. Preserve `pending_approval`, `running`, `succeeded`, `failed` and `unknown` exactly. A timeout, 403 after dispatch, invalid response or client restart does not prove failure. For unknown/running/approval recovery, use `pm_get_operation_result` with the **original** operationId; never call the business write again, mint a replacement key or infer success from the object's current state. Missing evidence remains unknown. If an older gateway does not advertise the result query, stop recovery and report the missing gateway capability, rather than replaying.
7. Existing PM approval, when explicitly configured, is server-owned; a client confirmation cannot replace it. Follow only the authorized approval link supplied by the server, then query the original operation. Do not approve a different parameter set.
8. Treat visibility independently of business outcome. Redacted/unavailable results cannot be reconstructed from cached titles, arguments, errors, receipts or other project history. Recheck current access for subsequent reads. Previously downloaded external-client history cannot be recalled by the server.
9. Report the actual business result and its authorized evidence. A successful tool, model turn or code run is not proof that a WorkItem is complete. Do not change task state unless the user requested the real lifecycle action.

Use `issue-management` for issue-specific edits and `task-planning` for a non-writing plan draft. Never execute arbitrary source files, shell commands or market plugins as a substitute for PM tools.
