import { execFile } from "node:child_process";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import { join, posix, relative } from "node:path";
import { hashFile, portable } from "./runtime-manifest.mjs";
import { promisify } from "node:util";
const execute = promisify(execFile);
const machOMagic = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);

export const dependencyLayoutManifest = "desktop-dependency-layout.json";
const packageName = /^(?:@[a-z0-9._~-]+\/)?(?!\.{1,2}$)[a-z0-9._~-]+$/i;
function safePath(value, allowRoot = false) {
  if (allowRoot && value === ".") return value;
  if (typeof value !== "string" || !value || /[\\:\0\r\n]/.test(value) || posix.isAbsolute(value)
    || value.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error(`Unsafe desktop dependency layout path: ${value}`);
  return value;
}
const objectMap = (value) => value && typeof value === "object" && !Array.isArray(value);
function dependencies(value) {
  if (!objectMap(value) || Object.entries(value).some(([name, id]) => !packageName.test(name) || typeof id !== "string"))
    throw new Error("Invalid desktop dependency graph bindings.");
  return value;
}

function absentDependencies(value = []) {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !packageName.test(name)) || new Set(value).size !== value.length)
    throw new Error("Invalid absent desktop dependency bindings.");
  return value;
}

async function ownFiles(directory, prefix = "") {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (entry.name === "node_modules" && !prefix) continue;
    const path = join(directory, entry.name);
    const location = prefix ? `${prefix}/${entry.name}` : entry.name;
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Desktop dependency owns a link instead of a physical resource: ${location}`);
    if (info.isDirectory()) files.push(...await ownFiles(path, location));
    else if (info.isFile()) files.push({ path: location, bytes: info.size, mode: info.mode & 0o777, sha256: await hashFile(path) });
    else throw new Error(`Unsupported desktop dependency resource: ${location}`);
  }
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

// No Node loader execution is needed: use Node's actual ancestor node_modules
// search order, and compare physical package identity rather than content hashes.
export function resolveDependencyPath(from, specifier, instances, excluded) {
  const owner = instances.get(from);
  if (from !== excluded && owner?.metadata?.name === specifier && Object.hasOwn(owner.metadata, "exports")) return from;
  for (let directory = from; ; directory = posix.dirname(directory)) {
    if (posix.basename(directory) !== "node_modules") {
      const candidate = posix.join(directory, "node_modules", specifier);
      if (candidate !== excluded && instances.has(candidate)) return candidate;
    }
    if (directory === ".") break;
  }
  return null;
}

export async function verifyDependencyLayout(root, { signedMachO = false } = {}) {
  const manifestPath = join(root, dependencyLayoutManifest);
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error("Desktop dependency layout manifest must be a real file.");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.contexts) || !manifest.contexts.length)
    throw new Error("Missing or unsupported desktop dependency layout contexts.");
  const instances = new Map();
  const contexts = new Set();
  const bins = new Map();
  for (const context of manifest.contexts) {
    safePath(context.root, true);
    if (typeof context.id !== "string" || contexts.has(context.id) || !Array.isArray(context.instances))
      throw new Error("Invalid desktop dependency context.");
    contexts.add(context.id);
    dependencies(context.dependencies);
    if (context.binFiles !== undefined && !Array.isArray(context.binFiles)) throw new Error("Invalid desktop command shim inventory.");
    for (const file of context.binFiles ?? []) {
      safePath(file.path);
      const prefix = posix.join(context.root, "node_modules/.bin");
      if (posix.dirname(file.path) !== prefix || bins.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256))
        throw new Error("Invalid or duplicated desktop command shim.");
      bins.set(file.path, file);
    }
    for (const instance of context.instances) {
      safePath(instance.path);
      safePath(instance.sourceId);
      if (instance.id !== instance.path || instances.has(instance.path) || !packageName.test(instance.name)
        || typeof instance.version !== "string" || !instance.version || !Array.isArray(instance.files)
        || !instance.path.startsWith(context.root === "." ? "node_modules/" : `${context.root}/node_modules/`))
        throw new Error(`Invalid or overlapping desktop dependency instance: ${instance.path}`);
      dependencies(instance.dependencies);
      instances.set(instance.path, { ...instance, context });
    }
  }
  // Inspect every actual dependency root, not only manifest-selected paths.
  // Deeper package-owned template/resource node_modules belong to the exact
  // own-file inventory, not to Node's immediate package dependency graph.
  const actual = new Set();
  const actualBins = new Set();
  async function scan(directory) {
    const packageDirectory = instances.has(portable(relative(root, directory)));
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (packageDirectory && entry.name !== "node_modules") continue;
      const path = join(directory, entry.name);
      const location = portable(relative(root, path));
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Desktop dependency layout contains a link: ${location}`);
      if (!info.isDirectory()) continue;
      if ([".packages", ".pnpm"].includes(entry.name)) throw new Error(`Obsolete or expanded dependency store: ${location}`);
      if (entry.name === "node_modules") {
        for (const child of await readdir(path, { withFileTypes: true })) {
          if (child.name === ".bin") {
            if (!child.isDirectory() || child.isSymbolicLink()) throw new Error("Desktop command shim directory must be real.");
            for (const bin of await readdir(join(path, child.name), { withFileTypes: true })) {
              const member = `${location}/.bin/${bin.name}`;
              const expected = bins.get(member);
              const absolute = join(path, ".bin", bin.name);
              const info = await lstat(absolute);
              if (!bin.isFile() || bin.isSymbolicLink() || !expected || info.size !== expected.bytes || await hashFile(absolute) !== expected.sha256
                || (process.platform === "darwin" && (info.mode & 0o777) !== expected.mode))
                throw new Error(`Missing, changed or unrecorded desktop command shim: ${member}`);
              actualBins.add(member);
            }
            continue;
          }
          if (child.name.startsWith("@")) {
            if (!child.isDirectory() || child.isSymbolicLink()) throw new Error(`Invalid dependency scope: ${location}/${child.name}`);
            for (const scoped of await readdir(join(path, child.name), { withFileTypes: true })) {
              const member = `${location}/${child.name}/${scoped.name}`;
              if (!scoped.isDirectory() || scoped.isSymbolicLink() || !instances.has(member))
                throw new Error(`Undeclared or recursively expanded dependency: ${member}`);
              actual.add(member);
            }
          } else {
            const member = `${location}/${child.name}`;
            if (!child.isDirectory() || child.isSymbolicLink() || !instances.has(member))
              throw new Error(`Undeclared or recursively expanded dependency: ${member}`);
            actual.add(member);
          }
        }
      }
      await scan(path);
    }
  }
  await scan(root);
  if (actualBins.size !== bins.size) throw new Error("Desktop layout is missing a recorded command shim.");
  if (actual.size !== instances.size || [...instances.keys()].some((path) => !actual.has(path)))
    throw new Error("Desktop dependency layout is missing a recorded physical package.");
  for (const instance of instances.values())
    instance.metadata = JSON.parse(await readFile(join(root, instance.path, "package.json"), "utf8"));
  const incoming = new Map([...instances.keys()].map((path) => [path, []]));
  const summaries = [];
  for (const context of manifest.contexts) {
    const roots = [];
    const inspectEdges = (from, bindings, absent = []) => {
      for (const specifier of absentDependencies(absent)) {
        if (Object.hasOwn(bindings, specifier) || resolveDependencyPath(from, specifier, instances))
          throw new Error(`Previously absent desktop dependency became active: ${context.id}:${from} -> ${specifier}`);
      }
      for (const [specifier, id] of Object.entries(bindings)) {
        const expected = instances.get(id);
        if (!expected || expected.context !== context || resolveDependencyPath(from, specifier, instances) !== id)
          throw new Error(`Wrong or missing desktop dependency binding: ${context.id}:${from} -> ${specifier} (${id})`);
        incoming.get(id).push({ from, specifier });
        if (from === context.root) roots.push(id);
      }
    };
    inspectEdges(context.root, context.dependencies, context.absentDependencies);
    let files = (context.binFiles ?? []).length;
    let logicalBytes = (context.binFiles ?? []).reduce((total, file) => total + file.bytes, 0);
    const signedResources = [];
    for (const declared of context.instances) {
      const instance = instances.get(declared.path);
      const metadata = instance.metadata;
      if (metadata.name !== instance.name || metadata.version !== instance.version)
        throw new Error(`Desktop dependency package identity changed: ${instance.path}`);
      for (const name of new Set([...Object.keys(metadata.dependencies ?? {}), ...Object.keys(metadata.optionalDependencies ?? {}), ...Object.keys(metadata.peerDependencies ?? {})])) {
        if (!Object.hasOwn(instance.dependencies, name) && !absentDependencies(instance.absentDependencies).includes(name))
          throw new Error(`Unrecorded package dependency: ${instance.path} -> ${name}`);
      }
      for (const name of absentDependencies(instance.absentDependencies)) {
        if ((Object.hasOwn(metadata.dependencies ?? {}, name) && !Object.hasOwn(metadata.optionalDependencies ?? {}, name))
          || (Object.hasOwn(metadata.peerDependencies ?? {}, name) && metadata.peerDependenciesMeta?.[name]?.optional !== true))
          throw new Error(`Mandatory desktop dependency recorded as absent: ${instance.path} -> ${name}`);
      }
      const listed = new Set();
      for (const file of instance.files) {
        safePath(file.path);
        if (file.path === "node_modules" || file.path.startsWith("node_modules/") || listed.has(file.path)
          || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256))
          throw new Error(`Invalid desktop dependency resource inventory: ${instance.path}`);
        listed.add(file.path);
      }
      const found = await ownFiles(join(root, instance.path));
      const expectedFiles = new Map(instance.files.map((file) => [file.path, file]));
      if (found.length !== expectedFiles.size) throw new Error(`Desktop dependency resources missing, changed or expanded: ${instance.path}`);
      for (const file of found) {
        const expected = expectedFiles.get(file.path);
        if (!expected) throw new Error(`Desktop dependency resource expanded: ${instance.path}/${file.path}`);
        if (process.platform === "darwin" && expected.mode !== file.mode)
          throw new Error(`Desktop dependency executable mode changed: ${instance.path}/${file.path}`);
        if (expected.bytes === file.bytes && expected.sha256 === file.sha256) continue;
        if (!signedMachO || process.platform !== "darwin" || expected.signable !== "mach-o")
          throw new Error(`Desktop dependency resources missing, changed or expanded: ${instance.path}/${file.path}`);
        const absolute = join(root, instance.path, file.path);
        const handle = await open(absolute, "r");
        const magic = Buffer.alloc(4);
        try {
          const { bytesRead } = await handle.read(magic, 0, 4, 0);
          if (bytesRead !== 4 || !machOMagic.has(magic.toString("hex"))) throw new Error(`Signed resource is not Mach-O: ${instance.path}/${file.path}`);
        } finally { await handle.close(); }
        await execute("/usr/bin/codesign", ["--verify", "--strict", absolute], { windowsHide: true });
        signedResources.push({ path: `${instance.path}/${file.path}`, sha256: file.sha256, bytes: file.bytes, sourceSha256: expected.sha256, scope: "Individual Mach-O signature verified after final app bundle signature; original hash verified before signing" });
      }
      files += found.length;
      logicalBytes += found.reduce((total, file) => total + file.bytes, 0);
      inspectEdges(instance.path, instance.dependencies, instance.absentDependencies);
    }
    for (const owner of [context, ...context.instances]) {
      for (const id of Object.values(owner.dependencies)) {
        const target = instances.get(id);
        for (const peer of Object.keys(target.metadata.peerDependencies ?? {})) {
          const ownerPeer = owner.dependencies[peer];
          const targetPeer = target.dependencies[peer];
          if (ownerPeer && targetPeer && ownerPeer !== targetPeer && instances.get(ownerPeer).sourceId === instances.get(targetPeer).sourceId)
            throw new Error(`Desktop dependency split a shared peer runtime object: ${target.path} -> ${peer}`);
        }
      }
    }
    const reachable = new Set();
    function visit(id) {
      if (reachable.has(id)) return;
      reachable.add(id);
      for (const next of Object.values(instances.get(id).dependencies)) visit(next);
    }
    for (const id of roots) visit(id);
    if (reachable.size !== context.instances.length) throw new Error(`Unreachable desktop dependency copies: ${context.id}`);
    const sources = new Map();
    const identities = new Map();
    for (const instance of context.instances) {
      const paths = sources.get(instance.sourceId) ?? [];
      paths.push(instance.path);
      sources.set(instance.sourceId, paths);
      const key = `${instance.name}@${instance.version}`;
      const variants = identities.get(key) ?? new Set();
      variants.add(instance.sourceId);
      identities.set(key, variants);
    }
    const necessaryCopies = [];
    const signature = (instance) => JSON.stringify([
      instance.name, instance.version,
      instance.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      Object.entries(instance.dependencies).map(([name, id]) => [name, instances.get(id).sourceId]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
      [...(instance.absentDependencies ?? [])].sort(),
    ]);
    for (const instance of context.instances) {
      const consumers = incoming.get(instance.path);
      if (consumers.length && consumers.every(({ from, specifier }) => {
        const fallback = resolveDependencyPath(from, specifier, instances, instance.path);
        return fallback && instances.get(fallback).context === context && signature(instance) === signature(instances.get(fallback));
      })) throw new Error(`Redundant recursive dependency copy: ${instance.path}`);
    }
    for (const [sourceId, paths] of sources) {
      if (paths.length < 2) continue;
      if (new Set(paths.map((path) => signature(instances.get(path)))).size !== 1)
        throw new Error(`Canonical dependency identity has inconsistent resources or peer bindings: ${sourceId}`);
      // Copies are valid only when the physical search path makes each necessary.
      // Removing a redundant copy must not leave every consumer bound to the same
      // canonical source through an already-present ancestor placement.
      for (const path of paths) {
        const consumers = incoming.get(path);
        const removable = consumers.length && consumers.every(({ from, specifier }) => {
          const fallback = resolveDependencyPath(from, specifier, instances, path);
          return fallback && instances.get(fallback).context === context && instances.get(fallback).sourceId === sourceId;
        });
        if (removable) throw new Error(`Redundant recursive dependency copy: ${path} (${sourceId})`);
      }
      necessaryCopies.push({ sourceId, paths: [...paths].sort(), reason: "Required by distinct ancestor resolution paths" });
    }
    if (context.effectSingleton !== null) {
      const effect = context.instances.filter((instance) => instance.name === "effect");
      if (effect.length !== 1 || effect[0].id !== context.effectSingleton || effect[0].version !== "4.0.5")
        throw new Error(`Desktop dependency Effect singleton differs: ${context.id}`);
    }
    summaries.push({ id: context.id, root: context.root, sourceCount: sources.size, instanceCount: context.instances.length, files, logicalBytes,
      necessaryCopies, signedResources, peerOrVersionContexts: [...identities].filter(([, variants]) => variants.size > 1).map(([identity, variants]) => ({ identity, sourceIds: [...variants].sort() })) });
  }
  return { status: "passed", manifest: dependencyLayoutManifest, sha256: await hashFile(manifestPath),
    scope: "Exact physical package paths, package-owned resource hashes, ancestor resolution graph and necessary contexts; no hash-based package deletion",
    contexts: summaries };
}
