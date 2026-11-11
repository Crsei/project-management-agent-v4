# dovspace-pm

First-party PM workflows for Codex, Claude Code, Pi and OpenCode. The three `skills/*/SKILL.md` files and the existing application PM tool registry are the single source. Adapters connect to the same authoritative `/mcp`; they contain no PM business implementation, database writer, model caller, credentials or third-party plugin host. Conditional plan E is not enabled.

This authoring directory deliberately has no preconfigured `mcp.json`: no public service origin has been approved. **Generate a configured distribution before loading it.** The generated `portable/` is a self-contained Agent Plugins **1.0.0** package with root `plugin.json`, concrete `mcp.json`, shared Skills, capability/result schema snapshot and complete AGPL license. Native adapters and compatibility manifests are generated from that source, not independent tools.

## Generate, install, update and uninstall

From the Dovspace source checkout, using its Node 24 toolchain:

```sh
mkdir -m 700 /tmp/dovspace-pm-profile
pnpm pm plugin generate --root /tmp/dovspace-pm-profile --origin http://127.0.0.1:3224
# install is the same owned-path publication with an installed status:
# pnpm pm plugin install --root /absolute/new-private-root --origin https://YOUR_CONFIRMED_ORIGIN
pnpm pm plugin update --root /tmp/dovspace-pm-profile --origin http://127.0.0.1:3224
pnpm pm plugin uninstall --root /tmp/dovspace-pm-profile
```

The loopback example is only the existing local gateway, **not** a claim that MCP/OAuth is configured or reachable there. For an external installation supply the administrator-confirmed HTTPS origin. Do not copy `YOUR_CONFIRMED_ORIGIN` into a real configuration. Origins must be absolute, concrete, credential-free and path/query/fragment-free. HTTP is allowed only on loopback. `${ENV}` and other placeholders are rejected; portable remote URLs/headers do not expand variables. The generator writes the supplied concrete origin plus `/mcp`, never tokens or headers.

`--root` is mandatory, absolute, pre-existing, operator-owned and private (0700). It must have safe non-symlink ancestors; no global Home is inferred. Output is only `<root>/dovspace-pm/`. Install/generate refuse an existing target; update/uninstall verify the exact owned file inventory and hashes, refusing symlinks, hardlinks, unexpected files and changed files. Native user configs are not read, merged or overwritten. An exclusive `.dovspace-pm.install-lock` rejects simultaneous installers. Staging plus rename publishes complete packages; a failed publication restores the prior package. A failure removing an old package reports its preserved backup path instead of force-deleting it. Incomplete staging or an interrupted-process lock is retained for operator inspection, never treated as permission to recursively delete arbitrary content. The lock is cooperative filesystem safety, not an OS sandbox or protection from another process running as the same user.

Do not run clients with their credential/session storage inside the managed package: update/uninstall intentionally refuse extra or modified files. Put native profiles beside it. After a process interruption, ensure no installer is running before inspecting the reported stage/backup and removing an empty stale lock; preserve the backup when in doubt. Update does not restart clients or widen existing OAuth consent. Native registration removal, local package removal and server-side OAuth revocation are separate actions.

The CLI returns an observable notice: **new operation policy is full access / audit-only**, no second allow/deny prompt or approval wait. Existing authentication, OAuth identity establishment/consent, PM membership/project permissions, explicit pre-existing delegated limits/revocation, revisions/CAS/idempotency and explicitly configured deployment approvals remain enforced. A full policy does not grant anonymous or cross-project access. No client-wide permission settings or deployment approval config are rewritten.

## Generated artifacts

| Path | Real consumption path and boundary |
| --- | --- |
| `portable/` | Agent Plugins 1.0.0 root manifest, Skills and streamable HTTP MCP. Only Skills/MCP are core components. Local schema profile validation is pinned; no schema fetch during generation/load. |
| `codex/` | Native MCP TOML fragment, `.agents/skills`, local portable marketplace and `.codex-plugin` compatibility fallback. CLI MCP+Skills and desktop marketplace installation are distinct surfaces. |
| `claude/` | Native `.claude-plugin/plugin.json`, `.mcp.json` (`type: http`) and Skills, consumed with `--plugin-dir`. Not falsely labeled portable Claude schema. |
| `pi/` | Actual first-party package and small `index.ts` registering the remote MCP server with built-in OAuth. No custom transport or credential reader. Pi extensions run with full host OS permissions, not in a sandbox. |
| `opencode/` | Native OpenCode **2.1.2** `mcp.servers` configuration and `.opencode/skills`; no legacy normalization, parallel major-version adapter or JS plugin. |
| `capabilities.json` in packages | Schema/description/capability metadata exported from the real PM registry and result contracts. Tool count is derived, not hardcoded. Runtime tools/list and existing authorization determine actual availability. |
| `connection.json`, `clients.json` | Concrete connection, nonblocking policy notice, documentation targets and separately labeled parent-measured executable versions. Never authentication material. |

