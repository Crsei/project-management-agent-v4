# cc-switch source-fork synchronization

## Authority and scope

The immutable input is cc-switch **4.0.25**, commit
`7afceec14b977ecc2f4373e8ffb40e7223b435ac`, from
<https://github.com/farion1231/cc-switch>. `source-manifest.json` records the
selected original Git blobs, modes, byte counts and SHA-256 hashes. Its original
bytes are never recaptured, rewritten as adapted hashes, or shared with t3code's
independent ledger. `fork-policy.json` pins the original manifest SHA-256.

The selected snapshot retains upstream directory structure, including sources,
fixtures, tests and extension manuals. **Selection is not a claim that the entire
cc-switch desktop application ships or runs.** Production roots are the headless
Cargo crate and `src/web/index.tsx`; the Web host retains its own application,
React/Query runtimes and authorization. The Rust crate references the copied
business modules rather than loading a sibling checkout at runtime. Native
Provider sessions, t3code, PM policy, MCP OAuth and MCP Apps remain host-owned.

The newer default Marketplace/Skills presentation is an independent real
[OpenHands source fork](../openhands-extensions/SYNC.md). Its immutable
Git/generated-locale/npm inputs and exact adaptations have their own ledger.
OpenHands consumes this fork through the existing `@pm/cc-switch-ui` public Web
entry, not internal source paths. CC's production closure follows that entry's
explicit exports and owns their implementations; OpenHands fingerprints the
public boundary without recursively claiming those outputs. Keep the independent
fork guard and never enroll OpenHands files in this fork's `--allow-local` list.
Web packaging still verifies both source generations, assets and notices.
This is a public consumption boundary, not independent OpenHands runtime operation.

Registered application Providers now enter MCP/Skills configuration directly by
instance ID. The host resolves/reuses internal native ownership metadata; users
do not create or authorize a separate management context. Exact native roots,
revision checks, shared-root effects, existing libraries and active execution
protection remain authoritative. Explicit external-target enrollment is separate.

## Reviewed output ledgers

A maintainer capture creates these files; their absence is an intentional hard
build gate, not permission to bypass provenance:

| File | Contract |
| --- | --- |
| `output-inventory.json` | Every selected pristine/adapted upstream output and every explicitly enrolled local integration output; canonical mode, bytes, postimage hash, source/preimage identity, reason and recipe hash; host build-input fingerprints |
| `integration-patches/**` | Deterministic exact-byte splice recipes for adapted upstream files, or explicitly identified base64 assets for host-owned additions; never fuzzy patches or falsely attributed upstream code |
| `resource-closure.json` | Reachable Rust modules/includes/Cargo paths, TS/JS import/export/URL resources and CSS references; hashes of inputs and host boundaries; source-only snapshots separately listed |
| `upstream-tree.json` | The complete path list from `git ls-tree` at the pinned commit, used to distinguish tracked upstream manual references from missing source references; it does not copy those unselected files |

The generated closure is static evidence, **not a build, test, native-client or
security acceptance result**. External crate closure and legal resources are
captured again from locked, target-filtered Cargo metadata when building a native
binary. Existing Web and Agent emitted-import packaging remains authoritative for
external JavaScript package resources. Unreviewed computed local resources must
be described by exact source/expression/kind/target entries and rationale in
`fork-policy.json`; otherwise capture fails.

Rust parsing follows balanced modules, `#[path]`, `include!`, `include_str!`,
`include_bytes!`, literal `concat!(env!("CARGO_MANIFEST_DIR"), ...)`, Cargo local
paths and build scripts. Definitely disabled release/test feature branches are
source snapshots; OS/CPU branches are retained conservatively. Compiler-generated
resources that cannot be resolved statically require an explicit reviewed policy
entry and a real native build, never a guessed success.
Ordinary Rust literals use Rust escape/continuation and multiline rules rather
than JSON decoding. Lexical and unsupported-resource diagnostics include source,
line and column; lexer regressions include the real production Skills DAO query.

## Externally owned PM integration outputs

`fork-policy.json.externalHostOutputs` can identify only these eleven reviewed
host outputs. Their sole replay authority is
`vendor/t3code/mcp-skills-adaptations.json`; the list is also enforced in the
provenance helper, not chosen by a capture caller:

