import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyPatch, encode, externalHostOutputs, patchBytes, relative, repository, reviewedHostTransfers, safePath, sha256, verifyExternalHostOutputs, verifyOutputs } from "./provenance.mjs";
import { resourceClosure, tokenizeRust } from "./closure.mjs";
import { replayOutputs } from "./sync.mjs";
import { reviewedLocalRetirements } from "./retire-local.mjs";

const providerHostPaths = ["apps/server/agent/src/providers/t3code/management.ts", "packages/agent-contracts/src/provider.ts"];
const localHostPaths = [
  "apps/server/agent/src/app.ts",
  "apps/server/agent/src/maintenance/agent-backup.test.ts",
  "apps/server/agent/src/maintenance/agent-backup.ts",
  "apps/server/agent/src/providers/skills.test.ts",
  "apps/server/pm/src/app.ts",
  "apps/web/src/features/agent/src/app.tsx",
  "apps/web/src/features/agent/src/settings/settings-layout.tsx",
  "packages/agent-contracts/package.json",
];
const composerHostPath = "apps/web/src/features/agent/src/chat/provider-skills-composer.tsx";
const composerSourcePaths = [
  "apps/web/src/components/chat/ChatComposer.tsx",
  "apps/web/src/components/chat/useComposerMenuItems.ts",
  "apps/web/src/components/chat/useComposerCommandKey.ts",
  "apps/web/src/components/chat/SkillInlineText.tsx",
  "apps/web/src/components/chat/useProviderWorkspaceSnapshotRefresh.ts",
];
const hostPaths = [...providerHostPaths, ...localHostPaths, composerHostPath];
const ownerPath = "vendor/t3code/mcp-skills-adaptations.json";
const ownerManifestPath = "vendor/t3code/source-manifest.json", ownerInventoryPath = "vendor/t3code/sync-inventory.json";
const ownerSourcePath = "vendor/t3code/mcp-skills-source.json", ownerLicensePath = "vendor/t3code/LICENSE";
const baselineCommit = "30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c", supplementalCommit = "d53873b6a4799e87afd63c8d288ef0089f5a3748";
const hostReferences = hostPaths.map((path) => ({ path, owner: ownerPath }));
const blobHash = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

async function ownerGeneration(put) {
  const license = Buffer.from("Synthetic MIT license evidence.\n");
  const productionPaths = ["apps/server/src/provider/ProviderRegistry.ts", "packages/contracts/src/server.ts"];
  const originals = new Map([...productionPaths, ...composerSourcePaths].map((name, index) => [name, Buffer.from(`export const upstream${index} = ${index};\n// retained source line\n`)]));
  const sourceInput = (commit, name, bytes = originals.get(name)) => ({ commit, path: name, sha256: sha256(bytes), bytes: bytes.length, gitBlobSha1: blobHash(bytes), gitMode: "100644" });
  const productionInputs = productionPaths.map((name) => sourceInput(baselineCommit, name));
  const supplementalInputs = composerSourcePaths.map((name) => sourceInput(supplementalCommit, name));
  const productionRecord = (input) => ({ source_path: input.path, sha256: input.sha256, bytes: input.bytes, git_blob_sha1: input.gitBlobSha1, git_mode: input.gitMode });
  const supplementalRecord = (input) => ({ path: input.path, type: "blob", sha256: input.sha256, bytes: input.bytes, blob: input.gitBlobSha1, mode: input.gitMode });
  const manifest = { upstream: { commit: baselineCommit, distribution_license: { spdx: "MIT", path: "LICENSE" } }, files: [...productionInputs, sourceInput(baselineCommit, "LICENSE", license)].map(productionRecord) };
  const supplemental = { version: 1, upstream: { commit: supplementalCommit, existingVendorCommit: baselineCommit, license: { spdx: "MIT", path: "LICENSE", sha256: sha256(license) } }, files: [...supplementalInputs, sourceInput(supplementalCommit, "LICENSE", license)].map(supplementalRecord) };
  const owner = { version: 1, baselineCommit, sourceInventory: ownerSourcePath, baselineInventory: ownerInventoryPath, sources: [baselineCommit, supplementalCommit].map((commit) => ({ commit, role: "Reviewed synthetic source evidence", license: { spdx: "MIT", path: "LICENSE", distributedPath: ownerLicensePath, sha256: sha256(license) } })), outputs: [] };
  function output(destination, value) {
    const bytes = Buffer.from(value), local = localHostPaths.includes(destination);
    const inputs = local ? [] : destination === composerHostPath ? supplementalInputs : [productionInputs[providerHostPaths.indexOf(destination)]];
    const recipe = local ? { kind: "local-bytes", base64: bytes.toString("base64") } : { kind: "exact-line-splices", primaryInput: 0, splices: [{ start: 0, before: originals.get(inputs[0].path).toString().match(/[^\n]*\n|[^\n]+$/g), after: bytes.toString().match(/[^\n]*\n|[^\n]+$/g) ?? [] }] };
    return { destination, provenance: local ? "local-integration" : "adapted-upstream", reason: "Reviewed synthetic host integration", license: "MIT; existing repository terms", sha256: sha256(bytes), bytes: bytes.length, mode: 0o644, inputs: structuredClone(inputs), recipe };
  }
  async function save() {
    const records = [[ownerPath, encode(owner)], [ownerManifestPath, encode(manifest)], [ownerSourcePath, encode(supplemental)], [ownerLicensePath, license]];
    for (const [name, bytes] of records) await put(name, bytes);
    await put(ownerInventoryPath, encode({ version: 1, upstreamCommit: owner.baselineCommit, sourceManifestSha256: sha256(encode(manifest)), files: records.map(([destination, bytes]) => ({ destination, sha256: sha256(bytes), bytes: bytes.length, mode: 0o644 })) }));
  }
  async function update(destination, value) {
    const entry = output(destination, value), index = owner.outputs.findIndex((entry) => entry.destination === destination);
    if (index < 0) owner.outputs.push(entry); else owner.outputs[index] = entry;
    await put(destination, value);
    await save();
  }
  for (const destination of hostPaths) await update(destination, "export const host = 1;\n");
  return { owner, manifest, supplemental, originals, save, update };
}

