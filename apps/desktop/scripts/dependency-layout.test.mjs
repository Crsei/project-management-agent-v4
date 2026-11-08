import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { locateDependency, materializeDependencyLayout, planDependencyLayout, readDependencyGraph, writeDependencyLayout } from "./dependency-layout.mjs";
const execute = promisify(execFile);

async function fixture(t, roots, definitions) {
  const temporary = await mkdtemp(join(tmpdir(), "pm desktop dependencies-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = join(temporary, "source"), output = join(temporary, "output"), scratch = join(temporary, "scratch");
  for (const root of [source, output, scratch]) await mkdir(root);
  const manifest = { name: "layout-test-root", version: "1.0.0", private: true,
    dependencies: Object.fromEntries(Object.keys(roots).map((name) => [name, "*"])) };
  await writeFile(join(source, "package.json"), JSON.stringify(manifest));
  await writeFile(join(output, "package.json"), JSON.stringify(manifest));
  const directories = new Map(Object.keys(definitions).map((id) => [id, join(source, ".packages", id)]));
  async function link(from, name, id) {
    const path = join(from, "node_modules", name);
    await mkdir(dirname(path), { recursive: true });
    await symlink(relative(dirname(path), directories.get(id)), path, process.platform === "win32" ? "junction" : "dir");
  }
  for (const [id, definition] of Object.entries(definitions)) {
    const directory = directories.get(id);
    await mkdir(directory, { recursive: true });
    const { dependencies = {}, files = {}, metadata = {}, name = id, version = "1.0.0" } = definition;
    await writeFile(join(directory, "package.json"), JSON.stringify({ name, version, main: "index.cjs",
      dependencies: Object.fromEntries(Object.keys(dependencies).map((name) => [name, "*"])), ...metadata }));
    for (const [path, content] of Object.entries({ "index.cjs": `module.exports = { name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)} };\n`, ...files })) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), content);
    }
    for (const [name, target] of Object.entries(dependencies)) await link(directory, name, target);
  }
  for (const [name, id] of Object.entries(roots)) await link(source, name, id);
  return { source, output, scratch, directories };
}
async function stage(fixture, options = { id: "pm" }) {
  const graph = await readDependencyGraph(fixture.source);
  const context = planDependencyLayout(graph, options);
  await materializeDependencyLayout(graph, context, fixture.output, fixture.scratch);
  await writeDependencyLayout(fixture.output, [context]);
  return { graph, context, require: createRequire(join(fixture.output, options.root ?? ".", "entry.cjs")) };
}
async function physicalFiles(root) {
  const files = [];
  for (const name of await readdir(root)) {
    const path = join(root, name), info = await lstat(path);
    assert.equal(info.isSymbolicLink(), false, `No dependency or resource links may reach the installer: ${path}`);
    if (info.isDirectory()) files.push(...await physicalFiles(path));
    else files.push(path);
  }
  return files;
}

