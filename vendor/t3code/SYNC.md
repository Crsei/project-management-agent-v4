# Frozen Provider source synchronization

Source revision: `30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c` (MIT, T3 Tools Inc.). The upstream checkout is a read-only **input**, never a runtime dependency. No command here fetches upstream, installs dependencies, reads Provider credentials, calls a Provider, changes a service or replaces current Agent Chat persistence. PM authorization, revisions, approvals and receipts remain host-owned.

## Provenance inputs

- `source-manifest.json`: 959 exact upstream inputs, including 861 selected copies and 98 reference/reuse inputs. Original SHA-256, Git blob SHA-1, byte count and mode are immutable. Four UI reference files include their actual source hashes; `TraitsPicker.tsx` is not an unpinned reference.
- `sync-inventory.json`: exact output hashes, canonical Git-style creation modes and explicit input recipes, distinguishing `pristine-upstream`, `patched-upstream` and `local-addition`. Its `modePolicy` defines existing-file compatibility separately: matching hashes/executable classes retain ordinary read/write permissions, rather than comparing every POSIX permission bit. Selected server/client manifests and client `work-log/itemDetail.ts` are included. Original fourteen complete packages remain distinct from the selected client/server closures.
- `integration-patches/*.json`: deterministic zero-based line splices against original bytes. Each splice retains complete old/new lines; whole-file preimage and postimage hashes are required. There is no fuzzy matching and no duplicate full upstream source tree. JSON patch files themselves are hashed inputs.
- `sync-imports.json`: TypeScript AST inventory of actual selected/patched module imports, type imports, re-exports, literal dynamic imports, `createRequire` calls and static `import.meta.url` resources, plus selected package exports/types. PM host-boundary targets are not copied. Runtime-computed resource paths remain explicitly distinguishable from statically resolved files.
- `integration-patches.json` and family/import ledgers: adaptation rationale and historically observed parent evidence, not a substitute for M6 acceptance. The six Markdown dependencies retain their existing exact files, upstream external patches, npm release integrity and license provenance in `import-markdown-patches.json`; sync hashes those existing assets rather than introducing another copy.
- `runtimeResources.hostBuildInputs`: exact build, package, shipped verifier and shared validator fingerprints. Sync/build/package check all required entries and regular contained files before publishing; build also records this verified toolchain, and packaging rejects output built with different or missing tool fingerprints.

The reasoning constant extraction preserves the exact original `threadExecution.ts:148–154` declaration and its surrounding local provenance comments. The settings-field extraction is traceable to the original `ProviderSettingsForm.tsx`; neither pulls the foreign thread/orchestrator or React tree into the browser-safe package.

## Offline reconstruction and refusal

Run from the PM repository root. `SOURCE` is any **local** Git checkout at the pinned revision; the example path from a developer workstation is not required.

```sh
SOURCE=/absolute/path/to/read-only/pinned-t3code
DEST=/absolute/path/to/new-or-current-pm-root
node vendor/t3code/scripts/sync.mjs --source "$SOURCE" --destination "$DEST"
node vendor/t3code/scripts/sync.mjs --source "$SOURCE" --destination "$DEST"
node vendor/t3code/scripts/sync.mjs --source "$SOURCE" --destination "$DEST" --check
```

The destination is the PM root, not `vendor/t3code`. Sync validates HEAD, every original input/reference hash/blob, every patch preimage/postimage/hash and every local asset **before** destination preflight. It refuses traversal, symlink/nonregular targets, wrong source identity and every destination hash/executable-class conflict. Modes follow a Git-style executable class: any POSIX execute bit (`mode & 0111`) marks a file executable. Ordinary read/write differences such as 0644 versus 0664 are accepted and left untouched; existing files are never chmodded. Setuid, setgid and sticky bits (`mode & 07000`) on regular files are unsafe and refused before any destination writes. Only absent, allowlisted vendor and supplemental MCP/Skills host files are created exclusively with canonical 0644/0755 modes. There is no force/update/delete/overwrite mode. Unrelated PM paths are never enumerated for copying or deletion. A filesystem/permission failure during publication can leave newly created files; no existing file is overwritten. Do not concurrently mutate the input or destination trees.

For a separate pristine reconstruction of just the selected original inputs (without PM additions or patches):

