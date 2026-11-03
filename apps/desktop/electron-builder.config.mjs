import { chmod, cp, lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { inspectDeployment } from "./scripts/stage-workspace.mjs";
import { verifyRuntime } from "./scripts/runtime-manifest.mjs";

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

export function desktopBuilderConfig({ application, workspaceRuntime, desktopRuntime, output, electronVersion, mode, platform, nativeBinaries }) {
  const signed = mode === "signed";
  return {
    appId: "com.projectmanagementagent.v4",
    productName: "PM Agent v4",
    executableName: "PM Agent v4",
    electronVersion,
    directories: { app: application, output },
    files: ["dist/**/*", "node_modules/**/*", "package.json"],
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    forceCodeSigning: signed,
    publish: null,
    artifactName: `PM-Agent-v4-\${version}-\${os}-\${arch}-${mode}.\${ext}`,
    // The native Node closure is intentionally outside app.asar and outside
    // Electron's dependency/rebuild graph. Copying here also preserves the
    // reviewed Agent packager's relative .packages links on every platform.
    async afterPack(context) {
      const resources = platform === "darwin"
        ? join(context.appOutDir, "PM Agent v4.app", "Contents", "Resources")
        : join(context.appOutDir, "resources");
      await mkdir(resources, { recursive: true });
      await cp(workspaceRuntime, join(resources, "workspace-runtime"), { recursive: true, verbatimSymlinks: true });
      await cp(desktopRuntime, join(resources, "desktop-runtime"), { recursive: true, verbatimSymlinks: true });
      await inspectDeployment(join(resources, "workspace-runtime"));
      await normalizeInstallationModes(join(resources, "workspace-runtime"));
      // Pinned runtime file modes stay intact; enclosing directories must still
      // be traversable and non-group-writable after installation by another user.
      await normalizeInstallationModes(join(resources, "desktop-runtime"), true);
      await verifyRuntime(join(resources, "desktop-runtime"));
    },
    win: { target: [{ target: "nsis", arch: ["x64"] }], signAndEditExecutable: signed },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: true,
      allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false,
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
