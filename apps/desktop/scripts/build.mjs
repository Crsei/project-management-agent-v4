import { cp, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src");
const dist = join(root, "dist");
const previous = await lstat(dist).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
if (previous && (!previous.isDirectory() || previous.isSymbolicLink()))
  throw new Error("Desktop dist must be a real directory; refusing to replace a symlink or caller-owned file.");
const temporary = await mkdtemp(join(root, ".desktop-build-"));
try {
  await cp(source, join(temporary, "dist"), {
    recursive: true,
    filter: async (path) => {
      const name = basename(path);
      if (path === join(source, "backend") || ["node_modules", "tests", "__tests__", ".git"].includes(name) || name.startsWith(".env") || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) return false;
      if ((await lstat(path)).isSymbolicLink()) throw new Error("Desktop source must not contain symlinked application resources.");
      return true;
    },
  });
  await mkdir(root, { recursive: true });
  await rm(dist, { recursive: true, force: true });
  await rename(join(temporary, "dist"), dist);
  console.log(`Desktop host files written to ${dist}. Local launch uses the prepared bundled Node/PostgreSQL runtime; no startup downloads.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