```sh
node vendor/t3code/scripts/sync.mjs --source "$SOURCE" --destination /new/pristine-root --pristine
node vendor/t3code/scripts/sync.mjs --source "$SOURCE" --destination /new/pristine-root --pristine --check
```

Parent acceptance, **not executed by T18**:

```sh
node vendor/t3code/scripts/verify-sync.mjs --source "$SOURCE"
node vendor/t3code/scripts/imports.mjs --check
```

The first command uses disposable roots and a local no-hardlink Git clone. It exercises clean offline reconstruction, exact repeat-no-diff, pristine and patched hash distinction, preservation of an unrelated PM sentinel, destination-conflict refusal before any missing file is created, wrong source hash/commit and patch hash refusal, and symlink refusal. POSIX permission fixtures explicitly change a reconstructed non-executable file from 0644 to 0664 and assert sync/check preserve its hash, mode, inode, modification and metadata-change timestamps. Changing its executable class or setting any of setuid/setgid/sticky must refuse before a deliberately missing file can be created. The harness never edits the designated upstream checkout or chmods repository files. The import command checks the frozen actual syntax inventory and refuses unresolved local/workspace closure. `imports.mjs --write` is a deliberate maintainer recapture operation: review changes first, then recapture corresponding sync hashes/patches; never use it to bless unexplained drift.

Host-tool fixtures copy the recorded tooling into a disposable source root, prove its baseline sync succeeds, then alter each tool independently and require rejection before any destination exists. This checks drift, not just the presence of descriptive hashes. Reconstruction owns `vendor/t3code/**` and the explicit MCP/Skills host output allowlist described below; it never overwrites existing PM files or copies unlisted host scripts.

Future upstream commits require a new reviewed pinned manifest and new exact patches. This same-commit tool deliberately does not guess upgrade merges or erase local changes.

After **reviewed intentional** same-commit changes, first update the selected source actions/ownership and explicitly allowlist any new local additions in `sync-inventory.json`. Then author deterministic snapshots without running Provider code:

```sh
python3 vendor/t3code/scripts/capture.py --source "$SOURCE"
node vendor/t3code/scripts/imports.mjs --write
python3 vendor/t3code/scripts/capture.py --source "$SOURCE"
```

`capture.py` validates the pinned commit and every immutable source/reference hash/blob before writing patch recipes and the sync inventory. By default it refuses misclassified pristine/patched source actions and unallowlisted local paths; explicit `--review-actions` permits updating only copy dispositions, preserving original source identity fields. It never rewrites host code or upstream files. The second capture binds the freshly authored import inventory. New upstream versions remain a separate review. Acceptance still requires the read-only commands above; recapture is not evidence that a behavior works.

New host tool/configuration paths require explicit enrollment with `capture.py --allow-host-input PATH` (repeat for each reviewed path). The build validator requires `scripts/doctor.mjs`, `.node-version`, `rust-toolchain.toml` and root `package.json` in addition to the existing build/package/verifier tools. For this cutover, add those four exact flags to the first capture above; no hand-written or placeholder hashes are needed. Subsequent captures refresh the enrolled paths without new flags. Do not enroll unrelated dirty files.

## MCP / Skills dual-source adaptations (T13)

The MCP/Skills source snapshot is pinned separately at `d53873b6a4799e87afd63c8d288ef0089f5a3748`. The production baseline remains the newer `30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c`; neither its original hashes/blobs/bytes/modes nor the immutable `.ref` source bytes are rewritten. The full `mcp-skills-source.json` inventory records the copied original tree and its point-in-time baseline comparison, not continuously updated production hashes.

`mcp-skills-adaptations.json` supplements—not replaces—that source inventory:

- Each source-derived host adapter/new vendor module names every original input commit/path, SHA-256, Git blob, size and mode, its adaptation reason, final output hash/mode, and MIT notice coverage. Recipes apply exact zero-based original-line splices against the first mapped input. Other mapped inputs are independently checked derivation references. A host adapter can include PM-owned integration without being mislabeled entirely local or pristine upstream.
- Genuinely local integration is separately classified and recorded as exact embedded bytes. Existing upstream vendor files continue using the baseline `integration-patches/` recipes; new adapted vendor modules use supplemental recipes, not the local-asset escape hatch.
- `sync.mjs` reads both commits from a **local Git object database** and checks all source/license/recipe/output identities before destination preflight. Supplemental host outputs are explicitly allowlisted, included in the same no-overwrite conflict transaction, and omitted by `--pristine`. No recipe imports or executes `.ref`, source checkout code, credentials, or a foreign application.
- The AST import inventory includes mapped host adaptations and rejects literal absolute, `file:` and `.ref` source imports. It still distinguishes unselected PM host boundaries and computed native resources.

