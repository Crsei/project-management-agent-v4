import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { validateInstallStamp } from "../src/install-stamp.mjs";
import { NODE_VERSION, POSTGRES_VERSION } from "./runtime-manifest.mjs";

// This describes the delivery, never the mutable user's instance. The runtime
// reader freezes it and never infers ownership from a directory/product name.
export function createInstallStamp(input) {
  return validateInstallStamp({
    formatVersion: 1,
    appId: "com.projectmanagementagent.v4",
    payload: "bundled",
    updateMechanism: "github-releases",
    ownership: { installation: input.platform === "darwin" || input.distribution === "dmg" ? "os-managed" : "self", scope: "per-user" },
    runtime: { node: NODE_VERSION, postgres: POSTGRES_VERSION },
    compatibility: input.compatibility,
    ...input,
  }, { platform: input.platform, arch: input.arch, version: input.version });
}

export async function writeInstallStamp(path, input) {
  const stamp = createInstallStamp(input);
  await writeFile(path, `${JSON.stringify(stamp, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  return stamp;
}

// Conservative rollback contract: matching PostgreSQL major is insufficient.
// Bind all shipped SQL migrations and the complete Agent code that can mutate
// SQLite/provider state. Changed state code requires an explicit future schema
// compatibility design; installers never guess that old code can reopen it.
export async function computeMigrationsSha256(workspaceRuntime) {
  const files = [];
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory() && (!info.isFile() || info.nlink !== 1)) throw new Error("Data compatibility inputs must be real unshared files.");
      if (info.isDirectory()) await visit(path);
      else files.push({ path: relative(workspaceRuntime, path).split(sep).join("/"), bytes: await readFile(path) });
    }
  }
  await visit(join(workspaceRuntime, "packages", "infrastructure", "migrations"));
  await visit(join(workspaceRuntime, "apps", "server", "agent", "dist"));
  if (!files.some(entry => entry.path.startsWith("packages/infrastructure/migrations/") && entry.path.endsWith(".sql")) || !files.some(entry => entry.path.startsWith("apps/server/agent/dist/"))) throw new Error("Data compatibility fingerprint requires nonempty PM migrations and shipped Agent state code.");
  const hash = createHash("sha256");
  for (const file of files.sort((a, b) => a.path.localeCompare(b.path, "en"))) hash.update(`${file.path}\0${file.bytes.length}\0`).update(file.bytes);
  return hash.digest("hex");
}
