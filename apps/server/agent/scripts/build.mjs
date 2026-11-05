import { build } from "esbuild";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyHostBuildInputs } from "../../../../vendor/t3code/scripts/host-inputs.mjs";
import { buildSidecar } from "./cc-switch.mjs";
import { assertBuildPrerequisites } from "../../../../scripts/doctor.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = path.resolve(packageRoot, "../../..");
await assertBuildPrerequisites();
const inventory = JSON.parse(await readFile(path.join(repositoryRoot, "vendor/t3code/sync-inventory.json"), "utf8"));
const hostBuildInputs = await verifyHostBuildInputs(repositoryRoot, inventory);
const temporaryOutput = process.env.AGENT_BUILD_OUTDIR;
// An alternate output is for isolated verification; never remove a caller-owned directory.
if (!temporaryOutput) {
  await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
}
const vendoredRoot = fileURLToPath(new URL("../../../../vendor/t3code/", import.meta.url));
const bundledWorkspace = /^(?:@agent-workspace\/(?:client-runtime\/providers$|contracts(?:\/|$))|@t3tools\/|@pm\/t3code-provider-server(?:\/|$)|effect-acp(?:\/|$)|effect-codex-app-server(?:\/|$))/;
const diskBackedSdk = /^(?:@anthropic-ai\/claude-agent-sdk|@cursor\/sdk|@muse-code\/sdk)(?:\/|$)/;
const sharedEffect = /^(?:effect|@effect\/platform-node)(?:\/|$)/;
const outputRoot = path.resolve(packageRoot, temporaryOutput || "dist");
const result = await build({
  absWorkingDir: packageRoot,
  entryPoints: {
    index: "src/index.ts",
    "claude-history-worker": path.join(vendoredRoot, "apps/server/src/claude-history-worker.ts"),
    "cursor-sdk-worker": path.join(vendoredRoot, "packages/provider-cursor/src/server/CursorSdkWorker.ts"),
    "providers/t3code/document-text-worker": "src/providers/t3code/document-text-worker.ts",
    "pm-cli/pi-tools": fileURLToPath(new URL("../../../../packages/pm-cli/pi-tools.ts", import.meta.url)),
    "pm-cli/automation-tools": fileURLToPath(new URL("../../../../packages/pm-cli/automation-tools.mjs", import.meta.url)),
    "workspace-tools": "src/automation-execution/native-templates/workspace-tools.mjs",
    "desktop-agent-maintenance": fileURLToPath(new URL("../../../desktop/src/backend/agent-maintenance.ts", import.meta.url)),
  },
  outdir: temporaryOutput || "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  metafile: true,
  splitting: true,
  chunkNames: "chunk-[hash]",
  plugins: [{
    name: "pinned-provider-source",
    setup(context) {
      context.onResolve({ filter: /^\.{1,2}\// }, (args) => {
        const resolved = path.resolve(args.resolveDir, args.path);
        if (resolved.startsWith(path.join(packageRoot, "src/providers/t3code/testing") + path.sep)) {
          throw new Error("PM Provider test support must not enter a production artifact.");
        }
      });
      context.onResolve({ filter: /^[^./]/ }, (args) => {
        // Drive-qualified native entry points/imports are files, not package specifiers.
        if (path.isAbsolute(args.path)) return;
        if (isBuiltin(args.path)) return { path: args.path, external: true };
        if (args.path.startsWith("@t3tools/provider-testing")) {
          throw new Error("Provider test support must not enter a production artifact.");
        }
        if (bundledWorkspace.test(args.path)) return;
        const fromVendor = args.importer.startsWith(vendoredRoot);
        const fromBundledDependency = args.importer.includes(`${path.sep}node_modules${path.sep}`);
        // Preserve SDK resources on disk and one Effect singleton with the PM host.
        if ((fromVendor || fromBundledDependency) &&
            !diskBackedSdk.test(args.path) && !sharedEffect.test(args.path)) return;
        return { path: args.path, external: true };
      });
    },
  }],
  banner: {
    js: 'import { createRequire as __pmCreateRequire } from "node:module"; const require = __pmCreateRequire(import.meta.url);',
  },
  platform: "node",
  format: "esm",
  target: "node22.18",
  sourcemap: true,
});

const ccSwitchNative = await buildSidecar(outputRoot);

// Packaging consumes actual emitted externals and input ownership, not a second dependency list.
const portablePath = (value, base) => path.relative(base, path.resolve(packageRoot, value)).split(path.sep).join("/");
await writeFile(path.join(outputRoot, "build-inputs.json"), JSON.stringify({
  version: 1,
  hostBuildInputs,
  ccSwitchNative: { target: ccSwitchNative.target, manifestSha256: ccSwitchNative.manifestSha256, outputInventorySha256: ccSwitchNative.outputInventorySha256, cargoLockSha256: ccSwitchNative.cargoLockSha256 },
  inputHashes: Object.fromEntries(await Promise.all(Object.keys(result.metafile.inputs).sort().map(async (value) => [
    portablePath(value, repositoryRoot), createHash("sha256").update(await readFile(path.resolve(packageRoot, value))).digest("hex"),
  ]))),
  inputs: Object.keys(result.metafile.inputs).map((value) => portablePath(value, repositoryRoot)).sort(),
  externalOrigins: Object.entries(result.metafile.inputs).flatMap(([source, metadata]) =>
    metadata.imports.filter((entry) => entry.external).map((entry) => ({
      specifier: entry.path, source: portablePath(source, repositoryRoot),
    }))),
  outputs: Object.entries(result.metafile.outputs).map(([value, metadata]) => ({
    path: portablePath(value, outputRoot),
    imports: metadata.imports.filter((entry) => entry.external).map((entry) => entry.path).sort(),
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
}, null, 2) + "\n");