One disposable authoring checkout used for this integration is `/tmp/pm-t3code-t13-30eb-local`, created entirely offline:

```sh
git clone --shared --no-checkout /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/t3code /tmp/pm-t3code-t13-30eb-local
git -C /tmp/pm-t3code-t13-30eb-local checkout --detach 30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c
```

That temporary checkout may share read-only Git objects with its local origin; it is not shipped or required at runtime. Any offline checkout containing both commits and checked out at `30eb...` is equivalent. Parent reconstruction acceptance should use its own independent local clone if it needs to demonstrate object-store independence.

After all feature owners release their outputs, reviewed metadata authoring is:

```sh
SOURCE=/tmp/pm-t3code-t13-30eb-local
# Repeat --accept-output for EACH changed active output after reviewing its bytes.
# Omit approval flags for unchanged outputs; hashes here are not auto-approvals.
python3 vendor/t3code/scripts/capture-mcp-skills.py --source "$SOURCE" \
  --accept-output REVIEWED_OUTPUT_PATH=REVIEWED_CURRENT_SHA256
python3 vendor/t3code/scripts/capture.py --source "$SOURCE" --review-actions
node vendor/t3code/scripts/imports.mjs --write
python3 vendor/t3code/scripts/capture.py --source "$SOURCE"
```

`--review-actions` authorizes only copy-verbatim/copy-then-patch disposition changes; original source fields remain unchanged. `--allow-local vendor/t3code/<path>` explicitly enrolls a reviewed new local metadata/implementation asset. Never use it for an upstream adaptation: add that module's exact source mapping to the supplemental manifest instead. Recapture after any integration/build-tool edits; it is authoring, not verification. Parent runs `imports.mjs --check`, `verify-sync.mjs --source "$SOURCE"`, independent packaging and relocated artifact acceptance.

### Explicit retirement and granular authoring

The supplemental author refuses blanket recapture: every changed non-retired
output needs its own `--accept-output PATH=CURRENT_SHA256`. Unknown, duplicate,
stale/unnecessary or wrong-hash approvals fail; executable-class changes need
separate review. With unchanged active outputs, the original `--source`-only
invocation is byte- and timestamp-preserving. All prior source commits, MIT
identities and each original SHA-256/blob/byte-count/mode are validated against
Git objects, and every old recipe is replayed before any authoring. Original
identity fields are never refreshed from a different source.
The prior ledger must also match its exact hash/byte-count binding in the existing
baseline inventory; hand-deleting rows or pre-editing retirement/recipe metadata
cannot evade explicit authoring. Only the supplemental ledger is published, after
all validations succeed. Then the separately reviewed baseline capture binds that
new ledger before any repeat authoring; no flag bypasses this ordering.

An intentionally removed host component must stay absent, not be restored to
satisfy a ledger. Request each reviewed retirement with both exact preimage and
explicit rationale:

```sh
python3 vendor/t3code/scripts/capture-mcp-skills.py --source "$SOURCE" \
  --retire-output HOST_OUTPUT_PATH=RECORDED_OLD_OUTPUT_SHA256 \
  --retirement-reason 'HOST_OUTPUT_PATH=Specific reviewed removal rationale' \
  --accept-output CHANGED_SURVIVING_OUTPUT=REVIEWED_CURRENT_SHA256
```

The existing `outputs[]` record remains authoritative and retains its complete
old source mapping, original reason/license, exact recipe, output hash, byte count
and mode. Only `retirement: { "sha256": "...", "reason": "..." }` is added; its
hash must equal that retained output preimage. There is no deletion-only second
ledger, hand-deleted row, source-pin change or fuzzy replay. Requests fail for an
existing target (including unsafe ancestors/symlinks), wrong hash, missing reason,
unknown/duplicate/already-retired target, conflicting acceptance, incomplete old
identity/recipe or surviving static consumers. The existing TypeScript import
authority scans host/vendor/script sources, including non-ledger consumers, and
resolves relative imports, actual tsconfig aliases and package exports against
virtual retired paths. Computed native resources remain explicitly separate
review obligations; static provenance does not prove arbitrary runtime strings.
Rejection happens before ledger publication, including rejection of unapproved
drift elsewhere in the same invocation.

