import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import { ensureElectron } from "./ensure-electron.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  await access(join(root, "dist", "main.mjs")).catch(() => {
    throw new Error(
      "Desktop files have not been built. Run pnpm --filter @agent-workspace/desktop build first.",
    );
  });
  const executable = await ensureElectron();
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [root, ...process.argv.slice(2)], {
    env: environment,
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.once("error", (cause) => {
    console.error(
      `Cannot launch Electron: ${cause.message}. Use a supported graphical OS with Electron system libraries and sandbox support.`,
    );
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (code !== 0 || signal)
      console.error(
        `Electron exited (${signal || code}). Check the OS runtime/GUI libraries; do not disable the renderer sandbox to bypass an unsupported host.`,
      );
    process.exitCode = code ?? 1;
  });
} catch (cause) {
  console.error(cause.message);
  process.exitCode = 1;
}
