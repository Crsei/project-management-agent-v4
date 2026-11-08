import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileStamp, GuardedDirectory, pathContains } from "../../../packages/pm-core/platform.ts";
import { assertNoWindowsReparsePath, cacheWindowsPathAttributes } from "../../../packages/pm-core/windows-reparse.ts";

// Preserve the measured regression ceiling until native installation/uninstall
// timing and complete runtime checks justify a smaller budget.
export const WINDOWS_INSTALL_FILE_LIMIT = 45_000;

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative safe integer.`);
}

export function assertWindowsInstallFileLimit(target, files, limit = WINDOWS_INSTALL_FILE_LIMIT) {
  nonnegativeInteger(files, "Install file count");
  nonnegativeInteger(limit, "Install file limit");
  if (typeof target !== "string") throw new Error("An explicit install target is required.");
  if (!target.startsWith("win32-") || files <= limit) return;
  const count = (value) => value.toLocaleString("en-US");
  throw new Error(
    `Windows install tree contains ${count(files)} files; limit ${count(limit)}. ` +
    `Reduce loose runtime files before packaging. ` +
    `Run node apps/desktop/scripts/payload-report.mjs --root <install-dir> --limit ${limit} for the current breakdown.`,
  );
}

const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const under = (path, root) => path === root || path.startsWith(`${root}/`);
const componentDescriptions = Object.freeze({
  pm: "PM/Worker/gateway code, PM packages and the independent PM production dependency closure",
  agent: "Agent code/resources and its independent production dependency closure",
  electron: "Electron/Chromium distribution, opaque app.asar, unpacked desktop shell and installer support",
  runtime: "Pinned bundled Node/PostgreSQL distribution and runtime inventory",
  shared: "Shared Web/UI/contracts, automation resources, licenses and workspace metadata",
  other: "Paths outside the explicit component allowlist; never silently assigned to a product component",
});
const pmPackages = ["application", "contracts", "domain", "infrastructure", "pm-cli", "pm-core", "pm-markdown", "pm-schema", "pm-views"];
const sharedPackages = ["agent-client-runtime", "agent-contracts", "automation-resources", "ui"];
const electronFiles = new Set([
  "PM Agent v4.exe", "Uninstall PM Agent v4.exe", "chrome_100_percent.pak", "chrome_200_percent.pak",
  "d3dcompiler_47.dll", "dxcompiler.dll", "dxil.dll", "ffmpeg.dll", "icudtl.dat",
  "libEGL.dll", "libGLESv2.dll", "resources.pak", "snapshot_blob.bin", "v8_context_snapshot.bin",
  "vk_swiftshader.dll", "vk_swiftshader_icd.json", "vulkan-1.dll",
  "LICENSE", "LICENSE.electron.txt", "LICENSES.chromium.html", "version",
]);
const workspaceMetadata = new Set([
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "desktop-dependency-layout.json",
  "agent-artifact-manifest.json", "desktop-runtime-native.json", "apps/desktop/package.json",
]);

// Paths are relative to the installation root (Windows) or the .app root
// (macOS). Matching only whole path components avoids agentish/node_modules-old
// and arbitrary nested resource names being mistaken for an owned closure.
function componentFor(path) {
  let resource;
  if (path.startsWith("resources/")) resource = path.slice("resources/".length);
  else if (path.startsWith("Contents/Resources/")) resource = path.slice("Contents/Resources/".length);
  if (resource !== undefined) {
    if (under(resource, "desktop-runtime")) return "runtime";
    if (resource === "app.asar" || under(resource, "app.asar.unpacked")) return "electron";
    if (resource === "electron.icns" || resource === "icon.icns" || /^[^/]+\.lproj\//.test(resource)) return "electron";
    if (resource === "desktop-install-stamp.json" || resource === "desktop-install-files.json") return "shared";
    if (resource.startsWith("workspace-runtime/")) {
      const workspace = resource.slice("workspace-runtime/".length);
      if (under(workspace, "apps/server/agent")) return "agent";
      if (under(workspace, "apps/server/pm") || under(workspace, "apps/server/worker")
        || workspace === "apps/server/gateway.ts" || under(workspace, "node_modules")
        || pmPackages.some((name) => under(workspace, `packages/${name}`))) return "pm";
      if (under(workspace, "apps/web") || under(workspace, "apps/desktop/src")
        || under(workspace, "licenses") || under(workspace, "vendor/openhands-automations")
        || sharedPackages.some((name) => under(workspace, `packages/${name}`))
        || workspaceMetadata.has(workspace)) return "shared";
    }
    return "other";
  }
  if (electronFiles.has(path) || under(path, "locales")
    || under(path, "Contents/MacOS") || under(path, "Contents/Frameworks")
    || under(path, "Contents/_CodeSignature") || path === "Contents/Info.plist"
    || path === "Contents/PkgInfo") return "electron";
  return "other";
}

export function payloadBudgets({ files, bytes }, { fileLimit = WINDOWS_INSTALL_FILE_LIMIT, byteLimit = null } = {}) {
  nonnegativeInteger(files, "Payload file count");
  nonnegativeInteger(bytes, "Payload logical bytes");
  nonnegativeInteger(fileLimit, "Payload file limit");
  if (byteLimit !== null) nonnegativeInteger(byteLimit, "Payload logical-byte limit");
  const budget = (actual, limit) => ({
    actual, limit, remaining: limit === null ? null : limit - actual,
    withinLimit: limit === null ? null : actual <= limit,
  });
  return {
    files: budget(files, fileLimit),
    logicalBytes: budget(bytes, byteLimit),
    withinLimit: files <= fileLimit && (byteLimit === null || bytes <= byteLimit),
  };
}

/**
 * Inventory loose regular-file paths, not expanded archive members or allocated
 * disk space. Optional contained POSIX symlinks are counted separately and never
 * traversed; Windows reparse resources always fail closed.
 */
export async function inspectPayloadFiles(root, {
  allowContainedSymlinks = false, fileLimit = WINDOWS_INSTALL_FILE_LIMIT, byteLimit = null,
} = {}) {
  // Validate options before touching a caller-provided directory.
  payloadBudgets({ files: 0, bytes: 0 }, { fileLimit, byteLimit });
  if (typeof allowContainedSymlinks !== "boolean") throw new Error("Invalid payload link policy.");
  const absolute = resolve(root);
  const boundary = new GuardedDirectory(absolute);
  const active = [boundary];
  const assertCurrent = () => { for (const directory of active) directory.assertCurrent(); };
  const summary = { files: 0, bytes: 0, links: 0 };
  const components = Object.fromEntries(Object.keys(componentDescriptions).map((name) => [name, { files: 0, bytes: 0, links: 0 }]));
  const topLevel = new Map();
  const directories = new Map();
  function add(child, relativeDirectory, size, link = false) {
    const component = components[componentFor(child)];
    if (link) { summary.links++; component.links++; return; }
    summary.files++;
    summary.bytes += size;
    if (!Number.isSafeInteger(summary.bytes)) throw new Error("Payload logical bytes exceed the safe integer range.");
    component.files++;
    component.bytes += size;
    const top = child.split("/")[0];
    const area = topLevel.get(top) ?? { files: 0, bytes: 0 };
    area.files++;
    area.bytes += size;
    topLevel.set(top, area);
    const parent = relativeDirectory || ".";
    const directory = directories.get(parent) ?? { files: 0, bytes: 0 };
    directory.files++;
    directory.bytes += size;
    directories.set(parent, directory);
  }
  async function visit(directory, relativeDirectory) {
    assertCurrent();
    const before = fileStamp(directory.currentStat());
    const names = (await readdir(directory.path())).sort(compare);
    if (process.platform === "win32") cacheWindowsPathAttributes(names.map(name => directory.path(name)));
    for (const name of names) {
      assertCurrent();
      const path = directory.path(name);
      const child = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const info = await lstat(path, { bigint: true });
      if (info.isSymbolicLink()) {
        if (!allowContainedSymlinks || process.platform === "win32")
          throw new Error(`Payload contains a symbolic link or reparse resource: ${child}`);
        const target = await readlink(path);
        if (isAbsolute(target) || !pathContains(absolute, resolve(dirname(join(absolute, child)), target))
          || !pathContains(absolute, await realpath(path)))
          throw new Error(`Payload contains an escaping symbolic link: ${child}`);
        add(child, relativeDirectory, 0, true);
      } else {
        assertNoWindowsReparsePath(path, info);
        if (info.isDirectory()) {
          const nested = new GuardedDirectory(path);
          active.push(nested);
          try { await visit(nested, child); }
          finally { active.pop(); nested.close(); }
        } else if (info.isFile()) {
          const size = Number(info.size);
          nonnegativeInteger(size, "Payload file logical bytes");
          add(child, relativeDirectory, size);
        } else throw new Error(`Payload contains an unsupported resource: ${child}`);
      }
      assertCurrent();
      const current = await lstat(path, { bigint: true });
      if (fileStamp(current) !== fileStamp(info)) throw new Error(`Payload resource changed while counting: ${child}`);
    }
    assertCurrent();
    if (fileStamp(directory.currentStat()) !== before) throw new Error("Payload directory changed while counting.");
  }
  try { await visit(boundary, ""); }
  finally { boundary.close(); }
  const topAreas = [...topLevel.entries()].sort(([left], [right]) => compare(left, right));
  const totals = Object.values(components).reduce((sum, component) => ({
    files: sum.files + component.files, bytes: sum.bytes + component.bytes, links: sum.links + component.links,
  }), { files: 0, bytes: 0, links: 0 });
  if (totals.files !== summary.files || totals.bytes !== summary.bytes || totals.links !== summary.links)
    throw new Error("Payload component accounting does not conserve the complete inventory.");
  return {
    root: absolute, ...summary,
    accounting: {
      fileCount: "regular-file paths; hardlinked paths each counted once",
      bytes: "sum of regular-file logical lengths; opaque archives counted once, not expanded",
      links: "counted separately, never followed and excluded from file/byte totals",
      diskBytes: null, diskUsageMeasured: false,
      installationExecuted: false, uninstallTimingMeasured: false,
    },
    classification: { version: 1, scope: "installation-root or macOS .app-root; disjoint path allowlist", categories: componentDescriptions },
    components,
    budgets: payloadBudgets(summary, { fileLimit, byteLimit }),
    topLevel: Object.fromEntries(topAreas.map(([path, area]) => [path, area.files])),
    topLevelBytes: Object.fromEntries(topAreas.map(([path, area]) => [path, area.bytes])),
    // Only direct-file hotspots; parent counts do not include descendants.
    topDirectories: [...directories.entries()]
      .sort(([leftPath, left], [rightPath, right]) => right.files - left.files || compare(leftPath, rightPath))
      .slice(0, 20).map(([path, area]) => ({ path, ...area })),
  };
}
