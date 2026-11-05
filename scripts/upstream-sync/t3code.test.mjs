import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadProfile, recordGeneration, verifyGeneration } from "./t3code.mjs";

const oldPin = "1".repeat(40), nextPin = "2".repeat(40), supplementalPin = "3".repeat(40);
const base = "vendor/t3code/";
const hash = value => createHash("sha256").update(value).digest("hex");
const blob = value => createHash("sha1").update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest("hex");
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const splitLines = value => value.toString().match(/[^\n]*\n|[^\n]+$/g) ?? [];
const input = (commit, name, value) => ({ commit, path: name, sha256: hash(value), bytes: Buffer.byteLength(value), gitBlobSha1: blob(value), gitMode: "100644" });
async function put(root, name, value) {
  const file = path.join(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value);
}
async function get(root, name) { return JSON.parse(await readFile(path.join(root, name))); }

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "t3-generation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = new Map([
    ["LICENSE", "MIT fixture license\n"],
    ["packages/contracts/package.json", json({ name: "@t3tools/contracts", exports: { ".": "./src/index.ts" }, dependencies: {} })],
    ["packages/contracts/src/index.ts", "export const upstream = 1;\n"],
    ["packages/contracts/src/ref.ts", "export const reference = 1;\n"],
    ["packages/contracts/src/drop.ts", "export const removable = true;\n"],
    ["apps/server/package.json", json({ name: "fixture-selected-server", exports: {}, dependencies: {} })],
    ["apps/server/src/selected.ts", "export const selected = true;\n"],
    ["apps/server/src/reference.ts", "export const referenceOnly = true;\n"],
  ]);
  if (options.extraction) old.set("apps/web/src/settings.ts", "export const field = 1;\n");
  if (options.dependencyUpdate) {
    old.set("pnpm-workspace.yaml", "catalog:\n  left-pad: 1.0.0\n");
    old.set("pnpm-lock.yaml", "lockfileVersion: '9.0'\n---\nlockfileVersion: '9.0'\nimporters:\n  packages/contracts:\n    dependencies: {}\npackages: {}\nsnapshots: {}\n");
  }
  const next = new Map(old);
  next.set("packages/contracts/src/index.ts", options.nextText ?? "export const upstream = 2;\n");
  if (options.secondaryChanged) next.set("packages/contracts/src/ref.ts", "export const reference = 2;\n");
  if (options.addition) next.set("packages/contracts/src/new.ts", "export const addition = 3;\n");
  if (options.deletion) next.delete("packages/contracts/src/drop.ts");
  if (options.targetFiles) for (const [name, value] of Object.entries(options.targetFiles)) next.set(name, value);
  if (options.dependencyUpdate) {
    next.set("packages/contracts/package.json", json({ name: "@t3tools/contracts", exports: { ".": "./src/index.ts" }, dependencies: { "left-pad": "catalog:" } }));
    next.set("pnpm-lock.yaml", "lockfileVersion: '9.0'\n---\nlockfileVersion: '9.0'\nimporters:\n  packages/contracts:\n    dependencies:\n      left-pad:\n        specifier: 'catalog:'\n        version: 1.0.0\npackages:\n  left-pad@1.0.0:\n    resolution:\n      integrity: sha512-fixture\n  tiny-dependency@2.0.0:\n    resolution:\n      integrity: sha512-transitive-fixture\nsnapshots:\n  left-pad@1.0.0:\n    dependencies:\n      tiny-dependency: 2.0.0\n  tiny-dependency@2.0.0: {}\n");
  }
  if (options.extraction) next.set("apps/web/src/settings.ts", "// moved declaration\nexport const field = 2;\n");
  // An unrelated tracked template must be listable, but never read or selected.
  next.set(".env.example", "not an input and must not be read\n");
  next.set("apps/web/src/never-selected.ts", "throw new Error('must not execute');\n");
  const supplement = new Map([["LICENSE", old.get("LICENSE")], ["apps/web/src/mcp.ts", "export const originalMcp = true;\n"]]);
  const repos = new Map([[oldPin, old], [nextPin, next], [supplementalPin, supplement]]);
  const reads = [];
  const readBlob = async (commit, name) => {
    reads.push(`${commit}:${name}`);
    const value = repos.get(commit)?.get(name);
    if (value === undefined) throw new Error(`Missing object: ${commit}:${name}`);
    assert.notEqual(name, ".env.example", "unselected credential template must not be read");
    return Buffer.from(value);
  };
  const listTree = async commit => [...repos.get(commit)].map(([name, value]) => ({ path: name, mode: "100644", blob: blob(value), type: "blob" }));
  const isReference = name => name.endsWith("/reference.ts") || name.startsWith("pnpm-") || name === "apps/web/src/settings.ts";
  const files = [...old].map(([name, value]) => ({ source_path: name, destination_path: isReference(name) ? null : `${base}${name}`, sha256: hash(value), git_blob_sha1: blob(value), git_mode: "100644", bytes: Buffer.byteLength(value), action: isReference(name) ? "reference-only" : name.endsWith("/index.ts") ? "copy-then-patch" : "copy-verbatim", category: "fixture", owner: "fixture", role: "runtime-or-build-input" }));
  if (options.editedDeletion) files.find(entry => entry.source_path === "packages/contracts/src/drop.ts").action = "copy-then-patch";
  const manifest = {
    manifest_version: 1, upstream: { commit: oldPin },
    packages: [
      { root: "packages/contracts", name: "@t3tools/contracts", scope: "complete-package", files: [...old.keys()].filter(name => name.startsWith("packages/contracts/")), dependencies: [] },
      { root: "apps/server", name: "fixture-selected-server", scope: "selected-sources-only", dependencies: [] },
    ],
    files, imports: [], summary: {}, implementation_inventory: { family_ledgers: [] },
    consumer_slices: [{ owner: "fixture", copy_paths: files.filter(entry => entry.action.startsWith("copy")).map(entry => entry.source_path), reference_paths: ["apps/server/src/reference.ts"] }],
    adapter_boundaries: [], runtime_resources: { static_source_resource_edges: [] },
  };
  if (options.dependencyUpdate) manifest.external_lock_closure = { source_path: "pnpm-lock.yaml", yaml_document_index: 1, snapshots: [] };
  const derivedName = "apps/server/agent/src/mcp-derived.ts";
  const derivedImports = [
    ...(options.adaptationPackages ? ['import "@agent-workspace/contracts";', 'import "@agent-workspace/client-runtime";'] : []),
    ...(options.derivedImport ? [`import ${JSON.stringify(options.derivedImport)};`] : []),
  ];
  const derivedBytes = Buffer.from([
    ...derivedImports,
    ...(options.resources ?? []).map((entry, index) => `export const resource${index} = new URL(${JSON.stringify(entry.specifier)}, import.meta.url);`),
    "export const adaptedMcp = true;",
  ].join("\n") + "\n");
  const adaptations = {
    version: 1, baselineCommit: oldPin, baselineInventory: `${base}sync-inventory.json`, sourceInventory: `${base}mcp-skills-source.json`, policy: {},
    sources: [supplementalPin, oldPin].map(commit => ({ commit, role: "fixture", license: { spdx: "MIT", path: "LICENSE", sha256: hash(old.get("LICENSE")), distributedPath: `${base}LICENSE` } })),
    outputs: [{ destination: derivedName, provenance: "adapted-upstream", reason: "Multi-input fixture with an independent supplemental primary", inputs: [input(supplementalPin, "apps/web/src/mcp.ts", supplement.get("apps/web/src/mcp.ts")), input(oldPin, "packages/contracts/src/ref.ts", old.get("packages/contracts/src/ref.ts"))], sha256: hash(derivedBytes), bytes: derivedBytes.length, mode: 0o644, recipe: { kind: "exact-line-splices", primaryInput: 0, splices: [{ start: 0, before: splitLines(supplement.get("apps/web/src/mcp.ts")), after: splitLines(derivedBytes) }] } }],
  };
  const adaptationPackages = [];
  if (options.adaptationPackages) for (const [directory, name] of [["agent-contracts", "@agent-workspace/contracts"], ["agent-client-runtime", "@agent-workspace/client-runtime"]]) {
    const destination = `packages/${directory}/package.json`;
    const bytes = json({ name, exports: { ".": "./dist/index.js" }, types: "./dist/index.d.ts" });
    adaptationPackages.push({ directory, destination, bytes });
    adaptations.outputs.push({ destination, provenance: "local-integration", reason: "PM-owned package metadata, not a vendored workspace package", inputs: [], sha256: hash(bytes), bytes: bytes.length, mode: 0o644, recipe: { kind: "local-bytes", base64: bytes.toString("base64") } });
  }
  const supplemental = { version: 1, upstream: { commit: supplementalPin, existingVendorCommit: oldPin }, files: [...supplement].map(([name, value]) => ({ path: name, mode: "100644", blob: blob(value), bytes: Buffer.byteLength(value), sha256: hash(value) })) };
  const imports = {
    version: 1, upstreamCommit: oldPin, adaptationCommits: [supplementalPin, oldPin], parser: "fixture-before-generation",
    scope: "Fixture exact actual import/resource graph", packages: [],
    edges: (options.resources ?? []).map((entry, index) => ({
      source: derivedName, line: derivedImports.length + index + 1, specifier: entry.specifier,
      kind: "import-meta-resource", usage: "runtime", disposition: entry.disposition, target: entry.target,
    })),
  };
  if (options.generation !== undefined) manifest.generation = options.generation;
  const manifestBytes = json(manifest);
  await put(root, `${base}source-manifest.json`, manifestBytes);
  await put(root, `${base}mcp-skills-adaptations.json`, json(adaptations));
  await put(root, `${base}mcp-skills-source.json`, json(supplemental));
  await put(root, `${base}sync-imports.json`, json(imports));
  await put(root, `${base}omp-source.json`, json({ classification: "Local OMP, never t3code", commit: "4".repeat(40) }));
  await put(root, `${base}integration-patches.json`, json({ reason: "Fixture accepted host adaptation" }));
  await put(root, `${base}packages/provider-omp/src/server.ts`, "export const localOmp = true;\n");
  await put(root, derivedName, derivedBytes);
  await put(root, "apps/server/agent/scripts/build.mjs", "// fingerprint fixture only; never executed\n");
  if (options.extraction) await put(root, `${base}packages/client-runtime/src/extracted.ts`, "// host annotation\nexport const field = 1;\n");
  for (const entry of adaptationPackages) {
    await put(root, entry.destination, entry.bytes);
    await put(root, `packages/${entry.directory}/dist/index.js`, "export {};\n");
  }
  const recipes = [];
  for (const entry of files.filter(entry => entry.action.startsWith("copy"))) {
    const before = Buffer.from(old.get(entry.source_path));
    const after = entry.action === "copy-then-patch" ? Buffer.concat([before, Buffer.from("// accepted host adaptation\n")]) : before;
    await put(root, entry.destination_path, after);
    const recipe = { destination: entry.destination_path, source: entry.source_path, upstreamSha256: entry.sha256, sha256: hash(after), bytes: after.length, mode: 0o644, provenance: entry.action === "copy-then-patch" ? "patched-upstream" : "pristine-upstream" };
    if (entry.action === "copy-then-patch") {
      const patchPath = `${base}integration-patches/${entry.source_path}.json`;
      const patchBytes = json({ version: 1, source: entry.source_path, beforeSha256: hash(before), afterSha256: hash(after), splices: [{ start: splitLines(before).length, before: [], after: ["// accepted host adaptation\n"] }] });
      await put(root, patchPath, patchBytes);
      recipe.patch = { path: patchPath, sha256: hash(patchBytes) };
    }
    recipes.push(recipe);
  }
  const assets = ["source-manifest.json", "mcp-skills-adaptations.json", "mcp-skills-source.json", "sync-imports.json", "omp-source.json", "integration-patches.json", "packages/provider-omp/src/server.ts", ...recipes.filter(entry => entry.patch).map(entry => entry.patch.path.slice(base.length))];
  if (options.extraction) assets.push("packages/client-runtime/src/extracted.ts");
  for (const name of assets) {
    const data = await readFile(path.join(root, base, name));
    recipes.push({ destination: `${base}${name}`, asset: `${base}${name}`, sha256: hash(data), bytes: data.length, mode: 0o644, provenance: "local-addition" });
  }
  const extractions = options.extraction ? [{ source: "apps/web/src/settings.ts", sourceSha256: hash(old.get("apps/web/src/settings.ts")), lines: "1-1", destination: `${base}packages/client-runtime/src/extracted.ts`, adaptation: "Reviewed fixture declaration extraction" }] : [];
  await put(root, `${base}sync-inventory.json`, json({ version: 1, upstreamCommit: oldPin, sourceManifestSha256: hash(manifestBytes), files: recipes, extractions, summary: {}, runtimeResources: { hostBuildInputs: [{ path: "apps/server/agent/scripts/build.mjs", sha256: hash(await readFile(path.join(root, "apps/server/agent/scripts/build.mjs"))) }] } }));
  const changes = [];
  for (const name of new Set([...old.keys(), ...next.keys()])) {
    if (name === ".env.example" || name === "apps/web/src/never-selected.ts") continue;
    const before = old.get(name), after = next.get(name);
    if (before !== undefined && after !== undefined && Buffer.from(before).equals(Buffer.from(after))) continue;
    const sourceEntry = files.find(entry => entry.source_path === name);
    changes.push({ sourcePath: name, sourceCommit: oldPin, outputPath: sourceEntry?.action === "reference-only" ? null : `${base}${name}`, status: before === undefined ? "added" : after === undefined ? "deleted" : "modified", oldSha256: before === undefined ? null : hash(before), newSha256: after === undefined ? null : hash(after), kind: sourceEntry?.action === "copy-then-patch" ? "patched" : "pristine" });
  }
  // Simulate the core's reviewed three-way merge, without invoking source code.
  for (const change of changes) {
    if (!change.outputPath || change.sourcePath.startsWith("apps/server/src/unselected")) continue;
    if (change.status === "deleted") await rm(path.join(root, change.outputPath));
    else {
      const data = Buffer.from(next.get(change.sourcePath));
      await put(root, change.outputPath, change.sourcePath === "packages/contracts/src/index.ts" ? Buffer.concat([data, Buffer.from("// accepted host adaptation\n")]) : data);
    }
  }
  const plan = { oldCommit: oldPin, newCommit: nextPin, changes, reviews: [], approvedSourcePaths: [] };
  const call = () => recordGeneration({ root, source: "/never-read-source-worktree", targetCommit: nextPin, plan, readBlob, listTree });
  const review = (outputPath, sourceNames) => plan.reviews.push({ outputPath, disposition: "integrated", reason: "Reviewed exact fixture inputs and retained host behavior", inputs: sourceNames.map(name => ({ path: name, commit: nextPin, sha256: hash(next.get(name)) })) });
  return { root, old, next, supplement, plan, readBlob, listTree, reads, derivedName, call, review };
}

