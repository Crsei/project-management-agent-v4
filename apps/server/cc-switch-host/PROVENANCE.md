# cc-switch host TypeScript translation

This package is a behavioral translation of the headless Rust host that previously
lived in `apps/server/cc-switch-host`.

## Upstream provenance

- Upstream project: <https://github.com/farion1231/cc-switch>
- Upstream version: `4.0.25`
- Upstream commit: `7afceec14b977ecc2f4373e8ffb40e7223b435ac`
- Upstream license: MIT, Copyright (c) 2025 Jason Young

The translation covers only the Rust modules that were reachable from the previous
headless `Cargo.toml`: the MCP/Skills management services, the twelve native
application adapters, the MCP/Skills DAOs, configuration-format helpers, and the
private JSON-lines host. It does not translate the cc-switch Tauri desktop
application, Provider account/subscription/proxy/cloud-sync features, or the
reference-only `.ref` native helpers.

Translated source is not claimed to be byte-identical upstream source. Each file
that contains translated behavior names its upstream source path in a header
comment. Behavior is checked against the frozen Rust host by the differential
fixtures under `tests/fixtures` and the Node integration tests.

## Update policy

Future upstream changes are applied only by an agent-driven review:

1. Resolve the target upstream commit and record it in this file before editing.
2. Compare the pinned commit with the target commit for the Rust paths listed in
   `UPSTREAM-SOURCES.md`.
3. Apply only behaviorally relevant changes to the TypeScript translation.
   Never copy a whole upstream tree into this package.
4. Update the source mapping and provenance record.
5. Run the differential/contract tests and the Agent extension integration tests.
   A change that only compiles is not accepted.
6. Update `THIRD_PARTY_NOTICES.md` and the package license notice when the
   upstream license or attribution changes.

The previous `vendor/cc-switch` Rust snapshot is not a runtime dependency and is
not required to build or start this package. Its `src-tauri` Rust source and
Cargo build were deleted after the translation; `vendor/cc-switch` now retains
only the reviewed React Web UI, MIT notice and the two shared provenance helper
scripts required by the OpenHands presentation. Complete removal of that UI
folder requires a separate Web/OpenHands ownership and provenance migration and
is not silently claimed here.

## Local bundled PM Skills adaptation

`src/skills/bundled.ts` is Dovspace-owned orchestration, not new upstream code.
It consumes only the Agent's private, catalog-validated byte payload and reuses
the translated cc-switch library, native layout, full-tree deployment hashing,
staged filesystem publication/rollback and uninstall-backup helpers. It does not
introduce a parallel Skill library, native root resolver or runtime dispatcher.

The same-pin changes in `src/host.ts`, `types.ts`, `constants.ts`,
`database/{index,skills}.ts` and `skills/{install,service,backup}.ts` add explicit
installed-source metadata (schema 3), retain it in backups, exclude builtins from
the GitHub updater, and protect bundled user edits across installation, updates,
toggle/resync/uninstall and backup restore. `updateManagedSkillFiles` is reused
with a final ownership recheck immediately before publication. The private
`inspect_bundled_skills` and `install_bundled_skills` IPC commands are not exposed
through the generic browser invoke allowlist.

`tests/bundled-skills.test.ts` covers real isolated-filesystem install/update,
Pi/OMP observations, assignment retention, full-tree conflicts, per-item failure,
metadata rollback and backup source retention. Agent route/provider tests are in
`apps/server/agent/src/extensions/bundled-skills.test.ts`. These additions do not
claim that a running native Provider loaded or can invoke the installed Skills.

