import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { hashFile, portable } from "./runtime-manifest.mjs";

const execute = promisify(execFile);
export function windowsSignerIdentity(environment = process.env) {
  const subject = environment.PM_DESKTOP_WINDOWS_SIGNER_SUBJECT;
  const sha256 = environment.PM_DESKTOP_WINDOWS_SIGNER_SHA256?.toLowerCase();
  if (!subject || /[\0\r\n]/.test(subject) || !/^[a-f0-9]{64}$/.test(sha256 ?? ""))
    throw new Error("Signed Windows verification requires PM_DESKTOP_WINDOWS_SIGNER_SUBJECT and PM_DESKTOP_WINDOWS_SIGNER_SHA256 (certificate SHA256), with no unsigned fallback.");
  return { subject, sha256 };
}
export function validateWindowsSignature(signature, expected) {
  if (!expected || typeof expected.subject !== "string" || !expected.subject || !/^[a-f0-9]{64}$/.test(expected.sha256 ?? ""))
    throw new Error("An exact expected Windows signing identity is required.");
  if (signature?.status !== "Valid" || signature.subject !== expected.subject || signature.certificateSha256?.toLowerCase() !== expected.sha256)
    throw new Error("Authenticode status or expected signer identity mismatch.");
  return { status: "passed", subject: signature.subject, certificateSha256: signature.certificateSha256.toLowerCase() };
}

// Capture the ORIGINAL non-certificate length, including every trailing data or
// overlay byte. A later signature may add only zero alignment after that bound.
export function peContentRecord(bytes, originalContentBytes) {
  if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") return null;
  const pe = bytes.readUInt32LE(0x3c);
  if (pe + 26 > bytes.length || bytes.toString("hex", pe, pe + 4) !== "50450000") return null;
  const optional = pe + 24, size = bytes.readUInt16LE(pe + 20);
  const magic = bytes.readUInt16LE(optional), directory = optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0);
  if (directory === optional || optional + size > bytes.length || directory + 40 > optional + size)
    throw new Error("Invalid PE optional header for signature integrity verification.");
  const security = directory + 32, offset = bytes.readUInt32LE(security), length = bytes.readUInt32LE(security + 4);
  if ((offset === 0) !== (length === 0) || offset && (offset < optional + size || offset % 8 || offset + length !== bytes.length))
    throw new Error("Unsupported PE certificate layout; refusing a broad executable hash exemption.");
  const prefixEnd = offset || bytes.length;
  const contentBytes = originalContentBytes ?? prefixEnd;
  const padding = prefixEnd - contentBytes;
  if (!Number.isSafeInteger(contentBytes) || contentBytes < optional + size || padding < 0 || padding > 7
    || (!offset && padding !== 0) || offset && padding !== (8 - contentBytes % 8) % 8
    || bytes.subarray(contentBytes, prefixEnd).some((byte) => byte !== 0))
    throw new Error("PE signature alignment differs from the exact original executable content boundary.");
  const hash = createHash("sha256").update(`PE-CONTENT\\0${contentBytes}\\0`);
  hash.update(bytes.subarray(0, optional + 64));
  hash.update(Buffer.alloc(4));
  hash.update(bytes.subarray(optional + 68, security));
  hash.update(Buffer.alloc(8));
  hash.update(bytes.subarray(security + 8, contentBytes));
  return { sha256: hash.digest("hex"), contentBytes };
}
export async function peFileRecord(path, originalContentBytes) {
  return peContentRecord(await readFile(path), originalContentBytes);
}

export async function verifyWindowsFile(path, expected = windowsSignerIdentity()) {
  if (process.platform !== "win32") throw new Error("Authenticode verification requires native Windows PowerShell; another OS cannot supply signing evidence.");
  const before = await hashFile(path);
  const command = "$ErrorActionPreference='Stop'; Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; $s=Get-AuthenticodeSignature -LiteralPath $env:PM_DESKTOP_VERIFY_SIGNATURE_PATH; $h=$null; if($s.SignerCertificate){$sha=[System.Security.Cryptography.SHA256]::Create(); try{$h=([BitConverter]::ToString($sha.ComputeHash($s.SignerCertificate.RawData))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}; @{status=$s.Status.ToString();subject=$s.SignerCertificate.Subject;certificateSha256=$h}|ConvertTo-Json -Compress";
  const powershell = join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await execute(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, PM_DESKTOP_VERIFY_SIGNATURE_PATH: resolve(path) },
  });
  const checked = validateWindowsSignature(JSON.parse(stdout.replace(/^\uFEFF/, "")), expected);
  if (await hashFile(path) !== before) throw new Error("Signed file changed during Authenticode verification.");
  return { ...checked, sha256: before, bytes: (await lstat(path)).size };
}

