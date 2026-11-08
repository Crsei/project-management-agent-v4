import { createHash } from "node:crypto";
import { createRequire, isBuiltin } from "node:module";
import { chmod, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertNoRetiredImportEdges, assertRetiredTargetsAbsent, createRetiredImportResolver, validateAdaptationStructure } from "../../vendor/t3code/scripts/mcp-skills-adaptations.mjs";

const require = createRequire(import.meta.url);
const base = "vendor/t3code/";
const paths = {
  manifest: `${base}source-manifest.json`, inventory: `${base}sync-inventory.json`,
  adaptations: `${base}mcp-skills-adaptations.json`, supplemental: `${base}mcp-skills-source.json`,
  imports: `${base}sync-imports.json`, policy: "scripts/upstream-sync/t3code-policy.json",
};
const generated = [paths.manifest, paths.inventory, paths.adaptations, paths.imports];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const blobHash = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const encode = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sorted = values => [...new Set(values)].sort(order);
const under = (name, directory) => name === directory || name.startsWith(`${directory}/`);
const canonicalMode = mode => mode === "100755" ? 0o755 : mode === "100644" ? 0o644 : (() => { throw new Error(`Unsupported Git mode: ${mode}`); })();
const missing = error => { if (error.code === "ENOENT") return null; throw error; };
function relative(name, treeEntry = false) {
  if (typeof name !== "string" || !name || /[\\\0\r\n]/.test(name) || path.posix.isAbsolute(name) || /^[A-Za-z]:/.test(name) || name.split("/").some(part => !part || [".", "..", ".git"].includes(part) || !treeEntry && (["node_modules", ".env"].includes(part) || part.startsWith(".env.")))) throw new Error(`Unsafe profile path: ${name}`);
  return name;
}
async function safeFile(root, name, allowDirectory = false) {
  let current = path.resolve(root);
  const rootInfo = await lstat(current);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || await realpath(current) !== current) throw new Error(`Unsafe profile root: ${root}`);
  // Scanner existence probes follow the legacy resolver's normalized
  // file-or-directory semantics. Ledger reads/writes remain file-only.
  const normalized = allowDirectory && typeof name === "string" ? path.posix.normalize(name) : name;
  const probeName = allowDirectory && typeof normalized === "string" && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  const parts = allowDirectory && probeName === "." ? [] : relative(probeName).split("/");
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const info = await lstat(current).catch(missing);
    if (info) {
      const final = index === parts.length - 1;
      const acceptable = final ? info.isFile() || allowDirectory && info.isDirectory() : info.isDirectory();
      if (info.isSymbolicLink() || !acceptable || final && info.isFile() && info.mode & 0o7000) throw new Error(`Unsafe profile file: ${name}`);
    }
  }
  return current;
}
async function bytesAt(root, name) { return readFile(await safeFile(root, name)); }
async function pathExists(root, name) {
  return Boolean(await lstat(await safeFile(root, name, true)).catch(missing));
}
async function documents(root) {
  const bytes = new Map();
  const values = {};
  for (const [key, name] of Object.entries(paths)) {
    const data = key === "policy" ? await readFile(new URL("./t3code-policy.json", import.meta.url)) : await bytesAt(root, name);
    bytes.set(name, data);
    values[key] = JSON.parse(data);
  }
  const { manifest, inventory, adaptations, supplemental, imports, policy } = values;
  const retirements = validateAdaptationStructure(adaptations);
  const retired = new Set(retirements.map(entry => entry.destination));
  if (inventory.files.some(entry => retired.has(entry.destination))) throw new Error("Retired output still has a baseline reconstruction owner");
  await assertRetiredTargetsAbsent(root, retirements);
  assertNoRetiredImportEdges(imports, retirements);
  if (!/^[a-f0-9]{40}$/.test(manifest.upstream?.commit) || inventory.version !== 1 || adaptations.version !== 1 || policy.version !== 1 || policy.id !== "t3code" || inventory.upstreamCommit !== manifest.upstream.commit || inventory.sourceManifestSha256 !== hash(bytes.get(paths.manifest)) || adaptations.baselineCommit !== manifest.upstream.commit) throw new Error("T3 source manifest/inventory identity mismatch");
  if (!adaptations.sources.some(entry => entry.commit === manifest.upstream.commit) || !adaptations.sources.some(entry => entry.commit === supplemental.upstream.commit)) throw new Error("T3 dual-source identity mismatch");
  return { ...values, bytes };
}
function inputFrom(entry, commit) {
  return { path: relative(entry.source_path ?? entry.path), commit: entry.commit ?? commit, sha256: entry.sha256, bytes: entry.bytes, gitMode: entry.git_mode ?? entry.gitMode ?? entry.mode, blob: entry.git_blob_sha1 ?? entry.gitBlobSha1 ?? entry.blob };
}
function addInput(inputs, input) {
  const key = `${input.commit}:${input.path}`;
  const previous = inputs.get(key);
  if (previous && JSON.stringify(previous) !== JSON.stringify(input)) throw new Error(`Contradictory T3 source identity: ${key}`);
  inputs.set(key, input);
}

/** Ledger identities only: live output and host drift is reported by the core. */
export async function loadProfile(root) {
  const { manifest, inventory, adaptations, supplemental, policy } = await documents(root);
  const commit = manifest.upstream.commit;
  const inputs = new Map();
  const originals = new Map(manifest.files.map(entry => [relative(entry.source_path), entry]));
  for (const entry of manifest.files) addInput(inputs, inputFrom(entry, commit));
  for (const source of adaptations.sources) {
    const entry = source.license.gitMode ? source.license
      : source.commit === commit ? originals.get(source.license.path) : supplemental.files.find(entry => entry.path === source.license.path);
    if (!entry || entry.sha256 !== source.license.sha256) throw new Error(`Uninventoried source license: ${source.commit}`);
    addInput(inputs, inputFrom(entry, source.commit));
  }
  const outputs = new Map();
  for (const entry of inventory.files) {
    const name = relative(entry.destination);
    if (outputs.has(name)) throw new Error(`Duplicate T3 output: ${name}`);
    const original = entry.source && originals.get(entry.source);
    if (entry.source && (!original || !original.action.startsWith("copy") || original.destination_path !== name || entry.upstreamSha256 !== original.sha256)) throw new Error(`Unmapped T3 source: ${name}`);
    if (![0o644, 0o755].includes(entry.mode)) throw new Error(`Invalid output mode: ${name}`);
    outputs.set(name, { path: name, sourcePath: entry.source ?? null, sourceCommit: entry.source ? commit : null, sha256: entry.sha256, bytes: entry.bytes, mode: entry.mode, kind: entry.source ? entry.patch ? "patched" : "pristine" : "local" });
  }
  for (const entry of adaptations.outputs) {
    const mapped = (entry.inputs ?? []).map(value => inputFrom(value));
    for (const input of mapped) addInput(inputs, input);
    const name = relative(entry.destination);
    if (Object.hasOwn(entry, "retirement")) continue;
    const previous = outputs.get(name);
    if (previous && (previous.sha256 !== entry.sha256 || previous.mode !== entry.mode)) throw new Error(`Contradictory baseline/adaptation output: ${name}`);
    outputs.set(name, { path: name, sourcePath: mapped[0]?.path ?? null, sourceCommit: mapped[0]?.commit ?? null, sha256: entry.sha256, bytes: entry.bytes, mode: entry.mode, kind: mapped.length ? "derived" : "local", inputs: mapped });
  }
  for (const extraction of inventory.extractions ?? []) {
    const output = outputs.get(relative(extraction.destination));
    const original = originals.get(relative(extraction.source));
    if (!output || !original || original.sha256 !== extraction.sourceSha256) throw new Error(`Unmapped extraction: ${extraction.destination}`);
    const input = inputFrom(original, commit);
    outputs.set(extraction.destination, { ...output, sourcePath: input.path, sourceCommit: commit, kind: "derived", inputs: [input] });
  }
  const metadataPaths = sorted([
    ...Object.values(paths).filter(name => name !== paths.policy), `${base}omp-source.json`, `${base}integration-patches.json`,
    ...(manifest.implementation_inventory?.family_ledgers ?? []).map(name => `${base}${relative(name)}`),
    ...inventory.files.filter(entry => entry.patch || entry.asset && /\.(?:json|mjs|py)$/.test(entry.asset) && !entry.asset.includes("/packages/")).map(entry => entry.patch?.path ?? entry.asset),
  ]);
  return {
    id: "t3code", upstreamUrl: policy.upstreamUrl, upstreamCommit: commit,
    manifestPath: paths.manifest, inventoryPath: paths.inventory, metadataPaths,
    inputs: [...inputs.values()].sort((a, b) => order(`${a.commit}:${a.path}`, `${b.commit}:${b.path}`)),
    outputs: [...outputs.values()].sort((a, b) => order(a.path, b.path)),
    hostInputs: inventory.runtimeResources?.hostBuildInputs ?? [],
    selection: {
      trees: manifest.packages.filter(entry => entry.scope === "complete-package").map(entry => relative(entry.root)).sort(order),
      files: sorted([...inputs.values()].filter(entry => entry.commit === commit).map(entry => entry.path)),
    },
    protectedPaths: policy.protectedPaths,
    authoringPaths: generated,
    authoringTrees: [`${base}integration-patches`],
    verification: [
      { id: "actual-import-closure", command: "node", args: [`${base}scripts/imports.mjs`, "--check"] },
      { id: "retained-source-types", command: "pnpm", args: ["--dir", "vendor/t3code", "typecheck"] },
      { id: "retained-source-tests", command: "pnpm", args: ["--dir", "vendor/t3code", "test"] },
      { id: "host-types", command: "pnpm", args: ["typecheck:agent"] },
      { id: "host-lint", command: "pnpm", args: ["lint:agent"] },
      { id: "host-tests", command: "pnpm", args: ["test:agent"] },
      { id: "web-lint", command: "pnpm", args: ["--filter", "@pm/web", "lint"] },
      { id: "web-build", command: "pnpm", args: ["--filter", "@pm/web", "build"] },
      { id: "web-tests", command: "pnpm", args: ["--filter", "@pm/web", "test"] },
      { id: "agent-build", command: "pnpm", args: ["build:agent"] },
      { id: "portable-package", command: "node", args: ["apps/server/agent/scripts/package.mjs", "--build", "apps/server/agent/dist", "--output", "/workspace/.upstream-sync/verification-output/t3-artifact"] },
      { id: "isolated-artifact", command: "node", args: ["/workspace/.upstream-sync/verification-output/t3-artifact/tools/verify-artifact.mjs", "--artifact", "/workspace/.upstream-sync/verification-output/t3-artifact"] },
    ],
    verificationLimitations: [
      "Requires preprovisioned lockfile-matching candidate dependencies, Node/pnpm and approved Rust/Cargo/C/C++ toolchains; never mount the operator Home or credentials.",
      "Agent packaging requires the existing cc-switch native sidecar and other-fork provenance to remain valid; a cross-fork mismatch blocks rather than authorizing recapture.",
      "Isolated artifact checks are credential-free. Real Provider accounts, cross-version native continuation, desktop platforms and publication still require separate explicit parent acceptance.",
    ],
    policy,
  };
}