test("diamond and cyclic dependencies copy canonical package content once, not once per incoming edge", async (t) => {
  const f = await fixture(t, { left: "left", right: "right", cycle: "cycle" }, {
    left: { dependencies: { shared: "shared" }, files: { "index.cjs": "module.exports = require('shared');" } },
    right: { dependencies: { shared: "shared" }, files: { "index.cjs": "module.exports = require('shared');" } },
    shared: { files: {
      "assets/resource.bin": Buffer.alloc(4096, 73), "LICENSE": "retained license", "index.cjs.map": "retained source map",
      "tests/resource.cjs": "retained package test resource",
      "tests/fixtures/eval/node_modules/file1.cjs": "module.exports='nested package-owned resource';",
      "tests/fixtures/eval/index.cjs": "module.exports=require('./node_modules/file1.cjs');",
    } },
    cycle: { dependencies: { back: "back" }, files: { "index.cjs": "exports.name='cycle'; exports.back=require('back');" } },
    back: { dependencies: { cycle: "cycle", shared: "shared" }, files: { "index.cjs": "exports.name='back'; exports.cycle=require('cycle'); exports.shared=require('shared');" } },
  });
  const { context, require } = await stage(f);
  assert.equal(context.summary.sourceCount, 5);
  assert.equal(context.summary.instanceCount, 5);
  assert.deepEqual(context.summary.repeatedSources, []);
  assert.equal(require("left"), require("right"));
  assert.equal(require("cycle").back.cycle, require("cycle"));
  assert.equal(require("cycle").back.shared, require("left"));
  const files = await physicalFiles(f.output);
  assert.equal(files.filter((path) => path.endsWith("resource.bin")).length, 1);
  assert.equal(files.filter((path) => path.endsWith("resource.cjs")).length, 1);
  assert.equal(files.filter((path) => path.endsWith("index.cjs.map")).length, 1);
  assert.equal(await readFile(join(f.output, "node_modules/shared/LICENSE"), "utf8"), "retained license");
  assert.equal(require(join(f.output, "node_modules/shared/tests/fixtures/eval/index.cjs")), "nested package-owned resource");
  assert.equal(context.instances.find((instance) => instance.name === "shared").files
    .some((file) => file.path === "tests/fixtures/eval/node_modules/file1.cjs"), true);
  await assert.rejects(lstat(join(f.output, ".packages")), { code: "ENOENT" });
});

test("version conflicts and identical-version peer contexts retain each consumer's physical peer object", async (t) => {
  const f = await fixture(t, { first: "first", second: "second" }, {
    first: { dependencies: { plugin: "plugin-first", peer: "peer-first" }, files: { "index.cjs": "module.exports={peer:require('peer'),plugin:require('plugin')};" } },
    second: { dependencies: { plugin: "plugin-second", peer: "peer-second" }, files: { "index.cjs": "module.exports={peer:require('peer'),plugin:require('plugin')};" } },
    "plugin-first": { name: "plugin", dependencies: { peer: "peer-first" }, metadata: { dependencies: {}, peerDependencies: { peer: "*" } }, files: { "index.cjs": "module.exports=require('peer');" } },
    "plugin-second": { name: "plugin", dependencies: { peer: "peer-second" }, metadata: { dependencies: {}, peerDependencies: { peer: "*" } }, files: { "index.cjs": "module.exports=require('peer');" } },
    "peer-first": { name: "peer", version: "1.0.0" },
    "peer-second": { name: "peer", version: "2.0.0" },
  });
  const { context, require } = await stage(f);
  const first = require("first"), second = require("second");
  assert.equal(first.peer, first.plugin);
  assert.equal(second.peer, second.plugin);
  assert.notEqual(first.peer, second.peer);
  assert.equal(first.peer.version, "1.0.0");
  assert.equal(second.peer.version, "2.0.0");
  const plugins = context.instances.filter((instance) => instance.name === "plugin");
  assert.equal(plugins.length, 2);
  assert.equal(plugins[0].version, plugins[1].version);
  assert.notEqual(plugins[0].sourceId, plugins[1].sourceId);
  assert.deepEqual(context.summary.repeatedSources, []);
  await physicalFiles(f.output);
});

