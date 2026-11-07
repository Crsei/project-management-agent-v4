# cc-switch configuration host

This module is the Agent's authorization, filesystem-authority and private JSON-lines bridge. MCP/Skills configuration, import, installation, backup, migration and native projection run in the TypeScript translation of the pinned cc-switch headless host. It does not replace the Provider runtime, `/mcp` OAuth, MCP Apps, PM policy, execution approvals or native Skills discovery.

## Binary and lifecycle

- `CC_SWITCH_HOST_ENTRY` may select an absolute deployment-owned `main.mjs`; `CC_SWITCH_HOST_IMPLEMENTATION=rust` plus `CC_SWITCH_HOST_BINARY` is only a rollback path. No browser field selects an executable.
- A packaged Agent resolves `dist/cc-switch/host/main.mjs` and runs it with Node 24. A missing packaged entry fails closed; it never falls back into a source checkout.
- TypeScript source development uses `apps/server/cc-switch-host/dist/main.mjs` (or the strip-only source entry) after the host build.
- Agent source execution uses Node's strip-only TypeScript support: constructor dependencies and public error properties are explicit class fields/assignments, not transform-required constructor parameter properties. No transform-types runtime flag is required.
- Each selected context lazily owns one child. `host_initialize` supplies explicit `dataDir`, `homeDir`, `appDirs`, private `claudeMcpFile` whenever Claude is bound, and the context key over stdin. A bound Claude target missing this explicit file authority requires confirmed rebind; it is never inferred from a default-looking app directory at initialization. The child inherits only a minimal process environment, not PM deployment keys or request credentials. Host-configured `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` and their lower-case forms retain the source HTTP client's network routing; browser input cannot configure these process-wide values.
- Requests/results/events are newline JSON with IDs. Protocol failure, disconnect and timeout reject pending operations. A failed write is never replayed. A subsequent explicit read can reconnect to reconcile authority.
- Agent shutdown stops its owned context children/descendants: POSIX process groups with awaited escalation; Windows fixed `System32/taskkill.exe /PID <owned-pid> /T /F`. Unconfirmed Windows tree termination is an error, not a reported successful stop. Native running Provider generations are never stopped by configuration invalidation.

## Private data and keys

All manager data is beneath `<dataDirectory()>/cc-switch/`:

- `contexts.json`: host-authorized binding metadata, never MCP credentials;
- `secret.key`: the native manager's generated 32-byte master key;
- `contexts/<contextId>/`: source SQLite/settings, Skill SSOT/backups, private ZIP uploads and project-isolated Home;
- `maintenance.json`: active reviewed PM migration exclusion identity.

New private paths reuse `packages/pm-core/private-path.ts`: POSIX owner-only permissions and current-user-only Windows ACLs. Existing unsafe paths are rejected, not silently repaired. Native databases without their matching native key require restoration of a matching private backup; no replacement key is generated for an existing native database. Context keys are HMAC-derived with context identity before entering the child's private stdin.

Project-private contexts **require the existing explicit `PM_AUTOMATION_INTEGRATIONS_KEY` 32-byte base64 deployment key on Agent**, matching the deployment key retained with PM's private integration backups. There is no generated/native-key fallback for project data. Project key derivation includes actor/workspace/project identity. The protected MCP DAO encrypts persisted definitions and per-Agent overrides; unredacted values cross only owned server-side transport and child IPC. Browser masks use structured, unambiguous context/definition/field, context/definition/app/override-or-effective/field, or context/preview/entry/app/definition/field authorities. An effective or preview mask cannot authorize a definition/override write; masks cannot move between applications, contexts, fields, or slash-containing versus nested keys. Absolute command/cwd values and nonpublic scalar extension fields are protected alongside env/header/argv and credential-bearing URL components. No browser reveal/export-secrets endpoint exists.

## Native and external target authority

Registered Providers open management directly through `POST /api/extensions/providers/:providerInstanceId/context` with exactly `{}`. The host resolves current Provider authority and prepares internal metadata only: no native imports, writes, installation, probes or credential reads. Contexts are storage/ownership records, not an additional permission ceremony. Repeated resolution and same-physical-root Providers reuse the owner and retained library; different same-driver roots remain independent. Same-root revision/alias changes refresh authority without replacing the sidecar or SSE listeners. Moving a Provider resolves its new root without copying/exporting the old library; the old record is retained. Incompatible overlapping owners fail explicitly instead of being silently overwritten.