function lines(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\0")) throw new Error("Binary adaptation requires explicit non-text handling");
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
// The existing format permits a single exact range. Keep the common prefix and
// suffix so a regenerated recipe remains reviewable without a second diff codec.
function splices(before, after) {
  const old = lines(before), next = lines(after);
  let start = 0, end = old.length, nextEnd = next.length;
  while (start < end && start < nextEnd && old[start] === next[start]) start++;
  while (end > start && nextEnd > start && old[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
  return start === end && start === nextEnd ? [] : [{ start, before: old.slice(start, end), after: next.slice(start, nextEnd) }];
}
function replay(original, edits, name) {
  const source = lines(original), result = [];
  let cursor = 0;
  if (!Array.isArray(edits)) throw new Error(`Invalid exact recipe: ${name}`);
  for (const item of edits) {
    if (!Number.isInteger(item.start) || item.start < cursor || item.start > source.length || !Array.isArray(item.before) || !Array.isArray(item.after) || ![...item.before, ...item.after].every(value => typeof value === "string")) throw new Error(`Invalid exact ranges: ${name}`);
    const end = item.start + item.before.length;
    if (end > source.length || source.slice(item.start, end).join("") !== item.before.join("")) throw new Error(`Exact preimage mismatch: ${name}`);
    result.push(...source.slice(cursor, item.start), ...item.after);
    cursor = end;
  }
  result.push(...source.slice(cursor));
  return Buffer.from(result.join(""));
}
function objectReader(readBlob, listTree) {
  const trees = new Map(), blobs = new Map();
  async function tree(commit) {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error(`Invalid immutable commit: ${commit}`);
    if (!trees.has(commit)) trees.set(commit, Promise.resolve(listTree(commit)).then(entries => {
      const result = new Map();
      for (const entry of entries) {
        relative(entry.path, true);
        if (result.has(entry.path)) throw new Error(`Duplicate Git tree path: ${entry.path}`);
        result.set(entry.path, entry);
      }
      return result;
    }));
    return trees.get(commit);
  }
  async function get(commit, name, expected) {
    relative(name);
    const entry = (await tree(commit)).get(name);
    if (!entry || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) throw new Error(`Missing or unsafe immutable input: ${commit}:${name}`);
    const key = `${commit}:${name}`;
    if (!blobs.has(key)) blobs.set(key, Promise.resolve(readBlob(commit, name)).then(value => Buffer.from(value)));
    const bytes = await blobs.get(key);
    const identity = { path: name, commit, sha256: hash(bytes), bytes: bytes.length, gitMode: entry.mode, blob: blobHash(bytes) };
    if (identity.blob !== entry.blob || expected && ["sha256", "bytes", "gitMode", "blob"].some(field => expected[field] !== undefined && expected[field] !== identity[field])) throw new Error(`Immutable source hash/blob/mode mismatch: ${key}`);
    return { bytes, identity };
  }
  return { tree, get };
}
function decision(plan, name, changedInputs = []) {
  return (plan.reviews ?? []).find(review => review.outputPath === name && ["integrated", "not-applicable"].includes(review.disposition) && typeof review.reason === "string" && review.reason.trim() && changedInputs.every(input => (review.inputs ?? []).some(value => value.path === input.path && value.commit === input.commit && value.sha256 === input.sha256)));
}

// Uses the installed, trusted parser, never a parser or script supplied by the
// source repository or candidate. Output fields/order match scripts/imports.mjs.
async function scanGraph(names, getBytes, exists, packageNames, owned = new Set(names), retiredTarget = () => null) {
  const ts = require("typescript");
  const packages = new Map();
  for (const name of packageNames.sort(order)) {
    const metadata = JSON.parse(await getBytes(name));
    if (typeof metadata.name === "string") packages.set(metadata.name, { root: path.posix.dirname(name), exports: metadata.exports ?? {}, types: metadata.types ?? null });
  }
  function condition(value) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return null;
    return condition(value.import) ?? condition(value.default) ?? condition(value.types);
  }
  async function fileTarget(name) {
    const ext = name.endsWith(".js") ? name.slice(0, -3) + ".ts" : name.endsWith(".mjs") ? name.slice(0, -4) + ".mts" : name.endsWith(".cjs") ? name.slice(0, -4) + ".cts" : name;
    for (const candidate of [name, ext, `${name}.ts`, `${name}.tsx`, `${name}.mjs`, `${name}.js`, `${name}/index.ts`, `${name}/index.js`]) if (await exists(candidate)) return candidate;
    return null;
  }
  async function resolve(source, specifier, resource) {
    const retired = retiredTarget(source, specifier);
    if (retired) throw new Error(`Live consumer of retired output: ${source} -> ${retired}`);
    if (path.posix.isAbsolute(specifier) || /^[A-Za-z]:[\\/]/.test(specifier) || specifier.split(/[\\/]/).includes(".ref") || specifier.startsWith("file:")) return { disposition: "forbidden-source-path", target: null };
    let target;
    if (specifier.startsWith(".")) target = await fileTarget(path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier)));
    else {
      if (isBuiltin(specifier)) return { disposition: "node-builtin", target: null };
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      const workspace = packages.get(name);
      if (!workspace) return { disposition: name.startsWith("@t3tools/") || ["effect-acp", "effect-codex-app-server", "@pm/t3code-provider-server"].includes(name) ? "unresolved-workspace-export" : name.startsWith("@agent-workspace/") ? "pm-host-package" : "external-package", target: null };
      const subpath = specifier.length === name.length ? "." : `.${specifier.slice(name.length)}`;
      let exported = condition(workspace.exports[subpath]);
      if (!exported) for (const [key, value] of Object.entries(workspace.exports)) {
        if (!key.includes("*")) continue;
        const [prefix, suffix] = key.split("*");
        if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) exported = condition(value)?.replaceAll("*", subpath.slice(prefix.length, subpath.length - suffix.length));
      }
      if (!exported) return { disposition: "unresolved-workspace-export", target: null };
      target = await fileTarget(path.posix.normalize(path.posix.join(workspace.root, exported)));
    }
    if (!target) return { disposition: resource ? "runtime-selected-resource" : "unresolved-local", target: null };
    return { disposition: owned.has(target) ? "vendored-source" : target.startsWith(base) ? "uninventoried-vendor" : "pm-host-boundary", target };
  }
  const edges = [];
  for (const source of names.filter(name => /\.(?:[cm]?tsx?|jsx?)$/.test(name)).sort(order)) {
    const ast = ts.createSourceFile(source, (await getBytes(source)).toString("utf8"), ts.ScriptTarget.Latest, true);
    const requireNames = new Set(["require"]), pending = [];
    function add(node, literal, kind, typeOnly = false, resource = false) {
      if (!literal) return;
      const location = { source, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 };
      if (!ts.isStringLiteralLike(literal)) {
        if (resource || ["dynamic-import", "require", "require-resolve"].includes(kind)) pending.push(Promise.resolve({ ...location, specifier: null, expression: literal.getText(ast), kind, usage: typeOnly ? "type-only" : "runtime", disposition: "runtime-selected-resource", target: null }));
      } else pending.push(resolve(source, literal.text, resource).then(resolution => ({ ...location, specifier: literal.text, kind, usage: typeOnly ? "type-only" : "runtime", ...resolution })));
    }
    function visit(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) && /(?:^|\.)createRequire$/.test(node.initializer.expression.getText(ast))) requireNames.add(node.name.text);
      if (ts.isImportDeclaration(node)) add(node, node.moduleSpecifier, "import", node.importClause?.isTypeOnly === true || Boolean(node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.length && node.importClause.namedBindings.elements.every(entry => entry.isTypeOnly) && !node.importClause.name));
      else if (ts.isExportDeclaration(node)) add(node, node.moduleSpecifier, "export", node.isTypeOnly);
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node, node.argument.literal, "import-type", true);
      else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0], "dynamic-import");
        else if (ts.isIdentifier(node.expression) && requireNames.has(node.expression.text)) add(node, node.arguments[0], "require");
        else if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "resolve" && ts.isIdentifier(node.expression.expression) && requireNames.has(node.expression.expression.text)) add(node, node.arguments[0], "require-resolve", false, true);
      } else if (ts.isNewExpression(node) && node.expression.getText(ast) === "URL" && node.arguments?.[1]?.getText(ast) === "import.meta.url") add(node, node.arguments[0], "import-meta-resource", false, true);
      ts.forEachChild(node, visit);
    }
    visit(ast);
    for (const reference of [...ast.referencedFiles, ...ast.typeReferenceDirectives]) {
      const retired = retiredTarget(source, reference.fileName);
      if (retired) throw new Error(`Live reference to retired output: ${source} -> ${retired}`);
    }
    edges.push(...await Promise.all(pending));
  }
  edges.sort((a, b) => order(a.source, b.source) || a.line - b.line || order(a.specifier, b.specifier));
  return { parser: `typescript@${ts.version}`, packages: [...packages].sort(([a], [b]) => order(a, b)).map(([name, metadata]) => ({ name, ...metadata })), edges };
}
// pnpm references can already carry the real package name behind an install
// alias. Preserve their peer/patch suffixes rather than prefixing the alias.
function lockSnapshotKey(name, reference, specifier) {
  if (typeof reference !== "string" || !reference) throw new Error(`Invalid pnpm resolution for ${name}`);
  const value = reference.startsWith("npm:") ? reference.slice(4) : reference;
  const qualified = /^((?:@[^/@()]+\/)?[^/@()]+)@[^@()]+$/;
  if (qualified.test(value.split("(", 1)[0])) return value;
  const alias = typeof specifier === "string" && specifier.startsWith("npm:")
    ? qualified.exec(specifier.slice(4).split("(", 1)[0]) : null;
  return `${alias?.[1] ?? name}@${value}`;
}

