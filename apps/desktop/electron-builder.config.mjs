import { chmod, cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectDeployment } from "./scripts/stage-workspace.mjs";
import { hashFile, verifyRuntime } from "./scripts/runtime-manifest.mjs";
import { inspectPackagedApplication } from "./scripts/packaged-application.mjs";
import { writeInstallStamp } from "./scripts/install-stamp.mjs";
import { inspectWindowsRuntimeDependencies } from "./scripts/windows-runtime-dependencies.mjs";
import { windowsSignerIdentity, verifyWindowsFile } from "./scripts/signatures.mjs";
import { createInstallationManifest, INSTALL_FILES_NAME } from "./src/uninstall.mjs";
import { desktopUpdatePolicy } from "./src/update-policy.mjs";

// Installation resources are public code, not private workspace data. cp keeps
// checkout permissions, which may otherwise make a shared /Applications install
// unreadable to anyone except the builder. Never follow links or chmod a shared inode.
async function normalizeInstallationModes(path, preserveFileModes = false) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(path, 0o755);
    for (const name of await readdir(path)) await normalizeInstallationModes(join(path, name), preserveFileModes);
  } else if (info.isFile()) {
    if (preserveFileModes) return;
    const mode = info.mode & 0o111 ? 0o755 : 0o644;
    if ((info.mode & 0o777) === mode) return;
    if (info.nlink > 1) throw new Error("Copied installation resource unexpectedly shares an inode.");
    await chmod(path, mode);
  } else throw new Error("Unsupported installation resource.");
}

