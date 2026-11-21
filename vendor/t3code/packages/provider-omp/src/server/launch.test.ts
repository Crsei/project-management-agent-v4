import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { buildOmpRpcLaunch, resolveOmpLaunchArgs, resolveOmpNativeHome } from "./launch.ts";

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
    assert.throws(() => buildOmpRpcLaunch({ launchArgs: [], environment, cwd }));
    const launch = buildOmpRpcLaunch({
      launchArgs: [], cwd,
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

  it("allows ambient native startup sources instead of refusing the launch", () => cleanEnvironment(({ home, cwd, environment }) => {
    const sources = [
      Path.join(home, ".codex", "config.toml"),
      Path.join(home, ".claude.json"),
      Path.join(home, ".omp", ".env"),
      Path.join(home, ".omp", "agent", "mcp.json"),
      Path.join(cwd, "mcp.json"),
      Path.join(cwd, ".omp", "tools", "native.ts"),
      Path.join(cwd, ".env"),
    ];
    for (const source of sources) {
      Fs.mkdirSync(Path.dirname(source), { recursive: true });
      Fs.writeFileSync(source, "ambient startup source that OMP may load");
    }
    const launch = buildOmpRpcLaunch({ launchArgs: [], environment, cwd, extensionPath: Path.join(home, "owned-gate.mjs") });
    assert.equal(launch.env.HOME, home);
    assert.include(launch.args, "--trusted-extension");
  }));

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
