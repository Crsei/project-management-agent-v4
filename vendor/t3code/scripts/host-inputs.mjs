import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const required = [
  "apps/server/agent/scripts/build.mjs",
  "apps/server/agent/scripts/package.mjs",
  "apps/server/agent/scripts/verify-artifact.mjs",
  "vendor/t3code/scripts/host-inputs.mjs",
];

/** Validate the authoring toolchain before sync/build/package can publish anything. */
export async function verifyHostBuildInputs(repository, inventory) {
  const entries = inventory.runtimeResources?.hostBuildInputs;
  if (!Array.isArray(entries) || entries.length !== required.length
    || new Set(entries.map(entry => entry?.path)).size !== required.length
    || entries.some(entry => !required.includes(entry?.path) || !/^[a-f0-9]{64}$/.test(entry?.sha256))) {
    throw new Error("Invalid host build tool inventory; reviewed recapture is required.");
  }
  const root = await realpath(repository);
  const verified = [];
  for (const relative of required) {
    const entry = entries.find(candidate => candidate.path === relative);
    const filename = path.join(root, relative);
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || await realpath(filename) !== filename) {
      throw new Error(`Unsafe host build tool: ${relative}`);
    }
    const digest = createHash("sha256").update(await readFile(filename)).digest("hex");
    if (digest !== entry.sha256) throw new Error(`Host build tool hash mismatch: ${relative}`);
    verified.push({ path: relative, sha256: digest });
  }
  return verified;
}