test("loadProfile derives complete roots, selected references and every dual-source input without swallowing drift", async t => {
  const f = await fixture(t);
  await put(f.root, `${base}packages/provider-omp/src/server.ts`, "// existing unrelated drift\n");
  await put(f.root, "apps/server/agent/scripts/build.mjs", "// existing host drift\n");
  const profile = await loadProfile(f.root);
  assert.deepEqual(profile.selection.trees, ["packages/contracts"]);
  assert.ok(profile.selection.files.includes("apps/server/src/reference.ts"));
  assert.ok(!profile.selection.files.includes("apps/web/src/mcp.ts"));
  assert.ok(!profile.selection.trees.includes("apps/server"));
  const derived = profile.outputs.find(entry => entry.path === f.derivedName);
  assert.equal(derived.kind, "derived");
  assert.deepEqual(derived.inputs.map(entry => entry.commit), [supplementalPin, oldPin]);
  assert.ok(profile.inputs.some(entry => entry.commit === supplementalPin && entry.path === "LICENSE"));
  assert.ok(profile.protectedPaths.includes(`${base}packages/provider-omp`));
  assert.ok(profile.authoringTrees.includes(`${base}integration-patches`));
});

test("production selection never promotes a supplemental-only input merely because its path exists in the production tree", async t => {
  const f = await fixture(t);
  const supplementalOnly = "apps/web/src/mcp.ts";
  f.old.set(supplementalOnly, "export const newerProductionMcp = true;\n");
  const profile = await loadProfile(f.root);
  assert.ok(profile.inputs.some(entry => entry.path === supplementalOnly && entry.commit === supplementalPin));
  assert.ok(profile.inputs.some(entry => entry.path === "packages/contracts/src/ref.ts" && entry.commit === oldPin));
  assert.ok(!profile.inputs.some(entry => entry.path === supplementalOnly && entry.commit === oldPin), "Do not invent an unenrolled production tuple");
  assert.ok(!profile.selection.files.includes(supplementalOnly), "Supplemental references must not become production selection");
  assert.ok(profile.selection.files.every(name => profile.inputs.some(entry => entry.path === name && entry.commit === oldPin)));
});

