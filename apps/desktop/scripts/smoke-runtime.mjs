import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { defaultRuntimeRoot, NODE_VERSION, POSTGRES_VERSION, requireNativeTarget, verifyRuntime } from "./runtime-manifest.mjs";

if (process.argv.length !== 2 && (process.argv.length !== 4 || process.argv[2] !== "--runtime-root"))
  throw new Error("Usage: smoke-runtime.mjs [--runtime-root DIRECTORY]");
const root = resolve(process.argv[3] ?? process.env.PM_DESKTOP_RUNTIME_ROOT ?? defaultRuntimeRoot);
const target = requireNativeTarget();
const manifest = await verifyRuntime(root, target);
const environment = Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
environment.PATH = "";
async function version(executable) {
  return new Promise((done, reject) => {
    const child = spawn(executable, ["--version"], { env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Bundled runtime version check timed out.")); }, 15_000);
    child.stdout.on("data", (bytes) => { stdout += bytes; });
    child.once("error", () => { clearTimeout(timer); reject(new Error("Cannot execute the prepared native runtime on this host.")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) done(stdout.trim());
      else reject(new Error("Bundled native runtime failed. Linux GNU smoke requires Debian12/glibc2.36-compatible OS libraries; use the documented verification container on older hosts."));
    });
  });
}
const node = await version(join(root, "node", process.platform === "win32" ? "node.exe" : "bin/node"));
if (node !== `v${NODE_VERSION}`) throw new Error("Prepared Node version does not match the pinned version.");
const tools = ["postgres", "initdb", "pg_ctl", "pg_dump", "pg_restore", "psql"];
for (const name of tools) {
  const output = await version(join(root, "postgres", "bin", `${name}${process.platform === "win32" ? ".exe" : ""}`));
  if (!output.includes(`(PostgreSQL) ${POSTGRES_VERSION}`)) throw new Error("Prepared PostgreSQL tool version does not match the pinned version.");
}
console.log(JSON.stringify({ target, node: NODE_VERSION, nodeProfile: manifest.nodeDistribution.profile, bundledPackageManagers: false,
  postgres: POSTGRES_VERSION, tools, ambientPathUsed: false, productInstaller: false }));