async function dependencyGraph(manifest, objects, commit, blockers) {
  const yaml = require("yaml");
  const files = new Set(manifest.files.map(entry => entry.source_path));
  const lockPath = manifest.external_lock_closure?.source_path;
  const lock = lockPath && files.has(lockPath) ? yaml.parseAllDocuments((await objects.get(commit, lockPath)).bytes.toString("utf8"))[manifest.external_lock_closure.yaml_document_index ?? 0]?.toJSON() : null;
  const workspace = files.has("pnpm-workspace.yaml") ? yaml.parse((await objects.get(commit, "pnpm-workspace.yaml")).bytes.toString("utf8")) : {};
  const direct = new Map(), catalogs = {};
  for (const pkg of manifest.packages) {
    const name = pkg.root === "." ? "package.json" : `${pkg.root}/package.json`;
    if (!files.has(name)) continue;
    const metadata = JSON.parse((await objects.get(commit, name)).bytes);
    pkg.name = metadata.name ?? pkg.name;
    pkg.upstream_exports = metadata.exports ?? {};
    pkg.upstream_scripts = metadata.scripts ?? {};
    const previous = new Map((pkg.dependencies ?? []).map(entry => [`${entry.section}:${entry.name}`, entry]));
    pkg.dependencies = [];
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) for (const [dependency, declared] of Object.entries(metadata[section] ?? {}).sort(([a], [b]) => order(a, b))) {
      const catalogName = declared.startsWith("catalog:") ? declared.slice(8) : null;
      const catalog = catalogName === null ? null : (catalogName ? workspace.catalogs?.[catalogName] : workspace.catalog)?.[dependency] ?? null;
      const locked = lock?.importers?.[pkg.root]?.[section]?.[dependency];
      const resolved = lock ? locked?.version ?? null : previous.get(`${section}:${dependency}`)?.resolved ?? null;
      const entry = { ...previous.get(`${section}:${dependency}`), name: dependency, section, declared, catalog, resolved, observed_uses: previous.get(`${section}:${dependency}`)?.observed_uses ?? [] };
      delete entry.workspace_source_root;
      if (declared.startsWith("workspace:")) entry.workspace_source_root = manifest.packages.find(value => value.name === dependency)?.root ?? (resolved?.startsWith("link:") ? path.posix.normalize(path.posix.join(pkg.root, resolved.slice(5))) : null);
      pkg.dependencies.push(entry);
      if (catalog !== null) {
        catalogs[dependency] ??= { specifier: catalog, consumers: [], parent_action: "Review and integrate only scoped dependency changes; preserve the PM compiler and lockfile." };
        catalogs[dependency].consumers.push({ root: pkg.root, section });
      }
      if (resolved && !/^(?:link:|workspace:|file:)/.test(resolved)) {
        const specifier = typeof locked?.specifier === "string" && locked.specifier.startsWith("npm:") ? locked.specifier : catalog ?? declared;
        const key = lockSnapshotKey(dependency, resolved, specifier);
        if (!direct.has(key)) direct.set(key, []);
        direct.get(key).push({ package: pkg.root, section, name: dependency });
      } else if (!declared.startsWith("workspace:") && section !== "peerDependencies" && lock) blockers.push({ code: "BLOCKED_DEPENDENCY", path: name, dependency, reason: "Missing scoped lock resolution" });
    }
  }
  manifest.required_catalog_entries = catalogs;
  if (!lock) return;
  const queue = [...direct.keys()], seen = new Set(), snapshots = [];
  for (let index = 0; index < queue.length; index++) {
    const key = queue[index];
    if (seen.has(key)) continue;
    seen.add(key);
    const snapshot = lock.snapshots?.[key];
    const metadata = lock.packages?.[key.replace(/\(.*/, "")];
    if (!snapshot || !metadata) { blockers.push({ code: "BLOCKED_DEPENDENCY", path: lockPath, dependency: key, reason: "Missing reachable lock snapshot/package" }); continue; }
    snapshots.push({ key, package: metadata, snapshot, direct_consumers: direct.get(key) ?? [] });
    for (const section of ["dependencies", "optionalDependencies"]) for (const [name, version] of Object.entries(snapshot[section] ?? {})) if (!/^(?:link:|workspace:|file:)/.test(version)) queue.push(lockSnapshotKey(name, version));
  }
  manifest.external_lock_closure.snapshots = snapshots.sort((a, b) => order(a.key, b.key));
}