test("generation import package discovery matches inventory-only trusted scanner while scanning adaptation sources", async t => {
  const f = await fixture(t, { adaptationPackages: true });
  const result = await f.call();
  assert.deepEqual(result.blockers, []);
  const inventory = await get(f.root, `${base}sync-inventory.json`);
  const graph = await get(f.root, `${base}sync-imports.json`);
  const inventoryPackages = await Promise.all(inventory.files
    .filter(entry => entry.destination.endsWith("/package.json") && !entry.destination.includes("/third-party/"))
    .map(async entry => (await get(f.root, entry.destination)).name));
  assert.deepEqual(graph.packages.map(entry => entry.name).sort(), inventoryPackages.sort(), "Adaptation-only host manifests must not expand workspace package discovery");
  const hostEdges = graph.edges.filter(edge => edge.source === f.derivedName && edge.specifier?.startsWith("@agent-workspace/"));
  assert.equal(hostEdges.length, 2, "Adaptation source imports remain in the graph");
  for (const edge of hostEdges) {
    assert.equal(edge.disposition, "pm-host-package");
    assert.equal(edge.target, null, "Do not resolve a host package through its distribution files");
  }
});

test("directory resource probing preserves trusted scanner targets and real import closure without reading directories", async t => {
  const resources = [
    { specifier: "./", disposition: "pm-host-boundary", target: "apps/server/agent/src/" },
    { specifier: "../../../../", disposition: "pm-host-boundary", target: "./" },
    { specifier: "./missing/", disposition: "runtime-selected-resource", target: null },
  ];
  const f = await fixture(t, { resources, derivedImport: "./mcp-derived.ts" });
  const result = await f.call();
  assert.deepEqual(result.blockers, []);
  const graph = await get(f.root, `${base}sync-imports.json`);
  const edges = graph.edges.filter(edge => edge.source === f.derivedName);
  const importEdge = edges.find(edge => edge.kind === "import" && edge.specifier === "./mcp-derived.ts");
  assert.equal(importEdge.disposition, "vendored-source");
  assert.equal(importEdge.target, f.derivedName);
  for (const expected of resources) {
    const edge = edges.find(edge => edge.kind === "import-meta-resource" && edge.specifier === expected.specifier);
    assert.ok(edge);
    assert.equal(edge.disposition, expected.disposition);
    assert.equal(edge.target, expected.target);
  }
});

