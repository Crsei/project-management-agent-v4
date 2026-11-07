# OpenHands presentation source maintenance

## Separate authorities

This is the selected real **Agent Canvas / OpenHands** presentation fork from
<https://github.com/OpenHands/OpenHands>, pinned at
`b4a3f45a28f6b6c387a8deb3dc7c18b4393c59c1`. It runs inside the existing CC Switch
Web host and uses CC Switch's Rust/native lifecycle. It is not a second Agent,
router, authentication system, settings database or cloud backend.

The independent [CC Switch maintenance ledger](../cc-switch/SYNC.md) remains the
authority for its original inputs and adaptations. OpenHands outputs must never
be enrolled as new CC Switch-owned files. Both tools share the existing exact
binary splice/path-safety primitives and TypeScript AST/resource scanner.
OpenHands imports CC capabilities only through `@pm/cc-switch-ui`, mapped to the
existing `vendor/cc-switch/src/web/index.tsx` public entry. The closure fingerprints
that independently owned entry; CC's own production closure follows its explicit
exports into the real implementations. Internal paths, relative bypasses and
public-alias substitutions are rejected, including type-only imports.

This replaces implementation-file fingerprint coupling, not functional reuse:
MCP/Skills controllers, management providers, authorized transport and portal
behavior still belong to CC and the PM host. Do not copy them or replace their
behavior with presentation-local substitutes. Both source generations and actual
runtime/legal assets remain production build requirements. The t3code Provider
ledger and unrelated `vendor/openhands-automations` remain independent and unchanged.

## Rebuilt MCP / Skills presentation

The operator-supplied `mcp-skill-page` rebuild supplies the Installed / Explore /
Config layout, horizontal MCP rows, Skill catalog, assignment matrices and
per-Agent drawers. These are local adaptations of the selected presentation,
not a new upstream pin or a runtime dependency on that sibling checkout.
Its demonstration localStorage, seeded assignments, simulated connectivity,
sync and OAuth flows are not copied. The host's existing scoped CC Switch
controllers own saves, serial bulk mutations, native imports and explicit probes.
Project theme tokens, responsive containers and existing accessible dialogs
remain authoritative for the integrated surface.

The setup-only entry shares this presentation frame without mounting a CC
management platform when no supported Provider exists. MCP exposes its public
catalog; Skills reports unread native data, and both link to Provider settings.
Saved Provider instances enter real management directly through the host's
registered-Provider resolver; internal context metadata is not a user consent step.

## Immutable input identities

`source-manifest.json` records the original selection, not the adapted outputs:

| Origin | Initial inputs | Evidence and replay source |
| --- | ---: | --- |
| `agent-canvas-git` | 169 | Selected paths, pinned commit, exact Git blob SHA-1, SHA-256, size and executable class; capture checks both the commit tree and read-only worktree |
| `agent-canvas-generated-locale` | 3 | Actual generated `en`, `zh-CN`, `zh-TW` inputs in `source-inputs/locales/`; no Git blob is asserted |
| `extensions-npm` | 88 | `@openhands/extensions@0.36.0`, registry tarball SHA-512 integrity, exact selected `integrations/**`, license and original package metadata |

The initial 260 records total 1,001,798 bytes. Those per-file records/hashes are
immutable. The parent corrected only the initial repository-URL typo to the
actual `OpenHands/OpenHands` repository before this policy pinned the manifest.
No compensating alternate metadata is used. Capture checks the real pinned Git
package metadata and both original license notices, not a guessed project URL.

An additional genuine source dependency must be copied **before adaptation** at
its unchanged upstream relative path. Enroll exact Git source/destination, blob,
SHA-256, byte count, canonical mode, `origin: agent-canvas-git` and review reason
in `supplemental-inputs.json`. Do not append or relabel the initial 260 records.
This ledger is initially empty. Its bytes become immutable for the captured
generation; a later addition requires a separately reviewed new generation,
not silent recapture of an existing generation. Source sibling repos are
read-only inputs; their credentials and runtime state are never consulted.

