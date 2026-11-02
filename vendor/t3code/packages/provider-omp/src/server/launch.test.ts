import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { buildOmpRpcLaunch, resolveOmpLaunchArgs, resolveOmpNativeHome } from "./launch.ts";
import { assertOmpStartupSafe } from "./startupPolicy.ts";

function cleanEnvironment(run: (input: { home: string; cwd: string; root: string; environment: NodeJS.ProcessEnv }) => void): void {
  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "omp-launch-policy-"));
  const home = Path.join(root, "home");
  const cwd = Path.join(root, "project", "nested");
  Fs.mkdirSync(home, { recursive: true });
  Fs.mkdirSync(cwd, { recursive: true });
  try { run({ home, cwd, root, environment: { HOME: home } }); }
  finally { Fs.rmSync(root, { force: true, recursive: true }); }
}

 describe("OMP host-owned launch", () => {
  it.each([
    "--yolo", "--auto-approve", "--approval-mode=always-ask", "--config=some.yml",
    "--mode rpc-ui", "--no-ui", "--session a", "--session-dir a", "--cwd /tmp", "--profile work",
    "--extension a", "--trusted-extension a", "--hook a", "--plugin-dir a", "--tools read",
    "--provider openai", "--model gpt", "--thinking high", "--api-key secret", "--unknown=yes", "@file", "-- prompt", "prompt",
  ])("rejects protocol, identity, policy, configuration and unknown override: %s", (args) => {
    assert.isFalse(resolveOmpLaunchArgs(args).ok);
  });

  it("normalizes only a closed safe option set and validates consumed values", () => {
    assert.deepEqual(resolveOmpLaunchArgs('--no-skills --max-cost="1.25" --max-time 30'), {
      ok: true, args: ["--no-skills", "--max-cost", "1.25", "--max-time", "30"],
    });
    assert.isFalse(resolveOmpLaunchArgs("--max-cost --yolo").ok);
    assert.isFalse(resolveOmpLaunchArgs("--max-time 0").ok);
    assert.isFalse(resolveOmpLaunchArgs("--no-title=false").ok);
  });

  it("requires an exact host permission extension and cannot inherit a stale PM bridge", () => cleanEnvironment(({ home, cwd, environment }) => {
    assert.throws(() => buildOmpRpcLaunch({ launchArgs: [], environment, cwd, homeDirectory: home }));
    const launch = buildOmpRpcLaunch({
      launchArgs: [], cwd, homeDirectory: home,
      environment: { ...environment, AGENT_OMP_GATE: "stale", AGENT_PM_TOOL_BRIDGE: "stale", T3_MCP_BEARER_TOKEN: "stale", NATIVE_MODEL_ENV: "preserved" },
      extensionPath: Path.join(home, "owned-gate.mjs"), permissionEnvironment: { AGENT_OMP_GATE: "live" },
    });
    assert.deepEqual(launch.args.slice(0, 4), ["--mode", "rpc-ui", "--approval-mode", "always-ask"]);
    assert.include(launch.args, "--trusted-extension");
    assert.notInclude(launch.args, "--no-ui");
    assert.equal(launch.env.AGENT_OMP_GATE, "live");
    assert.isUndefined(launch.env.AGENT_PM_TOOL_BRIDGE);
    assert.isUndefined(launch.env.T3_MCP_BEARER_TOKEN);
    assert.equal(launch.env.NATIVE_MODEL_ENV, "preserved");
    assert.throws(() => buildOmpRpcLaunch({ launchArgs: [], environment, cwd, disableTools: true, permissionEnvironment: { HOME: "/other" } }));
  }));

  it("keeps clean native Home and model configuration without reading credential files", () => cleanEnvironment(({ home, cwd, environment }) => {
    const agent = Path.join(home, ".omp", "agent");
    Fs.mkdirSync(agent, { recursive: true });
    Fs.writeFileSync(Path.join(agent, "config.yml"), "modelRoles:\n  default: local/model\n");
    Fs.writeFileSync(Path.join(agent, "agent.db"), "not-a-readable-credential-database", { mode: 0 });
    const launch = buildOmpRpcLaunch({ launchArgs: [], environment, cwd, ephemeral: true, disableTools: true, disableExtensions: true });
    assert.equal(launch.env.HOME, home);
    assert.include(launch.args, "--no-tools");
    assert.include(launch.args, "--no-session");
    assert.notInclude(launch.args, "--model");
  }));

  it.each([
    ".omp/tools/native.ts", ".claude/tools/custom.js", ".codex/tools/custom.ts",
    ".omp/mcp.json", ".claude/.mcp.json", ".codex/config.toml", ".gemini/settings.json",
    ".cursor/mcp.json", ".windsurf/mcp_config.json", ".vscode/mcp.json", "opencode.jsonc",
    ".opencode/opencode.json", ".mcp.json", ".env",
  ])("refuses real cwd startup sources before spawning: %s", (relative) => cleanEnvironment(({ home, cwd, environment }) => {
    const source = Path.join(cwd, relative);
    Fs.mkdirSync(Path.dirname(source), { recursive: true });
    Fs.writeFileSync(source, "untrusted contents that must not be parsed or run");
    assert.throws(() => buildOmpRpcLaunch({ launchArgs: [], environment, cwd, homeDirectory: home, disableTools: true }), /startup refused/i);
  }));

  it("does not treat ordinary VS Code settings as an OMP startup source", () => cleanEnvironment(({ cwd, root, environment }) => {
    for (const base of [cwd, Path.join(root, "project")]) {
      Fs.mkdirSync(Path.join(base, ".vscode"), { recursive: true });
      Fs.writeFileSync(Path.join(base, ".vscode", "settings.json"), '{"editor.tabSize":2}');
    }
    assert.doesNotThrow(() => buildOmpRpcLaunch({ launchArgs: [], environment, cwd, disableTools: true }));
    Fs.writeFileSync(Path.join(cwd, ".vscode", "mcp.json"), "uninspected native MCP source");
    assert.throws(() => buildOmpRpcLaunch({ launchArgs: [], environment, cwd, disableTools: true }), /startup refused/i);
  }));

  it.each([
    "mcp.json", ".mcp.json", ".vscode/mcp.json", ".vscode/settings.json",
    ".omp/mcp.json", ".omp/tools/unloaded.ts", ".claude/tools/unloaded.js",
    ".codex/config.toml", ".gemini/settings.json", "opencode.json", ".env",
  ])("does not invent an ancestor loader for cwd-only source %s", (relative) => cleanEnvironment(({ cwd, root, environment }) => {
    const source = Path.join(root, "project", relative);
    Fs.mkdirSync(Path.dirname(source), { recursive: true });
    Fs.writeFileSync(source, "not loaded from an ancestor by the pinned CLI");
    assert.doesNotThrow(() => buildOmpRpcLaunch({ launchArgs: [], environment, cwd, disableTools: true }));
  }));

  it.each([
    ".vscode/config.toml", ".cursor/settings.json", ".gemini/mcp.json",
    ".windsurf/settings.json", ".codex/settings.json", ".opencode/mcp.json",
  ])("does not reject unrelated filenames by cross-multiplying provider roots: %s", (relative) => cleanEnvironment(({ cwd, environment }) => {
    const source = Path.join(cwd, relative);
    Fs.mkdirSync(Path.dirname(source), { recursive: true });
    Fs.writeFileSync(source, "not an executable startup input for this provider");
    assert.doesNotThrow(() => buildOmpRpcLaunch({ launchArgs: [], environment, cwd, disableTools: true }));
  }));

  it("retains the actual ancestor plugin registry boundary", () => cleanEnvironment(({ cwd, root, environment }) => {
    const registry = Path.join(root, "project", ".omp", "plugins", "installed_plugins.json");
    Fs.mkdirSync(Path.dirname(registry), { recursive: true });
    Fs.writeFileSync(registry, "uninspected marketplace source");
    assert.throws(() => buildOmpRpcLaunch({ launchArgs: [], environment, cwd, disableTools: true }), /startup refused/i);
  }));

  it.each(["profile-mcp", "claude-config", "xdg-registry", "native-plugin"] as const)(
    "rejects the active native %s startup source",
    (kind) => cleanEnvironment(({ home, cwd, root }) => {
      const environment = { HOME: home, OMP_PROFILE: "work", CLAUDE_CONFIG_DIR: Path.join(root, "claude-other"), XDG_DATA_HOME: Path.join(root, "xdg") };
      const nativeHome = resolveOmpNativeHome({ environment, homeDirectory: home, cwd });
      const source = kind === "profile-mcp" ? Path.join(nativeHome.agentDirectory, "mcp.json")
        : kind === "claude-config" ? Path.join(environment.CLAUDE_CONFIG_DIR, ".claude.json")
        : kind === "xdg-registry" ? Path.join(environment.XDG_DATA_HOME, "omp", "profiles", "work", "plugins", "installed_plugins.json")
        : Path.join(nativeHome.configRoot, "plugins", "node_modules", "custom", "index.js");
      Fs.mkdirSync(Path.dirname(source), { recursive: true });
      Fs.writeFileSync(source, "untrusted");
      assert.throws(() => assertOmpStartupSafe({ environment, cwd, homeDirectory: home, nativeHome }));
    }),
  );

  it("preserves native profile and XDG identity rules rather than using Pi directories", () => {
    const home = Path.resolve("/native-home");
    const xdg = Path.resolve("/native-data");
    const native = resolveOmpNativeHome({
      environment: { OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/ignored-by-profile", XDG_DATA_HOME: xdg },
      homeDirectory: home, platform: "linux", exists: () => true,
    });
    assert.equal(native.agentDirectory, Path.join(home, ".omp", "profiles", "work", "agent"));
    assert.equal(native.sessionsDirectory, Path.join(xdg, "omp", "profiles", "work", "sessions"));
    assert.equal(resolveOmpNativeHome({ environment: { OMP_PROFILE: "", PI_PROFILE: "work" }, homeDirectory: home }).agentDirectory, Path.join(home, ".omp", "agent"));
    assert.throws(() => resolveOmpNativeHome({ environment: { OMP_PROFILE: "../other" }, homeDirectory: home }));
  });
});
