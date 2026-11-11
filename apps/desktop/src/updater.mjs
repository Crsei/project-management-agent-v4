import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { validateInstallStamp } from "./install-stamp.mjs";
import { safeDesktopMessage } from "./policy.mjs";
import { DESKTOP_UPDATE_REPOSITORY, desktopUpdatePolicy, updateInstallStampAssetName } from "./update-policy.mjs";

const versionPattern = /^\d+\.\d+\.\d+(?:-preview\.\d+)?$/;
const digestPattern = /^[a-f0-9]{64}$/;
const assetPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const repositoryPath = `${DESKTOP_UPDATE_REPOSITORY.owner}/${DESKTOP_UPDATE_REPOSITORY.repo}`;
const errorMessage = cause => safeDesktopMessage(cause).replace(/https?:\/\/[^\s"'<>]+/gi, value => {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return "[update URL]"; }
});

async function publicBytes(fetch_, url, maximum) {
  const response = await fetch_(url, {
    credentials: "omit", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub update metadata returned HTTP ${response.status}. No installation was started.`);
  if (Number(response.headers.get("content-length")) > maximum) throw new Error("GitHub update metadata exceeds its size limit.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("GitHub update metadata has no body.");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error("GitHub update metadata exceeds its size limit.");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks, size);
}

function json(bytes) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("GitHub update metadata is not valid JSON."); }
}

function assertCompatible(current, target) {
  if (!isDeepStrictEqual(current.compatibility, target.compatibility))
    throw new Error("This update changes the data schema, PostgreSQL major version or migration fingerprint. Automatic installation is blocked; keep the current app and use a separately verified migration procedure.");
  if (current.signing === "signed" && target.signing !== "signed") throw new Error("A signed installation cannot update to an unsigned test package.");
}

export function desktopUpdateTargetArch({ platform, arch, runningUnderARM64Translation = false }) {
  return platform === "darwin" && arch === "x64" && runningUnderARM64Translation === true ? "arm64" : arch;
}

// Public release metadata is tied to the immutable version tag, the exact source
// commit, the complete install stamp bytes, and the delivered installer digest.
export async function readCandidateRelease({ current, info, targetArch = current.arch, fetch: fetch_ = fetch }) {
  if (!versionPattern.test(info?.version) || info.tag !== `v${info.version}`) throw new Error("The GitHub release tag does not match its update version.");
  const target = `${current.platform}-${targetArch}`;
  const stampName = updateInstallStampAssetName({ platform: current.platform, arch: targetArch });
  const manifestName = `${target}-${current.signing}-desktop-package.json`;
  const download = `https://github.com/${repositoryPath}/releases/download/${info.tag}/`;
  const [stampBytes, manifestBytes, referenceBytes] = await Promise.all([
    publicBytes(fetch_, `${download}${stampName}`, 16_384),
    publicBytes(fetch_, `${download}${manifestName}`, 2_097_152),
    publicBytes(fetch_, `https://api.github.com/repos/${repositoryPath}/git/ref/tags/${info.tag}`, 16_384),
  ]);
  const stamp = validateInstallStamp(json(stampBytes), { platform: current.platform, arch: targetArch, version: info.version });
  const policy = desktopUpdatePolicy(stamp);
  if (!policy.enabled || stamp.updateMechanism !== "github-releases" || stamp.distribution !== (current.platform === "win32" ? "nsis" : "dmg"))
    throw new Error("The candidate package does not support this installation's GitHub update mechanism.");
  if (stamp.signing !== current.signing) throw new Error("The candidate signing mode does not match this installation.");
  assertCompatible(current, stamp);
  let reference = json(referenceBytes).object;
  for (let depth = 0; reference?.type === "tag" && depth < 4; depth++) {
    if (!/^[a-f0-9]{40}$/.test(reference.sha)) throw new Error("Invalid GitHub release tag identity.");
    reference = json(await publicBytes(fetch_, `https://api.github.com/repos/${repositoryPath}/git/tags/${reference.sha}`, 16_384)).object;
  }
  if (reference?.type !== "commit" || reference.sha !== stamp.commit) throw new Error("The candidate install stamp is not bound to the release tag's source commit.");
  const manifest = json(manifestBytes);
  if (manifest?.schemaVersion !== 3 || manifest.version !== stamp.version || manifest.target !== target || manifest.signing !== stamp.signing
    || manifest.source?.commit !== stamp.commit || manifest.source?.sha256 !== stamp.source.sha256 || manifest.source?.dirty !== false || stamp.source.dirty
    || !isDeepStrictEqual(manifest.installStamp, stamp)) throw new Error("The candidate delivery manifest and source-bound install stamp do not match.");
  const material = manifest.materials?.filter(value => value.path === stampName);
  if (material?.length !== 1 || material[0].bytes !== stampBytes.length || material[0].sha256 !== createHash("sha256").update(stampBytes).digest("hex"))
    throw new Error("The candidate install stamp bytes do not match the delivery manifest.");
  if (!Array.isArray(info.files) || !info.files.length || info.packages || (info.path !== undefined && !assetPattern.test(info.path)))
    throw new Error("The candidate update feed has unsupported installer paths.");
  for (const file of info.files) {
    if (!assetPattern.test(file.url) || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512) || !Number.isSafeInteger(file.size) || file.size <= 0)
      throw new Error("The candidate update feed must name complete, hash-verified GitHub release assets.");
  }
  const extension = current.platform === "win32" ? ".exe" : ".zip";
  const artifacts = manifest.artifacts?.filter(value => typeof value.path === "string" && value.path.endsWith(extension));
  if (artifacts?.length !== 1) throw new Error("The candidate delivery manifest must identify exactly one matching installer.");
  const artifact = artifacts[0];
  const feedFiles = info.files.filter(value => value.url === artifact.path && value.size === artifact.bytes);
  if (!assetPattern.test(artifact.path) || !digestPattern.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || feedFiles.length !== 1)
    throw new Error("The update feed does not identify the delivery manifest's exact installer asset.");
  return Object.freeze({ stamp, artifact: Object.freeze({ ...artifact }), sha512: feedFiles[0].sha512 });
}

export async function verifyDownloadedInstaller(path, candidate) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== candidate.artifact.bytes)
    throw new Error("The downloaded update is not the expected complete installer.");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw new Error("The downloaded installer changed while opening.");
    const sha256 = createHash("sha256"), sha512 = createHash("sha512");
    for await (const bytes of file.createReadStream({ autoClose: false })) { sha256.update(bytes); sha512.update(bytes); }
    const after = await file.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
      || sha256.digest("hex") !== candidate.artifact.sha256 || sha512.digest("base64") !== candidate.sha512)
      throw new Error("The downloaded installer does not match the verified release's SHA256/SHA512 identity. Installation is blocked.");
  } finally { await file.close(); }
}

