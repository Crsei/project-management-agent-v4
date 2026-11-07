import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

// Only version/help queries run here. In particular, do not invoke package
// installation, application configuration or live services.
export async function inspectBuildPrerequisites({
  root = repositoryRoot,
  platform = process.platform,
  nodeVersion = process.versions.node,
  env = process.env,
  run = spawnSync,
} = {}) {
  const nodePin = (await readFile(path.join(root, ".node-version"), "utf8")).trim();
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const pnpmPin = /^pnpm@(\d+\.\d+\.\d+)(?:\+sha\d+\..+)?$/.exec(manifest.packageManager)?.[1];
  if (!/^\d+\.\d+\.\d+$/.test(nodePin) || !pnpmPin) {
    throw new Error("Build tool pins must specify exact Node and pnpm versions.");
  }

  const checks = [{ name: "Node.js", ok: nodeVersion === nodePin, detail: `required ${nodePin}; found ${nodeVersion}` }];
  const cwd = path.join(root, "apps/server/cc-switch-host");
  const queryEnvironment = {
    ...env,
    // Corepack and pnpm must fail instead of fetching a missing package manager.
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
    npm_config_manage_package_manager_versions: "false",
  };
  const query = (command, args, shell = false) => {
    const result = run(command, args, {
      cwd,
      env: queryEnvironment,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      shell,
    });
    return {
      ok: !result.error && result.status === 0,
      status: result.error ? null : result.status,
      text: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
    };
  };
  const version = (name, command, args, expected, expression, shell = false) => {
    const result = query(command, args, shell);
    const found = expression.exec(result.text)?.[1];
    checks.push({ name, ok: result.ok && found === expected, detail: `required ${expected}; ${found ? `found ${found}` : "not available (no tool was installed)"}` });
  };
  version("pnpm", platform === "win32" ? "pnpm.cmd" : "pnpm", ["--version"], pnpmPin, /^(\d+\.\d+\.\d+)$/m, platform === "win32");

  const tool = (name, command, args) => {
    const result = query(command, args);
    checks.push({ name, ok: result.ok, detail: result.ok ? "available" : `required command ${command} is unavailable` });
  };
  if (platform === "win32") {
    tool("MSVC C/C++ compiler", "cl.exe", ["/?"]);
    const linker = query("link.exe", ["/?"]);
    // MSVC returns 1100 for successful help queries. Require recognizable help,
    // without linker diagnostics, rather than accepting arbitrary nonzero exits.
    const linkerHelp = linker.status === 1100
      && /^Microsoft \(R\) Incremental Linker Version /m.test(linker.text)
      && /^\s*\/OUT:filename\s*$/m.test(linker.text)
      && !/\bLNK\d{4}\b/.test(linker.text);
    checks.push({ name: "MSVC linker", ok: linker.ok || linkerHelp, detail: linker.ok || linkerHelp ? "available" : "required command link.exe is unavailable" });
    tool("Windows SDK resource compiler", "rc.exe", ["/?"]);
  } else if (platform === "darwin") {
    tool("Xcode C compiler", "xcrun", ["--find", "clang"]);
    tool("Xcode C++ compiler", "xcrun", ["--find", "clang++"]);
    tool("Xcode linker", "xcrun", ["--find", "ld"]);
    tool("make", "make", ["--version"]);
    tool("pkg-config", "pkg-config", ["--version"]);
  } else if (platform === "linux") {
    tool("C compiler", "cc", ["--version"]);
    tool("C++ compiler", "c++", ["--version"]);
    tool("linker", "ld", ["--version"]);
    tool("make", "make", ["--version"]);
    tool("pkg-config", "pkg-config", ["--version"]);
  } else {
    checks.push({ name: "Native platform", ok: false, detail: `unsupported platform ${platform}` });
  }
  return checks;
}

export async function assertBuildPrerequisites(options) {
  const checks = await inspectBuildPrerequisites(options);
  const failures = checks.filter((check) => !check.ok);
  if (failures.length) {
    throw new Error(`Build preflight failed before changing build output:\n${failures.map((check) => `- ${check.name}: ${check.detail}`).join("\n")}\nInstall/configure these prerequisites explicitly, then rerun node scripts/doctor.mjs. No tools were downloaded or application data accessed.`);
  }
  return checks;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error("Usage: node scripts/doctor.mjs (read-only build prerequisites; no installation or service checks)");
    const checks = await assertBuildPrerequisites();
    console.log(checks.map((check) => `OK ${check.name}: ${check.detail}`).join("\n"));
    console.log("Build prerequisites available. Dependencies, services and Provider readiness were not checked.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Build preflight failed.");
    process.exitCode = 1;
  }
}
