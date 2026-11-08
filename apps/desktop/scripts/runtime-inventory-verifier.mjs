import { execFile } from "node:child_process";
import { lstat, open, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { hashFile, inventoryTree, runtimeSources } from "./runtime-manifest.mjs";

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
export async function verifyFinalRuntime(resources, target, { signedMachO = false } = {}) {
  const root = join(resources, "desktop-runtime");
  const nativePath = join(resources, "workspace-runtime", nativeRuntimeManifest);
  for (const path of [root, nativePath, join(root, "runtime-manifest.json")]) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (path === root ? !info.isDirectory() : !info.isFile())) throw new Error("Runtime inventories and roots must be real resources.");
  }
  const original = JSON.parse(await readFile(join(root, "runtime-manifest.json"), "utf8"));
  const native = JSON.parse(await readFile(nativePath, "utf8"));
  if (original.version !== 1 || original.target !== target || JSON.stringify(original.sources) !== JSON.stringify(runtimeSources(target))
    || !Array.isArray(original.files) || native.schemaVersion !== 1 || !Array.isArray(native.files))
    throw new Error("Invalid final runtime source/native inventory.");
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
      if (allowed.has(file.path) && !await isMachO(join(root, file.path))) throw new Error(`Native runtime allowlist does not identify Mach-O: ${file.path}`);
      continue;
    }
    if (!signedMachO || !allowed.has(file.path) || !await isMachO(join(root, file.path)))
      throw new Error(`Final runtime resource bytes changed: ${file.path}`);
    await execute("/usr/bin/codesign", ["--verify", "--strict", join(root, file.path)]);
    signedResources.push({ path: file.path, bytes: file.bytes, sha256: file.sha256, sourceSha256: source.sha256 });
  }
  return { status: "passed", sourceManifest: "desktop-runtime/runtime-manifest.json", nativeManifest: `workspace-runtime/${nativeRuntimeManifest}`,
    nativeManifestSha256: await hashFile(nativePath), files: actual.length, signedResources,
    scope: "Exact complete runtime paths and bytes; only pre-sign magic-identified Mach-O files may differ after strict app and individual signature validation" };
}
