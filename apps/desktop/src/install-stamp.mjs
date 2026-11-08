import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

export const INSTALL_STAMP_FILENAME = "desktop-install-stamp.json";
const appId = "com.projectmanagementagent.v4";
const keys = ["formatVersion", "appId", "commit", "version", "platform", "arch", "distribution", "payload", "updateMechanism", "ownership", "source", "signing", "runtime", "compatibility"];
const exact = (value, names) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));

export function validateInstallStamp(value, { platform = process.platform, arch = process.arch, version } = {}) {
  if (!exact(value, keys) || value.formatVersion !== 1 || value.appId !== appId || typeof value.commit !== "string" || !/^[a-f0-9]{40}$/.test(value.commit) || typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version) || !["win32", "darwin"].includes(value.platform) || !["x64", "arm64"].includes(value.arch) || !["nsis", "dmg", "os-managed"].includes(value.distribution) || value.payload !== "bundled" || value.updateMechanism !== "none" || !["unsigned", "signed"].includes(value.signing)) throw new Error("Invalid or unsupported desktop installation identity. Reinstall using your operating system's installer.");
  if (!exact(value.ownership, ["installation", "scope"]) || !["self", "os-managed"].includes(value.ownership.installation) || value.ownership.scope !== "per-user" || !exact(value.source, ["sha256", "dirty"]) || typeof value.source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.source.sha256) || typeof value.source.dirty !== "boolean" || !exact(value.runtime, ["node", "postgres"]) || value.runtime.node !== "24.21.0" || value.runtime.postgres !== "16.15" || !exact(value.compatibility, ["dataSchema", "postgresMajor", "migrationsSha256"]) || value.compatibility.dataSchema !== 1 || value.compatibility.postgresMajor !== 16 || typeof value.compatibility.migrationsSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.compatibility.migrationsSha256)) throw new Error("Unsupported desktop installation ownership, source, runtime or data compatibility. Use your OS installer or package manager; automatic cleanup is disabled.");
  if (value.distribution === "nsis" && (value.platform !== "win32" || value.arch !== "x64" || value.ownership.installation !== "self") || value.distribution === "dmg" && (value.platform !== "darwin" || value.ownership.installation !== "os-managed") || value.distribution === "os-managed" && value.ownership.installation !== "os-managed") throw new Error("Desktop installation distribution and ownership do not match. Use Windows Settings or Finder/your OS package manager.");
  if (value.platform !== platform || value.arch !== arch || version !== undefined && value.version !== version) throw new Error("Desktop installation identity does not match this running application. Reinstall the complete matching package.");
  // Copy before freezing: no mutable reference from JSON/caller is retained.
  return Object.freeze({ ...value, ownership: Object.freeze({ ...value.ownership }), source: Object.freeze({ ...value.source }), runtime: Object.freeze({ ...value.runtime }), compatibility: Object.freeze({ ...value.compatibility }) });
}

export async function readInstallStamp(resourcesPath, context = {}) {
  const root = resolve(resourcesPath);
  const actual = await realpath(root);
  if ((process.platform === "win32" ? actual.toLowerCase() : actual) !== (process.platform === "win32" ? root.toLowerCase() : root)) throw new Error("Desktop installation resources must not be redirected through a link.");
  const path = join(root, INSTALL_STAMP_FILENAME);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 16_384) throw new Error("Unsafe desktop installation stamp.");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw new Error("Desktop installation stamp changed while opening.");
    const bytes = await file.readFile();
    const after = await file.stat();
    if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("Desktop installation stamp changed while reading.");
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Corrupt desktop installation stamp. Reinstall the complete application."); }
    return validateInstallStamp(value, context);
  } finally { await file.close(); }
}

export function assertSelfOwnedInstall(stamp) {
  if (!stamp || stamp.ownership?.installation !== "self") throw new Error("This installation is managed by the operating system or package manager. Use Windows Settings > Apps or your macOS/package manager removal instructions; desktop self-removal is disabled.");
  return stamp;
}
