import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repository = path.resolve(packageRoot, "../../..");
const options = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (!["--build", "--output", "--web-dist"].includes(key) || !process.argv[index + 1] || process.argv[index + 1].startsWith("--")) throw new Error(`Unknown/incomplete option: ${key}`);
  options.set(key, path.resolve(process.argv[++index]));
}
if (!options.has("--output")) throw new Error("Usage: node apps/server/agent/scripts/package.mjs --build BUILD_DIRECTORY --output NEW_ARTIFACT_ROOT [--web-dist WEB_DIST]");
const buildRoot = await realpath(options.get("--build") ?? path.join(packageRoot, "dist"));
const outputRoot = options.get("--output");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const posix = (value) => value.split(path.sep).join("/");
const inside = (root, value) => value === root || value.startsWith(root + path.sep);
const packageName = (specifier) => specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
const externalName = (specifier) => {
  if (isBuiltin(specifier)) return null;
  if (specifier.startsWith(".") || path.isAbsolute(specifier) || specifier.includes(":")) throw new Error(`Nonportable external import: ${specifier}`);
  return packageName(specifier);
};
const buildInputs = JSON.parse(await readFile(path.join(buildRoot, "build-inputs.json"), "utf8"));
if (buildInputs.version !== 1) throw new Error("Unsupported build input inventory.");
const diskSdks = { "@anthropic-ai/claude-agent-sdk": "0.3.276", "@cursor/sdk": "1.0.38", "@muse-code/sdk": "1.4.6" };
// Cursor's createRequire alias is intentionally opaque to esbuild's import metafile.
// The frozen disk-resource boundary must close these SDKs even without static imports.
const sourceImports = JSON.parse(await readFile(path.join(repository, "vendor/t3code/sync-imports.json"), "utf8"));
const builtSources = new Set(buildInputs.inputs);
const opaqueOrigins = new Map();
for (const edge of sourceImports.edges) {
  if (builtSources.has(edge.source) && edge.disposition === "external-package" && ["require", "require-resolve"].includes(edge.kind) && typeof edge.specifier === "string") {
    opaqueOrigins.set(packageName(edge.specifier), path.dirname(path.resolve(repository, edge.source)));
  }
}
const externalOrigins = new Map();
for (const entry of buildInputs.externalOrigins) {
  const name = externalName(entry.specifier);
  if (name && !externalOrigins.has(name)) externalOrigins.set(name, path.dirname(path.resolve(repository, entry.source)));
}
const roots = [...new Set([
  ...buildInputs.outputs.flatMap((entry) => entry.imports).map(externalName).filter(Boolean),
  ...Object.keys(diskSdks),
  ...opaqueOrigins.keys(),
])].sort();

