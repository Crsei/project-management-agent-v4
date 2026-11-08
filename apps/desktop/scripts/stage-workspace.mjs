import { spawn } from "node:child_process";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import { desktopRoot, inside, portable, requireNativeTarget, requirePinnedNode } from "./runtime-manifest.mjs";

import { collectNotices } from "./license-notices.mjs";
import { verifyHost } from "../../server/agent/scripts/cc-switch.mjs";
import { verifyWebDistribution } from "../../../vendor/openhands-extensions/scripts/web-build.mjs";
import { enforceExternalAgentBoundary } from "../../server/agent/scripts/external-agent-packages.mjs";
import { materializeDependencyLayout, planDependencyLayout, readDependencyGraph, writeDependencyLayout } from "./dependency-layout.mjs";
export const repository = resolve(desktopRoot, "../..");
export function run(command, args, cwd = repository) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolveRun() : reject(new Error(`Desktop preparation command failed (${signal || code}): ${basename(command)}`)));
  });
}
const pnpm = (args, cwd) => {
  if (!process.env.npm_execpath) throw new Error("Run desktop staging/packaging through pnpm.");
  return run(process.execPath, [process.env.npm_execpath, ...args], cwd);
};
export async function buildWorkspace() {
  await pnpm(["build:agent"]);
  await pnpm(["build:web"]);
  await run(process.execPath, [join(desktopRoot, "scripts/build.mjs")]);
}
export async function inspectDeployment(directory, boundary = directory) {
  if (directory === boundary) await enforceExternalAgentBoundary(boundary);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (/^\.env(?:\.|$)/i.test(entry.name) || [".npmrc", ".pnpmfile.cjs", ".git", ".local"].includes(entry.name))
      throw new Error(`Private or checkout-only resource must not be distributed: ${portable(relative(boundary, join(directory, entry.name)))}`);
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const link = await readlink(path);
      if (isAbsolute(link) || !inside(boundary, resolve(dirname(path), link)) || !inside(boundary, await realpath(path)))
        throw new Error(`Deployment contains a nonportable symlink: ${portable(relative(boundary, path))}`);
    } else if (entry.isDirectory()) await inspectDeployment(path, boundary);
    else if (!entry.isFile()) throw new Error("Deployment contains an unsupported filesystem resource.");
  }
}
const sourceFilter = async (path) => {
  const name = basename(path);
  if (["node_modules", "tests", "__tests__", "dist", ".git", ".local", ".npmrc"].includes(name) || name.startsWith(".env") || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) return false;
  if ((await lstat(path)).isSymbolicLink()) throw new Error("Backend source contains a symlink; stage explicit portable resources instead.");
  return true;
};
async function createIsolatedWorkspace(directory, desktop = false) {
  await mkdir(directory);
  const manifest = JSON.parse(await readFile(join(desktop ? desktopRoot : repository, "package.json"), "utf8"));
  delete manifest.devDependencies;
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  // The Agent artifact owns its patched SDK/test packages. Each other production
  // closure gets its own workspace: deploy must not reuse another target's hoists.
  const workspace = parse(await readFile(join(repository, "pnpm-workspace.yaml"), "utf8"));
  const lock = parse(await readFile(join(repository, "pnpm-lock.yaml"), "utf8"));
  workspace.packages = [];
  delete workspace.patchedDependencies;
  delete lock.patchedDependencies;
  const importer = lock.importers[desktop ? "apps/desktop" : "."];
  delete importer.devDependencies;
  lock.importers = { ".": importer };
  await writeFile(join(directory, "pnpm-workspace.yaml"), stringify(workspace));
  await writeFile(join(directory, "pnpm-lock.yaml"), stringify(lock));
  if (desktop) await cp(join(desktopRoot, "dist"), join(directory, "dist"), { recursive: true });
}