function refreshExternalDependencies(manifest, blockers) {
  const external = new Map(), differences = new Map();
  for (const pkg of manifest.packages) for (const dependency of pkg.dependencies ?? []) dependency.observed_uses = [];
  for (const edge of manifest.imports) {
    if (!edge.specifier || edge.specifier.startsWith(".") || isBuiltin(edge.specifier)) continue;
    const name = edge.specifier.startsWith("@") ? edge.specifier.split("/").slice(0, 2).join("/") : edge.specifier.split("/")[0];
    const owner = manifest.packages.filter(pkg => pkg.root === "." || under(edge.source, pkg.root)).sort((a, b) => b.root.length - a.root.length)[0];
    // The resolver has already checked the owning manifest's exports and file
    // target. A valid package self-reference is not a dependency declaration.
    if (owner && name === owner.name && edge.resolution === "workspace" && edge.target && (owner.root === "." || under(edge.target, owner.root))) continue;
    const declarations = (owner?.dependencies ?? []).filter(entry => entry.name === name || entry.name === `@types/${name.replace(/^@/, "").replace("/", "__")}`);
    if (!declarations.length) blockers.push({ code: "BLOCKED_UNDECLARED_DEPENDENCY", path: edge.source, dependency: name });
    const context = `${edge.context}:${edge.usage}`;
    for (const declaration of declarations) declaration.observed_uses = sorted([...declaration.observed_uses, context]);
    if (owner && edge.context === "runtime" && edge.usage === "runtime" && declarations.length && !declarations.some(entry => ["dependencies", "optionalDependencies"].includes(entry.section))) {
      const key = `${owner.root}:${name}`;
      if (!differences.has(key)) differences.set(key, { manifest: owner.root === "." ? "package.json" : `${owner.root}/package.json`, dependency: name, declared_sections: sorted(declarations.map(entry => entry.section)), required_section: "dependencies", sources: [] });
      const sources = differences.get(key).sources;
      if (!sources.some(entry => entry.path === edge.source && entry.specifier === edge.specifier)) sources.push({ path: edge.source, specifier: edge.specifier });
    }
    if (edge.target) continue;
    if (!external.has(name)) external.set(name, { specifier_package: name, dependency_package: declarations[0]?.name ?? name, contexts: [], declarations: [] });
    const item = external.get(name);
    item.contexts = sorted([...item.contexts, context]);
    for (const declaration of declarations) if (!item.declarations.some(entry => entry.declared_by === owner.root && entry.section === declaration.section)) item.declarations.push({ ...declaration, declared_by: owner.root });
  }
  manifest.manifest_differences = [...differences].sort(([a], [b]) => order(a, b)).map(([, value]) => value);
  manifest.external_dependencies = [...external.values()].sort((a, b) => order(a.specifier_package, b.specifier_package));
  for (const external of manifest.external_dependencies) external.declarations = external.declarations.map(declaration => ({
    ...manifest.packages.find(pkg => pkg.root === declaration.declared_by).dependencies.find(entry => entry.name === declaration.name && entry.section === declaration.section),
    declared_by: declaration.declared_by,
  }));
}

function extractionRanges(extraction, before, after) {
  const old = lines(before), next = lines(after), ranges = [];
  for (const range of extraction.lines.split(",")) {
    const match = /^(\d+)-(\d+)$/.exec(range);
    if (!match || Number(match[1]) < 1 || Number(match[2]) < Number(match[1]) || Number(match[2]) > old.length) return null;
    const selected = old.slice(Number(match[1]) - 1, Number(match[2]));
    const matches = [];
    for (let index = 0; index <= next.length - selected.length; index++) if (selected.every((line, offset) => line === next[index + offset])) matches.push(index);
    if (matches.length !== 1) return null;
    ranges.push(`${matches[0] + 1}-${matches[0] + selected.length}`);
  }
  return ranges.join(",");
}

function reviewedRanges(value, bytes) {
  if (typeof value !== "string" || !/^\d+-\d+(?:,\d+-\d+)*$/.test(value)) return null;
  const count = lines(bytes).length;
  let previous = 0;
  for (const range of value.split(",")) {
    const [start, end] = range.split("-").map(Number);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= previous || end < start || end > count) return null;
    previous = end;
  }
  return value;
}

