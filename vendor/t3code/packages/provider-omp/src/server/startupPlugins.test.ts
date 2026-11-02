import { describe, it, expect } from "vite-plus/test";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import { assertOmpPluginStartupSafe, ompPluginStartupRoots } from "./startupPlugins.ts";

describe("OMP plugin startup admission", () => {
  it("allows empty native roots, but refuses user/project installed modules without reading plugin secrets", () => {
    const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), "omp-plugin-policy-"));
    try {
      const cwd = Path.join(home, "workspace", "nested");
      const configRoot = Path.join(home, ".omp");
      Fs.mkdirSync(cwd, { recursive: true });
      const input = { environment: { HOME: home }, homeDirectory: home, cwd,
        nativeHome: { configRoot, agentDirectory: Path.join(configRoot, "agent") } };
      expect(() => assertOmpPluginStartupSafe(input)).not.toThrow();
      const userModules = Path.join(configRoot, "plugins", "node_modules");
      Fs.mkdirSync(userModules, { recursive: true });
      expect(() => assertOmpPluginStartupSafe(input)).not.toThrow();
      Fs.mkdirSync(Path.join(userModules, "installed-plugin"));
      expect(() => assertOmpPluginStartupSafe(input)).toThrow(/installed plugin startup/);
      Fs.rmdirSync(Path.join(userModules, "installed-plugin"));
      const projectModules = Path.join(home, "workspace", ".omp", "plugins", "node_modules");
      Fs.mkdirSync(Path.join(projectModules, "project-plugin"), { recursive: true });
      // A nearest project registry may be anchored above the spawn cwd.
      expect(() => assertOmpPluginStartupSafe(input)).toThrow(/installed plugin startup/);
    } finally { Fs.rmSync(home, { recursive: true, force: true }); }
  });

  it("covers relative XDG roots and refuses unclassifiable native module paths", () => {
    const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), "omp-plugin-xdg-"));
    try {
      const cwd = Path.join(home, "workspace");
      Fs.mkdirSync(cwd);
      const nativeHome = { configRoot: Path.join(home, ".omp"), agentDirectory: Path.join(home, ".omp", "agent") };
      const input = { environment: { HOME: home, XDG_DATA_HOME: "data" }, homeDirectory: home, cwd, nativeHome };
      const modules = Path.join(cwd, "data", "omp", "plugins", "node_modules");
      Fs.mkdirSync(Path.dirname(modules), { recursive: true });
      Fs.writeFileSync(modules, "not a directory");
      if (process.platform === "linux" || process.platform === "darwin")
        expect(() => assertOmpPluginStartupSafe(input)).toThrow(/not a directory/);
    } finally { Fs.rmSync(home, { recursive: true, force: true }); }
  });

  it("rejects package/runtime-lock traversal metadata even when node_modules is empty", () => {
    const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), "omp-plugin-traversal-"));
    try {
      const cwd = Path.join(home, "workspace");
      const root = Path.join(cwd, ".omp", "plugins");
      Fs.mkdirSync(Path.join(root, "node_modules"), { recursive: true });
      Fs.mkdirSync(Path.join(root, "escape"));
      Fs.writeFileSync(Path.join(root, "escape", "package.json"), JSON.stringify({ version: "1", omp: { tools: "init.mjs" } }));
      Fs.writeFileSync(Path.join(root, "escape", "init.mjs"), "throw new Error('preflight must never import this module');");
      const configRoot = Path.join(home, ".omp");
      const input = { environment: { HOME: home }, homeDirectory: home, cwd,
        nativeHome: { configRoot, agentDirectory: Path.join(configRoot, "agent") } };
      for (const metadata of ["package.json", "omp-plugins.lock.json"]) {
        Fs.writeFileSync(Path.join(root, metadata), JSON.stringify({ dependencies: { "../escape": "*" }, plugins: { "../escape": { enabled: true } } }));
        expect(() => assertOmpPluginStartupSafe(input)).toThrow(/plugin startup metadata/);
        Fs.unlinkSync(Path.join(root, metadata));
      }
    } finally { Fs.rmSync(home, { recursive: true, force: true }); }
  });

  it("uses the nearest native project root and never examines Home/temp ancestors as projects", () => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), "omp-plugin-ceilings-"));
    try {
      const home = Path.join(directory, "home"), temporary = Path.join(directory, "temp");
      const project = Path.join(temporary, "project"), cwd = Path.join(project, "nested");
      Fs.mkdirSync(home); Fs.mkdirSync(cwd, { recursive: true });
      // This is outside native project discovery, even though it is an ancestor.
      Fs.mkdirSync(Path.join(temporary, ".omp", "plugins", "node_modules", "unrelated"), { recursive: true });
      const configRoot = Path.join(home, ".omp");
      const userRoot = Path.join(configRoot, "plugins");
      const input = { environment: { HOME: home, TMPDIR: temporary }, homeDirectory: home, cwd,
        nativeHome: { configRoot, agentDirectory: Path.join(configRoot, "agent") } };
      expect(ompPluginStartupRoots(input)).toEqual([userRoot]);
      expect(() => assertOmpPluginStartupSafe(input)).not.toThrow();
      Fs.mkdirSync(Path.join(project, ".git"));
      expect(ompPluginStartupRoots(input)).toEqual([userRoot, Path.join(project, ".omp", "plugins")]);
      Fs.mkdirSync(Path.join(cwd, ".omp"));
      expect(ompPluginStartupRoots(input)).toEqual([userRoot, Path.join(cwd, ".omp", "plugins")]);
    } finally { Fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
