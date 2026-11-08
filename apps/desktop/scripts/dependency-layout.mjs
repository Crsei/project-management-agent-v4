import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, posix, relative } from "node:path";
import { hashFile, inside, portable } from "./runtime-manifest.mjs";

export const dependencyLayoutFile = "desktop-dependency-layout.json";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const missing = (error) => { if (["ENOENT", "ENOTDIR"].includes(error.code)) return null; throw error; };
const packageSpecifier = (name) => {
  if (!/^(?:@[a-zA-Z0-9._~-]+\/)?[a-zA-Z0-9._~-]+$/.test(name) || name === "." || name === "..")
    throw new Error(`Unsafe dependency specifier: ${name}`);
  return name;
};

// Looking up the package directory (rather than package.json through exports)
// also supports packages that deliberately keep their manifest private.
export async function locateDependency(from, name, boundary) {
  packageSpecifier(name);
  const require = createRequire(join(from, "package.json"));
  const own = await readFile(join(from, "package.json"), "utf8").then(JSON.parse).catch(missing);
  if (own?.name === name && own.exports) {
    const located = await realpath(from);
    if (!inside(boundary, located)) throw new Error(`Package self-reference escapes its production closure: ${name}`);
    return located;
  }
  for (const lookup of require.resolve.paths(name) ?? []) {
    const candidate = join(lookup, name);
    if (!(await lstat(join(candidate, "package.json")).catch(missing))?.isFile()) continue;
    const located = await realpath(candidate);
    if (!inside(boundary, located)) throw new Error(`Dependency escapes its production closure: ${name}`);
    return located;
  }
  return null;
}

function declarations(metadata) {
  return Object.keys({ ...metadata.peerDependencies, ...metadata.dependencies, ...metadata.optionalDependencies }).sort();
}
function optional(metadata, name) {
  return name in (metadata.optionalDependencies ?? {})
    || (!(name in (metadata.dependencies ?? {})) && metadata.peerDependenciesMeta?.[name]?.optional === true);
}

export async function readDependencyGraph(sourceRoot, { roots } = {}) {
  sourceRoot = await realpath(sourceRoot);
  const metadata = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  const graph = { sourceRoot, packages: new Map(), dependencies: new Map(), absentDependencies: [] };
  async function collect(name, from, isOptional) {
    const source = await locateDependency(from, name, sourceRoot);
    if (!source) {
      if (isOptional) return null;
      throw new Error(`Missing production dependency: ${name} from ${portable(relative(sourceRoot, from)) || "."}`);
    }
    const sourceId = portable(relative(sourceRoot, source));
    if (graph.packages.has(sourceId)) return sourceId;
    const metadata = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    if (!metadata.name || !metadata.version) throw new Error(`Dependency lacks package identity: ${sourceId}`);
    const record = { sourceId, source, metadata, dependencies: new Map(), absentDependencies: [] };
    graph.packages.set(sourceId, record);
    for (const dependency of declarations(metadata)) {
      const target = await collect(dependency, source, optional(metadata, dependency));
      if (target) record.dependencies.set(dependency, target);
      else record.absentDependencies.push(dependency);
    }
    return sourceId;
  }
  for (const name of roots ?? Object.keys({ ...metadata.dependencies, ...metadata.optionalDependencies }).sort()) {
    const target = await collect(name, sourceRoot, optional(metadata, name));
    if (target) graph.dependencies.set(name, target);
    else graph.absentDependencies.push(name);
  }
  return graph;
}

// This is electron-builder's already locked BSD-licensed Yarn hoister, used only
// during packaging. No hoister, loader, or source-store alias ships at runtime.
function lockedHoister() {
  const require = createRequire(import.meta.url);
  const builder = createRequire(require.resolve("electron-builder"));
  const library = createRequire(builder.resolve("app-builder-lib"));
  return library("./node-module-collector/hoist.js").hoist;
}