async function locatePackage(name, from) {
  const require = createRequire(path.join(from, "package.json"));
  for (const lookup of require.resolve.paths(name) ?? []) {
    const candidate = path.join(lookup, name);
    const info = await lstat(path.join(candidate, "package.json")).catch((error) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (info?.isFile()) return realpath(candidate);
  }
  return null;
}
const packages = new Map();
let effectRoot;
async function collect(name, from, optional = false) {
  const located = await locatePackage(name, from);
  if (!located) {
    if (optional) return null;
    throw new Error(`Missing installed production dependency ${name} (from ${posix(path.relative(repository, from))})`);
  }
  const metadata = JSON.parse(await readFile(path.join(located, "package.json"), "utf8"));
  if (metadata.name?.startsWith("@t3tools/") || metadata.name?.startsWith("@agent-workspace/") || metadata.name === "@pm/t3code-provider-server") throw new Error(`Unbundled source workspace dependency: ${metadata.name}`);
  if (metadata.name === "effect") {
    if (metadata.version !== "4.0.5") throw new Error(`Duplicate/incompatible Effect singleton: ${metadata.version}`);
    effectRoot ??= located;
    if (located !== effectRoot) return effectRoot;
  }
  if (packages.has(located)) return located;
  const record = { root: located, metadata, dependencies: new Map() };
  packages.set(located, record);
  const required = { ...metadata.peerDependencies, ...metadata.dependencies };
  const optionalDependencies = metadata.optionalDependencies ?? {};
  for (const dependency of Object.keys({ ...required, ...optionalDependencies }).sort()) {
    const optionalPeer = !metadata.dependencies?.[dependency] && metadata.peerDependenciesMeta?.[dependency]?.optional === true;
    const resolved = await collect(dependency, located, dependency in optionalDependencies || optionalPeer);
    if (resolved) record.dependencies.set(dependency, resolved);
  }
  return located;
}
const topLevel = new Map();
for (const name of roots) topLevel.set(name, await collect(name, opaqueOrigins.get(name) ?? externalOrigins.get(name) ?? packageRoot));
for (const [name, version] of Object.entries(diskSdks)) {
  if (packages.get(topLevel.get(name)).metadata.version !== version) throw new Error(`Unpinned SDK: ${name}`);
}
const ordered = [...packages.values()].sort((left, right) => {
  const a = `${left.metadata.name}@${left.metadata.version}:${posix(path.relative(repository, left.root))}`;
  const b = `${right.metadata.name}@${right.metadata.version}:${posix(path.relative(repository, right.root))}`;
  return a < b ? -1 : a > b ? 1 : 0;
});
for (const [index, record] of ordered.entries()) record.destination = `.packages/${String(index).padStart(4, "0")}`;

// Preflight source graphs and output ownership before creating the new artifact.
const transfers = [];
const fileRecords = [];
const links = [];
async function inventoryTree(root, destination, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const next = path.join(relative, entry.name);
    const source = path.join(root, next);
    const target = posix(path.join(destination, next));
    if (entry.isDirectory()) await inventoryTree(root, destination, next);
    else if (entry.isSymbolicLink()) {
      const link = await readlink(source);
      if (path.isAbsolute(link) || !inside(root, path.resolve(path.dirname(source), link))) throw new Error(`Escaping package resource symlink: ${source}`);
      links.push({ path: target, target: posix(link) });
    } else if (entry.isFile()) {
      const bytes = await readFile(source);
      const mode = (await lstat(source)).mode & 0o777;
      transfers.push({ target, source, sha256: sha(bytes), mode });
      fileRecords.push({ path: target, sha256: sha(bytes), bytes: bytes.length, mode });
    } else throw new Error(`Unsupported package resource: ${source}`);
  }
}
// Preserve package depth: paths.ts derives artifact-owned root via ../../../../ from dist.
await inventoryTree(buildRoot, "apps/server/agent/dist");
if (options.has("--web-dist")) await inventoryTree(await realpath(options.get("--web-dist")), "apps/web/dist");
for (const record of ordered) {
  await inventoryTree(record.root, record.destination);
  for (const [name, dependency] of record.dependencies) {
    const link = `${record.destination}/node_modules/${name}`;
    links.push({ path: link, target: posix(path.relative(path.dirname(link), packages.get(dependency).destination)) });
  }
}
for (const [name, dependency] of topLevel) {
  const link = `node_modules/${name}`;
  links.push({ path: link, target: posix(path.relative(path.dirname(link), packages.get(dependency).destination)) });
}
const licenseInputs = new Map();
for (const relative of buildInputs.inputs) {
  const input = path.resolve(repository, relative);
  if (!inside(repository, input)) throw new Error(`Outside-repository build input: ${relative}`);
  if (sha(await readFile(input)) !== buildInputs.inputHashes?.[relative]) throw new Error(`Source changed after build: ${relative}`);
  let current = path.dirname(input);
  while (inside(repository, current)) {
    const metadata = await readFile(path.join(current, "package.json"), "utf8").then(JSON.parse).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (metadata?.name === "effect") throw new Error("Effect was bundled; production must retain one external singleton.");
    if (metadata?.name) { licenseInputs.set(current, metadata); break; }
    current = path.dirname(current);
  }
}
const bundled = [];
let licenseIndex = 0;
for (const [root, metadata] of [...licenseInputs].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
  const notices = [];
  for (const name of (await readdir(root)).sort()) {
    if (!/^(?:licen[cs]e|copying|notice|copyright)(?:\.|$)/i.test(name) || !(await lstat(path.join(root, name))).isFile()) continue;
    const source = path.join(root, name), bytes = await readFile(source);
    const target = `licenses/bundled/${String(licenseIndex).padStart(4, "0")}/${name}`;
    transfers.push({ target, source, sha256: sha(bytes), mode: 0o644 });
    fileRecords.push({ path: target, sha256: sha(bytes), bytes: bytes.length, mode: 0o644 });
    notices.push(target);
  }
  bundled.push({ name: metadata.name, version: metadata.version ?? null, license: metadata.license ?? null, notices });
  licenseIndex++;
}
const vendorRoot = path.join(repository, "vendor/t3code");
const provenance = ["LICENSE.t3code", "pnpm-lock.yaml", "vendor/t3code/LICENSE", "vendor/t3code/SYNC.md",
  ...(await readdir(vendorRoot)).filter((name) => name.endsWith(".json")).sort().map((name) => `vendor/t3code/${name}`)];