## Native client commands (not run by the installer)

The following use the concrete local example above. Keep a real client's profile **outside** `dovspace-pm`; use disposable profiles for acceptance. Native model authentication, network/TLS and Dovspace OAuth are separate prerequisites. These commands are instructions, not a report that any client was installed or exercised.

```sh
BUNDLE=/tmp/dovspace-pm-profile/dovspace-pm
```

### Codex CLI and desktop

Documentation target **0.167.0**; parent measured installed **codex-cli 0.166.0** under isolated HOME. The native MCP/TOML and `.agents/skills` path is retained; desktop remains a separate surface. Availability/help and discovery commands:

```sh
command -v codex
codex --version
codex mcp --help
# Use a separate disposable CODEX_HOME for consolidated smoke.
# The -c value is the same concrete URL written into codex/mcp.toml.
(cd "$BUNDLE/codex" && codex -c 'mcp_servers.dovspace_pm.url="http://127.0.0.1:3224/mcp"' mcp login dovspace_pm)
(cd "$BUNDLE/codex" && codex -c 'mcp_servers.dovspace_pm.url="http://127.0.0.1:3224/mcp"' mcp list)
(cd "$BUNDLE/codex" && codex -c 'mcp_servers.dovspace_pm.url="http://127.0.0.1:3224/mcp"')
```

Launching from `codex/` discovers its `.agents/skills`; the supplied `-c` setting avoids modifying existing config. For another origin use the exact URL in the generated `codex/mcp.toml` for **each** command. Do not assume that fragment is loaded automatically. CLI overrides are invocation-scoped, so stopping their use unregisters this native MCP connection; `codex mcp logout dovspace_pm` under the same configured profile removes native stored OAuth state (review `codex mcp --help` on the exact version). Server revocation remains independent.

Desktop/local-marketplace path, separately verified by a person with the real application:

```sh
codex plugin marketplace add "$BUNDLE/codex"
codex plugin marketplace list
# Later: codex plugin marketplace remove dovspace-pm
```

Open the desktop Plugins Directory, choose the `dovspace-pm` source, install and authenticate, then start a new chat. CLI marketplace registration is **not** evidence of desktop installation or Skills invocation. The generated compatibility manifest is only a fallback; current portable loading remains the preferred path.

### Claude Code

Documentation baseline **2.1.281** provides MCP validation support; parent measured installed **2.1.303** under isolated HOME. No schema downgrade or alternate business transport is needed:

```sh
command -v claude
claude --version
claude plugin validate "$BUNDLE/claude" --strict
claude --plugin-dir "$BUNDLE/claude" --init-only
claude --plugin-dir "$BUNDLE/claude"
```

In Claude use `/mcp` to authenticate the `dovspace-pm` server with existing Dovspace OAuth; verify all three namespaced Skills and the same PM tool catalog. `--plugin-dir` is invocation-scoped and does not rewrite persistent plugin config. Stop supplying it to unload. Remove any native OAuth credentials through Claude's own `/mcp` UI and revoke the client at Dovspace separately. Client-native confirmation cannot replace explicit PM deployment approvals, and the plugin adds no new permission prompt.

### Pi

Parent measured installed **Pi 1.1.0** under isolated HOME; the earlier documentation target was 1.5.1. Installed 1.1.0 declarations and version-pinned official docs both expose `ExtensionAPI.registerMcpServer(name, config)` with remote `url` and `exposure: "direct"`. The package accepts host **`^1.1.0`** and uses that same thin native registration/OAuth path, without intercepting tool arguments/results.

