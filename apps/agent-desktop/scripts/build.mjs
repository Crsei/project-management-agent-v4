import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const name of [
  "main.mjs",
  "local-server.mjs",
  "policy.mjs",
  "preload.cjs",
  "connection.html",
  "connection.css",
  "connection.mjs",
]) {
  await cp(join(root, "src", name), join(dist, name));
}
console.log(
  `Desktop application files written to ${dist}. Build Server and Web before local launch; this command does not download Electron or package an installer.`,
);