- `apps/server/agent/src/providers/t3code/management.ts`
- `packages/agent-contracts/src/provider.ts`
- `apps/server/agent/src/app.ts`
- `apps/server/agent/src/maintenance/agent-backup.test.ts`
- `apps/server/agent/src/maintenance/agent-backup.ts`
- `apps/server/agent/src/providers/skills.test.ts`
- `apps/server/pm/src/app.ts`
- `apps/web/src/features/agent/src/app.tsx`
- `apps/web/src/features/agent/src/chat/provider-skills-composer.tsx`
- `apps/web/src/features/agent/src/settings/settings-layout.tsx`
- `packages/agent-contracts/package.json`

The two existing Provider outputs remain upstream-derived. The Composer output
retains its five exact supplemental-source inputs; the other eight additions
are zero-input `local-integration` records with canonical `local-bytes` recipes.
Verification authenticates owner/source manifests and the distributed MIT license
against their registrations in the T3 inventory, including bytes, hashes and
modes. Every derived input must match its registered original production or
supplemental manifest. The current pins remain
`30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c` and
`d53873b6a4799e87afd63c8d288ef0089f5a3748`; modern owner validation follows
coherent registered generations rather than adding a fixed-pin gate. Legacy T3
replay pin guards are unchanged. Exact line-splice inversion and forward replay
authenticate the primary original and current output.
Local recipes must decode canonically to the exact current bytes/hash/size/mode.
Retired, duplicate, malformed, unregistered or conflicting replay owners fail.

CC keeps neither a second whole-file asset nor a frozen consumer hash. Owner
generations may advance independently with complete registered evidence; this
does not authorize a CC candidate to rewrite owner metadata, enroll other paths
or change pins. Existing Provider binding/Skills behavior and Agent/Web type
checks remain compatibility gates.

The initial reviewed transfer requires one
`--transfer-host-output PATH=OLD_ASSET_RECIPE_SHA256` per retired output, alongside
the exact approvals for changed policy/tool files. Capture authenticates each
unchanged old asset recipe, its unique prior enrollment, canonical bytes/mode and
current owner before retiring the duplicate recipes; output hashes cannot stand
in for old recipe hashes. Subsequent captures do not reenroll these paths, and
`--allow-local` cannot reclaim them. A clean CC-only replay manufactures neither
external files nor owner evidence. If any external output or owner evidence is
present, complete valid evidence is required before replay writes begin.


## Capture: an authoring operation, not a check

Only the integration owner runs capture **after all source writers settle**, the
headless `Cargo.lock` is generated/reviewed and the isolated CSS output is built.
Do not capture half-written peer changes. No final output ledger is produced by
the packaging slice itself.

```sh
node vendor/cc-switch/scripts/capture.mjs \
  --source /path/to/read-only-pinned-cc-switch \
  --review --reason 'Reviewed headless/Web/context/security adaptations' \
  --allow-local apps/server/cc-switch-host/Cargo.toml \
  --allow-local apps/server/cc-switch-host/Cargo.lock
```

The example is deliberately not an exhaustive enrollment list: add **one exact
`--allow-local` for every reviewed new/local output** in the headless crate,
`src/web/`, host bridge, routes/contracts, build/package/backup integration and
migration files. Selected original paths are inferred from the immutable
manifest and must never be enrolled as local replacements. Reviewed source
extractions are declared in `fork-policy.json.derivedOutputs`, not mislabeled as
new local implementations: the Codex MCP helper module is reconstructed from the
original `src-tauri/src/codex_config.rs` preimage with its own exact recipe and
extraction rationale. The fixed provenance toolkit, this document and
`LICENSING.md` are enrolled by the capture tool. Unknown vendor, headless-crate or
extension-host files cause an error naming the exact missing enrollment; there
is no recursive wildcard enrollment or `--force` option. Build caches (`target`,
vendor `node_modules`) are the only explicitly excluded vendor generated trees.

Subsequent edits to already reviewed outputs and host build inputs require their
exact current hash, not a broad approval flag:

```sh
node vendor/cc-switch/scripts/capture.mjs \
  --source /path/to/read-only-pinned-cc-switch \
  --review --reason 'Specific reviewed change and compatibility evidence' \
  --accept-change vendor/cc-switch/src/example.ts=EXACT_CURRENT_SHA256
```

