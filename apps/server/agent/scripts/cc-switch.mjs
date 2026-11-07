import { execFileSync, spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resourceClosure } from "../../../../vendor/cc-switch/scripts/closure.mjs";
import { encode, file, repository, sha256, verifyOutputs } from "../../../../vendor/cc-switch/scripts/provenance.mjs";

export const nativeTargets = Object.freeze({
  "win32-x64": "x86_64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
});
export function nativeTarget(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`, triple = nativeTargets[target];
  if (!triple) throw new Error(`Unsupported cc-switch sidecar target: ${target}`);
  return { target, triple, executable: platform === "win32" ? "cc-switch-host.exe" : "cc-switch-host" };
}
const cargoRoot = path.join(repository, "apps/server/cc-switch-host");
const manifestPath = path.join(cargoRoot, "Cargo.toml");
const cargoEnvironment = { ...process.env, CARGO_TERM_COLOR: "never" };
const tool = (name, args) => execFileSync(name, args, { cwd: cargoRoot, env: cargoEnvironment, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
async function command(name, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(name, args, { cwd: cargoRoot, env: cargoEnvironment, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`cc-switch native build failed: ${signal ?? code}`)));
  });
}
async function crateNotices(metadata) {
  const records = [], assets = [];
  const graph = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const graphIds = new Set(), pending = [metadata.resolve.root];
  while (pending.length) {
    const id = pending.pop();
    if (graphIds.has(id)) continue;
    graphIds.add(id);
    for (const dependency of graph.get(id)?.deps ?? []) {
      if (dependency.dep_kinds.some((kind) => kind.kind !== "dev")) pending.push(dependency.pkg);
    }
  }
  for (const pkg of metadata.packages.filter((entry) => graphIds.has(entry.id)).sort((a, b) => a.id < b.id ? -1 : 1)) {
    if (/^(?:tauri(?:-|$)|wry$|gtk(?:-|$)|gtk4(?:-|$)|webkit2gtk(?:-|$)|tray-icon$)/.test(pkg.name)) throw new Error(`GUI dependency in headless Rust graph: ${pkg.name}`);
    if (!pkg.license && !pkg.license_file) throw new Error(`Missing crate license declaration: ${pkg.name}@${pkg.version}`);
    const root = path.dirname(pkg.manifest_path), found = new Set();
    for (const name of (await readdir(root)).sort()) {
      if (/^(?:licen[cs]e|copying|notice|copyright)(?:[._-]|$)/i.test(name) && (await lstat(path.join(root, name))).isFile()) found.add(name);
      if (/^(?:licenses?|legal)$/i.test(name) && (await lstat(path.join(root, name))).isDirectory()) {
        for (const child of (await readdir(path.join(root, name))).sort()) if ((await lstat(path.join(root, name, child))).isFile()) found.add(`${name}/${child}`);
      }
    }
    if (pkg.license_file) {
      const explicit = path.resolve(root, pkg.license_file);
      if (explicit !== root && !explicit.startsWith(root + path.sep)) throw new Error(`Escaping crate license file: ${pkg.name}`);
      found.add(path.relative(root, explicit).split(path.sep).join("/"));
    }
    const notices = [];
    for (const name of [...found].sort()) {
      const source = path.join(root, name), info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe crate notice: ${pkg.name}`);
      const bytes = await readFile(source), target = `licenses/crates/${records.length.toString().padStart(4, "0")}/${name}`;
      assets.push({ target, bytes, sha256: sha256(bytes), mode: 0o644 }); notices.push(target);
    }
    if (!notices.length) {
      // Cargo registry packages sometimes ship only an SPDX declaration. Retain
      // reviewed SPDX texts; unknown identifiers fail rather than omit notices.
      const identifiers = [...new Set((pkg.license ?? "").match(/[A-Za-z0-9][A-Za-z0-9.+-]*/g) ?? [])].filter((id) => !["AND", "OR", "WITH"].includes(id));
      if (!identifiers.length) throw new Error(`Missing crate license text: ${pkg.name}`);
      for (const id of identifiers) {
        const source = path.join(repository, "vendor/t3code/third-party-licenses/spdx/v3.28.0", `${id}.json`);
        const notice = JSON.parse(await readFile(source, "utf8").catch(() => { throw new Error(`Missing reviewed SPDX notice ${id} for ${pkg.name}@${pkg.version}; add the real upstream notice before packaging.`); }));
        if (typeof notice.licenseText !== "string" || !notice.licenseText.trim()) throw new Error(`Invalid SPDX text: ${id}`);
        const bytes = Buffer.from(notice.licenseText + "\n"), target = `licenses/crates/${records.length.toString().padStart(4, "0")}/${id}.txt`;
        assets.push({ target, bytes, sha256: sha256(bytes), mode: 0o644 }); notices.push(target);
      }
    }
    records.push({ name: pkg.name, version: pkg.version, source: pkg.source, license: pkg.license, authors: pkg.authors, repository: pkg.repository, noticeEvidence: found.size ? "crate-shipped-legal-files" : "declared-SPDX-with-canonical-text; review package authors/source attribution before release", notices });
  }
  return { records, assets };
}
export async function buildSidecar(outputRoot) {
  const target = nativeTarget();
  const finalized = await verifyOutputs();
  const closure = await resourceClosure(repository, finalized.policy, finalized.inventory.files);
  if (sha256(closure) !== finalized.inventory.closureSha256) throw new Error("cc-switch resource closure changed after capture.");
  // --locked is mandatory: parent creates/reviews the real headless Cargo.lock
  // before capture. Never silently resolve a new dependency graph in packaging.
  const lock = await file(repository, "apps/server/cc-switch-host/Cargo.lock");
  const metadata = JSON.parse(tool("cargo", ["metadata", "--locked", "--format-version", "1", "--manifest-path", manifestPath, "--filter-platform", target.triple]));
  const notices = await crateNotices(metadata);
  await command("cargo", ["build", "--locked", "--release", "--manifest-path", manifestPath, "--target", target.triple]);
  const afterBuild = await verifyOutputs();
  if (sha256(afterBuild.inventoryBytes) !== sha256(finalized.inventoryBytes)) throw new Error("Source/provenance generation changed during native build.");
  const source = path.join(metadata.target_directory, target.triple, "release", target.executable);
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Cargo did not produce a regular cc-switch-host executable.");
  const binary = await readFile(source);
  if (!binary.length) throw new Error("Cargo produced an empty sidecar executable.");
  const destination = path.resolve(outputRoot, "cc-switch", target.target);
  if (await lstat(destination).catch((error) => { if (error.code === "ENOENT") return null; throw error; })) throw new Error("cc-switch native staging destination already exists; refusing replacement.");
  // Windows has no POSIX execute bits; use the same canonical mode as file().
  const assets = [{ target: target.executable, bytes: binary, sha256: sha256(binary), mode: process.platform === "win32" ? 0o644 : 0o755 }, ...notices.assets];
  for (const relative of ["LICENSE", "LICENSING.md", "SYNC.md", "source-manifest.json", "fork-policy.json", "output-inventory.json", "resource-closure.json", "upstream-tree.json"]) {
    const bytes = (await file(repository, `vendor/cc-switch/${relative}`)).bytes;
    assets.push({ target: `licenses/provenance/vendor/cc-switch/${relative}`, bytes, sha256: sha256(bytes), mode: 0o644 });
  }
  const provenanceResources = [
    ...finalized.inventory.patches.map((entry) => entry.path),
    ...finalized.inventory.files.filter((entry) => entry.destination.startsWith("vendor/cc-switch/scripts/")).map((entry) => entry.destination),
  ];
  for (const relative of provenanceResources) {
    const bytes = (await file(repository, relative)).bytes;
    assets.push({ target: `licenses/provenance/${relative}`, bytes, sha256: sha256(bytes), mode: 0o644 });
  }
  const manifest = {
    version: 1, ...target, upstreamCommit: finalized.manifest.commit, sourceManifestSha256: sha256(finalized.manifestBytes), outputInventorySha256: sha256(finalized.inventoryBytes), cargoLockSha256: sha256(lock.bytes),
    rustc: tool("rustc", ["--version"]).trim(), cargo: tool("cargo", ["--version"]).trim(),
    resourcePolicy: "Native executable embeds selected Rust resources. No Tauri/GUI binary, Cargo target/source tree, absolute upstream path or runtime source repository is shipped or required. OS dynamic libraries remain platform prerequisites.",
    crates: notices.records,
    files: assets.map(({ target: filePath, sha256: digest, bytes, mode }) => ({ path: filePath, sha256: digest, bytes: bytes.length, mode })).sort((a, b) => a.path < b.path ? -1 : 1),
  };
  await mkdir(destination, { recursive: true });
  for (const asset of assets) {
    const targetPath = path.join(destination, asset.target);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, asset.bytes, { flag: "wx", mode: asset.mode });
    await chmod(targetPath, asset.mode);
  }
  await writeFile(path.join(destination, "native-manifest.json"), encode(manifest), { flag: "wx" });
  return { ...manifest, manifestSha256: sha256(encode(manifest)) };
}
export async function verifySidecar(buildRoot, platform = process.platform, arch = process.arch) {
  const expected = nativeTarget(platform, arch), root = path.join(buildRoot, "cc-switch", expected.target);
  const siblings = await readdir(path.join(buildRoot, "cc-switch"));
  if (siblings.length !== 1 || siblings[0] !== expected.target) throw new Error("Unknown or mixed OS/CPU sidecar staging contents.");
  const manifestBytes = (await file(root, "native-manifest.json")).bytes;
  const manifest = JSON.parse(manifestBytes);
  if (manifest.version !== 1 || manifest.target !== expected.target || manifest.triple !== expected.triple || manifest.executable !== expected.executable || !manifest.crates?.length) throw new Error("Wrong cc-switch native target or missing license closure.");
  const known = new Set(["native-manifest.json"]);
  for (const entry of manifest.files) {
    if (typeof entry.path !== "string" || entry.path.includes("\\") || entry.path.startsWith("/") || entry.path.split("/").some((part) => !part || part === "." || part === "..") || known.has(entry.path)) throw new Error("Unsafe native resource inventory.");
    known.add(entry.path);
    const { bytes, mode } = await file(root, entry.path);
    if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes || mode !== entry.mode) throw new Error(`Native resource changed: ${entry.path}`);
  }
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
      else if (!entry.isFile() || !known.has(relative)) throw new Error(`Unknown native resource: ${relative}`);
    }
  }
  await visit(root);
  if (!known.has(expected.executable)) throw new Error("Native binary missing from manifest.");
  return { ...manifest, manifestSha256: sha256(manifestBytes) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== "--output") throw new Error("Usage: node apps/server/agent/scripts/cc-switch.mjs --output BUILD_ROOT (native runner only; requires captured provenance and locked Cargo graph).");
  const manifest = await buildSidecar(process.argv[3]);
  console.log(JSON.stringify({ target: manifest.target, triple: manifest.triple, crates: manifest.crates.length }));
}
