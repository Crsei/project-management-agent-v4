# Upstream source mapping

Pinned upstream: `farion1231/cc-switch` `4.0.25`, commit
`7afceec14b977ecc2f4373e8ffb40e7223b435ac`, MIT.

This table is the review ledger for the TypeScript translation. It lists the
Rust modules that were reachable from the previous headless
`apps/server/cc-switch-host/Cargo.toml`, and where their behavior now lives.
Modules not listed here (for example the Tauri desktop app, provider account
management, proxy server, subscriptions, pricing, WebDAV/S3 and the `.ref`
native helpers) are outside the translation.

| Upstream Rust source | TypeScript target | Notes |
| --- | --- | --- |
| `src-tauri/src/app_config.rs` | `src/types.ts` | `AppType`, `McpServer`, `McpApps`, `SkillApps`, installed-skill shape |
| `src-tauri/src/config.rs` | `src/config/atomic.ts`, `src/config/paths.ts` | atomic/private writes, sort, native path helpers |
| `src-tauri/src/error.rs` | `src/errors.ts` | finite public error codes |
| `src-tauri/src/prompt.rs` | `src/types.ts` | prompt type only; prompt feature is not exposed by the headless host |
| `src-tauri/src/provider.rs` | `src/types.ts` | shared provider/config enums only; provider switching is not translated |
| `src-tauri/src/jsonc_document.rs` | `src/config/jsonc.ts` | format-preserving JSONC/JSON5 editing |
| `src-tauri/src/claude_mcp.rs` | `src/mcp/adapters/claude.ts` | Claude MCP file handling |
| `src-tauri/src/gemini_mcp.rs` | `src/mcp/adapters/gemini.ts` | Gemini MCP normalization |
| `src-tauri/src/codex_mcp_config.rs` | `src/config/paths.ts`, `src/mcp/adapters/codex.ts` | Codex config path/validation |
| `src-tauri/src/claude_mcp.rs` | `src/mcp/adapters/claude.ts` | duplicate upstream path intentionally kept for review clarity |
| `src-tauri/src/gemini_config.rs` | `src/config/paths.ts`, `src/mcp/adapters/gemini.ts` | Gemini path/env/validation subset |
| `src-tauri/src/grok_config.rs` | `src/config/paths.ts`, `src/mcp/adapters/grokbuild.ts` | Grok config validation/model subset |
| `src-tauri/src/hermes_config.rs` | `src/config/paths.ts`, `src/mcp/adapters/hermes.ts` | Hermes config path and YAML section handling |
| `src-tauri/src/opencode_config.rs` | `src/config/paths.ts`, `src/config/jsonc.ts`, `src/mcp/adapters/opencode.ts` | OpenCode JSONC path/format conversion |
| `src-tauri/src/mcode_config.rs` | `src/config/paths.ts`, `src/mcp/adapters/mcode.ts` | MCode paths and MCP JSON subset |
| `src-tauri/src/kimi_config.rs` | `src/config/paths.ts`, `src/mcp/adapters/kimi.ts` | Kimi paths and MCP JSON subset |
| `src-tauri/src/dsh_config.rs` | `src/config/paths.ts`, `src/mcp/adapters/dsh.ts` | DSH profiles, plugin entries, YAML guards |
| `src-tauri/src/omp_config.rs` | `src/config/paths.ts`, `src/mcp/adapters/omp.ts` | OMP paths and MCP JSON |
| `src-tauri/src/pi_config/mod.rs` | `src/config/paths.ts`, `src/mcp/adapters/pi.ts`, `src/skills/deploy.ts` | Pi paths, transport helpers, Pi Skill deployment |
| `src-tauri/src/mcp/mod.rs` | `src/mcp/adapters/index.ts` | adapter registry |
| `src-tauri/src/mcp/validation.rs` | `src/mcp/validation.ts` | server spec validation and transport inference |
| `src-tauri/src/mcp/overrides.rs` | `src/mcp/overrides.ts` | native option patch merge |
| `src-tauri/src/mcp/snapshot.rs` | `src/mcp/snapshot.ts` | read-only native snapshots, sync state |
| `src-tauri/src/mcp/claude.rs` | `src/mcp/adapters/claude.ts` | adapter |
| `src-tauri/src/mcp/codex.rs` | `src/mcp/adapters/codex.ts` | adapter |
| `src-tauri/src/mcp/gemini.rs` | `src/mcp/adapters/gemini.ts` | adapter |
| `src-tauri/src/mcp/grokbuild.rs` | `src/mcp/adapters/grokbuild.ts` | adapter |
| `src-tauri/src/mcp/opencode.rs` | `src/mcp/adapters/opencode.ts` | adapter |
| `src-tauri/src/mcp/hermes.rs` | `src/mcp/adapters/hermes.ts` | adapter |
| `src-tauri/src/mcp/pi.rs` | `src/mcp/adapters/pi.ts` | adapter |
| `src-tauri/src/mcp/omp.rs` | `src/mcp/adapters/omp.ts` | adapter |
| `src-tauri/src/mcp/agy.rs` | `src/mcp/adapters/agy.ts` | adapter |
| `src-tauri/src/mcp/kimi.rs` | `src/mcp/adapters/kimi.ts` | adapter |
| `src-tauri/src/mcp/mcode.rs` | `src/mcp/adapters/mcode.ts` | adapter |
| `src-tauri/src/mcp/dsh.rs` | `src/mcp/adapters/dsh.ts` | adapter |
| `src-tauri/src/database/dao/mcp.rs` | `src/database/mcp.ts` | encrypted MCP definitions and assignments |
| `src-tauri/src/database/dao/skills.rs` | `src/database/skills.ts` | Skills and repository DAO |
| `src-tauri/src/database/dao/settings.rs` | `src/database/settings.ts` | key/value settings DAO |
| `src-tauri/src/services/mcp.rs` | `src/mcp/service.ts` | MCP definition/assignment/resync orchestration |
| `src-tauri/src/services/skill.rs` | `src/skills/*` | Skills SSOT, install, discovery, backup, ZIP, migration |
| `src-tauri/src/services/mcp_connectivity.rs` | `src/mcp/connectivity.ts` | MCP initialize probes |
| `src-tauri/src/proxy/http_client.rs` | `src/skills/network.ts` | outbound download client/proxy behavior subset |
| `apps/server/cc-switch-host/src/main.rs` | `src/main.ts` | JSON-lines process loop |
| `apps/server/cc-switch-host/src/protocol.rs` | `src/host.ts` | command dispatch and result shapes |
| `apps/server/cc-switch-host/src/host_context.rs` | `src/host-context.ts` | path authority and context validation |
| `apps/server/cc-switch-host/src/secret_codec.rs` | `src/secret-codec.ts` | AES-256-GCM envelope and AAD |
| `apps/server/cc-switch-host/src/database.rs` | `src/database/index.ts` | schema versioning, lock, initialization |
| `apps/server/cc-switch-host/src/database/mcp_assignments.rs` | `src/database/mcp.ts` | override assignment/import transactions |
| `apps/server/cc-switch-host/src/mcp_management.rs` | `src/mcp/management.ts` | management snapshot, import preview/apply |
| `apps/server/cc-switch-host/src/settings.rs` | `src/settings.ts` | management settings |
| `apps/server/cc-switch-host/src/store.rs` | `src/host.ts` | per-context state and serialized operations |
| `apps/server/cc-switch-host/src/services.rs` | `src/mcp/service.ts`, `src/skills/service.ts` | service assembly |
| `apps/server/cc-switch-host/src/proxy.rs` | `src/skills/network.ts` | HTTP client initialization subset |
| `apps/server/cc-switch-host/src/lib.rs` | `src/host.ts` | module assembly/production boundary |