export function desktopBuilderConfig({ application, prepackedApplication, workspaceRuntime, desktopRuntime, output, electronVersion, mode, platform, nativeBinaries, installStamp }) {
  const signed = mode === "signed";
  if (!installStamp) throw new Error("Desktop packaging requires an exact source-bound build install stamp.");
  const updates = desktopUpdatePolicy({ version: installStamp.version, platform, signing: mode });
  const windowsSigner = signed && platform === "win32" ? windowsSignerIdentity() : null;
  if (signed && platform === "darwin" && !/^[A-Z0-9]{10}$/.test(process.env.PM_DESKTOP_MAC_TEAM_ID ?? process.env.APPLE_TEAM_ID ?? "")) throw new Error("Signed macOS packaging requires an exact expected Apple team identity.");
  return {
    appId: "com.projectmanagementagent.v4",
    productName: "PM Agent v4",
    executableName: "PM Agent v4",
    electronVersion,
    directories: { app: prepackedApplication.directory, output },
    files: ["app.asar"],
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    forceCodeSigning: signed,
    publish: updates.enabled ? { provider: updates.provider, owner: updates.owner, repo: updates.repo, channel: updates.channel, private: false, releaseType: updates.allowPrerelease ? "prerelease" : "release" } : null,
    generateUpdatesFilesForAllChannels: false,
    electronUpdaterCompatibility: ">=6.8.11",
    artifactName: `PM-Agent-v4-\${version}-\${os}-\${arch}-${mode}.\${ext}`,
    // The native Node closure is intentionally outside app.asar and outside
    // Electron's dependency/rebuild graph. Its dependency directories are real
    // hoisted packages, never graph links for the Windows archiver to expand.
    async afterPack(context) {
      const resources = platform === "darwin"
        ? join(context.appOutDir, "PM Agent v4.app", "Contents", "Resources")
        : join(context.appOutDir, "resources");
      await mkdir(resources, { recursive: true });
      if (await hashFile(join(resources, "app.asar")) !== prepackedApplication.sha256)
        throw new Error("Electron builder changed the prepacked application archive.");
      await cp(workspaceRuntime, join(resources, "workspace-runtime"), { recursive: true, verbatimSymlinks: true });
      await cp(desktopRuntime, join(resources, "desktop-runtime"), { recursive: true, verbatimSymlinks: true });
      await inspectDeployment(join(resources, "workspace-runtime"));
      await normalizeInstallationModes(join(resources, "workspace-runtime"));
      // Pinned runtime file modes stay intact; enclosing directories must still
      // be traversable and non-group-writable after installation by another user.
      await normalizeInstallationModes(join(resources, "desktop-runtime"), true);
      await verifyRuntime(join(resources, "desktop-runtime"));
      await writeInstallStamp(join(resources, "desktop-install-stamp.json"), installStamp);
      if (platform === "win32") {
        const maintenance = join(resources, "desktop-maintenance");
        await mkdir(maintenance);
        for (const name of ["uninstall.mjs", "uninstall-cli.mjs", "install-stamp.mjs", "private-state.mjs"]) await cp(join(import.meta.dirname, "src", name), join(maintenance, name));
        await cp(join(import.meta.dirname, "assets", "desktop-maintenance.ps1"), join(maintenance, "desktop-maintenance.ps1"));
        await writeFile(join(output, "desktop-lifecycle.generated.nsh"), `!define DOVSPACE_MIGRATIONS_SHA256 "${installStamp.compatibility.migrationsSha256}"\n!include "${join(import.meta.dirname, "assets", "desktop-lifecycle.nsh")}"\n`);
        await writeFile(join(resources, "windows-runtime-dependencies.json"), `${JSON.stringify(await inspectWindowsRuntimeDependencies(join(resources, "desktop-runtime")), null, 2)}\n`);
        await writeFile(join(resources, INSTALL_FILES_NAME), `${JSON.stringify(await createInstallationManifest(context.appOutDir, installStamp))}\n`);
      }
      const metadata = JSON.parse(await readFile(join(application, "package.json"), "utf8"));
      await inspectPackagedApplication(resources, metadata.version, { target: `${platform}-${installStamp.arch}`, updateConfiguration: false });
    },
    async afterSign(context) {
      if (platform !== "win32") return;
      if (signed) {
        async function signTree(directory) {
          for (const name of (await readdir(directory)).sort()) {
            const path = join(directory, name), info = await lstat(path);
            if (info.isSymbolicLink()) throw new Error("Windows signing cannot follow payload links.");
            if (info.isDirectory()) await signTree(path);
            else if (info.isFile() && /\.(?:exe|dll|node)$/i.test(name)) {
              // The pinned builder signs top-level Electron + app.asar.unpacked,
              // not our copied runtime closures. Sign every final loose PE.
              if (!await context.packager.signIf(path)) throw new Error("A shipped Windows native executable was not signed.");
              await verifyWindowsFile(path, windowsSigner);
            }
          }
        }
        await signTree(context.appOutDir);
      }
      // Authenticode changes bytes: ownership authorization records the exact
      // final signed tree, never broad binary hash exemptions during uninstall.
      await writeFile(join(context.appOutDir, "resources", INSTALL_FILES_NAME), `${JSON.stringify(await createInstallationManifest(context.appOutDir, installStamp))}\n`);
    },
    win: {
      target: [{ target: "nsis", arch: ["x64"] }],
      signAndEditExecutable: signed,
      signExts: [".exe", ".dll", ".node"],
      ...(windowsSigner ? { signtoolOptions: { certificateSubjectName: windowsSigner.subject, signingHashAlgorithms: ["sha256"] } } : {}),
      // Only the two shipped interface languages. Every extra locale adds a
      // loose .pak file to the install tree and to NSIS uninstall work.
      electronLanguages: ["en-US", "zh-CN"],
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      // Per-user maintenance never elevates. The builder otherwise injects
      // elevate.exe after afterPack, outside the exact ownership manifest.
      packElevateHelper: false,
      allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false,
      include: join(output, "desktop-lifecycle.generated.nsh"),
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: "PM Agent v4",
    },
    mac: {
      target: ["dmg", "zip"],
      category: "public.app-category.developer-tools",
      minimumSystemVersion: "15.0",
      darkModeSupport: true,
      // An ad-hoc macOS signature is explicitly UNSIGNED distribution, never
      // claimed as Developer ID signing/notarization. It permits arm64 testing.
      identity: signed ? undefined : "-",
      hardenedRuntime: signed,
      notarize: signed,
      entitlements: join(import.meta.dirname, "assets", "entitlements.mac.plist"),
      entitlementsInherit: join(import.meta.dirname, "assets", "entitlements.mac.inherit.plist"),
      binaries: nativeBinaries,
    },
    dmg: { sign: signed, writeUpdateInfo: false },
  };
}