export class DesktopUpdater {
  constructor({ version, stamp, packaged, updater, createCancellationToken, fetch: fetch_, canOperate = () => true,
    confirmInstall, stop, install, onState = () => {}, unavailableReason = "", targetArch = stamp?.arch }) {
    this.updater = updater;
    this.stamp = stamp;
    this.targetArch = targetArch;
    this.createCancellationToken = createCancellationToken;
    this.fetch = fetch_;
    this.canOperate = canOperate;
    this.confirmInstall = confirmInstall;
    this.stop = stop;
    this.install = install;
    this.onState = onState;
    this.operation = "";
    this.candidate = null;
    this.downloadedPath = null;
    try { this.policy = desktopUpdatePolicy({ version, platform: stamp?.platform ?? process.platform, signing: stamp?.signing }); }
    catch (cause) { this.policy = { enabled: false, channel: "", reason: errorMessage(cause) }; }
    const supportedInstall = stamp?.platform === "win32" && stamp.distribution === "nsis" || stamp?.platform === "darwin" && stamp.distribution === "dmg";
    const enabled = packaged && supportedInstall && stamp.updateMechanism === "github-releases" && this.policy.enabled && Boolean(updater);
    this.state = { enabled, channel: this.policy.channel, currentVersion: version, targetVersion: "", status: enabled ? "idle" : "unavailable",
      message: enabled ? "Updates are checked from the fixed public GitHub release repository. Downloads and installation require your action." : !packaged ? "Updates are available only in an installed desktop package." : unavailableReason || (!supportedInstall ? "This distribution is managed outside the desktop updater. Use its operating system or package manager update procedure." : this.policy.reason || "The installed updater is unavailable."),
      error: "", progress: null, testPackage: stamp?.platform === "win32" && stamp.signing === "unsigned" && this.policy.allowPrerelease === true, busy: false };
    if (!enabled) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = this.policy.allowPrerelease;
    updater.channel = this.policy.channel;
    // Setting a channel can enable downgrades inside electron-updater.
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.logger = null;
    updater.setFeedURL({ provider: "github", ...DESKTOP_UPDATE_REPOSITORY, channel: this.policy.channel, private: false });
    updater.on("error", cause => {
      this.lastUpdaterError = cause;
      this.publish({ status: "error", error: errorMessage(cause), message: "The update did not complete. Review the error before retrying; installation is never retried automatically." });
    });
    updater.on("download-progress", value => {
      if (this.operation !== "download") return;
      const finite = value => Number.isFinite(value) && value >= 0 ? value : 0;
      this.publish({ progress: { percent: Math.min(100, finite(value.percent)), transferred: finite(value.transferred), total: finite(value.total), bytesPerSecond: finite(value.bytesPerSecond) } });
    });
  }