export function planDependencyLayout(graph, { id, root = ".", effectSingleton = false }) {
  if (!/^[a-z0-9-]+$/.test(id) || typeof root !== "string" || /[\\:\0\r\n]/.test(root)
    || root !== "." && (posix.isAbsolute(root) || root.split("/").some((part) => !part || part === "." || part === "..")))
    throw new Error("Unsafe dependency context root.");
  const references = new Map();
  const nodes = new Map();
  function node(sourceId, name) {
    packageSpecifier(name);
    const key = `${name}:${sourceId}`;
    if (nodes.has(key)) return nodes.get(key);
    const record = graph.packages.get(sourceId);
    if (!record) throw new Error(`Unknown canonical dependency identity: ${sourceId}`);
    const reference = digest(sourceId);
    references.set(reference, sourceId);
    // The source graph already resolves peers to canonical identities (including
    // peer contexts). Treat those resolved edges as require promises rather than
    // discarding them as Yarn's unresolved peer placeholders. Every edge and peer
    // consumer identity is checked against the resulting physical lookup below.
    const result = { name, identName: record.metadata.name, reference, dependencies: new Set(), peerNames: new Set() };
    nodes.set(key, result);
    for (const [specifier, target] of record.dependencies) result.dependencies.add(node(target, specifier));
    return result;
  }
  const tree = { name: ".", identName: ".", reference: ".", dependencies: new Set(), peerNames: new Set() };
  for (const [name, sourceId] of graph.dependencies) tree.dependencies.add(node(sourceId, name));
  const hoisted = lockedHoister()(tree, { check: true, debugLevel: -1 });
  const instances = [];
  function visit(parent, directory, ancestors = new Set()) {
    for (const child of [...parent.dependencies].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (ancestors.has(child)) throw new Error("Hoisted dependencies still contain a recursive physical directory graph.");
      if (child.references.size !== 1) throw new Error("Hoister merged distinct canonical dependency contexts.");
      const sourceId = references.get([...child.references][0]);
      if (!sourceId) throw new Error("Hoister emitted an unknown dependency identity.");
      const record = graph.packages.get(sourceId);
      const path = posix.join(directory, "node_modules", packageSpecifier(child.name));
      instances.push({ id: path, sourceId, name: record.metadata.name, version: record.metadata.version, path,
        dependencies: {}, absentDependencies: record.absentDependencies, files: [] });
      visit(child, path, new Set([...ancestors, child]));
    }
  }
  visit(hoisted, root);
  const paths = new Map(instances.map((instance) => [instance.path, instance]));
  function lookup(from, name) {
    const self = paths.get(from);
    if (self?.name === name && graph.packages.get(self.sourceId).metadata.exports) return self;
    let directory = from;
    while (directory === root || directory.startsWith(root === "." ? "" : `${root}/`)) {
      if (posix.basename(directory) !== "node_modules") {
        const found = paths.get(posix.join(directory, "node_modules", name));
        if (found) return found;
      }
      if (directory === root) break;
      directory = posix.dirname(directory);
    }
    return null;
  }
  function bind(owner, source) {
    for (const [name, sourceId] of source.dependencies) {
      const target = lookup(owner.path ?? root, name);
      if (!target || target.sourceId !== sourceId) throw new Error(`Hoisting changed dependency identity: ${owner.path ?? id} -> ${name}`);
      owner.dependencies[name] = target.id;
    }
    for (const name of source.absentDependencies) {
      if (lookup(owner.path ?? root, name)) throw new Error(`Hoisting activated an absent optional dependency: ${owner.path ?? id} -> ${name}`);
    }
  }
  const context = { id, root, dependencies: {}, absentDependencies: graph.absentDependencies, instances, effectSingleton: null };
  bind(context, graph);
  for (const instance of instances) bind(instance, graph.packages.get(instance.sourceId));
  // Where an importer and its dependency shared a peer before, preserve the
  // physical runtime object, not merely a compatible peer version.
  for (const owner of [context, ...instances]) {
    for (const targetId of Object.values(owner.dependencies)) {
      const target = paths.get(targetId);
      const metadata = graph.packages.get(target.sourceId).metadata;
      for (const peer of Object.keys(metadata.peerDependencies ?? {})) {
        if (owner.dependencies[peer] && target.dependencies[peer]
          && owner.dependencies[peer] !== target.dependencies[peer]
          && paths.get(owner.dependencies[peer]).sourceId === paths.get(target.dependencies[peer]).sourceId)
          throw new Error(`Hoisting split a shared peer runtime identity: ${target.path} -> ${peer}`);
      }
    }
  }
  if (effectSingleton) {
    const effects = instances.filter((instance) => instance.name === "effect");
    if (effects.length !== 1 || effects[0].version !== "4.0.5") throw new Error("Agent must retain exactly one physical Effect 4.0.5 singleton.");
    context.effectSingleton = effects[0].id;
  }
  const copies = new Map();
  for (const instance of instances) copies.set(instance.sourceId, (copies.get(instance.sourceId) ?? 0) + 1);
  context.summary = { sourceCount: graph.packages.size, instanceCount: instances.length,
    repeatedSources: [...copies].filter(([, count]) => count > 1).map(([sourceId, instances]) => ({ sourceId, instances })) };
  return context;
}