## Translation rules

1. Behavior is derived from the pinned Rust source; file paths and public
   command/result shapes remain compatible.
2. A TypeScript file that contains translated behavior has a top header naming
   the Rust source path.
3. When upstream changes, update only the affected TypeScript modules and this
   table. Do not copy the upstream Rust tree into this package.
4. Run the differential fixtures and Agent integration tests before accepting an
   upstream update.
5. The previous Rust crate is retained only as a review/reference artifact until
   the cutover evidence is complete; it is not a runtime dependency.

## Host-native discovery adaptation (same upstream pin)

`src/skills/paths.ts`, `scan.ts`, `import.ts`, and `service.ts` retain the copied
cc-switch scanner/importer. Host binding filters exclude unbound fallback roots;
read-only scanning resolves SSOT paths without creating them and observes the
bound native Home's existing `.agents/skills` independently of managed storage.
The host-only `scan_native_skills` command (`src/host.ts`) projects the same scan
into native-only entries with a library-index `managed` flag. It does not imply
runtime loading, import, native deployment, or Unified write ownership. The
existing `scan_unmanaged_skills` import-candidate command remains distinct.

The same-pin host import boundary in `src/skills/import.ts` uses the local
`inspectSkillImportTree` adaptation in `src/skills/fs.ts`; it does not change the
legacy upstream deployment-copy helper or public command shapes. The adaptation
pins the selected root, materializes verified internal aliases, and rejects
escaping/cyclic descendants and unrecognized Windows reparse points before
adoption. Regular-file descriptor identity/stamps are checked while copying into
private staging and the source is rechecked before publication. Existing managed
destinations are independently checked against SSOT before source-repository
bookkeeping is saved. The host reuses the existing local
`packages/pm-core/windows-reparse.ts` and `private-path.ts` helpers; no upstream
source pin, npm dependency, native Home ownership, or Unified write authority is
added by this safety adaptation.
