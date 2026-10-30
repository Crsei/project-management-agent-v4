# Frozen Provider source synchronization

Source revision: `30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c` (MIT, T3 Tools Inc.). The upstream checkout is a read-only **input**, never a runtime dependency. No command here fetches upstream, installs dependencies, reads Provider credentials, calls a Provider, changes a service or replaces current Agent Chat persistence. PM authorization, revisions, approvals and receipts remain host-owned.

## Provenance inputs

- `source-manifest.json`: 959 exact upstream inputs, including 861 selected copies and 98 reference/reuse inputs. Original SHA-256, Git blob SHA-1, byte count and mode are immutable. Four UI reference files include their actual source hashes; `TraitsPicker.tsx` is not an unpinned reference.
- `sync-inventory.json`: exact output hashes, canonical Git-style creation modes and explicit input recipes, distinguishing `pristine-upstream`, `patched-upstream` and `local-addition`. Its `modePolicy` defines existing-file compatibility separately: matching hashes/executable classes retain ordinary read/write permissions, rather than comparing every POSIX permission bit. Selected server/client manifests and client `work-log/itemDetail.ts` are included. Original fourteen complete packages remain distinct from the selected client/server closures.
- `integration-patches/*.json`: deterministic zero-based line splices against original bytes. Each splice retains complete old/new lines; whole-file preimage and postimage hashes are required. There is no fuzzy matching and no duplicate full upstream source tree. JSON patch files themselves are hashed inputs.
- `sync-imports.json`: TypeScript AST inventory of actual selected/patched module imports, type imports, re-exports, literal dynamic imports, `createRequire` calls and static `import.meta.url` resources, plus selected package exports/types. PM host-boundary targets are not copied. Runtime-computed resource paths remain explicitly distinguishable from statically resolved files.
- `integration-patches.json` and family/import ledgers: adaptation rationale and historically observed parent evidence, not a substitute for M6 acceptance. The six Markdown dependencies retain their existing exact files, upstream external patches, npm release integrity and license provenance in `import-markdown-patches.json`; sync hashes those existing assets rather than introducing another copy.

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

The destination is the PM root, not `vendor/t3code`. Sync validates HEAD, every original input/reference hash/blob, every patch preimage/postimage/hash and every local asset **before** destination preflight. It refuses traversal, symlink/nonregular targets, wrong source identity and every destination hash/executable-class conflict. Modes follow a Git-style executable class: any POSIX execute bit (`mode & 0111`) marks a file executable. Ordinary read/write differences such as 0644 versus 0664 are accepted and left untouched; existing files are never chmodded. Setuid, setgid and sticky bits (`mode & 07000`) on regular files are unsafe and refused before any destination writes. Only absent, allowlisted `vendor/t3code/**` files are created exclusively with canonical 0644/0755 modes. There is no force/update/delete/overwrite mode. Unrelated PM paths are never enumerated for copying or deletion. A filesystem/permission failure during publication can leave newly created files; no existing file is overwritten. Do not concurrently mutate the input or destination trees.

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

Future upstream commits require a new reviewed pinned manifest and new exact patches. This same-commit tool deliberately does not guess upgrade merges or erase local changes.

After **reviewed intentional** same-commit changes, first update the selected source actions/ownership and explicitly allowlist any new local additions in `sync-inventory.json`. Then author deterministic snapshots without running Provider code:

```sh
python3 vendor/t3code/scripts/capture.py --source "$SOURCE"
node vendor/t3code/scripts/imports.mjs --write
python3 vendor/t3code/scripts/capture.py --source "$SOURCE"
```

`capture.py` validates the pinned commit and every immutable source/reference hash/blob before writing only patch recipes and the sync inventory. It refuses misclassified pristine/patched source actions and unallowlisted local paths; it never rewrites source manifests, host code or upstream files. The second capture binds the freshly authored import inventory. New upstream versions remain a separate review. Acceptance still requires the read-only commands above; recapture is not evidence that a behavior works.

## Independently runnable Agent artifact

The existing build bundles original source and ordinary dependency closure while keeping Effect/platform and the three disk-backed SDKs external. It now emits `build-inputs.json` describing **actual input hashes**, emitted externals and their original importer ownership. Packaging consumes this record, the frozen syntax inventory's opaque `createRequire` edges and the already installed, lockfile-pinned dependency graph; it does not run a package manager or build.