const machO = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);
async function copyOwnResources(source, destination) {
  const files = [];
  async function copy(directory, target, prefix = "", ancestors = new Set()) {
    const physical = await realpath(directory);
    if (!inside(source, physical)) throw new Error(`Package resource escapes canonical package: ${prefix}`);
    if (ancestors.has(physical)) throw new Error(`Recursive package resource link: ${prefix}`);
    const next = new Set([...ancestors, physical]);
    await mkdir(target, { recursive: true, mode: 0o755 });
    for (const name of (await readdir(directory)).sort()) {
      if (name === ".git" || name === "node_modules" && !prefix) continue;
      const input = join(directory, name), output = join(target, name), path = prefix ? `${prefix}/${name}` : name;
      const physical = await realpath(input);
      if (!inside(source, physical)) throw new Error(`Package resource escapes canonical package: ${path}`);
      const info = await lstat(physical);
      if (info.isDirectory()) await copy(physical, output, path, next);
      else if (info.isFile()) {
        const before = await hashFile(physical);
        const mode = info.mode & 0o111 ? 0o755 : 0o644;
        await copyFile(physical, output);
        await chmod(output, mode);
        if (await hashFile(output) !== before) throw new Error(`Dependency input changed during staging: ${path}`);
        const magic = Buffer.alloc(4);
        const handle = await open(output, "r");
        try { await handle.read(magic, 0, 4, 0); } finally { await handle.close(); }
        files.push({ path, sha256: before, bytes: info.size, mode, ...(machO.has(magic.toString("hex")) ? { signable: "mach-o" } : {}) });
      } else throw new Error(`Unsupported package resource: ${path}`);
    }
  }
  await copy(source, destination);
  return files;
}

