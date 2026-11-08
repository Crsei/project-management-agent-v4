import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { desktopBuilderConfig } from "../electron-builder.config.mjs";
import { prepackApplication } from "./application-asar.mjs";
import { inspectDeployment, run, stageWorkspace } from "./stage-workspace.mjs";
import { inspectPackagedApplication } from "./packaged-application.mjs";
import { inspectFinalArtifacts } from "./final-artifact.mjs";
import { captureSource, collectLegal, fileRecord, observePackagingPhase, requireUnchangedSource, writeReleaseMaterials } from "./release-materials.mjs";
import { computeMigrationsSha256, createInstallStamp } from "./install-stamp.mjs";
import { configuredArtifactNames } from "./delivery-assets.mjs";
import { peFileRecord, windowsSignerIdentity } from "./signatures.mjs";
import { inspectShippedSBOM } from "./sbom.mjs";
import { requireCleanVulnerabilityReport, scanSBOM } from "./osv.mjs";
import { notarizeFinalDmg } from "./mac-notarization.mjs";
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
const signer = mode === "signed" ? process.platform === "win32" ? windowsSignerIdentity()
  : { teamId: process.env.PM_DESKTOP_MAC_TEAM_ID ?? process.env.APPLE_TEAM_ID } : undefined;
if (mode === "signed" && process.platform === "darwin" && !/^[A-Z0-9]{10}$/.test(signer.teamId ?? ""))
  throw new Error("Signed macOS packaging requires the exact expected PM_DESKTOP_MAC_TEAM_ID (or APPLE_TEAM_ID).");
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
  const sourceIdentity = { commit: source.commit, dirty: source.dirty, sha256: source.sha256 };
  const builderOutput = join(staging, "builder-output");
  await observePackagingPhase("buildWorkspace", async () => {
    const pnpm = process.env.npm_execpath;
    if (!pnpm) throw new Error("Run desktop packaging through pnpm.");
    await run(process.execPath, [pnpm, "run", "build:agent"]);
    await run(process.execPath, [pnpm, "run", "build:web", "--config", join(desktopRoot, "../web/vite.desktop.config.mjs")]);
    await run(process.execPath, [join(desktopRoot, "scripts/build.mjs")]);
  });
  const application = join(staging, "application");
  const workspaceRuntime = join(staging, "workspace-runtime");
  await observePackagingPhase("stageWorkspace", () => stageWorkspace(workspaceRuntime, application));
  await copyFile(join(desktopRoot, "package.json"), join(workspaceRuntime, "apps/desktop/package.json"), constants.COPYFILE_EXCL);
  const installStamp = createInstallStamp({ commit: source.commit, version: manifest.version, source: { sha256: source.sha256, dirty: source.dirty },
    signing: mode, platform: process.platform, arch: process.arch, distribution: process.platform === "win32" ? "nsis" : "dmg",
    ownership: { installation: process.platform === "darwin" ? "os-managed" : "self", scope: "per-user" },
    compatibility: { dataSchema: 1, postgresMajor: 16, migrationsSha256: await computeMigrationsSha256(workspaceRuntime) } });
  const prepackedApplication = await observePackagingPhase("prepackApplication", () => prepackApplication(application, join(staging, "prepacked-application")));
  const nativeBinaries = [];
  const nativeRuntimeFiles = [];
  if (process.platform === "darwin" || mode === "signed" && process.platform === "win32") {
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
            const pe = bytesRead === 4 && magic.subarray(0, 2).toString("ascii") === "MZ" ? await peFileRecord(path) : null;
            if (bytesRead === 4 && (machO.has(magic.toString("hex")) || pe)) {
              const location = portable(relative(root, path));
              if (process.platform === "darwin") nativeBinaries.push(`Contents/Resources/${prefix}/${location}`);
              if (prefix === "desktop-runtime") nativeRuntimeFiles.push({ path: location, bytes: (await lstat(path)).size, sha256: await hashFile(path), ...(pe ? { peSha256: pe.sha256, peContentBytes: pe.contentBytes } : {}) });
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
    config: desktopBuilderConfig({ application, prepackedApplication, workspaceRuntime, desktopRuntime: runtimeRoot, output: builderOutput, electronVersion: manifest.devDependencies.electron, mode, platform: process.platform, nativeBinaries, installStamp }),
  }));
  const resources = process.platform === "win32"
    ? join(builderOutput, "win-unpacked", "resources")
    : join(builderOutput, process.arch === "arm64" ? "mac-arm64" : "mac", "PM Agent v4.app", "Contents", "Resources");
  await observePackagingPhase("inspectDeployment", () => inspectDeployment(join(resources, "workspace-runtime")));
  await observePackagingPhase("inspectPackagedApplication", () => inspectPackagedApplication(resources, manifest.version, { signedMachO: process.platform === "darwin", target, signing: mode, signer, source: sourceIdentity, installStamp }));
  const records = [];
  const delivered = new Set();
  for (const path of artifacts) {
    if (!isAbsolute(path) || !inside(builderOutput, path) || dirname(path) !== builderOutput || !/\.(?:exe|dmg|zip|blockmap)$/.test(path))
      throw new Error("Builder returned an unexpected artifact path or unconfigured update metadata.");
    delivered.add(basename(path));
  }
  // Builder scratch trees/debug logs never enter the delivery directory.
  const configured = configuredArtifactNames({ version: manifest.version, target, signing: mode });
  for (const name of await readdir(builderOutput)) if (name.endsWith(".blockmap")) delivered.add(name);
  if (configured.required.some((name) => !delivered.has(name)) || [...delivered].some((name) => !configured.allowed.includes(name)))
    throw new Error("Builder output differs from the exact configured final artifact allowlist.");
  const finalNotarization = [];
  if (mode === "signed" && process.platform === "darwin") {
    for (const name of [...delivered].filter((name) => name.endsWith(".dmg")).sort())
      finalNotarization.push(await observePackagingPhase("notarizeFinalDmg", () => notarizeFinalDmg(join(builderOutput, name))));
  }
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  await observePackagingPhase("recordArtifacts", async () => {
    for (const name of [...delivered].sort()) {
      await copyFile(join(builderOutput, name), join(output, name), constants.COPYFILE_EXCL);
      records.push(await fileRecord(output, name));
    }
  });
  const legalRoot = join(staging, "legal");
  let sbom;
  const identity = { target, version: manifest.version, signing: mode, signer, source: sourceIdentity, installStamp };
  const finalArtifactVerification = await observePackagingPhase("inspectFinalArtifacts", () => inspectFinalArtifacts(output, records, identity, async (finalResources) => {
    const current = await inspectShippedSBOM(finalResources, { ...identity, electronVersion: manifest.devDependencies.electron, artifacts: records });
    if (!sbom) {
      sbom = current;
      await collectLegal(finalResources, process.platform, legalRoot);
    } else if (JSON.stringify(current) !== JSON.stringify(sbom)) throw new Error("Final native archives contain different shipped SBOM closures.");
  }));
  await writeFile(join(output, "desktop-sbom.cdx.json"), JSON.stringify(sbom, null, 2) + "\n", { flag: "wx" });
  const vulnerabilityScan = await observePackagingPhase("scanShippedVulnerabilities", () => scanSBOM(sbom));
  await writeFile(join(output, "desktop-osv.json"), JSON.stringify(vulnerabilityScan.report, null, 2) + "\n", { flag: "wx" });
  await writeFile(join(output, "desktop-vulnerabilities.sarif"), JSON.stringify(vulnerabilityScan.sarif, null, 2) + "\n", { flag: "wx" });
  requireCleanVulnerabilityReport(vulnerabilityScan.report);
  await requireUnchangedSource(source);
  const delivery = await observePackagingPhase("writeReleaseMaterials", () => writeReleaseMaterials({
    output, resources, platform: process.platform, sourceRoot, source, legalRoot, legalCollected: true,
    manifest: {
      version: manifest.version, target, signing: mode,
      signingDetail: mode === "unsigned" && process.platform === "darwin" ? "ad-hoc only; not Developer ID signed or notarized" : mode,
      runtimeSources: runtimeManifest.sources,
      ...(signer ? { signer } : {}),
      installStamp,
      artifacts: records,
      updates: "Manual installer replacement only; managed data is outside installation and is preserved. No update feed or publishing is configured.",
    },
    verification: {
      schemaVersion: 1, generatedAt: new Date().toISOString(), target, signing: mode,
      checks: {
        application: finalArtifactVerification.artifacts[0].application,
        finalArtifacts: finalArtifactVerification,
        runtime: { status: "passed", scope: "Pinned source runtime inventory verified before signing by afterPack; final native executable smoke is separate." },
        signing: { status: mode === "signed" ? "passed" : "not-applicable", scope: "Exact final artifact per-file native reports in checks.finalArtifacts; unsigned/ad-hoc never claims signed or notarized.",
          ...(finalNotarization.length ? { finalDmgNotarization: finalNotarization } : {}) },
        installStamp: { status: "passed", value: installStamp, source: sourceIdentity },
        sbom: { status: "generated", path: "desktop-sbom.cdx.json", components: sbom.components.length, scope: "Actual final shipped closures and bundled input provenance" },
        vulnerabilities: { status: vulnerabilityScan.report.status, report: "desktop-osv.json", sarif: "desktop-vulnerabilities.sarif" },
        legalMaterials: { status: "collected-not-authorized", scope: "Final shipped legal copies collected; no legal compatibility or distribution approval is implied." },
      },
      nativeSmoke: { status: "not-run" },
      installE2E: { status: "not-run", installationExecuted: false, electronGuiExecuted: false },
      notCovered: ["Real installer install/upgrade/uninstall", "Electron GUI", "Real Provider account/model/native CLI Home", "Public distribution authorization", "Cross-store backup/restore acceptance"],
      published: false,
    },
  }));
  console.log(JSON.stringify({ output, manifest: join(output, "desktop-package.json"), target, signing: mode, published: false, artifacts: delivery.artifacts, materials: delivery.materials, checksums: "SHA256SUMS" }));
} finally {
  await observePackagingPhase("cleanStaging", () => rm(staging, { recursive: true, force: true }));
}