Already-deleted, obsolete **host-owned local code** can be retired with
`--retire-local PATH=OLD_OUTPUT_SHA256`. Review all consumers first; the exact
previous inventory output hash and intact asset recipe are required. This never
deletes source files, cannot retire upstream/derived code, vendor/tooling outputs,
production roots, host build inputs or externally owned outputs, and conflicts
with enrollment/update approvals. Resource-closure verification still rejects
remaining imports reachable from its production roots; host consumers also need
their typecheck/build. Capture checks absence again before publication and removes
only the obsolete generated recipe and inventory enrollment; it does not restore
dead components or silently accept missing files.

Source commit, selected file set, original bytes/blob/modes, existing patch hashes,
output modes, local resource closure and concurrent edits are checked before
publication. Same-input captures preserve identical bytes. Original metadata
never changes. A new upstream commit requires a separately reviewed new immutable
manifest and policy; this tool refuses to silently upgrade an existing one.

## Replay and check

Run from the reviewed host checkout, with the upstream checkout read-only:

```sh
node vendor/cc-switch/scripts/sync.mjs \
  --source /path/to/read-only-pinned-cc-switch --destination /new/host-source-root
node vendor/cc-switch/scripts/sync.mjs \
  --source /path/to/read-only-pinned-cc-switch --destination . --check
```

Replay reconstructs every output from the fixed originals and exact recipes,
including the toolkit and ledgers. Host-owned integrations are explicitly labeled;
replay does not claim to recreate the unrelated host repository or install its
root package configuration. A buildable replay needs the matching host checkout
and its fingerprinted root build inputs. Existing identical files are retained;
missing files are created only with exclusive writes; any differing file,
unknown vendor file, symlink/nonregular file, special mode, changed original or
changed recipe fails before destination writes. There is no destructive update,
fuzzy application, overwrite, force, HOME fallback or sibling source discovery.

`node --test vendor/cc-switch/scripts/provenance.test.mjs` exercises exact binary
patching, unknown modifications, immutable identity and unsafe paths. The
integration owner runs it; this document does not claim it has run.

## Source-reference documentation is not product closure

Copied immutable upstream Markdown can refer to manuals/images not selected for
this module fork. `upstream-tree.json` records whether those targets really exist
at the pinned commit. `scripts/check-docs.mjs` permits an upstream-only reference
**only for a file whose current hash matches its original manifest hash and whose
target is tracked in that pinned tree**. It reports upstream-only links and
unchecked upstream anchors separately. Absent upstream targets remain errors.
Adapted/new Markdown, this SYNC document, licensing and all host documentation
retain normal local link/anchor checking; there is no blanket vendor suppression.
Production TS/Rust/CSS local resources never use this documentation exception.

## Native build and distribution

`apps/server/agent/scripts/cc-switch.mjs` exports `nativeTargets`, `nativeTarget`,
`buildSidecar(outputRoot)` and `verifySidecar(buildRoot, platform?, arch?)`.
`buildSidecar` requires finalized provenance and a real reviewed headless lockfile,
uses `cargo metadata --locked --filter-platform`, rejects GUI dependencies, then
runs `cargo build --locked --release --target` on the native runner. It stages:

```text
apps/server/agent/dist/cc-switch/<platform>-<arch>/
  cc-switch-host[.exe]
  native-manifest.json
  licenses/crates/...
  licenses/provenance/...
```

Supported package mappings:

| Runner | Rust target |
| --- | --- |
| Windows x64 | `x86_64-pc-windows-msvc` |
| macOS x64 | `x86_64-apple-darwin` |
| macOS arm64 | `aarch64-apple-darwin` |
| Linux x64 backend/verification | `x86_64-unknown-linux-gnu` |
| Linux arm64 backend/verification | `aarch64-unknown-linux-gnu` |