  get busy() { return Boolean(this.operation); }
  snapshot() {
    return { ...this.state, progress: this.state.progress ? { ...this.state.progress } : null,
      canCheck: this.state.enabled && !this.busy && this.state.status !== "downloaded",
      canDownload: this.state.enabled && !this.busy && this.state.status === "available",
      canInstall: this.state.enabled && !this.busy && this.state.status === "downloaded",
      canCancel: this.operation === "download" && Boolean(this.cancellationToken) };
  }
  publish(patch = {}) { Object.assign(this.state, patch, { busy: this.busy }); this.onState(this.snapshot()); }
  reserve(operation) {
    if (!this.state.enabled) throw new Error(this.state.message);
    if (this.busy || !this.canOperate()) throw new Error("Wait for the current connection, backup, lifecycle or update operation to finish safely.");
    this.operation = operation;
    this.lastUpdaterError = null;
  }
  cancel() {
    if (this.operation !== "download" || !this.cancellationToken) throw new Error("No update download can be cancelled.");
    this.cancelRequested = true;
    this.cancellationToken.cancel();
    this.publish({ message: "Cancelling the update download; installation will not start." });
    return this.snapshot();
  }
  async run(operation, task) {
    this.reserve(operation);
    try { await task(); }
    catch (cause) {
      if (this.cancelRequested && operation === "download") this.publish({ status: "available", error: "", progress: null, message: "Update download cancelled. No installation was started." });
      else this.publish({ status: "error", error: errorMessage(cause), message: "The update did not complete. Review the error before retrying; installation is never retried automatically." });
    } finally {
      this.operation = "";
      this.cancellationToken = null;
      this.cancelRequested = false;
      this.publish();
    }
    return this.snapshot();
  }
  check() {
    return this.run("check", async () => {
      this.candidate = null;
      this.downloadedPath = null;
      this.publish({ status: "checking", targetVersion: "", progress: null, error: "", message: "Checking GitHub Releases for a matching-channel desktop update…" });
      const result = await this.updater.checkForUpdates();
      if (this.lastUpdaterError) throw this.lastUpdaterError;
      if (!result) throw new Error("The installed updater could not check GitHub Releases.");
      if (!result.isUpdateAvailable) { this.publish({ status: "current", message: "This installation is up to date on its release channel." }); return; }
      const info = result.updateInfo;
      const targetPolicy = desktopUpdatePolicy({ version: info?.version, platform: this.stamp.platform, signing: this.stamp.signing });
      if (!targetPolicy.enabled || targetPolicy.channel !== this.policy.channel || this.updater.currentVersion.compare(info.version) >= 0)
        throw new Error("The candidate is not a newer version on this installation's release channel. Downgrades and channel changes are blocked.");
      this.publish({ targetVersion: info.version });
      this.candidate = await readCandidateRelease({ current: this.stamp, targetArch: this.targetArch, info, fetch: this.fetch });
      this.info = structuredClone(info);
      this.publish({ status: "available", message: "A compatible update is available. Choose Download; local services will keep running." });
    });
  }
  download() {
    if (this.state.status !== "available" || !this.candidate) return Promise.reject(new Error("Check for a compatible update before downloading."));
    return this.run("download", async () => {
      this.cancellationToken = this.createCancellationToken();
      this.publish({ status: "downloading", error: "", progress: null, message: "Downloading and verifying the installer. Installation will not start automatically…" });
      const paths = await this.updater.downloadUpdate(this.cancellationToken);
      if (this.cancelRequested) throw new Error("Download cancelled.");
      if (this.lastUpdaterError) throw this.lastUpdaterError;
      if (!Array.isArray(paths) || paths.length !== 1 || typeof paths[0] !== "string") throw new Error("The updater did not return one verified installer.");
      await verifyDownloadedInstaller(paths[0], this.candidate);
      if (this.cancelRequested) throw new Error("Download cancelled.");
      this.downloadedPath = paths[0];
      this.publish({ status: "downloaded", progress: null, message: "Installer verified. Restart and install requires confirmation, draft approval and a successful graceful shutdown. Back up important data first." });
    });
  }
  restartAndInstall() {
    if (this.state.status !== "downloaded" || !this.candidate || !this.downloadedPath) return Promise.reject(new Error("Download and verify an update before installing."));
    return this.run("install", async () => {
      this.publish({ status: "preparing", error: "", message: "Rechecking the release identity and data compatibility before any services are stopped…" });
      const fresh = await readCandidateRelease({ current: this.stamp, targetArch: this.targetArch, info: this.info, fetch: this.fetch });
      if (!isDeepStrictEqual(fresh, this.candidate)) throw new Error("The release metadata changed after downloading. Check and download again; installation is blocked.");
      await verifyDownloadedInstaller(this.downloadedPath, fresh);
      if (!await this.confirmInstall(this.snapshot())) {
        this.publish({ status: "downloaded", message: "Installation cancelled. The downloaded update remains available; services have not been stopped." });
        return;
      }
      // stop must retain existing beforeunload/draft handling and owned process
      // supervision. Any cancellation, failed flush or failed PG stop rejects.
      this.publish({ status: "stopping", message: "Waiting for draft approval and gracefully stopping owned local services and PostgreSQL…" });
      await this.stop();
      if (this.lastUpdaterError) throw this.lastUpdaterError;
      this.publish({ status: "installing", message: "The verified update installer is starting. The application will restart after installation." });
      await this.install(() => this.updater.quitAndInstall(false, true));
      if (this.lastUpdaterError) throw this.lastUpdaterError;
    });
  }
}
