# OpenHands automation production baseline

This directory contains the production automation interface, catalog and bundled source selected from the authorized read-only local OpenHands checkout. It does not contain testing fixtures, example automations, an OpenHands runtime, credentials or a second scheduler.

## Pin and licensing

- Source commit: `b4a3f45a28f6b6c387a8deb3dc7c18b4393c59c1`.
- Agent Canvas: `@openhands/agent-canvas@1.34.0`; extensions: `@openhands/extensions@0.36.0`.
- Both selected sources are MIT licensed. The complete notices remain in `LICENSE.agent-canvas` and `LICENSE.extensions`; extensions copyright is **2025 OpenHands**.
- `source-pin.json` records SHA-256 and byte lengths of the actual local interface/catalog/index/type/license files, every extracted production script, derived browser bundle index, launch-command index and relevant local frontend sources. This supplements the Git commit: it does not assert that the source working tree was clean.
- The catalog is exactly the 23 entries imported by the production `catalog-index.js`, in source order. The unindexed `slack-github-linear-daily-organization.json` and all fixtures are intentionally excluded.
- `bundles/<id>/*.py` is verbatim extracted production source. `files.json` is its derived lazy browser index. Source Python is **read-only provenance**, not executable configuration for native PM template actions.

## Complete catalog and flow mapping

| Catalog ID | Source setup | Target execution/configuration path |
| --- | --- | --- |
| github-pr-reviewer | direct / bundle | Native template, source form arguments |
| custom-automation | direct / action choice | Prompt, plugins, custom Python or persistent uploaded tarball |
| github-repo-monitor | direct / prompt | Interpolated prompt, explicit Provider/model and project connectors |
| github-issue-to-pr | direct / bundle | Native template, source form arguments |
| slack-standup-digest | no setup | Explicit assisted Chat launch prompt |
| slack-channel-monitor | no setup | Explicit assisted Chat launch prompt |
| linear-triage-assistant | no setup | Explicit assisted Chat launch prompt |
| linear-issue-to-github-pr | no setup | Explicit assisted Chat launch prompt |
| gitlab-issue-to-mr | direct / bundle | Native template, source form arguments |
| linear-issue-to-gitlab-mr | no setup | Explicit assisted Chat launch prompt |
| linear-issue-to-bitbucket-pr | no setup | Explicit assisted Chat launch prompt |
| jira-issue-to-pr | no setup | Explicit assisted Chat launch prompt |
| qa-changes | direct / prompt | Interpolated prompt and source event filter |
| jira-issue-to-gitlab-mr | no setup | Explicit assisted Chat launch prompt |
| research-brief-writer | no setup | Explicit assisted Chat launch prompt |
| jira-issue-to-bitbucket-pr | no setup | Explicit assisted Chat launch prompt |
| github-agents-md-maintainer | direct / bundle | Native template, source form arguments |
| github-delivery-watchdog | direct / bundle | Native template, source form arguments |
| github-issue-triage | direct / bundle | Native template, source form arguments |
| upstream-fork-sync | direct / prompt | Interpolated prompt and explicit project repository reference |
| incident-retrospective-drafter | assisted | Source prerequisite/form/review, then explicit assisted Chat |
| news-digest | direct / bundle | Native template, source form arguments |
| github-stale-ci-pr-closer | direct / bundle | Native template, source form arguments |

Suggested/Beta classification comes from `interface.json.featuredAutomationIds`, not a hardcoded six-card replacement catalog. Verified project connector matches may also enter Suggested; non-featured templates retain Beta regardless of section. Source tags include declared integrations and repository-picker providers. Cron/Event badges derive from the manifest trigger variants.

## Target boundaries and controls

