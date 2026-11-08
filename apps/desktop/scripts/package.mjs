import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { desktopBuilderConfig } from "../electron-builder.config.mjs";
import { prepackApplication } from "./application-asar.mjs";
import { buildWorkspace, inspectDeployment, run, stageWorkspace } from "./stage-workspace.mjs";
import { inspectPackagedApplication } from "./packaged-application.mjs";
import { inspectFinalArtifacts } from "./final-artifact.mjs";
import { captureSource, fileRecord, observePackagingPhase, requireUnchangedSource, writeReleaseMaterials } from "./release-materials.mjs";
import {
  defaultRuntimeRoot, desktopRoot, hashFile, inside, portable, requireNativeTarget,
  requirePinnedNode, verifyRuntime,
} from "./runtime-manifest.mjs";

let mode;
const options = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const name = process.argv[index];
  if (["--unsigned", "--signed"].includes(name)) {
    if (mode) throw new Error("Choose exactly one of --unsigned and --signed.");
    mode = name.slice(2);
  } else if (["--runtime-root", "--output", "--platform", "--arch"].includes(name) && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    options.set(name, process.argv[++index]);
  } else throw new Error("Usage through pnpm: package.mjs (--unsigned | --signed) [--runtime-root DIRECTORY] [--output NEW_DIRECTORY] [--platform PLATFORM] [--arch ARCH]");
}
if (!mode) throw new Error("Signing is explicit: use package (unsigned) or package:signed. Nothing is published.");
requirePinnedNode();
const target = requireNativeTarget(options.get("--platform"), options.get("--arch"), true);
const runtimeRoot = resolve(options.get("--runtime-root") ?? process.env.PM_DESKTOP_RUNTIME_ROOT ?? defaultRuntimeRoot);
const runtimeManifest = await observePackagingPhase("verifyRuntime", () => verifyRuntime(runtimeRoot, target)).catch((cause) => {
  throw new Error(`A complete verified desktop runtime is required. Run pnpm --filter @agent-workspace/desktop runtime:prepare on this runner first. ${cause.message}`);
});
if (mode === "unsigned") {
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  for (const name of ["CSC_LINK", "CSC_KEY_PASSWORD", "CSC_NAME", "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_KEYCHAIN", "APPLE_KEYCHAIN_PROFILE"])
    delete process.env[name];
} else {
  if (!process.env.CSC_LINK && !(process.platform === "win32" && process.env.WIN_CSC_LINK))
    throw new Error("Signed packaging requires CSC_LINK (or Windows WIN_CSC_LINK) plus its certificate password environment variable. No unsigned fallback is allowed.");
  if (process.platform === "darwin" && !(
    (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) ||
    (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER)
  )) throw new Error("Signed macOS packaging additionally requires Apple notarization credentials (APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID or APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER). Nothing is published.");
}
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY) process.env.ELECTRON_GET_USE_PROXY ||= "1";
const manifest = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
const output = resolve(options.get("--output") ?? join(desktopRoot, "releases", manifest.version, target, mode));
for (let current = output; ; current = dirname(current)) {
  const info = await lstat(current).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (info && (current === output || !info.isDirectory() || info.isSymbolicLink()))
    throw new Error("Installer output must be a new directory with real directory ancestors; previous artifacts are never overwritten.");
  if (dirname(current) === current) break;
}
const staging = await realpath(await mkdtemp(join(tmpdir(), "pm-agent-v4-desktop-")));
try {
  const sourceRoot = join(staging, "source");
  const source = await captureSource(sourceRoot);
  await observePackagingPhase("buildWorkspace", () => buildWorkspace());
  const application = join(staging, "application");
  const workspaceRuntime = join(staging, "workspace-runtime");
  await observePackagingPhase("stageWorkspace", () => stageWorkspace(workspaceRuntime, application));
  const prepackedApplication = await observePackagingPhase("prepackApplication", () => prepackApplication(application, join(staging, "prepacked-application")));
  const nativeBinaries = [];
  const nativeRuntimeFiles = [];
  if (process.platform === "darwin") {
    const magic = Buffer.alloc(4);
    const machO = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);
    async function collectBinaries(root, prefix, directory = root) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await collectBinaries(root, prefix, path);
        else if (entry.isFile()) {
          const file = await open(path, "r");
          try {
            const { bytesRead } = await file.read(magic, 0, 4, 0);
            if (bytesRead === 4 && machO.has(magic.toString("hex"))) {
              const location = portable(relative(root, path));
              nativeBinaries.push(`Contents/Resources/${prefix}/${location}`);
              if (prefix === "desktop-runtime") nativeRuntimeFiles.push({ path: location, bytes: (await lstat(path)).size, sha256: await hashFile(path) });
            }
          } finally { await file.close(); }
        }
      }
    }
    await observePackagingPhase("collectNativeBinaries", async () => {
      await collectBinaries(runtimeRoot, "desktop-runtime");
      await collectBinaries(workspaceRuntime, "workspace-runtime");
    });
  }
  await writeFile(join(workspaceRuntime, "desktop-runtime-native.json"),
    JSON.stringify({ schemaVersion: 1, files: nativeRuntimeFiles }, null, 2) + "\n", { flag: "wx" });
  const { Arch, Platform, build } = await import("electron-builder");
  const platform = process.platform === "win32" ? Platform.WINDOWS : Platform.MAC;
  const arch = process.arch === "arm64" ? Arch.arm64 : Arch.x64;
  const artifacts = await observePackagingPhase("buildInstallers", () => build({
    projectDir: prepackedApplication.directory,
    targets: platform.createTarget(process.platform === "win32" ? ["nsis"] : ["dmg", "zip"], arch),
    publish: "never",
    config: desktopBuilderConfig({ application, prepackedApplication, workspaceRuntime, desktopRuntime: runtimeRoot, output, electronVersion: manifest.devDependencies.electron, mode, platform: process.platform, nativeBinaries }),
  }));
  const resources = process.platform === "win32"
    ? join(output, "win-unpacked", "resources")
    : join(output, process.arch === "arm64" ? "mac-arm64" : "mac", "PM Agent v4.app", "Contents", "Resources");
  await observePackagingPhase("inspectDeployment", () => inspectDeployment(join(resources, "workspace-runtime")));
  const applicationVerification = await observePackagingPhase("inspectPackagedApplication", () => inspectPackagedApplication(resources, manifest.version, { signedMachO: process.platform === "darwin" }));
  // afterPack verifies runtime bytes before native signing changes executable
  // hashes. Retain that source inventory as provenance; verify the signed bundle
  // and hash the final distributables below instead of rejecting upstream npm files.
  if (mode === "signed" && process.platform === "darwin")
    await observePackagingPhase("verifyMacSignature", () => run("codesign", ["--verify", "--deep", "--strict", join(resources, "../..")]));
  const records = [];
  const delivered = new Set();
  for (const path of artifacts) {
    if (!isAbsolute(path) || !inside(output, path) || dirname(path) !== output || !/\.(?:exe|dmg|zip|blockmap)$/.test(path))
      throw new Error("Builder returned an unexpected artifact path or unconfigured update metadata.");
    delivered.add(basename(path));
  }
  // Some builder targets report their installer but not its generated blockmap.
  for (const name of await readdir(output)) if (name.endsWith(".blockmap")) delivered.add(name);
  await observePackagingPhase("recordArtifacts", async () => {
    for (const name of [...delivered].sort()) records.push(await fileRecord(output, name));
  });
  const expected = process.platform === "win32" ? [".exe"] : [".dmg", ".zip"];
  if (expected.some((suffix) => !records.some((record) => record.path.endsWith(suffix))))
    throw new Error("Builder did not produce every required native installer/archive target.");
  if (mode === "signed" && process.platform === "win32") {
    const powershell = join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    await observePackagingPhase("verifyWindowsSignatures", async () => {
      for (const path of [join(output, "win-unpacked", "PM Agent v4.exe"), ...artifacts.filter((file) => file.endsWith(".exe"))]) {
        process.env.PM_DESKTOP_VERIFY_SIGNATURE_PATH = path;
        try {
          await run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; $signature=Get-AuthenticodeSignature -LiteralPath $env:PM_DESKTOP_VERIFY_SIGNATURE_PATH; if ($signature.Status -ne 'Valid') { throw 'Desktop Authenticode verification failed' }"]);
        } finally { delete process.env.PM_DESKTOP_VERIFY_SIGNATURE_PATH; }
      }
    });
  }
  const finalArtifactVerification = await observePackagingPhase("inspectFinalArtifacts", () => inspectFinalArtifacts(output, records, { target, version: manifest.version, signing: mode }));
  await mkdir(output, { recursive: true });
  await requireUnchangedSource(source);
  const delivery = await observePackagingPhase("writeReleaseMaterials", () => writeReleaseMaterials({
    output, resources, platform: process.platform, sourceRoot, source, legalRoot: join(staging, "legal"),
    manifest: {
      version: manifest.version, target, signing: mode,
      signingDetail: mode === "unsigned" && process.platform === "darwin" ? "ad-hoc only; not Developer ID signed or notarized" : mode,
      runtimeSources: runtimeManifest.sources,
      applicationResources: portable(relative(output, resources)),
      artifacts: records,
      updates: "Manual installer replacement only; managed data is outside installation and is preserved. No update feed or publishing is configured.",
    },
    verification: {
      schemaVersion: 1, generatedAt: new Date().toISOString(), target, signing: mode,
      checks: {
        application: applicationVerification,
        finalArtifacts: finalArtifactVerification,
        runtime: { status: "passed", scope: "Pinned source runtime inventory verified before signing by afterPack; final native executable smoke is separate." },
        signing: { status: mode === "signed" ? "passed" : "not-applicable", scope: mode === "signed" ? "Final platform signature verification; macOS notarization required by builder." : "Explicit unsigned test build; macOS ad-hoc is not Developer ID." },
        legalMaterials: { status: "collected-not-authorized", scope: "Final shipped legal copies collected; no legal compatibility or distribution approval is implied." },
      },
      nativeSmoke: { status: "not-run" },
      notCovered: ["Real installer install/upgrade/uninstall", "Electron GUI", "Real Provider account/model/native CLI Home", "Public distribution authorization", "Cross-store backup/restore acceptance"],
      published: false,
    },
  }));
  console.log(JSON.stringify({ output, manifest: join(output, "desktop-package.json"), target, signing: mode, published: false, artifacts: delivery.artifacts, materials: delivery.materials, checksums: "SHA256SUMS" }));
} finally {
  await observePackagingPhase("cleanStaging", () => rm(staging, { recursive: true, force: true }));
}
