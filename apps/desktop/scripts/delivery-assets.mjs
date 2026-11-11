import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
import { parseDocument } from "yaml";
import { validateInstallStamp } from "../src/install-stamp.mjs";
import { desktopUpdatePolicy, updateInstallStampAssetName } from "../src/update-policy.mjs";

export const requiredDeliveryMaterials = Object.freeze(["desktop-source.tar.gz", "desktop-source.json", "desktop-legal.tar.gz", "desktop-verification.json", "desktop-sbom.cdx.json", "desktop-osv.json", "desktop-vulnerabilities.sarif"]);
export const nativeReceiptMaterials = Object.freeze(["install-e2e-receipt.json", "install-e2e-evidence.tar.gz"]);
const exact = (value, names) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
const sha512 = (value) => typeof value === "string" && /^[A-Za-z0-9+/]{86}==$/.test(value) && Buffer.from(value, "base64").length === 64 && Buffer.from(value, "base64").toString("base64") === value;

export function configuredArtifactNames({ version, target, signing }) {
  if (!["win32-x64", "darwin-x64", "darwin-arm64"].includes(target)) throw new Error("Unsupported desktop delivery target.");
  const [platform, arch] = target.split("-");
  const policy = desktopUpdatePolicy({ version, platform, signing });
  const prefix = `PM-Agent-v4-${version}-${platform === "win32" ? "win" : "mac"}-${arch}-${signing}`;
  const native = (platform === "win32" ? ["exe"] : ["dmg", "zip"]).map((extension) => `${prefix}.${extension}`);
  const artifactName = `${prefix}.${platform === "win32" ? "exe" : "zip"}`;
  // Per-architecture Mac fragments cannot overwrite each other. The release
  // transaction merges both verified fragments into the canonical *-mac.yml.
  const builderFeedName = `${policy.channel}${platform === "darwin" ? "-mac" : ""}.yml`;
  const feedName = policy.enabled ? `${policy.channel}${platform === "darwin" ? `-mac-${arch}` : ""}.yml` : null;
  const blockmap = `${artifactName}.blockmap`;
  const required = [...native, ...(policy.enabled ? [blockmap, feedName] : [])];
  return { required, allowed: [...new Set([...required, blockmap])], update: { policy, artifactName, feedName, builderFeedName } };
}

export function deliveryMaterialNames({ target, nativeReceipt }) {
  const [platform, arch] = target.split("-");
  return [...requiredDeliveryMaterials, updateInstallStampAssetName({ platform, arch }), ...(nativeReceipt ? nativeReceiptMaterials : [])].sort();
}

export function validateDeliveryAssets(manifest) {
  const { required, allowed } = configuredArtifactNames(manifest);
  const artifacts = manifest.artifacts.map((file) => file.path);
  if (required.some((name) => !artifacts.includes(name)) || artifacts.some((name) => !allowed.includes(name)) || new Set(artifacts).size !== artifacts.length)
    throw new Error("Delivery does not contain the exact configured native installer targets/updater auxiliary allowlist.");
  const expected = deliveryMaterialNames(manifest);
  if (JSON.stringify(manifest.materials.map((file) => file.path).sort()) !== JSON.stringify(expected))
    throw new Error("Delivery is missing required materials or contains an extra material outside the exact allowlist.");
  return [...artifacts, ...expected, "desktop-package.json", "SHA256SUMS"].sort();
}

export function parseUpdateMetadata(bytes) {
  if (bytes.length > 64 * 1024) throw new Error("Desktop updater metadata is too large.");
  const document = parseDocument(bytes.toString("utf8"), { uniqueKeys: true, maxAliasCount: 0 });
  if (document.errors.length || document.warnings.length) throw new Error("Malformed desktop updater metadata.");
  let value;
  try { value = document.toJS({ maxAliasCount: 0 }); } catch { throw new Error("Malformed desktop updater metadata aliases."); }
  if (!exact(value, ["version", "files", "path", "sha512", "releaseDate"]) || !Array.isArray(value.files) || !value.files.length
    || typeof value.version !== "string" || typeof value.path !== "string" || !sha512(value.sha512)
    || typeof value.releaseDate !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.releaseDate) || !Number.isFinite(Date.parse(value.releaseDate)))
    throw new Error("Malformed desktop updater metadata identity.");
  for (const file of value.files) if (!exact(file, ["url", "sha512", "size"]) || typeof file.url !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file.url) || !sha512(file.sha512) || !Number.isSafeInteger(file.size) || file.size <= 0)
    throw new Error("Malformed desktop updater file identity/hash/size.");
  if (new Set(value.files.map((file) => file.url)).size !== value.files.length || value.path !== value.files[0].url || value.sha512 !== value.files[0].sha512)
    throw new Error("Desktop updater legacy identity differs from its exact selected file.");
  return value;
}

async function fileSha512(path) {
  const hash = createHash("sha512");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("base64");
}

