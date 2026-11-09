import { spawn } from "node:child_process";
import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const integration = new Set([
  "src/managed-postgres.test.mjs",
  "src/windows-private-state.test.mjs",
  "src/backend/bootstrap.test.ts",
  "src/backend/maintenance.test.ts",
]);
const lifecycle = new Set([
  "src/local-process.test.mjs",
  "src/local-server.test.mjs",
  "src/main.close.test.mjs",
  "src/main.security.test.mjs",
  "src/private-state.test.mjs",
  "src/uninstall.test.mjs",
]);
const release = new Set(["scripts/release-materials.test.mjs"]);
const phases = {
  contracts: { timeout: 120_000, concurrency: 2 },
  lifecycle: { timeout: 180_000, concurrency: 1 },
  integration: { timeout: 900_000, concurrency: 1 },
  release: { timeout: 300_000, concurrency: 1 },
};
const selected = process.argv[2] ?? "all";
if (process.argv.length > 3 || (selected !== "all" && !Object.hasOwn(phases, selected))) {
  throw new Error("Usage: node scripts/test.mjs [all|contracts|lifecycle|integration|release]");
}
const files = globSync(["src/*.test.mjs", "src/backend/*.test.mjs", "src/backend/*.test.ts", "scripts/*.test.mjs"], { cwd: root })
  .map(path => path.replaceAll("\\", "/")).sort();
for (const file of [...integration, ...lifecycle, ...release]) {
  if (!files.includes(file)) throw new Error(`Desktop test phase references a missing file: ${file}`);
}
for (const [phase, options] of Object.entries(phases)) {
  if (selected !== "all" && selected !== phase) continue;
  const members = files.filter(file => (integration.has(file) ? "integration" : lifecycle.has(file) ? "lifecycle" : release.has(file) ? "release" : "contracts") === phase);
  if (!members.length) throw new Error(`Desktop test phase is empty: ${phase}`);
  console.log(`Desktop ${phase}: ${members.length} files; concurrency ${options.concurrency}; test deadline ${options.timeout}ms`);
  const child = spawn(process.execPath, ["--test", `--test-concurrency=${options.concurrency}`, `--test-timeout=${options.timeout}`, ...members], {
    cwd: root, env: process.env, stdio: "inherit", windowsHide: true,
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(`Desktop ${phase} terminated by ${signal}`)) : resolve(code));
  });
  if (code !== 0) { process.exitCode = code ?? 1; break; }
}
