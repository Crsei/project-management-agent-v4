import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export const requiredDeliveryMaterials = Object.freeze(["desktop-source.tar.gz", "desktop-source.json", "desktop-legal.tar.gz", "desktop-verification.json", "desktop-sbom.cdx.json", "desktop-osv.json", "desktop-vulnerabilities.sarif"]);
export const nativeReceiptMaterials = Object.freeze(["install-e2e-receipt.json", "install-e2e-evidence.tar.gz"]);
export function configuredArtifactNames({ version, target, signing }) {
  const [platform, arch] = target.split("-");
  const prefix = `PM-Agent-v4-${version}-${platform === "win32" ? "win" : "mac"}-${arch}-${signing}`;
  const required = (platform === "win32" ? ["exe"] : ["dmg", "zip"]).map((extension) => `${prefix}.${extension}`);
  return { required, allowed: [...required, ...required.map((name) => `${name}.blockmap`)] };
}
export function validateDeliveryAssets(manifest) {
  const { required, allowed } = configuredArtifactNames(manifest);
  const artifacts = manifest.artifacts.map((file) => file.path);
  if (required.some((name) => !artifacts.includes(name)) || artifacts.some((name) => !allowed.includes(name)) || new Set(artifacts).size !== artifacts.length)
    throw new Error("Delivery does not contain the exact configured native installer targets/auxiliary allowlist.");
  const expected = [...requiredDeliveryMaterials, ...(manifest.nativeReceipt ? nativeReceiptMaterials : [])].sort();
  if (JSON.stringify(manifest.materials.map((file) => file.path).sort()) !== JSON.stringify(expected))
    throw new Error("Delivery is missing required materials or contains an extra material outside the exact allowlist.");
  return [...artifacts, ...expected, "desktop-package.json", "SHA256SUMS"].sort();
}
export async function assertExactDeliveryDirectory(output, names) {
  const entries = await readdir(output, { withFileTypes: true });
  for (const entry of entries) {
    if (/^(?:latest|nightly).*\.ya?ml$/i.test(entry.name)) throw new Error("An update feed is not configured; updater metadata must not be delivered.");
    const info = await lstat(join(output, entry.name));
    if (!names.includes(entry.name) || !info.isFile() || info.isSymbolicLink()) throw new Error(`Unrecorded release artifact or non-file entry outside the exact allowlist: ${entry.name}`);
  }
  if (JSON.stringify(entries.map((entry) => entry.name).sort()) !== JSON.stringify([...names].sort())) throw new Error("Exact delivery asset set has missing files.");
}