// Keep the Agent packager's reviewed import/resource closure, but turn each
// independent desktop closure into real node_modules directories. Windows NSIS
// deliberately dereferences dependency links and otherwise recursively expands
// the Agent's canonical .packages graph once per incoming edge.
export async function stageWorkspace(output, application, {
  agentBuild = join(repository, "apps/server/agent/dist"),
  webDist = join(repository, "apps/web/dist"),
} = {}) {
  requirePinnedNode();
  const target = requireNativeTarget();
  await verifyHost(agentBuild);
  await verifyWebDistribution(webDist, repository);
  const previous = await lstat(output).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (previous) throw new Error("Workspace runtime output must be a new directory.");
  const staging = await realpath(await mkdtemp(join(tmpdir(), "pm-desktop-staging-")));
  try {
    const workspace = join(staging, "workspace");
    const agentArtifact = join(staging, "agent-artifact");
    await createIsolatedWorkspace(workspace);
    const rootManifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
    await pnpm(["--filter", rootManifest.name, "--config.hoist-workspace-packages=false", "--config.frozen-lockfile=true", "deploy", "--prod", "--legacy", output], workspace);
    // pnpm deploy has an independent closure; it must not bypass Agent packaging.
    await enforceExternalAgentBoundary(output, { prune: true });
    for (const name of await readdir(output))
      if (!["node_modules", "package.json"].includes(name)) await rm(join(output, name), { recursive: true, force: true });
    const dependencyScratch = join(staging, "physical-dependencies");
    await mkdir(dependencyScratch);
    const pmGraph = await readDependencyGraph(output);
    const pmLayout = planDependencyLayout(pmGraph, { id: "pm" });
    await materializeDependencyLayout(pmGraph, pmLayout, output, dependencyScratch);
    await run(process.execPath, [join(repository, "apps/server/agent/scripts/package.mjs"), "--build", agentBuild, "--output", agentArtifact]);
    const originalAgent = JSON.parse(await readFile(join(agentArtifact, "artifact-manifest.json"), "utf8"));
    const agentRoots = originalAgent.links.filter((link) => link.path.startsWith("node_modules/")).map((link) => link.path.slice("node_modules/".length)).sort();
    const agentGraph = await readDependencyGraph(agentArtifact, { roots: agentRoots });
    // Do not silently broaden or narrow the reviewed Agent production graph.
    if (agentGraph.packages.size !== originalAgent.packages.length)
      throw new Error("Desktop Agent closure differs from the reviewed artifact graph.");
    for (const record of originalAgent.packages) {
      const actual = agentGraph.packages.get(record.path);
      const dependencies = actual && Object.fromEntries([...actual.dependencies].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
      if (!actual || actual.metadata.name !== record.name || actual.metadata.version !== record.version
        || JSON.stringify(dependencies) !== JSON.stringify(Object.fromEntries(Object.entries(record.dependencies).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))))
        throw new Error(`Desktop Agent dependency graph changed: ${record.path}`);
    }
    const agentLayout = planDependencyLayout(agentGraph, { id: "agent", root: "apps/server/agent", effectSingleton: true });
    for (const name of await readdir(agentArtifact)) {
      if ([".packages", "node_modules", "package.json", "tools"].includes(name)) continue;
      await cp(join(agentArtifact, name), join(output, name), { recursive: true, verbatimSymlinks: true });
    }
    await materializeDependencyLayout(agentGraph, agentLayout, output, dependencyScratch);
    await writeDependencyLayout(output, [pmLayout, agentLayout]);
    await renameAgentManifest(output, target, agentLayout);
    await verifyHost(join(output, "apps/server/agent/dist"));
    for (const name of ["apps/server/pm/src", "apps/server/worker/src", "packages", "apps/desktop/src", "vendor/openhands-automations"])
      await cp(join(repository, name), join(output, name), { recursive: true, filter: sourceFilter });
    await cp(join(repository, "apps/server/gateway.ts"), join(output, "apps/server/gateway.ts"));
    await mkdir(join(output, "apps/web"), { recursive: true });
    await cp(webDist, join(output, "apps/web/dist"), { recursive: true });
    for (const name of [
      "apps/server/pm/src/main.ts", "apps/server/worker/src/main.ts", "apps/server/agent/dist/index.mjs",
      "apps/server/agent/dist/claude-history-worker.mjs", "apps/server/agent/dist/cursor-sdk-worker.mjs",
      "apps/server/agent/dist/desktop-agent-maintenance.mjs", "apps/desktop/src/backend/bootstrap.ts",
      "apps/desktop/src/backend/maintenance.ts", "packages/infrastructure/migrations", "apps/web/dist/index.html",
      "vendor/openhands-automations/interface.json", "vendor/openhands-automations/bundle-index.js",
      "apps/web/dist/openhands-provenance.json", "apps/web/dist/licenses/openhands/LICENSE",
      "apps/web/dist/licenses/openhands/extensions/LICENSE",
      "licenses/provenance/LICENSE", "licenses/provenance/THIRD_PARTY_NOTICES.md",
      "apps/server/agent/dist/cc-switch/host/main.mjs",
      "apps/server/agent/dist/cc-switch/host/manifest.json",
      "apps/server/agent/dist/cc-switch/host/LICENSE",
      "apps/server/agent/dist/cc-switch/host/NOTICE.md",
      "apps/server/agent/dist/cc-switch/host/PROVENANCE.md",
      "apps/server/agent/dist/cc-switch/host/UPSTREAM-SOURCES.md",
    ]) await access(join(output, name));
    const require = createRequire(join(output, "apps/server/agent/dist/index.mjs"));
    require.resolve("@lydell/node-pty");
    for (const name of ["@anthropic-ai/claude-agent-sdk", "@cursor/sdk", "@muse-code/sdk"]) require.resolve(name);
    await collectNotices([repository, desktopRoot, join(repository, "apps/web")], join(output, "licenses/desktop-web"));
    await inspectDeployment(output);
    if (application) {
      const applicationWorkspace = join(staging, "electron-workspace");
      await createIsolatedWorkspace(applicationWorkspace, true);
      await pnpm(["--filter", "@agent-workspace/desktop", "--config.hoist-workspace-packages=false", "--config.frozen-lockfile=true", "deploy", "--prod", "--legacy", application], applicationWorkspace);
      await enforceExternalAgentBoundary(application, { prune: true });
      const manifest = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
      await writeFile(join(application, "package.json"), JSON.stringify({
        name: "pm-agent-v4-desktop", productName: "PM Agent v4", version: manifest.version,
        type: "module", main: "dist/main.mjs", description: manifest.description, private: true,
        dependencies: manifest.dependencies,
      }, null, 2) + "\n");
      const electronGraph = await readDependencyGraph(application);
      const electronLayout = planDependencyLayout(electronGraph, { id: "electron" });
      await materializeDependencyLayout(electronGraph, electronLayout, application, dependencyScratch);
      await writeDependencyLayout(application, [electronLayout]);
      await inspectDeployment(application);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
async function renameAgentManifest(output, target, layout) {
  const original = JSON.parse(await readFile(join(output, "artifact-manifest.json"), "utf8"));
  await writeFile(join(output, "agent-artifact-manifest.json"), JSON.stringify({
    ...original, desktopDependencyRoot: "apps/server/agent/node_modules",
    desktopTarget: target,
    desktopLayoutManifest: "desktop-dependency-layout.json",
    desktopEffectSingleton: layout.effectSingleton,
    desktopInventoryScope: "Original files/links are source Agent artifact provenance only; desktopLayoutManifest inventories the emitted dependency paths and bytes.",
    desktopPackagePaths: Object.fromEntries(original.packages.map((record) => [record.path,
      layout.instances.filter((instance) => instance.sourceId === record.path).map((instance) => instance.path)])),
    // Original files/links describe the source Agent artifact, not final desktop
    // paths or bytes. The desktop layout manifest owns the emitted inventory.
  }, null, 2) + "\n");
  await rm(join(output, "artifact-manifest.json"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!["--output", "--application", "--agent-build", "--web-dist"].includes(key) || !value || !isAbsolute(value) || options.has(key))
      throw new Error("Usage through pnpm: stage-workspace.mjs --output NEW_ABSOLUTE_DIRECTORY [--application NEW_ABSOLUTE_DIRECTORY] [--agent-build ABSOLUTE_DIRECTORY --web-dist ABSOLUTE_DIRECTORY] (Linux staging is smoke-only)");
    options.set(key, resolve(value));
  }
  if (!options.has("--output") || options.has("--agent-build") !== options.has("--web-dist"))
    throw new Error("Specify an output directory and either both prepared build directories or neither.");
  const supplied = options.has("--agent-build")
    ? { agentBuild: options.get("--agent-build"), webDist: options.get("--web-dist") }
    : undefined;
  if (!supplied) await buildWorkspace();
  await stageWorkspace(options.get("--output"), options.get("--application"), supplied);
  console.log(JSON.stringify({ serverRoot: options.get("--output"), application: options.get("--application") ?? null, target: requireNativeTarget(), productInstaller: false }));
}