test("exact byte patches preserve binary/CRLF data and reject wrong preimages or identities", () => {
  const before = Buffer.from([0, 13, 10, 31, 255, 9]), after = Buffer.from([0, 13, 10, 71, 0, 255, 9]);
  const bytes = patchBytes(before, after, "src/example.bin");
  const entry = { source: "src/example.bin", destination: "vendor/cc-switch/src/example.bin", upstreamSha256: sha256(before), sha256: sha256(after) };
  assert.deepEqual(applyPatch(before, bytes, entry), after);
  assert.deepEqual(patchBytes(before, after, "src/example.bin"), bytes);
  assert.throws(() => applyPatch(Buffer.from("wrong preimage"), bytes, entry), /identity/);
  assert.throws(() => applyPatch(before, bytes, { ...entry, sha256: "0".repeat(64) }), /identity/);
  const patch = JSON.parse(bytes); patch.start = before.length;
  assert.throws(() => applyPatch(before, encode(patch), entry), /preimage/);
});

test("provenance paths reject source escapes, platform aliases and special names", () => {
  for (const value of ["", "../outside", "a/../b", "./a", "a//b", "/absolute", "a\\b", "C:/source", "a\0b"]) assert.throws(() => relative(value), /Unsafe/);
  assert.equal(relative("vendor/cc-switch/src/mcp.ts"), "vendor/cc-switch/src/mcp.ts");
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "cc-switch-provenance-")));
  const put = async (name, bytes) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), bytes); };
  const commit = "1".repeat(40), source = Buffer.from("export const original = true;\n");
  const manifest = encode({ schemaVersion: 1, commit, selection: ["src"], files: [{ path: "src/example.ts", mode: "100644", blob: "2".repeat(40), sha256: sha256(source), bytes: source.length }] });
  const policy = encode({ version: 1, upstreamCommit: commit, sourceManifestSha256: sha256(manifest), generatedTrees: [] });
  const closure = encode({ version: 1, inputs: [] });
  const upstreamTree = encode({ version: 1, upstreamCommit: commit, paths: ["src/example.ts"] });
  const outputs = new Map([["vendor/cc-switch/source-manifest.json", manifest], ["vendor/cc-switch/fork-policy.json", policy], ["vendor/cc-switch/src/example.ts", source]]);
  for (const [name, bytes] of outputs) await put(name, bytes);
  await put("vendor/cc-switch/resource-closure.json", closure);
  await put("vendor/cc-switch/upstream-tree.json", upstreamTree);
  const patch = encode({ reviewed: true });
  await put("vendor/cc-switch/integration-patches/example.json", patch);
  const inventory = encode({ version: 1, upstreamCommit: commit, sourceManifestSha256: sha256(manifest), policySha256: sha256(policy), closureSha256: sha256(closure), upstreamTreeSha256: sha256(upstreamTree), hostBuildInputs: [], files: [...outputs].map(([destination, bytes]) => ({ destination, sha256: sha256(bytes), bytes: bytes.length, mode: 0o644 })), patches: [{ path: "vendor/cc-switch/integration-patches/example.json", sha256: sha256(patch) }] });
  await put("vendor/cc-switch/output-inventory.json", inventory);
  return { root, put, close: () => rm(root, { recursive: true, force: true }) };
}

test("checks reject unreviewed source/output/patch additions and changes", async () => {
  const f = await fixture();
  try {
    await verifyOutputs(f.root);
    await f.put("vendor/cc-switch/src/unknown.ts", Buffer.from("unreviewed"));
    await assert.rejects(verifyOutputs(f.root), /Unknown vendor output/);
    await rm(path.join(f.root, "vendor/cc-switch/src/unknown.ts"));
    await appendFile(path.join(f.root, "vendor/cc-switch/src/example.ts"), "unreviewed");
    await assert.rejects(verifyOutputs(f.root), /Unknown output change/);
  } finally { await f.close(); }
  const g = await fixture();
  try {
    await appendFile(path.join(g.root, "vendor/cc-switch/integration-patches/example.json"), " ");
    await assert.rejects(verifyOutputs(g.root), /Unknown patch change/);
  } finally { await g.close(); }
  const h = await fixture();
  try {
    await appendFile(path.join(h.root, "vendor/cc-switch/source-manifest.json"), " ");
    await assert.rejects(verifyOutputs(h.root), /Immutable/);
  } finally { await h.close(); }
});

test("local retirement requires a deleted host output and its intact reviewed preimage", async () => {
  const f = await fixture();
  const destination = "apps/web/obsolete.tsx", recipePath = "vendor/cc-switch/integration-patches/obsolete.json";
  const bytes = Buffer.from("export const obsolete = true;\n"), digest = sha256(bytes);
  const recipe = encode({ destination, sha256: digest, encoding: "base64", content: bytes.toString("base64") });
  const asset = { path: recipePath, sha256: sha256(recipe) };
  const entry = { destination, sha256: digest, provenance: "host-owned-integration", asset };
  const inventory = { files: [entry], patches: [asset] };
  const approval = new Map([[destination, digest]]);
  try {
    await f.put(destination, bytes); await f.put(recipePath, recipe);
    await assert.rejects(reviewedLocalRetirements(f.root, inventory, approval), /already-deleted/);
    await unlink(path.join(f.root, destination));
    assert.deepEqual([...await reviewedLocalRetirements(f.root, inventory, approval)], [destination]);
    await assert.rejects(reviewedLocalRetirements(f.root, inventory, new Map([[destination, "0".repeat(64)]])), /exact previous output hash/);
    await assert.rejects(reviewedLocalRetirements(f.root, inventory, approval, new Set([destination])), /Only host-owned/);
    await assert.rejects(reviewedLocalRetirements(f.root, { ...inventory, files: [{ ...entry, source: "src/original.tsx" }] }, approval), /Only host-owned/);
    await f.put(recipePath, Buffer.from("tampered"));
    await assert.rejects(reviewedLocalRetirements(f.root, inventory, approval), /recipe changed/);
    const vendor = "vendor/cc-switch/scripts/guard.mjs";
    await assert.rejects(reviewedLocalRetirements(f.root, { files: [{ ...entry, destination: vendor }], patches: [asset] }, new Map([[vendor, digest]])), /Only host-owned/);
  } finally { await f.close(); }
});

