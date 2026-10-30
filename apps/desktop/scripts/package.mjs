import { spawn } from "node:child_process";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(root, "../..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const rootManifest = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
if (!["linux", "darwin", "win32"].includes(process.platform) || !["x64", "arm64"].includes(process.arch))
  throw new Error("Package on the target OS and x64/arm64 architecture; native Agent dependencies cannot be cross-packaged.");
if (!process.env.npm_execpath)
  throw new Error("Run through pnpm: pnpm --filter @agent-workspace/desktop package");
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY)
  process.env.ELECTRON_GET_USE_PROXY ||= "1";
const { packager } = await import("@electron/packager");

function run(command, args, cwd = repository) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${command} ${args.join(" ")} failed (${signal || code}).`)));
  });
}
const pnpm = (args, cwd) => run(process.execPath, [process.env.npm_execpath, ...args], cwd);

async function inspectDeployment(directory, boundary) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = await realpath(path);
      const within = relative(boundary, target);
      if (within === ".." || within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(within))
        throw new Error(`Deployment contains an external symlink: ${path} -> ${target}`);
    } else if (info.isDirectory()) await inspectDeployment(path, boundary);
  }
}

const staging = await mkdtemp(join(tmpdir(), "pm-agent-v4-desktop-"));
try {
  for (const name of ["@agent-workspace/contracts", "@agent-workspace/client-runtime", "@agent-workspace/server", "@pm/web"])
    await pnpm(["--filter", name, "build"]);
  await run(process.execPath, [join(root, "scripts", "build.mjs")]);
  const application = join(staging, "application");
  const workspace = join(staging, "workspace");
  const runtime = join(staging, "runtime");
  await mkdir(workspace);
  for (const file of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"])
    await cp(join(repository, file), join(workspace, file));
  await cp(join(repository, "patches"), join(workspace, "patches"), { recursive: true });
  // Isolate pnpm legacy deployment from the checkout's installed dependency graph.
  for (const location of ["apps/server/agent", "packages/agent-contracts", "packages/agent-client-runtime"]) {
    const target = join(workspace, location);
    await mkdir(target, { recursive: true });
    await cp(join(repository, location, "package.json"), join(target, "package.json"));
    await cp(join(repository, location, "dist"), join(target, "dist"), { recursive: true });
  }
  await pnpm(["--filter", rootManifest.name, "--config.hoist-workspace-packages=false", "deploy", "--prod", "--legacy", runtime], workspace);
  // Only dependencies and the module-type manifest from the root deployment are needed.
  for (const entry of await readdir(runtime))
    if (!["node_modules", "package.json"].includes(entry)) await rm(join(runtime, entry), { recursive: true, force: true });
  const agent = join(runtime, "apps/server/agent");
  await mkdir(dirname(agent), { recursive: true });
  await pnpm(["--filter", "@agent-workspace/server", "--config.hoist-workspace-packages=false", "deploy", "--prod", "--legacy", agent], workspace);
  await mkdir(join(runtime, "apps/server/pm"), { recursive: true });
  await mkdir(join(runtime, "apps/server/worker"), { recursive: true });
  await cp(join(repository, "apps/server/pm/src"), join(runtime, "apps/server/pm/src"), { recursive: true });
  await cp(join(repository, "apps/server/worker/src"), join(runtime, "apps/server/worker/src"), { recursive: true });
  await cp(join(repository, "apps/server/gateway.ts"), join(runtime, "apps/server/gateway.ts"));
  await cp(join(repository, "packages"), join(runtime, "packages"), {
    recursive: true,
    filter: (path) => !["node_modules", "tests", "dist"].includes(path.split(/[\\/]/).at(-1)),
  });
  await mkdir(join(runtime, "apps/web"), { recursive: true });
  await cp(join(repository, "apps/web/dist"), join(runtime, "apps/web/dist"), { recursive: true });
  for (const file of ["apps/server/pm/src/main.ts", "apps/server/worker/src/main.ts", "apps/server/agent/dist/index.mjs", "apps/server/agent/dist/agents/claude-history-worker.mjs", "apps/server/gateway.ts", "apps/web/dist/index.html"])
    await access(join(runtime, file));
  await inspectDeployment(runtime, runtime);
  const require = createRequire(join(agent, "package.json"));
  require.resolve("@lydell/node-pty");
  const sdkRequire = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
  const nativeRoot = dirname(sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`));
  await access(join(nativeRoot, process.platform === "win32" ? "claude.exe" : "claude"));
  await mkdir(application);
  await cp(join(root, "dist"), join(application, "dist"), { recursive: true });
  await writeFile(join(application, "package.json"), JSON.stringify({
    name: "pm-agent-v4-desktop", productName: "PM Agent v4", version: manifest.version,
    type: "module", main: "dist/main.mjs", description: manifest.description, private: true,
  }, null, 2));
  await writeFile(join(application, "runtime-requirements.json"), JSON.stringify({
    node: "Node 24 LTS external executable", database: "User-provided, running and migrated PostgreSQL; not bundled",
    configuration: "~/.pmv4/.env and ~/.pmv4/.env.worker are required; ~/.pmv4/.env.agent is optional. Configure storage and the database before connecting.",
    ports: "127.0.0.1:3224 public, 4194 PM, 4325 Agent; all must be free",
    data: "Desktop and Agent data use v4-specific userData; project root is selected by the user",
    lifecycle: "Closing the workspace window keeps local tasks running; Quit stops only this desktop's own processes.",
    distribution: "Unsigned application directory, no installer or updates; native binaries match the build OS and architecture.",
  }, null, 2));
  const output = await packager({
    dir: application, name: "PM Agent v4", executableName: "PM Agent v4",
    appBundleId: "com.projectmanagementagent.v4", appCategoryType: "public.app-category.developer-tools",
    appVersion: manifest.version, electronVersion: manifest.devDependencies.electron,
    platform: process.platform, arch: process.arch, out: join(root, "release"), overwrite: true, asar: true, prune: false,
  });
  for (const directory of output) {
    const resources = process.platform === "darwin" ? join(directory, "PM Agent v4.app", "Contents", "Resources") : join(directory, "resources");
    const packagedRuntime = join(resources, "workspace-runtime");
    await cp(runtime, packagedRuntime, { recursive: true, verbatimSymlinks: true });
    await inspectDeployment(packagedRuntime, packagedRuntime);
    const executable = process.platform === "darwin" ? join(directory, "PM Agent v4.app", "Contents", "MacOS", "PM Agent v4") : join(directory, process.platform === "win32" ? "PM Agent v4.exe" : "PM Agent v4");
    await access(executable);
    console.log(`Runnable desktop application: ${executable}`);
  }
  console.log("Distribute the complete directory. Node 24 and a user-managed PostgreSQL database are required; no credentials or PostgreSQL are bundled.");
} finally {
  await rm(staging, { recursive: true, force: true });
}