test("directory resource support does not turn a missing ordinary import into a resolved resource", async t => {
  const f = await fixture(t, {
    resources: [{ specifier: "./", disposition: "pm-host-boundary", target: "apps/server/agent/src/" }],
    derivedImport: "./missing-module.ts",
  });
  const before = await readFile(path.join(f.root, `${base}source-manifest.json`));
  const result = await f.call();
  assert.ok(result.blockers.some(entry => entry.code === "BLOCKED_IMPORT_CLOSURE" && entry.path === f.derivedName && entry.dependency === "./missing-module.ts"));
  assert.deepEqual(result.changedPaths, []);
  assert.deepEqual(await readFile(path.join(f.root, `${base}source-manifest.json`)), before);
});

test("resource directory probes still refuse symlink and outside-root targets before publication", async t => {
  for (const specifier of ["./linked/", "../../../../../outside/"]) {
    const f = await fixture(t, { resources: [{ specifier, disposition: "pm-host-boundary", target: specifier }] });
    if (specifier === "./linked/") await symlink(f.root, path.join(f.root, path.posix.dirname(f.derivedName), "linked"));
    const before = await readFile(path.join(f.root, `${base}source-manifest.json`));
    await assert.rejects(f.call(), /Unsafe profile (?:path|file)/);
    assert.deepEqual(await readFile(path.join(f.root, `${base}source-manifest.json`)), before);
  }
});

