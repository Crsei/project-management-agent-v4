import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { dependencyLayoutManifest, verifyDependencyLayout } from "./dependency-layout-verifier.mjs";
import { inventoryTree } from "./runtime-manifest.mjs";

async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pm-desktop-layout-guard-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root, path, bytes) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytes);
}
async function fixture(root, definitions, rootDependencies, { id = "agent", contextRoot = ".", absentDependencies = [], effectSingleton = null } = {}) {
  const instances = [];
  // Write every package first, then inventory own resources only.
  for (const definition of definitions) {
    const dependencies = Object.fromEntries(Object.keys(definition.dependencies ?? {}).map((name) => [name, "*"]));
    await put(root, `${definition.path}/package.json`, JSON.stringify({ name: definition.name, version: definition.version ?? "1.0.0", main: "index.cjs", dependencies, ...definition.metadata }));
    await put(root, `${definition.path}/index.cjs`, definition.code ?? `module.exports = { name: ${JSON.stringify(definition.name)}, version: ${JSON.stringify(definition.version ?? "1.0.0")} };\n`);
    await put(root, `${definition.path}/sdk-resource.bin`, "SDK own resource retained\n");
  }
  for (const definition of definitions) {
    instances.push({ id: definition.path, path: definition.path, sourceId: definition.sourceId ?? `original/${definition.name}/${definition.version ?? "1.0.0"}`,
      name: definition.name, version: definition.version ?? "1.0.0", dependencies: definition.dependencies ?? {}, absentDependencies: definition.absentDependencies ?? [],
      files: (await inventoryTree(join(root, definition.path))).filter((file) => !file.path.startsWith("node_modules/")) });
  }
  const manifest = { schemaVersion: 1, contexts: [{ id, root: contextRoot, dependencies: rootDependencies, absentDependencies, effectSingleton, instances }] };
  await put(root, dependencyLayoutManifest, JSON.stringify(manifest));
  return manifest;
}

const shared = () => [
  { path: "node_modules/a", name: "a", dependencies: { shared: "node_modules/shared" }, code: 'module.exports = require("shared");\n' },
  { path: "node_modules/b", name: "b", dependencies: { shared: "node_modules/shared" }, code: 'module.exports = require("shared");\n' },
  { path: "node_modules/shared", name: "shared" },
];
const roots = { a: "node_modules/a", b: "node_modules/b" };

test("physical shared diamond passes and actual CJS consumers share the same module object", async (t) => {
  const root = await temporary(t);
  await fixture(root, shared(), roots);
  const report = await verifyDependencyLayout(root);
  const require = createRequire(join(root, "entry.cjs"));
  assert.equal(require("a"), require("b"));
  assert.equal(report.contexts[0].instanceCount, 3);
  assert.equal(report.contexts[0].necessaryCopies.length, 0);
  assert.ok(report.contexts[0].files > 0 && report.contexts[0].logicalBytes > 0);
});

test("undeclared recursive archive-style expansion fails even when every copied byte is equal", async (t) => {
  const root = await temporary(t);
  await fixture(root, shared(), roots);
  await cp(join(root, "node_modules/shared"), join(root, "node_modules/a/node_modules/shared"), { recursive: true });
  await assert.rejects(verifyDependencyLayout(root), /Undeclared or recursively expanded dependency/);
});

test("declaring redundant recursive copies or relabelling their source IDs cannot bless expansion", async (t) => {
  for (const sourceId of ["original/shared/1.0.0", "invented/alternate-context"]) {
    const root = await temporary(t);
    const definitions = shared();
    definitions[0].dependencies.shared = "node_modules/a/node_modules/shared";
    definitions.push({ path: "node_modules/a/node_modules/shared", name: "shared", sourceId });
    await fixture(root, definitions, roots);
    await assert.rejects(verifyDependencyLayout(root), /Redundant recursive dependency copy/);
  }
});

test("required version conflicts remain separate and execute the correct dependency", async (t) => {
  const root = await temporary(t);
  const definitions = shared();
  definitions[0].dependencies.shared = "node_modules/a/node_modules/shared";
  definitions.push({ path: "node_modules/a/node_modules/shared", name: "shared", version: "2.0.0" });
  await fixture(root, definitions, roots);
  assert.equal((await verifyDependencyLayout(root)).status, "passed");
  const require = createRequire(join(root, "entry.cjs"));
  assert.equal(require("a").version, "2.0.0");
  assert.equal(require("b").version, "1.0.0");
});

test("same name/version with genuinely different peer bindings remains valid", async (t) => {
  const root = await temporary(t);
  await fixture(root, [
    { path: "node_modules/owner", name: "owner", dependencies: { plugin: "node_modules/owner/node_modules/plugin", peer: "node_modules/owner/node_modules/peer" }, code: 'module.exports = require("plugin");' },
    { path: "node_modules/plugin", name: "plugin", sourceId: "original/plugin-peer1", dependencies: { peer: "node_modules/peer" }, code: 'module.exports = require("peer");' },
    { path: "node_modules/owner/node_modules/plugin", name: "plugin", sourceId: "original/plugin-peer2", dependencies: { peer: "node_modules/owner/node_modules/peer" }, code: 'module.exports = require("peer");' },
    { path: "node_modules/peer", name: "peer", version: "1.0.0" },
    { path: "node_modules/owner/node_modules/peer", name: "peer", version: "2.0.0" },
  ], { owner: "node_modules/owner", plugin: "node_modules/plugin" });
  const report = await verifyDependencyLayout(root);
  assert.equal(report.contexts[0].peerOrVersionContexts[0].identity, "plugin@1.0.0");
  const require = createRequire(join(root, "entry.cjs"));
  assert.equal(require("owner").version, "2.0.0");
  assert.equal(require("plugin").version, "1.0.0");
});

