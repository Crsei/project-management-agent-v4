import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_SOURCE_COMMIT = "7afceec14b977ecc2f4373e8ffb40e7223b435ac";
export const HOST_UPSTREAM_VERSION = "4.0.25";
const hostRoot = fileURLToPath(new URL("../../cc-switch-host/", import.meta.url));
const hostLegalFiles = ["LICENSE", "NOTICE.md", "PROVENANCE.md", "UPSTREAM-SOURCES.md", "upstream.json"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fileRecord(root, relative) {
  const bytes = await readFile(path.join(root, relative));
  const info = await lstat(path.join(root, relative));
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe host resource: ${relative}`);
  return { path: relative.split(path.sep).join("/"), sha256: sha256(bytes), bytes: bytes.length, mode: info.mode & 0o777 };
}
async function hostFiles(root, relative = "") {
  const files = [];
  for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await hostFiles(root, name));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`Unsafe host resource: ${name}`);
  }
  return files;
}

// Both host builders preserve notices for the actual bundled npm inputs only.
export async function collectHostNotices(metafile, destination) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const absolute = await realpath(path.resolve(hostRoot, input));
    if (!absolute.split(path.sep).includes("node_modules")) continue;
    let directory = path.dirname(absolute);
    while (directory !== path.dirname(directory)) {
      const metadata = await readFile(path.join(directory, "package.json"), "utf8").then(JSON.parse).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (metadata?.name) {
        packages.set(directory, metadata);
        break;
      }
      directory = path.dirname(directory);
    }
    if (!packages.has(directory)) throw new Error(`Cannot identify bundled host dependency: ${input}`);
  }
  const notices = [];
  const ordered = [...packages].sort(([, left], [, right]) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, "en"));
  for (const [index, [directory, metadata]] of ordered.entries()) {
    const files = [];
    async function copyNotice(source, relative) {
      const info = await lstat(source);
      if (info.isSymbolicLink()) throw new Error(`Unsafe host dependency notice: ${metadata.name}: ${relative}`);
      if (info.isDirectory()) {
        for (const name of (await readdir(source)).sort()) await copyNotice(path.join(source, name), `${relative}/${name}`);
      } else if (info.isFile()) {
        const target = `licenses/dependencies/${String(index).padStart(4, "0")}/${relative}`;
        await mkdir(path.dirname(path.join(destination, target)), { recursive: true });
        await cp(source, path.join(destination, target));
        files.push(target);
      } else throw new Error(`Unsupported host dependency notice: ${metadata.name}: ${relative}`);
    }
    for (const name of (await readdir(directory)).sort()) {
      if (/^(?:licen[cs]es?|copying|notices?|copyright|third-party-licenses)(?:[._-]|$)/i.test(name)) {
        await copyNotice(path.join(directory, name), name);
      }
    }
    if (!files.length) throw new Error(`Bundled host dependency has no shipped legal notice: ${metadata.name}@${metadata.version}`);
    notices.push({ name: metadata.name, version: metadata.version ?? null, license: metadata.license ?? null, files });
  }
  const legalRoot = path.join(destination, "licenses", "dependencies");
  await mkdir(legalRoot, { recursive: true });
  await writeFile(path.join(legalRoot, "index.json"), `${JSON.stringify({ scope: "Actual cc-switch TypeScript host bundled npm inputs.", packages: notices }, null, 2)}\n`);
  return Promise.all((await hostFiles(destination)).map((name) => fileRecord(destination, name)));
}


export async function buildHost(outputRoot) {
  const destination = path.join(outputRoot, "cc-switch", "host");
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const result = await build({
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
    metafile: true,
    legalComments: "external",
    banner: { js: 'import { createRequire as __pmCreateRequire } from "node:module"; const require = __pmCreateRequire(import.meta.url);' },
  });
  for (const name of hostLegalFiles) {
    await cp(path.join(hostRoot, name), path.join(destination, name));
  }
  const files = await collectHostNotices(result.metafile, destination);
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

export async function verifyHost(buildRoot, { installationModes = false } = {}) {
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
    let expectedMode = entry.mode;
    // Desktop afterPack canonicalizes POSIX installation permissions while
    // preserving whether source resources were executable. Windows cannot model
    // POSIX group/other bits; retain the existing exact native mode comparison.
    if (installationModes && process.platform !== "win32") {
      if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw new Error(`Host resource changed: ${entry.path}`);
      expectedMode = entry.mode & 0o111 ? 0o755 : 0o644;
    }
    if (record.sha256 !== entry.sha256 || record.bytes !== entry.bytes || record.mode !== expectedMode) {
      throw new Error(`Host resource changed: ${entry.path}`);
    }
  }
  for (const name of await hostFiles(root)) if (!expected.has(name)) throw new Error(`Unknown host resource: ${name}`);
  for (const name of ["main.mjs", ...hostLegalFiles, "licenses/dependencies/index.json"]) {
    if (!expected.has(name)) throw new Error(`Host resource missing from manifest: ${name}`);
  }
  return { ...manifest, manifestSha256: sha256(manifestBytes) };
}
