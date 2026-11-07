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
