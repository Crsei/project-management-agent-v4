---
name: issue-management
description: Read and update authorized Dovspace tasks and bugs, comments, dependencies and lifecycle state with exact revisions and trustworthy original-operation recovery.
license: AGPL-3.0-only
compatibility: Requires the authenticated dovspace-pm MCP connection or the Dovspace PM CLI.
---

# Issue management

- Discover authorized workspace/project targets using the current tool catalog and `pm_list_workspaces`. Use `pm_query` to find an issue; read its current record/body and exact revision using `pm_read`. Do not fabricate issue IDs, membership, revisions or unadvertised tools.
- Supply explicit `target: { workspaceId, projectId }` and registered `arguments` for each issue call. PM references, Session identity and cwd do not restrict or grant execution authority. Check each endpoint of cross-project relations using its own authorized record and revision.
- Use `pm_create_task` / `pm_update_task` only for the requested ordinary fields. Null means unchanged where specified; clearing fields follows the advertised schema. Use comment and relation tools instead of pretending a Markdown mention created a formal relation. Do not silently convert a suggestion into a new issue.
- Use advertised lifecycle tools for requested state transitions, archive, restore or permanent deletion. Existing server authorization, workflow, revision/CAS and retained-reference protections remain authoritative. Tool success or a passing test does not complete a task by itself.
- New plugin operation permissions are full / audit-only, with no new per-operation user prompt. Existing OAuth consent and an installation's explicit PM approval policy remain required. Do not ask users to grant a second plugin ACL or bypass a configured approval.
- Assign one UUID `operationId` before first dispatch. Preserve the exact original request, server `traceId`, command IDs (which can be native hash strings), receipt and revision. Keep request files private; do not put credentials or business bodies into plugin configuration or public logs.
- Preserve all five outcomes: pending_approval, running, succeeded, failed, unknown. If the call may have been sent and the response is lost, stop writing and call `pm_get_operation_result({ operationId })`. A missing record or 401/403/404 is not proof of non-execution. Do not automatically retry, change operationId, repeat a destructive action, or infer the original result from current object existence. Query the original operation after configured approval, restart or restored network access.
- Keep business outcome separate from current visibility. If access is revoked, show the server's safe inaccessible placeholder; do not reveal cached issue titles, parameters, diffs or error details. Authenticated read failures cannot rewrite a succeeded business receipt.

A report states what actually changed, which revision/receipt proves it when visible, and which operations remain unknown or unavailable. Existing external downloads cannot be revoked from client storage.
