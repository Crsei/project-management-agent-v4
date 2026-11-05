import assert from "node:assert/strict";
import { appendFile, chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyPatch, encode, patchBytes, relative, repository, safePath, sha256, verifyOutputs } from "./provenance.mjs";
import { resourceClosure, tokenizeRust } from "./closure.mjs";

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