Retired records are structurally checked by imports/source gates and their full
old recipes/inputs are still verified by offline Git replay. They are excluded
from active import ownership and reconstruction, and both authoring and replay
refuse a reappearing target. Replay also refuses a stale import-inventory edge
to/from a retired output before destination writes. `--pristine` remains original
source-only reconstruction, not a host retirement/migration operation. The
immutable original source manifest and supplemental snapshot inventory do not
change. After authoring, regenerate imports and recapture the existing baseline
inventory with the sequence above; do not use stale tool fingerprints.

Parent-only isolated author/replay fixtures (not run by the implementation
worker):

```sh
node vendor/t3code/scripts/verify-mcp-skills-authoring.mjs --source "$SOURCE"
node vendor/t3code/scripts/verify-sync.mjs --source "$SOURCE"
node vendor/t3code/scripts/imports.mjs --check
```

The new fixture script must be explicitly enrolled, after parent tool review,
with `capture.py --allow-local vendor/t3code/scripts/verify-mcp-skills-authoring.mjs`
on the first baseline capture. Its enrollment is not a claim that it was run.

The first uses disposable host roots and read-only Git objects to cover malformed
old identities/recipes/retirement records, existing targets, exact preimages,
duplicate/unknown requests, missing rationale, relative/alias live consumers,
granular drift approval, no writes on rejection, unchanged determinism and
source-derived/local retirement replay. The maintained `scripts/upstream-sync`
candidate authoring protocol is unchanged: this same-pin retirement operation
does not claim modern candidate retirement support or waive its dirty/identity
checks.


Distribution includes the existing MIT `LICENSE`, both source/adaptation manifests, baseline ledgers/recipes/import inventory and complete `vendor/t3code/scripts/` under artifact provenance. Package metadata must include these files without `.ref`, source `.git`, absolute checkout paths as dependencies, or a second executable t3code tree. Host build-tool fingerprints—including package-script changes—are refreshed by the final baseline capture. No build, tests, lint, formatter or reconstruction acceptance is implied by capture.

The final integration allowlist also records the host runtime startup/shutdown fixture, expanded durable HTTP error contract, and Agent contracts/client-runtime package wiring as `local-integration`. Claude lifecycle fixtures remain in the baseline `ClaudeAdapterV2.test.ts` patch; execution drain fixtures remain in the separately mapped host `execution.test.ts`. Their current bytes are captured without claiming the local lifecycle changes originated upstream.

Intentional exclusions from the supplemental host reconstruction allowlist:

- Build/package scripts are bound by `runtimeResources.hostBuildInputs`, not duplicated as supplemental source-derived outputs. Package-script changes require baseline recapture and a fresh parent build.
- The root lockfile is distributed by packaging with dependency/license evidence; it is not a source-adaptation recipe or an independently reconstructed host implementation.
- Unrelated PM document-source, graph, notice-center and shared Web styling work remains host-owned and is not enrolled merely because it is dirty. In particular, `chat/output-timeline.css` contains unrelated link styling; MCP App styling is separately mapped in `chat/mcp-app-frame.css`.
- Root documentation, acceptance evidence and temporary browser/HTTP fixtures are not executable adaptation outputs. The immutable source snapshot inventory remains a point-in-time record; current hashes belong to the baseline and supplemental output ledgers.

### 2026-11-08 Windows delivery provenance repair

This is a same-pin metadata repair, not an upstream update or permission to
recapture a dirty tree. The host base is
`575c11bdca253e731b4121a1507159931a601af9`. Read-only Git objects show that
`thread.aui.tsx`'s embedded local bytes are exactly that commit's parent version:
39,481 bytes / `c965bde33ab696ffc0ebe4c0d8049ceb572f1686390270d500c9ddec51906875`.
The committed/current output is 39,560 bytes /
`8b69fdcd2d7c1ba3052af852efdfc6ac5c25bce32ed7ade4f0aa501d16105321`.
The complete difference is the already committed switch from
`useProviderSkillsComposer` / `nativeSkills` to `useComposerSuggestions` /
`suggestions`, and the bilingual placeholder describing `@` files, `$` skills
and `/` commands. Form submission, direct steer, history blocking, usage command,
IME, keyboard and disabled-state wiring retain their respective guard positions.
This approves only recording those exact existing host bytes; it neither changes
Web behavior nor certifies the replacement hook's runtime/security acceptance.

