import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32 } from "node:zlib";
import { listArchive } from "./final-artifact.mjs";

// Actual uncompressed ZIP structures, including Unix symlink metadata. No shell
// echo, extractor mock, executable installer or native smoke is involved.
function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const data = Buffer.from(entry.data ?? "fixture");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((entry.link ? 0o120777 : 0o100644) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + data.length;
  }
  const records = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(records.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, records, end]);
}
async function archive(t, entries) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pm-desktop-archive-guard-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "fixture.zip");
  await writeFile(path, zip(entries));
  return path;
}

test("ZIP symlink data is inspected before extraction rather than trusting SLT mode alone", async (t) => {
  const path = await archive(t, [{ path: "App/Versions/A/file", data: "actual resource" }, { path: "App/Versions/Current", link: true, data: "A" }]);
  const listed = await listArchive(path);
  assert.equal(listed.find((entry) => entry.path.endsWith("/Current"))["Symbolic Link"], "A");
  await assert.rejects(listArchive(path, { windows: true }), /unsupported final archive link/);
});

test("ZIP symlink traversal and link-ancestor writes fail before filesystem extraction", async (t) => {
  const escape = await archive(t, [{ path: "resources/alias", link: true, data: "../../outside" }]);
  await assert.rejects(listArchive(escape), /Escaping or unsupported final archive link/);
  const writeThrough = await archive(t, [{ path: "resources/alias", link: true, data: "target" }, { path: "resources/alias/write.js", data: "must not write" }]);
  await assert.rejects(listArchive(writeThrough), /writes through a link/);
});

for (const entry of ["resources/NUL.txt", "resources/trailing.", "resources/trailing ", "../outside"]) {
  test(`Windows archive preflight refuses unsafe member ${JSON.stringify(entry)}`, async (t) => {
    const path = await archive(t, [{ path: entry }]);
    await assert.rejects(listArchive(path, { windows: true }), /Unsafe/);
  });
}

test("implicit Windows directory case aliases are rejected even without explicit directory entries", async (t) => {
  const path = await archive(t, [{ path: "resources/Package/a.js" }, { path: "resources/package/b.js" }]);
  await assert.rejects(listArchive(path, { windows: true }), /Case-aliased/);
});
