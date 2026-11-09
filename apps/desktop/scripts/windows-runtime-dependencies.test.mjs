import test from "node:test";
import assert from "node:assert/strict";
import { inspectPeImports } from "./windows-runtime-dependencies.mjs";

function pe({ delay = false, importName = "VCRUNTIME140.dll" } = {}) {
  const bytes = Buffer.alloc(0x600), header = 0x80, optional = header + 24, section = optional + 240;
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(header, 0x3c); bytes.writeUInt32LE(0x4550, header);
  bytes.writeUInt16LE(0x8664, header + 4); bytes.writeUInt16LE(1, header + 6); bytes.writeUInt16LE(240, header + 20);
  bytes.writeUInt16LE(0x20b, optional); bytes.writeBigUInt64LE(0x140000000n, optional + 24);
  bytes.writeUInt32LE(0x400, section + 8); bytes.writeUInt32LE(0x1000, section + 12); bytes.writeUInt32LE(0x400, section + 16); bytes.writeUInt32LE(0x200, section + 20);
  const directory = optional + 112 + (delay ? 13 : 1) * 8;
  bytes.writeUInt32LE(0x1000, directory); bytes.writeUInt32LE(delay ? 64 : 40, directory + 4);
  if (delay) { bytes.writeUInt32LE(1, 0x200); bytes.writeUInt32LE(0x1100, 0x204); }
  else bytes.writeUInt32LE(0x1100, 0x20c);
  bytes.write(`${importName}\0`, 0x300, "ascii");
  return bytes;
}
test("actual normal PE import tables, not guessed version heuristics, identify VC dependency", () => {
  assert.deepEqual(inspectPeImports(pe()), ["vcruntime140.dll"]);
});
test("delay-load PE dependencies are included in offline preflight evidence", () => {
  assert.deepEqual(inspectPeImports(pe({ delay: true })), ["vcruntime140.dll"]);
});
test("normal and delay-load imports retain executable and driver module names", () => {
  for (const delay of [false, true]) {
    for (const importName of ["postgres.exe", "WINSPOOL.DRV"]) {
      assert.deepEqual(inspectPeImports(pe({ delay, importName })), [importName.toLowerCase()]);
    }
  }
});
test("malformed, escaping and unterminated import tables fail closed", () => {
  assert.throws(() => inspectPeImports(Buffer.from("not PE")), /Malformed/);
  const unsafe = pe(); unsafe.fill(0, 0x300, 0x340); unsafe.write("../bad.dll\0", 0x300, "ascii");
  assert.throws(() => inspectPeImports(unsafe), /Malformed/);
  for (const importName of ["../postgres.exe", "C:postgres.exe", "/postgres.exe", "postgres.exe:stream", "postgres.exe ", ".", "..", "module."]) {
    assert.throws(() => inspectPeImports(pe({ importName })), /Malformed/);
  }
  const invalid = pe(); invalid.writeUInt32LE(0x90000000, 0x20c);
  assert.throws(() => inspectPeImports(invalid), /Malformed/);
});
