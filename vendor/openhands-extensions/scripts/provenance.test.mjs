import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { applyPatch, outputPath, patchBytes, prefix, registryFiles, sha256 } from "./provenance.mjs";

function archive(entries) {
  const blocks = [];
  for (const [name, content, kind = "0", mode = 0o644] of entries) {
    const bytes = Buffer.from(content), header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    const number = (value, offset, length) => header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
    number(mode, 100, 8); number(0, 108, 8); number(0, 116, 8); number(bytes.length, 124, 12); number(0, 136, 12);
    header.fill(32, 148, 156); header.write(kind, 156); header.write("ustar\0", 257);
    const sum = header.reduce((total, value) => total + value, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]), { mtime: 0 });
}
function fixture(extra = []) {
  const members = [
    ["package/LICENSE", "MIT License\nCopyright (c) 2025 OpenHands\n"],
    ["package/package.json", JSON.stringify({ name: "@openhands/extensions", version: "0.36.0", license: "MIT", repository: { url: "https://github.com/OpenHands/extensions" } })],
    ["package/integrations/index.js", "export const catalog = [];\n"],
  ];
  const bytes = archive([...members, ...extra]);
  const manifest = { extensions: { name: "@openhands/extensions", version: "0.36.0", integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` }, files: members.map(([name, text]) => ({ origin: "extensions-npm", source: name.slice(8), destination: name.slice(8) === "package.json" ? "extensions/source-package.json" : `extensions/${name.slice(8)}`, mode: 0o644, sha256: sha256(Buffer.from(text)), bytes: Buffer.byteLength(text) })) };
  return { bytes, manifest };
}
test("npm integrity and exact selected original bytes are independent of Git", () => {
  const { bytes, manifest } = fixture();
  assert.equal(registryFiles(bytes, manifest).get("integrations/index.js").bytes.toString(), "export const catalog = [];\n");
  assert.throws(() => registryFiles(Buffer.concat([bytes, Buffer.from("tampered")]), manifest), /integrity mismatch/);
  assert.throws(() => registryFiles(bytes, { ...manifest, files: manifest.files.map((entry, index) => index ? entry : { ...entry, sha256: "0".repeat(64) }) }), /hash\/size\/mode mismatch/);
});
test("unknown selected npm members and nonregular/path-escaping tar inputs are refused", () => {
  for (const [extra, error] of [
    [["package/integrations/unreviewed.js", "unexpected"], /Unknown\/missing/],
    [["package/../../escape", "bad"], /Unsafe provenance path/],
    [["package/link", "", "2"], /Unsupported\/duplicate/],
    [["package/executable", "", "0", 0o4644], /Special npm tar mode/],
  ]) {
    const { bytes, manifest } = fixture([extra]);
    assert.throws(() => registryFiles(bytes, manifest), error);
  }
});
test("exact binary adaptation rejects changed preimages and retains source identity", () => {
  const before = Buffer.from([0, 255, 10, 13, 42]), after = Buffer.from([0, 255, 12, 13, 42]);
  const entry = { source: "src/original.ts", destination: prefix + "src/original.ts", upstreamSha256: sha256(before), sha256: sha256(after) };
  const recipe = patchBytes(before, after, entry.source);
  assert.deepEqual(applyPatch(before, recipe, entry), after);
  assert.throws(() => applyPatch(Buffer.from("other"), recipe, entry), /identity mismatch/);
  assert.throws(() => applyPatch(before, recipe, { ...entry, source: "src/generated-locale.json" }), /identity mismatch/);
});
test("OpenHands cannot enroll CC Switch, automation, credentials or traversal as local", () => {
  for (const name of ["vendor/cc-switch/src/web/index.tsx", "vendor/openhands-automations/interface.json", `${prefix}../escape`, `${prefix}auth.json`, `${prefix}node_modules/package.js`]) assert.throws(() => outputPath(name));
  assert.equal(outputPath(prefix + "src/web/index.tsx"), prefix + "src/web/index.tsx");
});