The default `POST /api/extensions/contexts/resolve-enabled` resolver uses enabled instances only and partitions compatible targets without merging saved libraries. Physical-root ownership is checked across all Homes before registry publication, including pinned symlink identity. Disabled same-root aliases may be removed from the authority set only when enabled instances still authorize every retained physical root. A stopped owner can accept compatible additional applications; a started child keeps its immutable native paths and new targets get a separate context. Same-root metadata refresh updates the existing runtime in place, retaining subscriptions and reload state. Claude's exact MCP-file authority must remain representable with the retained owner's path spellings; canonical Home aliases alone do not establish compatibility.

Explicit external-target binding still uses IDs and `confirmed:true`, never browser paths. One application has at most one root per context; native writable roots cannot have overlapping owners. Separate contexts sharing one user Home retain independent `cc_switch` SSOTs; opting into `unified` reserves `Home/.agents/skills` for one context. Successful migration back to `cc_switch` releases that reservation. Sharing warnings do not claim app toggles are security isolation.

A deployment can register CLI targets without inventing PM Providers:

```json
[
  { "id": "external-codex-a", "label": "External Codex A", "app": "codex", "homeDir": "/srv/native-user", "appDir": "/srv/native-config/codex-a" },
  { "id": "external-gemini", "label": "External Gemini", "app": "gemini", "homeDir": "/srv/native-user", "appDir": "/srv/native-config/gemini" },
  { "id": "external-claude-override", "label": "Claude with explicit config override", "app": "claude", "homeDir": "/srv/native-user", "appDir": "/srv/native-user/.claude", "claudeMcpFile": "/srv/native-user/.claude/.claude.json" }
]
```

Set `CC_SWITCH_EXTERNAL_TARGETS_FILE` to the **absolute path of this deployment-owned JSON registry**. The file must be a regular, single-link, private file (POSIX `0600`, current-user-only Windows ACL). Its supported `app` values are exactly `claude`, `codex`, `gemini`, `grokbuild`, `opencode`, `hermes`, `pi`, `mcode`, `kimi`, `dsh`, `agy`, `omp`. Roots are explicit absolute paths; no guessed/default layout or real-HOME fallback is applied. The public target inventory exposes `externalTargetId`, labels, app IDs, overlap warnings and fingerprints, not these absolute authority paths. External CLI registration does not add Chat support or PM execution grants. Actual overlapping PM Provider roots are identified and invalidated after external-only mutations too.

Claude's native default and explicit config override are distinct even when the app directory is the same `Home/.claude` path. Provider targets derive the chosen private file from the real effective runtime `CLAUDE_CONFIG_DIR`: genuinely unset uses `Home/.claude.json`, while an explicit nonempty override uses `appDir/.claude.json`. External registry descriptors may specify `claudeMcpFile` only for `app:"claude"`; its absolute normalized value must exactly equal `homeDir/.claude.json` or `appDir/.claude.json`. When the external descriptor omits it, registration resolves cc-switch's standard default/custom rule once and persists the explicit choice. The file participates in canonical ownership, binding fingerprints and combination checks; same-directory targets with different MCP files cannot merge. Stored `binding`/`providerBinding`/external snapshots retain it unchanged, but browser target/context DTOs never expose it and browser binding requests cannot supply it. Changed or older bound-Claude metadata lacking the field requires explicit rebind, not a compatibility fallback.

Every operation rechecks current Provider revisions and physical path identity. Reopening registered-Provider management refreshes only matching current authority; external registrations and restored external enrollment still require explicit reconciliation/rebind when changed. Neither resolution nor rebind exports configuration. Unbind removes only ownership and stops that manager; it does not erase native configuration or retained recovery data.

## Browser routes

All are under existing Agent access/Origin guards and return `Cache-Control: no-store`. MCP/public automation bearers and dedicated service signatures are rejected as browser-management credentials.