test("output special modes and ancestor file aliases are refused", async () => {
  const f = await fixture();
  try {
    await f.put("not-a-directory", Buffer.from("owned"));
    await assert.rejects(safePath(f.root, "not-a-directory/file"), /Unsafe provenance ancestor/);
    if (process.platform !== "win32") {
      await chmod(path.join(f.root, "vendor/cc-switch/src/example.ts"), 0o4644);
      await assert.rejects(verifyOutputs(f.root), /Unsafe provenance file/);
    }
  } finally { await f.close(); }
});

test("reachable Rust modules/includes and TS/CSS resources close without the desktop/test graph", async () => {
  const root = await realpath(await mkdtemp(path.join(repository, ".tmp-cc-switch-closure-")));
  try {
    const files = {
      "package.json": "{}",
      "rust/Cargo.toml": '[package]\nname="fixture"\nversion="0.1.0"\n',
      "rust/schema.sql": "CREATE TABLE synthetic(id INTEGER);",
      "rust/shared.rs": "pub const SHARED: bool = true;",
      "rust/src/lib.rs": '#[path="../shared.rs"] mod shared;\n#[cfg(not(feature="headless"))] mod desktop;\n#[cfg(test)] mod absent_test;\nconst SCHEMA: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/schema.sql"));\n',
      "src/main.ts": 'import "./style.css"; export {value} from "./child"; const asset = new URL("./asset.svg", import.meta.url);',
      "src/child.ts": "export const value = true;",
      "src/style.css": 'body { background-image:url("./asset.svg"); }',
      "src/asset.svg": "<svg/>",
    };
    for (const [name, bytes] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), bytes);
    }
    const policy = { upstreamCommit: "1".repeat(40), productionRoots: ["rust/Cargo.toml", "src/main.ts"], rustFeatures: ["headless"], dynamicResources: [], sourceReferenceDocuments: [] };
    const closure = JSON.parse(await resourceClosure(root, policy, Object.keys(files).map(destination => ({ destination })), []));
    for (const name of ["rust/shared.rs", "rust/schema.sql", "src/asset.svg", "src/child.ts", "src/style.css"]) assert.ok(closure.inputs.some(entry => entry.path === name), name);
    assert.equal(closure.inputs.some(entry => /desktop|absent_test/.test(entry.path)), false);
    await writeFile(path.join(root, "src/main.ts"), 'const modulePath = "./child.ts"; import(modulePath);');
    await assert.rejects(resourceClosure(root, policy, Object.keys(files).map(destination => ({ destination })), []), /Unreviewed computed/);
    policy.dynamicResources.push({ source: "src/main.ts", expression: "modulePath", kind: "ts-dynamic-import", targets: ["src/child.ts"], reason: "Exact fixture target, not a runtime wildcard." });
    const reviewed = JSON.parse(await resourceClosure(root, policy, Object.keys(files).map(destination => ({ destination })), []));
    assert.ok(reviewed.inputs.some(entry => entry.path === "src/child.ts"));
    await writeFile(path.join(root, "src/main.ts"), 'import "./missing.ts";');
    await assert.rejects(resourceClosure(root, policy, Object.keys(files).map(destination => ({ destination })), []), /Unresolved production resource/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the production Skills DAO's ordinary multiline SQL is a valid Rust string token", async () => {
  const source = "vendor/cc-switch/src-tauri/src/database/dao/skills.rs";
  const text = await readFile(path.join(repository, source), "utf8");
  const tokens = tokenizeRust(source, text);
  const query = tokens.find(token => token.string && token.value.startsWith("SELECT id, name, description, directory,"));
  assert.ok(query);
  assert.equal(query.literalKind, "str");
  assert.ok(query.value.includes("\n"));
  assert.ok(query.value.includes("FROM skills ORDER BY name ASC"));
});

test("Rust attribute paths, multiline text and escape decoding preserve literal backslashes", () => {
  const slash = "\\";
  const text = [
    '#[path = "..\\u{2f}child.rs"] mod child;',
    "const escaped = \"quote:\\\" apostrophe:\\' slash:\\\\ nul:\\0 tab:\\t ascii:\\x41 unicode:\\u{1_f6_00} literal:\\\\u{41}\\\\x41\\\\0\";",
    'const multiline = "first\n\tsecond";',
    'const continued = "left' + slash + '\n    right";',
    'const raw = r###"raw "## \\0 \\u{41}"###;',
    'const bytes = b"\\x80\\xFF\\0";',
    'const raw_bytes = br#"raw\\0"#;',
    'const c_string = c"hello\\u{21}\\x7f";',
    'const raw_c_string = cr#"raw\\0"#;',
    "fn borrowed<'a>(value: &'a str) { let scalar = '\\u{1_f6_00}'; let brace = '}'; let byte = b'\\xff'; }",
  ].join("\n");
  const strings = tokenizeRust("fixture.rs", text).filter(token => token.string);
  assert.deepEqual(strings.map(token => token.value), [
    "../child.rs",
    'quote:" apostrophe:\' slash:\\ nul:\0 tab:\t ascii:A unicode:😀 literal:\\u{41}\\x41\\0',
    "first\n\tsecond",
    "leftright",
    'raw "## \\0 \\u{41}',
    "\x80\xff\0",
    "raw\\0",
    "hello!\x7f",
    "raw\\0",
  ]);
  assert.deepEqual(strings.map(token => token.literalKind), ["str", "str", "str", "str", "str", "byte", "byte", "c", "c"]);
  const crlf = tokenizeRust("crlf.rs", 'const multiline = "first\r\nsecond"; const continued = "left\\\r\n \t\r\n right";');
  assert.deepEqual(crlf.filter(token => token.string).map(token => token.value), ["first\nsecond", "leftright"]);
});