Capture embeds `source-inputs/blobs/<sha256>.bin` for every original and the exact
integrity-checked tarball as `source-inputs/extensions-0.36.0.tgz`. The tarball is
about 1.72 MB; it is source/reconstruction evidence, not a second installed npm
package. Tar decoding validates checksums, member paths, types, modes, selected
subtree completeness and package metadata. It does not execute extraction tools,
package scripts or archived code. Generated locale snapshots are never derived
from a Git command or attributed to the Git baseline.

## Explicit adaptation review

`fork-policy.json.reviewedAdaptations` lists only the exact source paths requested
by the MCP, Skills and shared-shell owners. `reviewedLocalOutputs` lists their
exact authored module paths and the local package adapter. A path in either
list is **not** approval of its current content. Initial changed originals and
new production modules each require `--accept-change PATH=SHA256`; new local
modules also require one `--allow-local PATH`. Add missing exact reviewed paths
to policy after coordinating with the actual owner; never enroll a directory,
regular expression, generated guess or blanket source tree.

The fixed toolkit, policy, manifests and legal documents are enrolled by the
tool itself under an explicit first-capture `--review`. Thereafter changes to
any enrolled output, policy or host build input require its exact current hash.
An unreviewed original adaptation, unknown local file, missing selected input,
unknown edit to an existing recipe/input archive, changed original mode or
concurrent source edit refuses capture before publication. There is no force
option. Only obsolete recipes already owned by the previous valid ledger are
removed after a successful reviewed capture; unknown files are preserved.
The sole generated-tree exception is the workspace package's `node_modules`;
it is neither copied, traversed, overwritten nor counted as a source output.

### 2026-11-08 reviewed Windows-build recipe repair

The host base `575c11bdca253e731b4121a1507159931a601af9` already removed
the retired cc-switch Rust-generation coupling from `scripts/web-build.mjs`.
Its parent bytes are exactly the existing local recipe's 11,555-byte payload,
`ce072ed76201fa940c20978ed06d48384941c05b26cf9f9836938f6c98bd3333`;
the committed/current script is 10,908 bytes,
`0d1349027428e4a7858c61fefee56bde322db9c7f22f706136e49ee1879b1a3a`,
already recorded in `output-inventory.json.files`. Only the local recipe still
reconstructs the parent. This is not a new Web production change.

The exact historical difference removes the CC `verifyOutputs` import, its
build-start/end calls and generation comparison, the
`ccSwitchOutputInventorySha256` marker field and its artifact comparison.
OpenHands source-generation checks, required actual modules, emitted-byte/legal
closure and the public-only `@pm/cc-switch-ui` boundary remain. The removed CC
inventory no longer exists after the same commit's TypeScript host cutover;
current host provenance is owned by
[`apps/server/cc-switch-host/PROVENANCE.md`](../../apps/server/cc-switch-host/PROVENANCE.md).
Recording this already committed script does not claim the retained CC UI has a
replacement independent full-tree ledger, restore that obsolete inventory or
weaken any current build check. The older dual-generation statements elsewhere
in this historical guide apply before that cutover, not to the current marker.

Local approval is restricted to that exact current script, this public record,
the necessary capture-tool change and its parent-only regression fixture.
The tool design adds
`capture.mjs --record-local --review --reason RATIONALE --accept-change PATH=SHA256`
with one exact approval per existing local output. It authenticates the recorded
input archives/recipes and unchanged generation/host inputs; refuses new paths,
original adaptations, mode changes, stale approvals, unapproved local-recipe
drift and production-closure changes; rewrites only approved local recipes and
their existing inventory bindings. No source checkout, installation, source
scripts, upstream pin change or full-tree capture is needed. Unrelated records
and recipes are preserved.

The ordinary capture path must also require an exact output approval when its
generated local asset or original adaptation recipe would differ from the prior
recipe, even if the inventory's output hash already matches. Narrow authoring
also replays every untouched original recipe against the authenticated archived
input and refuses disagreement rather than replacing it. Previously a local
recipe mismatch was silently regenerated by a capture for unrelated host
changes; that behavior is not an approval protocol. The narrow operation
deliberately accepts a recipe-only repair, but cannot turn an unrelated output
approval into permission for it.
Independent review additionally requires comparing both **presence and hash**:
creating a previously absent recipe, changing one, or returning an adapted
output to pristine bytes and removing its old recipe all need that output's
exact approval. An already pristine output binding is not permission to delete
a still-enrolled historical patch. A real ordinary-authoring consumer fixture
uses the explicitly supplied read-only pinned checkout
(`PM_OPENHANDS_AUTHORING_SOURCE`) and frozen tarball to prove that unapproved
removal leaves inventory/patches untouched, while the precise output approval
allows removal. Missing that fixture source is not a passing verification.
Parent integration must test rejection/preservation and exact offline replay,
then rebuild Agent/Web and verify the actual Windows artifact. This section is
design/review evidence, not a claim that authoring, tests or packaging passed.


