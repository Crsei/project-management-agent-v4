import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

export async function ensureElectron() {
  const installer = require.resolve("electron/install.js");
  const root = dirname(installer);
  const environment = { ...process.env };
  if (environment.HTTPS_PROXY || environment.HTTP_PROXY || environment.ALL_PROXY)
    environment.ELECTRON_GET_USE_PROXY ||= "1";
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [installer], { stdio: "inherit", env: environment });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Electron runtime installation failed (${signal || code}). Check network/proxy access to Electron releases, then run pnpm --filter @agent-workspace/desktop runtime:install.`,
            ),
          ),
    );
  });
  const relative = (await readFile(join(root, "path.txt"), "utf8")).trim();
  const executable = join(process.env.ELECTRON_OVERRIDE_DIST_PATH || join(root, "dist"), relative);
  await access(executable);
  return executable;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(`Electron runtime ready: ${await ensureElectron()}`);
  } catch (cause) {
    console.error(cause.message);
    process.exitCode = 1;
  }
}