test("fresh generation binds merged bytes, additions, deletions and original/actual graphs coherently", async t => {
  const f = await fixture(t, { addition: true, deletion: true, nextText: 'import { addition } from "./new.ts";\nexport const upstream = addition;\n' });
  const ompBefore = await readFile(path.join(f.root, `${base}omp-source.json`));
  const snapshotBefore = await readFile(path.join(f.root, `${base}mcp-skills-source.json`));
  const result = await f.call();
  assert.deepEqual(result.blockers, []);
  assert.ok(result.changedPaths.includes(`${base}source-manifest.json`));
  const manifest = await get(f.root, `${base}source-manifest.json`), inventory = await get(f.root, `${base}sync-inventory.json`);
  const adaptations = await get(f.root, `${base}mcp-skills-adaptations.json`), imports = await get(f.root, `${base}sync-imports.json`);
  assert.equal(manifest.upstream.commit, nextPin);
  assert.equal(inventory.sourceManifestSha256, hash(await readFile(path.join(f.root, `${base}source-manifest.json`))));
  assert.ok(manifest.files.some(entry => entry.source_path === "packages/contracts/src/new.ts"));
  assert.ok(!manifest.files.some(entry => entry.source_path === "packages/contracts/src/drop.ts"));
  assert.ok(!manifest.consumer_slices.some(slice => slice.copy_paths.includes("packages/contracts/src/drop.ts")));
  assert.ok(!manifest.files.some(entry => entry.source_path === "apps/web/src/never-selected.ts"));
  assert.ok(manifest.imports.some(edge => edge.target === "packages/contracts/src/new.ts"));
  assert.ok(imports.edges.some(edge => edge.target === `${base}packages/contracts/src/new.ts`));
  assert.equal(adaptations.baselineCommit, nextPin);
  assert.deepEqual(adaptations.outputs[0].inputs.map(entry => entry.commit), [supplementalPin, nextPin]);
  const recipe = inventory.files.find(entry => entry.source === "packages/contracts/src/index.ts");
  const patch = await get(f.root, recipe.patch.path);
  assert.equal(patch.beforeSha256, hash(f.next.get("packages/contracts/src/index.ts")));
  assert.equal(patch.afterSha256, hash(await readFile(path.join(f.root, recipe.destination))));
  assert.ok(patch.splices.some(splice => splice.after.includes("// accepted host adaptation\n")));
  assert.deepEqual(await readFile(path.join(f.root, `${base}omp-source.json`)), ompBefore);
  assert.deepEqual(await readFile(path.join(f.root, `${base}mcp-skills-source.json`)), snapshotBefore);
  assert.deepEqual((await verifyGeneration({ root: f.root, readBlob: f.readBlob, listTree: f.listTree })).blockers, []);
});

test("non-primary derivation changes block before publication until all changed input identities are reviewed", async t => {
  const f = await fixture(t, { secondaryChanged: true });
  const before = await readFile(path.join(f.root, `${base}source-manifest.json`));
  const blocked = await f.call();
  assert.ok(blocked.blockers.some(entry => entry.code === "BLOCKED_DERIVED_REVIEW" && entry.path === f.derivedName));
  assert.deepEqual(blocked.changedPaths, []);
  assert.deepEqual(await readFile(path.join(f.root, `${base}source-manifest.json`)), before);
  f.review(f.derivedName, ["packages/contracts/src/ref.ts"]);
  assert.deepEqual((await f.call()).blockers, []);
  const adaptation = (await get(f.root, `${base}mcp-skills-adaptations.json`)).outputs[0];
  assert.equal(adaptation.inputs[1].sha256, hash(f.next.get("packages/contracts/src/ref.ts")));
  assert.equal(adaptation.inputs[0].commit, supplementalPin);
});

test("a review naming only the primary input cannot authorize a secondary change", async t => {
  const f = await fixture(t, { secondaryChanged: true });
  f.plan.reviews.push({ outputPath: f.derivedName, disposition: "integrated", reason: "Wrong input reviewed", inputs: [{ path: "apps/web/src/mcp.ts", commit: supplementalPin, sha256: hash(f.supplement.get("apps/web/src/mcp.ts")) }] });
  assert.ok((await f.call()).blockers.some(entry => entry.code === "BLOCKED_DERIVED_REVIEW"));
});

test("unplanned local OMP and host build drift cannot become new trusted fingerprints", async t => {
  const f = await fixture(t);
  const before = await readFile(path.join(f.root, `${base}sync-inventory.json`));
  await put(f.root, `${base}packages/provider-omp/src/server.ts`, "// unapproved local OMP edit\n");
  await put(f.root, "apps/server/agent/scripts/build.mjs", "// unapproved host edit\n");
  const result = await f.call();
  assert.ok(result.blockers.some(entry => entry.code === "BLOCKED_PROTECTED"));
  assert.ok(result.blockers.some(entry => entry.path === "apps/server/agent/scripts/build.mjs"));
  assert.deepEqual(await readFile(path.join(f.root, `${base}sync-inventory.json`)), before);
});

test("new dependencies outside selected modules require scope review, not whole-application copying", async t => {
  const f = await fixture(t, { nextText: 'import "../../../apps/server/src/unselected.ts";\nexport const upstream = 2;\n', targetFiles: { "apps/server/src/unselected.ts": "export const businessService = true;\n" } });
  const result = await f.call();
  assert.ok(result.blockers.some(entry => entry.code === "BLOCKED_SCOPE_EXPANSION"));
  await assert.rejects(lstat(path.join(f.root, `${base}apps/server/src/unselected.ts`)), { code: "ENOENT" });
});

test("reviewed dependency changes regenerate catalog declarations and complete reachable lock snapshots", async t => {
  const f = await fixture(t, { dependencyUpdate: true, nextText: 'import "left-pad";\nexport const upstream = 2;\n' });
  f.review(`${base}packages/contracts/package.json`, ["packages/contracts/package.json"]);
  f.review(`${base}source-manifest.json`, ["pnpm-lock.yaml"]);
  const result = await f.call();
  assert.deepEqual(result.blockers, []);
  const manifest = await get(f.root, `${base}source-manifest.json`);
  assert.deepEqual(manifest.external_lock_closure.snapshots.map(entry => entry.key), ["left-pad@1.0.0", "tiny-dependency@2.0.0"]);
  assert.equal(manifest.required_catalog_entries["left-pad"].specifier, "1.0.0");
  assert.equal(manifest.external_dependencies.find(entry => entry.specifier_package === "left-pad").declarations[0].resolved, "1.0.0");
  assert.equal(manifest.packages[0].dependencies[0].declared, "catalog:");
  assert.equal(manifest.packages[0].dependencies[0].catalog, "1.0.0");
});