```sh
command -v pi
pi --version
# Run in a disposable trusted project, with native profile outside the bundle.
pi install --local "$BUNDLE/pi"
pi list
pi
# In Pi: /mcp, then /mcp login dovspace-pm; /reload after package changes.
# In the same disposable project when uninstalling:
pi remove --local "$BUNDLE/pi"
```

Shell `pi mcp list/login` does not load extensions, so it cannot inspect an extension-registered connection; use interactive `/mcp` here. Existing same-name file configuration takes precedence and is surfaced by Pi, not overwritten. Pi stores and refreshes OAuth itself. `/mcp logout dovspace-pm` removes native local credentials; Dovspace server revocation is separate. A third-party extension replacing Pi built-in `/mcp` is a compatibility blocker, not a reason to install a new host or custom token path.

For a model-free, invocation-only loading probe on Pi 1.1.0, use a separate `PI_CODING_AGENT_DIR` and isolated HOME, keep stdin open, start the following process and send only the JSONL inspection commands shown. No prompt is submitted:

```sh
pi --offline --no-approve --no-extensions --extension builtin:mcp --extension "$BUNDLE/pi/index.ts" --no-skills --skill "$BUNDLE/pi/skills" --no-context-files --no-session --mode rpc
```

```jsonl
{"id":"skills","type":"get_commands"}
{"id":"state","type":"get_state"}
```

`get_commands` exposes the three `skill:` commands and extension commands; inspect startup/extension diagnostics as well. Close stdin for orderly shutdown. This proves only loading/discovery, not authenticated tool execution. For live MCP discovery/OAuth, remove `--offline`, open the same explicitly loaded resources in the TUI with no initial prompt, then use `/mcp` and `/mcp login dovspace-pm`. Retain existing project trust boundaries; do not add `--approve` merely to bypass them.

### OpenCode 2.x

Parent measured installed **2.1.2** under isolated HOME. `opencode/` now targets its native V2 schema: server names are under `mcp.servers`, the connection is enabled by default without an `enabled` field, and `codemode: false` directly exposes the server's tools without changing permission rules. OAuth remains native/default; no headers or credentials are embedded.

```sh
command -v opencode
opencode --version
opencode --help
opencode mcp list --help
opencode debug config --help
opencode api --help
# Use a disposable HOME/XDG profile outside the managed bundle.
# Start with no prompt: private server, native config and shared Skills from cwd.
(cd "$BUNDLE/opencode" && opencode --standalone)
```

**Do not type `/mcps` (or other slash-looking diagnostic text) into the composer for smoke.** In the measured 2.1.2 client this was submitted as a model prompt instead of opening diagnostics. An empty model-credential profile is not a no-inference guarantee: OpenCode can select an anonymous/free default model.

For a source-backed model-free configured-server check, use the native API subcommand, which does support its own `--standalone` flag, and explicitly select the package directory. Run only in an isolated credential-free HOME/XDG profile; configuration output is private and must not be published unreviewed:

```sh
(cd "$BUNDLE/opencode" && opencode api --standalone GET /api/config --header "x-opencode-directory:$BUNDLE/opencode")
# Optional read-only runtime catalogs, with the same explicit native location:
(cd "$BUNDLE/opencode" && opencode api --standalone GET /api/mcp --header "x-opencode-directory:$BUNDLE/opencode")
(cd "$BUNDLE/opencode" && opencode api --standalone GET /api/skill --header "x-opencode-directory:$BUNDLE/opencode")
```

`GET /api/config` reads configuration sources; inspect the generated document's `mcp.servers.dovspace-pm` and concrete URL. These commands call native GET endpoints, not session/prompt/generate endpoints. The directory header selects the native OpenCode configuration location; it is not a PM authority grant. The native CLI manages the private server's authentication and lifetime. No raw credential or authorization header is supplied here.

For interactive error inspection, start the standalone TUI without a prompt, press **Ctrl+P**, and first verify that the **Commands** dialog is visibly open. Search/select **MCP servers** (command ID `mcp.list`). In that MCP dialog select `dovspace-pm` and press Enter to view a failed connection's error details. Do not press Space for a read-only probe: it toggles/retries the connection. If the palette does not open, stop; do not fall back to submitting diagnostic text in the composer. This uses local UI callbacks rather than a model. Inspect the three shared Skills separately; V2 IDs are path-derived (`project-management`, `issue-management`, `task-planning`) and the native model skill tool takes `{ "id": "..." }`, but invoking a model is not required merely to inspect configuration.

