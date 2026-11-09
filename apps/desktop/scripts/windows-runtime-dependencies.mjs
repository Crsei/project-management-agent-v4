import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { runtimeSources } from "./runtime-manifest.mjs";

// Inspect actual verified, pinned payload bytes, not assumptions about a Node or
// PostgreSQL version requiring a particular VC redist. No installer downloads.
export function inspectPeImports(bytes) {
  const fail = () => { throw new Error("Malformed pinned Windows PE import table."); };
  const bounds = (offset, count) => { if (!Number.isSafeInteger(offset) || offset < 0 || offset + count > bytes.length) fail(); };
  bounds(0, 64);
  if (bytes.readUInt16LE(0) !== 0x5a4d) fail();
  const pe = bytes.readUInt32LE(0x3c); bounds(pe, 24);
  if (bytes.readUInt32LE(pe) !== 0x4550) fail();
  const sections = bytes.readUInt16LE(pe + 6), optionalBytes = bytes.readUInt16LE(pe + 20), optional = pe + 24;
  bounds(optional, optionalBytes);
  const magic = bytes.readUInt16LE(optional);
  if (![0x10b, 0x20b].includes(magic)) fail();
  const directories = optional + (magic === 0x20b ? 112 : 96);
  const imageBase = magic === 0x20b ? Number(bytes.readBigUInt64LE(optional + 24)) : bytes.readUInt32LE(optional + 28);
  bounds(optional + optionalBytes, sections * 40);
  function offset(rva, count = 1) {
    for (let index = 0; index < sections; index++) {
      const section = optional + optionalBytes + index * 40;
      const start = bytes.readUInt32LE(section + 12), length = Math.max(bytes.readUInt32LE(section + 8), bytes.readUInt32LE(section + 16));
      if (rva >= start && rva < start + length) { const value = bytes.readUInt32LE(section + 20) + rva - start; bounds(value, count); return value; }
    }
    fail();
  }
  function name(rva) {
    const start = offset(rva), end = bytes.indexOf(0, start);
    if (end < start || end - start > 260) fail();
    const value = bytes.toString("ascii", start, end).toLowerCase();
    // PE imports name modules, not a DLL extension: PostgreSQL extensions
    // import postgres.exe and the pinned GUI libraries import WINSPOOL.DRV.
    // Keep basename/path validation without rejecting legitimate module types.
    if (!/^[a-z0-9_.+-]+$/.test(value) || value.endsWith(".")) fail();
    return value;
  }
  const imports = new Set();
  for (const [directoryIndex, width] of [[1, 20], [13, 32]]) {
    const directory = directories + directoryIndex * 8;
    if (directory + 8 > optional + optionalBytes) continue;
    const rva = bytes.readUInt32LE(directory), size = bytes.readUInt32LE(directory + 4);
    if (!rva && !size) continue;
    if (!rva || size < width) fail();
    const start = offset(rva, size);
    let terminated = false;
    for (let at = start; at + width <= start + size; at += width) {
      if (bytes.subarray(at, at + width).every(value => value === 0)) { terminated = true; break; }
      let nameRva = bytes.readUInt32LE(at + (directoryIndex === 1 ? 12 : 4));
      if (directoryIndex === 13 && !(bytes.readUInt32LE(at) & 1)) nameRva -= imageBase;
      imports.add(name(nameRva));
    }
    if (!terminated) fail();
  }
  return [...imports].sort();
}

export async function inspectWindowsRuntimeDependencies(runtimeRoot) {
  const files = [];
  async function visit(path) {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name), info = await lstat(child);
      if (info.isSymbolicLink()) throw new Error("Windows runtime dependency inspection rejects linked payloads.");
      if (info.isDirectory()) await visit(child);
      else if (info.isFile() && /\.(?:dll|exe)$/i.test(name)) files.push(child);
    }
  }
  await visit(join(runtimeRoot, "node"));
  await visit(join(runtimeRoot, "postgres"));
  const paths = new Set(files.map(path => path.toLowerCase()));
  const binaries = [];
  for (const path of files) {
    const bytes = await readFile(path);
    binaries.push({ path: relative(runtimeRoot, path).split(sep).join("/"), sha256: createHash("sha256").update(bytes).digest("hex"), imports: inspectPeImports(bytes).map(name => ({ name, resolution: paths.has(join(dirname(path), name).toLowerCase()) ? "bundled-sibling" : "os-loader", vcRuntime: /^(?:vcruntime|msvcp|msvcr|concrt)\d.*\.dll$/.test(name) })) });
  }
  if (!binaries.some(entry => entry.path === "node/node.exe") || !binaries.some(entry => entry.path === "postgres/bin/postgres.exe")) throw new Error("Pinned Node/PostgreSQL executables are missing from PE dependency inspection.");
  return { formatVersion: 1, target: "win32-x64", sources: runtimeSources("win32-x64"), evidence: "actual-pinned-pe-import-tables", binaries, preflight: { policy: "offline-loader-probe", executables: ["node/node.exe", "postgres/bin/postgres.exe"], remoteInstallerDownloads: false, vcRuntimeAssumed: false } };
}
