import { spawn } from "node:child_process";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "../..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (
  !["linux", "darwin", "win32"].includes(process.platform) ||
  !["x64", "arm64"].includes(process.arch)
) {
  throw new Error(
    "Package on the target OS and x64/arm64 architecture. Cross-packaging native Server PTY dependencies is not supported.",
  );
}
if (!process.env.npm_execpath)
  throw new Error("Run this command through pnpm: pnpm --filter @agent-workspace/desktop package");
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY)
  process.env.ELECTRON_GET_USE_PROXY ||= "1";
// @electron/get reads the proxy flag when the module is first evaluated.
const { packager } = await import("@electron/packager");

function run(command, args, cwd = repository) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolveRun()
        : reject(new Error(`${command} ${args.join(" ")} failed (${signal || code}).`)),
    );
  });
}
const pnpm = (args, cwd) => run(process.execPath, [process.env.npm_execpath, ...args], cwd);

// Deploy copies the actual production dependency graph, including platform PTY binaries and Claude SDK.
// Reject external symlinks so a release cannot accidentally depend on the checkout's node_modules.
async function inspectDeployment(directory, boundary) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = await realpath(path);
      const within = relative(boundary, target);
      if (
        within === ".." ||
        within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
        isAbsolute(within)
      ) {
        throw new Error(`Production deployment contains an external symlink: ${path} -> ${target}`);
      }
    } else if (info.isDirectory()) await inspectDeployment(path, boundary);
  }
}

const staging = await mkdtemp(join(tmpdir(), "agent-workspace-desktop-"));
try {
  for (const name of ["contracts", "client-runtime", "server", "web"])
    await pnpm(["--filter", `@agent-workspace/${name}`, "build"]);
  await run(process.execPath, [join(root, "scripts", "build.mjs")]);
  const application = join(staging, "application");
  const server = join(staging, "workspace-server");
  const web = join(staging, "workspace-web");
  // pnpm 11 legacy deploy records production-only workspace state. Isolate it
  // from the checkout so the next development command cannot prune dev tools.
  const deployWorkspace = join(staging, "workspace");
  await mkdir(deployWorkspace);
  for (const file of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"])
    await cp(join(repository, file), join(deployWorkspace, file));
  for (const location of ["apps/agent-server", "packages/agent-contracts", "packages/agent-client-runtime"]) {
    const target = join(deployWorkspace, location);
    await mkdir(target, { recursive: true });
    await cp(join(repository, location, "package.json"), join(target, "package.json"));
    await cp(join(repository, location, "dist"), join(target, "dist"), { recursive: true });
  }
  await mkdir(application);
  await cp(join(root, "dist"), join(application, "dist"), { recursive: true });
  await writeFile(
    join(application, "package.json"),
    JSON.stringify(
      {
        name: "agent-workspace-desktop",
        productName: "Agent Workspace",
        version: manifest.version,
        type: "module",
        main: "dist/main.mjs",
        description: manifest.description,
        private: true,
      },
      null,
      2,
    ),
  );
  // The deployed graph must not hoist checkout-only workspace self-links.
  await pnpm(
    [
      "--filter",
      "@agent-workspace/server",
      "--config.hoist-workspace-packages=false",
      "deploy",
      "--prod",
      "--legacy",
      server,
    ],
    deployWorkspace,
  );
  await cp(join(repository, "apps", "agent-web", "dist"), web, { recursive: true });
  for (const file of [
    join(server, "dist", "index.mjs"),
    join(server, "dist", "agents", "claude-history-worker.mjs"),
    join(web, "index.html"),
    join(web, "ui-lab.json"),
  ])
    await access(file);
  await inspectDeployment(server, server);
  const require = createRequire(join(server, "package.json"));
  require.resolve("@lydell/node-pty");
  const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
  const nativePackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const sdkRequire = createRequire(sdkEntry);
  const nativeRoot = dirname(sdkRequire.resolve(`${nativePackage}/package.json`));
  await access(join(nativeRoot, process.platform === "win32" ? "claude.exe" : "claude"));
  await writeFile(
    join(application, "runtime-requirements.json"),
    JSON.stringify(
      {
        node: "24 LTS (external executable; selected in Connection Settings or AGENT_WORKSPACE_NODE)",
        electron: manifest.devDependencies.electron,
        platform: process.platform,
        architecture: process.arch,
        dataDirectory: "AGENT_WORKSPACE_DATA_DIR or v3-owned .local/agent-data; never bundled",
        projectRoot:
          "AGENT_WORKSPACE_PROJECT_ROOT or saved selection; packaged default v3 app-data/projects",
        nativeDependencies: "Server production Node PTY binary; never rebuilt for the Electron ABI",
        providers:
          "API credentials configured by user; Codex/Claude CLI executables required only for those providers",
        lifecycle:
          "Closing workspace keeps Server running; Quit stops owned local Server and workers. No schedules while quit.",
        distribution:
          "Unsigned application directory; no installer, automatic updates or signing service",
      },
      null,
      2,
    ),
  );
  const output = await packager({
    dir: application,
    name: "Agent Workspace",
    executableName: "Agent Workspace",
    appBundleId: "com.agentworkspace.desktop",
    appCategoryType: "public.app-category.developer-tools",
    appVersion: manifest.version,
    electronVersion: manifest.devDependencies.electron,
    platform: process.platform,
    arch: process.arch,
    out: join(root, "release"),
    overwrite: true,
    asar: true,
    prune: false,
  });
  for (const directory of output) {
    const resources =
      process.platform === "darwin"
        ? join(directory, "Agent Workspace.app", "Contents", "Resources")
        : join(directory, "resources");
    const packagedServer = join(resources, "workspace-server");
    // Packager's extraResource copy resolves relative pnpm links against staging.
    // Preserve their spelling so the application remains relocatable after cleanup.
    await cp(server, packagedServer, { recursive: true, verbatimSymlinks: true });
    await cp(web, join(resources, "workspace-web"), { recursive: true, verbatimSymlinks: true });
    await inspectDeployment(packagedServer, packagedServer);
    const executable =
      process.platform === "darwin"
        ? join(directory, "Agent Workspace.app", "Contents", "MacOS", "Agent Workspace")
        : join(directory, process.platform === "win32" ? "Agent Workspace.exe" : "Agent Workspace");
    await access(executable);
    console.log(`Runnable desktop application: ${executable}`);
  }
  console.log(
    "Distribute the complete output directory. Install external Node >=22.18.0 on the target computer. Use a supported graphical OS and sandbox; packaged native PTY matches this build OS/architecture. No credentials or .env files are bundled.",
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