test("invalid Rust literal syntax reports the source, line and column without dumping the literal", () => {
  assert.throws(() => tokenizeRust("fixture.rs", '\n"\\q"'), { message: /^fixture\.rs:2:2: / });
  assert.throws(() => tokenizeRust("private.rs", '"source-body-marker\\q"'), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^private\.rs:1:\d+: /);
    assert.equal(error.message.includes("source-body-marker"), false);
    return true;
  });
  for (const text of ['"\\u{d800}"', '"\\u{110000}"', '"\\u{_41}"', '"\\xFF"', 'b"\\u{41}"', 'c"\\0"', 'r##"unclosed', "/* unclosed"]) {
    assert.throws(() => tokenizeRust("invalid.rs", text), { message: /^invalid\.rs:\d+:\d+: / });
  }
});

test("external owners require registered evidence, exact recipes and the actual output mode", async () => {
  const f = await fixture(), policy = { externalHostOutputs: hostReferences };
  try {
    const owner = await ownerGeneration(f.put);
    const initial = await verifyExternalHostOutputs(f.root, policy);
    assert.deepEqual(initial.inputs.map((entry) => entry.path), hostPaths);
    assert.equal(hostPaths.length, 11);
    assert.deepEqual(initial.metadata.map((entry) => entry.path), [ownerPath, ownerManifestPath, ownerInventoryPath, ownerSourcePath, ownerLicensePath]);
    for (const destination of [...localHostPaths, composerHostPath]) {
      await owner.update(destination, "export const independentlyUpdated = true;\n");
      const updated = (await verifyExternalHostOutputs(f.root, policy)).inputs.find((entry) => entry.path === destination);
      assert.notEqual(updated.sha256, initial.inputs.find((entry) => entry.path === destination).sha256);
    }
    await owner.update(hostPaths[0], "export const host = 2;\n");
    assert.notEqual((await verifyExternalHostOutputs(f.root, policy)).inputs[0].sha256, initial.inputs[0].sha256);
    await f.put(hostPaths[0], "export const forged = 3;\n");
    await assert.rejects(verifyExternalHostOutputs(f.root, policy), /differs from owner generation/);
    // Updating only an owner's hash/size is not a generation: the exact recipe
    // must still reconstruct the registered immutable source.
    owner.owner.outputs[0].sha256 = sha256(Buffer.from("export const forged = 3;\n"));
    owner.owner.outputs[0].bytes = Buffer.byteLength("export const forged = 3;\n");
    await owner.save();
    await assert.rejects(verifyExternalHostOutputs(f.root, policy), /recipe postimage mismatch/);
    await owner.update(hostPaths[0], "export const host = 2;\n");
    if (process.platform !== "win32") {
      await chmod(path.join(f.root, hostPaths[0]), 0o755);
      await assert.rejects(verifyExternalHostOutputs(f.root, policy), /differs from owner generation/);
      await chmod(path.join(f.root, hostPaths[0]), 0o644);
    }
    await unlink(path.join(f.root, hostPaths[0]));
    await symlink(path.join(f.root, hostPaths[1]), path.join(f.root, hostPaths[0]));
    await assert.rejects(verifyExternalHostOutputs(f.root, policy), /Unsafe provenance/);
  } finally { await f.close(); }
});

test("coherent modern owner generations remain pin-neutral while shared inputs require registered originals", async () => {
  const f = await fixture(), policy = { externalHostOutputs: hostReferences };
  try {
    const owner = await ownerGeneration(f.put), nextBaseline = "a".repeat(40), nextSupplement = "b".repeat(40);
    owner.owner.baselineCommit = nextBaseline;
    owner.manifest.upstream.commit = nextBaseline;
    owner.supplemental.upstream.commit = nextSupplement;
    // existingVendorCommit is historical capture context, not the current pin.
    for (const source of owner.owner.sources) source.commit = source.commit === baselineCommit ? nextBaseline : nextSupplement;
    for (const entry of owner.owner.outputs) for (const input of entry.inputs) input.commit = input.commit === baselineCommit ? nextBaseline : nextSupplement;
    await owner.save();
    assert.equal((await verifyExternalHostOutputs(f.root, policy)).inputs.length, 11);
    const license = owner.manifest.files.find((entry) => entry.source_path === "LICENSE");
    const historical = { commit: baselineCommit, role: "Retained historical generation license", license: { spdx: "MIT", path: "LICENSE", distributedPath: ownerLicensePath, sha256: license.sha256, bytes: license.bytes, gitBlobSha1: license.git_blob_sha1, gitMode: license.git_mode } };
    owner.owner.sources.push(historical);
    await owner.save();
    assert.equal((await verifyExternalHostOutputs(f.root, policy)).inputs.length, 11);
    historical.license.bytes++;
    await owner.save();
    await assert.rejects(verifyExternalHostOutputs(f.root, policy), /Unregistered external owner source license/);
    historical.license.bytes--;
    owner.owner.outputs[0].inputs[0].commit = baselineCommit;
    await owner.save();
    await assert.rejects(verifyExternalHostOutputs(f.root, policy), /Unregistered external owner source/);
  } finally { await f.close(); }
});