async function commandReport(command, args, environment) {
  const { stdout, stderr } = await execute(command, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...(environment ? { env: environment } : {}) });
  return { command, args, exitCode: 0, stdout, stderr };
}
export async function verifyFinalSignatures(resources, artifactPath, { target, signing, signer }) {
  if (signing !== "signed") return { status: "not-applicable", signing: "unsigned", scope: "Explicit unsigned test delivery; macOS ad-hoc is not Developer ID signing or notarization." };
  const root = target.startsWith("darwin-") ? resolve(resources, "../..") : dirname(resources);
  if (target === "win32-x64") {
    if (process.platform !== "win32") throw new Error("Final signed Windows artifacts require native Authenticode verification.");
    const identity = signer ?? windowsSignerIdentity();
    const files = [];
    async function visit(directory) {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
        const path = join(directory, entry.name), info = await lstat(path);
        if (info.isSymbolicLink()) throw new Error("Windows signing inventory cannot follow links.");
        if (info.isDirectory()) await visit(path);
        else if (info.isFile() && /\.(?:exe|dll|node)$/i.test(entry.name)) files.push({ path: portable(relative(root, path)), ...await verifyWindowsFile(path, identity) });
      }
    }
    await visit(root);
    if (!files.length) throw new Error("Final Windows payload contains no verifiable native executables.");
    return { status: "passed", platform: "win32", identity,
      scope: "Every .exe/.dll/.node in the final installed application/runtime payload plus exact final NSIS installer; native ASAR members are checked in application verification",
      installerBoundary: "Private NSIS implementation/plugin members are not installed application files. The validated final installer Authenticode signature and exact artifact SHA256 bind their container bytes; they are not required to carry separate application-publisher signatures.",
      installer: await verifyWindowsFile(artifactPath, identity), files };
  }
  if (!target.startsWith("darwin-") || process.platform !== "darwin") throw new Error("Final macOS signing/notarization verification requires native macOS.");
  const teamId = signer?.teamId ?? process.env.PM_DESKTOP_MAC_TEAM_ID ?? process.env.APPLE_TEAM_ID;
  if (!/^[A-Z0-9]{10}$/.test(teamId ?? "")) throw new Error("Signed macOS verification requires the exact expected PM_DESKTOP_MAC_TEAM_ID (or APPLE_TEAM_ID).");
  const reports = [];
  reports.push(await commandReport("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", root]));
  const identity = await commandReport("/usr/bin/codesign", ["--display", "--verbose=4", root]);
  if (!identity.stderr.split(/\r?\n/).includes(`TeamIdentifier=${teamId}`) || !/^Authority=Developer ID Application:/m.test(identity.stderr))
    throw new Error("Final macOS bundle is not Developer ID signed by the expected team.");
  reports.push(identity);
  reports.push(await commandReport("/usr/bin/xcrun", ["stapler", "validate", root]));
  reports.push(await commandReport("/usr/sbin/spctl", ["--assess", "--ignore-cache", "--no-cache", "--type", "execute", "--verbose=4", root]));
  if (artifactPath.endsWith(".dmg")) {
    reports.push(await commandReport("/usr/bin/xcrun", ["stapler", "validate", artifactPath]));
    reports.push(await commandReport("/usr/sbin/spctl", ["--assess", "--ignore-cache", "--no-cache", "--type", "open", "--context", "context:primary-signature", "--verbose=4", artifactPath]));
  }
  // ZIP cannot itself carry a staple; its extracted final .app must validate.
  const stable = (value) => value.replaceAll(root, "<final-app>").replaceAll(artifactPath, "<final-artifact>");
  return { status: "passed", platform: "darwin", identity: { teamId }, archive: artifactPath.endsWith(".zip") ? "ZIP: assessed extracted final app, not the unsigned ZIP container" : "DMG and contained app assessed",
    reports: reports.map((report) => ({ ...report, stdout: stable(report.stdout), stderr: stable(report.stderr), args: report.args.map(stable) })) };
}

// Keep the actual command reports in delivery evidence. Equality may remove only
// the cache annotation on an otherwise identical accepted/source result, never
// identity, acceptance, notarization source, command arguments or exit status.
export function comparableFinalArtifactReport(value) {
  const diagnostic = (text) => text.replace(/\r\n/g, "\n")
    .replace(/^(<final-(?:app|artifact)>: accepted|source=Notarized Developer ID) \(cached\)$/gm, "$1");
  return JSON.stringify(value, (_key, entry) => entry?.command === "/usr/sbin/spctl" && typeof entry.stdout === "string" && typeof entry.stderr === "string"
    ? { ...entry, stdout: diagnostic(entry.stdout), stderr: diagnostic(entry.stderr) } : entry);
}