for (const relative of provenance) {
  const bytes = await readFile(path.join(repository, relative));
  const target = `licenses/provenance/${relative}`;
  transfers.push({ target, source: path.join(repository, relative), sha256: sha(bytes), mode: 0o644 });
  fileRecords.push({ path: target, sha256: sha(bytes), bytes: bytes.length, mode: 0o644 });
}
await inventoryTree(path.join(vendorRoot, "integration-patches"), "licenses/provenance/vendor/t3code/integration-patches");
await inventoryTree(path.join(vendorRoot, "third-party/patches"), "licenses/provenance/vendor/t3code/third-party/patches");
await inventoryTree(path.join(vendorRoot, "third-party-licenses"), "licenses/provenance/vendor/t3code/third-party-licenses");
{
  const source = path.join(packageRoot, "scripts/verify-artifact.mjs");
  const bytes = await readFile(source), target = "tools/verify-artifact.mjs";
  transfers.push({ target, source, sha256: sha(bytes), mode: 0o644 });
  fileRecords.push({ path: target, sha256: sha(bytes), bytes: bytes.length, mode: 0o644 });
}
// Refuse an existing directory, including empty, and symlinked destination ancestors.
let ancestor = path.parse(outputRoot).root;
for (const part of outputRoot.split(path.sep).filter(Boolean)) {
  ancestor = path.join(ancestor, part);
  const info = await lstat(ancestor).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info && (ancestor === outputRoot || !info.isDirectory() || info.isSymbolicLink())) throw new Error(`Artifact output must be new with safe ancestors: ${ancestor}`);
}
await mkdir(outputRoot, { recursive: true });
for (const entry of transfers) {
  const bytes = await readFile(entry.source);
  if (sha(bytes) !== entry.sha256) throw new Error(`Input changed during packaging: ${entry.target}`);
  const target = path.join(outputRoot, entry.target);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: "wx", mode: entry.mode });
  await chmod(target, entry.mode);
}
for (const link of links.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
  const target = path.join(outputRoot, link.path);
  if (!inside(outputRoot, path.resolve(path.dirname(target), link.target))) throw new Error(`Escaping artifact link: ${link.path}`);
  await mkdir(path.dirname(target), { recursive: true });
  await symlink(link.target, target);
}
await writeFile(path.join(outputRoot, "package.json"), JSON.stringify({ name: "pm-agent-distribution", private: true, type: "module", scripts: { start: "node apps/server/agent/dist/index.mjs" }, engines: { node: ">=22.18.0" } }, null, 2) + "\n", { flag: "wx" });
await writeFile(path.join(outputRoot, "artifact-manifest.json"), JSON.stringify({
  version: 1, upstreamCommit: "30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c", platform: process.platform, arch: process.arch,
  entrypoint: "apps/server/agent/dist/index.mjs", effectSingleton: effectRoot ? packages.get(effectRoot).destination : null,
  packages: ordered.map((record) => ({ name: record.metadata.name, version: record.metadata.version, license: record.metadata.license ?? null, path: record.destination, dependencies: Object.fromEntries([...record.dependencies].map(([name, root]) => [name, packages.get(root).destination])) })),
  bundled, files: fileRecords.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0), links,
}, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ output: outputRoot, packages: ordered.length, files: fileRecords.length, links: links.length, nativeTarget: `${process.platform}-${process.arch}` }));