- `packages/contracts/src/automation-catalog.ts` defines host-owned catalog DTOs only; it does not import vendor code, manifests or bundles. Stable PM handler capability admission remains in `packages/contracts/src/automation-pm.ts`.
- `packages/automation-resources/catalog.ts` is the single host assembly for the pinned catalog, source versions, tag/trigger derivations, launch prompt and lazy immutable source bundle reader. `pm-catalog.ts` assembles the PM manifests; `native-template-arguments.ts` validates source-form values against that same catalog. These are ordinary shared host modules, not another installed package or upstream implementation.
- `node scripts/check-import-boundaries.mjs` checks owned Agent and contract sources with TypeScript ASTs. Only individually named adapter/module pairs may reach vendor internals; new files under an adapter directory are not automatically allowed. It checks type imports, re-exports, literal dynamic imports, `require`/`createRequire` and static `import.meta.url` resources. `node --test scripts/check-import-boundaries.test.mjs` exercises refusal fixtures. Public workspace package exports remain distinct from private vendor-source imports; this static gate is not authorization, a filesystem sandbox or behavioral acceptance.
- `studio-templates.tsx` implements complete search, source/trigger filters, Suggested/More/Beta and actual project connection metadata. Browsing neither probes MCP nor creates/sends Chat.
- `studio-editor.tsx` implements source prerequisites → form → read-only preflight/review. The existing report editor remains separate. Blank/template/edit paths use the actual Studio schema and same server APIs.
- Native bundle templates freeze **source form field names** into `action.arguments`: multi-repository fields are `string[]`, single repository fields are strings, numeric fields are numbers, other declared fields are strings. They use `action.kind = template` and a per-template `template:<id>` runtime capability. They do not execute source SDK/Python or treat generic tarball support as source compatibility. Source secret-name fields are provenance only: native authentication uses selected revisioned verified project Integration references, never arbitrary environment variables.
- Provider/model lists, approved local repository references and installed plugins come from scoped runtime capabilities. External source-form repository identifiers are explicit provider names and are distinct from approved local `action.repositories`. There are no fixture model lists or fabricated connection states.
- Connector channels are independently verified. Native GitHub/GitLab workflows accept a verified native-API-only connection without requiring MCP tools. Prompt/script plugin choices require MCP support **and** a successful MCP verification flag. Configuration presence or the opposite channel's probe is never enough. Editor capability reads include the current `actionKind`, and catalog readiness is evaluated per template, not by a global “connected” badge.
- Provider model availability is separate from injected-tool support. The editor uses the shared `studioRequiredProviderToolFeature(config)` contract to check the selected instance's `provider:<id>:promptConnectors` or `provider:<id>:templateWorkspace` feature, including implicit source connector references. It displays the exact advertised failure reason and blocks Test/Create-and-enable/enabled-definition updates before dispatch. Draft saving, receipt reconciliation, all Provider choices, ordinary model-only prompts, news summaries and deterministic workflows remain unaffected by an unrelated tool-adapter limitation.
- `github-delivery-watchdog` and `github-stale-ci-pr-closer` are deterministic native workflows: Provider/model are explicitly `null` (“None”) and options are `{}`. The other six native bundle workflows require a real Provider/model. This preserves the source distinction rather than making deterministic workflows depend on an unrelated model configuration.
- Custom Python persists source, entrypoint, setup and immutable files. Uploaded `.tar`/`.tar.gz` goes through the real Transfer bundle endpoint, its safety limits and durable original-key receipt recovery. Selecting custom Python is an explicit execution-type change, not ignored edits to a native template.
- Six time frequencies are Once/Hourly/Daily/Weekdays/Weekly/Custom cron, plus manual and event modes. Once stores a complete UTC instant with its year and IANA timezone; nonexistent DST wall times are rejected. Event filter/payload input must be a JSON object; source expressions use `{ "expression": "..." }` with the server's bounded JMESPath adapter.
- Save draft is a server create/update, not a local-only success. Test first saves the exact version, then explicitly dispatches a real test execution. Queued/running never means succeeded. Create/enable is a distinct explicit action. Writes are CAS-revisioned and journaled before dispatch; an unknown result is reconciled with its original receipt, never blindly retried.
- Unsaved local recovery is actor/workspace/membership/editor scoped. Permission changes redact private payloads while retaining uncertain request identity. Conflicts retain user input and expose explicit rebase or reload.
- A recovered draft whose project differs from an explicit URL project is preserved visibly, not rewritten. Save/upload/test/enable and assisted handoff are blocked until the user selects a matching scope. Receipt reconciliation remains available, but does not resume a test/enable continuation under a mismatched URL scope.
- Assisted actions persist recovery first and call only the existing host `onAssist` callback with project/definition/draft scope. The host prefills Chat without sending. Structured assistant JSON is explicitly previewed and confirmed in the editor; replies are not parsed automatically. Protected recursive merging never overwrites user-edited fields, including native arguments or changes made after a preview.

## Transfer compatibility

Source `.automation.json` is a strict, limited prompt interchange, not a lossless multi-repository/script/metadata format. Complete PM transfer uses `version: 1`, `kind: pm-automation-bundle`, `spec: StudioConfig`, preserving native arguments, model options, tags and complete script file snapshots. Unsupported source conversions and unknown fields must be rejected by the Transfer service, never silently dropped. A downloaded read-only `.source-bundle.json` is provenance and is explicitly **not** a PM import document. Imports remain drafts; they do not authorize execution.

## Evidence status

The source bytes and exported shape are pinned; this document does not assert functional acceptance. Setup behavior regression tests are retained; this slice did not run them. The parent performs integrated type/build/tests/browser and real execution checks after all owners finish. Native workflow readiness, scoped Provider/service transport, independently verified connector channels and authorized external test targets are runtime prerequisites, not inferred from source UI or template popularity. Stock OpenHands Python requires separate SDK/network/profile/session/KV/claim/callback protocols and is not silently used as a fallback for native PM workflows.