test("ESM, CJS, dynamic imports, package self-reference, exported subpaths and disk SDK-style resources use Node's standard resolution", async (t) => {
  const f = await fixture(t, { hybrid: "hybrid", caller: "caller" }, {
    hybrid: { metadata: { type: "module", exports: { ".": { import: "./index.mjs", require: "./index.cjs" }, "./self": { import: "./self.mjs", require: "./self.cjs" }, "./resource": "./resources/manifest.json" } }, files: {
      "index.mjs": "import {value} from 'hybrid/self'; import {readFileSync} from 'node:fs'; export const self=value; export const resource=readFileSync(new URL('./resources/manifest.json',import.meta.url),'utf8');",
      "index.cjs": "module.exports={self:require('hybrid/self').value,resource:require('node:fs').readFileSync(require.resolve('hybrid/resource'),'utf8')};",
      "self.mjs": "export const value='esm-self';", "self.cjs": "exports.value='cjs-self';",
      "resources/manifest.json": "{\"communication\":true}", "resources/manifest.zst.json": "complete compressed-manifest resource",
      "bin/tool": "retained native-tool resource bytes",
    } },
    caller: { dependencies: { hybrid: "hybrid" }, metadata: { type: "module", exports: "./index.mjs" }, files: {
      "index.mjs": "export async function load(){return import('hybrid');}",
    } },
  });
  const resourceAlias = join(f.directories.get("hybrid"), "resources", "manifest-alias.json");
  if (process.platform !== "win32") await symlink("manifest.json", resourceAlias);
  const { context, require } = await stage(f);
  const cjs = require("hybrid");
  assert.equal(cjs.self, "cjs-self");
  assert.equal(cjs.resource, '{"communication":true}');
  const hybrid = context.instances.find((instance) => instance.name === "hybrid");
  const esm = await import(pathToFileURL(join(f.output, hybrid.path, "index.mjs")).href);
  assert.equal(esm.self, "esm-self");
  assert.equal(esm.resource, cjs.resource);
  const caller = context.instances.find((instance) => instance.name === "caller");
  const dynamic = await import(pathToFileURL(join(f.output, caller.path, "index.mjs")).href);
  assert.equal(await dynamic.load(), esm);
  assert.equal(await readFile(join(f.output, hybrid.path, "resources/manifest.zst.json"), "utf8"), "complete compressed-manifest resource");
  if (process.platform !== "win32") assert.equal(await readFile(join(f.output, hybrid.path, "resources/manifest-alias.json"), "utf8"), cjs.resource);
  await physicalFiles(f.output);
});

test("Agent relocation retains one physical Effect singleton and actual CJS/ESM runtime identity", async (t) => {
  const f = await fixture(t, { first: "first", second: "second", effect: "effect" }, {
    first: { dependencies: { effect: "effect" }, files: { "index.cjs": "module.exports=require('effect');" } },
    second: { dependencies: { effect: "effect" }, metadata: { dependencies: {}, peerDependencies: { effect: "^4.0.5" } }, files: { "index.cjs": "module.exports=require('effect');" } },
    effect: { version: "4.0.5", metadata: { exports: { ".": "./index.cjs", "./esm": "./esm.mjs" } }, files: {
      "index.cjs": "module.exports={singleton:Symbol('Effect runtime')};",
      "esm.mjs": "import runtime from 'effect'; export default runtime;",
    } },
  });
  const { context, require } = await stage(f, { id: "agent", root: "apps/server/agent", effectSingleton: true });
  assert.equal(context.instances.filter((instance) => instance.name === "effect").length, 1);
  assert.equal(require("first"), require("second"));
  assert.equal(require("first"), require("effect"));
  const effect = context.instances.find((instance) => instance.id === context.effectSingleton);
  assert.equal((await import(pathToFileURL(join(f.output, effect.path, "esm.mjs")).href)).default, require("effect"));
  await assert.rejects(lstat(join(f.output, "node_modules")), { code: "ENOENT" });
  await physicalFiles(f.output);
});

test("PM and Agent physical closures stay isolated instead of cross-hoisting equal package names", async (t) => {
  const pm = await fixture(t, { shared: "shared" }, { shared: { version: "1.0.0" } });
  const agent = await fixture(t, { shared: "shared" }, { shared: { version: "2.0.0" } });
  const pmGraph = await readDependencyGraph(pm.source), agentGraph = await readDependencyGraph(agent.source);
  const pmContext = planDependencyLayout(pmGraph, { id: "pm" });
  const agentContext = planDependencyLayout(agentGraph, { id: "agent", root: "apps/server/agent" });
  await materializeDependencyLayout(pmGraph, pmContext, pm.output, pm.scratch);
  await materializeDependencyLayout(agentGraph, agentContext, pm.output, pm.scratch);
  const manifest = await writeDependencyLayout(pm.output, [pmContext, agentContext]);
  assert.equal(manifest.contexts.length, 2);
  const pmRequire = createRequire(join(pm.output, "entry.cjs"));
  const agentRequire = createRequire(join(pm.output, "apps/server/agent/dist/index.mjs"));
  assert.equal(pmRequire("shared").version, "1.0.0");
  assert.equal(agentRequire("shared").version, "2.0.0");
  assert.notEqual(pmRequire("shared"), agentRequire("shared"));
  await physicalFiles(pm.output);
});

