import { createHash } from "node:crypto";
import { loadNoticeSupplements } from "./supplement-notices.mjs";
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative as pathRelative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const owned = new Map([
  ['apps/desktop','@agent-workspace/desktop'], ['apps/web','@pm/web'],
  ['packages/agent-contracts','@agent-workspace/contracts'], ['packages/agent-client-runtime','@agent-workspace/client-runtime'],
]);
async function ownerEvidence(root, name) {
  const relative = pathRelative(repository, root).split(sep).join('/');
  if (owned.get(relative) === name) return { label:'AGPL-3.0-only (host code; see separate third-party notices)', originals:['LICENSE','THIRD_PARTY_NOTICES.md','vendor/t3code/LICENSE'] };
  const dir = relative.split('/').at(-1);
  if (relative === 'vendor/t3code/packages/' + dir && (name === '@t3tools/' + dir || name === 'effect-acp' && dir === name))
    return { label:'MIT (vendored t3code; local changes and nested dependencies retain their notices)', originals:['vendor/t3code/LICENSE','THIRD_PARTY_NOTICES.md'] };
  return null; // Never apply a workspace grant to an npm package with a similar name.
}
const nestedByPackage = {
  '@bufbuild/protobuf@1.10.0':['dist/cjs/google/varint.js'], // This file carries the actual Google BSD-3-Clause notice.
  '@ai-sdk/provider-utils@5.0.68':['src/to-json-schema/zod3-to-json-schema/LICENSE'],
  'victory-vendor@37.3.6': ['d3-array','d3-color','d3-ease','d3-format','d3-interpolate','d3-path','d3-scale','d3-shape','d3-time','d3-time-format','d3-timer','internmap','d3-voronoi'].map(dir=>'lib-vendor/'+dir+'/LICENSE'),
};

async function locate(name, from) {
  const require = createRequire(join(from, "package.json"));
  for (const directory of require.resolve.paths(name) ?? []) {
    const candidate = join(directory, name);
    const info = await lstat(join(candidate, "package.json")).catch((error) => {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
      throw error;
    });
    if (info?.isFile()) return realpath(candidate);
  }
  return null;
}

// Web bundles do not retain node_modules. Preserve the installed production
// graph's shipped license/notice files alongside the Agent packager's own exact
// bundled-input and on-disk dependency notices.
export async function collectNotices(roots, output) {
  const packages = new Map();
  async function visit(root) {
    root = await realpath(root);
    if (packages.has(root)) return;
    const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    packages.set(root, metadata);
    const dependencies = { ...metadata.peerDependencies, ...metadata.dependencies, ...metadata.optionalDependencies };
    for (const name of Object.keys(dependencies).sort()) {
      const optional = name in (metadata.optionalDependencies ?? {}) || (!metadata.dependencies?.[name] && metadata.peerDependenciesMeta?.[name]?.optional);
      const dependency = await locate(name, root);
      if (!dependency) {
        if (!optional) throw new Error(`Missing installed dependency while collecting distribution notices: ${name}`);
      } else await visit(dependency);
    }
  }
  for (const root of roots) await visit(root);
  await mkdir(output, { recursive: true });
  const notices = [], supplements = await loadNoticeSupplements();
  const ordered = [...packages].sort(([, left], [, right]) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`, "en"));
  for (const [index, [root, metadata]] of ordered.entries()) {
    const files = [];
    for (const name of (await readdir(root)).sort()) {
      if (!/^(?:licen[cs]es?|copying|notices?|copyright|third-party-licenses)(?:[._-]|$)/i.test(name)) continue;
      const info = await lstat(join(root, name));
      if (info.isSymbolicLink()) throw new Error("Dependency notice must not be an external symlink.");
      const path = `${String(index).padStart(4, "0")}/${name}`;
      await mkdir(join(output, String(index).padStart(4, "0")), { recursive: true });
      await cp(join(root, name), join(output, path), { recursive: true });
      files.push(path);
    }
    let source, scopeLicense;
    const nestedFiles = [];
    const folder = String(index).padStart(4, "0");
    const identity = metadata.name + "@" + metadata.version;
    for (const relative of nestedByPackage[identity] ?? []) {
      const original = join(root, relative);
      if (!(await lstat(original)).isFile() || await realpath(original) !== original) throw new Error("Invalid nested notice: " + identity);
      const dest = folder + "/nested/" + relative;
      await mkdir(join(output, dest, ".."), { recursive: true });
      await cp(original, join(output, dest));
      nestedFiles.push(dest);
    }
    if (identity === "khroma@2.1.0" && !metadata.license && files.some(f => f.endsWith("/license"))) {
      const bytes = await readFile(join(root, "license"));
      if (createHash("sha256").update(bytes).digest("hex") !== "66b333b0f66759a0b710459e03f7029abe17f4358114a128d2c972e642961b49") throw new Error("Reviewed khroma license changed");
      scopeLicense = "MIT"; source = "Exact MIT text shipped in khroma@2.1.0/license";
    }
    const owner = await ownerEvidence(root, metadata.name);
    if (!metadata.license && owner) {
      scopeLicense = owner.label;
      for (const original of owner.originals) {
        const dest = folder + "/scope/" + original;
        await mkdir(join(output, dest, ".."), { recursive: true });
        await cp(join(repository, original), join(output, dest));
        files.push(dest);
      }
      source = "Enclosing project scope: " + pathRelative(repository, root).split(sep).join("/");
    }
    if (!files.length) {
      const match = supplements.get(metadata.name + "@" + metadata.version);
      if (match) {
        if (match.license !== metadata.license) throw new Error("Supplemental notice license differs from the installed manifest: " + metadata.name);
        const folder = String(index).padStart(4, "0");
        await mkdir(join(output, folder), { recursive: true });
        await writeFile(join(output, folder, "UPSTREAM-LICENSE.txt"), match.bytes);
        files.push(folder + "/UPSTREAM-LICENSE.txt");
        source = match.source;
      } else {
        // Several exact npm tarballs ship a complete MIT notice only inside README.
        // Preserve the actual upstream bytes rather than inferring text from SPDX.
        for (const name of (await readdir(root)).filter(n => /^readme(?:\.md|\.txt)?$/i.test(n))) {
          const info = await lstat(join(root, name));
          if (!info.isFile() || info.size > 1024 * 1024 || metadata.license !== "MIT") continue;
          const bytes = await readFile(join(root, name));
          const normalized = bytes.toString("utf8").replace(/\s+/g, " ");
          if (!/copyright.{1,200}permission is hereby granted, free of charge/i.test(normalized) || !normalized.includes("THE SOFTWARE IS PROVIDED") || !/DEALINGS IN THE SOFTWARE/i.test(normalized)) continue;
          const folder = String(index).padStart(4, "0");
          await mkdir(join(output, folder), { recursive: true });
          await writeFile(join(output, folder, name), bytes);
          files.push(folder + "/" + name);
          source = "Actual installed package: " + name;
          break;
        }
      }
    }
    notices.push({ ...(source ? { source } : {}), name: metadata.name, version: metadata.version ?? null, license: metadata.license ?? scopeLicense ?? null, ...(scopeLicense ? { packageLicenseField: null } : {}), ...(nestedFiles.length ? { nestedFiles } : {}), files });
  }
  await writeFile(join(output, "index.json"), JSON.stringify({ scope: "Installed root, Electron host and Web production dependency notices; Agent exact build-input notices are in ../bundled and ../provenance.", packages: notices }, null, 2) + "\n");
}
