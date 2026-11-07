import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertRetiredTargetsAbsent, planMcpSkillsAdaptations } from "./mcp-skills-adaptations.mjs";

// Parent-only, offline fixtures. Never edits the designated Git source or host
// metadata; the authoring subprocess operates solely inside disposable roots.
if (process.argv.length !== 4 || process.argv[2] !== "--source") throw new Error("Usage: node vendor/t3code/scripts/verify-mcp-skills-authoring.mjs --source DUAL_PIN_CHECKOUT");
const source = path.resolve(process.argv[3]);
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), "pm-t3-retirement-"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const encode = (value) => JSON.stringify(value, null, 2) + "\n";
const environment = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
const authority = JSON.parse(await readFile(path.join(repository, "vendor/t3code/mcp-skills-adaptations.json"), "utf8"));
const originalManifest = await readFile(path.join(repository, "vendor/t3code/source-manifest.json"));
const input = structuredClone(authority.outputs.find((entry) => entry.inputs.length).inputs[0]);
const original = execFileSync("git", ["-C", source, "show", `${input.commit}:${input.path}`], { env: environment });
const names = ["apps/web/src/retired-a.ts", "apps/web/src/retired-b.ts", "apps/web/src/retired-c.ts"];
const contents = names.map((_, index) => Buffer.from(`export const value${index} = ${index};\n`));
const records = names.map((destination, index) => ({
  destination, provenance: index ? "local-integration" : "adapted-upstream", inputs: index ? [] : [input],
  reason: "Isolated reviewed retirement fixture", license: index ? "Existing repository terms" : "MIT; vendor/t3code/LICENSE",
  sha256: hash(contents[index]), bytes: contents[index].length, mode: 0o644,
  recipe: index ? { kind: "local-bytes", base64: contents[index].toString("base64") } : {
    kind: "exact-line-splices", primaryInput: 0,
    splices: [{ start: 0, before: original.toString("utf8").match(/[^\n]*\n|[^\n]+$/g) ?? [], after: [contents[index].toString()] }],
  },
}));
const initial = { version: 1, baselineCommit: authority.baselineCommit, sources: authority.sources, sourceInventory: authority.sourceInventory, baselineInventory: authority.baselineInventory, outputs: records };
let serial = 0;
async function put(root, name, bytes) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), bytes);
}
async function bindFixtureBaseline(root) {
  const name = "vendor/t3code/mcp-skills-adaptations.json";
  const bytes = await readFile(path.join(root, name));
  await put(root, "vendor/t3code/sync-inventory.json", encode({
    version: 1, upstreamCommit: authority.baselineCommit,
    files: [{ destination: name, asset: name, sha256: hash(bytes), bytes: bytes.length, mode: 0o644 }],
  }));
}
async function fixture(mutate) {
  const root = path.join(temporary, String(++serial));
  await mkdir(root);
  await cp(path.join(repository, "vendor/t3code/scripts"), path.join(root, "vendor/t3code/scripts"), { recursive: true });
  await put(root, "vendor/t3code/LICENSE", await readFile(path.join(repository, "vendor/t3code/LICENSE")));
  await put(root, "vendor/t3code/source-manifest.json", originalManifest);
  await put(root, "vendor/t3code/sync-imports.json", encode({ version: 1, edges: [] }));
  await put(root, "package.json", encode({ type: "module" }));
  await symlink(path.join(repository, "node_modules"), path.join(root, "node_modules"), "dir");
  const ledger = structuredClone(initial);
  if (mutate) mutate(ledger);
  await put(root, "vendor/t3code/mcp-skills-adaptations.json", encode(ledger));
  await bindFixtureBaseline(root);
  for (const [index, name] of names.entries()) await put(root, name, contents[index]);
  return root;
}
const retirement = (index = 0) => ["--retire-output", `${names[index]}=${records[index].sha256}`, "--retirement-reason", `${names[index]}=Unused component removed by reviewed cutover`];
async function author(root, args = [], expected = 0, message) {
  const target = path.join(root, "vendor/t3code/mcp-skills-adaptations.json");
  const before = await readFile(target);
  const result = spawnSync("python3", [path.join(root, "vendor/t3code/scripts/capture-mcp-skills.py"), "--source", source, ...args], { encoding: "utf8", env: environment });
  if (result.error) throw result.error;
  assert.equal(result.status, expected, result.stderr + result.stdout);
  if (message) assert.match(result.stderr, message);
  if (expected) assert.deepEqual(await readFile(target), before, "Rejected authoring must not partially write the ledger");
  assert.deepEqual(await readFile(path.join(root, "vendor/t3code/source-manifest.json")), originalManifest, "Authoring must preserve the original manifest");
  return JSON.parse(await readFile(target, "utf8"));
}
try {
  const unchanged = await fixture();
  const before = await readFile(path.join(unchanged, "vendor/t3code/mcp-skills-adaptations.json"));
  const timestamp = (await lstat(path.join(unchanged, "vendor/t3code/mcp-skills-adaptations.json"), { bigint: true })).mtimeNs;
  await author(unchanged);
  assert.deepEqual(await readFile(path.join(unchanged, "vendor/t3code/mcp-skills-adaptations.json")), before);
  assert.equal((await lstat(path.join(unchanged, "vendor/t3code/mcp-skills-adaptations.json"), { bigint: true })).mtimeNs, timestamp);

  const tampered = await fixture();
  const tamperedLedger = path.join(tampered, "vendor/t3code/mcp-skills-adaptations.json");
  await writeFile(tamperedLedger, encode({ ...initial, outputs: initial.outputs.slice(1) }));
  await author(tampered, [], 1, /differs from its recorded baseline/);

  for (const mutate of [
    (ledger) => { delete ledger.outputs[0].inputs[0].gitBlobSha1; },
    (ledger) => { ledger.outputs[0].inputs[0].sha256 = "0".repeat(64); },
    (ledger) => { ledger.sources[0].license.sha256 = "0".repeat(64); },
    (ledger) => { delete ledger.sources[0].license; },
    (ledger) => { delete ledger.outputs[0].recipe; },
    (ledger) => { ledger.outputs[0].recipe.splices[0].before = ["wrong preimage\n"]; },
    (ledger) => { ledger.outputs.push(structuredClone(ledger.outputs[0])); },
    (ledger) => { ledger.sources.push(structuredClone(ledger.sources[0])); },
    (ledger) => { ledger.outputs[0].retirement = { sha256: "0".repeat(64), reason: "invalid" }; },
    (ledger) => { ledger.outputs[0].retirement = { sha256: ledger.outputs[0].sha256, reason: " " }; },
    (ledger) => { ledger.outputs[0].retirement = { sha256: ledger.outputs[0].sha256, reason: "reviewed", extra: true }; },
  ]) await author(await fixture(mutate), [], 1);

  await author(await fixture(), retirement(), 1, /Retirement target still exists/);
  const wrongHash = await fixture();
  await rm(path.join(wrongHash, names[0]));
  await author(wrongHash, ["--retire-output", `${names[0]}=${"0".repeat(64)}`, "--retirement-reason", `${names[0]}=reviewed`], 1, /preimage hash mismatch/);
  await author(wrongHash, [...retirement(), ...retirement()], 1, /duplicate retirement/);
  await author(wrongHash, ["--retire-output", `${names[0]}=${records[0].sha256}`], 1, /exactly one rationale/);
  await author(wrongHash, ["--retire-output", `apps/web/src/unknown.ts=${records[0].sha256}`, "--retirement-reason", "apps/web/src/unknown.ts=reviewed"], 1, /Unknown output requests/);
  await author(wrongHash, [...retirement(), "--accept-output", `${names[0]}=${records[0].sha256}`], 1, /cannot also accept/);

  for (const [specifier, alias] of [["./retired-a", false], ["@fixture/retired-a", true]]) {
    const live = await fixture();
    await rm(path.join(live, names[0]));
    await put(live, "apps/web/src/consumer.ts", `export { value0 } from ${JSON.stringify(specifier)};\n`);
    if (alias) await put(live, "apps/web/tsconfig.json", encode({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", paths: { "@fixture/*": ["./src/*"] } } }));
    await author(live, retirement(), 1, /Live consumer of retired output/);
  }

  const drift = await fixture();
  const changed = Buffer.from("export const changed = true;\n");
  await put(drift, names[2], changed);
  await author(drift, [], 1, /Unapproved output drift/);
  await author(drift, ["--accept-output", `${names[2]}=${"0".repeat(64)}`], 1, /Unapproved output drift/);
  await author(drift, ["--accept-output", `${names[1]}=${records[1].sha256}`, "--accept-output", `${names[2]}=${hash(changed)}`], 1, /Stale\/unnecessary/);
  await author(drift, ["--accept-output", `${names[2]}=${hash(changed)}`, "--accept-output", `${names[2]}=${hash(changed)}`], 1, /duplicate output acceptance/);
  await put(drift, names[1], changed);
  await author(drift, ["--accept-output", `${names[2]}=${hash(changed)}`], 1, /Unapproved output drift/);

  const valid = await fixture();
  await rm(path.join(valid, names[0]));
  await rm(path.join(valid, names[1]));
  await put(valid, names[2], changed);
  const authored = await author(valid, [...retirement(), ...retirement(1), "--accept-output", `${names[2]}=${hash(changed)}`]);
  for (const index of [0, 1]) {
    const retained = structuredClone(authored.outputs.find((entry) => entry.destination === names[index]));
    assert.equal(retained.retirement.sha256, records[index].sha256);
    assert.ok(retained.retirement.reason.trim());
    delete retained.retirement;
    assert.deepEqual(retained, records[index], "Full source identity, recipe, old mode/hash and rationale must survive retirement");
  }
  const plan = await planMcpSkillsAdaptations(valid, source);
  assert.equal(plan.retirements.length, 2);
  assert.equal(plan.outputs.size, 1);
  assert.deepEqual(plan.outputs.get(names[2]).bytes, changed);
  const clean = path.join(temporary, "clean-replay");
  for (const output of plan.outputs.values()) await put(clean, output.relative, output.bytes);
  await assertRetiredTargetsAbsent(clean, plan.retirements);
  await put(clean, names[0], contents[0]);
  await assert.rejects(assertRetiredTargetsAbsent(clean, plan.retirements), /Retired target exists/);
  // Model the existing, separately authorized baseline capture after authoring;
  // production authoring itself never rewrites the baseline inventory.
  await bindFixtureBaseline(valid);
  await author(valid);
  await author(valid, retirement(), 1, /already retired/);
  await put(valid, "vendor/t3code/sync-imports.json", encode({ version: 1, edges: [{ source: names[2], target: names[0] }] }));
  await assert.rejects(planMcpSkillsAdaptations(valid, source), /remains in import closure/);
  await put(valid, "vendor/t3code/sync-imports.json", encode({ version: 1, edges: [] }));
  await put(valid, names[0], contents[0]);
  await author(valid, [], 1, /Retired target exists/);
  await assert.rejects(planMcpSkillsAdaptations(valid, source), /Retired target exists/);
  const replacementPath = "apps/web/src/features/agent/src/chat/composer-suggestions.tsx";
  const replacementBytes = Buffer.from("export const replacement = true;\n");
  const registryBytes = Buffer.from(encode({ upstream: { commit: input.commit }, files: [{ path: input.path, mode: input.gitMode, type: "blob", blob: input.gitBlobSha1, bytes: input.bytes, sha256: input.sha256 }] }));
  const replacementFixture = async (mutate) => {
    const root = await fixture(mutate);
    await put(root, authority.sourceInventory, registryBytes);
    const target = path.join(root, "vendor/t3code/sync-inventory.json");
    const baseline = JSON.parse(await readFile(target, "utf8"));
    baseline.sourceManifestSha256 = hash(originalManifest);
    baseline.files.push({ destination: authority.sourceInventory, asset: authority.sourceInventory, sha256: hash(registryBytes), bytes: registryBytes.length, mode: 0o644 });
    await writeFile(target, encode(baseline));
    await put(root, replacementPath, replacementBytes);
    return root;
  };
  const replacement = await replacementFixture();
  const reviewName = path.join(replacement, "review.json");
  const review = { destination: replacementPath, inputs: [{ commit: input.commit, path: input.path }], reason: "Reviewed synthetic composer replacement", license: "MIT; vendor/t3code/LICENSE" };
  const replacementArgs = ["--add-output", reviewName, "--accept-output", `${replacementPath}=${hash(replacementBytes)}`];
  await writeFile(reviewName, encode({ ...review, recipe: { kind: "local-bytes" } }));
  await author(replacement, replacementArgs, 1, /requires only/);
  await writeFile(reviewName, encode({ ...review, destination: "apps/web/src/unreviewed.tsx" }));
  await author(replacement, replacementArgs, 1, /Unknown\/duplicate\/existing/);
  await writeFile(reviewName, encode({ ...review, inputs: [{ commit: "a".repeat(40), path: input.path }] }));
  await author(replacement, replacementArgs, 1, /Unknown\/duplicate registered input/);
  await writeFile(reviewName, encode({ ...review, inputs: [review.inputs[0], review.inputs[0]] }));
  await author(replacement, replacementArgs, 1, /Unknown\/duplicate registered input/);
  await writeFile(reviewName, encode(review));
  await author(replacement, ["--add-output", reviewName], 1, /exact --accept-output/);
  await author(replacement, [...replacementArgs, "--add-output", reviewName], 1, /Unknown\/duplicate\/existing/);
  await author(replacement, ["--add-output", reviewName, "--accept-output", `${replacementPath}=${"0".repeat(64)}`], 1, /Unapproved output drift/);
  const replacementLedger = await author(replacement, replacementArgs);
  const newRecord = replacementLedger.outputs.find((entry) => entry.destination === replacementPath);
  assert.deepEqual(newRecord.inputs, [input], "Only registered full immutable identities may enter the new mapping");
  assert.equal(newRecord.provenance, "adapted-upstream");
  for (const entry of initial.outputs) assert.deepEqual(replacementLedger.outputs.find((candidate) => candidate.destination === entry.destination), entry);
  const restored = await replacementFixture((ledger) => ledger.outputs.push({ ...structuredClone(records[1]), destination: replacementPath, retirement: { sha256: records[1].sha256, reason: "Already retired" } }));
  await rm(path.join(restored, replacementPath));
  const restoreReview = path.join(restored, "review.json");
  await writeFile(restoreReview, encode(review));
  await author(restored, ["--add-output", restoreReview, "--accept-output", `${replacementPath}=${hash(replacementBytes)}`], 1, /Unknown\/duplicate\/existing/);

  const narrow = await fixture();
  const asset = "vendor/t3code/SYNC.md", other = "vendor/t3code/sync-imports.json";
  const oldAsset = Buffer.from("Reviewed local baseline\n"), newAsset = Buffer.from("Reviewed local baseline, amended\n");
  await put(narrow, asset, oldAsset);
  const baselinePath = path.join(narrow, "vendor/t3code/sync-inventory.json");
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  baseline.sourceManifestSha256 = hash(originalManifest);
  for (const name of [asset, other]) {
    const bytes = await readFile(path.join(narrow, name));
    baseline.files.push({ destination: name, asset: name, sha256: hash(bytes), bytes: bytes.length, mode: 0o644, provenance: "local-addition" });
  }
  const actualInventory = JSON.parse(await readFile(path.join(repository, "vendor/t3code/sync-inventory.json"), "utf8"));
  const frozenFixtures = new Map();
  for (const name of ["vendor/t3code/source-manifest.json", "vendor/t3code/mcp-skills-source.json", "vendor/t3code/omp-source.json"]) {
    const record = actualInventory.files.find((entry) => entry.destination === name);
    assert.equal(record?.asset, name);
    assert.equal(record?.provenance, "local-addition", "Exercise the real classification that previously admitted immutable registries");
    const bytes = await readFile(path.join(repository, name));
    baseline.files.push(structuredClone(record));
    frozenFixtures.set(name, bytes);
    await put(narrow, name, bytes);
  }
  baseline.runtimeResources = { hostBuildInputs: [{ path: "unrelated-host-tool", sha256: "a".repeat(64) }] };
  await writeFile(baselinePath, encode(baseline));
  await put(narrow, asset, newAsset);
  await put(narrow, other, "Unapproved unrelated local bytes\n");
  const bind = async (args, expected, message) => {
    const before = await readFile(baselinePath);
    const result = spawnSync("python3", [path.join(narrow, "vendor/t3code/scripts/capture.py"), "--source", source, ...args], { encoding: "utf8", env: environment });
    if (result.error) throw result.error;
    assert.equal(result.status, expected, result.stderr + result.stdout);
    if (message) assert.match(result.stderr, message);
    if (expected) assert.deepEqual(await readFile(baselinePath), before, "Rejected narrow binding must not publish metadata");
  };
  const acceptance = ["--accept-local", `${asset}=${hash(newAsset)}`];
  await bind(["--accept-local", `${asset}=${"0".repeat(64)}`], 1, /Wrong local acceptance hash/);
  await bind([...acceptance, ...acceptance], 1, /duplicate local acceptance/);
  await bind([...acceptance, "--allow-host-input", "unknown"], 1, /cannot enroll/);
  for (const [name, bytes] of frozenFixtures) {
    const changed = name.endsWith("/source-manifest.json") ? bytes : Buffer.concat([bytes, Buffer.from("\n")]);
    await put(narrow, name, changed);
    await bind([...acceptance, "--accept-local", `${name}=${hash(changed)}`], 1, /Immutable source registry cannot be rebound/);
    assert.deepEqual(await readFile(path.join(narrow, name)), changed, "Rejected binding must not rewrite registry bytes");
    await put(narrow, name, bytes);
  }
  await chmod(path.join(narrow, asset), 0o755);
  await bind(acceptance, 1, /changed local asset mode/);
  await chmod(path.join(narrow, asset), 0o644);
  await bind(acceptance, 0);
  const bound = JSON.parse(await readFile(baselinePath, "utf8"));
  const expectedBinding = structuredClone(baseline);
  Object.assign(expectedBinding.files.find((entry) => entry.destination === asset), { sha256: hash(newAsset), bytes: newAsset.length });
  assert.deepEqual(bound, expectedBinding, "Only the explicitly approved binding may change; no unrelated output/host refresh");
  await bind(acceptance, 1, /Stale\/unnecessary/);
  assert.deepEqual(await readFile(path.join(narrow, "vendor/t3code/source-manifest.json")), originalManifest);
  console.log(JSON.stringify({ unchangedDeterministic: true, malformedIdentityRefused: true, oldRecipePreserved: true, existingTargetRefused: true, exactRetirementHashRequired: true, duplicateUnknownRequestsRefused: true, liveRelativeAliasConsumersRefused: true, granularOutputAcceptanceRequired: true, rejectedWritesAbsent: true, adaptedAndLocalRetirementReplay: true }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