`opencode --standalone mcp list` is not supported by the measured 2.1.2 CLI. Its ordinary `mcp list/auth/logout` and `debug config` commands use a shared-server connection; use the explicit private API path above for isolated smoke instead of stopping/reconfiguring an existing user's service. Source `mcp.list` passes the caller's cwd, so an empty one-shot list is not inherently proof of global-only lookup or missing generated configuration. The MCP server registry is populated by an asynchronously activated config plugin, while the list handler has no activation barrier; an initial empty list and a later TUI failure can differ. Treat activation timing as an unconfirmed explanation until independently proven. A listed server whose discovery/OAuth endpoint returns 503 is **configured but unavailable**, not absent; no unauthenticated fallback is installed. The generated config sets no client-wide `permissions`/`policies`, OAuth disabling, global plugin manager or new operation gate.

The previous authoring baseline was OpenCode 1.19.5. It is not a second shipped adapter: this unpublished plugin cleanly targets installed V2. V2 source does contain legacy normalization, but this distribution deliberately does not rely on it. Stopping use of the generated profile unloads the integration; local OAuth logout and Dovspace server revocation remain separate.

## Ordinary PM CLI adapter

The repository CLI deliberately reuses existing `pm login` / origin-bound private session authentication, **not** another client's MCP OAuth token. It calls the existing PM application service with an external execution root, no fake Chat Session/generation. It does not read a global native client Home or use internal reconciliation endpoints.

**Approval channel boundary:** Agent `AGENT_APPROVAL_MODE=ask` applies to the Agent/MCP route. The ordinary CLI uses the existing direct native PM API, whose existing authentication, capabilities, project scope, lifecycle and CAS/idempotency guards remain authoritative; it does not enter or claim to exercise the Agent approval queue. This adapter adds neither an Agent approval bypass endpoint nor a new CLI approval gate. Test native CLI semantics separately from MCP-client approval scenarios.

```sh
pnpm pm login --email YOUR_EMAIL
pnpm pm plugin tools
pnpm pm plugin workspaces
pnpm pm plugin call --file /private/path/original-request.json
pnpm pm plugin result --file /private/path/original-request.json
```

Use an unchanged request object `{ "operationId": "UUID", "name": "advertised PM tool", "target": { "workspaceId": "authorized UUID", "projectId": "authorized PRJ ID or null" }, "arguments": { "registered tool arguments": "..." } }`, replacing every description with actual discovered values. Read current revisions before writes. The file is caller-owned and may contain private business text; keep it private and out of the plugin package. Do not include credentials, actor claims, client-issued trace IDs or Chat IDs.

Before dispatch, the adapter durably reserves the origin+operation identity in a 0600 private journal. A repeated `plugin call`, concurrent attempt or restart selects **only `/result`**, never redispatches `/call`. The journal stores only origin, operationId, format version and the nonblocking full/audit-only policy record, not request arguments, titles, results, access tokens or low-entropy content hashes. Preserve it with private CLI state. Default location is the existing CLI session directory's `operations/`; `PM_CLI_OPERATION_DIR` selects an explicit absolute private directory. Do not delete or change profiles to turn an unknown operation into a fresh call. The server still rejects same-key/different-request attempts and rechecks current PM access. `plugin result` is business-read-only original-operation recovery even when no local journal exists; it reserves the local identity so a later `call` cannot turn that unknown lookup into a new dispatch.

All adapters preserve original operationId, server traceId, invocation and command IDs, exact revision, receipt and the five states: `pending_approval`, `running`, `succeeded`, `failed`, `unknown`. An unconfirmed first dispatch is **unknown**, never a fabricated failure. HTTP access denial returns a redacted placeholder without business status/body; an unavailable `/result` read similarly does not overwrite an already-confirmed outcome. No automatic write retry is installed. Native MCP clients use `pm_get_operation_result({operationId})`; the ordinary PM CLI uses `/result` with the unchanged original request. Response certainty distinguishes possibly-sent/unresolved evidence, not guessed non-execution. Results and current visibility are separate; redacted/unavailable responses never reconstruct cached PM bodies. Prior downloads/native transcript caches cannot be recalled by server revocation.