The same host commit also changed these existing outputs; their old embedded
bytes equal the host parent exactly. Separate local review now permits recording
each listed current hash, not regenerating all dirty outputs:

| Output | Old bytes / SHA256 | Current bytes / SHA256 | Actual existing behavior |
| --- | --- | --- | --- |
| `apps/web/src/features/agent/src/pm/chat-surface.tsx` | 63,618 / `d9c9e78d39ea7b20e80ae42aa69fbd185582af42a98b870bfa5f3019391a33b1` | 73,104 / `378584b599fc16b405c686bdcf12e0239f0efebfcee5d789979da12834a30bd6` | Collapsible folder/session groups, compact times, folder filtering/new-session target selection, Provider/model labels and existing shared session actions; terminal receives only its controller. No PM authorization, execution resolution or persistence implementation changes are authored here. |
| `packages/agent-client-runtime/src/provider-skills.ts` | 5,616 / `221e413b277f1c1fffe809a24eaee3f3d1d95fef1cad8853d40f64993e47d813` | 5,650 / `ffd65fe1908b7f6edbc25c9eb62666af6cfe60d237d323273676cc08cf1c5549` | Adds the existing `serializeComposerFileLink` re-export; original trigger/token/ranking ownership remains in the shared source module. |

The same commit deleted `chat/provider-skills-composer.tsx` (15,524 bytes /
`ff5b4e46e63ac6bb78f48932994739e334e6cba0d0d10d74a5eb21e5c2fcccf0`)
and `chat/provider-skills.css` (1,359 bytes /
`5366635e19cf8843b64a5c4339763dabb0ddd0782d0cc09e4e38161b0059d00c`).
Their exact existing records are retired with the granular protocol: preserve
all old inputs/recipes/modes/rationale and require absent targets/no consumers,
not deletion of history or restoration of dead code.

Replacement modules in that commit have actual upstream derivation, not merely
a host directory location. `chat/composer-suggestions.tsx` (24,661 bytes /
`1347dc75018e5730c4dc351260184a2c8850b8ff1cc554516324866c855114bb`)
retains the old composer's five supplemental inputs and names two additional
already inventoried references: `packages/shared/src/composerTrigger.ts` and
`apps/web/src/components/chat/ComposerCommandMenu.tsx`, both at the unchanged
`d53873b6a4799e87afd63c8d288ef0089f5a3748` snapshot. Its native catalog TTL,
instance/revision/cwd binding, stale-selection send guards and IME lifecycle
remain around the PM transport; its added file menu uses session-scoped
inspector search and existing shared file-link serialization.
`chat/composer-command-menu.tsx` (5,728 bytes /
`1a17916d97d449b9e16dbce9a3dd62927482140af53da9e9b3b555e3a743f70a`)
derives its trigger labels, Skill-source icon/label tables, item presentation,
selection/hover/mousedown and scrolling semantics from that original menu
(8,979 bytes / `7103a425dc0af46931e230ce3cbc488e4ce69e61727f57248d9ee51c57bc7967`).
Neither copies the upstream router, command backend, PR/thread menu or account
state. `chat/composer-suggestions.css` (2,625 bytes /
`d040eb2ce464e3b2640cb40053b95fa3698f5de9ad6d10d99b31f874373084a5`)
is local host-token layout/presentation, not a separately copied upstream CSS
file; record it as zero-input local integration. No production file is changed.

Necessary mapping authoring uses one `capture-mcp-skills.py --add-output
REVIEW_JSON` per new output, together with that output's exact `--accept-output`.
Each review contains only `destination`, explicit `inputs: [{commit,path}]`,
`reason` and `license`. The tool resolves full input identities from the already
bound frozen inventories, authenticates Git blobs and replays the proposed
recipes before publication. Unknown identities, duplicate/existing destinations,
implicit outputs and missing/stale hash approvals fail. Review JSON is transient
input, not a second source/version database; authoritative recipes remain in the
existing supplemental ledger. Import generation follows the reviewed cutover.