- `GET /api/extensions/targets` → safe Provider/external target metadata.
- `POST /api/extensions/providers/:providerInstanceId/context` with `{}` → idempotently resolve a saved Provider's real configuration owner; no `confirmed`, paths or external IDs accepted. Existing Agent access/Origin guards remain.
- `GET /api/extensions/contexts` → native contexts only.
- `GET /api/extensions/contexts?workspaceId=...&projectId=...` → resolve the actual PM cookie identity and ensure its exact project-private context. It has no native app targets.
- `POST /api/extensions/contexts` and `POST /api/extensions/contexts/:id/binding` accept `{providerInstanceIds?:string[],externalTargetIds?:string[],confirmed:true}` with at least one target.
- `DELETE /api/extensions/contexts/:id` accepts `{confirmed:true}` for native unbind only.
- `POST /api/extensions/contexts/:id/invoke` accepts `{command,args}` from the explicit source-management allowlist. Paths, arbitrary Tauri/shell commands, host initialization and settings-root overrides are not dispatchable.
- `POST /api/extensions/contexts/:id/uploads` accepts raw `application/zip` bytes, bounded at 100 MiB, and returns an opaque context-owned `uploadId`. `install_skills_from_zip` consumes `{uploadId,currentApp}`; the native path is never browser-supplied. The TypeScript host validates/extracts/installs the actual ZIP.
- `GET /api/extensions/contexts/:id/events` uses SSE: `status`, `mcp-connectivity`, `warning`, `changed`, `operation`. Native-context connectivity starts only on explicit `start_mcp_connectivity_checks`, never list/init/page mount, and includes `{batchId,serverId,connected,requestId?}`. Cancel is explicit.
- `browse_directory` / `read_skill_file` are real installed-Skill/SSOT-contained browser helpers. They do not launch a remote file manager or claim that one opened.
- Native Skill scan payloads omit absolute `path`; backup/preserved-Pi path fields expose explicit path-withheld contextual labels only, retaining actual backup presence and opaque backup IDs. The old browser `get_cc_switch_skills_dir` path command is not dispatchable; contained browsing still resolves its real root through private IPC.

### MCP library, assignments and reviewed imports

Public types are exported by `@agent-workspace/contracts/extensions`: `ExtensionMcpDefinition`, `ExtensionMcpAgentConfiguration`, `ExtensionMcpManagement`, `ExtensionMcpImportPreview`, `ExtensionMcpImportEntry`, `ExtensionMcpImportSelection`, `ExtensionMcpImportResult` and the `ExtensionMcpCommands` argument/result map.

- `get_mcp_management {}` returns `{definitions,agentConfigurations,boundApps}`. Definitions never contain assignment flags. Rows describe only bound targets and expose real compatibility/sync reasons, not a fabricated connection status. Native paths, extra private IPC fields and arbitrary diagnostics are not forwarded.
- `save_mcp_definition {definition}` preserves existing assignments/overrides; a new library definition starts unassigned. Definition env/headers omission preserves previous maps; a complete provided map replaces the keyset and `{}` clears it.
- `set_mcp_agent_configuration {serverId,app,enabled,override?}` requires an explicitly bound app. Omitted override preserves it, `null` removes it, and an object replaces the saved JSON Merge Patch (including `{}` for an empty patch). Inside that patch, objects merge into the base, null removes inherited keys and arrays replace. Only masks from this exact saved override can be restored; effective configs are read-only browser data.
- `preview_mcp_import {}` scans only bound native roots. Its reviewed snapshot remains private inside that context's TypeScript host. The response is masked; scanning causes no operation/changed events, Provider invalidation, native writes or reload notice.
- `apply_mcp_import {previewId,selections:[{entryId,resolution}]}` accepts only the opaque reviewed IDs and `import`/`merge-override`/`skip`; browser-supplied definitions, entries, effective configs and paths are rejected. Duplicate selections reject. Native/library snapshot drift rejects with HTTP 409 `mcp_import_preview_stale`; it is never silently retried. A successful import commits library/assignments without rewriting native files, and publishes `nativeFilesWritten:false,syncReconciliationRequired:true`.
- The obsolete direct browser `import_mcp_from_apps` command is not dispatchable. Existing matrix saves/toggles/resync remain real source operations and retain overrides.

Management snapshots/previews are pure reads. Successful and partial/unconfirmed writes invalidate affected Provider snapshots and retain existing reload-needed/live-execution notices; consumers must re-read authority after a failed dispatched mutation. Source errors are opaque except a finite reviewed set of host-authored stale-preview/selection/conflict/compatibility/binding failures. A queued operation cannot reuse a context that has since been unbound or rebound.
Explicit stale/invalid/conflicting import-plan rejections are proven pre-commit/no-write outcomes: they report failed operations without emitting false `changed`/reload notices. Skip-only imports (`applied:0`) also avoid invalidation/reload while retaining an explicit completed/partial operation result. Unknown DB/IPC failures remain unconfirmed and conservatively invalidate.

Project-private contexts expose MCP definition reads, eligible Streamable HTTP definition saves/deletion and read-only management settings only. Assignment/import/native filesystem/Skills operations reject with explicit project capability reasons. Save uses PM endpoint/header policy before dispatch and reconciles the actual definition fingerprint through PM after any dispatched write; referenced deletion reservations and scope/revision authorization remain unchanged.

