import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { applyPatch, closure, encode, outputPath, patchBytes, prefix, registryFiles, repository, sha256, verifyOutputs } from "./provenance.mjs";

function archive(entries) {
  const blocks = [];
  for (const [name, content, kind = "0", mode = 0o644] of entries) {
    const bytes = Buffer.from(content), header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    const number = (value, offset, length) => header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
    number(mode, 100, 8); number(0, 108, 8); number(0, 116, 8); number(bytes.length, 124, 12); number(0, 136, 12);
    header.fill(32, 148, 156); header.write(kind, 156); header.write("ustar\0", 257);
    const sum = header.reduce((total, value) => total + value, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]), { mtime: 0 });
}
function fixture(extra = []) {
  const members = [
    ["package/LICENSE", "MIT License\nCopyright (c) 2025 OpenHands\n"],
    ["package/package.json", JSON.stringify({ name: "@openhands/extensions", version: "0.36.0", license: "MIT", repository: { url: "https://github.com/OpenHands/extensions" } })],
    ["package/integrations/index.js", "export const catalog = [];\n"],
  ];
  const bytes = archive([...members, ...extra]);
  const manifest = { extensions: { name: "@openhands/extensions", version: "0.36.0", integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` }, files: members.map(([name, text]) => ({ origin: "extensions-npm", source: name.slice(8), destination: name.slice(8) === "package.json" ? "extensions/source-package.json" : `extensions/${name.slice(8)}`, mode: 0o644, sha256: sha256(Buffer.from(text)), bytes: Buffer.byteLength(text) })) };
  return { bytes, manifest };
}
test("npm integrity and exact selected original bytes are independent of Git", () => {
  const { bytes, manifest } = fixture();
  assert.equal(registryFiles(bytes, manifest).get("integrations/index.js").bytes.toString(), "export const catalog = [];\n");
  assert.throws(() => registryFiles(Buffer.concat([bytes, Buffer.from("tampered")]), manifest), /integrity mismatch/);
  assert.throws(() => registryFiles(bytes, { ...manifest, files: manifest.files.map((entry, index) => index ? entry : { ...entry, sha256: "0".repeat(64) }) }), /hash\/size\/mode mismatch/);
});
test("unknown selected npm members and nonregular/path-escaping tar inputs are refused", () => {
  for (const [extra, error] of [
    [["package/integrations/unreviewed.js", "unexpected"], /Unknown\/missing/],
    [["package/../../escape", "bad"], /Unsafe provenance path/],
    [["package/link", "", "2"], /Unsupported\/duplicate/],
    [["package/executable", "", "0", 0o4644], /Special npm tar mode/],
  ]) {
    const { bytes, manifest } = fixture([extra]);
    assert.throws(() => registryFiles(bytes, manifest), error);
  }
});
test("exact binary adaptation rejects changed preimages and retains source identity", () => {
  const before = Buffer.from([0, 255, 10, 13, 42]), after = Buffer.from([0, 255, 12, 13, 42]);
  const entry = { source: "src/original.ts", destination: prefix + "src/original.ts", upstreamSha256: sha256(before), sha256: sha256(after) };
  const recipe = patchBytes(before, after, entry.source);
  assert.deepEqual(applyPatch(before, recipe, entry), after);
  assert.throws(() => applyPatch(Buffer.from("other"), recipe, entry), /identity mismatch/);
  assert.throws(() => applyPatch(before, recipe, { ...entry, source: "src/generated-locale.json" }), /identity mismatch/);
});
test("OpenHands cannot enroll CC Switch, automation, credentials or traversal as local", () => {
  for (const name of ["vendor/cc-switch/src/web/index.tsx", "vendor/openhands-automations/interface.json", `${prefix}../escape`, `${prefix}auth.json`, `${prefix}node_modules/package.js`]) assert.throws(() => outputPath(name));
  assert.equal(outputPath(prefix + "src/web/index.tsx"), prefix + "src/web/index.tsx");
});

async function boundaryFixture() {
  const root = await realpath(await mkdtemp(path.join(repository, ".tmp-openhands-boundary-")));
  const entry = `${prefix}src/web/index.tsx`;
  const publicEntry = "vendor/cc-switch/src/web/index.tsx";
  const internal = "vendor/cc-switch/src/hooks/useMcp.ts";
  const put = async (name, text) => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  };
  await put("package.json", "{}");
  await put(publicEntry, 'export { useMcpManagement } from "../hooks/useMcp";\n');
  await put(internal, "export const useMcpManagement = () => true;\n");
  const policy = {
    productionRoots: [entry],
    sourceAliases: { "@pm/cc-switch-ui": publicEntry },
    independentForkRoots: ["vendor/cc-switch"],
  };
  return { root, entry, publicEntry, internal, policy, put, close: () => rm(root, { recursive: true, force: true }) };
}

test("OpenHands records only the independent CC public entry without owning its implementation", async () => {
  const f = await boundaryFixture();
  try {
    await f.put(f.entry, 'import { useMcpManagement } from "@pm/cc-switch-ui";\n');
    const result = JSON.parse(await closure(f.root, f.policy, [{ destination: f.entry }]));
    const ccInputs = result.inputs.filter(input => input.path.startsWith("vendor/cc-switch/"));
    assert.deepEqual(ccInputs.map(input => [input.path, input.ownership]), [[f.publicEntry, "independently-inventoried-boundary"]]);
    assert.ok(result.edges.some(edge => edge.source === f.entry && edge.specifier === "@pm/cc-switch-ui" && edge.target === f.publicEntry && edge.disposition === "independently-inventoried-boundary"));
    assert.ok(!result.inputs.some(input => input.path === f.internal));
  } finally { await f.close(); }
});

test("OpenHands refuses CC internal imports, exports, type-only and dynamic paths even with a source alias", async () => {
  const f = await boundaryFixture();
  try {
    f.policy.sourceAliases["@pm/cc-switch-source/"] = "vendor/cc-switch/src/";
    for (const source of [
      'import { useMcpManagement } from "@pm/cc-switch-source/hooks/useMcp";',
      'export { useMcpManagement } from "@pm/cc-switch-source/hooks/useMcp";',
      'import { useMcpManagement } from "../../../cc-switch/src/hooks/useMcp";',
      'export type { InternalMcpState } from "../../../cc-switch/src/hooks/useMcp";',
      'const load = () => import("../../../cc-switch/src/hooks/useMcp");',
      'import { useMcpManagement } from "../../../cc-switch/src/web/index";',
    ]) {
      await f.put(f.entry, source);
      await assert.rejects(closure(f.root, f.policy, [{ destination: f.entry }]), /CC Switch public entry required/);
    }
    f.policy.sourceAliases["@pm/cc-switch-ui"] = f.internal;
    await f.put(f.entry, 'import { useMcpManagement } from "@pm/cc-switch-ui";');
    await assert.rejects(closure(f.root, f.policy, [{ destination: f.entry }]), /CC Switch public entry required/);
  } finally { await f.close(); }
});

test("the removed CC source alias and unpublished package subpaths remain unresolved", async () => {
  const f = await boundaryFixture();
  try {
    for (const specifier of ["@pm/cc-switch-source/hooks/useMcp", "@pm/cc-switch-ui/hooks/useMcp"]) {
      await f.put(f.entry, `import { useMcpManagement } from "${specifier}";`);
      await assert.rejects(closure(f.root, f.policy, [{ destination: f.entry }]), /Unresolved source alias/);
    }
  } finally { await f.close(); }
});

test("narrow local authoring requires exact recipe approvals and preserves unrelated generation bytes", async () => {
  const root = await realpath(await mkdtemp(path.join(repository, ".tmp-openhands-authoring-")));
  const inventoryPath = `${prefix}output-inventory.json`, closurePath = `${prefix}resource-closure.json`;
  const beforeBytes = await readFile(path.join(repository, inventoryPath));
  const inventory = JSON.parse(beforeBytes);
  const graph = JSON.parse(await readFile(path.join(repository, closurePath), "utf8"));
  const names = new Set([inventoryPath, closurePath, ...inventory.files.map((entry) => entry.destination), ...inventory.hostBuildInputs.map((entry) => entry.path), ...inventory.patches.map((entry) => entry.path), ...inventory.inputArtifacts.map((entry) => entry.path), ...graph.inputs.map((entry) => entry.path), "vendor/cc-switch/scripts/provenance.mjs", "vendor/cc-switch/scripts/closure.mjs"]);
  const put = async (name, bytes) => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), bytes);
  };
  try {
    for (const name of names) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await cp(path.join(repository, name), path.join(root, name));
    }
    const script = `${prefix}scripts/web-build.mjs`, doc = `${prefix}SYNC.md`;
    const recipePath = inventory.files.find((entry) => entry.destination === script).asset.path;
    const oldRecipe = encode({ version: 1, destination: script, sha256: sha256(Buffer.from("historical recipe payload\n")), mode: 0o644, encoding: "base64", content: Buffer.from("historical recipe payload\n").toString("base64") });
    // Synthetic prior inconsistency: the output binding is current, but its
    // authenticated recipe still reconstructs older bytes.
    await put(recipePath, oldRecipe);
    inventory.files.find((entry) => entry.destination === script).asset.sha256 = sha256(oldRecipe);
    Object.assign(inventory.patches.find((entry) => entry.path === recipePath), { sha256: sha256(oldRecipe), bytes: oldRecipe.length });
    await put(inventoryPath, encode(inventory));
    const docBytes = Buffer.concat([await readFile(path.join(root, doc)), Buffer.from("\nReviewed fixture amendment.\n")]);
    await put(doc, docBytes);
    const docApproval = ["--accept-change", `${doc}=${sha256(docBytes)}`];
    const scriptApproval = ["--accept-change", `${script}=${sha256(await readFile(path.join(root, script)))}`];
    const capture = async (args, expected, message) => {
      const baseline = await readFile(path.join(root, inventoryPath));
      const recipes = new Map(await Promise.all(inventory.patches.map(async (entry) => [entry.path, await readFile(path.join(root, entry.path))])));
      const result = spawnSync(process.execPath, [path.join(root, `${prefix}scripts/capture.mjs`), "--record-local", "--review", "--reason", "Reviewed isolated local authoring fixture", ...args], { encoding: "utf8" });
      if (result.error) throw result.error;
      assert.equal(result.status, expected, result.stderr + result.stdout);
      if (message) assert.match(result.stderr, message);
      if (expected) {
        assert.deepEqual(await readFile(path.join(root, inventoryPath)), baseline);
        for (const [name, bytes] of recipes) assert.deepEqual(await readFile(path.join(root, name)), bytes, `Rejected operation changed ${name}`);
      }
    };
    await capture(docApproval, 1, /Unapproved local recipe drift/);
    await capture([...docApproval, ...docApproval], 1, /Duplicate approval/);
    await capture(["--accept-change", `${doc}=${"0".repeat(64)}`], 1, /Wrong exact local hash/);
    await capture(["--accept-change", `${prefix}source-manifest.json=${sha256(await readFile(path.join(root, `${prefix}source-manifest.json`)))}`], 1, /Not an existing mutable local output/);
    await capture(["--accept-change", `${prefix}unknown.js=${"a".repeat(64)}`], 1, /Not an existing mutable local output/);
    await chmod(path.join(root, doc), 0o755);
    await capture([...docApproval, ...scriptApproval], 1, /Wrong exact local hash\/mode/);
    await chmod(path.join(root, doc), 0o644);
    await capture([...docApproval, ...scriptApproval], 0);
    const result = JSON.parse(await readFile(path.join(root, inventoryPath), "utf8"));
    const selected = new Set([doc, script]);
    for (const entry of inventory.files) if (!selected.has(entry.destination)) assert.deepEqual(result.files.find((item) => item.destination === entry.destination), entry);
    const selectedRecipes = new Set(inventory.files.filter((entry) => selected.has(entry.destination)).map((entry) => entry.asset.path));
    for (const entry of inventory.patches) if (!selectedRecipes.has(entry.path)) {
      assert.deepEqual(result.patches.find((item) => item.path === entry.path), entry);
      assert.deepEqual(await readFile(path.join(root, entry.path)), await readFile(path.join(repository, entry.path)));
    }
    assert.deepEqual(result.hostBuildInputs, inventory.hostBuildInputs);
    assert.deepEqual(result.inputArtifacts, inventory.inputArtifacts);
    assert.equal(result.closureSha256, inventory.closureSha256);
    await verifyOutputs(root);
    await capture(scriptApproval, 1, /Stale\/unnecessary/);
    const originalEntry = result.files.find((entry) => entry.patch);
    const invalidPatch = JSON.parse(await readFile(path.join(root, originalEntry.patch.path), "utf8"));
    invalidPatch.version = 99;
    const invalidBytes = encode(invalidPatch);
    await put(originalEntry.patch.path, invalidBytes);
    originalEntry.patch.sha256 = sha256(invalidBytes);
    Object.assign(result.patches.find((entry) => entry.path === originalEntry.patch.path), { sha256: sha256(invalidBytes), bytes: invalidBytes.length });
    await put(inventoryPath, encode(result));
    const nextDoc = Buffer.concat([docBytes, Buffer.from("Next reviewed amendment.\n")]);
    await put(doc, nextDoc);
    await capture(["--accept-change", `${doc}=${sha256(nextDoc)}`], 1, /Patch identity mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary capture requires exact approval before removing a historical original recipe", { skip: !process.env.PM_OPENHANDS_AUTHORING_SOURCE && "Requires the read-only pinned PM_OPENHANDS_AUTHORING_SOURCE; skipped is not an authoring pass" }, async () => {
  const root = await realpath(await mkdtemp(path.join(repository, ".tmp-openhands-ordinary-authoring-")));
  const inventoryPath = `${prefix}output-inventory.json`, closurePath = `${prefix}resource-closure.json`;
  const inventory = JSON.parse(await readFile(path.join(repository, inventoryPath), "utf8"));
  const graph = JSON.parse(await readFile(path.join(repository, closurePath), "utf8"));
  const names = new Set([inventoryPath, closurePath, ...inventory.files.map((entry) => entry.destination), ...inventory.hostBuildInputs.map((entry) => entry.path), ...inventory.patches.map((entry) => entry.path), ...inventory.inputArtifacts.map((entry) => entry.path), ...graph.inputs.map((entry) => entry.path), "vendor/cc-switch/scripts/provenance.mjs", "vendor/cc-switch/scripts/closure.mjs"]);
  const put = async (name, bytes) => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), bytes);
  };
  try {
    for (const name of names) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await cp(path.join(repository, name), path.join(root, name));
    }
    const live = new Set(graph.inputs.map((entry) => entry.path));
    const original = inventory.files.find((entry) => entry.patch && !live.has(entry.destination));
    assert.ok(original, "Use a real snapshot-only adapted original without changing production closure");
    const recipePath = original.patch.path;
    const bytes = await readFile(path.join(root, `${prefix}source-inputs/blobs/${original.upstreamSha256}.bin`));
    await put(original.destination, bytes);
    // Reproduce the real drift class: files[] already describes pristine bytes,
    // but an authenticated old adaptation recipe is still enrolled.
    original.sha256 = sha256(bytes); original.bytes = bytes.length; original.provenance = "pristine-original";
    await put(inventoryPath, encode(inventory));
    const doc = `${prefix}SYNC.md`;
    const docBytes = Buffer.concat([await readFile(path.join(root, doc)), Buffer.from("\nUnrelated reviewed authoring fixture amendment.\n")]);
    await put(doc, docBytes);
    const baseline = await readFile(path.join(root, inventoryPath)), closureBytes = await readFile(path.join(root, closurePath));
    const recipes = new Map(await Promise.all(inventory.patches.map(async (entry) => [entry.path, await readFile(path.join(root, entry.path))])));
    const author = (approvals) => {
      const result = spawnSync(process.execPath, [path.join(root, `${prefix}scripts/capture.mjs`), "--source", process.env.PM_OPENHANDS_AUTHORING_SOURCE, "--extensions-tarball", path.join(root, `${prefix}source-inputs/extensions-0.36.0.tgz`), "--review", "--reason", "Reviewed isolated ordinary recipe-removal fixture", "--accept-change", `${doc}=${sha256(docBytes)}`, ...approvals], { encoding: "utf8" });
      if (result.error) throw result.error;
      return result;
    };
    const rejected = author([]);
    assert.equal(rejected.status, 1, rejected.stderr + rejected.stdout);
    assert.match(rejected.stderr, /Exact review required/);
    assert.ok(rejected.stderr.includes(original.destination), rejected.stderr);
    assert.deepEqual(await readFile(path.join(root, inventoryPath)), baseline);
    assert.deepEqual(await readFile(path.join(root, closurePath)), closureBytes);
    for (const [name, recipe] of recipes) assert.deepEqual(await readFile(path.join(root, name)), recipe, `Rejected ordinary authoring changed/deleted ${name}`);
    const approved = author(["--accept-change", `${original.destination}=${sha256(bytes)}`]);
    assert.equal(approved.status, 0, approved.stderr + approved.stdout);
    const result = JSON.parse(await readFile(path.join(root, inventoryPath), "utf8"));
    assert.equal(result.files.find((entry) => entry.destination === original.destination).patch, undefined);
    assert.ok(!result.patches.some((entry) => entry.path === recipePath));
    await assert.rejects(readFile(path.join(root, recipePath)), { code: "ENOENT" });
    assert.deepEqual(await readFile(path.join(root, original.destination)), bytes);
    await verifyOutputs(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
