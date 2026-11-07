import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// These optional packages contain Claude Code itself, not SDK communication resources.
// Match the package family, never a binary basename: unrelated claude(.exe), SDK
// manifests, Cursor native tools, SQLite and PTY bindings must remain untouched.
export const isExternalAgentCliPackage = (name) =>
  typeof name === "string" && name.startsWith("@anthropic-ai/claude-agent-sdk-");

const inside = (root, target) => target === root || target.startsWith(root + path.sep);

/** Enforce the same boundary on custom artifacts and pnpm's separate deploy closure. */
export async function enforceExternalAgentBoundary(directory, { prune = false } = {}) {
  const root = await realpath(directory);
  const excluded = [];
  const links = new Map();
  const visited = new Set();
  const childRole = (role, name) => {
    if (name === "node_modules") return "modules";
    if (name === ".packages") return "packages";
    if (role === "modules" && name.startsWith("@")) return "scope";
    if (role === "scope" || role === "packages" || role === "modules" && !name.startsWith(".")) return "package";
    return "resource";
  };
  async function visit(current, role) {
    const identity = `${role}\0${current}`;
    if (visited.has(identity)) return;
    visited.add(identity);
    const metadataPath = path.join(current, "package.json");
    const metadataInfo = role === "package" ? await lstat(metadataPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }) : null;
    if (metadataInfo?.isSymbolicLink()) throw new Error(`Deployment package metadata must not be a symlink: ${path.relative(root, metadataPath)}`);
    if (metadataInfo?.isFile()) {
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      if (isExternalAgentCliPackage(metadata.name)) {
        if (current === root) throw new Error("Cannot prune a deployment whose root is an external Agent CLI package.");
        excluded.push({ name: metadata.name, path: current });
        return;
      }
    }
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      const roleAtEntry = childRole(role, entry.name);
      if (entry.isDirectory()) await visit(filename, roleAtEntry);
      else if (entry.isSymbolicLink()) {
        const target = await realpath(filename);
        if (!inside(root, target)) throw new Error(`Deployment link escapes the external Agent package boundary: ${path.relative(root, filename)}`);
        links.set(filename, target);
        // Package slots and node_modules roots retain their logical role even
        // when aliases/junctions point into a differently named internal store.
        // Do not classify arbitrary resource folders as installed packages.
        if (roleAtEntry !== "resource" && (await lstat(target)).isDirectory()) await visit(target, roleAtEntry);
      }
    }
  }
  await visit(root, "package");
  if (excluded.length && !prune) {
    throw new Error(`External Agent CLI packages must not be distributed: ${excluded.map((entry) => `${entry.name} (${path.relative(root, entry.path)})`).join(", ")}`);
  }
  if (prune) {
    // Discover aliases before removing physical packages, including pnpm's hidden
    // store and nested dependency links. Do not leave newly dangling symlinks.
    for (const [filename, target] of links) {
      if (excluded.some((entry) => inside(entry.path, target))) await rm(filename);
    }
    for (const entry of excluded) await rm(entry.path, { recursive: true });
  }
  return excluded.map((entry) => ({ name: entry.name, path: path.relative(root, entry.path).split(path.sep).join("/") }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode, directory, ...extra] = process.argv.slice(2);
  if (!["--check", "--prune-deployment"].includes(mode) || !directory || extra.length) {
    throw new Error("Usage: external-agent-packages.mjs <--check|--prune-deployment> DEPLOYMENT_ROOT");
  }
  const excluded = await enforceExternalAgentBoundary(directory, { prune: mode === "--prune-deployment" });
  console.log(JSON.stringify({ externalAgentCliPackagesExcluded: excluded }));
}
