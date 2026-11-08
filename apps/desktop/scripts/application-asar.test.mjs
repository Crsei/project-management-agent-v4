import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { desktopBuilderConfig } from "../electron-builder.config.mjs";
import { prepackApplication } from "./application-asar.mjs";
import { materializeDependencyLayout, planDependencyLayout, readDependencyGraph, writeDependencyLayout } from "./dependency-layout.mjs";
import { verifyDependencyLayout } from "./dependency-layout-verifier.mjs";
import { asarTools } from "./packaged-application.mjs";
import { desktopRoot, hashFile, inventoryTree } from "./runtime-manifest.mjs";
import { createInstallStamp } from "./install-stamp.mjs";

function lockedBuilder() {
  const require = createRequire(import.meta.url);
  const builder = createRequire(require.resolve("electron-builder"));
  return createRequire(builder.resolve("app-builder-lib"));
}

// Build an isolated input from the real installed, locked Electron pg closure.
// No package-manager install, Electron download, native build or fake dependency
// metadata is involved. Canonical own files (including README and package.json)
// are copied intact; only production graph links are reconstructed for staging.
async function stageRealElectronClosure(temporary) {
  const repository = await realpath(resolve(desktopRoot, "../.."));
  const installed = await readDependencyGraph(repository, { roots: ["pg"] });
  const source = join(temporary, "source"), application = join(temporary, "application"), scratch = join(temporary, "scratch");
  for (const directory of [source, application, scratch]) await mkdir(directory);
  const manifest = { name: "pm-agent-v4-desktop", version: "0.1.0", type: "module", private: true,
    description: "Real locked Electron closure regression", main: "dist/main.mjs", dependencies: { pg: "8.23.1" } };
  for (const directory of [source, application]) await writeFile(join(directory, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  await mkdir(join(application, "dist"));
  await writeFile(join(application, "dist/main.mjs"), "import pg from 'pg'; export const Client = pg.Client;\n");
  const packages = new Map([...installed.packages].map(([id], index) => [id, join(source, ".packages", String(index))]));
  for (const [id, record] of installed.packages) {
    await cp(record.source, packages.get(id), { recursive: true, verbatimSymlinks: true,
      filter: (path) => path !== join(record.source, "node_modules") });
  }
  async function link(from, name, id) {
    const path = join(from, "node_modules", name);
    await mkdir(dirname(path), { recursive: true });
    await symlink(relative(dirname(path), packages.get(id)), path, process.platform === "win32" ? "junction" : "dir");
  }
  for (const [id, record] of installed.packages)
    for (const [name, target] of record.dependencies) await link(packages.get(id), name, target);
  for (const [name, id] of installed.dependencies) await link(source, name, id);
  const graph = await readDependencyGraph(source);
  const context = planDependencyLayout(graph, { id: "electron" });
  await materializeDependencyLayout(graph, context, application, scratch);
  await writeDependencyLayout(application, [context]);
  return { application, context };
}

test("locked builder detects and consumes prepacked ASAR without transforming or pruning the inventoried real pg closure", async (t) => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "pm real builder asar-")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { application, context } = await stageRealElectronClosure(temporary);
  const pg = context.instances.find((instance) => instance.name === "pg");
  const manifestPath = join(application, pg.path, "package.json");
  const originalManifest = await readFile(manifestPath);
  const original = JSON.parse(originalManifest);
  assert.equal(original.version, "8.23.1");
  assert.ok(original.scripts && original.keywords && original.gitHead);
  const readme = (await readdir(join(application, pg.path))).find((name) => /^readme(?:\.|$)/i.test(name));
  assert.ok(readme, "The real pg README is part of the preserved resource inventory.");
  const before = await inventoryTree(application);
  const prepackedApplication = await prepackApplication(application, join(temporary, "prepacked"));
  await assert.rejects(lstat(join(prepackedApplication.directory, "package.json")), { code: "ENOENT" });
  assert.deepEqual(await readdir(prepackedApplication.directory), ["app.asar"]);
  const output = join(temporary, "output");
  const installStamp = createInstallStamp({ commit: "a".repeat(40), version: "0.1.0", platform: "win32", arch: "x64", distribution: "nsis", signing: "unsigned",
    source: { sha256: "b".repeat(64), dirty: false }, compatibility: { dataSchema: 1, postgresMajor: 16, migrationsSha256: "c".repeat(64) } });
  const config = desktopBuilderConfig({ application, prepackedApplication, workspaceRuntime: join(temporary, "workspace"),
    desktopRuntime: join(temporary, "runtime"), output, electronVersion: "45.0.0", mode: "unsigned", platform: "win32", nativeBinaries: [], installStamp });
  const library = lockedBuilder();
  // Demonstrate the exact real transformer that would corrupt the old path.
  const transformed = await library("./fileTransformer.js").createTransformer(application, config, null, null)(manifestPath);
  assert.ok(transformed);
  const cleaned = JSON.parse(transformed);
  assert.equal(cleaned.scripts, undefined);
  assert.equal(cleaned.keywords, undefined);
  assert.equal(cleaned.gitHead, undefined);

  // Exercise actual builder detection and copyAppFiles, not a mocked file copier
  // or a direct createPackage-only fixture. These are the same classes and
  // configuration used by package.mjs, stopping before native Electron assembly.
  const info = new (library("./packager.js").Packager)({ projectDir: prepackedApplication.directory, config });
  await info.validateConfig();
  assert.equal(info.isPrepackedAppAsar, true);
  assert.equal(info.appDir, prepackedApplication.directory);
  assert.equal(info.metadata.main, "dist/main.mjs");
  info._framework = await library("./electron/ElectronFramework.js").createElectronFrameworkSupport(info.config, info);
  info._appInfo = new (library("./appInfo.js").AppInfo)(info, null);
  const { Platform } = library("./core.js");
  const { Arch } = library("builder-util");
  const platform = new (library("./platformPackager.js").PlatformPackager)(info, Platform.WINDOWS);
  const taskManager = new (library("builder-util").AsyncTaskManager)(info.cancellationToken);
  const resources = join(output, "win-unpacked/resources");
  const packContext = { appOutDir: join(output, "win-unpacked"), outDir: output, arch: Arch.x64, targets: [], packager: platform, electronPlatformName: "win32" };
  platform.copyAppFiles(taskManager, await platform.computeAsarOptions(platform.platformSpecificBuildOptions), resources,
    join(resources, "app"), packContext, platform.platformSpecificBuildOptions, [], (pattern) => platform.expandMacro(pattern, Arch[Arch.x64]));
  await taskManager.awaitTasks();
  assert.equal(await hashFile(join(resources, "app.asar")), prepackedApplication.sha256);

  const extracted = join(temporary, "extracted");
  await mkdir(extracted);
  asarTools().extractAll(join(resources, "app.asar"), extracted);
  const comparable = (inventory) => inventory.map(({ mode: _mode, ...file }) => file);
  assert.deepEqual(comparable(await inventoryTree(extracted)), comparable(before));
  await verifyDependencyLayout(extracted);
  assert.deepEqual(await readFile(join(extracted, pg.path, "package.json")), originalManifest);
  assert.deepEqual(await readFile(join(extracted, pg.path, readme)), await readFile(join(application, pg.path, readme)));
  const require = createRequire(join(extracted, "dist/main.mjs"));
  assert.equal(typeof require("pg").Client, "function");
  assert.equal(require("pg").types.getTypeParser(23)("42"), 42);
});

test("prepacked application output refuses existing destinations and symlinked ancestors", async (t) => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "pm prepack ownership-")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const existing = join(temporary, "existing");
  await mkdir(existing);
  await assert.rejects(prepackApplication(temporary, existing));
  const alias = join(temporary, "alias");
  await symlink("existing", alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(prepackApplication(temporary, join(alias, "new")));
});
