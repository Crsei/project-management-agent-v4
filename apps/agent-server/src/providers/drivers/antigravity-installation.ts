// Ported from t3code provider/AntigravityInstallation.ts and zipArchive.ts (MIT).
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import * as Yauzl from "yauzl";
import type { ProviderDriverContext } from "../driver-adapter.ts";
import { resolveAntigravityReleaseAsset, type AntigravityReleaseAsset } from "./antigravity-release.ts";

export type AntigravityExecutable = {
  executablePath: string; harnessPath: string; source: "override" | "managed" | "path"; version: string | null;
};
type InstalledRelease = { releaseId: string; version: string; executable: { name: string; bytes: number }; harness: { name: string; bytes: number } };
const installs = new Set<string>();
const releaseRecord = ".install-complete.json";

async function readRecord(path: string): Promise<unknown> {
  const entry = await stat(path);
  if (!entry.isFile() || entry.size > 8_192) throw new Error("The managed Antigravity runtime record is invalid. Reinstall Antigravity.");
  return JSON.parse(await readFile(path, "utf8"));
}
function installationDirectory(context: ProviderDriverContext): string {
  return join(context.homeDirectory, "tools", "antigravity-acp", `${process.platform}-${process.arch}`);
}
async function executableFile(path: string, bytes?: number): Promise<boolean> {
  return stat(path).then((entry) => entry.isFile() && (bytes === undefined || entry.size === bytes) && (process.platform === "win32" || (entry.mode & 0o111) !== 0), () => false);
}
async function completedRelease(directory: string, id: string): Promise<AntigravityExecutable> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("The managed Antigravity release identifier is invalid.");
  const destination = join(directory, "versions", id);
  const data = await readRecord(join(destination, releaseRecord));
  const executableName = process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par";
  const harnessName = process.platform === "win32" ? "localharness_external.exe" : "localharness_external";
  if (!data || typeof data !== "object") throw new Error("The managed Antigravity runtime record is invalid.");
  const record = data as Partial<InstalledRelease>;
  if (record.releaseId !== id || typeof record.version !== "string" || !record.version.trim() || record.executable?.name !== executableName || record.harness?.name !== harnessName || !Number.isSafeInteger(record.executable.bytes) || record.executable.bytes <= 0 || !Number.isSafeInteger(record.harness.bytes) || record.harness.bytes <= 0 || !await executableFile(join(destination, executableName), record.executable.bytes) || !await executableFile(join(destination, harnessName), record.harness.bytes)) throw new Error("The managed Antigravity runtime is incomplete. Reinstall it.");
  return { executablePath: join(destination, executableName), harnessPath: join(destination, harnessName), version: record.version, source: "managed" };
}
export async function resolveAntigravityInstallation(context: ProviderDriverContext, binaryPath: string): Promise<AntigravityExecutable> {
  const names = process.platform === "win32" ? { executable: "agy_acp_server.exe", harness: "localharness_external.exe" } : { executable: "agy_acp_server.par", harness: "localharness_external" };
  const pathValue = process.platform === "win32" ? Object.entries(context.env).findLast(([key]) => key.toUpperCase() === "PATH")?.[1] : context.env.PATH;
  const pathCandidates = (name: string) => (pathValue ?? "").split(process.platform === "win32" ? ";" : ":").map((part) => part.trim().replace(/^"|"$/g, "")).filter(Boolean).map((part) => resolve(context.cwd, part, name));
  const external = async (candidate: string, source: "override" | "path"): Promise<AntigravityExecutable | null> => {
    if (!await executableFile(candidate)) return null;
    const executablePath = await realpath(candidate); const harnessPath = join(dirname(executablePath), names.harness);
    if (!await executableFile(harnessPath)) return null;
    return { executablePath, harnessPath, source, version: null };
  };
  if (binaryPath) {
    for (const candidate of isAbsolute(binaryPath) || binaryPath.includes("/") || binaryPath.includes("\\") ? [resolve(context.cwd, binaryPath)] : pathCandidates(binaryPath)) {
      const selected = await external(candidate, "override"); if (selected) return selected;
    }
    throw new Error("The custom Antigravity executable or its localharness_external sibling is missing or not executable.");
  }
  const directory = installationDirectory(context);
  const active = await readRecord(join(directory, "active.json")).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (active !== null) {
    if (typeof active !== "object" || !("releaseId" in active) || typeof active.releaseId !== "string") throw new Error("The managed Antigravity runtime pointer is invalid. Reinstall Antigravity.");
    return completedRelease(directory, active.releaseId);
  }
  for (const candidate of pathCandidates(names.executable)) { const selected = await external(candidate, "path"); if (selected) return selected; }
  throw new Error(resolveAntigravityReleaseAsset(process.platform, process.arch) ? "Antigravity is not installed. Install it in this environment or set a custom executable path." : `Google does not publish an Antigravity runtime for ${process.platform}-${process.arch}. Use a supported environment or a custom executable.`);
}
export async function extractAntigravityArchive(archivePath: string, destination: string, asset: AntigravityReleaseAsset, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const opened = Promise.withResolvers<Yauzl.ZipFile>();
  Yauzl.open(archivePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, zip) => error || !zip ? opened.reject(new Error("Could not open the verified Antigravity archive.")) : opened.resolve(zip));
  const archive = await opened.promise;
  let archiveError: Error | undefined;
  const rememberError = (error: Error) => { archiveError = error; };
  archive.on("error", rememberError);
  const abort = () => archive.close();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (archive.entryCount !== 2) throw new Error("The archive must contain exactly the Antigravity executable and its harness.");
    const seen = new Set<string>();
    for (;;) {
      signal?.throwIfAborted();
      if (archiveError) throw archiveError;
      const next = Promise.withResolvers<Yauzl.Entry | null>();
      const cleanup = () => { archive.removeListener("entry", onEntry); archive.removeListener("end", onEnd); archive.removeListener("error", onError); archive.removeListener("close", onClose); };
      const onEntry = (entry: Yauzl.Entry) => { cleanup(); next.resolve(entry); };
      const onEnd = () => { cleanup(); next.resolve(null); };
      const onError = (error: Error) => { cleanup(); next.reject(error); };
      const onClose = () => { cleanup(); next.reject(new Error("Antigravity archive extraction was interrupted.")); };
      archive.once("entry", onEntry); archive.once("end", onEnd); archive.once("error", onError); archive.once("close", onClose);
      archive.readEntry();
      const entry = await next.promise;
      if (!entry) break;
      const expected = [asset.executable, asset.harness].find((file) => file.name === entry.fileName);
      const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (!expected || seen.has(entry.fileName) || /[/\\]/.test(entry.fileName) || (unixType !== 0 && unixType !== 0o100000) || (entry.externalFileAttributes & 0x10) !== 0 || (entry.generalPurposeBitFlag & 1) !== 0 || ![0, 8].includes(entry.compressionMethod) || entry.uncompressedSize !== expected.bytes) throw new Error("The archive contains an unexpected, unsafe, or incorrectly sized member.");
      seen.add(entry.fileName);
      const stream = Promise.withResolvers<Readable>();
      archive.openReadStream(entry, (error, readable) => error || !readable ? stream.reject(new Error("Could not read an Antigravity archive member.")) : stream.resolve(readable));
      let bytes = 0;
      const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; callback(bytes > expected.bytes ? new Error("An archive member exceeded its pinned size.") : null, chunk); } });
      await pipeline(await stream.promise, counter, createWriteStream(join(destination, entry.fileName), { flags: "wx", mode: 0o700 }), { signal });
      if (bytes !== expected.bytes) throw new Error("An archive member was truncated.");
    }
    if (!seen.has(asset.executable.name) || !seen.has(asset.harness.name)) throw new Error("The archive is missing the Antigravity executable or its harness.");
    if (archiveError) throw archiveError;
  } finally { signal?.removeEventListener("abort", abort); archive.close(); }
}
export async function installAntigravityRuntime(context: ProviderDriverContext, validate: (installation: AntigravityExecutable, expectedVersion: string, signal: AbortSignal) => Promise<void>, signal?: AbortSignal, onProgress?: (message: string) => void): Promise<{ message: string }> {
  const asset = resolveAntigravityReleaseAsset(process.platform, process.arch);
  if (!asset) throw new Error(`Google does not publish an Antigravity runtime for ${process.platform}-${process.arch}. Use a supported environment or a custom executable.`);
  const directory = installationDirectory(context);
  if (installs.has(directory)) throw new Error("Antigravity installation is already in progress for this provider.");
  installs.add(directory);
  let staging: string | undefined;
  try {
    signal?.throwIfAborted();
    const versions = join(directory, "versions"); await mkdir(versions, { recursive: true, mode: 0o700 });
    const destination = join(versions, asset.sha256);
    const validateRelease = async (installation: AntigravityExecutable) => validate(installation, asset.version, AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(90_000)]));
    const exists = await stat(destination).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
    if (exists) { onProgress?.("Checking the installed Antigravity runtime."); await validateRelease(await completedRelease(directory, asset.sha256)); }
    else {
      const available = await statfs(versions, { bigint: true }).catch(() => null);
      const required = asset.archiveBytes + asset.executable.bytes + asset.harness.bytes + 256 * 1024 * 1024;
      if (available && available.bavail * available.bsize < BigInt(required)) throw new Error(`Antigravity needs at least ${Math.ceil(required / 1024 / 1024)} MiB of free space to install.`);
      staging = await mkdtemp(join(versions, ".install-")); const archivePath = join(staging, "download.zip"); const pairDirectory = join(staging, "runtime"); await mkdir(pairDirectory, { mode: 0o700 });
      onProgress?.("Downloading the pinned Google Antigravity runtime.");
      const downloadSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(45 * 60_000)]);
      const response = await fetch(asset.url, { signal: downloadSignal, headers: { "Accept-Encoding": "identity" }, redirect: "error" });
      if (!response.ok || !response.body) throw new Error("The Antigravity download failed.");
      const contentLength = response.headers.get("content-length"); const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
      if ((!encoding || encoding === "identity") && contentLength !== null && Number(contentLength) !== asset.archiveBytes) { await response.body.cancel(); throw new Error("The Antigravity download size did not match the pinned release."); }
      const hash = createHash("sha256"); let downloaded = 0;
      const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) { downloaded += chunk.length; hash.update(chunk); callback(downloaded > asset.archiveBytes ? new Error("The Antigravity download exceeded its pinned size.") : null, chunk); } });
      await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), counter, createWriteStream(archivePath, { flags: "wx", mode: 0o600 }), { signal: downloadSignal });
      if (downloaded !== asset.archiveBytes || hash.digest("hex") !== asset.sha256) throw new Error("The Antigravity download failed its size or SHA-256 check. Nothing was installed.");
      onProgress?.("Extracting the verified Antigravity runtime.");
      await extractAntigravityArchive(archivePath, pairDirectory, asset, signal); await rm(archivePath);
      if (process.platform !== "win32") { await chmod(join(pairDirectory, asset.executable.name), 0o755); await chmod(join(pairDirectory, asset.harness.name), 0o755); }
      const installation: AntigravityExecutable = { executablePath: join(pairDirectory, asset.executable.name), harnessPath: join(pairDirectory, asset.harness.name), source: "managed", version: asset.version };
      onProgress?.("Checking the downloaded Antigravity runtime."); await validateRelease(installation);
      await writeFile(join(pairDirectory, releaseRecord), JSON.stringify({ releaseId: asset.sha256, version: asset.version, executable: asset.executable, harness: asset.harness } satisfies InstalledRelease), { flag: "wx", mode: 0o600 });
      try { await rename(pairDirectory, destination); } catch (error) {
        if (!(error instanceof Error) || !["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        const existing = await completedRelease(directory, asset.sha256); if (existing.version !== asset.version) throw new Error("Another installation published a different Antigravity release."); await validateRelease(existing);
      }
    }
    signal?.throwIfAborted();
    const pointerDirectory = await mkdtemp(join(directory, "active.json."));
    try { const pointer = join(pointerDirectory, "contents.tmp"); await writeFile(pointer, JSON.stringify({ releaseId: asset.sha256 }), { flag: "wx", mode: 0o600 }); await rename(pointer, join(directory, "active.json")); } finally { await rm(pointerDirectory, { recursive: true, force: true }); }
    return { message: `Installed Google Antigravity ${asset.version}. Sign in to verify account access and load models.` };
  } finally { installs.delete(directory); if (staging) await rm(staging, { recursive: true, force: true }); }
}
