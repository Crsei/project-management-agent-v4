import { createHash, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { resourceClosure } from "../../cc-switch/scripts/closure.mjs";
export { applyPatch, encode, file, inside, patchBytes, publish, relative, safePath, sha256, walk } from "../../cc-switch/scripts/provenance.mjs";
import { encode, file, inside, relative, sha256, walk } from "../../cc-switch/scripts/provenance.mjs";

export const prefix = "vendor/openhands-extensions/";
export const vendor = fileURLToPath(new URL("../", import.meta.url));
export const repository = path.resolve(vendor, "../..");
export const fixedFiles = ["source-manifest.json", "supplemental-inputs.json", "fork-policy.json", "SYNC.md", "LICENSING.md", "scripts/provenance.mjs", "scripts/provenance.test.mjs", "scripts/capture.mjs", "scripts/sync.mjs", "scripts/web-build.mjs", "scripts/web-build.d.mts"];
export const blobPath = (entry) => `${prefix}source-inputs/blobs/${entry.sha256}.bin`;
export const archivePath = `${prefix}source-inputs/extensions-0.36.0.tgz`;
const hash = /^[a-f0-9]{64}$/;
const privatePath = /(?:^|\/)(?:\.env[^/]*|\.npmrc|secret\.key|auth\.json|credentials?\.json|providers\.json)(?:$|\/)/;
export function outputPath(value) {
  relative(value);
  if (!value.startsWith(prefix) || privatePath.test(value) || value.includes("/node_modules/") || value.includes("/target/")) throw new Error(`Outside OpenHands source ownership: ${value}`);
  return value;
}
export async function inputs(root = repository) {
  const manifestBytes = (await file(root, `${prefix}source-manifest.json`)).bytes;
  const policyBytes = (await file(root, `${prefix}fork-policy.json`)).bytes;
  const supplementalBytes = (await file(root, `${prefix}supplemental-inputs.json`)).bytes;
  const manifest = JSON.parse(manifestBytes), policy = JSON.parse(policyBytes), supplemental = JSON.parse(supplementalBytes);
  if (manifest.version !== 1 || policy.version !== 1 || supplemental.version !== 1 || manifest.agentCanvas.commit !== policy.upstreamCommit || supplemental.commit !== policy.upstreamCommit || sha256(manifestBytes) !== policy.sourceManifestSha256) throw new Error("Immutable OpenHands input manifest identity changed.");
  if (manifest.agentCanvas.repository !== "https://github.com/OpenHands/OpenHands" || manifest.agentCanvas.license !== "MIT" || manifest.extensions.name !== "@openhands/extensions" || manifest.extensions.version !== "0.36.0" || manifest.extensions.license !== "MIT" || manifest.extensions.resolved !== "https://registry.npmjs.org/@openhands/extensions/-/extensions-0.36.0.tgz" || manifest.extensions.integrity !== "sha512-/DPlbK1RWEpA568p9VC2MLFprFOKTXEC4q0gvX0nHqy8Gn0SXlkkBVLf/znchMds/T3jvvIctyLwvDVXl7oQJg==") throw new Error("Pinned source repository/package/license identity changed.");
  const counts = new Map(), seen = new Set();
  const entries = [...manifest.files, ...supplemental.files];
  for (const [index, entry] of entries.entries()) {
    relative(entry.source); relative(entry.destination);
    if (privatePath.test(entry.source) || seen.has(entry.destination) || ![0o644, 0o755].includes(entry.mode) || !hash.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error(`Invalid immutable original: ${entry.destination}`);
    seen.add(entry.destination);
    if (index < manifest.files.length) counts.set(entry.origin, (counts.get(entry.origin) ?? 0) + 1);
    else if (entry.origin !== "agent-canvas-git" || entry.source !== entry.destination || !entry.reason?.trim()) throw new Error(`Supplemental entry requires pinned Git identity and review rationale: ${entry.destination}`);
    if (entry.origin === "agent-canvas-git") {
      if (!/^[a-f0-9]{40}$/.test(entry.blob) || entry.source !== entry.destination) throw new Error(`Invalid Git source identity: ${entry.source}`);
    } else if (entry.origin === "agent-canvas-generated-locale") {
      if (!entry.snapshot?.startsWith("source-inputs/locales/") || entry.blob) throw new Error(`Generated locale is not a Git original: ${entry.source}`);
      relative(entry.snapshot);
    } else if (entry.origin !== "extensions-npm") throw new Error(`Unknown source origin: ${entry.origin}`);
  }
  if (manifest.files.length !== 260 || counts.get("agent-canvas-git") !== 169 || counts.get("agent-canvas-generated-locale") !== 3 || counts.get("extensions-npm") !== 88 || manifest.files.reduce((total, entry) => total + entry.bytes, 0) !== 1001798) throw new Error("Initial 169 Git + 3 generated + 88 npm source selection changed.");
  for (const field of ["reviewedAdaptations", "reviewedLocalOutputs"]) {
    if (!Array.isArray(policy[field]) || new Set(policy[field]).size !== policy[field].length) throw new Error(`Invalid exact path review policy: ${field}`);
    for (const name of policy[field]) {
      outputPath(prefix + name);
      if (field === "reviewedAdaptations" ? !seen.has(name) : seen.has(name)) throw new Error(`Wrong adaptation/local classification: ${name}`);
    }
  }
  return { manifest, manifestBytes, policy, policyBytes, supplemental, supplementalBytes, entries };
}
function original(entry, bytes, mode) {
  if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes || mode !== entry.mode) throw new Error(`Original hash/size/mode mismatch: ${entry.destination}`);
  if (entry.origin === "agent-canvas-git" && createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== entry.blob) throw new Error(`Original Git blob mismatch: ${entry.source}`);
  return bytes;
}
function octal(bytes, label) {
  const value = bytes.toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]+$/.test(value)) throw new Error(`Unsupported tar ${label}`);
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result)) throw new Error(`Oversized tar ${label}`);
  return result;
}
function pax(bytes) {
  const result = {};
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset), count = Number(bytes.subarray(offset, space).toString());
    if (space < 0 || !Number.isSafeInteger(count) || count <= space - offset + 1 || offset + count > bytes.length || bytes[offset + count - 1] !== 10) throw new Error("Invalid npm tar PAX header.");
    const record = bytes.subarray(space + 1, offset + count - 1).toString("utf8"), separator = record.indexOf("=");
    if (separator < 1) throw new Error("Invalid npm tar PAX record.");
    result[record.slice(0, separator)] = record.slice(separator + 1); offset += count;
  }
  return result;
}
export function registryFiles(archive, manifest) {
  const expected = Buffer.from(manifest.extensions.integrity.slice("sha512-".length), "base64");
  const actual = createHash("sha512").update(archive).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error("npm tarball integrity mismatch.");
  const tar = gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 }), files = new Map();
  let metadata = {}, ended = false;
  const string = (value) => value.toString("utf8").replace(/\0.*$/, "");
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) { ended = true; if (tar.subarray(offset).some((value) => value !== 0)) throw new Error("Trailing npm tar data."); break; }
    let checksum = 0;
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (checksum !== octal(header.subarray(148, 156), "checksum")) throw new Error("npm tar header checksum mismatch.");
    const size = octal(header.subarray(124, 136), "size"), kind = string(header.subarray(156, 157));
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (body.length !== size) throw new Error("Truncated npm tar member.");
    offset += 512 + Math.ceil(size / 512) * 512;
    if (kind === "x") { metadata = pax(body); continue; }
    const name = metadata.path ?? [string(header.subarray(345, 500)), string(header.subarray(0, 100))].filter(Boolean).join("/");
    if (metadata.size && Number(metadata.size) !== size || metadata.linkpath) throw new Error(`Unsupported npm tar metadata: ${name}`);
    metadata = {};
    const clean = name.replace(/\/$/, ""); relative(clean);
    if (clean === "package" && kind === "5") continue;
    if (!clean.startsWith("package/")) throw new Error(`Unexpected npm tar root: ${name}`);
    if (kind === "5") continue;
    if (!["", "0"].includes(kind) || files.has(clean.slice(8))) throw new Error(`Unsupported/duplicate npm tar member: ${name}`);
    const mode = octal(header.subarray(100, 108), "mode");
    if (mode & 0o7000) throw new Error(`Special npm tar mode: ${name}`);
    files.set(clean.slice(8), { bytes: body, mode: mode & 0o111 ? 0o755 : 0o644 });
  }
  if (!ended) throw new Error("Truncated npm tar terminator.");
  const selected = new Set(manifest.files.filter((entry) => entry.origin === "extensions-npm").map((entry) => entry.source));
  const actualSelection = [...files.keys()].filter((name) => name === "LICENSE" || name === "package.json" || name.startsWith("integrations/"));
  if (selected.size !== actualSelection.length || actualSelection.some((name) => !selected.has(name))) throw new Error("Unknown/missing file in selected npm integrations subtree.");
  for (const entry of manifest.files.filter((entry) => entry.origin === "extensions-npm")) {
    const source = files.get(entry.source);
    if (!source) throw new Error(`Missing npm original: ${entry.source}`);
    original(entry, source.bytes, source.mode);
  }
  const metadataJson = JSON.parse(files.get("package.json").bytes);
  if (metadataJson.name !== manifest.extensions.name || metadataJson.version !== manifest.extensions.version || metadataJson.license !== "MIT" || metadataJson.repository?.url !== "https://github.com/OpenHands/extensions") throw new Error("npm package metadata/license/repository mismatch.");
  return files;
}
export async function originalsFrom(source, archive, loaded, root = repository) {
  const checkout = await realpath(path.resolve(source));
  if (inside(checkout, root) || inside(root, checkout)) throw new Error("Upstream source and host must not overlap.");
  const options = { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 16 * 1024 * 1024 };
  const git = (args) => execFileSync("git", ["-C", checkout, ...args], options);
  if (git(["rev-parse", "HEAD"]).toString().trim() !== loaded.policy.upstreamCommit) throw new Error("Wrong pinned Agent Canvas checkout commit.");
  const gitEntries = loaded.entries.filter((entry) => entry.origin === "agent-canvas-git");
  const tree = new Map(git(["ls-tree", "-rz", loaded.policy.upstreamCommit, "--", ...gitEntries.map((entry) => entry.source)]).toString().split("\0").filter(Boolean).map((line) => { const [identity, name] = line.split("\t"); return [name, identity]; }));
  const registry = registryFiles(archive, loaded.manifest), result = new Map();
  for (const entry of loaded.entries) {
    let bytes;
    if (entry.origin === "agent-canvas-git") {
      if (tree.get(entry.source) !== `${entry.mode === 0o755 ? "100755" : "100644"} blob ${entry.blob}`) throw new Error(`Selected original is not in pinned Git tree: ${entry.source}`);
      bytes = original(entry, git(["cat-file", "blob", entry.blob]), entry.mode);
      const worktree = await file(checkout, entry.source); original(entry, worktree.bytes, worktree.mode);
    } else if (entry.origin === "agent-canvas-generated-locale") {
      const snapshot = await file(root, prefix + entry.snapshot); bytes = original(entry, snapshot.bytes, snapshot.mode);
    } else bytes = registry.get(entry.source).bytes;
    result.set(entry.destination, bytes);
  }
  const packageJson = JSON.parse(git(["show", `${loaded.policy.upstreamCommit}:package.json`]));
  const license = result.get("LICENSE").toString("utf8"), npmLicense = result.get("extensions/LICENSE").toString("utf8");
  if (packageJson.repository?.url !== loaded.manifest.agentCanvas.repository || packageJson.license !== "MIT" || !license.includes("Copyright © 2025 OpenHands contributors") || !npmLicense.includes("Copyright (c) 2025 OpenHands")) throw new Error("Pinned Git/npm legal metadata does not match actual evidence.");
  return result;
}
export async function offlineOriginals(loaded, root = repository) {
  const archive = await file(root, archivePath), registry = registryFiles(archive.bytes, loaded.manifest), result = new Map();
  for (const entry of loaded.entries) {
    const input = await file(root, blobPath(entry)); original(entry, input.bytes, entry.mode);
    if (entry.origin === "extensions-npm" && !input.bytes.equals(registry.get(entry.source).bytes)) throw new Error(`npm archive/blob mismatch: ${entry.source}`);
    if (entry.snapshot) { const snapshot = await file(root, prefix + entry.snapshot); original(entry, snapshot.bytes, snapshot.mode); }
    result.set(entry.destination, input.bytes);
  }
  return result;
}
export async function closure(root, policy, outputs) {
  const base = JSON.parse(await resourceClosure(root, policy, outputs, []));
  const owned = new Set(outputs.map((entry) => entry.destination));
  for (const input of base.inputs) {
    if (input.path.startsWith(prefix) && !owned.has(input.path)) throw new Error(`Unenrolled OpenHands production dependency: ${input.path}`);
  }
  for (const edge of base.edges) {
    if (edge.target?.startsWith("vendor/cc-switch/") && (edge.specifier !== "@pm/cc-switch-ui" || edge.target !== "vendor/cc-switch/src/web/index.tsx")) throw new Error(`CC Switch public entry required: ${edge.source}: ${edge.specifier}`);
    if (edge.disposition === "external-package" && /^(?:@pm\/|@openhands\/|#\/)/.test(edge.specifier)) throw new Error(`Unresolved source alias: ${edge.source}: ${edge.specifier}`);
    if (edge.source.startsWith(prefix) && /^(?:@\/|#\/|@cc-switch\/)/.test(edge.specifier)) throw new Error(`Unscoped source alias refused: ${edge.source}: ${edge.specifier}`);
  }
  return encode({ ...base, upstreamRepository: "https://github.com/OpenHands/OpenHands", hostIntegrationOutputs: [], localIntegrationOutputs: outputs.filter((entry) => !entry.source).map((entry) => entry.destination).sort(), snapshotOnly: [...owned].filter((name) => !base.inputs.some((entry) => entry.path === name)).sort(), limitations: "Static source/resource closure, not build/behavioral acceptance. Rollup Web provenance separately closes actual runtime assets, registry modules and dependency notices; CC Switch owns its independent native/runtime ledger." });
}
export async function loadInventory(root = repository) {
  const loaded = await inputs(root), inventoryBytes = (await file(root, `${prefix}output-inventory.json`)).bytes, inventory = JSON.parse(inventoryBytes);
  if (inventory.version !== 1 || inventory.upstreamCommit !== loaded.policy.upstreamCommit || inventory.sourceManifestSha256 !== sha256(loaded.manifestBytes) || inventory.supplementalSha256 !== sha256(loaded.supplementalBytes) || inventory.policySha256 !== sha256(loaded.policyBytes)) throw new Error("OpenHands reviewed output generation changed; explicit capture required.");
  const seen = new Set();
  for (const entry of inventory.files) {
    outputPath(entry.destination);
    if (seen.has(entry.destination) || !hash.test(entry.sha256) || ![0o644, 0o755].includes(entry.mode)) throw new Error(`Invalid output inventory: ${entry.destination}`);
    seen.add(entry.destination);
  }
  for (const entry of [...inventory.patches, ...inventory.inputArtifacts]) {
    outputPath(entry.path); const current = await file(root, entry.path);
    if (sha256(current.bytes) !== entry.sha256 || current.bytes.length !== entry.bytes || current.mode !== entry.mode) throw new Error(`Changed provenance input/recipe: ${entry.path}`);
  }
  if (sha256((await file(root, `${prefix}resource-closure.json`)).bytes) !== inventory.closureSha256) throw new Error("OpenHands resource closure ledger changed.");
  if (JSON.stringify(inventory.hostBuildInputs.map((entry) => entry.path)) !== JSON.stringify(loaded.policy.hostBuildInputs)) throw new Error("Host build-input enrollment changed.");
  for (const entry of inventory.hostBuildInputs) {
    const current = await file(root, entry.path);
    if (sha256(current.bytes) !== entry.sha256 || current.bytes.length !== entry.bytes || current.mode !== entry.mode) throw new Error(`Host build input changed: ${entry.path}`);
  }
  return { ...loaded, inventory, inventoryBytes };
}
export async function verifyOutputs(root = repository) {
  const loaded = await loadInventory(root), known = new Set([`${prefix}output-inventory.json`, `${prefix}resource-closure.json`, ...loaded.inventory.patches.map((entry) => entry.path), ...loaded.inventory.inputArtifacts.map((entry) => entry.path)]);
  for (const entry of loaded.inventory.files) {
    const current = await file(root, entry.destination);
    if (sha256(current.bytes) !== entry.sha256 || current.bytes.length !== entry.bytes || current.mode !== entry.mode) throw new Error(`Unreviewed OpenHands output: ${entry.destination}`);
    known.add(entry.destination);
  }
  for (const name of await walk(root, prefix.slice(0, -1), loaded.policy.generatedTrees)) if (!known.has(name)) throw new Error(`Unknown OpenHands-owned file: ${name}`);
  const closureBytes = await closure(root, loaded.policy, loaded.inventory.files);
  if (sha256(closureBytes) !== loaded.inventory.closureSha256) throw new Error("OpenHands source/import/resource boundary changed after capture.");
  return { ...loaded, closureBytes };
}