test("extractions are derived inputs and changed declarations require reviewed current source ranges", async t => {
  const f = await fixture(t, { extraction: true });
  const destination = `${base}packages/client-runtime/src/extracted.ts`;
  const profile = await loadProfile(f.root);
  assert.equal(profile.outputs.find(entry => entry.path === destination).kind, "derived");
  assert.equal(profile.outputs.find(entry => entry.path === destination).inputs[0].path, "apps/web/src/settings.ts");
  assert.ok((await f.call()).blockers.some(entry => entry.code === "BLOCKED_EXTRACTION"));
  f.review(destination, ["apps/web/src/settings.ts"]);
  f.plan.reviews.at(-1).extractionLines = "2-2";
  await put(f.root, destination, "// host annotation\nexport const field = 2;\n");
  assert.deepEqual((await f.call()).blockers, []);
  const inventory = await get(f.root, `${base}sync-inventory.json`);
  assert.equal(inventory.extractions[0].lines, "2-2");
  assert.equal(inventory.extractions[0].sourceSha256, hash(f.next.get("apps/web/src/settings.ts")));
});

test("guarded adapter changes require explicit reasoned acceptance even after a clean source merge", async t => {
  const guarded = "packages/provider-core/src/server/instanceEnvironment.ts";
  const f = await fixture(t, { targetFiles: { [guarded]: "export const environment = 'new';\n" } });
  // This is a newly proposed selected dependency; approve its scope, but not its semantics.
  f.plan.approvedSourcePaths.push(guarded);
  assert.ok((await f.call()).blockers.some(entry => entry.code === "BLOCKED_COMPATIBILITY_REVIEW"));
  f.review(`${base}${guarded}`, [guarded]);
  const policy = (await loadProfile(f.root)).policy;
  assert.ok(policy.adapterRequirements.find(entry => entry.id === "host-environment").reason.includes("HostProcess.Environment"));
  assert.ok(policy.adapterRequirements.find(entry => entry.id === "continuation-identity").acceptance.includes("409/session_mismatch"));
  assert.deepEqual((await f.call()).blockers, []);
});

test("removed locally edited files require an explicit disposition and delete obsolete recipes", async t => {
  const f = await fixture(t, { deletion: true, editedDeletion: true });
  const destination = `${base}packages/contracts/src/drop.ts`;
  assert.ok((await f.call()).blockers.some(entry => entry.code === "BLOCKED_REMOVED_INPUT"));
  f.plan.reviews.push({ outputPath: destination, disposition: "not-applicable", reason: "Reviewed removal: this edited fixture has no surviving consumer", inputs: [] });
  const result = await f.call();
  assert.deepEqual(result.blockers, []);
  const inventory = await get(f.root, `${base}sync-inventory.json`);
  assert.ok(!inventory.files.some(entry => entry.destination === destination));
  await assert.rejects(lstat(path.join(f.root, `${base}integration-patches/packages/contracts/src/drop.ts.json`)), { code: "ENOENT" });
});

test("old pristine output cannot be disguised as a newly accepted patch by only advancing pins", async t => {
  const source = "apps/server/src/selected.ts";
  const f = await fixture(t, { targetFiles: { [source]: "export const selected = 'new';\n" } });
  await put(f.root, `${base}${source}`, f.old.get(source));
  const before = await readFile(path.join(f.root, `${base}source-manifest.json`));
  assert.ok((await f.call()).blockers.some(entry => entry.code === "BLOCKED_STALE_OUTPUT"));
  assert.deepEqual(await readFile(path.join(f.root, `${base}source-manifest.json`)), before);
});

test("missing Git objects, source blob mismatches and unsafe trees refuse before metadata writes", async t => {
  const f = await fixture(t);
  const before = await readFile(path.join(f.root, `${base}source-manifest.json`));
  await assert.rejects(recordGeneration({ root: f.root, targetCommit: nextPin, plan: f.plan, listTree: f.listTree, readBlob: async () => { throw new Error("Missing immutable object"); } }), /Missing immutable object/);
  await assert.rejects(recordGeneration({ root: f.root, targetCommit: nextPin, plan: f.plan, listTree: f.listTree, readBlob: async () => Buffer.from("wrong bytes") }), /hash\/blob\/mode mismatch/);
  await assert.rejects(recordGeneration({ root: f.root, targetCommit: nextPin, plan: f.plan, readBlob: f.readBlob, listTree: async commit => [...await f.listTree(commit), { path: "../escape.ts", type: "blob", mode: "100644", blob: "0".repeat(40) }] }), /Unsafe profile path/);
  assert.deepEqual(await readFile(path.join(f.root, `${base}source-manifest.json`)), before);
});

test("symlinks and special-mode outputs cannot be silently captured", async t => {
  const f = await fixture(t);
  const file = path.join(f.root, `${base}packages/contracts/src/index.ts`);
  await rm(file);
  await symlink(path.join(f.root, `${base}LICENSE`), file);
  await assert.rejects(f.call(), /Unsafe profile file/);
  await rm(file);
  await put(f.root, `${base}packages/contracts/src/index.ts`, "fixture\n");
  await chmod(file, 0o4644);
  await assert.rejects(f.call(), /Unsafe profile file/);
});

