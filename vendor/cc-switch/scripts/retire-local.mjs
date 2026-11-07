import { lstat } from "node:fs/promises";
import { file, relative, safePath, sha256 } from "./provenance.mjs";

/** Retire only already-deleted host code, bound to its reviewed preimage. */
export async function reviewedLocalRetirements(root, inventory, approvals, protectedPaths = new Set()) {
  const retired = new Set();
  for (const [value, digest] of approvals) {
    const name = relative(value);
    const entry = inventory?.files.find(item => item.destination === name);
    if (!/^[a-f0-9]{64}$/.test(digest) || !entry || entry.sha256 !== digest) throw new Error(`Retirement requires the exact previous output hash: ${name}`);
    if (!/^(apps|packages)\//.test(name) || entry.source || entry.provenance !== "host-owned-integration" || !entry.asset || protectedPaths.has(name)) throw new Error(`Only host-owned local code can be retired: ${name}`);
    const patch = inventory.patches.find(item => item.path === entry.asset.path);
    const asset = await file(root, entry.asset.path);
    if (!patch || patch.sha256 !== entry.asset.sha256 || sha256(asset.bytes) !== entry.asset.sha256) throw new Error(`Retirement recipe changed: ${name}`);
    const recipe = JSON.parse(asset.bytes);
    if (recipe.destination !== name || recipe.sha256 !== digest || recipe.encoding !== "base64" || sha256(Buffer.from(recipe.content, "base64")) !== digest) throw new Error(`Retirement preimage changed: ${name}`);
    const current = await lstat(await safePath(root, name)).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (current) throw new Error(`Retirement requires an already-deleted output: ${name}`);
    retired.add(name);
  }
  return retired;
}