async function refreshLicenseOverrides(manifest, objects, commit) {
  const configPath = manifest.licenses?.upstream_license_config_reference;
  if (!configPath || !manifest.files.some(entry => entry.source_path === configPath)) return;
  const config = JSON.parse((await objects.get(commit, configPath)).bytes);
  const versions = (manifest.external_lock_closure?.snapshots ?? []).map(entry => entry.key.replace(/\(.*/, ""));
  manifest.licenses.selected_package_overrides = (config.packageOverrides ?? []).filter(entry => versions.some(version => entry.version ? version === `${entry.name}@${entry.version}` : version.startsWith(`${entry.name}@`)));
  manifest.licenses.nonmatching_version_overrides_reference_only = (config.packageOverrides ?? []).filter(entry => entry.version && versions.some(version => version.startsWith(`${entry.name}@`)) && !versions.includes(`${entry.name}@${entry.version}`));
}

/** Create a fresh generation of the existing formats, never a pin-only capture. */
export async function recordGeneration({ root, source, targetCommit, plan, readBlob, listTree }) {
  void source; // The core supplies immutable object readers; no worktree is read.
  if (typeof readBlob !== "function" || typeof listTree !== "function") throw new Error("T3 generation requires immutable object readers");
  const docs = await documents(root);
  const { manifest, inventory, adaptations, policy } = docs;
  const oldCommit = manifest.upstream.commit;
  const reauthor = plan.reauthorGeneration === true;
  const initialLocalAuthoring = plan.initialLocalAuthoring === true;
  if (initialLocalAuthoring && (
    !reauthor || plan.purpose !== "local-authoring" || targetCommit !== oldCommit ||
    [plan.oldCommit, plan.upstreamCommit, plan.newCommit, plan.targetCommit].some(commit => commit !== oldCommit) ||
    !Array.isArray(plan.changes) || plan.changes.length !== 0 ||
    !Array.isArray(plan.approvedSourcePaths ?? []) || (plan.approvedSourcePaths ?? []).length !== 0
  )) throw new Error("Initial local authoring requires explicit same-pin local-authoring intent with no source changes");
  const existingGenerationAuthoring = reauthor && manifest.generation !== undefined && manifest.generation !== null;
  if (reauthor && (targetCommit !== oldCommit || (existingGenerationAuthoring
    ? manifest.generation.commit !== oldCommit || !/^[a-f0-9]{40}$/.test(manifest.generation.previousCommit)
    : !initialLocalAuthoring))) throw new Error("Same-pin authoring requires an existing recorded maintenance generation");
  if (targetCommit === oldCommit && !reauthor) return { changedPaths: [], notes: ["Already at the production pin; same-commit capture is a separate operation."], blockers: [] };
  if ((plan.oldCommit ?? plan.upstreamCommit ?? oldCommit) !== oldCommit || (plan.newCommit ?? plan.targetCommit ?? targetCommit) !== targetCommit) throw new Error("T3 generation plan pin mismatch");
  const objects = objectReader(readBlob, listTree), blockers = [], pending = new Map(), removals = new Set();
  const changes = plan.changes ?? [];
  const approved = new Set(plan.approvedSourcePaths ?? []);
  const outputApprovals = reauthor ? plan.approvedOutputHashes ?? {} : {};
  if (!outputApprovals || typeof outputApprovals !== "object" || Array.isArray(outputApprovals)) throw new Error("approvedOutputHashes must map exact output paths to SHA256 values");
  const plannedOutputs = new Set(reauthor ? Object.keys(outputApprovals) : changes.map(entry => entry.outputPath).filter(Boolean));
  for (const review of plan.reviews ?? []) if (review.disposition === "deferred" || review.disposition === "needs-review") blockers.push({ code: "BLOCKED_DEFERRED_REVIEW", path: review.outputPath, reason: review.reason });
  const protectedPath = name => policy.protectedPaths.some(prefix => under(name, prefix));
  const schedule = (name, bytes, mode = 0o644) => {
    relative(name);
    if (protectedPath(name)) throw new Error(`Protected local/cross-fork output: ${name}`);
    pending.set(name, { bytes, mode });
  };
  const current = async name => {
    const file = await safeFile(root, name), info = await lstat(file).catch(missing);
    return info ? { bytes: await readFile(file), mode: info.mode & 0o111 ? 0o755 : 0o644 } : null;
  };
  const profile = await loadProfile(root);
  let reauthorChanged = false;
  if (reauthor) {
    const outputs = new Map(profile.outputs.map(output => [output.path, output]));
    const metadata = new Set(profile.metadataPaths);
    for (const [name, expected] of Object.entries(outputApprovals)) {
      relative(name);
      if (!outputs.has(name) || protectedPath(name) || metadata.has(name) || generated.includes(name) || name.startsWith(`${base}integration-patches/`) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Unapprovable reauthor output: ${name}`);
      const actual = await current(name);
      if (!actual || hash(actual.bytes) !== expected) blockers.push({ code: "BLOCKED_STALE_OUTPUT_APPROVAL", path: name });
    }
    for (const output of profile.outputs) {
      const actual = await current(output.path);
      if (!actual || actual.mode !== output.mode) { blockers.push({ code: "BLOCKED_MODE", path: output.path, reason: "Same-pin byte approval does not authorize deletions or mode changes" }); continue; }
      if (hash(actual.bytes) !== output.sha256) {
        reauthorChanged = true;
        if (outputApprovals[output.path] !== hash(actual.bytes)) blockers.push({ code: "BLOCKED_UNAPPROVED_OUTPUT", path: output.path, reason: "Every same-pin output change needs its exact current SHA256" });
      }
    }
  }
  // Old source identity and every recipe are checked before authoring anything.
  for (const input of profile.inputs) await objects.get(input.commit, input.path, input);
  for (const entry of inventory.files) {
    const actual = await current(entry.destination);
    if (!actual || hash(actual.bytes) !== entry.sha256 || actual.mode !== entry.mode) {
      if (!plannedOutputs.has(entry.destination) && !decision(plan, entry.destination)) blockers.push({ code: "BLOCKED_BASELINE_DRIFT", path: entry.destination, reason: "Unplanned output drift cannot be enrolled" });
      if (protectedPath(entry.destination)) blockers.push({ code: "BLOCKED_PROTECTED", path: entry.destination });
    }
    if (entry.patch) {
      const data = await bytesAt(root, entry.patch.path), patch = JSON.parse(data);
      if (hash(data) !== entry.patch.sha256 || patch.version !== 1 || patch.source !== entry.source || patch.beforeSha256 !== entry.upstreamSha256 || patch.afterSha256 !== entry.sha256 || hash(replay((await objects.get(oldCommit, entry.source)).bytes, patch.splices, entry.destination)) !== entry.sha256) throw new Error(`Invalid old exact recipe: ${entry.destination}`);
    }
  }
  for (const entry of adaptations.outputs) {
    let original;
    if (entry.inputs.length) {
      if (entry.recipe.kind !== "exact-line-splices" || entry.recipe.primaryInput !== 0) throw new Error(`Invalid old adaptation recipe: ${entry.destination}`);
      original = replay((await objects.get(entry.inputs[0].commit, entry.inputs[0].path)).bytes, entry.recipe.splices, entry.destination);
    } else {
      if (entry.recipe.kind !== "local-bytes") throw new Error(`Invalid old local recipe: ${entry.destination}`);
      original = Buffer.from(entry.recipe.base64, "base64");
      if (original.toString("base64") !== entry.recipe.base64) throw new Error(`Invalid old embedded bytes: ${entry.destination}`);
    }
    if (hash(original) !== entry.sha256 || original.length !== entry.bytes) throw new Error(`Invalid old adaptation replay: ${entry.destination}`);
  }
  for (const input of profile.hostInputs) if (hash(await bytesAt(root, input.path)) !== input.sha256) blockers.push({ code: "BLOCKED_BASELINE_DRIFT", path: input.path, reason: "Host build input drift cannot be recaptured" });
  if (blockers.length) return { changedPaths: [], notes: [], blockers };
  if (reauthor && !reauthorChanged) return { changedPaths: [], notes: ["Recorded generation is unchanged; no recapture performed."], blockers: [] };
  const tree = await objects.tree(targetCommit);
  const originalEntries = new Map(manifest.files.map(entry => [entry.source_path, entry]));
  const entries = new Map(originalEntries);
  for (const name of tree.keys()) if (profile.selection.trees.some(directory => under(name, directory)) && !entries.has(name)) {
    if (protectedPath(`${base}${name}`)) { blockers.push({ code: "BLOCKED_PROTECTED", path: name }); continue; }
    entries.set(name, { source_path: name, destination_path: `${base}${name}`, action: "copy-verbatim", category: name.endsWith("package.json") ? "package-manifest" : /(?:LICENSE|NOTICE)/i.test(name) ? "license" : "package-source", owner: "upstream-maintenance", role: /\.(?:test|spec)\./.test(name) ? "test-only" : "runtime-or-build-input" });
  }
  for (const change of changes) if (change.status === "added" && change.sourcePath && !entries.has(change.sourcePath)) {
    if (!approved.has(change.sourcePath) || change.outputPath !== `${base}${change.sourcePath}` || protectedPath(change.outputPath)) { blockers.push({ code: "BLOCKED_SCOPE_EXPANSION", path: change.sourcePath }); continue; }
    entries.set(change.sourcePath, { source_path: change.sourcePath, destination_path: change.outputPath, action: "copy-verbatim", category: "reviewed-dependency", owner: "upstream-maintenance", role: "runtime-or-build-input" });
  }
  const recipes = [], oldRecipes = new Map(inventory.files.filter(entry => entry.source).map(entry => [entry.source, entry]));
  for (const [name, previous] of [...entries].sort(([a], [b]) => order(a, b))) {
    const old = originalEntries.get(name), exists = tree.has(name);
    if (!exists) {
      const consumer = adaptations.outputs.find(entry => !Object.hasOwn(entry, "retirement") && entry.inputs.some(input => input.commit === oldCommit && input.path === name));
      if (consumer || oldRecipes.get(name)?.patch && !decision(plan, previous.destination_path)) blockers.push({ code: "BLOCKED_REMOVED_INPUT", path: name, outputPath: consumer?.destination ?? previous.destination_path, reason: "Removed adapted/derived input needs explicit disposition" });
      if (previous.action.startsWith("copy")) {
        if (await current(previous.destination_path)) blockers.push({ code: "BLOCKED_REMOVED_OUTPUT", path: previous.destination_path, reason: "Candidate still contains removed upstream output" });
        if (oldRecipes.get(name)?.patch) removals.add(oldRecipes.get(name).patch.path);
      }
      entries.delete(name);
      continue;
    }
    const next = await objects.get(targetCommit, name);
    const changed = !old || old.sha256 !== next.identity.sha256 || old.git_mode !== next.identity.gitMode;
    const guarded = policy.adapterRequirements.some(requirement => requirement.sourcePaths.includes(name));
    const reviewRequired = guarded || /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(name) || /(?:^|\/)(?:LICENSE|NOTICE)(?:\.[^/]*)?$|third-party-licenses|(?:^|\/)patches\/|worker|_generated|model-manifest/i.test(name);
    if (changed && reviewRequired && !decision(plan, previous.destination_path ?? paths.manifest, [next.identity])) blockers.push({ code: "BLOCKED_COMPATIBILITY_REVIEW", path: name, reason: guarded ? "Host environment/MCP/auth/continuation protection requires reviewed acceptance" : "Dependency/API/license/resource change requires scoped compatibility review" });
    entries.set(name, { ...previous, sha256: next.identity.sha256, bytes: next.identity.bytes, git_blob_sha1: next.identity.blob, git_mode: next.identity.gitMode });
    if (!previous.action.startsWith("copy")) continue;
    const destination = previous.destination_path;
    if (!under(destination, base.slice(0, -1)) || protectedPath(destination)) throw new Error(`Unsafe selected output: ${destination}`);
    const actual = await current(destination);
    if (!actual) { blockers.push({ code: "BLOCKED_MISSING_OUTPUT", path: destination }); continue; }
    if (reauthor && reviewRequired && hash(actual.bytes) !== oldRecipes.get(name)?.sha256 && !decision(plan, destination, [next.identity])) blockers.push({ code: "BLOCKED_COMPATIBILITY_REVIEW", path: destination, reason: "Same-pin source approval cannot bypass adapter/dependency/resource acceptance" });
    if (!old && !actual.bytes.equals(next.bytes)) { blockers.push({ code: "BLOCKED_ADDED_OUTPUT", path: destination, reason: "New upstream file has unreviewed local bytes" }); continue; }
    if (old && changed && actual.bytes.equals((await objects.get(oldCommit, name)).bytes) && old.action === "copy-verbatim" && !decision(plan, destination, [next.identity])) {
      blockers.push({ code: "BLOCKED_STALE_OUTPUT", path: destination, reason: "Candidate still contains the old pristine source; pin-only reclassification is not integration" });
      continue;
    }
    const changedOutput = !actual.bytes.equals(next.bytes);
    const mode = canonicalMode(next.identity.gitMode);
    if (actual.mode !== mode) { blockers.push({ code: "BLOCKED_MODE", path: destination }); continue; }
    entries.get(name).action = changedOutput ? "copy-then-patch" : "copy-verbatim";
    const recipe = { destination, source: name, upstreamSha256: next.identity.sha256, sha256: hash(actual.bytes), bytes: actual.bytes.length, mode, provenance: changedOutput ? "patched-upstream" : "pristine-upstream" };
    if (changedOutput) {
      const patchPath = `${base}integration-patches/${name}.json`;
      const oldRecipe = oldRecipes.get(name);
      const patchBytes = oldRecipe?.patch && old.sha256 === next.identity.sha256 && oldRecipe.sha256 === recipe.sha256
        ? await bytesAt(root, oldRecipe.patch.path)
        : encode({ version: 1, source: name, beforeSha256: next.identity.sha256, afterSha256: recipe.sha256, format: "Exact zero-based original-line splices; no offsets or fuzz. Lines include original terminators.", rationaleLedgers: [`${base}integration-patches.json`, ...(manifest.implementation_inventory?.family_ledgers ?? []).map(name => `${base}${name}`)], splices: splices(next.bytes, actual.bytes) });
      schedule(patchPath, patchBytes);
      recipe.patch = { path: patchPath, sha256: hash(patchBytes) };
    } else if (oldRecipes.get(name)?.patch) removals.add(oldRecipes.get(name).patch.path);
    recipes.push(recipe);
  }
  for (const entry of adaptations.outputs) {
    if (Object.hasOwn(entry, "retirement")) continue;
    const previousSha256 = entry.sha256, previousPrimarySha256 = entry.inputs[0]?.sha256;
    const changedInputs = [];
    for (let index = 0; index < entry.inputs.length; index++) {
      const input = entry.inputs[index];
      if (input.commit !== oldCommit) continue;
      if (!tree.has(input.path)) { blockers.push({ code: "BLOCKED_REMOVED_DERIVATION", path: input.path, outputPath: entry.destination }); continue; }
      const next = (await objects.get(targetCommit, input.path)).identity;
      if (next.sha256 !== input.sha256 || next.gitMode !== input.gitMode) changedInputs.push(next);
      entry.inputs[index] = { commit: targetCommit, path: next.path, sha256: next.sha256, bytes: next.bytes, gitBlobSha1: next.blob, gitMode: next.gitMode };
    }
    if (changedInputs.length && !decision(plan, entry.destination, changedInputs)) blockers.push({ code: "BLOCKED_DERIVED_REVIEW", path: entry.destination, inputs: changedInputs, reason: "Review every changed derivation input, not only primaryInput" });
    const actual = await current(entry.destination);
    if (!actual) { blockers.push({ code: "BLOCKED_MISSING_OUTPUT", path: entry.destination }); continue; }
    const reviewInputs = reauthor && hash(actual.bytes) !== entry.sha256 ? entry.inputs.map(input => inputFrom(input)) : changedInputs;
    if ((hash(actual.bytes) !== entry.sha256 || actual.mode !== entry.mode) && !decision(plan, entry.destination, reviewInputs)) blockers.push({ code: "BLOCKED_BASELINE_DRIFT", path: entry.destination, inputs: reviewInputs, reason: "Unreviewed derived/local integration drift" });
    entry.sha256 = hash(actual.bytes); entry.bytes = actual.bytes.length; entry.mode = actual.mode;
    if (entry.inputs.length && (previousPrimarySha256 !== entry.inputs[0].sha256 || previousSha256 !== entry.sha256)) entry.recipe = { kind: "exact-line-splices", primaryInput: 0, splices: splices((await objects.get(entry.inputs[0].commit, entry.inputs[0].path)).bytes, actual.bytes) };
    else if (!entry.inputs.length && previousSha256 !== entry.sha256) entry.recipe = { kind: "local-bytes", base64: actual.bytes.toString("base64") };
  }
  manifest.files = [...entries.values()].sort((a, b) => order(a.source_path, b.source_path));
  for (const pkg of manifest.packages) if (Array.isArray(pkg.files)) pkg.files = manifest.files.filter(entry => under(entry.source_path, pkg.root)).map(entry => entry.source_path);
  for (const slice of manifest.consumer_slices ?? []) {
    slice.copy_paths = slice.copy_paths.filter(name => entries.get(name)?.action.startsWith("copy"));
    slice.reference_paths = slice.reference_paths.filter(name => entries.has(name) && !entries.get(name).action.startsWith("copy"));
  }
  const added = manifest.files.filter(entry => !originalEntries.has(entry.source_path));
  if (added.length && Array.isArray(manifest.consumer_slices)) manifest.consumer_slices.push({ owner: "upstream-maintenance", copy_paths: added.filter(entry => entry.action.startsWith("copy")).map(entry => entry.source_path), reference_paths: added.filter(entry => !entry.action.startsWith("copy")).map(entry => entry.source_path) });
  await dependencyGraph(manifest, objects, targetCommit, blockers);
  const selected = manifest.files.filter(entry => entry.action.startsWith("copy")).map(entry => entry.source_path);
  const sourceGraph = await scanGraph(selected, async name => (await objects.get(targetCommit, name)).bytes, async name => tree.get(name)?.type === "blob" && ["100644", "100755"].includes(tree.get(name)?.mode), manifest.packages.map(pkg => pkg.root === "." ? "package.json" : `${pkg.root}/package.json`).filter(name => tree.has(name)), new Set(selected));
  const boundaries = new Set(manifest.adapter_boundaries?.map(entry => entry.source_path) ?? []);
  manifest.imports = sourceGraph.edges.filter(edge => edge.kind !== "import-meta-resource").map(edge => ({
    source: edge.source,
    context: /(?:\.test\.|\/test(?:ing)?\/|fixture|testkit)/i.test(edge.source) ? "test" : "runtime",
    specifier: edge.specifier,
    import_kind: ({ import: "import-statement", export: "import-statement", "import-type": "typescript-import-type", require: "create-require", "require-resolve": "create-require" })[edge.kind] ?? edge.kind,
    usage: edge.usage,
    resolution: edge.target ? edge.specifier?.startsWith(".") ? "local" : "workspace" : edge.disposition === "node-builtin" ? "builtin" : "external",
    target: edge.target,
    disposition: edge.target ? selected.includes(edge.target) ? "copied-source" : "adaptation-boundary" : edge.disposition === "node-builtin" ? "builtin" : edge.disposition === "external-package" ? "external" : edge.disposition,
  }));
  refreshExternalDependencies(manifest, blockers);
  await refreshLicenseOverrides(manifest, objects, targetCommit);
  manifest.runtime_resources ??= {};
  manifest.runtime_resources.static_source_resource_edges = sourceGraph.edges.filter(edge => edge.kind === "import-meta-resource").map(edge => ({ source: edge.source, specifier: edge.specifier, target: edge.target, usage: /(?:\.test\.|fixture|testkit)/i.test(edge.source) ? "test" : "runtime", line: edge.line, disposition: edge.target && selected.includes(edge.target) ? "copied-source" : edge.disposition }));
  for (const edge of sourceGraph.edges) if (["unresolved-local", "unresolved-workspace-export", "forbidden-source-path"].includes(edge.disposition) || edge.target && !entries.has(edge.target) && !boundaries.has(edge.target)) blockers.push({ code: "BLOCKED_SCOPE_EXPANSION", path: edge.source, dependency: edge.target ?? edge.specifier, reason: "New source/resource dependency is outside the reviewed ledger boundary" });
  manifest.upstream = { ...manifest.upstream, commit: targetCommit, head_confirmed: targetCommit, confirmation: "Resolved immutable Git object; generation authoring does not execute source code", source_bytes: "Committed Git blobs with verified SHA256, byte length, mode and blob identity", source_checkout_locator: "Explicit read-only source passed to upstream-sync; no runtime checkout dependency", source_tree_entries: tree.size };
  if (tree.has("apps/server/package.json")) manifest.upstream.app_version = JSON.parse((await objects.get(targetCommit, "apps/server/package.json")).bytes).version;
  manifest.copy_status = "new-generation-pending-integrated-verification";
  const previousGeneration = manifest.generation;
  manifest.generation = {
    previousCommit: existingGenerationAuthoring ? previousGeneration.previousCommit : oldCommit,
    commit: targetCommit,
    purpose: existingGenerationAuthoring ? previousGeneration.purpose ?? "upstream-update" : initialLocalAuthoring ? "local-authoring" : "upstream-update",
    supplementalCommits: adaptations.sources.filter(entry => entry.commit !== oldCommit).map(entry => entry.commit),
    reviews: [...(existingGenerationAuthoring ? previousGeneration.reviews ?? [] : []), ...(plan.reviews ?? [])],
    reauthoringRevision: existingGenerationAuthoring ? (previousGeneration.reauthoringRevision ?? 0) + 1 : 0,
    evidence: "Authoring only; no builds, tests, install, runtime or publish authorization implied",
    previousAnalysis: "Prior implementation/consumer/family verification statements remain historical evidence, not acceptance of this generation",
  };
  if (manifest.client_selection) manifest.client_selection.original_imports = manifest.imports.filter(edge => edge.source.startsWith("packages/client-runtime/"));
  if (manifest.tests) {
    manifest.tests.entrypoints = selected.filter(name => /\.(?:test|spec)\.[cm]?tsx?$/.test(name));
    manifest.tests.fixtures = sorted([...(manifest.tests.fixtures ?? []).filter(name => entries.has(name)), ...selected.filter(name => /(?:\/fixtures?\/|testkit|mock-agent|mock-peer)/i.test(name))]);
    manifest.tests.status = "Retained source inventory only; no acceptance executed for this generation.";
  }
  manifest.summary = { ...manifest.summary, copy_files: selected.length, reference_files: manifest.files.length - selected.length, total_inventoried_files: manifest.files.length, import_edges: manifest.imports.length, retained_behavior_test_files: selected.filter(name => /\.test\.[cm]?tsx?$/.test(name)).length, external_lock_snapshots: manifest.external_lock_closure?.snapshots?.length ?? 0 };
  adaptations.baselineCommit = targetCommit;
  adaptations.policy.sourceManifest = "This generation records verified immutable originals at baselineCommit; prior generation contents remain in Git history. The independent MCP/Skills snapshot is unchanged.";
  adaptations.policy.replay = "Use trusted scripts/upstream-sync/t3code.mjs verifyGeneration for this generation. Legacy same-pin capture/sync commit guards are intentionally unchanged.";
  for (const entry of adaptations.sources.filter(entry => entry.commit === oldCommit)) {
    const nextLicense = (await objects.get(targetCommit, entry.license.path)).identity;
    const next = { ...entry, commit: targetCommit, role: "production baseline for this generation; independent supplemental pin retained", license: { ...entry.license, sha256: nextLicense.sha256, bytes: nextLicense.bytes, gitBlobSha1: nextLicense.blob, gitMode: nextLicense.gitMode } };
    if (targetCommit !== oldCommit && adaptations.outputs.some(output => Object.hasOwn(output, "retirement") && output.inputs.some(input => input.commit === oldCommit))) {
      // Retired recipes retain their original pins, including that pin's license.
      const oldLicense = (await objects.get(oldCommit, entry.license.path)).identity;
      entry.license = { ...entry.license, bytes: oldLicense.bytes, gitBlobSha1: oldLicense.blob, gitMode: oldLicense.gitMode };
      adaptations.sources.push(next);
    } else Object.assign(entry, next);
  }
  // A source update must not change source license coverage silently.
  for (const entry of adaptations.sources) if (!(await objects.get(entry.commit, entry.license.path)).bytes.equals((await current(entry.license.distributedPath))?.bytes ?? Buffer.alloc(0))) blockers.push({ code: "BLOCKED_LICENSE", path: entry.license.distributedPath, commit: entry.commit });
  schedule(paths.manifest, encode(manifest));
  schedule(paths.adaptations, encode(adaptations));
  const inventoryOutputs = sorted([...recipes.map(entry => entry.destination), ...inventory.files.filter(entry => !entry.source && !entry.destination.startsWith(`${base}integration-patches/`)).map(entry => entry.destination)]);
  const allOutputs = sorted([...inventoryOutputs, ...adaptations.outputs.filter(entry => !Object.hasOwn(entry, "retirement")).map(entry => entry.destination)]);
  const retiredTarget = createRetiredImportResolver(root, adaptations.outputs.filter(entry => Object.hasOwn(entry, "retirement")), require("typescript"));
  const actualGraph = await scanGraph(allOutputs, async name => pending.get(name)?.bytes ?? bytesAt(root, name), async name => pathExists(root, name), inventoryOutputs.filter(name => name.endsWith("/package.json") && !name.includes("/third-party/")), new Set(allOutputs), retiredTarget);
  for (const edge of actualGraph.edges) if (["unresolved-local", "unresolved-workspace-export", "uninventoried-vendor", "forbidden-source-path"].includes(edge.disposition)) blockers.push({ code: "BLOCKED_IMPORT_CLOSURE", path: edge.source, dependency: edge.target ?? edge.specifier });
  const resourceKey = edge => JSON.stringify([edge.source, edge.kind, edge.specifier, edge.expression ?? null]);
  const previousResources = new Set(docs.imports.edges.filter(edge => edge.disposition === "runtime-selected-resource").map(resourceKey));
  for (const edge of actualGraph.edges) if (edge.disposition === "runtime-selected-resource" && !previousResources.has(resourceKey(edge))) {
    const output = profile.outputs.find(entry => entry.path === edge.source);
    const mapped = output?.inputs ?? (output?.sourcePath ? [profile.inputs.find(input => input.commit === output.sourceCommit && input.path === output.sourcePath)].filter(Boolean) : []);
    const changedInputs = await Promise.all(mapped.map(async input => input.commit === oldCommit ? (await objects.get(targetCommit, input.path)).identity : input));
    if (!decision(plan, edge.source, changedInputs)) blockers.push({ code: "BLOCKED_RESOURCE_REVIEW", path: edge.source, reason: "New opaque/dynamic resource edge requires explicit packaging review", edge });
  }
  schedule(paths.imports, encode({ version: 1, upstreamCommit: targetCommit, adaptationCommits: adaptations.sources.map(entry => entry.commit), parser: actualGraph.parser, scope: docs.imports.scope, packages: actualGraph.packages, edges: actualGraph.edges }));
  const selectedDestinations = new Set(recipes.map(entry => entry.destination));
  for (const old of inventory.files) {
    if (old.source || old.destination.startsWith(`${base}integration-patches/`) || selectedDestinations.has(old.destination)) continue;
    if (old.adaptation) {
      const adaptation = adaptations.outputs.find(entry => entry.destination === old.destination);
      if (!adaptation) throw new Error(`Missing adaptation inventory output: ${old.destination}`);
      recipes.push({ ...old, sha256: adaptation.sha256, bytes: adaptation.bytes, mode: adaptation.mode });
    } else {
      const bytes = pending.get(old.destination)?.bytes ?? await bytesAt(root, old.asset);
      recipes.push({ ...old, sha256: hash(bytes), bytes: bytes.length });
    }
  }
  for (const [name, entry] of pending) if (name.startsWith(`${base}integration-patches/`)) recipes.push({ destination: name, asset: name, sha256: hash(entry.bytes), bytes: entry.bytes.length, mode: entry.mode, provenance: "local-addition", rationaleLedger: `${base}integration-patches.json` });
  inventory.upstreamCommit = targetCommit;
  inventory.sourceManifestSha256 = hash(pending.get(paths.manifest).bytes);
  inventory.files = recipes.sort((a, b) => order(a.destination, b.destination));
  inventory.verification = "New-generation exact recipe authoring only; integrated provenance/build/resource/behavior verification remains required.";
  inventory.summary = { upstreamInputs: manifest.files.length, upstreamSelected: selectedDestinations.size, upstreamPristine: recipes.filter(entry => entry.provenance === "pristine-upstream").length, upstreamPatched: recipes.filter(entry => entry.patch).length, existingAdditionalAssets: recipes.filter(entry => entry.asset).length, outputFilesExcludingSelf: recipes.length };
  for (const extraction of inventory.extractions ?? []) {
    const entry = entries.get(extraction.source);
    if (!entry) blockers.push({ code: "BLOCKED_EXTRACTION", path: extraction.source });
    else if (entry.sha256 !== extraction.sourceSha256 || reauthor && Object.hasOwn(outputApprovals, extraction.destination)) {
      const next = (await objects.get(targetCommit, extraction.source)).identity;
      const review = decision(plan, extraction.destination, [next]);
      if (!review) blockers.push({ code: "BLOCKED_DERIVED_REVIEW", path: extraction.destination, inputs: [next], reason: "Extraction declaration/ranges require explicit review" });
      const previous = (await objects.get(oldCommit, extraction.source)).bytes;
      const nextBytes = (await objects.get(targetCommit, extraction.source)).bytes;
      const ranges = review?.extractionLines === undefined ? extractionRanges(extraction, previous, nextBytes) : reviewedRanges(review.extractionLines, nextBytes);
      if (!ranges) blockers.push({ code: "BLOCKED_EXTRACTION", path: extraction.destination, reason: "Changed/ambiguous declarations need valid reviewed extractionLines for the new immutable input" });
      else { extraction.lines = ranges; extraction.sourceSha256 = entry.sha256; }
    }
  }
  schedule(paths.inventory, encode(inventory));
  if (blockers.length) return { changedPaths: [], notes: [], blockers };
  // Preflight every publication/removal before any write. The core separately
  // binds the candidate identity and rejects unrelated changes/unsafe ancestry.
  for (const name of [...pending.keys(), ...removals]) await safeFile(root, name);
  const changedPaths = [];
  for (const [name, entry] of [...pending].sort(([a], [b]) => order(a, b))) {
    const actual = await current(name);
    if (actual?.bytes.equals(entry.bytes) && actual.mode === entry.mode) continue;
    const target = await safeFile(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.bytes, { mode: entry.mode });
    if (!actual || actual.mode !== entry.mode) await chmod(target, entry.mode);
    changedPaths.push(name);
  }
  for (const name of [...removals].sort(order)) if (!pending.has(name) && await current(name)) { await unlink(await safeFile(root, name)); changedPaths.push(name); }
  return { changedPaths: sorted(changedPaths), notes: ["Created a fresh production manifest, exact splice/adaptation recipes and scoped dependency/import/resource inventories; supplemental snapshot and local OMP remain independently owned.", "Legacy capture/sync commit guards remain unchanged; verify this generation with the trusted profile verifier, not legacy same-pin capture."], blockers: [] };
}

/** Read-only exact reconstruction for any generation, including both source pins. */
export async function verifyGeneration({ root, readBlob, listTree }) {
  if (typeof readBlob !== "function" || typeof listTree !== "function") throw new Error("T3 provenance replay requires immutable object readers");
  const { manifest, inventory, adaptations } = await documents(root);
  const objects = objectReader(readBlob, listTree), profile = await loadProfile(root), blockers = [];
  for (const input of profile.inputs) await objects.get(input.commit, input.path, input);
  const tree = await objects.tree(manifest.upstream.commit);
  const inventoried = new Set(manifest.files.map(entry => entry.source_path));
  for (const [name, entry] of tree) if (profile.selection.trees.some(directory => under(name, directory)) && !inventoried.has(name)) blockers.push({ code: "BLOCKED_INCOMPLETE_PACKAGE", path: name, gitMode: entry.mode });
  for (const entry of inventory.files) {
    let bytes;
    if (entry.source) {
      bytes = (await objects.get(manifest.upstream.commit, entry.source)).bytes;
      if (hash(bytes) !== entry.upstreamSha256) throw new Error(`Generation preimage mismatch: ${entry.destination}`);
      if (entry.patch) {
        const encoded = await bytesAt(root, entry.patch.path), patch = JSON.parse(encoded);
        if (hash(encoded) !== entry.patch.sha256 || patch.version !== 1 || patch.source !== entry.source || patch.beforeSha256 !== entry.upstreamSha256 || patch.afterSha256 !== entry.sha256) throw new Error(`Generation patch identity mismatch: ${entry.destination}`);
        bytes = replay(bytes, patch.splices, entry.destination);
      }
    } else if (entry.adaptation) continue;
    else bytes = await bytesAt(root, entry.asset);
    if (hash(bytes) !== entry.sha256 || bytes.length !== entry.bytes) throw new Error(`Generation replay mismatch: ${entry.destination}`);
  }
  for (const source of adaptations.sources) {
    const license = (await objects.get(source.commit, source.license.path)).bytes;
    if (source.license.spdx !== "MIT" || hash(license) !== source.license.sha256 || !license.equals(await bytesAt(root, source.license.distributedPath))) throw new Error(`Generation license mismatch: ${source.commit}`);
  }
  for (const entry of adaptations.outputs) {
    let bytes;
    if (entry.inputs.length) {
      if (entry.recipe.kind !== "exact-line-splices" || entry.recipe.primaryInput !== 0) throw new Error(`Invalid derivation recipe: ${entry.destination}`);
      bytes = replay((await objects.get(entry.inputs[0].commit, entry.inputs[0].path)).bytes, entry.recipe.splices, entry.destination);
    } else {
      if (entry.recipe.kind !== "local-bytes") throw new Error(`Invalid local integration recipe: ${entry.destination}`);
      bytes = Buffer.from(entry.recipe.base64, "base64");
      if (bytes.toString("base64") !== entry.recipe.base64) throw new Error(`Invalid embedded bytes: ${entry.destination}`);
    }
    if (hash(bytes) !== entry.sha256 || bytes.length !== entry.bytes) throw new Error(`Generation derivation replay mismatch: ${entry.destination}`);
  }
  for (const output of [...profile.outputs, ...profile.hostInputs]) {
    const info = await lstat(await safeFile(root, output.path)).catch(missing);
    if (!info || hash(await bytesAt(root, output.path)) !== output.sha256 || output.mode !== undefined && Boolean(info.mode & 0o111) !== Boolean(output.mode & 0o111)) blockers.push({ code: "BLOCKED_GENERATION_DRIFT", path: output.path });
  }
  return { blockers, notes: ["Exact committed-input and recipe replay only; not native behavior, full verification or write authorization."], changedPaths: [] };
}

/** Check the packager's concrete JSON identities after full isolated commands. */
export async function verifyArtifacts({ root, targetCommit }) {
  const artifactRoot = ".upstream-sync/verification-output/t3-artifact";
  const manifestPath = `${artifactRoot}/artifact-manifest.json`;
  const blockers = [];
  const notes = ["Data-only packaged T3 source identity check; native behavior and publication authorization are separate."];
  let reading = manifestPath;
  try {
    if (!/^[a-f0-9]{40}$/.test(targetCommit)) throw new Error("Expected a full immutable target commit");
    const artifact = JSON.parse(await bytesAt(root, manifestPath));
    if (artifact.version !== 1 || artifact.entrypoint !== "apps/server/agent/dist/index.mjs" || !Array.isArray(artifact.files)) {
      return { blockers: [{ code: "BLOCKED_ARTIFACT_SCHEMA", path: manifestPath, reason: "Expected the version-1 Agent package manifest and entrypoint" }], notes };
    }
    if (artifact.upstreamCommit !== targetCommit) {
      return {
        blockers: [{ code: "BLOCKED_ARTIFACT_IDENTITY", path: manifestPath, expectedCommit: targetCommit, actualCommit: artifact.upstreamCommit ?? null, reason: "Packaged upstream identity differs from the verified candidate target" }],
        notes: [...notes, "A stale packager stamp requires a separately approved shared-host-tool change and its T3/CC/OpenHands provenance updates; this check never enrolls those changes."],
      };
    }
    const candidate = await documents(root);
    if (candidate.manifest.upstream.commit !== targetCommit) blockers.push({ code: "BLOCKED_ARTIFACT_IDENTITY", path: paths.manifest, expectedCommit: targetCommit, actualCommit: candidate.manifest.upstream.commit, reason: "Candidate identity differs from the requested artifact target" });
    const provenance = ["manifest", "inventory", "adaptations", "supplemental", "imports"];
    const expectedPaths = new Set(provenance.map(key => `licenses/provenance/${paths[key]}`));
    const records = new Map();
    for (const record of artifact.files) {
      if (!expectedPaths.has(record?.path)) continue;
      if (records.has(record.path)) blockers.push({ code: "BLOCKED_ARTIFACT_SCHEMA", path: record.path, reason: "Duplicate packaged source identity record" });
      records.set(record.path, record);
    }
    const shipped = {};
    for (const key of provenance) {
      const relative = `licenses/provenance/${paths[key]}`;
      reading = `${artifactRoot}/${relative}`;
      const bytes = await bytesAt(root, reading), record = records.get(relative);
      if (!record || record.sha256 !== hash(bytes) || record.bytes !== bytes.length || record.mode !== 0o644) blockers.push({ code: "BLOCKED_ARTIFACT_PROVENANCE", path: reading, reason: "Packaged provenance bytes do not match their version-1 artifact file record" });
      if (!bytes.equals(candidate.bytes.get(paths[key]))) blockers.push({ code: "BLOCKED_ARTIFACT_PROVENANCE", path: reading, reason: "Packaged provenance is not the exact accepted candidate generation" });
      shipped[key] = { bytes, value: JSON.parse(bytes) };
    }
    if (shipped.manifest.value.upstream?.commit !== targetCommit
      || shipped.inventory.value.upstreamCommit !== targetCommit
      || shipped.inventory.value.sourceManifestSha256 !== hash(shipped.manifest.bytes)
      || shipped.adaptations.value.baselineCommit !== targetCommit
      || shipped.imports.value.upstreamCommit !== targetCommit) {
      blockers.push({ code: "BLOCKED_ARTIFACT_IDENTITY", path: manifestPath, expectedCommit: targetCommit, reason: "Distributed T3 source, replay, adaptation and import identities do not agree with the target" });
    }
    const sources = shipped.adaptations.value.sources;
    if (!Array.isArray(sources) || !sources.some(source => source.commit === targetCommit)
      || !sources.some(source => source.commit === shipped.supplemental.value.upstream?.commit)
      || JSON.stringify(shipped.imports.value.adaptationCommits) !== JSON.stringify(sources.map(source => source.commit))) {
      blockers.push({ code: "BLOCKED_ARTIFACT_IDENTITY", path: `${artifactRoot}/licenses/provenance/${paths.adaptations}`, reason: "Distributed production and supplemental source pins disagree" });
    }
  } catch (error) {
    blockers.push({ code: error.code === "ENOENT" ? "BLOCKED_ARTIFACT_MISSING" : "BLOCKED_ARTIFACT_PROVENANCE", path: reading, reason: error.message });
  }
  return { blockers, notes };
}