The ordinary CLI accepts only the public result projection. A visible record must match the original operation, tool, workspace/project target, external execution root and empty Chat correlation IDs; any receipt must identify the original operation. Wrong-target/malformed results and hidden projections carrying extra payload are replaced by a safe unavailable response, never echoed. Unknown non-contract fields are discarded rather than returned as an unchecked body copy.

## Compatibility and release evidence

The parent measured executable versions under isolated HOME: **Codex 0.166.0, Claude 2.1.303, Pi 1.1.0, OpenCode 2.1.2**. These are not the same fact as successful package loading, Skills/tool discovery, OAuth, model execution or business acceptance. `clients.json` separates `documentationVersion` from `measuredVersion` and names the measurement source; this worker did not rerun those version observations or execute clients. Pi 1.1.0's installed API declarations and [version-pinned extension docs](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/extensions.md) establish the thin registration API; OpenCode's generated config uses [native V2 MCP](https://opencode.ai/docs/mcp-servers/). Capture actual OS, package digest, profile, authentication identity class, time and evidence path for loading and each remaining acceptance scenario. Codex desktop still requires distinct evidence. No public TLS/distribution origin or real authentication/model/business acceptance is inferred from available binaries.

Maintainer checks (not a claim of execution):

```sh
node --test packages/pm-cli/tests/plugin-distribution.test.ts packages/pm-cli/tests/plugin-adapter.test.ts
pnpm typecheck
pnpm lint
pnpm check:docs
```

Real-client smoke must separately cover: installation from clean isolated profiles and unchanged unrelated config; same runtime tool/Skill discovery; OAuth consent, rejection, expiry/revocation, account/project boundaries; exact-revision writes and conflicts; existing deployment `ask` approvals and explicitly configured auto-approve; response loss after commit and client restart; original-operation-only recovery; revoked-history visibility; adapter update drift/failure and owned-only uninstall. A protocol fixture is not four real-client acceptance. Needed but unavailable client executables, model accounts, MCP/OAuth deployment, approved HTTPS/distribution origin and public release authorization remain **unverified prerequisites**, not silently passed checks.

## Sources and license

- [Agent Plugins 1.0.0 specification](https://agent-plugins.org/specification), [manifest schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json), [MCP schema](https://agent-plugins.org/schemas/1.0.0/mcp.schema.json), [Agent Skills specification](https://agentskills.io/specification).
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins) and [Codex MCP](https://developers.openai.com/codex/mcp).
- [Claude manifest and validator](https://code.claude.com/docs/en/plugins/manifest-reference).
- [OpenCode V2 native MCP](https://opencode.ai/docs/mcp-servers/), [configuration](https://opencode.ai/docs/config/), [Skills](https://opencode.ai/docs/skills/) and [pinned 2.1.2 source](https://github.com/anomalyco/opencode/tree/v2.1.2).
- OpenCode 2.1.2 safe diagnostics are grounded in [native API CLI dispatch](https://github.com/anomalyco/opencode/blob/v2.1.2/packages/cli/src/commands/handlers/api.ts), [native location selection](https://github.com/anomalyco/opencode/blob/v2.1.2/packages/server/src/location.ts), [TUI command registration](https://github.com/anomalyco/opencode/blob/v2.1.2/packages/tui/src/app.tsx), [default Ctrl+P binding](https://github.com/anomalyco/opencode/blob/v2.1.2/packages/tui/src/config/keybind.ts), [MCP error dialog](https://github.com/anomalyco/opencode/blob/v2.1.2/packages/tui/src/component/dialog-mcp.tsx) and [prompt submission fallthrough](https://github.com/anomalyco/opencode/blob/v2.1.2/packages/tui/src/component/prompt/index.tsx).
- [Pi 1.1.0 extension API](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/extensions.md), [MCP](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/mcp.md), [CLI/RPC loading options](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/cli.md) and [packages](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/packages.md).

Own plugin/generator/Skills code: **AGPL-3.0-only**, using the repository's confirmed license, bundled verbatim in each generated package. No third-party runtime is bundled; native clients remain independently installed/licensed. No repository, download or public service URL is invented. Source availability and the repository's separate third-party/public-release prerequisites still apply when distributing the full product. This first-party distribution is not a marketplace, SDK or arbitrary executable-plugin manager.