The repair design adds a narrow baseline binding operation:
`capture.py --source "$SOURCE" --accept-local PATH=CURRENT_SHA256` (repeat for
each reviewed **existing** local asset). It rejects unknown/duplicate/stale
approvals, source/patch outputs, mode changes and enrollment/full-capture flags.
It authenticates the frozen source inputs and changes only those exact existing
inventory hash/byte bindings; unrelated outputs, recipes, host fingerprints and
the immutable manifest remain untouched. The supplemental ledger must first be
authored with its own exact output/retirement approvals. This operation is not a
way to edit that ledger by hand or bless unreviewed content.

Independent boundary review identified that `local-addition` is a storage
classification, not permission to re-author an immutable source authority.
The existing `vendor/t3code/source-manifest.json`,
`vendor/t3code/mcp-skills-source.json` and `vendor/t3code/omp-source.json`
are explicitly forbidden `--accept-local` targets, even when the real baseline
registers them as local assets. Otherwise rebinding the supplemental registry
could expand the inputs later admitted by `--add-output` without a source review.
The narrow operation must reject these exact authority paths before changing
any inventory binding. Its consumer fixture copies the actual inventory
classification, attempts an exact-hash registry mutation alongside a valid
mutable approval, and requires refusal with no inventory publication.
This hardening does not authorize changing any registry, input selection or pin.

The approved baseline bindings are the resulting reviewed supplemental/import
ledgers, this public design record and the narrowly changed authoring tools and
their parent-only regression fixtures.
Host fingerprints remain the final enrolled tool bytes shared with OpenHands;
desktop release-only tools outside the enrolled set do not expand it implicitly.
The prior external-Claude-CLI exclusion, full communication SDK/native resources,
PM authorization/revisions/approvals/receipts, native Provider Home/environment
and current Chat persistence remain unchanged. Parent-only source/import/replay,
build, artifact and native Windows checks are still required after integration;
authoring is not verification, and session/persistence design remains open.



## Independently runnable Agent artifact

The existing build bundles original source and ordinary dependency closure while keeping Effect/platform and the three disk-backed SDKs external. It now emits `build-inputs.json` describing **actual input hashes**, emitted externals and their original importer ownership. Packaging consumes this record, the frozen syntax inventory's opaque `createRequire` edges and the already installed, lockfile-pinned dependency graph; it does not run a package manager or build.

The build runs the read-only `scripts/doctor.mjs` preflight and validates host-tool provenance before deleting its normal output directory. Doctor checks exact Node/pnpm and effective Rust/Cargo versions from the native crate's working directory, plus the platform C/C++ compiler/linker tools; it neither installs tools nor reads application configuration or services. The root `rust-toolchain.toml` controls host builds; the vendored cc-switch toolchain file remains an upstream snapshot, not an ancestor of the host crate. Intentional tooling updates require reviewed recapture and a fresh build; changing only the inventory after an older build cannot make that output current. The packager refuses missing/stale `hostBuildInputs` in `build-inputs.json` before creating its destination.

Commands for parent integration (source-copy workers do not run builds or acceptance checks):

```sh
BUILD=$(mktemp -d /tmp/pm-agent-build-XXXXXX)
AGENT_BUILD_OUTDIR="$BUILD" node apps/server/agent/scripts/build.mjs
ARTIFACT_PARENT=$(mktemp -d /tmp/pm-agent-artifact-XXXXXX)
node apps/server/agent/scripts/package.mjs --build "$BUILD" --output "$ARTIFACT_PARENT/agent"
# To include an already built, ISOLATED Web output, add: --web-dist "$WEB_DIST"
```

