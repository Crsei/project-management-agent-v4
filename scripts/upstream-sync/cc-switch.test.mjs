import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resourceClosure } from "../../vendor/cc-switch/scripts/closure.mjs";
import { applyPatch, encode, patchBytes, sha256 } from "../../vendor/cc-switch/scripts/provenance.mjs";
import { loadProfile, recordGeneration, verifyGeneration } from "./cc-switch.mjs";

const oldCommit = "1".repeat(40), newCommit = "2".repeat(40);
const prefix = "vendor/cc-switch/";
const manifestPath = prefix + "source-manifest.json", inventoryPath = prefix + "output-inventory.json";
const policyPath = prefix + "fork-policy.json", closurePath = prefix + "resource-closure.json", treePath = prefix + "upstream-tree.json";
const digestBlob = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const bytes = (value) => Buffer.isBuffer(value) ? value : Buffer.from(value);
const require = createRequire(import.meta.url);
async function put(root, name, content, mode = 0o644) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), content, { mode });
  await chmod(path.join(root, name), mode);
}
async function parsed(root, name) { return JSON.parse(await readFile(path.join(root, name))); }

// These are real exact-byte generations on disposable files. Immutable object
// callbacks model Git's blob/tree interface; no candidate script is executed.
async function fixture(t, { derived = false, patched = false, security = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cc-profile-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initial = new Map([
    ["LICENSE", bytes("MIT fixture\n")],
    ["package.json", bytes('{"name":"cc-fixture","version":"1.0.0"}\n')],
    ["src/index.ts", bytes("export const upstream = 1;\n")],
    ["src/dead.ts", bytes("export const dead = true;\n")],
    ["src-tauri/src/codex_config.rs", bytes("pub fn config() -> u8 { 1 }\n")],
  ]);
  if (security) initial.set("src-tauri/src/database/dao/mcp.rs", bytes("pub fn store() {}\n"));
  const target = new Map(initial), modes = new Map();
  const commits = new Map([[oldCommit, initial], [newCommit, target]]);
  const readBlob = async (commit, name) => {
    const value = commits.get(commit)?.get(name);
    if (!value) throw new Error(`Missing immutable object: ${commit}:${name}`);
    return Buffer.from(value);
  };
  const listTree = async (commit) => [...commits.get(commit)].map(([name, value]) => ({ path: name, mode: modes.get(`${commit}:${name}`) ?? "100644", blob: digestBlob(value), type: "blob" })).sort((a, b) => a.path.localeCompare(b.path));
  const originalFiles = (await listTree(oldCommit)).map((entry) => ({ path: entry.path, mode: entry.mode, blob: entry.blob, sha256: sha256(initial.get(entry.path)), bytes: initial.get(entry.path).length }));
  const manifest = { schemaVersion: 1, upstream: "https://github.com/farion1231/cc-switch", commit: oldCommit, version: "1.0.0", license: "MIT", selection: ["LICENSE", "package.json", "src", "src-tauri/src"], files: originalFiles };
  const manifestBytes = encode(manifest);
  const policy = { version: 1, upstreamCommit: oldCommit, sourceManifestSha256: sha256(manifestBytes), productionRoots: [prefix + "src/index.ts"], hostBuildInputs: ["host/build.json"], ownedTrees: ["vendor/cc-switch"], generatedTrees: [], derivedOutputs: derived ? [{ destination: prefix + "src-tauri/src/codex_mcp_config.rs", source: "src-tauri/src/codex_config.rs", reason: "Reviewed headless Codex helper extraction" }] : [], sourceReferenceDocuments: [], dynamicResources: [] };
  await put(root, manifestPath, manifestBytes);
  await put(root, policyPath, encode(policy));
  await put(root, "host/build.json", "{}\n");
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await symlink(path.dirname(require.resolve("typescript/package.json")), path.join(root, "node_modules/typescript"), "dir");
  const files = [], patches = [];
  async function enroll(destination, content, source = null) {
    await put(root, destination, content);
    const entry = { destination, sha256: sha256(content), bytes: content.length, mode: 0o644, provenance: source ? "pristine-upstream" : "local-fork-integration", reason: "Reviewed fixture adaptation" };
    if (source) {
      entry.source = source; entry.upstreamSha256 = sha256(initial.get(source));
      if (!content.equals(initial.get(source))) {
        const recipePath = `${prefix}integration-patches/${destination === prefix + source ? source : `derived/${destination}`}.json`;
        const recipe = patchBytes(initial.get(source), content, source);
        entry.patch = { path: recipePath, sha256: sha256(recipe) };
        entry.provenance = destination === prefix + source ? "patched-upstream" : "adapted-upstream-extraction";
        await put(root, recipePath, recipe); patches.push(entry.patch);
      }
    } else {
      const assetPath = `${prefix}integration-patches/local/${destination}.json`;
      const asset = encode({ version: 1, destination, sha256: entry.sha256, mode: entry.mode, encoding: "base64", content: content.toString("base64") });
      entry.asset = { path: assetPath, sha256: sha256(asset) };
      await put(root, assetPath, asset); patches.push(entry.asset);
    }
    files.push(entry);
  }
  for (const [name, content] of initial) {
    const accepted = patched && name === "src/index.ts" ? Buffer.concat([content, bytes("export const host = true;\n")]) : security && name === "src-tauri/src/database/dao/mcp.rs" ? bytes("pub fn store() { secret_codec::open(); secret_codec::seal(); }\n") : content;
    await enroll(prefix + name, accepted, name);
  }
  if (derived) await enroll(prefix + "src-tauri/src/codex_mcp_config.rs", bytes("pub fn headless_config() -> u8 { 1 }\n"), "src-tauri/src/codex_config.rs");
  await enroll(manifestPath, manifestBytes);
  await enroll(policyPath, encode(policy));
  await enroll(prefix + "src/host-only.ts", bytes("export const local = true;\n"));
  const tree = encode({ version: 1, upstreamCommit: oldCommit, paths: [...initial.keys()].sort() });
  const closure = await resourceClosure(root, policy, files, [...initial.keys()].sort());
  const inventory = { version: 1, upstreamCommit: oldCommit, sourceManifestSha256: sha256(manifestBytes), policySha256: sha256(encode(policy)), closureSha256: sha256(closure), upstreamTreeSha256: sha256(tree), hostBuildInputs: [{ path: "host/build.json", sha256: sha256(bytes("{}\n")), bytes: 3 }], modePolicy: "Canonical 0644/0755", files: files.sort((a, b) => a.destination.localeCompare(b.destination)), patches: patches.sort((a, b) => a.path.localeCompare(b.path)), summary: {} };
  await put(root, closurePath, closure);
  await put(root, treePath, tree);
  await put(root, inventoryPath, encode(inventory));
  const plan = { oldCommit, newCommit, changes: [] };
  const context = { root, source: "/unused/read-only-git", targetCommit: newCommit, plan, readBlob, listTree };
  function change(name, content, status = "modified") {
    if (content === null) target.delete(name); else target.set(name, bytes(content));
    plan.changes.push({ sourcePath: name, sourceCommit: oldCommit, outputPath: prefix + name, status, kind: "pristine" });
  }
  return { ...context, initial, target, modes, change, manifestBytes, inventory, context };
}

async function openHandsConsumer(root, name) {
  const consumed = await readFile(path.join(root, name));
  const closure = encode({ version: 1, inputs: [{ path: name, sha256: sha256(consumed), bytes: consumed.length, ownership: "independently-inventoried-boundary" }], snapshotOnly: [name] });
  const policy = encode({ version: 1 });
  await put(root, "vendor/openhands-extensions/resource-closure.json", closure);
  await put(root, "vendor/openhands-extensions/fork-policy.json", policy);
  await put(root, "vendor/openhands-extensions/output-inventory.json", encode({ version: 1, closureSha256: sha256(closure), policySha256: sha256(policy), hostBuildInputs: [] }));
}

test("profile exposes complete trees, exact source identity and all Codex derivation inputs without concealing drift", async (t) => {
  const f = await fixture(t, { derived: true });
  await put(f.root, prefix + "src/index.ts", "export const unknown = true;\n");
  await put(f.root, "host/build.json", "{\"parallel\":true}\n");
  const profile = await loadProfile(f.root);
  assert.deepEqual(profile.selection.trees, ["src", "src-tauri/src"]);
  const derived = profile.outputs.find((entry) => entry.path.endsWith("codex_mcp_config.rs"));
  assert.equal(derived.kind, "derived");
  assert.equal(derived.inputs[0].commit, oldCommit);
  assert.equal(derived.inputs[0].path, "src-tauri/src/codex_config.rs");
  assert.equal(profile.hostInputs.find((entry) => entry.path === "host/build.json").sha256, sha256(bytes("{}\n")));
  assert.notEqual(profile.outputs.find((entry) => entry.path === prefix + "src/index.ts").sha256, sha256(bytes("export const unknown = true;\n")));
});

test("fresh generation handles merged adaptation, dependency addition, deletion, binary mode and exact replay", async (t) => {
  const f = await fixture(t, { patched: true });
  f.change("src/index.ts", 'import { added } from "./added";\nexport const upstream = added;\n');
  f.change("src/added.ts", "export const added = 2;\n", "added");
  f.change("src/dead.ts", null, "deleted");
  f.change("src/binary.bin", Buffer.from([0, 255, 1, 128]), "added");
  f.modes.set(`${newCommit}:src/binary.bin`, "100755");
  await put(f.root, prefix + "src/index.ts", 'import { added } from "./added";\nexport const upstream = added;\nexport const host = true;\n');
  await unlink(path.join(f.root, prefix + "src/dead.ts"));
  const result = await recordGeneration(f.context);
  assert.deepEqual(result.blockers, []);
  assert.ok(result.changedPaths.includes(prefix + "src/added.ts"));
  assert.ok(result.changedPaths.includes(prefix + "src/binary.bin"));
  const manifest = await parsed(f.root, manifestPath), inventory = await parsed(f.root, inventoryPath);
  assert.equal(manifest.commit, newCommit);
  assert.ok(!manifest.files.some((entry) => entry.path === "src/dead.ts"));
  assert.equal(manifest.files.find((entry) => entry.path === "src/binary.bin").mode, "100755");
  const index = inventory.files.find((entry) => entry.destination === prefix + "src/index.ts");
  const recipe = await readFile(path.join(f.root, index.patch.path));
  assert.deepEqual(applyPatch(f.target.get("src/index.ts"), recipe, index), await readFile(path.join(f.root, index.destination)));
  const manifestOutput = inventory.files.find((entry) => entry.destination === manifestPath);
  const asset = await parsed(f.root, manifestOutput.asset.path);
  assert.equal(asset.sha256, sha256(await readFile(path.join(f.root, manifestPath))));
  assert.deepEqual((await verifyGeneration(f.context)).blockers, []);
  assert.equal(f.initial.get("src/index.ts").toString(), "export const upstream = 1;\n");
});

test("changed Codex input blocks until every derived output has explicit semantic review", async (t) => {
  const f = await fixture(t, { derived: true });
  f.change("src-tauri/src/codex_config.rs", "pub fn config() -> u8 { 2 }\n");
  await put(f.root, prefix + "src-tauri/src/codex_config.rs", f.target.get("src-tauri/src/codex_config.rs"));
  const before = await readFile(path.join(f.root, inventoryPath));
  let result = await recordGeneration(f.context);
  assert.ok(result.blockers.some((entry) => entry.code === "BLOCKED_DERIVED_REVIEW"));
  assert.deepEqual(await readFile(path.join(f.root, inventoryPath)), before);
  f.plan.reviewedDerivedOutputs = [prefix + "src-tauri/src/codex_mcp_config.rs"];
  await put(f.root, f.plan.reviewedDerivedOutputs[0], "pub fn headless_config() -> u8 { 2 }\n");
  result = await recordGeneration(f.context);
  assert.deepEqual(result.blockers, []);
  const inventory = await parsed(f.root, inventoryPath);
  assert.equal(inventory.files.find((entry) => entry.destination === f.plan.reviewedDerivedOutputs[0]).upstreamSha256, sha256(f.target.get("src-tauri/src/codex_config.rs")));
  assert.deepEqual((await verifyGeneration(f.context)).blockers, []);
});

test("out-of-selection dependency is blocked then exact source approval closes and replays it", async (t) => {
  const f = await fixture(t);
  f.change("src/index.ts", 'export { dependency } from "../shared/dependency";\n');
  f.target.set("shared/dependency.ts", bytes("export const dependency = true;\n"));
  await put(f.root, prefix + "src/index.ts", f.target.get("src/index.ts"));
  let result = await recordGeneration(f.context);
  assert.ok(result.blockers.some((entry) => entry.code === "BLOCKED_RESOURCE_CLOSURE"));
  assert.equal((await parsed(f.root, manifestPath)).commit, oldCommit);
  f.plan.approvedSourcePaths = ["shared/dependency.ts"];
  result = await recordGeneration(f.context);
  assert.deepEqual(result.blockers, []);
  assert.ok((await parsed(f.root, manifestPath)).selection.includes("shared/dependency.ts"));
  assert.deepEqual((await verifyGeneration(f.context)).blockers, []);
});

test("OpenHands boundary fingerprints block snapshot-only changes and never rewrite the other fork", async (t) => {
  const f = await fixture(t);
  await openHandsConsumer(f.root, prefix + "src/dead.ts");
  const otherBefore = await readFile(path.join(f.root, "vendor/openhands-extensions/output-inventory.json"));
  f.change("src/dead.ts", "export const dead = false;\n");
  await put(f.root, prefix + "src/dead.ts", f.target.get("src/dead.ts"));
  const profile = await loadProfile(f.root);
  assert.ok(profile.blockers.some((entry) => entry.code === "BLOCKED_CROSS_FORK"));
  const result = await recordGeneration(f.context);
  assert.ok(result.blockers.some((entry) => entry.code === "BLOCKED_CROSS_FORK"));
  assert.deepEqual(await readFile(path.join(f.root, "vendor/openhands-extensions/output-inventory.json")), otherBefore);
  assert.equal((await parsed(f.root, manifestPath)).commit, oldCommit);
});

test("unknown local edits, host drift and deleted edited outputs cannot be silently recaptured", async (t) => {
  const f = await fixture(t);
  await put(f.root, prefix + "src/host-only.ts", "export const local = false;\n");
  await put(f.root, "host/build.json", "{\"unapproved\":true}\n");
  f.change("src/dead.ts", null, "deleted");
  const result = await recordGeneration(f.context);
  assert.ok(result.blockers.some((entry) => entry.code === "BLOCKED_UNAPPROVED_OUTPUT"));
  assert.ok(result.blockers.some((entry) => entry.code === "BLOCKED_BASELINE_DRIFT"));
  assert.ok(result.blockers.some((entry) => entry.code === "BLOCKED_DELETED_OUTPUT"));
  assert.equal((await parsed(f.root, manifestPath)).commit, oldCommit);
});

test("exact local approval records a real host adaptation without granting blanket approval", async (t) => {
  const f = await fixture(t);
  const name = prefix + "src/host-only.ts", content = bytes("export const local = false;\n");
  await put(f.root, name, content);
  f.plan.approvedOutputHashes = { [name]: sha256(content) };
  const result = await recordGeneration(f.context);
  assert.deepEqual(result.blockers, []);
  const inventory = await parsed(f.root, inventoryPath), entry = inventory.files.find((output) => output.destination === name);
  assert.equal(entry.provenance, "local-fork-integration");
  assert.equal(entry.sha256, sha256(content));
  assert.deepEqual((await verifyGeneration(f.context)).blockers, []);
});

test("credential encryption hooks cannot be restored to plaintext even by an approved source merge", async (t) => {
  const f = await fixture(t, { security: true });
  const source = "src-tauri/src/database/dao/mcp.rs";
  f.change(source, "pub fn store() { plaintext(); }\n");
  await put(f.root, prefix + source, f.target.get(source));
  const result = await recordGeneration(f.context);
  assert.ok(result.blockers.some((entry) => entry.code === "BLOCKED_HOST_INVARIANT" && entry.invariant === "secret_codec::open"));
  assert.equal((await parsed(f.root, manifestPath)).commit, oldCommit);
});

test("hostile approved paths, symlink outputs and absent immutable objects fail before publication", async (t) => {
  const f = await fixture(t);
  f.plan.approvedSourcePaths = ["../escape"];
  await assert.rejects(recordGeneration(f.context), /Unsafe provenance path/);
  delete f.plan.approvedSourcePaths;
  await unlink(path.join(f.root, prefix + "src/dead.ts"));
  await symlink(path.join(f.root, "host/build.json"), path.join(f.root, prefix + "src/dead.ts"));
  await assert.rejects(recordGeneration(f.context), /Unsafe provenance/);
  await unlink(path.join(f.root, prefix + "src/dead.ts"));
  await put(f.root, prefix + "src/dead.ts", f.initial.get("src/dead.ts"));
  await assert.rejects(recordGeneration({ ...f.context, readBlob: async () => { throw new Error("Missing immutable object"); } }), /Missing immutable object/);
  assert.equal((await parsed(f.root, manifestPath)).commit, oldCommit);
});

test("candidate parser modules remain inert data, never production authoring code", async (t) => {
  const f = await fixture(t);
  const marker = path.join(f.root, "executed");
  await put(f.root, "node_modules/typescript-evil/package.json", '{"main":"index.js"}\n');
  await put(f.root, "node_modules/typescript-evil/index.js", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe'); throw new Error('candidate code ran');\n`);
  await unlink(path.join(f.root, "node_modules/typescript"));
  await symlink(path.join(f.root, "node_modules/typescript-evil"), path.join(f.root, "node_modules/typescript"), "dir");
  const result = await recordGeneration(f.context);
  assert.deepEqual(result.blockers, []);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.deepEqual((await verifyGeneration(f.context)).blockers, []);
});

test("upstream removal of an adapted file remains an explicit porting blocker even if the candidate removed it", async (t) => {
  const f = await fixture(t, { patched: true });
  f.change("src/index.ts", null, "deleted");
  await unlink(path.join(f.root, prefix + "src/index.ts"));
  const result = await recordGeneration(f.context);
  assert.ok(result.blockers.some((entry) => entry.code === "BLOCKED_DELETED_ADAPTATION"));
  assert.equal((await parsed(f.root, manifestPath)).commit, oldCommit);
});

test("a new upstream file cannot take over an existing local integration destination", async (t) => {
  const f = await fixture(t);
  f.change("src/host-only.ts", "export const upstreamTakeover = true;\n", "added");
  const result = await recordGeneration(f.context);
  assert.ok(result.blockers.some((entry) => entry.code === "BLOCKED_SOURCE_COLLISION"));
  assert.equal((await parsed(f.root, manifestPath)).commit, oldCommit);
});

test("same-pin reauthoring accepts only exact reviewed changes and stays byte-idempotent", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await recordGeneration(f.context)).blockers, []);
  f.plan.oldCommit = newCommit;
  f.plan.newCommit = newCommit;
  f.plan.changes = [];
  f.plan.reauthorGeneration = true;
  const name = prefix + "src/host-only.ts", content = bytes("export const local = 'reviewed-fix';\n");
  await put(f.root, name, content);
  assert.ok((await recordGeneration(f.context)).blockers.some((entry) => entry.code === "BLOCKED_UNAPPROVED_OUTPUT"));
  f.plan.approvedOutputHashes = { [name]: sha256(content) };
  assert.deepEqual((await recordGeneration(f.context)).blockers, []);
  assert.deepEqual((await verifyGeneration(f.context)).blockers, []);
  assert.deepEqual((await recordGeneration(f.context)).changedPaths, []);
});

test("derived review cannot authorize unrelated local output edits", async (t) => {
  const f = await fixture(t);
  f.plan.reviewedDerivedOutputs = [prefix + "src/host-only.ts"];
  await assert.rejects(recordGeneration(f.context), /not enrolled in CC fork policy/);
  assert.equal((await parsed(f.root, manifestPath)).commit, oldCommit);
});
