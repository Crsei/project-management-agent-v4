# OpenHands extension presentation licensing

## Original notices retained verbatim

| Selected source | Pinned identity | Notice retained |
| --- | --- | --- |
| OpenHands Agent Canvas presentation | `b4a3f45a28f6b6c387a8deb3dc7c18b4393c59c1`, <https://github.com/OpenHands/OpenHands> | [LICENSE](LICENSE): MIT, `Copyright © 2025 OpenHands contributors` |
| Static integrations registry | `@openhands/extensions@0.36.0`, <https://github.com/OpenHands/extensions> | [extensions/LICENSE](extensions/LICENSE): MIT, `Copyright (c) 2025 OpenHands` |

The actual copied notices were read; neither is replaced by a paraphrase.
Original npm package metadata remains at
[extensions/source-package.json](extensions/source-package.json), separately
from the local fork's authored workspace package adapter. The registry tarball
URL and full SHA-512 integrity are in
[source-manifest.json](source-manifest.json). Capture verifies package version,
repository/license metadata, all selected npm bytes and original notice hashes
against that integrity-checked archive.

Agent Canvas is the product/package name, not evidence for a different GitHub
repository. The read-only source `package.json.repository.url` and README's
repository/action/issue links identify `https://github.com/OpenHands/OpenHands`.
The parent corrected the initial manifest's repository URL typo before this
fork policy pinned its bytes. None of the original 260 file SHA-256/blob/mode
records were changed by that metadata correction. The capture implementation
also checks the actual package metadata at the pinned Git commit.

## Generated inputs are not Git-baseline claims

The three actual generated language inputs retain their separate immutable
snapshots under `source-inputs/locales/`. Their origins and SHA-256/byte counts
are recorded as `agent-canvas-generated-locale`, without invented Git blobs.
They are source-derived translation resources from the supplied Agent Canvas
copy and retain its MIT attribution; no claim is made that these generated
files were tracked at the pinned Git commit. Updated/generated translations
require their own reviewed input generation and license review.

## Distribution and dependency scope

The selected source keeps original paths, real static registry/catalog JSON,
icons and original notices. Necessary changes and authored host adapters are
identified in the separate output inventory and exact replay recipes; they are
not falsely represented as unchanged upstream files. The CC Switch and t3code
license ledgers remain independent. No source hashes, copyright statements or
license files are repurposed from those other forks.

The production Web plugin retains this document, both original licenses, npm
metadata and source/output ledgers under `licenses/openhands/`. It also collects
shipped legal files for the actual dependency packages whose modules entered
the real Web bundle, preserving package name/version/license metadata and exact
notice hashes. That installed-module evidence is not a declaration that every
package's own license metadata is legally sufficient; unresolved/restrictive
license terms still require release review. Missing shipped notices fail the
closure rather than silently producing an empty success.

Catalog `logoUrl`, documentation URLs, names and trademarks are descriptive
upstream metadata. They are not additional copyright/trademark grants and this
fork does not fetch or claim to redistribute external logo bytes merely because
a URL occurs in JSON. Imported local source icons and emitted/inlined resources
are covered by source/module and emitted-file hashes; independently hosted
assets must retain their own availability/rights policy.

Agent packaging includes complete OpenHands provenance, recipes, immutable
original-input artifacts and tooling under
`licenses/provenance/vendor/openhands-extensions/`; optional bundled Web output
and desktop staging retain the Web-specific notices and matching generation
marker. The npm input archive is reconstruction/legal evidence, not a second
runtime npm installation. No new native binary, deployment secret, credentials,
Provider account data or backup format is introduced by this presentation fork.

## Verification status

These legal/source facts and the implementation contract do not constitute a
build, test, replay, dependency-license audit or release approval. The
implementation slice intentionally did not run final captures or checks while
source owners were active. The parent must capture the final reviewed fork,
verify clean/offline repeat and refusal behavior, build actual Web/Agent output,
inspect packaged legal assets, and complete platform/browser/native acceptance.
See [SYNC.md](SYNC.md) for exact authoring, replay and packaging operations.