// Preserve the deployed PM command surface without retaining pnpm's source-store
// paths or NODE_PATH. The locked toolchain does not expose its bin-linker as a
// module; only the already-shipped Node commands jp/yaml are regenerated.
async function copyCommandShims(graph, context, prepared) {
  const source = join(graph.sourceRoot, "node_modules/.bin");
  const info = await lstat(source).catch(missing);
  if (!info) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Deployed command shim root must be a real directory.");
  const commands = new Map();
  for (const [name, sourceId] of graph.dependencies) {
    const record = graph.packages.get(sourceId);
    const bins = typeof record.metadata.bin === "string"
      ? { [record.metadata.name.split("/").at(-1)]: record.metadata.bin } : record.metadata.bin ?? {};
    for (const [command, target] of Object.entries(bins)) {
      if (!["jp", "yaml"].includes(command)) continue;
      if (typeof target !== "string" || /[\\:\0\r\n"'`$%]/.test(target) || posix.isAbsolute(target)
        || target.split("/").some((part) => part === ".."))
        throw new Error(`Nonportable deployed command target: ${command}`);
      const path = posix.normalize(target);
      const script = await realpath(join(record.source, path));
      if (!inside(record.source, script) || !(await lstat(script)).isFile()
        || !/^#![^\r\n]*\bnode(?:\s|$)/.test(await readFile(script, "utf8")))
        throw new Error(`Deployed command is not an owned Node entrypoint: ${command}`);
      const instance = context.instances.find((instance) => instance.id === context.dependencies[name]);
      const destination = posix.join(instance.path, path);
      commands.set(command, posix.relative(posix.join(context.root, "node_modules/.bin"), destination));
    }
  }
  const files = [];
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const extension = /\.(cmd|ps1)$/i.exec(entry.name)?.[1].toLowerCase() ?? "";
    const command = extension ? entry.name.slice(0, -extension.length - 1) : entry.name;
    const target = commands.get(command);
    if (!target || !entry.isFile()) throw new Error(`Unreviewed deployed command shim: ${entry.name}`);
    const contents = extension === "cmd"
      ? `@ECHO off\r\nSETLOCAL\r\nIF EXIST "%~dp0node.exe" (\r\n  "%~dp0node.exe" "%~dp0${target.replaceAll("/", "\\")}" %*\r\n) ELSE (\r\n  node "%~dp0${target.replaceAll("/", "\\")}" %*\r\n)\r\n`
      : extension === "ps1"
        ? `#!/usr/bin/env pwsh\n$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent\n$node = Join-Path $basedir "node.exe"\nif (-not (Test-Path -LiteralPath $node)) { $node = "node" }\n& $node "$basedir/${target}" @args\nexit $LASTEXITCODE\n`
        : `#!/bin/sh\nbasedir=\${0%/*}\nif [ "$basedir" = "$0" ]; then basedir=.; fi\nif [ -x "$basedir/node" ]; then\n  exec "$basedir/node" "$basedir/${target}" "$@"\nfi\nexec node "$basedir/${target}" "$@"\n`;
    const path = posix.join(context.root, "node_modules/.bin", entry.name);
    const output = join(prepared, path), mode = extension ? 0o644 : 0o755;
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, contents, { flag: "wx", mode });
    await chmod(output, mode);
    files.push({ path, bytes: Buffer.byteLength(contents), sha256: digest(contents), mode });
  }
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

// The caller owns a new staging tree. All source reading/copying completes before
// replacing that tree's original dependency directories; no checkout is changed.
export async function materializeDependencyLayout(graph, context, destinationRoot, scratch) {
  // Match realpath-resolved dependency candidates against the same physical
  // root, including Windows short-name/junction and macOS temp ancestor aliases.
  destinationRoot = await realpath(destinationRoot);
  const prepared = join(scratch, context.id);
  await mkdir(prepared, { recursive: false });
  await mkdir(join(prepared, context.root, "node_modules"), { recursive: true });
  for (const instance of context.instances)
    instance.files = await copyOwnResources(graph.packages.get(instance.sourceId).source, join(prepared, instance.path));
  context.binFiles = await copyCommandShims(graph, context, prepared);
  const destination = join(destinationRoot, context.root, "node_modules");
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  await rm(destination, { recursive: true, force: true });
  await rename(join(prepared, context.root, "node_modules"), destination);
  // Verify actual Node directory lookup on the materialized filesystem as well
  // as the hoister plan, without importing native code on the packaging host.
  const instances = new Map(context.instances.map((instance) => [instance.id, instance]));
  for (const owner of [context, ...context.instances]) {
    const from = join(destinationRoot, owner.path ?? context.root);
    for (const [name, id] of Object.entries(owner.dependencies)) {
      const located = await locateDependency(from, name, destinationRoot);
      if (located !== await realpath(join(destinationRoot, instances.get(id).path)))
        throw new Error(`Physical Node lookup changed dependency identity: ${owner.path ?? context.id} -> ${name}`);
    }
    for (const name of owner.absentDependencies)
      if (await locateDependency(from, name, destinationRoot)) throw new Error(`Physical layout activated an absent optional dependency: ${name}`);
  }
  return context;
}

export async function writeDependencyLayout(root, contexts) {
  const manifest = { schemaVersion: 1, layout: "physical-node-modules", contexts };
  await writeFile(join(root, dependencyLayoutFile), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return manifest;
}