for (const mutation of ["missing-package", "wrong-binding", "wrong-package", "missing-resource", "changed-resource"]) {
  test(`dependency guard fails closed for ${mutation}`, async (t) => {
    const root = await temporary(t);
    const manifest = await fixture(root, shared(), roots);
    if (mutation === "missing-package") await rm(join(root, "node_modules/shared"), { recursive: true });
    else if (mutation === "wrong-binding") {
      manifest.contexts[0].instances[0].dependencies.shared = "node_modules/b";
      await put(root, dependencyLayoutManifest, JSON.stringify(manifest));
    } else if (mutation === "wrong-package") await put(root, "node_modules/shared/package.json", JSON.stringify({ name: "shared", version: "9.0.0" }));
    else if (mutation === "missing-resource") await rm(join(root, "node_modules/shared/sdk-resource.bin"));
    else await put(root, "node_modules/shared/sdk-resource.bin", "wrong resource bytes");
    await assert.rejects(verifyDependencyLayout(root), /missing|changed|binding|identity/i);
  });
}

test("optional absence cannot be accidentally activated by hoisting", async (t) => {
  const root = await temporary(t);
  await fixture(root, [{ path: "node_modules/a", name: "a", absentDependencies: ["optional"], metadata: { optionalDependencies: { optional: "*" } } }], { a: "node_modules/a" });
  assert.equal((await verifyDependencyLayout(root)).status, "passed");
  await fixture(root, [
    { path: "node_modules/a", name: "a", absentDependencies: ["optional"], metadata: { optionalDependencies: { optional: "*" } } },
    { path: "node_modules/optional", name: "optional" },
  ], { a: "node_modules/a", optional: "node_modules/optional" });
  await assert.rejects(verifyDependencyLayout(root), /Previously absent/);
});

test("manifest cannot declare a mandatory package dependency absent", async (t) => {
  const root = await temporary(t);
  await fixture(root, [{ path: "node_modules/a", name: "a", absentDependencies: ["required"], metadata: { dependencies: { required: "*" } } }], { a: "node_modules/a" });
  await assert.rejects(verifyDependencyLayout(root), /Mandatory desktop dependency/);
});

test("missing manifests and escaping package links fail closed", async (t) => {
  const root = await temporary(t);
  await assert.rejects(verifyDependencyLayout(root), { code: "ENOENT" });
  await fixture(root, shared(), roots);
  const original = await readFile(join(root, dependencyLayoutManifest));
  await rm(join(root, "node_modules/shared"), { recursive: true });
  await symlink(root, join(root, "node_modules/shared"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(verifyDependencyLayout(root), /expanded dependency|link/);
  assert.deepEqual(await readFile(join(root, dependencyLayoutManifest)), original);
});

test("exported package self-references use the actual owner before ancestor lookup", async (t) => {
  const root = await temporary(t);
  await fixture(root, [{ path: "node_modules/self", name: "self", dependencies: { self: "node_modules/self" }, metadata: { exports: "./index.cjs" } }], { self: "node_modules/self" });
  assert.equal((await verifyDependencyLayout(root)).status, "passed");
});

test("identical packages in separate PM and Agent closures are not global-hash deduplication violations", async (t) => {
  const root = await temporary(t);
  const pm = await fixture(root, [{ path: "node_modules/shared", name: "shared" }], { shared: "node_modules/shared" }, { id: "pm" });
  const agent = await fixture(root, [{ path: "apps/server/agent/node_modules/shared", name: "shared" }], { shared: "apps/server/agent/node_modules/shared" }, { id: "agent", contextRoot: "apps/server/agent" });
  await put(root, dependencyLayoutManifest, JSON.stringify({ schemaVersion: 1, contexts: [...pm.contexts, ...agent.contexts] }));
  const report = await verifyDependencyLayout(root);
  assert.deepEqual(report.contexts.map((context) => context.instanceCount), [1, 1]);
});

test("only exactly inventoried physical command shims are admitted in .bin", async (t) => {
  const root = await temporary(t);
  const manifest = await fixture(root, shared(), roots);
  await put(root, "node_modules/.bin/cli", "#!/bin/sh\nexit 0\n");
  const file = (await inventoryTree(join(root, "node_modules/.bin")))[0];
  manifest.contexts[0].binFiles = [{ ...file, path: `node_modules/.bin/${file.path}` }];
  await put(root, dependencyLayoutManifest, JSON.stringify(manifest));
  assert.equal((await verifyDependencyLayout(root)).status, "passed");
  await put(root, "node_modules/.bin/extra", "unrecorded command");
  await assert.rejects(verifyDependencyLayout(root), /unrecorded desktop command shim/);
});

test("package-owned template node_modules resources are preserved but cannot grow beyond their exact inventory", async (t) => {
  const root = await temporary(t);
  const manifest = await fixture(root, [{ path: "node_modules/template-owner", name: "template-owner" }], { "template-owner": "node_modules/template-owner" });
  await put(root, "node_modules/template-owner/templates/example/node_modules/retained/package.json", JSON.stringify({ name: "retained-template", version: "1.0.0" }));
  await put(root, "node_modules/template-owner/templates/example/node_modules/retained/resource.txt", "template-owned package resource");
  manifest.contexts[0].instances[0].files = await inventoryTree(join(root, "node_modules/template-owner"));
  await put(root, dependencyLayoutManifest, JSON.stringify(manifest));
  assert.equal((await verifyDependencyLayout(root)).status, "passed");
  await put(root, "node_modules/template-owner/templates/example/node_modules/extra/resource.txt", "unrecorded expansion");
  await assert.rejects(verifyDependencyLayout(root), /resources missing, changed or expanded/);
});