test("same-pin reauthor refreshes only exact approved output bytes and preserves the generation ancestry", async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.call()).blockers, []);
  const destination = `${base}packages/contracts/src/index.ts`;
  const revised = Buffer.concat([await readFile(path.join(f.root, destination)), Buffer.from("// reviewed full-check fix\n")]);
  await put(f.root, destination, revised);
  const plan = { oldCommit: nextPin, newCommit: nextPin, changes: [], reauthorGeneration: true, approvedOutputHashes: {}, reviews: [] };
  const call = () => recordGeneration({ root: f.root, targetCommit: nextPin, plan, readBlob: f.readBlob, listTree: f.listTree });
  const before = await readFile(path.join(f.root, `${base}source-manifest.json`));
  assert.ok((await call()).blockers.some(entry => entry.code === "BLOCKED_UNAPPROVED_OUTPUT"));
  assert.deepEqual(await readFile(path.join(f.root, `${base}source-manifest.json`)), before);
  plan.approvedOutputHashes[destination] = "0".repeat(64);
  assert.ok((await call()).blockers.some(entry => entry.code === "BLOCKED_STALE_OUTPUT_APPROVAL"));
  plan.approvedOutputHashes[destination] = hash(revised);
  assert.deepEqual((await call()).blockers, []);
  const manifest = await get(f.root, `${base}source-manifest.json`);
  assert.equal(manifest.upstream.commit, nextPin);
  assert.equal(manifest.generation.previousCommit, oldPin);
  assert.equal(manifest.generation.reauthoringRevision, 1);
  assert.deepEqual((await verifyGeneration({ root: f.root, readBlob: f.readBlob, listTree: f.listTree })).blockers, []);
  const recorded = await readFile(path.join(f.root, `${base}sync-inventory.json`));
  plan.approvedOutputHashes = {};
  assert.deepEqual((await call()).changedPaths, []);
  assert.deepEqual(await readFile(path.join(f.root, `${base}sync-inventory.json`)), recorded);
});

test("same-pin reauthor of a derived output still requires every mapped source input review", async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.call()).blockers, []);
  const revised = Buffer.from("export const adaptedMcp = 'reviewed';\n");
  await put(f.root, f.derivedName, revised);
  const plan = { oldCommit: nextPin, newCommit: nextPin, changes: [], reauthorGeneration: true, approvedOutputHashes: { [f.derivedName]: hash(revised) }, reviews: [] };
  const call = () => recordGeneration({ root: f.root, targetCommit: nextPin, plan, readBlob: f.readBlob, listTree: f.listTree });
  assert.ok((await call()).blockers.some(entry => entry.path === f.derivedName && entry.inputs?.length === 2));
  const mapped = (await loadProfile(f.root)).outputs.find(entry => entry.path === f.derivedName).inputs;
  plan.reviews.push({ outputPath: f.derivedName, disposition: "integrated", reason: "Reviewed both existing immutable source inputs for the local correction", inputs: mapped.map(({ path, commit, sha256 }) => ({ path, commit, sha256 })) });
  assert.deepEqual((await call()).blockers, []);
  assert.deepEqual((await verifyGeneration({ root: f.root, readBlob: f.readBlob, listTree: f.listTree })).blockers, []);
});

test("same-pin approvals cannot re-enroll frozen baselines, metadata, local OMP or host build tools", async t => {
  const f = await fixture(t);
  await assert.rejects(recordGeneration({ root: f.root, targetCommit: oldPin, plan: { oldCommit: oldPin, newCommit: oldPin, reauthorGeneration: true, approvedOutputHashes: {} }, readBlob: f.readBlob, listTree: f.listTree }), /existing recorded maintenance generation/);
  assert.deepEqual((await f.call()).blockers, []);
  for (const name of [`${base}source-manifest.json`, `${base}packages/provider-omp/src/server.ts`, "apps/server/agent/scripts/build.mjs"]) {
    await assert.rejects(recordGeneration({ root: f.root, targetCommit: nextPin, plan: { oldCommit: nextPin, newCommit: nextPin, reauthorGeneration: true, approvedOutputHashes: { [name]: hash(await readFile(path.join(f.root, name))) } }, readBlob: f.readBlob, listTree: f.listTree }), /Unapprovable reauthor output/);
  }
});

test("explicit initial local-authoring records only approved corrections without advancing the immutable source pin", async t => {
  const f = await fixture(t);
  const destination = `${base}packages/contracts/src/index.ts`;
  const before = await readFile(path.join(f.root, `${base}source-manifest.json`));
  const originalIdentity = (await get(f.root, `${base}source-manifest.json`)).files.find(entry => entry.source_path === "packages/contracts/src/index.ts");
  const plan = {
    purpose: "local-authoring", initialLocalAuthoring: true, reauthorGeneration: true,
    oldCommit: oldPin, upstreamCommit: oldPin, newCommit: oldPin, targetCommit: oldPin,
    changes: [], approvedSourcePaths: [], approvedOutputHashes: {}, reviews: [],
  };
  const call = () => recordGeneration({ root: f.root, targetCommit: oldPin, plan, readBlob: f.readBlob, listTree: f.listTree });
  assert.ok((await call()).blockers.some(entry => entry.code === "BLOCKED_UNAPPROVED_OUTPUT"));
  assert.deepEqual(await readFile(path.join(f.root, `${base}source-manifest.json`)), before);
  plan.approvedOutputHashes[destination] = hash(await readFile(path.join(f.root, destination)));
  assert.deepEqual((await call()).blockers, []);
  const manifest = await get(f.root, `${base}source-manifest.json`);
  assert.equal(manifest.upstream.commit, oldPin);
  assert.equal(manifest.generation.commit, oldPin);
  assert.equal(manifest.generation.previousCommit, oldPin);
  assert.equal(manifest.generation.purpose, "local-authoring");
  assert.equal(manifest.generation.reauthoringRevision, 0);
  assert.deepEqual(manifest.files.find(entry => entry.source_path === originalIdentity.source_path), originalIdentity);
  assert.deepEqual((await verifyGeneration({ root: f.root, readBlob: f.readBlob, listTree: f.listTree })).blockers, []);
  assert.deepEqual((await call()).changedPaths, []);
  const revised = Buffer.concat([await readFile(path.join(f.root, destination)), Buffer.from("// later reviewed correction\n")]);
  await put(f.root, destination, revised);
  plan.initialLocalAuthoring = false;
  plan.approvedOutputHashes[destination] = hash(revised);
  assert.deepEqual((await call()).blockers, []);
  const subsequent = await get(f.root, `${base}source-manifest.json`);
  assert.equal(subsequent.generation.previousCommit, oldPin);
  assert.equal(subsequent.generation.purpose, "local-authoring");
  assert.equal(subsequent.generation.reauthoringRevision, 1);
});