Parent commands, **unexecuted by T18**:

```sh
BUILD=$(mktemp -d /tmp/pm-agent-build-XXXXXX)
AGENT_BUILD_OUTDIR="$BUILD" node apps/server/agent/scripts/build.mjs
ARTIFACT_PARENT=$(mktemp -d /tmp/pm-agent-artifact-XXXXXX)
node apps/server/agent/scripts/package.mjs --build "$BUILD" --output "$ARTIFACT_PARENT/agent"
# To include an already built, ISOLATED Web output, add: --web-dist "$WEB_DIST"
```

`package.mjs` refuses an existing output directory and source drift after the recorded build. It copies complete production dependency packages, SDK webpack chunks/native/CLI/resources and actual installed optional native dependencies; no SDK resource subset is guessed. Original importer ownership resolves externals, including opaque Cursor SDK/SQLite and `@napi-rs/keyring` edges, before artifact-root links are created. Dependencies use artifact-relative internal links, with one canonical `effect@4.0.5` package; incompatible Effect versions or bundled Effect/unbundled PM/t3 source packages are rejected. Package output retains `apps/server/agent/dist` so `paths.ts` resolves `workspaceRoot` **inside the artifact**, independent of caller cwd. No source checkout, repository node_modules symlink or absolute dependency path is required. The graph is platform/architecture-specific; build/package separately on every supported native target.

`artifact-manifest.json` records all copied file hashes/modes, internal links, package versions/dependency edges, bundled ownership/license metadata and the canonical Effect location. Complete copied SDK packages retain their own notices; bundled dependency notices, the current lockfile, source/family ledgers, exact adaptation recipes and SPDX notices are under `licenses/`. This does not redistribute or install independently managed Provider CLIs/accounts. `tools/verify-artifact.mjs` is shipped with the artifact and uses only Node built-ins.

Move the entire `agent` directory to another temporary directory or machine with the same Node/native target and **without the PM repository/source checkout**. From an unrelated cwd, the parent may then run the emitted entry using an isolated data root and loopback ephemeral port:

```sh
RELOCATED_PARENT=$(mktemp -d /tmp/pm-agent-relocated-XXXXXX)
mv "$ARTIFACT_PARENT/agent" "$RELOCATED_PARENT/agent"
ARTIFACT="$RELOCATED_PARENT/agent"
# Parent-only acceptance: verifies hashes/links, SDK imports, actual Cursor disk SQLite,
# native PTY loading, one Effect identity, document worker, Claude history dispatch,
# and production HTTP /api/access. Uses disposable HOME/data and starts/stops only its own server.
node "$ARTIFACT/tools/verify-artifact.mjs" --artifact "$ARTIFACT"
DATA=$(mktemp -d /tmp/pm-agent-data-XXXXXX)
# Preserve the actual authorized native environment only when explicitly validating a Provider.
# This API-only packaging smoke does not authorize native inference or production credentials.
(cd /tmp && AGENT_WORKSPACE_DATA_DIR="$DATA" AGENT_WORKSPACE_PROJECT_ROOT="$ARTIFACT" \
  AGENT_WORKSPACE_API_ONLY=1 HOST=127.0.0.1 PORT=0 \
  node "$ARTIFACT/apps/server/agent/dist/index.mjs")
```

The included verifier is an unexecuted acceptance command, not pre-recorded success. It starts the emitted API from an unrelated temporary cwd with an explicitly empty native environment and checks the real `/api/access` response. It imports the pinned disk-backed SDKs and emitted Pi extension, opens/disposes a disposable Cursor SDK SQLite store, starts/closes the emitted Cursor IPC worker without opening an Agent, loads the native PTY binding, extracts real RTF text through the emitted document worker, and reads empty history through both production Claude entrypoints. No Provider generation/login/installation or Keychain credential read is requested. For a manual run, observe the random listener and stop only that owned process. Successful packaging alone is not SDK/native/runtime acceptance. Required PM environment/authorization configuration remains the existing host contract; do not import global credentials. No M6 or release gate is marked passed here. Current Chat records/history/journal remain the current design pending unified persistence work.
