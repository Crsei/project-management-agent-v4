import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

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
  const notices = [];
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
    notices.push({ name: metadata.name, version: metadata.version ?? null, license: metadata.license ?? null, files });
  }
  await writeFile(join(output, "index.json"), JSON.stringify({ scope: "Installed root, Electron host and Web production dependency notices; Agent exact build-input notices are in ../bundled and ../provenance.", packages: notices }, null, 2) + "\n");
}
