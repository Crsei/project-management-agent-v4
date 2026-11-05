#!/usr/bin/env node
// Fails when removed EasyuseUI packages, vendor paths, build switches or the
// retired Showcase lab route reappear in runtime source, config or manifests.
// Historical/provenance docs and this script's own pattern list are excluded.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const self = fileURLToPath(import.meta.url);

const roots = [
  "apps/web/src",
  "apps/server/agent/src",
  "scripts",
  "deploy",
];
const files = [
  "package.json",
  "apps/web/package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
];

const forbidden = [
  ["@easyuse-ui", "@easyuse-ui package name"],
  ["easyuseui", "retired EasyuseUI identifier"],
  ["easyuse-ui", "retired EasyuseUI package/identifier"],
  ["data-eu-", "retired EasyuseUI data attribute"],
  ["vendor/ui", "removed vendor/ui path"],
  ["vendor/agent-workspace-views", "removed vendor/agent-workspace-views path"],
  ["vendor/workspace-protocol", "removed vendor/workspace-protocol path"],
  ["VITE_ENABLE_UI_LAB", "retired UI lab build switch"],
  ["/agent/showcase", "retired Showcase route"],
];

const skippedDirectories = new Set([
  ".git",
  ".local",
  "coverage",
  "dist",
  "docs",
  "node_modules",
]);

async function collect(relative, output) {
  let entries;
  try {
    entries = await readdir(path.join(root, relative), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) await collect(child, output);
    } else if (entry.isFile() && child !== "THIRD_PARTY_NOTICES.md") {
      output.push(child);
    }
  }
}

const targets = [];
for (const relative of files) {
  targets.push(relative);
}
for (const relative of roots) await collect(relative, targets);

const hits = [];
let scanned = 0;
for (const relative of targets) {
  if (path.resolve(root, relative) === self) continue;
  let text;
  try {
    text = await readFile(path.join(root, relative), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  scanned++;
  if (text.includes("\u0000")) continue;
  const lines = text.split("\n");
  for (const [needle, reason] of forbidden) {
    const lowerNeedle = needle.toLowerCase();
    lines.forEach((line, index) => {
      if (line.toLowerCase().includes(lowerNeedle)) hits.push(`${relative}:${index + 1}: ${reason} (${needle})`);
    });
  }
}

if (hits.length) {
  console.error(`Forbidden EasyuseUI/Showcase reference found in ${scanned} scanned file(s):`);
  for (const hit of hits) console.error(`  ${hit}`);
  console.error("Remove the reference or update this guard if the removal decision changed.");
  process.exitCode = 1;
} else {
  console.log(`No EasyuseUI/Showcase references in ${scanned} runtime/config file(s).`);
}
