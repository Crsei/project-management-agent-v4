import { execFileSync } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { resourceClosure } from "./closure.mjs";
import { encode, file, originalsFrom, patchBytes, policyInputs, publish, relative, repository, safePath, sha256, walk } from "./provenance.mjs";

const options = new Map(), additions = new Set(), accepted = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (key === "--review") options.set(key, true);
  else if (["--source", "--reason", "--allow-local", "--accept-change"].includes(key) && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    const value = process.argv[++index];
    if (key === "--allow-local") additions.add(relative(value));
    else if (key === "--accept-change") {
      const separator = value.lastIndexOf("=");
      if (separator < 0 || !/^[a-f0-9]{64}$/.test(value.slice(separator + 1))) throw new Error("--accept-change requires PATH=SHA256.");
      accepted.set(relative(value.slice(0, separator)), value.slice(separator + 1));
    } else options.set(key, value);
  } else throw new Error(`Unknown/incomplete capture option: ${key}`);
}
if (!options.get("--source") || !options.get("--review") || !options.get("--reason")?.trim()) throw new Error("Reviewed authoring only: capture.mjs --source PINNED_CHECKOUT --review --reason RATIONALE [--allow-local PATH] [--accept-change PATH=SHA256]. Never run while implementation writers are active.");
const { manifest, manifestBytes, policy, policyBytes } = await policyInputs();
const originals = await originalsFrom(options.get("--source"), manifest);
const upstreamPaths = execFileSync("git", ["-C", path.resolve(options.get("--source")), "ls-tree", "-rz", "--name-only", manifest.commit], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 16 * 1024 * 1024 }).split("\0").filter(Boolean).sort();
const upstreamTree = encode({ version: 1, upstreamCommit: manifest.commit, paths: upstreamPaths.map(relative) });
const hostBuildInputs = [];
for (const name of policy.hostBuildInputs ?? []) {
  const input = await file(repository, name);
  hostBuildInputs.push({ path: name, sha256: sha256(input.bytes), bytes: input.bytes.length });
}
const oldBytes = await readFile(path.join(repository, "vendor/cc-switch/output-inventory.json")).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
const previous = oldBytes ? JSON.parse(oldBytes) : null;
if (previous && (previous.upstreamCommit !== manifest.commit || previous.sourceManifestSha256 !== sha256(manifestBytes))) throw new Error("Unknown previous inventory identity.");
for (const name of ["resource-closure.json", "upstream-tree.json"]) {
  const expected = previous?.[name === "resource-closure.json" ? "closureSha256" : "upstreamTreeSha256"];
  if (expected && sha256((await file(repository, `vendor/cc-switch/${name}`)).bytes) !== expected) throw new Error(`Unknown generated provenance edit: ${name}`);
}
for (const entry of hostBuildInputs) {
  const old = previous?.hostBuildInputs?.find((input) => input.path === entry.path);
  if (old && old.sha256 !== entry.sha256 && accepted.get(entry.path) !== entry.sha256) throw new Error(`Changed host build input requires --accept-change ${entry.path}=${entry.sha256}`);
}
// Existing patch recipes are immutable authoring inputs until explicitly reviewed.
for (const patch of previous?.patches ?? []) {
  const actual = sha256((await file(repository, patch.path)).bytes);
  if (actual !== patch.sha256 && accepted.get(patch.path) !== actual) throw new Error(`Unknown patch change: ${patch.path}`);
}
const previousFiles = new Map((previous?.files ?? []).map((entry) => [entry.destination, entry]));
const files = [], payloads = new Map(), patches = [];
const originalTargets = new Set(manifest.files.map((entry) => `vendor/cc-switch/${entry.path}`));
const derivedOutputs = new Map();
for (const entry of policy.derivedOutputs ?? []) {
  if (originalTargets.has(relative(entry.destination)) || !originals.has(relative(entry.source)) || !entry.reason?.trim() || derivedOutputs.has(entry.destination)) throw new Error("Invalid source extraction policy.");
  derivedOutputs.set(entry.destination, entry);
  additions.add(entry.destination);
}
const tools = ["vendor/cc-switch/source-manifest.json", "vendor/cc-switch/fork-policy.json", "vendor/cc-switch/SYNC.md", "vendor/cc-switch/LICENSING.md", "vendor/cc-switch/scripts/provenance.mjs", "vendor/cc-switch/scripts/provenance.test.mjs", "vendor/cc-switch/scripts/closure.mjs", "vendor/cc-switch/scripts/capture.mjs", "vendor/cc-switch/scripts/sync.mjs"];
for (const name of tools) additions.add(name);
for (const entry of previous?.files ?? []) if (!entry.source) additions.add(entry.destination);
for (const name of additions) {
  if (originalTargets.has(name)) throw new Error(`Upstream source cannot be classified as local: ${name}`);
  if (!name.startsWith("vendor/cc-switch/") && !name.startsWith("apps/") && !name.startsWith("packages/") && !name.startsWith("scripts/") && !name.startsWith("tests/") && !name.startsWith("docs/implementation/")) throw new Error(`Outside explicit integration ownership roots: ${name}`);
  if (/(?:^|\/)(?:\.env[^/]*|secret\.key|auth\.json|credentials?\.json|providers\.json)$/.test(name) || name.includes("/target/") || name.includes("/node_modules/")) throw new Error(`Runtime/private/generated addition refused: ${name}`);
}
async function capture(destination, source) {
  const input = await file(repository, destination), digest = sha256(input.bytes), old = previousFiles.get(destination);
  if (old && (old.sha256 !== digest || old.mode !== input.mode) && accepted.get(destination) !== digest) throw new Error(`Changed reviewed output requires --accept-change ${destination}=${digest}`);
  const entry = { destination, sha256: digest, bytes: input.bytes.length, mode: input.mode, provenance: source ? "pristine-upstream" : destination.startsWith("vendor/cc-switch/") ? "local-fork-integration" : "host-owned-integration", reason: accepted.has(destination) ? options.get("--reason") : old?.reason ?? options.get("--reason") };
  if (source) {
    const before = originals.get(source);
    entry.source = source; entry.upstreamSha256 = sha256(before);
    const extraction = derivedOutputs.get(destination);
    if (extraction) { entry.provenance = "extracted-upstream"; entry.reason = extraction.reason; }
    if (!before.equals(input.bytes)) {
      entry.provenance = extraction ? "adapted-upstream-extraction" : "patched-upstream";
      const patch = patchBytes(before, input.bytes, source), patchPath = extraction
        ? `vendor/cc-switch/integration-patches/derived/${destination}.json`
        : `vendor/cc-switch/integration-patches/${source}.json`;
      entry.patch = { path: patchPath, sha256: sha256(patch) };
      payloads.set(patchPath, patch); patches.push(entry.patch);
    }
  } else {
    const assetPath = `vendor/cc-switch/integration-patches/local/${destination}.json`;
    const asset = encode({ version: 1, destination, sha256: digest, mode: input.mode, encoding: "base64", content: input.bytes.toString("base64") });
    entry.asset = { path: assetPath, sha256: sha256(asset) };
    payloads.set(assetPath, asset); patches.push(entry.asset);
  }
  files.push(entry);
}
for (const entry of manifest.files) await capture(`vendor/cc-switch/${entry.path}`, entry.path);
for (const name of [...additions].sort()) await capture(name, derivedOutputs.get(name)?.source ?? null);
const expected = new Set([...files.map((entry) => entry.destination), ...payloads.keys(), "vendor/cc-switch/output-inventory.json", "vendor/cc-switch/resource-closure.json", "vendor/cc-switch/upstream-tree.json", ...(previous?.patches ?? []).map((entry) => entry.path)]);
for (const tree of policy.ownedTrees ?? ["vendor/cc-switch"]) {
  for (const name of await walk(repository, tree, policy.generatedTrees)) if (!expected.has(name)) throw new Error(`Unknown owned output; review and enroll exact file with --allow-local: ${name}`);
}
const closure = await resourceClosure(repository, policy, files, upstreamPaths);
const result = encode({
  version: 1, upstreamCommit: manifest.commit,
  sourceManifestSha256: sha256(manifestBytes), policySha256: sha256(policyBytes),
  closureSha256: sha256(closure), upstreamTreeSha256: sha256(upstreamTree), hostBuildInputs,
  modePolicy: "Canonical 0644/0755 by executable class; special bits, links and nonregular files refused. Existing content must match exactly; no force or fuzzy replay.",
  files: files.sort((a, b) => a.destination < b.destination ? -1 : 1),
  patches: patches.sort((a, b) => a.path < b.path ? -1 : 1),
  summary: {
    originalInputs: manifest.files.length,
    pristine: files.filter((entry) => entry.provenance === "pristine-upstream").length,
    adapted: files.filter((entry) => entry.provenance === "patched-upstream").length,
    extracted: files.filter((entry) => derivedOutputs.has(entry.destination)).length,
    local: files.filter((entry) => !entry.source).length,
  },
});
// All source/output/patch/resource inputs are read before any publication. Refuse
// a concurrent edit rather than silently capturing a mixed source generation.
for (const entry of files) if (sha256((await file(repository, entry.destination)).bytes) !== entry.sha256) throw new Error(`Output changed during capture: ${entry.destination}`);
for (const entry of hostBuildInputs) if (sha256((await file(repository, entry.path)).bytes) !== entry.sha256) throw new Error(`Host build input changed during capture: ${entry.path}`);
for (const [name, bytes] of [...payloads].sort(([a], [b]) => a < b ? -1 : 1)) await publish(repository, name, bytes);
for (const patch of previous?.patches ?? []) if (!payloads.has(patch.path)) await unlink(await safePath(repository, patch.path));
await publish(repository, "vendor/cc-switch/upstream-tree.json", upstreamTree);
await publish(repository, "vendor/cc-switch/resource-closure.json", closure);
await publish(repository, "vendor/cc-switch/output-inventory.json", result);
console.log(JSON.stringify({ operation: "reviewed-authoring-not-acceptance", commit: manifest.commit, outputs: files.length, patches: patches.length, closureSha256: sha256(closure) }));