test("derived recipes reconstruct the exact primary source and replay real line boundaries", async () => {
  const f = await fixture(), policy = { externalHostOutputs: hostReferences };
  try {
    const owner = await ownerGeneration(f.put), destination = providerHostPaths[0];
    const entry = owner.owner.outputs[0], original = owner.originals.get(entry.inputs[0].path).toString();
    const output = `// host prefix\n${original}// host suffix\n`;
    await owner.update(destination, output);
    const current = owner.owner.outputs[0];
    current.recipe.splices = [{ start: 0, before: [], after: ["// host prefix\n"] }, { start: 2, before: [], after: ["// host suffix\n"] }];
    await owner.save();
    await verifyExternalHostOutputs(f.root, policy);
    current.recipe.splices = [{ start: 0, before: [original], after: output.match(/[^\n]*\n|[^\n]+$/g) }];
    await owner.save();
    await assert.rejects(verifyExternalHostOutputs(f.root, policy), /recipe preimage mismatch/);
    await owner.update(destination, Buffer.from([0xff, 0x0a]));
    await assert.rejects(verifyExternalHostOutputs(f.root, policy), /recipe postimage mismatch/);
  } finally { await f.close(); }
});

test("local host owners authenticate zero-input canonical recipes, including binary and empty outputs", async () => {
  const f = await fixture(), policy = { externalHostOutputs: hostReferences.filter((entry) => localHostPaths.includes(entry.path)) };
  try {
    const owner = await ownerGeneration(f.put), destination = localHostPaths[0];
    await owner.update(destination, Buffer.from([0, 255, 13, 10, 128]));
    await owner.update(localHostPaths[1], Buffer.alloc(0));
    assert.equal((await verifyExternalHostOutputs(f.root, policy)).inputs.length, 8);
    const accepted = structuredClone(owner.owner.outputs);
    for (const mutate of [
      (entry) => { entry.recipe.base64 += "\n"; },
      (entry) => { entry.recipe.base64 = Buffer.from("different bytes").toString("base64"); },
      (entry) => { delete entry.recipe.base64; },
      (entry) => { entry.recipe.kind = "exact-line-splices"; },
      (entry) => { entry.inputs = [owner.owner.outputs[0].inputs[0]]; },
      (entry) => { entry.provenance = "adapted-upstream"; },
      (entry) => { entry.retirement = { sha256: entry.sha256, reason: "Retired records cannot own live outputs" }; },
      (entry) => { entry.sha256 = "0".repeat(64); },
      (entry) => { entry.bytes++; },
      (entry) => { entry.mode = 0o755; },
      (entry) => { entry.reason = " "; },
      (entry) => { entry.license = ""; },
    ]) {
      owner.owner.outputs = structuredClone(accepted);
      mutate(owner.owner.outputs.find((entry) => entry.destination === destination));
      await owner.save();
      await assert.rejects(verifyExternalHostOutputs(f.root, policy), /external (?:owner|host owner)|differs from owner generation/i);
    }
    owner.owner.outputs = accepted;
    await owner.save();
    assert.equal((await verifyExternalHostOutputs(f.root, policy)).inputs.length, 8);
  } finally { await f.close(); }
});

test("derived host owners authenticate every original against its matching production or supplemental evidence", async () => {
  const f = await fixture(), policy = { externalHostOutputs: hostReferences };
  try {
    const owner = await ownerGeneration(f.put), accepted = structuredClone(owner.owner.outputs);
    const composer = accepted.find((entry) => entry.destination === composerHostPath);
    assert.equal(composer.inputs.length, 5);
    assert.ok(composer.inputs.every((entry) => entry.commit === supplementalCommit));
    for (const destination of [...providerHostPaths, composerHostPath]) {
      const original = accepted.find((entry) => entry.destination === destination);
      for (let index = 0; index < original.inputs.length; index++) {
        for (const [field, value] of [["sha256", "0".repeat(64)], ["bytes", original.inputs[index].bytes + 1], ["gitBlobSha1", "0".repeat(40)], ["gitMode", "100755"], ["commit", "f".repeat(40)], ["path", "unregistered.ts"]]) {
          owner.owner.outputs = structuredClone(accepted);
          owner.owner.outputs.find((entry) => entry.destination === destination).inputs[index][field] = value;
          await owner.save();
          await assert.rejects(verifyExternalHostOutputs(f.root, policy), /Unregistered external owner source/);
        }
      }
    }
    for (const mutate of [
      (entry) => { entry.inputs.pop(); },
      (entry) => { entry.inputs.push(structuredClone(entry.inputs[0])); },
      (entry) => { entry.inputs[1] = structuredClone(entry.inputs[0]); },
      (entry) => { entry.inputs[0].commit = baselineCommit; },
      (entry) => { entry.recipe.primaryInput = 1; },
      (entry) => { entry.recipe.splices[0].before[0] = "forged source line\n"; },
      (entry) => { entry.recipe.splices[0].after[0] = "forged output line\n"; },
      (entry) => { entry.recipe.splices[0].start = -1; },
      (entry) => { entry.recipe.splices[0].before = null; },
      (entry) => { entry.recipe.splices.push(null); },
      (entry) => { entry.retirement = null; },
    ]) {
      owner.owner.outputs = structuredClone(accepted);
      mutate(owner.owner.outputs.find((entry) => entry.destination === composerHostPath));
      await owner.save();
      await assert.rejects(verifyExternalHostOutputs(f.root, policy), /external (?:owner|host owner)/i);
    }
    owner.owner.outputs = structuredClone(accepted);
    owner.owner.outputs[0].inputs.push(structuredClone(owner.owner.outputs[0].inputs[0]));
    await owner.save();
    await assert.rejects(verifyExternalHostOutputs(f.root, policy), /Unregistered external owner source/);
    owner.owner.outputs = accepted;
    await owner.save();
    assert.equal((await verifyExternalHostOutputs(f.root, policy)).inputs.length, 11);
  } finally { await f.close(); }
});