`package.mjs` refuses an existing output directory and source drift after the recorded build. It copies complete production dependency packages, SDK chunks/manifests/resources and actual installed optional native dependencies, except the `@anthropic-ai/claude-agent-sdk-*` package family: those packages contain the external Claude CLI, not SDK transport resources. The reviewed `external-agent-packages.mjs` boundary excludes that family from SDK dependency collection, refuses other attempts to include it, and checks final artifact package identities; it never deletes an arbitrary file named `claude` or `claude.exe`. The SDK itself and all its resources remain intact. Desktop's independent root/Electron `pnpm deploy` closures and container deploy closures use the same identity-based pruning, including physical pnpm store packages and their aliases. Cursor SDK's native tools/SQLite, keyring and PTY resources remain unchanged. Original importer ownership resolves externals, including opaque Cursor SDK/SQLite and `@napi-rs/keyring` edges, before artifact-root links are created. Dependencies use artifact-relative internal links, with one canonical `effect@4.0.5` package; incompatible Effect versions or bundled Effect/unbundled PM/t3 source packages are rejected. Package output retains `apps/server/agent/dist` so `paths.ts` resolves `workspaceRoot` **inside the artifact**, independent of caller cwd. No source checkout, repository node_modules symlink or absolute dependency path is required. The graph is platform/architecture-specific; build/package separately on every supported native target.

`artifact-manifest.json` records all copied file hashes/modes, internal links, package versions/dependency edges, bundled ownership/license metadata and the canonical Effect location. Complete copied SDK packages retain their own notices; bundled dependency notices, the current lockfile, source/family ledgers, exact adaptation recipes and SPDX notices are under `licenses/`. This does not redistribute or install independently managed Provider CLIs/accounts. `tools/verify-artifact.mjs` is shipped with the artifact and uses only Node built-ins.

Development installations may still contain Claude's optional platform packages from the frozen lockfile; development dependency presence is not permission to ship them. Claude production execution and capability/usage probes already pass the configured external executable explicitly. Native Home/environment, PM authorization, revisions, approvals and receipts, Codex/Antigravity managed installation, ACP Registry installation semantics and current Chat persistence are unchanged. Cursor remains a local Agent SDK engine, not an external Cursor CLI wrapper.

Move the entire `agent` directory to another temporary directory or machine with the same Node/native target and **without the PM repository/source checkout**. From an unrelated cwd, the parent may then run the emitted entry using an isolated data root and loopback ephemeral port:

```sh
RELOCATED_PARENT=$(mktemp -d /tmp/pm-agent-relocated-XXXXXX)
mv "$ARTIFACT_PARENT/agent" "$RELOCATED_PARENT/agent"
ARTIFACT="$RELOCATED_PARENT/agent"
# Parent-only acceptance: verifies hashes/links, SDK imports, actual Cursor disk SQLite,
# native PTY loading, one Effect identity, document worker, Claude history dispatch,
# and production HTTP /api/access. Uses disposable HOME/data and starts/stops only its own server.
# Also checks external Claude initialization/missing-path failure with a controlled
# temporary CLI and no model prompt, plus absence of Claude platform CLI packages.
node "$ARTIFACT/tools/verify-artifact.mjs" --artifact "$ARTIFACT"
DATA=$(mktemp -d /tmp/pm-agent-data-XXXXXX)
# Preserve the actual authorized native environment only when explicitly validating a Provider.
# This API-only packaging smoke does not authorize native inference or production credentials.
(cd /tmp && AGENT_WORKSPACE_DATA_DIR="$DATA" AGENT_WORKSPACE_PROJECT_ROOT="$ARTIFACT" \
  AGENT_WORKSPACE_API_ONLY=1 HOST=127.0.0.1 PORT=0 \
  node "$ARTIFACT/apps/server/agent/dist/index.mjs")
```

Historical parent acceptance results and remaining release gates are kept in an internal evidence ledger retained locally, not a public build dependency. The verifier starts the emitted API from an unrelated temporary cwd with an explicitly empty native environment and checks the real `/api/access` response. It imports the pinned disk-backed SDKs and emitted Pi extension, opens/disposes a disposable Cursor SDK SQLite store, starts/closes the emitted Cursor IPC worker without opening an Agent, loads the native PTY binding, extracts real RTF text through the emitted document worker, and reads empty history through both production Claude entrypoints. No Provider generation/login/installation or Keychain credential read is requested. For a manual run, observe the random listener and stop only that owned process. Successful packaging alone is not SDK/native/runtime acceptance. Required PM environment/authorization configuration remains the existing host contract; do not import global credentials. No M6 or release gate is marked passed here. Current Chat records/history/journal remain the current design pending unified persistence work.