test("first local-authoring candidate record preserves a valid earlier upgrade generation and its reviews", async t => {
  const f = await fixture(t);
  const destination = `${base}packages/contracts/src/index.ts`;
  f.review(destination, ["packages/contracts/src/index.ts"]);
  assert.deepEqual((await f.call()).blockers, []);
  const previous = (await get(f.root, `${base}source-manifest.json`)).generation;
  const revised = Buffer.concat([await readFile(path.join(f.root, destination)), Buffer.from("// first correction in a new local-authoring candidate\n")]);
  await put(f.root, destination, revised);
  const plan = {
    purpose: "local-authoring", initialLocalAuthoring: true, reauthorGeneration: true,
    oldCommit: nextPin, upstreamCommit: nextPin, newCommit: nextPin, targetCommit: nextPin,
    changes: [], approvedSourcePaths: [], approvedOutputHashes: { [destination]: hash(revised) }, reviews: [],
  };
  const result = await recordGeneration({ root: f.root, targetCommit: nextPin, plan, readBlob: f.readBlob, listTree: f.listTree });
  assert.deepEqual(result.blockers, []);
  const current = (await get(f.root, `${base}source-manifest.json`)).generation;
  assert.equal(current.previousCommit, previous.previousCommit);
  assert.equal(current.previousCommit, oldPin);
  assert.equal(current.commit, nextPin);
  assert.equal(current.purpose, previous.purpose);
  assert.deepEqual(current.reviews, previous.reviews);
  assert.equal(current.reauthoringRevision, previous.reauthoringRevision + 1);
  assert.deepEqual((await verifyGeneration({ root: f.root, readBlob: f.readBlob, listTree: f.listTree })).blockers, []);
});

test("initial candidate intent cannot bypass invalid existing generation ancestry", async t => {
  const f = await fixture(t, { generation: { commit: oldPin, previousCommit: "invalid" } });
  const before = await readFile(path.join(f.root, `${base}source-manifest.json`));
  const destination = `${base}packages/contracts/src/index.ts`;
  const plan = {
    purpose: "local-authoring", initialLocalAuthoring: true, reauthorGeneration: true,
    oldCommit: oldPin, upstreamCommit: oldPin, newCommit: oldPin, targetCommit: oldPin,
    changes: [], approvedSourcePaths: [], approvedOutputHashes: { [destination]: hash(await readFile(path.join(f.root, destination))) }, reviews: [],
  };
  await assert.rejects(recordGeneration({ root: f.root, targetCommit: oldPin, plan, readBlob: f.readBlob, listTree: f.listTree }), /existing recorded maintenance generation/);
  assert.deepEqual(await readFile(path.join(f.root, `${base}source-manifest.json`)), before);
});

test("initial local-authoring intent cannot authorize source expansion, pin changes or frozen metadata and host enrollment", async t => {
  const f = await fixture(t);
  const before = await readFile(path.join(f.root, `${base}source-manifest.json`));
  const basePlan = {
    purpose: "local-authoring", initialLocalAuthoring: true, reauthorGeneration: true,
    oldCommit: oldPin, upstreamCommit: oldPin, newCommit: oldPin, targetCommit: oldPin,
    changes: [], approvedSourcePaths: [], approvedOutputHashes: {}, reviews: [],
  };
  const call = plan => recordGeneration({ root: f.root, targetCommit: oldPin, plan, readBlob: f.readBlob, listTree: f.listTree });
  for (const override of [
    { purpose: "upstream-update" }, { reauthorGeneration: false }, { upstreamCommit: nextPin },
    { changes: [{ sourcePath: "packages/contracts/src/index.ts", status: "modified" }] },
    { approvedSourcePaths: ["apps/server/src/unselected.ts"] },
  ]) await assert.rejects(call({ ...basePlan, ...override }), /Initial local authoring requires explicit same-pin/);
  for (const name of [`${base}source-manifest.json`, `${base}packages/provider-omp/src/server.ts`, "apps/server/agent/scripts/build.mjs"]) {
    await assert.rejects(call({ ...basePlan, approvedOutputHashes: { [name]: hash(await readFile(path.join(f.root, name))) } }), /Unapprovable reauthor output/);
  }
  assert.deepEqual(await readFile(path.join(f.root, `${base}source-manifest.json`)), before);
});

test("same-pin operation performs no recapture or writes", async t => {
  const f = await fixture(t);
  const before = await readFile(path.join(f.root, `${base}source-manifest.json`));
  const result = await recordGeneration({ root: f.root, targetCommit: oldPin, plan: { oldCommit: oldPin, newCommit: oldPin, changes: [] }, readBlob: f.readBlob, listTree: f.listTree });
  assert.deepEqual(result.changedPaths, []);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(await readFile(path.join(f.root, `${base}source-manifest.json`)), before);
});