## Parent-only final capture

Do not run capture, replay, builds, tests, linters or inventory collection while
source owners are writing. No final output hashes/recipes are supplied by the
implementation slice. Once all owners settle, inspect the exact adaptations,
review every added file and calculate approval hashes **then**. The authoring
command is:

```sh
node vendor/openhands-extensions/scripts/capture.mjs \
  --source /absolute/read-only/pinned-OpenHands \
  --extensions-tarball /absolute/verified/extensions-0.36.0.tgz \
  --review --reason 'Reviewed real Marketplace/Skills, Agent assignments and host/security cutover' \
  --allow-local vendor/openhands-extensions/package.json \
  --accept-change vendor/openhands-extensions/package.json=REVIEWED_CURRENT_SHA256
```

Extend this command with one `--allow-local` for each actually created path in
`reviewedLocalOutputs`, and one `--accept-change` for every changed original and
new local module. The policy is the exact owner-reviewed enrollment list, not a
wildcard scanner. SHA256 placeholders above are instructions for operator review,
not accepted values. Subsequent captures preserve identical bytes when inputs,
reasons and approvals are unchanged. Existing changed output errors identify the
exact approval flag required; never pipe a whole-tree scan straight into approvals.

Capture authors `output-inventory.json`, `resource-closure.json`, immutable input
artifacts and exact `integration-patches/**` recipes. Missing final ledgers are a
hard build/package gate, not a successful scaffold or permission to bypass it.
Capture is authoring and says nothing about functional acceptance.

Recommended integration order, after final source/dependency changes:

1. Build the existing isolated CC Switch CSS through its real source compiler;
   it now scans the authored OpenHands source too. This is a parent-only build.
2. Run reviewed OpenHands capture with final exact enrollment/hash approvals.
3. Recapture CC Switch with its existing command and exact approvals for changed
   outputs/build inputs; the OpenHands tree remains independently inventoried.
4. Refresh the existing t3code host-tool fingerprints because Agent packaging
   changed: use its documented `capture.py --source <pinned-t3code>` authoring
   flow (and import-ledger regeneration only if its inputs actually changed).
5. Run checks, then rebuild the matching native Agent and Web outputs. Capturing
   ledgers after an older build does not bless stale binaries or stale Web chunks.

## Fully offline replay

After capture, replay requires no sibling checkout, registry access, npm cache,
Git objects, network, package installation or source absolute path:

```sh
node vendor/openhands-extensions/scripts/sync.mjs --destination /new/host-root
node vendor/openhands-extensions/scripts/sync.mjs --destination /new/host-root
node vendor/openhands-extensions/scripts/sync.mjs --destination /new/host-root --check
node vendor/openhands-extensions/scripts/sync.mjs --destination . --check
node vendor/openhands-extensions/scripts/sync.mjs --destination /new/originals-root --pristine
node vendor/openhands-extensions/scripts/sync.mjs --destination /new/originals-root --pristine --check
```

Default mode reconstructs every selected original's final adapted/pristine
output, generated snapshot, authored integration, tooling, legal metadata,
recipes and original-input archives. `--pristine` reconstructs the original
selected file structure (including generated inputs identified as such), input
archives and immutable selection manifests; it does not claim the original
OpenHands application is independently runnable from this selected snapshot.

A clean replay creates only missing files with exclusive writes after complete
destination preflight. Exact repeats retain bytes/modes. Differing files,
unknown vendor files, symlinks, nonregular/hardlinked files, unsafe modes and
unsafe paths refuse before destination writes. Unrelated host files are not
owned, copied or deleted. Replay does not reproduce the entire PM host checkout:
production uses the matching host checkout/build inputs and the independent CC
Switch fork. The authoring toolkit itself imports the established CC Switch
primitives; that existing checked-in toolkit, not a sibling source checkout, is
a prerequisite when executing these tools from a replayed host.

