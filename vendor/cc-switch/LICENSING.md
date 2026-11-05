# cc-switch fork licensing and distribution

## Upstream grant retained verbatim

Source: <https://github.com/farion1231/cc-switch>, version 4.0.25, commit
`7afceec14b977ecc2f4373e8ffb40e7223b435ac`.

The copied `LICENSE` contains the **MIT License**, Copyright (c) **2025 Jason
Young**. It remains byte-for-byte part of the original source manifest. The
copyright and permission notice must accompany copies or substantial portions of
the selected software. Local headless/Web/transport/security patches do not erase
that attribution or turn original cc-switch code into host-authored source.

This is a selected source fork, not the entire cc-switch desktop distribution.
Tauri GUI/account/tray resources are not a runtime requirement of the selected
headless crate. Original uncompiled snapshot files and manual references are
identified separately in the resource ledger; their presence is not a dependency
or feature-support claim.

## What native artifacts retain

Agent native staging places these alongside the actual `cc-switch-host` binary:

- The exact upstream MIT notice and this licensing document.
- Source-manifest identity, reviewed output/resource inventories, pinned upstream
  path tree, exact integration recipes and reconstruction tooling as provenance.
  These are attribution/rebuild inputs, not runtime imports or a full copy of
  unrelated pristine desktop source.
- Production Cargo dependency names, versions, declared license expressions,
  available repository/source metadata and hashes of their license/NOTICE files.
- Compiler/target identity, Cargo.lock hash, native binary/resource checksums and
  the exact reviewed output generation from which the executable was built.

`apps/server/agent/scripts/cc-switch.mjs` traverses the target-filtered locked
Cargo graph from its root without dev-only edges, rejects GUI dependencies,
collects crate-shipped LICENSE/COPYING/NOTICE/COPYRIGHT material (including legal
subdirectories and explicit Cargo `license_file`), and refuses missing declarations
or missing legal texts. For crates shipping only SPDX declarations it uses the
existing repository's reviewed SPDX 3.28.0 texts; unknown identifiers fail closed
until their real notice is supplied. It does not invent attribution, silently omit
a dependency, invoke an uninstalled license generator, or fetch notices at startup.

Native crate inventories are produced on the actual target runner, not fabricated
from another platform's build. A target mapping or empty license directory is not
legal-resource closure. Cargo.lock and generated native/license manifests remain
reviewable release inputs/evidence; absent manifests block packaging.

## JavaScript/Web and other retained runtimes

The existing Agent artifact packager collects emitted-import dependency licenses,
bundled package notices, disk SDK resources and t3code's separate provenance. The
adapted `@pm/cc-switch-ui` package retains version/license and pinned original
source attribution. Desktop staging also invokes its existing Web/desktop notices
collector. The newly staged binary contributes its own native and cc-switch MIT
notice closure. Node, PostgreSQL, Electron, t3code, SDKs and any other retained
components keep their own notices and existing licensing duties; this file is not
a replacement for their inventories.

No root package/lock ownership or license has been rewritten by this packaging
slice. The integration owner must retain Web notice output as well as Agent/native
notices in the final combined distribution and verify native signing/archives
without dropping legal resources.

## Private data is never a notice

`cc-switch/secret.key`, context registries, SQLite databases, native configs,
project private Headers, Skills user content, offline backup bundles and deployment
keys are **not source provenance or license inputs**. Build and packaging scripts
do not inspect them or include them in legal artifacts. A secret-inclusive offline
backup remains private data, not a distributable source/license archive. See
`SYNC.md` for the portable private-data/restore boundary.

## Upgrade review

For every separately authorized upstream update, review the upstream license,
retained dependency lockfiles, additions/removals and shipped legal resources as
well as code conflicts. Preserve original notices and exact adaptation reasons.
MIT permission does not waive dependency-specific notice obligations, authorize
credential disclosure, or prove that any native platform/package was tested.
