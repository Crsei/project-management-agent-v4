import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_SOURCE_COMMIT = "7afceec14b977ecc2f4373e8ffb40e7223b435ac";
export const HOST_UPSTREAM_VERSION = "4.0.25";
const hostRoot = fileURLToPath(new URL("../../cc-switch-host/", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fileRecord(root, relative) {
  const bytes = await readFile(path.join(root, relative));
  const info = await lstat(path.join(root, relative));
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe host resource: ${relative}`);
  return { path: relative.split(path.sep).join("/"), sha256: sha256(bytes), bytes: bytes.length, mode: info.mode & 0o777 };
}

export async function buildHost(outputRoot) {
  const destination = path.join(outputRoot, "cc-switch", "host");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await build({
    absWorkingDir: hostRoot,
    entryPoints: ["src/main.ts"],
    outfile: path.join(destination, "main.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    mainFields: ["module", "main"],
    conditions: ["import", "module", "node"],
    sourcemap: true,
    legalComments: "external",
    banner: { js: 'import { createRequire as __pmCreateRequire } from "node:module"; const require = __pmCreateRequire(import.meta.url);' },
  });
  for (const name of ["LICENSE", "NOTICE.md", "PROVENANCE.md", "UPSTREAM-SOURCES.md", "upstream.json"]) {
    await cp(path.join(hostRoot, name), path.join(destination, name));
  }
  const files = [];
  for (const name of (await readdir(destination)).sort()) files.push(await fileRecord(destination, name));
  if (!files.some((entry) => entry.path === "main.mjs")) throw new Error("Host bundle missing.");
  const manifest = {
    version: 1,
    implementation: "typescript",
    entry: "main.mjs",
    node: ">=24 <25",
    sourceCommit: HOST_SOURCE_COMMIT,
    upstreamVersion: HOST_UPSTREAM_VERSION,
    files,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(destination, "manifest.json"), manifestBytes);
  return { ...manifest, manifestSha256: sha256(manifestBytes) };
}

export async function verifyHost(buildRoot) {
  const root = path.join(buildRoot, "cc-switch", "host");
  const manifestBytes = await readFile(path.join(root, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.version !== 1 || manifest.implementation !== "typescript" || manifest.entry !== "main.mjs"
    || manifest.sourceCommit !== HOST_SOURCE_COMMIT || manifest.upstreamVersion !== HOST_UPSTREAM_VERSION) {
    throw new Error("Wrong cc-switch TypeScript host manifest.");
  }
  const expected = new Set(["manifest.json"]);
  for (const entry of manifest.files) {
    if (typeof entry.path !== "string" || entry.path.includes("\\") || entry.path.startsWith("/")
      || entry.path.split("/").some((part) => !part || part === "." || part === "..") || expected.has(entry.path)) {
      throw new Error("Unsafe host resource inventory.");
    }
    expected.add(entry.path);
    const record = await fileRecord(root, entry.path);
    if (record.sha256 !== entry.sha256 || record.bytes !== entry.bytes || record.mode !== entry.mode) {
      throw new Error(`Host resource changed: ${entry.path}`);
    }
  }
  for (const name of await readdir(root)) if (!expected.has(name)) throw new Error(`Unknown host resource: ${name}`);
  if (!expected.has("main.mjs")) throw new Error("Host entry missing from manifest.");
  return { ...manifest, manifestSha256: sha256(manifestBytes) };
}