These are packaging mappings, **not native acceptance claims**. Unsupported or
mixed OS/CPU staging contents fail. There is no GUI sidecar, script substitute,
startup download, Cargo invocation at runtime or distributed `target`/source
checkout. The binary manifest records executable/resource hashes, lockfile and
source generation, compiler identity and production crate notices. Agent build
inputs pin the native manifest itself, so rewritten binaries/notices cannot be
silently accepted by repackaging. Agent packaging includes it in its normal hash
inventory; desktop staging requires the same native target and carries it through
native signing. Signed macOS binary hashes change under signing as with existing
Node/PostgreSQL runtime binaries: pre-sign provenance and final signature/archive
evidence are distinct.

Agent startup accepts only host-owned `CC_SWITCH_HOST_BINARY` or its packaged
module-relative binary. Desktop sets the exact packaged path; renderer/browser
requests cannot select executables. Source development fallback is a host concern,
not a packaged runtime dependency. The container copies Rust/Cargo only into its
build stage; final images retain the binary, notices and compiled Agent only.
Build-context test/source snapshots exist solely to validate provenance and do
not enter the final sidecar runtime.

Build prerequisites: existing Node/pnpm workspace and TypeScript, Cargo/Rust,
native C/C++ linker/toolchain, and the OS target SDK. Linux containers include
build-essential/pkg-config/CMake/CA certificates; Windows uses its MSVC SDK;
macOS uses its native SDK. No new JavaScript runtime package or auxiliary
`cargo-about` installation is required by these scripts. Crate license files are
read only from Cargo-resolved source packages, never user credential directories.

## Private backup and restore mapping

`pnpm agent:backup create --source <agent-data> --bundle <new-private-dir>
--secrets include --stopped` includes the whole owned `cc-switch` subtree together
with existing Agent data. `cc-switch/contexts/<id>/cc-switch.db` uses SQLite's
backup API (including WAL state), not a mismatched raw `.db`/WAL copy. The bundle
has private 0700/0600 permissions and member checksums; it is private data, not a
browser JSON export or inherently encrypted archive. Encrypt/seal and transfer it
with the existing offline operational backup policy. Never publish it as build
evidence or an artifact notice.

| Source | Portable treatment |
| --- | --- |
| `cc-switch/secret.key` | Native master key copied only with `--secrets include`, together with its matching encrypted databases; never logged |
| `cc-switch/contexts.json` | Context IDs and PM identity preserved; owned `provider-homes`/`cc-switch` binding paths—including explicit private `claudeMcpFile` in binding/providerBinding/external snapshots—become portable references; external paths stay references; missing Claude file authority is never inferred from directory names |
| `cc-switch/contexts/<id>/` | SQLite, settings, owned Skills/master copies, backups and owned private Home/files retained |
| Provider-owned Skills symlinks to owned master copies | Recorded as validated link metadata without following external trees; restored as links to the relocated owned target |
| `PM_AUTOMATION_INTEGRATIONS_KEY` | Not read/exported by backup; restore matching protected deployment configuration with the matching PM database backup |
| External native roots and external target registry file | Not scanned/copied/re-authorized; restore operator must separately re-register them |

`--secrets exclude` omits the entire `cc-switch` subtree as one unit, including
ciphertext, key, registry and private Skills/backups. It cannot leave an unusable
partial credential snapshot or accept a forged extension-key member on restore.
Both modes remain private because Agent histories/attachments are private.

Restore requires a separate empty target and matching old/new build/data versions,
never overwrites the source, relocates owned binding/providerBinding/external
snapshots, and **blanks native binding fingerprints**. Those fingerprints attest
live Provider revisions and physical roots, not portable path strings. Opening a
registered Provider's management page revalidates its current registered roots
before use; external targets still require explicit re-enrollment. Resolution
and restore never resync native files. External paths are not followed. Windows symlink
restore requires permission to create the original link kind. Stop the owning
Agent and its child sidecars first; `--stopped` is an operator attestation and the
existing Agent lock/owner checks remain enforced. Roll back only by stopping the
new owner and restoring the matching build, PM database/deployment key and private
Agent snapshot; never attach an old program to an upgraded live database.

## Release evidence still required

The integration owner must run deterministic capture/replay/check, Rust and Web
builds, provenance/backup/desktop regressions, temporary-root MCP/Skills behavior,
private-data backup/restore and native OS/CPU packaging/signing checks. Source
hashes, static closure, a successful compilation and actual native-client loading
are different evidence categories. No command or platform is recorded as passed
merely because its script or target mapping is present.
