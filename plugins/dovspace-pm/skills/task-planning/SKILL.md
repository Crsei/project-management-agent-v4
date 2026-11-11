---
name: task-planning
description: Draft a Dovspace project or issue implementation plan with scope, dependencies, acceptance criteria and evidence gaps; do not create tasks unless the user requests execution.
license: AGPL-3.0-only
compatibility: Requires the authenticated dovspace-pm MCP connection or the Dovspace PM CLI for live PM evidence.
---

# Task planning

Default deliverable is a **draft**, not a business write or automatic task completion.

1. Establish the requested scope from the conversation and authorized PM evidence. Discover current tools and targets with `pm_list_workspaces`; use explicit workspace/project targets for every other PM call. Read current records and complete relevant body pages with revisions. Distinguish unavailable access from an empty project.
2. Separate facts, requirements, assumptions and missing evidence. Never treat a successful tool/run, plan checklist or model statement as proof of WorkItem completion. Do not claim that unqueried tasks were deduplicated.
3. Draft runnable slices with goal, owned scope/non-goals, acceptance criteria, evidence and true dependencies. Do not invent business IDs, people, capacity, budget or dates. Include revision/CAS conflicts, existing permission/revocation checks and unknown-result recovery where relevant.
4. Return the plan as text. Do not create tasks, comments, dependencies or state transitions solely because planning tools are available. This is a user-intent boundary, not a second permission/approval system.
5. If the user has requested actual creation or updates, use only the corresponding advertised tools with exact current revisions, explicit targets and one stable UUID operationId per logical action. New plugin policy is full access / audit-only, not a new allow/deny selection. Preserve existing OAuth identity/consent, PM authority and explicitly configured deployment approvals.
6. Preserve returned traceId, original operationId, native/UUID command IDs, receipt, revision and five-state outcome. For a request that may have been dispatched, unknown/running/pending-approval recovery is a query of `pm_get_operation_result` with its original operationId, never redispatch or a new key. Do not turn missing evidence into failed/succeeded. CLI recovery uses the unchanged original request file with `pm plugin result --file`.
7. Redacted or unavailable records cannot be reconstructed from old summaries or cached titles. Label evidence gaps without leaking inaccessible project identities. A Session's directory and message references do not confer PM access.

The final draft explicitly lists proposed changes separately from any actually executed operations and their authorized receipts.