test("both ownership classes require complete registered source and license evidence, never partial absence", async () => {
  const f = await fixture(), policy = { externalHostOutputs: hostReferences };
  const evidence = [ownerPath, ownerManifestPath, ownerInventoryPath, ownerSourcePath, ownerLicensePath];
  const localPolicy = { externalHostOutputs: hostReferences.filter((entry) => localHostPaths.includes(entry.path)) };
  try {
    assert.deepEqual((await verifyExternalHostOutputs(f.root, policy, { allowAbsent: true })).inputs, []);
    await assert.rejects(verifyExternalHostOutputs(f.root, policy), { code: "ENOENT" });
    for (const name of [...hostPaths, ...evidence]) {
      await f.put(name, "{}");
      await assert.rejects(verifyExternalHostOutputs(f.root, policy, { allowAbsent: true }));
      await unlink(path.join(f.root, name));
    }
    const owner = await ownerGeneration(f.put);
    for (const name of evidence) {
      await unlink(path.join(f.root, name));
      for (const current of [policy, localPolicy]) await assert.rejects(verifyExternalHostOutputs(f.root, current, { allowAbsent: true }), { code: "ENOENT" });
      await owner.save();
      if (name !== ownerInventoryPath) {
        await appendFile(path.join(f.root, name), " ");
        for (const current of [policy, localPolicy]) await assert.rejects(verifyExternalHostOutputs(f.root, current), /Unregistered external owner evidence|Invalid external host owner generation/);
        await owner.save();
      }
      if (process.platform !== "win32") {
        await chmod(path.join(f.root, name), 0o755);
        for (const current of [policy, localPolicy]) await assert.rejects(verifyExternalHostOutputs(f.root, current), /Invalid external owner evidence mode/);
        await chmod(path.join(f.root, name), 0o644);
      }
    }
    const acceptedOwner = structuredClone(owner.owner), acceptedManifest = structuredClone(owner.manifest), acceptedSupplemental = structuredClone(owner.supplemental);
    for (const mutate of [
      () => { owner.owner.baselineCommit = "f".repeat(40); },
      () => { owner.owner.sourceInventory = "vendor/t3code/unknown.json"; },
      () => { owner.manifest.upstream.commit = supplementalCommit; },
      () => { owner.supplemental.upstream.commit = baselineCommit; },
      () => { owner.supplemental.upstream.commit = "not-a-commit"; },
      () => { owner.owner.sources.pop(); },
      () => { owner.owner.sources.push(structuredClone(owner.owner.sources[0])); },
      () => { owner.owner.sources[0].commit = "f".repeat(40); },
      () => { owner.owner.sources[0].license.sha256 = "0".repeat(64); },
      () => { delete owner.owner.sources[1].license; },
      () => { owner.manifest.files.find((entry) => entry.source_path === "LICENSE").git_blob_sha1 = "0".repeat(40); },
      () => { owner.supplemental.upstream.license.sha256 = "0".repeat(64); },
      () => { owner.supplemental.files.find((entry) => entry.path === "LICENSE").mode = "100755"; },
      () => { owner.manifest.files[0].sha256 = "0".repeat(64); },
      () => { owner.supplemental.files[4].sha256 = "0".repeat(64); },
      () => { owner.manifest.files.push(structuredClone(owner.manifest.files[0])); },
      () => { owner.supplemental.files.push(structuredClone(owner.supplemental.files[0])); },
    ]) {
      mutate();
      await owner.save();
      await assert.rejects(verifyExternalHostOutputs(f.root, policy), /external (?:owner|host owner)/i);
      Object.assign(owner.owner, structuredClone(acceptedOwner));
      Object.assign(owner.manifest, structuredClone(acceptedManifest));
      Object.assign(owner.supplemental, structuredClone(acceptedSupplemental));
    }
    await owner.save();
    const inventory = JSON.parse(await readFile(path.join(f.root, ownerInventoryPath)));
    for (const mutate of [
      (value) => { value.files[0].sha256 = "0".repeat(64); },
      (value) => { value.files[0].bytes++; },
      (value) => { value.files[0].mode = 0o755; },
      (value) => { value.files.push(structuredClone(value.files[0])); },
      (value) => { value.files.push({ destination: localHostPaths[0] }); },
    ]) {
      const changed = structuredClone(inventory);
      mutate(changed);
      await f.put(ownerInventoryPath, encode(changed));
      await assert.rejects(verifyExternalHostOutputs(f.root, policy), /Unregistered external owner evidence|Invalid external host owner output/);
    }
    await owner.save();
    await unlink(path.join(f.root, localHostPaths[0]));
    await assert.rejects(verifyExternalHostOutputs(f.root, policy, { allowAbsent: true }), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("unknown owners, duplicate registration and CC byte snapshots cannot authorize external outputs", async () => {
  const f = await fixture(), policy = { externalHostOutputs: hostReferences };
  try {
    const owner = await ownerGeneration(f.put);
    for (const references of [[{ ...hostReferences[0], owner: "vendor/forged/outputs.json" }], [{ path: "apps/other.ts", owner: ownerPath }], [{ path: `${localHostPaths[0]}.other`, owner: ownerPath }], [hostReferences[0], hostReferences[0]], [{ ...hostReferences[0], sha256: "0".repeat(64) }], [null]]) {
      await assert.rejects(verifyExternalHostOutputs(f.root, { externalHostOutputs: references }), /Invalid external host output owner/);
    }
    for (const name of hostPaths) {
      for (const extra of [{ files: [{ destination: name }] }, { hostBuildInputs: [{ path: name }] }, { patches: [{ path: `vendor/cc-switch/integration-patches/local/${name}.json` }] }]) {
        assert.throws(() => externalHostOutputs(policy, { externalHostOutputs: hostReferences, ...extra }), /cannot be replayed or fingerprinted|Retired external host recipe/);
      }
      for (const conflict of [{ hostBuildInputs: [name] }, { derivedOutputs: [{ destination: name }] }]) {
        assert.throws(() => externalHostOutputs({ ...policy, ...conflict }), /cannot be replayed or fingerprinted/);
      }
      for (const closure of [{ inputs: [{ path: name }] }, { hostIntegrationOutputs: [name] }, { snapshotOnly: [name] }]) {
        assert.throws(() => externalHostOutputs(policy, { externalHostOutputs: hostReferences }, closure), /cannot be replayed or fingerprinted/);
      }
    }
    assert.throws(() => externalHostOutputs(policy, { externalHostOutputs: hostReferences.slice(1) }), /enrollment changed/);
    const entry = owner.owner.outputs[0];
    entry.provenance = "local-integration";
    await owner.save();
    await assert.rejects(verifyExternalHostOutputs(f.root, policy), /Invalid external host owner output/);
    entry.provenance = "adapted-upstream";
    owner.owner.outputs.push(entry);
    await owner.save();
    await assert.rejects(verifyExternalHostOutputs(f.root, policy), /Invalid external host owner output/);
    owner.owner.outputs.pop();
    entry.inputs[0].sha256 = "0".repeat(64);
    await owner.save();
    await assert.rejects(verifyExternalHostOutputs(f.root, policy), /Unregistered external owner source/);
    await owner.update(hostPaths[0], "export const host = 1;\n");
    await appendFile(path.join(f.root, ownerPath), " ");
    await assert.rejects(verifyExternalHostOutputs(f.root, policy), /Unregistered external owner evidence/);
  } finally { await f.close(); }
});

test("reviewed transfer retires only the exact unchanged local recipe and cannot bless dirty bytes", async () => {
  const f = await fixture(), policy = { externalHostOutputs: hostReferences };
  try {
    await ownerGeneration(f.put);
    const destination = hostPaths[0], bytes = await readFile(path.join(f.root, destination));
    const assetPath = `vendor/cc-switch/integration-patches/local/${destination}.json`;
    const asset = encode({ version: 1, destination, encoding: "base64", content: bytes.toString("base64"), sha256: sha256(bytes), mode: 0o644 });
    await f.put(assetPath, asset);
    const recipe = { path: assetPath, sha256: sha256(asset) };
    const previous = { files: [{ destination, provenance: "host-owned-integration", sha256: sha256(bytes), bytes: bytes.length, mode: 0o644, asset: recipe }], patches: [recipe] };
    await assert.rejects(reviewedHostTransfers(f.root, policy, previous), /requires --transfer-host-output/);
    await assert.rejects(reviewedHostTransfers(f.root, policy, previous, new Map([[destination, "0".repeat(64)]])), /requires --transfer-host-output/);
    const approval = new Map([[destination, recipe.sha256]]);
    assert.deepEqual([...(await reviewedHostTransfers(f.root, policy, previous, approval)).retired], [destination]);
    await assert.rejects(reviewedHostTransfers(f.root, policy, previous, new Map([["apps/unrelated.ts", recipe.sha256]])), /Unenrolled host ownership transfer/);
    await appendFile(path.join(f.root, assetPath), " ");
    await assert.rejects(reviewedHostTransfers(f.root, policy, previous, approval), /preimage differs/);
  } finally { await f.close(); }
});

test("all nine additional transfers require individual old-asset approvals and intact exclusive CC ownership", async () => {
  const f = await fixture(), policy = { externalHostOutputs: hostReferences };
  try {
    const owner = await ownerGeneration(f.put), destinations = [...localHostPaths, composerHostPath];
    const previous = { externalHostOutputs: hostReferences.filter((entry) => providerHostPaths.includes(entry.path)), files: [], patches: [] }, approvals = new Map();
    for (const destination of destinations) {
      const bytes = await readFile(path.join(f.root, destination)), assetPath = `vendor/cc-switch/integration-patches/local/${destination}.json`;
      const assetBytes = encode({ version: 1, destination, encoding: "base64", content: bytes.toString("base64"), sha256: sha256(bytes), mode: 0o644 });
      const asset = { path: assetPath, sha256: sha256(assetBytes) };
      await f.put(assetPath, assetBytes);
      previous.files.push({ destination, provenance: "host-owned-integration", sha256: sha256(bytes), bytes: bytes.length, mode: 0o644, asset });
      previous.patches.push(asset);
      approvals.set(destination, asset.sha256);
    }
    for (const destination of destinations) {
      const missing = new Map(approvals);
      missing.delete(destination);
      await assert.rejects(reviewedHostTransfers(f.root, policy, previous, missing), /requires --transfer-host-output/);
      missing.set(destination, previous.files.find((entry) => entry.destination === destination).sha256);
      await assert.rejects(reviewedHostTransfers(f.root, policy, previous, missing), /requires --transfer-host-output/);
    }
    assert.deepEqual([...(await reviewedHostTransfers(f.root, policy, previous, approvals)).retired], destinations);
    for (const mutate of [
      (value) => { value.files.push(structuredClone(value.files[0])); },
      (value) => { value.patches.push(structuredClone(value.patches[0])); },
      (value) => { value.patches.push({ ...value.patches[0], sha256: "0".repeat(64) }); },
      (value) => { value.files[0].source = ""; },
      (value) => { value.files[0].patch = null; },
      (value) => { value.files[0].retirement = null; },
      (value) => { value.files[0].provenance = "patched-upstream"; },
      (value) => { value.files[0].asset.path = "vendor/cc-switch/integration-patches/unknown.json"; },
      (value) => { value.files[0].bytes++; },
      (value) => { value.files[0].mode = 0o755; },
      (value) => { value.externalHostOutputs.push({ path: destinations[0], owner: ownerPath }); },
    ]) {
      const changed = structuredClone(previous);
      mutate(changed);
      await assert.rejects(reviewedHostTransfers(f.root, policy, changed, approvals), /requires --transfer-host-output|preimage differs/);
    }
    const destination = destinations[0], assetPath = previous.files[0].asset.path;
    const assetBytes = await readFile(path.join(f.root, assetPath)), asset = JSON.parse(assetBytes);
    for (const content of [`${asset.content}\n`, null, Buffer.from("different content").toString("base64")]) {
      const bytes = encode({ ...asset, content }), changed = structuredClone(previous), approved = new Map(approvals);
      changed.files[0].asset.sha256 = sha256(bytes);
      changed.patches[0].sha256 = sha256(bytes);
      approved.set(destination, sha256(bytes));
      await f.put(assetPath, bytes);
      await assert.rejects(reviewedHostTransfers(f.root, policy, changed, approved), /preimage differs/);
    }
    await f.put(assetPath, assetBytes);
    if (process.platform !== "win32") {
      await chmod(path.join(f.root, assetPath), 0o755);
      await assert.rejects(reviewedHostTransfers(f.root, policy, previous, approvals), /preimage differs/);
      await chmod(path.join(f.root, assetPath), 0o644);
    }
    await owner.update(composerHostPath, "export const independentlyChanged = true;\n");
    await assert.rejects(reviewedHostTransfers(f.root, policy, previous, approvals), /preimage differs/);
    await assert.rejects(reviewedHostTransfers(f.root, policy, null, approvals), /no replay ownership to transfer/);
  } finally { await f.close(); }
});

test("standalone CC replay never installs host outputs and checks an independently updated destination owner", async (t) => {
  const root = await mkdtemp(path.join(repository, ".tmp-cc-replay-"));
  const source = await mkdtemp(path.join(tmpdir(), "cc-replay-source-"));
  const destination = await mkdtemp(path.join(tmpdir(), "cc-replay-destination-"));
  t.after(() => Promise.all([root, source, destination].map((name) => rm(name, { recursive: true, force: true }))));
  const put = async (name, content) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), content); };
  const putDestination = async (name, content) => { await mkdir(path.dirname(path.join(destination, name)), { recursive: true }); await writeFile(path.join(destination, name), content); };
  const original = Buffer.from("export const upstream = true;\n");
  await mkdir(path.join(source, "src"));
  await writeFile(path.join(source, "src/example.ts"), original);
  const git = (args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  git(["init", "--quiet"]);
  git(["add", "src/example.ts"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
  const commit = git(["rev-parse", "HEAD"]).trim();
  const manifest = encode({ schemaVersion: 1, commit, selection: ["src"], files: [{ path: "src/example.ts", mode: "100644", blob: blobHash(original), sha256: sha256(original), bytes: original.length }] });
  const policy = { version: 1, upstreamCommit: commit, sourceManifestSha256: sha256(manifest), productionRoots: [], generatedTrees: [], externalHostOutputs: hostReferences };
  const files = [{ destination: "vendor/cc-switch/src/example.ts", source: "src/example.ts", upstreamSha256: sha256(original), sha256: sha256(original), bytes: original.length, mode: 0o644 }], patches = [];
  await put(files[0].destination, original);
  for (const [name, content] of [["vendor/cc-switch/source-manifest.json", manifest], ["vendor/cc-switch/fork-policy.json", encode(policy)]]) {
    await put(name, content);
    const assetPath = `vendor/cc-switch/integration-patches/local/${name}.json`;
    const asset = encode({ version: 1, destination: name, sha256: sha256(content), mode: 0o644, encoding: "base64", content: content.toString("base64") });
    const recipe = { path: assetPath, sha256: sha256(asset) };
    await put(assetPath, asset);
    files.push({ destination: name, sha256: sha256(content), bytes: content.length, mode: 0o644, asset: recipe });
    patches.push(recipe);
  }
  const closure = await resourceClosure(root, policy, files, ["src/example.ts"]);
  const tree = encode({ version: 1, upstreamCommit: commit, paths: ["src/example.ts"] });
  await put("vendor/cc-switch/resource-closure.json", closure);
  await put("vendor/cc-switch/upstream-tree.json", tree);
  await put("vendor/cc-switch/output-inventory.json", encode({ version: 1, upstreamCommit: commit, sourceManifestSha256: sha256(manifest), policySha256: sha256(encode(policy)), closureSha256: sha256(closure), upstreamTreeSha256: sha256(tree), hostBuildInputs: [], externalHostOutputs: hostReferences, files, patches }));
  await assert.rejects(verifyOutputs(root), { code: "ENOENT" });
  const first = await replayOutputs({ root, source, destination });
  assert.ok(first.created > 0);
  for (const name of [...hostPaths, ownerPath, ownerManifestPath, ownerInventoryPath, ownerSourcePath, ownerLicensePath]) await assert.rejects(readFile(path.join(destination, name)), { code: "ENOENT" });
  assert.equal((await replayOutputs({ root, source, destination, check: true })).created, 0);
  const owner = await ownerGeneration(putDestination);
  await owner.update(hostPaths[0], "export const independentlyUpdated = true;\n");
  await owner.update(localHostPaths[0], "export const independentlyUpdatedLocal = true;\n");
  await owner.update(composerHostPath, "export const independentlyUpdatedSupplemental = true;\n");
  assert.equal((await replayOutputs({ root, source, destination })).created, 0);
  assert.equal(await readFile(path.join(destination, localHostPaths[0]), "utf8"), "export const independentlyUpdatedLocal = true;\n");
  assert.equal(await readFile(path.join(destination, composerHostPath), "utf8"), "export const independentlyUpdatedSupplemental = true;\n");
  await putDestination(hostPaths[0], "export const unreviewed = true;\n");
  await unlink(path.join(destination, files[0].destination));
  await assert.rejects(replayOutputs({ root, source, destination }), /differs from owner generation/);
  await assert.rejects(readFile(path.join(destination, files[0].destination)), { code: "ENOENT" });
  await owner.update(hostPaths[0], "export const independentlyUpdated = true;\n");
  await appendFile(path.join(destination, ownerSourcePath), " ");
  await assert.rejects(replayOutputs({ root, source, destination }), /Unregistered external owner evidence/);
  await assert.rejects(readFile(path.join(destination, files[0].destination)), { code: "ENOENT" });
  await owner.save();
  assert.equal((await replayOutputs({ root, source, destination })).created, 1);
  await putDestination(files[0].destination, "conflicting CC output\n");
  await assert.rejects(replayOutputs({ root, source, destination }), /Destination conflict/);
});
