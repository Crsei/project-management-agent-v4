import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectHostNotices } from "../../agent/scripts/cc-switch.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const outputRoot = path.join(packageRoot, "dist");
const output = path.join(outputRoot, "main.mjs");
await rm(outputRoot, { recursive: true, force: true });
const result = await build({
  absWorkingDir: packageRoot,
  entryPoints: ["src/main.ts"],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  mainFields: ["module", "main"],
  conditions: ["import", "module", "node"],
  target: "node24",
  sourcemap: true,
  metafile: true,
  legalComments: "external",
  banner: { js: 'import { createRequire as __pmCreateRequire } from "node:module"; const require = __pmCreateRequire(import.meta.url);' },
});
for (const name of ["LICENSE", "NOTICE.md", "PROVENANCE.md", "UPSTREAM-SOURCES.md", "upstream.json"]) {
  await cp(path.join(packageRoot, name), path.join(outputRoot, name));
}
const files = await collectHostNotices(result.metafile, outputRoot);
const bytes = await readFile(output);
const manifest = {
  version: 1,
  entry: "main.mjs",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
  node: process.version,
  sourceCommit: "7afceec14b977ecc2f4373e8ffb40e7223b435ac",
  upstreamVersion: "4.0.25",
  files,
};
await writeFile(path.join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ entry: output, sha256: manifest.sha256, bytes: manifest.bytes }));
