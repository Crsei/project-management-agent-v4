import { spawn } from "node:child_process";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import { desktopRoot, inside, portable, requireNativeTarget, requirePinnedNode } from "./runtime-manifest.mjs";

import { collectNotices } from "./license-notices.mjs";
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

// The reviewed Agent packager remains the sole owner of its emitted-import,
// disk SDK/native dependency and one-Effect closure. Desktop only relocates its
// root dependency links next to the Agent entrypoint so PM can retain its own
// production root dependencies without version collisions.
export async function stageWorkspace(output, application, {
  agentBuild = join(repository, "apps/server/agent/dist"),
  webDist = join(repository, "apps/web/dist"),
} = {}) {
  requirePinnedNode();
  const target = requireNativeTarget();
  const previous = await lstat(output).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (previous) throw new Error("Workspace runtime output must be a new directory.");
  const staging = await realpath(await mkdtemp(join(tmpdir(), "pm-desktop-staging-")));
  try {
    const workspace = join(staging, "workspace");
    const agentArtifact = join(staging, "agent-artifact");
    await createIsolatedWorkspace(workspace);
    const rootManifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
    await pnpm(["--filter", rootManifest.name, "--config.hoist-workspace-packages=false", "--config.frozen-lockfile=true", "deploy", "--prod", "--legacy", output], workspace);
    for (const name of await readdir(output))
      if (!["node_modules", "package.json"].includes(name)) await rm(join(output, name), { recursive: true, force: true });
    await run(process.execPath, [join(repository, "apps/server/agent/scripts/package.mjs"), "--build", agentBuild, "--output", agentArtifact]);
    for (const name of await readdir(agentArtifact)) {
      if (["node_modules", "package.json", "tools"].includes(name)) continue;
      await cp(join(agentArtifact, name), join(output, name), { recursive: true, verbatimSymlinks: true });
    }
    const agentModules = join(output, "apps/server/agent/node_modules");
    const linkRoot = join(agentArtifact, "node_modules");
    async function relocateLinks(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const source = join(directory, entry.name);
        if (entry.isDirectory()) { await relocateLinks(source); continue; }
        if (!entry.isSymbolicLink()) throw new Error("Unexpected Agent artifact root dependency resource.");
        const destination = join(agentModules, relative(linkRoot, source));
        const originalTarget = resolve(dirname(source), await readlink(source));
        if (!inside(agentArtifact, originalTarget)) throw new Error("Agent artifact dependency escapes its production closure.");
        const targetPath = join(output, relative(agentArtifact, originalTarget));
        await mkdir(dirname(destination), { recursive: true });
        await symlink(relative(dirname(destination), targetPath), destination, "dir");
      }
    }
    await relocateLinks(linkRoot);
    await renameAgentManifest(output, target);
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
      const manifest = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
      await writeFile(join(application, "package.json"), JSON.stringify({
        name: "pm-agent-v4-desktop", productName: "PM Agent v4", version: manifest.version,
        type: "module", main: "dist/main.mjs", description: manifest.description, private: true,
        dependencies: manifest.dependencies,
      }, null, 2) + "\n");
      await inspectDeployment(application);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
async function renameAgentManifest(output, target) {
  const original = JSON.parse(await readFile(join(output, "artifact-manifest.json"), "utf8"));
  await writeFile(join(output, "agent-artifact-manifest.json"), JSON.stringify({
    ...original, desktopDependencyRoot: "apps/server/agent/node_modules",
    desktopTarget: target,
    // Agent's original hash inventory is retained as provenance. Root-link paths
    // have intentionally moved; the original Agent verifier is not advertised
    // as a verifier for the composed desktop runtime.
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