Project requests re-resolve PM actor/workspace/project and recheck read/write authority. Project definitions resolve only through the existing PM-policy-valid Streamable HTTP contract; project stdio execution and native export are not granted. Project contexts reject native probe start/cancel with `project_connectivity_requires_pm`: the copied native client supports host proxy routing and cannot replace PM's pinned-DNS, no-proxy, no-redirect, no-retry transport. The manager disables those controls and links to the same project's explicit Studio connection verification; it neither fabricates connectivity results nor grants tools. Native contexts retain the source probe implementation. `changed` distinguishes saved configuration, projection outcome and live session reload. Final `operation.completed` is emitted only after required PM approval invalidation is confirmed. Partial/failed or unconfirmed writes retain failure state and require reconciliation; they still invalidate affected native discovery snapshots if mutation dispatch may have committed.

## Private PM service and migration control

PM runs separately and uses the production `createAutomationDefinitionClient()` signed HTTP transport. Agent does not import the PM application and PM does not start another manager. Both sides need the existing dedicated `PM_AUTOMATION_SERVICE_SECRET`; callbacks use `PM_API_URL` (default loopback port 4194). Browser origins and service bearers do not substitute for a method/path/body-bound HMAC.

Private endpoints below `/internal/extensions/definitions` are `list`, `resolve`, `ensure-context`, `import`, `begin-maintenance`, `end-maintenance`. Definition operations accept exact `scope:{actorId,workspaceId,projectId}`. `resolve` returns real endpoint/headers only to this owned authenticated service, after exact context identity and current PM authorization checks. List returns references/fingerprints, never secret headers. Missing context/server is `404`; there is no old-store fallback.

Project context identity is `pm-` plus the first 32 hex characters of SHA-256 over `actorId + NUL + workspaceId + NUL + projectId`. Fingerprints match PM's recursively lexicographic canonical JSON SHA-256 of `{transport:'streamable-http',endpoint,headers}`, with normalized lower-case headers. Import compares existing authority first, returns equal definitions, and rejects differing deterministic mappings without overwrite.

Callbacks to PM are signed `/internal/extensions/authorize`, `/references`, `/invalidate`. Delete reserves a PM tombstone with `reserveDelete:true` before native deletion, and refuses with scoped visible references if still bound. Actual upsert reconciliation sends the real fingerprint; only PM owns approval invalidation, tombstone clearing, native API policy and execution receipts. A failed projection can follow DAO persistence, so invalidation also follows dispatched-but-failed definition writes, but not rejected authorization/validation/mask/delete guards.

Migration control accepts `{migrationId:<reviewed-plan-sha256>}`. Begin persists the gate, then drains existing project mutation queues. Browser project writes reject while gated. Signed migration `ensure-context`/`import` must carry the same `migrationId` to bypass the gate and use PM's maintenance authorization. End refuses new imports while draining existing project queues before clearing the exact owner's gate. A different owner rejects; same-plan begin/end are idempotent. Process restart reloads the gate, and request abort during end/drain retains it for explicit same-plan reconciliation. Read-only resolution remains outside mutation queues to avoid a PM workspace-lock/deletion callback deadlock.

## Verification entry points

The focused suites exercise these boundaries:

- `external-targets.test.ts`: all 12 external registrations, no invented Provider, changed/unknown registration rejection;
- `secrets.test.ts`: definition/override/effective/preview authority masks, ambiguous-path and cross-context/app rejection, field removal/clear/omission, valid masked URL round-trip, scalar/absolute-path protection, canonical fingerprints, forged-import/config/path allowlists, exact public wire shapes and diagnostic redaction;
- `storage.test.ts`: private/concurrent native keys, mandatory isolated project key, durable same-owner migration control;
- `routes.test.ts`: Origin/access/service credential separation and signed method/path/body boundaries;
- `service.integration.test.ts`: **real built sidecar required**; same-Home/two-root independence, encrypted DAO bytes, real ZIP upload/install/native file projection, external-overlap Provider invalidation, exclusive Unified migration/release, retained-ID rebind, explicit real MCP handshake events, project native-probe/assignment/import denials, shared definitions/protected overrides, pure previews and stale/native-drift import rejection with unchanged native files.

Run the Agent typecheck/tests with the matching native binary, then exercise integrated PM→Agent authorization, migration and the actual browser surface. Windows ACL/process-tree behavior and target-platform native CLI loading require actual platform verification; authored tests or source inspection are not evidence they passed. Recorded integration results and outstanding gates are in the repository's cc-switch migration plan.