async function verifyBlockmap(output, name, artifact) {
  const info = await lstat(join(output, name));
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64 * 1024 * 1024) throw new Error("Unsafe desktop updater blockmap.");
  let value;
  try { value = JSON.parse(gunzipSync(await readFile(join(output, name)), { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8")); } catch { throw new Error("Malformed desktop updater blockmap."); }
  if (!exact(value, ["version", "files"]) || value.version !== "2" || !Array.isArray(value.files) || value.files.length !== 1) throw new Error("Unsupported desktop updater blockmap identity.");
  const file = value.files[0];
  if (!exact(file, ["name", "offset", "checksums", "sizes"]) || file.name !== "file" || file.offset !== 0 || !Array.isArray(file.checksums) || !Array.isArray(file.sizes) || !file.sizes.length || file.sizes.length !== file.checksums.length
    || file.sizes.some((size) => !Number.isSafeInteger(size) || size <= 0) || file.checksums.some((digest) => typeof digest !== "string" || !/^[A-Za-z0-9+/]{24}$/.test(digest)) || file.sizes.reduce((sum, size) => sum + size, 0) !== artifact.bytes)
    throw new Error("Desktop updater blockmap does not describe the exact target artifact bytes.");
}

export async function verifyUpdateDelivery(output, manifest) {
  const [platform, arch] = manifest.target.split("-");
  const { update } = configuredArtifactNames(manifest);
  if (!isDeepStrictEqual(manifest.updates, update.policy)) throw new Error("Desktop update policy is not bound to the exact version/target/signing identity.");
  const stampName = updateInstallStampAssetName({ platform, arch });
  const info = await lstat(join(output, stampName));
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16_384) throw new Error("Unsafe candidate desktop install stamp.");
  const stamp = validateInstallStamp(JSON.parse(await readFile(join(output, stampName), "utf8")), { platform, arch, version: manifest.version });
  if (!isDeepStrictEqual(manifest.installStamp, stamp) || stamp.commit !== manifest.source.commit || stamp.source.sha256 !== manifest.source.sha256 || stamp.source.dirty !== manifest.source.dirty || stamp.signing !== manifest.signing || stamp.distribution !== (platform === "win32" ? "nsis" : "dmg"))
    throw new Error("Candidate desktop install stamp differs from the exact release source/target/distribution identity.");
  for (const file of manifest.artifacts.filter((file) => file.path.endsWith(".blockmap"))) {
    const artifact = manifest.artifacts.find((artifact) => `${artifact.path}.blockmap` === file.path);
    if (!artifact) throw new Error("Desktop updater blockmap has no exact release artifact.");
    await verifyBlockmap(output, file.path, artifact);
  }
  if (!update.feedName) return { policy: update.policy, stamp };
  const feed = parseUpdateMetadata(await readFile(join(output, update.feedName)));
  if (feed.version !== manifest.version || feed.files.length !== 1 || feed.files[0].url !== update.artifactName) throw new Error("Desktop updater feed does not match the exact release version/target artifact.");
  const artifact = manifest.artifacts.find((file) => file.path === update.artifactName);
  if (!artifact || feed.files[0].size !== artifact.bytes || feed.files[0].sha512 !== await fileSha512(join(output, artifact.path))) throw new Error("Desktop updater feed SHA512/size differs from the exact final artifact.");
  return { policy: update.policy, stamp, feed };
}

export async function verifyPackagedUpdateConfiguration(resources, stamp) {
  const policy = desktopUpdatePolicy(stamp);
  const path = join(resources, "app-update.yml");
  const info = await lstat(path).catch((cause) => { if (cause.code === "ENOENT") return null; throw cause; });
  if (!policy.enabled) {
    if (info) throw new Error("Unsupported desktop distribution must not advertise an updater configuration.");
    return { status: "not-applicable", policy };
  }
  if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16_384) throw new Error("Missing or unsafe packaged desktop updater configuration.");
  const document = parseDocument(await readFile(path, "utf8"), { uniqueKeys: true });
  let value;
  try {
    if (document.errors.length || document.warnings.length) throw new Error();
    value = document.toJS({ maxAliasCount: 0 });
  } catch { throw new Error("Malformed packaged desktop updater configuration."); }
  const allowed = ["provider", "owner", "repo", "channel", "private", "releaseType", "updaterCacheDirName", ...(stamp.platform === "win32" && stamp.signing === "signed" ? ["publisherName"] : [])];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))
    || value.provider !== policy.provider || value.owner !== policy.owner || value.repo !== policy.repo || value.channel !== policy.channel || value.private !== false
    || value.releaseType !== (policy.allowPrerelease ? "prerelease" : "release") || value.updaterCacheDirName !== "pm-agent-v4-desktop-updater")
    throw new Error("Packaged desktop updater does not use the exact fixed public repository/channel identity.");
  if (stamp.platform === "win32" && stamp.signing === "signed" && !(typeof value.publisherName === "string" && value.publisherName.length || Array.isArray(value.publisherName) && value.publisherName.length && value.publisherName.every((name) => typeof name === "string" && name.length)))
    throw new Error("Signed Windows updater configuration lacks its native publisher identity.");
  return { status: "passed", policy };
}

export async function assertExactDeliveryDirectory(output, names) {
  const entries = await readdir(output, { withFileTypes: true });
  for (const entry of entries) {
    if (/\.ya?ml$/i.test(entry.name) && !names.includes(entry.name)) throw new Error("An unexpected update feed is outside the exact configured updater allowlist.");
    const info = await lstat(join(output, entry.name));
    if (!names.includes(entry.name) || !info.isFile() || info.isSymbolicLink()) throw new Error(`Unrecorded release artifact or non-file entry outside the exact allowlist: ${entry.name}`);
  }
  if (JSON.stringify(entries.map((entry) => entry.name).sort()) !== JSON.stringify([...names].sort())) throw new Error("Exact delivery asset set has missing files.");
}