test("Agent refuses two physical Effect identities even when versions are identical", async (t) => {
  const f = await fixture(t, { first: "first", second: "second" }, {
    first: { dependencies: { effect: "effect-first" } }, second: { dependencies: { effect: "effect-second" } },
    "effect-first": { name: "effect", version: "4.0.5" }, "effect-second": { name: "effect", version: "4.0.5" },
  });
  const graph = await readDependencyGraph(f.source);
  assert.throws(() => planDependencyLayout(graph, { id: "agent", effectSingleton: true }), /exactly one physical Effect/);
  assert.throws(() => planDependencyLayout(graph, { id: "../outside" }), /Unsafe dependency context root/);
  assert.throws(() => planDependencyLayout(graph, { id: "pm", root: "../outside" }), /Unsafe dependency context root/);
});

for (const shell of ["posix", "cmd", "powershell"]) {
  test(`deployed jp/yaml ${shell} command shims preserve arguments, exit status and paths with spaces`, { skip: shell === "posix" ? process.platform === "win32" : process.platform !== "win32" }, async (t) => {
    const files = { "commands/cli with spaces.cjs": "#!/usr/bin/env node\nif(process.argv[2]==='--exit')process.exit(19);\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n" };
    const f = await fixture(t, { yaml: "yaml", "@jmespath-community/jmespath": "jp" }, {
      yaml: { metadata: { bin: "./commands/cli with spaces.cjs" }, files },
      jp: { name: "@jmespath-community/jmespath", metadata: { bin: { jp: "./commands/cli with spaces.cjs" } }, files },
    });
    const original = join(f.source, "node_modules/.bin");
    await mkdir(original);
    for (const command of ["jp", "yaml"])
      for (const name of [command, `${command}.CMD`, `${command}.ps1`]) await writeFile(join(original, name), "source package-manager shim");
    const { context } = await stage(f);
    assert.equal(context.binFiles.length, 6);
    const env = { PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
    const args = ["argument with spaces", "literal$quote"];
    async function invoke(commandName, args, childEnv = env) {
      const shim = join(f.output, "node_modules/.bin", shell === "posix" ? commandName : shell === "cmd" ? `${commandName}.CMD` : `${commandName}.ps1`);
      if (shell === "posix") return execute(shim, args, { env: childEnv });
      if (shell === "cmd") {
        const command = `""${shim}" ${args.map((arg) => `"${arg}"`).join(" ")}"`;
        return execute(join(process.env.SystemRoot, "System32/cmd.exe"), ["/d", "/s", "/c", command], { env: childEnv, windowsVerbatimArguments: true });
      }
      return execute(join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", shim, ...args], { env: childEnv });
    }
    for (const command of ["jp", "yaml"]) {
      const result = await invoke(command, args);
      assert.equal(result.stderr, "", result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), args);
      await assert.rejects(invoke(command, ["--exit"]), (error) => error.code === 19);
    }
    if (shell === "powershell") {
      const emptyPath = join(f.source, "empty-path");
      await mkdir(emptyPath);
      for (const command of ["jp", "yaml"])
        await assert.rejects(invoke(command, args, { ...env, PATH: emptyPath }),
          (error) => Number.isInteger(error.code) && error.code !== 0 && error.stdout === "");
    }
    for (const file of context.binFiles) {
      const contents = await readFile(join(f.output, file.path), "utf8");
      assert.equal(contents.includes("NODE_PATH"), false);
      assert.equal(contents.includes(".pnpm"), false);
    }
    await physicalFiles(f.output);
  });
}

test("optional absence is explicit and hoisting cannot silently activate an absent peer", async (t) => {
  const f = await fixture(t, { consumer: "consumer" }, {
    consumer: { metadata: { optionalDependencies: { unavailable: "*" }, peerDependencies: { absentPeer: "*" }, peerDependenciesMeta: { absentPeer: { optional: true } } } },
  });
  const { context } = await stage(f);
  assert.deepEqual(context.instances[0].absentDependencies, ["absentPeer", "unavailable"]);
  const conflict = await fixture(t, { consumer: "consumer", provider: "provider" }, {
    consumer: { metadata: { peerDependencies: { shared: "*" }, peerDependenciesMeta: { shared: { optional: true } } } },
    provider: { dependencies: { shared: "shared" } }, shared: {},
  });
  const graph = await readDependencyGraph(conflict.source);
  assert.throws(() => planDependencyLayout(graph, { id: "pm" }), /activated an absent optional dependency/);
});

test("missing required dependencies and resources escaping a canonical package fail closed", async (t) => {
  const missing = await fixture(t, { consumer: "consumer" }, { consumer: { metadata: { dependencies: { missing: "*" } } } });
  await assert.rejects(readDependencyGraph(missing.source), /Missing production dependency: missing/);
  const f = await fixture(t, { consumer: "consumer" }, { consumer: {} });
  await symlink(relative(f.directories.get("consumer"), f.source), join(f.directories.get("consumer"), "outside"), process.platform === "win32" ? "junction" : "dir");
  const graph = await readDependencyGraph(f.source), context = planDependencyLayout(graph, { id: "pm" });
  await assert.rejects(materializeDependencyLayout(graph, context, f.output, f.scratch), /resource escapes canonical package/);
});

test("deployed command targets cannot escape their canonical package", async (t) => {
  const f = await fixture(t, { yaml: "yaml" }, { yaml: { metadata: { bin: "../outside.cjs" } } });
  await mkdir(join(f.source, "node_modules/.bin"));
  await writeFile(join(f.source, "node_modules/.bin/yaml"), "source package-manager shim");
  const graph = await readDependencyGraph(f.source), context = planDependencyLayout(graph, { id: "pm" });
  await assert.rejects(materializeDependencyLayout(graph, context, f.output, f.scratch), /Nonportable deployed command target/);
});

test("materialization canonicalizes an aliased destination without admitting outside dependencies or self-references", async (t) => {
  const f = await fixture(t, { consumer: "consumer" }, {
    consumer: { dependencies: { shared: "shared" }, files: { "index.cjs": "module.exports=require('shared');" } },
    shared: {},
  });
  const physicalRoot = await realpath(f.output);
  const alias = join(dirname(f.output), "ancestor alias");
  await symlink(await realpath(dirname(f.output)), alias, process.platform === "win32" ? "junction" : "dir");
  const aliasedRoot = join(alias, "output");
  assert.notEqual(aliasedRoot, physicalRoot);
  assert.equal(await realpath(aliasedRoot), physicalRoot);
  const graph = await readDependencyGraph(f.source), context = planDependencyLayout(graph, { id: "pm" });
  await materializeDependencyLayout(graph, context, aliasedRoot, f.scratch);
  const require = createRequire(join(aliasedRoot, "entry.cjs"));
  assert.equal(require("consumer"), require("shared"));
  assert.equal(await locateDependency(aliasedRoot, "consumer", physicalRoot), await realpath(join(f.output, context.dependencies.consumer)));
  await physicalFiles(f.output);

  const outside = join(dirname(f.output), "outside-package");
  await mkdir(outside);
  const metadata = JSON.stringify({ name: "outside", version: "1.0.0", exports: "./index.cjs" });
  await writeFile(join(outside, "package.json"), metadata);
  await writeFile(join(outside, "index.cjs"), "module.exports={outside:true};");
  await symlink(await realpath(outside), join(f.output, "node_modules/outside"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(locateDependency(aliasedRoot, "outside", physicalRoot), /Dependency escapes its production closure/);
  await assert.rejects(locateDependency(outside, "outside", physicalRoot), /Package self-reference escapes its production closure/);
  assert.equal(await readFile(join(outside, "package.json"), "utf8"), metadata);
  assert.equal(await readFile(join(outside, "index.cjs"), "utf8"), "module.exports={outside:true};");
});
