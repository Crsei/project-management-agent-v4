import { execFile } from "node:child_process";
import { lstat, open, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { assertNoNodeTooling, hashFile, inventoryTree, validateRuntimeManifest } from "./runtime-manifest.mjs";
import { peFileRecord, verifyWindowsFile } from "./signatures.mjs";

const execute = promisify(execFile);
const machO = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);
export const nativeRuntimeManifest = "desktop-runtime-native.json";
const safe = (path) => typeof path === "string" && path && !/[\\:\0\r\n]/.test(path) && !posix.isAbsolute(path)
  && path.split("/").every((part) => part && part !== "." && part !== "..");
async function isMachO(path) {
  const handle = await open(path, "r");
  const magic = Buffer.alloc(4);
  try {
    const { bytesRead } = await handle.read(magic, 0, 4, 0);
    return bytesRead === 4 && machO.has(magic.toString("hex"));
  } finally { await handle.close(); }
}

// The small native allowlist is captured from source magic BEFORE signing and
// sealed with the application. Every other original inventory entry stays exact.
export async function verifyFinalRuntime(resources, target, { signedMachO = false, signedPE = false, signer } = {}) {
  const root = join(resources, "desktop-runtime");
  const nativePath = join(resources, "workspace-runtime", nativeRuntimeManifest);
  for (const path of [root, nativePath, join(root, "runtime-manifest.json")]) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (path === root ? !info.isDirectory() : !info.isFile())) throw new Error("Runtime inventories and roots must be real resources.");
  }
  const original = JSON.parse(await readFile(join(root, "runtime-manifest.json"), "utf8"));
  const native = JSON.parse(await readFile(nativePath, "utf8"));
  validateRuntimeManifest(original, target);
  await assertNoNodeTooling(root, target);
  if (native.schemaVersion !== 1 || !Array.isArray(native.files)) throw new Error("Invalid final runtime native inventory.");
  const expected = new Map();
  for (const file of original.files) {
    if (!safe(file.path) || expected.has(file.path)) throw new Error("Invalid or duplicated runtime inventory path.");
    expected.set(file.path, file);
  }
  const suffix = target.startsWith("win32-") ? ".exe" : "";
  for (const path of [suffix ? "node/node.exe" : "node/bin/node", ...["postgres", "initdb", "pg_ctl", "pg_dump", "pg_restore", "psql"].map((name) => `postgres/bin/${name}${suffix}`)]) {
    if (!expected.has(path) || expected.get(path).link !== undefined) throw new Error(`Final runtime lacks a required native tool: ${path}`);
  }
  const allowed = new Map();
  for (const file of native.files) {
    const source = expected.get(file.path);
    if (!safe(file.path) || allowed.has(file.path) || !source || source.link !== undefined
      || source.sha256 !== file.sha256 || source.bytes !== file.bytes)
      throw new Error("Native runtime signature allowlist differs from the original pinned inventory.");
    allowed.set(file.path, file);
  }
  if (signedMachO && (process.platform !== "darwin" || !target.startsWith("darwin-")))
    throw new Error("Runtime signature mutations require native macOS validation.");
  if (signedPE && (process.platform !== "win32" || target !== "win32-x64"))
    throw new Error("Runtime PE signature mutations require native Windows validation.");
  const actual = (await inventoryTree(root)).filter((file) => file.path !== "runtime-manifest.json");
  if (actual.length !== expected.size || actual.some((file) => !expected.has(file.path))) throw new Error("Final runtime has missing or extra resources.");
  const signedResources = [];
  for (const file of actual) {
    const source = expected.get(file.path);
    if (source.link !== undefined || file.link !== undefined) {
      if (source.link !== file.link) throw new Error(`Final runtime resource link changed: ${file.path}`);
      continue;
    }
    if (target.startsWith("darwin-") && file.mode !== source.mode) throw new Error(`Final runtime resource mode changed: ${file.path}`);
    const changed = file.sha256 !== source.sha256 || file.bytes !== source.bytes;
    if (!changed) {
      if (allowed.has(file.path) && !(target.startsWith("win32-") ? await peFileRecord(join(root, file.path)) : await isMachO(join(root, file.path))))
        throw new Error(`Native runtime allowlist does not identify the expected executable format: ${file.path}`);
      continue;
    }
    if (signedPE && allowed.has(file.path) && /^[a-f0-9]{64}$/.test(allowed.get(file.path).peSha256 ?? "")
      && Number.isSafeInteger(allowed.get(file.path).peContentBytes) && allowed.get(file.path).peContentBytes > 0
      && allowed.get(file.path).peContentBytes <= source.bytes
      && (await peFileRecord(join(root, file.path), allowed.get(file.path).peContentBytes))?.sha256 === allowed.get(file.path).peSha256) {
      const signature = await verifyWindowsFile(join(root, file.path), signer);
      signedResources.push({ path: file.path, bytes: file.bytes, sha256: file.sha256, sourceSha256: source.sha256,
        peSha256: allowed.get(file.path).peSha256, peContentBytes: allowed.get(file.path).peContentBytes, signature });
      continue;
    }
    if (!signedMachO || !allowed.has(file.path) || !await isMachO(join(root, file.path)))
      throw new Error(`Final runtime resource bytes changed: ${file.path}`);
    await execute("/usr/bin/codesign", ["--verify", "--strict", join(root, file.path)]);
    signedResources.push({ path: file.path, bytes: file.bytes, sha256: file.sha256, sourceSha256: source.sha256 });
  }
  return { status: "passed", sourceManifest: "desktop-runtime/runtime-manifest.json", nativeManifest: `workspace-runtime/${nativeRuntimeManifest}`,
    nativeManifestSha256: await hashFile(nativePath), files: actual.length, signedResources,
    scope: "Exact declared execution-only Node transformation and complete PostgreSQL paths and bytes; only pre-sign magic-identified native files may differ after native signature validation; PE executable content must remain exact excluding Authenticode fields" };
}