Parent verification (not executed by this slice):

```sh
node --test vendor/openhands-extensions/scripts/provenance.test.mjs
node --test vendor/cc-switch/scripts/provenance.test.mjs
```

The parent must additionally exercise clean repeat/check, pristine-vs-adapted
hash distinction, unknown-file preservation/refusal, changed original/blob/mode,
changed npm integrity, changed generated input, changed patch and destination
conflict preflight in disposable roots. Static closure is not a Rust, TypeScript,
Web, security or native-client pass.

## Real runtime/assets/legal closure

`openHandsProvenancePlugin()` in `scripts/web-build.mjs` is a production-only
Vite plugin integrated into the existing Web build. Development is not blocked
on final capture. Production build start requires the exact reviewed source
generation. The plugin requires the actual OpenHands entry, MCP/Skills source
routes, static integrations registry and every selected catalog JSON in Rollup's
module graph. It records actual imported OpenHands modules; inlined icon/locale
assets are covered by final chunk hashes, and emitted assets retain their real
paths. It gathers license/notice files from the presentation's transitive runtime
imports, including CC Switch reuse, without claiming unrelated PM/Provider code.
Missing installed notices require an exact reviewed package/version/license entry
in `dependency-notices.json`; its actual upstream blob and SHA-256 are preserved
offline. The `react-remove-scroll-bar@2.3.8` npm package omits LICENSE; its entry
explicitly distinguishes the repository license blob from the inaccessible npm
gitHead. Unknown missing notices fail rather than receiving fabricated text.
It emits `licenses/openhands/**`, the imported CC Switch license/notices under
`licenses/cc-switch/`, and final on-disk hashes in `openhands-provenance.json`.
Both independent source generations are verified at build start/end and bound
into this marker; stale Web or CC Switch source generations are rejected.

`verifyWebDistribution(directory, root?)` verifies that marker, source generation,
emitted bytes and required legal assets. Agent packaging calls it when
`--web-dist` is supplied. Agent distribution always includes the independent
OpenHands source/patch/input/tooling/legal evidence under
`licenses/provenance/vendor/openhands-extensions/` and records source/Web
identities in `artifact-manifest.json.openHands`. Desktop staging verifies its
actual supplied Web output before deployment, carries the Web marker/notices
and uses the same Agent packager. No backup/native runtime behavior changed.

Parent packaging commands, using new disposable output paths:

```sh
pnpm build:agent
pnpm build:web
node apps/server/agent/scripts/package.mjs \
  --build apps/server/agent/dist --web-dist apps/web/dist \
  --output /new/agent-with-web
node /new/agent-with-web/tools/verify-artifact.mjs --artifact /new/agent-with-web
pnpm exec node apps/desktop/scripts/stage-workspace.mjs \
  --output /new/desktop-runtime \
  --agent-build /absolute/host/apps/server/agent/dist \
  --web-dist /absolute/host/apps/web/dist
```

The existing relocated Agent/native/desktop platform tests remain required.
These commands are not claimed executed, and artifact integrity is distinct
from browser behavior, native client acceptance, credentials/OAuth support or
release authorization.

## Reviewed upstream update procedure

Select and inspect a new commit/package version independently; retain the old
manifest, original archives, ledgers and a matching application backup. Review
upstream source/catalog/schema/license/dependency differences and genuine source
selection closure. Author a new immutable source-generation manifest/policy
with exact input facts, preserving the previous generation as evidence. Update
the tool's explicit pinned version/count/identity assertions only as a reviewed
upstream upgrade, never to make an unexplained mismatch pass. Reapply the exact
old adaptations against new preimages with manual conflict review, preserving
upstream relative paths. Re-enroll changed paths/reasons and explicit hash
approvals; generated locale origins remain generated. Capture in the new
reviewed generation, exercise offline repeated/pristine/conflict replay, close
actual Web dependency/assets/legal output, then run behavioral/security/native
regressions before atomically releasing matching Web/Agent/native artifacts.
Never pull over unknown local changes or silently accept fuzzy patches.
