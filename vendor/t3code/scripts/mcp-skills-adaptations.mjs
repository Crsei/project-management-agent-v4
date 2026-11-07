import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const commits = new Set([
  "d53873b6a4799e87afd63c8d288ef0089f5a3748",
  "30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c",
]);
const immutableCommit = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const sha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function relative(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value) || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe adaptation path: ${value}`);
  return value;
}
function blob(source, commit, name) {
  if (!commits.has(commit)) throw new Error(`Unapproved source commit: ${commit}`);
  return execFileSync("git", ["-C", source, "show", `${commit}:${relative(name)}`], { maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
}
function recipeShape(recipe, inputs, name) {
  if (!recipe || typeof recipe !== "object") throw new Error(`Missing adaptation recipe: ${name}`);
  if (!inputs.length) {
    if (recipe.kind !== "local-bytes" || typeof recipe.base64 !== "string" || Buffer.from(recipe.base64, "base64").toString("base64") !== recipe.base64) throw new Error(`Invalid local integration recipe: ${name}`);
    return;
  }
  if (recipe.kind !== "exact-line-splices" || recipe.primaryInput !== 0 || !Array.isArray(recipe.splices)) throw new Error(`Invalid adaptation recipe: ${name}`);
  let cursor = 0;
  for (const item of recipe.splices) {
    if (!item || !Number.isSafeInteger(item.start) || item.start < cursor || !Array.isArray(item.before) || !Array.isArray(item.after) || ![...item.before, ...item.after].every((line) => typeof line === "string")) throw new Error(`Invalid adaptation ranges: ${name}`);
    cursor = item.start + item.before.length;
  }
}
function splice(original, recipe, name) {
  const lines = original.toString("utf8").match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const output = [];
  let cursor = 0;
  for (const item of recipe.splices) {
    const end = item.start + item.before.length;
    if (item.start > lines.length || end > lines.length || lines.slice(item.start, end).join("") !== item.before.join("")) throw new Error(`Adaptation preimage conflict: ${name}`);
    output.push(...lines.slice(cursor, item.start), ...item.after);
    cursor = end;
  }
  output.push(...lines.slice(cursor));
  return Buffer.from(output.join(""));
}

// Retirements stay inside the existing authoritative output record: immutable
// inputs, exact historical recipe, hash, byte count, mode and original rationale
// remain intact. No second patch stack or deletion-only inventory is introduced.
export function validateAdaptationStructure(manifest) {
  if (manifest.version !== 1 || !immutableCommit(manifest.baselineCommit) || !Array.isArray(manifest.sources) || !Array.isArray(manifest.outputs)) throw new Error("Adaptation manifest identity mismatch");
  const licensed = new Set();
  for (const source of manifest.sources) {
    if (!source || !immutableCommit(source.commit) || licensed.has(source.commit) || typeof source.role !== "string" || !source.role.trim() || source.license?.spdx !== "MIT" || source.license.path !== "LICENSE" || source.license.distributedPath !== "vendor/t3code/LICENSE" || !sha256(source.license.sha256)) throw new Error("Incomplete/duplicate adaptation source identity");
    licensed.add(source.commit);
  }
  if (licensed.size < 2 || !licensed.has(manifest.baselineCommit)) throw new Error("Incomplete adaptation source identities");
  const seen = new Set(), retirements = [];
  for (const entry of manifest.outputs) {
    const name = relative(entry.destination);
    if (!/^(?:vendor\/t3code\/|apps\/server\/|apps\/web\/|packages\/)/.test(name) || name.includes("/node_modules/") || name.includes("/.git/") || seen.has(name)) throw new Error(`Unapproved/duplicate adaptation destination: ${name}`);
    seen.add(name);
    if (!sha256(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || ![0o644, 0o755].includes(entry.mode) || typeof entry.reason !== "string" || !entry.reason.trim() || typeof entry.license !== "string" || !entry.license.trim()) throw new Error(`Incomplete adaptation output identity: ${name}`);
    if (!Array.isArray(entry.inputs) || Boolean(entry.inputs.length) !== (entry.provenance === "adapted-upstream") || !["adapted-upstream", "local-integration"].includes(entry.provenance)) throw new Error(`Invalid adaptation classification: ${name}`);
    const inputs = new Set();
    for (const input of entry.inputs) {
      if (!input || !licensed.has(input.commit) || !sha256(input.sha256) || !Number.isSafeInteger(input.bytes) || input.bytes < 0 || typeof input.gitBlobSha1 !== "string" || !/^[a-f0-9]{40}$/.test(input.gitBlobSha1) || !["100644", "100755"].includes(input.gitMode)) throw new Error(`Incomplete adaptation original identity: ${name}`);
      const key = `${input.commit}:${relative(input.path)}`;
      if (inputs.has(key)) throw new Error(`Duplicate adaptation original identity: ${name}`);
      inputs.add(key);
    }
    recipeShape(entry.recipe, entry.inputs, name);
    if (Object.hasOwn(entry, "retirement")) {
      const retired = entry.retirement;
      if (!retired || Object.keys(retired).sort().join(",") !== "reason,sha256" || retired.sha256 !== entry.sha256 || typeof retired.reason !== "string" || !retired.reason.trim()) throw new Error(`Malformed adaptation retirement: ${name}`);
      retirements.push(entry);
    }
  }
  return retirements;
}

// Only legacy replay/capture accepts the original production + supplemental pins.
// Structural consumers also serve coherent generations authored by the profile.
export function validateAdaptationManifest(manifest) {
  const retirements = validateAdaptationStructure(manifest);
  if (manifest.baselineCommit !== "30eb7e7bb1ef103fdd6f54081b6a4acf66b3ee4c" || manifest.sources.length !== commits.size || manifest.sources.some((source) => !commits.has(source.commit))) throw new Error("Adaptation manifest identity mismatch");
  return retirements;
}

export async function assertRetiredTargetsAbsent(repository, retirements) {
  for (const entry of retirements) {
    let current = repository;
    const pieces = relative(entry.destination).split("/");
    for (const [index, piece] of pieces.entries()) {
      current = path.join(current, piece);
      const info = await lstat(current).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (!info) break;
      if (info.isSymbolicLink() || (index < pieces.length - 1 && !info.isDirectory())) throw new Error(`Unsafe retired destination: ${entry.destination}`);
      if (index === pieces.length - 1) throw new Error(`Retired target exists: ${entry.destination}`);
    }
  }
}

export function assertNoRetiredImportEdges(imports, retirements) {
  if (!retirements.length) return;
  if (imports.version !== 1 || !Array.isArray(imports.edges)) throw new Error("Invalid retirement import inventory");
  const retired = new Set(retirements.map((entry) => entry.destination));
  for (const edge of imports.edges) {
    if (!edge || typeof edge.source !== "string" || (edge.target !== null && typeof edge.target !== "string")) throw new Error("Malformed retirement import edge");
    if (retired.has(edge.source) || retired.has(edge.target)) throw new Error(`Retired output remains in import closure: ${edge.source} -> ${edge.target}`);
  }
}
// Resolve against virtual retired files using the consumer's existing tsconfig
// and package exports. Both generation graphs and the live import scan use this.
export function createRetiredImportResolver(root, retirements, ts) {
  const retired = new Set(retirements.map((entry) => entry.destination));
  const names = [...retired], configurations = new Map();
  const virtual = (file) => retired.has(path.relative(root, file).split(path.sep).join("/"));
  const host = {
    ...ts.sys,
    fileExists: (file) => virtual(file) || ts.sys.fileExists(file),
    directoryExists: (directory) => {
      const relative = path.relative(root, directory).split(path.sep).join("/");
      return names.some((name) => name.startsWith(relative + "/")) || ts.sys.directoryExists(directory);
    },
    realpath: (file) => virtual(file) ? file : ts.sys.realpath(file),
  };
  return (source, specifier) => {
    if (!retired.size) return null;
    const absolute = path.join(root, source), directory = path.dirname(absolute);
    let options = configurations.get(directory);
    if (!options) {
      const config = ts.findConfigFile(directory, ts.sys.fileExists);
      if (config) {
        const loaded = ts.readConfigFile(config, ts.sys.readFile);
        if (loaded.error) throw new Error(`Cannot read retirement consumer tsconfig: ${config}`);
        const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, path.dirname(config));
        if (parsed.errors.some((error) => error.code !== 18003)) throw new Error(`Cannot parse retirement consumer tsconfig: ${config}`);
        options = parsed.options;
      } else options = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext };
      configurations.set(directory, options);
    }
    const resolved = ts.resolveModuleName(specifier, absolute, options, host).resolvedModule?.resolvedFileName;
    if (resolved && virtual(resolved)) return path.relative(root, resolved).split(path.sep).join("/");
    const direct = specifier.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier))
      : specifier.startsWith("file:") ? path.relative(root, fileURLToPath(specifier)).split(path.sep).join("/")
        : path.isAbsolute(specifier) ? path.relative(root, specifier).split(path.sep).join("/") : specifier;
    const extensionless = direct.replace(/\.(?:[cm]?tsx?|jsx?)$/, "");
    return names.find((name) => name === direct || name.replace(/\.(?:[cm]?tsx?|jsx?)$/, "") === extensionless) ?? null;
  };
}


// Verify every retained historical recipe and source identity, retired or not.
// Authoring shares this read-only replay without requiring freshly authored imports.
export async function replayMcpSkillsAdaptations(repository, source, manifest) {
  const retirements = validateAdaptationManifest(manifest);
  const cache = new Map(), modes = new Map();
  const distributedLicense = await readFile(path.join(repository, "vendor/t3code/LICENSE"));
  for (const sourceEntry of manifest.sources) {
    const actual = execFileSync("git", ["-C", source, "rev-parse", `${sourceEntry.commit}^{commit}`], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
    if (actual !== sourceEntry.commit) throw new Error("Adaptation source commit identity mismatch");
    const license = blob(source, sourceEntry.commit, sourceEntry.license.path);
    if (hash(license) !== sourceEntry.license.sha256 || !license.equals(distributedLicense)) throw new Error("Pinned source MIT coverage mismatch");
  }
  const outputs = new Map();
  for (const entry of manifest.outputs) {
    const name = entry.destination;
    for (const input of entry.inputs) {
      const key = `${input.commit}:${input.path}`;
      if (!cache.has(key)) {
        cache.set(key, blob(source, input.commit, input.path));
        modes.set(key, execFileSync("git", ["-C", source, "ls-tree", input.commit, "--", input.path], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).split(/\s/)[0]);
      }
      const bytes = cache.get(key);
      const gitBlob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (hash(bytes) !== input.sha256 || bytes.length !== input.bytes || gitBlob !== input.gitBlobSha1 || modes.get(key) !== input.gitMode) throw new Error(`Adaptation original hash/blob conflict: ${key}`);
    }
    const bytes = entry.inputs.length ? splice(cache.get(`${entry.inputs[0].commit}:${entry.inputs[0].path}`), entry.recipe, name) : Buffer.from(entry.recipe.base64, "base64");
    if (hash(bytes) !== entry.sha256 || bytes.length !== entry.bytes) throw new Error(`Adaptation output hash conflict: ${name}`);
    if (!Object.hasOwn(entry, "retirement")) outputs.set(name, { relative: name, bytes, mode: entry.mode });
  }
  return { outputs, retirements };
}

// Returns all active bytes before the caller inspects/writes any destination.
// Git committed blobs are inputs only; source worktree code is never executed.
export async function planMcpSkillsAdaptations(repository, source) {
  const manifestPath = path.join(repository, "vendor/t3code/mcp-skills-adaptations.json");
  const info = await lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe adaptation manifest");
  const plan = await replayMcpSkillsAdaptations(repository, source, JSON.parse(await readFile(manifestPath, "utf8")));
  await assertRetiredTargetsAbsent(repository, plan.retirements);
  if (plan.retirements.length) assertNoRetiredImportEdges(JSON.parse(await readFile(path.join(repository, "vendor/t3code/sync-imports.json"), "utf8")), plan.retirements);
  return plan;
}
